-- AgentMail initial schema.
-- All timestamps are integer epoch milliseconds (UTC).

CREATE TABLE IF NOT EXISTS inboxes (
  id            TEXT PRIMARY KEY,            -- lowercased address, e.g. "agent-7f3k@mail.example.com"
  address       TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  metadata      TEXT NOT NULL DEFAULT '{}',  -- JSON object, free-form
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id               TEXT PRIMARY KEY,
  inbox_id         TEXT NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  subject          TEXT,                      -- normalized: Re:/Fwd: prefixes stripped
  participants     TEXT NOT NULL DEFAULT '[]', -- JSON array of addresses
  message_count    INTEGER NOT NULL DEFAULT 0,
  last_message_at  INTEGER NOT NULL,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_threads_inbox_last ON threads(inbox_id, last_message_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id                 TEXT PRIMARY KEY,
  inbox_id           TEXT NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  thread_id          TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  direction          TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  message_id_header  TEXT,                    -- RFC 5322 Message-ID incl. angle brackets
  in_reply_to        TEXT,
  references_hdr     TEXT,                    -- space-separated Message-IDs
  from_address       TEXT,
  from_name          TEXT,
  to_json            TEXT NOT NULL DEFAULT '[]',
  cc_json            TEXT NOT NULL DEFAULT '[]',
  bcc_json           TEXT NOT NULL DEFAULT '[]',
  reply_to           TEXT,
  subject            TEXT,
  text               TEXT,
  html               TEXT,
  snippet            TEXT,
  received_at        INTEGER NOT NULL,
  expires_at         INTEGER,                 -- optional per-message TTL (ttl.<seconds> addresses)
  size_bytes         INTEGER NOT NULL DEFAULT 0,
  has_attachments    INTEGER NOT NULL DEFAULT 0,
  labels             TEXT NOT NULL DEFAULT '[]',
  read               INTEGER NOT NULL DEFAULT 0,
  raw_r2_key         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_inbox_msgid ON messages(inbox_id, message_id_header);
CREATE INDEX IF NOT EXISTS idx_messages_inbox_received ON messages(inbox_id, received_at DESC, id);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, received_at ASC);
CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_messages_received ON messages(received_at);

CREATE TABLE IF NOT EXISTS attachments (
  id           TEXT PRIMARY KEY,
  message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename     TEXT,
  mime_type    TEXT,
  size         INTEGER NOT NULL DEFAULT 0,
  disposition  TEXT,                          -- 'attachment' | 'inline'
  content_id   TEXT,
  r2_key       TEXT                           -- NULL when the blob was too large to store
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id);

CREATE TABLE IF NOT EXISTS webhooks (
  id          TEXT PRIMARY KEY,
  inbox_id    TEXT REFERENCES inboxes(id) ON DELETE CASCADE, -- NULL = fires for every inbox
  url         TEXT NOT NULL,
  secret      TEXT NOT NULL,
  events      TEXT NOT NULL DEFAULT '["message.received"]',
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_webhooks_inbox ON webhooks(inbox_id);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id           TEXT PRIMARY KEY,
  webhook_id   TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event_type   TEXT NOT NULL,
  message_id   TEXT,
  status       TEXT NOT NULL,                 -- 'delivered' | 'failed'
  http_status  INTEGER,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deliveries_webhook ON webhook_deliveries(webhook_id, created_at DESC);

-- Full-text search over messages. Standalone table (not external-content) so it
-- survives without triggers; rows are maintained by the application.
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  message_id UNINDEXED,
  inbox_id UNINDEXED,
  subject,
  body,
  from_address,
  tokenize = 'unicode61'
);
