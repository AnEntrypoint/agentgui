import { h, mount, installStyles, components as C } from 'anentrypoint-design';
import * as B from './backend.js';
import { installShortcuts } from './shortcuts.js';
import { readHash as readHashRouting, buildHash as buildHashRouting, writeHash as writeHashRouting } from './hash-routing.js';
import { createTerminals } from './terminals.js';

installStyles().catch(() => {});

const { PageHeader, Btn, Spinner, Alert, FileGrid, sortFiles, FileToolbar, RootsPicker, BreadcrumbPath, FileViewer, FilePreviewPane, FilePreviewCode, FilePreviewText, FilePreviewMedia, PromptDialog, ConfirmDialog, DropZone, UploadProgress, BulkBar, toast } = C;

const DISABLED_COPY = 'Terminals are disabled. Start the server with PASSWORD and ENABLE_TERMINAL=1.';

const state = {
  backend: B.getBackend(),
  health: { status: 'unknown' },
  healthChecking: false,
  sessionExpired: false,
  tab: 'files',
  files: { path: '', segments: [], entries: [], roots: [], loading: false, error: null, preview: null, sort: 'name', sortDir: 'asc', filter: '' },
};

function readHash() { return readHashRouting(); }
function writeHash(opts) { return writeHashRouting(state, opts); }

function fmtRelTime(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s <= 0) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s/60) + 'm ago';
  if (s < 86400) return Math.round(s/3600) + 'h ago';
  return Math.round(s/86400) + 'd ago';
}

let render;
let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => { renderScheduled = false; render(); });
}

const NARROW_BP = 640;
function isNarrow() { return typeof window !== 'undefined' && window.innerWidth < NARROW_BP; }
function truncate(str, mobileLen, desktopLen) {
  const s = String(str ?? '');
  const max = isNarrow() ? mobileLen : desktopLen;
  return s.length > max ? s.slice(0, max) + '…' : s;
}
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

let _announcer = null;

function announce(msg) {
  if (typeof document === 'undefined') return;
  if (!_announcer) {
    _announcer = document.createElement('div');
    _announcer.setAttribute('aria-live', 'polite');
    _announcer.setAttribute('role', 'status');
    _announcer.className = 'sr-only';
    document.body.appendChild(_announcer);
  }
  _announcer.textContent = '';
  requestAnimationFrame(() => { if (_announcer) _announcer.textContent = msg; });
}


async function loadDir(dirPath, { fromHash = false } = {}) {
  state.files = state.files || {};
  const myReq = (state.files._reqId = (state.files._reqId || 0) + 1);
  state.files.loading = true; state.files.error = null; render();
  try {
    const j = await B.listDir(state.backend, dirPath || '');
    if (state.files._reqId !== myReq) return;
    if (j.path !== state.files.path) {
      state.files.filter = ''; state.files.shown = null;
      state.files.marked = new Set(); state.files._lastMarkIdx = null;
    } else if (state.files.marked && state.files.marked.size) {
      const alive = new Set((j.entries || []).map((e) => e.path || e.name));
      state.files.marked = new Set([...state.files.marked].filter((p) => alive.has(p)));
    }
    state.files.path = j.path;
    state.files.segments = j.segments || [];
    state.files.entries = j.entries || [];
    state.files.roots = j.roots || [];
    state.files.error = null;
    if (state.tab === 'files') writeHash({ push: !fromHash });
  } catch (e) {
    if (state.files._reqId !== myReq) return;
    state.files.error = e.status === 403
      ? 'That folder is outside the accessible folders, or access is denied.'
      : (e.status === 404 ? 'That folder no longer exists.' : (e.message || 'Could not list this directory.'));
    state.files.entries = [];
  }
  if (state.files._reqId !== myReq) return;
  state.files.loading = false; render();
}

const PREVIEW_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', tsx: 'tsx', py: 'python', rb: 'ruby', rs: 'rust',
  go: 'go', java: 'java', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
  cs: 'csharp', php: 'php', sh: 'bash', css: 'css', html: 'markup',
  xml: 'markup', svg: 'markup', json: 'json', yml: 'yaml', yaml: 'yaml',
  toml: 'toml', sql: 'sql', md: 'markdown',
};

async function loadPreviewContent(file) {
  state.files = state.files || {};
  const p = state.files.previewState = { loading: true, error: null, content: '', truncated: false, path: file.path };
  render();
  try {
    const { content, truncated } = await B.readFile(state.backend, file.path);
    if (state.files.preview?.path !== file.path) return;
    p.content = content; p.truncated = truncated;
  } catch (e) {
    if (state.files.preview?.path !== file.path) return;
    p.error = e.message;
  }
  p.loading = false; render();
}

function closePreview() {
  if (!state.files) return;
  state.files.preview = null;
  state.files.previewState = null;
  if (state.tab === 'files') writeHash();
  render();
}

