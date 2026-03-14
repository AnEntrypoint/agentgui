import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import zlib from 'zlib';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { execSync, spawn } from 'child_process';
import { createRequire } from 'module';
const PKG_VERSION = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
import { OAuth2Client } from 'google-auth-library';
import express from 'express';
import Busboy from 'busboy';
import fsbrowse from 'fsbrowse';
import { queries } from './database.js';
import { runClaudeWithStreaming } from './lib/claude-runner.js';
import { initializeDescriptors, getAgentDescriptor } from './lib/agent-descriptors.js';
import { WSOptimizer } from './lib/ws-optimizer.js';
import { WsRouter } from './lib/ws-protocol.js';
import { encode as wsEncode } from './lib/codec.js';
const sendWs = (ws, obj) => { if (ws.readyState === 1) ws.send(wsEncode(obj)); };
import { register as registerConvHandlers } from './lib/ws-handlers-conv.js';
import { register as registerSessionHandlers } from './lib/ws-handlers-session.js';
import { register as registerRunHandlers } from './lib/ws-handlers-run.js';
import { register as registerUtilHandlers } from './lib/ws-handlers-util.js';
import { startAll as startACPTools, stopAll as stopACPTools, getStatus as getACPStatus, getPort as getACPPort, ensureRunning, queryModels as queryACPModels, touch as touchACP } from './lib/acp-sdk-manager.js';
import { installGMAgentConfigs } from './lib/gm-agent-configs.js';
import * as toolManager from './lib/tool-manager.js';
import { pm2Manager } from './lib/pm2-manager.js';
import CheckpointManager from './lib/checkpoint-manager.js';


process.on('uncaughtException', (err, origin) => {
  console.error('[FATAL] Uncaught exception (contained):', err.message, '| origin:', origin);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[FATAL] Unhandled rejection (contained):', reason instanceof Error ? reason.message : reason);
  if (reason instanceof Error) console.error(reason.stack);
});

process.on('SIGINT', () => {
  console.log('[SIGNAL] SIGINT received - graceful shutdown');
  try { pm2Manager.disconnect(); } catch (_) {}
  stopACPTools().catch(() => {}).finally(() => {
    try { wss.close(() => server.close(() => process.exit(0))); } catch (_) { process.exit(0); }
  });
});
process.on('SIGHUP', () => { console.log('[SIGNAL] SIGHUP received (ignored - uncrashable)'); });
process.on('beforeExit', (code) => { console.log('[PROCESS] beforeExit with code:', code); });
process.on('exit', (code) => { console.log('[PROCESS] exit with code:', code); });

const ttsTextAccumulators = new Map();
const voiceCacheManager = {
  generating: new Map(),
  maxCacheSize: 10 * 1024 * 1024,
  async getOrGenerateCache(conversationId, text) {
    const cacheKey = `${conversationId}:${text}`;
    if (this.generating.has(cacheKey)) {
      return new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          const cached = queries.getVoiceCache(conversationId, text);
          if (cached) {
            clearInterval(checkInterval);
            resolve(cached);
          }
        }, 50);
      });
    }
    const cached = queries.getVoiceCache(conversationId, text);
    if (cached) return cached;
    this.generating.set(cacheKey, true);
    try {
      const speech = await getSpeech();
      const audioBlob = await speech.synthesize(text, 'default');
      const saved = queries.saveVoiceCache(conversationId, text, audioBlob);
      const totalSize = queries.getVoiceCacheSize(conversationId);
      if (totalSize > this.maxCacheSize) {
        const needed = totalSize - this.maxCacheSize;
        queries.deleteOldestVoiceCache(conversationId, needed);
      }
      return saved;
    } finally {
      this.generating.delete(cacheKey);
    }
  }
};

let speechModule = null;
async function getSpeech() {
  if (!speechModule) speechModule = await import('./lib/speech.js');
  return speechModule;
}

async function ensurePocketTtsSetup(onProgress) {
  const { createRequire: cr } = await import('module');
  const r = cr(import.meta.url);
  const serverTTS = r('webtalk/server-tts');
  return serverTTS.ensureInstalled(onProgress);
}

// Model download manager
const modelDownloadState = {
  downloading: false,
  progress: null,
  error: null,
  complete: false,
  startTime: null,
  downloadMetrics: new Map()
};

function broadcastModelProgress(progress) {
  modelDownloadState.progress = progress;
  const broadcastData = {
    type: 'model_download_progress',
    modelId: progress.type || 'unknown',
    bytesDownloaded: progress.bytesDownloaded || 0,
    bytesRemaining: progress.bytesRemaining || 0,
    totalBytes: progress.totalBytes || 0,
    downloadSpeed: progress.downloadSpeed || 0,
    eta: progress.eta || 0,
    retryCount: progress.retryCount || 0,
    currentGateway: progress.currentGateway || '',
    status: progress.status || (progress.done ? 'completed' : progress.downloading ? 'downloading' : 'paused'),
    percentComplete: progress.percentComplete || 0,
    completedFiles: progress.completedFiles || 0,
    totalFiles: progress.totalFiles || 0,
    timestamp: Date.now(),
    ...progress
  };
  broadcastSync(broadcastData);
}

async function validateAndCleanupModels(modelsDir) {
  try {
    const manifestPath = path.join(modelsDir, '.manifests.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const content = fs.readFileSync(manifestPath, 'utf8');
        JSON.parse(content);
      } catch (e) {
        console.error('[MODELS] Manifest corrupted, removing:', e.message);
        fs.unlinkSync(manifestPath);
      }
    }

    const files = fs.readdirSync(modelsDir);
    for (const file of files) {
      if (file.endsWith('.tmp')) {
        try {
          fs.unlinkSync(path.join(modelsDir, file));
          console.log('[MODELS] Cleaned up temp file:', file);
        } catch (e) {
          console.warn('[MODELS] Failed to clean:', file);
        }
      }
    }
  } catch (e) {
    console.warn('[MODELS] Cleanup check failed:', e.message);
  }
}

async function ensureModelsDownloaded() {
  if (modelDownloadState.downloading) {
    while (modelDownloadState.downloading) {
      await new Promise(r => setTimeout(r, 100));
    }
    return modelDownloadState.complete;
  }

  modelDownloadState.downloading = true;
  modelDownloadState.error = null;

  try {
    const r = createRequire(import.meta.url);
    const { createConfig } = r('webtalk/config');
    const { ensureModel } = r('webtalk/whisper-models');
    const { ensureTTSModels } = r('webtalk/tts-models');
    const gmguiModels = path.join(os.homedir(), '.gmgui', 'models');
    const modelsBase = process.env.PORTABLE_EXE_DIR
      ? (fs.existsSync(path.join(process.env.PORTABLE_EXE_DIR, 'models', 'onnx-community')) ? path.join(process.env.PORTABLE_EXE_DIR, 'models') : gmguiModels)
      : gmguiModels;

    await validateAndCleanupModels(modelsBase);

    const config = createConfig({
      modelsDir: modelsBase,
      ttsModelsDir: path.join(modelsBase, 'tts'),
    });

    // Progress callback for broadcasting download progress
    const onProgress = (progress) => {
      broadcastModelProgress({
        ...progress,
        started: true,
        done: false,
        downloading: true
      });
    };

    broadcastModelProgress({ started: true, done: false, downloading: true, type: 'whisper', status: 'starting' });
    await ensureModel('onnx-community/whisper-base', config, onProgress);

    broadcastModelProgress({ started: true, done: false, downloading: true, type: 'tts', status: 'starting' });
    await ensureTTSModels(config, onProgress);

    modelDownloadState.complete = true;
    broadcastModelProgress({ started: true, done: true, complete: true, downloading: false });
    return true;
  } catch (err) {
    console.error('[MODELS] Download error:', err.message);
    modelDownloadState.error = err.message;
    broadcastModelProgress({ done: true, error: err.message });
    return false;
  } finally {
    modelDownloadState.downloading = false;
  }
}

function eagerTTS(text, conversationId, sessionId) {
  const key = `${conversationId}:${sessionId}`;
  let acc = ttsTextAccumulators.get(key);
  if (!acc) {
    acc = { text: '', timer: null };
    ttsTextAccumulators.set(key, acc);
  }
  acc.text += text;
  if (acc.timer) clearTimeout(acc.timer);
  acc.timer = setTimeout(() => flushTTSaccumulator(key, conversationId, sessionId), 600);
}

function flushTTSaccumulator(key, conversationId, sessionId) {
  const acc = ttsTextAccumulators.get(key);
  if (!acc || !acc.text) return;
  const text = acc.text.trim();
  acc.text = '';
  ttsTextAccumulators.delete(key);
  
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
    for (const vid of voices) {
      const cacheKey = speech.ttsCacheKey(text, vid);
      const cached = speech.ttsCacheGet(cacheKey);
      if (cached) {
        pushTTSAudio(cacheKey, cached, conversationId, sessionId, vid);
        continue;
      }
      speech.synthesize(text, vid).then(wav => {
        if (speech.ttsCacheSet) speech.ttsCacheSet(cacheKey, wav);
        pushTTSAudio(cacheKey, wav, conversationId, sessionId, vid);
      }).catch(() => {});
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


function buildSystemPrompt(agentId, model, subAgent) {
  const parts = [];
  if (agentId && agentId !== 'claude-code') {
    const displayAgentId = agentId.split('-·-')[0];
    parts.push(`Use ${displayAgentId} subagent for all tasks.`);
  }
  if (model) {
    parts.push(`Model: ${model}.`);
  }
  if (subAgent) {
    parts.push(`Subagent: ${subAgent}.`);
  }
  return parts.join(' ');
}

const activeExecutions = new Map();
const activeScripts = new Map();
const messageQueues = new Map();
const rateLimitState = new Map();
const activeProcessesByRunId = new Map();
const activeProcessesByConvId = new Map(); // Store process handles by conversationId for steering
const steeringTimeouts = new Map(); // Track timeout handles for process cleanup
const checkpointManager = new CheckpointManager(queries);
const STUCK_AGENT_THRESHOLD_MS = 600000;
const NO_PID_GRACE_PERIOD_MS = 60000;
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60000;

const debugLog = (msg) => {
  const timestamp = new Date().toISOString();
  console.error(`[${timestamp}] ${msg}`);
};

// Atomic cleanup function - ensures consistent state across all data structures
function cleanupExecution(conversationId, broadcastCompletion = false) {
  debugLog(`[cleanup] Starting cleanup for ${conversationId}`);

  // Clean in-memory maps in atomic block
  activeExecutions.delete(conversationId);
  const proc = activeProcessesByConvId.get(conversationId);
  activeProcessesByConvId.delete(conversationId);

  // Cancel steering timeout if present
  const steeringTimeout = steeringTimeouts.get(conversationId);
  if (steeringTimeout) {
    clearTimeout(steeringTimeout);
    steeringTimeouts.delete(conversationId);
  }

  // Try to kill process if still alive
  if (proc) {
    try {
      if (proc.kill) proc.kill('SIGTERM');
    } catch (e) {
      debugLog(`[cleanup] Error killing process: ${e.message}`);
    }
  }

  // Clean database state
  queries.setIsStreaming(conversationId, false);

  if (broadcastCompletion) {
    broadcastSync({
      type: 'execution_cleaned_up',
      conversationId,
      timestamp: Date.now()
    });
  }

  debugLog(`[cleanup] Cleanup complete for ${conversationId}`);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = process.env.PORTABLE_EXE_DIR || __dirname;
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || '/gm').replace(/\/+$/, '');
const watch = process.argv.includes('--no-watch') ? false : (process.argv.includes('--watch') || process.env.HOT_RELOAD !== 'false');

const STARTUP_CWD = process.env.STARTUP_CWD || process.cwd();
const staticDir = path.join(rootDir, 'static');
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

// Cache fsbrowse routers per conversation to ensure API calls work
const fsbrowseRouters = new Map();

// fsbrowse file browser - mounted per conversation workingDirectory
// Route: /gm/files/:conversationId/*
expressApp.use(BASE_URL + '/files/:conversationId', (req, res, next) => {
  const convId = req.params.conversationId;
  const conv = queries.getConversation(convId);
  if (!conv || !conv.workingDirectory) {
    return res.status(404).json({ error: 'Conversation not found or no working directory' });
  }

  // Normalize the working directory path to avoid Windows path duplication issues
  const normalizedWorkingDir = path.resolve(conv.workingDirectory);

  // Get or create cached fsbrowse router for this conversation
  let router = fsbrowseRouters.get(convId);
  if (!router) {
    router = fsbrowse({ baseDir: normalizedWorkingDir, name: 'Files' });
    fsbrowseRouters.set(convId, router);
  }

  // Set baseUrl before calling the router
  req.baseUrl = BASE_URL + '/files/' + convId;
  req.url = req.url.replace(new RegExp(`^${BASE_URL}/files/${convId}`), '');

  router(req, res, next);
});

function findCommand(cmd) {
  const isWindows = os.platform() === 'win32';
  const localBin = path.join(path.dirname(fileURLToPath(import.meta.url)), 'node_modules', '.bin', isWindows ? cmd + '.cmd' : cmd);
  if (fs.existsSync(localBin)) {
    console.log(`[agent-discovery] Found ${cmd} in local node_modules`);
    return localBin;
  }
  try {
    // Increase timeout to 10 seconds to handle slower systems and running agents
    const timeoutMs = 10000;
    if (isWindows) {
      const result = execSync(`where ${cmd}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], timeout: timeoutMs }).trim();
      if (result) {
        console.log(`[agent-discovery] Found ${cmd} in PATH`);
        return result.split('\n')[0].trim();
      }
    } else {
      const result = execSync(`which ${cmd}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], timeout: timeoutMs }).trim();
      if (result) {
        console.log(`[agent-discovery] Found ${cmd} in PATH`);
        return result;
      }
    }
  } catch (err) {
    console.log(`[agent-discovery] ${cmd} not found or timed out`);
    return null;
  }
  return null;
}

async function queryACPServerAgents(baseUrl) {
  const endpoint = baseUrl.endsWith('/') ? baseUrl + 'agents/search' : baseUrl + '/agents/search';
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) {
      console.error(`Failed to query ACP agents from ${baseUrl}: ${response.status}`);
      return [];
    }
    const data = await response.json();
    if (!data?.agents || !Array.isArray(data.agents)) {
      console.error(`Invalid agents response from ${baseUrl}`);
      return [];
    }
    return data.agents.map(agent => ({
      id: agent.agent_id || agent.id,
      name: agent.metadata?.ref?.name || agent.name || 'Unknown Agent',
      metadata: {
        ref: {
          name: agent.metadata?.ref?.name,
          version: agent.metadata?.ref?.version,
          url: agent.metadata?.ref?.url,
          tags: agent.metadata?.ref?.tags
        },
        description: agent.metadata?.description,
        author: agent.metadata?.author,
        license: agent.metadata?.license
      },
      specs: agent.specs ? {
        capabilities: agent.specs.capabilities,
        input_schema: agent.specs.input_schema || agent.specs.input,
        output_schema: agent.specs.output_schema || agent.specs.output,
        thread_state_schema: agent.specs.thread_state_schema || agent.specs.thread_state,
        config_schema: agent.specs.config_schema || agent.specs.config,
        custom_streaming_update_schema: agent.specs.custom_streaming_update_schema || agent.specs.custom_streaming_update
      } : null,
      custom_data: agent.custom_data,
      icon: agent.metadata?.ref?.name?.charAt(0) || 'A',
      protocol: 'acp',
      path: baseUrl
    }));
  } catch (error) {
    console.error(`ACP agents query failed for ${baseUrl}: ${error.message}`);
    return [];
  }
}

function discoverAgents() {
  const agents = [];
  const binaries = [
    { cmd: 'claude', id: 'claude-code', name: 'Claude Code', icon: 'C', protocol: 'cli' },
    { cmd: 'opencode', id: 'opencode', name: 'OpenCode', icon: 'O', protocol: 'acp', npxPackage: 'opencode-ai' },
    { cmd: 'gemini', id: 'gemini', name: 'Gemini CLI', icon: 'G', protocol: 'acp', npxPackage: '@google/gemini-cli' },
    { cmd: 'kilo', id: 'kilo', name: 'Kilo Code', icon: 'K', protocol: 'acp', npxPackage: '@kilocode/cli' },
    { cmd: 'goose', id: 'goose', name: 'Goose', icon: 'g', protocol: 'acp' },
    { cmd: 'openhands', id: 'openhands', name: 'OpenHands', icon: 'H', protocol: 'acp' },
    { cmd: 'augment', id: 'augment', name: 'Augment Code', icon: 'A', protocol: 'acp' },
    { cmd: 'cline', id: 'cline', name: 'Cline', icon: 'c', protocol: 'acp' },
    { cmd: 'kimi', id: 'kimi', name: 'Kimi CLI', icon: 'K', protocol: 'acp' },
    { cmd: 'qwen-code', id: 'qwen', name: 'Qwen Code', icon: 'Q', protocol: 'acp' },
    { cmd: 'codex', id: 'codex', name: 'Codex CLI', icon: 'X', protocol: 'acp', npxPackage: '@openai/codex' },
    { cmd: 'mistral-vibe', id: 'mistral', name: 'Mistral Vibe', icon: 'M', protocol: 'acp' },
    { cmd: 'kiro', id: 'kiro', name: 'Kiro CLI', icon: 'k', protocol: 'acp' },
    { cmd: 'fast-agent', id: 'fast-agent', name: 'fast-agent', icon: 'F', protocol: 'acp' },
  ];
  for (const bin of binaries) {
    const result = findCommand(bin.cmd);
    if (result) {
      agents.push({ id: bin.id, name: bin.name, icon: bin.icon, path: result, protocol: bin.protocol });
    } else if (bin.npxPackage) {
      // For npx-launchable packages (including claude-code as fallback)
      agents.push({ id: bin.id, name: bin.name, icon: bin.icon, path: null, protocol: bin.protocol, npxPackage: bin.npxPackage, npxLaunchable: true });
    } else if (bin.id === 'claude-code') {
      // Ensure Claude Code is always available as an npx-launchable agent
      agents.push({ id: bin.id, name: bin.name, icon: bin.icon, path: null, protocol: bin.protocol, npxPackage: '@anthropic-ai/claude-code', npxLaunchable: true });
    }
  }

  // Add CLI tool wrappers for ACP agents (these map CLI commands to plugin sub-agents)
  // These allow users to select "OpenCode", "Gemini", etc. and then pick a model/variant
  const cliWrappers = [
    { id: 'cli-opencode', name: 'OpenCode', icon: 'O', protocol: 'cli-wrapper', acpId: 'opencode' },
    { id: 'cli-gemini', name: 'Gemini', icon: 'G', protocol: 'cli-wrapper', acpId: 'gemini' },
    { id: 'cli-kilo', name: 'Kilo', icon: 'K', protocol: 'cli-wrapper', acpId: 'kilo' },
    { id: 'cli-codex', name: 'Codex', icon: 'X', protocol: 'cli-wrapper', acpId: 'codex' },
  ];

  // Only add CLI wrappers for agents that are already discovered
  console.log('[discoverAgents] Found agents:', agents.map(a => a.id).join(', '));
  for (const wrapper of cliWrappers) {
    if (agents.some(a => a.id === wrapper.acpId)) {
      console.log(`[discoverAgents] Adding CLI wrapper for ${wrapper.id}`);
      agents.push(wrapper);
      console.log(`[discoverAgents] After push, agents.length = ${agents.length}, includes ${wrapper.id}? ${agents.some(a => a.id === wrapper.id)}`);
    } else {
      console.log(`[discoverAgents] Skipping CLI wrapper ${wrapper.id} (ACP agent ${wrapper.acpId} not found)`);
    }
  }
  // Remove raw ACP agents that have a cli-wrapper (avoid duplicates in UI)
  const wrappedAcpIds = new Set(cliWrappers.filter(w => agents.some(a => a.id === w.acpId)).map(w => w.acpId));
  const filtered = agents.filter(a => !wrappedAcpIds.has(a.id));
  console.log('[discoverAgents] Final agent count:', filtered.length, 'Agent IDs:', filtered.map(a => a.id).join(', '));

  return filtered;
}

