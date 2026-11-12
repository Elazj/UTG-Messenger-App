// Needs a running stack (docker compose up). Run: cd server && npm i && npm test
import test from 'node:test';
import assert from 'node:assert';
import { io } from 'socket.io-client';
import { randomUUID as uuid } from 'node:crypto';

const API = process.env.API || 'http://localhost:4000';
const call = async (p, t, b) => {
  const r = await fetch(API + p, { method: b ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(t && { authorization: 'Bearer ' + t }) }, body: b && JSON.stringify(b) });
  return { status: r.status, body: await r.json() };
};
const reg = async (n) => {
  const u = `t${n}${Date.now()}`.slice(0, 20);
  const r = await call('/api/auth/register', null, { username: u, email: u + '@utg.edu.gm', password: 'Password123!', fullName: u });
  return { ...r.body, username: u };
};
const conn = (t, url = API) => io(url, { auth: { token: t }, transports: ['websocket'] });
const once = (s, e) => new Promise((r) => s.once(e, (x, ack) => { ack?.(true); r(x); }));
const send = (s, m) => new Promise((r) => s.emit('message:send', m, r));

test('realtime delivery, idempotency, offline sync, authorization', async () => {
  const [a, b, c] = await Promise.all([reg(1), reg(2), reg(3)]);
  assert.equal((await call('/api/conversations', b.token)).status, 200);
  const { body: { id: cid } } = await call('/api/conversations', a.token, { usernames: [b.username] });
  const sa = conn(a.token); let sb = conn(b.token);
  await Promise.all([sa, sb].map((x) => new Promise((r) => x.once('connect', r))));

  const id1 = uuid(), live = once(sb, 'message:new');
  assert.ok((await send(sa, { id: id1, conversationId: cid, body: 'hi' })).ok);
  assert.equal((await live).id, id1);

  sb.disconnect(); await new Promise((r) => setTimeout(r, 400));
  const id2 = uuid();
  await send(sa, { id: id2, conversationId: cid, body: 'while offline' });
  await send(sa, { id: id2, conversationId: cid, body: 'while offline' }); // retry must not duplicate
  sb = conn(b.token);
  assert.deepEqual((await once(sb, 'sync')).map((m) => m.id), [id2]);

  assert.equal((await call(`/api/conversations/${cid}/messages`, c.token)).status, 403); // outsider
  assert.equal((await call('/api/admin/stats', a.token)).status, 403); // non-admin
  sa.close(); sb.close();
});