function restoreFileFromHash(filePath) {
  const f = state.files || {};
  if (!filePath) {
    if (f.preview) { f.preview = null; f.previewState = null; render(); }
    return;
  }
  if (f.preview && f.preview.path === filePath) return;
  const entry = (f.entries || []).find(e => e.path === filePath);
  if (entry && entry.type !== 'dir') openPreview(entry, { fromHash: true });
}

function fileMutationCopy(e) {
  if (e.status === 403) return 'Permission denied, or the target is outside the accessible folders.';
  if (e.status === 404) return 'That file no longer exists.';
  if (e.status === 409) return e.message || 'A file with that name already exists.';
  if (e.status === 413) return 'Too large (50MB upload cap).';
  return e.message || 'The operation failed.';
}
function suggestAlternateName(name) {
  const m = /^(.*) \((\d+)\)(\.[^.]*)?$/.exec(name);
  if (m) return m[1] + ' (' + (parseInt(m[2], 10) + 1) + ')' + (m[3] || '');
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) + ' (2)' + name.slice(dot) : name + ' (2)';
}
function openFileDialog(kind, file) {
  const trigger = typeof document !== 'undefined' ? document.activeElement : null;
  state.files.dialog = { kind, file: file || null, error: null, busy: false, _trigger: trigger || null };
  render();
}
function restoreFileDialogFocus(trigger) {
  if (!trigger) return;
  requestAnimationFrame(() => { if (document.contains(trigger)) trigger.focus(); });
}
function filesMarked() {
  if (!(state.files.marked instanceof Set)) state.files.marked = new Set();
  return state.files.marked;
}
function markFile(f, { range = false } = {}) {
  const marked = filesMarked();
  const key = f.path || f.name;
  const list = state.files._sorted || [];
  const idx = list.findIndex((e) => (e.path || e.name) === key);
  if (range && state.files._lastMarkIdx != null && idx >= 0) {
    const [a, b] = [Math.min(state.files._lastMarkIdx, idx), Math.max(state.files._lastMarkIdx, idx)];
    for (const e of list.slice(a, b + 1)) {
      if (e.permissions === 'EACCES') continue;
      marked.add(e.path || e.name);
    }
  } else if (marked.has(key)) marked.delete(key);
  else marked.add(key);
  state.files._lastMarkIdx = idx >= 0 ? idx : null;
  render();
}
function clearFileSelection({ quiet = false } = {}) {
  const marked = filesMarked();
  if (!marked.size) return false;
  marked.clear();
  state.files._lastMarkIdx = null;
  if (!quiet) announce('selection cleared');
  render();
  return true;
}
async function runBulkDelete() {
  const d = state.files.dialog;
  if (!d || d.kind !== 'bulk-delete' || d.busy) return;
  const marked = filesMarked();
  const targets = (state.files.entries || []).filter((e) => marked.has(e.path || e.name));
  if (!targets.length) { state.files.dialog = null; restoreFileDialogFocus(d._trigger); render(); return; }
  d.busy = true; d.error = null; render();
  const results = await Promise.allSettled(
    targets.map((e) => B.deleteEntry(state.backend, e.path, e.type === 'dir')));
  if (state.files.dialog !== d) { announce('delete finished after the dialog closed'); render(); return; }
  const failed = targets.filter((_, i) => results[i].status === 'rejected');
  const okCount = targets.length - failed.length;
  if (!failed.length) {
    state.files.dialog = null;
    restoreFileDialogFocus(d._trigger);
    marked.clear(); state.files._lastMarkIdx = null;
    const successMsg = 'deleted ' + okCount + ' ' + (okCount === 1 ? 'entry' : 'entries');
    announce(successMsg);
    toast({ message: successMsg, kind: 'success' });
    const gone = new Set(targets.map((e) => e.path || e.name));
    state.files.entries = (state.files.entries || []).filter((e) => !gone.has(e.path || e.name));
    render();
    loadDir(state.files.path, { fromHash: true });
    return;
  }
  state.files.marked = new Set(failed.map((e) => e.path || e.name));
  const firstErr = results.find((r) => r.status === 'rejected');
  d.busy = false;
  d.error = 'deleted ' + okCount + ' of ' + targets.length + ' - '
    + (failed.length === 1 ? '1 entry' : failed.length + ' entries') + ' failed ('
    + fileMutationCopy(firstErr.reason || {}) + '). The failed entries stay selected.';
  await loadDir(state.files.path, { fromHash: true });
  render();
}
async function runBulkMove(destDir) {
  const d = state.files.dialog;
  if (!d || d.kind !== 'bulk-move' || d.busy) return;
  const marked = filesMarked();
  const targets = (state.files.entries || []).filter((e) => marked.has(e.path || e.name));
  if (!targets.length) { state.files.dialog = null; restoreFileDialogFocus(d._trigger); render(); return; }
  d.busy = true; d.error = null; render();
  try { await B.statPath(state.backend, destDir); }
  catch (e) {
    if (state.files.dialog !== d) { announce(fileMutationCopy(e)); render(); return; }
    d.busy = false;
    d.error = e.status === 404 ? 'that folder does not exist' : fileMutationCopy(e);
    render(); return;
  }
  const results = await Promise.allSettled(
    targets.map((e) => B.moveEntry(state.backend, e.path, destDir)));
  if (state.files.dialog !== d) { announce('move finished after the dialog closed'); render(); return; }
  const failed = targets.filter((_, i) => results[i].status === 'rejected');
  const okCount = targets.length - failed.length;
  if (!failed.length) {
    state.files.dialog = null;
    restoreFileDialogFocus(d._trigger);
    marked.clear(); state.files._lastMarkIdx = null;
    const successMsg = 'moved ' + okCount + ' ' + (okCount === 1 ? 'entry' : 'entries');
    announce(successMsg);
    toast({ message: successMsg, kind: 'success' });
    const gone = new Set(targets.map((e) => e.path || e.name));
    state.files.entries = (state.files.entries || []).filter((e) => !gone.has(e.path || e.name));
    render();
    loadDir(state.files.path, { fromHash: true });
    return;
  }
  state.files.marked = new Set(failed.map((e) => e.path || e.name));
  const firstErr = results.find((r) => r.status === 'rejected');
  d.busy = false;
  d.error = 'moved ' + okCount + ' of ' + targets.length + ' - '
    + (failed.length === 1 ? '1 entry' : failed.length + ' entries') + ' failed ('
    + fileMutationCopy(firstErr.reason || {}) + '). The failed entries stay selected.';
  await loadDir(state.files.path, { fromHash: true });
  render();
}
function closeFileDialog() {
  if (state.files.dialog?.busy) { announce('still working - please wait'); return; }
  const trigger = state.files.dialog?._trigger;
  state.files.dialog = null; render();
  restoreFileDialogFocus(trigger);
}
async function runFileMutation(fn, doneMsg, patch) {
  const d = state.files.dialog;
  if (!d || d.busy) return;
  d.busy = true; d.error = null; render();
  try {
    const result = await fn();
    state.files.dialog = null;
    restoreFileDialogFocus(d._trigger);
    announce(doneMsg);
    if (result && result.trashId) offerUndoDelete(result.trashId, doneMsg);
    else toast({ message: doneMsg, kind: 'success' });
    if (patch) {
      state.files.entries = patch(state.files.entries || []);
      render();
      loadDir(state.files.path, { fromHash: true });
    } else {
      await loadDir(state.files.path, { fromHash: true });
    }
  } catch (e) {
    if (state.files.dialog !== d) { announce(fileMutationCopy(e)); render(); return; }
    d.busy = false; d.error = fileMutationCopy(e); render();
  }
}
const UNDO_DELETE_WINDOW_MS = 10000;
let _undoDeleteTimer = null;
function offerUndoDelete(trashId, doneMsg) {
  clearTimeout(_undoDeleteTimer);
  state.files.undoDelete = { trashId, doneMsg };
  render();
  _undoDeleteTimer = setTimeout(() => { state.files.undoDelete = null; render(); }, UNDO_DELETE_WINDOW_MS);
}
async function undoDelete() {
  const u = state.files.undoDelete;
  if (!u) return;
  clearTimeout(_undoDeleteTimer);
  state.files.undoDelete = null;
  try {
    await B.restoreEntry(state.backend, u.trashId);
    announce('restored');
    await loadDir(state.files.path, { fromHash: true });
  } catch (e) {
    announce('could not restore: ' + fileMutationCopy(e));
    render();
  }
}
async function uploadFiles(fileList) {
  const dir = state.files.path;
  if (!dir || !fileList || !fileList.length) return;
  const items = Array.from(fileList).map((f) => ({ name: f.name, pct: 0, done: false, error: null, status: null, _file: f, _dir: dir }));
  state.files.uploads = (state.files.uploads || []).concat(items);
  render();
  if (state.files.uploading) return;
  state.files.uploading = true;
  try {
    let it;
    while ((it = (state.files.uploads || []).find(i => !i.done && !i.error && !i._started))) {
      it._started = true;
      try {
        await B.uploadFile(state.backend, it._dir, it._file);
        it.pct = 100; it.done = true;
        if (it._dir === state.files.path && !(state.files.entries || []).some((e) => e.name === it.name)) {
          state.files.entries = [...(state.files.entries || []),
            { name: it.name, path: (it._dir ? it._dir.replace(/\/$/, '') + '/' : '') + it.name, type: 'file', size: it._file.size, mtime: Date.now() }];
        }
      } catch (e) {
        it.status = e.status || null;
        it.error = fileMutationCopy(e);
      }
      render();
    }
  } finally {
    state.files.uploading = false;
  }
  announce('upload finished');
  await loadDir(state.files.path, { fromHash: true });
  if (!(state.files.uploads || []).some(i => i.error)) state.files.uploads = null;
  render();
}

