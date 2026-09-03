import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  confineToRoots, fsAllowRoots, sanitizeEntryName, safeErrMsg, readBody,
  isAllowRoot, moveToTrash, restoreFromTrash, SECRET_RE,
} from './shared.js';

// --- File mutations ----------------------------------------------------
// The Files surface is a real manager (fsbrowse-grade): rename, delete,
// mkdir, upload. Every route re-confines via confineToRoots (realpath, so
// a symlink inside a root cannot point a mutation outside it), refuses
// the roots themselves as targets, and sanitizes any NEW name to a single
// path component (sanitizeEntryName). All are POST/PUT-only with JSON or
// raw-byte bodies; errors map to plain machine codes the client renders
// as human copy.

// POST /api/rename {path, newName} -> {ok, path}
export async function handleRename(req, res, sendJSON) {
  let body;
  try { body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}'); }
  catch (e) { sendJSON(req, res, e.code === 'TOO_LARGE' ? 413 : 400, { error: 'bad request body' }); return; }
  const allowRoots = fsAllowRoots();
  const conf = confineToRoots(String(body.path || ''), allowRoots);
  if (!conf.ok) { sendJSON(req, res, conf.reason === 'not found' ? 404 : 403, { error: 'forbidden: ' + conf.reason }); return; }
  if (isAllowRoot(conf.realPath, allowRoots)) { sendJSON(req, res, 403, { error: 'forbidden: cannot rename an allowed root' }); return; }
  const newName = sanitizeEntryName(body.newName);
  if (!newName) { sendJSON(req, res, 400, { error: 'invalid name' }); return; }
  if (SECRET_RE.test(newName)) { sendJSON(req, res, 403, { error: 'forbidden: secret/dotfile name' }); return; }
  const target = path.join(path.dirname(conf.realPath), newName);
  // The target stays in the same (already-confined) directory by
  // construction, but re-check anyway so the invariant is local.
  const tConf = confineToRoots(path.dirname(target), allowRoots);
  if (!tConf.ok) { sendJSON(req, res, 403, { error: 'forbidden: target outside allowed roots' }); return; }
  if (fs.existsSync(target)) { sendJSON(req, res, 409, { error: 'a file with that name already exists' }); return; }
  try { fs.renameSync(conf.realPath, target); sendJSON(req, res, 200, { ok: true, path: target }); }
  catch (err) { sendJSON(req, res, err.code === 'EACCES' || err.code === 'EPERM' ? 403 : 400, { error: safeErrMsg(err) }); }
}

// POST /api/move {path, destDir, overwrite?} -> {ok, path}. Moves an
// entry into another directory; BOTH endpoints re-confine via realpath.
// Refuses: a root as the source, a directory moved into itself or its
// own subtree, and an existing target unless overwrite:true (and never
// overwrites a directory).
export async function handleMove(req, res, sendJSON) {
  let body;
  try { body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}'); }
  catch (e) { sendJSON(req, res, e.code === 'TOO_LARGE' ? 413 : 400, { error: 'bad request body' }); return; }
  const allowRoots = fsAllowRoots();
  const conf = confineToRoots(String(body.path || ''), allowRoots);
  if (!conf.ok) { sendJSON(req, res, conf.reason === 'not found' ? 404 : 403, { error: 'forbidden: ' + conf.reason }); return; }
  if (isAllowRoot(conf.realPath, allowRoots)) { sendJSON(req, res, 403, { error: 'forbidden: cannot move an allowed root' }); return; }
  const dConf = confineToRoots(String(body.destDir || ''), allowRoots);
  if (!dConf.ok) { sendJSON(req, res, dConf.reason === 'not found' ? 404 : 403, { error: 'forbidden: ' + dConf.reason }); return; }
  let destIsDir = false;
  try { destIsDir = fs.statSync(dConf.realPath).isDirectory(); } catch {}
  if (!destIsDir) { sendJSON(req, res, 400, { error: 'destination is not a directory' }); return; }
  const name = sanitizeEntryName(path.basename(conf.realPath));
  if (!name) { sendJSON(req, res, 400, { error: 'invalid name' }); return; }
  // A directory must never move into itself or its own subtree.
  const srcPrefix = conf.realPath + path.sep;
  if (dConf.realPath === conf.realPath || dConf.realPath.startsWith(srcPrefix)) {
    sendJSON(req, res, 400, { error: 'cannot move a folder into itself' }); return;
  }
  const target = path.join(dConf.realPath, name);
  if (target === conf.realPath) { sendJSON(req, res, 200, { ok: true, path: target }); return; }
  if (fs.existsSync(target)) {
    let targetIsDir = false;
    try { targetIsDir = fs.lstatSync(target).isDirectory(); } catch {}
    if (targetIsDir || body.overwrite !== true) {
      sendJSON(req, res, 409, { error: 'a file with that name already exists' }); return;
    }
  }
  try { fs.renameSync(conf.realPath, target); sendJSON(req, res, 200, { ok: true, path: target }); }
  catch (err) {
    const code = err.code === 'EACCES' || err.code === 'EPERM' ? 403 : 400;
    sendJSON(req, res, code, { error: err.code === 'EXDEV' ? 'cannot move across drives' : err.message });
  }
}

