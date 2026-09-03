// Global keyboard shortcut handling, extracted from app.js (vertical slice
// per AGENTS.md SOLID/Clean-Architecture preferences). This is the highest
// cross-cutting-coupling code in app.js (AGENTS.md flags it as historically
// crash-prone under webjsx keying mistakes) - the factory takes every
// dependency explicitly rather than closing over app.js's module scope, so
// the coupling is visible at the call site instead of implicit.
export function installShortcuts(state, render, helpers) {
  const {
    navTo, announce, closeFileDialog, filesMarked, clearFileSelection,
    cancelChat, newChat, previewNeighbours, openPreview,
    clearNewChatArmTimer, clearStopAllArmTimer, clearStopSelArmTimer,
  } = helpers;

  let gPending = false;

  function focusComposer() {
    const el = document.querySelector('#agentgui-main textarea, #agentgui-main [contenteditable="true"], #agentgui-main input[type="text"]');
    el?.focus();
  }
  function focusSearch() {
    const el = document.querySelector('#app input[type="search"]');
    el?.focus();
  }
  // Focus the active surface's filter input (Files grid filter / Live dashboard
  // filter) - both are search-type inputs inside the main region.
  function focusFilter() {
    const el = document.querySelector('#agentgui-main input[type="search"]')
      || document.querySelector('#agentgui-main .ds-file-filter-input')
      || document.querySelector('#agentgui-main input[type="text"]');
    el?.focus();
    return !!el;
  }

  window.addEventListener('keydown', (e) => {
    const t = e.target;
    const typing = t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable);
    // One explicit chord BEFORE the modifier early-return: Mod+Shift+L focuses
    // the composer from anywhere, even while typing in another field.
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === 'L' || e.key === 'l')) {
      e.preventDefault();
      navTo('chat');
      requestAnimationFrame(() => focusComposer());
      announce('composer focused');
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (typing) {
      // The cwd editor's own text input is the one exception: Escape there must
      // close the editor in a single press (matching every other Escape-
      // closeable surface in the app), not blur-then-require-a-second-press.
      if (e.key === 'Escape' && t.classList && t.classList.contains('agentchat-cwd-input')) {
        t.blur();
        // Fall through to the ladder below instead of returning early.
      } else {
        if (e.key === 'Escape') t.blur();
        return;
      }
    }
    if (e.key === 'Escape') {
      // Priority ladder for transient state (modals/drawers are kit-handled):
      // shortcuts overlay > armed confirms > stop a streaming generation.
      if (state.showShortcuts) { state.showShortcuts = false; render(); announce('shortcuts closed'); return; }
      // File-mutation dialog: close on Escape wherever focus sits (the kit's
      // backdrop listener covers in-dialog focus; this covers everything else).
      if (state.files.dialog) { if (!state.files.dialog.busy) closeFileDialog(); return; }
      if (state.chat.confirmingEdit) { state.chat.confirmingEdit = null; render(); announce('edit cancelled'); return; }
      // cwd editor: the browse popover is a nested layer within it - Escape
      // closes the popover first (one level of the nesting) before falling
      // through to closing the whole editor on a second press, matching the
      // dialog-then-page Escape convention used elsewhere in the app.
      if (state.cwdEditing) {
        if (state.cwdBrowse) { state.cwdBrowse = null; render(); announce('folder browser closed'); return; }
        state.cwdEditing = false; state.cwdDraft = undefined; state.cwdError = null; state.cwdChecking = false;
        render(); announce('cwd edit cancelled');
        requestAnimationFrame(() => { const btn = document.querySelector('.agentchat-cwd-btn'); if (btn) btn.focus(); });
        return;
      }
      if (state.confirmingClearData) { state.confirmingClearData = false; render(); announce('clear cancelled'); return; }
      if (state.confirmingNewChat) { clearNewChatArmTimer(); state.confirmingNewChat = false; render(); announce('new chat cancelled'); return; }
      if (state.live.confirmingStopAll || state.live.confirmingStopSelected) {
        state.live.confirmingStopAll = false; state.live.confirmingStopSelected = false;
        clearStopAllArmTimer(); clearStopSelArmTimer();
        render(); announce('stop cancelled'); return;
      }
      // A live file multi-select is transient state too: Escape drops it before
      // falling through to stop-generation.
      if (state.tab === 'files' && filesMarked().size) { clearFileSelection(); return; }
      if (state.chat.busy && state.tab === 'chat') { cancelChat(); announce('generation stopped'); return; }
      return;
    }
    if (gPending) {
      gPending = false;
      if (e.key === 'c') { navTo('chat'); return; }
      if (e.key === 'h') { navTo('history'); return; }
      if (e.key === 'f') { navTo('files'); return; }
      if (e.key === 'l') { navTo('live'); return; }
      if (e.key === 's') { navTo('settings'); return; }
      return;
    }
    if (e.key === 'g') { gPending = true; setTimeout(() => { gPending = false; }, 1000); return; }
    if (e.key === 'n' && state.tab === 'chat') { e.preventDefault(); newChat(); return; }
    if (e.key === '/') {
      // / targets the active surface's find affordance: search on history,
      // composer on chat, the filter inputs on files/live. Settings has no
      // field - the only documented no-op.
      if (state.tab === 'history') { e.preventDefault(); focusSearch(); announce('search focused'); }
      else if (state.tab === 'chat') { e.preventDefault(); focusComposer(); announce('composer focused'); }
      else if (state.tab === 'files' || state.tab === 'live') { e.preventDefault(); if (focusFilter()) announce('filter focused'); }
      return;
    }
    if (e.key === '?') { state.showShortcuts = !state.showShortcuts; render(); return; }
    // Left/Right: step through file previews (documented in SHORTCUTS).
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && state.tab === 'files' && state.files.preview) {
      const { prev, next } = previewNeighbours();
      const target = e.key === 'ArrowLeft' ? prev : next;
      if (target) { e.preventDefault(); openPreview(target); }
      return;
    }
  });

  // A file dropped anywhere outside a DropZone must never navigate the browser
  // away (destroying the live session view). DropZones handle their own events.
  window.addEventListener('dragover', (e) => {
    if (!(e.target instanceof Element) || !e.target.closest('.ds-dropzone')) e.preventDefault();
  });

  return { focusComposer, focusSearch, focusFilter };
}
