import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { execSync } from 'child_process';
import { queries } from './database.js';
import { runClaudeWithStreaming } from './lib/claude-runner.js';

// System prompt for Claude to format responses as HTML
const SYSTEM_PROMPT = `Always write your responses in ripple-ui enhanced HTML. Avoid overriding light/dark mode CSS variables. Use all the benefits of HTML to express technical details with proper semantic markup, tables, code blocks, headings, and lists. Write clean, well-structured HTML that respects the existing design system.`;

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
    // Remove query parameters from routePath for matching
    const pathOnly = routePath.split('?')[0];

    if (pathOnly === '/api/conversations' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ conversations: queries.getConversationsList() }));
      return;
    }

    if (pathOnly === '/api/conversations' && req.method === 'POST') {
      const body = await parseBody(req);
      const conversation = queries.createConversation(body.agentId, body.title);
      queries.createEvent('conversation.created', { agentId: body.agentId }, conversation.id);
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
      const skipPermissions = body.skipPermissions || false;

      debugLog(`[stream] Starting stream: conversationId=${conversationId}, agentId=${agentId}, skipPermissions=${skipPermissions}`);

      // Create user message and session immediately
      const userMessage = queries.createMessage(conversationId, 'user', prompt);
      const session = queries.createSession(conversationId);
      queries.createEvent('message.created', { role: 'user', messageId: userMessage.id }, conversationId);
      queries.createEvent('session.created', { messageId: userMessage.id, sessionId: session.id }, conversationId, session.id);

      // Send immediate response with session info
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: userMessage, session, streamId: session.id }));

      // Emit streaming start event
      broadcastSync({
        type: 'streaming_start',
        sessionId: session.id,
        conversationId,
        messageId: userMessage.id,
        agentId,
        timestamp: Date.now()
      });

      // Fire-and-forget streaming with error handling
      processMessageWithStreaming(conversationId, userMessage.id, session.id, prompt, agentId, skipPermissions)
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

async function processMessageWithStreaming(conversationId, messageId, sessionId, content, agentId, skipPermissions = false) {
  const startTime = Date.now();
  try {
    debugLog(`[stream] Starting: conversationId=${conversationId}, sessionId=${sessionId}, agentId=${agentId}, skipPermissions=${skipPermissions}`);

    const cwd = '/config';
    const actualAgentId = agentId || 'claude-code';

    debugLog(`[stream] Calling runClaudeWithStreaming with config: skipPermissions=${skipPermissions}`);
    const config = {
      skipPermissions,
      verbose: true,
      outputFormat: 'stream-json',
      timeout: 1800000, // 30 minutes
      print: true
    };

    // Prepend system prompt to user content
    const promptWithSystem = `${SYSTEM_PROMPT}\n\n${content}`;

    const outputs = await runClaudeWithStreaming(promptWithSystem, cwd, actualAgentId, config);
    debugLog(`[stream] Claude returned ${outputs.length} streaming outputs`);

    // Process streaming outputs similar to processMessage
    // But emit WebSocket events for each block
    let allBlocks = [];
    let lastAssistantMessage = null;
    let eventCount = 0;

    for (const output of outputs) {
      if (output.type === 'assistant' && output.message?.content) {
        debugLog(`[stream] Found assistant message with ${output.message.content.length} content blocks`);
        lastAssistantMessage = output.message;
        allBlocks.push(...(output.message.content || []));

        // Emit progress event for each block
        broadcastSync({
          type: 'streaming_progress',
          sessionId,
          conversationId,
          blockCount: allBlocks.length,
          timestamp: Date.now()
        });
        eventCount++;
      } else if (output.type === 'tool_result' && output.result) {
        debugLog(`[stream] Found tool result`);
        allBlocks.push({
          type: 'tool_result',
          result: output.result,
          tool_use_id: output.tool_use_id
        });
        eventCount++;
      }
    }

    let messageContent = null;
    if (allBlocks.length > 0) {
      messageContent = JSON.stringify({
        type: 'claude_execution',
        blocks: allBlocks,
        timestamp: Date.now()
      });
      debugLog(`[stream] Storing full execution with ${allBlocks.length} blocks`);
    } else {
      let textParts = [];
      for (const output of outputs) {
        if (typeof output === 'string') {
          textParts.push(output);
        } else if (output.text) {
          textParts.push(output.text);
        } else if (output.content?.text) {
          textParts.push(output.content.text);
        } else if (output.result) {
          textParts.push(String(output.result));
        }
      }
      messageContent = textParts.join('\n').trim();
      debugLog(`[stream] Storing text response: "${messageContent.substring(0, 100)}..."`);
    }

    if (messageContent) {
      debugLog(`[stream] Creating assistant message`);
      const assistantMessage = queries.createMessage(conversationId, 'assistant', messageContent);
      debugLog(`[stream] Created message with id: ${assistantMessage.id}`);
      broadcastSync({
        type: 'streaming_complete',
        sessionId,
        conversationId,
        messageId: assistantMessage.id,
        eventCount,
        timestamp: Date.now()
      });
    } else {
      debugLog(`[stream] No response content extracted!`);
    }

    debugLog(`[stream] ✅ Completed: ${outputs.length} outputs received, ${eventCount} events emitted`);
  } catch (error) {
    const elapsed = Date.now() - startTime;
    debugLog(`[stream] Error after ${elapsed}ms: ${error.message}`);

    // Mark session as incomplete for recovery
    try {
      const sessionStatus = error.message.includes('timeout') ? 'timeout' : 'error';
      queries.markSessionIncomplete(sessionId, error.message);
      debugLog(`[stream] Session ${sessionId} marked as incomplete (${sessionStatus})`);
    } catch (err) {
      debugLog(`[stream] Failed to mark session: ${err.message}`);
    }

    broadcastSync({
      type: 'streaming_error',
      sessionId,
      conversationId,
      error: error.message,
      recoverable: elapsed < 60000, // Retryable if failed within 1 minute
      timestamp: Date.now()
    });

    const errorMessage = queries.createMessage(conversationId, 'assistant', `Error: ${error.message}`);
    broadcastSync({
      type: 'message_created',
      conversationId,
      message: errorMessage,
      timestamp: Date.now()
    });
  }
}

