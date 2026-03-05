(function() {
  const ACTIVE_STATES = new Set(['online', 'launching', 'stopping', 'waiting restart']);

  window.pm2Monitor = { processes: [], logsModalOpen: null, initialized: false };

  const panel = document.getElementById('pm2MonitorPanel');
  const list = document.getElementById('pm2ProcessList');
  const refreshBtn = document.getElementById('pm2RefreshBtn');

  function send(msg) {
    if (window.wsManager && window.wsManager.isConnected) window.wsManager.sendMessage(msg);
  }

  function setPanelVisible(visible) {
    if (!panel) return;
    panel.style.display = visible ? 'flex' : 'none';
  }

  function renderProcessList(processes) {
    if (!list) return;
    const active = processes.filter(p => ACTIVE_STATES.has(p.status));
    const inactive = processes.filter(p => !ACTIVE_STATES.has(p.status));
    const ordered = [...active, ...inactive];
    list.innerHTML = ordered.map(proc => {
      const isActive = ACTIVE_STATES.has(proc.status);
      const uptimeSec = proc.uptime ? Math.floor((Date.now() - proc.uptime) / 1000) : null;
      return `<div class="pm2-process-item ${proc.status}" data-pm2-name="${escAttr(proc.name)}">
        <div class="pm2-process-name">${escHtml(proc.name)} <span class="pm2-status-dot pm2-status-${proc.status}"></span></div>
        <div class="pm2-process-meta">
          <span>${proc.status}</span>
          <span>${(proc.cpu || 0).toFixed(1)}% CPU</span>
          <span>${fmtBytes(proc.memory)}</span>
          ${uptimeSec !== null ? `<span>${fmtUptime(uptimeSec)}</span>` : ''}
          <span>#${proc.pid || '-'}</span>
          ${proc.restarts > 0 ? `<span>${proc.restarts}x restarts</span>` : ''}
        </div>
        <div class="pm2-process-actions">
          ${!isActive ? `<button class="pm2-btn" onclick="window.pm2Monitor.startProcess('${escAttr(proc.name)}')">Start</button>` : ''}
          ${proc.status === 'online' ? `<button class="pm2-btn danger" onclick="window.pm2Monitor.stopProcess('${escAttr(proc.name)}')">Stop</button>` : ''}
          <button class="pm2-btn" onclick="window.pm2Monitor.restartProcess('${escAttr(proc.name)}')">Restart</button>
          <button class="pm2-btn" onclick="window.pm2Monitor.showLogs('${escAttr(proc.name)}')">Logs</button>
          <button class="pm2-btn danger" onclick="window.pm2Monitor.deleteProcess('${escAttr(proc.name)}')">Delete</button>
        </div>
      </div>`;
    }).join('');
  }

  function handleMessage(msg) {
    if (msg.type === 'pm2_monit_update') {
      const procs = msg.processes || [];
      window.pm2Monitor.processes = procs;
      const hasActive = msg.hasActive || procs.some(p => ACTIVE_STATES.has(p.status));
      setPanelVisible(hasActive);
      if (hasActive) renderProcessList(procs);
    } else if (msg.type === 'pm2_list_response') {
      const procs = msg.processes || [];
      window.pm2Monitor.processes = procs;
      const hasActive = procs.some(p => ACTIVE_STATES.has(p.status));
      setPanelVisible(hasActive);
      if (hasActive) renderProcessList(procs);
    } else if (msg.type === 'pm2_unavailable') {
      setPanelVisible(false);
    } else if (msg.type === 'pm2_start_response' || msg.type === 'pm2_stop_response' ||
               msg.type === 'pm2_restart_response' || msg.type === 'pm2_delete_response') {
      const action = msg.type.replace('pm2_', '').replace('_response', '');
      if (msg.success) {
        toast(`PM2 ${action} ${msg.name} succeeded`, 'success');
        setTimeout(() => send({ type: 'pm2_list' }), 500);
      } else {
        toast(`PM2 ${action} ${msg.name} failed: ${msg.error}`, 'error');
      }
    } else if (msg.type === 'pm2_logs_response') {
      if (msg.success) showLogsModal(msg.name, msg.logs);
      else toast(`Logs error: ${msg.error}`, 'error');
    } else if (msg.type === 'pm2_flush_logs_response') {
      toast(msg.success ? 'Logs flushed' : `Flush failed: ${msg.error}`, msg.success ? 'success' : 'error');
    }
  }

  function init() {
    if (window.pm2Monitor.initialized) return;
    window.pm2Monitor.initialized = true;
    setPanelVisible(false);
    if (refreshBtn) refreshBtn.addEventListener('click', () => send({ type: 'pm2_list' }));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && window.pm2Monitor.logsModalOpen) window.pm2Monitor.closeLogsModal(); });
    if (window.wsManager) {
      window.wsManager.on('message', handleMessage);
      window.wsManager.on('connected', () => {
        send({ type: 'pm2_start_monitoring' });
        send({ type: 'pm2_list' });
      });
      if (window.wsManager.isConnected) {
        send({ type: 'pm2_start_monitoring' });
        send({ type: 'pm2_list' });
      }
    }
  }

  function showLogsModal(name, logs) {
    if (window.pm2Monitor.logsModalOpen) window.pm2Monitor.closeLogsModal();
    const modal = document.createElement('div');
    modal.className = 'pm2-logs-modal';
    modal.innerHTML = `<div class="pm2-logs-content">
      <div class="pm2-logs-header"><span>Logs: ${escHtml(name)}</span><button class="pm2-btn" onclick="window.pm2Monitor.closeLogsModal()">Close</button></div>
      <div class="pm2-logs-body">${escHtml(logs || 'No logs available')}</div>
      <div class="pm2-logs-footer">
        <button class="pm2-btn" onclick="window.pm2Monitor.flushLogs('${escAttr(name)}')">Flush</button>
        <button class="pm2-btn" onclick="window.pm2Monitor.closeLogsModal()">Close</button>
      </div></div>`;
    document.body.appendChild(modal);
    window.pm2Monitor.logsModalOpen = name;
    modal.addEventListener('click', (e) => { if (e.target === modal) window.pm2Monitor.closeLogsModal(); });
  }

  function toast(msg, type) {
    const t = document.createElement('div');
    t.className = 'pm2-toast';
    t.textContent = msg;
    const bg = type === 'error' ? 'var(--color-error)' : type === 'success' ? 'var(--color-success)' : 'var(--color-primary)';
    t.style.cssText = `position:fixed;top:1rem;right:1rem;padding:0.5rem 1rem;border-radius:0.375rem;font-size:0.8rem;color:white;z-index:10000;background:${bg}`;
    document.body.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.3s'; setTimeout(() => t.remove(), 300); }, 3000);
  }

  function escHtml(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function escAttr(s) { return (s || '').replace(/"/g, '&quot;').replace(/'/g, '&#039;'); }
  function fmtBytes(b) {
    if (!b || typeof b !== 'number') return '0 B';
    const u = ['B','KB','MB','GB'], i = Math.min(Math.floor(Math.log(b) / Math.log(1024)), 3);
    return (b / Math.pow(1024, i)).toFixed(1) + ' ' + u[i];
  }
  function fmtUptime(s) {
    if (!s || s < 0) return '0s';
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }

  window.pm2Monitor.closeLogsModal = () => { const m = document.querySelector('.pm2-logs-modal'); if (m) m.remove(); window.pm2Monitor.logsModalOpen = null; };
  window.pm2Monitor.startProcess = (name) => send({ type: 'pm2_start', name });
  window.pm2Monitor.stopProcess = (name) => send({ type: 'pm2_stop', name });
  window.pm2Monitor.restartProcess = (name) => send({ type: 'pm2_restart', name });
  window.pm2Monitor.deleteProcess = (name) => { if (confirm(`Delete PM2 process "${name}"?`)) send({ type: 'pm2_delete', name }); };
  window.pm2Monitor.showLogs = (name) => send({ type: 'pm2_logs', name, lines: 200 });
  window.pm2Monitor.flushLogs = (name) => send({ type: 'pm2_flush_logs', name });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 150));
  else setTimeout(init, 150);
})();
