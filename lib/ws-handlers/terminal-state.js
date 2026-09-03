// Short-lived per-session terminal-event buffer (finding 35): a turn that
// completes/errors/cancels while a client ws is down would otherwise be a
// fire-and-forget broadcast the client never sees, hanging it busy forever.
// A re-subscribing client gets the buffered terminal frame replayed.
const TERMINAL_TTL_MS = 60000;
const terminalEvents = new Map(); // sessionId -> terminal event

export function recordTerminal(sessionId, event) {
  terminalEvents.set(sessionId, event);
  const t = setTimeout(() => {
    if (terminalEvents.get(sessionId) === event) terminalEvents.delete(sessionId);
  }, TERMINAL_TTL_MS);
  if (typeof t.unref === 'function') t.unref();
}

export function getTerminal(sessionId) { return terminalEvents.get(sessionId); }
