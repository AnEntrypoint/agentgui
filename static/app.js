// Multi-agent ACP client with WebSocket + MessagePack
class GMGUIApp {
  constructor() {
    this.agents = new Map();
    this.selectedAgent = null;
    this.messageHistory = [];
    this.connections = new Map();
    this.settings = {
      messageFormat: 'msgpackr',
      autoScroll: true,
      connectTimeout: 30000,
      screenshotFormat: 'png',
    };
    this.uploadedFiles = [];
    this.lastScreenshot = null;

    this.init();
  }

  async init() {
    this.loadSettings();
    this.setupEventListeners();
    this.fetchAgents();
    this.setupWebSocketListener();
  }

  loadSettings() {
    const stored = localStorage.getItem('gmgui-settings');
    if (stored) {
      this.settings = { ...this.settings, ...JSON.parse(stored) };
    }
    this.applySettings();
  }

  saveSettings() {
    localStorage.setItem('gmgui-settings', JSON.stringify(this.settings));
  }

  applySettings() {
    const format = document.getElementById('messageFormat');
    const autoScroll = document.getElementById('autoScroll');
    const timeout = document.getElementById('connectTimeout');
    const screenshotFormat = document.getElementById('screenshotFormat');

    if (format) format.value = this.settings.messageFormat;
    if (autoScroll) autoScroll.checked = this.settings.autoScroll;
    if (timeout) timeout.value = this.settings.connectTimeout / 1000;
    if (screenshotFormat) screenshotFormat.value = this.settings.screenshotFormat;
  }

