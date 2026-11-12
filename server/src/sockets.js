import { Server } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import jwt from 'jsonwebtoken';
import { q, MSG, isMember } from './db.js';
import { SECRET } from './auth.js';

// Server role: signaling + persistence + offline queue + presence. It never needs to read P2P traffic.
export async function attachSockets(server) {
  const redis = createClient({ url: process.env.REDIS_URL });
  const sub = redis.duplicate();
  await Promise.all([redis.connect(), sub.connect()]);
  // Redis adapter: io.to(room).emit() reaches sockets on every API instance.
  const io = new Server(server, { adapter: createAdapter(redis, sub), cors: { origin: true }, maxHttpBufferSize: 1e5 });

  io.use(async (s, next) => {
    try {
      const { uid } = jwt.verify(s.handshake.auth.token, SECRET);
      const { rows: [user] } = await q('SELECT banned FROM users WHERE id=$1', [uid]);
      if (!user || user.banned) return next(new Error('unauthorized'));
      s.data.uid = uid;
      next();
    } catch (e) {
      if (e.name === 'JsonWebTokenError' || e.name === 'TokenExpiredError') return next(new Error('unauthorized'));
      next(e);
    }
  });

  const others = async (cid, uid) =>
    (await q('SELECT user_id FROM conversation_participants WHERE conversation_id=$1 AND user_id<>$2', [cid, uid])).rows.map((r) => r.user_id);
  const markDelivered = async (id, uid, sender) => {
    const r = await q('INSERT INTO message_receipts(message_id,user_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [id, uid]);
    if (r.rowCount) io.to(`u:${sender}`).emit('message:delivered', { id, userId: uid });
  };

  io.on('connection', (socket) => {
    const uid = socket.data.uid;
    const on = (ev, fn) => socket.on(ev, async (...a) => { try { await fn(...a); } catch (e) { console.error(ev, e.message); } });
    socket.join(`u:${uid}`);

    on('message:send', async (d, ack = () => {}) => {
      const { id, conversationId: cid, body, replyTo, attachmentIds = [] } = d || {};
      if (!/^[0-9a-f-]{36}$/i.test(id) || typeof body !== 'string' || !body.trim() ||
          body.length > 20000 || !Array.isArray(attachmentIds) || attachmentIds.length > 5 ||
          !(await isMember(cid, uid)))
        return ack({ ok: false });
      const { rows: [conversation] } = await q('SELECT encrypted FROM conversations WHERE id=$1', [cid]);
      if ((!conversation.encrypted && body.length > 4000) ||
          (conversation.encrypted && !body.startsWith('enc1:')) ||
          (replyTo && !(await q('SELECT 1 FROM messages WHERE id=$1 AND conversation_id=$2', [replyTo, cid])).rowCount))
        return ack({ ok: false });
      let attachments = [];
      if (attachmentIds.length) {
        const { rows } = await q(
          `SELECT id,file_name AS name,mime_type AS "mimeType",size,encrypted
           FROM uploads WHERE id=ANY($1::uuid[]) AND owner_id=$2 AND conversation_id=$3 AND message_id IS NULL`,
          [attachmentIds, uid, cid]);
        if (rows.length !== attachmentIds.length || rows.some((file) => file.encrypted !== conversation.encrypted))
          return ack({ ok: false });
        attachments = rows.map((file) => ({ ...file, url: `/api/uploads/${file.id}` }));
      }
      // Idempotent: a retried id inserts nothing and is not fanned out twice.
      const ins = await q(
        `INSERT INTO messages(id,conversation_id,sender_id,body,reply_to,attachments)
         VALUES($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT(id) DO NOTHING`,
        [id, cid, uid, body.trim(), replyTo || null, JSON.stringify(attachments)]);
      if (ins.rowCount && attachmentIds.length)
        await q('UPDATE uploads SET message_id=$1 WHERE id=ANY($2::uuid[])', [id, attachmentIds]);
      const { rows: [msg] } = await q(`SELECT ${MSG} FROM messages m WHERE m.id=$1 AND m.sender_id=$2`, [id, uid]);
      ack({ ok: !!msg, message: msg });
      if (!ins.rowCount) return;
      for (const pid of await others(cid, uid)) {
        await q(
          `INSERT INTO notifications(user_id,type,payload) VALUES($1,'message',jsonb_build_object(
            'conversationId',$2::text,'messageId',$3::text,'senderId',$4::text))`, [pid, cid, id, uid]);
        io.to(`u:${pid}`).timeout(5000).emit('message:new', msg, (err, res) => { if (!err && res.length) markDelivered(msg.id, pid, uid); });
      }
    });

    on('message:read', async ({ conversationId: cid, upToSeq } = {}) => {
      if (!Number.isInteger(upToSeq) || !(await isMember(cid, uid))) return;
      await q('UPDATE conversation_participants SET last_read_seq=GREATEST(last_read_seq,$3) WHERE conversation_id=$1 AND user_id=$2', [cid, uid, upToSeq]);
      for (const pid of await others(cid, uid)) io.to(`u:${pid}`).emit('message:read', { conversationId: cid, userId: uid, upToSeq });
    });

    on('typing', async (cid) => {
      if (await isMember(cid, uid)) for (const pid of await others(cid, uid)) io.to(`u:${pid}`).emit('typing', { conversationId: cid, userId: uid });
    });

    // WebRTC signaling only: relays SDP/ICE between two users who share a conversation.
    on('rtc:signal', async ({ to, data } = {}) => {
      const { rowCount } = await q(
        `SELECT 1 FROM conversation_participants a JOIN conversation_participants b ON a.conversation_id=b.conversation_id
         WHERE a.user_id=$1 AND b.user_id=$2 LIMIT 1`, [uid, to]);
      if (rowCount) io.to(`u:${to}`).emit('rtc:signal', { from: uid, data });
    });

    on('disconnect', async () => {
      if ((await redis.hIncrBy('presence', uid, -1)) <= 0) {
        await redis.hDel('presence', uid);
        io.emit('presence', { userId: uid, online: false });
        await q('UPDATE users SET last_seen=now() WHERE id=$1', [uid]);
      }
    });

    (async () => {
      try {
        if ((await redis.hIncrBy('presence', uid, 1)) === 1) io.emit('presence', { userId: uid, online: true });
        socket.emit('presence:list', await redis.hKeys('presence'));
        // Offline queue: everything addressed to me without a delivery receipt, in seq order.
        const { rows } = await q(
          `SELECT ${MSG} FROM messages m JOIN conversation_participants p ON p.conversation_id=m.conversation_id AND p.user_id=$1
           WHERE m.sender_id<>$1 AND NOT EXISTS (SELECT 1 FROM message_receipts r WHERE r.message_id=m.id AND r.user_id=$1)
           ORDER BY m.seq LIMIT 500`, [uid]);
        if (rows.length) socket.timeout(10000).emit('sync', rows, async (err) => {
          if (!err) for (const m of rows) await markDelivered(m.id, uid, m.senderId);
        });
      } catch (e) { console.error('connect', e.message); }
    })();
  });

  return { io, redis };
}
