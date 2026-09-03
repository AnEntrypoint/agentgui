import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { LRUCache } from 'lru-cache';
const PKG_VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
import { createExpressApp } from './lib/routes-upload.js';
import { createHistoryRouter } from 'ccsniff';
import { queries } from './database.js';
import { runClaudeWithStreaming } from './lib/claude-runner-run.js';
import { initializeDescriptors, getAgentDescriptor } from './lib/agent-descriptors.js';
import { initializeAgentDiscovery } from './lib/agent-discovery.js';
import { register as registerWsHandlers } from './lib/ws-handlers-util.js';
import { BROADCAST_TYPES } from './lib/broadcast.js';
import { WSOptimizer } from './lib/ws-optimizer.js';
import { WsRouter } from './lib/ws-protocol.js';
import { encode as wsEncode } from './lib/codec.js';
import { parseBody, acceptsEncoding, compressAndSend, sendJSON } from './lib/http-utils.js';
import { createWsSetup } from './lib/ws-setup.js';
import { createHttpHandler } from './lib/http-handler.js';
import { createOnServerReady } from './lib/server-startup.js';
import { createAutoImport, createDbRecovery } from './lib/server-startup2.js';
const sendWs = (ws, obj) => { if (ws.readyState === 1) ws.send(wsEncode(obj)); };
import { startAll as startACPTools, stopAll as stopACPTools, getStatus as getACPStatus, getPort as getACPPort, ensureRunning, queryModels as queryACPModels, touch as touchACP } from './lib/acp-sdk-manager.js';
import * as execMachine from './lib/execution-machine.js';
import { _assetCache, htmlState, generateETag, warmAssetCache, serveFile as _serveFile } from './lib/asset-server.js';
import { installGMAgentConfigs } from './lib/gm-agent-configs.js';
import { createBroadcast } from './lib/broadcast.js';
import { createRecovery } from './lib/recovery.js';
import { parseRateLimitResetTime } from './lib/process-message-rate-limit.js';
import { createEventHandler } from './lib/stream-event-handler.js';
import { createMessageQueue } from './lib/message-queue.js';
import { createProcessMessage } from './lib/process-message.js';
import { buildSystemPrompt, getProviderConfigs, saveProviderConfig } from './lib/provider-config.js';
import { logError, errLogPath, makeCleanupExecution, makeGetModelsForAgent } from './lib/server-utils.js';


process.on('uncaughtException', (err, origin) => { console.error('[FATAL] Uncaught exception:', err.message, '| origin:', origin); console.error(err.stack); });
process.on('unhandledRejection', (reason) => { console.error('[FATAL] Unhandled rejection:', reason instanceof Error ? reason.message : reason); if (reason instanceof Error) console.error(reason.stack); });
process.on('SIGHUP', () => { console.log('[SIGNAL] SIGHUP received (ignored - uncrashable)'); });
process.on('beforeExit', (code) => { console.log('[PROCESS] beforeExit with code:', code); });
process.on('exit', (code) => { console.log('[PROCESS] exit with code:', code); });

const activeExecutions = new Map();
const activeScripts = new Map();
const messageQueues = new Map();
const rateLimitState = new Map();
let _jsonlWatcher = null;
const activeProcessesByRunId = new Map();
const STUCK_AGENT_THRESHOLD_MS = 1800000;
const NO_PID_GRACE_PERIOD_MS = 60000;