// Function to discover agents from external ACP servers
async function discoverExternalACPServers() {
  const externalAgents = [];
  for (const agent of discoveredAgents.filter(a => a.protocol === 'acp' && a.acpPort)) {
    try {
      const agents = await queryACPServerAgents(`http://localhost:${agent.acpPort}`);
      externalAgents.push(...agents);
    } catch (_) {}
  }
  return externalAgents;
}

let discoveredAgents = [];
initializeDescriptors(discoveredAgents);

// Agent discovery happens asynchronously in background to not block startup
async function initializeAgentDiscovery() {
  try {
    const agents = discoverAgents();
    // Mutate the existing array instead of reassigning to preserve closure references in handlers
    discoveredAgents.length = 0;
    discoveredAgents.push(...agents);
    initializeDescriptors(discoveredAgents);
    console.log('[AGENTS] Discovered:', discoveredAgents.map(a => ({ id: a.id, found: !!a.path, protocol: a.protocol })));
    console.log('[AGENTS] Total count:', discoveredAgents.length);
  } catch (err) {
    console.error('[AGENTS] Discovery error:', err.message);
  }
}

// Start immediately but don't wait for it
const startTime = Date.now();
initializeAgentDiscovery().then(() => {
  console.log('[INIT] initializeAgentDiscovery completed in', Date.now() - startTime, 'ms');
}).catch(() => {});

const modelCache = new Map();

async function getModelsForAgent(agentId) {
  const cached = modelCache.get(agentId);
  if (cached && Date.now() - cached.timestamp < 300000) return cached.models;
  let models = [];
  if (agentId === 'claude-code') {
    models = [
      { id: 'haiku', label: 'Haiku' },
      { id: 'sonnet', label: 'Sonnet' },
      { id: 'opus', label: 'Opus' }
    ];
  } else {
    const agent = discoveredAgents.find(a => a.id === agentId);
    if (agent?.protocol === 'acp') {
      await ensureRunning(agentId);
      try { models = await queryACPModels(agentId); } catch (_) {}
    }
  }
  modelCache.set(agentId, { models, timestamp: Date.now() });
  return models;
}

const GEMINI_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

function extractOAuthFromFile(oauth2Path) {
  try {
    const src = fs.readFileSync(oauth2Path, 'utf8');
    const idMatch = src.match(/OAUTH_CLIENT_ID\s*=\s*['"]([^'"]+)['"]/);
    const secretMatch = src.match(/OAUTH_CLIENT_SECRET\s*=\s*['"]([^'"]+)['"]/);
    if (idMatch && secretMatch) return { clientId: idMatch[1], clientSecret: secretMatch[1] };
  } catch {}
  return null;
}

function getGeminiOAuthCreds() {
  if (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET) {
    return { clientId: process.env.GOOGLE_OAUTH_CLIENT_ID, clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET, custom: true };
  }
  const oauthRelPath = path.join('node_modules', '@google', 'gemini-cli-core', 'dist', 'src', 'code_assist', 'oauth2.js');
  try {
    const geminiPath = findCommand('gemini');
    if (geminiPath) {
      const realPath = fs.realpathSync(geminiPath);
      const pkgRoot = path.resolve(path.dirname(realPath), '..');
      const result = extractOAuthFromFile(path.join(pkgRoot, oauthRelPath));
      if (result) return result;
    }
  } catch (e) {
    console.error('[gemini-oauth] gemini lookup failed:', e.message);
  }
  try {
    const npmCacheDirs = new Set();
    const addDir = (d) => { if (d) npmCacheDirs.add(path.join(d, '_npx')); };
    addDir(path.join(os.homedir(), '.npm'));
    addDir(path.join(os.homedir(), '.cache', '.npm'));
    if (process.env.NPM_CACHE) addDir(process.env.NPM_CACHE);
    if (process.env.npm_config_cache) addDir(process.env.npm_config_cache);
    try { addDir(execSync('npm config get cache', { encoding: 'utf8', timeout: 5000 }).trim()); } catch {}
    for (const cacheDir of npmCacheDirs) {
      if (!fs.existsSync(cacheDir)) continue;
      for (const d of fs.readdirSync(cacheDir).filter(d => !d.startsWith('.'))) {
        const result = extractOAuthFromFile(path.join(cacheDir, d, oauthRelPath));
        if (result) return result;
      }
    }
  } catch (e) {
    console.error('[gemini-oauth] npm cache scan failed:', e.message);
  }
  console.error('[gemini-oauth] Could not find Gemini CLI OAuth credentials in any known location');
  return null;
}
const GEMINI_DIR = path.join(os.homedir(), '.gemini');
const GEMINI_OAUTH_FILE = path.join(GEMINI_DIR, 'oauth_creds.json');
const GEMINI_ACCOUNTS_FILE = path.join(GEMINI_DIR, 'google_accounts.json');

let geminiOAuthState = { status: 'idle', error: null, email: null };
let geminiOAuthPending = null;

function buildBaseUrl(req) {
  const override = process.env.AGENTGUI_BASE_URL;
  if (override) return override.replace(/\/+$/, '');
  const fwdProto = req.headers['x-forwarded-proto'];
  const fwdHost = req.headers['x-forwarded-host'] || req.headers['host'];
  if (fwdHost) {
    const proto = fwdProto || (req.socket.encrypted ? 'https' : 'http');
    const cleanHost = fwdHost.replace(/:443$/, '').replace(/:80$/, '');
    return `${proto}://${cleanHost}`;
  }
  return `http://127.0.0.1:${PORT}`;
}

function saveGeminiCredentials(tokens, email) {
  if (!fs.existsSync(GEMINI_DIR)) fs.mkdirSync(GEMINI_DIR, { recursive: true });
  fs.writeFileSync(GEMINI_OAUTH_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  try { fs.chmodSync(GEMINI_OAUTH_FILE, 0o600); } catch (_) {}

  let accounts = { active: null, old: [] };
  try {
    if (fs.existsSync(GEMINI_ACCOUNTS_FILE)) {
      accounts = JSON.parse(fs.readFileSync(GEMINI_ACCOUNTS_FILE, 'utf8'));
    }
  } catch (_) {}

  if (email) {
    if (accounts.active && accounts.active !== email && !accounts.old.includes(accounts.active)) {
      accounts.old.push(accounts.active);
    }
    accounts.active = email;
  }
  fs.writeFileSync(GEMINI_ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), { mode: 0o600 });
}

function geminiOAuthResultPage(title, message, success) {
  const color = success ? '#10b981' : '#ef4444';
  const icon = success ? '&#10003;' : '&#10007;';
  return `<!DOCTYPE html><html><head><title>${title}</title></head>
<body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#111827;font-family:system-ui,sans-serif;color:white;">
<div style="text-align:center;max-width:400px;padding:2rem;">
<div style="font-size:4rem;color:${color};margin-bottom:1rem;">${icon}</div>
<h1 style="font-size:1.5rem;margin-bottom:0.5rem;">${title}</h1>
<p style="color:#9ca3af;">${message}</p>
<p style="color:#6b7280;margin-top:1rem;font-size:0.875rem;">You can close this tab.</p>
</div></body></html>`;
}

function encodeOAuthState(csrfToken, relayUrl) {
  const payload = JSON.stringify({ t: csrfToken, r: relayUrl });
  return Buffer.from(payload).toString('base64url');
}

function decodeOAuthState(stateStr) {
  try {
    const payload = JSON.parse(Buffer.from(stateStr, 'base64url').toString());
    return { csrfToken: payload.t, relayUrl: payload.r };
  } catch (_) {
    return { csrfToken: stateStr, relayUrl: null };
  }
}

