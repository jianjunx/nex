pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    path        TEXT NOT NULL UNIQUE,
    created_at  INTEGER NOT NULL,
    last_opened INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id),
    title       TEXT NOT NULL DEFAULT 'New Chat',
    agent_type  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'idle',
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    role            TEXT NOT NULL,
    content         TEXT NOT NULL,
    tool_summary    TEXT,
    timestamp       INTEGER NOT NULL,
    sequence        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conv_project ON conversations(project_id);
CREATE INDEX IF NOT EXISTS idx_conv_updated ON conversations(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_msg_conv_seq ON messages(conversation_id, sequence);

-- Persisted agent thread entries (thought/tool_call/etc).
-- We store the whole ThreadEntry payload as JSON so the UI can restore
-- thinking and tool-call cards accurately after restart.
CREATE TABLE IF NOT EXISTS thread_entries (
    id              TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id),
    kind            TEXT NOT NULL,
    sequence       INTEGER NOT NULL,
    timestamp      INTEGER NOT NULL,
    payload_json   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_thread_conv_seq ON thread_entries(conversation_id, sequence);

-- One-time, versioned data-maintenance markers. This is intentionally kept
-- separate from SQLite's user_version so independent schema additions remain
-- backwards-compatible with existing Nex databases.
CREATE TABLE IF NOT EXISTS nex_metadata (
    key     TEXT PRIMARY KEY,
    value   TEXT NOT NULL
);
"#;
