import { h, mount, installStyles, components as C } from 'anentrypoint-design';
import * as B from './backend.js';
import { createChatPersistence, CHAT_KEY } from './chat-persistence.js';
import { installShortcuts } from './shortcuts.js';
import { readHash as readHashRouting, buildHash as buildHashRouting, writeHash as writeHashRouting } from './hash-routing.js';
import { createHistory } from './history.js';

installStyles().catch(() => {});

const { AppShell, WorkspaceShell, WorkspaceRail, Topbar, Crumb, Side, Status, Chat, ChatComposer, AgentChat, ConversationList, SessionDashboard, Row, Panel, PageHeader, TextField, Select, Btn, Icon, IconButton, EventList, Spinner, Alert, FileGrid, FileSkeleton, sortFiles, FileToolbar, RootsPicker, BreadcrumbPath, EmptyState, FileViewer, FilePreviewPane, FilePreviewCode, FilePreviewText, FilePreviewMedia, ThemeToggle, ContextPane, PromptDialog, ConfirmDialog, DropZone, UploadProgress, FilterPills, SessionMeta, BulkBar, Checkbox, ShortcutList, FocusTrap, AgentListSkeleton, flashComposerNote, toast, withBusy, GitStatusPanel, GitDiffView, WorktreeSwitcher, Badge, ModelsConfig, PluginsConfig } = C;

// One duration/bytes vocabulary across every surface: prefer the kit's shared
// formatters (exported alongside the components), fall back to the local
// equivalents so the app keeps working against an older vendored kit build.
const fmtDuration = C.fmtDuration || ((ms) => humanizeMs(ms));
const fmtBytes = C.fmtBytes || ((n) => (Math.round((n || 0) / 102.4) / 10) + ' KB');

const state = {
  backend: B.getBackend(),
  backendDraft: B.getBackend(),
  health: { status: 'unknown' },
  tab: 'chat',
  agents: [],
  selectedAgent: lsGet('agentgui.agent') || '',
  agentModels: [],
  selectedModel: lsGet('agentgui.model') || '',
  chatCwd: lsGet('agentgui.cwd') || '',
  chat: { messages: [], busy: false, abort: null, draft: '', resumeSid: null, confirmingEdit: null, totalCost: 0 },
  agentsError: null,
  // true until the boot loadAgents() call resolves - starting false left a
  // real window (mount -> boot's first render -> loadAgents() actually
  // starting) where the picker rendered with an empty options list instead
  // of the "loading agents…" placeholder, a transient state a toolbar button
  // could source an undefined label/type from.
  agentsLoading: true,
  settingsSection: null,
  eventFilter: 'all',         // history event-type filter: all | text | tool | errors
  sessionSearchQ: null,       // the query the selected session was opened from (search-hit highlight)
  historySlow: false,         // first history fetch unresolved after 5s -> indexing copy
  eventsSlow: false,          // first events fetch unresolved after 5s -> indexing copy
  sessions: [],
  selectedSid: null,
  events: [],
  searchQ: '',
  searchHits: null,
  historyError: null,
  showSubagents: false,
  sessionsLimit: 60,
  projectFilter: '',
  live: { es: null, connected: false, lastEventTs: 0, error: null, eventCount: 0, reconnects: 0, stopping: new Set(), clockSkew: null },
  active: [],
  activeTimer: null,
  eventsLimit: 300,   // how many of the most-recent events to render; grows via "load older"
  files: { path: '', segments: [], entries: [], roots: [], loading: false, error: null, preview: null, sort: 'name', sortDir: 'asc', filter: '' },
  git: { loading: false, error: null, diff: '', commits: [], worktrees: [], files: [], file: '', worktreeBusy: false },
  // One-time welcome banner naming what each tab is for. Shown until
  // dismissed once, ever - a returning user has already learned the tabs.
  showOnboarding: lsGet('agentgui.onboarded') !== '1',
  // Models tab: composed agent/provider availability (models.availability WS
  // handler), fed into the design SDK's ModelsConfig component.
  models: { data: null, loading: false, error: null, selectedProviderId: null },
  // Plugins tab: agentgui has no freddie-style plugin host - the closest real
  // extensibility surface is the discovered agent-CLI registry (agents.list),
  // adapted to PluginsConfig's {name,surfaces,requires,enabled,status} shape.
  plugins: { selected: null },
};

// Two-step arm controls auto-reset after this delay so an accidental first click
// doesn't leave a "armed" button forever.
const ARM_RESET_MS = 4000;

// Full routable param set. Every view-defining piece of state round-trips
// through the hash so reload and Back/forward restore the exact view.
// Hash-based deep-link state - extracted to hash-routing.js. Local names kept
// identical to every existing call site (readHash/buildHash/writeHash), bound
// against the module's shared `state` object.
function readHash() { return readHashRouting(); }
function buildHash() { return buildHashRouting(state); }
function writeHash(opts) { return writeHashRouting(state, opts); }
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
function fmtRelTime(ts) {
  if (!ts) return '';
  const s = Math.round((Date.now() - ts) / 1000);
  // Clamp negative spans (server clock ahead of the client) to "just now" -
  // "-12s ago" is clock skew, not information.
  if (s <= 0) return 'just now';
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.round(s/60) + 'm ago';
  if (s < 86400) return Math.round(s/3600) + 'h ago';
  return Math.round(s/86400) + 'd ago';
}

let render;
let renderScheduled = false;
function scheduleRender() {
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => { renderScheduled = false; render(); });
}

// Streaming renders (token deltas, tool events) arrive faster than a frame; a
// full webjsx diff + scroll per token thrashes. Coalesce both into one rAF tick
// so a fast stream costs ~60fps of renders, not one render per token.
let streamRenderScheduled = false;
function scheduleStreamRender() {
  if (streamRenderScheduled) return;
  // Don't wipe an active text selection inside the streaming thread: a
  // re-render replaces the live bubble's text nodes every frame, destroying a
  // select-and-copy in progress. The stream's settle path (finally) still
  // renders unconditionally, so nothing is lost - rendering just pauses while
  // the selection is held.
  try {
    const sel = document.getSelection();
    if (sel && !sel.isCollapsed && sel.anchorNode) {
      const node = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentElement;
      if (node && node.closest && node.closest('.agentchat-thread, .chat-thread')) return;
    }
  } catch {}
  streamRenderScheduled = true;
  requestAnimationFrame(() => {
    streamRenderScheduled = false;
    render();
    // Kit AgentChat's IntersectionObserver sentinel handles streaming auto-scroll;
    // calling scrollChatToBottom here forces a synchronous scrollHeight layout reflow.
  });
}

const UNTITLED_CONVERSATION = 'Untitled conversation';  // one fallback label, one casing, for every call site
const NARROW_BP = 640;  // unified with the CSS touch-target breakpoint in index.html
function isNarrow() { return typeof window !== 'undefined' && window.innerWidth < NARROW_BP; }
function truncate(str, mobileLen, desktopLen) {
  const s = String(str ?? '');
  const max = isNarrow() ? mobileLen : desktopLen;
  return s.length > max ? s.slice(0, max) + '…' : s;
}
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function lsGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); } catch {} }
function lsRemove(k) { try { localStorage.removeItem(k); } catch {} }

function dismissOnboarding() {
  state.showOnboarding = false;
  lsSet('agentgui.onboarded', '1');
  render();
}

// A single visually-hidden aria-live region for transient announcements (tab
// changes, etc.) so screen-reader users hear context that's otherwise conveyed
// only by focus movement or color.
let _announcer = null;
let lastAnnouncedStatus = null;
function announce(msg) {
  if (typeof document === 'undefined') return;
  if (!_announcer) {
    _announcer = document.createElement('div');
    _announcer.setAttribute('aria-live', 'polite');
    _announcer.setAttribute('role', 'status');
    _announcer.className = 'sr-only';
    document.body.appendChild(_announcer);
  }
  // Clear then set on the next frame so repeated identical messages re-announce.
  _announcer.textContent = '';
  requestAnimationFrame(() => { if (_announcer) _announcer.textContent = msg; });
}

// Extract the last path segment from a file-system path (cross-platform / or \).
function pathBasename(p) { return p ? p.split(/[/\\]/).filter(Boolean).slice(-1)[0] || '' : ''; }

function pillButton(key, label, active, title, onClick) {
  return h('button', {
    key,
    type: 'button',
    class: 'pill lede' + (active ? ' pill-active' : ''),
    title,
    'aria-pressed': active ? 'true' : 'false',
    onClick,
  }, label);
}

let _chatScroller = null;
function scrollChatToBottom() {
  // The kit's real scroll container is .agentchat-thread; the old .chat-thread
  // selector matched nothing, so auto-scroll silently never fired. Cache the
  // node and re-query only if it detached. Callers already run inside a frame
  // (or right after render), so no nested rAF here.
  if (!_chatScroller || !_chatScroller.isConnected) {
    _chatScroller = document.querySelector('.agentchat-thread')
      || document.querySelector('.chat-thread')
      || document.querySelector('#agentgui-main')
      || document.getElementById('app');
  }
  if (_chatScroller) _chatScroller.scrollTop = _chatScroller.scrollHeight;
}

function timeNow() {
  const d = new Date();
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

async function selectAgent(id) {
  // Re-selecting the same agent would needlessly refetch models and reset the
  // current model selection - no-op early.
  if (id === state.selectedAgent && state.agentModels.length) return;
  state.selectedAgent = id;
  lsSet('agentgui.agent', id);
  // Resume state is claude-code-only (it threads claude's --resume sid). Switching
  // to any other agent must clear it, or the resume banner keeps showing and a
  // stale sid gets forwarded - which makes agy wrongly run --continue.
  if (id !== 'claude-code') { state.chat.resumeSid = null; state.chat.resumeNote = null; }
  state.agentModels = [];
  state.selectedModel = '';
  state.modelsLoading = true;
  render();
  const models = await B.listAgentModels(state.backend, id);
  if (state.selectedAgent !== id) return; // changed while loading
  state.modelsLoading = false;
  state.agentModels = models;
  const saved = lsGet('agentgui.model');
  // Only restore a saved model that the NEW agent actually offers; otherwise
  // fall back to its first model (never carry a stale model from a prior agent).
  state.selectedModel = (saved && models.some(m => m.id === saved)) ? saved : (models[0]?.id || '');
  render();
}

function selectModel(id) {
  state.selectedModel = id;
  lsSet('agentgui.model', id);
  render();
}

function agentById(id) { return state.agents.find(a => a.id === id); }
function agentAvailable(id) { const a = agentById(id); return !a || a.available !== false; }

// The four flagship orchestration targets surface first, then other available
// agents, then npx-installable, then not-installed - so the agents the GUI
// exists to drive are reachable without scanning a flat 17-item list. This
// ordering is agentgui's orchestration priority, so it stays in the host and is
// passed pre-sorted to the (app-agnostic) AgentChat kit.
// Protocol ids are plumbing vocabulary; rows speak product words.
const PROTOCOL_WORDS = { acp: 'managed server', cli: 'local CLI', direct: 'local CLI' };
const PRIMARY_AGENTS = ['claude-code', 'opencode', 'kilo', 'agy'];
// Memoized: recomputed only when state.agents changes (in loadAgents), not on
// every chatMain() render. Stored in state.sortedAgentsCache.
function computeSortedAgents() {
  const rank = (a) => {
    const primary = PRIMARY_AGENTS.indexOf(a.id);
    const avail = a.available !== false;
    if (primary !== -1 && avail) return primary;
    if (avail) return 10;
    if (a.npxInstallable) return 20;
    return 30;
  };
  return state.agents
    .map(a => ({ a, rank: rank(a) }))
    .sort((x, y) => x.rank - y.rank || x.a.name.localeCompare(y.a.name))
    .map(({ a }) => a);
}
function sortedAgents() { return state.sortedAgentsCache || (state.sortedAgentsCache = computeSortedAgents()); }

function navTo(tab, { writeHash: doWriteHash = true, push = true } = {}) {
  const prev = state.tab;
  // Leaving chat clears any pending new-chat confirmation so it doesn't linger
  // as a stale banner when the user returns.
  if (prev === 'chat' && tab !== 'chat') state.confirmingNewChat = false;
  if (prev !== tab) state.confirmingClearData = false;
  state.confirmingBackend = undefined;
  state.tab = tab;
  // Live history SSE feeds both the History tab (event log) and the Live
  // dashboard (per-session activity tally + stream-health signal); open it on
  // either, close it when leaving both. Active-chat polling runs globally.
  // The chat tab keeps the stream too while a chat is busy or sessions are in
  // flight, so the rail's counters/timestamps don't freeze on the very tab
  // where the streaming happens.
  // Any session in flight keeps the stream open regardless of tab - otherwise
  // the Live nav-badge's error "flame" can go stale (freeze red) while the user
  // sits on Files/Settings with no live feed refreshing the underlying signal.
  const wantsStream = (t) => t === 'history' || t === 'live'
    || (t === 'chat' && state.chat.busy)
    || (Array.isArray(state.active) && state.active.length > 0);
  if (wantsStream(tab)) {
    if (tab === 'history' && (!state._historyLoadedOnce || Date.now() - (state._historyLoadedAt || 0) > 5000)) refreshHistory();
    openLiveStream();
  } else if (wantsStream(prev)) {
    closeLiveStream();
  }
  // The conversation column now lives on the chat tab too, so populate the
  // session list when entering chat if it hasn't been loaded yet (it used to
  // load only on a History visit, leaving the rail empty on a fresh chat).
  if (tab === 'chat' && !state.sessions.length && !state.historyError) refreshHistory();
  // Kick the first directory load on entering Files HERE (an effect), not inside
  // filesMain (which runs during render) - a render-time fetch is fragile under
  // a double-render and re-enters render() while building the tree.
  if (tab === 'files' && !state.files.path && !state.files.loading && !state.files.error) loadDir('');
  // Chat's @-mention autocomplete (mentionFiles) reuses state.files.entries -
  // seed it from the root listing on first chat visit so mentions work
  // without requiring a prior Files-tab visit. Uses the same confined
  // B.listDir the Files tab itself calls; failure is silent (mentionFiles
  // just stays empty, same as never having visited Files).
  if (tab === 'chat' && !state.files.entries.length && !state.files.loading && !state.files.error) {
    B.listDir(state.backend, '').then((j) => {
      if (!state.files.entries.length) state.files.entries = j.entries || [];
      if (!state.files.roots.length) state.files.roots = j.roots || [];
      render();
    }).catch(() => {});
  }
  // Models tab: composed agent/provider availability, fetched on first visit
  // (and via the ModelsConfig 'refresh' action thereafter).
  if (tab === 'models' && !state.models.data && !state.models.loading && !state.models.error) loadModelsAvailability();
  // Plugins tab reuses state.agents (agents.list) - same lazy load as chat's
  // agent picker, so visiting Plugins directly (deep-link/reload) still works.
  if (tab === 'plugins' && !state.agents.length && !state.agentsLoading && !state.agentsError) loadAgents();
  // popstate calls navTo with writeHash:false so it never replaceState-clobbers
  // the entry it popped; user-initiated navigation pushes so Back walks tabs.
  if (doWriteHash) writeHash({ push });
  announce('now on ' + tab + ' tab');
  render();
  // Move focus into the new region for keyboard/AT users.
  requestAnimationFrame(() => {
    syncAriaCurrent();
    const region = document.querySelector('#agentgui-main');
    if (!region) return;
    const heading = region.querySelector('h1, h2');
    const target = heading || region;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    // Mark as programmatically focused so CSS can suppress the focus ring - we
    // move focus here for AT, but a visible green outline box around the heading
    // reads as an accidental border to sighted users.
    target.setAttribute('data-prog-focus', '');
    try { target.focus({ preventScroll: true }); } catch {}
    const clear = () => { target.removeAttribute('data-prog-focus'); target.removeEventListener('blur', clear); };
    target.addEventListener('blur', clear);
  });
}

// The DS Topbar derives aria-current from href<->location.hash matching, which
// drifts from our hash-based active tab (e.g. aria-current lands on "settings"
// while we're on "chat"). Re-assert aria-current on the actually-active tab.
function syncAriaCurrent() {
  const links = document.querySelectorAll('.app-topbar nav a');
  links.forEach((a) => {
    const isActive = a.classList.contains('active');
    if (isActive) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  });
}

// A cheap signature of the active-chats list so an unchanged 3s poll does not
// trigger a full ConversationList + dashboard rebuild every tick (the rail
// re-renders every row on each render). Only re-render when the set actually
// changed (or while on the live tab, where elapsed advances every second).
function activeSig(list) {
  // claudeSessionId arrives mid-turn (streaming_session) - it must be part of
  // the signature so the rail/dashboard re-render when the real sid lands.
  return (Array.isArray(list) ? list : []).map(a => a.sessionId + ':' + (a.claudeSessionId || '') + ':' + (a.model || '') + ':' + (a.startedAt || '')).sort().join('|');
}
async function refreshActive() {
  // A backgrounded tab still holds its interval timer, but polling every ~3.3s
  // while hidden is needless server load across many left-open tabs - skip the
  // network call (and let the next visible tick catch up). Mark the currently
  // held state.active as stale so a refocus render doesn't silently paint
  // minutes-old data as fresh while the re-poll is still in flight.
  if (typeof document !== 'undefined' && document.hidden) { state._activeStale = true; return; }
  let next;
  try { next = await B.listActiveChats(state.backend); } catch { return; }
  state._activeStale = false;
  const changed = activeSig(next) !== activeSig(state.active);
  state.active = next;
  if (changed) state._sessionGroupsCache = null;
  // A stopping sid that left the active set has genuinely stopped - clear it
  // so the per-card 'stopping' state resolves.
  const st = state.live.stopping;
  if (st && st.size) {
    const present = new Set(next.map(a => a.sessionId));
    for (const sid of [...st]) if (!present.has(sid)) st.delete(sid);
  }
  // The live tab needs the steady elapsed tick regardless; elsewhere only
  // re-render when the active set genuinely changed.
  if (changed || state.tab === 'live') render();
}
function startActivePolling() {
  if (state.activeTimer) return;
  refreshActive();
  // Small jitter so many tabs don't hit the server in lockstep.
  state.activeTimer = setInterval(refreshActive, 3000 + Math.floor(Math.random() * 600));
  if (!state._visActiveBound && typeof document !== 'undefined') {
    state._visActiveBound = true;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        refreshActive();
        // Two GUI tabs on the Live view can silently diverge on sort/filter -
        // re-read the shared prefs key on refocus so a change made in another
        // tab is reconciled instead of staying invisible until a hard reload.
        hydratePrefs();
        render();
      }
    });
  }
}
function stopActivePolling() {
  if (state.activeTimer) { clearInterval(state.activeTimer); state.activeTimer = null; }
}

// Re-render once a minute so relative timestamps ("5s ago") don't sit frozen
// between events. Cheap: scheduleRender coalesces via rAF.
let _relTick = null;
function startRelTimeTick() { if (!_relTick) _relTick = setInterval(() => { if (state.tab === 'history' || (Array.isArray(state.active) && state.active.length)) scheduleRender(); }, 30000); }
// The live dashboard's per-card elapsed must advance every second, not in 3s
// poll-sized jumps - a frozen counter reads as a stalled session. A dedicated
// 1s tick runs ONLY while the live tab is showing running sessions, so it costs
// nothing on other tabs (and stops when there's nothing in flight).
let _liveTick = null;
function startLiveTick() {
  if (_liveTick) return;
  _liveTick = setInterval(() => {
    if (state.tab === 'live' && Array.isArray(state.active) && state.active.length) {
      scheduleRender();
    } else if (state.tab !== 'live' && !(Array.isArray(state.active) && state.active.length)) {
      clearInterval(_liveTick); _liveTick = null;
    }
  }, 1000);
}
async function stopActiveChat(sid) {
  const st = state.live.stopping = state.live.stopping || new Set();
  if (st.has(sid)) return;   // re-entry guard: one cancel per sid in flight
  st.add(sid);
  render();
  try {
    await B.cancelChat(state.backend, sid);
  } catch {
    st.delete(sid);
    state.live.bulkStopError = 'conversation did not stop - try again';
    announce('stop failed');
    render();
    return;
  }
  // Optimistically drop the row so the card doesn't read 'running' for up to
  // 3s after the click; the immediate refresh confirms.
  state.active = (Array.isArray(state.active) ? state.active : []).filter(a => a.sessionId !== sid);
  await refreshActive();
  render();
  // The backend accepted the cancel, but the underlying process can outlive
  // this immediate refresh - if it's still showing active after a bounded
  // wait, stop treating it as en-route-to-stopped: clear `stopping` (or the
  // row wedges permanently disabled) and surface the same retry banner used
  // on an outright rejection.
  setTimeout(() => {
    const st2 = state.live.stopping;
    const stillActive = Array.isArray(state.active) && state.active.some(a => a.sessionId === sid);
    if (st2 && st2.has(sid) && stillActive) {
      st2.delete(sid);
      state.live.bulkStopError = 'conversation did not stop - try again';
      announce('stop failed');
      render();
    }
  }, 9000);
}

function openLiveStream() {
  if (state.live.es) return;
  state.live.error = null;
  state.live.connected = false;
  try {
    state.live.es = B.streamHistory(state.backend, (kind, data) => {
      state.live.lastEventTs = Date.now();
      // Only real event frames count - hello/error frames inflated the number.
      if (kind === 'event') state.live.eventCount++;
      if (kind === 'hello') {
        if (!state.live.connected) state.live.connected = true;
        if (state.live.error) {
          state.live.error = null; state.live.reconnects++;
          // After a disconnect there is no way to know what was missed or
          // replayed: re-baseline. Drop the tally (the index owns truth) and
          // refetch the session list so counters never double-count a replay.
          if (state.live.tally) state.live.tally.clear();
          // A cleared tally momentarily loses the per-sid running-tool/recency
          // signal until the re-fetched index catches up - without a grace
          // window a running session can flap to 'stale' for one tick right
          // after reconnect. Suppress the stale demotion for a few seconds.
          state.live.reconnectGraceUntil = Date.now() + 5000;
          debouncedRefreshHistory();
        }
      } else if (kind === 'event' && data) {
        // ccsniff's stream frame is { sid, payload: <flattened event> } - the
        // real event (type/isError/i/ts) lives under .payload, not on the
        // wrapper. Reading the wrapper gave every counter `undefined`, so live
        // tool/error tallies never moved. Route by data.sid, read ev for the rest.
        const ev = data.payload || data;
        // Estimate server-vs-client clock skew once from the first near-realtime
        // event; staleness comparisons apply it so pure skew never reads stale.
        if (state.live.clockSkew == null && ev.ts) state.live.clockSkew = Date.now() - ev.ts;
        if (state.selectedSid && data.sid === state.selectedSid) {
          // Dedupe against the snapshot/prior pushes by event index - a
          // reconnect or overlap would otherwise double-append the same event.
          if (!state.events._seen) state.events._seen = new Set();
          if (ev.i == null || !state.events._seen.has(ev.i)) {
            if (ev.i != null) {
              state.events._seen.add(ev.i);
              // Cap the seen-set so a very long session doesn't grow unbounded.
              if (state.events._seen.size > 5000) state.events._seen = new Set([...state.events._seen].slice(-2500));
            }
            ev._idx = state.events.length;
            state.events.push(ev);
            // Cap retained events so a long live session can't grow unbounded.
            if (state.events.length > 2000) state.events.splice(0, state.events.length - 2000);
          }
        }
        // Per-sid live tally, kept independent of the history index so a
        // brand-new chat (not yet in sessionsBySid) STILL shows motion on the
        // dashboard. Keyed by sid; the dashboard reads this when no history row
        // exists yet.
        if (data.sid) {
          state.live.tally = state.live.tally || new Map();
          const t = state.live.tally.get(data.sid) || { events: 0, tools: 0, errors: 0, last: 0, maxI: null, toolRunning: false, toolName: '', lastErrorTs: 0 };
          // Dedupe by event index: a reconnect replay/overlap re-delivers the
          // same events and would double-count tools/errors otherwise.
          const dup = ev.i != null && t.maxI != null && ev.i <= t.maxI;
          if (!dup) {
            if (ev.i != null) t.maxI = ev.i;
            t.events++; t.last = ev.ts || Date.now();
            // Per-sid running-tool truth: an unresolved tool_use means this
            // session is busy-with-tool, not stalled - for EVERY session, not
            // only the one resumed in the in-page chat.
            if (ev.type === 'tool_use') { t.tools++; t.toolRunning = true; t.toolName = ev.tool || ev.name || ''; }
            if (ev.type === 'tool_result') { t.toolRunning = false; t.toolName = ''; }
            if (ev.type === 'result' && ev.usage) { t.tokens = (t.tokens || 0) + (ev.usage.input_tokens || 0) + (ev.usage.output_tokens || 0); }
            if (ev.type === 'result' && typeof ev.total_cost_usd === 'number') { t.cost = (t.cost || 0) + ev.total_cost_usd; }
            if (ev.isError) { t.errors++; t.lastErrorTs = t.last; }
          }
          state.live.tally.set(data.sid, t);
        }
        const sess = state.sessionsBySid ? state.sessionsBySid.get(data.sid) : null;
        if (sess) {
          const dupS = ev.i != null && sess._maxI != null && ev.i <= sess._maxI;
          if (!dupS) {
            if (ev.i != null) sess._maxI = ev.i;
            sess.events = (sess.events || 0) + 1;
            sess.last = ev.ts || Date.now();
            if (ev.type === 'tool_use') sess.tools = (sess.tools || 0) + 1;
            if (ev.isError) { sess.errors = (sess.errors || 0) + 1; sess.lastErrorTs = sess.last; }
          }
        } else {
          // Unknown session: a burst of events for a new session would trigger
          // a full session-list refetch per event - debounce it into one. The
          // tally above already captured the motion, so the card is not frozen.
          debouncedRefreshHistory();
          scheduleRender();
          return;
        }
      } else if (kind === 'conversation') {
        debouncedRefreshHistory();
        return;
      } else if (kind === 'error' && data) {
        state.live.error = data.error || 'stream error';
      }
      scheduleRender();
    });
    state.live.es.addEventListener('error', () => {
      // EventSource auto-reconnects; only flap state once per disconnect.
      if (!state.live.error) {
        state.live.connected = false;
        state.live.error = 'connection lost (auto-retry)';
        scheduleRender();
      }
    });
  } catch (e) {
    state.live.error = e.message;
    state.live.es = null;
  }
}

