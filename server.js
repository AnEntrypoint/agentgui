import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { execSync } from 'child_process';
import { createRequire } from 'module';
import { queries } from './database.js';
import { runClaudeWithStreaming } from './lib/claude-runner.js';
let speechModule = null;
async function getSpeech() {
  if (!speechModule) speechModule = await import('./lib/speech.js');
  return speechModule;
}

function eagerTTS(text, conversationId, sessionId) {
  getSpeech().then(speech => {
    const status = speech.getStatus();
    if (!status.ttsReady || status.ttsError) return;
    const voices = new Set();
    for (const ws of syncClients) {
      const vid = ws.ttsVoiceId || 'default';
      const convKey = `conv-${conversationId}`;
      if (ws.subscriptions && (ws.subscriptions.has(sessionId) || ws.subscriptions.has(convKey))) {
        voices.add(vid);
      }
    }
    if (voices.size === 0) return;
    const sentences = speech.splitSentences(text);
    for (const vid of voices) {
      for (const sentence of sentences) {
        const cacheKey = speech.ttsCacheKey(sentence, vid);
        const cached = speech.ttsCacheGet(cacheKey);
        if (cached) {
          pushTTSAudio(cacheKey, cached, conversationId, sessionId, vid);
          continue;
        }
        speech.synthesize(sentence, vid).then(wav => {
          pushTTSAudio(cacheKey, wav, conversationId, sessionId, vid);
        }).catch(() => {});
      }
    }
  }).catch(() => {});
}

function pushTTSAudio(cacheKey, wav, conversationId, sessionId, voiceId) {
  const b64 = wav.toString('base64');
  broadcastSync({
    type: 'tts_audio',
    cacheKey,
    audio: b64,
    voiceId,
    conversationId,
    sessionId,
    timestamp: Date.now()
  });
}

const require = createRequire(import.meta.url);
const express = require('express');
const Busboy = require('busboy');
const fsbrowse = require('fsbrowse');

const SYSTEM_PROMPT = `Write all responses as short, easy to speak sentences. Be concise and conversational. Avoid formatting, markup, or structured output. Just plain text in brief sentences.`;

const activeExecutions = new Map();
const messageQueues = new Map();
const rateLimitState = new Map();
const STUCK_AGENT_THRESHOLD_MS = 600000;
const NO_PID_GRACE_PERIOD_MS = 60000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60000;

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

function acceptsEncoding(req, encoding) {
  const accept = req.headers['accept-encoding'] || '';
  return accept.includes(encoding);
}

function compressAndSend(req, res, statusCode, contentType, body) {
  const raw = typeof body === 'string' ? Buffer.from(body) : body;
  if (raw.length < 860) {
    res.writeHead(statusCode, { 'Content-Type': contentType, 'Content-Length': raw.length });
    res.end(raw);
    return;
  }
  if (acceptsEncoding(req, 'br')) {
    const compressed = zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } });
    res.writeHead(statusCode, { 'Content-Type': contentType, 'Content-Encoding': 'br', 'Content-Length': compressed.length });
    res.end(compressed);
  } else if (acceptsEncoding(req, 'gzip')) {
    const compressed = zlib.gzipSync(raw, { level: 6 });
    res.writeHead(statusCode, { 'Content-Type': contentType, 'Content-Encoding': 'gzip', 'Content-Length': compressed.length });
    res.end(compressed);
  } else {
    res.writeHead(statusCode, { 'Content-Type': contentType, 'Content-Length': raw.length });
    res.end(raw);
  }
}

