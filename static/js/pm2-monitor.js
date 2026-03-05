(function() {
  window.pm2Monitor = {
    enabled: false,
    processes: [],
    ws: null,
    monitoring: false,
    logsModalOpen: null,
    initialized: false
  };

  const pm2Panel = document.getElementById('pm2MonitorPanel');
  const pm2ProcessList = document.getElementById('pm2ProcessList');
  const pm2Loading = document.getElementById('pm2Loading');
  const pm2RefreshBtn = document.getElementById('pm2RefreshBtn');
  const pm2ToggleMonitorBtn = document.getElementById('pm2ToggleMonitorBtn');

  function init() {
    if (window.location.pathname.includes('index.html') || window.location.pathname.endsWith('/gm/') || document.body) {
      if (!window.pm2Monitor.initialized) {
        window.pm2Monitor.initialized = true;
        setupEventListeners();
        connectWebSocket();
      }
    }
  }

  function setupEventListeners() {
    if (pm2RefreshBtn) {
      pm2RefreshBtn.addEventListener('click', () => {
        sendPM2Message({ type: 'pm2_list' });
        showToast('Refreshing PM2 processes...', 'info');
      });
    }

    if (pm2ToggleMonitorBtn) {
      pm2ToggleMonitorBtn.addEventListener('click', () => {
        if (window.pm2Monitor.monitoring) {
          sendPM2Message({ type: 'pm2_stop_monitoring' });
          window.pm2Monitor.monitoring = false;
          pm2ToggleMonitorBtn.textContent = '▶';
          pm2ToggleMonitorBtn.title = 'Start monitoring';
        } else {
          sendPM2Message({ type: 'pm2_start_monitoring' });
          window.pm2Monitor.monitoring = true;
          pm2ToggleMonitorBtn.textContent = '⏸';
          pm2ToggleMonitorBtn.title = 'Pause monitoring';
        }
      });
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && window.pm2Monitor.logsModalOpen) {
        closeLogsModal();
      }
    });
  }

  function sendPM2Message(msg) {
    if (window.wsManager && window.wsManager.isConnected) {
      window.wsManager.sendMessage(msg);
    } else if (window.pm2Monitor.ws && window.pm2Monitor.ws.readyState === WebSocket.OPEN) {
      window.pm2Monitor.ws.send(JSON.stringify(msg));
    }
  }

  function onConnected() {
    console.log('[PM2 Monitor] WebSocket connected');
    window.pm2Monitor.monitoring = true;
    if (pm2ToggleMonitorBtn) {
      pm2ToggleMonitorBtn.textContent = '⏸';
      pm2ToggleMonitorBtn.title = 'Pause monitoring';
    }
    sendPM2Message({ type: 'pm2_list' });
    sendPM2Message({ type: 'pm2_start_monitoring' });
  }

  function connectWebSocket() {
    if (window.wsManager && window.wsManager.isConnected) {
      window.wsManager.on('message', handleWebSocketMessage);
      window.wsManager.on('connected', onConnected);
      if (window.wsManager.isConnected) {
        onConnected();
      }
      return;
    }

    if (window.__BASE_URL) {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${location.host}${window.__BASE_URL}/sync`;
      window.pm2Monitor.ws = new WebSocket(wsUrl);
      window.pm2Monitor.ws.onopen = onConnected;
      window.pm2Monitor.ws.onmessage = (e) => {
        try {
          handleWebSocketMessage(JSON.parse(e.data));
        } catch (err) {}
      };
      window.pm2Monitor.ws.onclose = () => {
        console.log('[PM2 Monitor] WebSocket closed, reconnecting...');
        setTimeout(connectWebSocket, 3000);
      };
      window.pm2Monitor.ws.onerror = (err) => {
        console.error('[PM2 Monitor] WebSocket error:', err);
      };
    }
  }

  function handleWebSocketMessage(msg) {
    if (msg.type === 'pm2_list_response') {
      window.pm2Monitor.processes = msg.processes || [];
      renderProcessList();
      hideLoading();
    } else if (msg.type === 'pm2_monit_update') {
      window.pm2Monitor.processes = msg.processes || [];
      renderProcessList();
    } else if (msg.type === 'pm2_start_response' || msg.type === 'pm2_stop_response' ||
               msg.type === 'pm2_restart_response' || msg.type === 'pm2_delete_response') {
      const success = msg.success;
      const name = msg.name;
      if (success) {
        showToast(`${msg.type.split('_')[1]} ${name} successful`, 'success');
        setTimeout(() => window.wsManager.send({ type: 'pm2_list' }), 500);
      } else {
        showToast(`${msg.type.split('_')[1]} ${name} failed: ${msg.error}`, 'error');
      }
    } else if (msg.type === 'pm2_logs_response') {
      if (msg.success) {
        showLogsModal(msg.name, msg.logs);
      } else {
        showToast(`Failed to get logs: ${msg.error}`, 'error');
      }
    } else if (msg.type === 'pm2_flush_logs_response') {
      if (msg.success) {
        showToast('Logs flushed', 'success');
      } else {
        showToast(`Failed to flush logs: ${msg.error}`, 'error');
      }
    } else if (msg.type === 'pm2_ping_response') {
      if (!msg.success) {
        console.warn('[PM2 Monitor] PM2 daemon not responding:', msg.error);
      }
    }
  }

  function renderProcessList() {
    if (!pm2ProcessList) return;

    if (window.pm2Monitor.processes.length === 0) {
      pm2ProcessList.innerHTML = '<div class="pm2-empty">No PM2 processes found</div>';
      return;
    }

    pm2ProcessList.innerHTML = window.pm2Monitor.processes.map(proc => `
      <div class="pm2-process-item ${proc.status}" data-pm2-name="${proc.name}">
        <div class="pm2-process-name">${escapeHtml(proc.name)}</div>
        <div class="pm2-process-meta">
          <span title="Status">● ${proc.status}</span>
          <span title="CPU">🖥 ${proc.cpu && proc.cpu.toFixed(1) || '0.0'}%</span>
          <span title="Memory">💾 ${formatBytes(proc.memory)}</span>
          <span title="Uptime">⏱ ${formatUptime(proc.uptime)}</span>
          <span title="PID">#${proc.pid || '—'}</span>
        </div>
        <div class="pm2-process-actions">
          ${proc.status === 'stopped' ? `<button class="pm2-btn" onclick="window.pm2Monitor.startProcess('${escapeAttr(proc.name)}')">Start</button>` : ''}
          ${proc.status === 'online' ? `<button class="pm2-btn danger" onclick="window.pm2Monitor.stopProcess('${escapeAttr(proc.name)}')">Stop</button>` : ''}
          <button class="pm2-btn" onclick="window.pm2Monitor.restartProcess('${escapeAttr(proc.name)}')">Restart</button>
          <button class="pm2-btn danger" onclick="window.pm2Monitor.deleteProcess('${escapeAttr(proc.name)}')">Delete</button>
          <button class="pm2-btn" onclick="window.pm2Monitor.showLogs('${escapeAttr(proc.name)}')">Logs</button>
          <button class="pm2-btn" onclick="window.pm2Monitor.flushLogs('${escapeAttr(proc.name)}')">Flush</button>
        </div>
      </div>
    `).join('');
  }

  function hideLoading() {
    if (pm2Loading) pm2Loading.style.display = 'none';
  }

  function showToast(message, type = 'info') {
    const existing = document.querySelector('.pm2-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `pm2-toast pm2-toast-${type}`;
    toast.textContent = message;
    toast.style.cssText = `
      position: fixed;
      top: 1rem;
      right: 1rem;
      padding: 0.5rem 1rem;
      border-radius: 0.375rem;
      font-size: 0.8rem;
      color: white;
      z-index: 10000;
      animation: slideIn 0.3s ease;
      ${type === 'error' ? 'background: var(--color-error);' : type === 'success' ? 'background: var(--color-success);' : 'background: var(--color-primary);'}
    `;
    document.body.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s';
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  function showLogsModal(name, logs) {
    if (window.pm2Monitor.logsModalOpen) closeLogsModal();

    const modal = document.createElement('div');
    modal.className = 'pm2-logs-modal';
    modal.innerHTML = `
      <div class="pm2-logs-content">
        <div class="pm2-logs-header">
          <span>PM2 Logs: ${escapeHtml(name)}</span>
          <button class="pm2-btn" onclick="window.pm2Monitor.closeLogsModal()">× Close</button>
        </div>
        <div class="pm2-logs-body">${escapeHtml(logs || 'No logs available')}</div>
        <div class="pm2-logs-footer">
          <button class="pm2-btn" onclick="window.pm2Monitor.flushLogs('${escapeAttr(name)}')">Flush Logs</button>
          <button class="pm2-btn" onclick="window.pm2Monitor.closeLogsModal()">Close</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    window.pm2Monitor.logsModalOpen = name;
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeLogsModal();
    });
  }

  window.pm2Monitor.closeLogsModal = function() {
    const modal = document.querySelector('.pm2-logs-modal');
    if (modal) modal.remove();
    window.pm2Monitor.logsModalOpen = null;
  };

  window.pm2Monitor.startProcess = function(name) {
    sendPM2Message({ type: 'pm2_start', name });
  };

  window.pm2Monitor.stopProcess = function(name) {
    sendPM2Message({ type: 'pm2_stop', name });
  };

  window.pm2Monitor.restartProcess = function(name) {
    sendPM2Message({ type: 'pm2_restart', name });
  };

  window.pm2Monitor.deleteProcess = function(name) {
    if (confirm(`Delete PM2 process "${name}"?`)) {
      sendPM2Message({ type: 'pm2_delete', name });
    }
  };

  window.pm2Monitor.showLogs = function(name) {
    sendPM2Message({ type: 'pm2_logs', name, lines: 200 });
  };

  window.pm2Monitor.flushLogs = function(name) {
    sendPM2Message({ type: 'pm2_flush_logs', name });
  };

  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function escapeAttr(text) {
    if (!text) return '';
    return text.replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function formatUptime(seconds) {
    if (!seconds || seconds < 60) return `${seconds}s`;
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    const parts = [];
    if (days > 0) parts.push(`${days}d`);
    if (hours > 0) parts.push(`${hours}h`);
    if (mins > 0) parts.push(`${mins}m`);
    if (secs > 0 && days === 0 && hours === 0) parts.push(`${secs}s`);
    return parts.join(' ') || '0s';
  }

  window.addEventListener('load', () => {
    setTimeout(init, 100);
  });

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(init, 100);
  }
})();