function closeLiveStream() {
  if (!state.live.es) return;
  try { state.live.es.close(); } catch {}
  state.live.es = null;
  state.live.connected = false;
}

// ONE shortcuts definition consumed by BOTH the ?-overlay and the settings
// keyboard panel, so the two surfaces cannot drift from the keydown handler
// below (which implements exactly these: g+c/h/f/l/s, n, /, ?, Esc).
const SHORTCUTS = [
  { keys: 'g then c / h / f / l / s', desc: 'switch tabs (chat / history / files / live / settings)' },
  { keys: 'n', desc: 'new chat (on the chat tab)' },
  { keys: '/', desc: 'focus search / filter / composer' },
  { keys: 'Ctrl/Cmd+Shift+L', desc: 'focus the composer from anywhere' },
  { keys: 'Enter / Shift+Enter', desc: 'send / new line (in the composer)' },
  { keys: '?', desc: 'show shortcuts' },
  { keys: 'Esc', desc: 'close overlays, cancel confirms, stop generation, or blur the field' },
  { keys: 'Up / Down / Home / End', desc: 'move the focused file row (files grid)' },
  { keys: 'Enter / Backspace', desc: 'open the focused file / go up a directory (files grid)' },
  { keys: 'Ctrl/Cmd+A', desc: 'select all shown files (files grid); Shift+click selects a range' },
  { keys: 'Left / Right', desc: 'previous / next file (file preview)' },
];

function view() {
  const ok = state.health.status === 'ok';
  // history/live both read the SSE stream, not the REST health poll - a tab
  // that shows its own "connecting to live stream" widget must agree with the
  // header badge, since they are the same underlying connection. Showing the
  // REST-derived "connected" here while the tab's own widget says otherwise
  // is exactly the mismatch this guards against.
  const streamTab = state.tab === 'history' || state.tab === 'live';
  const liveActive = streamTab && state.live.connected && (Date.now() - state.live.lastEventTs < 30000);
  const dotLabel = streamTab
    ? (state.live.error
        ? 'stream: ' + state.live.error + (state.live.reconnects ? ' · ' + state.live.reconnects + ' reconnects' : '')
        : (liveActive ? 'stream: live · ' + state.live.eventCount : (state.live.connected ? 'stream: live' : 'stream: connecting…')))
    : (ok ? (state.health.ws === 'reconnecting' ? 'connecting…' : 'connected') : 'offline');
  const dotLive = streamTab ? (liveActive || state.live.connected) : ok;
  // The status dot is drawn entirely by CSS (.status-dot::before) - a small
  // colored disc, real product design, not a text glyph. State drives its colour
  // via the modifier class; the label carries only words so AT reads "live", and
  // there are no literal status-glyph characters in the DOM.
  // The disc carries the KIT modifier class directly (status-dot-live pulses,
  // -connecting / -error are static) - one canonical disc, no app override.
  const discClass = (state.live.error || !dotLive) ? 'status-dot-error'
    : (dotLive && state.tab !== 'history' && state.health.ws === 'reconnecting' ? 'status-dot-connecting' : 'status-dot-live');
  // Only announce status changes to AT (not every render) to avoid spamming.
  if (dotLabel !== lastAnnouncedStatus) { lastAnnouncedStatus = dotLabel; }
  const dot = h('span', { key: 'dot', class: 'status-dot' },
    h('span', { key: 'dd', class: 'status-dot-disc ' + discClass, 'aria-hidden': 'true' }),
    h('span', { key: 'dl', 'aria-live': 'off' }, dotLabel));

  // Give the crumb contextual content on the left so it isn't a bare bar holding
  // only the dot: on history/chat it names the selected session/agent, on files
  // the current dir, on live the live count, on settings "configuration".
  let crumbLeaf = '';
  let crumbTrail = [];
  if (state.tab === 'history') {
    const sel = state.selectedSid && (Array.isArray(state.sessions) ? state.sessions : []).find(s => s.sid === state.selectedSid);
    crumbLeaf = state.selectedSid
      ? truncate(projectLabel(sel?.title) || projectLabel(sel?.project) || state.selectedSid, 24, 48)
      : 'all sessions';
  } else if (state.tab === 'chat') {
    // A resumed conversation loses the agent picker's own visual weight (it
    // collapses to two small <select>s once turns exist) - the only other
    // place the bound agent showed was this same tiny crumb text, easy to
    // miss. Render it as a real badge on resumed threads so "which agent is
    // this" reads as a persistent, visible indicator, not header trivia.
    const chatAgentName = state.selectedAgent ? (agentById(state.selectedAgent)?.name || state.selectedAgent) : null;
    crumbLeaf = chatAgentName
      ? (state.chat.resumeSid ? Badge({ children: 'agent: ' + chatAgentName, tone: 'neutral' }) : chatAgentName)
      : 'no agent';
  } else if (state.tab === 'files') {
    // ONE breadcrumb owner: the in-page BreadcrumbPath is the interactive
    // navigator, so the top crumb names only the tab (mirroring live/settings).
    // Duplicating the full path in both bars read as a layout mistake.
    crumbLeaf = 'files';
  } else if (state.tab === 'live') {
    crumbLeaf = 'live · ' + ((state.active && state.active.length) || 0);
  } else if (state.tab === 'git') {
    crumbLeaf = 'git';
  } else if (state.tab === 'settings') {
    // Same word as the rail item - location chrome must not fork vocabulary.
    crumbLeaf = 'settings';
  } else if (state.tab === 'models') {
    crumbLeaf = 'models';
  } else if (state.tab === 'plugins') {
    crumbLeaf = 'plugins';
  }
  const crumb = Crumb({ trail: crumbTrail, leaf: crumbLeaf, right: [dot] });

  const agentLabel = state.selectedAgent
    ? 'agent: ' + (agentById(state.selectedAgent)?.name || state.selectedAgent) + (state.selectedModel ? ' · ' + state.selectedModel : '')
    : 'no agent';
  // The default (same-origin) backend is implementation detail, not status -
  // the footer names a backend only when the user pointed at a custom one.
  // On history/live, the persistent footer chip must agree with the crumb dot
  // and the tab's own stream widget - reporting REST-health "connected" here
  // while the Live tab's widget says "connecting to live stream" indefinitely
  // is the exact contradiction users can't resolve into a real signal.
  const footerConnLabel = streamTab ? (dotLive ? 'connected' : 'connecting…') : (ok ? 'connected' : 'offline');
  const status = Status({
    left: [state.backend || null, footerConnLabel].filter(Boolean),
    right: [agentLabel, 'press ? for shortcuts'],
  });

  const shortcutsHint = state.showShortcuts
    ? h('div', { key: 'sc', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Keyboard shortcuts', class: 'ds-alert ds-alert--info shortcuts-dialog' },
        FocusTrap({ children: [
          h('div', { key: 'sc-head', class: 'ds-alert-head' },
            h('span', { key: 'sc-title', class: 'ds-alert-title' }, 'Keyboard shortcuts'),
            h('button', { key: 'sc-close', type: 'button', class: 'ds-btn', 'aria-label': 'Close keyboard shortcuts', onClick: () => { state.showShortcuts = false; render(); announce('shortcuts closed'); } }, 'close')),
          h('div', { key: 'sc-body', class: 'ds-alert-body' }, ShortcutList({ shortcuts: SHORTCUTS })),
        ] }))
    : null;
  // One-time welcome naming what each tab is for - a brand-new user's only
  // other guidance is installHint (zero-agents case) or the calm chat empty
  // state (agents-but-no-conversation case); neither explains History/Files/
  // Live exist at all. Dismissed once, ever, via localStorage.
  const onboardingBanner = state.showOnboarding
    ? Alert({
        key: 'onboarding', kind: 'info', title: 'Welcome to AgentGUI',
        onDismiss: dismissOnboarding,
        children: 'Chat with an agent here. History holds every past conversation, Files browses and edits project directories, Live shows every running session at once, and Settings covers connection, appearance, and keyboard shortcuts.',
      })
    : null;
  const main = h('div', { id: 'agentgui-main', role: 'region', 'aria-label': 'main content', 'data-chat-scroll': '', class: 'agentgui-main agentgui-main-' + state.tab }, [shortcutsHint, onboardingBanner, ...mainContent()].filter(Boolean));

  // Claude-Desktop three-column shell: a persistent left rail (workspace nav), an
  // optional sessions column (chat + history share the conversation list), the
  // main content, and an optional right context pane. The rail replaces the old
  // Topbar tabs; it collapses to icon-only and, on mobile, behind its own toggle.
  const rail = workspaceRail();
  const sessions = (state.tab === 'chat' || state.tab === 'history' || state.tab === 'live') ? sessionsColumn() : null;
  // Right context pane. On chat it carries agent/model/cwd + the live running-tool
  // count + last-turn usage. On files it hosts the inline file preview (split view).
  // On other tabs it is null but the shell keeps the column TRACK (stableFrame) so
  // the geometry does not re-flow on tab switch (the "separate pages" tell).
  let pane = null;
  if (state.tab === 'chat') {
    pane = ContextPane({
      agent: state.selectedAgent ? (agentById(state.selectedAgent)?.name || state.selectedAgent) : '',
      model: state.selectedModel || '',
      cwd: state.chatCwd || '',
      toolCount: runningToolCount(),
      usage: state.chat.usage || null,
      session: {
        turns: state.chat.messages.filter(m => m.role === 'user').length,
        cost: state.chat.totalCost || null,
      },
      recentFiles: recentSessionFiles(),
      onOpenFile: (path) => {
        const base = pathBasename(path);
        const dir = base === path ? '' : path.slice(0, path.length - base.length - 1);
        navTo('files');
        loadDir(dir);
      },
      // One affordance per action: the cwd row opens the SAME inline editor as
      // the composer context line (it validates via /api/stat) instead of
      // navigating away to the Files tab.
      onSetCwd: () => { state.cwdEditing = true; state.cwdDraft = state.chatCwd || ''; state.cwdError = null; render(); requestAnimationFrame(() => { const inp = document.querySelector('.agentchat-cwd-input'); if (inp) inp.focus(); }); },
    });
  } else if (state.tab === 'files' && state.files && state.files.preview && !isNarrow()) {
    pane = filePreviewPane();
  }
  // The chat tab manages its own --measure gutter, so it opts out of the content
  // column padding; every other surface (files/live/history/settings) keeps it.
  return WorkspaceShell({ rail, sessions, main, pane, crumb, status, narrow: isNarrow(), stableFrame: true, mainFlush: state.tab === 'chat' });
}

// The left workspace rail: brand, New chat action, and the primary view nav.
function workspaceRail() {
  // Same owned+external session set the Live dashboard renders, so the nav
  // badge count and error tone never diverge from what the dashboard shows.
  const liveSessions = computeLiveSessions();
  const liveCount = liveSessions.length;
  const liveHasError = liveSessions.some((s) => s.status === 'error');
  // Show a live pulse on the chat rail item when a stream is in progress but the
  // user has navigated to a different tab - so the background stream stays visible.
  const chatStreaming = state.chat.busy && state.tab !== 'chat';
  const items = [
    { key: 'chat', label: 'Chat', icon: 'forum', active: state.tab === 'chat', count: chatStreaming ? 1 : null, onClick: () => navTo('chat') },
    { key: 'history', label: 'History', icon: 'thread', active: state.tab === 'history', onClick: () => navTo('history') },
    { key: 'files', label: 'Files', icon: 'folder', active: state.tab === 'files', onClick: () => navTo('files') },
    { key: 'live', label: 'Live', icon: 'activity', active: state.tab === 'live', count: liveCount || null, rail: liveHasError ? 'flame' : undefined, onClick: () => navTo('live') },
    { key: 'git', label: 'Git', icon: 'branch', active: state.tab === 'git', onClick: () => navTo('git') },
    { key: 'models', label: 'Models', icon: 'circle-dot', active: state.tab === 'models', onClick: () => navTo('models') },
    { key: 'plugins', label: 'Plugins', icon: 'link', active: state.tab === 'plugins', onClick: () => navTo('plugins') },
    { key: 'settings', label: 'Settings', icon: 'settings', active: state.tab === 'settings', onClick: () => navTo('settings') },
  ];
  return WorkspaceRail({
    brand: 'agentgui',
    action: { label: 'New chat', icon: 'pencil', onClick: () => { navTo('chat'); newChat(); } },
    items,
    // W18: a persistent theme toggle pinned to the rail bottom (the Claude-Desktop
    // / cowork pinned-bottom affordance). A shortcuts-help icon sits alongside it -
    // the '?' overlay (state.showShortcuts) was previously 100% keyboard-only
    // tribal knowledge with zero visible entry point outside Settings.
    footer: [
      h('span', { key: 'rail-help' }, IconButton({ icon: 'help', title: 'Keyboard shortcuts', onClick: () => { state.showShortcuts = true; render(); } })),
      h('span', { key: 'rail-theme' }, ThemeToggle({ compact: true })),
    ],
  });
}

// Bucket a session's last-active timestamp into a Claude-Desktop-style date
// group label (Today / Yesterday / This week / Earlier). Pure date math against
// local midnight so the labels match the user's calendar, not a rolling 24h.
function dateGroupLabel(ts) {
  if (!ts) return 'Earlier';
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const d = ts;
  if (d >= startOfToday) return 'Today';
  if (d >= startOfToday - 86400000) return 'Yesterday';
  if (d >= startOfToday - 7 * 86400000) return 'This week';
  return 'Earlier';
}
const DATE_GROUP_ORDER = ['Running', 'Today', 'Yesterday', 'This week', 'Earlier'];

// Build the kit ConversationList `groups` from the visible sessions: running
// chats are pinned to a "Running" section at the top (a live workspace surfaces
// in-flight work first), the rest bucket by recency. Returns { items, groups }.
function sessionGroups(sessionsView) {
  // Cache key: sessions + active combo (both affect group membership).
  const key = sessionsView.map(s => s.sid).join(',') + '|' + (Array.isArray(state.active) ? state.active : []).map(a => a.claudeSessionId || a.sessionId).join(',');
  if (state._sessionGroupsCache && state._sessionGroupsCacheKey === key) return state._sessionGroupsCache;
  // Join on the REAL claude/ccsniff sid when known (chat.active rows carry the
  // ephemeral chat- id; claudeSessionId lands once streaming_session arrives).
  const runningSids = new Set((Array.isArray(state.active) ? state.active : []).map(a => a.claudeSessionId || a.sessionId));
  const buckets = new Map();
  for (const s of sessionsView) {
    const label = runningSids.has(s.sid) ? 'Running' : dateGroupLabel(s.last);
    if (!buckets.has(label)) buckets.set(label, []);
    buckets.get(label).push(s.sid);
  }
  const groups = DATE_GROUP_ORDER
    .filter(l => buckets.has(l))
    .map(l => ({ label: l, sids: buckets.get(l) }));
  state._sessionGroupsCacheKey = key;
  state._sessionGroupsCache = groups;
  return groups;
}

// Tool errors are routine in agent transcripts (every failed command counts),
// so "has any error" is not a signal - it painted every real session flame.
// A session reads as errored only when failures DOMINATE it: several errors
// AND a meaningful share of all its events.
function sessionErrorDense(s) {
  const errors = Number(s?.errors) || 0;
  const events = Number(s?.events) || 0;
  return errors >= 3 && errors / Math.max(events, 1) > 0.15;
}

// The sessions column (conversation list) shared by chat + history. Selecting a
// row on the chat tab resumes it in chat; on the history tab it loads its events.
function sessionsColumn() {
  // When a search is active (>=2 chars with hits), the rail shows the search
  // results instead of the time-sorted session list - on BOTH tabs, so chat-tab
  // search is no longer a dead control that runs a query nothing displays.
  const searching = !!(state.searchHits && state.searchQ.trim().length >= 2);
  if (searching) {
    const hits = (state.searchHits.results || []).slice(0, state.sessionsLimit);
    const items = hits.map((r, i) => ({
      sid: r.sid,
      title: r.snippet || projectLabel(r.title) || projectLabel(r.project) || UNTITLED_CONVERSATION,
      project: projectLabel(r.project) || '',
      time: r.ts ? fmtRelTime(r.ts) : '',
      running: false,
      unread: false,
      rail: r.isError ? 'flame' : (r.isSubagent ? 'purple' : 'green'),
      _focusEventI: r.i, _focusEventTs: r.ts,
    }));
    const list = ConversationList({
      sessions: items,
      selected: state.selectedSid,
      // Search runs across every project (runSearch() clears projectFilter so
      // it doesn't silently re-narrow later) - say so, since that reset is
      // otherwise invisible and would surprise the user when they clear the
      // search and the session list is unexpectedly wider than before.
      caption: 'Searching across all projects',
      search: {
        value: state.searchQ,
        placeholder: 'Search all conversations - titles + messages (2+ chars)',
        onInput: (v) => { state.searchQ = v; if (v.trim().length >= 2) debouncedSearch(); else { state.searchHits = null; } render(); },
      },
      resultCount: state.searchBusy ? null : (hits.length + ' result' + (hits.length === 1 ? '' : 's')),
      onNew: () => { navTo('chat'); newChat(); },
      onSelect: (s) => {
        if (state.tab === 'chat') resumeInChat({ sid: s.sid });
        else {
          // Persist the anchor so buildHash() can carry it into the URL -
          // without this, reload/Back only ever restored the bare session,
          // losing the matched event's scroll+flash position.
          state._focusEventTs = s._focusEventTs ?? null;
          loadSession(s.sid, { focusEventI: s._focusEventI, focusEventTs: s._focusEventTs });
          writeHash({ push: true });
        }
      },
      loading: state.searchBusy,
      error: state.searchHits.error || null,
      emptyText: 'No matches for "' + state.searchQ + '"',
      hasMore: (state.searchHits.results || []).length > state.sessionsLimit,
      onLoadMore: () => { state.sessionsLimit += 60; render(); },
    });
    // Only per-session event JSON / full transcript export existed - the
    // search RESULTS themselves (title, project, snippet, timestamp) had no
    // export path. Rendered as a plain sibling OUTSIDE ConversationList
    // (not threaded through any of its props) - a prior attempt passing a
    // VElement/extra prop through the caption slot triggered a real,
    // intermittent webjsx crash inside that shared component; a fully
    // separate wrapper keeps this feature from touching that risk surface.
    if (!hits.length) return list;
    return h('div', { key: 'searchwrap', class: 'agentgui-search-rail-wrap' },
      h('div', { key: 'searchexportrow', class: 'agentgui-search-export-row' },
        Btn({ key: 'searchexport', onClick: () => downloadBlob(JSON.stringify(hits, null, 2), 'agentgui-search-' + (state.searchQ || 'results').replace(/[^a-z0-9-]+/gi, '-') + '-' + dateStamp() + '.json', 'application/json'), children: 'export ' + hits.length + ' result' + (hits.length === 1 ? '' : 's') })),
      list);
  }
  const sessionsView = visibleSessions();
  const sliced = sessionsView.slice(0, state.sessionsLimit);
  const runningSids = new Set((Array.isArray(state.active) ? state.active : []).map(a => a.claudeSessionId || a.sessionId));
  // Same status computation the Live tab uses (running/stale/error), keyed by
  // realSid, so a session pinned to the rail's "Running" group shows whether it
  // is actually stuck vs busy instead of just a plain live dot.
  const liveStatusBySid = new Map(computeLiveSessions().map((s) => [s.realSid, s.status]));
  const items = sliced.map((s) => {
    const title = projectLabel(s.title) || projectLabel(s.project) || s.sid;
    const project = projectLabel(s.project) || '';
    return {
      sid: s.sid,
      title,
      // title==project would print the same word twice in one row; the sub then
      // carries only the time (and agent when present).
      project: project === title ? '' : project,
      time: fmtRelTime(s.last),
      // ccsniff only reads Claude Code's own JSONL (see AGENTS.md), so the
      // agent is always claude-code; ccsniff's sessions() now also folds in
      // the session's most-recent model - surfacing both here matches the
      // badge the running-panel/live-dashboard rows already show for the
      // identical session while it's in-flight, instead of going blank the
      // moment it finishes and drops into History.
      agent: (agentById('claude-code')?.name || 'Claude Code') + (s.model ? ' · ' + s.model : ''),
      running: runningSids.has(s.sid),
      status: runningSids.has(s.sid) ? liveStatusBySid.get(s.sid) : undefined,
      unread: false,
      // Tool errors are NORMAL in agent sessions (a failed Bash call counts) -
      // flame-on-any-error painted every real session red. Flame only when
      // failures dominate the session (error-dense), the recency-not-cumulative
      // rule the live tab already follows.
      rail: sessionErrorDense(s) ? 'flame' : (s.isSubagent ? 'purple' : 'green'),
    };
  });
  return ConversationList({
    sessions: items,
    // Per-tab caption: selecting a row does different things on chat vs history,
    // so disambiguate the visually-identical rows (W17).
    caption: state.tab === 'chat' ? 'Resume a conversation in chat' : 'Browse a conversation\'s events',
    // Today/Yesterday/This-week + a pinned Running section, the Claude-Desktop
    // Chats shape. Groups reference sids the kit maps back to the items above.
    groups: sessionGroups(sliced),
    selected: state.selectedSid,
    search: {
      value: state.searchQ,
      placeholder: 'Search all conversations - titles + messages',
      onInput: (v) => { state.searchQ = v; if (v.trim().length >= 2) debouncedSearch(); else { state.searchHits = null; } render(); },
    },
    onNew: () => { navTo('chat'); newChat(); },
    // On files/live/settings the rail still renders (keepSessionsTrack) and is
    // captioned 'Browse a conversation's events', but loadSession() alone only
    // populates state - nothing on those tabs renders events, so the click had
    // zero visible effect. Land on history first so the caption's promise
    // (browsing events) is kept from every tab the rail appears on.
    onSelect: (s) => {
      if (state.tab === 'chat') { resumeInChat({ sid: s.sid }); return; }
      if (state.tab !== 'history') navTo('history', { writeHash: false });
      loadSession(s.sid);
    },
    loading: !state.sessions.length && !state.historyError,
    loadingText: state.historySlow ? 'Indexing your Claude history — the first load can take a minute…' : undefined,
    error: state.historyError,
    emptyText: 'No conversations yet - start one from Chat',
    hasMore: sessionsView.length > state.sessionsLimit,
    onLoadMore: () => { state.sessionsLimit += 60; render(); },
  });
}

function mainContent() {
  if (state.tab === 'chat')    return chatMain();
  if (state.tab === 'history') return historyMain();
  if (state.tab === 'files')   return filesMain();
  if (state.tab === 'live')    return liveMain();
  if (state.tab === 'git')     return gitMain();
  if (state.tab === 'models')  return modelsMain();
  if (state.tab === 'plugins') return pluginsMain();
  return settingsMain();
}

// --- git (status/diff/log + worktree list) ---
// Uses anentrypoint-design's GitStatusPanel/GitDiffView/WorktreeSwitcher
// (ported from pi-web's BranchNavigator concept) once the vendored SDK
// bundle carries them - see components.js barrel export.
async function loadGitPanel() {
  state.git.loading = true; state.git.error = null; render();
  try {
    const [files, commits, worktrees] = await Promise.all([
      B.gitStatus(state.backend, {}),
      B.gitLog(state.backend, { limit: 20 }),
      B.worktreeList(state.backend, {}),
    ]);
    state.git.files = files;
    state.git.commits = commits;
    state.git.worktrees = worktrees;
  } catch (e) {
    state.git.error = e.message || 'Could not load git status.';
  }
  state.git.loading = false; render();
}

async function loadGitDiff(file) {
  state.git.diffLoading = true; state.git.diffError = null; render();
  try {
    const { diff, binary } = await B.gitDiff(state.backend, { file: file || undefined });
    state.git.diff = diff || '(no changes)';
    state.git.diffBinary = !!binary;
    state.git.file = file || '';
  } catch (e) {
    state.git.diffError = e.message || 'Could not load diff.';
  }
  state.git.diffLoading = false; render();
}

async function createWorktree(path, branch, newBranch) {
  state.git.worktreeBusy = true; render();
  try {
    await B.worktreeCreate(state.backend, { path, branch, newBranch });
    state.git.wtDialog = null;
    await loadGitPanel();
  } catch (e) {
    if (state.git.wtDialog) { state.git.wtDialog.error = e.message || 'Could not create worktree.'; }
    else state.git.error = e.message || 'Could not create worktree.';
  }
  state.git.worktreeBusy = false; render();
}

function gitWorktreeDialog() {
  const d = state.git.wtDialog;
  if (!d) return null;
  return PromptDialog({
    title: 'New worktree', value: d.value ?? '', placeholder: 'relative path, e.g. ../myrepo-feature',
    error: d.error || null, busy: !!state.git.worktreeBusy,
    confirmLabel: state.git.worktreeBusy ? 'creating…' : 'create', cancelLabel: 'cancel',
    onCancel: () => { state.git.wtDialog = null; render(); },
    onInput: (v) => { d.value = v; },
    onConfirm: (v) => {
      if (!v) { d.error = 'enter a worktree path'; render(); return; }
      // New worktree checks out a branch named after the path's basename -
      // matches WorktreeSwitcher's "new worktree" action, which collects no
      // separate branch field (host owns the create flow per its own docs).
      createWorktree(v, undefined, v.split('/').filter(Boolean).pop());
    },
  });
}

function gitMain() {
  if (!state.git.loading && !state.git.files.length && !state.git.commits.length && !state.git.worktrees.length && !state.git.error) loadGitPanel();
  const g = state.git;
  return [
    PageHeader({ compact: true, dense: true, title: 'Git', lede: 'Working-tree diff, recent commits, and worktrees.' }),
    g.error ? Alert({ key: 'git-err', kind: 'error', title: 'Git error', children: g.error }) : null,
    Row({ key: 'git-actions', children: [
      Btn({ key: 'refresh', onClick: () => loadGitPanel(), children: g.loading ? 'loading…' : 'refresh' }),
      WorktreeSwitcher({
        key: 'wts',
        worktrees: g.worktrees,
        current: (g.worktrees.find(w => w.branch) || {}).branch,
        onSwitch: (w) => loadGitDiff(''),
        onCreate: () => { state.git.wtDialog = { value: '', error: null }; render(); },
      }),
    ] }),
    Panel({ id: 'git-status', title: 'changed files', children:
      GitStatusPanel({ files: g.files, active: g.file, onFileClick: (f) => loadGitDiff(f.path) }) }),
    Panel({ id: 'git-diff', title: g.file ? ('diff: ' + g.file) : 'diff', children:
      g.diffError ? h('p', { key: 'de', class: 't-meta field-error' }, g.diffError)
      : GitDiffView({ diff: g.diff || '', filename: g.file, binary: !!g.diffBinary }) }),
    Panel({ id: 'git-log', title: 'recent commits', children:
      !g.commits.length ? h('p', { key: 'nc', class: 't-meta' }, g.loading ? 'loading…' : 'no commits')
      : h('ul', { key: 'cl', class: 'git-commit-list' }, g.commits.map(c =>
          h('li', { key: c.hash }, [
            h('code', { key: 'h' }, (c.hash || '').slice(0, 8)),
            ' ' + (c.subject || ''),
            h('span', { key: 'm', class: 't-meta' }, ' — ' + (c.author || '') + ' · ' + (c.date || '')),
            Btn({ key: 'view', small: true, onClick: () => loadGitDiff(''), children: 'view' }),
          ]))) }),
    gitWorktreeDialog(),
  ];
}

// Models tab: agentgui's real model surface composed by the models.availability
// WS handler (agent-CLI registry availability + provider key presence), fed
// into the design SDK's ModelsConfig component. Not freddie's probed per-mode
// matrix - see lib/ws-handlers-util.js models.availability for the mapping.
function modelsMain() {
  const m = state.models;
  return [
    PageHeader({ compact: true, dense: true, title: 'Models', lede: 'Discovered agent CLIs, their models, and provider key presence on this server.' }),
    ModelsConfig({
      data: m.data,
      loading: m.loading,
      error: m.error,
      selectedProviderId: m.selectedProviderId,
      onSelectProvider: (id) => { state.models.selectedProviderId = id; render(); },
      onRefresh: () => loadModelsAvailability(),
    }),
  ];
}

// Plugins tab: agentgui has no freddie-style plugin host (~150 discoverable
// plugin.js files) - its actual extensibility surface is the discovered
// agent-CLI registry (lib/agent-discovery.js + lib/claude-runner-agents.js
// AgentRegistry, the same data agents.list already exposes to the chat
// picker). Adapted onto PluginsConfig's shape: name=agent id, surfaces=
// protocol (cli|acp), requires=[] (agents have no dependency graph), enabled=
// available (the CLI was actually found on this server), status=install hint
// when missing. There is no enable/disable action (agentgui does not gate
// which agent CLIs are usable) so onToggle re-checks availability instead of
// pretending to flip a setting that doesn't exist.
function pluginsMain() {
  const list = (state.agents || []).map((a) => ({
    name: a.id,
    version: undefined,
    surfaces: a.protocol || 'cli',
    requires: [],
    source: a.npxPackage ? ('npx ' + a.npxPackage) : undefined,
    enabled: a.available !== false,
    status: a.available !== false ? 'loaded' : (a.npxInstallable ? 'installable via npx' : 'not found'),
  }));
  return [
    PageHeader({ compact: true, dense: true, title: 'Plugins', lede: 'Discovered agent CLIs — agentgui\'s real extensibility surface (no freddie-style plugin host).' }),
    PluginsConfig({
      plugins: list,
      selected: state.plugins.selected,
      loading: !!state.agentsLoading,
      error: state.agentsError,
      onSelect: (name) => { state.plugins.selected = name; render(); },
      // No real enable/disable exists - re-run discovery so a just-installed
      // CLI's availability reflects immediately instead of a fake toggle.
      onToggle: () => { withBusy(null, () => loadAgents(), 'checking…'); },
      onReload: () => loadAgents(),
    }),
  ];
}

// --- files (folder browser) ---
async function loadDir(dirPath, { fromHash = false } = {}) {
  state.files = state.files || {};
  // Guard against a stale in-flight reconcile clobbering a newer optimistic
  // patch (e.g. two rapid bulk delete/move actions): only the most-recently-
  // issued call is allowed to commit its result.
  const myReq = (state.files._reqId = (state.files._reqId || 0) + 1);
  state.files.loading = true; state.files.error = null; render();
  try {
    const j = await B.listDir(state.backend, dirPath || '');
    if (state.files._reqId !== myReq) return;
    // The filter text and show-more cap are per-directory state: keep them
    // across an in-place refresh (same path after a mutation), reset them when
    // the resolved directory actually changed. The multi-select set follows the
    // same rule: cleared on a real directory change, pruned to the surviving
    // entries on an in-place refresh (a deleted file must not stay marked).
    if (j.path !== state.files.path) {
      state.files.filter = ''; state.files.shown = null;
      state.files.marked = new Set(); state.files._lastMarkIdx = null;
    } else if (state.files.marked && state.files.marked.size) {
      const alive = new Set((j.entries || []).map((e) => e.path || e.name));
      state.files.marked = new Set([...state.files.marked].filter((p) => alive.has(p)));
    }
    state.files.path = j.path;
    state.files.segments = j.segments || [];
    state.files.entries = j.entries || [];
    state.files.roots = j.roots || [];
    state.files.error = null;
    // Deep-link the open directory: push so Back walks the tree; a load that
    // came FROM the hash (popstate/boot) replaces instead - the entry already
    // exists, only the URL needs to stay accurate (writeHash no-ops when the
    // hash already matches, so popstate never loops).
    if (state.tab === 'files') writeHash({ push: !fromHash });
  } catch (e) {
    if (state.files._reqId !== myReq) return;
    // W9: translate HTTP status to plain, non-leaky copy.
    state.files.error = e.status === 403
      ? 'That folder is outside the accessible folders, or access is denied.'
      : (e.status === 404 ? 'That folder no longer exists.' : (e.message || 'Could not list this directory.'));
    state.files.entries = [];
  }
  if (state.files._reqId !== myReq) return;
  state.files.loading = false; render();
}

// Map a file extension to a Prism language hint for the code preview.
const PREVIEW_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', tsx: 'tsx', py: 'python', rb: 'ruby', rs: 'rust',
  go: 'go', java: 'java', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
  cs: 'csharp', php: 'php', sh: 'bash', css: 'css', html: 'markup',
  xml: 'markup', svg: 'markup', json: 'json', yml: 'yaml', yaml: 'yaml',
  toml: 'toml', sql: 'sql', md: 'markdown',
};

