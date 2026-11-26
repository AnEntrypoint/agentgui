import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PASSWORD = 'relay-test-pw';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function startServer({ terminals }) {
  const port = await freePort();
  const env = { ...process.env, PORT: String(port), BASE_URL: '/gm', STARTUP_CWD: root, PASSWORD };
  delete env.TRUST_PROXY;
  if (terminals) delete env.ENABLE_TERMINAL; else env.ENABLE_TERMINAL = '0';
  const child = spawn(process.execPath, ['server.js'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}/gm`;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${base}/health`, { headers: { Authorization: 'Bearer ' + PASSWORD } });
      if (r.ok) return { port, base, child, log: () => log };
    } catch {}
    await sleep(100);
  }
  child.kill('SIGKILL');
  throw new Error('server did not start: ' + log);
}

function stopServer(s) {
  if (s && s.child.exitCode === null) s.child.kill('SIGTERM');
}

async function api(s, method, route, body) {
  const headers = { Authorization: 'Bearer ' + PASSWORD };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(s.base + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
}

function openTerminal(s, sid, { token = PASSWORD, origin, headers: extra = {} } = {}) {
  const headers = { ...(origin ? { origin } : {}), ...extra };
  const query = token === null ? '' : `?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/gm/api/terminal/sessions/${sid}${query}`, { headers });
  const view = { out: '', exit: null, closed: false, error: null };
  ws.on('message', (data, isBinary) => {
    if (isBinary) view.out += data.toString('utf8');
    else view.exit = JSON.parse(data.toString());
  });
  ws.on('close', () => { view.closed = true; });
  ws.on('error', (err) => { view.error = err; });
  view.ws = ws;
  view.opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('unexpected-response', (req, res) => reject(new Error('HTTP ' + res.statusCode)));
    ws.once('error', reject);
  });
  return view;
}

async function waitFor(pred, what, ms = 10000) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + what);
    await sleep(30);
  }
}

let server;
before(async () => { server = await startServer({ terminals: true }); });
after(() => stopServer(server));

test('unauthenticated requests are refused', async () => {
  const r = await fetch(`${server.base}/api/list`);
  assert.equal(r.status, 401);
});

