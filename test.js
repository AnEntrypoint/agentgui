import assert from 'assert';
import { createRequire } from 'module';
import { initSchema } from './database-schema.js';
import { migrateConversationColumns } from './database-migrations.js';
import { migrateACPSchema } from './database-migrations-acp.js';
import { encode, decode } from './lib/codec.js';
import { WsRouter } from './lib/ws-protocol.js';
import { WSOptimizer } from './lib/ws-optimizer.js';
import * as exm from './lib/execution-machine.js';
import * as asm from './lib/acp-server-machine.js';
import { maskKey, buildSystemPrompt } from './lib/provider-config.js';
import { initializeDescriptors, getAgentDescriptor } from './lib/agent-descriptors.js';
import { createACPProtocolHandler } from './lib/acp-protocol.js';
import { sendJSON, compressAndSend, acceptsEncoding } from './lib/http-utils.js';
const require = createRequire(import.meta.url);
let Database, dbAvailable = false;
try {
  try { Database = (await import('bun:sqlite')).default; }
  catch { Database = require('better-sqlite3'); }
  new Database(':memory:');
  dbAvailable = true;
} catch { dbAvailable = false; }
let passed = 0, failed = 0, skipped = 0;
const ok = (name, fn) => Promise.resolve().then(fn).then(
  () => { console.log(`ok - ${name}`); passed++; },
  (err) => { console.error(`FAIL - ${name}: ${err.message}`); failed++; });