// Load the raw content of the currently-selected text/code preview file.
// Images don't fetch here (the FileViewer renders them via /api/image url).
async function loadPreviewContent(file) {
  state.files = state.files || {};
  const p = state.files.previewState = { loading: true, error: null, content: '', truncated: false, path: file.path };
  render();
  try {
    const { content, truncated } = await B.readFile(state.backend, file.path);
    // Bail if the user moved to another file while this was in flight.
    if (state.files.preview?.path !== file.path) return;
    p.content = content; p.truncated = truncated;
  } catch (e) {
    if (state.files.preview?.path !== file.path) return;
    p.error = e.message;
  }
  p.loading = false; render();
}

function closePreview() {
  if (!state.files) return;
  state.files.preview = null;
  state.files.previewState = null;
  // Clear file= from the URL (replace - the pushed open-entry stays poppable).
  if (state.tab === 'files') writeHash();
  render();
}

// Restore (or clear) the file= preview named by the hash once the directory
// listing for dir= has resolved - popstate and boot both funnel through here.
function restoreFileFromHash(filePath) {
  const f = state.files || {};
  if (!filePath) {
    if (f.preview) { f.preview = null; f.previewState = null; render(); }
    return;
  }
  if (f.preview && f.preview.path === filePath) return;
  const entry = (f.entries || []).find(e => e.path === filePath);
  if (entry && entry.type !== 'dir') openPreview(entry, { fromHash: true });
}

// --- file mutations (rename / delete / new folder / upload) ---
// One dialog at a time lives in state.files.dialog: {kind, file, error, busy}.
// Errors from the confined endpoints map to plain copy by HTTP status.
function fileMutationCopy(e) {
  if (e.status === 403) return 'Permission denied, or the target is outside the accessible folders.';
  if (e.status === 404) return 'That file no longer exists.';
  if (e.status === 409) return e.message || 'A file with that name already exists.';
  if (e.status === 413) return 'Too large (50MB upload cap).';
  return e.message || 'The operation failed.';
}
// On a 409 name-collision, suggest 'name (2)' / 'name (3)' etc instead of
// leaving the user to retype the identical blocked string from scratch -
// mirrors the numbering convention most desktop file managers use.
function suggestAlternateName(name) {
  const m = /^(.*) \((\d+)\)(\.[^.]*)?$/.exec(name);
  if (m) return m[1] + ' (' + (parseInt(m[2], 10) + 1) + ')' + (m[3] || '');
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) + ' (2)' + name.slice(dot) : name + ' (2)';
}
function openFileDialog(kind, file) {
  const trigger = typeof document !== 'undefined' ? document.activeElement : null;
  state.files.dialog = { kind, file: file || null, error: null, busy: false, _trigger: trigger || null };
  render();
}
// Restore focus to whatever row/button opened the dialog so keyboard/AT users
// don't lose their place to document.body on close.
function restoreFileDialogFocus(trigger) {
  if (!trigger) return;
  requestAnimationFrame(() => { if (document.contains(trigger)) trigger.focus(); });
}
// --- multi-select (marked) helpers. Marked entries are keyed by path so the
// set survives sort/filter changes; loadDir owns clearing/pruning it.
function filesMarked() {
  if (!(state.files.marked instanceof Set)) state.files.marked = new Set();
  return state.files.marked;
}
function markFile(f, { range = false } = {}) {
  const marked = filesMarked();
  const key = f.path || f.name;
  const list = state.files._sorted || [];
  const idx = list.findIndex((e) => (e.path || e.name) === key);
  if (range && state.files._lastMarkIdx != null && idx >= 0) {
    // Shift-click: mark the whole span between the anchor and this row (always
    // mark, never unmark - the common bulk gesture; EACCES rows are skipped).
    const [a, b] = [Math.min(state.files._lastMarkIdx, idx), Math.max(state.files._lastMarkIdx, idx)];
    for (const e of list.slice(a, b + 1)) {
      if (e.permissions === 'EACCES') continue;
      marked.add(e.path || e.name);
    }
  } else if (marked.has(key)) marked.delete(key);
  else marked.add(key);
  state.files._lastMarkIdx = idx >= 0 ? idx : null;
  render();
}
function clearFileSelection({ quiet = false } = {}) {
  const marked = filesMarked();
  if (!marked.size) return false;
  marked.clear();
  state.files._lastMarkIdx = null;
  if (!quiet) announce('selection cleared');
  render();
  return true;
}
// Bulk delete every marked entry via the same confined endpoint the per-row
// delete uses. Partial failure keeps the FAILED paths marked (so a retry
// targets exactly what's left) and surfaces a count in the dialog.
async function runBulkDelete() {
  const d = state.files.dialog;
  if (!d || d.kind !== 'bulk-delete' || d.busy) return;
  const marked = filesMarked();
  const targets = (state.files.entries || []).filter((e) => marked.has(e.path || e.name));
  if (!targets.length) { state.files.dialog = null; restoreFileDialogFocus(d._trigger); render(); return; }
  d.busy = true; d.error = null; render();
  const results = await Promise.allSettled(
    targets.map((e) => B.deleteEntry(state.backend, e.path, e.type === 'dir')));
  // The dialog can detach mid-flight (state replaced/closed elsewhere) - a
  // write onto a dead object would be silently lost, same race runFileMutation
  // guards below.
  if (state.files.dialog !== d) { announce('delete finished after the dialog closed'); render(); return; }
  const failed = targets.filter((_, i) => results[i].status === 'rejected');
  const okCount = targets.length - failed.length;
  if (!failed.length) {
    state.files.dialog = null;
    restoreFileDialogFocus(d._trigger);
    marked.clear(); state.files._lastMarkIdx = null;
    const successMsg = 'deleted ' + okCount + ' ' + (okCount === 1 ? 'entry' : 'entries');
    announce(successMsg);
    toast({ message: successMsg, kind: 'success' });
    // Patch the visible list immediately instead of waiting on a second full
    // directory round-trip - the server already confirmed every deletion.
    const gone = new Set(targets.map((e) => e.path || e.name));
    state.files.entries = (state.files.entries || []).filter((e) => !gone.has(e.path || e.name));
    render();
    loadDir(state.files.path, { fromHash: true }); // background reconcile
    return;
  }
  // Keep only the failures marked; report the split inside the dialog.
  state.files.marked = new Set(failed.map((e) => e.path || e.name));
  const firstErr = results.find((r) => r.status === 'rejected');
  d.busy = false;
  d.error = 'deleted ' + okCount + ' of ' + targets.length + ' - '
    + (failed.length === 1 ? '1 entry' : failed.length + ' entries') + ' failed ('
    + fileMutationCopy(firstErr.reason || {}) + '). The failed entries stay selected.';
  await loadDir(state.files.path, { fromHash: true });
  render();
}
// Bulk move every marked entry into a destination directory (confined
// /api/move). Same partial-failure contract as bulk delete: failed paths
// stay marked, the split reports inside the dialog.
async function runBulkMove(destDir) {
  const d = state.files.dialog;
  if (!d || d.kind !== 'bulk-move' || d.busy) return;
  const marked = filesMarked();
  const targets = (state.files.entries || []).filter((e) => marked.has(e.path || e.name));
  if (!targets.length) { state.files.dialog = null; restoreFileDialogFocus(d._trigger); render(); return; }
  d.busy = true; d.error = null; render();
  // Validate the destination once up front so 20 identical 403s read as one
  // clear message instead of a partial-failure split.
  try { await B.statPath(state.backend, destDir); }
  catch (e) {
    if (state.files.dialog !== d) { announce(fileMutationCopy(e)); render(); return; }
    d.busy = false;
    d.error = e.status === 404 ? 'that folder does not exist' : fileMutationCopy(e);
    render(); return;
  }
  const results = await Promise.allSettled(
    targets.map((e) => B.moveEntry(state.backend, e.path, destDir)));
  // The dialog can detach mid-flight (state replaced/closed elsewhere) - a
  // write onto a dead object would be silently lost, same race runFileMutation
  // guards below.
  if (state.files.dialog !== d) { announce('move finished after the dialog closed'); render(); return; }
  const failed = targets.filter((_, i) => results[i].status === 'rejected');
  const okCount = targets.length - failed.length;
  if (!failed.length) {
    state.files.dialog = null;
    restoreFileDialogFocus(d._trigger);
    marked.clear(); state.files._lastMarkIdx = null;
    const successMsg = 'moved ' + okCount + ' ' + (okCount === 1 ? 'entry' : 'entries');
    announce(successMsg);
    toast({ message: successMsg, kind: 'success' });
    // Moved entries leave the current dir - patch them out immediately rather
    // than waiting on a second full directory round-trip.
    const gone = new Set(targets.map((e) => e.path || e.name));
    state.files.entries = (state.files.entries || []).filter((e) => !gone.has(e.path || e.name));
    render();
    loadDir(state.files.path, { fromHash: true }); // background reconcile
    return;
  }
  state.files.marked = new Set(failed.map((e) => e.path || e.name));
  const firstErr = results.find((r) => r.status === 'rejected');
  d.busy = false;
  d.error = 'moved ' + okCount + ' of ' + targets.length + ' - '
    + (failed.length === 1 ? '1 entry' : failed.length + ' entries') + ' failed ('
    + fileMutationCopy(firstErr.reason || {}) + '). The failed entries stay selected.';
  await loadDir(state.files.path, { fromHash: true });
  render();
}
function closeFileDialog() {
  // A mid-flight close would orphan the mutation's result and swallow its
  // error - hold the dialog open until the operation settles.
  if (state.files.dialog?.busy) { announce('still working - please wait'); return; }
  const trigger = state.files.dialog?._trigger;
  state.files.dialog = null; render();
  restoreFileDialogFocus(trigger);
}
async function runFileMutation(fn, doneMsg, patch) {
  const d = state.files.dialog;
  if (!d || d.busy) return;
  d.busy = true; d.error = null; render();
  try {
    const result = await fn();
    state.files.dialog = null;
    restoreFileDialogFocus(d._trigger);
    announce(doneMsg);
    // A soft-delete's trashId (if this mutation was a delete) rides the
    // return value straight to the undo-toast caller - that banner is its own
    // dedicated real-undo-action UI, not a generic dismiss-only confirmation,
    // so it stays separate from toast() rather than being replaced by it.
    if (result && result.trashId) offerUndoDelete(result.trashId, doneMsg);
    else toast({ message: doneMsg, kind: 'success' });
    if (patch) {
      // Patch the visible list immediately, matching the bulk-delete/move
      // pattern, instead of stalling the dialog on a second full round-trip.
      state.files.entries = patch(state.files.entries || []);
      render();
      loadDir(state.files.path, { fromHash: true }); // background reconcile
    } else {
      await loadDir(state.files.path, { fromHash: true }); // refresh in place, no history entry
    }
  } catch (e) {
    // If the dialog detached anyway (e.g. state replaced), the error would be
    // written onto a dead object and lost - announce it instead.
    if (state.files.dialog !== d) { announce(fileMutationCopy(e)); render(); return; }
    d.busy = false; d.error = fileMutationCopy(e); render();
  }
}
// Delete is a soft-delete server-side (moved to a confined .agentgui-trash/,
// see lib/http-handler.js) - offer a real undo action within the retention
// window instead of the ConfirmDialog's pre-delete confirm being the ONLY
// safety net. One active undo toast at a time (the most recent delete wins;
// an in-flight bulk-delete calls this per-entry, each replacing the last -
// acceptable since restoring the single most recent one is still strictly
// better than no undo at all, and stacking N toasts for a bulk op would be
// its own UX problem).
const UNDO_DELETE_WINDOW_MS = 10000;
let _undoDeleteTimer = null;
function offerUndoDelete(trashId, doneMsg) {
  clearTimeout(_undoDeleteTimer);
  state.files.undoDelete = { trashId, doneMsg };
  render();
  _undoDeleteTimer = setTimeout(() => { state.files.undoDelete = null; render(); }, UNDO_DELETE_WINDOW_MS);
}
async function undoDelete() {
  const u = state.files.undoDelete;
  if (!u) return;
  clearTimeout(_undoDeleteTimer);
  state.files.undoDelete = null;
  try {
    await B.restoreEntry(state.backend, u.trashId);
    announce('restored');
    await loadDir(state.files.path, { fromHash: true });
  } catch (e) {
    announce('could not restore: ' + fileMutationCopy(e));
    render();
  }
}
// Upload a FileList into the current directory; per-file rows feed the kit
// UploadProgress (done/error per file - fetch has no chunk progress).
async function uploadFiles(fileList) {
  const dir = state.files.path;
  if (!dir || !fileList || !fileList.length) return;
  const items = Array.from(fileList).map((f) => ({ name: f.name, pct: 0, done: false, error: null, status: null, _file: f, _dir: dir }));
  // Concurrent drops APPEND to the shared queue (a second drop mid-upload must
  // not replace the first batch's progress/errors); one running loop drains it.
  state.files.uploads = (state.files.uploads || []).concat(items);
  render();
  if (state.files.uploading) return;
  state.files.uploading = true;
  try {
    let it;
    while ((it = (state.files.uploads || []).find(i => !i.done && !i.error && !i._started))) {
      it._started = true;
      try {
        await B.uploadFile(state.backend, it._dir, it._file);
        it.pct = 100; it.done = true;
        // Show the finished file in the grid right away instead of waiting on
        // the whole queue to drain - the final loadDir below still reconciles.
        if (it._dir === state.files.path && !(state.files.entries || []).some((e) => e.name === it.name)) {
          state.files.entries = [...(state.files.entries || []),
            { name: it.name, path: (it._dir ? it._dir.replace(/\/$/, '') + '/' : '') + it.name, type: 'file', size: it._file.size, mtime: Date.now() }];
        }
      } catch (e) {
        it.status = e.status || null;
        it.error = fileMutationCopy(e);
      }
      render();
    }
  } finally {
    state.files.uploading = false;
  }
  announce('upload finished');
  await loadDir(state.files.path, { fromHash: true });
  // Keep error rows visible; clear the list entirely when everything landed.
  if (!(state.files.uploads || []).some(i => i.error)) state.files.uploads = null;
  render();
}
// Pasted-image handler for the chat composer: upload each pasted file through
// the same confined endpoint the Files tab uses (into the chat's current cwd),
// then insert the resulting relative path into the draft. Falls back to an
// announce() if there's no cwd to upload into (chat hasn't picked one yet).
function composerEl() {
  return document.querySelector('.chat-composer');
}
async function pastedFilesToChat(files) {
  const list = Array.from(files || []);
  if (!list.length) return;
  const dir = state.chatCwd;
  if (!dir) { announce('set a working directory before pasting files'); return; }
  const el = composerEl();
  if (flashComposerNote && el) flashComposerNote(el, 'uploading ' + plural(list.length, 'file') + '…');
  const inserted = [];
  for (const f of list) {
    try {
      await B.uploadFile(state.backend, dir, f);
      inserted.push(f.name);
    } catch (e) {
      const msg = 'paste upload failed: ' + fileMutationCopy(e);
      announce(msg);
      if (flashComposerNote && el) flashComposerNote(el, msg);
    }
  }
  if (inserted.length) {
    const draft = state.chat.draft || '';
    state.chat.draft = draft + (draft && !draft.endsWith('\n') && !draft.endsWith(' ') ? ' ' : '') + inserted.join(' ');
    debouncedPersistDraft();
    const msg = 'pasted ' + plural(inserted.length, 'file') + ' into ' + pathBasename(dir) + ' - undo history does not include this insert';
    announce(msg);
    if (flashComposerNote && el) flashComposerNote(el, 'pasted ' + plural(inserted.length, 'file'));
    render();
  }
}
// 'replace' on a 409 row: re-PUT the same file with overwrite=1.
async function retryUploadOverwrite(it) {
  if (!it || it._retrying || !it._file) return;
  it._retrying = true; it.error = null; it.status = null; render();
  try {
    await B.uploadFile(state.backend, it._dir, it._file, true);
    it.pct = 100; it.done = true;
  } catch (e) {
    it.status = e.status || null;
    it.error = fileMutationCopy(e);
  }
  it._retrying = false;
  await loadDir(state.files.path, { fromHash: true });
  if (!(state.files.uploads || []).some(i => i.error)) state.files.uploads = null;
  render();
}
function dismissUpload(it) {
  const ups = state.files.uploads || [];
  const i = ups.indexOf(it);
  if (i >= 0) ups.splice(i, 1);
  if (!ups.length) state.files.uploads = null;
  render();
}
// The active file dialog (rename/delete/mkdir) as a kit modal, or null.
function fileDialog() {
  const d = state.files && state.files.dialog;
  if (!d) return null;
  // error/busy live INSIDE the kit dialog (the modal overlay sits above page
  // flow, so a sibling alert was invisible and outside the focus trap).
  if (d.kind === 'rename') {
    return PromptDialog({
      title: 'Rename ' + d.file.name, value: d.suggestedValue ?? d.file.name, placeholder: 'new name',
      error: d.error || null, busy: !!d.busy,
      confirmLabel: d.busy ? 'renaming…' : 'rename', cancelLabel: 'cancel',
      onCancel: closeFileDialog,
      onConfirm: (v) => {
        // Every confirm press produces visible feedback - never a silent no-op.
        if (!v || v === d.file.name) { d.error = 'enter a different name'; render(); return; }
        runFileMutation(() => B.renameEntry(state.backend, d.file.path, v), 'renamed to ' + v,
          (entries) => entries.map((e) => (e.path || e.name) === (d.file.path || d.file.name)
            ? { ...e, name: v, path: e.path ? e.path.slice(0, e.path.length - d.file.name.length) + v : v }
            : e))
          .then(() => {
            // On a 409 name-collision, prefill the retry input with a
            // suggested alternate instead of leaving the identical blocked
            // string - matching the pattern uploadFiles' 409-retry rows
            // already establish for the same class of conflict.
            if (state.files.dialog === d && d.error && /already exists/i.test(d.error)) {
              d.suggestedValue = suggestAlternateName(v);
              render();
            }
          });
      },
    });
  }
  if (d.kind === 'delete') {
    const isDir = d.file.type === 'dir';
    return ConfirmDialog({
      title: 'Delete ' + d.file.name,
      // Delete is soft (moved to trash, undoable for a short window right
      // after) - the copy no longer overclaims permanence the way an actual
      // unlink would warrant.
      message: isDir
        ? 'Delete this folder and everything inside it? You can undo this for a few seconds after.'
        : 'Delete this file? You can undo this for a few seconds after.',
      error: d.error || null, busy: !!d.busy,
      confirmLabel: d.busy ? 'deleting…' : 'delete', cancelLabel: 'cancel', destructive: true,
      onCancel: closeFileDialog,
      onConfirm: () => runFileMutation(() => B.deleteEntry(state.backend, d.file.path, isDir), 'deleted ' + d.file.name,
        (entries) => entries.filter((e) => (e.path || e.name) !== (d.file.path || d.file.name))),
    });
  }
  if (d.kind === 'bulk-delete') {
    const n = filesMarked().size;
    const hasDir = (state.files.entries || []).some((e) => filesMarked().has(e.path || e.name) && e.type === 'dir');
    return ConfirmDialog({
      title: 'Delete ' + n + ' selected ' + (n === 1 ? 'entry' : 'entries'),
      message: (hasDir
        ? 'Folders are deleted with everything inside them. '
        : '') + 'This cannot be undone.',
      error: d.error || null, busy: !!d.busy,
      confirmLabel: d.busy ? 'deleting…' : 'delete ' + n, cancelLabel: 'cancel', destructive: true,
      onCancel: closeFileDialog,
      onConfirm: runBulkDelete,
    });
  }
  if (d.kind === 'bulk-move') {
    const n = filesMarked().size;
    // Debounced /api/stat validation on the destination input (mirrors cwd field).
    if (!d._validateDest) {
      d._validateDest = debounce(async (v) => {
        if (!v || v === state.files.path) return;
        try {
          const st = await B.statPath(state.backend, v);
          if (state.files.dialog !== d) return;
          d.error = (!st || st.ok === false) ? 'folder not found on the server'
            : (!st.dir ? 'that path is not a directory' : null);
        } catch (e) {
          if (state.files.dialog !== d) return;
          d.error = e.status === 403 ? 'outside the accessible folders'
            : (e.status === 404 ? 'folder not found on the server' : null);
        }
        render();
      }, 400);
    }
    return PromptDialog({
      title: 'Move ' + n + ' selected ' + (n === 1 ? 'entry' : 'entries'),
      value: d._draft ?? (state.files.path || ''), placeholder: 'destination folder path',
      error: d.error || null, busy: !!d.busy,
      confirmLabel: d.busy ? 'moving…' : 'move ' + n, cancelLabel: 'cancel',
      // A second/third allowed root has no discoverable path other than
      // typing it from memory - one-click chips for every accessible root,
      // matching the same practicality upgrade the cwd editor got.
      roots: (Array.isArray(state.files.roots) && state.files.roots.length > 1)
        ? state.files.roots.map((r) => ({ path: r, label: truncate(projectLabel(r) || r, 14, 24) }))
        : undefined,
      onCancel: closeFileDialog,
      onInput: (v) => { d._draft = v; d.error = null; d._validateDest(v); },
      onPickRoot: (v) => { d._draft = v; d.error = null; d._validateDest(v); render(); },
      onConfirm: (v) => {
        if (!v) { d.error = 'enter a destination folder'; render(); return; }
        if (v === state.files.path) { d.error = 'already in that folder - enter a different destination'; render(); return; }
        runBulkMove(v);
      },
    });
  }
  if (d.kind === 'mkdir') {
    return PromptDialog({
      title: 'New folder', value: d.suggestedValue ?? '', placeholder: 'folder name',
      error: d.error || null, busy: !!d.busy,
      confirmLabel: d.busy ? 'creating…' : 'create', cancelLabel: 'cancel',
      onCancel: closeFileDialog,
      onConfirm: (v) => {
        if (!v) { d.error = 'enter a folder name'; render(); return; }
        runFileMutation(() => B.makeDir(state.backend, state.files.path, v), 'created ' + v,
          (entries) => entries.some((e) => e.name === v)
            ? entries
            : [...entries, { name: v, path: (state.files.path ? state.files.path.replace(/\/$/, '') + '/' : '') + v, type: 'dir' }])
          .then(() => {
            if (state.files.dialog === d && d.error && /already exists/i.test(d.error)) {
              d.suggestedValue = suggestAlternateName(v);
              render();
            }
          });
      },
    });
  }
  return null;
}

