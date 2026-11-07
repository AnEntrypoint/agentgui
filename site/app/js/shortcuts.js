export function installShortcuts({ state, announce, closeFileDialog, filesMarked, clearFileSelection, previewNeighbours, openPreview }) {
  window.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t instanceof Element && t.closest('#term-host')) return;
    const typing = t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable);
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (typing) {
      if (e.key === 'Escape') t.blur();
      return;
    }
    if (e.key === 'Escape') {
      if (state.files.dialog) {
        if (!state.files.dialog.busy) closeFileDialog();
        return;
      }
      if (state.tab === 'files' && filesMarked().size) clearFileSelection();
      return;
    }
    if (e.key === '/' && state.tab === 'files') {
      const el = document.querySelector('#files-root input[type="search"]') || document.querySelector('#files-root input[type="text"]');
      if (el) {
        e.preventDefault();
        el.focus();
        announce('filter focused');
      }
      return;
    }
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && state.tab === 'files' && state.files.preview) {
      const { prev, next } = previewNeighbours();
      const target = e.key === 'ArrowLeft' ? prev : next;
      if (target) {
        e.preventDefault();
        openPreview(target);
      }
    }
  });

  window.addEventListener('dragover', (e) => {
    if (!(e.target instanceof Element) || !e.target.closest('.ds-dropzone')) e.preventDefault();
  });
  window.addEventListener('drop', (e) => {
    if (!(e.target instanceof Element) || !e.target.closest('.ds-dropzone')) e.preventDefault();
  });
}
