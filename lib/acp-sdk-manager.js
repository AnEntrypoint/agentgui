import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { fileURLToPath } from 'url';
import * as acpMachine from './acp-server-machine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const isWindows = os.platform() === 'win32';
// codex (@openai/codex >=0.147.0) has no `acp` subcommand - `codex acp` is
// parsed as the interactive TUI with prompt text "acp" ("Error: stdin is not
// a terminal" when non-interactive), live-confirmed via `codex --help`/`codex
// app-server --help`. Its ACP-equivalent surface is `app-server` over a
// WebSocket (`--remote ws://host:port`), not this manager's HTTP-polling
// `/provider` health-check model, so codex is intentionally excluded from
// ACP_TOOLS rather than spawning a command that can never succeed. Re-add it
// once a WebSocket app-server client exists (see PRD row
// aaa-codex-app-server-client).
// `args` MUST pass --port explicitly - `acp` alone defaults --port to 0 (an
// OS-assigned ephemeral port), so the spawned server never actually listens
// on `tool.port` and every health-check/getPort() call targets the wrong
// port forever (live-confirmed: opencode process alive, listening on SOME
// port, but 127.0.0.1:18100/provider connection-refused). Fixed by pinning
// --port to the same value this manager already tracks per tool.
const ACP_TOOLS = [
  { id: 'opencode', cmd: 'opencode', args: ['acp', '--port', '18100'], port: 18100, npxPkg: 'opencode-ai' },
  { id: 'kilo', cmd: 'kilo', args: ['acp', '--port', '18101'], port: 18101, npxPkg: '@kilocode/cli' },
];
const HEALTH_INTERVAL_MS = 30000, STARTUP_GRACE_MS = 5000, IDLE_TIMEOUT_MS = 120000;
const processes = new Map(), idleTimers = new Map();
let healthTimer = null, shuttingDown = false;
function log(msg) { console.log('[ACP-SDK] ' + msg); }

function resolveCommand(tool) {
  const localBin = path.join(projectRoot, 'node_modules', '.bin', tool.cmd + (isWindows ? '.cmd' : ''));
  return fs.existsSync(localBin) ? { bin: localBin, args: tool.args } : { bin: tool.cmd, args: tool.args };
}

function resetIdleTimer(toolId) {
  acpMachine.send(toolId, { type: 'TOUCH' });
  const existing = idleTimers.get(toolId);
  if (existing) clearTimeout(existing);
  idleTimers.set(toolId, setTimeout(() => { acpMachine.send(toolId, { type: 'IDLE_TIMEOUT' }); stopTool(toolId); }, IDLE_TIMEOUT_MS));
}

function clearIdleTimer(toolId) {
  const t = idleTimers.get(toolId);
  if (t) { clearTimeout(t); idleTimers.delete(toolId); }
}

function stopTool(toolId) {
  const proc = processes.get(toolId);
  if (!proc) return;
  log(toolId + ' stopping');
  clearIdleTimer(toolId);
  try { proc.kill('SIGTERM'); } catch (_) {}
  setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} }, 5000);
  processes.delete(toolId);
  acpMachine.send(toolId, { type: 'STOPPED' });
}

function startProcess(tool) {
  if (shuttingDown) return null;
  const resolved = resolveCommand(tool);
  let proc;
  try {
    // stdin MUST stay open (piped, never closed) - the ACP CLI's `acp`
    // subcommand watches stdin and disposes itself on EOF even though it is
    // actually serving its normal HTTP API on `tool.port` (confirmed live:
    // spawning with stdio 'ignore' closes stdin immediately, which the
    // process treats as EOF and exits). Never .end()/.destroy() proc.stdin.
    proc = spawn(resolved.bin, resolved.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: false,
    });
  } catch (err) {
    log(tool.id + ' spawn failed: ' + err.message);
    acpMachine.send(tool.id, { type: 'CRASHED' });
    scheduleRestart(tool);
    return null;
  }

  processes.set(tool.id, proc);
  acpMachine.send(tool.id, { type: 'START' });
  acpMachine.send(tool.id, { type: 'STARTED', process: proc, pid: proc.pid });

  log(tool.id + ' started port ' + tool.port + ' pid ' + proc.pid);

  // A missing/unspawnable binary surfaces as an async 'error' event, NOT the
  // synchronous throw the try/catch above guards (witnessed under Bun: an
  // uninstalled ACP CLI emits ENOENT asynchronously and, without this listener,
  // escapes as an uncaught exception that kills the whole server). Funnel it
  // into the same CRASHED + backoff path as a normal exit so an uninstalled
  // on-demand agent degrades to "not healthy", never a process crash.
  proc.on('error', (err) => {
    processes.delete(tool.id);
    if (shuttingDown) return;
    log(tool.id + ' spawn error: ' + err.message);
    acpMachine.send(tool.id, { type: 'CRASHED' });
    const snap = acpMachine.snapshot(tool.id);
    if (snap?.value === 'stopped') { log(tool.id + ' max restarts reached'); return; }
    scheduleRestart(tool);
  });

  proc.on('close', (code) => {
    processes.delete(tool.id);
    if (shuttingDown) return;
    log(tool.id + ' exited code ' + code);
    acpMachine.send(tool.id, { type: 'CRASHED' });
    const snap = acpMachine.snapshot(tool.id);
    if (snap?.value === 'stopped') { log(tool.id + ' max restarts reached'); return; }
    scheduleRestart(tool);
  });

  setTimeout(() => checkHealth(tool.id, tool.port), STARTUP_GRACE_MS);
  resetIdleTimer(tool.id);
  return proc;
}