function geminiOAuthRelayPage(code, state, error) {
  const stateData = decodeOAuthState(state || '');
  const relayUrl = stateData.relayUrl || '';
  const escapedCode = (code || '').replace(/['"\\]/g, '');
  const escapedState = (state || '').replace(/['"\\]/g, '');
  const escapedError = (error || '').replace(/['"\\]/g, '');
  const escapedRelay = relayUrl.replace(/['"\\]/g, '');
  return `<!DOCTYPE html><html><head><title>Completing sign-in...</title></head>
<body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#111827;font-family:system-ui,sans-serif;color:white;">
<div id="status" style="text-align:center;max-width:400px;padding:2rem;">
<div id="spinner" style="font-size:2rem;margin-bottom:1rem;">&#8987;</div>
<h1 id="title" style="font-size:1.5rem;margin-bottom:0.5rem;">Completing sign-in...</h1>
<p id="msg" style="color:#9ca3af;">Relaying authentication to server...</p>
</div>
<script>
(function() {
  var code = '${escapedCode}';
  var state = '${escapedState}';
  var error = '${escapedError}';
  var relayUrl = '${escapedRelay}';
  function show(icon, title, msg, color) {
    document.getElementById('spinner').textContent = icon;
    document.getElementById('spinner').style.color = color;
    document.getElementById('title').textContent = title;
    document.getElementById('msg').textContent = msg;
  }
  if (error) { show('\\u2717', 'Authentication Failed', error, '#ef4444'); return; }
  if (!code) { show('\\u2717', 'Authentication Failed', 'No authorization code received.', '#ef4444'); return; }
  if (!relayUrl) { show('\\u2713', 'Authentication Successful', 'Credentials saved. You can close this tab.', '#10b981'); return; }
  fetch(relayUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code, state: state })
  }).then(function(r) { return r.json(); }).then(function(data) {
    if (data.success) {
      show('\\u2713', 'Authentication Successful', data.email ? 'Signed in as ' + data.email + '. You can close this tab.' : 'Credentials saved. You can close this tab.', '#10b981');
    } else {
      show('\\u2717', 'Authentication Failed', data.error || 'Unknown error', '#ef4444');
    }
  }).catch(function(e) {
    show('\\u2717', 'Relay Failed', 'Could not reach server: ' + e.message + '. You may need to paste the URL manually.', '#ef4444');
  });
})();
</script>
</body></html>`;
}

function isRemoteRequest(req) {
  return !!(req && (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers['x-forwarded-proto']));
}

async function startGeminiOAuth(req) {
  const creds = getGeminiOAuthCreds();
  if (!creds) throw new Error('Could not find Gemini CLI OAuth credentials. Install gemini CLI first.');

  const useCustomClient = !!creds.custom;
  const remote = isRemoteRequest(req);
  let redirectUri;
  if (useCustomClient && req) {
    redirectUri = `${buildBaseUrl(req)}${BASE_URL}/oauth2callback`;
  } else {
    redirectUri = `http://localhost:${PORT}${BASE_URL}/oauth2callback`;
  }

  const csrfToken = crypto.randomBytes(32).toString('hex');
  const relayUrl = req ? `${buildBaseUrl(req)}${BASE_URL}/api/gemini-oauth/relay` : null;
  const state = encodeOAuthState(csrfToken, relayUrl);

  const client = new OAuth2Client({
    clientId: creds.clientId,
    clientSecret: creds.clientSecret,
  });

  const authUrl = client.generateAuthUrl({
    redirect_uri: redirectUri,
    access_type: 'offline',
    scope: GEMINI_SCOPES,
    state,
  });

  const mode = useCustomClient ? 'custom' : (remote ? 'cli-remote' : 'cli-local');
  geminiOAuthPending = { client, redirectUri, state: csrfToken };
  geminiOAuthState = { status: 'pending', error: null, email: null };

  setTimeout(() => {
    if (geminiOAuthState.status === 'pending') {
      geminiOAuthState = { status: 'error', error: 'Authentication timed out', email: null };
      geminiOAuthPending = null;
    }
  }, 5 * 60 * 1000);

  return { authUrl, mode };
}

async function exchangeGeminiOAuthCode(code, stateParam) {
  if (!geminiOAuthPending) throw new Error('No pending OAuth flow. Please start authentication again.');

  const { client, redirectUri, state: expectedCsrf } = geminiOAuthPending;
  const { csrfToken } = decodeOAuthState(stateParam);

  if (csrfToken !== expectedCsrf) {
    geminiOAuthState = { status: 'error', error: 'State mismatch', email: null };
    geminiOAuthPending = null;
    throw new Error('State mismatch - possible CSRF attack.');
  }

  if (!code) {
    geminiOAuthState = { status: 'error', error: 'No authorization code received', email: null };
    geminiOAuthPending = null;
    throw new Error('No authorization code received.');
  }

  const { tokens } = await client.getToken({ code, redirect_uri: redirectUri });
  client.setCredentials(tokens);

  let email = '';
  try {
    const { token } = await client.getAccessToken();
    if (token) {
      const resp = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (resp.ok) {
        const info = await resp.json();
        email = info.email || '';
      }
    }
  } catch (_) {}

  saveGeminiCredentials(tokens, email);
  geminiOAuthState = { status: 'success', error: null, email };
  geminiOAuthPending = null;

  return email;
}

async function handleGeminiOAuthCallback(req, res) {
  const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
  const code = reqUrl.searchParams.get('code');
  const state = reqUrl.searchParams.get('state');
  const error = reqUrl.searchParams.get('error');
  const errorDesc = reqUrl.searchParams.get('error_description');

  if (error) {
    const desc = errorDesc || error;
    geminiOAuthState = { status: 'error', error: desc, email: null };
    geminiOAuthPending = null;
  }

  const stateData = decodeOAuthState(state || '');
  if (stateData.relayUrl) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(geminiOAuthRelayPage(code, state, errorDesc || error));
    return;
  }

  if (!geminiOAuthPending) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(geminiOAuthResultPage('Authentication Failed', 'No pending OAuth flow.', false));
    return;
  }

  try {
    if (error) throw new Error(errorDesc || error);
    const email = await exchangeGeminiOAuthCode(code, state);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(geminiOAuthResultPage('Authentication Successful', email ? `Signed in as ${email}` : 'Gemini CLI credentials saved.', true));
  } catch (e) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(geminiOAuthResultPage('Authentication Failed', e.message, false));
  }
}

function getGeminiOAuthStatus() {
  try {
    if (fs.existsSync(GEMINI_OAUTH_FILE)) {
      const creds = JSON.parse(fs.readFileSync(GEMINI_OAUTH_FILE, 'utf8'));
      if (creds.refresh_token || creds.access_token) {
        let email = '';
        try {
          if (fs.existsSync(GEMINI_ACCOUNTS_FILE)) {
            const accts = JSON.parse(fs.readFileSync(GEMINI_ACCOUNTS_FILE, 'utf8'));
            email = accts.active || '';
          }
        } catch (_) {}
        return { hasKey: true, apiKey: email || '****oauth', defaultModel: '', path: GEMINI_OAUTH_FILE, authMethod: 'oauth' };
      }
    }
  } catch (_) {}
  return null;
}

const PROVIDER_CONFIGS = {
  'anthropic': {
    name: 'Anthropic', configPaths: [
      path.join(os.homedir(), '.claude.json'),
      path.join(os.homedir(), '.config', 'claude', 'settings.json'),
      path.join(os.homedir(), '.anthropic.json')
    ],
    configFormat: (apiKey, model) => ({ api_key: apiKey, default_model: model })
  },
  'openai': {
    name: 'OpenAI', configPaths: [
      path.join(os.homedir(), '.openai.json'),
      path.join(os.homedir(), '.config', 'openai', 'api-key')
    ],
    configFormat: (apiKey, model) => ({ apiKey, defaultModel: model })
  },
  'google': {
    name: 'Google Gemini', configPaths: [
      path.join(os.homedir(), '.gemini.json'),
      path.join(os.homedir(), '.config', 'gemini', 'credentials.json')
    ],
    configFormat: (apiKey, model) => ({ api_key: apiKey, default_model: model })
  },
  'openrouter': {
    name: 'OpenRouter', configPaths: [
      path.join(os.homedir(), '.openrouter.json'),
      path.join(os.homedir(), '.config', 'openrouter', 'config.json')
    ],
    configFormat: (apiKey, model) => ({ api_key: apiKey, default_model: model })
  },
  'github': {
    name: 'GitHub Models', configPaths: [
      path.join(os.homedir(), '.github.json'),
      path.join(os.homedir(), '.config', 'github-copilot.json')
    ],
    configFormat: (apiKey, model) => ({ github_token: apiKey, default_model: model })
  },
  'azure': {
    name: 'Azure OpenAI', configPaths: [
      path.join(os.homedir(), '.azure.json'),
      path.join(os.homedir(), '.config', 'azure-openai', 'config.json')
    ],
    configFormat: (apiKey, model) => ({ api_key: apiKey, endpoint: '', default_model: model })
  },
  'anthropic-claude-code': {
    name: 'Claude Code Max', configPaths: [
      path.join(os.homedir(), '.claude', 'max.json'),
      path.join(os.homedir(), '.config', 'claude-code', 'max.json')
    ],
    configFormat: (apiKey, model) => ({ api_key: apiKey, plan: 'max', default_model: model })
  },
  'opencode': {
    name: 'OpenCode', configPaths: [
      path.join(os.homedir(), '.opencode', 'config.json'),
      path.join(os.homedir(), '.config', 'opencode', 'config.json')
    ],
    configFormat: (apiKey, model) => ({ api_key: apiKey, default_model: model, providers: ['anthropic', 'openai', 'google'] })
  },
  'proxypilot': {
    name: 'ProxyPilot', configPaths: [
      path.join(os.homedir(), '.proxypilot', 'config.json'),
      path.join(os.homedir(), '.config', 'proxypilot', 'config.json')
    ],
    configFormat: (apiKey, model) => ({ api_key: apiKey, default_model: model })
  },
  'codex': {
    name: 'Codex CLI', configPaths: [
      path.join(os.homedir(), '.codex', 'auth.json')
    ],
    configFormat: (apiKey) => ({ auth_mode: 'apikey', OPENAI_API_KEY: apiKey })
  }
};

function maskKey(key) {
  if (!key || key.length < 8) return '****';
  return '****' + key.slice(-4);
}

function getProviderConfigs() {
  const configs = {};
  for (const [providerId, config] of Object.entries(PROVIDER_CONFIGS)) {
    if (providerId === 'google') {
      const oauthStatus = getGeminiOAuthStatus();
      if (oauthStatus) {
        configs[providerId] = { name: config.name, ...oauthStatus };
        continue;
      }
    }
    for (const configPath of config.configPaths) {
      try {
        if (fs.existsSync(configPath)) {
          const content = fs.readFileSync(configPath, 'utf8');
          const parsed = JSON.parse(content);
          const rawKey = parsed.api_key || parsed.apiKey || parsed.github_token || parsed.OPENAI_API_KEY || '';
          configs[providerId] = {
            name: config.name,
            apiKey: maskKey(rawKey),
            hasKey: !!rawKey,
            defaultModel: parsed.default_model || parsed.defaultModel || '',
            path: configPath
          };
          break;
        }
      } catch (_) {}
    }
    if (!configs[providerId]) {
      configs[providerId] = { name: config.name, apiKey: '', hasKey: false, defaultModel: '', path: '' };
    }
  }
  return configs;
}

function saveProviderConfig(providerId, apiKey, defaultModel) {
  const config = PROVIDER_CONFIGS[providerId];
  if (!config) throw new Error('Unknown provider: ' + providerId);
  const configPath = config.configPaths[0];
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  let existing = {};
  try {
    if (fs.existsSync(configPath)) existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (_) {}
  const merged = { ...existing, ...config.configFormat(apiKey, defaultModel) };
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
  return configPath;
}

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
  const isHtml = contentType && contentType.includes('text/html');
  const baseHeaders = { 'Content-Type': contentType };
  if (isHtml) baseHeaders['Cache-Control'] = 'no-store';
  if (raw.length < 860) {
    res.writeHead(statusCode, { ...baseHeaders, 'Content-Length': raw.length });
    res.end(raw);
    return;
  }
  if (acceptsEncoding(req, 'gzip')) {
    const compressed = zlib.gzipSync(raw, { level: 6 });
    res.writeHead(statusCode, { ...baseHeaders, 'Content-Encoding': 'gzip', 'Content-Length': compressed.length });
    res.end(compressed);
  } else {
    res.writeHead(statusCode, { ...baseHeaders, 'Content-Length': raw.length });
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
  if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') return;

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

  // Handle requests with or without BASE_URL prefix (for reverse proxy compatibility)
  let routePath = req.url;
  if (req.url.startsWith(BASE_URL + '/')) {
    routePath = req.url.slice(BASE_URL.length);
  } else if (req.url === BASE_URL) {
    routePath = '/';
  } else if (req.url.startsWith('/api/') || req.url.startsWith('/js/') || req.url.startsWith('/css/') ||
             req.url.startsWith('/vendor/') || req.url.startsWith('/sync') || req.url === '/' ||
             req.url.startsWith('/conversations/')) {
    // Allow requests without BASE_URL prefix for static files and known routes
    // This supports reverse proxies that strip the BASE_URL prefix
    routePath = req.url;
  } else {
    res.writeHead(404); res.end('Not found'); return;
  }

  routePath = routePath || '/';

  try {
    // Remove query parameters from routePath for matching
    const pathOnly = routePath.split('?')[0];

    if (pathOnly === '/oauth2callback' && req.method === 'GET') {
      await handleGeminiOAuthCallback(req, res);
      return;
    }

    if (pathOnly === '/api/conversations' && req.method === 'GET') {
      const conversations = queries.getConversationsList();
      // Filter out stale streaming state using a single bulk query instead of N+1 per-conversation queries
      const activeSessionConvIds = new Set(queries.getActiveSessionConversationIds());
      for (const conv of conversations) {
        if (conv.isStreaming && !activeExecutions.has(conv.id) && !activeSessionConvIds.has(conv.id)) {
          conv.isStreaming = 0;
        }
      }
            sendJSON(req, res, 200, { conversations });
      return;
    }

    if (pathOnly === '/api/conversations' && req.method === 'POST') {
      const body = await parseBody(req);
      // Normalize working directory to avoid Windows path issues; expand ~ to home
      const expandTilde = p => p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
      const normalizedWorkingDir = body.workingDirectory ? path.resolve(expandTilde(body.workingDirectory)) : null;
      const conversation = queries.createConversation(body.agentId, body.title, normalizedWorkingDir, body.model || null);
      queries.createEvent('conversation.created', { agentId: body.agentId, workingDirectory: conversation.workingDirectory, model: conversation.model }, conversation.id);
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
        // Normalize working directory if present to avoid Windows path issues; expand ~ to home
        if (body.workingDirectory) {
          const expandTilde = p => p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
          body.workingDirectory = path.resolve(expandTilde(body.workingDirectory));
        }
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
        const model = body.model || conv.model || null;
        const subAgent = body.subAgent || conv.subAgent || null;
        const idempotencyKey = body.idempotencyKey || null;
        const message = queries.createMessage(conversationId, 'user', body.content, idempotencyKey);
        queries.createEvent('message.created', { role: 'user', messageId: message.id }, conversationId);
        broadcastSync({ type: 'message_created', conversationId, message, timestamp: Date.now() });

        if (activeExecutions.has(conversationId)) {
          if (!messageQueues.has(conversationId)) messageQueues.set(conversationId, []);
          messageQueues.get(conversationId).push({ content: body.content, agentId, model, messageId: message.id, subAgent });
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

        processMessageWithStreaming(conversationId, message.id, session.id, body.content, agentId, model, subAgent)
          .catch(err => {
            console.error(`[messages] Uncaught error for conv ${conversationId}:`, err.message);
            debugLog(`[messages] Uncaught error: ${err.message}`);
          });
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
      const model = body.model || conv.model || null;
      const subAgent = body.subAgent || conv.subAgent || null;

      const userMessage = queries.createMessage(conversationId, 'user', prompt);
      queries.createEvent('message.created', { role: 'user', messageId: userMessage.id }, conversationId);

      broadcastSync({ type: 'message_created', conversationId, message: userMessage, timestamp: Date.now() });

      if (activeExecutions.has(conversationId)) {
        debugLog(`[stream] Conversation ${conversationId} is busy, queuing message`);
        if (!messageQueues.has(conversationId)) messageQueues.set(conversationId, []);
        messageQueues.get(conversationId).push({ content: prompt, agentId, model, messageId: userMessage.id, subAgent });

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

      processMessageWithStreaming(conversationId, userMessage.id, session.id, prompt, agentId, model, subAgent)
        .catch(err => debugLog(`[stream] Uncaught error: ${err.message}`));
      return;
    }

    const queueMatch = pathOnly.match(/^\/api\/conversations\/([^/]+)\/queue$/);
    if (queueMatch && req.method === 'GET') {
      const conversationId = queueMatch[1];
      const conv = queries.getConversation(conversationId);
      if (!conv) { sendJSON(req, res, 404, { error: 'Conversation not found' }); return; }
      const queue = messageQueues.get(conversationId) || [];
      sendJSON(req, res, 200, { queue });
      return;
    }

    const queueItemMatch = pathOnly.match(/^\/api\/conversations\/([^/]+)\/queue\/([^/]+)$/);
    if (queueItemMatch && req.method === 'DELETE') {
      const conversationId = queueItemMatch[1];
      const messageId = queueItemMatch[2];
      const queue = messageQueues.get(conversationId);
      if (!queue) { sendJSON(req, res, 404, { error: 'Queue not found' }); return; }
      const index = queue.findIndex(q => q.messageId === messageId);
      if (index === -1) { sendJSON(req, res, 404, { error: 'Queued message not found' }); return; }
      queue.splice(index, 1);
      if (queue.length === 0) messageQueues.delete(conversationId);
      broadcastSync({ type: 'queue_status', conversationId, queueLength: queue?.length || 0, timestamp: Date.now() });
      sendJSON(req, res, 200, { deleted: true });
      return;
    }

    if (queueItemMatch && req.method === 'PATCH') {
      const conversationId = queueItemMatch[1];
      const messageId = queueItemMatch[2];
      const body = await parseBody(req);
      const queue = messageQueues.get(conversationId);
      if (!queue) { sendJSON(req, res, 404, { error: 'Queue not found' }); return; }
      const item = queue.find(q => q.messageId === messageId);
      if (!item) { sendJSON(req, res, 404, { error: 'Queued message not found' }); return; }
      if (body.content !== undefined) item.content = body.content;
      if (body.agentId !== undefined) item.agentId = body.agentId;
      broadcastSync({ type: 'queue_updated', conversationId, messageId, content: item.content, agentId: item.agentId, timestamp: Date.now() });
      sendJSON(req, res, 200, { updated: true, item });
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
      const sinceSeq = parseInt(url.searchParams.get('sinceSeq') || '-1');
      const since = parseInt(url.searchParams.get('since') || '0');

      let chunks;
      if (sinceSeq >= 0) {
        chunks = queries.getChunksSinceSeq(sessionId, sinceSeq);
      } else {
        chunks = queries.getChunksSince(sessionId, since);
      }
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

    const runsMatch = pathOnly.match(/^\/api\/runs$/);
    if (runsMatch && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) { body += chunk; }
      let parsed = {};
      try { parsed = body ? JSON.parse(body) : {}; } catch {}

      const { input, agentId, webhook } = parsed;
      if (!input) {
        sendJSON(req, res, 400, { error: 'Missing input in request body' });
        return;
      }

      const resolvedAgentId = agentId || 'claude-code';
      const resolvedModel = parsed.model || null;
      const cwd = parsed.workingDirectory || STARTUP_CWD;

      const thread = queries.createConversation(resolvedAgentId, 'Stateless Run', cwd);
      const session = queries.createSession(thread.id, resolvedAgentId, 'pending');
      const message = queries.createMessage(thread.id, 'user', typeof input === 'string' ? input : JSON.stringify(input));

      processMessageWithStreaming(thread.id, message.id, session.id, typeof input === 'string' ? input : JSON.stringify(input), resolvedAgentId, resolvedModel);

      sendJSON(req, res, 200, {
        id: session.id,
        status: 'pending',
        started_at: session.started_at,
        agentId: resolvedAgentId
      });
      return;
    }

    const runsSearchMatch = pathOnly.match(/^\/api\/runs\/search$/);
    if (runsSearchMatch && req.method === 'POST') {
      const sessions = queries.getAllSessions();
      const runs = sessions.slice(0, 50).map(s => ({
        id: s.id,
        status: s.status,
        started_at: s.started_at,
        completed_at: s.completed_at,
        agentId: s.agentId,
        input: null,
        output: null
      })).reverse();
      sendJSON(req, res, 200, runs);
      return;
    }

    // POST /runs/stream - SSE removed, use WebSocket
    if (pathOnly === '/api/runs/stream' && req.method === 'POST') {
      res.writeHead(410); res.end(JSON.stringify({ error: 'SSE removed, use WebSocket' }));
      return;
    }

    const scriptsMatch = pathOnly.match(/^\/api\/conversations\/([^/]+)\/scripts$/);
    if (scriptsMatch && req.method === 'GET') {
      const conv = queries.getConversation(scriptsMatch[1]);
      if (!conv) { sendJSON(req, res, 404, { error: 'Not found' }); return; }
      const wd = conv.workingDirectory || STARTUP_CWD;
      let hasStart = false, hasDev = false;
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(wd, 'package.json'), 'utf-8'));
        const scripts = pkg.scripts || {};
        hasStart = !!scripts.start;
        hasDev = !!scripts.dev;
      } catch {}
      const running = activeScripts.has(scriptsMatch[1]);
      const runningScript = running ? activeScripts.get(scriptsMatch[1]).script : null;
      sendJSON(req, res, 200, { hasStart, hasDev, running, runningScript });
      return;
    }

    const runScriptMatch = pathOnly.match(/^\/api\/conversations\/([^/]+)\/run-script$/);
    if (runScriptMatch && req.method === 'POST') {
      const conversationId = runScriptMatch[1];
      const conv = queries.getConversation(conversationId);
      if (!conv) { sendJSON(req, res, 404, { error: 'Not found' }); return; }
      if (activeScripts.has(conversationId)) { sendJSON(req, res, 409, { error: 'Script already running' }); return; }
      const body = await parseBody(req);
      const script = body.script;
      if (script !== 'start' && script !== 'dev') { sendJSON(req, res, 400, { error: 'Invalid script' }); return; }
      const wd = conv.workingDirectory || STARTUP_CWD;
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(wd, 'package.json'), 'utf-8'));
        if (!pkg.scripts || !pkg.scripts[script]) { sendJSON(req, res, 400, { error: `Script "${script}" not found` }); return; }
      } catch { sendJSON(req, res, 400, { error: 'No package.json' }); return; }

      const childEnv = { ...process.env, FORCE_COLOR: '1' };
      delete childEnv.PORT;
      delete childEnv.BASE_URL;
      delete childEnv.HOT_RELOAD;
      const isWindows = os.platform() === 'win32';
      const child = spawn('npm', ['run', script], { cwd: wd, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: childEnv, shell: isWindows });
      activeScripts.set(conversationId, { process: child, script, startTime: Date.now() });
      broadcastSync({ type: 'script_started', conversationId, script, timestamp: Date.now() });

      const onData = (stream) => (chunk) => {
        broadcastSync({ type: 'script_output', conversationId, data: chunk.toString(), stream, timestamp: Date.now() });
      };
      child.stdout.on('data', onData('stdout'));
      child.stderr.on('data', onData('stderr'));
      child.stdout.on('error', () => {});
      child.stderr.on('error', () => {});
      child.on('error', (err) => {
        activeScripts.delete(conversationId);
        broadcastSync({ type: 'script_stopped', conversationId, code: 1, error: err.message, timestamp: Date.now() });
      });
      child.on('close', (code) => {
        activeScripts.delete(conversationId);
        broadcastSync({ type: 'script_stopped', conversationId, code: code || 0, timestamp: Date.now() });
      });
      sendJSON(req, res, 200, { ok: true, script, pid: child.pid });
      return;
    }

    const stopScriptMatch = pathOnly.match(/^\/api\/conversations\/([^/]+)\/stop-script$/);
    if (stopScriptMatch && req.method === 'POST') {
      const conversationId = stopScriptMatch[1];
      const entry = activeScripts.get(conversationId);
      if (!entry) { sendJSON(req, res, 404, { error: 'No running script' }); return; }
      try { process.kill(-entry.process.pid, 'SIGTERM'); } catch { try { entry.process.kill('SIGTERM'); } catch {} }
      sendJSON(req, res, 200, { ok: true });
      return;
    }

    const scriptStatusMatch = pathOnly.match(/^\/api\/conversations\/([^/]+)\/script-status$/);
    if (scriptStatusMatch && req.method === 'GET') {
      const entry = activeScripts.get(scriptStatusMatch[1]);
      sendJSON(req, res, 200, { running: !!entry, script: entry?.script || null });
      return;
    }

    const cancelRunMatch = pathOnly.match(/^\/api\/conversations\/([^/]+)\/cancel$/);
    if (cancelRunMatch && req.method === 'POST') {
      const conversationId = cancelRunMatch[1];
      const entry = activeExecutions.get(conversationId);
      
      if (!entry) {
        sendJSON(req, res, 404, { error: 'No active execution to cancel' });
        return;
      }

      const { pid, sessionId } = entry;
      
      if (pid) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            process.kill(pid, 'SIGKILL');
          } catch (e) {}
        }
      }

      if (sessionId) {
        queries.updateSession(sessionId, { 
          status: 'interrupted', 
          completed_at: Date.now() 
        });
      }

      queries.setIsStreaming(conversationId, false);
      activeExecutions.delete(conversationId);

      broadcastSync({
        type: 'streaming_complete',
        sessionId,
        conversationId,
        interrupted: true,
        timestamp: Date.now()
      });

      sendJSON(req, res, 200, { ok: true, cancelled: true, conversationId, sessionId });
      return;
    }

    const resumeRunMatch = pathOnly.match(/^\/api\/conversations\/([^/]+)\/resume$/);
    if (resumeRunMatch && req.method === 'POST') {
      const conversationId = resumeRunMatch[1];
      const conv = queries.getConversation(conversationId);
      
      if (!conv) {
        sendJSON(req, res, 404, { error: 'Conversation not found' });
        return;
      }

      const activeEntry = activeExecutions.get(conversationId);
      if (activeEntry) {
        sendJSON(req, res, 409, { error: 'Conversation already has an active execution' });
        return;
      }

      let body = '';
      for await (const chunk of req) { body += chunk; }
      let parsed = {};
      try { parsed = body ? JSON.parse(body) : {}; } catch {}

      const { content, agentId } = parsed;
      if (!content) {
        sendJSON(req, res, 400, { error: 'Missing content in request body' });
        return;
      }

      const resolvedAgentId = agentId || conv.agentId || 'claude-code';
      const resolvedModel = parsed.model || conv.model || null;
      const cwd = conv.workingDirectory || STARTUP_CWD;

      const session = queries.createSession(conversationId, resolvedAgentId, 'pending');
      
      const message = queries.createMessage(conversationId, 'user', content);

      processMessageWithStreaming(conversationId, message.id, session.id, content, resolvedAgentId, resolvedModel);

      sendJSON(req, res, 200, { 
        ok: true, 
        conversationId, 
        sessionId: session.id,
        messageId: message.id,
        resumed: true 
      });
      return;
    }

    const injectMatch = pathOnly.match(/^\/api\/conversations\/([^/]+)\/inject$/);
    if (injectMatch && req.method === 'POST') {
      const conversationId = injectMatch[1];
      const conv = queries.getConversation(conversationId);
      
      if (!conv) {
        sendJSON(req, res, 404, { error: 'Conversation not found' });
        return;
      }

      let body = '';
      for await (const chunk of req) { body += chunk; }
      let parsed = {};
      try { parsed = body ? JSON.parse(body) : {}; } catch {}

      const { content, eager } = parsed;
      if (!content) {
        sendJSON(req, res, 400, { error: 'Missing content in request body' });
        return;
      }

      const entry = activeExecutions.get(conversationId);
      
      if (entry && eager) {
        sendJSON(req, res, 409, { error: 'Cannot eagerly inject while execution is running - message queued' });
        return;
      }

      const message = queries.createMessage(conversationId, 'user', '[INJECTED] ' + content);

      if (!entry) {
        const resolvedAgentId = conv.agentId || 'claude-code';
        const resolvedModel = conv.model || null;
        const cwd = conv.workingDirectory || STARTUP_CWD;
        const session = queries.createSession(conversationId, resolvedAgentId, 'pending');
        processMessageWithStreaming(conversationId, message.id, session.id, message.content, resolvedAgentId, resolvedModel);
      }

      sendJSON(req, res, 200, { ok: true, injected: true, conversationId, messageId: message.id });
      return;
    }

    if (pathOnly === '/api/agents' && req.method === 'GET') {
      console.log(`[API /api/agents] Returning ${discoveredAgents.length} agents:`, discoveredAgents.map(a => a.id).join(', '));
            sendJSON(req, res, 200, { agents: discoveredAgents });
      return;
    }

    if (pathOnly === '/api/acp/status' && req.method === 'GET') {
      sendJSON(req, res, 200, { tools: getACPStatus() });
      return;
    }

    if (pathOnly === '/api/tools' && req.method === 'GET') {
      console.log('[TOOLS-API] Handling GET /api/tools');
      try {
        // Return immediately with cached data (non-blocking) - skip network version checks
        const tools = await Promise.race([
          toolManager.getAllToolsAsync(true), // skipPublishedVersion=true for fast response
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
        ]);
        const result = tools.map((t) => ({
          id: t.id,
          name: t.name,
          pkg: t.pkg,
          category: t.category || 'plugin',
          installed: t.installed,
          status: t.installed ? (t.isUpToDate ? 'installed' : 'needs_update') : 'not_installed',
          isUpToDate: t.isUpToDate,
          upgradeNeeded: t.upgradeNeeded,
          hasUpdate: t.upgradeNeeded && t.installed,
          installedVersion: t.installedVersion,
          publishedVersion: t.publishedVersion
        }));
        sendJSON(req, res, 200, { tools: result });
      } catch (err) {
        console.log('[TOOLS-API] Error getting tools, returning cached status:', err.message);
        // Return synchronously cached tool status - this provides immediate response with last-known status
        const tools = toolManager.getAllToolsSync().map((t) => ({
          id: t.id,
          name: t.name,
          pkg: t.pkg,
          category: t.category || 'plugin',
          installed: t.installed || false,
          status: (t.installed) ? (t.isUpToDate ? 'installed' : 'needs_update') : 'not_installed',
          isUpToDate: t.isUpToDate || false,
          upgradeNeeded: t.upgradeNeeded || false,
          hasUpdate: (t.upgradeNeeded && t.installed) || false,
          installedVersion: t.installedVersion || null,
          publishedVersion: t.publishedVersion || null
        }));
        sendJSON(req, res, 200, { tools });
      }
      return;
    }

    if (pathOnly.match(/^\/api\/tools\/([^/]+)\/status$/)) {
      const toolId = pathOnly.match(/^\/api\/tools\/([^/]+)\/status$/)[1];
      const dbStatus = queries.getToolStatus(toolId);
      const tmStatus = toolManager.checkToolStatus(toolId);
      if (!tmStatus && !dbStatus) {
        sendJSON(req, res, 404, { error: 'Tool not found' });
        return;
      }

      // Merge database status with tool manager status
      const status = {
        toolId,
        installed: tmStatus?.installed || (dbStatus?.status === 'installed'),
        isUpToDate: tmStatus?.isUpToDate || false,
        upgradeNeeded: tmStatus?.upgradeNeeded || false,
        status: dbStatus?.status || (tmStatus?.installed ? 'installed' : 'not_installed'),
        installedVersion: dbStatus?.version || tmStatus?.installedVersion || null,
        timestamp: Date.now(),
        error_message: dbStatus?.error_message || null
      };

      if (status.installed) {
        const updates = await toolManager.checkForUpdates(toolId);
        status.hasUpdate = updates.needsUpdate || false;
      }
      sendJSON(req, res, 200, status);
      return;
    }

    if (pathOnly.match(/^\/api\/tools\/([^/]+)\/install$/) && req.method === 'POST') {
      const toolId = pathOnly.match(/^\/api\/tools\/([^/]+)\/install$/)[1];
      const tool = toolManager.getToolConfig(toolId);
      if (!tool) {
        sendJSON(req, res, 404, { error: 'Tool not found' });
        return;
      }
      const existing = queries.getToolStatus(toolId);
      if (!existing) {
        queries.insertToolInstallation(toolId, { status: 'not_installed' });
      }
      queries.updateToolStatus(toolId, { status: 'installing' });
      sendJSON(req, res, 200, { success: true, installing: true, estimatedTime: 60000 });

      let installCompleted = false;
      const installTimeout = setTimeout(() => {
        if (!installCompleted) {
          installCompleted = true;
          queries.updateToolStatus(toolId, { status: 'failed', error_message: 'Install timeout after 6 minutes' });
          broadcastSync({ type: 'tool_install_failed', toolId, data: { success: false, error: 'Install timeout after 6 minutes' } });
          queries.addToolInstallHistory(toolId, 'install', 'failed', 'Install timeout after 6 minutes');
        }
      }, 360000);

      toolManager.install(toolId, (msg) => {
        broadcastSync({ type: 'tool_install_progress', toolId, data: msg });
      }).then(async (result) => {
        clearTimeout(installTimeout);
        if (installCompleted) return;
        installCompleted = true;
        if (result.success) {
          const version = result.version || null;
          console.log(`[TOOLS-API] Install succeeded for ${toolId}, version: ${version}`);
          queries.updateToolStatus(toolId, { status: 'installed', version, installed_at: Date.now() });
          const freshStatus = await toolManager.checkToolStatusAsync(toolId);
          console.log(`[TOOLS-API] Fresh status after install for ${toolId}:`, JSON.stringify(freshStatus));
          broadcastSync({ type: 'tool_install_complete', toolId, data: { success: true, version, ...freshStatus } });
          queries.addToolInstallHistory(toolId, 'install', 'success', null);
        } else {
          console.error(`[TOOLS-API] Install failed for ${toolId}:`, result.error);
          queries.updateToolStatus(toolId, { status: 'failed', error_message: result.error });
          broadcastSync({ type: 'tool_install_failed', toolId, data: result });
          queries.addToolInstallHistory(toolId, 'install', 'failed', result.error);
        }
      }).catch((err) => {
        clearTimeout(installTimeout);
        if (installCompleted) return;
        installCompleted = true;
        const error = err?.message || 'Unknown error';
        console.error(`[TOOLS-API] Install error for ${toolId}:`, error);
        queries.updateToolStatus(toolId, { status: 'failed', error_message: error });
        broadcastSync({ type: 'tool_install_failed', toolId, data: { success: false, error } });
        queries.addToolInstallHistory(toolId, 'install', 'failed', error);
      });
      return;
    }

    if (pathOnly.match(/^\/api\/tools\/([^/]+)\/update$/) && req.method === 'POST') {
      const toolId = pathOnly.match(/^\/api\/tools\/([^/]+)\/update$/)[1];
      const body = await parseBody(req);
      const tool = toolManager.getToolConfig(toolId);
      if (!tool) {
        sendJSON(req, res, 404, { error: 'Tool not found' });
        return;
      }
      const current = await toolManager.checkToolStatusAsync(toolId);
      if (!current || !current.installed) {
        sendJSON(req, res, 400, { error: 'Tool not installed' });
        return;
      }
      queries.updateToolStatus(toolId, { status: 'updating' });
      sendJSON(req, res, 200, { success: true, updating: true });

      let updateCompleted = false;
      const updateTimeout = setTimeout(() => {
        if (!updateCompleted) {
          updateCompleted = true;
          queries.updateToolStatus(toolId, { status: 'failed', error_message: 'Update timeout after 6 minutes' });
          broadcastSync({ type: 'tool_update_failed', toolId, data: { success: false, error: 'Update timeout after 6 minutes' } });
          queries.addToolInstallHistory(toolId, 'update', 'failed', 'Update timeout after 6 minutes');
        }
      }, 360000);

      toolManager.update(toolId, (msg) => {
        broadcastSync({ type: 'tool_update_progress', toolId, data: msg });
      }).then(async (result) => {
        clearTimeout(updateTimeout);
        if (updateCompleted) return;
        updateCompleted = true;
        if (result.success) {
          const version = result.version || null;
          console.log(`[TOOLS-API] Update succeeded for ${toolId}, version: ${version}`);
          queries.updateToolStatus(toolId, { status: 'installed', version, installed_at: Date.now() });
          const freshStatus = await toolManager.checkToolStatusAsync(toolId);
          console.log(`[TOOLS-API] Fresh status after update for ${toolId}:`, JSON.stringify(freshStatus));
          broadcastSync({ type: 'tool_update_complete', toolId, data: { success: true, version, ...freshStatus } });
          queries.addToolInstallHistory(toolId, 'update', 'success', null);
        } else {
          console.error(`[TOOLS-API] Update failed for ${toolId}:`, result.error);
          queries.updateToolStatus(toolId, { status: 'failed', error_message: result.error });
          broadcastSync({ type: 'tool_update_failed', toolId, data: result });
          queries.addToolInstallHistory(toolId, 'update', 'failed', result.error);
        }
      }).catch((err) => {
        clearTimeout(updateTimeout);
        if (updateCompleted) return;
        updateCompleted = true;
        const error = err?.message || 'Unknown error';
        console.error(`[TOOLS-API] Update error for ${toolId}:`, error);
        queries.updateToolStatus(toolId, { status: 'failed', error_message: error });
        broadcastSync({ type: 'tool_update_failed', toolId, data: { success: false, error } });
        queries.addToolInstallHistory(toolId, 'update', 'failed', error);
      });
      return;
    }

    if (pathOnly.match(/^\/api\/tools\/([^/]+)\/history$/) && req.method === 'GET') {
      const toolId = pathOnly.match(/^\/api\/tools\/([^/]+)\/history$/)[1];
      const url = new URL(req.url, 'http://localhost');
      const limit = Math.min(parseInt(url.searchParams.get('limit')) || 20, 100);
      const offset = parseInt(url.searchParams.get('offset')) || 0;
      const history = queries.getToolInstallHistory(toolId, limit, offset);
      sendJSON(req, res, 200, { history });
      return;
    }

    if (pathOnly === '/api/tools/update' && req.method === 'POST') {
      const allToolIds = ['cli-claude', 'cli-opencode', 'cli-gemini', 'cli-kilo', 'cli-codex', 'gm-cc', 'gm-oc', 'gm-gc', 'gm-kilo'];
      sendJSON(req, res, 200, { updating: true, toolCount: allToolIds.length });
      broadcastSync({ type: 'tools_update_started', tools: allToolIds });
      setImmediate(async () => {
        const toolIds = allToolIds;
        const results = {};
        for (const toolId of toolIds) {
          try {
            const result = await toolManager.update(toolId, (msg) => {
              broadcastSync({ type: 'tool_update_progress', toolId, data: msg });
            });
            results[toolId] = result;
            if (result.success) {
              const version = result.version || null;
              queries.updateToolStatus(toolId, { status: 'installed', version, installed_at: Date.now() });
              queries.addToolInstallHistory(toolId, 'update', 'success', null);
              const freshStatus = await toolManager.checkToolStatusAsync(toolId);
              broadcastSync({ type: 'tool_update_complete', toolId, data: { ...result, ...freshStatus } });
            } else {
              queries.updateToolStatus(toolId, { status: 'failed', error_message: result.error });
              queries.addToolInstallHistory(toolId, 'update', 'failed', result.error);
              broadcastSync({ type: 'tool_update_failed', toolId, data: result });
            }
          } catch (err) {
            queries.updateToolStatus(toolId, { status: 'failed', error_message: err.message });
            queries.addToolInstallHistory(toolId, 'update', 'failed', err.message);
            broadcastSync({ type: 'tool_update_failed', toolId, data: { success: false, error: err.message } });
          }
        }
        broadcastSync({ type: 'tools_update_complete', data: results });
      });
      return;
    }

    if (pathOnly === '/api/tools/refresh-all' && req.method === 'POST') {
      sendJSON(req, res, 200, { refreshing: true, toolCount: 4 });
      broadcastSync({ type: 'tools_refresh_started' });
      setImmediate(async () => {
        const tools = toolManager.getAllTools();
        for (const tool of tools) {
          queries.updateToolStatus(tool.id, {
            status: tool.installed ? 'installed' : 'not_installed',
            version: tool.installedVersion,
            last_check_at: Date.now()
          });
          if (tool.installed) {
            const status = await toolManager.checkToolStatusAsync(tool.id);
            if (status && status.upgradeNeeded) {
              queries.updateToolStatus(tool.id, { update_available: 1, latest_version: status.publishedVersion });
            }
          }
        }
        broadcastSync({ type: 'tools_refresh_complete', data: tools });
      });
      return;
    }

    if (pathOnly === '/api/ws-stats' && req.method === 'GET') {
      const stats = wsOptimizer.getStats();
      sendJSON(req, res, 200, stats);
      return;
    }

    if (pathOnly === '/api/agents/search' && req.method === 'POST') {
      const body = await parseBody(req);
      try {
        // Get local agents
        const localResult = queries.searchAgents(discoveredAgents, body);
        
        // Get external agents from ACP servers
        const externalAgents = await discoverExternalACPServers();
        const externalResult = queries.searchAgents(externalAgents, body);
        
        // Combine results
        const combinedAgents = [...localResult.agents, ...externalResult.agents];
        const total = localResult.total + externalResult.total;
        const hasMore = localResult.hasMore || externalResult.hasMore;
        
        sendJSON(req, res, 200, {
          agents: combinedAgents,
          total,
          limit: body.limit || 50,
          offset: body.offset || 0,
          hasMore,
        });
      } catch (error) {
        console.error('Error searching agents:', error);
        const result = queries.searchAgents(discoveredAgents, body);
        sendJSON(req, res, 200, result);
      }
      return;
    }

    if (pathOnly === '/api/agents/auth-status' && req.method === 'GET') {
      const statuses = discoveredAgents.map(agent => {
        const status = { id: agent.id, name: agent.name, authenticated: false, detail: '' };
        try {
          if (agent.id === 'claude-code') {
            const credFile = path.join(os.homedir(), '.claude', '.credentials.json');
            if (fs.existsSync(credFile)) {
              const creds = JSON.parse(fs.readFileSync(credFile, 'utf-8'));
              if (creds.claudeAiOauth && creds.claudeAiOauth.expiresAt > Date.now()) {
                status.authenticated = true;
                status.detail = creds.claudeAiOauth.subscriptionType || 'authenticated';
              } else {
                status.detail = 'expired';
              }
            } else {
              status.detail = 'no credentials';
            }
          } else if (agent.id === 'gemini') {
            const oauthFile = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
            const acctFile = path.join(os.homedir(), '.gemini', 'google_accounts.json');
            let hasOAuth = false;
            if (fs.existsSync(oauthFile)) {
              try {
                const creds = JSON.parse(fs.readFileSync(oauthFile, 'utf-8'));
                if (creds.refresh_token || creds.access_token) hasOAuth = true;
              } catch (_) {}
            }
            if (fs.existsSync(acctFile)) {
              const accts = JSON.parse(fs.readFileSync(acctFile, 'utf-8'));
              if (accts.active) {
                status.authenticated = true;
                status.detail = accts.active;
              } else if (hasOAuth) {
                status.authenticated = true;
                status.detail = 'oauth';
              } else {
                status.detail = 'logged out';
              }
            } else if (hasOAuth) {
              status.authenticated = true;
              status.detail = 'oauth';
            } else {
              status.detail = 'no credentials';
            }
          } else if (agent.id === 'opencode') {
            const out = execSync('opencode auth list 2>&1', { encoding: 'utf-8', timeout: 5000 });
            const countMatch = out.match(/(\d+)\s+credentials?/);
            if (countMatch && parseInt(countMatch[1], 10) > 0) {
              status.authenticated = true;
              status.detail = countMatch[1] + ' credential(s)';
            } else {
              status.detail = 'no credentials';
            }
          } else {
            status.detail = 'unknown';
          }
        } catch (e) {
          status.detail = 'check failed';
        }
        return status;
      });
      sendJSON(req, res, 200, { agents: statuses });
      return;
    }

    const agentByIdMatch = pathOnly.match(/^\/api\/agents\/([^/]+)$/);
    if (agentByIdMatch && req.method === 'GET') {
      const agentId = agentByIdMatch[1];
      const agent = discoveredAgents.find(a => a.id === agentId);
      
      if (!agent) {
        sendJSON(req, res, 404, { error: 'Agent not found' });
        return;
      }

      sendJSON(req, res, 200, {
        id: agent.id,
        name: agent.name,
        description: agent.description || '',
        icon: agent.icon || null,
        status: 'available'
      });
      return;
    }

    const agentDescriptorMatch = pathOnly.match(/^\/api\/agents\/([^/]+)\/descriptor$/);
    if (agentDescriptorMatch && req.method === 'GET') {
      const agentId = agentDescriptorMatch[1];
      const descriptor = getAgentDescriptor(agentId);

      if (!descriptor) {
        sendJSON(req, res, 404, { error: 'Agent not found' });
        return;
      }

      sendJSON(req, res, 200, descriptor);
      return;
    }

    const modelsMatch = pathOnly.match(/^\/api\/agents\/([^/]+)\/models$/);
    if (modelsMatch && req.method === 'GET') {
      const agentId = modelsMatch[1];
      const cached = modelCache.get(agentId);
      if (cached && (Date.now() - cached.timestamp) < 300000) {
        sendJSON(req, res, 200, { models: cached.models });
        return;
      }
      try {
        const models = await getModelsForAgent(agentId);
        modelCache.set(agentId, { models, timestamp: Date.now() });
        sendJSON(req, res, 200, { models });
      } catch (err) {
        sendJSON(req, res, 200, { models: [] });
      }
      return;
    }

    if (pathOnly === '/api/runs' && req.method === 'POST') {
      const body = await parseBody(req);
      const { agent_id, input, config, webhook_url } = body;
      if (!agent_id) {
        sendJSON(req, res, 422, { error: 'agent_id is required' });
        return;
      }
      const agent = discoveredAgents.find(a => a.id === agent_id);
      if (!agent) {
        sendJSON(req, res, 404, { error: 'Agent not found' });
        return;
      }
      const run = queries.createRun(agent_id, null, input, config, webhook_url);
      sendJSON(req, res, 201, run);
      return;
    }

    if (pathOnly === '/api/runs/search' && req.method === 'POST') {
      const body = await parseBody(req);
      const result = queries.searchRuns(body);
      sendJSON(req, res, 200, result);
      return;
    }

    if (pathOnly === '/api/runs/wait' && req.method === 'POST') {
      const body = await parseBody(req);
      const { agent_id, input, config } = body;
      if (!agent_id) {
        sendJSON(req, res, 422, { error: 'agent_id is required' });
        return;
      }
      const agent = discoveredAgents.find(a => a.id === agent_id);
      if (!agent) {
        sendJSON(req, res, 404, { error: 'Agent not found' });
        return;
      }
      const run = queries.createRun(agent_id, null, input, config);
      const statelessThreadId = queries.getRun(run.run_id)?.thread_id;
      if (statelessThreadId && input?.content) {
        try {
          await runClaudeWithStreaming(agent_id, statelessThreadId, input.content, config?.model || null);
          const finalRun = queries.getRun(run.run_id);
          sendJSON(req, res, 200, finalRun);
        } catch (err) {
          queries.updateRunStatus(run.run_id, 'error');
          sendJSON(req, res, 500, { error: err.message });
        }
      } else {
        sendJSON(req, res, 200, run);
      }
      return;
    }

    const oldRunByIdMatch1 = pathOnly.match(/^\/api\/runs\/([^/]+)$/);
    if (oldRunByIdMatch1) {
      const runId = oldRunByIdMatch1[1];

      if (req.method === 'GET') {
        const run = queries.getRun(runId);
        if (!run) {
          sendJSON(req, res, 404, { error: 'Run not found' });
          return;
        }
        sendJSON(req, res, 200, run);
        return;
      }

      if (req.method === 'POST') {
        const body = await parseBody(req);
        const run = queries.getRun(runId);
        if (!run) {
          sendJSON(req, res, 404, { error: 'Run not found' });
          return;
        }
        if (run.status !== 'pending') {
          sendJSON(req, res, 409, { error: 'Run is not resumable' });
          return;
        }
        if (body.input?.content && run.thread_id) {
          runClaudeWithStreaming(run.agent_id, run.thread_id, body.input.content, null).catch(() => {});
        }
        sendJSON(req, res, 200, run);
        return;
      }

      if (req.method === 'DELETE') {
        try {
          queries.deleteRun(runId);
          res.writeHead(204);
          res.end();
        } catch (err) {
          sendJSON(req, res, 404, { error: 'Run not found' });
        }
        return;
      }
    }

    const runWaitMatch = pathOnly.match(/^\/api\/runs\/([^/]+)\/wait$/);
    if (runWaitMatch && req.method === 'GET') {
      const runId = runWaitMatch[1];
      const run = queries.getRun(runId);
      if (!run) {
        sendJSON(req, res, 404, { error: 'Run not found' });
        return;
      }
      const startTime = Date.now();
      const pollInterval = setInterval(() => {
        const currentRun = queries.getRun(runId);
        const elapsed = Date.now() - startTime;
        const done = currentRun && ['success', 'error', 'cancelled'].includes(currentRun.status);
        if (done) {
          clearInterval(pollInterval);
          sendJSON(req, res, 200, currentRun);
        } else if (elapsed > 30000) {
          clearInterval(pollInterval);
          sendJSON(req, res, 408, { error: 'Run still pending after 30s', run_id: runId, status: currentRun?.status || run.status });
        }
      }, 500);
      req.on('close', () => clearInterval(pollInterval));
      return;
    }

    const runStreamMatch = pathOnly.match(/^\/api\/runs\/([^/]+)\/stream$/);
    if (runStreamMatch && req.method === 'GET') {
      res.writeHead(410); res.end(JSON.stringify({ error: 'SSE removed, use WebSocket' }));
      return;
    }

    const oldRunCancelMatch1 = pathOnly.match(/^\/api\/runs\/([^/]+)\/cancel$/);
    if (oldRunCancelMatch1 && req.method === 'POST') {
      const runId = oldRunCancelMatch1[1];
      try {
        const run = queries.getRun(runId);
        if (!run) {
          sendJSON(req, res, 404, { error: 'Run not found' });
          return;
        }

        if (['success', 'error', 'cancelled'].includes(run.status)) {
          sendJSON(req, res, 409, { error: 'Run already completed or cancelled' });
          return;
        }

        const cancelledRun = queries.cancelRun(runId);

        const threadId = run.thread_id;
        if (threadId) {
          const execution = activeExecutions.get(threadId);
          if (execution?.pid) {
            try {
              process.kill(-execution.pid, 'SIGTERM');
            } catch {
              try {
                process.kill(execution.pid, 'SIGTERM');
              } catch (e) {
                console.error(`[cancel] Failed to SIGTERM PID ${execution.pid}:`, e.message);
              }
            }

            setTimeout(() => {
              try {
                process.kill(-execution.pid, 'SIGKILL');
              } catch {
                try {
                  process.kill(execution.pid, 'SIGKILL');
                } catch (e) {}
              }
            }, 3000);
          }

          if (execution?.sessionId) {
            queries.updateSession(execution.sessionId, {
              status: 'error',
              error: 'Cancelled by user',
              completed_at: Date.now()
            });
          }

          activeExecutions.delete(threadId);
          queries.setIsStreaming(threadId, false);

          broadcastSync({
            type: 'streaming_cancelled',
            sessionId: execution?.sessionId || runId,
            conversationId: threadId,
            runId: runId,
            timestamp: Date.now()
          });
        }

        sendJSON(req, res, 200, cancelledRun);
      } catch (err) {
        if (err.message === 'Run not found') {
          sendJSON(req, res, 404, { error: err.message });
        } else if (err.message.includes('already completed')) {
          sendJSON(req, res, 409, { error: err.message });
        } else {
          sendJSON(req, res, 500, { error: err.message });
        }
      }
      return;
    }

    const threadRunCancelMatch = pathOnly.match(/^\/api\/threads\/([^/]+)\/runs\/([^/]+)\/cancel$/);
    if (threadRunCancelMatch && req.method === 'POST') {
      const threadId = threadRunCancelMatch[1];
      const runId = threadRunCancelMatch[2];

      try {
        const run = queries.getRun(runId);
        if (!run) {
          sendJSON(req, res, 404, { error: 'Run not found' });
          return;
        }

        if (run.thread_id !== threadId) {
          sendJSON(req, res, 400, { error: 'Run does not belong to specified thread' });
          return;
        }

        if (['success', 'error', 'cancelled'].includes(run.status)) {
          sendJSON(req, res, 409, { error: 'Run already completed or cancelled' });
          return;
        }

        const cancelledRun = queries.cancelRun(runId);

        const execution = activeExecutions.get(threadId);
        if (execution?.pid) {
          try {
            process.kill(-execution.pid, 'SIGTERM');
          } catch {
            try {
              process.kill(execution.pid, 'SIGTERM');
            } catch (e) {
              console.error(`[cancel] Failed to SIGTERM PID ${execution.pid}:`, e.message);
            }
          }

          setTimeout(() => {
            try {
              process.kill(-execution.pid, 'SIGKILL');
            } catch {
              try {
                process.kill(execution.pid, 'SIGKILL');
              } catch (e) {}
            }
          }, 3000);
        }

        if (execution?.sessionId) {
          queries.updateSession(execution.sessionId, {
            status: 'error',
            error: 'Cancelled by user',
            completed_at: Date.now()
          });
        }

        activeExecutions.delete(threadId);
        activeProcessesByRunId.delete(runId);
        queries.setIsStreaming(threadId, false);

        broadcastSync({ type: 'run_cancelled', runId, threadId, sessionId: execution?.sessionId, timestamp: Date.now() });
        broadcastSync({ type: 'streaming_cancelled', sessionId: execution?.sessionId || runId, conversationId: threadId, runId, timestamp: Date.now() });

        sendJSON(req, res, 200, cancelledRun);
      } catch (err) {
        if (err.message === 'Run not found') {
          sendJSON(req, res, 404, { error: err.message });
        } else if (err.message.includes('already completed')) {
          sendJSON(req, res, 409, { error: err.message });
        } else {
          sendJSON(req, res, 500, { error: err.message });
        }
      }
      return;
    }

    const threadRunWaitMatch = pathOnly.match(/^\/api\/threads\/([^/]+)\/runs\/([^/]+)\/wait$/);
    if (threadRunWaitMatch && req.method === 'GET') {
      const threadId = threadRunWaitMatch[1];
      const runId = threadRunWaitMatch[2];

      const run = queries.getRun(runId);
      if (!run) {
        sendJSON(req, res, 404, { error: 'Run not found' });
        return;
      }

      if (run.thread_id !== threadId) {
        sendJSON(req, res, 400, { error: 'Run does not belong to specified thread' });
        return;
      }

      const startTime = Date.now();
      const pollInterval = setInterval(() => {
        const currentRun = queries.getRun(runId);
        const elapsed = Date.now() - startTime;
        const done = currentRun && ['success', 'error', 'cancelled'].includes(currentRun.status);
        if (done) {
          clearInterval(pollInterval);
          sendJSON(req, res, 200, currentRun);
        } else if (elapsed > 30000) {
          clearInterval(pollInterval);
          sendJSON(req, res, 408, { error: 'Run still pending after 30s', run_id: runId, status: currentRun?.status || run.status });
        }
      }, 500);
      req.on('close', () => clearInterval(pollInterval));
      return;
    }

    if (pathOnly === '/api/gemini-oauth/start' && req.method === 'POST') {
      try {
        const result = await startGeminiOAuth(req);
        sendJSON(req, res, 200, { authUrl: result.authUrl, mode: result.mode });
      } catch (e) {
        console.error('[gemini-oauth] /api/gemini-oauth/start failed:', e);
        sendJSON(req, res, 500, { error: e.message });
      }
      return;
    }

    if (pathOnly === '/api/gemini-oauth/status' && req.method === 'GET') {
      sendJSON(req, res, 200, geminiOAuthState);
      return;
    }

    if (pathOnly === '/api/gemini-oauth/relay' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const { code, state: stateParam } = body;
        if (!code || !stateParam) {
          sendJSON(req, res, 400, { error: 'Missing code or state' });
          return;
        }
        const email = await exchangeGeminiOAuthCode(code, stateParam);
        sendJSON(req, res, 200, { success: true, email });
      } catch (e) {
        geminiOAuthState = { status: 'error', error: e.message, email: null };
        geminiOAuthPending = null;
        sendJSON(req, res, 400, { error: e.message });
      }
      return;
    }

    if (pathOnly === '/api/gemini-oauth/complete' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const pastedUrl = (body.url || '').trim();
        if (!pastedUrl) {
          sendJSON(req, res, 400, { error: 'No URL provided' });
          return;
        }

        let parsed;
        try { parsed = new URL(pastedUrl); } catch (_) {
          sendJSON(req, res, 400, { error: 'Invalid URL. Paste the full URL from the browser address bar.' });
          return;
        }

        const error = parsed.searchParams.get('error');
        if (error) {
          const desc = parsed.searchParams.get('error_description') || error;
          geminiOAuthState = { status: 'error', error: desc, email: null };
          geminiOAuthPending = null;
          sendJSON(req, res, 200, { error: desc });
          return;
        }

        const code = parsed.searchParams.get('code');
        const state = parsed.searchParams.get('state');
        const email = await exchangeGeminiOAuthCode(code, state);
        sendJSON(req, res, 200, { success: true, email });
      } catch (e) {
        geminiOAuthState = { status: 'error', error: e.message, email: null };
        geminiOAuthPending = null;
        sendJSON(req, res, 400, { error: e.message });
      }
      return;
    }

    const agentAuthMatch = pathOnly.match(/^\/api\/agents\/([^/]+)\/auth$/);
    if (agentAuthMatch && req.method === 'POST') {
      const agentId = agentAuthMatch[1];
      const agent = discoveredAgents.find(a => a.id === agentId);
      if (!agent) { sendJSON(req, res, 404, { error: 'Agent not found' }); return; }

      if (agentId === 'gemini') {
        try {
          const result = await startGeminiOAuth(req);
          const conversationId = '__agent_auth__';
          broadcastSync({ type: 'script_started', conversationId, script: 'auth-gemini', agentId: 'gemini', timestamp: Date.now() });
          broadcastSync({ type: 'script_output', conversationId, data: `\x1b[36mOpening Google OAuth in your browser...\x1b[0m\r\n\r\nIf it doesn't open automatically, visit:\r\n${result.authUrl}\r\n`, stream: 'stdout', timestamp: Date.now() });

          const pollId = setInterval(() => {
            if (geminiOAuthState.status === 'success') {
              clearInterval(pollId);
              const email = geminiOAuthState.email || '';
              broadcastSync({ type: 'script_output', conversationId, data: `\r\n\x1b[32mAuthentication successful${email ? ' (' + email + ')' : ''}\x1b[0m\r\n`, stream: 'stdout', timestamp: Date.now() });
              broadcastSync({ type: 'script_stopped', conversationId, code: 0, timestamp: Date.now() });
            } else if (geminiOAuthState.status === 'error') {
              clearInterval(pollId);
              broadcastSync({ type: 'script_output', conversationId, data: `\r\n\x1b[31mAuthentication failed: ${geminiOAuthState.error}\x1b[0m\r\n`, stream: 'stderr', timestamp: Date.now() });
              broadcastSync({ type: 'script_stopped', conversationId, code: 1, error: geminiOAuthState.error, timestamp: Date.now() });
            }
          }, 1000);

          setTimeout(() => clearInterval(pollId), 5 * 60 * 1000);

          sendJSON(req, res, 200, { ok: true, agentId, authUrl: result.authUrl, mode: result.mode });
          return;
        } catch (e) {
          console.error('[gemini-oauth] /api/agents/gemini/auth failed:', e);
          sendJSON(req, res, 500, { error: e.message });
          return;
        }
      }

      const authCommands = {
        'claude-code': { cmd: 'claude', args: ['setup-token'] },
        'opencode': { cmd: 'opencode', args: ['auth', 'login'] },
      };
      const authCmd = authCommands[agentId];
      if (!authCmd) { sendJSON(req, res, 400, { error: 'No auth command for this agent' }); return; }

      const conversationId = '__agent_auth__';
      if (activeScripts.has(conversationId)) {
        sendJSON(req, res, 409, { error: 'Auth process already running' });
        return;
      }

      const child = spawn(authCmd.cmd, authCmd.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '1' },
        shell: os.platform() === 'win32'
      });
      activeScripts.set(conversationId, { process: child, script: 'auth-' + agentId, startTime: Date.now() });
      broadcastSync({ type: 'script_started', conversationId, script: 'auth-' + agentId, agentId, timestamp: Date.now() });

      const onData = (stream) => (chunk) => {
        broadcastSync({ type: 'script_output', conversationId, data: chunk.toString(), stream, timestamp: Date.now() });
      };
      child.stdout.on('data', onData('stdout'));
      child.stderr.on('data', onData('stderr'));
      child.stdout.on('error', () => {});
      child.stderr.on('error', () => {});
      child.on('error', (err) => {
        activeScripts.delete(conversationId);
        broadcastSync({ type: 'script_stopped', conversationId, code: 1, error: err.message, timestamp: Date.now() });
      });
      child.on('close', (code) => {
        activeScripts.delete(conversationId);
        broadcastSync({ type: 'script_stopped', conversationId, code: code || 0, timestamp: Date.now() });
      });
      sendJSON(req, res, 200, { ok: true, agentId, pid: child.pid });
      return;
    }

    const agentUpdateMatch = pathOnly.match(/^\/api\/agents\/([^/]+)\/update$/);
    if (agentUpdateMatch && req.method === 'POST') {
      const agentId = agentUpdateMatch[1];
      const updateCommands = {
        'claude-code': { cmd: 'claude', args: ['update', '--yes'] },
      };
      const updateCmd = updateCommands[agentId];
      if (!updateCmd) { sendJSON(req, res, 400, { error: 'No update command for this agent' }); return; }
      const conversationId = '__agent_update__';
      if (activeScripts.has(conversationId)) { sendJSON(req, res, 409, { error: 'Update already running' }); return; }
      const child = spawn(updateCmd.cmd, updateCmd.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, FORCE_COLOR: '1' },
        shell: os.platform() === 'win32'
      });
      activeScripts.set(conversationId, { process: child, script: 'update-' + agentId, startTime: Date.now() });
      broadcastSync({ type: 'script_started', conversationId, script: 'update-' + agentId, agentId, timestamp: Date.now() });
      const onData = (stream) => (chunk) => {
        broadcastSync({ type: 'script_output', conversationId, data: chunk.toString(), stream, timestamp: Date.now() });
      };
      child.stdout.on('data', onData('stdout'));
      child.stderr.on('data', onData('stderr'));
      child.stdout.on('error', () => {});
      child.stderr.on('error', () => {});
      child.on('error', (err) => {
        activeScripts.delete(conversationId);
        broadcastSync({ type: 'script_stopped', conversationId, code: 1, error: err.message, timestamp: Date.now() });
      });
      child.on('close', (code) => {
        activeScripts.delete(conversationId);
        modelCache.delete(agentId);
        broadcastSync({ type: 'script_stopped', conversationId, code: code || 0, timestamp: Date.now() });
      });
      sendJSON(req, res, 200, { ok: true, agentId, pid: child.pid });
      return;
    }

    if (pathOnly === '/api/auth/configs' && req.method === 'GET') {
      const configs = getProviderConfigs();
      sendJSON(req, res, 200, configs);
      return;
    }

    if (pathOnly === '/api/auth/save-config' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const { providerId, apiKey, defaultModel } = body || {};
        if (typeof providerId !== 'string' || !providerId.length || providerId.length > 100) {
          sendJSON(req, res, 400, { error: 'Invalid providerId' }); return;
        }
        if (typeof apiKey !== 'string' || !apiKey.length || apiKey.length > 10000) {
          sendJSON(req, res, 400, { error: 'Invalid apiKey' }); return;
        }
        if (defaultModel !== undefined && (typeof defaultModel !== 'string' || defaultModel.length > 200)) {
          sendJSON(req, res, 400, { error: 'Invalid defaultModel' }); return;
        }
        const configPath = saveProviderConfig(providerId, apiKey, defaultModel || '');
        sendJSON(req, res, 200, { success: true, path: configPath });
      } catch (err) {
        sendJSON(req, res, 400, { error: err.message });
      }
      return;
    }

    if (pathOnly === '/api/import/claude-code' && req.method === 'GET') {
      const result = queries.importClaudeCodeConversations();
            sendJSON(req, res, 200, { imported: result });
      return;
    }

    if (pathOnly === '/api/discover/claude-code' && req.method === 'GET') {
      const discovered = queries.discoverClaudeCodeConversations();
            sendJSON(req, res, 200, { discovered });
      return;
    }

    if (pathOnly === '/api/home' && req.method === 'GET') {
            sendJSON(req, res, 200, { home: os.homedir(), cwd: STARTUP_CWD });
      return;
    }

    if (pathOnly === '/api/version' && req.method === 'GET') {
      sendJSON(req, res, 200, { version: PKG_VERSION });
      return;
    }

    if (pathOnly === '/api/stt' && req.method === 'POST') {
      try {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const audioBuffer = Buffer.concat(chunks);
        if (audioBuffer.length === 0) {
                    sendJSON(req, res, 400, { error: 'No audio data' });
          return;
        }
        broadcastSync({ type: 'stt_progress', status: 'transcribing', percentComplete: 0 });
        const { transcribe } = await getSpeech();
        const text = await transcribe(audioBuffer);
        const finalText = (text || '').trim();
        broadcastSync({ type: 'stt_progress', status: 'completed', percentComplete: 100, transcript: finalText });
                sendJSON(req, res, 200, { text: finalText });
      } catch (err) {
        debugLog('[STT] Error: ' + err.message);
        let errorMsg = err.message || 'STT failed';
        if (errorMsg.includes('VERS_1.21') || errorMsg.includes('onnxruntime')) {
          errorMsg = 'STT model load failed: onnxruntime version mismatch. Try: npm install or npm ci';
        } else if (errorMsg.includes('not valid JSON') || errorMsg.includes('Unexpected token') || errorMsg.includes('corrupted files cleared')) {
          try {
            const speech = await getSpeech();
            const cleared = speech.clearCorruptedSTTCache();
            speech.resetSTTError();
            console.log('[STT] Cleared', cleared, 'corrupted files and reset error state');
            await ensureModelsDownloaded();
            errorMsg = 'STT cache was corrupted, re-downloaded models. Please try again.';
          } catch (e) {
            console.warn('[STT] Recovery failed:', e.message);
            errorMsg = 'STT model load failed: corrupted cache. Recovery attempted, try again.';
          }
        }
        broadcastSync({ type: 'stt_progress', status: 'failed', percentComplete: 0, error: errorMsg });
        if (!res.headersSent) sendJSON(req, res, 500, { error: errorMsg });
      }
      return;
    }

    if (pathOnly === '/api/voices' && req.method === 'GET') {
      try {
        const { getVoices } = await getSpeech();
        sendJSON(req, res, 200, { ok: true, voices: getVoices() });
      } catch (err) {
        sendJSON(req, res, 200, { ok: true, voices: [] });
      }
      return;
    }

    if (pathOnly === '/api/tts' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const text = body.text || '';
        const voiceId = body.voiceId || null;
        if (!text) {
          sendJSON(req, res, 400, { error: 'No text provided' });
          return;
        }

        if (process.platform === 'win32') {
          const setupOk = await ensurePocketTtsSetup((msg) => {
            broadcastSync({ type: 'tts_setup_progress', ...msg });
          });
          if (!setupOk) {
            sendJSON(req, res, 503, { error: 'pocket-tts setup failed', retryable: false });
            return;
          }

          // After successful setup, start the TTS sidecar if not already running
          const speech = await getSpeech();
          if (speech.preloadTTS) {
            speech.preloadTTS();
            // Wait a bit for it to start
            await new Promise(r => setTimeout(r, 2000));
          }
        }

        const speech = await getSpeech();
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

    if (pathOnly === '/api/tts-stream' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const text = body.text || '';
        const voiceId = body.voiceId || null;
        if (!text) {
          sendJSON(req, res, 400, { error: 'No text provided' });
          return;
        }
        const speech = await getSpeech();
        const gen = speech.synthesizeStream(text, voiceId);
        const firstResult = await gen.next();
        if (firstResult.done) {
          sendJSON(req, res, 500, { error: 'TTS stream returned no audio', retryable: true });
          return;
        }
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Transfer-Encoding': 'chunked',
          'X-Content-Type': 'audio/wav-stream',
          'Cache-Control': 'no-cache'
        });
        const writeChunk = (wavChunk) => {
          const lenBuf = Buffer.alloc(4);
          lenBuf.writeUInt32BE(wavChunk.length, 0);
          res.write(lenBuf);
          res.write(wavChunk);
        };
        writeChunk(firstResult.value);
        for await (const wavChunk of gen) {
          writeChunk(wavChunk);
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

    if (pathOnly.startsWith('/api/tts-cache/') && req.method === 'GET') {
      const cacheKey = decodeURIComponent(pathOnly.slice('/api/tts-cache/'.length));
      try {
        const speech = await getSpeech();
        const cached = speech.ttsCacheGet(cacheKey);
        if (cached) {
          res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': cached.length, 'Cache-Control': 'public, max-age=3600' });
          res.end(cached);
        } else {
          sendJSON(req, res, 404, { error: 'not cached' });
        }
      } catch (err) {
        sendJSON(req, res, 500, { error: err.message });
      }
      return;
    }

    if (pathOnly === '/api/speech-status' && req.method === 'GET') {
      try {
        const { getStatus } = await getSpeech();
        const baseStatus = getStatus();
        sendJSON(req, res, 200, {
          ...baseStatus,
          setupMessage: baseStatus.ttsReady ? 'pocket-tts ready' : 'Will setup on first TTS request',
          modelsDownloading: modelDownloadState.downloading,
          modelsComplete: modelDownloadState.complete,
          modelsError: modelDownloadState.error,
          modelsProgress: modelDownloadState.progress,
        });
      } catch (err) {
        sendJSON(req, res, 200, {
          sttReady: false, ttsReady: false, sttLoading: false, ttsLoading: false,
          setupMessage: 'Will setup on first TTS request',
          modelsDownloading: modelDownloadState.downloading,
          modelsComplete: modelDownloadState.complete,
          modelsError: modelDownloadState.error,
        });
      }
      return;
    }

    if (pathOnly === '/api/speech-status' && req.method === 'POST') {
      const body = await parseBody(req);
      if (body.forceDownload) {
        if (modelDownloadState.complete) {
          sendJSON(req, res, 200, { ok: true, modelsComplete: true, message: 'Models already ready' });
          return;
        }
        if (!modelDownloadState.downloading) {
          modelDownloadState.error = null;
          ensureModelsDownloaded().then(ok => {
            broadcastSync({
              type: 'model_download_progress',
              progress: { done: true, complete: ok, error: ok ? null : 'Download failed' }
            });
          }).catch(err => {
            broadcastSync({
              type: 'model_download_progress',
              progress: { done: true, error: err.message }
            });
          });
        }
        sendJSON(req, res, 200, { ok: true, message: 'Starting model download' });
        return;
      }
      sendJSON(req, res, 400, { error: 'Unknown request' });
      return;
    }

    if (pathOnly === '/api/clone' && req.method === 'POST') {
      const body = await parseBody(req);
      const repo = (body.repo || '').trim();
      if (!repo || !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
        sendJSON(req, res, 400, { error: 'Invalid repo format. Use org/repo or user/repo' });
        return;
      }
      const cloneDir = STARTUP_CWD || os.homedir();
      const repoName = repo.split('/')[1];
      const targetPath = path.join(cloneDir, repoName);
      if (fs.existsSync(targetPath)) {
        sendJSON(req, res, 409, { error: `Directory already exists: ${repoName}`, path: targetPath });
        return;
      }
      try {
        const isWindows = os.platform() === 'win32';
        execSync('git clone https://github.com/' + repo + '.git', {
          cwd: cloneDir,
          encoding: 'utf-8',
          timeout: 120000,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
          shell: isWindows
        });
        sendJSON(req, res, 200, { ok: true, repo, path: targetPath, name: repoName });
      } catch (err) {
        const stderr = err.stderr || err.message || 'Clone failed';
        sendJSON(req, res, 500, { error: stderr.trim() });
      }
      return;
    }

    if (pathOnly === '/api/folders' && req.method === 'POST') {
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

    if (pathOnly === '/api/git/check-remote-ownership' && req.method === 'GET') {
      try {
        const isWindows = os.platform() === 'win32';
        const result = execSync('git remote get-url origin' + (isWindows ? '' : ' 2>/dev/null'), { encoding: 'utf-8', cwd: STARTUP_CWD, shell: isWindows });
        const remoteUrl = result.trim();
        const statusResult = execSync('git status --porcelain' + (isWindows ? '' : ' 2>/dev/null'), { encoding: 'utf-8', cwd: STARTUP_CWD, shell: isWindows });
        const hasChanges = statusResult.trim().length > 0;
        const unpushedResult = execSync('git rev-list --count --not --remotes' + (isWindows ? '' : ' 2>/dev/null'), { encoding: 'utf-8', cwd: STARTUP_CWD, shell: isWindows });
        const hasUnpushed = parseInt(unpushedResult.trim() || '0', 10) > 0;
        const ownsRemote = !remoteUrl.includes('github.com/') || remoteUrl.includes(process.env.GITHUB_USER || '');
        sendJSON(req, res, 200, { ownsRemote, hasChanges, hasUnpushed, remoteUrl });
      } catch {
        sendJSON(req, res, 200, { ownsRemote: false, hasChanges: false, hasUnpushed: false, remoteUrl: '' });
      }
      return;
    }

    if (pathOnly === '/api/git/push' && req.method === 'POST') {
      try {
        const isWindows = os.platform() === 'win32';
        const gitCommand = isWindows
          ? 'git add -A & git commit -m "Auto-commit" & git push'
          : 'git add -A && git commit -m "Auto-commit" && git push';
        execSync(gitCommand, { encoding: 'utf-8', cwd: STARTUP_CWD, shell: isWindows });
        sendJSON(req, res, 200, { success: true });
      } catch (err) {
        sendJSON(req, res, 500, { error: err.message });
      }
      return;
    }

    // ============================================================
    // THREAD API ENDPOINTS (ACP v0.2.3)
    // ============================================================

    // POST /threads - Create empty thread
    if (pathOnly === '/api/threads' && req.method === 'POST') {
      console.log('[ACP] POST /api/threads HIT');
      try {
        const body = await parseBody(req);
        const metadata = body.metadata || {};
        const thread = queries.createThread(metadata);
        sendJSON(req, res, 201, thread);
      } catch (err) {
        sendJSON(req, res, 422, { error: err.message, type: 'validation_error' });
      }
      return;
    }

    // POST /threads/search - Search threads
    if (pathOnly === '/api/threads/search' && req.method === 'POST') {
      try {
        const body = await parseBody(req);
        const result = queries.searchThreads(body);
        sendJSON(req, res, 200, result);
      } catch (err) {
        sendJSON(req, res, 422, { error: err.message, type: 'validation_error' });
      }
      return;
    }

    // GET /threads/{thread_id} - Get thread by ID
    const acpThreadMatch = pathOnly.match(/^\/api\/threads\/([a-f0-9-]{36})$/);
    if (acpThreadMatch && req.method === 'GET') {
      const threadId = acpThreadMatch[1];
      try {
        const thread = queries.getThread(threadId);
        if (!thread) {
          sendJSON(req, res, 404, { error: 'Thread not found', type: 'not_found' });
        } else {
          sendJSON(req, res, 200, thread);
        }
      } catch (err) {
        sendJSON(req, res, 500, { error: err.message, type: 'internal_error' });
      }
      return;
    }

    // PATCH /threads/{thread_id} - Update thread metadata
    if (acpThreadMatch && req.method === 'PATCH') {
      const threadId = acpThreadMatch[1];
      try {
        const body = await parseBody(req);
        const thread = queries.patchThread(threadId, body);
        sendJSON(req, res, 200, thread);
      } catch (err) {
        if (err.message.includes('not found')) {
          sendJSON(req, res, 404, { error: err.message, type: 'not_found' });
        } else {
          sendJSON(req, res, 422, { error: err.message, type: 'validation_error' });
        }
      }
      return;
    }

    // DELETE /threads/{thread_id} - Delete thread (fail if pending runs exist)
    if (acpThreadMatch && req.method === 'DELETE') {
      const threadId = acpThreadMatch[1];
      try {
        queries.deleteThread(threadId);
        res.writeHead(204);
        res.end();
      } catch (err) {
        if (err.message.includes('not found')) {
          sendJSON(req, res, 404, { error: err.message, type: 'not_found' });
        } else if (err.message.includes('pending runs')) {
          sendJSON(req, res, 409, { error: err.message, type: 'conflict' });
        } else {
          sendJSON(req, res, 500, { error: err.message, type: 'internal_error' });
        }
      }
      return;
    }

    // GET /threads/{thread_id}/history - Get thread state history with pagination
    const threadHistoryMatch = pathOnly.match(/^\/api\/threads\/([a-f0-9-]{36})\/history$/);
    if (threadHistoryMatch && req.method === 'GET') {
      const threadId = threadHistoryMatch[1];
      try {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const limit = parseInt(url.searchParams.get('limit') || '50', 10);
        const before = url.searchParams.get('before') || null;

        // Convert 'before' cursor to offset if needed
        let offset = 0;
        if (before) {
          // Simple cursor-based pagination: before is an offset value
          offset = parseInt(before, 10);
        }

        const result = queries.getThreadHistory(threadId, limit, offset);

        // Generate next_cursor if there are more results
        const response = {
          states: result.states,
          next_cursor: result.hasMore ? String(offset + limit) : null
        };

        sendJSON(req, res, 200, response);
      } catch (err) {
        if (err.message.includes('not found')) {
          sendJSON(req, res, 404, { error: err.message, type: 'not_found' });
        } else {
          sendJSON(req, res, 422, { error: err.message, type: 'validation_error' });
        }
      }
      return;
    }

    // POST /threads/{thread_id}/copy - Copy thread with all states/checkpoints
    const threadCopyMatch = pathOnly.match(/^\/api\/threads\/([a-f0-9-]{36})\/copy$/);
    if (threadCopyMatch && req.method === 'POST') {
      const sourceThreadId = threadCopyMatch[1];
      try {
        const body = await parseBody(req);
        const newThread = queries.copyThread(sourceThreadId);

        // Update metadata if provided
        if (body.metadata) {
          const updated = queries.patchThread(newThread.thread_id, { metadata: body.metadata });
          sendJSON(req, res, 201, updated);
        } else {
          sendJSON(req, res, 201, newThread);
        }
      } catch (err) {
        if (err.message.includes('not found')) {
          sendJSON(req, res, 404, { error: err.message, type: 'not_found' });
        } else {
          sendJSON(req, res, 500, { error: err.message, type: 'internal_error' });
        }
      }
      return;
    }

    // POST /threads/{thread_id}/runs/stream - SSE removed, use WebSocket
    const threadRunsStreamMatch = pathOnly.match(/^\/api\/threads\/([a-f0-9-]{36})\/runs\/stream$/);
    if (threadRunsStreamMatch && req.method === 'POST') {
      res.writeHead(410); res.end(JSON.stringify({ error: 'SSE removed, use WebSocket' }));
      return;
    }

    // GET /threads/{thread_id}/runs/{run_id}/stream - SSE removed, use WebSocket
    const threadRunStreamMatch = pathOnly.match(/^\/api\/threads\/([a-f0-9-]{36})\/runs\/([a-f0-9-]{36})\/stream$/);
    if (threadRunStreamMatch && req.method === 'GET') {
      res.writeHead(410); res.end(JSON.stringify({ error: 'SSE removed, use WebSocket' }));
      return;
    }

    if (routePath.startsWith('/api/image/')) {
      const imagePath = routePath.slice('/api/image/'.length);
      const decodedPath = decodeURIComponent(imagePath);
      const expandedPath = decodedPath.startsWith('~') ?
        decodedPath.replace('~', os.homedir()) : decodedPath;
      const normalizedPath = path.normalize(expandedPath);
      const isWindows = os.platform() === 'win32';
      const isAbsolute = isWindows ? /^[A-Za-z]:[\\\/]/.test(normalizedPath) : normalizedPath.startsWith('/');
      if (!isAbsolute || normalizedPath.includes('..')) {
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

// In-memory cache: etag -> { br: Buffer, gz: Buffer, raw: Buffer }
const _assetCache = new Map();
// Cached processed HTML (invalidated on hot-reload or server restart)
let _htmlCache = null;
let _htmlCacheEtag = null;

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
      const isJsCss = ['.js', '.css'].includes(ext);
      // Use long cache + ETag for immutable assets; browser only re-requests on server restart
      const cacheControl = isJsCss
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600, must-revalidate';

      const sendCached = (cached) => {
        if (acceptsEncoding(req, 'gzip') && cached.gz) {
          res.writeHead(200, { 'Content-Type': contentType, 'Content-Encoding': 'gzip', 'Content-Length': cached.gz.length, 'ETag': etag, 'Cache-Control': cacheControl });
          res.end(cached.gz);
        } else {
          res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': cached.raw.length, 'ETag': etag, 'Cache-Control': cacheControl });
          res.end(cached.raw);
        }
      };

      const cached = _assetCache.get(etag);
      if (cached) { sendCached(cached); return; }

      fs.readFile(filePath, (err2, raw) => {
        if (err2) { res.writeHead(500); res.end('Server error'); return; }
        if (raw.length < 860) {
          const entry = { raw, gz: null };
          _assetCache.set(etag, entry);
          sendCached(entry);
          return;
        }
        // Pre-compress once with gzip, cache it
        const gz = zlib.gzipSync(raw, { level: 6 });
        const entry = { raw, gz };
        _assetCache.set(etag, entry);
        sendCached(entry);
      });
    });
    return;
  }

  // HTML: cache processed result, invalidate when file changes
  fs.stat(filePath, (err, stats) => {
    if (err) { res.writeHead(500); res.end('Server error'); return; }
    const etag = generateETag(stats);
    if (!watch && _htmlCache && _htmlCacheEtag === etag) {
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'Content-Encoding': 'gzip', 'Content-Length': _htmlCache.length });
      res.end(_htmlCache);
      return;
    }
    fs.readFile(filePath, (err2, data) => {
      if (err2) { res.writeHead(500); res.end('Server error'); return; }
      let content = data.toString();
      const baseTag = `<script>window.__BASE_URL='${BASE_URL}';window.__SERVER_VERSION='${PKG_VERSION}';</script>`;
      content = content.replace('<head>', `<head>\n  <base href="${BASE_URL}/">\n  ` + baseTag);
      content = content.replace(/(href|src)="vendor\//g, `$1="${BASE_URL}/vendor/`);
      content = content.replace(/(src)="\/gm\/js\//g, `$1="${BASE_URL}/js/`);
      if (watch) {
        content += `\n<script>(function(){const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'${BASE_URL}/hot-reload');ws.onmessage=e=>{if(JSON.parse(e.data).type==='reload')location.reload()};})();</script>`;
      }
      compressAndSend(req, res, 200, contentType, content);
      if (!watch && acceptsEncoding(req, 'gzip')) {
        _htmlCache = zlib.gzipSync(Buffer.from(content), { level: 6 });
        _htmlCacheEtag = etag;
      }
    });
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

// Global broadcast sequence counter for event ordering
let broadcastSeq = 0;

function parseRateLimitResetTime(text) {
  const match = text.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(?(UTC|[A-Z]{2,4})\)?/i);
  if (!match) return 300;
  let hours = parseInt(match[1], 10);
  const minutes = match[2] ? parseInt(match[2], 10) : 0;
  const period = match[3]?.toLowerCase();
  if (period === 'pm' && hours !== 12) hours += 12;
  if (period === 'am' && hours === 12) hours = 0;
  const now = new Date();
  const resetTime = new Date(now);
  resetTime.setUTCHours(hours, minutes, 0, 0);
  if (resetTime <= now) resetTime.setUTCDate(resetTime.getUTCDate() + 1);
  return Math.max(60, Math.ceil((resetTime.getTime() - now.getTime()) / 1000));
}

async function processMessageWithStreaming(conversationId, messageId, sessionId, content, agentId, model, subAgent) {
  const startTime = Date.now();
  touchACP(agentId);
  
  const conv = queries.getConversation(conversationId);
  if (!conv) {
    console.error(`[stream] Conversation ${conversationId} not found, aborting`);
    queries.updateSession(sessionId, { status: 'error', error: 'Conversation not found' });
    queries.setIsStreaming(conversationId, false);
    return;
  }
  
  if (activeExecutions.has(conversationId)) {
    const existing = activeExecutions.get(conversationId);
    if (existing.sessionId !== sessionId) {
      debugLog(`[stream] Conversation ${conversationId} already has active execution (different session), aborting duplicate`);
      return;
    }
  }
  
  if (rateLimitState.has(conversationId)) {
    const rlState = rateLimitState.get(conversationId);
    if (rlState.retryAt > Date.now()) {
      debugLog(`[stream] Conversation ${conversationId} is in rate limit cooldown, aborting`);
      return;
    }
  }
  
  activeExecutions.set(conversationId, { pid: null, startTime, sessionId, lastActivity: startTime });
  queries.setIsStreaming(conversationId, true);
  queries.updateSession(sessionId, { status: 'active' });
  const batcher = createChunkBatcher();

  try {
    debugLog(`[stream] Starting: conversationId=${conversationId}, sessionId=${sessionId}`);

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
        if (parsed.subtype === 'task_notification') return;

        if (parsed.session_id && parsed.session_id !== resumeSessionId) {
          queries.setClaudeSessionId(conversationId, parsed.session_id, sessionId);
          debugLog(`[stream] Eagerly persisted claudeSessionId=${parsed.session_id} for conv=${conversationId}`);
        }

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
          blockRole: 'system',
          blockIndex: allBlocks.length,
          seq: currentSequence,
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
            blockRole: 'assistant',
            blockIndex: allBlocks.length - 1,
            seq: currentSequence,
            timestamp: Date.now()
          });

          if (block.type === 'text' && block.text) {
            // Check for rate limit message in text content
            const rateLimitTextMatch = block.text.match(/you'?ve hit your limit|rate limit exceeded/i);
            if (rateLimitTextMatch) {
              debugLog(`[rate-limit] Detected rate limit message in stream for conv ${conversationId}`);
              
              const retryAfterSec = parseRateLimitResetTime(block.text);
              debugLog(`[rate-limit] Parsed reset time, retry in ${retryAfterSec}s`);
              
              // Kill the running process
              const entry = activeExecutions.get(conversationId);
              if (entry && entry.pid) {
                try {
                  process.kill(entry.pid);
                  debugLog(`[rate-limit] Killed process ${entry.pid} for conv ${conversationId}`);
                } catch (e) {
                  debugLog(`[rate-limit] Failed to kill process: ${e.message}`);
                }
              }
              
              // Set flag to stop processing and trigger retry
              rateLimitState.set(conversationId, { 
                retryAt: Date.now() + (retryAfterSec * 1000), 
                cooldownMs: retryAfterSec * 1000, 
                retryCount: 0,
                isStreamDetected: true
              });
              
              // Broadcast rate limit event
              broadcastSync({
                type: 'rate_limit_hit',
                sessionId,
                conversationId,
                retryAfterMs: retryAfterSec * 1000,
                retryAt: Date.now() + (retryAfterSec * 1000),
                retryCount: 1,
                timestamp: Date.now()
              });
              
              batcher.drain();
              activeExecutions.delete(conversationId);
              queries.setIsStreaming(conversationId, false);
              
              // Schedule retry
              setTimeout(() => {
                rateLimitState.delete(conversationId);
                broadcastSync({
                  type: 'rate_limit_clear',
                  conversationId,
                  timestamp: Date.now()
                });
                scheduleRetry(conversationId, messageId, content, agentId, model, subAgent);
              }, retryAfterSec * 1000);
              
              return; // Stop processing events
            }
            
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
              blockRole: 'tool_result',
              blockIndex: allBlocks.length,
              seq: currentSequence,
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
          blockRole: 'result',
          blockIndex: allBlocks.length,
          isResult: true,
          seq: currentSequence,
          timestamp: Date.now()
        });

        if (parsed.result) {
          const resultText = typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result);
          
          // Check for rate limit message in result
          const rateLimitResultMatch = resultText.match(/you'?ve hit your limit|rate limit exceeded/i);
          if (rateLimitResultMatch) {
            debugLog(`[rate-limit] Detected rate limit in result for conv ${conversationId}`);
            
            const retryAfterSec = parseRateLimitResetTime(resultText);
            
            const entry = activeExecutions.get(conversationId);
            if (entry && entry.pid) {
              try {
                process.kill(entry.pid);
              } catch (e) {}
            }
            
            rateLimitState.set(conversationId, { 
              retryAt: Date.now() + (retryAfterSec * 1000), 
              cooldownMs: retryAfterSec * 1000, 
              retryCount: 0,
              isStreamDetected: true
            });
            
            broadcastSync({
              type: 'rate_limit_hit',
              sessionId,
              conversationId,
              retryAfterMs: retryAfterSec * 1000,
              retryAt: Date.now() + (retryAfterSec * 1000),
              retryCount: 1,
              timestamp: Date.now()
            });
            
            batcher.drain();
            activeExecutions.delete(conversationId);
            queries.setIsStreaming(conversationId, false);
            
            setTimeout(() => {
              rateLimitState.delete(conversationId);
              broadcastSync({
                type: 'rate_limit_clear',
                conversationId,
                timestamp: Date.now()
              });
              scheduleRetry(conversationId, messageId, content, agentId, model, subAgent);
            }, retryAfterSec * 1000);
            
            return;
          }
          
          if (resultText) eagerTTS(resultText, conversationId, sessionId);
        }

        if (parsed.result && allBlocks.length === 0) {
          allBlocks.push({ type: 'text', text: String(parsed.result) });
        }
      } else if (parsed.type === 'tool_status') {
        // Handle ACP tool status updates (in_progress, pending)
        broadcastSync({
          type: 'streaming_progress',
          sessionId,
          conversationId,
          block: {
            type: 'tool_status',
            tool_use_id: parsed.tool_use_id,
            status: parsed.status
          },
          seq: currentSequence,
          timestamp: Date.now()
        });
      } else if (parsed.type === 'usage') {
        // Handle ACP usage updates
        broadcastSync({
          type: 'streaming_progress',
          sessionId,
          conversationId,
          block: {
            type: 'usage',
            usage: parsed.usage
          },
          seq: currentSequence,
          timestamp: Date.now()
        });
      } else if (parsed.type === 'plan') {
        // Handle ACP plan updates
        broadcastSync({
          type: 'streaming_progress',
          sessionId,
          conversationId,
          block: {
            type: 'plan',
            entries: parsed.entries
          },
          seq: currentSequence,
          timestamp: Date.now()
        });
      }
    };

    const resolvedModel = model || conv?.model || null;
    const resolvedSubAgent = subAgent || conv?.subAgent || null;
    const unifiedSystemPrompt = buildSystemPrompt(agentId, resolvedModel, resolvedSubAgent);
    const config = {
      verbose: true,
      outputFormat: 'stream-json',
      timeout: 1800000,
      print: true,
      resumeSessionId,
      systemPrompt: unifiedSystemPrompt,
      model: resolvedModel || undefined,
      subAgent: resolvedSubAgent || undefined,
      onEvent,
      onPid: (pid) => {
        const entry = activeExecutions.get(conversationId);
        if (entry) entry.pid = pid;
      },
      onProcess: (proc) => {
        // Store process handle for steering - both maps so steer handler always finds it
        activeProcessesByConvId.set(conversationId, proc);
        const entry = activeExecutions.get(conversationId);
        if (entry) entry.proc = proc;
      }
    };

    const { outputs, sessionId: claudeSessionId } = await runClaudeWithStreaming(content, cwd, agentId || 'claude-code', config);

    // Check if rate limit was already handled in stream detection
    if (rateLimitState.get(conversationId)?.isStreamDetected) {
      debugLog(`[rate-limit] Rate limit already handled in stream for conv ${conversationId}, skipping success handler`);
      activeProcessesByConvId.delete(conversationId);
      return;
    }

    activeExecutions.delete(conversationId);
    // Keep process alive for steering for up to 30 seconds after execution completes
    const steeringTimeout = setTimeout(() => {
      activeProcessesByConvId.delete(conversationId);
      steeringTimeouts.delete(conversationId);
    }, 30000);
    steeringTimeouts.set(conversationId, steeringTimeout);
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
      agentId,
      eventCount,
      seq: currentSequence,
      timestamp: Date.now()
    });

    debugLog(`[stream] Completed: ${outputs.length} outputs, ${eventCount} events`);
  } catch (error) {
    const elapsed = Date.now() - startTime;
    debugLog(`[stream] Error after ${elapsed}ms: ${error.message}`);

    // Check if rate limit was already handled in stream detection
    const existingState = rateLimitState.get(conversationId);
    if (existingState?.isStreamDetected) {
      debugLog(`[rate-limit] Rate limit already handled in stream for conv ${conversationId}, skipping catch handler`);
      return;
    }

    const isAuthError = error.authError || error.nonRetryable ||
      /401|unauthorized|invalid.*auth|invalid.*token|auth.*failed|permission denied|access denied/i.test(error.message);

    const isRateLimit = error.rateLimited ||
      /rate.?limit|429|too many requests|overloaded|throttl/i.test(error.message);

    queries.updateSession(sessionId, {
      status: 'error',
      error: error.message,
      completed_at: Date.now()
    });

    if (isAuthError) {
      debugLog(`[auth-error] Auth error for conv ${conversationId}: ${error.message}`);
      broadcastSync({
        type: 'streaming_error',
        sessionId,
        conversationId,
        error: `Authentication failed: ${error.message}. Please check your API credentials.`,
        recoverable: false,
        isAuthError: true,
        timestamp: Date.now()
      });
      const errorMessage = queries.createMessage(conversationId, 'assistant', `Error: Authentication failed. ${error.message}. Please update your credentials and try again.`);
      broadcastSync({
        type: 'message_created',
        conversationId,
        message: errorMessage,
        timestamp: Date.now()
      });
      queries.setIsStreaming(conversationId, false);
      batcher.drain();
      activeExecutions.delete(conversationId);
      return;
    }

    if (isRateLimit) {
      const existingState = rateLimitState.get(conversationId) || {};
      const retryCount = (existingState.retryCount || 0) + 1;
      const maxRateLimitRetries = 3;

      if (retryCount > maxRateLimitRetries) {
        debugLog(`[rate-limit] Conv ${conversationId} hit rate limit ${retryCount} times, giving up`);
        broadcastSync({
          type: 'streaming_error',
          sessionId,
          conversationId,
          error: `Rate limit exceeded after ${retryCount} attempts. Please try again later.`,
          recoverable: false,
          timestamp: Date.now()
        });
        const errorMessage = queries.createMessage(conversationId, 'assistant', `Error: Rate limit exceeded after ${retryCount} attempts. Please try again later.`);
        broadcastSync({
          type: 'message_created',
          conversationId,
          message: errorMessage,
          timestamp: Date.now()
        });
        queries.setIsStreaming(conversationId, false);
        return;
      }

      const cooldownMs = (error.retryAfterSec || 60) * 1000;
      const retryAt = Date.now() + cooldownMs;
      rateLimitState.set(conversationId, { retryAt, cooldownMs, retryCount });
      debugLog(`[rate-limit] Conv ${conversationId} hit rate limit (attempt ${retryCount}/${maxRateLimitRetries}), retry in ${cooldownMs}ms`);

      broadcastSync({
        type: 'rate_limit_hit',
        sessionId,
        conversationId,
        retryAfterMs: cooldownMs,
        retryAt,
        retryCount,
        timestamp: Date.now()
      });

      batcher.drain();

      debugLog(`[rate-limit] Scheduling retry for conv ${conversationId} in ${cooldownMs}ms (attempt ${retryCount + 1})`);
      
      setTimeout(() => {
        debugLog(`[rate-limit] Timeout fired for conv ${conversationId}, calling scheduleRetry`);
        rateLimitState.delete(conversationId);
        debugLog(`[rate-limit] Conv ${conversationId} cooldown expired, restarting (attempt ${retryCount + 1})`);
        broadcastSync({
          type: 'rate_limit_clear',
          conversationId,
          timestamp: Date.now()
        });
        scheduleRetry(conversationId, messageId, content, agentId, model, subAgent);
      }, cooldownMs);
      return;
    }

    broadcastSync({
      type: 'streaming_error',
      sessionId,
      conversationId,
      error: error.message,
      isPrematureEnd: error.isPrematureEnd || false,
      exitCode: error.exitCode,
      stderrText: error.stderrText,
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
    // Use atomic cleanup but only if not in rate limit recovery
    if (!rateLimitState.has(conversationId)) {
      cleanupExecution(conversationId);
      drainMessageQueue(conversationId);
    } else {
      // Rate limit in flight - keep execution entry for now, but clean process handle
      activeProcessesByConvId.delete(conversationId);
      const steeringTimeout = steeringTimeouts.get(conversationId);
      if (steeringTimeout) {
        clearTimeout(steeringTimeout);
        steeringTimeouts.delete(conversationId);
      }
    }
  }
}

function scheduleRetry(conversationId, messageId, content, agentId, model, subAgent) {
  debugLog(`[rate-limit] scheduleRetry called for conv ${conversationId}, messageId=${messageId}`);

  if (!content) {
    const conv = queries.getConversation(conversationId);
    const lastMsg = queries.getLastUserMessage(conversationId);
    content = lastMsg?.content || 'continue';
    debugLog(`[rate-limit] Recovered content from last message: ${content?.substring?.(0, 50)}...`);
  }

  const newSession = queries.createSession(conversationId);
  queries.createEvent('session.created', { messageId, sessionId: newSession.id, retryReason: 'rate_limit' }, conversationId, newSession.id);

  debugLog(`[rate-limit] Broadcasting streaming_start for retry session ${newSession.id}`);
  broadcastSync({
    type: 'streaming_start',
    sessionId: newSession.id,
    conversationId,
    messageId,
    agentId,
    queueLength: messageQueues.get(conversationId)?.length || 0,
    timestamp: Date.now()
  });

  const startTime = Date.now();
  activeExecutions.set(conversationId, { pid: null, startTime, sessionId: newSession.id, lastActivity: startTime });

  debugLog(`[rate-limit] Calling processMessageWithStreaming for retry`);
  processMessageWithStreaming(conversationId, messageId, newSession.id, content, agentId, model, subAgent)
    .catch(err => {
      debugLog(`[rate-limit] Retry failed: ${err.message}`);
      console.error(`[rate-limit] Retry error for conv ${conversationId}:`, err);
      // Clean up state on retry failure
      cleanupExecution(conversationId);
      broadcastSync({
        type: 'streaming_error',
        sessionId: newSession.id,
        conversationId,
        error: `Rate limit retry failed: ${err.message}`,
        recoverable: false,
        timestamp: Date.now()
      });
    });
}

function drainMessageQueue(conversationId) {
  const queue = messageQueues.get(conversationId);
  if (!queue || queue.length === 0) return;

  const next = queue.shift();
  if (queue.length === 0) messageQueues.delete(conversationId);

  debugLog(`[queue] Draining next message for ${conversationId}, messageId=${next.messageId}`);

  // Broadcast queue_item_dequeued so client can update UI immediately
  broadcastSync({
    type: 'queue_item_dequeued',
    conversationId,
    messageId: next.messageId,
    queueLength: queue?.length || 0,
    timestamp: Date.now()
  });

  const session = queries.createSession(conversationId);
  queries.createEvent('session.created', { messageId: next.messageId, sessionId: session.id }, conversationId, session.id);

  broadcastSync({
    type: 'streaming_start',
    sessionId: session.id,
    conversationId,
    messageId: next.messageId,
    agentId: next.agentId,
    queueLength: queue?.length || 0,
    timestamp: Date.now()
  });

  broadcastSync({
    type: 'queue_status',
    conversationId,
    queueLength: queue?.length || 0,
    timestamp: Date.now()
  });

  const startTime = Date.now();
  activeExecutions.set(conversationId, { pid: null, startTime, sessionId: session.id, lastActivity: startTime });

  processMessageWithStreaming(conversationId, next.messageId, session.id, next.content, next.agentId, next.model, next.subAgent)
    .catch(err => {
      debugLog(`[queue] Error processing queued message: ${err.message}`);
      // CRITICAL: Clean up state on error so next message can be retried
      cleanupExecution(conversationId);
      broadcastSync({
        type: 'streaming_error',
        sessionId: session.id,
        conversationId,
        error: `Queue processing failed: ${err.message}`,
        recoverable: true,
        timestamp: Date.now()
      });
      // Try to drain next message in queue
      setTimeout(() => drainMessageQueue(conversationId), 100);
    });
}


const wss = new WebSocketServer({
  server,
  perMessageDeflate: false  // Disabled: msgpack binary doesn't compress well, and
                             // synchronous zlib on every frame blocks the event loop.
                             // HTTP-layer gzip already handles static assets; WS
                             // streaming events are small and latency-sensitive.
});
wss.on('error', (err) => {
  console.error('[WSS] WebSocket server error (contained):', err.message);
});
const hotReloadClients = [];
const syncClients = new Set();
const subscriptionIndex = new Map();
const pm2Subscribers = new Set();

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

    sendWs(ws, ({
      type: 'sync_connected',
      clientId: ws.clientId,
      timestamp: Date.now()
    }));

    ws.on('error', (err) => {
      console.error('[WS] Client error (contained):', ws.clientId, err.message);
    });
    ws.on('message', (msg) => {
      try { wsRouter.onMessage(ws, msg); } catch (e) { console.error('[WS] Message handler error (contained):', e.message); }
    });

    ws.on('pong', () => { ws.isAlive = true; });
     ws.on('close', () => {
       if (ws.terminalProc) { try { ws.terminalProc.kill(); } catch(e) {} ws.terminalProc = null; }
       syncClients.delete(ws);
       wsOptimizer.removeClient(ws);
       for (const sub of ws.subscriptions) {
         const idx = subscriptionIndex.get(sub);
         if (idx) { idx.delete(ws); if (idx.size === 0) subscriptionIndex.delete(sub); }
       }
       if (ws.pm2Subscribed) {
         pm2Subscribers.delete(ws);
       }
       console.log(`[WebSocket] Client ${ws.clientId} disconnected`);
     });
  }
});