async function retryUploadOverwrite(it) {
  if (!it || it._retrying || !it._file) return;
  it._retrying = true; it.error = null; it.status = null; render();
  try {
    await B.uploadFile(state.backend, it._dir, it._file, true);
    it.pct = 100; it.done = true;
  } catch (e) {
    it.status = e.status || null;
    it.error = fileMutationCopy(e);
  }
  it._retrying = false;
  await loadDir(state.files.path, { fromHash: true });
  if (!(state.files.uploads || []).some(i => i.error)) state.files.uploads = null;
  render();
}
function dismissUpload(it) {
  const ups = state.files.uploads || [];
  const i = ups.indexOf(it);
  if (i >= 0) ups.splice(i, 1);
  if (!ups.length) state.files.uploads = null;
  render();
}
function fileDialog() {
  const d = state.files && state.files.dialog;
  if (!d) return null;
  if (d.kind === 'rename') {
    return PromptDialog({
      title: 'Rename ' + d.file.name, value: d.suggestedValue ?? d.file.name, placeholder: 'new name',
      error: d.error || null, busy: !!d.busy,
      confirmLabel: d.busy ? 'renaming…' : 'rename', cancelLabel: 'cancel',
      onCancel: closeFileDialog,
      onConfirm: (v) => {
        if (!v || v === d.file.name) { d.error = 'enter a different name'; render(); return; }
        runFileMutation(() => B.renameEntry(state.backend, d.file.path, v), 'renamed to ' + v,
          (entries) => entries.map((e) => (e.path || e.name) === (d.file.path || d.file.name)
            ? { ...e, name: v, path: e.path ? e.path.slice(0, e.path.length - d.file.name.length) + v : v }
            : e))
          .then(() => {
            if (state.files.dialog === d && d.error && /already exists/i.test(d.error)) {
              d.suggestedValue = suggestAlternateName(v);
              render();
            }
          });
      },
    });
  }
  if (d.kind === 'delete') {
    const isDir = d.file.type === 'dir';
    return ConfirmDialog({
      title: 'Delete ' + d.file.name,
      message: isDir
        ? 'Delete this folder and everything inside it? You can undo this for a few seconds after.'
        : 'Delete this file? You can undo this for a few seconds after.',
      error: d.error || null, busy: !!d.busy,
      confirmLabel: d.busy ? 'deleting…' : 'delete', cancelLabel: 'cancel', destructive: true,
      onCancel: closeFileDialog,
      onConfirm: () => runFileMutation(() => B.deleteEntry(state.backend, d.file.path, isDir), 'deleted ' + d.file.name,
        (entries) => entries.filter((e) => (e.path || e.name) !== (d.file.path || d.file.name))),
    });
  }
  if (d.kind === 'bulk-delete') {
    const n = filesMarked().size;
    const hasDir = (state.files.entries || []).some((e) => filesMarked().has(e.path || e.name) && e.type === 'dir');
    return ConfirmDialog({
      title: 'Delete ' + n + ' selected ' + (n === 1 ? 'entry' : 'entries'),
      message: (hasDir
        ? 'Folders are deleted with everything inside them. '
        : '') + 'This cannot be undone.',
      error: d.error || null, busy: !!d.busy,
      confirmLabel: d.busy ? 'deleting…' : 'delete ' + n, cancelLabel: 'cancel', destructive: true,
      onCancel: closeFileDialog,
      onConfirm: runBulkDelete,
    });
  }
  if (d.kind === 'bulk-move') {
    const n = filesMarked().size;
    if (!d._validateDest) {
      d._validateDest = debounce(async (v) => {
        if (!v || v === state.files.path) return;
        try {
          const st = await B.statPath(state.backend, v);
          if (state.files.dialog !== d) return;
          d.error = (!st || st.ok === false) ? 'folder not found on the server'
            : (!st.dir ? 'that path is not a directory' : null);
        } catch (e) {
          if (state.files.dialog !== d) return;
          d.error = e.status === 403 ? 'outside the accessible folders'
            : (e.status === 404 ? 'folder not found on the server' : null);
        }
        render();
      }, 400);
    }
    return PromptDialog({
      title: 'Move ' + n + ' selected ' + (n === 1 ? 'entry' : 'entries'),
      value: d._draft ?? (state.files.path || ''), placeholder: 'destination folder path',
      error: d.error || null, busy: !!d.busy,
      confirmLabel: d.busy ? 'moving…' : 'move ' + n, cancelLabel: 'cancel',
      roots: (Array.isArray(state.files.roots) && state.files.roots.length > 1)
        ? state.files.roots.map((r) => ({ path: r, label: truncate(projectLabel(r) || r, 14, 24) }))
        : undefined,
      onCancel: closeFileDialog,
      onInput: (v) => { d._draft = v; d.error = null; d._validateDest(v); },
      onPickRoot: (v) => { d._draft = v; d.error = null; d._validateDest(v); render(); },
      onConfirm: (v) => {
        if (!v) { d.error = 'enter a destination folder'; render(); return; }
        if (v === state.files.path) { d.error = 'already in that folder - enter a different destination'; render(); return; }
        runBulkMove(v);
      },
    });
  }
  if (d.kind === 'mkdir') {
    return PromptDialog({
      title: 'New folder', value: d.suggestedValue ?? '', placeholder: 'folder name',
      error: d.error || null, busy: !!d.busy,
      confirmLabel: d.busy ? 'creating…' : 'create', cancelLabel: 'cancel',
      onCancel: closeFileDialog,
      onConfirm: (v) => {
        if (!v) { d.error = 'enter a folder name'; render(); return; }
        runFileMutation(() => B.makeDir(state.backend, state.files.path, v), 'created ' + v,
          (entries) => entries.some((e) => e.name === v)
            ? entries
            : [...entries, { name: v, path: (state.files.path ? state.files.path.replace(/\/$/, '') + '/' : '') + v, type: 'dir' }])
          .then(() => {
            if (state.files.dialog === d && d.error && /already exists/i.test(d.error)) {
              d.suggestedValue = suggestAlternateName(v);
              render();
            }
          });
      },
    });
  }
  return null;
}

