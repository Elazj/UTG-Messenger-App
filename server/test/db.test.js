import test from 'node:test';
import assert from 'node:assert/strict';
import { createDbHelpers, MSG } from '../src/db.js';

test('membership lookup uses parameterized conversation and user IDs', async () => {
  const calls = [];
  const db = createDbHelpers(async (...args) => {
    calls.push(args);
    return { rowCount: 1 };
  });
  assert.equal(await db.isMember('conversation-id', 'user-id'), true);
  assert.deepEqual(calls, [[
    'SELECT 1 FROM conversation_participants WHERE conversation_id=$1 AND user_id=$2',
    ['conversation-id', 'user-id'],
  ]]);
});

test('membership lookup returns false when no participant row exists', async () => {
  const db = createDbHelpers(async () => ({ rowCount: 0 }));
  assert.equal(await db.isMember('missing-conversation', 'user-id'), false);
});

test('message projection includes edits, deletion and attachments', () => {
  assert.match(MSG, /m\.edited_at AS "editedAt"/);
  assert.match(MSG, /m\.deleted_at AS "deletedAt"/);
  assert.match(MSG, /m\.attachments/);
});
