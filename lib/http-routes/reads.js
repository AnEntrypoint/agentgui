import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  confineToRoots, fsAllowRoots, resolveConfinedPath, safeErrMsg, SECRET_RE,
} from './shared.js';

// Existence/shape probe for a proposed chat working directory, confined
// to the same allowlist as the Files surface (an unconfined stat would be
// a filesystem oracle). Returns {ok, dir} or a 403/404 with plain copy.
export function handleStat(req, res, routePath, sendJSON) {
  const decodedPath = resolveConfinedPath(req, routePath, 'path', '/api/stat');
  const conf = confineToRoots(decodedPath, fsAllowRoots());
  if (!conf.ok) { sendJSON(req, res, conf.reason === 'not found' ? 404 : 403, { error: conf.reason }); return; }
  try {
    const st = fs.statSync(conf.realPath);
    sendJSON(req, res, 200, { ok: true, dir: st.isDirectory(), path: conf.realPath });
  } catch (err) {
    sendJSON(req, res, err.code === 'ENOENT' ? 404 : 403, { error: safeErrMsg(err) });
  }
}

// Directory listing for the Files / folder-browser view (mirrors fsbrowse
// /api/list). Confined to an allowlist root exactly like /api/image - the
// normalize-then-prefix-check is the real guard (a `..` test after
// path.normalize is a no-op). Returns {path, segments, entries} so the kit
// FileGrid + BreadcrumbPath render directly. Allowed roots default to the
// server cwd + Claude projects dir; widen via FS_ROOTS (path-separated).
export function handleList(req, res, routePath, sendJSON) {
  const decodedPath = resolveConfinedPath(req, routePath, 'dir', '/api/list');
  const allowRoots = fsAllowRoots();
  // Empty path = the first allow-root (a sane default landing dir).
  const reqPath = !decodedPath ? allowRoots[0] : decodedPath;
  const conf = confineToRoots(reqPath, allowRoots);
  if (!conf.ok) {
    const code = conf.reason === 'not found' ? 404 : 403;
    sendJSON(req, res, code, { error: 'forbidden: ' + conf.reason }); return;
  }
  // Use the symlink-resolved real path for all reads.
  const normalizedPath = conf.realPath;
  try {
    const st = fs.statSync(normalizedPath);
    if (!st.isDirectory()) { sendJSON(req, res, 400, { error: 'not a directory' }); return; }
    // Classify by extension into the kit's data-file-type buckets so
    // FileGrid renders the right rail/icon. dir/symlink come from stat.
    const EXT_TYPE = {
      image: ['png','jpg','jpeg','gif','webp','svg','bmp','ico','avif'],
      video: ['mp4','webm','mov','mkv','avi','m4v'],
      audio: ['mp3','wav','ogg','flac','m4a','aac'],
      code: ['js','mjs','cjs','ts','tsx','jsx','rs','go','py','rb','java','c','cpp','h','hpp','cs','php','sh','css','html','json','yml','yaml','toml','sql'],
      text: ['txt','md','log','csv','env'],
      archive: ['zip','tar','gz','tgz','rar','7z','bz2','xz'],
      document: ['pdf','doc','docx','xls','xlsx','ppt','pptx','odt'],
    };
    const typeFor = (name, dirent) => {
      if (dirent.isSymbolicLink()) return 'symlink';
      if (dirent.isDirectory()) return 'dir';
      const ext = path.extname(name).slice(1).toLowerCase();
      for (const [t, exts] of Object.entries(EXT_TYPE)) if (exts.includes(ext)) return t;
      return 'other';
    };
    const dirents = fs.readdirSync(normalizedPath, { withFileTypes: true }).filter((d) => !SECRET_RE.test(d.name));
    const entries = dirents.map((d) => {
      const full = path.join(normalizedPath, d.name);
      let size = null, modified = null, permissions;
      try {
        const s = fs.statSync(full); size = s.isDirectory() ? null : s.size; modified = s.mtime.toISOString();
        // Per-entry permission probe (mirrors fsbrowse checkPermissions) so
        // the row reads honestly (read-only / no access) instead of a silent
        // size:null on a stat failure. A stat success means at least read.
        const perms = ['read'];
        try { fs.accessSync(full, fs.constants.W_OK); perms.push('write'); } catch (_) {}
        permissions = perms;
      } catch (e) {
        // Could not stat (commonly EACCES): mark no-access so the client
        // disables open + shows the tag, rather than failing silently.
        permissions = e && e.code === 'EACCES' ? 'EACCES' : [];
      }
      return { name: d.name, type: typeFor(d.name, d), size, modified, path: full, permissions };
    }).sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
    // Breadcrumb segments from the absolute path (drive/root aware).
    const segments = normalizedPath.split(/[\\\/]+/).filter(Boolean);
    sendJSON(req, res, 200, { path: normalizedPath, segments, entries, roots: allowRoots });
  } catch (err) {
    const code = err && err.code === 'ENOENT' ? 404 : (err && err.code === 'EACCES' ? 403 : 400);
    sendJSON(req, res, code, { error: safeErrMsg(err) });
  }
}

