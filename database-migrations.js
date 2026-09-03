import fs from 'fs';

export function migrateFromJson(db, oldJsonPath) {
  if (!fs.existsSync(oldJsonPath)) return;
  try {
    const content = fs.readFileSync(oldJsonPath, 'utf-8');
    const data = JSON.parse(content);
    const migrationStmt = db.transaction(() => {
      if (data.conversations) {
        for (const id in data.conversations) {
          const conv = data.conversations[id];
          db.prepare(
            `INSERT OR REPLACE INTO conversations (id, agentId, title, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, ?)`
          ).run(conv.id, conv.agentId, conv.title || null, conv.created_at, conv.updated_at, conv.status || 'active');
        }
      }
      if (data.messages) {
        for (const id in data.messages) {
          const msg = data.messages[id];
          const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
          db.prepare(
            `INSERT OR REPLACE INTO messages (id, conversationId, role, content, created_at) VALUES (?, ?, ?, ?, ?)`
          ).run(msg.id, msg.conversationId, msg.role, contentStr, msg.created_at);
        }
      }
      if (data.sessions) {
        for (const id in data.sessions) {
          const sess = data.sessions[id];
          const responseStr = sess.response ? (typeof sess.response === 'string' ? sess.response : JSON.stringify(sess.response)) : null;
          const errorStr = sess.error ? (typeof sess.error === 'string' ? sess.error : JSON.stringify(sess.error)) : null;
          db.prepare(
            `INSERT OR REPLACE INTO sessions (id, conversationId, status, started_at, completed_at, response, error) VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(sess.id, sess.conversationId, sess.status, sess.started_at, sess.completed_at || null, responseStr, errorStr);
        }
      }
      if (data.events) {
        for (const id in data.events) {
          const evt = data.events[id];
          const dataStr = typeof evt.data === 'string' ? evt.data : JSON.stringify(evt.data || {});
          db.prepare(
            `INSERT OR REPLACE INTO events (id, type, conversationId, sessionId, data, created_at) VALUES (?, ?, ?, ?, ?, ?)`
          ).run(evt.id, evt.type, evt.conversationId || null, evt.sessionId || null, dataStr, evt.created_at);
        }
      }
      if (data.idempotencyKeys) {
        for (const key in data.idempotencyKeys) {
          const entry = data.idempotencyKeys[key];
          const valueStr = typeof entry.value === 'string' ? entry.value : JSON.stringify(entry.value || {});
          const ttl = typeof entry.ttl === 'number' ? entry.ttl : (entry.ttl ? parseInt(entry.ttl) : 0);
          db.prepare(
            `INSERT OR REPLACE INTO idempotencyKeys (key, value, created_at, ttl) VALUES (?, ?, ?, ?)`
          ).run(key, valueStr, entry.created_at, ttl);
        }
      }
    });
    migrationStmt();
    fs.renameSync(oldJsonPath, `${oldJsonPath}.migrated`);
    console.log('Migrated data from JSON to SQLite');
  } catch (e) {
    console.error('Error during migration:', e.message);
  }
}

export function migrateToACP(db) {
  try {
    const migrate = db.transaction(() => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS thread_states (
          id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, checkpoint_id TEXT,
          state_data TEXT NOT NULL, created_at INTEGER NOT NULL,
          FOREIGN KEY (thread_id) REFERENCES conversations(id) ON DELETE CASCADE,
          FOREIGN KEY (checkpoint_id) REFERENCES checkpoints(id) ON DELETE SET NULL
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS checkpoints (
          id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, checkpoint_name TEXT NOT NULL,
          sequence INTEGER NOT NULL, created_at INTEGER NOT NULL,
          FOREIGN KEY (thread_id) REFERENCES conversations(id) ON DELETE CASCADE
        )
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS run_metadata (
          id TEXT PRIMARY KEY, run_id TEXT NOT NULL UNIQUE, thread_id TEXT,
          agent_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
          input TEXT, config TEXT, webhook_url TEXT,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          FOREIGN KEY (thread_id) REFERENCES conversations(id) ON DELETE CASCADE
        )
      `);
      const convColNames = db.prepare("PRAGMA table_info(conversations)").all().map(c => c.name);
      if (!convColNames.includes('metadata')) db.exec('ALTER TABLE conversations ADD COLUMN metadata TEXT');
      const sessColNames = db.prepare("PRAGMA table_info(sessions)").all().map(c => c.name);
      for (const [colName, colType] of Object.entries({ run_id: 'TEXT', input: 'TEXT', config: 'TEXT', interrupt: 'TEXT' })) {
        if (!sessColNames.includes(colName)) db.exec(`ALTER TABLE sessions ADD COLUMN ${colName} ${colType}`);
      }
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_thread_states_thread ON thread_states(thread_id);
        CREATE INDEX IF NOT EXISTS idx_thread_states_checkpoint ON thread_states(checkpoint_id);
        CREATE INDEX IF NOT EXISTS idx_thread_states_created ON thread_states(created_at);
        CREATE INDEX IF NOT EXISTS idx_checkpoints_thread ON checkpoints(thread_id);
        CREATE INDEX IF NOT EXISTS idx_checkpoints_sequence ON checkpoints(thread_id, sequence);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_checkpoints_unique_seq ON checkpoints(thread_id, sequence);
        CREATE INDEX IF NOT EXISTS idx_run_metadata_run_id ON run_metadata(run_id);
        CREATE INDEX IF NOT EXISTS idx_run_metadata_thread ON run_metadata(thread_id);
        CREATE INDEX IF NOT EXISTS idx_run_metadata_status ON run_metadata(status);
        CREATE INDEX IF NOT EXISTS idx_run_metadata_agent ON run_metadata(agent_id);
        CREATE INDEX IF NOT EXISTS idx_run_metadata_created ON run_metadata(created_at);
        CREATE INDEX IF NOT EXISTS idx_sessions_run_id ON sessions(run_id);
      `);
    });
    migrate();
  } catch (err) {
    console.error('[Migration] ACP schema migration error:', err.message);
  }
}

export function migrateConversationColumns(db) {
  try {
    const columnNames = db.prepare("PRAGMA table_info(conversations)").all().map(r => r.name);
    const requiredColumns = {
      agentType: 'TEXT', source: 'TEXT DEFAULT "gui"', externalId: 'TEXT',
      firstPrompt: 'TEXT', messageCount: 'INTEGER DEFAULT 0', projectPath: 'TEXT',
      gitBranch: 'TEXT', sourcePath: 'TEXT', lastSyncedAt: 'INTEGER',
      workingDirectory: 'TEXT', claudeSessionId: 'TEXT', isStreaming: 'INTEGER DEFAULT 0',
      model: 'TEXT', subAgent: 'TEXT', pinned: 'INTEGER DEFAULT 0',
      tags: 'TEXT', sortOrder: 'INTEGER DEFAULT 0'
    };
    let addedColumns = false;
    for (const [colName, colDef] of Object.entries(requiredColumns)) {
      if (!columnNames.includes(colName)) {
        db.exec(`ALTER TABLE conversations ADD COLUMN ${colName} ${colDef}`);
        console.log(`[Migration] Added column ${colName} to conversations table`);
        addedColumns = true;
      }
    }
    if (addedColumns) {
      try {
        db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_external ON conversations(externalId)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_agent_type ON conversations(agentType)`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_conversations_source ON conversations(source)`);
      } catch (e) {
        console.warn('[Migration] Index creation warning:', e.message);
      }
    }
  } catch (err) {
    console.error('[Migration] Error:', err.message);
  }
}
