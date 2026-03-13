import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.gmgui/data.db');

const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get('conv-1773345760020-nbff5d5b9');
console.log('Conversation:', conv);

const sessions = db.prepare('SELECT id, conversation_id, status, created_at FROM sessions WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 5').all('conv-1773345760020-nbff5d5b9');
console.log('Recent sessions:', sessions);

const latestSession = db.prepare('SELECT id, status FROM sessions WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1').get('conv-1773345760020-nbff5d5b9');
console.log('Latest session status:', latestSession);
