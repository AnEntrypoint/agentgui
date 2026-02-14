import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import http from 'http';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const POCKET_BIN = path.join(ROOT, 'data', 'pocket-venv', 'bin', 'pocket-tts');
const PORT = 8787;

const FALLBACK_VOICE = 'alba';
const state = {
  process: null, port: PORT, status: 'stopped', pid: null,
  restartCount: 0, failureCount: 0, lastError: null,
  healthy: false, voicePath: null, starting: false,
  shutdownRequested: false, healthTimer: null, restartTimer: null,
  voiceCloning: false,
};
globalThis.__pocketSidecar = state;

function isInstalled() { return fs.existsSync(POCKET_BIN); }

function findVoiceFile(voiceId) {
  if (!voiceId || voiceId === 'default') return null;
  const baseName = voiceId.replace(/^custom_/, '');
  const dirs = [
    path.join(process.env.STARTUP_CWD || process.cwd(), 'voices'),
    path.join(ROOT, 'voices'), path.join(os.homedir(), 'voices'), '/config/voices',
  ];
  for (const dir of dirs)
    for (const ext of ['.wav', '.mp3', '.ogg', '.flac']) {
      const p = path.join(dir, baseName + ext);
      if (fs.existsSync(p)) return p;
    }
  return null;
}

function healthCheck() {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${PORT}/health`, { timeout: 3000 }, (res) => {
      res.resume();
      res.on('end', () => { state.healthy = res.statusCode === 200; resolve(state.healthy); });
    });
    req.on('error', () => { state.healthy = false; resolve(false); });
    req.on('timeout', () => { req.destroy(); state.healthy = false; resolve(false); });
  });
}

function killProcess() {
  if (state.process) { try { state.process.kill('SIGTERM'); } catch (_) {} }
  state.process = null; state.pid = null; state.healthy = false; state.status = 'stopped';
}

function scheduleRestart() {
  if (state.shutdownRequested) return;
  killProcess();
  const delay = Math.min(1000 * Math.pow(2, state.restartCount), 30000);
  state.restartCount++;
  console.log(`[POCKET-TTS] Restart in ${delay}ms (attempt ${state.restartCount})`);
  state.restartTimer = setTimeout(() => {
    state.restartTimer = null;
    start(state.voicePath).catch(e => console.error('[POCKET-TTS] Restart failed:', e.message));
  }, delay);
}

function spawnSidecar(voice) {
  const args = ['serve', '--host', '0.0.0.0', '--port', String(PORT)];
  if (voice) args.push('--voice', voice);
  console.log('[POCKET-TTS] Starting:', POCKET_BIN, args.join(' '));
  return spawn(POCKET_BIN, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
  });
}

function attachProc(proc) {
  state.process = proc; state.pid = proc.pid; state.status = 'starting';
  proc.stdout.on('data', d => { const l = d.toString().trim(); if (l) console.log('[POCKET-TTS]', l); });
  proc.stderr.on('data', d => { const l = d.toString().trim(); if (l) console.error('[POCKET-TTS]', l); });
  proc.on('error', e => { state.lastError = e.message; });
}

async function waitForReady(proc, timeoutSec) {
  let exited = false;
  proc.on('exit', () => { exited = true; });
  for (let i = 0; i < timeoutSec; i++) {
    if (exited) return false;
    await new Promise(r => setTimeout(r, 1000));
    if (await healthCheck()) return true;
  }
  return false;
}

async function start(voicePath) {
  if (!isInstalled()) { state.lastError = 'not installed'; state.status = 'unavailable'; return false; }
  if (state.starting) return false;
  if (state.status === 'running' && state.healthy) return true;
  state.starting = true; state.shutdownRequested = false;
  const requestedVoice = voicePath || state.voicePath;
  try {
    killProcess();
    let proc = spawnSidecar(requestedVoice);
    attachProc(proc);
    let ready = await waitForReady(proc, 120);
    if (!ready && requestedVoice && requestedVoice !== FALLBACK_VOICE) {
      console.log('[POCKET-TTS] Custom voice failed, trying predefined voice:', FALLBACK_VOICE);
      killProcess();
      proc = spawnSidecar(FALLBACK_VOICE);
      attachProc(proc);
      state.voiceCloning = false;
      ready = await waitForReady(proc, 120);
      if (ready) state.voicePath = FALLBACK_VOICE;
    } else if (ready) {
      state.voicePath = requestedVoice;
      state.voiceCloning = !!requestedVoice && !['alba','marius','javert','jean','fantine','cosette','eponine','azelma'].includes(requestedVoice);
    }
    if (ready) {
      state.status = 'running'; state.restartCount = 0; state.failureCount = 0; state.lastError = null;
      proc.on('exit', (code, sig) => {
        console.log(`[POCKET-TTS] Exited: code=${code} signal=${sig}`);
        state.process = null; state.pid = null; state.healthy = false; state.status = 'stopped';
        if (!state.shutdownRequested) scheduleRestart();
      });
      if (!state.healthTimer) state.healthTimer = setInterval(async () => {
        if (state.status !== 'running') return;
        const ok = await healthCheck();
        if (!ok && !state.shutdownRequested) {
          state.failureCount++;
          if (state.failureCount >= 3) scheduleRestart();
        } else if (ok) state.failureCount = 0;
      }, 10000);
      console.log('[POCKET-TTS] Ready on port', PORT, '(voice cloning:', state.voiceCloning + ')');
      return true;
    }
    state.lastError = 'Start timeout'; state.status = 'error'; killProcess(); return false;
  } catch (err) {
    state.lastError = err.message; state.status = 'error'; return false;
  } finally { state.starting = false; }
}

async function stop() {
  state.shutdownRequested = true;
  if (state.healthTimer) { clearInterval(state.healthTimer); state.healthTimer = null; }
  if (state.restartTimer) { clearTimeout(state.restartTimer); state.restartTimer = null; }
  killProcess();
}

async function synthesize(text, voicePath) {
  if (!state.healthy) throw new Error('pocket-tts not ready');
  const boundary = '----PocketTTS' + Date.now();
  const parts = [];
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\n${text}\r\n`);
  if (state.voiceCloning && voicePath && voicePath !== state.voicePath) {
    const data = fs.readFileSync(voicePath);
    const name = path.basename(voicePath);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="voice_wav"; filename="${name}"\r\nContent-Type: audio/wav\r\n\r\n`);
    parts.push(data); parts.push('\r\n');
  }
  parts.push(`--${boundary}--\r\n`);
  const body = Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p)));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: PORT, path: '/tts', method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
      timeout: 60000,
    }, res => {
      if (res.statusCode !== 200) {
        let e = ''; res.on('data', d => e += d);
        res.on('end', () => reject(new Error(`pocket-tts HTTP ${res.statusCode}: ${e}`)));
        return;
      }
      const chunks = []; res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('pocket-tts timeout')); });
    req.write(body); req.end();
  });
}

function getState() {
  return {
    status: state.status, healthy: state.healthy, pid: state.pid, port: state.port,
    restartCount: state.restartCount, failureCount: state.failureCount,
    lastError: state.lastError, installed: isInstalled(), voiceCloning: state.voiceCloning,
  };
}

export { start, stop, synthesize, healthCheck, getState, isInstalled, findVoiceFile };