// Raw file bytes for the Files preview pane. Confined to the SAME
// allowlist roots as /api/list (server cwd + Claude projects dir, widened
// via FS_ROOTS). Same normalize-then-prefix-check guard. Capped at 512KB
// and limited to reasonable text/code/image types so this is never a
// generic arbitrary-file reader. Images are served via /api/image; this
// returns text/* with utf-8.
export function handleFile(req, res, routePath) {
  const decodedPath = resolveConfinedPath(req, routePath, 'path', '/api/file/');
  const allowRoots = fsAllowRoots();
  const conf = confineToRoots(decodedPath, allowRoots);
  if (!conf.ok) { res.writeHead(conf.reason === 'not found' ? 404 : 403); res.end('Forbidden'); return; }
  const normalizedPath = conf.realPath;
  // Block secret-bearing files regardless of root: dotfiles, env/key/cert
  // material, and credential stores must never be readable through the
  // Files preview even when they sit inside an allowed root.
  const base = path.basename(normalizedPath);
  if (SECRET_RE.test(base)) { res.writeHead(403); res.end('Forbidden'); return; }
  // Only known text/code extensions (images go through /api/image). An
  // unknown/binary extension is rejected, never served as octet-stream.
  // env/conf/cfg/ini are dropped - they commonly carry secrets.
  const TEXT_EXTS = new Set([
    'js','mjs','cjs','ts','tsx','jsx','rs','go','py','rb','java','c','cpp','h','hpp','cs','php','sh','css','html','json','yml','yaml','toml','sql',
    'txt','md','log','csv','xml','gitignore','dockerfile','svg',
  ]);
  const ext = path.extname(normalizedPath).slice(1).toLowerCase()
    || path.basename(normalizedPath).toLowerCase();
  if (!TEXT_EXTS.has(ext)) { res.writeHead(403); res.end('Forbidden: unsupported type'); return; }
  try {
    const st = fs.statSync(normalizedPath);
    if (!st.isFile()) { res.writeHead(400); res.end('Not a file'); return; }
    const MAX = 512 * 1024;
    const fd = fs.openSync(normalizedPath, 'r');
    const len = Math.min(st.size, MAX);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, 0);
    fs.closeSync(fd);
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-File-Truncated': st.size > MAX ? '1' : '0',
    });
    res.end(buf);
  } catch (err) {
    const code = err && err.code === 'ENOENT' ? 404 : (err && err.code === 'EACCES' ? 403 : 400);
    res.writeHead(code); res.end(safeErrMsg(err));
  }
}