function sendJSON(req, res, statusCode, data) {
  compressAndSend(req, res, statusCode, 'application/json', JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const pathOnly = req.url.split('?')[0];

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
            sendJSON(req, res, 200, { conversations: queries.getConversationsList() });
      return;
    }

    if (pathOnly === '/api/conversations' && req.method === 'POST') {
      const body = await parseBody(req);
      const conversation = queries.createConversation(body.agentId, body.title, body.workingDirectory || null);
      queries.createEvent('conversation.created', { agentId: body.agentId, workingDirectory: conversation.workingDirectory }, conversation.id);
      broadcastSync({ type: 'conversation_created', conversation });
            sendJSON(req, res, 201, { conversation });
      return;
    }

    const convMatch = pathOnly.match(/^\/api\/conversations\/([^/]+)$/);
    if (convMatch) {
      if (req.method === 'GET') {
        const conv = queries.getConversation(convMatch[1]);
        if (!conv) { sendJSON(req, res, 404, { error: 'Not found' }); return; }

        const latestSession = queries.getLatestSession(convMatch[1]);
        const isActivelyStreaming = activeExecutions.has(convMatch[1]);

                sendJSON(req, res, 200, {
          conversation: conv,
          isActivelyStreaming,
          latestSession
        });
        return;
      }

      if (req.method === 'POST' || req.method === 'PUT') {
        const body = await parseBody(req);
        const conv = queries.updateConversation(convMatch[1], body);
        if (!conv) { sendJSON(req, res, 404, { error: 'Conversation not found' }); return; }
        queries.createEvent('conversation.updated', body, convMatch[1]);
        broadcastSync({ type: 'conversation_updated', conversation: conv });
                sendJSON(req, res, 200, { conversation: conv });
        return;
      }

      if (req.method === 'DELETE') {
        const deleted = queries.deleteConversation(convMatch[1]);
        if (!deleted) { sendJSON(req, res, 404, { error: 'Not found' }); return; }
        broadcastSync({ type: 'conversation_deleted', conversationId: convMatch[1] });
                sendJSON(req, res, 200, { deleted: true });
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
                sendJSON(req, res, 200, result);
        return;
      }

      if (req.method === 'POST') {
        const conversationId = messagesMatch[1];
        const conv = queries.getConversation(conversationId);
        if (!conv) { sendJSON(req, res, 404, { error: 'Conversation not found' }); return; }
        const body = await parseBody(req);
        const agentId = body.agentId || conv.agentType || conv.agentId || 'claude-code';
        const idempotencyKey = body.idempotencyKey || null;
        const message = queries.createMessage(conversationId, 'user', body.content, idempotencyKey);
        queries.createEvent('message.created', { role: 'user', messageId: message.id }, conversationId);
        broadcastSync({ type: 'message_created', conversationId, message, timestamp: Date.now() });

        if (activeExecutions.has(conversationId)) {
          if (!messageQueues.has(conversationId)) messageQueues.set(conversationId, []);
          messageQueues.get(conversationId).push({ content: body.content, agentId, messageId: message.id });
          const queueLength = messageQueues.get(conversationId).length;
          broadcastSync({ type: 'queue_status', conversationId, queueLength, messageId: message.id, timestamp: Date.now() });
          sendJSON(req, res, 200, { message, queued: true, queuePosition: queueLength, idempotencyKey });
          return;
        }

        const session = queries.createSession(conversationId);
        queries.createEvent('session.created', { messageId: message.id, sessionId: session.id }, conversationId, session.id);

        activeExecutions.set(conversationId, { pid: null, startTime: Date.now(), sessionId: session.id, lastActivity: Date.now() });
        queries.setIsStreaming(conversationId, true);

        broadcastSync({
          type: 'streaming_start',
          sessionId: session.id,
          conversationId,
          messageId: message.id,
          agentId,
          timestamp: Date.now()
        });

        sendJSON(req, res, 201, { message, session, idempotencyKey });

        processMessageWithStreaming(conversationId, message.id, session.id, body.content, agentId)
          .catch(err => debugLog(`[messages] Uncaught error: ${err.message}`));
        return;
      }
    }

    const streamMatch = pathOnly.match(/^\/api\/conversations\/([^/]+)\/stream$/);
    if (streamMatch && req.method === 'POST') {
      const conversationId = streamMatch[1];
      const body = await parseBody(req);
      const conv = queries.getConversation(conversationId);
      if (!conv) { sendJSON(req, res, 404, { error: 'Conversation not found' }); return; }

      const prompt = body.content || body.message || '';
      const agentId = body.agentId || conv.agentType || conv.agentId || 'claude-code';

      const userMessage = queries.createMessage(conversationId, 'user', prompt);
      queries.createEvent('message.created', { role: 'user', messageId: userMessage.id }, conversationId);

      broadcastSync({ type: 'message_created', conversationId, message: userMessage, timestamp: Date.now() });

      if (activeExecutions.has(conversationId)) {
        debugLog(`[stream] Conversation ${conversationId} is busy, queuing message`);
        if (!messageQueues.has(conversationId)) messageQueues.set(conversationId, []);
        messageQueues.get(conversationId).push({ content: prompt, agentId, messageId: userMessage.id });

        const queueLength = messageQueues.get(conversationId).length;
        broadcastSync({ type: 'queue_status', conversationId, queueLength, messageId: userMessage.id, timestamp: Date.now() });

                sendJSON(req, res, 200, { message: userMessage, queued: true, queuePosition: queueLength });
        return;
      }

      const session = queries.createSession(conversationId);
      queries.createEvent('session.created', { messageId: userMessage.id, sessionId: session.id }, conversationId, session.id);

      activeExecutions.set(conversationId, { pid: null, startTime: Date.now(), sessionId: session.id, lastActivity: Date.now() });
      queries.setIsStreaming(conversationId, true);

      broadcastSync({
        type: 'streaming_start',
        sessionId: session.id,
        conversationId,
        messageId: userMessage.id,
        agentId,
        timestamp: Date.now()
      });

      sendJSON(req, res, 200, { message: userMessage, session, streamId: session.id });

      processMessageWithStreaming(conversationId, userMessage.id, session.id, prompt, agentId)
        .catch(err => debugLog(`[stream] Uncaught error: ${err.message}`));
      return;
    }

    const messageMatch = pathOnly.match(/^\/api\/conversations\/([^/]+)\/messages\/([^/]+)$/);
    if (messageMatch && req.method === 'GET') {
      const msg = queries.getMessage(messageMatch[2]);
      if (!msg || msg.conversationId !== messageMatch[1]) { sendJSON(req, res, 404, { error: 'Not found' }); return; }
            sendJSON(req, res, 200, { message: msg });
      return;
    }

    const sessionMatch = pathOnly.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch && req.method === 'GET') {
      const sess = queries.getSession(sessionMatch[1]);
      if (!sess) { sendJSON(req, res, 404, { error: 'Not found' }); return; }
      const events = queries.getSessionEvents(sessionMatch[1]);
            sendJSON(req, res, 200, { session: sess, events });
      return;
    }

    const fullLoadMatch = pathOnly.match(/^\/api\/conversations\/([^/]+)\/full$/);
    if (fullLoadMatch && req.method === 'GET') {
      const conversationId = fullLoadMatch[1];
      const conv = queries.getConversation(conversationId);
      if (!conv) { sendJSON(req, res, 404, { error: 'Not found' }); return; }
      const latestSession = queries.getLatestSession(conversationId);
      const isActivelyStreaming = activeExecutions.has(conversationId);

      const url = new URL(req.url, 'http://localhost');
      const chunkLimit = Math.min(parseInt(url.searchParams.get('chunkLimit') || '500'), 5000);
      const allChunks = url.searchParams.get('allChunks') === '1';

      const totalChunks = queries.getConversationChunkCount(conversationId);
      let chunks;
      if (allChunks || totalChunks <= chunkLimit) {
        chunks = queries.getConversationChunks(conversationId);
      } else {
        chunks = queries.getRecentConversationChunks(conversationId, chunkLimit);
      }
      const msgResult = queries.getPaginatedMessages(conversationId, 100, 0);
      const rateLimitInfo = rateLimitState.get(conversationId) || null;
            sendJSON(req, res, 200, {
        conversation: conv,
        isActivelyStreaming,
        latestSession,
        chunks,
        totalChunks,
        messages: msgResult.messages,
        rateLimitInfo
      });
      return;
    }

    const conversationChunksMatch = pathOnly.match(/^\/api\/conversations\/([^/]+)\/chunks$/);
    if (conversationChunksMatch && req.method === 'GET') {
      const conversationId = conversationChunksMatch[1];
      const conv = queries.getConversation(conversationId);
      if (!conv) { sendJSON(req, res, 404, { error: 'Conversation not found' }); return; }

      const url = new URL(req.url, 'http://localhost');
      const since = parseInt(url.searchParams.get('since') || '0');

      const allChunks = queries.getConversationChunks(conversationId);
      debugLog(`[chunks] Conv ${conversationId}: ${allChunks.length} total chunks`);
      const chunks = since > 0 ? allChunks.filter(c => c.created_at > since) : allChunks;
            sendJSON(req, res, 200, { ok: true, chunks });
      return;
    }

    const sessionChunksMatch = pathOnly.match(/^\/api\/sessions\/([^/]+)\/chunks$/);
    if (sessionChunksMatch && req.method === 'GET') {
      const sessionId = sessionChunksMatch[1];
      const sess = queries.getSession(sessionId);
      if (!sess) { sendJSON(req, res, 404, { error: 'Session not found' }); return; }

      const url = new URL(req.url, 'http://localhost');
      const since = parseInt(url.searchParams.get('since') || '0');

      const chunks = queries.getChunksSince(sessionId, since);
            sendJSON(req, res, 200, { ok: true, chunks });
      return;
    }

    if (pathOnly.match(/^\/api\/conversations\/([^/]+)\/sessions\/latest$/) && req.method === 'GET') {
      const convId = pathOnly.match(/^\/api\/conversations\/([^/]+)\/sessions\/latest$/)[1];
      const latestSession = queries.getLatestSession(convId);
      if (!latestSession) {
                sendJSON(req, res, 200, { session: null });
        return;
      }
      const events = queries.getSessionEvents(latestSession.id);
            sendJSON(req, res, 200, { session: latestSession, events });
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

                sendJSON(req, res, 200, executionData);
      } catch (err) {
                sendJSON(req, res, 400, { error: err.message });
      }
      return;
    }

    if (routePath === '/api/agents' && req.method === 'GET') {
            sendJSON(req, res, 200, { agents: discoveredAgents });
      return;
    }


    if (routePath === '/api/import/claude-code' && req.method === 'GET') {
      const result = queries.importClaudeCodeConversations();
            sendJSON(req, res, 200, { imported: result });
      return;
    }

    if (routePath === '/api/discover/claude-code' && req.method === 'GET') {
      const discovered = queries.discoverClaudeCodeConversations();
            sendJSON(req, res, 200, { discovered });
      return;
    }

    if (routePath === '/api/home' && req.method === 'GET') {
            sendJSON(req, res, 200, { home: os.homedir(), cwd: STARTUP_CWD });
      return;
    }

    if (routePath === '/api/stt' && req.method === 'POST') {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const audioBuffer = Buffer.concat(chunks);
        if (audioBuffer.length === 0) {
                    sendJSON(req, res, 400, { error: 'No audio data' });
          return;
        }
        const { transcribe } = await getSpeech();
        const text = await transcribe(audioBuffer);
                sendJSON(req, res, 200, { text: (text || '').trim() });
      } catch (err) {
        debugLog('[STT] Error: ' + err.message);
        if (!res.headersSent) sendJSON(req, res, 500, { error: err.message || 'STT failed' });
      }
      return;
    }

    if (routePath === '/api/voices' && req.method === 'GET') {
      try {
        const { getVoices } = await getSpeech();
        sendJSON(req, res, 200, { ok: true, voices: getVoices() });
      } catch (err) {
        sendJSON(req, res, 200, { ok: true, voices: [] });
      }
      return;
    }

    if (routePath === '/api/tts' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const text = body.text || '';
        const voiceId = body.voiceId || null;
        if (!text) {
          sendJSON(req, res, 400, { error: 'No text provided' });
          return;
        }
        const speech = await getSpeech();
        const status = speech.getStatus();
        if (status.ttsError) {
          sendJSON(req, res, 503, { error: status.ttsError, retryable: false });
          return;
        }
        const wavBuffer = await speech.synthesize(text, voiceId);
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wavBuffer.length });
        res.end(wavBuffer);
      } catch (err) {
        debugLog('[TTS] Error: ' + err.message);
        const isModelError = /model.*load|pipeline.*failed|failed to load/i.test(err.message);
        const statusCode = isModelError ? 503 : 500;
        if (!res.headersSent) sendJSON(req, res, statusCode, { error: err.message || 'TTS failed', retryable: !isModelError });
      }
      return;
    }

    if (routePath === '/api/tts-stream' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const text = body.text || '';
        const voiceId = body.voiceId || null;
        if (!text) {
          sendJSON(req, res, 400, { error: 'No text provided' });
          return;
        }
        const speech = await getSpeech();
        const status = speech.getStatus();
        if (status.ttsError) {
          sendJSON(req, res, 503, { error: status.ttsError, retryable: false });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Transfer-Encoding': 'chunked',
          'X-Content-Type': 'audio/wav-stream',
          'Cache-Control': 'no-cache'
        });
        for await (const wavChunk of speech.synthesizeStream(text, voiceId)) {
          const lenBuf = Buffer.alloc(4);
          lenBuf.writeUInt32BE(wavChunk.length, 0);
          res.write(lenBuf);
          res.write(wavChunk);
        }
        res.end();
      } catch (err) {
        debugLog('[TTS-STREAM] Error: ' + err.message);
        const isModelError = /model.*load|pipeline.*failed|failed to load/i.test(err.message);
        const statusCode = isModelError ? 503 : 500;
        if (!res.headersSent) sendJSON(req, res, statusCode, { error: err.message || 'TTS stream failed', retryable: !isModelError });
        else res.end();
      }
      return;
    }

    if (routePath === '/api/speech-status' && req.method === 'GET') {
      try {
        const { getStatus } = await getSpeech();
        sendJSON(req, res, 200, getStatus());
      } catch (err) {
        sendJSON(req, res, 200, { sttReady: false, ttsReady: false, sttLoading: false, ttsLoading: false });
      }
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
                sendJSON(req, res, 200, { folders });
      } catch (err) {
                sendJSON(req, res, 400, { error: err.message });
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
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
        res.end(fileContent);
      } catch (err) {
                sendJSON(req, res, 400, { error: err.message });
      }
      return;
    }

    // Handle conversation detail routes - serve index.html for client-side routing
    if (pathOnly.match(/^\/conversations\/[^\/]+$/)) {
      const indexPath = path.join(staticDir, 'index.html');
      serveFile(indexPath, res, req);
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
          serveFile(filePath, res, req);
        });
      } else {
        serveFile(filePath, res, req);
      }
    });
  } catch (e) {
    console.error('Server error:', e.message);
        sendJSON(req, res, 500, { error: e.message });
  }
});