// Build the inner preview body (image / code / text / loading / error) shared by
// the modal FileViewer (<900px) and the inline FilePreviewPane (split view).
function filePreviewBody(file) {
  const f = state.files || {};
  if (file.type === 'image') {
    return FilePreviewMedia({ src: B.imageUrl(state.backend, file.path), type: 'image', name: file.name });
  }
  const ps = f.previewState;
  if (!ps || ps.path !== file.path) { Promise.resolve().then(() => { if (state.files.preview?.path === file.path && state.files.previewState?.path !== file.path) loadPreviewContent(file); }); }
  if (!ps || ps.loading || ps.path !== file.path) {
    return h('div', { class: 't-meta empty-state', role: 'status', 'aria-live': 'polite' }, Spinner({ size: 'sm' }), 'loading…');
  }
  if (ps.error) {
    return Alert({ kind: 'warn', title: 'Cannot preview file', children: [
      h('span', { key: 'perr' }, ps.error),
      h('a', { key: 'dl', class: 'btn btn-sm', href: B.downloadUrl(state.backend, file.path), download: file.name }, 'download instead'),
    ] });
  }
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const lang = PREVIEW_LANG[ext];
  return lang
    ? FilePreviewCode({ content: ps.content, lang, filename: file.name })
    : FilePreviewText({ content: ps.content, truncated: ps.truncated });
}

// The previewable (non-dir) neighbours of the current preview, in the same
// sorted+filtered order the grid shows, so prev/next step through files the way
// fsbrowse does. Returns { prev, next } file objects or null at the ends.
function previewNeighbours() {
  const f = state.files || {};
  const file = f.preview;
  if (!file || !Array.isArray(f._sorted)) return { prev: null, next: null };
  const list = f._sorted.filter(e => e.type !== 'dir');
  const i = list.findIndex(e => e.path === file.path);
  if (i === -1) return { prev: null, next: null };
  return { prev: i > 0 ? list[i - 1] : null, next: i < list.length - 1 ? list[i + 1] : null };
}

function openPreview(file, { fromHash = false } = {}) {
  state.files.preview = file;
  // Push file= so Back closes the preview; hash-driven opens replace instead.
  if (state.tab === 'files') writeHash({ push: !fromHash });
  if (file.type !== 'image') loadPreviewContent(file);
  render();
}

// Render the file preview MODAL (FileViewer) - the <900px fallback when there is
// no room for the inline pane. Returns null when nothing is selected.
function filePreview() {
  const f = state.files || {};
  const file = f.preview;
  if (!file) return null;
  const { prev, next } = previewNeighbours();
  return FileViewer({ file, body: filePreviewBody(file), onClose: closePreview,
    onPrev: prev ? () => openPreview(prev) : undefined,
    onNext: next ? () => openPreview(next) : undefined });
}

// Render the inline file preview PANE (FilePreviewPane) for the WorkspaceShell
// pane slot - the split-view, claude-Desktop file-pane feel.
function filePreviewPane() {
  const f = state.files || {};
  const file = f.preview;
  if (!file) return FilePreviewPane({});
  const { prev, next } = previewNeighbours();
  return FilePreviewPane({ file, body: filePreviewBody(file), onClose: closePreview,
    onPrev: prev ? () => openPreview(prev) : undefined,
    onNext: next ? () => openPreview(next) : undefined });
}

// Go up one directory from the current path (the FileGrid Backspace affordance).
function fileUp() {
  const f = state.files || {};
  const segs = (f.segments || []);
  if (segs.length <= 1) { loadDir(''); return; }
  const up = segs.slice(0, segs.length - 1);
  const joined = /^[A-Za-z]:$/.test(up[0]) ? up[0] + '\\' + up.slice(1).join('\\') : '/' + up.join('/');
  loadDir(joined);
}

function filesMain() {
  const f = state.files || {};
  // The initial dir load is kicked from navTo('files') (an effect), not here,
  // so this view function stays pure. A direct deep-link to files still loads:
  // init()/navTo handles the entry. As a safety net for a render that arrives
  // before navTo's effect (e.g. hash deep-link), schedule (not call) a load.
  if (!f.path && !f.loading && !f.error) { Promise.resolve().then(() => { if (!state.files.path && !state.files.loading) loadDir(''); }); }
  const crumb = BreadcrumbPath({
    root: 'root',
    segments: f.segments || [],
    onNav: (i) => {
      // i=0 is the synthetic root button -> reload the default root; otherwise
      // rebuild the absolute path up to the clicked segment.
      if (i === 0) { loadDir(''); return; }
      const segs = (f.segments || []).slice(0, i);
      // Reconstruct a drive-aware absolute path from the segments.
      const joined = segs.length && /^[A-Za-z]:$/.test(segs[0]) ? segs[0] + '\\' + segs.slice(1).join('\\') : '/' + segs.join('/');
      loadDir(joined);
    },
  });
  // Sort + filter the entries client-side (the server returns one directory at a
  // time, so this is bounded by dir size). Map modified to BOTH a display string
  // and an epoch (modifiedTs) so the kit's modified-sort orders by real time.
  const mapped = (f.entries || []).map((e) => {
    const ts = e.modified ? Date.parse(e.modified) : 0;
    // permissions rides along so the kit's EACCES/read-only tag, disabled-open
    // and unmarkable-checkbox logic actually fire (it was silently dropped here).
    return { name: e.name, type: e.type, size: e.size, modified: ts ? fmtRelTime(ts) : null, modifiedTs: ts, path: e.path, permissions: e.permissions };
  });
  const filtered = f.filter
    ? mapped.filter(e => e.name.toLowerCase().includes(f.filter.toLowerCase()))
    : mapped;
  const sorted = sortFiles(filtered, f.sort || 'name', f.sortDir || 'asc');
  // Stash the sorted+filtered list so prev/next preview stepping walks the SAME
  // order the grid shows (W6).
  state.files._sorted = sorted;
  let body;
  if (f.error) {
    body = Alert({ key: 'ferr', kind: 'warn', title: 'Cannot list directory', children: f.error });
  } else {
    body = FileGrid({
      files: sorted,
      loading: f.loading,
      shown: f.shown,
      onShowMore: (n) => { state.files.shown = n; render(); },
      emptyText: f.filter ? 'No files match "' + f.filter + '"' : 'Empty directory',
      // Multi-select: marked is path-keyed; shift-click ranges over the same
      // sorted order the grid shows; select-all covers the SHOWN window only.
      selectable: !!f.path,
      marked: filesMarked(),
      onMark: markFile,
      onSelectAll: (keys) => { state.files.marked = new Set(keys); state.files._lastMarkIdx = null; announce(keys.length + ' selected'); render(); },
      onClearSelection: () => clearFileSelection(),
      // Density: list / compact / thumbnails. Thumbnails stream through the
      // confined /api/download (same fsAllowRoots as the listing - /api/image
      // has its OWN narrower allowlist and 403s repo files; <img> ignores the
      // attachment disposition).
      density: f.density || 'list',
      onDensity: (d2) => { state.files.density = d2; persistFilesPrefs(); render(); },
      thumbUrl: (file) => B.downloadUrl(state.backend, file.path),
      sort: { key: f.sort || 'name', dir: f.sortDir || 'asc', onSort: (k) => {
        // Click the active column to flip direction; a new column resets to asc.
        if (state.files.sort === k) state.files.sortDir = state.files.sortDir === 'asc' ? 'desc' : 'asc';
        else { state.files.sort = k; state.files.sortDir = 'asc'; }
        persistFilesPrefs();
        render();
      } },
      filter: { value: f.filter || '', placeholder: 'Filter by name', onInput: debouncedFilesFilter },
      onUp: fileUp,
      onOpen: (file) => {
        if (file.permissions === 'EACCES') { announce('no access to ' + file.name); return; }
        if (file.type === 'dir') loadDir(file.path);
        else openPreview(file);
      },
      // Full manager wiring: download streams the confined /api/download;
      // rename/delete open a kit dialog backed by the confined mutation
      // endpoints (the former read-only scope cut is reversed).
      onAction: (act, file) => {
        if (file.permissions === 'EACCES') { announce('no access to ' + file.name); return; }
        if (act === 'download' && file.type !== 'dir') {
          const a = document.createElement('a');
          a.href = B.downloadUrl(state.backend, file.path);
          a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
        }
        if (act === 'rename') openFileDialog('rename', file);
        if (act === 'delete') openFileDialog('delete', file);
        // Single-file move reuses the bulk-move dialog + runBulkMove, seeded
        // with just this one path selected - no new dialog kind, no new
        // server surface (/api/move already exists for the multi-select
        // path). Was previously only reachable via checkbox-select + BulkBar.
        if (act === 'move') {
          state.files.marked = new Set([file.path || file.name]);
          state.files._lastMarkIdx = null;
          openFileDialog('bulk-move', file);
        }
      },
    });
  }
  // Roots picker: when the server allows more than one root, surface them as a
  // kit RootsPicker segmented control so every allowed root is reachable in one
  // click (not only by breadcrumb-walking down from the first).
  const roots = Array.isArray(f.roots) ? f.roots : [];
  const rootsRow = roots.length > 1
    ? RootsPicker({
        roots: roots.map((r) => ({ id: r, label: truncate(projectLabel(r) || r, 16, 28) })),
        selected: f.path, onSelect: (r) => loadDir(r), label: 'Jump to an accessible folder',
      })
    : null;
  const targetCwd = f.path || (roots.length === 1 ? roots[0] : '');
  // Kit FileToolbar (replaces the hand-built .ds-file-toolbar markup).
  const toolbar = FileToolbar({
    left: [crumb],
    right: [
      // Explicit up-a-directory affordance for mouse users (the grid also takes
      // Backspace); disabled at a root depth where fileUp would no-op.
      Btn({ key: 'up', disabled: (f.segments || []).length <= 1, 'aria-label': 'up a directory', onClick: () => fileUp(), children: 'up' }),
      f.path ? Btn({ key: 'newdir', onClick: () => openFileDialog('mkdir'), children: 'new folder' }) : null,
      f.path ? Btn({ key: 'upload', onClick: () => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true;
        inp.style.position = 'fixed'; inp.style.opacity = '0';
        document.body.appendChild(inp);
        inp.onchange = () => { uploadFiles(inp.files); inp.remove(); };
        inp.click();
      }, children: 'upload' }) : null,
      targetCwd
        ? Btn({ key: 'usecwd', onClick: () => { state.chatCwd = targetCwd; lsSet('agentgui.cwd', targetCwd); announce('working directory set to ' + targetCwd); navTo('chat'); }, children: 'use as chat cwd' })
        : null,
    ].filter(Boolean),
  });
  // Drag-and-drop upload wraps the grid (keyboard path = the toolbar upload
  // button); per-file progress rows render above the grid while in flight.
  const droppableBody = f.path && !f.error
    ? DropZone({
        dragover: !!f.dragover,
        label: 'drop files to upload to this folder',
        onDragOver: () => { if (!state.files.dragover) { state.files.dragover = true; render(); } },
        onDragLeave: () => { if (state.files.dragover) { state.files.dragover = false; render(); } },
        onDrop: (files, ev) => {
          state.files.dragover = false;
          // Detect directory drops: browsers report an empty FileList for dirs.
          // Check DataTransferItems when available; fall back to empty files list.
          const items = ev && ev.dataTransfer && ev.dataTransfer.items;
          const FOLDER_DROP_MSG = 'folders cannot be dropped - use new folder to create one';
          if (items) {
            const hasDir = Array.from(items).some(it => { try { return it.webkitGetAsEntry && it.webkitGetAsEntry()?.isDirectory; } catch { return false; } });
            if (hasDir) { announce(FOLDER_DROP_MSG); return; }
          } else if (!files || !files.length) {
            announce(FOLDER_DROP_MSG); return;
          }
          uploadFiles(files);
        },
        children: body,
      })
    : body;
  return [
    offlineBanner(),
    f.undoDelete ? Alert({ key: 'undodel', kind: 'info', title: 'Deleted',
      children: [
        h('span', { key: 'udtxt' }, (f.undoDelete.doneMsg || 'Deleted') + ' - undo within a few seconds. '),
        Btn({ key: 'udbtn', onClick: () => undoDelete(), children: 'undo' })] }) : null,
    PageHeader({ compact: true, dense: true, title: 'Files', lede: 'Browse and manage files in the allowed folders.' }),
    // One vertical beat (.ds-files-stack gap) for the whole command stack -
    // the bands used to butt edge-to-edge while the header gap was 24px.
    // The .filter(Boolean) is load-bearing (webjsx keyed-children rule).
    h('div', { key: 'fstack', class: 'ds-files-stack' }, ...[
      rootsRow ? h('div', { key: 'froots' }, rootsRow) : null,
      h('div', { key: 'ftb' }, toolbar),
      // Bulk action strip - appears while a multi-select is active; delete runs
      // through the same armed ConfirmDialog vocabulary as the per-row delete.
      filesMarked().size ? h('div', { key: 'fbulk' }, BulkBar({
        count: filesMarked().size,
        noun: 'entry',
        busy: !!(f.dialog && (f.dialog.kind === 'bulk-delete' || f.dialog.kind === 'bulk-move') && f.dialog.busy),
        actions: [
          { label: 'move selected', onClick: () => openFileDialog('bulk-move') },
          { label: 'delete selected', danger: true, onClick: () => openFileDialog('bulk-delete') },
        ],
        onClear: () => clearFileSelection(),
      })) : null,
      (f.uploads && f.uploads.length) ? h('div', { key: 'fup' }, UploadProgress({
        // Recovery affordances per row: 'replace' on a name collision (409),
        // dismiss on any error row (errors otherwise persist until the next batch).
        items: f.uploads.map((it) => {
          // No chunk-level progress is available from fetch, so an in-flight
          // row with no percent yet gets the marquee affordance instead of a
          // static 0% fill that reads as stuck.
          const base = (!it.error && !it.done && !it.pct) ? { ...it, indeterminate: true } : it;
          return (base.error && base.status === 409 && !base._retrying)
            ? { ...base, actions: [{ label: 'replace', onClick: () => retryUploadOverwrite(base) }] }
            : base;
        }),
        onDismiss: (item, i) => {
          const src = (state.files.uploads || [])[i];
          if (src && src.error) dismissUpload(src);
        },
      })) : null,
      h('div', { key: 'fbody' }, droppableBody),
    ].filter(Boolean)),
    fileDialog(),
    // Inline pane handles wide-screen preview; the modal is only the <900px
    // fallback (the pane has no room there).
    (f.preview && isNarrow()) ? h('div', { key: 'fprev' }, filePreview()) : null,
  ].filter(Boolean);
}

