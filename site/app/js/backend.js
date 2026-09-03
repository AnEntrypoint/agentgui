// agentgui backend client. Same-origin by default. Talks to:
//  - HTTP: /health, /v1/history/* (served by ccsniff)
//  - WS  : /sync   (JSON envelope: requests {m, r, p}; replies {r, d|e};
//          broadcasts {type, sessionId, ...})
// No external acptoapi dependency. Chat + agent listing flow over the WS.

import { encode, decode } from './codec.js';

const KEY = 'agentgui.backend';
const DEFAULT_BACKEND = '';

function authToken() {
  try { return (typeof window !== 'undefined' && window.__WS_TOKEN) || ''; } catch { return ''; }
}

// Set when a 401 is received mid-session so the app can show a reconnect banner.
let _sessionExpired = false;
const _sessionExpiredListeners = new Set();
export function onSessionExpired(fn) { _sessionExpiredListeners.add(fn); return () => _sessionExpiredListeners.delete(fn); }
function emitSessionExpired() {
  if (_sessionExpired) return; // emit only once per session
  _sessionExpired = true;
  for (const fn of _sessionExpiredListeners) { try { fn(); } catch {} }
}

async function authedFetch(url, opts = {}) {
  // Thread the agentgui token via the ?token= query param (exactly like the WS,
  // EventSource, and image/download URLs) rather than an `Authorization: Bearer`
  // header. A Bearer header OVERWRITES the browser's cached HTTP Basic Auth
  // credentials, so behind an nginx `auth_basic` proxy (e.g. the boxone /gm
  // deploy) every app fetch is rejected with 401 at the proxy before it ever
  // reaches agentgui - the page HTML/JS load (browser sends Basic creds) but
  // /health, /v1/history/*, and /api/* all 401. The query param coexists with
  // Basic auth; agentgui accepts ?token= on every HTTP route. credentials are
  // kept same-origin so the agentgui_token cookie also flows.
  const r = await fetch(withToken(url), { credentials: 'same-origin', ...opts });
  if (r.status === 401) emitSessionExpired();
  return r;
}

function withToken(url) {
  const tok = authToken();
  if (!tok) return url;
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(tok);
}

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

export function getBackend() {
  const u = new URL(location.href);
  const fromQs = u.searchParams.get('backend');
  if (fromQs) {
    // Only accept same-origin backends from the query string. A cross-origin
    // ?backend= would receive the ?token= auth credential on every request,
    // which is a credential-theft vector. Reject silently and fall through to
    // the stored/default value.
    let accepted = false;
    try {
      const parsed = new URL(fromQs, location.href);
      const sameOrigin = parsed.origin === location.origin;
      const isLocalDev = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      accepted = sameOrigin || isLocalDev;
    } catch {}
    if (accepted) { lsSet(KEY, fromQs); return fromQs; }
  }
  // Same-origin default: honour the server-injected router prefix so HTTP
  // calls (/health, /v1/history/*, /api/*) stay under the proxied path
  // (e.g. /gm) instead of hitting the site root, where a path-routing proxy
  // (nginx Basic auth) challenges and the browser re-prompts for a password.
  const bu = (typeof window !== 'undefined' && window.__BASE_URL) || '';
  return lsGet(KEY) || DEFAULT_BACKEND || String(bu).replace(/\/+$/, '');
}

export function setBackend(url) { lsSet(KEY, url); }

