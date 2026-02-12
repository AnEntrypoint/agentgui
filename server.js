import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { queries } from './database.js';
import { runClaudeWithStreaming } from './lib/claude-runner.js';

const require = createRequire(import.meta.url);
const express = require('express');
const Busboy = require('busboy');
const fsbrowse = require('fsbrowse');
const { webtalk } = require('webtalk');

const SYSTEM_PROMPT = `Always write your responses in ripple-ui enhanced HTML. Avoid overriding light/dark mode CSS variables. Use all the benefits of HTML to express technical details with proper semantic markup, tables, code blocks, headings, and lists. Write clean, well-structured HTML that respects the existing design system.`;

const activeExecutions = new Map();
const messageQueues = new Map();

const debugLog = (msg) => {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] ${msg}`);
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || '/gm').replace(/\/+$/, '');
const watch = process.argv.includes('--no-watch') ? false : (process.argv.includes('--watch') || process.env.HOT_RELOAD !== 'false');

const STARTUP_CWD = process.env.STARTUP_CWD || process.cwd();
const staticDir = path.join(__dirname, 'static');
if (!fs.existsSync(staticDir)) fs.mkdirSync(staticDir, { recursive: true });

// Express sub-app for fsbrowse file browser and file upload
const expressApp = express();

// Separate Express app for webtalk (STT/TTS) - isolated to contain COEP/COOP headers
const webtalkApp = express();
const webtalkInstance = webtalk(webtalkApp, { path: BASE_URL + '/webtalk' });
webtalkInstance.init().catch(err => debugLog('Webtalk init: ' + err.message));

// File upload endpoint - copies dropped files to conversation workingDirectory
expressApp.post(BASE_URL + '/api/upload/:conversationId', (req, res) => {
  try {
    const conv = queries.getConversation(req.params.conversationId);
    if (!conv) return res.status(404).json({ error: 'Conversation not found' });
    if (!conv.workingDirectory) return res.status(400).json({ error: 'No working directory set for this conversation' });

    const uploadDir = conv.workingDirectory;
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }

    const bb = Busboy({ headers: req.headers });
    const fileNames = [];
    const writePromises = [];

    bb.on('file', (fieldname, file, info) => {
      const safeName = path.basename(info.filename);
      const filePath = path.join(uploadDir, safeName);
      fileNames.push(safeName);
      const p = new Promise((resolve) => {
        const writeStream = fs.createWriteStream(filePath);
        file.pipe(writeStream);
        writeStream.on('finish', resolve);
        writeStream.on('error', () => { file.resume(); resolve(); });
      });
      writePromises.push(p);
    });

    bb.on('finish', () => {
      Promise.all(writePromises).then(() => {
        res.json({ ok: true, files: fileNames, count: fileNames.length });
      }).catch(() => {
        res.json({ ok: true, files: fileNames, count: fileNames.length });
      });
    });

    bb.on('error', (err) => {
      res.status(500).json({ error: 'Upload failed: ' + err.message });
    });

    req.pipe(bb);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// fsbrowse file browser - mounted per conversation workingDirectory
// Route: /gm/files/:conversationId/*
expressApp.use(BASE_URL + '/files/:conversationId', (req, res, next) => {
  const conv = queries.getConversation(req.params.conversationId);
  if (!conv || !conv.workingDirectory) {
    return res.status(404).json({ error: 'Conversation not found or no working directory' });
  }
  // Create a fresh fsbrowse router for this conversation's directory
  const router = fsbrowse({ baseDir: conv.workingDirectory });
  // Strip the conversationId param from the path before passing to fsbrowse
  req.baseUrl = BASE_URL + '/files/' + req.params.conversationId;
  router(req, res, next);
});

function discoverAgents() {
  const agents = [];
  const binaries = [
    { cmd: 'claude', id: 'claude-code', name: 'Claude Code', icon: 'C' },
    { cmd: 'opencode', id: 'opencode', name: 'OpenCode', icon: 'O' },
    { cmd: 'gemini', id: 'gemini', name: 'Gemini CLI', icon: 'G' },
    { cmd: 'goose', id: 'goose', name: 'Goose', icon: 'g' },
    { cmd: 'openhands', id: 'openhands', name: 'OpenHands', icon: 'H' },
    { cmd: 'augment', id: 'augment', name: 'Augment Code', icon: 'A' },
    { cmd: 'cline', id: 'cline', name: 'Cline', icon: 'c' },
    { cmd: 'kimi', id: 'kimi', name: 'Kimi CLI', icon: 'K' },
    { cmd: 'qwen-code', id: 'qwen', name: 'Qwen Code', icon: 'Q' },
    { cmd: 'codex', id: 'codex', name: 'Codex CLI', icon: 'X' },
    { cmd: 'mistral-vibe', id: 'mistral', name: 'Mistral Vibe', icon: 'M' },
    { cmd: 'kiro', id: 'kiro', name: 'Kiro CLI', icon: 'k' },
    { cmd: 'fast-agent', id: 'fast-agent', name: 'fast-agent', icon: 'F' },
  ];
  for (const bin of binaries) {
    try {
      const result = execSync(`which ${bin.cmd} 2>/dev/null`, { encoding: 'utf-8' }).trim();
      if (result) agents.push({ id: bin.id, name: bin.name, icon: bin.icon, path: result });
    } catch (_) {}
  }
  return agents;
}

const discoveredAgents = discoverAgents();

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('error', reject);
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const pathOnly = req.url.split('?')[0];
  if (pathOnly.startsWith(BASE_URL + '/webtalk') || pathOnly.startsWith('/webtalk') || pathOnly.startsWith('/assets/') || pathOnly.startsWith('/tts/') || pathOnly.startsWith('/models/')) {
    if (!req.url.startsWith(BASE_URL)) req.url = BASE_URL + req.url;
    return webtalkApp(req, res);
  }

  // Route file upload and fsbrowse requests through Express sub-app
  if (pathOnly.startsWith(BASE_URL + '/api/upload/') || pathOnly.startsWith(BASE_URL + '/files/')) {
    return expressApp(req, res);
  }

  if (req.url === '/favicon.ico' || req.url === BASE_URL + '/favicon.ico') {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#3b82f6"/><text x="50" y="68" font-size="50" font-family="sans-serif" font-weight="bold" fill="white" text-anchor="middle">G</text></svg>';
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
    res.end(svg);
    return;
  }

  if (req.url === '/') { res.writeHead(302, { Location: BASE_URL + '/' }); res.end(); return; }

  if (!req.url.startsWith(BASE_URL + '/') && req.url !== BASE_URL) {
    res.writeHead(404); res.end('Not found'); return;
  }

  const routePath = req.url.slice(BASE_URL.length) || '/';

  try {
    // Remove query parameters from routePath for matching
    const pathOnly = routePath.split('?')[0];

    if (pathOnly === '/api/conversations' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ conversations: queries.getConversationsList() }));
      return;
    }

    if (pathOnly === '/api/conversations' && req.method === 'POST') {
      const body = await parseBody(req);
      const conversation = queries.createConversation(body.agentId, body.title, body.workingDirectory || null);
      queries.createEvent('conversation.created', { agentId: body.agentId, workingDirectory: conversation.workingDirectory }, conversation.id);
      broadcastSync({ type: 'conversation_created', conversation });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ conversation }));
      return;
    }

    const convMatch = pathOnly.match(/^\/api\/conversations\/([^/]+)$/);
    if (convMatch) {
      if (req.method === 'GET') {
        const conv = queries.getConversation(convMatch[1]);
        if (!conv) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }

        // Check both in-memory and database for active streaming status
        const latestSession = queries.getLatestSession(convMatch[1]);
        const isActivelyStreaming = activeExecutions.has(convMatch[1]) ||
          (latestSession && latestSession.status === 'active');

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          conversation: conv,
          isActivelyStreaming,
          latestSession
        }));
        return;
      }

      if (req.method === 'POST' || req.method === 'PUT') {
        const body = await parseBody(req);
        const conv = queries.updateConversation(convMatch[1], body);
        if (!conv) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Conversation not found' })); return; }
        queries.createEvent('conversation.updated', body, convMatch[1]);
        broadcastSync({ type: 'conversation_updated', conversation: conv });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ conversation: conv }));
        return;
      }

      if (req.method === 'DELETE') {
        const deleted = queries.deleteConversation(convMatch[1]);
        if (!deleted) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
        broadcastSync({ type: 'conversation_deleted', conversationId: convMatch[1] });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ deleted: true }));
        return;
      }
    }

    const messagesMatch = pathOnly.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (messagesMatch) {
      if (req.method === 'GET') {
        const url = new URL(req.url, 'http://localhost');
        const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);
        const offset = Math.max(parseInt(url.searchParams.get('offset') || '0'), 0);
        const result = queries.getPaginatedMessages(messagesMatch[1], limit, offset);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }

      if (req.method === 'POST') {
        const conversationId = messagesMatch[1];
        const conv = queries.getConversation(conversationId);
        if (!conv) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Conversation not found' })); return; }
        const body = await parseBody(req);
        const idempotencyKey = body.idempotencyKey || null;
        const message = queries.createMessage(conversationId, 'user', body.content, idempotencyKey);
        queries.createEvent('message.created', { role: 'user', messageId: message.id }, conversationId);
        broadcastSync({ type: 'message_created', conversationId, message, timestamp: Date.now() });
        const session = queries.createSession(conversationId);
        queries.createEvent('session.created', { messageId: message.id, sessionId: session.id }, conversationId, session.id);
         res.writeHead(201, { 'Content-Type': 'application/json' });
         res.end(JSON.stringify({ message, session, idempotencyKey }));
         // Fire-and-forget with proper error handling
         processMessage(conversationId, message.id, body.content, body.agentId)
           .catch(err => debugLog(`[processMessage] Uncaught error: ${err.message}`));
         return;
      }
    }

    const streamMatch = pathOnly.match(/^\/api\/conversations\/([^/]+)\/stream$/);
    if (streamMatch && req.method === 'POST') {
      const conversationId = streamMatch[1];
      const body = await parseBody(req);
      const conv = queries.getConversation(conversationId);
      if (!conv) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Conversation not found' })); return; }

      const prompt = body.content || '';
      const agentId = body.agentId || 'claude-code';

      const userMessage = queries.createMessage(conversationId, 'user', prompt);
      queries.createEvent('message.created', { role: 'user', messageId: userMessage.id }, conversationId);

      broadcastSync({ type: 'message_created', conversationId, message: userMessage, timestamp: Date.now() });

      if (activeExecutions.has(conversationId)) {
        debugLog(`[stream] Conversation ${conversationId} is busy, queuing message`);
        if (!messageQueues.has(conversationId)) messageQueues.set(conversationId, []);
        messageQueues.get(conversationId).push({ content: prompt, agentId, messageId: userMessage.id });

        const queueLength = messageQueues.get(conversationId).length;
        broadcastSync({ type: 'queue_status', conversationId, queueLength, messageId: userMessage.id, timestamp: Date.now() });

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: userMessage, queued: true, queuePosition: queueLength }));
        return;
      }

      const session = queries.createSession(conversationId);
      queries.createEvent('session.created', { messageId: userMessage.id, sessionId: session.id }, conversationId, session.id);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: userMessage, session, streamId: session.id }));

      broadcastSync({
        type: 'streaming_start',
        sessionId: session.id,
        conversationId,
        messageId: userMessage.id,
        agentId,
        timestamp: Date.now()
      });

      processMessageWithStreaming(conversationId, userMessage.id, session.id, prompt, agentId)
        .catch(err => debugLog(`[stream] Uncaught error: ${err.message}`));
      return;
    }

    const messageMatch = pathOnly.match(/^\/api\/conversations\/([^/]+)\/messages\/([^/]+)$/);
    if (messageMatch && req.method === 'GET') {
      const msg = queries.getMessage(messageMatch[2]);
      if (!msg || msg.conversationId !== messageMatch[1]) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: msg }));
      return;
    }

    const sessionMatch = pathOnly.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch && req.method === 'GET') {
      const sess = queries.getSession(sessionMatch[1]);
      if (!sess) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
      const events = queries.getSessionEvents(sessionMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session: sess, events }));
      return;
    }

    const conversationChunksMatch = pathOnly.match(/^\/api\/conversations\/([^/]+)\/chunks$/);
    if (conversationChunksMatch && req.method === 'GET') {
      const conversationId = conversationChunksMatch[1];
      const conv = queries.getConversation(conversationId);
      if (!conv) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Conversation not found' })); return; }

      const url = new URL(req.url, 'http://localhost');
      const since = parseInt(url.searchParams.get('since') || '0');

      const allChunks = queries.getConversationChunks(conversationId);
      debugLog(`[chunks] Conv ${conversationId}: ${allChunks.length} total chunks`);
      const chunks = since > 0 ? allChunks.filter(c => c.created_at > since) : allChunks;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, chunks }));
      return;
    }

    const sessionChunksMatch = pathOnly.match(/^\/api\/sessions\/([^/]+)\/chunks$/);
    if (sessionChunksMatch && req.method === 'GET') {
      const sessionId = sessionChunksMatch[1];
      const sess = queries.getSession(sessionId);
      if (!sess) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Session not found' })); return; }

      const url = new URL(req.url, 'http://localhost');
      const since = parseInt(url.searchParams.get('since') || '0');

      const chunks = queries.getChunksSince(sessionId, since);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, chunks }));
      return;
    }

    if (pathOnly.match(/^\/api\/conversations\/([^/]+)\/sessions\/latest$/) && req.method === 'GET') {
      const convId = pathOnly.match(/^\/api\/conversations\/([^/]+)\/sessions\/latest$/)[1];
      const latestSession = queries.getLatestSession(convId);
      if (!latestSession) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ session: null }));
        return;
      }
      const events = queries.getSessionEvents(latestSession.id);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session: latestSession, events }));
      return;
    }

    const executionMatch = pathOnly.match(/^\/api\/sessions\/([^/]+)\/execution$/);
    if (executionMatch && req.method === 'GET') {
      const sessionId = executionMatch[1];
      const url = new URL(req.url, 'http://localhost');
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '1000'), 5000);
      const offset = Math.max(parseInt(url.searchParams.get('offset') || '0'), 0);
      const filterType = url.searchParams.get('filterType');

      try {
        // Retrieve execution history from database
        // This would normally query execution_events table
        // For now, return proper response structure
        const executionData = {
          sessionId,
          events: [],
          total: 0,
          limit,
          offset,
          hasMore: false,
          metadata: {
            status: 'pending',
            startTime: Date.now(),
            duration: 0,
            eventCount: 0
          }
        };

        if (filterType) {
          executionData.events = executionData.events.filter(e => e.type === filterType);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(executionData));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (routePath === '/api/agents' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ agents: discoveredAgents }));
      return;
    }


    if (routePath === '/api/import/claude-code' && req.method === 'GET') {
      const result = queries.importClaudeCodeConversations();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ imported: result }));
      return;
    }

    if (routePath === '/api/discover/claude-code' && req.method === 'GET') {
      const discovered = queries.discoverClaudeCodeConversations();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ discovered }));
      return;
    }

    if (routePath === '/api/home' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ home: os.homedir(), cwd: STARTUP_CWD }));
      return;
    }

    if (routePath === '/api/folders' && req.method === 'POST') {
      const body = await parseBody(req);
      const folderPath = body.path || STARTUP_CWD;
      try {
        const expandedPath = folderPath.startsWith('~') ?
          folderPath.replace('~', os.homedir()) : folderPath;
        const entries = fs.readdirSync(expandedPath, { withFileTypes: true });
        const folders = entries
          .filter(e => e.isDirectory() && !e.name.startsWith('.'))
          .map(e => ({ name: e.name }))
          .sort((a, b) => a.name.localeCompare(b.name));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ folders }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    if (routePath.startsWith('/api/image/')) {
      const imagePath = routePath.slice('/api/image/'.length);
      const decodedPath = decodeURIComponent(imagePath);
      const expandedPath = decodedPath.startsWith('~') ?
        decodedPath.replace('~', os.homedir()) : decodedPath;
      const normalizedPath = path.normalize(expandedPath);
      if (!normalizedPath.startsWith('/') || normalizedPath.includes('..')) {
        res.writeHead(403); res.end('Forbidden'); return;
      }
      try {
        if (!fs.existsSync(normalizedPath)) { res.writeHead(404); res.end('Not found'); return; }
        const ext = path.extname(normalizedPath).toLowerCase();
        const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        const fileContent = fs.readFileSync(normalizedPath);
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' });
        res.end(fileContent);
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // Handle conversation detail routes - serve index.html for client-side routing
    if (pathOnly.match(/^\/conversations\/[^\/]+$/)) {
      const indexPath = path.join(staticDir, 'index.html');
      serveFile(indexPath, res);
      return;
    }

    let filePath = routePath === '/' ? '/index.html' : routePath;
    filePath = path.join(staticDir, filePath);
    const normalizedPath = path.normalize(filePath);
    if (!normalizedPath.startsWith(staticDir)) { res.writeHead(403); res.end('Forbidden'); return; }

    fs.stat(filePath, (err, stats) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      if (stats.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
        fs.stat(filePath, (err2) => {
          if (err2) { res.writeHead(404); res.end('Not found'); return; }
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
  const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(500); res.end('Server error'); return; }
    let content = data.toString();
    if (ext === '.html') {
      const baseTag = `<script>window.__BASE_URL='${BASE_URL}';</script>`;
      content = content.replace('<head>', '<head>\n  ' + baseTag);
      if (watch) {
        content += `\n<script>(function(){const ws=new WebSocket('ws://'+location.host+'${BASE_URL}/hot-reload');ws.onmessage=e=>{if(JSON.parse(e.data).type==='reload')location.reload()};})();</script>`;
      }
    }
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

function persistChunkWithRetry(sessionId, conversationId, sequence, blockType, blockData, maxRetries = 3) {
  let lastError = null;
  const backoffs = [100, 200, 400];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const chunk = queries.createChunk(sessionId, conversationId, sequence, blockType, blockData);
      return chunk;
    } catch (err) {
      lastError = err;
      debugLog(`[chunk] Persist attempt ${attempt + 1}/${maxRetries} failed: ${err.message}`);
      if (attempt < maxRetries - 1) {
        const delayMs = backoffs[attempt] || 400;
        const endTime = Date.now() + delayMs;
        while (Date.now() < endTime) {
          // Synchronous sleep for backoff
        }
      }
    }
  }

  debugLog(`[chunk] Failed to persist after ${maxRetries} retries: ${lastError?.message}`);
  return null;
}

async function processMessageWithStreaming(conversationId, messageId, sessionId, content, agentId) {
  const startTime = Date.now();
  activeExecutions.set(conversationId, true);
  queries.setIsStreaming(conversationId, true);
  queries.updateSession(sessionId, { status: 'active' });

  try {
    debugLog(`[stream] Starting: conversationId=${conversationId}, sessionId=${sessionId}`);

    const conv = queries.getConversation(conversationId);
    const cwd = conv?.workingDirectory || STARTUP_CWD;
    const resumeSessionId = conv?.claudeSessionId || null;

    let allBlocks = [];
    let eventCount = 0;
    let currentSequence = queries.getMaxSequence(sessionId) ?? -1;

    const onEvent = (parsed) => {
      eventCount++;
      debugLog(`[stream] Event ${eventCount}: type=${parsed.type}`);

      if (parsed.type === 'system') {
        const systemBlock = {
          type: 'system',
          subtype: parsed.subtype,
          model: parsed.model,
          cwd: parsed.cwd,
          tools: parsed.tools,
          session_id: parsed.session_id
        };

        currentSequence++;
        persistChunkWithRetry(sessionId, conversationId, currentSequence, 'system', systemBlock);

        broadcastSync({
          type: 'streaming_progress',
          sessionId,
          conversationId,
          block: systemBlock,
          blockIndex: allBlocks.length,
          timestamp: Date.now()
        });
      } else if (parsed.type === 'assistant' && parsed.message?.content) {
        for (const block of parsed.message.content) {
          allBlocks.push(block);

          currentSequence++;
          persistChunkWithRetry(sessionId, conversationId, currentSequence, block.type || 'assistant', block);

          broadcastSync({
            type: 'streaming_progress',
            sessionId,
            conversationId,
            block,
            blockIndex: allBlocks.length - 1,
            timestamp: Date.now()
          });
        }
      } else if (parsed.type === 'user' && parsed.message?.content) {
        for (const block of parsed.message.content) {
          if (block.type === 'tool_result') {
            const toolResultBlock = {
              type: 'tool_result',
              tool_use_id: block.tool_use_id,
              content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
              is_error: block.is_error || false
            };

            currentSequence++;
            persistChunkWithRetry(sessionId, conversationId, currentSequence, 'tool_result', toolResultBlock);

            broadcastSync({
              type: 'streaming_progress',
              sessionId,
              conversationId,
              block: toolResultBlock,
              blockIndex: allBlocks.length,
              timestamp: Date.now()
            });
          }
        }
      } else if (parsed.type === 'result') {
        const resultBlock = {
          type: 'result',
          subtype: parsed.subtype,
          duration_ms: parsed.duration_ms,
          total_cost_usd: parsed.total_cost_usd,
          num_turns: parsed.num_turns,
          is_error: parsed.is_error || false,
          result: parsed.result
        };

        currentSequence++;
        persistChunkWithRetry(sessionId, conversationId, currentSequence, 'result', resultBlock);

        broadcastSync({
          type: 'streaming_progress',
          sessionId,
          conversationId,
          block: resultBlock,
          blockIndex: allBlocks.length,
          isResult: true,
          timestamp: Date.now()
        });

        if (parsed.result && allBlocks.length === 0) {
          allBlocks.push({ type: 'text', text: String(parsed.result) });
        }
      }
    };

    const config = {
      verbose: true,
      outputFormat: 'stream-json',
      timeout: 1800000,
      print: true,
      resumeSessionId,
      systemPrompt: SYSTEM_PROMPT,
      onEvent
    };

    const { outputs, sessionId: claudeSessionId } = await runClaudeWithStreaming(content, cwd, agentId || 'claude-code', config);
    debugLog(`[stream] Claude returned ${outputs.length} outputs, sessionId=${claudeSessionId}`);

    if (claudeSessionId && !conv?.claudeSessionId) {
      queries.setClaudeSessionId(conversationId, claudeSessionId);
      debugLog(`[stream] Stored claudeSessionId=${claudeSessionId}`);
    }

    // Mark session as complete
    queries.updateSession(sessionId, {
      status: 'complete',
      response: JSON.stringify({ outputs, eventCount }),
      completed_at: Date.now()
    });

    broadcastSync({
      type: 'streaming_complete',
      sessionId,
      conversationId,
      eventCount,
      timestamp: Date.now()
    });

    debugLog(`[stream] Completed: ${outputs.length} outputs, ${eventCount} events`);
  } catch (error) {
    const elapsed = Date.now() - startTime;
    debugLog(`[stream] Error after ${elapsed}ms: ${error.message}`);

    // Mark session as error
    queries.updateSession(sessionId, {
      status: 'error',
      error: error.message,
      completed_at: Date.now()
    });

    broadcastSync({
      type: 'streaming_error',
      sessionId,
      conversationId,
      error: error.message,
      recoverable: elapsed < 60000,
      timestamp: Date.now()
    });

    const errorMessage = queries.createMessage(conversationId, 'assistant', `Error: ${error.message}`);
    broadcastSync({
      type: 'message_created',
      conversationId,
      message: errorMessage,
      timestamp: Date.now()
    });
  } finally {
    activeExecutions.delete(conversationId);
    queries.setIsStreaming(conversationId, false);
    drainMessageQueue(conversationId);
  }
}

function drainMessageQueue(conversationId) {
  const queue = messageQueues.get(conversationId);
  if (!queue || queue.length === 0) return;

  const next = queue.shift();
  if (queue.length === 0) messageQueues.delete(conversationId);

  debugLog(`[queue] Draining next message for ${conversationId}`);

  const session = queries.createSession(conversationId);
  queries.createEvent('session.created', { messageId: next.messageId, sessionId: session.id }, conversationId, session.id);

  broadcastSync({
    type: 'streaming_start',
    sessionId: session.id,
    conversationId,
    messageId: next.messageId,
    agentId: next.agentId,
    timestamp: Date.now()
  });

  broadcastSync({
    type: 'queue_status',
    conversationId,
    queueLength: queue?.length || 0,
    timestamp: Date.now()
  });

  processMessageWithStreaming(conversationId, next.messageId, session.id, next.content, next.agentId)
    .catch(err => debugLog(`[queue] Error processing queued message: ${err.message}`));
}

async function processMessage(conversationId, messageId, content, agentId) {
  try {
    debugLog(`[processMessage] Starting: conversationId=${conversationId}, agentId=${agentId}`);

    const conv = queries.getConversation(conversationId);
    const cwd = conv?.workingDirectory || STARTUP_CWD;
    const resumeSessionId = conv?.claudeSessionId || null;

    let contentStr = typeof content === 'object' ? JSON.stringify(content) : content;

    const { outputs, sessionId: claudeSessionId } = await runClaudeWithStreaming(contentStr, cwd, agentId || 'claude-code', {
      resumeSessionId,
      systemPrompt: SYSTEM_PROMPT
    });

    if (claudeSessionId && !conv?.claudeSessionId) {
      queries.setClaudeSessionId(conversationId, claudeSessionId);
    }

    let allBlocks = [];
    for (const output of outputs) {
      if (output.type === 'assistant' && output.message?.content) {
        allBlocks.push(...(output.message.content || []));
      }
    }

    let messageContent = null;
    if (allBlocks.length > 0) {
      messageContent = JSON.stringify({ type: 'claude_execution', blocks: allBlocks, timestamp: Date.now() });
    } else {
      let textParts = [];
      for (const output of outputs) {
        if (output.type === 'result' && output.result) textParts.push(String(output.result));
        else if (typeof output === 'string') textParts.push(output);
      }
      messageContent = textParts.join('\n').trim();
    }

    if (messageContent) {
      const assistantMessage = queries.createMessage(conversationId, 'assistant', messageContent);
      broadcastSync({ type: 'message_created', conversationId, message: assistantMessage, timestamp: Date.now() });
    }
  } catch (error) {
    debugLog(`[processMessage] Error: ${error.message}`);
    const errorMessage = queries.createMessage(conversationId, 'assistant', `Error: ${error.message}`);
    broadcastSync({ type: 'message_created', conversationId, message: errorMessage, timestamp: Date.now() });
  }
}

const wss = new WebSocketServer({ server });
const hotReloadClients = [];
const syncClients = new Set();

wss.on('connection', (ws, req) => {
  // req.url in WebSocket is just the path (e.g., '/gm/sync'), not a full URL
  const wsPath = req.url.startsWith(BASE_URL) ? req.url.slice(BASE_URL.length) : req.url;
  if (wsPath === '/hot-reload') {
    hotReloadClients.push(ws);
    ws.on('close', () => { const i = hotReloadClients.indexOf(ws); if (i > -1) hotReloadClients.splice(i, 1); });
  } else if (wsPath === '/sync') {
    syncClients.add(ws);
    ws.isAlive = true;
    ws.subscriptions = new Set();
    ws.clientId = `client-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

    ws.send(JSON.stringify({
      type: 'sync_connected',
      clientId: ws.clientId,
      timestamp: Date.now()
    }));

    ws.on('message', (msg) => {
      try {
        const data = JSON.parse(msg);
        if (data.type === 'subscribe') {
          if (data.sessionId) ws.subscriptions.add(data.sessionId);
          if (data.conversationId) ws.subscriptions.add(`conv-${data.conversationId}`);
          const subTarget = data.sessionId || data.conversationId;
          debugLog(`[WebSocket] Client ${ws.clientId} subscribed to ${subTarget}`);
          ws.send(JSON.stringify({
            type: 'subscription_confirmed',
            sessionId: data.sessionId,
            conversationId: data.conversationId,
            timestamp: Date.now()
          }));
        } else if (data.type === 'unsubscribe') {
          ws.subscriptions.delete(data.sessionId);
          debugLog(`[WebSocket] Client ${ws.clientId} unsubscribed from ${data.sessionId}`);
        } else if (data.type === 'get_subscriptions') {
          ws.send(JSON.stringify({
            type: 'subscriptions',
            subscriptions: Array.from(ws.subscriptions),
            timestamp: Date.now()
          }));
        } else if (data.type === 'ping') {
          ws.send(JSON.stringify({
            type: 'pong',
            timestamp: Date.now()
          }));
        }
      } catch (e) {
        console.error('WebSocket message parse error:', e.message);
        ws.send(JSON.stringify({
          type: 'error',
          error: 'Invalid message format',
          timestamp: Date.now()
        }));
      }
    });

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', () => {
      syncClients.delete(ws);
      console.log(`[WebSocket] Client ${ws.clientId} disconnected`);
    });
  }
});