// --- live/files preference persistence (sort, errors-only). The live
// selection Set is deliberately NOT persisted - stale sids would arm
// stop-selected against sessions that no longer exist.
const LIVE_PREFS_KEY = 'agentgui.live';
const FILES_PREFS_KEY = 'agentgui.files';
// Recent-cwd MRU: a small, most-recently-used list of working directories
// actually saved, so switching between a regular handful of projects needs no
// re-typing/re-browsing. Capped small - this is a quick-pick convenience, not
// a full history (that's what the Files tab + browse popover are for).
const CWD_RECENT_KEY = 'agentgui.cwd.recent';
const CWD_RECENT_CAP = 6;
function loadRecentCwds() {
  try { const v = JSON.parse(lsGet(CWD_RECENT_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function pushRecentCwd(path) {
  if (!path) return;
  const list = loadRecentCwds().filter((p) => p !== path);
  list.unshift(path);
  lsSet(CWD_RECENT_KEY, JSON.stringify(list.slice(0, CWD_RECENT_CAP)));
}
function persistLivePrefs() {
  lsSet(LIVE_PREFS_KEY, JSON.stringify({ sort: state.live.sort || 'status', errorsOnly: !!state.live.errorsOnly, filter: state.live.filter || '' }));
  if (state.tab === 'live') writeHash();
}
function persistFilesPrefs() {
  lsSet(FILES_PREFS_KEY, JSON.stringify({ sort: state.files.sort || 'name', sortDir: state.files.sortDir || 'asc', density: state.files.density || 'list' }));
}
function hydratePrefs() {
  try {
    const lv = JSON.parse(lsGet(LIVE_PREFS_KEY) || 'null');
    if (lv) { if (lv.sort) state.live.sort = lv.sort; state.live.errorsOnly = !!lv.errorsOnly; if (lv.filter) state.live.filter = lv.filter; }
  } catch {}
  try {
    const fp = JSON.parse(lsGet(FILES_PREFS_KEY) || 'null');
    if (fp) { if (fp.sort) state.files.sort = fp.sort; if (fp.sortDir) state.files.sortDir = fp.sortDir; if (fp.density) state.files.density = fp.density; }
  } catch {}
}

// Two-step stop: the first click ARMS (confirming* flips the kit button to a
// confirm state), a second click within 4s executes; the timer auto-resets.
let _stopAllArmTimer = null;
let _stopSelArmTimer = null;
function armStopAll() {
  state.live.confirmingStopAll = true;
  clearTimeout(_stopAllArmTimer);
  _stopAllArmTimer = setTimeout(() => { state.live.confirmingStopAll = false; render(); }, ARM_RESET_MS);
  render();
}
function armStopSelected() {
  state.live.confirmingStopSelected = true;
  clearTimeout(_stopSelArmTimer);
  _stopSelArmTimer = setTimeout(() => { state.live.confirmingStopSelected = false; render(); }, ARM_RESET_MS);
  render();
}

// Stop every in-flight chat at once (the dashboard "stop all" bulk control).
// Awaits every cancel, reports partial failure, and returns the sids that
// actually stopped so callers only clear those from a selection.
async function stopAllActive(sessions) {
  const sids = (Array.isArray(sessions) ? sessions : (state.active || [])).map(s => s.sid || s.sessionId).filter(Boolean);
  if (!sids.length) return [];
  const st = state.live.stopping = state.live.stopping || new Set();
  for (const sid of sids) st.add(sid);
  render();
  const results = await Promise.allSettled(sids.map(sid => B.cancelChat(state.backend, sid)));
  const okSids = sids.filter((sid, i) => results[i].status === 'fulfilled');
  const failed = sids.length - okSids.length;
  state.live.bulkStopError = failed
    ? failed + ' conversation' + (failed === 1 ? '' : 's') + ' did not stop - try again'
    : null;
  announce(failed
    ? 'stopped ' + okSids.length + ' of ' + sids.length + ' conversations'
    : 'stopped ' + plural(okSids.length, 'conversation'));
  // Clear EVERY attempted sid from the stopping set - both ok and failed -
  // mirroring stopActiveChat's catch-block cleanup. A failed cancel that stays
  // in state.active would otherwise never leave `stopping` (refreshActive only
  // clears sids that vanished from the active set), leaving its stop button
  // permanently disabled instead of retryable.
  for (const sid of sids) st.delete(sid);
  await refreshActive();
  render();
  return okSids;
}

// How long a session can go without activity (and without a running tool)
// before it is treated as STALE - alive but not making progress, so a stuck
// agent reads differently from a busy one.
const STALE_AFTER_MS = 45000;
// Tracks whether a pointer is currently held down anywhere in the document,
// used to freeze Live-dashboard card sort order mid-click (see liveMain()).
let _livePointerDown = false;
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', () => { _livePointerDown = true; });
  document.addEventListener('pointerup', () => { _livePointerDown = false; });
  document.addEventListener('pointercancel', () => { _livePointerDown = false; });
}
// Rank for the error-then-stale-first ordering (W3).
const STATUS_RANK = { error: 0, stale: 1, running: 2 };

// --- live (multi-session dashboard) ---
// Shared source of truth for "every live session" (owned chat.active rows plus
// external SSE-observed sessions) - used by BOTH the Live tab dashboard and the
// WorkspaceRail nav badge/tone, so the count and error signal never diverge
// between the two surfaces (a prior cohesion gap: the rail counted owned-only).
function computeLiveSessions() {
  const bySid = state.sessionsBySid || new Map();
  const tally = state.live.tally || new Map();
  const now = Date.now();
  const stoppingSet = state.live.stopping || new Set();
  const nowS = now - (state.live.clockSkew || 0);
  let sessions = (Array.isArray(state.active) ? state.active : []).map((r) => {
    // The history index + SSE tally are keyed by claude's REAL session id, not
    // the ephemeral chat- id chat.active returns; join on the real one once
    // streaming_session has landed. The ephemeral id stays the card sid (it is
    // what chat.cancel takes).
    const realSid = r.claudeSessionId || r.sessionId;
    const sess = bySid.get(realSid);
    const t = tally.get(realSid);
    // Counters are MONOTONIC within a session: the index refresh lags the JSONL
    // flush, so take the max of index and live tally - never regress.
    const events = Math.max(sess?.events ?? -1, t?.events ?? -1);
    const tools = Math.max(sess?.tools || 0, t?.tools || 0);
    const errors = Math.max(sess?.errors || 0, t?.errors || 0);
    const lastTs = Math.max(sess?.last || 0, t?.last || 0);
    const lastErrorTs = Math.max(sess?.lastErrorTs || 0, t?.lastErrorTs || 0);
    const counterBits = [];
    if (events >= 0) counterBits.push(events + ' ev');
    if (tools) counterBits.push(tools + ' tools');
    if (errors) counterBits.push(errors + ' err');
    // Current tool: the in-page chat knows its own running tool part; every
    // OTHER session gets it from the per-sid SSE tally (an unresolved tool_use
    // means busy-with-tool, not stalled).
    let currentTool = '';
    if (state.chat.resumeSid === realSid && state.chat.busy) {
      const msgs = state.chat.messages || [];
      const last = msgs[msgs.length - 1];
      const running = last && Array.isArray(last.parts) && last.parts.filter(p => p && p.kind === 'tool' && p.status === 'running').slice(-1)[0];
      if (running) currentTool = running.name || '';
    }
    if (!currentTool && t && t.toolRunning) currentTool = t.toolName || 'tool';
    // Status reflects CURRENT reality: error only when an error is recent (a
    // recovered tool error hours ago is history, kept in the counter chip);
    // stale = no recent activity AND no running tool.
    const inReconnectGrace = now < (state.live.reconnectGraceUntil || 0);
    let status = 'running';
    if (lastErrorTs && (nowS - lastErrorTs) <= STALE_AFTER_MS) status = 'error';
    else if (!currentTool && lastTs && (nowS - lastTs) > STALE_AFTER_MS && !inReconnectGrace) status = 'stale';
    const startedTs = r.startedAt || 0;
    const elapsedMs = startedTs ? Math.max(0, now - startedTs) : 0;
    // One title source shared with the rails: projectLabel(title|project)|sid.
    // A brand-new session (started <3s ago) with no index row yet is still
    // BEING indexed, not permanently unresolved - give it a distinct
    // "indexing..." placeholder instead of rendering identically to a session
    // whose index lookup genuinely never resolves.
    const startedTsForTitle = r.startedAt || 0;
    const stillIndexing = !sess && startedTsForTitle && (now - startedTsForTitle < 3000);
    const title = sess
      ? (projectLabel(sess.title) || projectLabel(sess.project) || realSid)
      : (stillIndexing ? 'indexing…' : (r.claudeSessionId ? realSid : ''));
    return {
      sid: r.sessionId,
      realSid,
      title: title || undefined,
      agent: agentById(r.agentId)?.name || r.agentId || 'agent',
      model: r.model || '',
      cwd: pathBasename(r.cwd),
      elapsed: elapsedMs ? fmtDuration(elapsedMs) : '',
      elapsedMs,
      startedTs,
      counter: counterBits.length ? counterBits.join(' · ') : null,
      lastActivity: lastTs ? fmtRelTime(lastTs + (state.live.clockSkew || 0)) : '',
      lastTs,
      errors,
      currentTool,
      status,
      stopping: stoppingSet.has(r.sessionId),
      // Arrival cue for a freshly-started session (a brief enter animation).
      isNew: startedTs ? (now - startedTs < 3000) : false,
      // Surface the in-page chat's own running cost and token count on its card
      // (the only session we hold reliable per-session data for; others omit it).
      cost: (state.chat.resumeSid && (r.claudeSessionId === state.chat.resumeSid || r.sessionId === state.chat.resumeSid))
        ? (state.chat.totalCost || null) : (t && t.cost ? t.cost : null),
      tokens: (state.chat.resumeSid && (r.claudeSessionId === state.chat.resumeSid || r.sessionId === state.chat.resumeSid) && state.chat.usage)
        ? ((state.chat.usage.inputTokens || 0) + (state.chat.usage.outputTokens || 0)) : (t && t.tokens ? t.tokens : undefined),
    };
  });
  // External sessions (a claude CLI in a terminal, etc.): live SSE motion that
  // belongs to no agentgui-spawned chat. The page promises EVERY in-flight
  // session, so render them as read-only cards (we own no process to stop).
  const ownedReal = new Set(sessions.map(s => s.realSid));
  for (const [sid, t] of tally) {
    if (ownedReal.has(sid)) continue;
    if (!t.last || (nowS - t.last) >= STALE_AFTER_MS) continue;
    const sess = bySid.get(sid);
    const events = Math.max(sess?.events ?? -1, t.events ?? -1);
    const tools = Math.max(sess?.tools || 0, t.tools || 0);
    const errors = Math.max(sess?.errors || 0, t.errors || 0);
    const lastErrorTs = Math.max(sess?.lastErrorTs || 0, t.lastErrorTs || 0);
    const counterBits = [];
    if (events >= 0) counterBits.push(events + ' ev');
    if (tools) counterBits.push(tools + ' tools');
    if (errors) counterBits.push(errors + ' err');
    sessions.push({
      sid,
      realSid: sid,
      external: true,
      readOnly: true,
      title: sess ? (projectLabel(sess.title) || projectLabel(sess.project) || sid) : sid,
      agent: 'other tool',
      model: '',
      cwd: pathBasename(sess && sess.cwd),
      elapsed: '',
      elapsedMs: 0,
      startedTs: 0,
      counter: counterBits.length ? counterBits.join(' · ') : null,
      lastActivity: fmtRelTime(t.last + (state.live.clockSkew || 0)),
      lastTs: t.last,
      errors,
      currentTool: t.toolRunning ? (t.toolName || 'tool') : '',
      // Apply stale detection to external sessions too: no recent activity + no
      // running tool = stale. Same STALE_AFTER_MS as owned sessions (line 1691)
      // AND the inclusion filter above (line 1731) - a card must never report
      // 'stale' before it's even old enough to be dropped from the list, and an
      // owned vs external session in the identical objective state must read
      // the same status.
      status: (lastErrorTs && (nowS - lastErrorTs) <= STALE_AFTER_MS) ? 'error'
        : (!t.toolRunning && t.last && (nowS - t.last) > STALE_AFTER_MS && now >= (state.live.reconnectGraceUntil || 0) ? 'stale' : 'running'),
      stopping: false,
    });
  }
  return sessions;
}

function liveMain() {
  const offline = state.health.status !== 'ok' && state.health.status !== 'unknown';
  // Live-stream health: connected (recent event), connecting (opened, no event
  // yet), or offline (errored - one connection vocabulary across the GUI).
  const streamState = state.live.error ? 'offline' : (state.live.connected ? 'connected' : 'connecting');
  const stoppingSet = state.live.stopping || new Set();
  let sessions = computeLiveSessions();
  // W12: in-dir filter + errors-only toggle.
  const lv = state.live;
  if (lv.errorsOnly) sessions = sessions.filter(s => s.status === 'error');
  if (lv.filter) {
    const q = lv.filter.toLowerCase();
    sessions = sessions.filter(s => ((s.title || '') + ' ' + s.agent + ' ' + s.model + ' ' + s.cwd).toLowerCase().includes(q));
  }
  // Sort: real numeric comparisons (recency/elapsed/error count), owned before
  // external, and a deterministic sid tiebreaker so equal-rank cards never
  // reshuffle with the server's return order.
  const sortKey = lv.sort || 'status';
  // 'elapsed'/'activity' sort keys are continuously-ticking values (they change
  // every second), so re-sorting on every render can reorder a card out from
  // under a mid-click pointer (selecting a checkbox, clicking stop). While a
  // pointer is held down anywhere in the dashboard, freeze the sort to the
  // last-computed sid order instead of live-recomputing it.
  if (_livePointerDown && state._liveSortedOrder && state._liveSortedOrder.length) {
    const rank = new Map(state._liveSortedOrder.map((sid, i) => [sid, i]));
    sessions.sort((a, b) => (rank.has(a.sid) ? rank.get(a.sid) : 1e9) - (rank.has(b.sid) ? rank.get(b.sid) : 1e9));
  } else {
    sessions.sort((a, b) => {
      let d = (a.external ? 1 : 0) - (b.external ? 1 : 0);
      if (d) return d;
      if (sortKey === 'elapsed') d = (b.elapsedMs || 0) - (a.elapsedMs || 0);
      else if (sortKey === 'activity') d = (b.lastTs || 0) - (a.lastTs || 0);
      else if (sortKey === 'errors') d = (b.errors || 0) - (a.errors || 0);
      else d = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
      return d || String(a.sid).localeCompare(String(b.sid));
    });
    state._liveSortedOrder = sessions.map(s => s.sid);
  }
  const selected = lv.selected instanceof Set ? lv.selected : new Set();
  // The in-page chat's card accent matches on the real sid, but the kit
  // compares activeSid against card.sid (the ephemeral id for owned cards).
  const activeCard = state.chat.resumeSid
    ? sessions.find(s => s.realSid === state.chat.resumeSid)
    : null;
  return [
    offlineBanner(),
    lv.bulkStopError
      ? Alert({ key: 'bulkstoperr', kind: 'warn', title: 'Some conversations did not stop',
          children: [
            h('span', { key: 'bsetxt' }, lv.bulkStopError + ' '),
            Btn({ key: 'bsedismiss', onClick: () => { state.live.bulkStopError = null; render(); }, children: 'dismiss' })] })
      : null,
    PageHeader({ compact: true, dense: true, title: 'Live conversations', lede: 'Watch, open, and stop running agent conversations.' }),
    SessionDashboard({
      sessions,
      offline,
      streamState,
      activeSid: activeCard ? activeCard.sid : state.chat.resumeSid,   // W13
      sort: { value: sortKey, onChange: (v) => { state.live.sort = v; persistLivePrefs(); render(); } },
      filter: { value: lv.filter || '', placeholder: 'Filter by agent, model, or folder', onInput: (v) => { state.live.filter = v; persistLivePrefs(); render(); } },
      errorsOnly: !!lv.errorsOnly,
      onErrorsOnly: (on) => { state.live.errorsOnly = on; persistLivePrefs(); render(); },
      selectable: true,
      selected,
      onToggleSelect: (s) => {
        const set = (state.live.selected instanceof Set) ? state.live.selected : new Set();
        if (set.has(s.sid)) set.delete(s.sid); else set.add(s.sid);
        state.live.selected = set; render();
      },
      // Tri-state select-all over the currently-visible selectable sids.
      onSelectAll: (sids) => {
        const set = (state.live.selected instanceof Set) ? state.live.selected : new Set();
        for (const sid of sids) set.add(sid);
        state.live.selected = set; render();
      },
      onClearSelection: () => { state.live.selected = new Set(); render(); },
      // Two-step bulk stops: arm first, execute on the confirmed click.
      confirmingStopAll: !!lv.confirmingStopAll,
      confirmingStopSelected: !!lv.confirmingStopSelected,
      onArmStopAll: armStopAll,
      onArmStopSelected: armStopSelected,
      onStopSelected: async (sids) => {
        state.live.confirmingStopSelected = false;
        clearTimeout(_stopSelArmTimer);
        // Await the cancels and only clear the sids that actually stopped, so
        // a partially-failed bulk stop stays selected and visibly armed-again.
        const ok = await stopAllActive(sids.map(sid => ({ sid })));
        const sel = (state.live.selected instanceof Set) ? state.live.selected : new Set();
        for (const sid of ok) sel.delete(sid);
        state.live.selected = sel;
        render();
      },
      emptyText: (!sessions.length && (lv.filter || lv.errorsOnly)) ? 'No sessions match the current filter' : 'No live sessions — agents you start (or run locally) appear here.',
      emptyAction: { label: 'start a chat', onClick: () => { navTo('chat'); } },
      onStop: (s) => { if (!s.external) stopActiveChat(s.sid); },
      onStopAll: async (all) => {
        state.live.confirmingStopAll = false;
        clearTimeout(_stopAllArmTimer);
        await stopAllActive((all || []).filter(s => !s.external));
        render();
      },
      onOpen: (s) => { resumeInChat({ sid: s.realSid || s.sid }); },
      onView: (s) => { navTo('history'); loadSession(s.realSid || s.sid); },
    }),
  ].filter(Boolean);
}

// --- chat ---
function canSend() {
  return !!state.selectedAgent && agentAvailable(state.selectedAgent) && !state.chat.busy;
}

// A short, human one-liner for a tool's most salient argument (used as the
// collapsible card's label). The full args live in the structured part.
function toolLabel(inp) {
  if (inp && typeof inp === 'object') {
    const a = inp.command || inp.file_path || inp.path || inp.pattern || inp.query || inp.url || '';
    if (a) return String(a).slice(0, 160);
    // No salient arg: surface the first scalar property so the card still carries
    // a hint of what it does, rather than an empty, affordance-less label.
    for (const [k, v] of Object.entries(inp)) {
      if (v != null && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
        return (k + ': ' + String(v)).slice(0, 160);
      }
    }
  }
  return '';
}

// Build a structured tool part the kit's ToolCallNode renders as a collapsible
// card (name + label + full args, status icon). tool_result is matched back to
// this part by tool_use id so the result lands inside the same card.
// Count tool calls still running in the current live turn. Only meaningful
// while the chat is busy; scans the trailing assistant message's parts.
function runningToolCount() {
  if (!state.chat || !state.chat.busy) return 0;
  const msgs = Array.isArray(state.chat.messages) ? state.chat.messages : [];
  const last = msgs[msgs.length - 1];
  if (!last || last.role !== 'assistant' || !Array.isArray(last.parts)) return 0;
  return last.parts.filter(p => p && p.kind === 'tool' && p.status === 'running').length;
}

// Files touched by Edit/Write/MultiEdit/Read tool calls in the current chat
// session, most-recent first, deduped by path - feeds ContextPane's "recent
// files" panel (Claude Desktop surfaces recently-touched files; this GUI had
// no path to that fact at all before).
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'Read', 'NotebookEdit']);
function recentSessionFiles() {
  const msgs = Array.isArray(state.chat.messages) ? state.chat.messages : [];
  const seen = new Set();
  const out = [];
  for (let i = msgs.length - 1; i >= 0 && out.length < 5; i--) {
    const parts = Array.isArray(msgs[i].parts) ? msgs[i].parts : [];
    for (let j = parts.length - 1; j >= 0 && out.length < 5; j--) {
      const p = parts[j];
      if (!p || p.kind !== 'tool' || !FILE_TOOLS.has(p.name)) continue;
      const path = p.args && (p.args.file_path || p.args.path || p.args.notebook_path);
      if (!path || seen.has(path)) continue;
      seen.add(path);
      out.push({ path });
    }
  }
  return out;
}

function toolPart(block) {
  const name = block.name || block.kind || 'tool';
  const input = block.input || block.rawInput || {};
  return {
    kind: 'tool',
    _id: block.id || block.tool_use_id || null,
    name,
    label: toolLabel(input),
    args: input,
    status: 'running',
  };
}

// Append a streamed text delta as an interleaved markdown part, coalescing
// consecutive text into the trailing md part so prose and tool cards keep their
// arrival order within the turn (text -> tool -> text).
function appendText(parts, text) {
  const last = parts[parts.length - 1];
  if (last && last.kind === "md") last.text += text;
  else parts.push({ kind: "md", text });
}

// Apply a tool_result to its matching tool part (by id), else append a
// standalone tool_result part. Sets the card's result + done/error status.
function applyToolResult(parts, block) {
  const id = block.tool_use_id || block.id || null;
  const raw = block?.content ?? block?.output ?? block;
  // Claude API delivers content as an array of {type,text} objects; flatten to plain text.
  const content = Array.isArray(raw) ? (raw.filter(b => b.type === 'text').map(b => b.text).join('\n') || JSON.stringify(raw, null, 2)) : raw;
  const isError = !!(block?.is_error);
  const byId = id ? [...parts].reverse().find(p => p && p.kind === 'tool' && p._id === id) : null;
  const target = byId || [...parts].reverse().find(p => p && p.kind === 'tool' && p.status === 'running');
  if (target) {
    target.result = content;
    target.status = isError ? 'error' : 'done';
    target.error = isError || undefined;
  } else {
    parts.push({ kind: 'tool_result', name: 'result', result: content, error: isError || undefined, status: isError ? 'error' : 'done' });
  }
}

// Map raw transport/server errors to plain-language copy. The raw string is
// preserved via errTextRaw so renderers can carry it on a title attribute.
const ERR_COPY = [
  [/^ws closed$/, 'Lost connection to the server.'],
  [/connection lost during stream/, 'Lost connection while the agent was responding - use retry.'],
  [/connection dropped mid-turn/, 'Connection dropped mid-turn - the response above may be incomplete (events weren\'t replayed). Retry to try again.'],
  [/no sessionId from server/, 'The server could not start the agent - check it is installed.'],
  [/^sessions: \d+/, 'History is still indexing - try again in a moment.'],
];
function errTextRaw(e) {
  if (e == null) return 'unknown error';
  if (typeof e === 'string') return e;
  if (e.message) return e.message;
  try { return JSON.stringify(e); } catch { return String(e); }
}
function errText(e) {
  const raw = errTextRaw(e);
  for (const [re, copy] of ERR_COPY) { if (re.test(raw)) return copy; }
  return raw;
}

function chatMain() {
  const agentName = agentById(state.selectedAgent)?.name || state.selectedAgent || 'agent';
  const userTurnCount = state.chat.messages.filter(m => m.role === 'user').length;

  // Banners agentgui owns (resume, agent-switched, unavailable, confirm-clear,
  // stream error) are pre-built here and handed to the kit, which renders them
  // above the thread. The kit holds no agentgui-specific banner logic.
  const banners = [];
  // Non-claude-code agents cannot --resume by id, so a multi-turn chat with one
  // silently loses prior context. Warn once the conversation is past its first
  // turn so the user knows this agent is not carrying history forward.
  {
    if (state.selectedAgent && state.selectedAgent !== 'claude-code' && state.selectedAgent !== 'agy' && userTurnCount > 1 && !state.chat.resumeSid) {
      banners.push(Alert({ key: 'nocontinuity', kind: 'info', title: (agentById(state.selectedAgent)?.name || state.selectedAgent) + ' does not resume across turns',
        children: 'This agent starts fresh each message - it will not remember earlier turns in this chat. Use Claude Code for a continuous conversation.' }));
    }
    // agy has a real --continue (most-recent-conversation) path wired via
    // resumeSid once this chat is past its first turn - it is NOT stateless
    // like opencode/kilo/codex, so it gets no "does not resume" warning.
  }
  if (state.chat.resumeSid && state.selectedAgent === 'claude-code') {
    // The agent-switched note (if any) lives inside the resume banner rather
    // than as a separate stacked Alert, so resume context reads as one block.
    banners.push(h('div', { key: 'rb', class: 'resume-banner', role: 'status' }, ...[
      h('span', { key: 'rbtxt', class: 'lede' },
        'next message continues this conversation (' + resumeSidLabel(state.chat.resumeSid) + ')'),
      state.chat.resumeNote
        ? h('span', { key: 'rbnote', class: 'sub' }, state.chat.resumeNote)
        : null,
      Btn({ key: 'rclr', onClick: () => { state.chat.resumeSid = null; state.chat.resumeNote = null; render(); }, children: 'clear' }),
    ].filter(Boolean)));
  }
  if (state.selectedAgent && !agentAvailable(state.selectedAgent)) {
    banners.push(Alert({ key: 'unavail', kind: 'warn', title: agentName + ' is not installed',
      children: 'This agent\'s CLI was not found on the server. Pick another agent or install it.' }));
  }
  if (state.confirmingNewChat) {
    banners.push(Alert({ key: 'confnew', kind: 'warn', title: 'Start a new chat?',
      children: [
        h('span', { key: 'cntxt' }, 'This cannot be undone. '),
        Btn({ key: 'cnno', onClick: () => { clearTimeout(_newChatArmTimer); state.confirmingNewChat = false; render(); }, children: 'cancel' }),
        Btn({ key: 'cnyes', danger: true, onClick: confirmNewChat, children: 'yes, start new chat' })] }));
  }
  if (state.cwdError) {
    banners.push(Alert({ key: 'cwderr', kind: 'warn', title: 'Invalid working directory', children: state.cwdError }));
  }
  if (state.chat.externalUpdate) {
    const hasDraft = !!(state.chat.draft && state.chat.draft.trim());
    banners.push(Alert({ key: 'xupd', kind: 'info', title: 'This chat was updated in another tab',
      children: [
        h('span', { key: 'xutxt' }, 'Reload it to see the latest turns, or dismiss to keep this tab\'s view. '
          // "reload it" re-pulls the transcript from localStorage, which
          // silently discarded whatever was typed but not yet sent in THIS
          // tab - warn before that data-loss, not just after.
          + (hasDraft ? 'This tab has an unsent draft that reloading will discard. ' : '')),
        Btn({ key: 'xureload', disabled: state.chat.busy, onClick: () => {
          if (state.chat.busy) return;
          if (hasDraft) { state.chat.confirmingReloadDiscard = true; render(); return; }
          state.chat.externalUpdate = false;
          state.chat.messages = []; state.chat.resumeSid = null; state.chat.totalCost = 0;
          restoreChat(); render();
        }, children: 'reload it' }),
        Btn({ key: 'xudismiss', onClick: () => { state.chat.externalUpdate = false; render(); }, children: 'dismiss' })] }));
  }
  if (state.chat.persistError) {
    banners.push(Alert({ key: 'perr', kind: 'warn', title: 'Chat too large to save locally',
      children: [
        h('span', { key: 'petxt' }, 'New turns stay in this tab but will not survive a reload - export the transcript from settings. '),
        Btn({ key: 'pedismiss', onClick: () => { state.chat.persistError = false; render(); }, children: 'dismiss' })] }));
  } else if (state.chat.persistTruncated) {
    banners.push(Alert({ key: 'ptrunc', kind: 'warn', title: 'Older turns will not survive a reload',
      children: [
        h('span', { key: 'ptrunctxt' }, 'This transcript is longer than the ' + PERSIST_MSG_CAP + ' turns saved locally - a reload keeps only the most recent ' + PERSIST_MSG_CAP + '. Export the full transcript from settings first. '),
        Btn({ key: 'ptruncdismiss', onClick: () => { state.chat.persistTruncated = false; render(); }, children: 'dismiss' })] }));
  }
  if (state.agentsError) {
    // A failed agents.list call (server/network issue) is a distinct case
    // from "the list loaded but nothing is installed" (installHint below,
    // which only fires on a genuinely non-empty, all-unavailable list) -
    // recommending npx-install commands here would be actively wrong, since
    // we don't actually know whether anything is installed. Just clarify the
    // failure is transient/server-side, not a "nothing is installed" state.
    banners.push(Alert({ key: 'agerr', kind: 'error', title: 'Could not load agents from the server',
      children: [
        h('span', { key: 'agtxt', title: state.agentsError }, 'The agent list failed to load - this is a connection issue, not necessarily a sign nothing is installed. '),
        Btn({ key: 'agretry', onClick: (e) => withBusy(e.currentTarget, () => loadAgents(), 'retrying…'), children: 'retry' })] }));
  }
  if (state.chat.loadingTranscript) {
    banners.push(Alert({ key: 'transcriptload', kind: 'info', title: 'Loading prior conversation…',
      children: [Spinner({ key: 'trspin', size: 'sm' })] }));
  }
  if (state.chat.confirmingEdit) {
    const isRetry = state.chat.confirmingEdit.kind === 'retry';
    // Name the actual count/cost about to be discarded instead of the vague
    // "the later turns" - a user retrying/editing message 2 of 40 needs to
    // know whether that's 1 turn or 38 before confirming a destructive undo.
    const truncIdx = state.chat.confirmingEdit.idx;
    const discarded = state.chat.messages.slice(truncIdx + 1);
    const discardedTurns = discarded.filter((m) => m.role === 'user').length;
    const discardedCost = discarded.reduce((s, m) => s + (typeof m.costUsd === 'number' ? m.costUsd : 0), 0);
    const discardSummary = discardedTurns
      ? plural(discardedTurns, 'turn') + (discardedCost > 0 ? ' ($' + discardedCost.toFixed(4) + ')' : '')
      : null;
    banners.push(Alert({ key: 'confedit', kind: 'warn', title: isRetry ? 'Retry this turn?' : 'Edit this message?',
      children: [
        h('span', { key: 'cetext' }, (isRetry ? 'Retrying' : 'Editing') + ' will remove ' + (discardSummary ? discardSummary + ' after this point' : 'the later turns') + ' - continue? '),
        Btn({ key: 'ceno', onClick: cancelEditAndResend, children: 'cancel' }),
        Btn({ key: 'ceyes', danger: true, onClick: confirmEditAndResend, children: isRetry ? 'retry' : 'continue' })] }));
  }
  const lastMsg = state.chat.messages.length ? state.chat.messages[state.chat.messages.length - 1] : null;
  // A failed dangling message now surfaces its error inline on that specific
  // turn (ChatMessage's error/onRetry, wired through AgentChat's message
  // mapper) instead of a separate top-of-thread banner duplicating the same
  // failure - kept as one signal, not two, matching the docstudio per-turn
  // error pattern.

  const placeholder = !state.selectedAgent
    ? 'choose an agent first'
    : (!agentAvailable(state.selectedAgent) ? agentName + ' is not installed' : 'message…');

  // The reusable AgentChat kit owns the agent/model picker, cwd bar, transcript
  // (with AICat-style auto-scroll + thinking), and the caret-stable composer.
  // agentgui supplies state and wires every server interaction as a callback.
  return [
    offlineBanner(),
    runningPanel(),
    AgentChat({
      agents: sortedAgents(),
      agentsLoading: !!state.agentsLoading,
      selectedAgent: state.selectedAgent,
      models: state.agentModels,
      selectedModel: state.selectedModel,
      modelsLoading: !!state.modelsLoading,
      messages: state.chat.messages,
      busy: state.chat.busy,
      draft: state.chat.draft,
      // Scroll-position overview strip alongside the thread.
      showMinimap: true,
      // @-mention file autocomplete: reuse the Files tab's own data source
      // (state.files.entries, populated by loadDir/listDir) rather than a new
      // fetch. Scoped to whatever directory Files last listed - if the user
      // hasn't opened Files yet this is empty and the composer simply shows
      // no mention suggestions until they do (no fake/synthetic file list).
      mentionFiles: (state.files.entries || [])
        .filter((e) => e && e.path)
        .map((e) => ({ path: e.path, isDir: e.type === 'dir' })),
      // Idle never reads 'resuming…' (nothing is in flight - the continuation
      // fact lives in the composer context line and banner); a remotely-stopped
      // turn reads 'stopped', not a normal finish.
      status: state.chat.busy
        ? (state.health.ws === 'reconnecting' ? 'connecting…' : 'streaming…')
        : (state.modelsLoading ? 'loading models…' : ((lastMsg && lastMsg.role === 'assistant' && lastMsg.stopped) ? 'stopped' : 'ready')),
      agentName,
      placeholder,
      canSend: canSend(),
      banners,
      suggestions: state.chat.messages.length ? [] : [
        'Summarize the structure of this project',
        'What are the recent changes on this branch?',
        'Find and explain the main entry point',
      ],
      // Chips send their own text and never touch a typed draft (clicking a
      // chip with a half-typed message in the composer must not destroy it).
      onSuggestionClick: (t) => { if (!canSend()) return; sendChat(t); },
      // W14: a stable per-agent product mark (a line-SVG, not a per-agent letter)
      // and the active target shown inline above the composer.
      avatar: state.selectedAgent ? h('span', { class: 'agentchat-avatar-mark', 'aria-hidden': 'true' }, Icon('forum', { size: 16 })) : undefined,
      composerContext: state.selectedAgent ? {
        // Split click targets: only the cwd bit is interactive (it opens the
        // inline cwd editor); agent/model stay inert text - the picker above
        // already owns them. The resume fact is stated plainly at the point of
        // typing so send's behavior is never a surprise.
        bits: [
          agentName,
          state.selectedModel || null,
          {
            label: state.chatCwd ? pathBasename(state.chatCwd) : 'server default',
            title: state.chatCwd ? 'change working directory' : ('change working directory (default: ' + (state.serverHome?.cwd || '…') + ')'),
            onClick: () => { state.cwdEditing = true; state.cwdDraft = state.chatCwd || ''; state.cwdError = null; render(); requestAnimationFrame(() => { const inp = document.querySelector('.chat-cwd-input, .agentchat-cwd-input'); if (inp) inp.focus(); }); },
          },
          userTurnCount > 0 ? plural(userTurnCount, 'turn') : null,
          (state.chat.resumeSid && state.selectedAgent === 'claude-code')
            ? 'continues conversation (' + resumeSidLabel(state.chat.resumeSid) + ')'
            : (state.selectedAgent === 'agy' && userTurnCount > 0)
              ? 'continues most recent conversation'
              : null,
        ].filter(Boolean),
      } : undefined,
      // W15: contextual follow-up chips derived from the settled last turn
      // (tool error / code fence / file path), seeded statically otherwise.
      followups: chatFollowups(),
      onFollowupClick: (t) => { if (!canSend()) return; sendChat(t); },
      // Transcript export: copy all / markdown / json.
      exportActions: state.chat.messages.length ? [
        { label: 'copy all', title: 'Copy the whole transcript as markdown', onClick: () => copyText(transcriptToMarkdown(state.chat.messages), 'transcript copied') },
        { label: 'export md', title: 'Download the transcript as markdown', onClick: () => downloadBlob(transcriptToMarkdown(state.chat.messages), 'agentgui-chat-' + dateStamp() + '.md', 'text/markdown') },
        { label: 'export json', title: 'Download the transcript as JSON', onClick: () => downloadBlob(JSON.stringify(state.chat.messages, null, 2), 'agentgui-chat-' + dateStamp() + '.json', 'application/json') },
      ] : [],
      // When the server reports agents but NONE is installed, show install
      // commands inline instead of a dead picker.
      installHint: (state.agents.length && state.agents.every(a => a.available === false)) ? {
        text: 'No agent CLIs found on the server.',
        commands: state.agents.filter(a => a.npxInstallable).map(a => ({ agent: a.name || a.id, command: 'npx ' + (a.npxPackage || a.id) })),
        onRecheck: () => loadAgents(),
      } : undefined,
      // Per-message actions: copy any message; retry the last assistant turn;
      // edit-and-resend a user message (two-step: arm a confirm banner first,
      // since the truncation destroys the later turns).
      onCopyMessage: (m) => copyMessageText(m),
      // Mid-thread retry (gui-completion #7): the kit now offers retry on
      // EVERY assistant turn, not just the last - pass the specific message
      // through so retryTurn truncates from the right position.
      onRetryMessage: (m) => retryTurn(m),
      confirmEdit: true,
      onArmEdit: (m) => armEditAndResend(m),
      onEditMessage: (m) => armEditAndResend(m),
      cwd: state.chatCwd,
      defaultCwd: state.serverHome?.cwd || null,
      cwdEditing: !!state.cwdEditing,
      cwdDraft: state.cwdDraft,
      cwdError: state.cwdError || null,
      cwdChecking: !!state.cwdChecking,
      // Practicality upgrade: allowed roots (one-click starting points, always
      // visible instead of buried in the Files tab's own picker), a small
      // recent-cwd MRU (one-click switch between the handful of directories a
      // user actually works in), and an inline browse popover (click through
      // subdirectories right here instead of round-tripping through Files).
      cwdRoots: (Array.isArray(state.files.roots) && state.files.roots.length)
        ? state.files.roots.map((r) => ({ path: r, label: truncate(projectLabel(r) || r, 14, 24) }))
        : undefined,
      cwdRecent: loadRecentCwds().filter((p) => p !== state.chatCwd),
      cwdBrowse: state.cwdBrowse || undefined,
      // Pasted images upload through the same confined endpoint the Files tab
      // uses, into the chat's current cwd, then insert the resulting relative
      // path into the draft - matching the desktop-composer expectation
      // instead of the prior permanent no-op.
      onPasteFiles: (files) => pastedFilesToChat(files),
      // Dropped files resolve their server-relative path via the confined
      // Files API and insert it into the draft, matching desktop-composer
      // expectations instead of the prior dead-end 'not supported' toast.
      onDropFiles: (files) => pastedFilesToChat(files),
      // The toolbar emoji button opens the SAME inline picker typing ':' does
      // (EMOJI_TRIGGER_RE) - append the trigger character rather than
      // duplicating the picker-open logic, which lives inside the composer.
      onEmoji: () => {
        const draft = state.chat.draft || '';
        state.chat.draft = draft + (draft && !draft.endsWith(' ') ? ' ' : '') + ':';
        render();
      },
      // Long threads render a capped window with a 'show earlier' row (the
      // chat-side equivalent of history's eventsLimit), reset per conversation.
      shownMessages: state.chat.shownMessages || undefined,
      onShowEarlier: (n) => { state.chat.shownMessages = n; render(); },
      onSelectAgent: (v) => selectAgent(v),
      onSelectModel: (v) => selectModel(v),
      onNewChat: newChat,
      onStop: cancelChat,
      onInput: (v) => {
        // The kit's textarea is controlled and reads its live DOM value on send,
        // so re-render only when the draft crosses empty<->non-empty (the only
        // transition that toggles the send button's disabled state).
        const was = !!(state.chat.draft && state.chat.draft.trim());
        const now = !!(v && v.trim());
        state.chat.draft = v;
        debouncedPersistDraft();   // a typed-but-unsent draft survives reload
        if (was !== now) render();
      },
      onSend: (v) => { state.chat.draft = v; sendChat(); },
      onCwdEdit: () => {
        state.cwdEditing = true; state.cwdDraft = state.chatCwd || ''; state.cwdError = null; render();
        requestAnimationFrame(() => { const inp = document.querySelector('.agentchat-cwd-input'); if (inp) inp.focus(); });
        // A fresh user has no way to discover what's even browsable if roots
        // are only fetched on the first "browse" click - prefetch them the
        // moment the editor opens (root-only listDir call, cheap) so the
        // always-visible roots row is populated on the very first open.
        if (!(state.files.roots && state.files.roots.length)) {
          B.listDir(state.backend, '').then((j) => { state.files.roots = j.roots || []; render(); }).catch(() => {});
        }
      },
      onCwdBrowseToggle: () => toggleCwdBrowse(),
      onCwdBrowseCrumb: (i) => cwdBrowseCrumb(i),
      onCwdBrowseEnter: (path) => loadCwdBrowseDir(path),
      onCwdBrowsePick: (path) => cwdBrowsePick(path),
      onCwdSave: async () => {
        let path = (state.cwdDraft ?? '').trim();
        const isAbsolute = /^([/\\]|[A-Za-z]:[/\\])/.test(path);
        // A bare relative subpath (no leading / or drive letter) resolves
        // against the CURRENT chat cwd, not the server process dir - lets a
        // power user type a known subfolder name instead of the full path or
        // opening the browse popover. Only meaningful when a cwd is already
        // set; with no current cwd there's no sensible base to resolve against.
        if (path && !isAbsolute && state.chatCwd) {
          const base = state.chatCwd.replace(/[/\\]+$/, '');
          const sep = state.chatCwd.includes('\\') && !state.chatCwd.includes('/') ? '\\' : '/';
          path = base + sep + path.replace(/^\.[/\\]/, '');
        } else if (path && !isAbsolute) {
          state.cwdError = 'enter an absolute path (e.g. /home/you/proj or C:\\proj), a subfolder name (resolves against the current cwd once one is set), or leave blank';
          render();
          return;
        }
        // Validate against the server: the path must resolve and be a directory.
        if (path) {
          try {
            const st = await B.statPath(state.backend, path);
            if (!st || st.ok === false) { state.cwdError = 'directory not found on the server: ' + path; render(); return; }
            if (!st.dir) { state.cwdError = 'that path is not a directory'; render(); return; }
          } catch (e) {
            state.cwdError = e.status === 403 ? 'outside the accessible folders - use "browse…" or a "recent"/root chip above to pick a reachable one'
              : (e.status === 404 ? 'directory not found on the server: ' + path
              : (e.status ? 'directory not found on the server: ' + path : 'could not validate the path - server unreachable'));
            render();
            return;
          }
        }
        state.cwdError = null;
        state.chatCwd = path;
        if (state.chatCwd) { lsSet('agentgui.cwd', state.chatCwd); pushRecentCwd(state.chatCwd); } else lsRemove('agentgui.cwd');
        state.cwdEditing = false; state.cwdDraft = undefined; state.cwdBrowse = null; render();
      },
      onCwdCancel: () => { state.cwdEditing = false; state.cwdDraft = undefined; state.cwdError = null; state.cwdChecking = false; state.cwdBrowse = null; render(); requestAnimationFrame(() => { const btn = document.querySelector('.agentchat-cwd-btn'); if (btn) btn.focus(); }); },
      onCwdClear: () => { state.chatCwd = ''; lsRemove('agentgui.cwd'); render(); },
      onCwdDraft: (v) => { state.cwdDraft = v; state.cwdError = null; debouncedCwdProbe(); },
    }),
    state.chat.confirmingReloadDiscard ? ConfirmDialog({
      key: 'confreload',
      title: 'Discard unsent draft?',
      message: 'Reloading will discard your unsent draft in this tab. Continue?',
      confirmLabel: 'reload', cancelLabel: 'cancel', destructive: true,
      onCancel: () => { state.chat.confirmingReloadDiscard = false; render(); },
      onConfirm: () => {
        state.chat.confirmingReloadDiscard = false;
        state.chat.externalUpdate = false;
        state.chat.messages = []; state.chat.resumeSid = null; state.chat.totalCost = 0;
        restoreChat(); render();
      },
    }) : null,
  ].filter(Boolean);
}

// Inline cwd-browse popover: a lightweight directory-only listing reusing the
// same confined B.listDir the Files tab uses, but writing to its own
// state.cwdBrowse rather than state.files - opening/closing the cwd browser
// must never disturb whatever the Files tab currently has loaded, and vice
// versa (independent request-id guards against cross-talk if both are open).
let _cwdBrowseReqId = 0;
async function loadCwdBrowseDir(dirPath) {
  const myReq = (_cwdBrowseReqId += 1);
  state.cwdBrowse = { ...(state.cwdBrowse || {}), loading: true };
  render();
  try {
    const j = await B.listDir(state.backend, dirPath || '');
    if (_cwdBrowseReqId !== myReq) return;
    state.cwdBrowse = {
      current: j.path,
      segments: j.segments || [],
      rootLabel: (state.files.roots && state.files.roots.length > 1) ? 'roots' : 'root',
      // Directory-only listing: the cwd picker is for choosing a folder to run
      // in, not for browsing/opening files - filter out non-directory entries.
      entries: (j.entries || []).filter((e) => e.type === 'dir' || e.isDir || e.dir),
      loading: false,
    };
    render();
  } catch (e) {
    if (_cwdBrowseReqId !== myReq) return;
    state.cwdBrowse = { ...(state.cwdBrowse || {}), loading: false, entries: [] };
    render();
  }
}
function toggleCwdBrowse() {
  if (state.cwdBrowse) { state.cwdBrowse = null; render(); return; }
  loadCwdBrowseDir(state.cwdDraft || state.chatCwd || '');
}
function cwdBrowseCrumb(segIdx) {
  if (!state.cwdBrowse || !state.cwdBrowse.segments) return;
  const target = segIdx === 0 ? '' : state.cwdBrowse.segments.slice(0, segIdx).join('/');
  loadCwdBrowseDir(target);
}
// "use this folder" commits the browse popover's CURRENT directory into the
// draft input (leaving the popover open state cleared) so the user still
// confirms via the normal save flow (which re-validates + persists to recent).
function cwdBrowsePick(path) {
  if (!path) return;
  state.cwdDraft = path;
  state.cwdError = null;
  state.cwdBrowse = null;
  debouncedCwdProbe();
  render();
}

function offlineBanner() {
  // A session-expired 401 is a distinct, more actionable case than a plain
  // network-down offline state (the fix is "reload", not "wait for
  // reconnect") - surfaced first since it takes priority as an explanation.
  if (state.sessionExpired) {
    return Alert({ key: 'sessionexpired', kind: 'error', title: 'Session expired',
      children: [
        h('span', { key: 'setxt' }, 'Your access token is no longer valid (it may have rotated or expired). Reload the page to sign in again. '),
        Btn({ key: 'sereload', onClick: () => window.location.reload(), children: 'reload now' }),
      ] });
  }
  if (state.health.status === 'ok' || state.health.status === 'unknown') return null;
  return Alert({ key: 'offline', kind: 'error', title: 'Backend unreachable',
    children: [
      h('span', { key: 'otxt' }, 'agentgui can\'t reach the server (' + (state.health.error || state.health.status) + '). Chat and history actions will fail until it reconnects. '),
      // Previously the only recovery was waiting for the WS backoff timer or
      // a manual page reload - a direct retry button re-probes /health
      // immediately instead of making the user guess how long to wait.
      Btn({ key: 'oretry', disabled: !!state.healthChecking, onClick: () => recheckHealth(), children: state.healthChecking ? 'checking…' : 'retry now' }),
    ] });
}

// (The working-directory bar now lives in the AgentChat kit; agentgui wires its
// cwd state + handlers as kit callbacks in chatMain.)

// Destructive new-chat is two-step with DISTINCT arm/confirm controls: pressing
// 'n' (or the rail action) only ARMS the banner; while armed, repeat presses
// are no-ops and the arm auto-resets after 4s. Confirmation happens exclusively
// via the banner's explicit 'clear' button - a double-tap can never wipe the
// transcript.
let _newChatArmTimer = null;
function newChat() {
  if (state.chat.messages.length) {
    if (state.confirmingNewChat) { render(); return; }   // armed: repeat press is a no-op
    state.confirmingNewChat = true;
    clearTimeout(_newChatArmTimer);
    _newChatArmTimer = setTimeout(() => { state.confirmingNewChat = false; render(); }, ARM_RESET_MS);
    render();
    return;
  }
  confirmNewChat();
}
function confirmNewChat() {
  clearTimeout(_newChatArmTimer);
  state.confirmingNewChat = false;
  state.chat.abort?.abort();
  state.chat = { messages: [], busy: false, abort: null, draft: '', resumeSid: null, usage: null, confirmingEdit: null, totalCost: 0, shownMessages: null };
  lsRemove(CHAT_KEY);
  render();
}

function cancelChat() {
  // Clear busy immediately so the composer re-enables and the "stop" button
  // flips back to "new" without waiting for the stream's finally block.
  state.chat.abort?.abort();
  // Drop a trailing empty assistant shell (aborted before any content) from the
  // live array so the message count + suggestions-empty check stay correct; the
  // paired user message is intentionally kept. A turn stopped mid-content is
  // labeled 'stopped' so truncated output never reads as a finished answer.
  const msgs = state.chat.messages;
  if (msgs.length && isEmptyTurn(msgs[msgs.length - 1])) msgs.pop();
  else if (msgs.length && msgs[msgs.length - 1].role === 'assistant') msgs[msgs.length - 1].stopped = true;
  if (state.chat.busy) { state.chat.busy = false; }
  refreshActive();
  render();
}

// Chat transcript localStorage persistence - extracted to chat-persistence.js
// (vertical slice per AGENTS.md SOLID/Clean-Architecture preferences). The
// factory closes over the SAME live `state` object every other app.js concern
// mutates by reference, so every call site below (persistChat/restoreChat/
// debouncedPersistDraft/isEmptyTurn) keeps working unchanged.
const { persistChat, restoreChat, debouncedPersistDraft, isEmptyTurn } =
  createChatPersistence(state, { announce, scheduleRender, lsGet, lsRemove, debounce });

// Flatten a message's content (string content or md/text/tool parts) to plain
// text for the copy action.
function messageToText(m) {
  if (m.content) return m.content;
  if (!Array.isArray(m.parts)) return '';
  return m.parts.map((p) => {
    if (typeof p === 'string') return p;
    if (p.kind === 'md' || p.kind === 'text') return p.text || '';
    if (p.kind === 'thinking') return '[thinking: ' + (p.text || '') + ']';
    if (p.kind === 'tool') return '[tool: ' + (p.name || '') + (p.label ? ' ' + p.label : '') + ']';
    return '';
  }).filter(Boolean).join('\n');
}
// Shared clipboard helper with an insecure-origin fallback; announces via the
// aria-live region so AT users hear the result.
function copyText(text, msg) {
  if (!text) return;
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => announce(msg)).catch(() => announce('copy failed'));
  else {
    try { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove(); announce(msg); } catch { announce('copy failed'); }
  }
}
function copyMessageText(m) {
  copyText(messageToText(m), 'message copied');
}