test('authenticated health reports terminals enabled', async () => {
  const r = await api(server, 'GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.terminalsEnabled, true);
});

test('file manager list works under auth', async () => {
  const r = await api(server, 'GET', `/api/list?dir=${encodeURIComponent(path.join(root, 'lib'))}`);
  assert.equal(r.status, 200);
  const names = (r.json.entries || []).map((e) => e.name);
  assert.ok(names.includes('terminal.js'), 'lib listing includes terminal.js');
});

test('several terminals run independently', async () => {
  const a = await api(server, 'POST', '/api/terminal/sessions', { cols: 90, rows: 26 });
  const b = await api(server, 'POST', '/api/terminal/sessions', { cols: 90, rows: 26 });
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.notEqual(a.json.sid, b.json.sid);
  const va = openTerminal(server, a.json.sid);
  const vb = openTerminal(server, b.json.sid);
  await Promise.all([va.opened, vb.opened]);
  va.ws.send(Buffer.from('echo MARK_$((10+1))_A\r'));
  vb.ws.send(Buffer.from('echo MARK_$((10+2))_B\r'));
  await waitFor(() => va.out.includes('MARK_11_A') && vb.out.includes('MARK_12_B'), 'both markers');
  assert.equal(va.out.includes('MARK_12_B'), false);
  assert.equal(vb.out.includes('MARK_11_A'), false);
  va.ws.close(); vb.ws.close();
  assert.equal((await api(server, 'DELETE', `/api/terminal/sessions/${a.json.sid}`)).status, 200);
  assert.equal((await api(server, 'DELETE', `/api/terminal/sessions/${b.json.sid}`)).status, 200);
});

test('output fans out to every attached client and late joiners get the replay', async () => {
  const s = await api(server, 'POST', '/api/terminal/sessions', { cols: 80, rows: 24 });
  const first = openTerminal(server, s.json.sid);
  await first.opened;
  first.ws.send(Buffer.from('echo FANOUT_$((3*3))\r'));
  await waitFor(() => first.out.includes('FANOUT_9'), 'first client output');
  const second = openTerminal(server, s.json.sid);
  await second.opened;
  await waitFor(() => second.out.includes('FANOUT_9'), 'replay to late joiner');
  first.ws.send(Buffer.from('echo LIVE_$((4*4))\r'));
  await waitFor(() => first.out.includes('LIVE_16') && second.out.includes('LIVE_16'), 'live fan-out to both');
  first.ws.close(); second.ws.close();
  await api(server, 'DELETE', `/api/terminal/sessions/${s.json.sid}`);
});

test('resize control frame reaches the pty', async () => {
  const s = await api(server, 'POST', '/api/terminal/sessions', { cols: 80, rows: 24 });
  const v = openTerminal(server, s.json.sid);
  await v.opened;
  v.ws.send(JSON.stringify({ type: 'resize', cols: 101, rows: 33 }));
  await sleep(150);
  v.ws.send(Buffer.from('stty size | tr " " "x"; echo SZ_DONE\r'));
  await waitFor(() => v.out.includes('33x101'), 'pty size after resize');
  v.ws.close();
  await api(server, 'DELETE', `/api/terminal/sessions/${s.json.sid}`);
});

test('ctrl-c interrupts the foreground job and the shell keeps working', async () => {
  const s = await api(server, 'POST', '/api/terminal/sessions', { cols: 80, rows: 24 });
  const v = openTerminal(server, s.json.sid);
  await v.opened;
  v.ws.send(Buffer.from('sleep 60\r'));
  await sleep(400);
  v.ws.send(Buffer.from('\x03'));
  await sleep(300);
  v.ws.send(Buffer.from('echo AFTER_$((5+5))\r'));
  await waitFor(() => v.out.includes('AFTER_10'), 'shell responsive after ctrl-c');
  v.ws.close();
  await api(server, 'DELETE', `/api/terminal/sessions/${s.json.sid}`);
});

test('shell exit code is delivered as a control frame and the socket closes', async () => {
  const s = await api(server, 'POST', '/api/terminal/sessions', { cols: 80, rows: 24 });
  const v = openTerminal(server, s.json.sid);
  await v.opened;
  v.ws.send(Buffer.from('exit 7\r'));
  await waitFor(() => v.exit !== null && v.closed, 'exit frame and close');
  assert.deepEqual(v.exit, { type: 'exit', code: 7 });
  const after = await api(server, 'GET', `/api/terminal/sessions/${s.json.sid}`);
  assert.equal(after.json.exited, true);
  assert.equal(after.json.exitCode, 7);
  await api(server, 'DELETE', `/api/terminal/sessions/${s.json.sid}`);
});

test('socket upgrade is refused for a bad token and for a cross-origin page', async () => {
  const s = await api(server, 'POST', '/api/terminal/sessions', { cols: 80, rows: 24 });
  const badToken = openTerminal(server, s.json.sid, { token: 'nope' });
  await assert.rejects(badToken.opened, /HTTP 401/);
  const crossOrigin = openTerminal(server, s.json.sid, { origin: 'https://evil.example' });
  await assert.rejects(crossOrigin.opened, /HTTP 403/);
  await api(server, 'DELETE', `/api/terminal/sessions/${s.json.sid}`);
});

test('closing a session via DELETE kills it and it disappears', async () => {
  const s = await api(server, 'POST', '/api/terminal/sessions', { cols: 80, rows: 24 });
  const v = openTerminal(server, s.json.sid);
  await v.opened;
  assert.equal((await api(server, 'DELETE', `/api/terminal/sessions/${s.json.sid}`)).status, 200);
  await waitFor(() => v.closed, 'socket closed after DELETE');
  assert.equal((await api(server, 'GET', `/api/terminal/sessions/${s.json.sid}`)).status, 404);
});

const PUBLIC_HOST = 'buildesk.acc.l-inc.co.za';
const publicHeaders = (extra = {}) => ({ Host: PUBLIC_HOST, Origin: `https://${PUBLIC_HOST}`, 'Sec-Fetch-Site': 'same-origin', ...extra });

function viaNginx(s, method, route, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: s.port, method, path: route, headers }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('behind nginx an unauthenticated page request gets the Basic challenge', async () => {
  const r = await viaNginx(server, 'GET', '/gm/', publicHeaders());
  assert.equal(r.status, 401);
  assert.match(r.headers['www-authenticate'], /^Basic /);
});

test('a Basic login sets the cookie that terminal routes accept from the public host', async () => {
  const basic = 'Basic ' + Buffer.from(`abc:${PASSWORD}`).toString('base64');
  const page = await viaNginx(server, 'GET', '/gm/', publicHeaders({ Authorization: basic }));
  assert.equal(page.status, 200);
  const cookie = (page.headers['set-cookie'] || []).map((c) => c.split(';')[0]).find((c) => c.startsWith('agentgui_token='));
  assert.ok(cookie, 'login sets agentgui_token');
  const created = await viaNginx(server, 'POST', '/gm/api/terminal/sessions', publicHeaders({ Cookie: cookie, 'Content-Type': 'application/json' }), JSON.stringify({ cols: 80, rows: 24 }));
  assert.equal(created.status, 200);
  const sid = JSON.parse(created.text).sid;
  assert.equal((await viaNginx(server, 'GET', '/gm/api/terminal/sessions', publicHeaders({ Cookie: cookie }))).status, 200);
  assert.equal((await viaNginx(server, 'DELETE', `/gm/api/terminal/sessions/${sid}`, publicHeaders({ Cookie: cookie }))).status, 200);
});

test('behind nginx the socket accepts the token from the public host and refuses the cookie alone', async () => {
  const s = await api(server, 'POST', '/api/terminal/sessions', { cols: 80, rows: 24 });
  const sid = s.json.sid;
  const withToken = openTerminal(server, sid, { headers: publicHeaders() });
  await withToken.opened;
  withToken.ws.close();
  const cookieOnly = openTerminal(server, sid, { token: null, headers: publicHeaders({ Cookie: `agentgui_token=${PASSWORD}` }) });
  await assert.rejects(cookieOnly.opened, /HTTP 401/);
  await api(server, 'DELETE', `/api/terminal/sessions/${sid}`);
});

test('behind the proxy one client failed logins do not refuse another client', async () => {
  const s = await startServer({ terminals: true });
  try {
    const basic = (pw) => 'Basic ' + Buffer.from(`abc:${pw}`).toString('base64');
    for (let i = 0; i < 40; i += 1) {
      await viaNginx(s, 'GET', '/gm/', publicHeaders({ Authorization: basic('wrong'), 'X-Forwarded-For': '203.0.113.7' }));
    }
    const other = await viaNginx(s, 'GET', '/gm/', publicHeaders({ Authorization: basic(PASSWORD), 'X-Forwarded-For': '203.0.113.8' }));
    assert.equal(other.status, 200);
  } finally {
    stopServer(s);
  }
});

test('terminals stay disabled with ENABLE_TERMINAL=0', async () => {
  const off = await startServer({ terminals: false });
  try {
    const r = await api(off, 'POST', '/api/terminal/sessions', { cols: 80, rows: 24 });
    assert.equal(r.status, 403);
    const h = await api(off, 'GET', '/health');
    assert.equal(h.json.terminalsEnabled, false);
  } finally {
    stopServer(off);
  }
});
