// Smoke-test the WS chat protocol added in this session.
// Boots no server - assumes one is already running at ws://localhost:$PORT/sync.
//
// Usage: PORT=3990 node scripts/smoke-ws-chat.mjs
//
// Checks:
//  1. WS connects, receives sync_connected.
//  2. agents.list returns a non-empty array.
//  3. (optional) conversation.subscribe returns subscribed:true.

import WebSocket from 'ws';

const PORT = process.env.PORT || 3000;
const URL = `ws://localhost:${PORT}/sync`;

const ws = new WebSocket(URL);
let reqId = 0;
const pending = new Map();

const call = (method, params) => new Promise((resolve, reject) => {
  const r = ++reqId;
  pending.set(r, { resolve, reject });
  ws.send(JSON.stringify({ m: method, r, p: params || {} }));
  setTimeout(() => { if (pending.has(r)) { pending.delete(r); reject(new Error('timeout: ' + method)); } }, 5000);
});

ws.on('open', async () => {
  console.log('WS open:', URL);
});

ws.on('message', async (data) => {
  let msg;
  try { msg = JSON.parse(data.toString('utf8')); } catch { console.log('decode fail:', data); return; }
  const items = Array.isArray(msg) ? msg : [msg];
  for (const m of items) {
    if (m && m.r !== undefined && (m.d !== undefined || m.e !== undefined)) {
      const p = pending.get(m.r);
      if (!p) continue;
      pending.delete(m.r);
      if (m.e) p.reject(new Error(m.e.m));
      else p.resolve(m.d);
    } else if (m?.type === 'sync_connected') {
      console.log('sync_connected, clientId =', m.clientId);
      try {
        const r1 = await call('agents.list');
        console.log('agents.list OK, count =', r1.agents.length, '- first =', r1.agents[0]?.id);
        const r2 = await call('conversation.subscribe', { sessionId: 'smoke-test-sid' });
        console.log('conversation.subscribe OK =', r2);
        console.log('PASS');
        process.exit(0);
      } catch (e) {
        console.error('FAIL:', e.message);
        process.exit(1);
      }
    }
  }
});

ws.on('error', (e) => { console.error('ws error:', e.message); process.exit(1); });
ws.on('close', (code, reason) => { console.log('ws close:', code, reason?.toString()); });

setTimeout(() => { console.error('overall timeout'); process.exit(1); }, 15000);