function scheduleRestart(tool) {
  if (shuttingDown) return;
  const delay = acpMachine.getBackoffDelay(tool.id);
  setTimeout(() => {
    if (!shuttingDown) startProcess(tool);
  }, delay);
}

// A single check at STARTUP_GRACE_MS can race a genuinely-still-starting
// server (opencode's HTTP endpoint was live-observed taking ~8s to come up,
// past the 5s grace) and mark it UNHEALTHY with no second chance before the
// next scheduled HEALTH_INTERVAL_MS tick (30s) - starving any caller polling
// isHealthy() over a shorter window (ensureRunning's own 10s loop). Retry a
// few times with backoff before sending UNHEALTHY, so a slow-but-genuinely-
// starting server gets caught instead of permanently mis-marked for 30s.
async function checkHealth(toolId, port, _retries = 3) {
  if (shuttingDown) return;
  const snap = acpMachine.snapshot(toolId);
  if (!snap || snap.value === 'stopped' || snap.value === 'idle_stopping') return;
  const p = port || ACP_TOOLS.find(t => t.id === toolId)?.port;
  if (!p) return;
  try {
    const res = await fetch('http://127.0.0.1:' + p + '/provider', { signal: AbortSignal.timeout(3000) });
    if (res.ok) { acpMachine.send(toolId, { type: 'HEALTHY', providerInfo: await res.json() }); return; }
    if (_retries > 0) { setTimeout(() => checkHealth(toolId, p, _retries - 1), 1500); return; }
    acpMachine.send(toolId, { type: 'UNHEALTHY' });
  } catch (_) {
    if (_retries > 0) { setTimeout(() => checkHealth(toolId, p, _retries - 1), 1500); return; }
    acpMachine.send(toolId, { type: 'UNHEALTHY' });
  }
}

export async function ensureRunning(agentId) {
  const tool = ACP_TOOLS.find(t => t.id === agentId);
  if (!tool) return null;
  if (acpMachine.isHealthy(agentId)) { resetIdleTimer(agentId); return tool.port; }
  const snap = acpMachine.snapshot(agentId);
  if (!snap || snap.value === 'stopped' || snap.value === 'crashed') {
    startProcess(tool);
  }
  // 30 x 500ms = 15s - wide enough to cover STARTUP_GRACE_MS (5s) plus
  // checkHealth's own retry backoff (up to ~4.5s more) with real margin, per
  // opencode's live-observed ~8s cold-start time for its HTTP endpoint.
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (shuttingDown) return null;
    if (acpMachine.isHealthy(agentId)) { resetIdleTimer(agentId); return tool.port; }
  }
  return null;
}

export function touch(agentId) { resetIdleTimer(agentId); }

export async function startAll() {
  log('ACP tools available (on-demand start)');
  healthTimer = setInterval(() => {
    for (const tool of ACP_TOOLS) {
      const snap = acpMachine.snapshot(tool.id);
      if (snap && (snap.value === 'running' || snap.value === 'starting')) {
        checkHealth(tool.id, tool.port);
      }
    }
  }, HEALTH_INTERVAL_MS);
}

export async function stopAll() {
  shuttingDown = true;
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  for (const toolId of idleTimers.keys()) clearIdleTimer(toolId);
  await Promise.all([...processes].map(([id, proc]) => {
    log('stopping ' + id + ' pid ' + proc.pid);
    return new Promise(resolve => {
      const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch (_) {} resolve(); }, 5000);
      proc.on('close', () => { clearTimeout(t); resolve(); });
      try { proc.kill('SIGTERM'); } catch (_) {}
    });
  }));
  processes.clear();
  acpMachine.stopAll();
  log('all stopped');
}

export function getStatus() {
  return ACP_TOOLS.map(tool => {
    const snap = acpMachine.snapshot(tool.id);
    const ctx = snap?.context || {};
    return { id: tool.id, port: tool.port, running: snap?.value === 'running' || snap?.value === 'starting', healthy: ctx.healthy || false, pid: ctx.pid, uptime: ctx.startedAt ? Date.now() - ctx.startedAt : 0, restartCount: ctx.restarts?.length || 0, idleMs: ctx.lastUsed ? Date.now() - ctx.lastUsed : 0, providerInfo: ctx.providerInfo || null };
  });
}

export function getPort(agentId) {
  return acpMachine.isHealthy(agentId) ? (ACP_TOOLS.find(t => t.id === agentId)?.port || null) : null;
}

export async function restart(agentId) {
  const tool = ACP_TOOLS.find(t => t.id === agentId);
  if (!tool) return false;
  stopTool(agentId); startProcess(tool); return true;
}

export async function queryModels(agentId) {
  const port = await ensureRunning(agentId);
  if (!port) return [];
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/provider', { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    const data = await res.json();
    const connected = data.connected || [];
    const allProvs = Object.fromEntries((data.all || []).map(p => [p.id, p]));
    const src = connected.length ? connected : Object.keys(allProvs);
    const models = [];
    for (const pid of src) {
      const prov = allProvs[pid] || {};
      for (const [, m] of Object.entries(prov.models || {})) {
        models.push({ id: (m.providerID || pid) + '/' + m.id, label: m.name || m.id });
      }
    }
    return models;
  } catch (_) { return []; }
}

export function isAvailable(agentId) { return !!ACP_TOOLS.find(t => t.id === agentId); }
