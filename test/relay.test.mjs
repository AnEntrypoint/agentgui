import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
  if (terminals) env.ENABLE_TERMINAL = '1'; else delete env.ENABLE_TERMINAL;
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

function openTerminal(s, sid, { token = PASSWORD, origin } = {}) {
  const headers = origin ? { origin } : {};
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}/gm/api/terminal/sessions/${sid}?token=${encodeURIComponent(token)}`, { headers });
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

test('terminals stay disabled without ENABLE_TERMINAL=1', async () => {
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
