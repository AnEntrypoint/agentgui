import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = crypto.randomBytes(12).toString('hex');
const PUBLIC_HOST = 'buildesk.acc.l-inc.co.za';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const basic = (pw) => 'Basic ' + Buffer.from(`abc:${pw}`).toString('base64');
const publicHeaders = (extra = {}) => ({ Host: PUBLIC_HOST, Origin: `https://${PUBLIC_HOST}`, 'Sec-Fetch-Site': 'same-origin', ...extra });
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail });

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function startServer(port) {
  const env = { ...process.env, PORT: String(port), BASE_URL: '/gm', STARTUP_CWD: root, PASSWORD };
  delete env.ENABLE_TERMINAL;
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: 'ignore' });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const up = await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false));
    });
    if (up) return child;
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error('server did not start');
}

function parseSid(text) {
  try { return JSON.parse(text).sid || null; } catch { return null; }
}

function request(port, method, route, headers = {}, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: route, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

function openSocket(port, sid, { token = PASSWORD, headers = {} } = {}) {
  const query = token === null ? '' : `?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/gm/api/terminal/sessions/${sid}${query}`, { headers });
  const view = { ws, out: '', exit: null, status: null };
  ws.on('message', (data, isBinary) => {
    if (isBinary) view.out += data.toString('utf8');
    else view.exit = JSON.parse(data.toString());
  });
  view.opened = new Promise((resolve) => {
    ws.once('open', () => { view.status = 101; resolve(view); });
    ws.once('unexpected-response', (_req, res) => { view.status = res.statusCode; resolve(view); });
    ws.once('error', () => resolve(view));
  });
  return view;
}

async function waitFor(pred, ms = 15000) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) return false;
    await sleep(50);
  }
  return true;
}

async function main() {
  const port = await freePort();
  const child = await startServer(port);
  try {
    for (let i = 0; i < 40; i += 1) {
      await request(port, 'GET', '/gm/', publicHeaders({ Authorization: basic('wrong-' + i), 'X-Forwarded-For': '203.0.113.7' }));
    }
    const other = await request(port, 'GET', '/gm/', publicHeaders({ Authorization: basic(PASSWORD), 'X-Forwarded-For': '203.0.113.8' }));
    check('correct login from a second client is not refused after another client failed 40 logins', other.status === 200, 'status ' + other.status);

    const cookie = (other.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('agentgui_token='));
    check('Basic login sets agentgui_token', !!cookie);
    const auth = { Cookie: cookie || '' };

    const created = await request(port, 'POST', '/gm/api/terminal/sessions', publicHeaders({ ...auth, 'Content-Type': 'application/json' }), JSON.stringify({ cols: 80, rows: 24 }));
    const sid = parseSid(created.text);
    check('cookie creates a terminal through the public host', created.status === 200 && !!sid, 'status ' + created.status);
    const listed = await request(port, 'GET', '/gm/api/terminal/sessions', publicHeaders(auth));
    check('cookie lists terminals (200 means a terminal build)', listed.status === 200, 'status ' + listed.status);

    if (sid) {
      const refused = await openSocket(port, sid, { token: null, headers: publicHeaders(auth) }).opened;
      check('socket refuses the cookie alone (token is the gate)', refused.status === 401, 'status ' + refused.status);

      const foreign = await openSocket(port, sid, { headers: { Host: PUBLIC_HOST, Origin: 'https://evil.example' } }).opened;
      check('socket refuses a foreign Origin', foreign.status === 403, 'status ' + foreign.status);

      const v = await openSocket(port, sid, { headers: publicHeaders() }).opened;
      check('socket upgrades with the token from the public origin', v.status === 101, 'status ' + v.status);
      v.ws.send(Buffer.from('echo WITNESS_$((6*7))\r'));
      check('typed command output comes back over the socket', await waitFor(() => v.out.includes('WITNESS_42')), 'no WITNESS_42 in output');
      v.ws.send(Buffer.from('exit 0\r'));
      check('shell exit arrives as an exit control frame', await waitFor(() => v.exit !== null), 'no exit frame');
      check('exit frame carries code 0', v.exit && v.exit.code === 0, JSON.stringify(v.exit));
      const del = await request(port, 'DELETE', `/gm/api/terminal/sessions/${sid}`, publicHeaders(auth));
      check('DELETE closes the session', del.status === 200, 'status ' + del.status);
    }
  } finally {
    child.kill('SIGTERM');
  }
  let failed = 0;
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok || !r.detail ? '' : ': ' + r.detail}`);
    if (!r.ok) failed += 1;
  }
  console.log(failed ? `gm terminal witness: ${failed} failing, ${results.length - failed} passing` : `gm terminal witness: ${results.length} passing`);
  process.exitCode = failed ? 1 : 0;
}

main().catch((err) => {
  console.log('FAIL witness could not run: ' + err.message);
  process.exitCode = 1;
});
