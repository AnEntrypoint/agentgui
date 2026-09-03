// Hash-based deep-link state, extracted from app.js (vertical slice per
// AGENTS.md SOLID/Clean-Architecture preferences). Full hash routing state is
// HASH_KEYS; popstate diffs the full set, and navTo(tab,{writeHash:false})
// navigates without pushing a new hash entry (navTo itself stays in app.js -
// it orchestrates tab-switch side effects like reloading history/files/live
// data, not just the hash string, so it is a broader concern than routing).
export const HASH_KEYS = ['tab', 'sid', 'dir', 'file', 'q', 'project', 'section', 'filter', 'lsort', 'lfilter', 'lerr', 'ets'];

export function readHash() {
  const hash = location.hash || '';
  const out = {};
  for (const k of HASH_KEYS) {
    const m = hash.match(new RegExp('(?:^#|&)' + k + '=([^&]*)'));
    out[k] = m ? decodeURIComponent(m[1]) : null;
  }
  return out;
}

export function buildHash(state) {
  const parts = [];
  const tab = state.tab || 'chat';
  // tab is omitted for the default chat tab, EXCEPT when a session id rides
  // along - a bare #sid= historically meant history, so chat+sid must name its
  // tab explicitly or the deep-link restores the wrong surface.
  if (tab !== 'chat') parts.push('tab=' + encodeURIComponent(tab));
  else if (state.selectedSid) parts.push('tab=chat');
  // Keep sid whenever set (regardless of tab) so Back restores the selection.
  if (state.selectedSid) parts.push('sid=' + encodeURIComponent(state.selectedSid));
  if (tab === 'files' && state.files) {
    if (state.files.path) parts.push('dir=' + encodeURIComponent(state.files.path));
    if (state.files.preview && state.files.preview.path) parts.push('file=' + encodeURIComponent(state.files.preview.path));
    if (state.files.filter) parts.push('filter=' + encodeURIComponent(state.files.filter));
  }
  if (tab === 'history') {
    const q = (state.searchQ || '').trim();
    if (q.length >= 2) parts.push('q=' + encodeURIComponent(q));
    if (state.projectFilter) parts.push('project=' + encodeURIComponent(state.projectFilter));
    // A session opened from a search hit carries the matched event's
    // timestamp so reload/Back reproduces the same scrolled+flashed position
    // a live click gives - without this, the anchor only existed in memory
    // and a search-hit URL degraded to just the bare session on reload.
    if (state._focusEventTs != null) parts.push('ets=' + encodeURIComponent(state._focusEventTs));
  }
  if (tab === 'settings' && state.settingsSection) parts.push('section=' + encodeURIComponent(state.settingsSection));
  if (tab === 'live') {
    const lv = state.live || {};
    if (lv.sort && lv.sort !== 'status') parts.push('lsort=' + encodeURIComponent(lv.sort));
    if (lv.filter) parts.push('lfilter=' + encodeURIComponent(lv.filter));
    if (lv.errorsOnly) parts.push('lerr=1');
  }
  return parts.length ? '#' + parts.join('&') : '';
}

export function writeHash(state, { push = false } = {}) {
  const h = buildHash(state);
  const url = location.pathname + location.search + h;
  if (location.hash === h || (!location.hash && !h)) return;
  // pushState for user navigation steps (tab visits, session selection,
  // directory walks, preview opens) so Back retraces them; replaceState for
  // passive state sync (search text, filter resets).
  (push ? history.pushState : history.replaceState).call(history, null, '', url);
}
