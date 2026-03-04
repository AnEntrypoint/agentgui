(function() {
  var btn = document.getElementById('toolsManagerBtn');
  var popup = document.getElementById('toolsPopup');
  var tools = [];
  var isRefreshing = false;
  var operationInProgress = new Set();

  function init() {
    if (!btn || !popup) return;
    btn.style.display = 'flex';
    btn.addEventListener('click', togglePopup);
    document.addEventListener('click', function(e) {
      if (!btn.contains(e.target) && !popup.contains(e.target)) closePopup();
    });
    window.addEventListener('ws-message', onWsMessage);

    // Initialize voice controls
    initVoiceControls();
    refresh();
  }

  function initVoiceControls() {
    var autoSpeakToggle = document.getElementById('toolsAutoSpeakToggle');
    var voiceSelector = document.getElementById('toolsVoiceSelector');

    if (!autoSpeakToggle || !voiceSelector) return;

    // Load saved preferences
    var savedAutoSpeak = localStorage.getItem('toolsAutoSpeak') === 'true';
    var savedVoice = localStorage.getItem('toolsVoice') || 'default';

    autoSpeakToggle.checked = savedAutoSpeak;
    voiceSelector.value = savedVoice;

    // Listen for voice list updates
    window.addEventListener('ws-message', function(e) {
      var data = e.detail;
      if (data && data.type === 'voice_list') {
        updateVoiceSelector(data.voices);
      }
    });

    // Save preferences on change
    autoSpeakToggle.addEventListener('change', function() {
      localStorage.setItem('toolsAutoSpeak', this.checked);
    });

    voiceSelector.addEventListener('change', function() {
      localStorage.setItem('toolsVoice', this.value);
    });
  }

  function updateVoiceSelector(voices) {
    var voiceSelector = document.getElementById('toolsVoiceSelector');
    if (!voiceSelector || !voices || !Array.isArray(voices)) return;

    var currentValue = voiceSelector.value;
    voiceSelector.innerHTML = '<option value="default">Voice</option>';

    voices.forEach(function(voice) {
      var option = document.createElement('option');
      option.value = voice;
      option.textContent = voice;
      voiceSelector.appendChild(option);
    });

    if (voices.includes(currentValue)) {
      voiceSelector.value = currentValue;
    }
  }

  function refresh() {
    fetchTools();
  }

  function fetchTools() {
    window.wsClient.rpc('tools.list')
      .then(function(data) {
        tools = data.tools || [];
        render();
      })
      .catch(function() {
        fetch('/gm/api/tools')
          .then(r => r.json())
          .then(d => {
            tools = d.tools || [];
            render();
          })
          .catch(function(e) {
            console.error('[TOOLS-MGR]', e.message);
          });
      });
  }

  function getStatusColor(tool) {
    if (tool.status === 'installing' || tool.status === 'updating') return '#3b82f6';
    if (tool.status === 'needs_update' || (tool.status === 'installed' && tool.hasUpdate)) return '#f59e0b';
    if (tool.status === 'installed') return '#10b981';
    if (tool.status === 'failed') return '#ef4444';
    return '#6b7280';
  }

  function getStatusText(tool) {
    if (tool.status === 'installing') return 'Installing...';
    if (tool.status === 'updating') return 'Updating...';
    if (tool.status === 'needs_update') return 'Update available';
    if (tool.status === 'installed') {
      return tool.hasUpdate ? 'Update available' : 'Up-to-date';
    }
    if (tool.status === 'failed') return 'Installation failed';
    return 'Not installed';
  }

  function getStatusClass(tool) {
    if (tool.status === 'installing' || tool.status === 'updating') return 'installing';
    if (tool.status === 'needs_update' || (tool.status === 'installed' && tool.hasUpdate)) return 'updating';
    if (tool.status === 'installed') return 'installed';
    if (tool.status === 'failed') return 'failed';
    return 'not-installed';
  }

  function install(toolId) {
    if (operationInProgress.has(toolId)) return;
    operationInProgress.add(toolId);
    var tool = tools.find(t => t.id === toolId);
    if (tool) {
      tool.status = 'installing';
      tool.progress = 0;
      render();
    }
    fetch(`/gm/api/tools/${toolId}/install`, { method: 'POST' })
      .then(r => r.json())
      .then(d => {
        if (!d.success) {
          alert(`Install failed: ${d.error || 'Unknown error'}`);
          operationInProgress.delete(toolId);
          if (tool) {
            tool.status = 'failed';
            render();
          }
        }
      })
      .catch(e => {
        alert(`Install failed: ${e.message}`);
        operationInProgress.delete(toolId);
        if (tool) {
          tool.status = 'failed';
          render();
        }
      });
  }

  function update(toolId) {
    if (operationInProgress.has(toolId)) return;
    operationInProgress.add(toolId);
    var tool = tools.find(t => t.id === toolId);
    if (tool) {
      tool.status = 'updating';
      tool.progress = 0;
      render();
    }
    fetch(`/gm/api/tools/${toolId}/update`, { method: 'POST' })
      .then(r => r.json())
      .then(d => {
        if (!d.success) {
          alert(`Update failed: ${d.error || 'Unknown error'}`);
          operationInProgress.delete(toolId);
          if (tool) {
            tool.status = 'failed';
            render();
          }
        }
      })
      .catch(e => {
        alert(`Update failed: ${e.message}`);
        operationInProgress.delete(toolId);
        if (tool) {
          tool.status = 'failed';
          render();
        }
      });
  }

  function togglePopup(e) {
    e.stopPropagation();
    if (!popup.classList.contains('open')) {
      isRefreshing = false;
      refresh();
    }
    popup.classList.toggle('open');
  }

  function closePopup() {
    popup.classList.remove('open');
  }

  function onWsMessage(e) {
    var data = e.detail;
    if (!data) return;

    if (data.type === 'tools_update_started') {
      var updateTools = data.tools || [];
      updateTools.forEach(function(toolId) {
        var tool = tools.find(t => t.id === toolId);
        if (tool) {
          tool.status = 'updating';
          tool.progress = 5;
        }
      });
      render();
    } else if (data.type === 'tool_install_started' || data.type === 'tool_install_progress' || data.type === 'tool_update_progress') {
      var tool = tools.find(t => t.id === data.toolId);
      if (tool) {
        tool.status = (data.type === 'tool_install_started' || data.type === 'tool_install_progress') ? 'installing' : 'updating';
        tool.progress = (tool.progress || 0) + 5;
        if (tool.progress > 90) tool.progress = 90;
        render();
      }
    } else if (data.type === 'tool_install_complete' || data.type === 'tool_update_complete') {
      var tool = tools.find(t => t.id === data.toolId);
      if (tool) {
        tool.status = data.data?.isUpToDate ? 'installed' : 'needs_update';
        tool.version = data.data?.version || tool.version;
        tool.installedVersion = data.data?.installedVersion || tool.installedVersion;
        tool.publishedVersion = data.data?.publishedVersion || tool.publishedVersion;
        tool.isUpToDate = data.data?.isUpToDate ?? false;
        tool.upgradeNeeded = data.data?.upgradeNeeded ?? false;
        tool.hasUpdate = (data.data?.upgradeNeeded && data.data?.installed) ?? false;
        tool.progress = 100;
        operationInProgress.delete(data.toolId);
        render();
        setTimeout(fetchTools, 1000);
      }
    } else if (data.type === 'tool_install_failed' || data.type === 'tool_update_failed') {
      var tool = tools.find(t => t.id === data.toolId);
      if (tool) {
        tool.status = 'failed';
        tool.error_message = data.data?.error;
        tool.progress = 0;
        operationInProgress.delete(data.toolId);
        render();
      }
    } else if (data.type === 'tools_update_complete') {
      fetchTools();
    } else if (data.type === 'tools_refresh_complete') {
      isRefreshing = false;
      fetchTools();
    }
  }

  function render() {
    var scroll = popup.querySelector('.tools-popup-scroll');
    if (!scroll) return;

    if (tools.length === 0) {
      scroll.innerHTML = '<div class="tool-empty-state" style="grid-column: 1 / -1;"><div class="tool-empty-state-icon">⚙️</div><div class="tool-empty-state-text">No tools available</div></div>';
      return;
    }

    scroll.innerHTML = tools.map(function(tool) {
      var statusClass = getStatusClass(tool);
      var isInstalling = tool.status === 'installing' || tool.status === 'updating';
      var versionInfo = '';
      if (tool.installedVersion || tool.publishedVersion) {
        versionInfo = '<div class="tool-versions">';
        if (tool.installedVersion) {
          versionInfo += '<span class="tool-version-item">v' + esc(tool.installedVersion) + '</span>';
        }
        if (tool.publishedVersion && tool.installedVersion !== tool.publishedVersion) {
          versionInfo += '<span class="tool-version-item">(v' + esc(tool.publishedVersion) + ' available)</span>';
        }
        versionInfo += '</div>';
      }

      return '<div class="tool-item">' +
        '<div style="display: flex; flex-direction: column; gap: 0.3rem;">' +
        '<div class="tool-header">' +
        '<span class="tool-name">' + esc(tool.id) + '</span>' +
        '</div>' +
        '<div class="tool-status-indicator ' + statusClass + '">' +
        '<span class="tool-status-dot"></span>' +
        '<span>' + getStatusText(tool) + '</span>' +
        '</div>' +
        versionInfo +
        (isInstalling && tool.progress !== undefined ?
          '<div class="tool-progress-container">' +
          '<div class="tool-progress-bar"><div class="tool-progress-fill" style="width:' + Math.min(tool.progress, 100) + '%"></div></div>' +
          '</div>' : '') +
        (tool.error_message ? '<div class="tool-error-message">Error: ' + esc(tool.error_message.substring(0, 40)) + '</div>' : '') +
        '</div>' +
        '<div class="tool-actions">' +
        (tool.status === 'not_installed' ?
          '<button class="tool-btn tool-btn-primary" onclick="window.toolsManager.install(\'' + tool.id + '\')" ' + (operationInProgress.has(tool.id) ? 'disabled' : '') + '>Install</button>' :
          (tool.hasUpdate || tool.status === 'needs_update') ?
          '<button class="tool-btn tool-btn-primary" onclick="window.toolsManager.update(\'' + tool.id + '\')" ' + (operationInProgress.has(tool.id) ? 'disabled' : '') + '>Update</button>' :
          tool.status === 'failed' ?
          '<button class="tool-btn tool-btn-primary" onclick="window.toolsManager.install(\'' + tool.id + '\')" ' + (operationInProgress.has(tool.id) ? 'disabled' : '') + '>Retry</button>' :
          '<button class="tool-btn tool-btn-secondary" onclick="window.toolsManager.refresh()" ' + (isRefreshing ? 'disabled' : '') + '>✓</button>'
        ) +
        '</div>' +
        '</div>';
    }).join('');
  }

  function esc(s) {
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  function updateAll() {
    var toolsWithUpdates = tools.filter(function(t) {
      return t.hasUpdate || t.status === 'needs_update' || t.status === 'failed';
    });

    if (toolsWithUpdates.length === 0) {
      alert('All tools are up-to-date');
      return;
    }

    for (var i = 0; i < toolsWithUpdates.length; i++) {
      operationInProgress.add(toolsWithUpdates[i].id);
      var tool = tools.find(function(t) { return t.id === toolsWithUpdates[i].id; });
      if (tool) {
        tool.status = 'updating';
        tool.progress = 0;
      }
    }
    render();

    fetch('/gm/api/tools/update', { method: 'POST' })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (!d.updating) {
          alert('Update started, but response unexpected');
          for (var i = 0; i < toolsWithUpdates.length; i++) {
            operationInProgress.delete(toolsWithUpdates[i].id);
          }
        }
      })
      .catch(function(e) {
        alert('Update failed: ' + e.message);
        for (var i = 0; i < toolsWithUpdates.length; i++) {
          operationInProgress.delete(toolsWithUpdates[i].id);
        }
      });
  }

  window.toolsManager = {
    refresh: function() {
      isRefreshing = true;
      render();
      fetch('/gm/api/tools/refresh-all', { method: 'POST' })
        .catch(function(e) { console.error('[TOOLS-MGR]', e.message); });
    },
    install: function(toolId) { install(toolId); },
    update: function(toolId) { update(toolId); },
    updateAll: function() { updateAll(); },
    getAutoSpeak: function() {
      var toggle = document.getElementById('toolsAutoSpeakToggle');
      return toggle ? toggle.checked : false;
    },
    getVoice: function() {
      var selector = document.getElementById('toolsVoiceSelector');
      return selector ? selector.value : 'default';
    },
    setAutoSpeak: function(value) {
      var toggle = document.getElementById('toolsAutoSpeakToggle');
      if (toggle) {
        toggle.checked = value;
        localStorage.setItem('toolsAutoSpeak', value);
      }
    },
    setVoice: function(value) {
      var selector = document.getElementById('toolsVoiceSelector');
      if (selector && Array.from(selector.options).some(opt => opt.value === value)) {
        selector.value = value;
        localStorage.setItem('toolsVoice', value);
      }
    }
  };
})();