const MIME_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

function generateETag(stats) {
  return `"${stats.mtimeMs.toString(36)}-${stats.size.toString(36)}"`;
}

function serveFile(filePath, res, req) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  if (ext !== '.html') {
    fs.stat(filePath, (err, stats) => {
      if (err) { res.writeHead(500); res.end('Server error'); return; }
      const etag = generateETag(stats);
      if (req && req.headers['if-none-match'] === etag) {
        res.writeHead(304);
        res.end();
        return;
      }
      const headers = {
        'Content-Type': contentType,
        'Content-Length': stats.size,
        'ETag': etag,
        'Cache-Control': 'public, max-age=3600, must-revalidate'
      };
      if (acceptsEncoding(req, 'br') && stats.size > 860) {
        const stream = fs.createReadStream(filePath);
        headers['Content-Encoding'] = 'br';
        delete headers['Content-Length'];
        res.writeHead(200, headers);
        stream.pipe(zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } })).pipe(res);
      } else if (acceptsEncoding(req, 'gzip') && stats.size > 860) {
        const stream = fs.createReadStream(filePath);
        headers['Content-Encoding'] = 'gzip';
        delete headers['Content-Length'];
        res.writeHead(200, headers);
        stream.pipe(zlib.createGzip({ level: 6 })).pipe(res);
      } else {
        res.writeHead(200, headers);
        fs.createReadStream(filePath).pipe(res);
      }
    });
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(500); res.end('Server error'); return; }
    let content = data.toString();
    const baseTag = `<script>window.__BASE_URL='${BASE_URL}';</script>`;
    content = content.replace('<head>', '<head>\n  ' + baseTag);
    if (watch) {
      content += `\n<script>(function(){const ws=new WebSocket('ws://'+location.host+'${BASE_URL}/hot-reload');ws.onmessage=e=>{if(JSON.parse(e.data).type==='reload')location.reload()};})();</script>`;
    }
    compressAndSend(req, res, 200, contentType, content);
  });
}