function filePreviewBody(file) {
  const f = state.files || {};
  if (file.type === 'image') {
    return FilePreviewMedia({ src: B.imageUrl(state.backend, file.path), type: 'image', name: file.name });
  }
  const ps = f.previewState;
  if (!ps || ps.path !== file.path) { Promise.resolve().then(() => { if (state.files.preview?.path === file.path && state.files.previewState?.path !== file.path) loadPreviewContent(file); }); }
  if (!ps || ps.loading || ps.path !== file.path) {
    return h('div', { class: 't-meta empty-state', role: 'status', 'aria-live': 'polite' }, Spinner({ size: 'sm' }), 'loading…');
  }
  if (ps.error) {
    return Alert({ kind: 'warn', title: 'Cannot preview file', children: [
      h('span', { key: 'perr' }, ps.error),
      h('a', { key: 'dl', class: 'btn btn-sm', href: B.downloadUrl(state.backend, file.path), download: file.name }, 'download instead'),
    ] });
  }
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const lang = PREVIEW_LANG[ext];
  return lang
    ? FilePreviewCode({ content: ps.content, lang, filename: file.name })
    : FilePreviewText({ content: ps.content, truncated: ps.truncated });
}

function previewNeighbours() {
  const f = state.files || {};
  const file = f.preview;
  if (!file || !Array.isArray(f._sorted)) return { prev: null, next: null };
  const list = f._sorted.filter(e => e.type !== 'dir');
  const i = list.findIndex(e => e.path === file.path);
  if (i === -1) return { prev: null, next: null };
  return { prev: i > 0 ? list[i - 1] : null, next: i < list.length - 1 ? list[i + 1] : null };
}