// --- transcript export ---
function dateStamp() { return new Date().toISOString().slice(0, 10); }
function downloadBlob(content, filename, type) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function transcriptToMarkdown(messages) {
  return (messages || []).map((m) => {
    const head = '## ' + (m.role === 'user' ? 'User' : 'Assistant') + (m.time ? ' (' + m.time + ')' : '');
    const parts = Array.isArray(m.parts) ? m.parts : [];
    const body = parts.length
      ? parts.map((p) => {
          if (typeof p === 'string') return p;
          if (p.kind === 'md' || p.kind === 'text') return p.text || '';
          if (p.kind === 'thinking') return '> thinking: ' + (p.text || '');
          if (p.kind === 'tool' || p.kind === 'tool_result') {
            const bits = ['## tool: ' + (p.name || 'tool')];
            if (p.args && Object.keys(p.args).length) bits.push('```json\n' + JSON.stringify(p.args, null, 2) + '\n```');
            if (p.result != null) bits.push('```\n' + (typeof p.result === 'string' ? p.result : JSON.stringify(p.result, null, 2)) + '\n```');
            return bits.join('\n');
          }
          return '';
        }).filter(Boolean).join('\n\n')
      : (m.content || '');
    return head + '\n\n' + body;
  }).join('\n\n');
}