export async function probeBackend(base) {
  try {
    const r = await authedFetch(base + '/health', { method: 'GET' });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, info: await r.json() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------- Filesystem listing (HTTP, served by lib/http-handler.js) ----------

// List a directory for the Files / folder-browser view. Returns
// { path, segments, entries:[{name,type,size,modified,path}], roots }.
// An empty path lands on the server's first allow-root. The server confines
// every path to an allowlist root, so a 403 means the path is out of bounds.
export async function listDir(base, dirPath) {
  // A path SEGMENT (encoded as %2F for its own slashes) is silently mangled by
  // some reverse-proxy configs that normalize proxy_pass URIs - a nginx
  // decode-then-reencode of the request path collapses %2F back into a literal
  // slash before forwarding, so the app receives extra path segments instead
  // of one opaque one, loses its leading slash on strip, and 403s every
  // absolute-path listing that isn't the bare root. A query param is never
  // subject to that URI-path normalization, so it survives any proxy in front
  // of this app untouched.
  const qs = dirPath ? '?dir=' + encodeURIComponent(dirPath) : '';
  const r = await authedFetch(base + '/api/list' + qs);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    // Carry the HTTP status so the app can map 403/404 to plain copy (W9).
    const e = new Error(j.error || ('list: ' + r.status));
    e.status = r.status;
    throw e;
  }
  return j;
}

// Fetch raw text/code file bytes for the Files preview pane. The server
// confines the path to the same allowlist roots as listDir and caps the size;
// a 403 means out-of-bounds or unsupported type, 404 missing. Returns
// { content, truncated }.
export async function readFile(base, filePath) {
  // Query param, not a path segment - see listDir()'s comment above for why:
  // a reverse proxy's URI normalization can silently collapse an encoded %2F
  // path-segment slash back into a literal slash before forwarding.
  const r = await authedFetch(base + '/api/file?path=' + encodeURIComponent(filePath));
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(t || ('file: ' + r.status));
  }
  const content = await r.text();
  return { content, truncated: r.headers.get('X-File-Truncated') === '1' };
}

// Same-origin URL for an image file (served by /api/image, token-threaded).
export function imageUrl(base, filePath) {
  return withToken(base + '/api/image?path=' + encodeURIComponent(filePath));
}

// Same-origin download URL (served by /api/download, attachment disposition,
// confined + token-threaded). Used by the Files row download action.
export function downloadUrl(base, filePath) {
  return withToken(base + '/api/download?path=' + encodeURIComponent(filePath));
}

// ---------- File mutations (confined server endpoints) ----------

// Shared shape: each throws an Error carrying .status so the app maps
// 403/404/409/413 to plain human copy instead of the raw server string.
async function mutateJSON(base, route, body) {
  const r = await authedFetch(base + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || (route + ': ' + r.status)); e.status = r.status; throw e; }
  return j;
}

// Stat a path (GET /api/stat?path=<encoded>) for cwd validation. Returns {ok, dir}.
// Throws an Error carrying .status (403 outside roots, 404 missing).
export async function statPath(base, p) {
  // Query param, not a path segment - see the comment in listDir() above for
  // why: a reverse proxy's URI normalization can silently collapse an encoded
  // %2F path-segment slash back into a literal slash before forwarding.
  const r = await authedFetch(base + '/api/stat?path=' + encodeURIComponent(p));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || ('stat: ' + r.status)); e.status = r.status; throw e; }
  return j;
}

export function renameEntry(base, filePath, newName) { return mutateJSON(base, '/api/rename', { path: filePath, newName }); }
// deleteEntry's server response now includes trashId - the delete is a soft
// move-to-trash, not a permanent unlink, so the caller can offer an undo.
export function deleteEntry(base, filePath, recursive) { return mutateJSON(base, '/api/delete', { path: filePath, recursive: !!recursive }); }
export function restoreEntry(base, trashId) { return mutateJSON(base, '/api/restore', { trashId }); }
export function makeDir(base, dirPath, name) { return mutateJSON(base, '/api/mkdir', { dir: dirPath, name }); }
export function moveEntry(base, filePath, destDir, overwrite) { return mutateJSON(base, '/api/move', { path: filePath, destDir, overwrite: !!overwrite }); }

// Upload a File/Blob as raw bytes (PUT /api/upload-file). onProgress is not
// available via fetch streaming everywhere, so progress is per-file (done or
// not) - the kit UploadProgress shows per-file rows, which this satisfies.
export async function uploadFile(base, dirPath, file, overwrite) {
  const qs = '?dir=' + encodeURIComponent(dirPath) + '&name=' + encodeURIComponent(file.name) + (overwrite ? '&overwrite=1' : '');
  const r = await authedFetch(base + '/api/upload-file' + qs, { method: 'PUT', body: file });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || ('upload: ' + r.status)); e.status = r.status; throw e; }
  return j;
}

// ---------- History (HTTP, served by ccsniff) ----------