const debugLog = (msg) => {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] ${msg}`);
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = process.env.PORTABLE_EXE_DIR || __dirname;
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || '/gm').replace(/\/+/g, '/').replace(/\/+$/, '');
const watch = process.argv.includes('--no-watch') ? false : (process.argv.includes('--watch') || process.env.HOT_RELOAD !== 'false');

const STARTUP_CWD = (() => {
  const cwd = process.env.STARTUP_CWD || process.cwd();
  try { fs.accessSync(cwd, fs.constants.R_OK); return cwd; } catch { console.warn(`[server] STARTUP_CWD "${cwd}" not accessible, falling back to ${process.cwd()}`); return process.cwd(); }
})();
const staticDir = path.join(rootDir, 'site', 'app');
if (!fs.existsSync(staticDir)) fs.mkdirSync(staticDir, { recursive: true });

const expressApp = createExpressApp({ queries, BASE_URL });

// ccsniff's /v1/history/sessions/:sid/events returns ALL events with no
// paging. Shim (mounted BEFORE the ccsniff router; node_modules untouched):
// when ?limit= is present, slice the most-recent window server-side and
// report { total, offset } so the client can page older on demand via
// ?before= (slice end index, exclusive; defaults to total).
function historyEventsLimitShim(req, res, next) {
  if (!/\/v1\/history\/sessions\/[^/]+\/events$/.test(req.path)) return next();
  const limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) return next();
  const origJson = res.json.bind(res);
  res.json = (body) => {
    try {
      if (body && Array.isArray(body.events)) {
        const total = body.events.length;
        const before = parseInt(req.query.before, 10);
        const end = (Number.isFinite(before) && before >= 0) ? Math.min(before, total) : total;
        const start = Math.max(0, end - limit);
        body = { ...body, events: body.events.slice(start, end), total, offset: start };
      }
    } catch {}
    return origJson(body);
  };
  next();
}
expressApp.use(historyEventsLimitShim);

try {
  const historyRouter = await createHistoryRouter({ projectsDir: process.env.CLAUDE_PROJECTS_DIR });
  expressApp.use('/', historyRouter);
  if (BASE_URL && BASE_URL !== '/') expressApp.use(BASE_URL, historyRouter);
  console.log('[ccsniff] /v1/history/* mounted at / and ' + (BASE_URL || '/'));
} catch (e) { console.error('[ccsniff] mount failed:', e.message); }

let discoveredAgents = [];
initializeDescriptors(discoveredAgents);

const startTime = Date.now();
initializeAgentDiscovery(discoveredAgents, rootDir, logError).then(() => {
  initializeDescriptors(discoveredAgents);
  console.log('[INIT] initializeAgentDiscovery completed in', Date.now() - startTime, 'ms');
}).catch(() => {});

const modelCache = new Map();
const getModelsForAgent = makeGetModelsForAgent({ modelCache, discoveredAgents, ensureRunning, queryACPModels });

const _rateLimitMap = new LRUCache({ max: 1000, ttl: 60000 });
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '3000', 10);

const _assetDeps = { compressAndSend, acceptsEncoding, watch, BASE_URL, PKG_VERSION };
function serveFile(filePath, res, req, cspNonce) { return _serveFile(filePath, res, req, { ..._assetDeps, cspNonce }); }

const _routes = {};
const server = http.createServer(createHttpHandler({ BASE_URL, expressApp, queries, sendJSON, serveFile, staticDir, messageQueues, getWss: () => wss, activeExecutions, getACPStatus, discoveredAgents, PKG_VERSION, RATE_LIMIT_MAX, rateLimitMap: _rateLimitMap, routes: _routes, PORT }));

let broadcastSeq = 0;
const syncClients = new Set();
const subscriptionIndex = new Map();

const wsOptimizer = new WSOptimizer();

const broadcastSync = createBroadcast({
  syncClients,
  subscriptionIndex,
  wsOptimizer,
  broadcastTypes: BROADCAST_TYPES,
  getSeq: () => ++broadcastSeq
});

const cleanupExecution = makeCleanupExecution({ execMachine, activeExecutions, queries, broadcastSync, debugLog });
const { scheduleRetry, drainMessageQueue } = createMessageQueue({ queries, messageQueues, activeExecutions, rateLimitState, execMachine, broadcastSync, cleanupExecution, debugLog, getProcessMessageWithStreaming: () => processMessageWithStreaming });

const { processMessageWithStreaming } = createProcessMessage({
  queries, activeExecutions, rateLimitState, execMachine,
  broadcastSync, runClaudeWithStreaming, cleanupExecution,
  discoveredAgents, STARTUP_CWD, buildSystemPrompt,
  parseRateLimitResetTime, touchACP,
  getJsonlWatcher: () => _jsonlWatcher,
  debugLog, logError,
  scheduleRetry, drainMessageQueue, createEventHandler
});

const activeChats = new Map();
const wsRouter = new WsRouter();
registerWsHandlers(wsRouter, { queries, wsOptimizer, broadcastSync, getProviderConfigs, saveProviderConfig, STARTUP_CWD, discoveredAgents, subscriptionIndex, activeChats, getModelsForAgent });


const { wss, hotReloadClients } = createWsSetup(server, {
  BASE_URL, watch, staticDir, _assetCache, htmlState, sendWs, wsRouter, debugLog,
  subscriptionIndex, syncClients, wsOptimizer,
  legacyDeps: {
    subscriptionIndex, execMachine, activeExecutions, messageQueues, queries,
    getSeq: () => ++broadcastSeq, sendWs, debugLog
  }
});

const { killActiveExecutions, recoverStaleSessions, resumeInterruptedStreams, isProcessAlive, markAgentDead, resumeConversation, performAgentHealthCheck } = createRecovery({
  activeExecutions,
  processMessageWithStreaming,
  queries,
  broadcastSync,
  drainMessageQueue,
  stuckThresholdMs: STUCK_AGENT_THRESHOLD_MS,
  noPidGracePeriodMs: NO_PID_GRACE_PERIOD_MS
});

process.on('SIGTERM', () => {
  console.log('[SIGNAL] SIGTERM received - graceful shutdown');
  killActiveExecutions();
  const _jw = getJsonlWatcher(); if (_jw) try { _jw.stop(); } catch (_) {}
  stopACPTools().catch(() => {}).finally(() => {
    try { wss.close(() => server.close(() => process.exit(0))); } catch (_) { process.exit(0); }
    setTimeout(() => process.exit(1), 5000);
  });
});

process.on('SIGINT', () => {
  killActiveExecutions();
  process.exit(0);
});

let _serverReadyFired = false;
const onServerListenStart = () => {
  if (_serverReadyFired) return;
  _serverReadyFired = true;
  onServerReady();
};

let _portRetries = 0;
const MAX_PORT_RETRIES = 5;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    _portRetries++;
    if (_portRetries > MAX_PORT_RETRIES) {
      // Bail instead of retrying forever - an unbounded retry loop leaks a
      // live process that holds no useful port and accumulates on each launch.
      console.error(`Port ${PORT} still in use after ${MAX_PORT_RETRIES} retries; exiting. Free the port or set PORT to a different value.`);
      process.exit(1);
    }
    console.error(`Port ${PORT} already in use. Retry ${_portRetries}/${MAX_PORT_RETRIES} in 3s...`);
    setTimeout(() => { server.listen(PORT, onServerListenStart); }, 3000);
  } else {
    console.error('[SERVER] Error (contained):', err.message);
  }
});

const { performAutoImport } = createAutoImport({ queries, broadcastSync });
const { performDbRecovery } = createDbRecovery({ queries, debugLog });

setInterval(performDbRecovery, 300000);

const { onServerReady, getJsonlWatcher } = createOnServerReady({
  queries, broadcastSync, warmAssetCache, staticDir, discoveredAgents,
  PORT, BASE_URL, watch, setWatcher: (w) => { _jsonlWatcher = w; }, resumeInterruptedStreams, activeExecutions,
  debugLog, installGMAgentConfigs, startACPTools, getACPStatus, execMachine,
  performAutoImport, performAgentHealthCheck, recoverStaleSessions
});

server.listen(PORT, onServerListenStart);
