// Requires the stack from `docker compose up`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { io } from 'socket.io-client';
import { randomUUID } from 'node:crypto';

const API = process.env.API || 'http://localhost:4000';
const post = async (path, body, token) => {
  const response = await fetch(API + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
};
const register = async () => {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 15);
  const username = `l${suffix}`;
  const response = await post('/api/auth/register', {
    username, email: `${username}@utg.edu.gm`, password: 'Password123!', fullName: username,
  });
  assert.equal(response.status, 200);
  return { ...response.body, username };
};
const waitFor = async (predicate, timeoutMs = 10000) => {
  const until = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(predicate(), 'timed out waiting for concurrent message delivery');
};

test('concurrent message writes preserve every unique message and deduplicate retries', async (t) => {
  const [sender, recipient] = await Promise.all([register(), register()]);
  const created = await post('/api/conversations', { usernames: [recipient.username] }, sender.token);
  assert.equal(created.status, 200);
  const cid = created.body.id;
  const sendSocket = io(API, { auth: { token: sender.token }, transports: ['websocket'] });
  const receiveSocket = io(API, { auth: { token: recipient.token }, transports: ['websocket'] });
  t.after(() => { sendSocket.close(); receiveSocket.close(); });
  await Promise.all([sendSocket, receiveSocket].map((socket) => new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('connect_error', reject);
  })));

  const delivered = [];
  receiveSocket.on('message:new', (message, ack) => { delivered.push(message.id); ack?.(true); });
  const unique = Array.from({ length: 25 }, (_, i) => ({
    id: randomUUID(), conversationId: cid, body: `parallel-${i}`,
  }));
  const send = (message) => new Promise((resolve, reject) => {
    sendSocket.timeout(10000).emit('message:send', message, (error, result) => {
      if (error) reject(error); else resolve(result);
    });
  });
  const results = await Promise.all(unique.map(send));
  assert.ok(results.every((result) => result.ok));
  await waitFor(() => delivered.length >= unique.length);
  assert.equal(new Set(delivered).size, unique.length);

  const retry = { id: randomUUID(), conversationId: cid, body: 'retry-safe' };
  const retries = await Promise.all(Array.from({ length: 10 }, () => send(retry)));
  assert.ok(retries.every((result) => result.ok));
  await waitFor(() => delivered.length === unique.length + 1);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(delivered.length, unique.length + 1);
});
