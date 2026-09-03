// History tab: session list, event viewer, search - extracted from app.js
// (vertical slice per AGENTS.md SOLID/Clean-Architecture preferences). The
// factory takes every app.js dependency explicitly (state, render, backend
// module B, kit components, and helper functions) rather than closing over
// app.js's module scope implicitly - the same pattern used successfully for
// chat-persistence.js and shortcuts.js earlier in this split.
export function createHistory(state, render, B, deps) {
  const {
    h, PageHeader, ShortcutList, Btn, Panel, EventList, FilterPills, SessionMeta,
    SHORTCUTS, UNTITLED_CONVERSATION,
    reconnectAlert, agentById, projectLabel, pathBasename, plural, fmtRelTime, truncate,
    eventMatchesFilter, sessionDuration, resumeInChat, downloadBlob, toolLabel, copyText,
    pushRecentCwd, announce, lsSet, errText, writeHash,
    getCopyToast, copySid,
  } = deps;

  function jumpToEvent(idx) {
    if (idx < 0) return;
    state.eventFilter = 'all';
    state._errorNavIdx = idx;
    const fromEnd = state.events.length - idx;
    if (fromEnd > state.eventsLimit) state.eventsLimit = Math.ceil(fromEnd / 300) * 300;
    render();
    const sliceStart = Math.max(0, state.events.length - state.eventsLimit);
    const rowPos = idx - sliceStart;
    requestAnimationFrame(() => {
      const rows = document.querySelectorAll('.ds-event-list .row');
      const row = rows[rowPos];
      if (row) { row.scrollIntoView({ block: 'center' }); row.classList.add('event-flash'); setTimeout(() => row.classList.remove('event-flash'), 2000); }
    });
  }
  function jumpToFirstError() {
    const idx = state.events.findIndex(e => e.isError);
    jumpToEvent(idx);
  }
  // Persistent next/prev navigation between error events - jumpToFirstError
  // alone only reaches the FIRST error once; a session with multiple errors had
  // no way to step through them without manually scanning the event list.
  function jumpToNextError(dir) {
    const errIdxs = state.events.reduce((acc, e, i) => { if (e.isError) acc.push(i); return acc; }, []);
    if (!errIdxs.length) return;
    const cur = state._errorNavIdx;
    let pos = errIdxs.indexOf(cur);
    pos = pos < 0 ? (dir > 0 ? 0 : errIdxs.length - 1) : (pos + dir + errIdxs.length) % errIdxs.length;
    jumpToEvent(errIdxs[pos]);
  }

  function historyMain() {
    if (!state.selectedSid) {
      const count = (Array.isArray(state.sessions) ? state.sessions : []).length;
      return [
        reconnectAlert(),
        PageHeader({
          compact: true,
          dense: true,
          title: 'History',
          lede: 'Pick a conversation to inspect its events as they happen.',
        }),
        h('div', { key: 'histempty', class: 'history-empty', role: 'status' },
          h('p', { key: 'gt', class: 'history-empty-title' },
            count ? 'Select a conversation to view its events' : 'No conversations yet'),
          h('p', { key: 'gs', class: 'history-empty-sub' },
            count
              ? count + ' conversation' + (count === 1 ? '' : 's') + ' available · use the search box or press / to filter'
              : 'Start a chat or run a local coding agent - its conversation will appear here live.'),
          count ? h('div', { key: 'gh', class: 'history-empty-hints' },
            ShortcutList({ shortcuts: SHORTCUTS.slice(0, 4) })) : null),
      ].filter(Boolean);
    }

    const sess = (Array.isArray(state.sessions) ? state.sessions : []).find(s => s.sid === state.selectedSid);
    // sess.model is the raw ccsniff-sourced field (41st-run fix); ccsniff only
    // reads Claude Code's own JSONL so the agent is always constant. The
    // History detail header previously never surfaced either, reading
    // identity-thin next to the same session's Running-panel/Live-dashboard
    // rows which both show an agent+model badge.
    const agentModelBit = sess?.model ? ((agentById('claude-code')?.name || 'Claude Code') + ' · ' + sess.model) : null;
    const lede = sess
      ? (projectLabel(sess.project) || pathBasename(sess.cwd) || 'unknown location') + (agentModelBit ? ' · ' + agentModelBit : '') + ' · ' + plural(sess.events || 0, 'event') + ' · ' + plural(sess.userTurns || 0, 'turn') + ' · ' + fmtRelTime(sess.last)
      : UNTITLED_CONVERSATION;

    const head = PageHeader({
      compact: true,
      dense: true,
      title: truncate(projectLabel(sess?.title) || projectLabel(sess?.project) || pathBasename(sess?.cwd) || state.selectedSid || UNTITLED_CONVERSATION, 40, 80),
      lede,
    });

    const hasErrors = state.events.some(e => e.isError);
    const actions = h('div', { key: 'acts', class: 'history-actions' }, [
      Btn({ key: 'resume', primary: true, onClick: () => resumeInChat(sess || { sid: state.selectedSid }), children: 'open in chat' }),
      Btn({ key: 'copy', onClick: copySid, children: getCopyToast() || 'copy conversation id' }),
      Btn({ key: 'exportsess', disabled: !state.eventsLoaded, title: 'Download this session\'s events as JSON',
        onClick: () => downloadBlob(JSON.stringify(state.events, null, 2), (projectLabel(sess?.project) || 'session') + '-' + state.selectedSid + '.json', 'application/json'),
        children: 'export' }),
      hasErrors ? Btn({ key: 'jumperr', onClick: jumpToFirstError, children: 'jump to first error' }) : null,
      // Persistent next/prev stepping between errors - jump-to-first alone only
      // ever reaches the FIRST one; a session with several errors had no way to
      // step through the rest without manually scrolling/scanning.
      hasErrors ? Btn({ key: 'errprev', title: 'previous error', 'aria-label': 'previous error', onClick: () => jumpToNextError(-1), children: 'prev error' }) : null,
      hasErrors ? Btn({ key: 'errnext', title: 'next error', 'aria-label': 'next error', onClick: () => jumpToNextError(1), children: 'next error' }) : null,
    ].filter(Boolean));

    if (state.events.length === 0) {
      // Distinguish "still loading" from "genuinely empty" so a 0-event session
      // doesn't spin forever. After 5s of an unresolved first fetch, swap to the
      // indexing copy (ccsniff's first JSONL walk can take a minute).
      const body = state.eventsLoaded
        ? h('div', { key: 'noev', class: 'lede empty-state', role: 'status' },
            h('span', { key: 'noevtxt' }, 'no events in this conversation'),
            Btn({ key: 'reload', onClick: () => loadSession(state.selectedSid), children: 'reload' }))
        // Shape-matched skeleton rows (kit EventList loading state) instead of a
        // lone spinner collapsing the slowest pane in the product.
        : h('div', { key: 'loading' }, EventList({ items: [], loading: true,
            loadingText: state.eventsSlow ? 'Indexing your Claude history — the first load can take a minute…' : 'loading events…' }));
      return [reconnectAlert(), head, actions, Panel({ title: 'events', kind: 'wide', children: body })].filter(Boolean);
    }

    if (!state.expandedEvents) state.expandedEvents = new Set();
    // Event-type filter applies BEFORE the render-window slice so "errors" shows
    // every error in the session, not only errors among the most-recent 300.
    const ef = state.eventFilter || 'all';
    const filteredEvents = ef === 'all' ? state.events : state.events.filter(e => eventMatchesFilter(e, ef));
    const filterPills = FilterPills({
      options: [
        { id: 'all', label: 'all' },
        { id: 'text', label: 'text' },
        { id: 'tool', label: 'tools' },
        { id: 'errors', label: 'errors' },
        { id: 'thinking', label: 'thinking' },
      ],
      selected: ef,
      onSelect: (id) => { state.eventFilter = id && id.id ? id.id : id; render(); },
      label: 'Filter events by type',
    });
    // Single pass over state.events for all three counters (replaces three separate .filter() calls).
    const evCounters = state.events.reduce((c, e) => {
      if (e.role === 'user') c.turns++;
      if (e.type === 'tool_use') c.tools++;
      if (e.isError) c.errors++;
      return c;
    }, { turns: 0, tools: 0, errors: 0 });
    const meta = SessionMeta({
      items: [
        sess && sess.cwd ? { label: 'directory', value: sess.cwd, title: sess.cwd,
          actionLabel: 'use as chat cwd',
          onAction: () => { state.chatCwd = sess.cwd; lsSet('agentgui.cwd', sess.cwd); pushRecentCwd(sess.cwd); announce('working directory set to ' + sess.cwd); render(); } } : null,
        (() => { const dur = sessionDuration(); return dur ? { label: 'duration', value: dur } : null; })(),
        { label: 'session id', value: state.selectedSid.slice(0, 8) + '…', title: state.selectedSid, onCopy: () => copyText(state.selectedSid, 'session id copied') },
        // Spelled counter vocabulary in the detail strip (events/turns/tools/
        // errors); the abbreviated 'ev/tools/err' triple stays compact-row-only.
        { label: 'events', value: String(state.events.length) },
        { label: 'turns', value: String(sess?.userTurns ?? evCounters.turns) },
        { label: 'tools', value: String(evCounters.tools) },
        { label: 'errors', value: String(evCounters.errors) },
        sess && sess.cost != null ? { label: 'cost', value: '$' + Number(sess.cost).toFixed(4) } : null,
      ].filter(Boolean),
    });
    if (filteredEvents.length === 0) {
      return [reconnectAlert(), head, actions, Panel({ title: 'events', kind: 'wide', children: [
        h('div', { key: 'evmeta' }, meta),
        h('div', { key: 'evfp' }, filterPills),
        h('div', { key: 'nofilt', class: 'lede empty-state', role: 'status' },
          h('span', { key: 'noftxt' }, 'no events match this filter'),
          Btn({ key: 'clearf', onClick: () => { state.eventFilter = 'all'; render(); }, children: 'clear filter' })),
      ] })].filter(Boolean);
    }
    const total = filteredEvents.length;
    const limit = state.eventsLimit;
    const shown = filteredEvents.slice(-limit);
    const hiddenCount = total - shown.length;
    // Keys of the currently-shown rows, so expand-all toggles only what's rendered.
    const shownKeys = shown.map((e, i) => e.i != null ? 'ev' + e.i : 'ev-' + (e.ts || 0) + '-' + (e.type || '') + '-' + (e._idx ?? (total - shown.length + i)));
    const allExpanded = shownKeys.length > 0 && shownKeys.every(k => state.expandedEvents.has(k));
    const eventControls = h('div', { key: 'evctrl', class: 'history-actions', role: 'group', 'aria-label': 'event controls' },
      Btn({ key: 'expall', onClick: () => {
          if (allExpanded) { shownKeys.forEach(k => state.expandedEvents.delete(k)); }
          else { shownKeys.forEach(k => state.expandedEvents.add(k)); }
          render();
        }, children: allExpanded ? 'collapse shown' : 'expand shown' }),
      hiddenCount > 0
        ? Btn({ key: 'older', onClick: () => { const added = Math.min(300, hiddenCount); state.eventsLimit += 300; announce('loaded ' + added + ' more events'); render(); }, children: 'load ' + Math.min(300, hiddenCount) + ' older (' + hiddenCount + ' hidden)' })
        : null,
      // A per-click 300-event step is fine for casual scanning, but a huge
      // session (thousands hidden) makes that a lot of repeat clicks - a
      // secondary "load all" jumps straight to the full transcript.
      hiddenCount > 1000
        ? Btn({ key: 'loadall', onClick: () => { state.eventsLimit = total; announce('loaded all ' + total + ' events'); render(); }, children: 'load all (' + hiddenCount + ' hidden)' })
        : null,
    );
    return [
      reconnectAlert(),
      head,
      actions,
      Panel({
        title: plural(total, 'event') + (ef !== 'all' ? ' (' + ef + ' filter)' : '') + (hiddenCount > 0 ? ' (showing last ' + shown.length + '; ' + hiddenCount + ' older)' : ''),
        kind: 'wide',
        children: [h('div', { key: 'evmeta' }, meta), h('div', { key: 'evfp' }, filterPills), eventControls, EventList({
          items: shown.map((e, i) => {
            // Stable key: prefer the server-assigned event index, else the
            // event timestamp + position, never a bare array index (which
            // collides between loaded and live-pushed events).
            // Stable key: server event index when present, else ts + the event's
            // ABSOLUTE position in state.events (not the sliced-view index, which
            // shifts when live events append and would collide loaded vs live rows).
            const key = e.i != null ? 'ev' + e.i : 'ev-' + (e.ts || 0) + '-' + (e.type || '') + '-' + (e._idx ?? (total - shown.length + i));
            const role = e.role || '?';
            const type = e.type || '?';
            const tool = e.tool ? ' · tool: ' + e.tool : '';
            const errMark = e.isError ? ' · error' : '';
            const raw = e.text || '';
            const text = raw.replace(/\s+/g, ' ').trim() || (e.type === 'tool_use' && e.toolInput ? toolLabel(e.toolInput) : '');
            const toolNamePrefix = (e.type === 'tool_use' && e.tool) ? e.tool + ': ' : '';
            const typePrefix = e.type === 'tool_result' ? '(result) ' : (e.type === 'tool_use' ? ('(tool call) ' + toolNamePrefix) : '');
            const expanded = state.expandedEvents.has(key);
            // Only build the expanded body (JSON.stringify tool input) when the row is
            // expanded - doing it for all ~300 rows every frame wastes work mid-stream.
            const full = expanded ? (e.toolInput ? (text + '\n\n' + JSON.stringify(e.toolInput, null, 2)) : raw) : '';
            // Rail tone matches the session/agents rail semantics so an event's
            // kind is visible at a glance, consistent across the GUI:
            // flame = error, purple = tool activity, green = normal turn.
            const rail = e.isError ? 'flame' : (e.type === 'tool_use' || e.type === 'tool_result' ? 'purple' : 'green');
            // When the session was opened from a search hit, window the collapsed
            // title AROUND the first query match (a match at char 5000 would
            // otherwise be invisible behind the 0-220 slice).
            let collapsedTitle = typePrefix + text.slice(0, 220);
            const q = state.sessionSearchQ;
            if (q && !expanded) {
              const qi = text.toLowerCase().indexOf(q.toLowerCase());
              if (qi > 60) collapsedTitle = '…' + text.slice(qi - 60, qi - 60 + 220);
            }
            return {
              key,
              code: String(total - shown.length + i + 1).padStart(4, '0'),
              rail,
              expanded,  // disclosure state -> kit Row sets aria-expanded
              highlight: q || undefined,
              // Copy is available whether or not the row is expanded - a user
              // scanning collapsed rows for a specific payload shouldn't have
              // to expand every row first just to copy one.
              actions: [{
                label: 'copy', title: 'copy event',
                onClick: () => copyText(full || raw || ('(' + type + ')'), 'event copied'),
              }],
              title: expanded ? (typePrefix + (text || '(' + type + ')')) : (collapsedTitle || typePrefix + '(' + type + ')'),
              detail: expanded && e.toolInput ? JSON.stringify(e.toolInput, null, 2) : undefined,
              // Guard ts: a missing/zero timestamp renders "Invalid Date" otherwise.
              // Every row is click-to-expand, so always show the affordance word
              // (not only when text overflows 220 chars).
              // Relative time matches every other surface; the absolute stamp
              // appears when the row is expanded (forensic precision preserved).
              sub: (e.ts ? (expanded ? new Date(e.ts).toLocaleString() : fmtRelTime(e.ts)) : 'no time') + ' · ' + role + ' · ' + type + tool + errMark + ' · ' + (expanded ? 'collapse' : 'expand'),
              onClick: () => { expanded ? state.expandedEvents.delete(key) : state.expandedEvents.add(key); render(); },
            };
          }),
        })],
      }),
    ].filter(Boolean);
  }

  async function refreshHistory() {
    // Guard against concurrent calls: a slow first fetch followed by a polling
    // trigger would otherwise stack two in-flight requests; the second would
    // overwrite state mid-render with a stale response.
    if (state._historyFetching) return;
    state._historyFetching = true;
    // Warmup copy: the FIRST sessions fetch can sit behind ccsniff's 30-90s
    // JSONL walk; after 5s swap the loading copy to indexing language.
    const firstLoad = !state._historyLoadedOnce;
    const slowTimer = firstLoad
      ? setTimeout(() => { if (!state._historyLoadedOnce) { state.historySlow = true; render(); } }, 5000)
      : null;
    try {
      state.sessions = await B.listSessions(state.backend);
      state._historyLoadedOnce = true;
      state._historyLoadedAt = Date.now();
      state.historySlow = false;
      // Index by sid so each live SSE event is an O(1) lookup, not an O(sessions)
      // linear scan per event during a burst load.
      state.sessionsBySid = new Map((state.sessions || []).map(s => [s.sid, s]));
      state._sessionGroupsCache = null;
      // Bound the live tally: drop entries with no activity in 24h and cap the
      // Map at ~200 most-recent sids (a long-lived tab otherwise accumulates
      // every sid ever seen, and dead entries could resurrect wrong externals).
      if (state.live.tally) {
        const cutoff = Date.now() - 24 * 3600 * 1000;
        for (const [sid, t] of [...state.live.tally]) {
          if (!t.last || t.last < cutoff) state.live.tally.delete(sid);
        }
        if (state.live.tally.size > 200) {
          state.live.tally = new Map([...state.live.tally.entries()]
            .sort((a, b) => (b[1].last || 0) - (a[1].last || 0))
            .slice(0, 200));
        }
      }
      // If the selected session vanished from the list (deleted/aged out server-side),
      // drop the selection so the main pane doesn't sit on stale events that can no
      // longer be reloaded; fall back to the no-selection empty state.
      if (state.selectedSid && !state.sessionsBySid.has(state.selectedSid)) {
        state.selectedSid = null;
        state.events = [];
        state.eventsLoaded = false;
        writeHash();
      }
      state.historyError = null;
    } catch (e) {
      // Only a genuine fetch/list failure is a history error. A render exception
      // must not masquerade as one (it would poison the sessions panel with a
      // render-stack string and never clear), so render() lives outside this try.
      state.historyError = errText(e);
      console.warn('history fetch failed:', e.message);
    } finally {
      state._historyFetching = false;
      if (slowTimer) clearTimeout(slowTimer);
      render();
    }
  }

  async function runSearch() {
    const q = state.searchQ.trim();
    if (!q) { state.searchHits = null; state.searchBusy = false; writeHash(); render(); return; }
    if (q.length < 2) { state.searchHits = null; state.searchBusy = false; writeHash(); render(); return; }
    // The project-filter pills are hidden while searching; clear the filter so it
    // doesn't silently re-apply (and surprise the user) when they later clear the
    // search and the now-visible session list is unexpectedly narrowed.
    state.projectFilter = '';
    // The debounced search keeps the URL's q=/project= in sync via replaceState
    // so a reload (or share) restores the search, without flooding history.
    writeHash();
    state.searchBusy = true;
    render();
    try {
      state.searchHits = await B.searchHistory(state.backend, q, 60);
      // Announce the settled count for AT - the sessions-column count is only
      // rendered visually (the history actions row is the only aria-live region).
      const n = (state.searchHits.results || []).length;
      announce((n || 'no') + ' matches for ' + q);
    } catch (e) {
      state.searchHits = { query: q, results: [], error: errText(e) };
    } finally {
      state.searchBusy = false;
      render();
    }
  }

  async function loadSession(sid, { focusEventI = null, focusEventTs = null, fromHash = false } = {}) {
    // Guard against a bad sid from a malformed hash (e.g. "?sid=undefined").
    if (!sid || sid === 'undefined' || sid === 'null') { state.selectedSid = null; render(); return; }
    if (sid === state.selectedSid && state.eventsLoaded && !fromHash && focusEventI == null && focusEventTs == null) {
      render();
      requestAnimationFrame(() => { document.querySelector('.app-side .row.active')?.scrollIntoView({ block: 'nearest' }); });
      return;
    }
    state.selectedSid = sid;
    // A plain (non-search-hit) session open must not carry a stale event
    // anchor forward into the URL - only reset it when this call ISN'T itself
    // the one supplying a fresh focusEventTs.
    if (focusEventTs == null) state._focusEventTs = null;
    state.events = [];
    state.events._seen = new Set();     // O(1) dedupe by event index
    state.eventsLoaded = false;
    state.eventsSlow = false;
    state.eventsLimit = 300;            // reset the render window per session
    state.eventFilter = 'all';          // don't carry the type filter across sessions
    state.expandedEvents = new Set();   // don't carry expansion to the new session
    // Remember the query this session was opened FROM (search hit) so the event
    // rows can highlight + window around the match; a plain selection clears it.
    state.sessionSearchQ = (focusEventI != null || focusEventTs != null) && state.searchQ.trim().length >= 2
      ? state.searchQ.trim() : null;
    // The live "live · N" crumb counter reads as the selected session's activity,
    // so reset it per selection rather than letting it accrue across all sessions.
    state.live.eventCount = 0;
    writeHash({ push: !fromHash });
    // Warmup copy: a first events fetch can sit behind ccsniff's JSONL walk.
    const slowTimer = setTimeout(() => { if (!state.eventsLoaded && state.selectedSid === sid) { state.eventsSlow = true; render(); } }, 5000);
    // Close the mobile sidebar drawer on selection. The DS only auto-closes when
    // the clicked element is an <a>; agentgui's session rows are onClick divs, so
    // we close it explicitly here.
    // Close the WorkspaceShell mobile sessions drawer on session selection.
    if (state.wsSessions) { state.wsSessions = false; }
    document.querySelector('[data-ws-sessions-open]')?.removeAttribute('data-ws-sessions-open');
    render();
    // Bring the now-active sidebar row into view (deep-link / back-forward may
    // select a row that's scrolled out of the session list).
    requestAnimationFrame(() => {
      document.querySelector('.app-side .row.active')?.scrollIntoView({ block: 'nearest' });
    });
    try {
      state.events = await B.getSessionEvents(state.backend, sid);
      // ccsniff's events route has no ?limit= (checked: router.js returns the
      // whole session) - cap in-memory state at the most-recent 5000 so a
      // monster session can't pin the tab; the render window stays 300+load-older.
      if (state.events.length > 5000) state.events = state.events.slice(-5000);
      // Stamp stable _idx so EventList keys are stable regardless of slice/cap.
      state.events.forEach((e, i) => { if (e._idx == null) e._idx = i; });
      clearTimeout(slowTimer);
      state.eventsSlow = false;
      state.eventsLoaded = true;
      // If we arrived from a search hit, make sure the matched event is within the
      // render window, then scroll to + flash it so the match isn't lost.
      if (focusEventI != null || focusEventTs != null) {
        const idx = state.events.findIndex(e => (focusEventI != null && e.i === focusEventI) || (focusEventTs != null && e.ts === focusEventTs));
        if (idx >= 0) {
          const fromEnd = state.events.length - idx;
          if (fromEnd > state.eventsLimit) state.eventsLimit = Math.ceil(fromEnd / 300) * 300;
          render();
          // The rendered EventList shows the last eventsLimit events in order, so
          // the matched event's row is at (idx - sliceStart) among .ds-event-list rows.
          const sliceStart = Math.max(0, state.events.length - state.eventsLimit);
          const rowPos = idx - sliceStart;
          requestAnimationFrame(() => {
            const rows = document.querySelectorAll('.ds-event-list .row');
            const row = rows[rowPos];
            if (row) { row.scrollIntoView({ block: 'center' }); row.classList.add('event-flash'); setTimeout(() => row.classList.remove('event-flash'), 2000); }
          });
          return;
        }
      }
      render();
    } catch (e) {
      state.events = [{
        ts: Date.now(),
        role: 'error',
        type: 'fetch',
        text: 'Failed to load session: ' + errText(e) + ' - retry via the rail',
      }];
      clearTimeout(slowTimer);
      state.eventsSlow = false;
      state.eventsLoaded = true;
      render();
    }
  }

  return { jumpToEvent, jumpToFirstError, jumpToNextError, historyMain, refreshHistory, runSearch, loadSession };
}