export async function listSessions(base) {
  const r = await authedFetch(base + '/v1/history/sessions');
  if (!r.ok) throw new Error('sessions: ' + r.status);
  const j = await r.json();
  return Array.isArray(j) ? j : (j.sessions || []);
}

export async function getSessionEvents(base, sid) {
  const r = await authedFetch(base + '/v1/history/sessions/' + encodeURIComponent(sid) + '/events');
  if (!r.ok) throw new Error('events: ' + r.status);
  const j = await r.json();
  return j.events || [];
}

export async function searchHistory(base, q, limit = 50) {
  const r = await authedFetch(base + '/v1/history/search?q=' + encodeURIComponent(q) + '&limit=' + limit);
  if (!r.ok) throw new Error('search: ' + r.status);
  return r.json();
}

// Native EventSource auto-reconnects on its own schedule with no cap, unlike
// the WS client's explicit exponential backoff below - a flaky proxy can spin
// it into a tight reconnect loop. Wrap the lifecycle with the same manual
// close+reopen-on-timer backoff (start 500ms, double, cap 30000ms, reset on a
// successful connection) so both realtime transports behave consistently.
// Returns a thin handle exposing addEventListener('error', ...)/close(), the
// same surface callers already use against a raw EventSource.
export function streamHistory(base, onEvent) {
  const EVENT_KINDS = ['hello', 'event', 'error', 'start', 'complete', 'conversation'];
  let es = null;
  let closed = false;
  let attempts = 0;
  let retryTimer = null;
  const errorListeners = new Set();

  function connect() {
    if (closed) return;
    es = new EventSource(withToken(base + '/v1/history/stream'));
    for (const k of EVENT_KINDS) {
      es.addEventListener(k, ev => {
        if (k === 'hello') { attempts = 0; }   // reset backoff on a live connection
        let data; try { data = JSON.parse(ev.data); } catch { data = null; }
        onEvent(k, data);
      });
    }
    es.addEventListener('error', () => {
      if (closed) return;
      try { es.close(); } catch {}
      for (const fn of errorListeners) { try { fn(); } catch {} }
      const delay = Math.min(30000, 500 * Math.pow(2, attempts));
      attempts++;
      retryTimer = setTimeout(() => { retryTimer = null; connect(); }, delay);
    });
  }
  connect();

  return {
    addEventListener(kind, fn) { if (kind === 'error') errorListeners.add(fn); },
    close() {
      closed = true;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      if (es) { try { es.close(); } catch {} }
    },
  };
}

// ---------- WebSocket client (/sync) ----------

const SYNC_PATH = '/sync';
let _ws = null;
let _wsReady = null;       // Promise that resolves when ws is OPEN
let _nextReqId = 1;
const _pending = new Map();          // requestId -> { resolve, reject }
const _sessionListeners = new Map(); // sessionId -> Set<(event)=>void>
const _statusListeners = new Set();  // fn(state) where state in 'open'|'closed'|'error'|'reconnecting'
let _reconnectAttempts = 0;
let _reconnectTimer = null;
let _wsBaseHint = '';                 // base remembered for reconnect

export function onWsStatus(fn) { _statusListeners.add(fn); return () => _statusListeners.delete(fn); }
function emitStatus(s) { for (const fn of _statusListeners) { try { fn(s); } catch {} } }

function scheduleReconnect() {
  if (_reconnectTimer) return;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    // Wait for online before retrying.
    const onOnline = () => { window.removeEventListener('online', onOnline); _reconnectAttempts = 0; ensureWs(_wsBaseHint).catch(() => {}); };
    window.addEventListener('online', onOnline);
    return;
  }
  const delay = Math.min(30000, 500 * Math.pow(2, _reconnectAttempts));
  _reconnectAttempts++;
  emitStatus('reconnecting');
  _reconnectTimer = setTimeout(() => {
    _reconnectTimer = null;
    ensureWs(_wsBaseHint).catch(() => {});
  }, delay);
}