const BROADCAST_TYPES = new Set([
  'message_created', 'conversation_created', 'conversation_updated',
  'conversations_updated', 'conversation_deleted', 'all_conversations_deleted', 'queue_status', 'queue_updated',
  'rate_limit_hit', 'rate_limit_clear',
  'script_started', 'script_stopped', 'script_output',
  'model_download_progress', 'stt_progress', 'tts_setup_progress', 'voice_list',
  'streaming_start', 'streaming_progress', 'streaming_complete', 'streaming_error',
  'tool_install_started', 'tool_install_progress', 'tool_install_complete', 'tool_install_failed',
  'tool_update_progress', 'tool_update_complete', 'tool_update_failed',
  'tool_status_update',
  'tools_update_started', 'tools_update_complete', 'tools_refresh_complete',
  'pm2_monit_update', 'pm2_monitoring_started', 'pm2_monitoring_stopped',
  'pm2_list_response', 'pm2_start_response', 'pm2_stop_response',
  'pm2_restart_response', 'pm2_delete_response', 'pm2_logs_response',
  'pm2_flush_logs_response', 'pm2_ping_response', 'pm2_unavailable'
]);

const wsOptimizer = new WSOptimizer();

// Global sequence counter for atomic event ordering across all broadcasts
let broadcastSeq = 0;