// POST /api/delete {path, recursive?} -> {ok}. Deleting a non-empty dir
// requires recursive:true (the client confirms first).
export async function handleDelete(req, res, sendJSON) {
  let body;
  try { body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}'); }
  catch (e) { sendJSON(req, res, e.code === 'TOO_LARGE' ? 413 : 400, { error: 'bad request body' }); return; }
  const allowRoots = fsAllowRoots();
  const conf = confineToRoots(String(body.path || ''), allowRoots);
  if (!conf.ok) { sendJSON(req, res, conf.reason === 'not found' ? 404 : 403, { error: 'forbidden: ' + conf.reason }); return; }
  if (isAllowRoot(conf.realPath, allowRoots)) { sendJSON(req, res, 403, { error: 'forbidden: cannot delete an allowed root' }); return; }
  try {
    const st = fs.lstatSync(conf.realPath);
    // Soft-delete: move into a confined per-root .agentgui-trash/ instead
    // of unlinking, so the only safety net isn't confirm-before (the
    // pre-existing ConfirmDialog) but also undo-after, matching an
    // fsbrowse-grade file manager. A non-empty directory without
    // recursive=true still throws ENOTEMPTY BEFORE any move happens
    // (checked via a dry probe) to keep that existing guard's semantics.
    if (st.isDirectory() && body.recursive !== true) {
      const dryEntries = fs.readdirSync(conf.realPath);
      if (dryEntries.length) { sendJSON(req, res, 409, { error: 'directory is not empty' }); return; }
    }
    const trashInfo = moveToTrash(conf.realPath, allowRoots);
    sendJSON(req, res, 200, { ok: true, trashId: trashInfo.trashId });
  } catch (err) {
    const code = err.code === 'ENOTEMPTY' ? 409 : (err.code === 'EACCES' || err.code === 'EPERM' ? 403 : (err.code === 'ENOENT' ? 404 : 400));
    sendJSON(req, res, code, { error: err.code === 'ENOTEMPTY' ? 'directory is not empty' : err.message });
  }
}

// POST /api/restore {trashId} -> {ok, path}. Undoes a /api/delete within
// its retention window (trashRetentionMs, default 10 minutes) by moving
// the entry back from .agentgui-trash/ to its original confined path.
export async function handleRestore(req, res, sendJSON) {
  let body;
  try { body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}'); }
  catch (e) { sendJSON(req, res, e.code === 'TOO_LARGE' ? 413 : 400, { error: 'bad request body' }); return; }
  try {
    const restored = restoreFromTrash(String(body.trashId || ''), fsAllowRoots());
    sendJSON(req, res, 200, { ok: true, path: restored.path });
  } catch (err) {
    sendJSON(req, res, err.code === 'NOT_FOUND' ? 404 : (err.code === 'CONFLICT' ? 409 : 400), { error: err.message });
  }
}