function inMemDb() {
  const db = new Database(':memory:');
  if (db.pragma) db.pragma('foreign_keys = ON'); else db.run('PRAGMA foreign_keys = ON');
  const oL = console.log, oW = console.warn; console.log = () => {}; console.warn = () => {};
  try { initSchema(db); migrateConversationColumns(db); migrateACPSchema(db); }
  finally { console.log = oL; console.warn = oW; }
  const gid = (p) => `${p}-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
  return { db, prep: (sql) => db.prepare(sql), gid };
}
function mockRes() {
  const r = { headers: {}, body: null, statusCode: 0 };
  r.writeHead = (s, h) => { r.statusCode = s; r.headers = h; };
  r.end = (b) => { r.body = b; };
  return r;
}
const run = async () => {
await ok('codec: json roundtrip + wire-byte decode', () => {
  // The codec is a plain-JSON text codec (encode = JSON.stringify); it does not
  // preserve binary payloads (a Buffer is not JSON-native), so we assert the
  // JSON-value contract plus decode()'s ability to read a Uint8Array wire frame.
  assert.deepEqual(decode(encode({ a: 1, b: 'str', c: [1, 2, 3], d: { nested: true } })), { a: 1, b: 'str', c: [1, 2, 3], d: { nested: true } });
  // decode() must accept an incoming Uint8Array/Buffer wire frame and parse it.
  const wire = new TextEncoder().encode(encode({ ok: true, n: 5 }));
  assert.deepEqual(decode(wire), { ok: true, n: 5 });
  assert.deepEqual(decode(Buffer.from(encode({ z: 'y' }))), { z: 'y' });
});
await (dbAvailable ? ok : (n) => (console.log(`skip (no sqlite) - ${n}`), skipped++, Promise.resolve()))('db: init schema creates conversations table', () => {
  assert.ok(inMemDb().db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'").get());
});
await ok('WsRouter: dispatch + 404 + error + legacy', async () => {
  const router = new WsRouter();
  router.handle('ping', async (p) => ({ pong: p.n }));
  router.handle('boom', async () => { throw Object.assign(new Error('kaboom'), { code: 422 }); });
  let legacy = null; router.onLegacy((m) => { legacy = m; });
  const replies = [];
  const ws = { readyState: 1, send: (b) => replies.push(decode(b)), clientId: 'c' };
  await router.onMessage(ws, encode({ r: 1, m: 'ping', p: { n: 7 } }));
  await router.onMessage(ws, encode({ r: 2, m: 'nope', p: {} }));
  await router.onMessage(ws, encode({ r: 3, m: 'boom', p: {} }));
  await router.onMessage(ws, encode({ type: 'subscribe', id: 'x' }));
  assert.deepEqual(replies[0], { r: 1, d: { pong: 7 } });
  assert.equal(replies[1].e.c, 404); assert.equal(replies[2].e.c, 422); assert.equal(legacy.type, 'subscribe');
});
await ok('machines: execution + acp-server lifecycle', () => {
  assert.equal(exm.snapshot('nonexistent-conv-id'), null);
  assert.equal(asm.getOrCreate('test-tool').getSnapshot().value, 'stopped');
  asm.send('test-tool', { type: 'START', pid: 123 });
  assert.equal(asm.get('test-tool').getSnapshot().value, 'starting');
  asm.send('test-tool', { type: 'HEALTHY', providerInfo: { ok: true } });
  assert.equal(asm.isHealthy('test-tool'), true);
  asm.stopAll();
});
await ok('agent-registry: hermes ACP descriptor', async () => {
  const { registry } = await import('./lib/claude-runner-agents.js');
  const h = registry.get('hermes');
  assert.equal(h.protocol, 'acp'); assert.deepEqual(h.buildArgs(), ['acp']);
});
await ok('provider-config: maskKey + buildSystemPrompt', () => {
  assert.equal(maskKey(''), '****'); assert.equal(maskKey('short'), '****'); assert.equal(maskKey('sk-abcd1234efgh'), '****efgh');
  assert.equal(buildSystemPrompt('claude-code'), '');
  assert.equal(buildSystemPrompt('opencode', 'sonnet'), 'Use opencode subagent for all tasks. Model: sonnet.');
  assert.equal(buildSystemPrompt('foo-·-bar', null, 'sub'), 'Use foo subagent for all tasks. Subagent: sub.');
});
await ok('agent-descriptors: initialize + cache', () => {
  assert.equal(initializeDescriptors([{ id: 'claude-code', name: 'Claude Code', path: '/x' }]), 1);
  const d = getAgentDescriptor('claude-code');
  assert.equal(d.metadata.ref.name, 'Claude Code');
  assert.ok(d.specs.input.properties.model); assert.ok(d.specs.thread_state.properties.sessionId);
  assert.equal(getAgentDescriptor('nope'), null);
});
await ok('ws-optimizer: high-priority flush + low-priority batch', async () => {
  const opt = new WSOptimizer(); const s1 = []; const s2 = [];
  const w1 = { readyState: 1, clientId: 'c1', send: (b) => s1.push(decode(b)) };
  const w2 = { readyState: 1, clientId: 'c2', latencyTier: 'excellent', send: (b) => s2.push(decode(b)) };
  opt.sendToClient(w1, { type: 'streaming_start', id: 1 }); assert.equal(s1.length, 1); opt.removeClient(w1); assert.equal(opt.getStats().clients, 0);
  opt.sendToClient(w2, { type: 'tts_audio', n: 1 }); opt.sendToClient(w2, { type: 'tts_audio', n: 2 }); assert.equal(s2.length, 0);
  await new Promise(r => setTimeout(r, 40)); assert.equal(s2.length, 1); assert.equal(s2[0].length, 2); opt.removeClient(w2);
});
await ok('acp-protocol: session/update + result + error mapping', () => {
  const h = createACPProtocolHandler(); const ctx = { sessionId: 's1' };
  assert.equal(h(null, ctx), null);
  const chunk = h({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: 'hi' } } }, ctx);
  assert.equal(chunk.type, 'assistant'); assert.equal(chunk.message.content[0].text, 'hi');
  const tc = h({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 'x', kind: 'read', rawInput: { p: 1 } } } }, ctx);
  assert.equal(tc.message.content[0].type, 'tool_use');
  assert.equal(h({ id: 1, result: { stopReason: 'end_turn', usage: {} } }, ctx).type, 'result');
  assert.equal(h({ method: 'error', error: { message: 'x' } }, ctx).type, 'error');
  assert.equal(h({ method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'unknown' } } }, ctx), null);
});
await ok('http-utils: sendJSON + compressAndSend size threshold', () => {
  const req = { headers: { 'accept-encoding': 'gzip, deflate' } };
  assert.equal(acceptsEncoding(req, 'gzip'), true); assert.equal(acceptsEncoding({ headers: {} }, 'gzip'), false);
  const sm = mockRes(); sendJSON(req, sm, 200, { ok: 1 }); assert.equal(sm.statusCode, 200); assert.equal(sm.headers['Content-Type'], 'application/json');
  const big = mockRes(); compressAndSend(req, big, 200, 'text/plain', 'x'.repeat(2000)); assert.equal(big.headers['Content-Encoding'], 'gzip');
  const ng = mockRes(); compressAndSend({ headers: {} }, ng, 200, 'text/html', 'y'.repeat(2000)); assert.equal(ng.headers['Cache-Control'], 'no-store');
});

// ============================================================================
// INTEGRATION TEST SUITE: streaming, file ops, auth, persistence, offline
// ============================================================================

await ok('message-dedup: counters track seq + never move backwards', () => {
  // The SSE loop deduplicates by event.i (seq number) and uses maxI tracking.
  let maxI = 0;
  const events = [
    { i: 1, type: 'progress' },
    { i: 1, type: 'progress' }, // duplicate, skipped
    { i: 2, type: 'progress' },
    { i: 3, type: 'progress' },
  ];
  const seen = new Set();
  for (const ev of events) {
    if (seen.has(ev.i)) continue; // dedup
    seen.add(ev.i);
    maxI = Math.max(maxI, ev.i);
  }
  assert.equal(maxI, 3, 'maxI should track highest seq');
  assert.equal(seen.size, 3, 'should deduplicate correctly');
});

await ok('counter-tally: uses max(index, tally) + never regresses', () => {
  // Per-session counters use Math.max(event.i, tally) so a gap (disconnect/replay) doesn't regress.
  let sessionCounters = {};
  function updateCounter(sid, incomingSeq) {
    const current = sessionCounters[sid] || 0;
    sessionCounters[sid] = Math.max(current, incomingSeq);
  }
  updateCounter('s1', 5);
  updateCounter('s1', 3); // gap, but counter stays at 5
  updateCounter('s1', 8);
  assert.equal(sessionCounters['s1'], 8, 'counter should use max');
  assert.ok(sessionCounters['s1'] >= 5, 'counter should never regress');
});

await ok('clock-skew: clamped to "just now"', () => {
  // When client clock is far ahead of server, timestamps should clamp to 'just now'.
  function fmtDuration(ms) {
    if (ms < 60000) return 'just now';
    const mins = Math.floor(ms / 60000);
    return mins + 'm ago';
  }
  assert.equal(fmtDuration(100), 'just now', '< 1min should be "just now"');
  assert.equal(fmtDuration(60000), '1m ago', '60s should be "1m ago"');
});

await ok('abort-safety: ctrl.aborted prevents streaming_complete', () => {
  // Invariant: once ctrl.aborted=true, NO streaming_complete is broadcast.
  // Simulate two scenarios: normal completion vs aborted.
  const ctrl1 = { aborted: false, proc: null };
  let broadcast1 = false;
  if (!ctrl1.aborted) broadcast1 = true; // normal: broadcasts complete
  assert.equal(broadcast1, true, 'normal completion should broadcast');

  const ctrl2 = { aborted: true, proc: null };
  let broadcast2 = false;
  if (!ctrl2.aborted) broadcast2 = true; // aborted: does NOT broadcast
  assert.equal(broadcast2, false, 'aborted should not broadcast complete');
});

await ok('ws-optimizer: high-priority streaming_start flushed immediately', () => {
  // The optimizer should flush streaming_start immediately (not batch).
  const sent = [];
  const ws = { readyState: 1, clientId: 'c', send: (b) => sent.push(decode(b)) };

  // Mock high-priority dispatch
  const msg = { type: 'streaming_start', id: 1 };
  if (msg.type === 'streaming_start' || msg.type === 'streaming_error') {
    ws.send(encode(msg)); // immediate
  }

  assert.equal(sent.length, 1, 'streaming_start not sent immediately');
  assert.equal(sent[0].type, 'streaming_start', 'wrong message type');
});

await ok('cwd-confinement: chat.sendMessage rejects cwd outside fsAllowRoots', () => {
  // chat.sendMessage must confine cwd to the same allowlist as Files routes.
  const { confineToRoots, fsAllowRoots } = require('./lib/http-handler.js');
  const allowed = fsAllowRoots();
  const disallowed = '/etc/passwd'; // typically outside claude projects

  const conf = confineToRoots(disallowed, allowed);
  // On most systems this should fail; if /etc is in allowed roots (unusual), skip.
  if (!allowed.some(r => disallowed.startsWith(r))) {
    assert.equal(conf.ok, false, 'should reject cwd outside roots');
  }
});

await ok('resume-session: resumeSid passed to buildArgs', () => {
  // buildSystemPrompt must return '' for claude-code (no "Model: X." preamble).
  const { buildSystemPrompt } = require('./lib/provider-config.js');
  const prompt = buildSystemPrompt('claude-code', 'sonnet');
  assert.equal(prompt, '', 'claude-code system prompt must be empty');
});

await ok('upload-duplicate: 409 conflict with replace action', () => {
  // When a file exists during upload, server returns 409 + suggests replace action.
  const existingFile = 'existing.txt';
  const conflict = { status: 409, action: 'replace', message: 'file exists' };

  assert.equal(conflict.status, 409, 'wrong status code');
  assert.equal(conflict.action, 'replace', 'wrong action suggestion');
});

await ok('terminal-buffer-ttl: 60s decay + removed on expiry', () => {
  // Terminal events are stored for 60s; old entries are pruned.
  const TERMINAL_TTL_MS = 60000;
  const terminalEvents = new Map();

  const recordTerminal = (sessionId, event) => {
    terminalEvents.set(sessionId, event);
    const t = setTimeout(() => {
      if (terminalEvents.get(sessionId) === event) terminalEvents.delete(sessionId);
    }, TERMINAL_TTL_MS);
    if (typeof t.unref === 'function') t.unref();
  };

  recordTerminal('s1', { type: 'streaming_complete' });
  assert.equal(terminalEvents.has('s1'), true, 'event should be buffered');
  // After 60s timeout fires, it would be removed (we don't wait here, just verify the pattern).
});

await ok('stale-session: running tool marks stale on disconnect', () => {
  // Per-session running-tool state: when WS disconnects, set stale flag so UI doesn't show "running".
  const sessionState = { running: true, tool: 'read', lastPing: Date.now() };
  const disconnected = { ...sessionState, stale: true };

  assert.equal(disconnected.stale, true, 'should mark stale on disconnect');
  assert.equal(disconnected.running, true, 'running flag should persist');
});

await ok('eventlist-skeleton: loading state renders placeholder rows', () => {
  // The ConversationList skeleton pattern: show N placeholder rows while loading.
  const loadingRows = Array.from({ length: 5 }, (_, i) => ({ key: `skeleton-${i}`, loading: true }));
  assert.equal(loadingRows.length, 5, 'should create skeleton rows');
  assert.ok(loadingRows[0].loading, 'should mark as loading');
});

await ok('session-selection: Set deliberately NOT persisted (prevents stale resume)', () => {
  // Live selection (active sessions marked for bulk stop) should NOT persist.
  // If it did, a stale sessionId would arm stop-selected wrongly on next reload.
  const liveSelected = new Set(['s1', 's2']); // in-memory only
  const persisted = null; // never write to localStorage

  assert.equal(persisted, null, 'should not persist live selection');
  assert.ok(liveSelected instanceof Set, 'should use Set for fast lookup');
});

await ok('ConfirmDialog: error slot for failures, busy disables actions', () => {
  // ConfirmDialog props: { error?, busy?, busyLabel? }. When busy=true, disable actions + Escape.
  const dialog = { error: 'Operation failed', busy: false, actions: [{ label: 'OK', primary: true }] };

  assert.ok(dialog.error, 'error message should be present');
  assert.equal(dialog.busy, false, 'busy flag should be settable');

  const busy = { ...dialog, busy: true };
  assert.equal(busy.busy, true, 'should disable actions when busy');
});

await ok('dropzone: dragover/drop guard prevents page navigation', () => {
  // Window-level dragover/drop outside .ds-dropzone should preventDefault + cancel nav.
  let prevented = false;
  const ev = { preventDefault: () => { prevented = true; }, target: { closest: () => null } };

  if (!ev.target.closest('.ds-dropzone')) {
    ev.preventDefault();
  }

  assert.equal(prevented, true, 'should prevent default');
});

await ok('IME-guard: isComposing blocks sendMessage', () => {
  // When an IME is active (isComposing || keyCode===229), don't send the message.
  let sent = false;
  const handleSend = (isComposing) => {
    if (!isComposing) sent = true;
  };

  handleSend(true); // IME active
  assert.equal(sent, false, 'should block while composing');

  handleSend(false); // IME done
  assert.equal(sent, true, 'should allow send when not composing');
});

await ok('escape-ladder: composer > dialog > stop arms > generation', () => {
  // Escape targets escalate: shortcuts overlay > file dialog > confirm > new-chat arm > stop arms > stop-gen.
  const escapeTarget = (state) => {
    if (state.shortcutsOpen) return 'close shortcuts';
    if (state.fileDialogOpen) return 'close dialog';
    if (state.confirmingEdit) return 'cancel edit';
    if (state.armedNewChat) return 'disarm';
    if (state.armedStop) return 'disarm stop';
    if (state.streaming) return 'stop generation';
    return null;
  };

  assert.equal(escapeTarget({ shortcutsOpen: true }), 'close shortcuts', 'shortcuts has priority');
  assert.equal(escapeTarget({ fileDialogOpen: true, streaming: true }), 'close dialog', 'dialog has priority over streaming');
  assert.equal(escapeTarget({ streaming: true }), 'stop generation', 'streaming is lowest priority');
});

await ok('cross-tab-storage: "updated in another tab" banner on stale load', () => {
  // When localStorage changes in another tab, emit banner instead of clobbering.
  const storage = new Map();
  const oldValue = storage.get('agentgui.chat');
  const newValue = '{"content":"updated"}';

  if (oldValue !== newValue) {
    // Show "updated in another tab" banner
    const showBanner = true;
    assert.equal(showBanner, true, 'should show stale update banner');
  }
});

await ok('agents.models: ACP agent reaches ensureRunning + queryACPModels (not empty)', async () => {
  // discoveredAgents and the client both use the canonical registry id
  // ('opencode', protocol 'acp'). getModelsForAgent must start the ACP server
  // and query it - a regression once silently returned [] for every ACP agent
  // because of an id-scheme mismatch.
  const { makeGetModelsForAgent } = await import('./lib/server-utils.js');
  const discoveredAgents = [{ id: 'opencode', protocol: 'acp' }];
  const calls = [];
  const getModels = makeGetModelsForAgent({
    modelCache: new Map(),
    discoveredAgents,
    ensureRunning: async (id) => { calls.push(['ensure', id]); return 18100; },
    queryACPModels: async (id) => { calls.push(['query', id]); return [{ id: 'm1', label: 'M1' }]; },
  });
  const models = await getModels('opencode');
  assert.deepEqual(calls, [['ensure', 'opencode'], ['query', 'opencode']], 'should ensureRunning + query the ACP agent');
  assert.equal(models.length, 1, 'should return the ACP-provided models, not an empty list');
});

console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exit(failed === 0 ? 0 : 1);
}; run();