  setupEventListeners() {
    // Message input
    const messageInput = document.getElementById('messageInput');
    if (messageInput) {
      messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.sendMessage();
        }
      });
    }

    // Settings changes
    document.getElementById('messageFormat').addEventListener('change', (e) => {
      this.settings.messageFormat = e.target.value;
      this.saveSettings();
    });

    document.getElementById('autoScroll').addEventListener('change', (e) => {
      this.settings.autoScroll = e.target.checked;
      this.saveSettings();
    });

    document.getElementById('connectTimeout').addEventListener('change', (e) => {
      this.settings.connectTimeout = parseInt(e.target.value) * 1000;
      this.saveSettings();
    });

    document.getElementById('screenshotFormat').addEventListener('change', (e) => {
      this.settings.screenshotFormat = e.target.value;
      this.saveSettings();
    });
  }

  async fetchAgents() {
    try {
      const response = await fetch('/api/agents');
      const data = await response.json();

      if (data.agents) {
        data.agents.forEach(agent => {
          this.agents.set(agent.id, agent);
        });
        this.renderAgentsList();
      }
    } catch (error) {
      this.logMessage('error', 'Failed to fetch agents list', error.message);
    }
  }

  renderAgentsList() {
    const list = document.getElementById('agentsList');
    if (!list) return;

    list.innerHTML = '';

    if (this.agents.size === 0) {
      list.innerHTML = '<p style="color: #9ca3af; font-size: 0.875rem; padding: 1rem; text-align: center;">No agents found</p>';
      return;
    }

    this.agents.forEach((agent, id) => {
      const item = document.createElement('div');
      item.className = `agent-item ${this.selectedAgent === id ? 'active' : ''}`;

      const statusClass = agent.status === 'connected' ? 'connected' : (agent.type === 'cli' ? 'available' : 'disconnected');
      const statusText = agent.type === 'cli' ? 'available' : (agent.status || 'disconnected');
      const icon = agent.icon || '🤖';
      const displayName = agent.name || agent.id;

      item.innerHTML = `
        <div class="agent-item-header">
          <span class="agent-icon">${icon}</span>
          <span class="agent-id">${escapeHtml(displayName)}</span>
          <span class="agent-status ${statusClass}">${statusText}</span>
        </div>
        <div class="agent-type">${agent.type === 'cli' ? 'CLI Agent' : 'WebSocket Agent'}</div>
        ${agent.endpoint ? `<div class="agent-endpoint">${escapeHtml(agent.endpoint)}</div>` : ''}
        <div class="agent-actions">
          ${agent.type === 'cli' ? `<button onclick="app.launchCLIAgent('${escapeHtml(agent.id)}')">Launch</button>` : `<button onclick="app.selectAgent('${escapeHtml(agent.id)}')">Select</button>`}
          <button onclick="app.disconnectAgent('${escapeHtml(agent.id)}')">Remove</button>
        </div>
      `;

      list.appendChild(item);
    });
  }

  selectAgent(id) {
    this.selectedAgent = id;
    this.renderAgentsList();
    const agent = this.agents.get(id);
    const chatTitle = document.getElementById('chatTitle');
    if (chatTitle) {
      chatTitle.textContent = `Chat with ${escapeHtml(id)}`;
    }
    this.logMessage('info', `Selected agent: ${id}`);
  }

  async connectAgent(id, endpoint) {
    try {
      this.logMessage('info', `Connecting to ${id}...`);

      const wsUrl = `ws://${window.location.host}/agent/${id}`;
      const ws = new WebSocket(wsUrl);

      ws.binaryType = 'arraybuffer';

      const timeout = setTimeout(() => {
        ws.close();
        this.logMessage('error', `Connection timeout for ${id}`);
      }, this.settings.connectTimeout);

      ws.onopen = () => {
        clearTimeout(timeout);
        this.connections.set(id, ws);
        const agent = this.agents.get(id) || { id, endpoint, status: 'connected' };
        agent.status = 'connected';
        this.agents.set(id, agent);
        this.renderAgentsList();
        this.logMessage('success', `Connected to ${id}`);
      };

      ws.onmessage = (event) => {
        this.handleAgentMessage(id, event.data);
      };

      ws.onerror = (error) => {
        clearTimeout(timeout);
        this.logMessage('error', `Connection error for ${id}`, error.message);
      };

      ws.onclose = () => {
        clearTimeout(timeout);
        this.connections.delete(id);
        const agent = this.agents.get(id);
        if (agent) {
          agent.status = 'disconnected';
        }
        this.renderAgentsList();
        this.logMessage('warning', `Disconnected from ${id}`);
      };
    } catch (error) {
      this.logMessage('error', `Failed to connect to ${id}`, error.message);
    }
  }

  handleAgentMessage(agentId, data) {
    try {
      let message;

      if (this.settings.messageFormat === 'msgpackr') {
        message = `[Binary Data from ${agentId}]`;
      } else {
        message = typeof data === 'string' ? JSON.parse(data) : data;
      }

      const agent = this.agents.get(agentId);
      if (agent) {
        agent.lastMessage = message;
        this.agents.set(agentId, agent);
      }

      this.messageHistory.push({
        agentId,
        message,
        timestamp: Date.now(),
      });

      this.logMessage('info', `Message from ${agentId}`,
        typeof message === 'string' ? message : JSON.stringify(message, null, 2)
      );
    } catch (error) {
      this.logMessage('error', `Failed to process message from ${agentId}`, error.message);
    }
  }

  setupWebSocketListener() {
    const wsUrl = `ws://${window.location.host}`;
    const ws = new WebSocket(wsUrl);

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.type === 'agent:connected') {
          const agent = data.agent;
          this.agents.set(agent.id, agent);
          this.renderAgentsList();
          this.logMessage('success', `Agent connected: ${agent.id}`);
        } else if (data.type === 'agent:disconnected') {
          const agent = this.agents.get(data.agentId);
          if (agent) {
            agent.status = 'disconnected';
            this.agents.set(data.agentId, agent);
          }
          this.renderAgentsList();
          this.logMessage('warning', `Agent disconnected: ${data.agentId}`);
        } else if (data.type === 'agent:message') {
          this.handleAgentMessage(data.agentId, data);
        }
      } catch (e) {
        console.error('WebSocket message error:', e);
      }
    };

    ws.onerror = (error) => {
      console.error('WebSocket error:', error);
    };
  }

  async sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();

    if (!message) return;
    if (!this.selectedAgent) {
      this.logMessage('error', 'Please select an agent first');
      return;
    }

    try {
      const payload = {
        type: 'message',
        content: message,
        timestamp: Date.now(),
      };

      const response = await fetch(`/api/agents/${this.selectedAgent}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        this.logMessage('info', `You (to ${this.selectedAgent})`, message);
        input.value = '';
      } else {
        const error = await response.json();
        this.logMessage('error', 'Send failed', error.error);
      }
    } catch (error) {
      this.logMessage('error', 'Send error', error.message);
    }
  }

  async captureScreenshot() {
    const format = this.settings.screenshotFormat || 'png';
    this.showLoading(true);

    try {
      const response = await fetch('/api/screenshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format }),
      });

      if (response.ok) {
        const data = await response.json();
        this.lastScreenshot = data;
        this.showScreenshotModal(data.path);
        this.logMessage('success', 'Screenshot captured', '', [{
          type: 'screenshot',
          path: data.path,
          filename: data.filename,
        }]);
      } else {
        const error = await response.json();
        this.logMessage('error', 'Screenshot failed', error.error);
      }
    } catch (error) {
      this.logMessage('error', 'Screenshot error', error.message);
    } finally {
      this.showLoading(false);
    }
  }

  async regenerateScreenshot() {
    await this.captureScreenshot();
  }

  showScreenshotModal(path) {
    const modal = document.getElementById('screenshotModal');
    const img = document.getElementById('screenshotImage');

    if (modal && img) {
      img.src = path;
      modal.classList.add('active');
    }
  }

  closeScreenshotModal() {
    const modal = document.getElementById('screenshotModal');
    if (modal) {
      modal.classList.remove('active');
    }
  }

  async sendScreenshot() {
    if (!this.lastScreenshot || !this.selectedAgent) {
      this.logMessage('error', 'No screenshot or agent selected');
      return;
    }

    try {
      const message = `Captured screenshot: ${this.lastScreenshot.filename}`;
      const payload = {
        type: 'message',
        content: message,
        attachment: {
          type: 'screenshot',
          path: this.lastScreenshot.path,
          filename: this.lastScreenshot.filename,
        },
        timestamp: Date.now(),
      };

      const response = await fetch(`/api/agents/${this.selectedAgent}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const attachments = [{
          type: 'screenshot',
          path: this.lastScreenshot.path,
          filename: this.lastScreenshot.filename,
        }];
        this.logMessage('info', `You (to ${this.selectedAgent})`, message, attachments);
        this.closeScreenshotModal();
      } else {
        const error = await response.json();
        this.logMessage('error', 'Send failed', error.error);
      }
    } catch (error) {
      this.logMessage('error', 'Send error', error.message);
    }
  }

  downloadScreenshot() {
    if (!this.lastScreenshot) return;

    const img = document.getElementById('screenshotImage');
    const link = document.createElement('a');
    link.href = this.lastScreenshot.path;
    link.download = this.lastScreenshot.filename;
    link.click();
  }

  triggerFileUpload() {
    document.getElementById('fileInput').click();
  }

  async handleFileUpload() {
    const input = document.getElementById('fileInput');
    const files = input.files;

    if (files.length === 0) return;

    this.showLoading(true);

    try {
      const formData = new FormData();
      for (const file of files) {
        formData.append('files', file);
      }

      const response = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });

      if (response.ok) {
        const data = await response.json();
        this.uploadedFiles.push(...data.files);
        this.refreshFileList();
        this.logMessage('success', `Uploaded ${data.files.length} file(s)`);
        input.value = '';
      } else {
        const error = await response.json();
        this.logMessage('error', 'Upload failed', error.error);
      }
    } catch (error) {
      this.logMessage('error', 'Upload error', error.message);
    } finally {
      this.showLoading(false);
    }
  }

  refreshFileList() {
    const list = document.getElementById('filesList');
    if (!list) return;

    if (this.uploadedFiles.length === 0) {
      list.innerHTML = '<p style="color: #9ca3af; padding: 1rem;">No files uploaded</p>';
      return;
    }

    list.innerHTML = '';

    this.uploadedFiles.forEach((file, index) => {
      const item = document.createElement('div');
      item.className = 'file-item';

      const sizeKB = Math.round(file.size / 1024);
      const date = new Date(file.timestamp).toLocaleString();

      item.innerHTML = `
        <div class="file-item-name">${escapeHtml(file.filename)}</div>
        <div class="file-item-info">
          <div>Size: ${sizeKB} KB</div>
          <div>Uploaded: ${date}</div>
        </div>
        <div class="file-item-actions">
          <a href="${file.path}" download="${file.filename}">Download</a>
          <button onclick="app.sendFile(${index})">Send</button>
        </div>
      `;

      list.appendChild(item);
    });
  }

  async sendFile(index) {
    if (!this.selectedAgent) {
      this.logMessage('error', 'Please select an agent first');
      return;
    }

    const file = this.uploadedFiles[index];

    try {
      const message = `Sending file: ${file.filename}`;
      const payload = {
        type: 'message',
        content: message,
        attachment: {
          type: 'file',
          path: file.path,
          filename: file.filename,
        },
        timestamp: Date.now(),
      };

      const response = await fetch(`/api/agents/${this.selectedAgent}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const attachments = [{
          type: 'file',
          path: file.path,
          filename: file.filename,
          mime: 'application/octet-stream',
        }];
        this.logMessage('info', `You (to ${this.selectedAgent})`, message, attachments);
      } else {
        const error = await response.json();
        this.logMessage('error', 'Send failed', error.error);
      }
    } catch (error) {
      this.logMessage('error', 'Send error', error.message);
    }
  }

  async renderContentWithReferences(content, attachments = []) {
    let html = `<div class="console-text">${escapeHtml(content)}</div>`;

    if (attachments && attachments.length > 0) {
      html += '<div class="attachments-container">';

      for (const att of attachments) {
        if (att.type === 'file') {
          html += this.renderFileReference(att);
        } else if (att.type === 'screenshot') {
          html += await this.renderScreenshotReference(att);
        }
      }

      html += '</div>';
    }

    return html;
  }

  renderFileReference(att) {
    return `
      <div class="attachment file-reference">
        <span class="attachment-icon">📄</span>
        <div class="attachment-info">
          <a href="${att.path}" download="${att.filename || 'file'}" class="attachment-name">${escapeHtml(att.filename || 'File')}</a>
          <div class="attachment-meta">${att.mime || 'application/octet-stream'}</div>
        </div>
      </div>
    `;
  }

  async renderScreenshotReference(att) {
    try {
      const response = await fetch(att.path);
      if (response.ok) {
        return `
          <div class="attachment screenshot-reference">
            <img src="${att.path}" alt="Screenshot" class="attachment-image" loading="lazy" />
            <button onclick="app.regenerateScreenshot()" class="btn btn-secondary btn-xs">Regenerate</button>
          </div>
        `;
      }
    } catch (e) {
      console.warn(`Failed to load screenshot reference: ${att.path}`);
    }

    return `
      <div class="attachment content-unavailable">
        <span class="attachment-icon">⚠️</span>
        <div class="attachment-info">
          <div class="attachment-name">Screenshot unavailable</div>
          <div class="attachment-meta">File not found: ${escapeHtml(att.path)}</div>
        </div>
        <button onclick="app.regenerateScreenshot()" class="btn btn-secondary btn-xs">Regenerate</button>
      </div>
    `;
  }

  async logMessage(type, title, content = '', attachments = []) {
    const output = document.getElementById('consoleOutput');
    if (!output) return;

    const msg = document.createElement('div');
    msg.className = `console-message ${type}`;

    const time = new Date().toLocaleTimeString();
    const contentHtml = content ? await this.renderContentWithReferences(content, attachments) : '';

    msg.innerHTML = `
      <div class="console-timestamp">${time}</div>
      <div><span class="console-agent-id">${escapeHtml(title)}</span></div>
      ${contentHtml}
    `;

    output.appendChild(msg);

    if (this.settings.autoScroll) {
      output.scrollTop = output.scrollHeight;
    }
  }

  clearConsole() {
    const output = document.getElementById('consoleOutput');
    if (output) {
      output.innerHTML = '';
    }
    this.messageHistory = [];
  }

  disconnectAgent(id) {
    const ws = this.connections.get(id);
    if (ws) {
      ws.close();
      this.connections.delete(id);
    }
    this.agents.delete(id);
    this.renderAgentsList();
    this.logMessage('warning', `Removed agent: ${id}`);
  }

  showLoading(show) {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
      if (show) {
        overlay.classList.add('active');
      } else {
        overlay.classList.remove('active');
      }
    }
  }

  launchCLIAgent(agentId) {
    const agent = this.agents.get(agentId);
    if (!agent || agent.type !== 'cli') {
      this.logMessage('error', 'Invalid CLI agent');
      return;
    }

    this.showLoading(true);
    fetch(`/api/cli-agents/${agentId}/launch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId })
    })
      .then(res => {
        this.showLoading(false);
        if (res.ok) {
          this.logMessage('info', `Launching ${agent.name}...`);
          setTimeout(() => {
            this.selectAgent(agentId);
          }, 1000);
        } else {
          this.logMessage('error', `Failed to launch ${agent.name}`);
        }
      })
      .catch(err => {
        this.showLoading(false);
        this.logMessage('error', `Launch error: ${err.message}`);
      });
  }
}