// POST /api/mkdir {dir, name} -> {ok, path}. dir must exist inside roots.
export async function handleMkdir(req, res, sendJSON) {
  let body;
  try { body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}'); }
  catch (e) { sendJSON(req, res, e.code === 'TOO_LARGE' ? 413 : 400, { error: 'bad request body' }); return; }
  const allowRoots = fsAllowRoots();
  const conf = confineToRoots(String(body.dir || ''), allowRoots);
  if (!conf.ok) { sendJSON(req, res, conf.reason === 'not found' ? 404 : 403, { error: 'forbidden: ' + conf.reason }); return; }
  const name = sanitizeEntryName(body.name);
  if (!name) { sendJSON(req, res, 400, { error: 'invalid name' }); return; }
  if (SECRET_RE.test(name)) { sendJSON(req, res, 403, { error: 'forbidden: secret/dotfile name' }); return; }
  const target = path.join(conf.realPath, name);
  if (fs.existsSync(target)) { sendJSON(req, res, 409, { error: 'a file with that name already exists' }); return; }
  try { fs.mkdirSync(target); sendJSON(req, res, 200, { ok: true, path: target }); }
  catch (err) { sendJSON(req, res, err.code === 'EACCES' || err.code === 'EPERM' ? 403 : 400, { error: err.message }); }
}

// PUT /api/upload-file?dir=<enc>&name=<enc> with raw file bytes as the
// body (no multipart dependency; the client sends fetch(file)). 50MB cap,
// never overwrites unless ?overwrite=1. Distinct path from the legacy
// express-mounted /api/upload/:conversationId.
export async function handleUploadFile(req, res, sendJSON) {
  let qs;
  try { qs = new URL(req.url, 'http://localhost').searchParams; } catch { qs = new URLSearchParams(); }
  // Require Content-Length header: rejects chunked or missing-length requests
  // that could claim any size. Pre-validates the announced size before streaming.
  const contentLength = req.headers['content-length'];
  if (!contentLength) {
    sendJSON(req, res, 411, { error: 'length required' }); return;
  }
  const MAX_UPLOAD = 50 * 1024 * 1024;
  const len = parseInt(contentLength, 10);
  if (isNaN(len) || len < 0 || len > MAX_UPLOAD) {
    sendJSON(req, res, 413, { error: `file too large (max ${MAX_UPLOAD} bytes)` }); return;
  }
  const allowRoots = fsAllowRoots();
  const conf = confineToRoots(qs.get('dir') || '', allowRoots);
  if (!conf.ok) { sendJSON(req, res, conf.reason === 'not found' ? 404 : 403, { error: 'forbidden: ' + conf.reason }); return; }
  const name = sanitizeEntryName(qs.get('name'));
  if (!name) { sendJSON(req, res, 400, { error: 'invalid name' }); return; }
  if (SECRET_RE.test(name)) { sendJSON(req, res, 403, { error: 'forbidden: secret/dotfile name' }); return; }
  const target = path.join(conf.realPath, name);
  if (fs.existsSync(target) && qs.get('overwrite') !== '1') { sendJSON(req, res, 409, { error: 'a file with that name already exists' }); return; }
  // Stream the upload body to a temp file to keep memory constant and
  // avoid blocking the event loop with a large synchronous writeFileSync.
  const tmpPath = target + '.tmp.' + crypto.randomBytes(6).toString('hex');
  try {
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(tmpPath);
      let total = 0;
      ws.on('error', reject);
      req.on('error', reject);
      req.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_UPLOAD) {
          ws.destroy();
          req.destroy();
          const e = new Error('file too large (50MB cap)'); e.code = 'TOO_LARGE';
          reject(e); return;
        }
        ws.write(chunk);
      });
      req.on('end', () => ws.end());
      ws.on('finish', () => resolve(total));
    });
    fs.renameSync(tmpPath, target);
    const uploadedSize = fs.statSync(target).size;
    sendJSON(req, res, 200, { ok: true, path: target, size: uploadedSize });
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    if (err.code === 'TOO_LARGE') { sendJSON(req, res, 413, { error: 'file too large (50MB cap)' }); return; }
    sendJSON(req, res, err.code === 'EACCES' || err.code === 'EPERM' ? 403 : 400, { error: 'upload failed' });
  }
}
