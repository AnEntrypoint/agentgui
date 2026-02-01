import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { pack, unpack } from 'msgpackr';
import os from 'os';
import { queries } from './database.js';
import ACPLauncher from './acp-launcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const watch = process.argv.includes('--watch');

// Serve static files
const staticDir = path.join(__dirname, 'static');
if (!fs.existsSync(staticDir)) {
  fs.mkdirSync(staticDir, { recursive: true });
}

// ACP Session Manager for Claude Code
class ACPSessionManager {
  constructor() {
    this.sessions = new Map();
    this.launchers = new Map();
  }

  async createSession(agentId, cwd, agent = 'claude-code') {
    const sessionId = `acp-${agentId}-${Date.now()}`;

    try {
      let launcher = this.launchers.get(agentId);

      if (!launcher || !launcher.isRunning()) {
        launcher = new ACPLauncher();
        const agentPath = agent === 'opencode' ? 'opencode' : 'claude-code-acp';
        await launcher.launch(agentPath, agent);
        await launcher.initialize();
        this.launchers.set(agentId, launcher);
      }

      const sessionInfo = await launcher.createSession(cwd, sessionId);
      const apcSessionId = sessionInfo.sessionId;

      this.sessions.set(sessionId, {
        agentId,
        cwd,
        sessionId,
        apcSessionId,
        launcher,
        createdAt: Date.now(),
        lastActivity: Date.now(),
      });

      return { sessionId, apcSessionId, ...sessionInfo };
    } catch (err) {
      console.error(`Failed to create ACP session: ${err.message}`);
      throw err;
    }
  }

  async sendPrompt(sessionId, messages) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    try {
      const result = await session.launcher.sendPrompt(session.apcSessionId, messages);
      session.lastActivity = Date.now();
      return result;
    } catch (err) {
      console.error(`Failed to send prompt to ACP: ${err.message}`);
      throw err;
    }
  }

  async cleanup() {
    for (const launcher of this.launchers.values()) {
      await launcher.terminate();
    }
    this.launchers.clear();
    this.sessions.clear();
  }
}

const acpSessionManager = new ACPSessionManager();

// Parse request body
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('error', reject);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

// HTTP server
const server = http.createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  try {
    // API Routes - Conversations
    if (req.url === '/api/conversations' && req.method === 'GET') {
      const conversations = queries.getAllConversations();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ conversations }));
      return;
    }

    if (req.url === '/api/conversations' && req.method === 'POST') {
      const body = await parseBody(req);
      const conversation = queries.createConversation(body.agentId, body.title);
      queries.createEvent('conversation.created', { agentId: body.agentId }, conversation.id);
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ conversation }));
      return;
    }

    // Get specific conversation
    const convMatch = req.url.match(/^\/api\/conversations\/([^/]+)$/);
    if (convMatch && req.method === 'GET') {
      const conversationId = convMatch[1];
      const conversation = queries.getConversation(conversationId);
      if (!conversation) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Conversation not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ conversation }));
      return;
    }

    // Update conversation
    if (convMatch && req.method === 'POST') {
      const conversationId = convMatch[1];
      const body = await parseBody(req);
      const conversation = queries.updateConversation(conversationId, body);
      queries.createEvent('conversation.updated', body, conversationId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ conversation }));
      return;
    }

    // API Routes - Messages
    const messagesMatch = req.url.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (messagesMatch && req.method === 'GET') {
      const conversationId = messagesMatch[1];
      const messages = queries.getConversationMessages(conversationId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ messages }));
      return;
    }

    if (messagesMatch && req.method === 'POST') {
      const conversationId = messagesMatch[1];
      const body = await parseBody(req);

      // Store user message
      const message = queries.createMessage(conversationId, 'user', body.content);
      queries.createEvent('message.created', { role: 'user' }, conversationId);

      // Create session for agent processing
      const session = queries.createSession(conversationId);
      queries.createEvent('session.created', { messageId: message.id }, conversationId, session.id);

      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message, session }));

      // Process in background - don't await, just fire and forget
      processMessage(conversationId, message.id, session.id, body.content, body.agentId, body.folderContext);
      return;
    }

    // Get specific message
    const messageMatch = req.url.match(/^\/api\/conversations\/([^/]+)\/messages\/([^/]+)$/);
    if (messageMatch && req.method === 'GET') {
      const conversationId = messageMatch[1];
      const messageId = messageMatch[2];
      const message = queries.getMessage(messageId);

      if (!message || message.conversationId !== conversationId) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Message not found' }));
        return;
      }

      // Get associated session for this message
      const sessions = queries.getConversationSessions(conversationId);
      const session = sessions.find(s => {
        const events = queries.getSessionEvents(s.id);
        return events.some(e => e.type === 'session.created' && e.data.messageId === messageId);
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message, session }));
      return;
    }

    // API Routes - Sessions
    const sessionMatch = req.url.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch && req.method === 'GET') {
      const sessionId = sessionMatch[1];
      const session = queries.getSession(sessionId);

      if (!session) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }

      const events = queries.getSessionEvents(sessionId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session, events }));
      return;
    }

    // Agents endpoint (legacy support)
    if (req.url === '/api/agents' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ agents: [] }));
      return;
    }

    // Home directory endpoint
    if (req.url === '/api/home' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ home: process.env.HOME || '/config' }));
      return;
    }

    // Serve static files
    let filePath = req.url === '/' ? '/index.html' : req.url;
    filePath = path.join(staticDir, filePath);

    const normalizedPath = path.normalize(filePath);
    if (!normalizedPath.startsWith(staticDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.stat(filePath, (err, stats) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      if (stats.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
        fs.stat(filePath, (err, stats) => {
          if (err) {
            res.writeHead(404);
            res.end('Not found');
            return;
          }
          serveFile(filePath, res);
        });
      } else {
        serveFile(filePath, res);
      }
    });

  } catch (e) {
    console.error('Server error:', e.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: e.message }));
  }
});

