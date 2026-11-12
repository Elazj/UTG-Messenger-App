ALTER TABLE conversations ADD COLUMN IF NOT EXISTS encrypted boolean NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS edited_at timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]';
ALTER TABLE users ADD COLUMN IF NOT EXISTS bio text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS user_public_keys(
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  public_key jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS conversation_keys(
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  wrapped_key text NOT NULL,
  PRIMARY KEY(conversation_id,user_id));

CREATE TABLE IF NOT EXISTS uploads(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid REFERENCES conversations(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  size bigint NOT NULL,
  storage_name text NOT NULL UNIQUE,
  encrypted boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS notifications(
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id,created_at DESC);

CREATE TABLE IF NOT EXISTS reports(
  id bigserial PRIMARY KEY,
  reporter_id uuid NOT NULL REFERENCES users(id),
  target_user_id uuid REFERENCES users(id),
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  reason text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewed','dismissed')),
  resolution text,
  moderated_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status,created_at DESC);
