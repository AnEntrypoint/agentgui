export const CHAT_KEY = 'agentgui.chat';
// Cap the persisted footprint: the last 100 messages, with any tool args/result
// payload over 4KB truncated in the SAVED copy only (in-memory state keeps the
// full payload). A quota failure is surfaced once instead of silently dropping
// persistence forever.
const PERSIST_MSG_CAP = 100;
const PERSIST_PART_CAP = 4096;

// An assistant turn with no content AND no parts is an empty shell (an aborted
// turn that produced nothing). The view already renders it as nothing; drop it
// from persisted/in-memory state so a restored chat never carries blank bubbles.
function isEmptyTurn(m) {
  return m.role === 'assistant' && !m.content && !(Array.isArray(m.parts) && m.parts.length);
}

function trimPartForStorage(p) {
  if (!p || typeof p !== 'object') return p;
  let out = p;
  for (const k of ['result', 'args']) {
    const v = out[k];
    if (v == null) continue;
    let s;
    if (typeof v === 'string') s = v;
    else { try { s = JSON.stringify(v); } catch { s = String(v); } }
    if (s.length > PERSIST_PART_CAP) {
      if (out === p) out = { ...p };
      out[k] = s.slice(0, PERSIST_PART_CAP);
      out.truncatedForStorage = true;
    }
  }
  return out;
}

function computeTotalCost(state) {
  return (state.chat.messages || []).reduce((s, m) => s + (typeof m.costUsd === 'number' ? m.costUsd : 0), 0);
}

// Factory: app.js calls this once at module load, passing the live `state`
// object (mutated by reference, same as every other app.js concern) and the
// shared helpers (announce/scheduleRender/lsGet/lsSet/lsRemove/debounce)
// already defined there. Returns the same function set app.js previously
// defined inline, wired to app.js's own state/render/announce.
export function createChatPersistence(state, { announce, scheduleRender, lsGet, lsRemove, debounce }) {
  let _persistFailedOnce = false;
  let _lastPersistTs = 0;

  function persistChat() {
    try {
      const eligible = state.chat.messages.filter(m => !isEmptyTurn(m));
      // On-screen transcript can exceed the cap; a reload only restores the last
      // PERSIST_MSG_CAP turns - surface that once so it's not a silent surprise,
      // same Alert pattern as the sibling quota-failure banner below.
      const wasCapped = eligible.length > PERSIST_MSG_CAP;
      if (wasCapped !== !!state.chat.persistTruncated) {
        state.chat.persistTruncated = wasCapped;
        scheduleRender();
      }
      const msgs = eligible
        .slice(-PERSIST_MSG_CAP)
        .map(m => ({ id: m.id, role: m.role, content: m.content, time: m.time, costUsd: m.costUsd, stopped: m.stopped || undefined, parts: Array.isArray(m.parts) ? m.parts.map(trimPartForStorage) : m.parts }));
      const draft = (state.chat.draft || '').trim() ? state.chat.draft : '';
      // Persist when there is a transcript OR a non-empty draft (a typed-but-not-
      // sent message must survive a reload too).
      if (!msgs.length && !draft) { lsRemove(CHAT_KEY); return; }
      _lastPersistTs = Date.now();
      localStorage.setItem(CHAT_KEY, JSON.stringify({ ts: _lastPersistTs, messages: msgs, draft, resumeSid: state.chat.resumeSid, totalCost: state.chat.totalCost || 0, agent: state.selectedAgent, model: state.selectedModel }));
    } catch {
      if (!_persistFailedOnce) {
        _persistFailedOnce = true;
        state.chat.persistError = true;
        announce('chat too large to save locally - export it from settings');
        scheduleRender();
      }
    }
  }

  const debouncedPersistDraft = debounce(persistChat, 500);

  // Another GUI tab rewrote the shared chat key: never silently diverge - surface
  // a banner offering to reload the newer copy (last-writer-wins with a ts guard).
  window.addEventListener('storage', (e) => {
    if (e.key !== CHAT_KEY || !e.newValue) return;
    try {
      const remote = JSON.parse(e.newValue);
      if (remote && remote.ts && remote.ts > _lastPersistTs) {
        state.chat.externalUpdate = true;
        scheduleRender();
      }
    } catch {}
  });

  function restoreChat() {
    try {
      const raw = lsGet(CHAT_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (typeof saved.draft === 'string' && saved.draft.trim()) {
        state.chat.draft = saved.draft;
        // A restored draft is set programmatically, so Ctrl+Z has nothing in the
        // browser's native undo history to act on - a one-time note explains why
        // undo appears to do nothing right after a reload.
        announce('draft restored - note: undo history does not carry over a reload');
      }
      if (typeof saved.totalCost === 'number') state.chat.totalCost = saved.totalCost;
      if (Array.isArray(saved.messages) && saved.messages.length) {
        state.chat.messages = saved.messages
          .filter(m => !isEmptyTurn(m))
          .map(m => ({ ...m, parts: Array.isArray(m.parts) ? m.parts : [] }));
        // Prefer the per-message cost sum when present (it self-corrects after
        // edit/retry truncation); the scalar is only the legacy fallback.
        const derived = computeTotalCost(state);
        if (derived) state.chat.totalCost = derived;
        state.chat.resumeSid = saved.resumeSid || null;
        // Restore the agent/model the transcript belongs to, so a restored chat
        // isn't silently shown under whatever agent the picker defaulted to.
        state.chat.restoredAgent = saved.agent || null;
        state.chat.restoredModel = saved.model || null;
      }
    } catch {}
  }

  return { persistChat, restoreChat, debouncedPersistDraft, isEmptyTurn, computeTotalCost: () => computeTotalCost(state) };
}