function wsUrl(base) {
  let proto, host, prefix = '';
  if (base) {
    try {
      const u = new URL(base);
      proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
      host = u.host;
      // A custom backend URL may carry a routing path prefix (e.g. https://host/gm).
      prefix = u.pathname.replace(/\/+$/, '');
    } catch {}
  }
  if (!host) {
    proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    host = location.host;
    // Same-origin: honour the server-injected router prefix so the socket is
    // routed correctly behind a path-routing proxy (e.g. nginx /gm/ -> 9897).
    const bu = (typeof window !== 'undefined' && window.__BASE_URL) || '';
    prefix = String(bu).replace(/\/+$/, '');
  }
  const tok = authToken();
  return proto + '//' + host + prefix + SYNC_PATH + (tok ? '?token=' + encodeURIComponent(tok) : '');
}

function ensureWs(base) {
  _wsBaseHint = base || _wsBaseHint;
  if (_ws && _ws.readyState === 1) return _wsReady;
  if (_ws && _ws.readyState === 0) return _wsReady;
  _ws = new WebSocket(wsUrl(_wsBaseHint));
  _wsReady = new Promise((resolve, reject) => {
    _ws.addEventListener('open', () => {
      _reconnectAttempts = 0;
      emitStatus('open');
      // Re-subscribe any session listeners that survived the disconnect.
      for (const sid of _sessionListeners.keys()) {
        try { _ws.send(encode({ m: 'conversation.subscribe', r: _nextReqId++, p: { sessionId: sid } })); } catch {}
      }
      // Reload the agent list after reconnect so the picker reflects reality.
      emitStatus('reloadAgents');
      resolve(_ws);
    });
    // The error Event has no .message; reject with a real Error so callers log
    // a usable reason instead of "undefined" (e.g. "agents fetch failed: ...").
    _ws.addEventListener('error', () => { emitStatus('error'); reject(new Error('WebSocket connection failed')); });
    _ws.addEventListener('close', () => {
      emitStatus('closed');
      for (const [, p] of _pending) p.reject(new Error('Connection lost - please reconnect'));
      _pending.clear();
      _ws = null;
      _wsReady = null;
      // Auto-reconnect if there are listeners or callers will retry.
      if (_sessionListeners.size > 0 || _statusListeners.size > 0) scheduleReconnect();
    });
    _ws.addEventListener('message', (ev) => {
      let msg;
      try {
        // Server sends text frames (JSON via codec). ev.data is string.
        msg = typeof ev.data === 'string' ? JSON.parse(ev.data) : decode(ev.data);
      } catch { return; }
      // Reply to a prior request?
      if (msg && msg.r !== undefined && (msg.d !== undefined || msg.e !== undefined)) {
        const p = _pending.get(msg.r);
        if (!p) return;
        _pending.delete(msg.r);
        if (msg.e) p.reject(new Error(msg.e.m || ('ws error ' + msg.e.c)));
        else p.resolve(msg.d);
        return;
      }
      // Unsolicited broadcast - route by sessionId to subscribers.
      // Server may send a single event or a batch (array) per ws-optimizer.
      const items = Array.isArray(msg) ? msg : [msg];
      for (const item of items) {
        const sid = item?.sessionId;
        if (!sid) continue;
        const subs = _sessionListeners.get(sid);
        if (!subs) continue;
        for (const fn of subs) { try { fn(item); } catch {} }
      }
    });
  });
  return _wsReady;
}