function serveFile(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
  };

  const contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end('Server error');
      return;
    }

    let content = data.toString();
    if (ext === '.html' && watch) {
      content += `
<script>
(function() {
  const ws = new WebSocket('ws://' + location.host + '/hot-reload');
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'reload') location.reload();
  };
})();
</script>`;
    }

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
}

// Background message processor
async function processMessage(conversationId, messageId, sessionId, content, agentId, folderContext) {
  try {
    // Update session to processing
    queries.updateSession(sessionId, { status: 'processing' });
    queries.createEvent('session.processing', {}, conversationId, sessionId);

    // For now, if we have folder context and agentId, use ACP
    if (folderContext?.path && agentId) {
      try {
        const sessionResult = await acpSessionManager.createSession(
          agentId,
          folderContext.path,
          agentId === 'opencode' ? 'opencode' : 'claude-code'
        );

        await new Promise(resolve => setTimeout(resolve, 500));

        const messages = [{ role: 'user', content }];
        const promptResult = await acpSessionManager.sendPrompt(
          sessionResult.sessionId,
          messages
        );

        // Store response
        const responseMessage = queries.createMessage(conversationId, 'assistant', JSON.stringify(promptResult));
        queries.updateSession(sessionId, {
          status: 'completed',
          response: promptResult,
          completed_at: Date.now()
        });
        queries.createEvent('session.completed', { responseId: responseMessage.id }, conversationId, sessionId);

      } catch (acpErr) {
        queries.updateSession(sessionId, {
          status: 'error',
          error: acpErr.message,
          completed_at: Date.now()
        });
        queries.createEvent('session.error', { error: acpErr.message }, conversationId, sessionId);
      }
    } else {
      // No agent available, mark as completed with placeholder
      const responseMessage = queries.createMessage(conversationId, 'assistant', 'No agent available to process this message.');
      queries.updateSession(sessionId, {
        status: 'completed',
        response: { text: 'No agent available' },
        completed_at: Date.now()
      });
      queries.createEvent('session.completed', { responseId: responseMessage.id }, conversationId, sessionId);
    }
  } catch (e) {
    console.error('Background processing error:', e.message);
    queries.updateSession(sessionId, {
      status: 'error',
      error: e.message,
      completed_at: Date.now()
    });
    queries.createEvent('session.error', { error: e.message }, conversationId, sessionId);
  }
}

// WebSocket server for hot reload
const wss = new WebSocketServer({ server });
const clients = [];

wss.on('connection', (ws, req) => {
  const url = req.url;

  if (url === '/hot-reload') {
    clients.push(ws);
    ws.on('close', () => {
      const idx = clients.indexOf(ws);
      if (idx > -1) clients.splice(idx, 1);
    });
  }
});

// Hot reload watcher
if (watch) {
  const watchedFiles = new Map();
  const watchFile = (filePath) => {
    if (watchedFiles.has(filePath)) return;
    try {
      fs.watchFile(filePath, { interval: 100 }, (curr, prev) => {
        if (curr.mtime > prev.mtime) {
          clients.forEach(client => {
            if (client.readyState === 1) {
              client.send(JSON.stringify({ type: 'reload' }));
            }
          });
        }
      });
      watchedFiles.set(filePath, true);
    } catch (e) {
      console.error(`Failed to watch ${filePath}:`, e.message);
    }
  };

  // Watch static files
  try {
    const staticFiles = fs.readdirSync(staticDir);
    staticFiles.forEach(file => watchFile(path.join(staticDir, file)));
  } catch (e) {
    console.error('Error watching static files:', e.message);
  }
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Shutting down gracefully...');
  await acpSessionManager.cleanup();
  wss.close(() => {
    server.close(() => {
      process.exit(0);
    });
  });
});

server.listen(PORT, () => {
  console.log(`SQL-based server running on http://localhost:${PORT}`);
  console.log(`Hot reload: ${watch ? 'enabled' : 'disabled'}`);
  console.log('');
  console.log('API endpoints:');
  console.log('  GET  /api/conversations');
  console.log('  POST /api/conversations');
  console.log('  GET  /api/conversations/:id');
  console.log('  POST /api/conversations/:id');
  console.log('  GET  /api/conversations/:id/messages');
  console.log('  POST /api/conversations/:id/messages');
  console.log('  GET  /api/conversations/:id/messages/:id');
  console.log('  GET  /api/sessions/:id');
});