// Contextual follow-up chips derived from the settled last assistant turn;
// falls back to the static seeds when nothing contextual applies.
const FOLLOWUP_SEEDS = ['Explain that in more detail', 'Show me the diff', 'Run the tests'];
function chatFollowups() {
  const msgs = state.chat.messages || [];
  if (!msgs.length || state.chat.busy) return [];
  // Memoize: recompute only when the messages array reference changes.
  if (state._followupsCache && state._followupsMsgs === msgs) return state._followupsCache;
  const last = [...msgs].reverse().find(m => m.role === 'assistant');
  if (!last) return [];
  const out = [];
  const parts = Array.isArray(last.parts) ? last.parts : [];
  if (parts.some(p => p && p.kind === 'tool' && p.status === 'error')) out.push('Fix that error');
  const text = messageToText(last);
  if (/```/.test(text) || parts.some(p => p && p.kind === 'code')) out.push('Explain this code');
  const fm = text.match(/([A-Za-z]:\\\S+|\/[\w./-]+\.\w+)/);
  if (fm) {
    const base = fm[1].split(/[/\\]/).filter(Boolean).pop();
    if (base) out.push('Explain ' + base.replace(/[^\w.\-]/g, ''));
  }
  const result = out.length ? out.slice(0, 3) : FOLLOWUP_SEEDS;
  state._followupsMsgs = msgs;
  state._followupsCache = result;
  return result;
}
// Retry the last assistant turn: drop it and re-send the preceding user message.
// Retry a turn: truncates the transcript back to (and resends) the user
// message that preceded the given assistant message, discarding it and
// everything after - the same truncate+resend mechanism edit-and-resend
// uses. `m` is optional (falls back to the trailing assistant turn) so this
// also serves as "retry last turn" for onRetryMessage on a dangling user
// message with no reply yet. Mid-thread retry (any assistant turn, not just
// the last) was a gui-completion #7 finding - the kit's per-message retry
// action is no longer gated to the last message index for assistant turns.
function retryTurn(m) {
  if (state.chat.busy) return;
  const msgs = state.chat.messages;
  let ai = m ? msgs.indexOf(m) : -1;
  if (ai < 0) {
    // Fall back to the trailing assistant turn (no specific message given,
    // or the given message somehow isn't in the current transcript).
    ai = msgs.length - 1;
    while (ai >= 0 && msgs[ai].role !== 'assistant') ai--;
  }
  if (ai < 0) return;
  let ui = ai - 1;
  while (ui >= 0 && msgs[ui].role !== 'user') ui--;
  if (ui < 0) return;
  // Retrying anything before the trailing turn silently discards every LATER
  // turn too - the same destructive-truncation risk edit-and-resend already
  // confirms for, so mid-thread retry gets the identical arm-then-confirm
  // banner instead of firing immediately.
  const discardsLaterTurns = ai < msgs.length - 1;
  if (discardsLaterTurns) {
    state.chat.confirmingEdit = { idx: ui, text: msgs[ui].content || '', kind: 'retry' };
    render();
    return;
  }
  state.chat.confirmingEdit = null;
  executeTruncateAndResend(ui);
}
function executeTruncateAndResend(ui) {
  const msgs = state.chat.messages;
  const userText = msgs[ui].content || '';
  state.chat.messages = msgs.slice(0, ui);
  state.chat.totalCost = computeTotalCost();   // discarded turns leave the spend
  // Never --resume a session whose tail diverged from what the server saw -
  // a mid-thread retry/edit truncates history the resumed session still has.
  state.chat.resumeSid = null;
  state.chat.resumeNote = null;
  state.chat.draft = userText;
  persistChat();
  if (canSend()) sendChat();
  else render();
}
function retryLastTurn() { retryTurn(); }
// Edit-and-resend a user message: two-step. The edit click ARMS a confirmation
// (truncating destroys the later turns), the banner's continue executes it.
function armEditAndResend(m) {
  if (state.chat.busy) return;
  const idx = state.chat.messages.indexOf(m);
  if (idx < 0) return;
  state.chat.confirmingEdit = { idx, text: m.content || messageToText(m) };
  render();
}
function confirmEditAndResend() {
  const ce = state.chat.confirmingEdit;
  if (!ce || state.chat.busy) return;
  state.chat.confirmingEdit = null;
  // Retry resends the SAME text immediately (no edit step); edit-and-resend
  // populates the draft so the user can change it before sending.
  if (ce.kind === 'retry') { executeTruncateAndResend(ce.idx); return; }
  state.chat.messages = state.chat.messages.slice(0, ce.idx);
  state.chat.totalCost = computeTotalCost();   // discarded turns leave the spend
  // Never --resume a session whose tail diverged from what the server saw.
  state.chat.resumeSid = null;
  state.chat.resumeNote = null;
  state.chat.draft = ce.text;
  persistChat();
  render();
  requestAnimationFrame(() => focusComposer());
}
function cancelEditAndResend() {
  state.chat.confirmingEdit = null;
  render();
}

// Compute the conversation's spend from the per-message costUsd markers, so
// edit/retry truncation self-corrects the total (no phantom spend from turns
// that no longer exist in the transcript).
function computeTotalCost() {
  return (state.chat.messages || []).reduce((s, m) => s + (typeof m.costUsd === 'number' ? m.costUsd : 0), 0);
}

// sendChat(text) sends an explicit text (suggestion/followup chips) WITHOUT
// touching the typed draft; with no argument it sends + clears the draft.
async function sendChat(textArg) {
  const text = ((textArg != null ? textArg : state.chat.draft) || '').trim();
  if (!text || !canSend()) return;
  // The conversation is moving on: any armed edit-and-resend confirm refers to
  // an index that is about to be stale - disarm it.
  state.chat.confirmingEdit = null;
  const t = timeNow();
  const userMsg = { id: 'u' + Date.now(), role: 'user', content: text, time: t };
  const curMsg = { id: 'a' + (Date.now() + 1), role: 'assistant', content: '', time: t, parts: [] };
  state.chat.messages = [...state.chat.messages, userMsg, curMsg];
  if (textArg == null) state.chat.draft = '';
  state.chat.busy = true;
  // Open the live stream + refresh the active list right away so the rail and
  // dashboard reflect this turn without waiting for the 3s poll.
  openLiveStream();
  refreshActive();
  const ctrl = new AbortController();
  state.chat.abort = ctrl;
  persistChat();
  render();
  scrollChatToBottom();
  const cur = state.chat.messages[state.chat.messages.length - 1];
  try {
    for await (const ev of B.streamChat(state.backend, {
      agentId: state.selectedAgent,
      model: state.selectedModel || undefined,
      cwd: state.chatCwd || undefined,
      // Non-resume agents receive a flattened transcript (tool parts become text summaries).
      // Claude-code uses --resume and ignores this array; it is only used by direct/ACP agents.
      // NOTE: only m.content (or its text equivalent) is sent here - tool_use/tool_result
      // parts are intentionally flattened to text so non-claude-code agents receive a
      // readable transcript rather than raw API objects they cannot process.
      messages: state.chat.messages.slice(0, -1).map(m => ({ role: m.role, content: m.content || messageToText(m) })),
      signal: ctrl.signal,
      // claude-code consumes a literal --resume <sid>; agy's --continue is a
      // boolean 'resume most-recent conversation' flag (it ignores the sid
      // value entirely, see lib/claude-runner-agents.js), so any truthy value
      // is enough to opt agy into continuity once this chat has a prior turn.
      resumeSid: state.selectedAgent === 'claude-code'
        ? (state.chat.resumeSid || undefined)
        : (state.selectedAgent === 'agy' && state.chat.messages.length > 2 ? true : undefined),
    })) {
      // After a stop, the iterator drains buffered events for a turn the user
      // aborted - applying them would set resumeSid / accrue cost / write text
      // into a popped shell. A stopped turn applies no further state.
      if (ctrl.signal.aborted) break;
      if (ev.type === 'session') {
        // Remember the server's session id so the NEXT turn resumes this
        // conversation instead of cold-spawning. Only claude-code supports
        // --resume by id; for other agents we leave resumeSid unset.
        if (state.selectedAgent === 'claude-code' && ev.sessionId) {
          state.chat.resumeSid = ev.sessionId;
          persistChat();
        }
      }
      else if (ev.type === 'text')  { appendText(cur.parts, ev.text); scheduleStreamRender(); }
      else if (ev.type === 'thinking') { cur.parts.push({ kind: 'thinking', text: ev.text }); scheduleStreamRender(); }
      else if (ev.type === 'tool') { cur.parts.push(toolPart(ev.block)); scheduleStreamRender(); }
      else if (ev.type === 'tool_result') { applyToolResult(cur.parts, ev.block); scheduleStreamRender(); }
      else if (ev.type === 'result') {
        // The terminal result block carries claude's turn usage (token counts,
        // cost, turns, duration). The prose is already streamed via text events;
        // capture the usage so the ContextPane can surface it (was dropped).
        const b = ev.block || {};
        const u = b.usage || {};
        const inTok = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        const outTok = u.output_tokens || 0;
        state.chat.usage = {
          inputTokens: inTok || null,
          outputTokens: outTok || null,
          costUsd: typeof b.total_cost_usd === 'number' ? b.total_cost_usd : null,
          turns: b.num_turns != null ? b.num_turns : null,
          durationMs: b.duration_ms != null ? b.duration_ms : null,
        };
        // Per-message cost markers; the session total is DERIVED from the
        // visible messages so edit/retry truncation self-corrects the spend.
        const cost = typeof b.total_cost_usd === 'number' ? b.total_cost_usd : (typeof u.cost === 'number' ? u.cost : 0);
        if (cost) { cur.costUsd = (cur.costUsd || 0) + cost; state.chat.totalCost = computeTotalCost(); }
        scheduleStreamRender();
      }
      else if (ev.type === 'cancelled') {
        // Remote stop (another tab / dashboard): label the turn stopped so the
        // truncated output never reads as a finished answer.
        cur.stopped = true;
        announce('generation stopped');
        scheduleStreamRender();
      }
      else if (ev.type === 'error') { cur.error = errText(ev.error); cur.errorRaw = errTextRaw(ev.error); render(); }
    }
  } catch (e) {
    if (e.name !== 'AbortError') { cur.error = errText(e); cur.errorRaw = errTextRaw(e); }
  } finally {
    state.chat.busy = false;
    state.chat.abort = null;
    // Prune an empty assistant shell (WS-drop before any content arrived).
    const msgs = state.chat.messages;
    if (msgs.length && isEmptyTurn(msgs[msgs.length - 1])) msgs.pop();
    persistChat();
    refreshActive();   // settle the running panel/dashboard now, not at the next poll
    render();
    scrollChatToBottom();
  }
}

// Validate the cwd draft while editing (debounced) so an invalid path reads as
// invalid before the save click, via the existing confined /api/stat endpoint.
const debouncedCwdProbe = debounce(async () => {
  const raw = (state.cwdDraft ?? '').trim();
  if (!state.cwdEditing) return;
  const isAbsolute = /^([/\\]|[A-Za-z]:[/\\])/.test(raw);
  let path = raw;
  if (raw && !isAbsolute && state.chatCwd) {
    // Mirror onCwdSave's relative-subpath resolution so the live-typing hint
    // reflects the same interpretation the save button will actually apply.
    const base = state.chatCwd.replace(/[/\\]+$/, '');
    const sep = state.chatCwd.includes('\\') && !state.chatCwd.includes('/') ? '\\' : '/';
    path = base + sep + raw.replace(/^\.[/\\]/, '');
  } else if (raw && !isAbsolute) {
    state.cwdChecking = false; render(); return;   // no cwd to resolve against yet - onCwdSave surfaces the error on save
  } else if (!raw) {
    state.cwdChecking = false; render(); return;
  }
  state.cwdChecking = true; render();
  const probed = raw;   // compare against the RAW (unresolved) draft to detect staleness
  try {
    const st = await B.statPath(state.backend, path);   // query the RESOLVED absolute path
    if ((state.cwdDraft ?? '').trim() !== probed) return;   // draft moved on
    state.cwdError = (!st || st.ok === false) ? 'folder not found on the server'
      : (!st.dir ? 'that path is not a directory' : null);
  } catch (e) {
    if ((state.cwdDraft ?? '').trim() !== probed) return;
    state.cwdError = e.status === 403 ? 'outside the accessible folders - try "browse…" or a chip above'
      : (e.status === 404 ? 'folder not found on the server' : null);
  }
  state.cwdChecking = false;
  render();
}, 400);

// --- history ---
function reconnectAlert() {
  if (!state.live.error) return null;
  return Alert({
    key: 'liveerr',
    kind: 'error',
    title: 'Live stream offline',
    children: [h('span', { key: 'lemsg' }, state.live.error + ' - '), Btn({ key: 'reco', onClick: openLiveStream, children: 'reconnect', title: 'Reconnect to history stream' })],
  });
}

// Inline fallback for the fmtDuration kit export (line 11 references humanizeMs
// as the local fallback when the kit does not export fmtDuration yet).
function humanizeMs(ms) {
  if (ms == null || !isFinite(ms) || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + 's';
  if (s < 3600) return Math.floor(s / 60) + 'm ' + (s % 60) + 's';
  return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm';
}

// First-to-last event timestamp span for the selected session, humanized.
function sessionDuration() {
  const ts = (state.events || []).map(e => e.ts).filter(Boolean);
  if (ts.length < 2) return '';
  return fmtDuration(ts.reduce((a, b) => b > a ? b : a, ts[0]) - ts.reduce((a, b) => b < a ? b : a, ts[0]));
}

// Event-type filter predicate (all | text | tool | errors | thinking).
function eventMatchesFilter(e, f) {
  if (f === 'tool') return e.type === 'tool_use' || e.type === 'tool_result';
  if (f === 'errors') return !!e.isError;
  if (f === 'thinking') return e.type === 'thinking';
  // text excludes thinking events so they don't appear under a non-dedicated filter.
  if (f === 'text') return !e.isError && e.type !== 'tool_use' && e.type !== 'tool_result' && e.type !== 'thinking';
  return true;
}

// Scroll to + flash the first error event, widening the render window (and
// clearing the type filter) so the row is actually rendered.
// History tab (session list, event viewer, search) - extracted to
// history.js. Local names kept identical to every existing call site.
const { jumpToEvent, jumpToFirstError, jumpToNextError, historyMain, refreshHistory: _refreshHistory, runSearch: _runSearch, loadSession } = createHistory(state, () => render(), B, {
  h, PageHeader, ShortcutList, Btn, Panel, EventList, FilterPills, SessionMeta,
  SHORTCUTS, UNTITLED_CONVERSATION,
  reconnectAlert, agentById, projectLabel, pathBasename, plural, fmtRelTime, truncate,
  eventMatchesFilter, sessionDuration, resumeInChat, downloadBlob, toolLabel, copyText,
  pushRecentCwd, announce, lsSet, errText, writeHash,
  getCopyToast: () => copyToast, copySid: (...args) => copySid(...args),
});

let copyToast = null;
// Hold the toast long enough to read (2.5s); the copy button label is inside a
// role=status region (history-actions) so AT announces the change.
let _copyToastTimer = null;
function setCopyToast(msg) {
  copyToast = msg; render();
  // One timer per invocation: a rapid second copy must not have its feedback
  // truncated by the first copy's expiring timeout.
  clearTimeout(_copyToastTimer);
  _copyToastTimer = setTimeout(() => { copyToast = null; render(); }, 2500);
}
function copySid() {
  const sid = state.selectedSid;
  if (!sid) return;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(sid).then(() => setCopyToast('copied')).catch(() => setCopyToast('copy failed'));
  } else {
    // Fallback for insecure (http) origins where navigator.clipboard is absent.
    try {
      const ta = document.createElement('textarea');
      ta.value = sid; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
      setCopyToast('copied');
    } catch { setCopyToast('copy failed'); }
  }
}

function resumeInChat(sess, { fromHash = false } = {}) {
  state.tab = 'chat';
  closeLiveStream();
  state.chat.resumeSid = sess?.sid || state.selectedSid;
  // Carry the sid on the chat tab too (tab=chat&sid=...) so reload/Back
  // restores the resumed conversation rather than a blank chat.
  state.selectedSid = state.chat.resumeSid || state.selectedSid;
  if (!fromHash) writeHash({ push: true });
  state.chat.messages = [];
  state.chat.totalCost = 0;
  state.chat.shownMessages = null;
  state.chat.draft = '';
  // Only claude-code supports --resume by sid; warn if we have to switch the
  // user's selected agent rather than silently discarding it.
  if (state.selectedAgent && state.selectedAgent !== 'claude-code') {
    state.chat.resumeNote = 'Switched to Claude Code - only it supports resuming a session by id.';
  } else {
    state.chat.resumeNote = null;
  }
  if (state.selectedAgent !== 'claude-code') selectAgent('claude-code');
  render();
  // Load prior turns from history so the user can re-read context inline.
  const sidToLoad = state.chat.resumeSid;
  if (sidToLoad) {
    state.chat.loadingTranscript = true;
    render();
    B.getSessionEvents(state.backend, sidToLoad).then(evs => {
      // Only populate if still on the same resume (user may have switched).
      if (state.chat.resumeSid !== sidToLoad || state.chat.messages.length) return;
      // Replay the FULL event history (not a fixed-size slice of raw events -
      // a slice taken before filtering to human/assistant turns can leave only
      // a couple of visible messages on a long thread). The kit's own
      // shownMessages/onShowEarlier windowing (wired above) handles the
      // "load earlier" pagination the same way History's eventsLimit does.
      const msgs = [];
      let cur = null; // the in-progress assistant message, so interleaved
                       // tool_use/tool_result/text events land on one bubble
                       // instead of one bubble per event.
      let totalCost = 0; // ccsniff's stored 'result' events already carry the
                          // real total_cost_usd (as e.cost) - the live path
                          // sums these as they stream in, but a resumed
                          // historical session never re-derived it, leaving
                          // totalCost stuck at 0 regardless of turn/tool count.
      for (const e of (evs || [])) {
        if (e.type === 'human' || e.role === 'user') {
          cur = null;
          const text = e.text || e.content || '';
          if (text) msgs.push({ id: 'rh' + e.ts, role: 'user', content: text, time: e.ts, historical: true });
        } else if (e.type === 'tool_use') {
          if (!cur) { cur = { id: 'ra' + e.ts, role: 'assistant', content: '', time: e.ts, parts: [], historical: true }; msgs.push(cur); }
          cur.parts.push(toolPart({ name: e.tool, input: e.toolInput, id: e.toolUseId || e.id }));
        } else if (e.type === 'tool_result') {
          if (!cur) { cur = { id: 'ra' + e.ts, role: 'assistant', content: '', time: e.ts, parts: [], historical: true }; msgs.push(cur); }
          applyToolResult(cur.parts, { tool_use_id: e.toolUseId || e.id, content: e.text, is_error: e.isError });
        } else if (e.type === 'result') {
          if (typeof e.cost === 'number') totalCost += e.cost;
        } else if (e.type === 'assistant' || e.role === 'assistant') {
          const text = e.text || '';
          if (!text) continue;
          if (!cur) { cur = { id: 'ra' + e.ts, role: 'assistant', content: '', time: e.ts, parts: [], historical: true }; msgs.push(cur); }
          appendText(cur.parts, text);
        }
      }
      if (state.chat.resumeSid === sidToLoad && !state.chat.messages.length) {
        // Attach the summed cost to the last message's costUsd (rather than a
        // side-channel field) so computeTotalCost() - which every subsequent
        // send/discard recomputes from message.costUsd - naturally includes
        // it instead of silently resetting it back to 0 on the next turn.
        if (totalCost > 0) {
          const last = msgs[msgs.length - 1];
          if (last) last.costUsd = (last.costUsd || 0) + totalCost;
        }
        state.chat.messages = msgs;
        state.chat.totalCost = computeTotalCost();
      }
    }).catch(() => {}) // history may not be available; silent fail
    .finally(() => {
      if (state.chat.resumeSid === sidToLoad) state.chat.loadingTranscript = false;
      render();
    });
  }
}

function visibleSessions() {
  const arr = Array.isArray(state.sessions) ? state.sessions : [];
  let filtered = state.showSubagents ? arr : arr.filter(s => !s.isSubagent);
  if (state.projectFilter) {
    const pf = state.projectFilter.toLowerCase();
    filtered = filtered.filter(s => (s.project || '').toLowerCase().includes(pf));
  }
  return filtered.slice().sort((a, b) => (b.last || 0) - (a.last || 0));
}

// ccsniff derives `project` from the ~/.claude/projects dir name, which encodes
// the cwd as a dash-joined path (e.g. "-config-workspace-agentgui"). Show the
// last meaningful segment ("agentgui") rather than the raw slug.
function projectLabel(project) {
  if (!project) return '';
  if (/[/\\]/.test(project)) return project.split(/[/\\]/).filter(Boolean).pop() || project;
  const segs = project.split('-').filter(Boolean);
  return segs.length ? segs[segs.length - 1] : project;
}

// Resume banner/turn-continuation copy previously showed a raw sid slice with
// no way to tell which conversation it refers to - prefer the same human
// label used everywhere else in the rail, falling back to the sid slice.
function resumeSidLabel(sid) {
  if (!sid) return '';
  const arr = Array.isArray(state.sessions) ? state.sessions : [];
  const sess = arr.find((s) => s.sid === sid);
  const label = sess && (projectLabel(sess.title) || projectLabel(sess.project));
  return label || UNTITLED_CONVERSATION;
}

// Same identity contract as the sessions rail/history rail/Live SessionCard:
// a running row must show the resolved conversation title, not just agent
// metadata - otherwise the same session reads as "nameless" here and named
// everywhere else.
function runningRowTitle(r) {
  const realSid = r.claudeSessionId || r.sessionId;
  const arr = Array.isArray(state.sessions) ? state.sessions : [];
  const sess = arr.find((s) => s.sid === realSid);
  // A brand-new session (started <3s ago) with no index row yet is still
  // BEING indexed, not permanently untitled - same carve-out and threshold
  // computeLiveSessions() uses, so the identical session doesn't read
  // "Untitled conversation" here and "indexing…" on the Live dashboard.
  if (!sess && r.startedAt && (Date.now() - r.startedAt < 3000)) return 'indexing…';
  return resumeSidLabel(realSid);
}

function uniqueProjects() {
  const arr = Array.isArray(state.sessions) ? state.sessions : [];
  const seen = new Map();
  for (const s of arr) {
    if (!s.project) continue;
    seen.set(s.project, (seen.get(s.project) || 0) + 1);
  }
  return Array.from(seen.entries()).sort((a, b) => b[1] - a[1]);
}

// The running-chats panel: in-flight chats with per-session stop. Shown on the
// history sidebar AND the chat tab, so a chat started then navigated-away-from
// stays visible and stoppable from anywhere (active polling is global).
function runningPanel() {
  const running = Array.isArray(state.active) ? state.active : [];
  if (!running.length) {
    // A send is in flight but the active-session poll hasn't caught up yet
    // (up to ~3s) - without this, the Live tab's existence is undiscoverable
    // during that gap even though the chat is, in fact, already running.
    if (state.chat.busy) {
      return Panel({
        key: 'runningPanelPending',
        title: 'running',
        children: [h('div', { key: 'runpending', class: 'resume-banner', role: 'group' },
          h('span', { key: 'runpendinglbl', class: 't-meta' }, 'this chat will also appear in live once it starts'),
          Btn({ key: 'runpendinglive', onClick: () => navTo('live'), children: 'view live' }))],
      });
    }
    return null;
  }
  const stopping = state.live.stopping || new Set();
  return Panel({
    key: 'runningPanel',
    title: 'all running sessions · ' + running.length + (state._activeStale ? ' (refreshing…)' : ''),
    children: [
      // A discoverable path from "this running chat" to the management surface.
      h('div', { key: 'runall', class: 'resume-banner', role: 'group' },
        h('span', { key: 'runalllbl', class: 't-meta' }, 'manage all running sessions'),
        Btn({ key: 'runalllive', onClick: () => navTo('live'), children: 'view all in live' })),
      ...running.map((r) => {
        const agentName = agentById(r.agentId)?.name || r.agentId || 'agent';
        const elapsedMs = r.startedAt ? Math.max(0, Date.now() - r.startedAt) : 0;
        const isStopping = stopping.has(r.sessionId);
        // All children must be keyed VElements (mixing a keyed span with an
        // unkeyed one crashes webjsx applyDiff "reading 'key'").
        return h('div', { key: 'run' + r.sessionId, class: 'resume-banner', role: 'group' },
          h('span', { key: 'rd-' + r.sessionId, class: 'status-dot-disc ' + (isStopping ? 'status-dot-connecting' : 'status-dot-live'), 'aria-hidden': 'true' }),
          h('span', { key: 'rl-' + r.sessionId, class: 't-meta' }, runningRowTitle(r) + ' · ' + agentName + (r.model ? ' · ' + r.model : '') + (elapsedMs ? ' · ' + fmtDuration(elapsedMs) : '') + (r.cwd ? ' · ' + pathBasename(r.cwd) : '')),
          Btn({ key: 'open' + r.sessionId, onClick: () => navTo('live'), children: 'open in live' }),
          Btn({ key: 'stop' + r.sessionId, disabled: isStopping, onClick: () => stopActiveChat(r.sessionId), children: isStopping ? 'stopping…' : 'stop' }));
      }),
    ],
  });
}

// --- settings ---
function isValidUrl(s) {
  if (!s) return true; // blank = same-origin is valid
  try {
    // Only add http:// prefix for schemeless inputs (no ://); inputs with an
    // explicit non-http scheme (ftp://, ws://) must fail the protocol check.
    const u = new URL(s.includes('://') ? s : 'http://' + s);
    return u.protocol === 'http:' || u.protocol === 'https:'; // reject ftp:/ws:/etc
  } catch { return false; }
}

// Canonicalize a backend URL to its origin so a schemeless 'localhost:3000'
// (which would otherwise be stored raw and resolved against the page origin)
// becomes the same string we validated. Blank stays blank (same-origin).
function normalizeBackend(s) {
  if (!s) return '';
  try { return new URL(s.includes('://') ? s : 'http://' + s).origin; }
  catch { return s; }
}

async function saveBackend() {
  if (!isValidUrl(state.backendDraft)) return;
  // Block a mid-stream backend switch: the in-flight fetch is bound to the old
  // origin and will error or produce split state if the backend changes under it.
  if (state.chat.busy) {
    state.backendError = 'A chat is in progress - stop it before switching backends.';
    render();
    return;
  }
  // Re-submitting the current URL (e.g. after a failed health check) re-runs
  // the health probe and shows connecting… so the user gets visible feedback.
  if (state.backendDraft === state.backend) { state.backendStatus = 'connecting'; render(); await recheckHealth(); return; }
  // Switching backend orphans the local chat transcript (it belongs to the old
  // server's sessions). Confirm once if there's a transcript to lose - and the
  // confirmation binds to the EXACT value confirmed: editing the URL after
  // arming re-arms instead of executing under a stale confirmation.
  if (state.chat.messages.length && state.confirmingBackend !== state.backendDraft) {
    state.confirmingBackend = state.backendDraft; render(); return;
  }
  state.confirmingBackend = undefined;
  const canonical = normalizeBackend(state.backendDraft);
  // Probe the candidate URL before committing: fetch /health and verify it's
  // an agentgui server (status:'ok' + version field). Reject with an error if
  // the probe fails or returns a non-agentgui response.
  if (canonical) {
    state.backendStatus = 'connecting';
    render();
    try {
      const probeUrl = canonical.replace(/\/$/, '') + '/health';
      const pr = await fetch(probeUrl, { signal: AbortSignal.timeout(5000) });
      if (!pr.ok) throw new Error('server returned ' + pr.status);
      const pj = await pr.json();
      if (pj.status !== 'ok' || !pj.version) throw new Error('not an agentgui server');
    } catch (e) {
      state.backendStatus = 'failed';
      state.backendError = e.message || 'not an agentgui server';
      render();
      return;
    }
  }
  state.backendError = undefined;
  state.backendDraft = canonical;
  B.setBackend(canonical);
  state.backend = canonical;
  state.health = { status: 'unknown' };
  state.backendStatus = 'connecting';
  render();
  await init();
  state.backendStatus = state.health.status === 'ok' ? 'ok' : 'failed';
  render();
}

function healthSummary() {
  const hh = state.health || {};
  const ok = hh.status === 'ok';
  // Each chip carries a title so its meaning isn't left to inference.
  const bits = [];
  // Use the same connection vocabulary as the crumb status dot
  // (connected/offline/connecting) so the same state reads the same word
  // everywhere, instead of the raw health.status ('ok'/'down').
  const connWord = hh.status === 'ok' ? 'connected'
    : hh.status === 'unknown' ? 'connecting…'
    : 'offline';
  bits.push([connWord, 'Backend connection status']);
  if (hh.version) bits.push(['v' + hh.version, 'Server version']);
  if (typeof hh.agents === 'number') bits.push([hh.agents + ' agents', 'Agents registered on the server']);
  if (typeof hh.activeExecutions === 'number') bits.push([hh.activeExecutions + ' active', 'Chats currently executing']);
  // db chip uses the SAME connected/offline register as the connection chip
  // above (not ok/down, and not a third online/offline register) so the same
  // up/down category of fact reads the same word in both chips of this row.
  // Always render it: when /health is partial and hh.db is absent, show
  // 'db unknown' rather than dropping the chip and leaving the db state ambiguous.
  // Only show 'db unknown' when health has been fetched (not on initial null/unknown state).
  if (hh.status && hh.status !== 'unknown') {
    bits.push(['db ' + (hh.db ? (hh.db.ok ? 'connected' : 'offline') : 'unknown'), 'History database status']);
  } else if (hh.db) {
    bits.push(['db ' + (hh.db.ok ? 'connected' : 'offline'), 'History database status']);
  }
  return h('div', { key: 'hp', class: 'health-summary' + (ok ? ' health-ok' : ''), role: 'group', 'aria-label': 'Backend health' },
    ...bits.map(([b, t], i) => h('span', { key: 'hb' + i, class: 'health-chip', title: t }, b)));
}

function settingsMain() {
  const ok = state.health.status === 'ok';
  const isValid = isValidUrl(state.backendDraft);
  return [
    PageHeader({
      compact: true,
      dense: true,
      title: 'Settings',
      // The page lede describes the PAGE; the backend explanation lives in the
      // backend panel where it applies.
      lede: 'Connection, agents, appearance, keyboard, and local data.',
    }),
    state.health.corsWildcardOpen
      ? Alert({ key: 'cors-open-warn', kind: 'error', title: 'Open CORS with no password',
          children: 'This server allows requests from any origin (CORS_ORIGIN=*) with no PASSWORD set - any page a user visits in their browser can read and modify this filesystem. Set PASSWORD or restrict CORS_ORIGIN to a specific origin.' })
      : null,
    h('div', { key: 'settings-grid', class: 'settings-grid' }, [
    Panel({
      id: 'backend',
      title: 'backend',
      children: h('form', {
        key: 'backendForm',
        onSubmit: (e) => { e.preventDefault(); saveBackend(); },
      }, [
        h('p', { key: 'blede', class: 't-meta agentgui-field-mb',
          title: 'Also settable with a ?backend= URL parameter; the value persists in this browser.' },
          'Connect to a different agentgui server. Leave blank to use this one.'),
        TextField({
          key: 'backendField',
          label: 'backend url',
          value: state.backendDraft,
          placeholder: '(blank = same origin)',
          error: !isValid ? 'Invalid URL format' : undefined,
          title: isValid ? 'Enter a valid URL or leave blank for same-origin' : 'Invalid URL format',
          onInput: (v) => {
            state.backendDraft = v;
            // The armed confirmation refers to a different value now - disarm.
            if (state.confirmingBackend !== undefined && state.confirmingBackend !== v) state.confirmingBackend = undefined;
            // Clear stale probe results so the old error doesn't persist while typing.
            state.backendError = undefined;
            if (state.backendStatus === 'failed') state.backendStatus = undefined;
            render();
          },
        }),
        state.backendStatus === 'connecting' ? h('span', { key: 'bst-connecting', class: 'ds-status-chip', role: 'status' }, 'connecting…') : null,
        state.backendStatus === 'ok' ? h('span', { key: 'bst-ok', class: 'ds-status-chip ds-status-chip-ok', role: 'status' }, 'connected') : null,
        state.backendStatus === 'failed' ? h('span', { key: 'bst-failed', class: 'ds-status-chip ds-status-chip-error', role: 'alert' }, 'connection failed - check the URL') : null,
        (state.confirmingBackend !== undefined && state.confirmingBackend === state.backendDraft && isValid && state.backendDraft !== state.backend)
          ? h('p', { key: 'bcw', class: 't-meta field-error', role: 'alert' }, 'changing backend discards this browser\'s chat transcript - press save again to confirm') : null,
        healthSummary(),
        Btn({
          key: 'savebtn',
          type: 'submit',
          primary: true,
          disabled: !isValid || state.backendStatus === 'connecting',
          onClick: (e) => { e.preventDefault(); saveBackend(); },
          children: state.backendStatus === 'connecting' ? 'connecting…' : 'save + reconnect',
          title: isValid ? 'Save backend URL and reconnect' : 'Fix URL format first',
        }),
      ]),
    }),
    // Panel order: connection group (backend + server) first, then agents,
    // then personal preferences (appearance / keyboard / data).
    serverPanel(),
    agentsPanel(),
    Panel({
      id: 'appearance',
      title: 'appearance',
      kind: 'wide',
      children: [
        h('div', { key: 'apl', class: 't-meta agentgui-field-mb' }, 'theme - follows the OS in auto, or pick light/dark.'),
        ThemeToggle({ key: 'tt' }),
      ],
    }),
    keyboardPanel(),
    preferencesPanel(),
    ]),
  ];
}

// Server info from /health: version, uptime, ws clients, allowed roots (with
// per-root copy), projects dir. Renders unknowns plainly rather than hiding.
function serverPanel() {
  const hh = state.health || {};
  const roots = Array.isArray(hh.allowRoots) ? hh.allowRoots : [];
  const upMs = hh.uptimeMs != null ? hh.uptimeMs : (hh.uptime != null ? hh.uptime * 1000 : null);
  const wsClients = hh.wsClients != null ? hh.wsClients : (hh.clients != null ? hh.clients : null);
  // The very first health probe is in flight (not yet failed, not yet
  // succeeded): 'checking…' reads as progress, 'unknown' reads as a
  // permanent fact about the server - only the first is true here.
  const fallback = (hh.status === 'unknown' && state.healthChecking) ? 'checking…' : 'unknown';
  // These facts previously each rendered as their own '.lede' paragraph -
  // .lede is the fs-xl/tall-line-height INTRO-paragraph style, not a metadata
  // style, so four short facts read as four oversized paragraphs with a lot
  // of dead vertical space between them. One compact SessionMeta strip
  // (already used for the roots list right below) gives all server facts a
  // consistent, denser reading - same information, a fraction of the height.
  const facts = [
    { label: 'version', value: hh.version ? 'v' + hh.version : fallback },
    { label: 'uptime', value: upMs != null ? fmtDuration(upMs) : fallback },
    { label: 'connected clients', value: wsClients != null ? String(wsClients) : fallback },
    { label: 'projects folder', value: hh.projectsDir || fallback, title: hh.projectsDir || undefined,
      onCopy: hh.projectsDir ? () => copyText(hh.projectsDir, 'projects folder copied') : undefined },
  ];
  return Panel({
    id: 'server',
    title: 'server',
    children: [
      SessionMeta({ key: 'sfacts', items: facts }),
      roots.length
        ? SessionMeta({ key: 'sroots', items: roots.map((r, i) => ({ label: 'root ' + (i + 1), value: r, title: r, onCopy: () => copyText(r, 'root copied') })) })
        : (hh.status && hh.status !== 'unknown' ? h('div', { key: 'snoroots', class: 't-meta' }, 'accessible folders: none configured') : null),
    ],
  });
}

// The keyboard panel consumes the same SHORTCUTS definition as the ?-overlay.
function keyboardPanel() {
  return Panel({
    id: 'keyboard',
    title: 'keyboard',
    kind: 'wide',
    children: ShortcutList({ shortcuts: SHORTCUTS }),
  });
}

function clearLocalData() {
  if (!state.confirmingClearData) { state.confirmingClearData = true; render(); return; }
  state.confirmingClearData = false;
  // Wipe agentgui's own localStorage keys (chat transcript, agent/model/cwd,
  // backend). Then reload: clearing only the keys but leaving the in-memory
  // selectedAgent/Model/chatCwd/backend would let the next interaction
  // re-persist them, so the "clear" wouldn't survive. A reload re-inits from
  // defaults with the keys gone.
  state.chat.abort?.abort(); // stop any in-flight stream before we drop the page
  for (const k of ['agentgui.chat', 'agentgui.agent', 'agentgui.model', 'agentgui.cwd', 'agentgui.backend', 'agentgui.live', 'agentgui.files']) lsRemove(k);
  // Also wipe kit WorkspaceShell layout keys (collapse state + resizer widths).
  try { for (let i = localStorage.length - 1; i >= 0; i--) { const k = localStorage.key(i); if (k && k.startsWith('ds.ws.')) localStorage.removeItem(k); } } catch {}
  state.chat = { messages: [], busy: false, abort: null, draft: '', resumeSid: null, confirmingEdit: null, totalCost: 0 };
  location.reload();
}

// navigator.storage.estimate() is async - fetch once (per settings visit,
// not per render) and cache the result in state; a fresh fetch every render
// would be wasteful and the number doesn't need to be live-updating.
let _storageEstimateFetched = false;
function fetchStorageEstimateOnce() {
  if (_storageEstimateFetched) return;
  _storageEstimateFetched = true;
  if (!(navigator.storage && navigator.storage.estimate)) { state._storageEstimate = { unsupported: true }; return; }
  navigator.storage.estimate().then((est) => { state._storageEstimate = est; render(); }).catch(() => { state._storageEstimate = { unsupported: true }; });
}
function storageEstimateRow() {
  fetchStorageEstimateOnce();
  const est = state._storageEstimate;
  if (!est) return h('div', { key: 'storageest', class: 't-meta agentgui-field-my' }, 'browser storage: checking…');
  if (est.unsupported) return null;   // Safari/older browsers - no estimate API, no row rather than a broken one
  const used = fmtBytes(est.usage || 0);
  const quota = est.quota ? fmtBytes(est.quota) : null;
  return h('div', { key: 'storageest', class: 't-meta agentgui-field-my' },
    'browser storage (this origin, all sources): ' + used + (quota ? ' of ' + quota + ' available' : ''));
}
function preferencesPanel() {
  const hh = state.health || {};
  const savedChat = lsGet(CHAT_KEY);
  // Footprint of agentgui's own localStorage keys.
  let lsKeys = 0, lsBytes = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('agentgui.')) { lsKeys++; lsBytes += (localStorage.getItem(k) || '').length; }
    }
  } catch {}
  return Panel({
    id: 'data',
    title: 'data',
    kind: 'wide',
    children: [
      // The server version lives in the server panel; carry only a build stamp
      // here, and only when it differs from the server version.
      (window.__SERVER_VERSION && window.__SERVER_VERSION !== hh.version)
        ? h('div', { key: 'ver', class: 't-meta' }, 'build ' + window.__SERVER_VERSION)
        : null,
      h('div', { key: 'lsize', class: 't-meta agentgui-field-my' },
        'local data: ' + fmtBytes(lsBytes) + ' across ' + lsKeys + ' key' + (lsKeys === 1 ? '' : 's')),
      // agentgui's own localStorage keys are only PART of what this origin
      // accumulates - the markdown-highlighting CDN scripts (marked/dompurify/
      // prismjs) and any browser HTTP cache add to real storage usage with no
      // visibility at all previously. navigator.storage.estimate() surfaces
      // the origin's actual total-vs-quota figure alongside the known-keys
      // breakdown, so "why is my browser storage full" has an actual answer.
      storageEstimateRow(),
      h('div', { key: 'expchatrow', class: 'agentgui-field-my' },
        Btn({ key: 'expchat', disabled: !savedChat,
          title: savedChat ? 'Download the saved chat transcript as JSON' : 'no saved conversation yet',
          onClick: savedChat ? () => downloadBlob(savedChat, 'agentgui-chat-' + dateStamp() + '.json', 'application/json') : undefined,
          children: 'export conversation' })),
      h('div', { key: 'cwdnote', class: 't-meta agentgui-field-my' },
        'working directory: set per-chat in the chat composer\'s cwd bar' + (state.chatCwd ? ' (current: ' + state.chatCwd + ')' : ' (currently: server default)')),
      state.confirmingClearData
        ? Alert({ key: 'cld', kind: 'warn', title: 'Clear all local data?',
            children: [
              h('span', { key: 'cldtxt' }, 'Removes saved chat, agent/model/cwd, backend, and layout preferences from this browser. This cannot be undone. '),
              Btn({ key: 'cldno', onClick: () => { state.confirmingClearData = false; render(); }, children: 'cancel' }),
              Btn({ key: 'cldyes', danger: true, onClick: clearLocalData, children: 'clear' })] })
        : Btn({ key: 'cldbtn', onClick: clearLocalData, children: 'clear local data' }),
    ].filter(Boolean),
  });
}

function acpStatusFor(agentId) {
  const acp = Array.isArray(state.health.acp) ? state.health.acp : [];
  return acp.find(a => a.id === agentId) || null;
}

function agentsPanel() {
  const installed = state.agents.filter(a => a.available !== false);
  const hasAcp = (Array.isArray(state.health.acp) ? state.health.acp : []).length > 0;
  // '0/0 installed' during the initial fetch reads as "nothing works", not
  // "still loading" - show the loading word instead until the list lands.
  const title = (state.agentsLoading && !state.agents.length)
    ? 'agents · loading…'
    : 'agents · ' + installed.length + '/' + state.agents.length + ' installed';
  // A 16-agent list with only ~4 installed is dominated by disabled-looking
  // rows; default to hiding not-installed/non-npx-installable agents so the
  // list reads as "what can I use" rather than a wall of grey entries. The
  // toggle stays visible (and the count in its label) so nothing is hidden
  // silently.
  const hiddenCount = state.agents.filter(a => a.available === false && !a.npxInstallable).length;
  const visibleAgents = state.hideUnavailableAgents
    ? state.agents.filter(a => a.available !== false || a.npxInstallable)
    : state.agents;
  return Panel({
    id: 'agents',
    title,
    children: [
    // ACP agents (opencode/kilo/codex) are managed automatically: started
    // on-demand and restarted with backoff by the server, so there are no
    // manual start/stop controls by design. This note makes that explicit so
    // a 'stopped' row doesn't read as a missing action.
    hasAcp ? h('p', { key: 'acpnote', class: 't-meta agentgui-field-mb' }, 'ACP agents start on demand and restart automatically; selecting one launches it.') : null,
    h('div', { key: 'agrefreshrow', class: 'agentgui-field-mb' }, [
      Btn({ key: 'agrefresh', onClick: () => loadAgents(), disabled: state.agentsLoading, children: state.agentsLoading ? 'refreshing…' : 'refresh' }),
      hiddenCount > 0 ? Checkbox({
        key: 'aghidetoggle',
        checked: !!state.hideUnavailableAgents,
        label: 'hide unavailable (' + hiddenCount + ')',
        onChange: (v) => { state.hideUnavailableAgents = v; render(); },
      }) : null,
    ].filter(Boolean)),
    ...(visibleAgents.length
      ? visibleAgents.map((a, i) => {
          const acp = acpStatusFor(a.id);
          const avail = a.available !== false;
          const usable = avail || a.npxInstallable;     // selectable from this row
          const bits = [PROTOCOL_WORDS[a.protocol] || 'agent'];
          if (!avail) bits.push(a.npxInstallable ? 'installs automatically when used (via npx)' : ('not installed' + (a.cmd ? ' - install the "' + a.cmd + '" CLI to enable' : '')));
          if (acp) bits.push(acp.healthy ? 'connected' : (acp.running ? 'connecting' : 'offline'));
          if (acp && acp.restartCount >= 1) bits.push('restarted ' + acp.restartCount + (acp.restartCount === 1 ? ' time' : ' times'));
          if (acp && !acp.healthy && acp.providerInfo?.error) {
            const rawErr = String(acp.providerInfo.error);
            const truncatedErr = rawErr.length > 80 ? rawErr.slice(0, 80) + '…' : rawErr;
            bits.push('connection failed, try restart: ' + truncatedErr);
          }
          if (acp && acp.idleMs > 3_600_000) bits.push(fmtDuration(acp.idleMs) + ' idle');
          return Row({
            key: 'ag' + a.id,
            rank: String(i + 1).padStart(3, '0'),
            title: a.name,
            sub: bits.join(' · '),
            // Rail tone keeps its GUI-wide meaning: green=ok/selected,
            // flame=error/unavailable. Selection is shown via `active`, not by
            // borrowing purple (purple is reserved for subagents).
            // flame is a REAL error signal (Row's shared rail renders it as an
            // sr-only "error" a11y label) - "not installed" is the normal,
            // expected state for most of the 16-agent list and must not carry
            // that label. Only an ACP agent that is actually running-unhealthy
            // (started, but connection/auth failed) is a genuine error; a
            // merely-absent binary with no restart in flight is not.
            rail: (acp && !acp.healthy) ? 'flame' : (a.id === state.selectedAgent ? 'green' : undefined),
            active: a.id === state.selectedAgent,
            // Non-installable agents are genuinely inert: mark them disabled (no
            // click, no button role) instead of looking clickable but doing nothing.
            state: usable ? 'default' : 'disabled',
            onClick: usable ? () => { navTo('chat'); selectAgent(a.id); } : undefined,
            right: (acp && !acp.healthy)
              ? [Btn({ key: 'acprestart', onClick: (e) => { e.stopPropagation(); withBusy(e.currentTarget, () => B.restartAcpAgent(state.backend, a.id).then(() => loadAgents()), 'restarting…'); }, children: 'restart' })]
              // Direct-runner agents (claude-code/agy) have no restart, but a
              // 'not installed' verdict can go stale if the user installs the
              // CLI mid-session - give it the same recheck affordance ACP rows
              // get via 'restart', instead of only static prose.
              : (!avail ? [Btn({ key: 'agrecheck', onClick: (e) => { e.stopPropagation(); withBusy(e.currentTarget, () => loadAgents(), 'checking…'); }, children: 're-check' })] : undefined),
          });
        })
      // The empty array means one of several things; never let an in-flight
      // load read as a broken registry, and never let the hide-unavailable
      // filter read as "no agents" either.
      : [state.agentsLoading
          ? AgentListSkeleton({ rows: 5 })
          : (state.agentsError
              ? h('div', { key: 'agfail', class: 't-meta empty-state' },
                  h('span', { key: 'agfailtxt' }, 'the agent list failed to load'),
                  Btn({ key: 'agretry2', onClick: (e) => withBusy(e.currentTarget, () => loadAgents(), 'retrying…'), children: 'retry' }))
              : (state.agents.length
                  ? h('div', { key: 'agallhidden', class: 't-meta empty-state' },
                      h('span', { key: 'agallhiddentxt' }, 'all agents are hidden by the unavailable filter'),
                      Btn({ key: 'agshowall', onClick: () => { state.hideUnavailableAgents = false; render(); }, children: 'show all' }))
                  : h('p', { key: 'none', class: 't-meta' }, 'no agents loaded')))]),
    ].filter(Boolean),
  });
}

// --- data ---
// refreshHistory/runSearch/loadSession - extracted to history.js, bound to
// the local names _refreshHistory/_runSearch above (loadSession keeps its
// name directly since nothing else in app.js shadows it).
const refreshHistory = _refreshHistory;
const debouncedRefreshHistory = debounce(refreshHistory, 500);
// Debounced files filter: toLowerCase() on every entry runs on every keystroke;
// 150ms coalesces rapid typing into one filter pass (perf-003).
const debouncedFilesFilter = debounce((v) => { state.files.filter = v; state.files.shown = null; if (state.tab === 'files') writeHash(); render(); }, 150);

const runSearch = _runSearch;
const debouncedSearch = debounce(runSearch, 300);

// Fetch agents + pick the active one. Reusable: boot, backend save, and the
// reconnect path all re-run it. Returns true on success; failure lands in
// state.agentsError so the chat tab can surface it with a retry control.
async function loadAgents() {
  state.agentsError = null;
  state.agentsLoading = true;
  try {
    state.agents = await B.listAgents(state.backend);
    state.sortedAgentsCache = null;  // invalidate memoized sort when agents list changes
    state.agentsLoading = false;
    // Agent selection priority: the agent a restored transcript belongs to (so
    // the chat isn't shown under the wrong agent), else the saved picker agent,
    // else first available, else first.
    let target = (state.chat.restoredAgent && state.agents.find(a => a.id === state.chat.restoredAgent))
      || state.agents.find(a => a.id === state.selectedAgent);
    if (!target) target = state.agents.find(a => a.available !== false) || state.agents[0];
    if (target) await selectAgent(target.id);
    render();
    return true;
  } catch (e) {
    state.agentsLoading = false;
    state.agentsError = errText(e);
    console.warn('agents fetch failed:', e.message);
    render();
    return false;
  }
}

// Models tab data load: models.availability WS handler composes agent
// registry + provider key presence into ModelsConfig's expected shape. See
// lib/ws-handlers-util.js for exactly what each field means in agentgui (no
// freddie-style per-mode probe matrix - one real 'cli' mode per model).
async function loadModelsAvailability() {
  state.models.loading = true;
  state.models.error = null;
  render();
  try {
    state.models.data = await B.getModelsAvailability(state.backend);
    state.models.loading = false;
    render();
  } catch (e) {
    state.models.loading = false;
    state.models.error = errText(e) || 'failed to load model availability';
    render();
  }
}

// Boot-time automatic retries with backoff when the first agents fetch fails
// (the server may still be warming up).
async function retryLoadAgents() {
  for (const ms of [2000, 5000, 10000]) {
    await new Promise(r => setTimeout(r, ms));
    if (!state.agentsError) return;       // a manual retry already succeeded
    if (await loadAgents()) return;
  }
}

// While the backend is unreachable, poll /health every ~10s; on recovery
// re-fetch agents + models and announce, so a mid-session outage self-heals.
let _healthPollTimer = null;
function stopHealthPolling() { if (_healthPollTimer) { clearInterval(_healthPollTimer); _healthPollTimer = null; } }
function startHealthPolling() {
  if (_healthPollTimer) return;
  _healthPollTimer = setInterval(() => {
    if (state.health.status === 'ok') { stopHealthPolling(); return; }
    recheckHealth();
  }, 10000);
}
async function recheckHealth() {
  const wasOk = state.health.status === 'ok';
  // Distinguishes "never probed yet" (status stays 'unknown', server panel
  // shows literal 'unknown' fields with no affordance) from "probe in
  // flight" - the settings server panel reads this to show 'checking…'
  // instead of a wall of 'unknown' during the very first health probe.
  state.healthChecking = true;
  const r = await B.probeBackend(state.backend);
  state.healthChecking = false;
  if (r.ok) {
    state.health = { status: 'ok', ...r.info };
    stopHealthPolling();
    if (!wasOk) { announce('reconnected'); loadAgents(); }
  } else {
    state.health = { status: 'down', ...r };
    startHealthPolling();
  }
  render();
}

// Build-freshness: a long-open tab keeps running the JS it parsed at load
// time even after a new version is deployed. window.__SERVER_VERSION is
// baked in at page load; /health's `version` field reflects whatever is
// currently running server-side. Poll it at a low frequency (distinct from
// the health-outage poll above, which only runs while unhealthy) and, on a
// mismatch, surface a persistent action toast rather than silently leaving
// the tab on stale code — mirrors docstudio's update-check.js version.json
// poll + reload-nudge pattern.
const BUILD_FRESHNESS_POLL_MS = 90000;
let _buildFreshnessTimer = null;
let _buildStaleNoticeShown = false;
function startBuildFreshnessPoll() {
  if (_buildFreshnessTimer || !window.__SERVER_VERSION) return;
  _buildFreshnessTimer = setInterval(async () => {
    if (_buildStaleNoticeShown) return;
    const r = await B.probeBackend(state.backend);
    if (r.ok && r.info && r.info.version && r.info.version !== window.__SERVER_VERSION) {
      _buildStaleNoticeShown = true;
      clearInterval(_buildFreshnessTimer);
      _buildFreshnessTimer = null;
      toast({
        message: 'A new version is available',
        kind: 'info',
        duration: 0,
        actionLabel: 'reload',
        onAction: (dismiss) => { dismiss(); location.reload(); },
      });
    }
  }, BUILD_FRESHNESS_POLL_MS);
}

async function init() {
  state.health = { status: 'unknown' };
  render();
  try {
    const r = await B.probeBackend(state.backend);
    state.health = r.ok ? { status: 'ok', ...r.info } : { status: 'down', ...r };
  } catch (e) {
    state.health = { status: 'error', error: e.message };
  }
  render();
  if (!(await loadAgents())) retryLoadAgents();
  startBuildFreshnessPoll();
  // Fetch once: lets the cwd "use default" button show what it resolves to
  // via a tooltip, instead of only revealing it after the click.
  B.getHome(state.backend).then(h => { state.serverHome = h; render(); }).catch(() => {});

  const hp = readHash();
  const bootTab = hp.tab || (hp.sid ? 'history' : 'chat');
  if (hp.sid && bootTab === 'chat') {
    // tab=chat&sid deep link: resume the conversation in chat.
    resumeInChat({ sid: hp.sid }, { fromHash: true });
    refreshHistory();
  } else if (hp.sid) {
    if (hp.q) state.searchQ = hp.q;
    if (hp.project) state.projectFilter = hp.project;
    const bootFocusTs = hp.ets != null ? Number(hp.ets) : null;
    if (bootFocusTs != null && !Number.isNaN(bootFocusTs)) state._focusEventTs = bootFocusTs;
    navTo('history', { push: false });
    await refreshHistory();
    await loadSession(hp.sid, { fromHash: true, focusEventTs: bootFocusTs != null && !Number.isNaN(bootFocusTs) ? bootFocusTs : undefined });
    if (state.searchQ.trim().length >= 2) runSearch();
  } else if (bootTab !== state.tab) {
    // Files deep-link: restore the directory the URL names (reload keeps
    // context instead of resetting to the default root). Kick the load BEFORE
    // navTo - loadDir sets loading=true synchronously, so navTo's default
    // loadDir('') guard skips and the two never race. Once the listing
    // resolves, restore the file= preview on top of it.
    if (bootTab === 'files' && hp.dir) {
      if (hp.filter) state.files.filter = hp.filter;
      loadDir(hp.dir, { fromHash: true }).then(() => restoreFileFromHash(hp.file));
    }
    if (bootTab === 'history' && hp.q) state.searchQ = hp.q;
    if (bootTab === 'history' && hp.project) state.projectFilter = hp.project;
    if (bootTab === 'live') {
      if (hp.lsort) state.live.sort = hp.lsort;
      if (hp.lfilter) state.live.filter = hp.lfilter;
      if (hp.lerr) state.live.errorsOnly = true;
    }
    navTo(bootTab, { push: false });
    if (bootTab === 'history' && state.searchQ.trim().length >= 2) runSearch();
    if (bootTab === 'settings' && hp.section) focusSettingsSection(hp.section);
  }

  registerWsStatusOnce();
  registerSettingsScrollSpyOnce();
  startActivePolling();   // surface running chats on any tab, not just history
  startRelTimeTick();
  startLiveTick();        // 1s elapsed advance on the live dashboard
  // The conversation column shows on the default chat tab, so load the session
  // list at boot (unless a history deep-link already triggered a refresh).
  if (state.tab === 'chat' && !state.sessions.length) refreshHistory();
}

// init() runs both at boot and on every saveBackend(); registering the WS
// status listener inside it leaked a listener per save. Register exactly once.
let wsStatusRegistered = false;
function registerWsStatusOnce() {
  if (wsStatusRegistered) return;
  wsStatusRegistered = true;
  B.onWsStatus?.((s) => {
    if (s === 'closed' || s === 'error') {
      if (state.health.status === 'ok') { state.health = { ...state.health, ws: 'reconnecting' }; render(); }
      // The WS dropping often means the whole server went away - re-probe
      // /health so the offline banner appears mid-session (and the 10s
      // recovery poll starts) instead of silently retrying forever.
      recheckHealth();
    } else if (s === 'open') {
      if (state.health.ws) { delete state.health.ws; render(); }
    }
  });
  // backend.js already detects a mid-session 401 (a token that stopped being
  // valid - e.g. PASSWORD rotated, cookie expired) and exports this hook, but
  // nothing ever subscribed to it: every subsequent fetch just failed
  // silently with no on-screen indication of WHY. Surface it as a persistent
  // banner instructing a reload (the only real recovery - the token lives in
  // window.__WS_TOKEN, injected server-side at page load).
  B.onSessionExpired?.(() => { state.sessionExpired = true; render(); });
}

hydratePrefs();
restoreChat();
render = mount(document.getElementById('app'), view);
requestAnimationFrame(syncAriaCurrent);

// Re-render on resize so isNarrow()/truncate() reflect the current width
// (they read window.innerWidth only at render time).
window.addEventListener('resize', debounce(() => scheduleRender(), 150));

// Scroll to + focus a settings panel by its id (section= deep link), reusing
// the data-prog-focus pattern so the programmatic focus ring is suppressed.
function focusSettingsSection(id) {
  state.settingsSection = id;
  requestAnimationFrame(() => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ block: 'start' });
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.setAttribute('data-prog-focus', '');
    try { el.focus({ preventScroll: true }); } catch {}
    const clear = () => { el.removeAttribute('data-prog-focus'); el.removeEventListener('blur', clear); };
    el.addEventListener('blur', clear);
  });
}
const SETTINGS_SECTION_IDS = ['backend', 'server', 'agents', 'appearance', 'keyboard', 'data'];
// Settings was deep-link-IN only: focusSettingsSection() (a section= URL param
// or the ?-overlay jump) set state.settingsSection, but manually scrolling
// never updated it back - so the URL/state silently went stale the instant a
// user scrolled by hand, and Back could never step BETWEEN panels the way it
// does for every other tab. A lightweight scroll-position scrollspy (not a
// full IntersectionObserver - the settings scroll region is small/short-lived
// enough that a debounced scroll-position check is simpler and avoids the
// observer-lifecycle bookkeeping) keeps state.settingsSection (and the URL)
// honest while the user scrolls, registered once like the WS/session-expired
// listeners above.
const debouncedSettingsScrollSpy = debounce(() => {
  if (state.tab !== 'settings') return;
  const region = document.querySelector('#agentgui-main');
  if (!region) return;
  const regionTop = region.getBoundingClientRect().top;
  let current = null;
  for (const id of SETTINGS_SECTION_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    // The section whose top has scrolled past the region's own top edge
    // (with a little slack for the sticky header) is the "current" one -
    // same heuristic every scrollspy implementation uses.
    if (el.getBoundingClientRect().top - regionTop <= 80) current = id;
  }
  if (current && current !== state.settingsSection) {
    state.settingsSection = current;
    writeHash({ push: false });   // passive sync, not a Back-able step - matches search text/filter's replaceState treatment
  }
}, 150);
let settingsScrollSpyRegistered = false;
function registerSettingsScrollSpyOnce() {
  if (settingsScrollSpyRegistered) return;
  settingsScrollSpyRegistered = true;
  document.addEventListener('scroll', (e) => {
    if (e.target && e.target.id === 'agentgui-main') debouncedSettingsScrollSpy();
  }, true);   // capture: #agentgui-main itself is the scrolling element, not a bubling target
}

// Browser Back/forward: diff the FULL hash param set against state and re-sync
// each piece. Everything here runs with writeHash:false / fromHash:true so the
// handler never clobbers or re-pushes the entry it just popped.
window.addEventListener('popstate', () => {
  const hp = readHash();
  const tab = hp.tab || 'chat';
  if (tab !== state.tab) navTo(tab, { writeHash: false });
  // Session selection: honor tab= when present (tab=chat&sid resumes in chat,
  // anything else - or a bare sid - opens it in history).
  if (hp.sid && hp.sid !== state.selectedSid) {
    if (tab === 'chat') resumeInChat({ sid: hp.sid }, { fromHash: true });
    else {
      const popFocusTs = hp.ets != null ? Number(hp.ets) : null;
      state._focusEventTs = (popFocusTs != null && !Number.isNaN(popFocusTs)) ? popFocusTs : null;
      loadSession(hp.sid, { fromHash: true, focusEventTs: (popFocusTs != null && !Number.isNaN(popFocusTs)) ? popFocusTs : undefined });
    }
  } else if (!hp.sid && state.selectedSid && tab === 'history') {
    state.selectedSid = null;
    state.events = [];
    state.eventsLoaded = false;
  }
  if (tab === 'files') {
    const cur = state.files && state.files.path;
    if (hp.filter !== undefined && hp.filter !== null) state.files.filter = hp.filter || '';
    if (hp.dir && hp.dir !== cur) {
      // Restore the file= preview only once the directory listing resolves
      // (the entry object lives in state.files.entries).
      loadDir(hp.dir, { fromHash: true }).then(() => restoreFileFromHash(hp.file));
    } else {
      restoreFileFromHash(hp.file);
    }
  }
  if (tab === 'history') {
    const q = hp.q || '';
    if (q !== state.searchQ) {
      state.searchQ = q;
      if (q.trim().length >= 2) runSearch();
      else { state.searchHits = null; state.searchBusy = false; }
    }
    state.projectFilter = hp.project || '';
  }
  if (tab === 'settings' && hp.section) focusSettingsSection(hp.section);
  render();
});

window.__agentgui = { state, render };

// Keyboard shortcuts. 'g' then c/h/s switches tabs; 'n' new chat; '/' focuses
// search (history) or composer (chat). Ignored while typing in a field.
// Keyboard shortcuts - extracted to shortcuts.js (vertical slice per
// AGENTS.md SOLID/Clean-Architecture preferences). The factory takes every
// app.js dependency explicitly (state, render, and the helpers object below)
// rather than closing over app.js's module scope.
const { focusComposer } = installShortcuts(state, render, {
  navTo, announce, closeFileDialog, filesMarked, clearFileSelection,
  cancelChat, newChat, previewNeighbours, openPreview,
  clearNewChatArmTimer: () => clearTimeout(_newChatArmTimer),
  clearStopAllArmTimer: () => clearTimeout(_stopAllArmTimer),
  clearStopSelArmTimer: () => clearTimeout(_stopSelArmTimer),
});
window.addEventListener('drop', (e) => {
  if (!(e.target instanceof Element) || !e.target.closest('.ds-dropzone')) e.preventDefault();
});

init();