function openPreview(file, { fromHash = false } = {}) {
  state.files.preview = file;
  if (state.tab === 'files') writeHash({ push: !fromHash });
  if (file.type !== 'image') loadPreviewContent(file);
  render();
}

function filePreview() {
  const f = state.files || {};
  const file = f.preview;
  if (!file) return null;
  const { prev, next } = previewNeighbours();
  return FileViewer({ file, body: filePreviewBody(file), onClose: closePreview,
    onPrev: prev ? () => openPreview(prev) : undefined,
    onNext: next ? () => openPreview(next) : undefined });
}

function filePreviewPane() {
  const f = state.files || {};
  const file = f.preview;
  if (!file) return FilePreviewPane({});
  const { prev, next } = previewNeighbours();
  return FilePreviewPane({ file, body: filePreviewBody(file), onClose: closePreview,
    onPrev: prev ? () => openPreview(prev) : undefined,
    onNext: next ? () => openPreview(next) : undefined });
}

function fileUp() {
  const f = state.files || {};
  const segs = (f.segments || []);
  if (segs.length <= 1) { loadDir(''); return; }
  const up = segs.slice(0, segs.length - 1);
  const joined = /^[A-Za-z]:$/.test(up[0]) ? up[0] + '\\' + up.slice(1).join('\\') : '/' + up.join('/');
  loadDir(joined);
}

