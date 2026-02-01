import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import os from 'os';
import { execSync } from 'child_process';
import { queries } from './database.js';
import ACPConnection from './acp-launcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || '/gm').replace(/\/+$/, '');
const watch = process.argv.includes('--watch');

const staticDir = path.join(__dirname, 'static');
if (!fs.existsSync(staticDir)) fs.mkdirSync(staticDir, { recursive: true });

// ACP connection pool keyed by agentId
const acpPool = new Map();

async function getACP(agentId, cwd) {
  let conn = acpPool.get(agentId);
  if (conn?.isRunning()) return conn;

  conn = new ACPConnection();
  const agentType = agentId === 'opencode' ? 'opencode' : 'claude-code';
  
  try {
    await conn.connect(agentType, cwd);
    await conn.initialize();
    await conn.newSession(cwd);
    await conn.setSessionMode('bypassPermissions');
    await conn.injectSkills(['html_rendering', 'image_display', 'scrot', 'fs_access']);
    acpPool.set(agentId, conn);
    console.log(`ACP connection ready for ${agentId} in ${cwd}`);
    return conn;
  } catch (err) {
    console.error(`Failed to initialize ACP connection for ${agentId}: ${err.message}`);
    acpPool.delete(agentId);
    if (conn) await conn.terminate();
    throw new Error(`ACP initialization failed for ${agentId}: ${err.message}`);
  }
}

function discoverAgents() {
  const agents = [];
  const binaries = [
    { cmd: 'claude', id: 'claude-code', name: 'Claude Code', icon: 'C' },
    { cmd: 'opencode', id: 'opencode', name: 'OpenCode', icon: 'O' },
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

  if (req.url === '/') { res.writeHead(302, { Location: BASE_URL + '/' }); res.end(); return; }

  if (!req.url.startsWith(BASE_URL + '/') && req.url !== BASE_URL) {
    res.writeHead(404); res.end('Not found'); return;
  }

  const routePath = req.url.slice(BASE_URL.length) || '/';

  try {
    if (routePath === '/api/conversations' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ conversations: queries.getAllConversations() }));
      return;
    }

    if (routePath === '/api/conversations' && req.method === 'POST') {
      const body = await parseBody(req);
      const conversation = queries.createConversation(body.agentId, body.title);
      queries.createEvent('conversation.created', { agentId: body.agentId }, conversation.id);
      broadcastSync({ type: 'conversation_created', conversation });
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ conversation }));
      return;
    }

    const convMatch = routePath.match(/^\/api\/conversations\/([^/]+)$/);
    if (convMatch) {
      if (req.method === 'GET') {
        const conv = queries.getConversation(convMatch[1]);
        if (!conv) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ conversation: conv }));
        return;
      }

      if (req.method === 'POST') {
        const body = await parseBody(req);
        const conv = queries.updateConversation(convMatch[1], body);
        queries.createEvent('conversation.updated', body, convMatch[1]);
        broadcastSync({ type: 'conversation_updated', conversation: conv });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ conversation: conv }));
        return;
      }

      if (req.method === 'DELETE') {
        const deleted = queries.deleteConversation(convMatch[1]);
        if (!deleted) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ deleted: true }));
        return;
      }
    }

    const messagesMatch = routePath.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (messagesMatch) {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ messages: queries.getConversationMessages(messagesMatch[1]) }));
        return;
      }

      if (req.method === 'POST') {
        const conversationId = messagesMatch[1];
        const body = await parseBody(req);
        const message = queries.createMessage(conversationId, 'user', body.content);
        queries.createEvent('message.created', { role: 'user' }, conversationId);
        broadcastSync({ type: 'message_created', conversationId, message });
        const session = queries.createSession(conversationId);
        queries.createEvent('session.created', { messageId: message.id }, conversationId, session.id);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message, session }));
        processMessage(conversationId, message.id, session.id, body.content, body.agentId, body.folderContext);
        return;
      }
    }

    const messageMatch = routePath.match(/^\/api\/conversations\/([^/]+)\/messages\/([^/]+)$/);
    if (messageMatch && req.method === 'GET') {
      const msg = queries.getMessage(messageMatch[2]);
      if (!msg || msg.conversationId !== messageMatch[1]) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: msg }));
      return;
    }

    const sessionMatch = routePath.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch && req.method === 'GET') {
      const sess = queries.getSession(sessionMatch[1]);
      if (!sess) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
      const events = queries.getSessionEvents(sessionMatch[1]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ session: sess, events }));
      return;
    }

    if (routePath === '/api/agents' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ agents: discoveredAgents }));
      return;
    }

    if (routePath === '/api/home' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ home: process.env.HOME || '/config' }));
      return;
    }

    if (routePath === '/api/folders' && req.method === 'POST') {
      const body = await parseBody(req);
      const folderPath = body.path || '/config';
      try {
        const expandedPath = folderPath.startsWith('~') ?
          folderPath.replace('~', process.env.HOME || '/config') : folderPath;
        const entries = fs.readdirSync(expandedPath, { withFileTypes: true });
        const folders = entries
          .filter(e => e.isDirectory())
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
        decodedPath.replace('~', process.env.HOME || '/config') : decodedPath;
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
      const baseTag = `<script>window.__BASE_URL='${BASE_URL}'; window.__AUTH_TOKEN=localStorage.getItem('gmgui-token');</script>`;
      content = content.replace('<head>', '<head>\n  ' + baseTag);
      if (watch) {
        content += `\n<script>(function(){const ws=new WebSocket('ws://'+location.host+'${BASE_URL}/hot-reload');ws.onmessage=e=>{if(JSON.parse(e.data).type==='reload')location.reload()};})();</script>`;
      }
    }
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'application/octet-stream' });
    res.end(content);
  });
}

