import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

// Module-level platform constant — never changes at runtime.
export const IS_WINDOWS = os.platform() === 'win32';

// Confine a requested filesystem path to an allowlist of roots. Two layers:
//   1. normalize + resolved-prefix check on the LEXICAL path (blocks `../`
//      traversal, which path.normalize collapses so a literal `..` test is a
//      no-op);
//   2. fs.realpathSync + the SAME prefix check on the REAL path, so a symlink
//      that lives inside an allowed root but points outside it cannot escape
//      (the lexical path passes layer 1, the resolved target fails layer 2).
// Returns { ok, realPath, reason }. realPath is the symlink-resolved absolute
// path to stat/read; callers use it, never the raw input. A non-existent path
// has no realpath yet, so it fails closed with reason 'not found'.
export function confineToRoots(inputPath, allowRoots) {
  const norms = allowRoots.map(r => path.normalize(r));
  const expanded = inputPath && inputPath.startsWith('~') ? inputPath.replace('~', os.homedir()) : inputPath;
  const normalizedPath = path.normalize(expanded || '');
  const isAbsolute = IS_WINDOWS ? /^[A-Za-z]:[\\/]/.test(normalizedPath) : normalizedPath.startsWith('/');
  const within = (p) => {
    const np = IS_WINDOWS ? p.toLowerCase() : p;
    return norms.some(root => {
      const r = IS_WINDOWS ? root.toLowerCase() : root;
      return np === r || np.startsWith(r + path.sep);
    });
  };
  if (!isAbsolute || !within(normalizedPath)) return { ok: false, reason: 'path outside allowed roots' };
  // realpath the target and re-confine, defeating symlink escape (TOCTOU/link
  // traversal). If realpath throws (missing path / broken link) fail closed.
  let realPath;
  try { realPath = fs.realpathSync(normalizedPath); }
  catch (e) { return { ok: false, reason: e && e.code === 'ENOENT' ? 'not found' : 'cannot resolve path', code: e && e.code }; }
  if (!within(realPath)) return { ok: false, reason: 'symlink target outside allowed roots' };
  return { ok: true, realPath };
}

// Mask ?token=VALUE in a URL string before logging so credentials never
// appear in server logs or error messages.
export function maskToken(url) {
  if (typeof url !== 'string') return url;
  return url.replace(/([?&]token=)[^&]*/gi, '$1***');
}

// Secret-bearing basenames that must never be readable through ANY confined
// raw-bytes route (preview or download), even when they sit inside an allowed
// root: dotfiles, env/key/cert material, and credential stores. One const so
// /api/file and /api/download can never drift apart.
export const SECRET_RE = /(^\.|\.(env|pem|key|crt|p12|pfx)$|secret|credential|\.npmrc$|\.netrc$)/i;

// The allowlist the Files surface operates within: server cwd + Claude
// projects dir, widened via FS_ROOTS (path-separated). One construction so
// /api/list,file,download and the mutation routes can never drift apart.
export function fsAllowRoots() {
  const roots = [
    process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects'),
  ];
  // The server cwd is only exposed when PASSWORD is set (the witnessed
  // localhost-PASSWORD deploy lists the repo tree) or FS_ALLOW_CWD=1 is opted
  // in. An open no-PASSWORD deploy must NOT expose the whole server tree.
  if (process.env.PASSWORD || process.env.FS_ALLOW_CWD === '1') {
    roots.push(process.env.STARTUP_CWD || process.cwd());
  }
  if (process.env.FS_ROOTS) roots.push(...process.env.FS_ROOTS.split(path.delimiter));
  return roots.map(r => path.normalize(r));
}

