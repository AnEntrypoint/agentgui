import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const isWindows = os.platform() === 'win32';

const ACP_TOOLS = [
  { id: 'opencode', cmd: 'opencode', args: ['acp'], port: 18100, npxPkg: 'opencode-ai' },
  { id: 'kilo', cmd: 'kilo', args: ['acp'], port: 18101, npxPkg: '@kilocode/cli' },
  { id: 'codex', cmd: 'codex', args: ['acp'], port: 18102, npxPkg: '@openai/codex' },
];

const HEALTH_INTERVAL_MS = 30000;
const STARTUP_GRACE_MS = 5000;
const MAX_RESTARTS = 10;
const RESTART_WINDOW_MS = 300000;
const IDLE_TIMEOUT_MS = 120000;

const processes = new Map();
let healthTimer = null;
let shuttingDown = false;

function log(msg) { console.log('[ACP-SDK] ' + msg); }

function resolveCommand(tool) {
  const ext = isWindows ? '.cmd' : '';
  const localBin = path.join(projectRoot, 'node_modules', '.bin', tool.cmd + ext);
  if (fs.existsSync(localBin)) return { bin: localBin, args: tool.args };
  const bunx = path.join(projectRoot, 'node_modules', '.bin', 'bunx' + ext);
  const runner = fs.existsSync(bunx) ? bunx : 'bunx';
  if (tool.npxPkg) return { bin: runner, args: [tool.npxPkg, ...tool.args] };
  return { bin: tool.cmd, args: tool.args };
}

function startProcess(tool) {
  if (shuttingDown) return null;
  const existing = processes.get(tool.id);
  if (existing?.process && !existing.process.killed) return existing;

  const resolved = resolveCommand(tool);
  const entry = {
    id: tool.id,
    port: tool.port,
    startedAt: Date.now(),
    lastUsed: Date.now(),
    lastHealthCheck: 0,
    healthy: false,
    process: null,
    pid: null,
    restarts: [],
    idleTimer: null,
    providerInfo: null,
    _stopping: false
  };

  try {
    entry.process = spawn(resolved.bin, resolved.args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    });
    entry.pid = entry.process.pid;

    entry.process.on('close', (code) => {
      entry.healthy = false;
      if (shuttingDown || entry._stopping) return;
      log(tool.id + ' exited code ' + code);
      const window = Date.now() - RESTART_WINDOW_MS;
      entry.restarts = entry.restarts.filter(t => t > window);
      if (entry.restarts.length < MAX_RESTARTS) {
        const delay = Math.min(1000 * Math.pow(2, entry.restarts.length), 30000);
        entry.restarts.push(Date.now());
        setTimeout(() => startProcess(tool), delay);
      } else {
        log(tool.id + ' max restarts reached');
      }
    });

    processes.set(tool.id, entry);
    log(tool.id + ' started port ' + tool.port + ' pid ' + entry.pid);
    setTimeout(() => checkHealth(tool.id), STARTUP_GRACE_MS);
    resetIdleTimer(tool.id);
  } catch (err) {
    log(tool.id + ' spawn failed: ' + err.message);
  }

  return entry;
}

function resetIdleTimer(toolId) {
  const entry = processes.get(toolId);
  if (!entry) return;
  entry.lastUsed = Date.now();
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => stopTool(toolId), IDLE_TIMEOUT_MS);
}

function stopTool(toolId) {
  const entry = processes.get(toolId);
  if (!entry) return;
  log(toolId + ' idle, stopping to free RAM');
  entry._stopping = true;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  try { entry.process.kill('SIGTERM'); } catch (_) {}
  setTimeout(() => { try { entry.process.kill('SIGKILL'); } catch (_) {} }, 5000);
  processes.delete(toolId);
}

async function checkHealth(toolId) {
  const entry = processes.get(toolId);
  if (!entry || shuttingDown) return;

  try {
    const res = await fetch('http://127.0.0.1:' + entry.port + '/provider', {
      signal: AbortSignal.timeout(3000)
    });
    entry.healthy = res.ok;
    if (res.ok) {
      entry.providerInfo = await res.json();
    }
  } catch (_) {
    entry.healthy = false;
  }
  entry.lastHealthCheck = Date.now();
}

export async function ensureRunning(agentId) {
  const tool = ACP_TOOLS.find(t => t.id === agentId);
  if (!tool) return null;
  let entry = processes.get(agentId);
  if (entry?.healthy) { resetIdleTimer(agentId); return entry.port; }
  if (!entry || entry._stopping) {
    entry = startProcess(tool);
    if (!entry) return null;
  }
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    await checkHealth(agentId);
    if (processes.get(agentId)?.healthy) { resetIdleTimer(agentId); return tool.port; }
  }
  return null;
}

export function touch(agentId) {
  const entry = processes.get(agentId);
  if (entry) resetIdleTimer(agentId);
}

export async function startAll() {
  log('ACP tools available (on-demand start)');
  healthTimer = setInterval(() => {
    for (const [id] of processes) checkHealth(id);
  }, HEALTH_INTERVAL_MS);
}

export async function stopAll() {
  shuttingDown = true;
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  const kills = [];
  for (const [id, entry] of processes) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    log('stopping ' + id + ' pid ' + entry.pid);
    kills.push(new Promise(resolve => {
      const t = setTimeout(() => { try { entry.process.kill('SIGKILL'); } catch (_) {} resolve(); }, 5000);
      entry.process.on('close', () => { clearTimeout(t); resolve(); });
      try { entry.process.kill('SIGTERM'); } catch (_) {}
    }));
  }
  await Promise.all(kills);
  processes.clear();
  log('all stopped');
}

export function getStatus() {
  return ACP_TOOLS.map(tool => {
    const e = processes.get(tool.id);
    return {
      id: tool.id,
      port: tool.port,
      running: !!e,
      healthy: e?.healthy || false,
      pid: e?.pid,
      uptime: e ? Date.now() - e.startedAt : 0,
      restartCount: e?.restarts.length || 0,
      idleMs: e ? Date.now() - e.lastUsed : 0,
      providerInfo: e?.providerInfo || null,
    };
  });
}

export function getPort(agentId) {
  const e = processes.get(agentId);
  return e?.healthy ? e.port : null;
}

export function getRunningPorts() {
  const ports = {};
  for (const [id, e] of processes) if (e.healthy) ports[id] = e.port;
  return ports;
}

export async function restart(agentId) {
  const tool = ACP_TOOLS.find(t => t.id === agentId);
  if (!tool) return false;
  stopTool(agentId);
  startProcess(tool);
  return true;
}

export async function queryModels(agentId) {
  const port = await ensureRunning(agentId);
  if (!port) return [];
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/models', {
      signal: AbortSignal.timeout(3000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.models || [];
  } catch (_) { return []; }
}

export function isAvailable(agentId) {
  const tool = ACP_TOOLS.find(t => t.id === agentId);
  return !!tool;
}