// Global helper functions
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function addAgent() {
  const id = document.getElementById('agentId').value.trim();
  const endpoint = document.getElementById('agentEndpoint').value.trim();

  if (!id || !endpoint) {
    alert('Please enter both Agent ID and Endpoint');
    return;
  }

  app.agents.set(id, { id, endpoint, status: 'disconnected' });
  app.connectAgent(id, endpoint);

  document.getElementById('agentId').value = '';
  document.getElementById('agentEndpoint').value = '';
}

function sendMessage() {
  app.sendMessage();
}

function clearConsole() {
  if (confirm('Clear all messages?')) {
    app.clearConsole();
  }
}

function switchTab(tabName) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));

  const tab = document.getElementById(tabName);
  const btn = document.querySelector(`[data-tab="${tabName}"]`);

  if (tab) tab.classList.add('active');
  if (btn) btn.classList.add('active');
}

function captureScreenshot() {
  app.captureScreenshot();
}

function closeScreenshotModal() {
  app.closeScreenshotModal();
}

function sendScreenshot() {
  app.sendScreenshot();
}

function downloadScreenshot() {
  app.downloadScreenshot();
}

function triggerFileUpload() {
  app.triggerFileUpload();
}

function handleFileUpload() {
  app.handleFileUpload();
}

function refreshFileList() {
  app.refreshFileList();
}

function launchCLIAgent(agentId) {
  app.launchCLIAgent(agentId);
}

// Initialize app
const app = new GMGUIApp();
