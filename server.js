import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import os from 'os';
import { execSync } from 'child_process';
import { queries } from './database.js';
import ACPConnection from './acp-launcher.js';
import { SessionStateStore } from './state-manager.js';
import { StreamHandler } from './stream-handler.js';
import { StateValidator } from './state-validator.js';
import { getConversationSync } from './conversation-sync.js';

// Debug logging to file
const debugLog = (msg) => {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] ${msg}`);
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || '/gm').replace(/\/+$/, '');
const watch = process.argv.includes('--no-watch') ? false : (process.argv.includes('--watch') || process.env.HOT_RELOAD !== 'false');

const staticDir = path.join(__dirname, 'static');
if (!fs.existsSync(staticDir)) fs.mkdirSync(staticDir, { recursive: true });

// ACP connection pool keyed by agentId
const acpPool = new Map();

// Global session state store - tracks ALL prompt processing with explicit states
const sessionStateStore = new SessionStateStore();

// Periodic cleanup of old sessions
setInterval(() => {
  sessionStateStore.cleanup(3600000); // Clean sessions older than 1 hour
}, 600000); // Run every 10 minutes

/**
 * Get or create ACP connection with timeout protection
 */
async function getACP(agentId, cwd) {
  let conn = acpPool.get(agentId);
  if (conn?.isRunning()) {
    console.log(`[getACP] Returning cached connection for ${agentId}`);
    return conn;
  }

  console.log(`[getACP] Creating new ACP connection for ${agentId}`);
  conn = new ACPConnection();
  const agentType = agentId === 'opencode' ? 'opencode' : 'claude-code';
  
  // Wrap entire init in timeout to prevent indefinite hangs
  return Promise.race([
    initializeACP(conn, agentType, cwd, agentId),
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error('ACP initialization timeout (>60s)')), 60000)
    )
  ]);
}

/**
 * Initialize ACP with all steps
 */
async function initializeACP(conn, agentType, cwd, agentId) {
  try {
    console.log(`[getACP] Step 1: Connecting to ${agentType}...`);
    await conn.connect(agentType, cwd);
    console.log(`[getACP] Step 2: Connected, initializing...`);
    await conn.initialize();
    console.log(`[getACP] Step 3: Initialized, creating session...`);
    await conn.newSession(cwd);
    console.log(`[getACP] Step 4: Session created, setting mode...`);
    await conn.setSessionMode('bypassPermissions');
    console.log(`[getACP] Step 5: Injecting skills...`);
    // Inject system prompt to ensure HTML/RippleUI formatting
    await conn.injectSkills();
    console.log(`[getACP] Step 6: Injecting system context...`);
    await conn.injectSystemContext();
    console.log(`[getACP] Step 7: All initialization complete, caching connection`);
    acpPool.set(agentId, conn);
    console.log(`[getACP] ✅ ACP connection ready for ${agentId} in ${cwd}`);
    return conn;
  } catch (err) {
    console.error(`[getACP] ❌ ERROR: Failed to initialize ACP connection for ${agentId}: ${err.message}`);
    console.error(`[getACP] Stack: ${err.stack}`);
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
      res.end(JSON.stringify({ conversations: queries.getConversationsList() }));
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
        broadcastSync({ type: 'conversation_deleted', conversationId: convMatch[1] });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ deleted: true }));
        return;
      }
    }

    const messagesMatch = routePath.match(/^\/api\/conversations\/([^/]+)\/messages$/);
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
        const body = await parseBody(req);
        const idempotencyKey = body.idempotencyKey || null;
        const message = queries.createMessage(conversationId, 'user', body.content, idempotencyKey);
        queries.createEvent('message.created', { role: 'user', messageId: message.id }, conversationId);
        broadcastSync({ type: 'message_created', conversationId, message });
        const session = queries.createSession(conversationId);
        queries.createEvent('session.created', { messageId: message.id, sessionId: session.id }, conversationId, session.id);
         res.writeHead(201, { 'Content-Type': 'application/json' });
         res.end(JSON.stringify({ message, session, idempotencyKey }));
         // Fire-and-forget with proper error handling
         processMessage(conversationId, message.id, session.id, body.content, body.agentId, body.folderContext)
           .catch(err => debugLog(`[processMessage] Uncaught error: ${err.message}`));
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

    if (routePath.match(/^\/api\/conversations\/([^/]+)\/sessions\/latest$/) && req.method === 'GET') {
      const convId = routePath.match(/^\/api\/conversations\/([^/]+)\/sessions\/latest$/)[1];
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

    if (routePath === '/api/agents' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ agents: discoveredAgents }));
      return;
    }

    // Diagnostics endpoint - shows ALL active and recent sessions
    if (routePath === '/api/diagnostics/sessions' && req.method === 'GET') {
      const diagnostics = sessionStateStore.getDiagnostics();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(diagnostics, null, 2));
      return;
    }

    const streamUpdatesMatch = routePath.match(/^\/api\/sessions\/([^/]+)\/stream-updates$/);
    if (streamUpdatesMatch && req.method === 'GET') {
      const sessionId = streamUpdatesMatch[1];
      const updates = queries.getSessionStreamUpdates(sessionId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessionId, updates, count: updates.length }));
      return;
    }

    const stateRecoveryMatch = routePath.match(/^\/api\/sessions\/([^/]+)\/state-recovery$/);
    if (stateRecoveryMatch && req.method === 'GET') {
      const sessionId = stateRecoveryMatch[1];
      const state = StateValidator.getSessionState(sessionId);
      if (!state) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Session not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(state));
      return;
    }

    const stateValidationMatch = routePath.match(/^\/api\/sessions\/([^/]+)\/validate$/);
    if (stateValidationMatch && req.method === 'GET') {
      const sessionId = stateValidationMatch[1];
      const validation = StateValidator.validateSession(sessionId);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(validation));
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

/**
 * Process a user message through the Claude Code ACP with real-time streaming
 * Updates are persisted to database and broadcast to clients immediately
 */
async function processMessage(conversationId, messageId, sessionId, content, agentId, folderContext) {
  // Create state manager for this session
  const stateManager = sessionStateStore.create(sessionId, conversationId, messageId, 120000);

  try {
    console.log(`[processMessage] Starting: conversationId=${conversationId}, sessionId=${sessionId}`);
    console.log(`[processMessage] Initial state: ${stateManager.getState()}`);

    // STATE: PENDING → ACQUIRING_ACP
    stateManager.transition(stateManager.constructor.STATES.ACQUIRING_ACP, {
      reason: 'Connecting to ACP',
      data: {}
    });

    const cwd = folderContext?.path || '/config';
    const actualAgentId = agentId || 'claude-code';

    try {
      const conn = await getACP(actualAgentId, cwd);

      // STATE: ACQUIRING_ACP → ACP_ACQUIRED
      stateManager.transition(stateManager.constructor.STATES.ACP_ACQUIRED, {
        reason: 'ACP connection established',
        data: { acpConnectionTime: Date.now() }
      });

      // Create stream handler for real-time persistence and broadcasting
      const streamHandler = new StreamHandler(sessionId, conversationId, broadcastSync);
      let fullText = '';

      // Setup response streaming
      conn.onUpdate = (params) => {
        streamHandler.handleUpdate(params, BASE_URL);
        const u = params.update;
        if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.text) {
          fullText += u.content.text;
        }
      };

      // STATE: ACP_ACQUIRED → SENDING_PROMPT
      stateManager.transition(stateManager.constructor.STATES.SENDING_PROMPT, {
        reason: 'Sending prompt to ACP',
        data: {}
      });

      console.log(`[processMessage] Sending prompt to ACP (${content.length} chars)`);
      const result = await conn.sendPrompt(content);
      conn.onUpdate = null;

      // STATE: SENDING_PROMPT → PROCESSING
      stateManager.transition(stateManager.constructor.STATES.PROCESSING, {
        reason: 'ACP processing complete, formatting response',
        data: { promptSentTime: Date.now(), responseReceivedTime: Date.now() }
      });

       console.log(`[processMessage] ACP returned: stopReason=${result?.stopReason}, streamUpdates=${streamHandler.getUpdateCount()}`);

       // Save agent's complete response as-is, without any processing
       // The agent workflow must flow naturally - no HTML extraction or interference
       const responseText = fullText || result?.result || 'No response.';

       const messageContent = {
         text: responseText,
         streamUpdatesCount: streamHandler.getUpdateCount()
       };

      // Save consolidated response to database
      const assistantMessage = queries.createMessage(conversationId, 'assistant', messageContent);
      queries.updateSession(sessionId, {
        status: 'completed',
        response: { text: responseText, messageId: assistantMessage.id },
        completed_at: Date.now()
      });
      queries.createEvent('session.completed', { messageId: assistantMessage.id }, conversationId, sessionId);

      // Broadcast final consolidated response
      broadcastSync({
        type: 'session_updated',
        sessionId,
        status: 'completed',
        message: assistantMessage
      });

      // STATE: PROCESSING → COMPLETED
      stateManager.transition(stateManager.constructor.STATES.COMPLETED, {
        reason: 'Response successfully generated and saved',
        data: {
          responseLength: responseText.length,
          messageId: assistantMessage.id,
          streamUpdates: streamHandler.getUpdateCount()
        }
      });

      console.log(`[processMessage] ✅ Session completed with ${streamHandler.getUpdateCount()} stream updates: ${stateManager.getSummary().duration}`);

    } catch (acpError) {
      console.error(`[processMessage] ACP Error: ${acpError.message}`);
      console.error(`[processMessage] Stack: ${acpError.stack}`);

      // STATE: → ERROR
      stateManager.transition(stateManager.constructor.STATES.ERROR, {
        reason: `ACP error: ${acpError.message}`,
        data: {
          error: acpError.message,
          stackTrace: acpError.stack
        }
      });

      // Save error to database
      const errorMsg = `ACP Error: ${acpError.message}`;
      queries.createMessage(conversationId, 'assistant', errorMsg);
      queries.updateSession(sessionId, { status: 'error', error: acpError.message, completed_at: Date.now() });
      queries.createEvent('session.error', { error: acpError.message, stack: acpError.stack }, conversationId, sessionId);
      broadcastSync({ type: 'session_updated', sessionId, status: 'error', error: acpError.message });

      // Clean up ACP connection on error
      acpPool.delete(actualAgentId);
      throw acpError;
    }

  } catch (fatalError) {
    console.error(`[processMessage] ❌ Fatal error: ${fatalError.message}`);
    console.error(`[processMessage] Stack: ${fatalError.stack}`);

    // Ensure state is in error
    if (!stateManager.isTerminal()) {
      stateManager.transition(stateManager.constructor.STATES.ERROR, {
        reason: `Fatal error: ${fatalError.message}`,
        data: {
          error: fatalError.message,
          stackTrace: fatalError.stack
        }
      });
    }

    // Log full state history for debugging
    const summary = stateManager.getSummary();
    console.error(`[processMessage] State history: ${JSON.stringify(summary, null, 2)}`);

  } finally {
    // Cleanup: remove from state store immediately (async to not block)
    setImmediate(() => {
      sessionStateStore.remove(sessionId);
    });

    // Log final state
    console.log(`[processMessage] Final state: ${stateManager.getState()}`);
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
          ws.subscriptions.add(data.sessionId);
          // On subscribe, send current state for recovery
          const state = StateValidator.getSessionState(data.sessionId);
          if (state) {
            ws.send(JSON.stringify({
              type: 'state_snapshot',
              sessionId: data.sessionId,
              state,
              timestamp: Date.now()
            }));
          }
        } else if (data.type === 'unsubscribe') {
          ws.subscriptions.delete(data.sessionId);
        } else if (data.type === 'recovery_request') {
          // Client asking to recover from a checkpoint
          const state = StateValidator.getSessionState(data.sessionId);
          if (state) {
            ws.send(JSON.stringify({
              type: 'recovery_response',
              sessionId: data.sessionId,
              state,
              timestamp: Date.now()
            }));
          }
        }
      } catch (e) {
        console.error('WebSocket message parse error:', e.message);
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
    if (ws.readyState === 1) {
      // CRITICAL: Only send if client subscribed to this session
      if (event.sessionId) {
        if (!ws.subscriptions || !ws.subscriptions.has(event.sessionId)) {
          continue;
        }
      }
      // Send immediately - no buffering
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

  // Run auto-import immediately
  performAutoImport();

  // Then run it every 30 seconds (constant automatic importing)
  setInterval(performAutoImport, 30000);

  // Start conversation sync to watch for changes
  try {
    const sync = getConversationSync();
    sync.start();
  } catch (err) {
    console.error('[SERVER] Error starting conversation sync:', err.message);
  }
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

server.listen(PORT, onServerReady);
