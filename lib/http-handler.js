import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { confineToRoots, fsAllowRoots, maskToken, SECRET_RE } from './http-routes/shared.js';
import { handleStat, handleList, handleFile, handleDownload, handleImage } from './http-routes/reads.js';
import { handleRename, handleMove, handleDelete, handleRestore, handleMkdir, handleUploadFile } from './http-routes/mutations.js';
import { listSessions, describeSession, createSession, closeSession, clampDim } from './terminal.js';
import { sendJSON, compressAndSend, acceptsEncoding } from './http-utils.js';
import { serveFile } from './asset-server.js';
import { digestEqual, stripBase } from './auth.js';

export { confineToRoots, fsAllowRoots, maskToken, SECRET_RE };

const SESSION_PATH = /^\/api\/terminal\/sessions\/([0-9a-f]{16})$/;
const FAVICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="20" fill="#3b82f6"/><text x="50" y="68" font-size="50" font-family="sans-serif" font-weight="bold" fill="white" text-anchor="middle">G</text></svg>';
const JSON_BODY_LIMIT = 64 * 1024;

function buildCsp(nonce) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data: blob:",
    "font-src 'self' data: https://fonts.gstatic.com",
    "connect-src 'self' ws: wss:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'"
  ].join('; ');
}

function applyCors(req, res) {
  const allowOrigin = process.env.CORS_ORIGIN;
  if (!allowOrigin) return;
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  if (allowOrigin !== '*') res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Vary', 'Origin');
  if (req.method === 'OPTIONS' || req.headers.origin) {
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  }
}

function clientAddress(req) {
  let ip;
  if (process.env.TRUST_PROXY === '1' && req.headers['x-forwarded-for']) {
    const hops = req.headers['x-forwarded-for'].split(',').map((s) => s.trim()).filter(Boolean);
    ip = hops[hops.length - 1] || req.socket.remoteAddress;
  } else {
    ip = req.socket.remoteAddress;
  }
  if (ip && ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

function credentialCandidates(req, searchParams) {
  const candidates = [];
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
      const i = decoded.indexOf(':');
      if (i !== -1) candidates.push({ token: decoded.slice(i + 1), via: 'header' });
    } catch {}
  } else if (auth.startsWith('Bearer ') && /^\S+$/.test(auth.slice(7))) {
    candidates.push({ token: auth.slice(7), via: 'header' });
  }
  const queryToken = searchParams.get('token');
  if (queryToken) candidates.push({ token: queryToken, via: 'query' });
  const m = /(?:^|;\s*)agentgui_token=([^;]+)/.exec(req.headers.cookie || '');
  if (m) {
    try { candidates.push({ token: decodeURIComponent(m[1]), via: 'cookie' }); } catch {}
  }
  return candidates;
}

function csrfAccepted(req) {
  const sfs = req.headers['sec-fetch-site'];
  const sameSite = sfs === 'same-origin' || sfs === 'none';
  const jsonBody = (req.headers['content-type'] || '').toLowerCase().startsWith('application/json');
  const authed = !!req.headers.authorization;
  const origin = req.headers.origin;
  let originOk = true;
  if (origin) {
    try { originOk = new URL(origin).host === req.headers.host; } catch { originOk = false; }
  }
  return originOk && (sameSite || jsonBody || authed);
}

async function readJson(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > JSON_BODY_LIMIT) throw new Error('request body too large');
  }
  try { return body ? JSON.parse(body) : {}; } catch { return {}; }
}

function resolveCwd(requested) {
  if (!requested) return undefined;
  const confined = confineToRoots(String(requested), fsAllowRoots());
  return confined.ok ? confined.realPath : undefined;
}