// Confined raw-bytes download (any type) with an attachment disposition,
// so the Files view can offer download on a row. Same allowlist + realpath
// confinement as /api/file and /api/image - never a generic file reader.
export function handleDownload(req, res, routePath) {
  const decodedPath = resolveConfinedPath(req, routePath, 'path', '/api/download/');
  const allowRoots = fsAllowRoots();
  const conf = confineToRoots(decodedPath, allowRoots);
  if (!conf.ok) { res.writeHead(conf.reason === 'not found' ? 404 : 403); res.end('Forbidden'); return; }
  const normalizedPath = conf.realPath;
  // Same secret-name block as /api/file: a download must not exfiltrate
  // .env/.pem/.key/credential material just because it streams bytes.
  if (SECRET_RE.test(path.basename(normalizedPath))) { res.writeHead(403); res.end('Forbidden'); return; }
  try {
    const st = fs.statSync(normalizedPath);
    if (!st.isFile()) { res.writeHead(400); res.end('Not a file'); return; }
    const MAX = 50 * 1024 * 1024; // 50MB cap so a download can't exhaust memory
    if (st.size > MAX) { res.writeHead(413); res.end('File too large to download'); return; }
    const base = path.basename(normalizedPath);
    const asciiName = base.replace(/[\\"\r\n]/g, '').replace(/[^\x20-\x7e]/g, '_');
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="' + asciiName + '"; filename*=UTF-8\'\'' + encodeURIComponent(base),
      'Content-Length': String(st.size),
      'Cache-Control': 'no-cache',
    });
    const rs = fs.createReadStream(normalizedPath);
    rs.on('error', (streamErr) => { if (!res.writableEnded) res.destroy(streamErr); });
    rs.pipe(res);
  } catch (err) {
    const code = err && err.code === 'ENOENT' ? 404 : (err && err.code === 'EACCES' ? 403 : 400);
    res.writeHead(code); res.end(safeErrMsg(err));
  }
}

// Confined image bytes with a content-type allowlist (SVG intentionally
// excluded - see inline comment below). Its own allowlist roots (Claude
// projects dir + IMAGE_ROOTS), distinct from fsAllowRoots(), because the
// user home is never a default root for arbitrary image reads.
export function handleImage(req, res, routePath, sendJSON) {
  const decodedPath = resolveConfinedPath(req, routePath, 'path', '/api/image/');
  // Confine reads to an allowlist root. Without this the route is an
  // arbitrary-file-read of any image-extensioned path on the host (the
  // prior `includes('..')` guard is a no-op after path.normalize resolves
  // the segments). Allowed roots: the Claude projects dir (history images)
  // only; add more via IMAGE_ROOTS (path-separated). The user home is NOT
  // a default root - it covers ~/.ssh, ~/.aws, dotfiles etc., so an image
  // route reaching all of home is a broad read of anything image-shaped.
  // confineToRoots also realpath-resolves so a symlink inside a root can't
  // point an image read at an out-of-root file.
  const allowRoots = [
    process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects'),
    ...(process.env.IMAGE_ROOTS ? process.env.IMAGE_ROOTS.split(path.delimiter) : []),
  ].map(r => path.normalize(r));
  const conf = confineToRoots(decodedPath, allowRoots);
  if (!conf.ok) { res.writeHead(conf.reason === 'not found' ? 404 : 403); res.end(conf.reason === 'not found' ? 'Not found' : 'Forbidden'); return; }
  const normalizedPath = conf.realPath;
  try {
    const ext = path.extname(normalizedPath).toLowerCase();
    const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
    // SVG is intentionally excluded: browsers render SVG as a live document
    // in the app's origin, so an agent-written SVG with a <script src=CDN>
    // would execute in the agentgui origin (CSP allows unpkg/jsdelivr).
    // Files preview uses /api/file/download (attachment) for SVG.
    const contentType = mimeTypes[ext];
    if (!contentType) { res.writeHead(403); res.end('Forbidden'); return; }
    const imgSt = fs.statSync(normalizedPath);
    const IMG_MAX = 20 * 1024 * 1024; // 20MB hard cap
    if (imgSt.size > IMG_MAX) { res.writeHead(413); res.end('Image too large'); return; }
    // Always stream to avoid blocking the event loop on large synchronous reads.
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache', 'Content-Length': String(imgSt.size) });
    const imgRs = fs.createReadStream(normalizedPath);
    imgRs.on('error', (streamErr) => { if (!res.writableEnded) res.destroy(streamErr); });
    imgRs.pipe(res);
  } catch (err) { sendJSON(req, res, 400, { error: 'cannot read image' }); }
}