function wsCall(base, method, params, timeoutMs = 15000) {
  return ensureWs(base).then(() => new Promise((resolve, reject) => {
    const r = _nextReqId++;
    const timer = setTimeout(() => {
      if (_pending.delete(r)) reject(new Error(method + ' timed out'));
    }, timeoutMs);
    _pending.set(r, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    _ws.send(encode({ m: method, r, p: params || {} }));
  }));
}

function addSessionListener(sessionId, fn) {
  if (!_sessionListeners.has(sessionId)) _sessionListeners.set(sessionId, new Set());
  _sessionListeners.get(sessionId).add(fn);
  return () => {
    const s = _sessionListeners.get(sessionId);
    if (s) { s.delete(fn); if (s.size === 0) _sessionListeners.delete(sessionId); }
  };
}

// ---------- Agents / models (WS) ----------

export async function listAgents(base) {
  const { agents } = await wsCall(base, 'agents.list', {});
  return agents || [];
}

// Server's home/STARTUP_CWD - fetched once so "use default" can show what it
// actually resolves to (a tooltip) before the user clicks it, instead of only
// after.
export async function getHome(base) {
  return wsCall(base, 'home', {});
}

export async function listActiveChats(base) {
  try { const { sessions } = await wsCall(base, 'chat.active', {}); return sessions || []; }
  catch { return []; }
}

export async function cancelChat(base, sessionId) {
  try {
    return await wsCall(base, 'chat.cancel', { sessionId });
  } catch (e) {
    // Surface a distinct error type so the app can show a toast instead of
    // silently swallowing the failure (user clicked stop but nothing happened).
    const err = new Error(e.message || 'stop request not delivered');
    err.cancelFailed = true;
    throw err;
  }
}

export async function restartAcpAgent(base, agentId) {
  try { return await wsCall(base, 'acp.restart', { id: agentId }); }
  catch { return { ok: false }; }
}

export async function listAgentModels(base, agentId) {
  if (!agentId) return [];
  try {
    const { models } = await wsCall(base, 'agents.models', { id: agentId });
    return models || [];
  } catch { return []; }
}

// Composed model-availability view for the Models tab (ModelsConfig
// component): per-agent CLI availability + models, in the shape ModelsConfig
// expects ({timestamp, providers, sampler, summary}). See lib/ws-handlers-
// util.js models.availability for what each field really means in agentgui
// (no probed per-mode matrix like freddie - one real 'cli' mode per model).
export async function getModelsAvailability(base) {
  return wsCall(base, 'models.availability', {});
}

// Provider API-key configs (masked) for the Models tab's provider auth info -
// backs the existing Settings 'keys' surface, reused here as-is.
export async function getAuthConfigs(base) {
  return wsCall(base, 'auth.configs', {});
}

export async function saveAuthConfig(base, providerId, apiKey, defaultModel) {
  return wsCall(base, 'auth.save', { providerId, apiKey, defaultModel });
}

// ---------- Git / worktrees (WS) ----------

export async function gitStatus(base, { cwd } = {}) {
  const { files } = await wsCall(base, 'git.status', { cwd });
  return files || [];
}

export async function gitDiff(base, { cwd, file, staged } = {}) {
  return wsCall(base, 'git.diff', { cwd, file, staged });
}

export async function gitLog(base, { cwd, limit } = {}) {
  const { commits } = await wsCall(base, 'git.log', { cwd, limit });
  return commits || [];
}

export async function worktreeList(base, { cwd } = {}) {
  const { worktrees } = await wsCall(base, 'worktree.list', { cwd });
  return worktrees || [];
}

export async function worktreeCreate(base, { cwd, path, branch, newBranch } = {}) {
  return wsCall(base, 'worktree.create', { cwd, path, branch, newBranch });
}

export async function worktreeRemove(base, { cwd, path, force } = {}) {
  return wsCall(base, 'worktree.remove', { cwd, path, force });
}

// ---------- Streaming chat (WS) ----------
//
// Yields events of shape:
//   { type: 'text',  text: '...' }    - assistant text deltas
//   { type: 'tool',  block: {...} }   - tool_use blocks
//   { type: 'result', block: {...} }  - terminal result block
//   { type: 'error', error: '...' }
//
// Caller signature kept compatible with the previous HTTP/SSE impl.
export async function* streamChat(base, { model, messages, signal, agentId, resumeSid, cwd }) {
  // The last user message is the prompt; agentgui's claude-runner spawns the
  // agent for a single prompt. Multi-turn continuity is the agent's own resume.
  const last = messages[messages.length - 1];
  const content = last?.content || '';
  if (!content) return;

  const resolvedAgentId = agentId || 'claude-code';
  const resolvedModel = model || undefined;

  // Queue events here; the async iterator pulls from it.
  const queue = [];
  let resolveWait = null;
  let done = false;
  let errored = null;
  const push = (ev) => { queue.push(ev); if (resolveWait) { resolveWait(); resolveWait = null; } };

  // Kick off the chat on the server.
  let started;
  try {
    started = await wsCall(base, 'chat.sendMessage', { content, agentId: resolvedAgentId, model: resolvedModel, resumeSid, cwd });
  } catch (e) {
    yield { type: 'error', error: e.message };
    return;
  }
  const sessionId = started?.sessionId;
  if (!sessionId) { yield { type: 'error', error: 'no sessionId from server' }; return; }

  const finish = () => { done = true; if (resolveWait) { resolveWait(); resolveWait = null; } };

  const unsub = addSessionListener(sessionId, (ev) => {
    if (ev.type === 'streaming_session') {
      // claude's real session id - surface it so the host can --resume this
      // conversation on the next turn (multi-turn continuity).
      if (ev.claudeSessionId) push({ type: 'session', sessionId: ev.claudeSessionId });
    } else if (ev.type === 'streaming_progress') {
      const block = ev.block;
      if (block?.type === 'text' && block.text) push({ type: 'text', text: block.text });
      else if (block?.type === 'thinking' && block.thinking) push({ type: 'thinking', text: block.thinking });
      else if (block?.type === 'tool_use') push({ type: 'tool', block });
      else if (block?.type === 'tool_result') push({ type: 'tool_result', block });
      else if (block?.type === 'result') push({ type: 'result', block });
    } else if (ev.type === 'streaming_complete') {
      finish();
    } else if (ev.type === 'streaming_cancelled') {
      push({ type: 'cancelled' });
      finish();
    } else if (ev.type === 'streaming_error') {
      // A remote stop (another tab / dashboard stop-all) is not a failure: the
      // server marks it cancelled; surface it as a distinct event so the app
      // can label the turn 'stopped' instead of a normal finish or error red.
      if (ev.cancelled || ev.error === 'cancelled') {
        push({ type: 'cancelled' });
      } else {
        errored = ev.error || 'streaming error';
      }
      finish();
    }
  });

  // If the websocket drops mid-stream, streaming_complete will never arrive.
  // Don't fail immediately: the client auto-reconnects (and the open handler
  // re-subscribes this session's listeners), so give it a ~12s grace window.
  // Only if the socket is still down when the timer expires do we surface the
  // error and end the iterator instead of hanging forever.
  const WS_GRACE_MS = 12000;
  let graceTimer = null;
  const onWs = (s) => {
    if (done) return;
    if (s === 'open') {
      // Reconnected in time - the open handler already re-subscribed us.
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
      // streaming_complete is fire-and-forget with no replay: if the turn
      // finished while the socket was down, no terminal frame will ever
      // arrive. Verify the session is still alive server-side; if it is
      // gone, settle the iterator with a plain incomplete marker instead of
      // hanging busy forever.
      wsCall(base, 'chat.active', {}).then((d) => {
        if (done) return;
        const sessions = (d && d.sessions) || [];
        const alive = Array.isArray(sessions) && sessions.some(x => x && x.sessionId === sessionId);
        if (!alive) {
          errored = errored || 'connection dropped mid-turn - the response may be incomplete; events were not replayed';
          finish();
        }
      }).catch(() => {});
      return;
    }
    if ((s === 'closed' || s === 'error') && !graceTimer) {
      graceTimer = setTimeout(() => {
        graceTimer = null;
        if (!done) { errored = errored || 'connection lost during stream'; finish(); }
      }, WS_GRACE_MS);
    }
  };
  const unsubWs = onWsStatus ? onWsStatus(onWs) : null;

  // Wire AbortSignal to chat.cancel - and end the iterator immediately so the
  // caller's busy state clears even if the server never emits a final event.
  const onAbort = () => { wsCall(base, 'chat.cancel', { sessionId }).catch(() => {}); finish(); };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    while (!done || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise(r => { resolveWait = r; });
        continue;
      }
      yield queue.shift();
    }
    if (errored) {
      // Sanitize raw server strings: strip internal stack traces / JSON blobs
      // and map common cases to plain human copy.
      let displayError = (typeof errored === 'string' ? errored : 'streaming error').trim();
      if (/^\{/.test(displayError) || displayError.length > 300) displayError = 'An error occurred while streaming the response.';
      yield { type: 'error', error: displayError };
    }
  } finally {
    unsub();
    if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
    if (typeof unsubWs === 'function') unsubWs();
    if (signal) signal.removeEventListener?.('abort', onAbort);
  }
}
