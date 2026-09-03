import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { LRUCache } from 'lru-cache';

const MIME_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

export const _assetCache = new LRUCache({ max: 200 });
export const htmlState = { cache: null, etag: null };

export function generateETag(stats) {
  return `"${stats.mtimeMs.toString(36)}-${stats.size.toString(36)}"`;
}

export function warmAssetCache(staticDir) {
  const dirs = ['js', 'css', 'lib', 'vendor'];
  let count = 0;
  for (const dir of dirs) {
    const full = path.join(staticDir, dir);
    if (!fs.existsSync(full)) continue;
    for (const file of fs.readdirSync(full)) {
      const filePath = path.join(full, file);
      try {
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) continue;
        const etag = generateETag(stats);
        if (_assetCache.has(etag)) continue;
        const raw = fs.readFileSync(filePath);
        _assetCache.set(etag, raw.length < 860 ? { raw, gz: null } : { raw, gz: zlib.gzipSync(raw, { level: 6 }) });
        count++;
      } catch (_) {}
    }
  }
  for (const file of ['app.js', 'theme.js']) {
    const filePath = path.join(staticDir, file);
    try {
      const stats = fs.statSync(filePath);
      const etag = generateETag(stats);
      if (!_assetCache.has(etag)) {
        const raw = fs.readFileSync(filePath);
        _assetCache.set(etag, raw.length < 860 ? { raw, gz: null } : { raw, gz: zlib.gzipSync(raw, { level: 6 }) });
        count++;
      }
    } catch (_) {}
  }
  if (count > 0) console.log(`[CACHE] Pre-warmed ${count} static assets`);
}

export function serveFile(filePath, res, req, { compressAndSend, acceptsEncoding, watch, BASE_URL, PKG_VERSION, cspNonce }) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  if (ext !== '.html') {
    fs.stat(filePath, (err, stats) => {
      if (err) { res.writeHead(500); res.end('Server error'); return; }
      const etag = generateETag(stats);
      if (req && req.headers['if-none-match'] === etag) { res.writeHead(304); res.end(); return; }
      const cacheControl = 'public, no-cache';
      const sendCached = (cached) => {
        if (acceptsEncoding(req, 'gzip') && cached.gz) {
          res.writeHead(200, { 'Content-Type': contentType, 'Content-Encoding': 'gzip', 'Content-Length': cached.gz.length, 'ETag': etag, 'Cache-Control': cacheControl });
          res.end(cached.gz);
        } else {
          res.writeHead(200, { 'Content-Type': contentType, 'Content-Length': cached.raw.length, 'ETag': etag, 'Cache-Control': cacheControl });
          res.end(cached.raw);
        }
      };
      const cached = _assetCache.get(etag);
      if (cached) { sendCached(cached); return; }
      fs.readFile(filePath, (err2, raw) => {
        if (err2) { res.writeHead(500); res.end('Server error'); return; }
        if (raw.length < 860) { const entry = { raw, gz: null }; _assetCache.set(etag, entry); sendCached(entry); return; }
        const gz = zlib.gzipSync(raw, { level: 6 });
        const entry = { raw, gz };
        _assetCache.set(etag, entry);
        sendCached(entry);
      });
    });
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err) { res.writeHead(500); res.end('Server error'); return; }
    const etag = generateETag(stats);
    // The HTML carries a per-request CSP nonce, so the response body differs on
    // every request - the shared htmlState cache cannot be reused (it would
    // serve a stale nonce that fails the CSP). Only cache when there is no
    // nonce.
    if (!cspNonce && !watch && htmlState.cache && htmlState.etag === etag) {
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'Content-Encoding': 'gzip', 'Content-Length': htmlState.cache.length });
      res.end(htmlState.cache);
      return;
    }
    fs.readFile(filePath, (err2, data) => {
      if (err2) { res.writeHead(500); res.end('Server error'); return; }
      let content = data.toString();
      // Validate BASE_URL before injecting into HTML: must be a path starting
      // with / (single slash, not protocol-relative //) and containing only safe
      // URL chars (no script injection or protocol schemes).
      if (BASE_URL && !/^\/(?!\/)[a-z0-9\-._~:/?#[\]@!$&'()*+,;=]*$/i.test(BASE_URL)) {
        res.writeHead(500); res.end('Server error'); return;
      }
      const nonceAttr = cspNonce ? ` nonce="${cspNonce}"` : '';
      const wsToken = process.env.PASSWORD ? 'window.__WS_TOKEN=' + JSON.stringify(process.env.PASSWORD) + ';' : '';
      const baseTag = `<script${nonceAttr}>window.__BASE_URL='${BASE_URL}';window.__SERVER_VERSION='${PKG_VERSION}';${wsToken}</script>`;
      content = content.replace('<head>', `<head>\n  <base href="${BASE_URL}/">\n  ` + baseTag);
      content = content.replace(/(href|src)="vendor\//g, `$1="${BASE_URL}/vendor/`);
      content = content.replace(/(src)="\/gm\/js\//g, `$1="${BASE_URL}/js/`);
      // The static inline <script type="importmap"> and the module entry script
      // are inline/self scripts that MUST carry the nonce or the app never boots
      // under the nonce'd CSP. Add nonce to every inline <script> that lacks one.
      if (cspNonce) {
        content = content.replace(/<script type="importmap">/g, `<script type="importmap"${nonceAttr}>`);
        content = content.replace(/<script type="module"/g, `<script type="module"${nonceAttr}`);
      }
      if (watch) {
        content += `\n<script${nonceAttr}>(function(){const tok=window.__WS_TOKEN?'?token='+encodeURIComponent(window.__WS_TOKEN):'';const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'${BASE_URL}/hot-reload'+tok);ws.onmessage=e=>{if(JSON.parse(e.data).type==='reload')location.reload()};})();</script>`;
      }
      compressAndSend(req, res, 200, contentType, content);
      if (!cspNonce && !watch && acceptsEncoding(req, 'gzip')) {
        htmlState.cache = zlib.gzipSync(Buffer.from(content), { level: 6 });
        htmlState.etag = etag;
      }
    });
  });
}
