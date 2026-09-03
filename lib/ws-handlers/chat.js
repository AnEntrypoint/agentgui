import crypto from 'crypto';
import { runClaudeWithStreaming } from '../claude-runner-run.js';
import { registry } from '../claude-runner-agents.js';
import { confineToRoots, fsAllowRoots } from '../http-handler.js';
import { err } from './shared.js';
import { recordTerminal, getTerminal } from './terminal-state.js';

export function register(router, deps) {
  const { wsOptimizer, broadcastSync, STARTUP_CWD, subscriptionIndex, activeChats } = deps;

  // --- conversation.subscribe: register this ws for sessionId broadcasts ---
  router.handle('conversation.subscribe', (p, ws) => {
    const sid = p?.sessionId;
    if (!sid || typeof sid !== 'string') err(400, 'sessionId required');
    if (!subscriptionIndex.has(sid)) subscriptionIndex.set(sid, new Set());
    subscriptionIndex.get(sid).add(ws);
    ws.subscriptions = ws.subscriptions || new Set();
    ws.subscriptions.add(sid);
    // Replay a buffered terminal frame (complete/error/cancelled) so a client
    // that re-subscribes after a ws drop learns the turn already ended.
    const term = getTerminal(sid);
    if (term) { try { wsOptimizer.sendToClient(ws, { ...term, replayed: true }); } catch {} }
    return { subscribed: true, sessionId: sid, replayedTerminal: !!term };
  });

  // --- chat.sendMessage: start a one-shot streaming chat with an agent.
  // Bypasses the gutted db-queries layer entirely; calls runClaudeWithStreaming
  // directly and broadcasts streaming_* events scoped to an ephemeral sessionId.
  router.handle('chat.sendMessage', async (p, ws) => {
    let content = (p?.content || '').toString();
    if (!content) err(400, 'content required');
    const agentId = p?.agentId || 'claude-code';
    // For non-resume agents (not claude-code which uses --resume), prepend prior
    // conversation turns so the agent has context. claude-code handles multi-turn
    // natively via resumeSessionId; direct runners (agy, etc.) get a preamble.
    const priorMessages = Array.isArray(p?.messages) ? p.messages.filter(m => m?.role && m?.content) : [];
    if (agentId !== 'claude-code' && !p?.resumeSid && !p?.resumeSessionId && priorMessages.length > 0) {
      const preamble = priorMessages.map(m => (m.role === 'user' ? 'User: ' : 'Assistant: ') + (m.content || '').trim()).join('\n\n');
      content = '[Prior conversation]\n' + preamble + '\n\n[Current message]\n' + content;
    }
    const model = p?.model || undefined;
    const subAgent = p?.subAgent || undefined;
    const cwd = p?.cwd || STARTUP_CWD;
    const resumeSessionId = p?.resumeSid || p?.resumeSessionId || undefined;
    if (!registry.has(agentId)) err(404, `Unknown agentId: ${agentId}`);
    // A client-supplied cwd must be confined to the SAME allowlist as the Files
    // routes (fsAllowRoots) - an unconfined cwd would let a client spawn the
    // agent CLI anywhere on disk. Use the realpath-resolved value as the spawn
    // cwd (defeats symlink escape, same as the HTTP file routes). No p.cwd ->
    // STARTUP_CWD, which is itself an allowed root, so it needs no check.
    let spawnCwd = STARTUP_CWD;
    if (p?.cwd) {
      const conf = confineToRoots(cwd, fsAllowRoots());
      if (!conf.ok) err(conf.reason === 'not found' ? 400 : 403, `cwd outside allowed roots: ${cwd}`);
      spawnCwd = conf.realPath;
    }

    const sessionId = 'chat-' + crypto.randomBytes(8).toString('hex');
    // Auto-subscribe the originating ws so it receives its own broadcasts.
    if (!subscriptionIndex.has(sessionId)) subscriptionIndex.set(sessionId, new Set());
    subscriptionIndex.get(sessionId).add(ws);
    ws.subscriptions = ws.subscriptions || new Set();
    ws.subscriptions.add(sessionId);

    const ctrl = { aborted: false, proc: null, agentId, model, cwd: spawnCwd, startedAt: Date.now() };
    activeChats.set(sessionId, ctrl);
    // Push-driven hint so clients refresh active-session state without
    // waiting for the 3s chat.active poll (finding 48).
    broadcastSync({ type: 'chat_active_changed', reason: 'started', sessionId, agentId, timestamp: Date.now() });

    // Fire-and-forget. Errors broadcast as streaming_error.
    (async () => {
      let eventCount = 0;
      broadcastSync({ type: 'streaming_start', sessionId, agentId, timestamp: Date.now() });
      let claudeSessionBroadcast = false;
      const onEvent = (parsed) => {
        eventCount++;
        // Surface claude's REAL session id (from the stream) once, so the client
        // can --resume this conversation on its next turn. The ephemeral
        // 'chat-...' sessionId is not a claude session id and cannot be resumed.
        if (!claudeSessionBroadcast && parsed?.session_id) {
          claudeSessionBroadcast = true;
          ctrl.claudeSessionId = parsed.session_id;
          broadcastSync({ type: 'streaming_session', sessionId, claudeSessionId: parsed.session_id, agentId, timestamp: Date.now() });
        }
        if (parsed?.type === 'assistant' && parsed.message?.content) {
          for (const block of parsed.message.content) {
            broadcastSync({ type: 'streaming_progress', sessionId, block, blockRole: 'assistant', seq: eventCount, timestamp: Date.now() });
          }
        } else if (parsed?.type === 'user' && parsed.message?.content) {
          const blocks = Array.isArray(parsed.message.content) ? parsed.message.content : [];
          for (const block of blocks) {
            if (block?.type === 'tool_result') {
              broadcastSync({ type: 'streaming_progress', sessionId, block, blockRole: 'tool_result', seq: eventCount, timestamp: Date.now() });
            }
          }
        } else if (parsed?.type === 'result') {
          const block = { type: 'result', result: parsed.result, subtype: parsed.subtype, duration_ms: parsed.duration_ms, total_cost_usd: parsed.total_cost_usd, is_error: !!parsed.is_error };
          broadcastSync({ type: 'streaming_progress', sessionId, block, blockRole: 'result', seq: eventCount, isResult: true, timestamp: Date.now() });
        }
      };
      try {
        const config = {
          verbose: true, outputFormat: 'stream-json', timeout: 1800000, print: true,
          model, subAgent, onEvent, resumeSessionId,
          onPid: () => {}, onProcess: (proc) => { ctrl.proc = proc; },
        };
        await runClaudeWithStreaming(content, spawnCwd, agentId, config);
        if (!ctrl.aborted) {
          const ev = { type: 'streaming_complete', sessionId, claudeSessionId: ctrl.claudeSessionId || null, agentId, eventCount, timestamp: Date.now() };
          recordTerminal(sessionId, ev);
          broadcastSync(ev);
        }
      } catch (e) {
        if (!ctrl.aborted) {
          const ev = { type: 'streaming_error', sessionId, claudeSessionId: ctrl.claudeSessionId || null, agentId, error: e.message || String(e), recoverable: false, timestamp: Date.now() };
          recordTerminal(sessionId, ev);
          broadcastSync(ev);
        }
      } finally {
        activeChats.delete(sessionId);
        broadcastSync({ type: 'chat_active_changed', reason: 'ended', sessionId, agentId, timestamp: Date.now() });
      }
    })();

    return { sessionId, started: true };
  });

  // --- chat.active: list in-flight chats started via this server ---
  router.handle('chat.active', () => {
    const sessions = [];
    for (const [sid, c] of activeChats) {
      sessions.push({ sessionId: sid, claudeSessionId: c.claudeSessionId || null, agentId: c.agentId || null, model: c.model || null, cwd: c.cwd || null, startedAt: c.startedAt || null, pid: c.proc?.pid || null });
    }
    return { sessions };
  });

  // --- chat.cancel: abort an in-flight chat ---
  router.handle('chat.cancel', (p) => {
    const sid = p?.sessionId;
    if (!sid) err(400, 'sessionId required');
    const ctrl = activeChats.get(sid);
    if (!ctrl) return { cancelled: false, reason: 'not-found' };
    ctrl.aborted = true;
    // Broadcast the terminal 'cancelled' frame BEFORE killing the proc so a
    // remote cancellation (other tab, dashboard stop-all) does not read as a
    // normal completion (finding 44). streaming_cancelled is in BROADCAST_TYPES
    // so every connected client sees it; it is also buffered for re-subscribers.
    const ev = { type: 'streaming_cancelled', sessionId: sid, claudeSessionId: ctrl.claudeSessionId || null, agentId: ctrl.agentId || null, cancelled: true, timestamp: Date.now() };
    recordTerminal(sid, ev);
    broadcastSync(ev);
    try { ctrl.proc?.kill?.(); } catch {}
    activeChats.delete(sid);
    broadcastSync({ type: 'chat_active_changed', reason: 'cancelled', sessionId: sid, agentId: ctrl.agentId || null, timestamp: Date.now() });
    return { cancelled: true };
  });
}
