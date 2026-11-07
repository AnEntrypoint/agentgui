export const HASH_KEYS = ['tab', 'dir', 'file', 'filter'];

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
  const tab = state.tab || 'files';
  if (tab !== 'files') parts.push('tab=' + encodeURIComponent(tab));
  if (tab === 'files' && state.files) {
    if (state.files.path) parts.push('dir=' + encodeURIComponent(state.files.path));
    if (state.files.preview && state.files.preview.path) parts.push('file=' + encodeURIComponent(state.files.preview.path));
    if (state.files.filter) parts.push('filter=' + encodeURIComponent(state.files.filter));
  }
  return parts.length ? '#' + parts.join('&') : '';
}

export function writeHash(state, { push = false } = {}) {
  const h = buildHash(state);
  const url = location.pathname + location.search + h;
  if (location.hash === h || (!location.hash && !h)) return;
  (push ? history.pushState : history.replaceState).call(history, null, '', url);
}