async function processMessage(conversationId, messageId, sessionId, content, agentId, folderContext) {
  try {
    queries.updateSession(sessionId, { status: 'processing' });
    queries.createEvent('session.processing', {}, conversationId, sessionId);
    broadcastStream(conversationId, { type: 'status', status: 'processing' });

    const cwd = folderContext?.path || '/config';
    const conn = await getACP(agentId || 'claude-code', cwd);

    let fullText = '';
    const blocks = [];
    conn.onUpdate = (params) => {
      const u = params.update;
      if (!u) return;
      const kind = u.sessionUpdate;
      if (kind === 'agent_message_chunk' && u.content?.text) {
        fullText += u.content.text;
        broadcastStream(conversationId, { type: 'text_delta', text: u.content.text });
      } else if (kind === 'agent_thought_chunk' && u.content?.text) {
        broadcastStream(conversationId, { type: 'thought_delta', text: u.content.text });
      } else if (kind === 'html_content' && u.content?.html) {
        blocks.push({ type: 'html', html: u.content.html, title: u.content.title, id: u.content.id });
        broadcastStream(conversationId, { type: 'html_section', html: u.content.html, title: u.content.title, id: u.content.id });
      } else if (kind === 'image_content' && u.content?.path) {
        const imageUrl = BASE_URL + '/api/image/' + encodeURIComponent(u.content.path);
        blocks.push({ type: 'image', path: u.content.path, url: imageUrl, title: u.content.title, alt: u.content.alt });
        broadcastStream(conversationId, { type: 'image_section', url: imageUrl, path: u.content.path, title: u.content.title, alt: u.content.alt });
      } else if (kind === 'tool_call') {
        broadcastStream(conversationId, { type: 'tool_call', toolCallId: u.toolCallId, title: u.title, kind: u.kind, status: u.status, content: u.content, locations: u.locations });
      } else if (kind === 'tool_call_update') {
        broadcastStream(conversationId, { type: 'tool_update', toolCallId: u.toolCallId, title: u.title, status: u.status, content: u.content });
      } else if (kind === 'plan') {
        broadcastStream(conversationId, { type: 'plan', entries: u.entries });
      }
    };

    const result = await conn.sendPrompt(content);
    conn.onUpdate = null;

    const responseText = fullText || (result?.stopReason ? `Completed: ${result.stopReason}` : 'No response.');
    const messageContent = blocks.length > 0 ? { text: responseText, blocks } : responseText;
    queries.createMessage(conversationId, 'assistant', messageContent);
    queries.updateSession(sessionId, { status: 'completed', response: { text: responseText }, completed_at: Date.now() });
    queries.createEvent('session.completed', {}, conversationId, sessionId);
    broadcastStream(conversationId, { type: 'done', stopReason: result?.stopReason || 'end_turn' });
  } catch (e) {
    console.error('processMessage error:', e.message);
    queries.createMessage(conversationId, 'assistant', `Error: ${e.message}`);
    queries.updateSession(sessionId, { status: 'error', error: e.message, completed_at: Date.now() });
    queries.createEvent('session.error', { error: e.message }, conversationId, sessionId);
    broadcastStream(conversationId, { type: 'error', message: e.message });
    acpPool.delete(agentId || 'claude-code');
  }
}

const wss = new WebSocketServer({ server });
const hotReloadClients = [];
const streamClients = new Map();
const syncClients = new Set();

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://localhost');
  const wsPath = url.pathname.startsWith(BASE_URL) ? url.pathname.slice(BASE_URL.length) : url.pathname;
  if (wsPath === '/hot-reload') {
    hotReloadClients.push(ws);
    ws.on('close', () => { const i = hotReloadClients.indexOf(ws); if (i > -1) hotReloadClients.splice(i, 1); });
  } else if (wsPath === '/stream') {
    const convId = url.searchParams.get('conversationId');
    if (!convId) { ws.close(); return; }
    if (!streamClients.has(convId)) streamClients.set(convId, new Set());
    streamClients.get(convId).add(ws);
    ws.on('close', () => {
      const set = streamClients.get(convId);
      if (set) { set.delete(ws); if (set.size === 0) streamClients.delete(convId); }
    });
  } else if (wsPath === '/sync') {
    syncClients.add(ws);
    ws.isAlive = true;
    ws.send(JSON.stringify({ type: 'sync_connected' }));
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('close', () => { syncClients.delete(ws); });
  }
});

function broadcastStream(conversationId, event) {
  const set = streamClients.get(conversationId);
  if (!set) return;
  const data = JSON.stringify(event);
  for (const ws of set) {
    if (ws.readyState === 1) ws.send(data);
  }
}

function broadcastSync(event) {
  const data = JSON.stringify(event);
  for (const ws of syncClients) {
    if (ws.readyState === 1) ws.send(data);
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
  for (const conn of acpPool.values()) await conn.terminate();
  acpPool.clear();
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
}

server.listen(PORT, onServerReady);