export function createHttpHandler({ BASE_URL, staticDir, PKG_VERSION, RATE_LIMIT_MAX, rateLimitMap, terminalEnabled }) {
  if (process.env.CORS_ORIGIN === '*' && !process.env.PASSWORD) {
    console.warn('[agentgui] WARNING: CORS_ORIGIN=* is set without PASSWORD. Any cross-origin page can make credentialless requests to all /api/* endpoints and read/modify the filesystem. Set PASSWORD or restrict CORS_ORIGIN to a specific origin.');
  }

  return async function httpHandler(req, res) {
    applyCors(req, res);
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https') {
      res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    }
    const cspNonce = crypto.randomBytes(16).toString('base64');
    res.setHeader('Content-Security-Policy', buildCsp(cspNonce));
    if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

    const clientIp = clientAddress(req);
    const hits = (rateLimitMap.get(clientIp) || 0) + 1;
    rateLimitMap.set(clientIp, hits);
    res.setHeader('X-RateLimit-Limit', RATE_LIMIT_MAX);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, RATE_LIMIT_MAX - hits));
    if (hits > RATE_LIMIT_MAX) { res.writeHead(429, { 'Retry-After': '60' }); res.end('Too Many Requests'); return; }

    const qIndex = req.url.indexOf('?');
    const rawPath = qIndex === -1 ? req.url : req.url.slice(0, qIndex);
    const query = qIndex === -1 ? '' : req.url.slice(qIndex);
    const bare = stripBase(rawPath, BASE_URL);
    const routePath = bare + query;
    const password = process.env.PASSWORD;
    const isHealth = bare === '/health' || bare === '/api/health';

    if (password && !(isHealth && process.env.HEALTH_NO_AUTH === '1')) {
      const candidates = credentialCandidates(req, new URL(req.url, 'http://localhost').searchParams);
      const matched = candidates.find((c) => digestEqual(c.token, password));
      if (!matched) {
        rateLimitMap.set(clientIp, (rateLimitMap.get(clientIp) || 0) + 100);
        res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="agentgui"' });
        res.end('Unauthorized');
        return;
      }
      if (matched.via !== 'cookie') {
        const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' || process.env.COOKIE_SECURE === '1';
        res.setHeader('Set-Cookie', `agentgui_token=${encodeURIComponent(password)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure ? '; Secure' : ''}`);
      }
    }

    if (bare.startsWith('/api/terminal/') && !terminalEnabled()) {
      sendJSON(req, res, 403, { error: 'terminal disabled (requires PASSWORD and ENABLE_TERMINAL=1)' });
      return;
    }

    if ((req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') && !csrfAccepted(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'cross-site request rejected' }));
      return;
    }

    try {
      if (isHealth && req.method === 'GET') {
        const body = {
          status: 'ok',
          version: PKG_VERSION,
          uptime: process.uptime(),
          terminals: listSessions().length,
          terminalsEnabled: terminalEnabled(),
          corsWildcardOpen: process.env.CORS_ORIGIN === '*' && !process.env.PASSWORD
        };
        if (!(isHealth && process.env.HEALTH_NO_AUTH === '1')) {
          body.memory = process.memoryUsage();
          body.allowRoots = fsAllowRoots();
        }
        sendJSON(req, res, 200, body);
        return;
      }

      if (routePath.startsWith('/api/stat') && req.method === 'GET') return handleStat(req, res, routePath, sendJSON);
      if (routePath.startsWith('/api/list')) return handleList(req, res, routePath, sendJSON);
      if (routePath.startsWith('/api/file/') || routePath.startsWith('/api/file?')) return handleFile(req, res, routePath);
      if (routePath.startsWith('/api/download/') || routePath.startsWith('/api/download?')) return handleDownload(req, res, routePath);
      if (routePath.startsWith('/api/image/') || routePath.startsWith('/api/image?')) return handleImage(req, res, routePath, sendJSON);

      if (bare === '/api/rename' && req.method === 'POST') return handleRename(req, res, sendJSON);
      if (bare === '/api/move' && req.method === 'POST') return handleMove(req, res, sendJSON);
      if (bare === '/api/delete' && req.method === 'POST') return handleDelete(req, res, sendJSON);
      if (bare === '/api/restore' && req.method === 'POST') return handleRestore(req, res, sendJSON);
      if (bare === '/api/mkdir' && req.method === 'POST') return handleMkdir(req, res, sendJSON);
      if (bare === '/api/upload-file' && req.method === 'PUT') return handleUploadFile(req, res, sendJSON);

      if (bare === '/api/terminal/sessions' && req.method === 'GET') {
        sendJSON(req, res, 200, listSessions());
        return;
      }
      if (bare === '/api/terminal/sessions' && req.method === 'POST') {
        const body = await readJson(req);
        try {
          const session = await createSession({ cwd: resolveCwd(body.cwd), cols: clampDim(body.cols, 80), rows: clampDim(body.rows, 24) });
          sendJSON(req, res, 200, session);
        } catch (err) {
          sendJSON(req, res, /limit/.test(err.message) ? 429 : 500, { error: maskToken(err.message) });
        }
        return;
      }
      const sessionMatch = SESSION_PATH.exec(bare);
      if (sessionMatch && req.method === 'GET') {
        const session = describeSession(sessionMatch[1]);
        sendJSON(req, res, session ? 200 : 404, session || { error: 'session not found' });
        return;
      }
      if (sessionMatch && req.method === 'DELETE') {
        const ok = closeSession(sessionMatch[1]);
        sendJSON(req, res, ok ? 200 : 404, { ok });
        return;
      }

      if (bare === '/favicon.ico') {
        res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=86400' });
        res.end(FAVICON);
        return;
      }

      const relative = bare === '/' || bare === '' ? '/index.html' : bare;
      const filePath = path.join(staticDir, relative);
      if (!path.normalize(filePath).startsWith(staticDir)) { res.writeHead(403); res.end('Forbidden'); return; }
      fs.stat(filePath, (err, stats) => {
        if (err || stats.isDirectory()) { res.writeHead(404); res.end('Not found'); return; }
        serveFile(filePath, res, req, { compressAndSend, acceptsEncoding, watch: false, BASE_URL, PKG_VERSION, cspNonce });
      });
    } catch (e) {
      console.error('Server error:', maskToken(e.message), e.stack, '| path:', maskToken(rawPath));
      sendJSON(req, res, 500, { error: 'internal server error' });
    }
  };
}