function createChunkBatcher() {
  const pending = [];
  let timer = null;
  const BATCH_SIZE = 10;
  const BATCH_INTERVAL = 50;

  function flush() {
    if (pending.length === 0) return;
    const batch = pending.splice(0);
    try {
      const tx = queries._db ? queries._db.transaction(() => {
        for (const c of batch) queries.createChunk(c.sessionId, c.conversationId, c.sequence, c.type, c.data);
      }) : null;
      if (tx) { tx(); } else {
        for (const c of batch) {
          try { queries.createChunk(c.sessionId, c.conversationId, c.sequence, c.type, c.data); } catch (e) { debugLog(`[chunk] ${e.message}`); }
        }
      }
    } catch (err) {
      debugLog(`[chunk-batch] Batch write failed: ${err.message}`);
      for (const c of batch) {
        try { queries.createChunk(c.sessionId, c.conversationId, c.sequence, c.type, c.data); } catch (_) {}
      }
    }
  }

  function add(sessionId, conversationId, sequence, blockType, blockData) {
    pending.push({ sessionId, conversationId, sequence, type: blockType, data: blockData });
    if (pending.length >= BATCH_SIZE) {
      if (timer) { clearTimeout(timer); timer = null; }
      flush();
    } else if (!timer) {
      timer = setTimeout(() => { timer = null; flush(); }, BATCH_INTERVAL);
    }
  }

  function drain() {
    if (timer) { clearTimeout(timer); timer = null; }
    flush();
  }

  return { add, drain };
}

