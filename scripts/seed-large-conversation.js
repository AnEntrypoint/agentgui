#!/usr/bin/env bun
// Seed a large conversation for profiling browser rendering performance.
// Usage: bun scripts/seed-large-conversation.js [--turns N] [--chunks-per-turn N]
// Output: conversation ID on stdout, progress on stderr.

import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import path from 'path';
import os from 'os';
import fs from 'fs';

const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 ? parseInt(args[i + 1]) : def;
};
const turns = getArg('--turns', 6000);
const chunksPerTurn = getArg('--chunks-per-turn', 5);

const dataDir = process.env.PORTABLE_DATA_DIR || path.join(os.homedir(), '.gmgui');
const dbDir = dataDir;
fs.mkdirSync(dbDir, { recursive: true });
const dbPath = path.join(dbDir, 'data.db');

console.error(`[seed] opening ${dbPath}`);
const db = new Database(dbPath);
db.run('PRAGMA journal_mode = WAL');
db.run('PRAGMA synchronous = NORMAL');

db.run(`CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, agentId TEXT NOT NULL, title TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, status TEXT DEFAULT 'active',
  agentType TEXT, workingDirectory TEXT, model TEXT, isStreaming INTEGER DEFAULT 0,
  claudeSessionId TEXT, subAgent TEXT, tags TEXT, pinned INTEGER DEFAULT 0,
  sortOrder INTEGER DEFAULT 0, source TEXT DEFAULT 'gui'
)`);
db.run(`CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, role TEXT NOT NULL,
  content TEXT NOT NULL, created_at INTEGER NOT NULL
)`);
db.run(`CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, conversationId TEXT NOT NULL, status TEXT NOT NULL,
  started_at INTEGER NOT NULL, completed_at INTEGER, response TEXT, error TEXT,
  run_id TEXT, input TEXT, config TEXT, interrupt TEXT, claudeSessionId TEXT
)`);
db.run(`CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY, sessionId TEXT NOT NULL, conversationId TEXT NOT NULL,
  sequence INTEGER NOT NULL, type TEXT NOT NULL, data BLOB NOT NULL, created_at INTEGER NOT NULL
)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_chunks_conv_created ON chunks(conversationId, created_at)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_chunks_session ON chunks(sessionId, sequence)`);
try { db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_unique ON chunks(sessionId, sequence)`); } catch(_) {}

const convId = randomUUID();
const now = Date.now();
const TURN_INTERVAL_MS = 30000;
const startTime = now - turns * TURN_INTERVAL_MS;

console.error(`[seed] inserting conversation ${convId} with ${turns} turns, ${chunksPerTurn} chunks/turn`);

db.run(
  `INSERT INTO conversations (id, agentId, title, created_at, updated_at, status, agentType, workingDirectory, model)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [convId, 'cli-claude', `Profiling Seed - ${turns} turns`, startTime, now, 'active', 'claude', '/home/user', 'claude-opus-4-6']
);

const insertMsg = db.prepare(
  `INSERT INTO messages (id, conversationId, role, content, created_at) VALUES (?, ?, ?, ?, ?)`
);
const insertSession = db.prepare(
  `INSERT INTO sessions (id, conversationId, status, started_at, completed_at) VALUES (?, ?, ?, ?, ?)`
);
const insertChunk = db.prepare(
  `INSERT INTO chunks (id, sessionId, conversationId, sequence, type, data, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
);

const prompts = [
  'Read the file src/index.ts and explain what it does.',
  'Search for all uses of useEffect in the codebase.',
  'Write a function to validate email addresses.',
  'Fix the TypeScript error in lib/auth.ts line 42.',
  'Add unit tests for the formatDate utility.',
  'Refactor the database connection pool to use async/await.',
  'Find all TODO comments in the project.',
  'Implement pagination for the user list endpoint.',
  'Add error handling to the upload route.',
  'Create a migration to add the created_at column.',
];
const toolNames = ['Read', 'Bash', 'Glob', 'Grep', 'Write', 'Edit'];
const filePaths = ['src/index.ts', 'lib/auth.ts', 'lib/db.ts', 'src/components/App.tsx', 'tests/auth.test.ts'];

let totalChunks = 0;

const runBatch = db.transaction((batchTurns) => {
  for (const { turn, t } of batchTurns) {
    const prompt = prompts[turn % prompts.length];
    insertMsg.run(randomUUID(), convId, 'user', prompt, t);

    const sessId = randomUUID();
    const sessStart = t + 1000;
    const sessEnd = sessStart + 8000 + (turn % 5) * 2000;
    insertSession.run(sessId, convId, 'completed', sessStart, sessEnd);

    let seq = 0;
    insertChunk.run(
      randomUUID(), sessId, convId, seq++, 'block',
      JSON.stringify({ type: 'text', text: `I'll help with that. Let me analyze ${prompt.slice(0, 40)}...` }),
      sessStart + 500
    );

    const pairs = Math.max(1, Math.floor((chunksPerTurn - 2) / 2));
    for (let p = 0; p < pairs; p++) {
      const tool = toolNames[(turn + p) % toolNames.length];
      const file = filePaths[(turn + p) % filePaths.length];
      const toolUseId = `tu_${turn}_${p}`;
      const input = tool === 'Bash' ? { command: `cat ${file} | head -20` }
                  : tool === 'Glob' ? { pattern: '**/*.ts' }
                  : tool === 'Grep' ? { pattern: 'useEffect', path: '.' }
                  : { file_path: file };
      insertChunk.run(
        randomUUID(), sessId, convId, seq++, 'block',
        JSON.stringify({ type: 'tool_use', id: toolUseId, name: tool, input }),
        sessStart + 1000 + p * 800
      );
      const resultContent = tool === 'Read' ? `// ${file}\nexport function main() {\n  return 42;\n}\n`
                           : tool === 'Bash' ? `stdout: Line 1\nLine 2\nLine 3\n`
                           : tool === 'Glob' ? `src/index.ts\nsrc/app.ts\n`
                           : `src/App.tsx:12: useEffect(() => {\n`;
      insertChunk.run(
        randomUUID(), sessId, convId, seq++, 'block',
        JSON.stringify({ type: 'tool_result', tool_use_id: toolUseId, content: resultContent }),
        sessStart + 1400 + p * 800
      );
    }

    insertChunk.run(
      randomUUID(), sessId, convId, seq++, 'block',
      JSON.stringify({ type: 'text', text: `Done. The file looks correct. I've completed turn ${turn + 1}.` }),
      sessEnd - 200
    );

    totalChunks += seq;
  }
});

const BATCH = 500;
for (let i = 0; i < turns; i += BATCH) {
  const batch = [];
  for (let j = i; j < Math.min(i + BATCH, turns); j++) {
    batch.push({ turn: j, t: startTime + j * TURN_INTERVAL_MS });
  }
  runBatch(batch);
  process.stderr.write(`\r[seed] ${Math.min(i + BATCH, turns)}/${turns} turns`);
}

db.close();
process.stderr.write('\n');
console.error(`[seed] complete - ${totalChunks} total chunks for conv ${convId}`);
console.log(convId);
