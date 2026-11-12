import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { createHmac, randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { pool, q, MSG, isMember } from './db.js';
import { requireAuth, requireAdmin } from './auth.js';

const uploadDir = process.env.UPLOAD_DIR || path.resolve('uploads');
fs.mkdirSync(uploadDir, { recursive: true });
const acceptedTypes = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/pdf', 'text/plain', 'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);
const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (_req, _file, cb) => cb(null, randomUUID()),
});
const makeUpload = (imagesOnly = false) => multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const encryptedFile = !imagesOnly && file.mimetype === 'application/octet-stream' && req.body.encrypted === 'true';
    const allowed = encryptedFile || (imagesOnly
      ? file.mimetype.startsWith('image/') && acceptedTypes.has(file.mimetype)
      : acceptedTypes.has(file.mimetype));
    if (allowed) cb(null, true);
    else cb(Object.assign(new Error('unsupported file type'), { status: 400 }));
  },
});
const upload = makeUpload();
const avatarUpload = makeUpload(true);
const safeFileName = (name) => path.basename(name).replace(/[\u0000-\u001f\u007f"\\]/g, '_').slice(0, 200) || 'attachment';

const DIRECT = `SELECT c.id FROM conversations c
  JOIN conversation_participants a ON a.conversation_id=c.id AND a.user_id=$1
  JOIN conversation_participants b ON b.conversation_id=c.id AND b.user_id=$2
  WHERE NOT c.is_group LIMIT 1`;

export const apiRouter = (redis, io) => {
  const r = Router();
  r.get('/avatar/:id', async (req, res) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) return res.status(404).end();
    const { rows: [file] } = await q(
      `SELECT f.storage_name AS "storageName",f.mime_type AS "mimeType"
       FROM uploads f JOIN users u ON u.id=f.owner_id
       WHERE f.id=$1 AND f.conversation_id IS NULL AND u.avatar_url=$2`, [req.params.id, `/api/avatar/${req.params.id}`]);
    if (!file) return res.status(404).end();
    res.type(file.mimeType).set('Cache-Control', 'public, max-age=3600').sendFile(path.join(uploadDir, file.storageName));
  });
  r.use(requireAuth);

  r.get('/rtc/turn-credentials', (req, res) => {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const username = `${expires}:${req.user.uid}`;
    const credential = createHmac('sha1', process.env.TURN_SECRET || 'dev-turn-secret-change-me')
      .update(username).digest('base64');
    res.json({
      urls: process.env.TURN_URL || 'turn:localhost:3478?transport=udp',
      username,
      credential,
      expires,
    });
  });

  r.get('/users', async (req, res) => {
    const s = `%${String(req.query.q || '').replace(/[%_\\]/g, '')}%`;
    res.json((await q(
      `SELECT u.id, u.username, u.full_name AS "fullName", u.faculty, u.department, u.avatar_url AS "avatarUrl", c.name AS campus
       FROM users u LEFT JOIN campuses c ON c.id=u.campus_id
       WHERE u.id<>$1 AND NOT u.banned AND (u.username ILIKE $2 OR u.full_name ILIKE $2) ORDER BY u.full_name LIMIT 20`,
      [req.user.uid, s])).rows);
  });

  r.get('/users/me', async (req, res) => {
    const { rows: [user] } = await q(
      `SELECT id,username,email,full_name AS "fullName",faculty,department,bio,avatar_url AS "avatarUrl",
        campus_id AS "campusId",settings,role FROM users WHERE id=$1`, [req.user.uid]);
    res.json(user);
  });

  r.patch('/users/me', async (req, res) => {
    const { fullName, faculty, department, bio, campusId, settings } = req.body || {};
    if (typeof fullName !== 'string' || !fullName.trim() || fullName.length > 100 ||
        typeof bio !== 'string' || bio.length > 500 ||
        (campusId != null && !Number.isInteger(campusId)) ||
        (settings !== undefined && (!settings || typeof settings !== 'object' || Array.isArray(settings))))
      return res.status(400).json({ error: 'invalid profile or settings' });
    const { rows: [user] } = await q(
      `UPDATE users SET full_name=$2,faculty=$3,department=$4,bio=$5,campus_id=$6,
        settings=COALESCE($7::jsonb,settings) WHERE id=$1
       RETURNING id,username,email,full_name AS "fullName",faculty,department,bio,avatar_url AS "avatarUrl",
        campus_id AS "campusId",settings,role`,
      [req.user.uid, fullName.trim(), String(faculty || '').slice(0, 100), String(department || '').slice(0, 100),
        bio, campusId || null, settings === undefined ? null : JSON.stringify(settings)]);
    res.json(user);
  });

  r.put('/users/me/public-key', async (req, res) => {
    const publicKey = req.body?.publicKey;
    if (!publicKey || publicKey.kty !== 'RSA' || publicKey.alg !== 'RSA-OAEP-256' ||
        typeof publicKey.n !== 'string' || typeof publicKey.e !== 'string')
      return res.status(400).json({ error: 'invalid public key' });
    await q(`INSERT INTO user_public_keys(user_id,public_key) VALUES($1,$2)
      ON CONFLICT(user_id) DO UPDATE SET public_key=EXCLUDED.public_key,updated_at=now()`,
      [req.user.uid, JSON.stringify(publicKey)]);
    res.json({ ok: true });
  });

  r.post('/users/me/avatar', (req, res, next) => avatarUpload.single('file')(req, res, (e) => {
    if (e) return next(e);
    next();
  }), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'image required' });
    const { rows: [image] } = await q(
      `INSERT INTO uploads(owner_id,file_name,mime_type,size,storage_name)
       VALUES($1,$2,$3,$4,$5) RETURNING id`,
      [req.user.uid, safeFileName(req.file.originalname), req.file.mimetype, req.file.size, req.file.filename]);
    const { rows: [user] } = await q(
      'UPDATE users SET avatar_url=$2 WHERE id=$1 RETURNING avatar_url AS "avatarUrl"',
      [req.user.uid, `/api/avatar/${image.id}`]);
    res.json(user);
  });

  r.get('/conversations', async (req, res) => {
    res.json((await q(
      `SELECT c.id, c.is_group AS "isGroup", c.title,c.encrypted,c.created_by AS "createdBy",
        (SELECT json_agg(json_build_object('id',u.id,'username',u.username,'fullName',u.full_name,'faculty',u.faculty,
           'avatarUrl',u.avatar_url,'campus',(SELECT name FROM campuses WHERE id=u.campus_id)))
         FROM conversation_participants p2 JOIN users u ON u.id=p2.user_id
         WHERE p2.conversation_id=c.id AND p2.user_id<>$1) AS others,
        (SELECT row_to_json(l) FROM (SELECT ${MSG} FROM messages m WHERE m.conversation_id=c.id ORDER BY m.seq DESC LIMIT 1) l) AS last,
        (SELECT count(*) FROM messages m WHERE m.conversation_id=c.id AND m.seq>p.last_read_seq AND m.sender_id<>$1)::int AS unread
       FROM conversations c JOIN conversation_participants p ON p.conversation_id=c.id AND p.user_id=$1
       ORDER BY (SELECT max(seq) FROM messages WHERE conversation_id=c.id) DESC NULLS LAST, c.created_at DESC`,
      [req.user.uid])).rows);
  });

  // Direct chat: one username, no title. Group: a title or several usernames.
  r.post('/conversations', async (req, res) => {
    const names = (Array.isArray(req.body.usernames) ? req.body.usernames : []).map((s) => String(s).toLowerCase()).slice(0, 50);
    const title = req.body.title ? String(req.body.title).slice(0, 80) : null;
    const { rows: us } = await q('SELECT id FROM users WHERE username=ANY($1) AND id<>$2 AND NOT banned', [names, req.user.uid]);
    if (!us.length) return res.status(400).json({ error: 'no valid users' });
    const group = !!title || us.length > 1;
    if (!group) { const { rows: [e] } = await q(DIRECT, [req.user.uid, us[0].id]); if (e) return res.json({ id: e.id }); }
    const encrypted = req.body.encrypted === true;
    if (encrypted) {
      const participantIds = [req.user.uid, ...us.map((user) => user.id)];
      const { rowCount } = await q(
        'SELECT 1 FROM user_public_keys WHERE user_id=ANY($1::uuid[])', [participantIds]);
      if (rowCount !== participantIds.length)
        return res.status(400).json({ error: 'All participants must sign in once before an encrypted conversation can be created' });
    }
    const { rows: [c] } = await q(
      'INSERT INTO conversations(is_group,title,created_by,encrypted) VALUES($1,$2,$3,$4) RETURNING id',
      [group, title, req.user.uid, encrypted]);
    await q('INSERT INTO conversation_participants(conversation_id,user_id) SELECT $1, unnest($2::uuid[])',
      [c.id, [req.user.uid, ...us.map((u) => u.id)]]);
    res.json({ id: c.id, encrypted });
  });

  r.get('/conversations/:id/keys', async (req, res) => {
    if (!(await isMember(req.params.id, req.user.uid))) return res.status(403).json({ error: 'forbidden' });
    const { rows: [row] } = await q(
      'SELECT wrapped_key AS "wrappedKey" FROM conversation_keys WHERE conversation_id=$1 AND user_id=$2',
      [req.params.id, req.user.uid]);
    res.json({ wrappedKey: row?.wrappedKey || null });
  });

  r.get('/conversations/:id/keys/public', async (req, res) => {
    if (!(await isMember(req.params.id, req.user.uid))) return res.status(403).json({ error: 'forbidden' });
    const { rows: members } = await q(
      `SELECT p.user_id AS "userId",k.public_key AS "publicKey"
       FROM conversation_participants p LEFT JOIN user_public_keys k ON k.user_id=p.user_id
       WHERE p.conversation_id=$1`, [req.params.id]);
    res.json({ members });
  });

  r.post('/conversations/:id/keys', async (req, res) => {
    const { rows: [conversation] } = await q(
      'SELECT created_by,encrypted FROM conversations WHERE id=$1', [req.params.id]);
    if (!conversation || conversation.created_by !== req.user.uid || !conversation.encrypted)
      return res.status(403).json({ error: 'forbidden' });
    const wrappedKeys = req.body?.wrappedKeys;
    if (!Array.isArray(wrappedKeys) || wrappedKeys.length < 2 || wrappedKeys.length > 50 ||
        wrappedKeys.some((item) => typeof item?.userId !== 'string' ||
          typeof item?.wrappedKey !== 'string' || item.wrappedKey.length > 2000))
      return res.status(400).json({ error: 'invalid key envelopes' });
    const { rows: participants } = await q(
      'SELECT user_id FROM conversation_participants WHERE conversation_id=$1', [req.params.id]);
    const ids = participants.map((row) => row.user_id).sort();
    const submitted = wrappedKeys.map((row) => row.userId).sort();
    if (ids.length !== submitted.length || ids.some((id, i) => id !== submitted[i]))
      return res.status(400).json({ error: 'key envelope membership mismatch' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [req.params.id]);
      const { rowCount } = await client.query(
        'SELECT 1 FROM conversation_keys WHERE conversation_id=$1 LIMIT 1', [req.params.id]);
      if (!rowCount) {
        for (const item of wrappedKeys)
          await client.query('INSERT INTO conversation_keys(conversation_id,user_id,wrapped_key) VALUES($1,$2,$3)',
            [req.params.id, item.userId, item.wrappedKey]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally { client.release(); }
    res.json({ ok: true });
  });

  // Keyset pagination on seq: ?before=<seq>&limit=50
  r.get('/conversations/:id/messages', async (req, res) => {
    if (!(await isMember(req.params.id, req.user.uid))) return res.status(403).json({ error: 'forbidden' });
    const before = +req.query.before || 2147483647, limit = Math.min(+req.query.limit || 50, 100);
    const { rows } = await q(`SELECT ${MSG} FROM messages m WHERE m.conversation_id=$1 AND m.seq<$2 ORDER BY m.seq DESC LIMIT $3`,
      [req.params.id, before, limit]);
    res.json(rows.reverse());
  });

  r.patch('/messages/:id', async (req, res) => {
    const body = req.body?.body;
    if (typeof body !== 'string' || !body.trim() || body.length > 20000)
      return res.status(400).json({ error: 'invalid message body' });
    const { rows: [existing] } = await q(
      `SELECT c.encrypted FROM messages m JOIN conversations c ON c.id=m.conversation_id
       WHERE m.id=$1 AND m.sender_id=$2 AND m.deleted_at IS NULL`, [req.params.id, req.user.uid]);
    if (!existing) return res.status(404).json({ error: 'message not found' });
    if (existing.encrypted && !body.startsWith('enc1:'))
      return res.status(400).json({ error: 'encrypted conversation requires encrypted message content' });
    if (!existing.encrypted && body.length > 4000)
      return res.status(400).json({ error: 'message is too long' });
    const { rows: [message] } = await q(
      `UPDATE messages AS m SET body=$2,edited_at=now() WHERE m.id=$1 AND m.sender_id=$3 AND m.deleted_at IS NULL
       RETURNING ${MSG}`,
      [req.params.id, body.trim(), req.user.uid]);
    if (!message) return res.status(404).json({ error: 'message not found' });
    if (io) {
      const { rows: members } = await q('SELECT user_id FROM conversation_participants WHERE conversation_id=$1', [message.conversationId]);
      for (const member of members) io.to(`u:${member.user_id}`).emit('message:updated', message);
    }
    res.json(message);
  });

  r.delete('/messages/:id', async (req, res) => {
    const { rows: attachments } = await q('SELECT storage_name FROM uploads WHERE message_id=$1', [req.params.id]);
    const { rows: [message] } = await q(
      `UPDATE messages AS m SET body='',attachments='[]'::jsonb,deleted_at=now()
       WHERE m.id=$1 AND m.sender_id=$2 AND m.deleted_at IS NULL
       RETURNING ${MSG}`, [req.params.id, req.user.uid]);
    if (!message) return res.status(404).json({ error: 'message not found' });
    await q('DELETE FROM uploads WHERE message_id=$1', [req.params.id]);
    for (const attachment of attachments) {
      const location = path.join(uploadDir, attachment.storage_name);
      if (fs.existsSync(location)) fs.unlinkSync(location);
    }
    if (io) {
      const { rows: members } = await q('SELECT user_id FROM conversation_participants WHERE conversation_id=$1', [message.conversationId]);
      for (const member of members) io.to(`u:${member.user_id}`).emit('message:updated', message);
    }
    res.json(message);
  });

  r.post('/conversations/:id/uploads', (req, res, next) => upload.single('file')(req, res, (e) => {
    if (e) return next(e);
    next();
  }), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'file required' });
    if (!(await isMember(req.params.id, req.user.uid))) {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: 'forbidden' });
    }
    const encrypted = req.body.encrypted === 'true';
    const { rows: [conversation] } = await q('SELECT encrypted FROM conversations WHERE id=$1', [req.params.id]);
    if (encrypted !== conversation.encrypted) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'upload encryption must match conversation settings' });
    }
    const fileName = encrypted ? 'Encrypted attachment' : safeFileName(req.file.originalname);
    const mimeType = encrypted ? 'application/octet-stream' : req.file.mimetype;
    const { rows: [attachment] } = await q(
      `INSERT INTO uploads(owner_id,conversation_id,file_name,mime_type,size,storage_name,encrypted)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       RETURNING id,file_name AS name,mime_type AS "mimeType",size,encrypted`,
      [req.user.uid, req.params.id, fileName, mimeType, req.file.size, req.file.filename, encrypted]);
    res.json({ ...attachment, url: `/api/uploads/${attachment.id}` });
  });

  r.get('/uploads/:id', async (req, res) => {
    const { rows: [file] } = await q(
      `SELECT owner_id AS "ownerId",conversation_id AS "conversationId",storage_name AS "storageName",file_name AS "fileName",mime_type AS "mimeType"
       FROM uploads WHERE id=$1`, [req.params.id]);
    if (!file) return res.status(404).json({ error: 'file not found' });
    if (file.conversationId && !(await isMember(file.conversationId, req.user.uid)))
      return res.status(403).json({ error: 'forbidden' });
    res.type(file.mimeType).set('Content-Disposition',
      `${file.mimeType.startsWith('image/') && !file.mimeType.includes('svg') ? 'inline' : 'attachment'}; filename="${safeFileName(file.fileName)}"`);
    res.sendFile(path.join(uploadDir, file.storageName));
  });

  r.get('/notifications', async (req, res) => {
    const { rows } = await q(
      `SELECT id,type,payload,created_at AS "createdAt",read_at AS "readAt"
       FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100`, [req.user.uid]);
    res.json(rows);
  });

  r.patch('/notifications/:id/read', async (req, res) => {
    await q('UPDATE notifications SET read_at=now() WHERE id=$1 AND user_id=$2', [req.params.id, req.user.uid]);
    res.json({ ok: true });
  });

  r.post('/notifications/read-all', async (req, res) => {
    await q('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [req.user.uid]);
    res.json({ ok: true });
  });

  r.post('/reports', async (req, res) => {
    const { targetUserId, messageId, reason } = req.body || {};
    if ((!targetUserId && !messageId) || typeof reason !== 'string' || !reason.trim() || reason.length > 1000)
      return res.status(400).json({ error: 'a target and reason are required' });
    if (messageId) {
      const { rows: [message] } = await q(
        `SELECT m.sender_id FROM messages m JOIN conversation_participants p ON p.conversation_id=m.conversation_id
         WHERE m.id=$1 AND p.user_id=$2`, [messageId, req.user.uid]);
      if (!message) return res.status(404).json({ error: 'message not found' });
      if (message.sender_id === req.user.uid || (targetUserId && targetUserId !== message.sender_id))
        return res.status(400).json({ error: 'message reports must target the message sender' });
      await q('INSERT INTO reports(reporter_id,target_user_id,message_id,reason) VALUES($1,$2,$3,$4)',
        [req.user.uid, targetUserId || message.sender_id, messageId, reason.trim()]);
    } else {
      if (targetUserId === req.user.uid) return res.status(400).json({ error: 'cannot report yourself' });
      const { rowCount } = await q('SELECT 1 FROM users WHERE id=$1', [targetUserId]);
      if (!rowCount) return res.status(404).json({ error: 'user not found' });
      await q('INSERT INTO reports(reporter_id,target_user_id,reason) VALUES($1,$2,$3)',
        [req.user.uid, targetUserId, reason.trim()]);
    }
    res.status(201).json({ ok: true });
  });

  r.get('/admin/reports', requireAdmin, async (_req, res) => {
    const { rows } = await q(
      `SELECT r.id,r.reason,r.status,r.created_at AS "createdAt",r.resolution,
        reporter.username AS "reporterUsername",target.username AS "targetUsername",r.message_id AS "messageId",
        CASE WHEN c.encrypted THEN 'Encrypted message' ELSE m.body END AS "messageBody"
       FROM reports r JOIN users reporter ON reporter.id=r.reporter_id
       LEFT JOIN users target ON target.id=r.target_user_id
       LEFT JOIN messages m ON m.id=r.message_id
       LEFT JOIN conversations c ON c.id=m.conversation_id
       ORDER BY r.created_at DESC LIMIT 200`);
    res.json(rows);
  });

  r.patch('/admin/reports/:id', requireAdmin, async (req, res) => {
    const { status, resolution, banTarget } = req.body || {};
    if (!['reviewed', 'dismissed'].includes(status) || typeof resolution !== 'string' || resolution.length > 1000)
      return res.status(400).json({ error: 'invalid moderation decision' });
    const { rows: [report] } = await q(
      `UPDATE reports SET status=$2,resolution=$3,moderated_by=$4,resolved_at=now()
       WHERE id=$1 RETURNING target_user_id AS "targetUserId"`,
      [req.params.id, status, resolution.trim(), req.user.uid]);
    if (!report) return res.status(404).json({ error: 'report not found' });
    if (banTarget && report.targetUserId) {
      const { rowCount } = await q('UPDATE users SET banned=true WHERE id=$1 AND role<>\'admin\'', [report.targetUserId]);
      if (rowCount && io) io.in(`u:${report.targetUserId}`).disconnectSockets(true);
    }
    res.json({ ok: true });
  });

  r.get('/admin/users', requireAdmin, async (_req, res) => {
    const { rows } = await q(
      `SELECT id,username,email,full_name AS "fullName",role,banned,created_at AS "createdAt"
       FROM users ORDER BY created_at DESC LIMIT 500`);
    res.json(rows);
  });

  r.patch('/admin/users/:id', requireAdmin, async (req, res) => {
    const { banned, role, password } = req.body || {};
    if (typeof banned !== 'boolean' || !['student', 'admin'].includes(role))
      return res.status(400).json({ error: 'invalid account changes' });
    if (password !== undefined && (typeof password !== 'string' || password.length < 8 || password.length > 128))
      return res.status(400).json({ error: 'password must be between 8 and 128 characters' });
    if (req.params.id === req.user.uid && (banned || role !== 'admin'))
      return res.status(400).json({ error: 'cannot disable your own admin account' });
    const passwordHash = password === undefined ? null : await bcrypt.hash(password, 12);
    const { rows: [user] } = await q(
      `UPDATE users SET banned=$2,role=$3,password_hash=COALESCE($4,password_hash) WHERE id=$1
       RETURNING id,username,email,full_name AS "fullName",role,banned,created_at AS "createdAt"`,
      [req.params.id, banned, role, passwordHash]);
    if (!user) return res.status(404).json({ error: 'user not found' });
    if (user.banned && io) io.in(`u:${user.id}`).disconnectSockets(true);
    res.json(user);
  });

  r.get('/admin/stats', requireAdmin, async (_, res) => {
    const [u, c, m] = await Promise.all([
      q('SELECT count(*)::int n FROM users'),
      q('SELECT c.name, count(u.id)::int n FROM campuses c LEFT JOIN users u ON u.campus_id=c.id GROUP BY c.name ORDER BY c.name'),
      q(`SELECT count(*)::int total, count(*) FILTER (WHERE created_at > now() - interval '1 hour')::int "lastHour" FROM messages`)]);
    res.json({ users: u.rows[0].n, byCampus: c.rows, messages: m.rows[0], onlineUsers: await redis.hLen('presence') });
  });

  return r;
};