function broadcastSync(event) {
  const data = JSON.stringify(event);

  for (const ws of syncClients) {
    if (ws.readyState !== 1) continue;

    let shouldSend = false;

    if (event.sessionId && ws.subscriptions?.has(event.sessionId)) {
      shouldSend = true;
    } else if (event.conversationId && ws.subscriptions?.has(`conv-${event.conversationId}`)) {
      shouldSend = true;
    } else if (event.type === 'message_created' || event.type === 'conversation_created' || event.type === 'conversations_updated' || event.type === 'conversation_deleted' || event.type === 'queue_status' || event.type === 'streaming_start' || event.type === 'streaming_complete' || event.type === 'streaming_error') {
      shouldSend = true;
    }

    if (shouldSend) {
      ws.send(data);
    }
  }
}

// Heartbeat interval to detect stale connections
const heartbeatInterval = setInterval(() => {
  syncClients.forEach(ws => {
    if (!ws.isAlive) {
      syncClients.delete(ws);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

if (watch) {
  const watchedFiles = new Map();
  try {
    fs.readdirSync(staticDir).forEach(file => {
      const fp = path.join(staticDir, file);
      if (watchedFiles.has(fp)) return;
      fs.watchFile(fp, { interval: 100 }, (curr, prev) => {
        if (curr.mtime > prev.mtime) hotReloadClients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'reload' })); });
      });
      watchedFiles.set(fp, true);
    });
  } catch (e) { console.error('Watch error:', e.message); }
}

