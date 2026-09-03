export function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      agentId TEXT NOT NULL,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      status TEXT DEFAULT 'active'
    );

    CREATE INDEX IF NOT EXISTS idx_conversations_agent ON conversations(agentId);
    CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversationId TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (conversationId) REFERENCES conversations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversationId);

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      conversationId TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      response TEXT,
      error TEXT,
      FOREIGN KEY (conversationId) REFERENCES conversations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_conversation ON sessions(conversationId);
    CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(conversationId, status);

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      conversationId TEXT,
      sessionId TEXT,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (conversationId) REFERENCES conversations(id),
      FOREIGN KEY (sessionId) REFERENCES sessions(id)
    );

    CREATE INDEX IF NOT EXISTS idx_events_conversation ON events(conversationId);

    CREATE TABLE IF NOT EXISTS idempotencyKeys (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      ttl INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotencyKeys(created_at);

    CREATE TABLE IF NOT EXISTS stream_updates (
      id TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL,
      conversationId TEXT NOT NULL,
      updateType TEXT NOT NULL,
      content TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (sessionId) REFERENCES sessions(id),
      FOREIGN KEY (conversationId) REFERENCES conversations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_stream_updates_session ON stream_updates(sessionId);
    CREATE INDEX IF NOT EXISTS idx_stream_updates_created ON stream_updates(created_at);

    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL,
      conversationId TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      data BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (sessionId) REFERENCES sessions(id),
      FOREIGN KEY (conversationId) REFERENCES conversations(id)
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(sessionId, sequence);
    CREATE INDEX IF NOT EXISTS idx_chunks_conversation ON chunks(conversationId, sequence);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_unique ON chunks(sessionId, sequence);
    CREATE INDEX IF NOT EXISTS idx_chunks_conv_created ON chunks(conversationId, created_at);
    CREATE INDEX IF NOT EXISTS idx_chunks_sess_created ON chunks(sessionId, created_at);

    CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY,
      workflowName TEXT NOT NULL,
      workflowId TEXT,
      runId TEXT,
      sha TEXT,
      branch TEXT,
      status TEXT,
      conclusion TEXT,
      htmlUrl TEXT,
      triggeredAt INTEGER NOT NULL,
      completedAt INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_workflow_runs_name ON workflow_runs(workflowName);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_sha ON workflow_runs(sha);
    CREATE INDEX IF NOT EXISTS idx_workflow_runs_completed ON workflow_runs(completedAt);

  `);
}