function broadcastSync(event) {
  try {
    // Assign global sequence number to ALL events for ordering guarantee
    if (!event.seq) {
      event.seq = ++broadcastSeq;
    }

    const isBroadcast = BROADCAST_TYPES.has(event.type);

    if (syncClients.size > 0) {
      if (isBroadcast) {
        for (const ws of syncClients) { try { wsOptimizer.sendToClient(ws, event); } catch (e) {} }
      } else {
        const targets = new Set();
        if (event.sessionId) {
          const subs = subscriptionIndex.get(event.sessionId);
          if (subs) for (const ws of subs) targets.add(ws);
        }
        if (event.conversationId) {
          const subs = subscriptionIndex.get(`conv-${event.conversationId}`);
          if (subs) for (const ws of subs) targets.add(ws);
        }
        for (const ws of targets) { try { wsOptimizer.sendToClient(ws, event); } catch (e) {} }
      }
    }

  } catch (err) {
    console.error('[BROADCAST] Error (contained):', err.message);
  }
}

// WebSocket protocol router
const wsRouter = new WsRouter();

registerConvHandlers(wsRouter, {
  queries, activeExecutions, messageQueues, rateLimitState,
  broadcastSync, processMessageWithStreaming, activeProcessesByConvId, steeringTimeouts,
  cleanupExecution
});