process.on('SIGTERM', async () => {
  wss.close(() => server.close(() => process.exit(0)));
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} already in use. Waiting 3 seconds before retry...`);
    setTimeout(() => {
      server.listen(PORT, onServerReady);
    }, 3000);
  } else {
    console.error('Server error:', err.message);
    process.exit(1);
  }
});

function onServerReady() {
  console.log(`GMGUI running on http://localhost:${PORT}${BASE_URL}/`);
  console.log(`Agents: ${discoveredAgents.map(a => a.name).join(', ') || 'none'}`);
  console.log(`Hot reload: ${watch ? 'on' : 'off'}`);

  // Clean up empty conversations on startup
  const deletedCount = queries.cleanupEmptyConversations();
  if (deletedCount > 0) {
    console.log(`Cleaned up ${deletedCount} empty conversation(s) on startup`);
  }

  // Run auto-import immediately
  performAutoImport();

  // Then run it every 30 seconds (constant automatic importing)
  setInterval(performAutoImport, 30000);

}

function performAutoImport() {
  try {
    const imported = queries.importClaudeCodeConversations();
    if (imported.length > 0) {
      const importedCount = imported.filter(i => i.status === 'imported').length;
      const skippedCount = imported.filter(i => i.status === 'skipped').length;
      if (importedCount > 0) {
        console.log(`[AUTO-IMPORT] Imported ${importedCount} new Claude Code conversations (${skippedCount} already exist)`);
        // Broadcast to all connected clients that conversations were updated
        broadcastSync({ type: 'conversations_updated', count: importedCount });
      } else if (skippedCount > 0) {
        // All conversations already imported, don't spam logs
      }
    }
  } catch (err) {
    console.error('[AUTO-IMPORT] Error:', err.message);
  }
}

function performRecovery() {
  try {
    // Cleanup orphaned sessions (older than 7 days)
    const cleanedUp = queries.cleanupOrphanedSessions(7);
    if (cleanedUp > 0) {
      debugLog(`[RECOVERY] Cleaned up ${cleanedUp} orphaned sessions`);
    }

    // Mark sessions incomplete if they've been processing too long (>2 hours)
    const longRunning = queries.getSessionsProcessingLongerThan(120);
    if (longRunning.length > 0) {
      for (const session of longRunning) {
        queries.markSessionIncomplete(session.id, 'Timeout: processing exceeded 2 hours');
      }
      debugLog(`[RECOVERY] Marked ${longRunning.length} long-running sessions as incomplete`);
    }
  } catch (err) {
    console.error('[RECOVERY] Error:', err.message);
  }
}

// Run recovery every 5 minutes
setInterval(performRecovery, 300000);

server.listen(PORT, onServerReady);