async function processMessageWithStreaming(conversationId, messageId, sessionId, content, agentId) {
  const startTime = Date.now();
  activeExecutions.set(conversationId, { pid: null, startTime, sessionId, lastActivity: startTime });
  queries.setIsStreaming(conversationId, true);
  queries.updateSession(sessionId, { status: 'active' });
  const batcher = createChunkBatcher();

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
      const entry = activeExecutions.get(conversationId);
      if (entry) entry.lastActivity = Date.now();
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
        batcher.add(sessionId, conversationId, currentSequence, 'system', systemBlock);

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
          batcher.add(sessionId, conversationId, currentSequence, block.type || 'assistant', block);

          broadcastSync({
            type: 'streaming_progress',
            sessionId,
            conversationId,
            block,
            blockIndex: allBlocks.length - 1,
            timestamp: Date.now()
          });

          if (block.type === 'text' && block.text) {
            eagerTTS(block.text, conversationId, sessionId);
          }
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
            batcher.add(sessionId, conversationId, currentSequence, 'tool_result', toolResultBlock);

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
        batcher.add(sessionId, conversationId, currentSequence, 'result', resultBlock);

        broadcastSync({
          type: 'streaming_progress',
          sessionId,
          conversationId,
          block: resultBlock,
          blockIndex: allBlocks.length,
          isResult: true,
          timestamp: Date.now()
        });

        if (parsed.result) {
          const resultText = typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result);
          if (resultText) eagerTTS(resultText, conversationId, sessionId);
        }

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
      onEvent,
      onPid: (pid) => {
        const entry = activeExecutions.get(conversationId);
        if (entry) entry.pid = pid;
      }
    };

    const { outputs, sessionId: claudeSessionId } = await runClaudeWithStreaming(content, cwd, agentId || 'claude-code', config);
    activeExecutions.delete(conversationId);
    batcher.drain();
    debugLog(`[stream] Claude returned ${outputs.length} outputs, sessionId=${claudeSessionId}`);

    if (claudeSessionId) {
      queries.setClaudeSessionId(conversationId, claudeSessionId);
      debugLog(`[stream] Updated claudeSessionId=${claudeSessionId}`);
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

    const isRateLimit = error.rateLimited ||
      /rate.?limit|429|too many requests|overloaded|throttl/i.test(error.message);

    queries.updateSession(sessionId, {
      status: 'error',
      error: error.message,
      completed_at: Date.now()
    });

    if (isRateLimit) {
      const cooldownMs = (error.retryAfterSec || 60) * 1000;
      const retryAt = Date.now() + cooldownMs;
      rateLimitState.set(conversationId, { retryAt, cooldownMs });
      debugLog(`[rate-limit] Conv ${conversationId} hit rate limit, retry in ${cooldownMs}ms`);

      broadcastSync({
        type: 'rate_limit_hit',
        sessionId,
        conversationId,
        retryAfterMs: cooldownMs,
        retryAt,
        timestamp: Date.now()
      });

      batcher.drain();

      setTimeout(() => {
        rateLimitState.delete(conversationId);
        debugLog(`[rate-limit] Conv ${conversationId} cooldown expired, restarting`);
        broadcastSync({
          type: 'rate_limit_clear',
          conversationId,
          timestamp: Date.now()
        });
        scheduleRetry(conversationId, messageId, content, agentId);
      }, cooldownMs);
      return;
    }

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
    batcher.drain();
    activeExecutions.delete(conversationId);
    queries.setIsStreaming(conversationId, false);
    if (!rateLimitState.has(conversationId)) {
      drainMessageQueue(conversationId);
    }
  }
}

