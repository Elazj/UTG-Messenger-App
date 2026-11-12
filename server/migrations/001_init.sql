CREATE TABLE IF NOT EXISTS campuses(id serial PRIMARY KEY, name text UNIQUE NOT NULL);
INSERT INTO campuses(name) VALUES ('Faraba Banta'),('Brikama'),('Kanifing'),('Banjul') ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS users(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username text UNIQUE NOT NULL, email text UNIQUE NOT NULL, password_hash text NOT NULL,
  full_name text NOT NULL, campus_id int REFERENCES campuses(id), faculty text, department text, avatar_url text,
  role text NOT NULL DEFAULT 'student' CHECK (role IN ('student','admin')),
  banned boolean NOT NULL DEFAULT false, last_seen timestamptz, created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS conversations(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), is_group boolean NOT NULL DEFAULT false,
  title text, created_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS conversation_participants(
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  last_read_seq bigint NOT NULL DEFAULT 0, PRIMARY KEY(conversation_id, user_id));
CREATE INDEX IF NOT EXISTS idx_cp_user ON conversation_participants(user_id);

-- id is client-generated (idempotent retries); seq is the server-assigned total order.
CREATE TABLE IF NOT EXISTS messages(
  id uuid PRIMARY KEY, seq bigserial UNIQUE NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id uuid NOT NULL REFERENCES users(id), body text NOT NULL,
  reply_to uuid REFERENCES messages(id), created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_msg_conv_seq ON messages(conversation_id, seq DESC);

-- A row here = delivered to that recipient. No row = still in the offline queue.
CREATE TABLE IF NOT EXISTS message_receipts(
  message_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  delivered_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(message_id, user_id));
