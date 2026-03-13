import Database from 'better-sqlite3';
const db = new Database(process.env.HOME + '/.gmgui/data.db');

// Check what columns exist in sessions
const sessions = db.prepare('SELECT * FROM sessions WHERE id = ?').all('3119107b-399c-4ecb-9c7a-96f256e36538');
console.log('Session info:', sessions[0]);

// Check if there are any recent messages/events for this conversation
const messages = db.prepare('SELECT id, conversation_id, content, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 3').all('conv-1773345760020-nbff5d5b9');
console.log('Recent messages:', messages);