async function processMessage(conversationId, messageId, content, agentId) {
  try {
    debugLog(`[processMessage] Starting: conversationId=${conversationId}, agentId=${agentId}`);

    const cwd = '/config';
    const actualAgentId = agentId || 'claude-code';

    // Handle both string content and object content (for structured messages)
    let contentStr = content;
    if (typeof content === 'object') {
      contentStr = JSON.stringify(content);
    }

    debugLog(`[processMessage] Calling runClaudeWithStreaming with prompt: "${contentStr.substring(0, 50)}..."`);
    // Prepend system prompt to user content
    const promptWithSystem = `${SYSTEM_PROMPT}\n\n${contentStr}`;
    const outputs = await runClaudeWithStreaming(promptWithSystem, cwd, actualAgentId);
    debugLog(`[processMessage] Claude returned ${outputs.length} outputs`);

    // Collect all message blocks to preserve full execution details
    let allBlocks = [];
    let lastAssistantMessage = null;

    for (const output of outputs) {
      if (output.type === 'assistant' && output.message?.content) {
        debugLog(`[processMessage] Found assistant message with ${output.message.content.length} content blocks`);
        lastAssistantMessage = output.message;
        allBlocks.push(...(output.message.content || []));
      } else if (output.type === 'tool_result' && output.result) {
        debugLog(`[processMessage] Found tool result: ${typeof output.result}`);
        allBlocks.push({
          type: 'tool_result',
          result: output.result,
          tool_use_id: output.tool_use_id
        });
      }
    }

    // Store full message structure if we have execution data, otherwise fallback to text
    let messageContent = null;

    if (allBlocks.length > 0) {
      // Store full message structure as JSON for proper rendering
      messageContent = JSON.stringify({
        type: 'claude_execution',
        blocks: allBlocks,
        timestamp: Date.now()
      });
      debugLog(`[processMessage] Storing full execution with ${allBlocks.length} blocks`);
    } else {
      // Fallback: extract text for simple responses
      let textParts = [];
      for (const output of outputs) {
        if (typeof output === 'string') {
          textParts.push(output);
        } else if (output.text) {
          textParts.push(output.text);
        } else if (output.content?.text) {
          textParts.push(output.content.text);
        } else if (output.result) {
          textParts.push(String(output.result));
        }
      }
      messageContent = textParts.join('\n').trim();
      debugLog(`[processMessage] Storing text response: "${messageContent.substring(0, 100)}..."`);
    }

    if (messageContent) {
      debugLog(`[processMessage] Creating assistant message`);
      const assistantMessage = queries.createMessage(conversationId, 'assistant', messageContent);
      debugLog(`[processMessage] Created message with id: ${assistantMessage.id}`);
      broadcastSync({
        type: 'message_created',
        conversationId,
        message: assistantMessage,
        timestamp: Date.now()
      });
    } else {
      debugLog(`[processMessage] No response content extracted!`);
    }

    debugLog(`[processMessage] ✅ Completed: ${outputs.length} outputs received`);
  } catch (error) {
    debugLog(`[processMessage] Error: ${error.message}`);
    debugLog(`[processMessage] Stack: ${error.stack}`);
    const errorMessage = queries.createMessage(conversationId, 'assistant', `Error: ${error.message}`);
    broadcastSync({
      type: 'message_created',
      conversationId,
      message: errorMessage,
      timestamp: Date.now()
    });
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
          debugLog(`[WebSocket] Client ${ws.clientId} subscribed to ${data.sessionId}`);
          ws.send(JSON.stringify({
            type: 'subscription_confirmed',
            sessionId: data.sessionId,
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
  const isStreamingEvent = event.type && event.type.startsWith('streaming_');
  const targetSessionId = event.sessionId || (event.conversationId && `conv-${event.conversationId}`);

  for (const ws of syncClients) {
    if (ws.readyState !== 1) continue;

    let shouldSend = false;

    if (isStreamingEvent && targetSessionId) {
      // Streaming events require sessionId subscription
      shouldSend = ws.subscriptions && ws.subscriptions.has(targetSessionId);
    } else if (event.sessionId) {
      // Regular session events require sessionId subscription
      shouldSend = ws.subscriptions && ws.subscriptions.has(event.sessionId);
    } else if (event.type === 'message_created' || event.type === 'conversation_created') {
      // Global events sent to all clients
      shouldSend = true;
    } else {
      // Default: send to all connected clients
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
