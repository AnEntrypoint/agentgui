import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import * as B from './backend.js';

const STORE_KEY = 'agentgui.terminals';
const MAX_BACKOFF_MS = 8000;
const encoder = new TextEncoder();

function readStore() {
  try {
    const v = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
    return Array.isArray(v) ? v.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function writeStore(sids) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(sids)); } catch {}
}

export function createTerminals({ base, tabbar, host, filesRoot, onSelect, announce }) {
  const tabs = new Map();
  let order = [];
  let enabled = false;
  let active = 'files';
  let note = '';
  let busy = false;
  let restoring = null;

  function nextLabel() {
    const used = new Set([...tabs.values()].map((t) => t.label));
    let n = 1;
    while (used.has('Terminal ' + n)) n += 1;
    return 'Terminal ' + n;
  }

  function statusText(tab) {
    if (tab.status !== 'exited') return tab.status;
    return tab.exitCode === null ? 'closed' : 'exited ' + tab.exitCode;
  }

  function persist() {
    writeStore(order.slice());
  }

  function makeTab(sid, label) {
    const pane = document.createElement('div');
    pane.className = 'term-pane';
    pane.dataset.active = 'false';
    if (sid) pane.id = 'pane-' + sid;
    host.appendChild(pane);
    const term = new Terminal({
      scrollback: 5000,
      cursorBlink: true,
      allowProposedApi: true,
      convertEol: false,
      fontFamily: 'Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 14,
      theme: { background: '#0b0e14', foreground: '#d5d8de' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(pane);
    const tab = {
      sid, label, pane, term, fit,
      ws: null, status: 'connecting', exitCode: null,
      attempts: 0, everOpened: false, retryTimer: null, closed: false,
    };
    term.onData((data) => {
      if (tab.ws && tab.ws.readyState === 1) tab.ws.send(encoder.encode(data));
    });
    return tab;
  }

  function sendResize(tab) {
    if (tab.ws && tab.ws.readyState === 1) {
      tab.ws.send(JSON.stringify({ type: 'resize', cols: tab.term.cols, rows: tab.term.rows }));
    }
  }

  function fitTab(tab) {
    try { tab.fit.fit(); } catch {}
    sendResize(tab);
  }

  function finish(tab, status, line) {
    tab.status = status;
    tab.term.writeln('');
    tab.term.writeln(line);
    renderTabs();
  }

  function control(tab, text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg || msg.type !== 'exit') return;
    tab.exitCode = Number.isFinite(msg.code) ? msg.code : null;
    finish(tab, 'exited', tab.exitCode === null ? '[session closed]' : '[process exited with code ' + tab.exitCode + ']');
    announce(tab.label + ' ' + statusText(tab));
  }

  function connect(tab) {
    if (tab.closed) return;
    const ws = new WebSocket(B.terminalSocketUrl(tab.sid));
    ws.binaryType = 'arraybuffer';
    tab.ws = ws;
    tab.status = 'connecting';
    ws.onopen = () => {
      if (tab.ws !== ws) return;
      if (tab.everOpened) tab.term.reset();
      tab.everOpened = true;
      tab.attempts = 0;
      tab.status = 'live';
      fitTab(tab);
      renderTabs();
    };
    ws.onmessage = (ev) => {
      if (tab.ws !== ws) return;
      if (typeof ev.data === 'string') control(tab, ev.data);
      else tab.term.write(new Uint8Array(ev.data));
    };
    ws.onclose = (ev) => {
      if (tab.ws !== ws) return;
      tab.ws = null;
      if (tab.closed || tab.status === 'exited' || tab.status === 'ended') return;
      if (ev.code === 4404) {
        finish(tab, 'ended', '[session ended]');
        return;
      }
      tab.status = 'disconnected';
      tab.term.writeln('');
      tab.term.writeln('[disconnected, reconnecting]');
      renderTabs();
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** tab.attempts);
      tab.attempts += 1;
      tab.retryTimer = setTimeout(() => { tab.retryTimer = null; connect(tab); }, delay);
    };
  }

  function tabButton(id, label, status) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-selected', String(id === active));
    b.setAttribute('aria-controls', id === 'files' ? 'files-root' : 'pane-' + id);
    b.dataset.tab = id;
    const name = document.createElement('span');
    name.textContent = label;
    b.appendChild(name);
    if (status) {
      const st = document.createElement('span');
      st.className = 'tab-status';
      st.textContent = ' ' + status;
      b.appendChild(st);
    }
    b.addEventListener('click', () => onSelect(id));
    return b;
  }

  function termGroup(tab) {
    const group = document.createElement('span');
    group.className = 'tab-group';
    group.setAttribute('role', 'presentation');
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'tab-close';
    close.setAttribute('aria-label', 'Close ' + tab.label);
    close.textContent = 'x';
    close.addEventListener('click', () => closeTab(tab.sid));
    group.append(tabButton(tab.sid, tab.label, statusText(tab)), close);
    return group;
  }

  function newButton() {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tab-new';
    b.setAttribute('aria-label', 'New terminal');
    b.textContent = '+';
    b.addEventListener('click', () => { newTerminal(true); });
    return b;
  }

  function renderTabs() {
    const items = [tabButton('files', 'Files', '')];
    for (const sid of order) {
      const tab = tabs.get(sid);
      if (tab) items.push(termGroup(tab));
    }
    if (enabled) items.push(newButton());
    const noteEl = document.createElement('span');
    noteEl.className = 'tab-note';
    noteEl.setAttribute('role', 'status');
    noteEl.textContent = note;
    items.push(noteEl);
    tabbar.replaceChildren(...items);
  }

  function show(id) {
    active = id !== 'files' && tabs.has(id) ? id : 'files';
    filesRoot.dataset.active = String(active === 'files');
    host.dataset.active = String(active !== 'files');
    for (const tab of tabs.values()) tab.pane.dataset.active = String(tab.sid === active);
    renderTabs();
    if (active !== 'files') {
      const tab = tabs.get(active);
      fitTab(tab);
      tab.term.focus();
    }
    return active;
  }

  function attach(sid) {
    const tab = makeTab(sid, nextLabel());
    tabs.set(sid, tab);
    order.push(sid);
    connect(tab);
  }

  async function newTerminal(focus) {
    if (!enabled || busy) return null;
    busy = true;
    const tab = makeTab(null, nextLabel());
    try {
      fitTab(tab);
      const session = await B.createTerminal(base, { cols: tab.term.cols, rows: tab.term.rows });
      tab.sid = session.sid;
      tab.pane.id = 'pane-' + session.sid;
      tabs.set(session.sid, tab);
      order.push(session.sid);
      note = '';
      persist();
      connect(tab);
      if (focus) show(session.sid);
      else renderTabs();
      return session.sid;
    } catch (e) {
      tab.term.dispose();
      tab.pane.remove();
      note = 'Could not create a terminal: ' + e.message;
      renderTabs();
      return null;
    } finally {
      busy = false;
    }
  }

  async function closeTab(sid) {
    const tab = tabs.get(sid);
    if (!tab) return;
    tab.closed = true;
    clearTimeout(tab.retryTimer);
    const ws = tab.ws;
    tab.ws = null;
    if (ws) { try { ws.close(1000, 'closed'); } catch {} }
    tabs.delete(sid);
    order = order.filter((s) => s !== sid);
    tab.term.dispose();
    tab.pane.remove();
    persist();
    try {
      await B.closeTerminal(base, sid);
      note = '';
    } catch {
      note = 'The server did not confirm that the terminal closed.';
    }
    if (active === sid) onSelect(order.length ? order[order.length - 1] : 'files');
    else renderTabs();
  }

  async function doRestore() {
    const sessions = await B.listTerminals(base);
    const live = new Set(sessions.filter((s) => !s.exited).map((s) => s.sid));
    const keep = readStore().filter((sid) => live.has(sid));
    for (const sid of keep) attach(sid);
    persist();
    renderTabs();
    if (!order.length) await newTerminal(false);
  }

  function restore() {
    if (!enabled) return Promise.resolve();
    if (!restoring) restoring = doRestore().catch(() => { restoring = null; });
    return restoring;
  }

  function setAvailability(on, text) {
    enabled = !!on;
    note = text || '';
    renderTabs();
    if (enabled) restore();
  }

  const resizeObserver = new ResizeObserver(() => {
    const tab = tabs.get(active);
    if (tab) fitTab(tab);
  });
  resizeObserver.observe(host);
  document.addEventListener('visibilitychange', () => {
    const tab = tabs.get(active);
    if (tab && document.visibilityState === 'visible') fitTab(tab);
  });

  return {
    show,
    has: (id) => tabs.has(id),
    labelOf: (id) => (tabs.get(id) ? tabs.get(id).label : 'files'),
    restore,
    setAvailability,
  };
}