function filesMain() {
  const f = state.files || {};
  if (!f.path && !f.loading && !f.error) { Promise.resolve().then(() => { if (!state.files.path && !state.files.loading) loadDir(''); }); }
  const crumb = BreadcrumbPath({
    root: 'root',
    segments: f.segments || [],
    onNav: (i) => {
      if (i === 0) { loadDir(''); return; }
      const segs = (f.segments || []).slice(0, i);
      const joined = segs.length && /^[A-Za-z]:$/.test(segs[0]) ? segs[0] + '\\' + segs.slice(1).join('\\') : '/' + segs.join('/');
      loadDir(joined);
    },
  });
  const mapped = (f.entries || []).map((e) => {
    const ts = e.modified ? Date.parse(e.modified) : 0;
    return { name: e.name, type: e.type, size: e.size, modified: ts ? fmtRelTime(ts) : null, modifiedTs: ts, path: e.path, permissions: e.permissions };
  });
  const filtered = f.filter
    ? mapped.filter(e => e.name.toLowerCase().includes(f.filter.toLowerCase()))
    : mapped;
  const sorted = sortFiles(filtered, f.sort || 'name', f.sortDir || 'asc');
  state.files._sorted = sorted;
  let body;
  if (f.error) {
    body = Alert({ key: 'ferr', kind: 'warn', title: 'Cannot list directory', children: f.error });
  } else {
    body = FileGrid({
      files: sorted,
      loading: f.loading,
      shown: f.shown,
      onShowMore: (n) => { state.files.shown = n; render(); },
      emptyText: f.filter ? 'No files match "' + f.filter + '"' : 'Empty directory',
      selectable: !!f.path,
      marked: filesMarked(),
      onMark: markFile,
      onSelectAll: (keys) => { state.files.marked = new Set(keys); state.files._lastMarkIdx = null; announce(keys.length + ' selected'); render(); },
      onClearSelection: () => clearFileSelection(),
      density: f.density || 'list',
      onDensity: (d2) => { state.files.density = d2; persistFilesPrefs(); render(); },
      thumbUrl: (file) => B.downloadUrl(state.backend, file.path),
      sort: { key: f.sort || 'name', dir: f.sortDir || 'asc', onSort: (k) => {
        if (state.files.sort === k) state.files.sortDir = state.files.sortDir === 'asc' ? 'desc' : 'asc';
        else { state.files.sort = k; state.files.sortDir = 'asc'; }
        persistFilesPrefs();
        render();
      } },
      filter: { value: f.filter || '', placeholder: 'Filter by name', onInput: debouncedFilesFilter },
      onUp: fileUp,
      onOpen: (file) => {
        if (file.permissions === 'EACCES') { announce('no access to ' + file.name); return; }
        if (file.type === 'dir') loadDir(file.path);
        else openPreview(file);
      },
      onAction: (act, file) => {
        if (file.permissions === 'EACCES') { announce('no access to ' + file.name); return; }
        if (act === 'download' && file.type !== 'dir') {
          const a = document.createElement('a');
          a.href = B.downloadUrl(state.backend, file.path);
          a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
        }
        if (act === 'rename') openFileDialog('rename', file);
        if (act === 'delete') openFileDialog('delete', file);
        if (act === 'move') {
          state.files.marked = new Set([file.path || file.name]);
          state.files._lastMarkIdx = null;
          openFileDialog('bulk-move', file);
        }
      },
    });
  }
  const roots = Array.isArray(f.roots) ? f.roots : [];
  const rootsRow = roots.length > 1
    ? RootsPicker({
        roots: roots.map((r) => ({ id: r, label: truncate(projectLabel(r) || r, 16, 28) })),
        selected: f.path, onSelect: (r) => loadDir(r), label: 'Jump to an accessible folder',
      })
    : null;

  const toolbar = FileToolbar({
    left: [crumb],
    right: [
      Btn({ key: 'up', disabled: (f.segments || []).length <= 1, 'aria-label': 'up a directory', onClick: () => fileUp(), children: 'up' }),
      f.path ? Btn({ key: 'newdir', onClick: () => openFileDialog('mkdir'), children: 'new folder' }) : null,
      f.path ? Btn({ key: 'upload', onClick: () => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true;
        inp.style.position = 'fixed'; inp.style.opacity = '0';
        document.body.appendChild(inp);
        inp.onchange = () => { uploadFiles(inp.files); inp.remove(); };
        inp.click();
      }, children: 'upload' }) : null,

    ].filter(Boolean),
  });
  const droppableBody = f.path && !f.error
    ? DropZone({
        dragover: !!f.dragover,
        label: 'drop files to upload to this folder',
        onDragOver: () => { if (!state.files.dragover) { state.files.dragover = true; render(); } },
        onDragLeave: () => { if (state.files.dragover) { state.files.dragover = false; render(); } },
        onDrop: (files, ev) => {
          state.files.dragover = false;
          const items = ev && ev.dataTransfer && ev.dataTransfer.items;
          const FOLDER_DROP_MSG = 'folders cannot be dropped - use new folder to create one';
          if (items) {
            const hasDir = Array.from(items).some(it => { try { return it.webkitGetAsEntry && it.webkitGetAsEntry()?.isDirectory; } catch { return false; } });
            if (hasDir) { announce(FOLDER_DROP_MSG); return; }
          } else if (!files || !files.length) {
            announce(FOLDER_DROP_MSG); return;
          }
          uploadFiles(files);
        },
        children: body,
      })
    : body;
  return [
    offlineBanner(),
    f.undoDelete ? Alert({ key: 'undodel', kind: 'info', title: 'Deleted',
      children: [
        h('span', { key: 'udtxt' }, (f.undoDelete.doneMsg || 'Deleted') + ' - undo within a few seconds. '),
        Btn({ key: 'udbtn', onClick: () => undoDelete(), children: 'undo' })] }) : null,
    PageHeader({ compact: true, dense: true, title: 'Files', lede: 'Browse and manage files in the allowed folders.' }),
    h('div', { key: 'fstack', class: 'ds-files-stack' }, ...[
      rootsRow ? h('div', { key: 'froots' }, rootsRow) : null,
      h('div', { key: 'ftb' }, toolbar),
      filesMarked().size ? h('div', { key: 'fbulk' }, BulkBar({
        count: filesMarked().size,
        noun: 'entry',
        busy: !!(f.dialog && (f.dialog.kind === 'bulk-delete' || f.dialog.kind === 'bulk-move') && f.dialog.busy),
        actions: [
          { label: 'move selected', onClick: () => openFileDialog('bulk-move') },
          { label: 'delete selected', danger: true, onClick: () => openFileDialog('bulk-delete') },
        ],
        onClear: () => clearFileSelection(),
      })) : null,
      (f.uploads && f.uploads.length) ? h('div', { key: 'fup' }, UploadProgress({
        items: f.uploads.map((it) => {
          const base = (!it.error && !it.done && !it.pct) ? { ...it, indeterminate: true } : it;
          return (base.error && base.status === 409 && !base._retrying)
            ? { ...base, actions: [{ label: 'replace', onClick: () => retryUploadOverwrite(base) }] }
            : base;
        }),
        onDismiss: (item, i) => {
          const src = (state.files.uploads || [])[i];
          if (src && src.error) dismissUpload(src);
        },
      })) : null,
      h('div', { key: 'fbody' }, droppableBody),
    ].filter(Boolean)),
    fileDialog(),
    (f.preview && isNarrow()) ? h('div', { key: 'fprev' }, filePreview()) : null,
  ].filter(Boolean);
}