function scheduleRetry(conversationId, messageId, content, agentId) {
  const newSession = queries.createSession(conversationId);
  queries.createEvent('session.created', { messageId, sessionId: newSession.id, retryReason: 'rate_limit' }, conversationId, newSession.id);

  broadcastSync({
    type: 'streaming_start',
    sessionId: newSession.id,
    conversationId,
    messageId,
    agentId,
    timestamp: Date.now()
  });

  processMessageWithStreaming(conversationId, messageId, newSession.id, content, agentId)
    .catch(err => debugLog(`[retry] Error: ${err.message}`));
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


const wss = new WebSocketServer({
  server,
  perMessageDeflate: {
    zlibDeflateOptions: { level: 6 },
    threshold: 256
  }
});
const hotReloadClients = [];
const syncClients = new Set();
const subscriptionIndex = new Map();

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
          if (data.sessionId) {
            ws.subscriptions.add(data.sessionId);
            if (!subscriptionIndex.has(data.sessionId)) subscriptionIndex.set(data.sessionId, new Set());
            subscriptionIndex.get(data.sessionId).add(ws);
          }
          if (data.conversationId) {
            const key = `conv-${data.conversationId}`;
            ws.subscriptions.add(key);
            if (!subscriptionIndex.has(key)) subscriptionIndex.set(key, new Set());
            subscriptionIndex.get(key).add(ws);
          }
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
          const idx = subscriptionIndex.get(data.sessionId);
          if (idx) { idx.delete(ws); if (idx.size === 0) subscriptionIndex.delete(data.sessionId); }
          debugLog(`[WebSocket] Client ${ws.clientId} unsubscribed from ${data.sessionId}`);
        } else if (data.type === 'get_subscriptions') {
          ws.send(JSON.stringify({
            type: 'subscriptions',
            subscriptions: Array.from(ws.subscriptions),
            timestamp: Date.now()
          }));
        } else if (data.type === 'set_voice') {
          ws.ttsVoiceId = data.voiceId || 'default';
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
      for (const sub of ws.subscriptions) {
        const idx = subscriptionIndex.get(sub);
        if (idx) { idx.delete(ws); if (idx.size === 0) subscriptionIndex.delete(sub); }
      }
      console.log(`[WebSocket] Client ${ws.clientId} disconnected`);
    });
  }
});

