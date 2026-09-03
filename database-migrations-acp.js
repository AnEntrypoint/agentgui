import fs from 'fs';

export function migrateACPSchema(db) {
  try {
    console.log('[Migration] Running ACP schema migration...');
    const convColsACP = db.prepare("PRAGMA table_info(conversations)").all().map(c => c.name);
    if (!convColsACP.includes('metadata')) {
      db.exec('ALTER TABLE conversations ADD COLUMN metadata TEXT DEFAULT "{}"');
      console.log('[Migration] Added metadata column to conversations');
    }
    const sessColsACP = db.prepare("PRAGMA table_info(sessions)").all().map(c => c.name);
    for (const [col] of [['run_id'],['input'],['config'],['interrupt'],['claudeSessionId']]) {
      if (!sessColsACP.includes(col)) {
        db.exec(`ALTER TABLE sessions ADD COLUMN ${col} TEXT`);
        console.log(`[Migration] Added ${col} column to sessions`);
      }
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_states (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL, state_data TEXT NOT NULL, created_at INTEGER NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_thread_states_thread ON thread_states(thread_id);
      CREATE INDEX IF NOT EXISTS idx_thread_states_checkpoint ON thread_states(checkpoint_id);
      CREATE INDEX IF NOT EXISTS idx_thread_states_created ON thread_states(created_at);
      CREATE TABLE IF NOT EXISTS checkpoints (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL,
        checkpoint_name TEXT, sequence INTEGER NOT NULL, created_at INTEGER NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_checkpoints_thread ON checkpoints(thread_id);
      CREATE INDEX IF NOT EXISTS idx_checkpoints_sequence ON checkpoints(thread_id, sequence);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_checkpoints_unique ON checkpoints(thread_id, sequence);
      CREATE TABLE IF NOT EXISTS run_metadata (
        run_id TEXT PRIMARY KEY, thread_id TEXT, agent_id TEXT NOT NULL,
        status TEXT NOT NULL, input TEXT, config TEXT, webhook_url TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        FOREIGN KEY (thread_id) REFERENCES conversations(id) ON DELETE CASCADE,
        FOREIGN KEY (run_id) REFERENCES sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_run_metadata_thread ON run_metadata(thread_id);
      CREATE INDEX IF NOT EXISTS idx_run_metadata_agent ON run_metadata(agent_id);
      CREATE INDEX IF NOT EXISTS idx_run_metadata_status ON run_metadata(status);
      CREATE INDEX IF NOT EXISTS idx_run_metadata_created ON run_metadata(created_at);
    `);
    console.log('[Migration] ACP schema migration complete');
  } catch (err) {
    console.error('[Migration] ACP schema migration error:', err.message);
  }
}

export function migrateBackfillMessages(db) {
  try {
    const emptyImported = db.prepare(`
      SELECT c.id, c.sourcePath FROM conversations c
      LEFT JOIN messages m ON c.id = m.conversationId
      WHERE c.sourcePath IS NOT NULL AND c.status != 'deleted'
      GROUP BY c.id HAVING COUNT(m.id) = 0
    `).all();
    if (emptyImported.length === 0) return;
    console.log(`[Migration] Backfilling messages for ${emptyImported.length} imported conversation(s)`);
    const insertMsg = db.prepare(`INSERT OR IGNORE INTO messages (id, conversationId, role, content, created_at) VALUES (?, ?, ?, ?, ?)`);
    const backfill = db.transaction(() => {
      for (const conv of emptyImported) {
        if (!fs.existsSync(conv.sourcePath)) continue;
        try {
          const lines = fs.readFileSync(conv.sourcePath, 'utf-8').split('\n');
          let count = 0;
          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const obj = JSON.parse(line);
              const msgId = obj.uuid || `msg-${Date.now()}-${Math.random().toString(36).substr(2,9)}`;
              const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now();
              if (obj.type === 'user' && obj.message?.content) {
                const raw = obj.message.content;
                const text = typeof raw === 'string' ? raw
                  : Array.isArray(raw) ? raw.filter(c => c.type === 'text').map(c => c.text).join('\n')
                  : JSON.stringify(raw);
                if (text && !text.startsWith('[{"tool_use_id"')) { insertMsg.run(msgId, conv.id, 'user', text, ts); count++; }
              } else if (obj.type === 'assistant' && obj.message?.content) {
                const raw = obj.message.content;
                const text = Array.isArray(raw)
                  ? raw.filter(c => c.type === 'text' && c.text).map(c => c.text).join('\n\n')
                  : typeof raw === 'string' ? raw : '';
                if (text) { insertMsg.run(msgId, conv.id, 'assistant', text, ts); count++; }
              }
            } catch (_) {}
          }
          if (count > 0) console.log(`[Migration] Backfilled ${count} messages for conversation ${conv.id}`);
        } catch (e) {
          console.error(`[Migration] Error backfilling ${conv.id}:`, e.message);
        }
      }
    });
    backfill();
  } catch (err) {
    console.error('[Migration] Backfill error:', err.message);
  }
}

export function migrateFTS(db) {
  try {
    const hasFts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'").get();
    if (!hasFts) {
      db.exec("CREATE VIRTUAL TABLE messages_fts USING fts5(content, conversationId UNINDEXED, role UNINDEXED, content_rowid='rowid')");
      const msgs = db.prepare("SELECT rowid, content, conversationId, role FROM messages").all();
      if (msgs.length > 0) {
        const ins = db.prepare("INSERT INTO messages_fts(rowid, content, conversationId, role) VALUES (?, ?, ?, ?)");
        const tx = db.transaction(() => { for (const m of msgs) ins.run(m.rowid, m.content, m.conversationId, m.role); });
        tx();
        console.log(`[Migration] FTS5 index created with ${msgs.length} messages`);
      }
    }
  } catch (err) {
    console.error('[Migration] FTS5 error:', err.message);
  }
}

export function migrateAutoVacuum(db) {
  try {
    const autoVacuum = db.prepare('PRAGMA auto_vacuum').get();
    const mode = autoVacuum?.auto_vacuum ?? autoVacuum;
    if (mode !== 2) {
      console.log('[Migration] Enabling incremental auto_vacuum (one-time VACUUM)...');
      db.exec('PRAGMA auto_vacuum = INCREMENTAL');
      console.log('[Migration] auto_vacuum = INCREMENTAL enabled (VACUUM skipped)');
    }
  } catch (err) {
    console.error('[Migration] auto_vacuum setup error:', err.message);
  }
}