const FILES_PREFS_KEY = 'agentgui.files';

function persistFilesPrefs() {
  lsSet(FILES_PREFS_KEY, JSON.stringify({ sort: state.files.sort || 'name', sortDir: state.files.sortDir || 'asc', density: state.files.density || 'list' }));
}

function hydratePrefs() {
  try {
    const fp = JSON.parse(lsGet(FILES_PREFS_KEY) || 'null');
    if (fp) {
      if (fp.sort) state.files.sort = fp.sort;
      if (fp.sortDir) state.files.sortDir = fp.sortDir;
      if (fp.density) state.files.density = fp.density;
    }
  } catch {}
}

function offlineBanner() {
  if (state.sessionExpired) {
    return Alert({ key: 'sessionexpired', kind: 'error', title: 'Session expired',
      children: [
        h('span', { key: 'setxt' }, 'Your access token is no longer valid (it may have rotated or expired). Reload the page to sign in again. '),
        Btn({ key: 'sereload', onClick: () => window.location.reload(), children: 'reload now' }),
      ] });
  }
  if (state.health.status === 'ok' || state.health.status === 'unknown') return null;
  return Alert({ key: 'offline', kind: 'error', title: 'Backend unreachable',
    children: [
      h('span', { key: 'otxt' }, 'agentgui can\'t reach the server (' + (state.health.error || state.health.status) + '). File and terminal actions will fail until it reconnects. '),
      Btn({ key: 'oretry', disabled: !!state.healthChecking, onClick: () => recheckHealth(), children: state.healthChecking ? 'checking…' : 'retry now' }),
    ] });
}

function projectLabel(project) {
  if (!project) return '';
  if (/[/\\]/.test(project)) return project.split(/[/\\]/).filter(Boolean).pop() || project;
  const segs = project.split('-').filter(Boolean);
  return segs.length ? segs[segs.length - 1] : project;
}

const debouncedFilesFilter = debounce((v) => { state.files.filter = v; state.files.shown = null; if (state.tab === 'files') writeHash(); render(); }, 150);

