import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const dbDir = path.join(os.homedir(), '.gmgui');
const dbFilePath = path.join(dbDir, 'data.db');
const oldJsonPath = path.join(dbDir, 'data.json');

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let db;
try {
  const Database = (await import('bun:sqlite')).default;
  db = new Database(dbFilePath);
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA foreign_keys = ON');
} catch (e) {
  try {
    const sqlite3 = require('better-sqlite3');
    db = new sqlite3(dbFilePath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  } catch (e2) {
    throw new Error('SQLite database is required. Please run with bun (recommended) or install better-sqlite3: npm install better-sqlite3');
  }
}

function initSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      agentId TEXT NOT NULL,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      status TEXT DEFAULT 'active'
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_conversations_agent ON conversations(agentId)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversationId TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (conversationId) REFERENCES conversations(id)
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversationId)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      conversationId TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      completed_at INTEGER,
      response TEXT,
      error TEXT,
      FOREIGN KEY (conversationId) REFERENCES conversations(id)
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_conversation ON sessions(conversationId)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(conversationId, status)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      conversationId TEXT,
      sessionId TEXT,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (conversationId) REFERENCES conversations(id),
      FOREIGN KEY (sessionId) REFERENCES sessions(id)
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_events_conversation ON events(conversationId)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS idempotencyKeys (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      ttl INTEGER NOT NULL
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_idempotency_created ON idempotencyKeys(created_at)`);
}

function migrateFromJson() {
  if (!fs.existsSync(oldJsonPath)) return;

  try {
    const content = fs.readFileSync(oldJsonPath, 'utf-8');
    const data = JSON.parse(content);

    if (data.conversations) {
      for (const id in data.conversations) {
        const conv = data.conversations[id];
        db.run(
          `INSERT OR REPLACE INTO conversations (id, agentId, title, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, ?)`,
          [conv.id, conv.agentId, conv.title || null, conv.created_at, conv.updated_at, conv.status || 'active']
        );
      }
    }

    if (data.messages) {
      for (const id in data.messages) {
        const msg = data.messages[id];
        db.run(
          `INSERT OR REPLACE INTO messages (id, conversationId, role, content, created_at) VALUES (?, ?, ?, ?, ?)`,
          [msg.id, msg.conversationId, msg.role, msg.content, msg.created_at]
        );
      }
    }

    if (data.sessions) {
      for (const id in data.sessions) {
        const sess = data.sessions[id];
        db.run(
          `INSERT OR REPLACE INTO sessions (id, conversationId, status, started_at, completed_at, response, error) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [sess.id, sess.conversationId, sess.status, sess.started_at, sess.completed_at || null, sess.response || null, sess.error || null]
        );
      }
    }

    if (data.events) {
      for (const id in data.events) {
        const evt = data.events[id];
        db.run(
          `INSERT OR REPLACE INTO events (id, type, conversationId, sessionId, data, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
          [evt.id, evt.type, evt.conversationId || null, evt.sessionId || null, JSON.stringify(evt.data), evt.created_at]
        );
      }
    }

    if (data.idempotencyKeys) {
      for (const key in data.idempotencyKeys) {
        const entry = data.idempotencyKeys[key];
        db.run(
          `INSERT OR REPLACE INTO idempotencyKeys (key, value, created_at, ttl) VALUES (?, ?, ?, ?)`,
          [key, JSON.stringify(entry.value), entry.created_at, entry.ttl]
        );
      }
    }

    fs.renameSync(oldJsonPath, `${oldJsonPath}.migrated`);
    console.log('Migrated data from JSON to SQLite');
  } catch (e) {
    console.error('Error during migration:', e.message);
  }
}

initSchema();
migrateFromJson();

function generateId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export const queries = {
  createConversation(agentId, title = null) {
    const id = generateId('conv');
    const now = Date.now();
    const stmt = db.prepare(
      `INSERT INTO conversations (id, agentId, title, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, ?)`
    );
    stmt.run(id, agentId, title, now, now, 'active');

    return {
      id,
      agentId,
      title,
      created_at: now,
      updated_at: now,
      status: 'active'
    };
  },

  getConversation(id) {
    const stmt = db.prepare('SELECT * FROM conversations WHERE id = ?');
    return stmt.get(id);
  },

  getAllConversations() {
    const stmt = db.prepare('SELECT * FROM conversations ORDER BY updated_at DESC');
    return stmt.all();
  },

  updateConversation(id, data) {
    const conv = this.getConversation(id);
    if (!conv) return null;

    const now = Date.now();
    const title = data.title !== undefined ? data.title : conv.title;
    const status = data.status !== undefined ? data.status : conv.status;

    const stmt = db.prepare(
      `UPDATE conversations SET title = ?, status = ?, updated_at = ? WHERE id = ?`
    );
    stmt.run(title, status, now, id);

    return {
      ...conv,
      title,
      status,
      updated_at: now
    };
  },

  createMessage(conversationId, role, content, idempotencyKey = null) {
    if (idempotencyKey) {
      const cached = this.getIdempotencyKey(idempotencyKey);
      if (cached) return JSON.parse(cached);
    }

    const id = generateId('msg');
    const now = Date.now();

    const stmt = db.prepare(
      `INSERT INTO messages (id, conversationId, role, content, created_at) VALUES (?, ?, ?, ?, ?)`
    );
    stmt.run(id, conversationId, role, content, now);

    const updateConvStmt = db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?');
    updateConvStmt.run(now, conversationId);

    const message = {
      id,
      conversationId,
      role,
      content,
      created_at: now
    };

    if (idempotencyKey) {
      this.setIdempotencyKey(idempotencyKey, message);
    }

    return message;
  },

  getMessage(id) {
    const stmt = db.prepare('SELECT * FROM messages WHERE id = ?');
    return stmt.get(id);
  },

  getConversationMessages(conversationId) {
    const stmt = db.prepare(
      'SELECT * FROM messages WHERE conversationId = ? ORDER BY created_at ASC'
    );
    return stmt.all(conversationId);
  },

  createSession(conversationId) {
    const id = generateId('sess');
    const now = Date.now();

    const stmt = db.prepare(
      `INSERT INTO sessions (id, conversationId, status, started_at, completed_at, response, error) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    stmt.run(id, conversationId, 'pending', now, null, null, null);

    return {
      id,
      conversationId,
      status: 'pending',
      started_at: now,
      completed_at: null,
      response: null,
      error: null
    };
  },

  getSession(id) {
    const stmt = db.prepare('SELECT * FROM sessions WHERE id = ?');
    return stmt.get(id);
  },

  getConversationSessions(conversationId) {
    const stmt = db.prepare(
      'SELECT * FROM sessions WHERE conversationId = ? ORDER BY started_at DESC'
    );
    return stmt.all(conversationId);
  },

  updateSession(id, data) {
    const session = this.getSession(id);
    if (!session) return null;

    const status = data.status !== undefined ? data.status : session.status;
    const response = data.response !== undefined ? data.response : session.response;
    const error = data.error !== undefined ? data.error : session.error;
    const completed_at = data.completed_at !== undefined ? data.completed_at : session.completed_at;

    const stmt = db.prepare(
      `UPDATE sessions SET status = ?, response = ?, error = ?, completed_at = ? WHERE id = ?`
    );

    try {
      stmt.run(status, response, error, completed_at, id);
      return {
        ...session,
        status,
        response,
        error,
        completed_at
      };
    } catch (e) {
      throw e;
    }
  },

  getLatestSession(conversationId) {
    const stmt = db.prepare(
      'SELECT * FROM sessions WHERE conversationId = ? ORDER BY started_at DESC LIMIT 1'
    );
    return stmt.get(conversationId) || null;
  },

  getSessionsByStatus(conversationId, status) {
    const stmt = db.prepare(
      'SELECT * FROM sessions WHERE conversationId = ? AND status = ? ORDER BY started_at DESC'
    );
    return stmt.all(conversationId, status);
  },

  createEvent(type, data, conversationId = null, sessionId = null) {
    const id = generateId('evt');
    const now = Date.now();

    const stmt = db.prepare(
      `INSERT INTO events (id, type, conversationId, sessionId, data, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    );
    stmt.run(id, type, conversationId, sessionId, JSON.stringify(data), now);

    return {
      id,
      type,
      conversationId,
      sessionId,
      data,
      created_at: now
    };
  },

  getEvent(id) {
    const stmt = db.prepare('SELECT * FROM events WHERE id = ?');
    const row = stmt.get(id);
    if (row) {
      return {
        ...row,
        data: JSON.parse(row.data)
      };
    }
    return undefined;
  },

  getConversationEvents(conversationId) {
    const stmt = db.prepare(
      'SELECT * FROM events WHERE conversationId = ? ORDER BY created_at ASC'
    );
    const rows = stmt.all(conversationId);
    return rows.map(row => ({
      ...row,
      data: JSON.parse(row.data)
    }));
  },

  getSessionEvents(sessionId) {
    const stmt = db.prepare(
      'SELECT * FROM events WHERE sessionId = ? ORDER BY created_at ASC'
    );
    const rows = stmt.all(sessionId);
    return rows.map(row => ({
      ...row,
      data: JSON.parse(row.data)
    }));
  },

  deleteConversation(id) {
    const conv = this.getConversation(id);
    if (!conv) return false;

    db.run('DELETE FROM messages WHERE conversationId = ?', [id]);
    db.run('DELETE FROM sessions WHERE conversationId = ?', [id]);
    db.run('DELETE FROM events WHERE conversationId = ?', [id]);
    db.run('DELETE FROM conversations WHERE id = ?', [id]);

    return true;
  },

  cleanup() {
    const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);

    db.run('DELETE FROM events WHERE created_at < ?', [thirtyDaysAgo]);
    db.run(
      'DELETE FROM sessions WHERE completed_at IS NOT NULL AND completed_at < ?',
      [thirtyDaysAgo]
    );

    const now = Date.now();
    db.run('DELETE FROM idempotencyKeys WHERE (created_at + ttl) < ?', [now]);
  },

  setIdempotencyKey(key, value) {
    const now = Date.now();
    const ttl = 24 * 60 * 60 * 1000;

    const stmt = db.prepare(
      'INSERT OR REPLACE INTO idempotencyKeys (key, value, created_at, ttl) VALUES (?, ?, ?, ?)'
    );
    stmt.run(key, JSON.stringify(value), now, ttl);
  },

  getIdempotencyKey(key) {
    const stmt = db.prepare('SELECT * FROM idempotencyKeys WHERE key = ?');
    const entry = stmt.get(key);

    if (!entry) return null;

    const isExpired = Date.now() - entry.created_at > entry.ttl;
    if (isExpired) {
      db.run('DELETE FROM idempotencyKeys WHERE key = ?', [key]);
      return null;
    }

    return entry.value;
  },

  clearIdempotencyKey(key) {
    db.run('DELETE FROM idempotencyKeys WHERE key = ?', [key]);
  },

  discoverClaudeCodeConversations() {
    const claudeHomeDir = path.join(os.homedir(), '.claude-code');
    const conversationsDir = path.join(claudeHomeDir, 'conversations');

    if (!fs.existsSync(conversationsDir)) {
      return [];
    }

    const discovered = [];
    try {
      const items = fs.readdirSync(conversationsDir, { withFileTypes: true });
      for (const item of items) {
        if (!item.isDirectory()) continue;

        const metadataPath = path.join(conversationsDir, item.name, 'metadata.json');
        const messagesPath = path.join(conversationsDir, item.name, 'messages.json');

        if (!fs.existsSync(metadataPath) || !fs.existsSync(messagesPath)) continue;

        try {
          const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf-8'));
          const messages = JSON.parse(fs.readFileSync(messagesPath, 'utf-8'));

          discovered.push({
            id: item.name,
            metadata,
            messages,
            source: 'claude-code'
          });
        } catch (e) {
          console.error(`Error reading Claude Code conversation ${item.name}:`, e.message);
        }
      }
    } catch (e) {
      console.error('Error discovering Claude Code conversations:', e.message);
    }

    return discovered;
  },

  importClaudeCodeConversations() {
    const discovered = this.discoverClaudeCodeConversations();
    const imported = [];

    for (const conv of discovered) {
      try {
        const existingConv = db.prepare('SELECT id FROM conversations WHERE id = ?').get(conv.id);
        if (existingConv) {
          imported.push({ id: conv.id, status: 'skipped', reason: 'Already imported' });
          continue;
        }

        const title = conv.metadata?.title || 'Claude Code Conversation';
        const createdAt = conv.metadata?.created_at || Date.now();
        const updatedAt = conv.metadata?.updated_at || Date.now();

        db.prepare(
          `INSERT INTO conversations (id, agentId, title, created_at, updated_at, status) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(conv.id, 'claude-code', title, createdAt, updatedAt, 'active');

        for (const msg of (conv.messages || [])) {
          try {
            db.prepare(
              `INSERT INTO messages (id, conversationId, role, content, created_at) VALUES (?, ?, ?, ?, ?)`
            ).run(msg.id || generateId('msg'), conv.id, msg.role || 'user', msg.content || '', msg.created_at || Date.now());
          } catch (e) {
            console.error(`Error importing message in conversation ${conv.id}:`, e.message);
          }
        }

        imported.push({ id: conv.id, status: 'imported', title });
      } catch (e) {
        console.error(`Error importing Claude Code conversation ${conv.id}:`, e.message);
        imported.push({ id: conv.id, status: 'error', error: e.message });
      }
    }

    return imported;
  }
};

export default { queries };