const BROADCAST_TYPES = new Set([
  'message_created', 'conversation_created', 'conversation_updated',
  'conversations_updated', 'conversation_deleted', 'queue_status',
  'streaming_start', 'streaming_complete', 'streaming_error',
  'rate_limit_hit', 'rate_limit_clear'
]);

const wsBatchQueues = new Map();
const WS_BATCH_INTERVAL = 16;

function flushWsBatch(ws) {
  const queue = wsBatchQueues.get(ws);
  if (!queue || queue.msgs.length === 0) return;
  if (ws.readyState !== 1) { wsBatchQueues.delete(ws); return; }
  if (queue.msgs.length === 1) {
    ws.send(queue.msgs[0]);
  } else {
    ws.send('[' + queue.msgs.join(',') + ']');
  }
  queue.msgs.length = 0;
  queue.timer = null;
}

function sendToClient(ws, data) {
  if (ws.readyState !== 1) return;
  let queue = wsBatchQueues.get(ws);
  if (!queue) { queue = { msgs: [], timer: null }; wsBatchQueues.set(ws, queue); }
  queue.msgs.push(data);
  if (!queue.timer) {
    queue.timer = setTimeout(() => flushWsBatch(ws), WS_BATCH_INTERVAL);
  }
}

function broadcastSync(event) {
  if (syncClients.size === 0) return;
  const data = JSON.stringify(event);
  const isBroadcast = BROADCAST_TYPES.has(event.type);

  if (isBroadcast) {
    for (const ws of syncClients) sendToClient(ws, data);
    return;
  }

  const targets = new Set();
  if (event.sessionId) {
    const subs = subscriptionIndex.get(event.sessionId);
    if (subs) for (const ws of subs) targets.add(ws);
  }
  if (event.conversationId) {
    const subs = subscriptionIndex.get(`conv-${event.conversationId}`);
    if (subs) for (const ws of subs) targets.add(ws);
  }
  for (const ws of targets) sendToClient(ws, data);
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

function recoverStaleSessions() {
  try {
    const now = Date.now();

    const staleSessions = queries.getActiveSessions ? queries.getActiveSessions() : [];
    for (const session of staleSessions) {
      if (activeExecutions.has(session.conversationId)) continue;
      queries.updateSession(session.id, {
        status: 'error',
        error: 'Server restarted',
        completed_at: now
      });
    }
    if (staleSessions.length > 0) {
      console.log(`[RECOVERY] Marked ${staleSessions.length} stale session(s) as error`);
    }

    const streamingConvs = queries.getStreamingConversations ? queries.getStreamingConversations() : [];
    let clearedCount = 0;
    for (const conv of streamingConvs) {
      if (activeExecutions.has(conv.id)) continue;
      queries.setIsStreaming(conv.id, false);
      clearedCount++;
    }
    if (clearedCount > 0) {
      console.log(`[RECOVERY] Cleared isStreaming flag on ${clearedCount} stale conversation(s)`);
    }
  } catch (err) {
    console.error('[RECOVERY] Stale session recovery error:', err.message);
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === 'EPERM') return true;
    return false;
  }
}

