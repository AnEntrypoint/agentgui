// WebSocket terminal sessions. Ported from acptoapi 2026-05-21.
// Auth: callers MUST gate /api/terminal/* + the WS upgrade behind agentgui's
// PASSWORD Basic-auth check. This module does no auth on its own - never
// expose without the gate.

import os from 'os';
import { spawn } from 'child_process';
import crypto from 'crypto';
import { createRequire } from 'module';
const require_ = createRequire(import.meta.url);

let _pty = null;
function getPty() {
  if (_pty !== null) return _pty;
  try { _pty = require_('node-pty'); } catch { _pty = false; }
  return _pty;
}

const sessions = new Map();

function newSid() { return crypto.randomBytes(8).toString('hex'); }

function defaultShell() {
  if (os.platform() === 'win32') return process.env.COMSPEC || 'cmd.exe';
  return process.env.SHELL || '/bin/bash';
}

export function createSession({ shell, cwd, cols = 80, rows = 24, env } = {}) {
  const sid = newSid();
  const pty = getPty();
  const _shell = shell || defaultShell();
  const _cwd = cwd || process.env.HOME || os.homedir();
  const _env = { ...process.env, ...(env || {}), TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  let proc, kind;
  if (pty) {
    proc = pty.spawn(_shell, [], { name: 'xterm-256color', cols, rows, cwd: _cwd, env: _env });
    kind = 'pty';
  } else {
    proc = spawn(_shell, os.platform() === 'win32' ? [] : ['-i'], { cwd: _cwd, env: _env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    kind = 'pipe';
  }
  const session = { sid, kind, proc, shell: _shell, cwd: _cwd, cols, rows, createdAt: Date.now(), clients: new Set(), exitCode: null };
  sessions.set(sid, session);
  const onData = (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    for (const ws of session.clients) { if (ws.readyState === 1) try { ws.send(buf); } catch {} }
  };
  if (kind === 'pty') {
    proc.on('data', onData);
    proc.on('exit', (code) => { session.exitCode = code; for (const ws of session.clients) { try { ws.close(1000, 'exit:' + code); } catch {} } sessions.delete(sid); });
  } else {
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.stdout.on('error', () => {});
    proc.stderr.on('error', () => {});
    proc.stdin.on('error', () => {});
    proc.on('exit', (code) => { session.exitCode = code; for (const ws of session.clients) { try { ws.close(1000, 'exit:' + code); } catch {} } sessions.delete(sid); });
    proc.on('error', (err) => { session.exitCode = -1; for (const ws of session.clients) { try { ws.close(1011, 'error:' + err.message); } catch {} } sessions.delete(sid); });
  }
  return session;
}

export function getSession(sid) { return sessions.get(sid); }

export function listSessions() {
  return [...sessions.values()].map(s => ({ sid: s.sid, kind: s.kind, shell: s.shell, cwd: s.cwd, cols: s.cols, rows: s.rows, createdAt: s.createdAt, clients: s.clients.size }));
}

export function closeSession(sid) {
  const s = sessions.get(sid);
  if (!s) return false;
  try { s.proc.kill(); } catch {}
  sessions.delete(sid);
  return true;
}

export function writeToSession(sid, data) {
  const s = sessions.get(sid);
  if (!s) return false;
  const buf = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (s.kind === 'pty') {
    try { s.proc.write(buf); } catch { return false; }
  } else {
    if (!s.proc.stdin || !s.proc.stdin.writable) return false;
    try { s.proc.stdin.write(buf); } catch { return false; }
  }
  return true;
}

export function resizeSession(sid, cols, rows) {
  const s = sessions.get(sid);
  if (!s || s.kind !== 'pty' || typeof s.proc.resize !== 'function') return false;
  s.cols = cols; s.rows = rows;
  try { s.proc.resize(cols, rows); return true; } catch { return false; }
}

export function attachWs(sid, ws) {
  const s = sessions.get(sid);
  if (!s) { try { ws.close(4404, 'session-not-found'); } catch {} return false; }
  s.clients.add(ws);
  ws.on('close', () => { s.clients.delete(ws); });
  ws.on('message', (msg, isBinary) => {
    if (isBinary || Buffer.isBuffer(msg)) { writeToSession(sid, msg); return; }
    const text = msg.toString();
    if (text && text.length > 0 && text[0] === '{') {
      try { const j = JSON.parse(text); if (j.type === 'resize' && j.cols && j.rows) { resizeSession(sid, j.cols, j.rows); return; } } catch {}
    }
    writeToSession(sid, text);
  });
  ws.on('error', () => { s.clients.delete(ws); });
  return true;
}
