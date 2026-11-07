import os from 'node:os';
import crypto from 'node:crypto';

export const MAX_SESSIONS = 50;
export const REPLAY_BYTES = 256 * 1024;
export const MAX_BUFFERED_BYTES = 8 * 1024 * 1024;
const KILL_GRACE_MS = 1500;
const MAX_DIM = 1000;
const POSIX_PRELUDE = 'if T=$(tty 2>/dev/null); then exec 0<"$T"; fi; exec "$@"';

const sessions = new Map();
let ptyLib = null;

async function loadPty() {
  if (!ptyLib) {
    const mod = await import('tt-native');
    ptyLib = mod.default ?? mod;
  }
  return ptyLib;
}

export function clampDim(value, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_DIM, Math.max(1, n));
}

function defaultShell() {
  if (process.platform === 'win32') return process.env.COMSPEC || 'cmd.exe';
  return process.env.SHELL || '/bin/bash';
}

function spawnTarget(shell) {
  if (process.platform === 'win32') return { file: shell, args: [] };
  return { file: 'sh', args: ['-c', POSIX_PRELUDE, 'agentgui', shell] };
}

function childEnv() {
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  delete env.PASSWORD;
  return env;
}

function describe(s) {
  return {
    sid: s.sid,
    shell: s.shell,
    cwd: s.cwd,
    cols: s.cols,
    rows: s.rows,
    pid: s.pid,
    createdAt: s.createdAt,
    clients: s.clients.size,
    exited: s.exited,
    exitCode: s.exitCode
  };
}

function sendControl(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function finish(s, code) {
  if (s.exited) return;
  s.exited = true;
  s.exitCode = code;
  for (const ws of s.clients) {
    sendControl(ws, { type: 'exit', code });
    try { ws.close(1000, 'exit'); } catch {}
  }
  s.clients.clear();
}

function trimReplay(s) {
  while (s.replayBytes > REPLAY_BYTES) {
    const excess = s.replayBytes - REPLAY_BYTES;
    const head = s.replay[0];
    if (head.length <= excess) {
      s.replay.shift();
      s.replayBytes -= head.length;
    } else {
      s.replay[0] = head.subarray(excess);
      s.replayBytes -= excess;
    }
  }
}

function broadcast(s, chunk) {
  s.replay.push(chunk);
  s.replayBytes += chunk.length;
  trimReplay(s);
  for (const ws of s.clients) {
    if (ws.readyState !== 1) continue;
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      s.clients.delete(ws);
      try { ws.terminate(); } catch {}
      continue;
    }
    ws.send(chunk, { binary: true });
  }
}

function nudge(s) {
  try {
    s.pty.resize(Math.max(1, s.cols - 1), s.rows);
    s.pty.resize(s.cols, s.rows);
  } catch {}
}

function handleClientMessage(s, data, isBinary) {
  if (isBinary) {
    writeSession(s.sid, data);
    return;
  }
  let msg;
  try { msg = JSON.parse(data.toString()); } catch { return; }
  if (msg && msg.type === 'resize') resizeSession(s.sid, msg.cols, msg.rows);
}

export async function createSession({ cwd, cols, rows } = {}) {
  if (sessions.size >= MAX_SESSIONS) throw new Error(`terminal limit reached (${MAX_SESSIONS})`);
  const PTY = await loadPty();
  const shell = defaultShell();
  const target = spawnTarget(shell);
  const workdir = cwd || process.env.STARTUP_CWD || process.cwd() || os.homedir();
  const width = clampDim(cols, 80);
  const height = clampDim(rows, 24);
  const pty = PTY.spawn(target.file, target.args, { cwd: workdir, env: childEnv(), width, height });
  const s = {
    sid: crypto.randomBytes(8).toString('hex'),
    shell,
    cwd: workdir,
    cols: width,
    rows: height,
    pid: pty.pid ?? null,
    pty,
    createdAt: Date.now(),
    clients: new Set(),
    replay: [],
    replayBytes: 0,
    exited: false,
    exitCode: null,
    killTimer: null
  };
  sessions.set(s.sid, s);
  pty.on('data', (chunk) => broadcast(s, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  pty.once('exit', (code) => {
    clearTimeout(s.killTimer);
    finish(s, Number.isFinite(code) ? code : 0);
  });
  return describe(s);
}

export function listSessions() {
  return [...sessions.values()].map(describe);
}

export function describeSession(sid) {
  const s = sessions.get(sid);
  return s ? describe(s) : null;
}

export function writeSession(sid, data) {
  const s = sessions.get(sid);
  if (!s || s.exited) return false;
  try { s.pty.write(data); } catch { return false; }
  return true;
}

export function resizeSession(sid, cols, rows) {
  const s = sessions.get(sid);
  if (!s || s.exited) return false;
  s.cols = clampDim(cols, s.cols);
  s.rows = clampDim(rows, s.rows);
  try { s.pty.resize(s.cols, s.rows); } catch { return false; }
  return true;
}

export function attachSocket(sid, ws) {
  const s = sessions.get(sid);
  if (!s) {
    try { ws.close(4404, 'session-not-found'); } catch {}
    return false;
  }
  if (s.exited) {
    sendControl(ws, { type: 'exit', code: s.exitCode });
    try { ws.close(1000, 'exit'); } catch {}
    return false;
  }
  if (s.replayBytes > 0) ws.send(Buffer.concat(s.replay, s.replayBytes), { binary: true });
  s.clients.add(ws);
  nudge(s);
  ws.on('message', (data, isBinary) => handleClientMessage(s, data, isBinary));
  ws.on('close', () => s.clients.delete(ws));
  ws.on('error', () => s.clients.delete(ws));
  return true;
}

export function closeSession(sid) {
  const s = sessions.get(sid);
  if (!s) return false;
  sessions.delete(sid);
  if (!s.exited) {
    finish(s, null);
    try { s.pty.kill('SIGHUP'); } catch {}
    s.killTimer = setTimeout(() => { try { s.pty.kill('SIGKILL'); } catch {} }, KILL_GRACE_MS);
    s.killTimer.unref?.();
  }
  return true;
}

export function closeAllSessions() {
  for (const sid of [...sessions.keys()]) closeSession(sid);
}