function markAgentDead(conversationId, entry, reason) {
  if (!activeExecutions.has(conversationId)) return;
  activeExecutions.delete(conversationId);
  queries.setIsStreaming(conversationId, false);
  if (entry.sessionId) {
    queries.updateSession(entry.sessionId, {
      status: 'error',
      error: reason,
      completed_at: Date.now()
    });
  }
  broadcastSync({
    type: 'streaming_error',
    sessionId: entry.sessionId,
    conversationId,
    error: reason,
    recoverable: false,
    timestamp: Date.now()
  });
  drainMessageQueue(conversationId);
}

function performAgentHealthCheck() {
  const now = Date.now();
  for (const [conversationId, entry] of activeExecutions) {
    if (!entry) continue;

    if (entry.pid) {
      if (!isProcessAlive(entry.pid)) {
        debugLog(`[HEALTH] Agent PID ${entry.pid} for conv ${conversationId} is dead`);
        markAgentDead(conversationId, entry, 'Agent process died unexpectedly');
      } else if (now - entry.lastActivity > STUCK_AGENT_THRESHOLD_MS) {
        debugLog(`[HEALTH] Agent PID ${entry.pid} for conv ${conversationId} has no activity for ${Math.round((now - entry.lastActivity) / 1000)}s`);
        broadcastSync({
          type: 'streaming_error',
          sessionId: entry.sessionId,
          conversationId,
          error: 'Agent may be stuck (no activity for 10 minutes)',
          recoverable: true,
          timestamp: now
        });
      }
    } else {
      if (now - entry.startTime > NO_PID_GRACE_PERIOD_MS) {
        debugLog(`[HEALTH] Agent for conv ${conversationId} never reported PID after ${Math.round((now - entry.startTime) / 1000)}s`);
        markAgentDead(conversationId, entry, 'Agent failed to start (no PID reported)');
      }
    }
  }
}

function onServerReady() {
  console.log(`GMGUI running on http://localhost:${PORT}${BASE_URL}/`);
  console.log(`Agents: ${discoveredAgents.map(a => a.name).join(', ') || 'none'}`);
  console.log(`Hot reload: ${watch ? 'on' : 'off'}`);

  // Clean up empty conversations on startup
  const deletedCount = queries.cleanupEmptyConversations();
  if (deletedCount > 0) {
    console.log(`Cleaned up ${deletedCount} empty conversation(s) on startup`);
  }

  // Recover stale active sessions from previous run
  recoverStaleSessions();

  getSpeech().then(s => s.getTTS()).then(() => debugLog('[TTS] Model preloaded')).catch(e => debugLog('[TTS] Preload failed: ' + e.message));

  performAutoImport();

  // Then run it every 30 seconds (constant automatic importing)
  setInterval(performAutoImport, 30000);

  // Agent health check every 30 seconds
  setInterval(performAgentHealthCheck, 30000);

}

const importMtimeCache = new Map();

function hasIndexFilesChanged() {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  if (!fs.existsSync(projectsDir)) return false;
  let changed = false;
  try {
    const dirs = fs.readdirSync(projectsDir);
    for (const d of dirs) {
      const indexPath = path.join(projectsDir, d, 'sessions-index.json');
      try {
        const stat = fs.statSync(indexPath);
        const cached = importMtimeCache.get(indexPath);
        if (!cached || cached < stat.mtimeMs) {
          importMtimeCache.set(indexPath, stat.mtimeMs);
          changed = true;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return changed;
}

function performAutoImport() {
  try {
    if (!hasIndexFilesChanged()) return;
    const imported = queries.importClaudeCodeConversations();
    if (imported.length > 0) {
      const importedCount = imported.filter(i => i.status === 'imported').length;
      if (importedCount > 0) {
        console.log(`[AUTO-IMPORT] Imported ${importedCount} new Claude Code conversations`);
        broadcastSync({ type: 'conversations_updated', count: importedCount });
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
