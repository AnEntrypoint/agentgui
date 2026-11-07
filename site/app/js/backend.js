const KEY = 'agentgui.backend';
const DEFAULT_BACKEND = '';

let _sessionExpired = false;
const _sessionExpiredListeners = new Set();
export function onSessionExpired(fn) { _sessionExpiredListeners.add(fn); return () => _sessionExpiredListeners.delete(fn); }
function emitSessionExpired() {
  if (_sessionExpired) return;
  _sessionExpired = true;
  for (const fn of _sessionExpiredListeners) { try { fn(); } catch {} }
}

function authToken() {
  try { return (typeof window !== 'undefined' && window.__WS_TOKEN) || ''; } catch { return ''; }
}

async function authedFetch(url, opts = {}) {
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
    let accepted = false;
    try {
      const parsed = new URL(fromQs, location.href);
      const sameOrigin = parsed.origin === location.origin;
      const isLocalDev = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1';
      accepted = sameOrigin || isLocalDev;
    } catch {}
    if (accepted) { lsSet(KEY, fromQs); return fromQs; }
  }
  const bu = (typeof window !== 'undefined' && window.__BASE_URL) || '';
  return lsGet(KEY) || DEFAULT_BACKEND || String(bu).replace(/\/+$/, '');
}

export async function probeBackend(base) {
  try {
    const r = await authedFetch(base + '/health', { method: 'GET' });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, info: await r.json() };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function listDir(base, dirPath) {
  const qs = dirPath ? '?dir=' + encodeURIComponent(dirPath) : '';
  const r = await authedFetch(base + '/api/list' + qs);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(j.error || ('list: ' + r.status));
    e.status = r.status;
    throw e;
  }
  return j;
}

export async function readFile(base, filePath) {
  const r = await authedFetch(base + '/api/file?path=' + encodeURIComponent(filePath));
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(t || ('file: ' + r.status));
  }
  const content = await r.text();
  return { content, truncated: r.headers.get('X-File-Truncated') === '1' };
}

export function imageUrl(base, filePath) {
  return withToken(base + '/api/image?path=' + encodeURIComponent(filePath));
}

export function downloadUrl(base, filePath) {
  return withToken(base + '/api/download?path=' + encodeURIComponent(filePath));
}

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

export async function statPath(base, p) {
  const r = await authedFetch(base + '/api/stat?path=' + encodeURIComponent(p));
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || ('stat: ' + r.status)); e.status = r.status; throw e; }
  return j;
}

export function renameEntry(base, filePath, newName) { return mutateJSON(base, '/api/rename', { path: filePath, newName }); }
export function deleteEntry(base, filePath, recursive) { return mutateJSON(base, '/api/delete', { path: filePath, recursive: !!recursive }); }
export function restoreEntry(base, trashId) { return mutateJSON(base, '/api/restore', { trashId }); }
export function makeDir(base, dirPath, name) { return mutateJSON(base, '/api/mkdir', { dir: dirPath, name }); }
export function moveEntry(base, filePath, destDir, overwrite) { return mutateJSON(base, '/api/move', { path: filePath, destDir, overwrite: !!overwrite }); }

export async function uploadFile(base, dirPath, file, overwrite) {
  const qs = '?dir=' + encodeURIComponent(dirPath) + '&name=' + encodeURIComponent(file.name) + (overwrite ? '&overwrite=1' : '');
  const r = await authedFetch(base + '/api/upload-file' + qs, { method: 'PUT', body: file });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || ('upload: ' + r.status)); e.status = r.status; throw e; }
  return j;
}

export async function listTerminals(base) {
  const r = await authedFetch(base + '/api/terminal/sessions');
  const j = await r.json().catch(() => null);
  if (!r.ok) { const e = new Error((j && j.error) || ('terminals: ' + r.status)); e.status = r.status; throw e; }
  return Array.isArray(j) ? j : [];
}

export async function createTerminal(base, { cols, rows }) {
  const r = await authedFetch(base + '/api/terminal/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cols, rows }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || ('terminal: ' + r.status)); e.status = r.status; throw e; }
  return j;
}

export async function closeTerminal(base, sid) {
  const r = await authedFetch(base + '/api/terminal/sessions/' + encodeURIComponent(sid), { method: 'DELETE' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok && r.status !== 404) { const e = new Error(j.error || ('close: ' + r.status)); e.status = r.status; throw e; }
  return j;
}

export function terminalSocketUrl(sid) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const prefix = String((typeof window !== 'undefined' && window.__BASE_URL) || '').replace(/\/+$/, '');
  const tok = authToken();
  return proto + '//' + location.host + prefix + '/api/terminal/sessions/' + encodeURIComponent(sid) + (tok ? '?token=' + encodeURIComponent(tok) : '');
}
