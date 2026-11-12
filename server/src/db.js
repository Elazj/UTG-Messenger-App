import pg from 'pg';
import fs from 'fs';
import bcrypt from 'bcryptjs';

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
export const q = (text, params) => pool.query(text, params);
export const MSG = `m.id, m.conversation_id AS "conversationId", m.sender_id AS "senderId", m.body,
  m.reply_to AS "replyTo",m.edited_at AS "editedAt",m.deleted_at AS "deletedAt",
  m.attachments,m.seq::int AS seq,m.created_at AS "createdAt"`;
export const createDbHelpers = (query) => ({
  isMember: async (cid, uid) =>
    (await query('SELECT 1 FROM conversation_participants WHERE conversation_id=$1 AND user_id=$2', [cid, uid])).rowCount > 0,
});
export const { isMember } = createDbHelpers(q);

// Runs migrations under an advisory lock so several instances can boot at once.
export async function migrate() {
  const c = await pool.connect();
  try {
    await c.query('SELECT pg_advisory_lock(42)');
    const dir = new URL('../migrations/', import.meta.url);
    for (const f of fs.readdirSync(dir).sort()) await c.query(fs.readFileSync(new URL(f, dir), 'utf8'));
    const add = async (username, email, name, pw, role) =>
      c.query(`INSERT INTO users(username,email,password_hash,full_name,campus_id,role) VALUES($1,$2,$3,$4,1,$5) ON CONFLICT DO NOTHING`,
        [username, email, await bcrypt.hash(pw, 12), name, role]);
    if (process.env.SEED_DEV) {
      await add('alice', 'alice@utg.edu.gm', 'Alice Jallow', 'Password123!', 'student');
      await add('bob', 'bob@utg.edu.gm', 'Bob Ceesay', 'Password123!', 'student');
    }
    if (process.env.ADMIN_EMAIL) await add('admin', process.env.ADMIN_EMAIL, 'Administrator', process.env.ADMIN_PASSWORD, 'admin');
  } finally {
    await c.query('SELECT pg_advisory_unlock(42)');
    c.release();
  }
}
