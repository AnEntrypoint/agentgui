/**
 * Features Module
 * Drag-and-drop file upload, fsbrowse file browser toggle, mobile sidebar
 */

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
  }

  function setupSidebarToggle() {
    var toggleBtn = document.querySelector('[data-sidebar-toggle]');
    var sidebar = document.querySelector('[data-sidebar]');
    var overlay = document.querySelector('[data-sidebar-overlay]');

    if (!sidebar) return;

    var savedState = localStorage.getItem('sidebar-collapsed');
    if (savedState === 'true' && window.innerWidth > 768) {
      sidebar.classList.add('collapsed');
    }

    function isMobile() { return window.innerWidth <= 768; }

    function toggleSidebar() {
      if (isMobile()) {
        var isOpen = sidebar.classList.contains('mobile-visible');
        if (isOpen) { closeSidebar(); } else { openSidebar(); }
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

    if (toggleBtn) {
      toggleBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        toggleSidebar();
      });
    }

    if (overlay) {
      overlay.addEventListener('click', closeSidebar);
    }

    document.addEventListener('keydown', function(e) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'b') {
        e.preventDefault();
        toggleSidebar();
      }
    });

    window.addEventListener('conversation-selected', function() {
      if (isMobile()) closeSidebar();
    });

    window.addEventListener('resize', function() {
      if (!isMobile()) {
        sidebar.classList.remove('mobile-visible');
        if (overlay) overlay.classList.remove('visible');
      }
    });
  }

  // --- Drag and Drop File Upload ---
  function setupDragAndDrop() {
    const dropZone = document.querySelector('[data-drop-zone]');
    const overlay = document.getElementById('dropZoneOverlay');

    if (!dropZone || !overlay) return;

    dropZone.addEventListener('dragenter', function(e) {
      e.preventDefault();
      e.stopPropagation();
      dragCounter++;
      if (dragCounter === 1) {
        overlay.classList.add('visible');
      }
    });

    dropZone.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.stopPropagation();
    });

    dropZone.addEventListener('dragleave', function(e) {
      e.preventDefault();
      e.stopPropagation();
      dragCounter--;
      if (dragCounter <= 0) {
        dragCounter = 0;
        overlay.classList.remove('visible');
      }
    });

    dropZone.addEventListener('drop', function(e) {
      e.preventDefault();
      e.stopPropagation();
      dragCounter = 0;
      overlay.classList.remove('visible');

      if (!currentConversation) {
        showToast('Select a conversation first', 'error');
        return;
      }

      const files = e.dataTransfer.files;
      if (!files || files.length === 0) return;

      uploadFiles(files);
    });
  }

  function uploadFiles(files) {
    if (!currentConversation) {
      showToast('No conversation selected', 'error');
      return;
    }

    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
      formData.append('file', files[i]);
    }

    showToast('Uploading ' + files.length + ' file(s)...', 'info');

    fetch(BASE + '/api/upload/' + currentConversation, {
      method: 'POST',
      body: formData
    })
    .then(function(res) { return res.json(); })
    .then(function(data) {
      if (data.ok) {
        showToast(data.count + ' file(s) uploaded', 'success');
      } else {
        showToast('Upload failed: ' + (data.error || 'Unknown error'), 'error');
      }
    })
    .catch(function(err) {
      showToast('Upload failed: ' + err.message, 'error');
    });
  }

  function showToast(message, type) {
    var existing = document.querySelector('.upload-toast');
    if (existing) existing.remove();

    var toast = document.createElement('div');
    toast.className = 'upload-toast ' + (type || 'info');
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(function() {
      toast.style.opacity = '0';
      setTimeout(function() { toast.remove(); }, 300);
    }, 3000);
  }

  // --- View Toggle (Chat / Files) ---
  function setupViewToggle() {
    var bar = document.getElementById('viewToggleBar');
    if (!bar) return;

    var buttons = bar.querySelectorAll('.view-toggle-btn');
    buttons.forEach(function(btn) {
      btn.addEventListener('click', function() {
        var view = btn.dataset.view;
        switchView(view);
      });
    });
  }

  function switchView(view) {
    currentView = view;
    var bar = document.getElementById('viewToggleBar');
    var chatArea = document.getElementById('output-scroll');
    var execPanel = document.querySelector('.input-section');
    var fileBrowser = document.getElementById('fileBrowserContainer');
    var fileIframe = document.getElementById('fileBrowserIframe');
    var voiceContainer = document.getElementById('voiceContainer');

    if (!bar) return;

    bar.querySelectorAll('.view-toggle-btn').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.view === view);
    });

    if (chatArea) chatArea.style.display = view === 'chat' ? '' : 'none';
    if (execPanel) execPanel.style.display = view === 'chat' ? '' : 'none';
    if (fileBrowser) fileBrowser.style.display = view === 'files' ? 'flex' : 'none';
    if (voiceContainer) voiceContainer.style.display = view === 'voice' ? 'flex' : 'none';

    if (view === 'files' && fileIframe && currentConversation) {
      var src = BASE + '/files/' + currentConversation + '/';
      if (fileIframe.src !== location.origin + src) {
        fileIframe.src = src;
      }
    }

    if (view === 'voice' && window.voiceModule) {
      window.voiceModule.activate();
    } else if (view !== 'voice' && window.voiceModule) {
      window.voiceModule.deactivate();
    }
  }

  function updateViewToggleVisibility() {
    var bar = document.getElementById('viewToggleBar');
    if (!bar) return;

    // Show toggle bar only when a conversation is selected
    if (currentConversation) {
      bar.style.display = 'flex';
    } else {
      bar.style.display = 'none';
    }
  }

  // --- Conversation Listener ---
  function setupConversationListener() {
    window.addEventListener('conversation-selected', function(e) {
      currentConversation = e.detail.conversationId;
      updateViewToggleVisibility();
      // If currently in files view, reload the iframe
      if (currentView === 'files') {
        switchView('files');
      }
    });

    // Also listen for conversation created
    window.addEventListener('create-new-conversation', function() {
      // Will be updated when conversation-selected fires
    });
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