// A new file/dir name must be a single path component: no separators, no
// traversal, no NTFS alternate-data-stream colon, no reserved Windows device
// names, no trailing dot/space (Windows silently strips them, aliasing two
// names onto one entry). Returns the trimmed name or null when inadmissible.
export function sanitizeEntryName(name) {
  if (typeof name !== 'string') return null;
  const n = name.trim();
  if (!n || n.length > 255) return null;
  if (/[\\/:*?"<>|\x00-\x1f]/.test(n)) return null;
  if (n === '.' || n === '..') return null;
  if (/[. ]$/.test(n)) return null;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(n)) return null;
  return n;
}

// Every confined filesystem route accepts its target path via a `?path=`/
// `?dir=` query param, preferred over a path SEGMENT. A reverse proxy's
// proxy_pass URI normalization can decode-then-reencode the request path,
// collapsing an encoded %2F segment slash back into a literal '/' before
// forwarding - the app then sees extra path segments instead of one opaque
// one, strips what it thinks is a leading '/', and silently turns an absolute
// path into a relative one that fails confinement even for genuinely
// accessible directories/files. A query param is untouched by that
// normalization on any proxy in front of this app. `legacyPrefix` is the old
// `/api/xxx/<path>` route prefix, still accepted for any caller not yet
// updated to the query-param form.
export function resolveConfinedPath(req, routePath, queryKey, legacyPrefix) {
  const url = new URL(req.url, 'http://x');
  const qVal = url.searchParams.get(queryKey);
  if (qVal != null) return qVal;
  const raw = routePath.split('?')[0].slice(legacyPrefix.length).replace(/^\//, '');
  return raw ? decodeURIComponent(raw) : '';
}

// Map a Node.js filesystem error code to a safe human-readable string that
// does not disclose host paths or internal stack context. Used everywhere an
// err.message would otherwise be returned to the client.
export function safeErrMsg(err) {
  if (!err) return 'unknown error';
  switch (err.code) {
    case 'ENOENT': return 'file not found';
    case 'EACCES': return 'permission denied';
    case 'EPERM':  return 'operation not permitted';
    case 'EISDIR': return 'path is a directory';
    case 'ENOTDIR': return 'path is not a directory';
    case 'ENOTEMPTY': return 'directory is not empty';
    case 'EEXIST': return 'file already exists';
    case 'EXDEV': return 'cannot move across drives';
    case 'EMFILE': return 'too many open files';
    case 'ENOSPC': return 'no space left on device';
    default: return 'operation failed';
  }
}

// Read a request body with a hard size cap; resolves a Buffer or rejects with
// .code='TOO_LARGE' so the caller can answer 413 without buffering the rest.
// Stops accumulating further chunks (req.pause()) but does NOT destroy the
// socket - a destroyed request cannot carry the caller's 413 response back to
// the client, which instead sees a raw ECONNRESET with zero information
// (live-witnessed: fetch() reported only "fetch failed", no status code).
// The still-open connection is closed normally once the 413 response is sent.
export function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = []; let total = 0; let tooLarge = false;
    req.on('data', (c) => {
      if (tooLarge) return;
      total += c.length;
      if (total > maxBytes) {
        tooLarge = true;
        req.pause();
        const e = new Error('body too large'); e.code = 'TOO_LARGE';
        reject(e);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

// True when the resolved path IS one of the allowlist roots - the roots
// themselves are never mutation targets (rename/delete of a root would orphan
// the whole surface).
export function isAllowRoot(realPath, allowRoots) {
  const p = IS_WINDOWS ? realPath.toLowerCase() : realPath;
  return allowRoots.some(r => (IS_WINDOWS ? r.toLowerCase() : r) === p);
}

// --- Soft-delete (trash) -----------------------------------------------
// /api/delete moves entries into <root>/.agentgui-trash/<trashId>__<name>
// instead of unlinking, giving a short undo window. In-memory index only
// (server restart forfeits the undo window - acceptable since the retention
// window itself is short and this is a convenience net on top of, not a
// replacement for, the pre-delete ConfirmDialog). Purged after
// TRASH_RETENTION_MS or when trashIndex grows past TRASH_MAX_ENTRIES
// (oldest-first), so a long-running server's trash dir can't grow unbounded.
const TRASH_DIR_NAME = '.agentgui-trash';
const TRASH_RETENTION_MS = parseInt(process.env.AGENTGUI_TRASH_RETENTION_MS || '', 10) || 10 * 60 * 1000;
const TRASH_MAX_ENTRIES = 200;
const trashIndex = new Map(); // trashId -> { trashPath, originalPath, root, deletedAt }

function purgeExpiredTrash() {
  const now = Date.now();
  for (const [id, info] of trashIndex) {
    if (now - info.deletedAt > TRASH_RETENTION_MS) {
      try { fs.rmSync(info.trashPath, { recursive: true, force: true }); } catch { /* already gone */ }
      trashIndex.delete(id);
    }
  }
  if (trashIndex.size > TRASH_MAX_ENTRIES) {
    const sorted = [...trashIndex.entries()].sort((a, b) => a[1].deletedAt - b[1].deletedAt);
    for (const [id, info] of sorted.slice(0, trashIndex.size - TRASH_MAX_ENTRIES)) {
      try { fs.rmSync(info.trashPath, { recursive: true, force: true }); } catch {}
      trashIndex.delete(id);
    }
  }
}

// Which allowed root a confined realPath lives under - the trash dir sits
// alongside it (still inside the SAME root, so confineToRoots covers the
// trash path too - no new unconfined surface).
function rootFor(realPath, allowRoots) {
  const p = IS_WINDOWS ? realPath.toLowerCase() : realPath;
  return allowRoots.find(r => { const rr = IS_WINDOWS ? r.toLowerCase() : r; return p === rr || p.startsWith(rr + path.sep); });
}

export function moveToTrash(realPath, allowRoots) {
  purgeExpiredTrash();
  const root = rootFor(realPath, allowRoots);
  if (!root) { const e = new Error('not confined to an allowed root'); e.code = 'EACCES'; throw e; }
  const trashDir = path.join(root, TRASH_DIR_NAME);
  fs.mkdirSync(trashDir, { recursive: true });
  const trashId = crypto.randomBytes(8).toString('hex');
  const base = path.basename(realPath);
  const trashPath = path.join(trashDir, trashId + '__' + base);
  fs.renameSync(realPath, trashPath);
  trashIndex.set(trashId, { trashPath, originalPath: realPath, root, deletedAt: Date.now() });
  return { trashId };
}

export function restoreFromTrash(trashId, allowRoots) {
  const info = trashIndex.get(trashId);
  if (!info) { const e = new Error('nothing to restore - the undo window has expired or this was already restored'); e.code = 'NOT_FOUND'; throw e; }
  // Re-confine the ORIGINAL path at restore time (not trust the cached one
  // blindly) - the allowlist itself doesn't change at runtime, but this keeps
  // restore honoring the exact same confinement contract every other route does.
  const conf = confineToRoots(info.originalPath, allowRoots);
  if (!conf.ok && conf.reason !== 'not found') { const e = new Error('restore target is no longer inside an accessible folder'); e.code = 'CONFLICT'; throw e; }
  if (fs.existsSync(info.originalPath)) { const e = new Error('a file already exists at the original location'); e.code = 'CONFLICT'; throw e; }
  fs.mkdirSync(path.dirname(info.originalPath), { recursive: true });
  fs.renameSync(info.trashPath, info.originalPath);
  trashIndex.delete(trashId);
  return { path: info.originalPath };
}