let _healthPollTimer = null;
function stopHealthPolling() { if (_healthPollTimer) { clearInterval(_healthPollTimer); _healthPollTimer = null; } }
function startHealthPolling() {
  if (_healthPollTimer) return;
  _healthPollTimer = setInterval(() => {
    if (state.health.status === 'ok') { stopHealthPolling(); return; }
    recheckHealth();
  }, 10000);
}
async function recheckHealth() {
  const wasOk = state.health.status === 'ok';
  state.healthChecking = true;
  const r = await B.probeBackend(state.backend);
  state.healthChecking = false;
  if (r.ok) {
    state.health = { status: 'ok', ...r.info };
    stopHealthPolling();
    if (!wasOk) { announce('reconnected'); }
  } else {
    state.health = { status: 'down', ...r };
    startHealthPolling();
  }
  applyHealth();
  render();
}

const BUILD_FRESHNESS_POLL_MS = 90000;
let _buildFreshnessTimer = null;
let _buildStaleNoticeShown = false;
function startBuildFreshnessPoll() {
  if (_buildFreshnessTimer || !window.__SERVER_VERSION) return;
  _buildFreshnessTimer = setInterval(async () => {
    if (_buildStaleNoticeShown) return;
    const r = await B.probeBackend(state.backend);
    if (r.ok && r.info && r.info.version && r.info.version !== window.__SERVER_VERSION) {
      _buildStaleNoticeShown = true;
      clearInterval(_buildFreshnessTimer);
      _buildFreshnessTimer = null;
      toast({
        message: 'A new version is available',
        kind: 'info',
        duration: 0,
        actionLabel: 'reload',
        onAction: (dismiss) => { dismiss(); location.reload(); },
      });
    }
  }, BUILD_FRESHNESS_POLL_MS);
}

const terminals = createTerminals({
  base: state.backend,
  tabbar: document.getElementById('tabbar'),
  host: document.getElementById('term-host'),
  filesRoot: document.getElementById('files-root'),
  onSelect: (id) => navTo(id),
  announce,
});

function applyHealth() {
  const ok = state.health.status === 'ok';
  const on = ok && !!state.health.terminalsEnabled;
  terminals.setAvailability(on, ok ? (on ? '' : DISABLED_COPY) : 'Backend unreachable. Terminals are unavailable.');
}

function navTo(tab, { writeHash: doWriteHash = true, push = true } = {}) {
  state.tab = terminals.show(tab);
  if (state.tab === 'files' && !state.files.path && !state.files.loading && !state.files.error) loadDir('');
  if (doWriteHash) writeHash({ push });
  announce('now on ' + terminals.labelOf(state.tab));
  render();
}

function view() {
  const split = !!state.files.preview && !isNarrow();
  return h('div', { key: 'files-view', id: 'agentgui-main', class: 'files-view' }, [
    h('div', { key: 'files-main', class: 'files-main' }, filesMain()),
    split ? h('div', { key: 'files-pane', class: 'files-pane' }, filePreviewPane()) : null,
  ].filter(Boolean));
}

async function init() {
  state.health = { status: 'unknown' };
  render();
  try {
    const r = await B.probeBackend(state.backend);
    state.health = r.ok ? { status: 'ok', ...r.info } : { status: 'down', ...r };
  } catch (e) {
    state.health = { status: 'error', error: e.message };
  }
  applyHealth();
  if (state.health.status !== 'ok') startHealthPolling();
  startBuildFreshnessPoll();
  const hp = readHash();
  const wantsFiles = !hp.tab || hp.tab === 'files';
  if (wantsFiles && hp.dir) {
    if (hp.filter) state.files.filter = hp.filter;
    loadDir(hp.dir, { fromHash: true }).then(() => restoreFileFromHash(hp.file));
  }
  navTo('files', { writeHash: false, push: false });
  await terminals.restore();
  if (!wantsFiles && terminals.has(hp.tab)) navTo(hp.tab, { push: false });
  render();
}

window.addEventListener('popstate', () => {
  const hp = readHash();
  const wanted = !hp.tab || hp.tab === 'files' ? 'files' : hp.tab;
  const target = wanted === 'files' || terminals.has(wanted) ? wanted : 'files';
  if (target !== state.tab) navTo(target, { writeHash: false });
  if (target === 'files') {
    const cur = state.files && state.files.path;
    if (hp.filter !== undefined && hp.filter !== null) state.files.filter = hp.filter || '';
    if (hp.dir && hp.dir !== cur) loadDir(hp.dir, { fromHash: true }).then(() => restoreFileFromHash(hp.file));
    else restoreFileFromHash(hp.file);
  }
  render();
});

window.addEventListener('resize', debounce(() => scheduleRender(), 150));

window.__agentgui = { state, render };

B.onSessionExpired(() => {
  state.sessionExpired = true;
  render();
});

installShortcuts({ state, announce, closeFileDialog, filesMarked, clearFileSelection, previewNeighbours, openPreview });

hydratePrefs();
render = mount(document.getElementById('files-root'), view);

init();