console.log('[INIT] About to call registerSessionHandlers, discoveredAgents.length:', discoveredAgents.length);
registerSessionHandlers(wsRouter, {
  db: queries, discoveredAgents, modelCache,
  getAgentDescriptor, activeScripts, broadcastSync,
  startGeminiOAuth, geminiOAuthState: () => geminiOAuthState
});
console.log('[INIT] registerSessionHandlers completed');

registerRunHandlers(wsRouter, {
  queries, discoveredAgents, activeExecutions, activeProcessesByRunId,
  broadcastSync, processMessageWithStreaming
});

registerUtilHandlers(wsRouter, {
  queries, wsOptimizer, modelDownloadState, ensureModelsDownloaded,
  broadcastSync, getSpeech, getProviderConfigs, saveProviderConfig,
  startGeminiOAuth, exchangeGeminiOAuthCode,
  geminiOAuthState: () => geminiOAuthState,
  STARTUP_CWD, activeScripts, voiceCacheManager, toolManager, discoveredAgents
});

wsRouter.onLegacy((data, ws) => {
  try {
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
    sendWs(ws, ({
      type: 'subscription_confirmed',
      sessionId: data.sessionId,
      conversationId: data.conversationId,
      timestamp: Date.now()
    }));

    // Notify client if this conversation has an active streaming execution
    if (data.conversationId && activeExecutions.has(data.conversationId)) {
      const execution = activeExecutions.get(data.conversationId);
      const conv = queries.getConversation(data.conversationId);
      const queue = messageQueues.get(data.conversationId);
      sendWs(ws, ({
        type: 'streaming_start',
        sessionId: execution.sessionId,
        conversationId: data.conversationId,
        agentId: conv?.agentType || conv?.agentId || 'claude-code',
        queueLength: queue?.length || 0,
        resumed: true,
        seq: ++broadcastSeq,
        timestamp: Date.now()
      }));
    }

    // Inject pending checkpoint events if this is a conversation subscription
    if (data.conversationId && checkpointManager.hasPendingCheckpoint(data.conversationId)) {
      const checkpoint = checkpointManager.getPendingCheckpoint(data.conversationId);
      if (checkpoint) {
        console.log(`[checkpoint] Injecting ${checkpoint.events.length} events to client for ${data.conversationId}`);

        const latestSession = queries.getLatestSession(data.conversationId);
        if (latestSession) {
          sendWs(ws, ({
            type: 'streaming_resumed',
            sessionId: latestSession.id,
            conversationId: data.conversationId,
            resumeFrom: checkpoint.sessionId,
            eventCount: checkpoint.events.length,
            chunkCount: checkpoint.chunks.length,
            timestamp: Date.now()
          }));

          checkpointManager.injectCheckpointEvents(latestSession.id, checkpoint, (evt) => {
            sendWs(ws, ({
              ...evt,
              sessionId: latestSession.id,
              conversationId: data.conversationId
            }));
          });
        }
      }
    }
  } else if (data.type === 'unsubscribe') {
    if (data.sessionId) {
      ws.subscriptions.delete(data.sessionId);
      const idx = subscriptionIndex.get(data.sessionId);
      if (idx) { idx.delete(ws); if (idx.size === 0) subscriptionIndex.delete(data.sessionId); }
    }
    if (data.conversationId) {
      const key = `conv-${data.conversationId}`;
      ws.subscriptions.delete(key);
      const idx = subscriptionIndex.get(key);
      if (idx) { idx.delete(ws); if (idx.size === 0) subscriptionIndex.delete(key); }
    }
    debugLog(`[WebSocket] Client ${ws.clientId} unsubscribed from ${data.sessionId || data.conversationId}`);
  } else if (data.type === 'get_subscriptions') {
    sendWs(ws, ({
      type: 'subscriptions',
      subscriptions: Array.from(ws.subscriptions),
      timestamp: Date.now()
    }));
  } else if (data.type === 'set_voice') {
    ws.ttsVoiceId = data.voiceId || 'default';
  } else if (data.type === 'latency_report') {
    ws.latencyTier = data.quality || 'good';
    ws.latencyAvg = data.avg || 0;
    ws.latencyTrend = data.trend || 'stable';
  } else if (data.type === 'ping') {
    sendWs(ws, ({
      type: 'pong',
      requestId: data.requestId,
      timestamp: Date.now()
    }));
  } else if (data.type === 'terminal_start') {
    if (ws.terminalProc) {
      try { ws.terminalProc.kill(); } catch(e) {}
    }
    try {
      const _req = createRequire(import.meta.url);
      const pty = _req('node-pty');
      const shell = process.env.SHELL || '/bin/bash';
      const cwd = data.cwd || process.env.STARTUP_CWD || process.env.HOME || '/';
      const proc = pty.spawn(shell, [], {
        name: 'xterm-256color',
        cols: data.cols || 80,
        rows: data.rows || 24,
        cwd: cwd,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
      });
      ws.terminalProc = proc;
      ws.terminalPty = true;
      proc.on('data', (chunk) => {
        if (ws.readyState === 1) sendWs(ws, ({ type: 'terminal_output', data: Buffer.from(chunk).toString('base64'), encoding: 'base64' }));
      });
      proc.on('exit', (code) => {
        if (ws.readyState === 1) sendWs(ws, { type: 'terminal_exit', code });
        ws.terminalProc = null;
      });
      proc.on('error', (err) => {
        console.error('[TERMINAL] PTY error (contained):', err.message);
        if (ws.readyState === 1) sendWs(ws, { type: 'terminal_exit', code: 1, error: err.message });
        ws.terminalProc = null;
      });
      sendWs(ws, ({ type: 'terminal_started', timestamp: Date.now() }));
    } catch (e) {
      console.error('[TERMINAL] Failed to spawn PTY, falling back to pipes:', e.message);
      const shell = process.env.SHELL || '/bin/bash';
      const cwd = data.cwd || process.env.STARTUP_CWD || process.env.HOME || '/';
      const proc = spawn(shell, ['-i'], { cwd, env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }, stdio: ['pipe', 'pipe', 'pipe'] });
      ws.terminalProc = proc;
      ws.terminalPty = false;
      proc.stdout.on('data', (chunk) => {
        if (ws.readyState === 1) sendWs(ws, ({ type: 'terminal_output', data: chunk.toString('base64'), encoding: 'base64' }));
      });
      proc.stderr.on('data', (chunk) => {
        if (ws.readyState === 1) sendWs(ws, ({ type: 'terminal_output', data: chunk.toString('base64'), encoding: 'base64' }));
      });
      proc.on('exit', (code) => {
        if (ws.readyState === 1) sendWs(ws, { type: 'terminal_exit', code });
        ws.terminalProc = null;
      });
      proc.on('error', (err) => {
        console.error('[TERMINAL] Spawn error (contained):', err.message);
        if (ws.readyState === 1) sendWs(ws, { type: 'terminal_exit', code: 1, error: err.message });
        ws.terminalProc = null;
      });
      proc.stdin.on('error', () => {});
      proc.stdout.on('error', () => {});
      proc.stderr.on('error', () => {});
      sendWs(ws, ({ type: 'terminal_started', timestamp: Date.now() }));
    }
  } else if (data.type === 'terminal_input') {
    if (ws.terminalProc) {
      try {
        const input = Buffer.from(data.data, 'base64');
        if (ws.terminalPty) {
          ws.terminalProc.write(input);
        } else if (ws.terminalProc.stdin && ws.terminalProc.stdin.writable) {
          ws.terminalProc.stdin.write(input);
        }
      } catch (e) {}
    }
  } else if (data.type === 'terminal_resize') {
    if (ws.terminalProc && ws.terminalPty) {
      try {
        const { cols, rows } = data;
        if (cols && rows && typeof ws.terminalProc.resize === 'function') {
          ws.terminalProc.resize(cols, rows);
        }
      } catch (e) {}
    }
   } else if (data.type === 'terminal_stop') {
     if (ws.terminalProc) {
       try { ws.terminalProc.kill(); } catch(e) {}
       ws.terminalProc = null;
     }
    } else if (data.type === 'pm2_list') {
      if (!pm2Manager.connected) {
        if (ws.readyState === 1) sendWs(ws, ({ type: 'pm2_unavailable', reason: 'PM2 not connected', timestamp: Date.now() }));
      } else {
        pm2Manager.listProcesses().then(processes => {
          if (ws.readyState === 1) {
            const hasActive = processes.some(p => ['online','launching','stopping','waiting restart'].includes(p.status));
            sendWs(ws, { type: 'pm2_list_response', processes, hasActive });
          }
        }).catch(() => {
          if (ws.readyState === 1) sendWs(ws, ({ type: 'pm2_unavailable', reason: 'list failed', timestamp: Date.now() }));
        });
      }
    } else if (data.type === 'pm2_start_monitoring') {
      pm2Subscribers.add(ws);
      ws.pm2Subscribed = true;
      if (!pm2Manager.connected) {
        if (ws.readyState === 1) sendWs(ws, ({ type: 'pm2_unavailable', reason: 'PM2 not connected', timestamp: Date.now() }));
      } else {
        sendWs(ws, { type: 'pm2_monitoring_started' });
      }
    } else if (data.type === 'pm2_stop_monitoring') {
      pm2Subscribers.delete(ws);
      ws.pm2Subscribed = false;
      sendWs(ws, { type: 'pm2_monitoring_stopped' });
    } else if (data.type === 'pm2_start') {
      pm2Manager.startProcess(data.name).then(result => {
        sendWs(ws, { type: 'pm2_start_response', name: data.name, ...result });
      });
    } else if (data.type === 'pm2_stop') {
      pm2Manager.stopProcess(data.name).then(result => {
        sendWs(ws, { type: 'pm2_stop_response', name: data.name, ...result });
      });
    } else if (data.type === 'pm2_restart') {
      pm2Manager.restartProcess(data.name).then(result => {
        sendWs(ws, { type: 'pm2_restart_response', name: data.name, ...result });
      });
    } else if (data.type === 'pm2_delete') {
      pm2Manager.deleteProcess(data.name).then(result => {
        sendWs(ws, { type: 'pm2_delete_response', name: data.name, ...result });
      });
    } else if (data.type === 'pm2_logs') {
      pm2Manager.getLogs(data.name, { lines: data.lines || 100 }).then(result => {
        sendWs(ws, { type: 'pm2_logs_response', name: data.name, ...result });
      });
    } else if (data.type === 'pm2_flush_logs') {
      pm2Manager.flushLogs(data.name).then(result => {
        sendWs(ws, { type: 'pm2_flush_logs_response', name: data.name, ...result });
      });
    } else if (data.type === 'pm2_ping') {
      pm2Manager.ping().then(result => {
        sendWs(ws, { type: 'pm2_ping_response', ...result });
      });
    }

  } catch (err) { console.error('[WS-LEGACY] Handler error (contained):', err.message); }
});

