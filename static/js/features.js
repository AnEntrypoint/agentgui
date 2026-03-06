(function() {
  const BASE = window.__BASE_URL || '';
  let currentConversation = null;
  let currentView = 'chat';
  let dragCounter = 0;

  function init() {
    setupSidebarToggle();
    setupDragAndDrop();
    setupViewToggle();
    setupConversationListener();
    setupModelProgressIndicator();
  }

  function setupSidebarToggle() {
    var toggleBtn = document.querySelector('[data-sidebar-toggle]');
    var sidebar = document.querySelector('[data-sidebar]');
    var overlay = document.querySelector('[data-sidebar-overlay]');
    if (!sidebar) return;
    if (window.innerWidth <= 768) {
      sidebar.classList.add('collapsed');
    } else {
      var savedState = localStorage.getItem('sidebar-collapsed');
      if (savedState === 'true') sidebar.classList.add('collapsed');
    }
    function isMobile() { return window.innerWidth <= 768; }
    function toggleSidebar() {
      if (isMobile()) {
        sidebar.classList.contains('mobile-visible') ? closeSidebar() : openSidebar();
      } else {
        sidebar.classList.toggle('collapsed');
        localStorage.setItem('sidebar-collapsed', sidebar.classList.contains('collapsed'));
      }
    }
    function openSidebar() {
      sidebar.classList.add('mobile-visible');
      sidebar.classList.remove('collapsed');
      if (overlay) overlay.classList.add('visible');
    }
    function closeSidebar() {
      sidebar.classList.remove('mobile-visible');
      if (overlay) overlay.classList.remove('visible');
    }
    if (toggleBtn) toggleBtn.addEventListener('click', function(e) { e.stopPropagation(); toggleSidebar(); });
    if (overlay) overlay.addEventListener('click', closeSidebar);
    document.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') { e.preventDefault(); toggleSidebar(); }
    });
    window.addEventListener('conversation-selected', function() { if (isMobile()) closeSidebar(); });
    window.addEventListener('resize', function() {
      if (!isMobile()) { sidebar.classList.remove('mobile-visible'); if (overlay) overlay.classList.remove('visible'); }
    });
  }

  function setupDragAndDrop() {
    var dropZone = document.querySelector('[data-drop-zone]');
    var overlay = document.getElementById('dropZoneOverlay');
    if (!dropZone || !overlay) return;
    dropZone.addEventListener('dragenter', function(e) { e.preventDefault(); e.stopPropagation(); dragCounter++; if (dragCounter === 1) overlay.classList.add('visible'); });
    dropZone.addEventListener('dragover', function(e) { e.preventDefault(); e.stopPropagation(); });
    dropZone.addEventListener('dragleave', function(e) { e.preventDefault(); e.stopPropagation(); dragCounter--; if (dragCounter <= 0) { dragCounter = 0; overlay.classList.remove('visible'); } });
    dropZone.addEventListener('drop', function(e) {
      e.preventDefault(); e.stopPropagation(); dragCounter = 0; overlay.classList.remove('visible');
      if (!currentConversation) { if (window.UIDialog) window.UIDialog.showToast('Select a conversation first', 'error'); return; }
      var files = e.dataTransfer.files;
      if (!files || files.length === 0) return;
      uploadFiles(files);
    });
  }

  function uploadFiles(files) {
    if (!currentConversation) { if (window.UIDialog) window.UIDialog.showToast('No conversation selected', 'error'); return; }
    var formData = new FormData();
    for (var i = 0; i < files.length; i++) formData.append('file', files[i]);
    if (window.UIDialog) window.UIDialog.showToast('Uploading ' + files.length + ' file(s)...', 'info');
    fetch(BASE + '/api/upload/' + currentConversation, { method: 'POST', body: formData })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.ok) { if (window.UIDialog) window.UIDialog.showToast(data.count + ' file(s) uploaded', 'success'); }
        else { if (window.UIDialog) window.UIDialog.showToast('Upload failed: ' + (data.error || 'Unknown error'), 'error'); }
      })
      .catch(function(err) { if (window.UIDialog) window.UIDialog.showToast('Upload failed: ' + err.message, 'error'); });
  }

  function setupViewToggle() {
    var bar = document.getElementById('viewToggleBar');
    if (!bar) return;
    bar.querySelectorAll('.view-toggle-btn').forEach(function(btn) {
      btn.addEventListener('click', function() { switchView(btn.dataset.view); });
    });
  }

  function setupModelProgressIndicator() {
    var indicator = document.getElementById('modelDlIndicator');
    var tooltip = document.getElementById('modelDlTooltip');
    var progressCircle = indicator ? indicator.querySelector('.progress') : null;
    var circumference = 62.83;

    window.addEventListener('ws-message', function(e) {
      var data = e.detail;
      if (!data || data.type !== 'model_download_progress') return;
      var progress = data.progress || data;
      if (progress.done && progress.complete) {
        if (indicator) indicator.classList.remove('active');
        return;
      }
      if (progress.error || progress.status === 'failed') {
        if (indicator) indicator.classList.remove('active');
        if (tooltip) tooltip.textContent = 'Voice model download failed: ' + (progress.error || 'unknown');
        return;
      }
      if (progress.started || progress.downloading || progress.status === 'downloading') {
        if (indicator) indicator.classList.add('active');
        var pct = progress.percentComplete || 0;
        if (progress.completedFiles && progress.totalFiles) {
          pct = Math.round((progress.completedFiles / progress.totalFiles) * 100);
        }
        if (progressCircle) {
          progressCircle.style.strokeDashoffset = circumference - (circumference * pct / 100);
        }
        var msg = 'Downloading voice models... ' + pct + '%';
        if (progress.file) msg = 'Downloading ' + progress.file + '...';
        if (tooltip) tooltip.textContent = msg;
      }
    });

    if (window.wsClient) {
      window.wsClient.rpc('speech.status')
        .then(function(status) {
          if (status.modelsComplete) {
            if (indicator) indicator.classList.remove('active');
          } else if (status.modelsDownloading) {
            if (indicator) indicator.classList.add('active');
          }
        })
        .catch(function() {});
    }
  }

  function switchView(view) {
    currentView = view;
    var bar = document.getElementById('viewToggleBar');
    var chatArea = document.getElementById('output-scroll');
    var execPanel = document.querySelector('.input-section');
    var fileBrowser = document.getElementById('fileBrowserContainer');
    var fileIframe = document.getElementById('fileBrowserIframe');
    var terminalContainer = document.getElementById('terminalContainer');
    if (!bar) return;
    bar.querySelectorAll('.view-toggle-btn').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.view === view);
    });
    if (chatArea) chatArea.style.display = view === 'chat' ? '' : 'none';
    if (execPanel) execPanel.style.display = view === 'chat' ? '' : 'none';
    if (fileBrowser) fileBrowser.style.display = view === 'files' ? 'flex' : 'none';
    if (terminalContainer) terminalContainer.style.display = view === 'terminal' ? 'flex' : 'none';
    if (view === 'files' && fileIframe && currentConversation) {
      var src = BASE + '/files/' + currentConversation + '/';
      if (fileIframe.src !== location.origin + src) fileIframe.src = src;
    }
    window.dispatchEvent(new CustomEvent('view-switched', { detail: { view: view } }));
  }

  function updateViewToggleVisibility() {
    var bar = document.getElementById('viewToggleBar');
    if (!bar) return;
    bar.style.display = currentConversation ? 'flex' : 'none';
  }

  function setupConversationListener() {
    window.addEventListener('conversation-selected', function(e) {
      currentConversation = e.detail.conversationId;
      updateViewToggleVisibility();
      if (currentView === 'files') switchView('files');
    });
    window.addEventListener('conversation-deselected', function() {
      currentConversation = null;
      updateViewToggleVisibility();
      switchView('chat');
    });
  }

  window.switchView = switchView;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
