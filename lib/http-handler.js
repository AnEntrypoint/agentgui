import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import * as term from './terminal.js';
import { confineToRoots, fsAllowRoots, maskToken, SECRET_RE } from './http-routes/shared.js';
import { handleStat, handleList, handleFile, handleDownload, handleImage } from './http-routes/reads.js';
import { handleRename, handleMove, handleDelete, handleRestore, handleMkdir, handleUploadFile } from './http-routes/mutations.js';

export { confineToRoots, fsAllowRoots, maskToken, SECRET_RE };

export function createHttpHandler({ BASE_URL, expressApp, queries, sendJSON, serveFile, staticDir, messageQueues, getWss, activeExecutions, getACPStatus, discoveredAgents, PKG_VERSION, RATE_LIMIT_MAX, rateLimitMap, routes, PORT }) {
  // Warn operators when CORS_ORIGIN=* is combined with no PASSWORD: any
  // cross-origin page can make credentialless fetch() calls to all /api/*
  // endpoints (list, file, download, rename, delete, mkdir) and read or
  // modify the filesystem. The existing code is structurally correct (no
  // Access-Control-Allow-Credentials with wildcard), but the exposure is
  // easy to miss.
  if (process.env.CORS_ORIGIN === '*' && !process.env.PASSWORD) {
    console.warn('[agentgui] WARNING: CORS_ORIGIN=* is set without PASSWORD. Any cross-origin page can make credentialless requests to all /api/* endpoints and read/modify the filesystem. Set PASSWORD or restrict CORS_ORIGIN to a specific origin.');
  }
  return async function httpHandler(req, res) {
    // CORS: emit ACAO only when CORS_ORIGIN is explicitly set. A wildcard would
    // let any webpage the user visits make credentialless fetches to /api/list,
    // /api/file/*, etc. and read ~/.claude/projects content — even on a no-
    // PASSWORD localhost deploy. Set CORS_ORIGIN=<origin> for cross-origin tools.
    const _corsOrigin = process.env.CORS_ORIGIN;
    if (_corsOrigin) {
      // Never set a wildcard when credentials (cookies) may be in play — a
      // wildcard + credentials is rejected by browsers and leaks session tokens.
      // A specific origin allows credentialed cross-origin requests safely.
      res.setHeader('Access-Control-Allow-Origin', _corsOrigin);
      if (_corsOrigin !== '*') res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
      // Allow-Methods and Allow-Headers are only meaningful on CORS preflights
      // or CORS requests; emitting them unconditionally leaks the method surface
      // to same-origin (and non-CORS) responses unnecessarily.
      if (req.method === 'OPTIONS' || req.headers['origin']) {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      }
    } // no ACAO header -> browsers enforce same-origin by default
    // The password can ride in a ?token= query param (EventSource/deep-links
    // can't set headers), so a navigation away from the app would leak it in
    // the Referer header to the destination. Strip the referrer on every
    // response so the credential never crosses an origin boundary that way.
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Prevent MIME-sniffing attacks on all responses including file downloads.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    // Emit HSTS when the connection is known-TLS so clients pin HTTPS and
    // refuse future downgrade attempts (protects cookie + ?token= in transit).
    if (req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    }
    // CSP: the markdown stack (marked/dompurify/prismjs) and the DS kit load
    // from unpkg/jsdelivr; everything else is self. connect-src also allows
    // self for the same-origin WS/SSE. script-src drops 'unsafe-inline' in
    // favour of a per-request nonce threaded onto every server-injected and
    // static inline <script> (bootstrap, hot-reload, importmap) by the asset
    // server. style-src keeps 'unsafe-inline' because the DS injects a runtime
    // <style> with no hook to nonce.
    const cspNonce = crypto.randomBytes(16).toString('base64');
    res.setHeader('Content-Security-Policy', [
      "default-src 'self'",
      `script-src 'self' 'nonce-${cspNonce}' https://unpkg.com https://cdn.jsdelivr.net`,
      "style-src 'self' 'unsafe-inline' https://unpkg.com https://cdn.jsdelivr.net https://fonts.googleapis.com",
      "img-src 'self' data: blob:",
      "font-src 'self' data: https://unpkg.com https://cdn.jsdelivr.net https://fonts.gstatic.com",
      "connect-src 'self' https://unpkg.com https://cdn.jsdelivr.net ws: wss:",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'self'",
    ].join('; '));
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
    if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') return;

    // Only honour X-Forwarded-For behind a trusted proxy (TRUST_PROXY=1), and
    // then take the RIGHT-MOST hop (the one the trusted proxy itself observed,
    // not a client-spoofed left-most value). Otherwise the socket peer is the
    // only trustworthy source - a client can forge the header freely.
    let clientIp;
    if (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for']) {
      const hops = req.headers['x-forwarded-for'].split(',').map(s => s.trim()).filter(Boolean);
      clientIp = hops[hops.length - 1] || req.socket.remoteAddress;
    } else {
      clientIp = req.socket.remoteAddress;
    }
    // Normalize IPv4-mapped IPv6 addresses (::ffff:1.2.3.4 -> 1.2.3.4) so the
    // rate-limit bucket is the same regardless of how the OS presents the peer.
    if (clientIp && clientIp.startsWith('::ffff:')) clientIp = clientIp.slice(7);
    const hits = (rateLimitMap.get(clientIp) || 0) + 1;
    rateLimitMap.set(clientIp, hits);
    res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, RATE_LIMIT_MAX - hits));
    if (hits > RATE_LIMIT_MAX) { res.writeHead(429, { 'Retry-After': '60' }); res.end('Too Many Requests'); return; }

    const _pwd = process.env.PASSWORD;
    // Optional: exempt /health from auth so container/k8s probes work
    // without distributing the password to monitoring infra.
    const _bareEarly = req.url.split('?')[0];
    const _healthExempt = process.env.HEALTH_NO_AUTH === '1' && (_bareEarly === '/health' || _bareEarly === '/api/health' || _bareEarly === (BASE_URL + '/health') || _bareEarly === (BASE_URL + '/api/health'));
    if (_pwd && !_healthExempt) {
      const _auth = req.headers['authorization'] || '';
      let _ok = false;
      // Constant-time compare over fixed-width SHA-256 digests so neither the
      // password length nor a byte-position mismatch leaks via timing.
      const _checkToken = (tok) => {
        try {
          const a = crypto.createHash('sha256').update(String(tok)).digest();
          const b = crypto.createHash('sha256').update(String(_pwd)).digest();
          return crypto.timingSafeEqual(a, b);
        } catch { return false; }
      };
      if (_auth.startsWith('Basic ')) {
        try {
          const _decoded = Buffer.from(_auth.slice(6), 'base64').toString('utf8');
          const _ci = _decoded.indexOf(':');
          if (_ci !== -1) _ok = _checkToken(_decoded.slice(_ci + 1));
        } catch (_) {}
      } else if (_auth.startsWith('Bearer ')) {
        const bearerToken = _auth.slice(7);
        // Validate Bearer token format: non-empty, no whitespace. Prevents
        // timing-attack length inference if PASSWORD contains spaces.
        if (/^[\S]+$/.test(bearerToken)) _ok = _checkToken(bearerToken);
      }
      // EventSource and same-origin links can't set headers - accept ?token= as fallback.
      let _viaQuery = false;
      if (!_ok) {
        try {
          const _qsTok = new URL(req.url, 'http://localhost').searchParams.get('token');
          if (_qsTok) { _ok = _checkToken(_qsTok); _viaQuery = _ok; }
        } catch (_) {}
      }
      // Static subresources (js/css/vendor) are requested by the BROWSER, which
      // can attach neither a header nor a ?token= - without a cookie the SPA
      // can never boot behind PASSWORD (index.html 200s, app.js 401s, blank
      // page). On any successful auth, set an HttpOnly SameSite=Lax cookie the
      // gate accepts for subsequent requests. Lax + the CSRF guard below keep
      // cross-site mutations rejected; the value is URL-encoded (a password
      // may carry cookie-hostile characters like commas).
      if (!_ok) {
        try {
          const _ck = req.headers['cookie'] || '';
          const _m = /(?:^|;\s*)agentgui_token=([^;]+)/.exec(_ck);
          if (_m) _ok = _checkToken(decodeURIComponent(_m[1]));
        } catch (_) {}
      } else if (_viaQuery || _auth) {
        try {
          // Secure only over a real TLS connection (or behind an https proxy /
          // explicit opt-in) so the localhost-http witness still gets a usable
          // cookie. Max-Age bounds the credential's lifetime to a day.
          const _https = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' || process.env.COOKIE_SECURE === '1';
          res.setHeader('Set-Cookie', 'agentgui_token=' + encodeURIComponent(_pwd) + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400' + (_https ? '; Secure' : ''));
        } catch (_) {}
      }
      if (!_ok) {
        // Penalize failed auth heavily in the rate bucket so a credential
        // brute-force trips the 429 limiter long before it can guess.
        rateLimitMap.set(clientIp, (rateLimitMap.get(clientIp) || 0) + 100);
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="agentgui"' }); res.end('Unauthorized'); return;
      }
    }

    const pathOnly = req.url.split('?')[0];

    // Terminal RCE guard: the terminal surface spawns an interactive shell, so
    // it is fail-closed by default. It is reachable ONLY when PASSWORD is set
    // AND ENABLE_TERMINAL=1 is explicitly opted in. (Under the localhost-PASSWORD
    // witness ENABLE_TERMINAL is unset, so the terminal is correctly disabled -
    // it is not part of the witness.)
    if (pathOnly.startsWith('/api/terminal/') || pathOnly.startsWith(BASE_URL + '/api/terminal/')) {
      if (!process.env.PASSWORD || process.env.ENABLE_TERMINAL !== '1') {
        sendJSON(req, res, 403, { error: 'terminal disabled (requires PASSWORD and ENABLE_TERMINAL=1)' });
        return;
      }
    }

    // CSRF guard on every state-changing method. Without PASSWORD the server
    // is open and advertises a wildcard ACAO, so a cross-site page could POST
    // a form at the mutation routes (rename/delete/mkdir/upload) on localhost.
    // A simple cross-site form cannot set Sec-Fetch-Site:same-origin, send
    // application/json, or attach custom headers - so: accept when the
    // browser says same-origin/none (direct nav, same-origin fetch), when the
    // body is declared JSON, or when an Authorization header rode along (a
    // credentialed programmatic client). Reject the rest with 403.
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') {
      const sfs = req.headers['sec-fetch-site'];
      const ct = (req.headers['content-type'] || '').toLowerCase();
      // A MISSING Sec-Fetch-Site header must NOT be treated as same-site -
      // older browsers/non-browser clients omitting it would otherwise pass
      // unconditionally regardless of true origin. Only an explicit
      // same-origin/none value counts; a present-but-absent header falls
      // through to the Origin-host check below.
      const sameSite = sfs === 'same-origin' || sfs === 'none';
      // Only application/json counts as a non-cross-site body now: a simple
      // cross-site <form> can send only urlencoded/multipart/text-plain, and
      // octet-stream / empty CT were too broad an escape (a no-CORS fetch can
      // send octet-stream). The binary upload PUT still rides the same-origin
      // SPA fetch (Sec-Fetch-Site: same-origin), so it passes via sameSite.
      const jsonBody = ct.startsWith('application/json');
      const authed = !!req.headers['authorization'];
      // If an Origin header is present, its host MUST match the Host header -
      // a cross-origin page's Origin will not, regardless of Sec-Fetch-Site.
      let originOk = true;
      const origin = req.headers['origin'];
      if (origin) {
        try { originOk = new URL(origin).host === req.headers['host']; }
        catch { originOk = false; }
      }
      if (!originOk || (!sameSite && !jsonBody && !authed)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'cross-site request rejected' }));
        return;
      }
    }

    if (pathOnly.startsWith(BASE_URL + '/api/upload/') || pathOnly.startsWith(BASE_URL + '/files/') || pathOnly.startsWith('/v1/history') || (BASE_URL && pathOnly.startsWith(BASE_URL + '/v1/history'))) return expressApp(req, res);

    if (req.url === '/favicon.ico' || req.url === BASE_URL + '/favicon.ico') {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#3b82f6"/><text x="50" y="68" font-size="50" font-family="sans-serif" font-weight="bold" fill="white" text-anchor="middle">G</text></svg>';
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
      res.end(svg); return;
    }

    // serve index.html at root directly (no redirect)

    let routePath = req.url;
    const _bareUrl = req.url.split('?')[0];
    if (_bareUrl.startsWith(BASE_URL + '/')) { routePath = req.url.slice(BASE_URL.length); }
    else if (_bareUrl === BASE_URL) { routePath = '/'; }
    else if (_bareUrl.startsWith('/api/') || _bareUrl.startsWith('/js/') || _bareUrl.startsWith('/css/') ||
             _bareUrl.startsWith('/vendor/') || _bareUrl.startsWith('/sync') || _bareUrl === '/' ||
             _bareUrl === '/health' || _bareUrl.startsWith('/v1/') ||
             _bareUrl.startsWith('/api/terminal/') ||
             _bareUrl.startsWith('/conversations/')) { routePath = req.url; }
    else { res.writeHead(404); res.end('Not found'); return; }

    routePath = routePath || '/';

    try {
      const pathOnly = routePath.split('?')[0];

      if ((pathOnly === '/api/health' || pathOnly === '/health') && req.method === 'GET') {
        let dbStatus = { ok: true };
        try { queries._db.prepare('SELECT 1').get(); } catch (e) { dbStatus = { ok: false, error: e.message }; }
        const queueSizes = {};
        for (const [k, v] of messageQueues) queueSizes[k] = v.length;
        const _body = {
          status: 'ok', version: PKG_VERSION, uptime: process.uptime(), agents: discoveredAgents.length,
          activeExecutions: activeExecutions.size, wsClients: getWss()?.clients?.size ?? 0,
          acp: getACPStatus(), db: dbStatus, queueSizes,
          // Surfaces the console-only CORS_ORIGIN=*+no-PASSWORD warning (above)
          // as a fact the GUI settings panel can render a persistent banner
          // from - an operator not tailing logs otherwise never sees the risk.
          corsWildcardOpen: process.env.CORS_ORIGIN === '*' && !process.env.PASSWORD,
        };
        // Host-internal facts (memory, filesystem paths) are exposed only to an
        // authenticated caller, never on the unauthenticated health-probe bypass.
        if (!_healthExempt) {
          _body.memory = process.memoryUsage();
          _body.projectsDir = process.env.CLAUDE_PROJECTS_DIR || path.join(os.homedir(), '.claude', 'projects');
          _body.allowRoots = fsAllowRoots();
        }
        sendJSON(req, res, 200, _body);
        return;
      }

      // Existence/shape probe for a proposed chat working directory - see
      // lib/http-routes/reads.js for the confinement contract.
      if (routePath.startsWith('/api/stat') && req.method === 'GET') {
        handleStat(req, res, routePath, sendJSON);
        return;
      }

      // Terminal sessions - gated by the Basic-auth check at the top of this handler.
      // Never expose these routes without PASSWORD set.
      if (pathOnly === '/api/terminal/sessions' && req.method === 'GET') {
        sendJSON(req, res, 200, term.listSessions()); return;
      }
      if (pathOnly === '/api/terminal/sessions' && req.method === 'POST') {
        let body = ''; for await (const c of req) body += c;
        let p = {}; try { p = body ? JSON.parse(body) : {}; } catch {}
        // Never honour a client-supplied shell or env - that would be a direct
        // command/arg injection into the spawned process. Only geometry + cwd.
        // Confine cwd to allowed roots; fall back to STARTUP_CWD on failure.
        let termCwd = process.env.STARTUP_CWD || process.cwd();
        if (p.cwd) {
          const cwdConf = confineToRoots(p.cwd, fsAllowRoots());
          if (cwdConf.ok) termCwd = cwdConf.realPath;
        }
        const s = term.createSession({ cwd: termCwd, cols: p.cols, rows: p.rows });
        sendJSON(req, res, 200, { sid: s.sid, kind: s.kind, shell: s.shell, cwd: s.cwd, cols: s.cols, rows: s.rows, pid: s.proc.pid });
        return;
      }
      const termMatch = pathOnly.match(/^\/api\/terminal\/sessions\/([0-9a-f]+)$/);
      if (termMatch && req.method === 'GET') {
        const s = term.getSession(termMatch[1]);
        if (!s) { sendJSON(req, res, 404, { error: 'session not found' }); return; }
        sendJSON(req, res, 200, { sid: s.sid, kind: s.kind, shell: s.shell, cwd: s.cwd, cols: s.cols, rows: s.rows, pid: s.proc.pid, clients: s.clients.size });
        return;
      }
      if (termMatch && req.method === 'DELETE') {
        const ok = term.closeSession(termMatch[1]);
        sendJSON(req, res, ok ? 200 : 404, { ok }); return;
      }

      // Legacy REST handlers removed. History served by ccsniff at /v1/history/*.
      for (const key of Object.keys(routes)) {
        try {
          const h = routes[key]?._match?.(req.method, pathOnly);
          if (h) { await h(req, res); return; }
        } catch (_) {}
      }
      // Directory listing for the Files / folder-browser view - see
      // lib/http-routes/reads.js for the confinement contract.
      if (routePath.startsWith('/api/list')) {
        handleList(req, res, routePath, sendJSON);
        return;
      }

      // Raw file bytes for the Files preview pane - see lib/http-routes/reads.js.
      if (routePath.startsWith('/api/file/') || routePath.startsWith('/api/file?')) {
        handleFile(req, res, routePath);
        return;
      }

      // Confined raw-bytes download - see lib/http-routes/reads.js.
      if (routePath.startsWith('/api/download/') || routePath.startsWith('/api/download?')) {
        handleDownload(req, res, routePath);
        return;
      }

      // --- File mutations ----------------------------------------------------
      // The Files surface is a real manager (fsbrowse-grade): rename, delete,
      // mkdir, upload. See lib/http-routes/mutations.js for the shared
      // confinement/sanitization contract every route below follows.

      // POST /api/rename {path, newName} -> {ok, path}
      if (routePath.split('?')[0] === '/api/rename' && req.method === 'POST') {
        await handleRename(req, res, sendJSON);
        return;
      }

      // POST /api/move {path, destDir, overwrite?} -> {ok, path}
      if (routePath.split('?')[0] === '/api/move' && req.method === 'POST') {
        await handleMove(req, res, sendJSON);
        return;
      }

      // POST /api/delete {path, recursive?} -> {ok}
      if (routePath.split('?')[0] === '/api/delete' && req.method === 'POST') {
        await handleDelete(req, res, sendJSON);
        return;
      }

      // POST /api/restore {trashId} -> {ok, path}
      if (routePath.split('?')[0] === '/api/restore' && req.method === 'POST') {
        await handleRestore(req, res, sendJSON);
        return;
      }

      // POST /api/mkdir {dir, name} -> {ok, path}
      if (routePath.split('?')[0] === '/api/mkdir' && req.method === 'POST') {
        await handleMkdir(req, res, sendJSON);
        return;
      }

      // PUT /api/upload-file?dir=<enc>&name=<enc> with raw file bytes as the body
      if (routePath.split('?')[0] === '/api/upload-file' && req.method === 'PUT') {
        await handleUploadFile(req, res, sendJSON);
        return;
      }

      // Confined image bytes - see lib/http-routes/reads.js.
      if (routePath.startsWith('/api/image/') || routePath.startsWith('/api/image?')) {
        handleImage(req, res, routePath, sendJSON);
        return;
      }

      if (pathOnly.match(/^\/conversations\/[^\/]+$/)) { serveFile(path.join(staticDir, 'index.html'), res, req, cspNonce); return; }

      const routePathBare = routePath.split('?')[0];
      let filePath = routePathBare === '/' ? '/index.html' : routePathBare;
      filePath = path.join(staticDir, filePath);
      const normalizedPath = path.normalize(filePath);
      if (!normalizedPath.startsWith(staticDir)) { res.writeHead(403); res.end('Forbidden'); return; }

      fs.stat(filePath, (err, stats) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        if (stats.isDirectory()) {
          filePath = path.join(filePath, 'index.html');
          fs.stat(filePath, (err2) => { if (err2) { res.writeHead(404); res.end('Not found'); return; } serveFile(filePath, res, req, cspNonce); });
        } else { serveFile(filePath, res, req, cspNonce); }
      });
    } catch (e) {
      console.error('Server error:', maskToken(e.message), e.stack, '| path:', maskToken(req.url.split('?')[0]));
      sendJSON(req, res, 500, { error: 'internal server error' });
    }
  };
}