// Heartbeat interval to detect stale connections
const heartbeatInterval = setInterval(() => {
  syncClients.forEach(ws => {
    if (!ws.isAlive) {
      syncClients.delete(ws);
      wsOptimizer.removeClient(ws);
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
        if (curr.mtime > prev.mtime) {
          _assetCache.clear();
          _htmlCache = null;
          _htmlCacheEtag = null;
          hotReloadClients.forEach(c => { if (c.readyState === 1) c.send(JSON.stringify({ type: 'reload' })); });
        }
      });
      watchedFiles.set(fp, true);
    });
  } catch (e) { console.error('Watch error:', e.message); }
}

process.on('SIGTERM', () => {
  console.log('[SIGNAL] SIGTERM received - graceful shutdown');
  try { pm2Manager.disconnect(); } catch (_) {}
  stopACPTools().catch(() => {}).finally(() => {
    try { wss.close(() => server.close(() => process.exit(0))); } catch (_) { process.exit(0); }
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} already in use. Waiting 3 seconds before retry...`);
    setTimeout(() => {
      server.listen(PORT, onServerReady);
    }, 3000);
  } else {
    console.error('[SERVER] Error (contained):', err.message);
  }
});

// On startup: mark all active/pending sessions as interrupted (server was down, they didn't complete).
// Then resumeInterruptedStreams will pick up recent ones for auto-resume.
function recoverStaleSessions() {
  try {
    const RESUME_WINDOW_MS = 600000;
    const cutoff = Date.now() - RESUME_WINDOW_MS;
    const staleSessions = queries.getActiveSessions();
    for (const session of staleSessions) {
      queries.updateSession(session.id, {
        status: session.started_at > cutoff ? 'interrupted' : 'error',
        error: 'Server restarted',
        completed_at: Date.now()
      });
    }
    // Clear all isStreaming flags - nothing is running yet
    queries.clearAllStreamingFlags();
    if (staleSessions.length > 0) {
      console.log(`[RECOVERY] Marked ${staleSessions.length} stale session(s); cleared streaming flags`);
    }
  } catch (err) {
    console.error('[RECOVERY] Error:', err.message);
  }
}

// Resume conversations with recently interrupted sessions (started within 10 min).
async function resumeInterruptedStreams() {
  try {
    const toResume = queries.getResumableConversations(600000);
    if (toResume.length === 0) return;
    console.log(`[RESUME] Resuming ${toResume.length} interrupted conversation(s)`);
    for (let i = 0; i < toResume.length; i++) {
      const conv = toResume[i];
      try {
        const lastSession = queries.getLatestSession(conv.id);
        await resumeConversation(conv.id, lastSession?.id || null, 'Server restarted');
        if (i < toResume.length - 1) await new Promise(r => setTimeout(r, 200));
      } catch (err) {
        console.error(`[RESUME] Failed to resume conv ${conv.id}: ${err.message}`);
        queries.setIsStreaming(conv.id, false);
      }
    }
  } catch (err) {
    console.error('[RESUME] Error:', err.message);
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

  const RESUME_WINDOW_MS = 600000; // 10 minutes
  const sessionAge = entry.startTime ? Date.now() - entry.startTime : Infinity;
  const shouldRestart = sessionAge < RESUME_WINDOW_MS;

  queries.setIsStreaming(conversationId, false);
  if (entry.sessionId) {
    queries.updateSession(entry.sessionId, {
      status: shouldRestart ? 'interrupted' : 'error',
      error: reason,
      completed_at: Date.now()
    });
  }

  if (shouldRestart) {
    // Session was recent — restart it automatically
    resumeConversation(conversationId, entry.sessionId, reason).catch(err => {
      console.error(`[RESUME] Auto-restart failed for conv ${conversationId}: ${err.message}`);
      queries.setIsStreaming(conversationId, false);
    });
    return;
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

// Resume a single conversation after interruption. Used both by markAgentDead and resumeInterruptedStreams.
async function resumeConversation(conversationId, previousSessionId, reason) {
  const conv = queries.getConversation(conversationId);
  if (!conv) throw new Error('Conversation not found');

  const checkpoint = previousSessionId ? checkpointManager.loadCheckpoint(previousSessionId) : null;

  if (previousSessionId) {
    // Only mark interrupted if not already done
    const prev = queries.getSession ? queries.getSession(previousSessionId) : null;
    if (prev && prev.status !== 'interrupted') {
      queries.updateSession(previousSessionId, { status: 'interrupted', error: reason || 'Restarting', completed_at: Date.now() });
    }
    if (checkpoint) {
      checkpointManager.markSessionResumed(previousSessionId);
    }
  }

  const lastMsg = queries.getLastUserMessage(conversationId);
  const promptText = typeof lastMsg?.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg?.content || 'continue');

  const session = queries.createSession(conversationId);
  queries.createEvent('session.created', {
    sessionId: session.id,
    resumeReason: 'interrupted',
    claudeSessionId: conv.claudeSessionId,
    checkpointFrom: previousSessionId || null
  }, conversationId, session.id);

  activeExecutions.set(conversationId, {
    pid: null,
    startTime: Date.now(),
    sessionId: session.id,
    lastActivity: Date.now()
  });

  broadcastSync({
    type: 'streaming_start',
    sessionId: session.id,
    conversationId,
    agentId: conv.agentType,
    resumed: true,
    checkpointAvailable: !!checkpoint,
    timestamp: Date.now()
  });

  if (checkpoint) {
    checkpointManager.storeCheckpointForDelay(conversationId, checkpoint);
    console.log(`[RESUME] Checkpoint stored for conv ${conversationId}`);
  }

  console.log(`[RESUME] Restarting conv ${conversationId} (reason: ${reason})`);
  await processMessageWithStreaming(conversationId, lastMsg?.id || null, session.id, promptText, conv.agentType, conv.model, conv.subAgent);
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
        // Kill stuck agent and clear streaming state
        try { process.kill(entry.pid, 'SIGTERM'); } catch (e) {}
        markAgentDead(conversationId, entry, 'Agent was stuck (no activity for 10 minutes)');
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
  // Clear tool status cache on startup to ensure fresh detection
  toolManager.clearStatusCache();

  console.log(`GMGUI running on http://localhost:${PORT}${BASE_URL}/`);
  console.log(`Agents: ${discoveredAgents.map(a => a.name).join(', ') || 'none'}`);
  console.log(`Hot reload: ${watch ? 'on' : 'off'}`);

  const deletedCount = queries.cleanupEmptyConversations();
  if (deletedCount > 0) {
    console.log(`Cleaned up ${deletedCount} empty conversation(s) on startup`);
  }

  recoverStaleSessions();

  resumeInterruptedStreams().catch(err => console.error('[RESUME] Startup error:', err.message));

  installGMAgentConfigs().catch(err => console.error('[GM-CONFIG] Startup error:', err.message));

  startACPTools().then(() => {
    console.log('[ACP] On-demand startup enabled (ACP tools start when first used)');
    setTimeout(() => {
      const acpStatus = getACPStatus();
      for (const s of acpStatus) {
        if (s.healthy) {
          const agent = discoveredAgents.find(a => a.id === s.id);
          if (agent) { agent.acpPort = s.port; }
        }
      }
      if (acpStatus.length > 0) {
        console.log(`[ACP] Tools ready: ${acpStatus.filter(s => s.healthy).map(s => s.id + ':' + s.port).join(', ') || 'none healthy yet'}`);
      }
    }, 6000);
  }).catch(err => console.error('[ACP] Startup error:', err.message));

  const toolIds = ['cli-claude', 'cli-opencode', 'cli-gemini', 'cli-kilo', 'cli-codex', 'cli-agent-browser', 'gm-cc', 'gm-oc', 'gm-gc', 'gm-kilo'];
  queries.initializeToolInstallations(toolIds.map(id => ({ id })));
  console.log('[TOOLS] Starting background provisioning...');

  // Create broadcast handler for tool events
  const toolBroadcaster = (evt) => {
    broadcastSync(evt);
    if (evt.type === 'tool_install_complete' || evt.type === 'tool_update_complete') {
      const d = evt.data || {};
      queries.updateToolStatus(evt.toolId, { status: 'installed', version: d.version || null, installed_at: Date.now() });
      queries.addToolInstallHistory(evt.toolId, evt.type.includes('update') ? 'update' : 'install', 'success', null);
    } else if (evt.type === 'tool_install_failed' || evt.type === 'tool_update_failed') {
      queries.updateToolStatus(evt.toolId, { status: 'failed', error_message: evt.data?.error });
      queries.addToolInstallHistory(evt.toolId, evt.type.includes('update') ? 'update' : 'install', 'failed', evt.data?.error);
    } else if (evt.type === 'tool_status_update') {
      const d = evt.data || {};
      if (d.installed) {
        queries.updateToolStatus(evt.toolId, { status: 'installed', version: d.installedVersion || null, installed_at: Date.now() });
      }
    }
  };

  // Initial provisioning (blocks until complete)
  toolManager.autoProvision(toolBroadcaster)
    .catch(err => console.error('[TOOLS] Auto-provision error:', err.message))
    .then(() => {
      // Start periodic update checker AFTER initial provisioning completes
      // This runs in background and doesn't block GUI
      console.log('[TOOLS] Starting periodic update checker...');
      toolManager.startPeriodicUpdateCheck(toolBroadcaster);
    });

  ensureModelsDownloaded().then(async ok => {
    if (ok) console.log('[MODELS] Speech models ready');
    else console.log('[MODELS] Speech model download failed');
    try {
      const { getVoices } = await getSpeech();
      const voices = getVoices();
      broadcastSync({ type: 'voice_list', voices });
    } catch (err) {
      debugLog('[VOICE] Failed to broadcast voices: ' + err.message);
      broadcastSync({ type: 'voice_list', voices: [] });
    }
  }).catch(async err => {
    console.error('[MODELS] Download error:', err.message);
    try {
      const { getVoices } = await getSpeech();
      const voices = getVoices();
      broadcastSync({ type: 'voice_list', voices });
    } catch (err2) {
      debugLog('[VOICE] Failed to broadcast voices: ' + err2.message);
      broadcastSync({ type: 'voice_list', voices: [] });
    }
  });

   getSpeech().then(s => s.preloadTTS()).catch(e => debugLog('[TTS] Preload failed: ' + e.message));

   performAutoImport();

   setInterval(performAutoImport, 30000);

   setInterval(performAgentHealthCheck, 30000);

    // Initialize PM2 monitoring - only when PM2 daemon is available
    const broadcastPM2 = (update) => {
      const msg = JSON.stringify(update);
      for (const client of pm2Subscribers) {
        if (client.readyState === 1) { try { client.send(msg); } catch (_) {} }
      }
    };

    const startPM2Monitoring = async () => {
      try {
        await pm2Manager.connect();
        await pm2Manager.startMonitoring(broadcastPM2);
        console.log('[PM2] Monitoring started');
      } catch (err) {
        console.log('[PM2] Not available:', err.message);
        broadcastPM2({ type: 'pm2_unavailable', reason: err.message, timestamp: Date.now() });
      }
    };

    setTimeout(startPM2Monitoring, 2000);

    setInterval(async () => {
      if (!pm2Manager.connected && !pm2Manager.monitoring) {
        try {
          const healed = await pm2Manager.heal();
          if (healed.success) await pm2Manager.startMonitoring(broadcastPM2);
        } catch (_) {}
      }
    }, 30000);
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

// Load plugins as extensions (additive, not replacing core routes)
import PluginLoader from './lib/plugin-loader.js';
const pluginLoader = new PluginLoader(path.join(__dirname, 'lib', 'plugins'));
async function loadPluginExtensions() {
  try {
    await pluginLoader.loadAllPlugins({ router: app, baseUrl: BASE_URL, logger: console, env: process.env });
    const names = Array.from(pluginLoader.registry.keys());
    if (names.length > 0) {
      for (const name of names) {
        const state = pluginLoader.get(name);
        if (!state || !state.routes) continue;
        for (const route of state.routes) {
          const fullPath = BASE_URL + route.path;
          const method = (route.method || 'GET').toLowerCase();
          if (app[method]) app[method](fullPath, route.handler);
        }
      }
      console.log(`[PLUGINS] Loaded extensions: ${names.join(', ')}`);
    }
  } catch (err) {
    console.error('[PLUGINS] Extension loading failed (non-fatal):', err.message);
  }
}

server.listen(PORT, () => {
  onServerReady();
  loadPluginExtensions();
});
