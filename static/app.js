// Multi-agent ACP client with chat history
class GMGUIApp {
  constructor() {
    this.agents = new Map();
    this.selectedAgent = null;
    this.conversations = new Map();
    this.currentConversation = null;
    this.connections = new Map();
    this.sessionConnections = new Map(); // WebSocket connections for sessions
    this.settings = {
      autoScroll: true,
      connectTimeout: 30000,
      screenshotFormat: 'png',
    };
    this.lastScreenshot = null;

    this.init();
  }

  async init() {
    this.loadSettings();
    this.setupEventListeners();
    await this.fetchHome();
    this.fetchAgents();
    this.loadConversations();
    this.renderAgentCards();
  }

  async fetchHome() {
    try {
      const res = await fetch('/api/home');
      if (res.ok) {
        const data = await res.json();
        localStorage.setItem('gmgui-home', data.home);
      }
    } catch (e) {
      console.error('Failed to fetch home directory:', e);
    }
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
    const autoScroll = document.getElementById('autoScroll');
    const timeout = document.getElementById('connectTimeout');
    const screenshotFormat = document.getElementById('screenshotFormat');

    if (autoScroll) autoScroll.checked = this.settings.autoScroll;
    if (timeout) timeout.value = this.settings.connectTimeout / 1000;
    if (screenshotFormat) screenshotFormat.value = this.settings.screenshotFormat;
  }

  expandHome(path) {
    if (!path) return path;
    const home = localStorage.getItem('gmgui-home') || '/root';
    return path.startsWith('~') ? path.replace('~', home) : path;
  }

  setupEventListeners() {
    const messageInput = document.getElementById('messageInput');
    if (messageInput) {
      messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.sendMessage();
        }
      });
      
      messageInput.addEventListener('input', () => {
        this.updateSendButtonState();
      });
    }

    document.getElementById('autoScroll')?.addEventListener('change', (e) => {
      this.settings.autoScroll = e.target.checked;
      this.saveSettings();
    });

    document.getElementById('connectTimeout')?.addEventListener('change', (e) => {
      this.settings.connectTimeout = parseInt(e.target.value) * 1000;
      this.saveSettings();
    });

    document.getElementById('screenshotFormat')?.addEventListener('change', (e) => {
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
        this.renderAgentCards();
      }
    } catch (error) {
      console.error('Failed to fetch agents:', error);
    }
  }

  renderAgentCards() {
    const container = document.getElementById('agentCards');
    if (!container) return;

    container.innerHTML = '';

    if (this.agents.size === 0) {
      container.innerHTML = '<p style="color: var(--text-tertiary); font-size: 0.875rem;">No agents available</p>';
      return;
    }

    let firstAgent = true;
    this.agents.forEach((agent, id) => {
      const card = document.createElement('button');
      card.className = `agent-card ${this.selectedAgent === id ? 'active' : ''}`;
      card.onclick = () => this.selectAgent(id);

      const icon = agent.icon || '🤖';
      const displayName = agent.name || id;

      card.innerHTML = `
        <span class="agent-card-icon">${icon}</span>
        <span class="agent-card-name">${escapeHtml(displayName)}</span>
      `;

      container.appendChild(card);

      if (!firstAgent) {
        const sep = document.createElement('span');
        sep.className = 'agent-separator';
        sep.textContent = '|';
        container.insertBefore(sep, card);
      }
      firstAgent = false;
    });
  }

  selectAgent(id) {
    this.selectedAgent = id;
    this.renderAgentCards();

    // Hide welcome section and show ready state
    const welcomeSection = document.querySelector('.welcome-section');
    if (welcomeSection) {
      welcomeSection.style.display = 'none';
    }

    // Ensure chat input is visible and focused
    const messageInput = document.getElementById('messageInput');
    if (messageInput) {
      messageInput.focus();
    }
  }

  loadConversations() {
    const stored = localStorage.getItem('gmgui-conversations');
    if (stored) {
      try {
        const data = JSON.parse(stored);
        this.conversations = new Map(Object.entries(data));
      } catch (e) {
        console.error('Failed to load conversations:', e);
      }
    }
    this.renderChatHistory();
  }

  saveConversations() {
    const data = Object.fromEntries(this.conversations);
    localStorage.setItem('gmgui-conversations', JSON.stringify(data));
  }

  startNewChat(folderPath = null) {
    const id = `chat-${Date.now()}`;
    const title = folderPath 
      ? `📁 ${folderPath.split('/').pop() || folderPath}`
      : `Chat ${this.conversations.size + 1}`;
    
    const conversation = {
      id,
      title,
      messages: [],
      createdAt: new Date().toLocaleString(),
      folderPath: folderPath || null,
    };
    this.conversations.set(id, conversation);
    this.currentConversation = id;
    this.saveConversations();
    this.renderChatHistory();
    this.displayConversation(id);
  }

  renderChatHistory() {
    const list = document.getElementById('chatList');
    if (!list) return;

    list.innerHTML = '';

    if (this.conversations.size === 0) {
      list.innerHTML = '<p style="color: var(--text-tertiary); font-size: 0.875rem; padding: 0.5rem;">No chats yet</p>';
      return;
    }

    const sorted = Array.from(this.conversations.values()).sort(
      (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
    );

    sorted.forEach(conv => {
      const item = document.createElement('button');
      item.className = `chat-item ${this.currentConversation === conv.id ? 'active' : ''}`;
      
      const titleSpan = document.createElement('span');
      titleSpan.className = 'chat-item-title';
      titleSpan.textContent = conv.title;
      
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'chat-item-delete';
      deleteBtn.textContent = '✕';
      deleteBtn.title = 'Delete chat';
      deleteBtn.onclick = (e) => {
        e.stopPropagation();
        this.showDeleteConfirmDialog(conv.id);
      };
      
      item.appendChild(titleSpan);
      item.appendChild(deleteBtn);
      item.onclick = () => this.displayConversation(conv.id);
      list.appendChild(item);
    });
  }

  showDeleteConfirmDialog(conversationId) {
    const modal = document.getElementById('deleteConfirmModal');
    if (!modal) return;

    const confirmBtn = modal.querySelector('.btn-confirm');
    const cancelBtn = modal.querySelector('.btn-cancel');

    const handleConfirm = () => {
      this.conversations.delete(conversationId);
      this.saveConversations();
      
      if (this.currentConversation === conversationId) {
        this.currentConversation = null;
        const firstChat = Array.from(this.conversations.values())[0];
        if (firstChat) {
          this.displayConversation(firstChat.id);
        } else {
          const messagesDiv = document.getElementById('chatMessages');
          if (messagesDiv) {
            messagesDiv.innerHTML = `
              <div class="welcome-section">
                <h2>Hi, what's your plan for today?</h2>
                <div class="agent-selection">
                  <div id="agentCards" class="agent-cards"></div>
                </div>
              </div>
            `;
            this.renderAgentCards();
          }
        }
      }
      this.renderChatHistory();
      this.closeDeleteConfirmDialog();
    };

    const handleCancel = () => {
      this.closeDeleteConfirmDialog();
    };

    confirmBtn.onclick = handleConfirm;
    cancelBtn.onclick = handleCancel;
    modal.classList.add('active');
  }

  closeDeleteConfirmDialog() {
    const modal = document.getElementById('deleteConfirmModal');
    if (modal) {
      modal.classList.remove('active');
    }
  }

  displayConversation(id) {
    this.currentConversation = id;
    const conversation = this.conversations.get(id);

    if (!conversation) return;

    const messagesDiv = document.getElementById('chatMessages');
    if (!messagesDiv) return;

    let headerHtml = '';
    if (conversation.folderPath) {
      headerHtml = `
        <div class="chat-context-header">
          <span class="folder-icon">📁</span>
          <span class="folder-context">${escapeHtml(conversation.folderPath)}</span>
        </div>
      `;
    }

    if (conversation.messages.length === 0) {
      if (this.selectedAgent) {
        // Agent already selected, just show empty chat
        messagesDiv.innerHTML = headerHtml;
      } else {
        // No agent selected, show welcome section with agent cards
        messagesDiv.innerHTML = headerHtml + `
          <div class="welcome-section">
            <h2>Hi, what's your plan for today?</h2>
            <div class="agent-selection">
              <div id="agentCards" class="agent-cards"></div>
            </div>
          </div>
        `;
        this.renderAgentCards();
      }
    } else {
      messagesDiv.innerHTML = headerHtml;
      conversation.messages.forEach(msg => {
        this.addMessageToDisplay(msg);
      });
      if (this.settings.autoScroll) {
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
      }
    }

    this.renderChatHistory();
  }

  addMessageToDisplay(msg) {
    const messagesDiv = document.getElementById('chatMessages');
    if (!messagesDiv) return;

    const msgEl = document.createElement('div');
    msgEl.className = `message ${msg.role}`;

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.textContent = msg.content;

    msgEl.appendChild(bubble);
    messagesDiv.appendChild(msgEl);
  }

  async sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();

    // State validation
    if (!message) {
      return; // Silently ignore empty messages
    }

    if (!this.selectedAgent) {
      this.logMessage('system', 'Please select an agent first');
      return;
    }

    if (!this.currentConversation) {
      this.logMessage('system', 'No conversation selected');
      return;
    }

    try {
      const conversation = this.conversations.get(this.currentConversation);
      if (!conversation) return;

      const userMsg = {
        role: 'user',
        content: message,
        timestamp: Date.now(),
      };

      conversation.messages.push(userMsg);
      this.addMessageToDisplay(userMsg);
      input.value = '';
      this.updateSendButtonState();

      const payload = {
        type: 'message',
        content: message,
        agentId: this.selectedAgent,
        timestamp: Date.now(),
        folderContext: {
          path: conversation.folderPath || (localStorage.getItem('gmgui-home') || '/config'),
          isFolder: true,
        },
      };

      const response = await fetch(`/api/agents/${this.selectedAgent}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        const data = await response.json();

        if (data.sessionId) {
          // Agent is processing asynchronously, connect WebSocket for real-time updates
          const processingMsg = {
            role: 'system',
            content: `Processing with ${this.selectedAgent}...`,
            timestamp: Date.now(),
            sessionId: data.sessionId,
          };
          conversation.messages.push(processingMsg);
          this.addMessageToDisplay(processingMsg);
          this.saveConversations();

          // Connect WebSocket for real-time updates
          this.connectSessionWebSocket(data.sessionId, conversation, processingMsg);
        } else if (this.selectedAgent === 'code' && data.response) {
          const responseText = this.extractACPResponse(data.response);
          const agentMsg = {
            role: 'assistant',
            content: responseText || `Claude Code processed your request in ${payload.folderContext?.path || 'current directory'}`,
            timestamp: Date.now(),
          };
          conversation.messages.push(agentMsg);
          this.addMessageToDisplay(agentMsg);
          this.saveConversations();
        } else {
          const agentMsg = {
            role: 'assistant',
            content: `Response from ${this.selectedAgent}`,
            timestamp: Date.now(),
          };
          conversation.messages.push(agentMsg);
          this.addMessageToDisplay(agentMsg);
          this.saveConversations();
        }

        if (this.settings.autoScroll) {
          const messagesDiv = document.getElementById('chatMessages');
          messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }
      } else {
        const error = await response.json();
        const errorMsg = {
          role: 'system',
          content: `Error: ${error.error}`,
          timestamp: Date.now(),
        };
        conversation.messages.push(errorMsg);
        this.addMessageToDisplay(errorMsg);
      }
    } catch (error) {
      const errorMsg = {
        role: 'system',
        content: `Error: ${error.message}`,
        timestamp: Date.now(),
      };
      const conversation = this.conversations.get(this.currentConversation);
      if (conversation) {
        conversation.messages.push(errorMsg);
        this.addMessageToDisplay(errorMsg);
      }
    }
  }

  connectSessionWebSocket(sessionId, conversation, processingMsg) {
    // Check if we already have a connection for this session
    if (this.sessionConnections.has(sessionId)) {
      return;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${protocol}://${window.location.host}/session/${sessionId}`;

    try {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        console.log(`Connected to session ${sessionId}`);
      };

      ws.onmessage = (event) => {
        try {
          // Decode msgpackr binary data
          const sessionState = this.unpackMessage(event.data);
          this.handleSessionUpdate(sessionState, conversation, processingMsg);
        } catch (err) {
          console.error('Error unpacking session message:', err);
        }
      };

      ws.onerror = (error) => {
        console.error(`WebSocket error for session ${sessionId}:`, error);
        // Fall back to polling on error
        this.pollSessionStatus(sessionId, conversation, processingMsg);
      };

      ws.onclose = () => {
        console.log(`Disconnected from session ${sessionId}`);
        this.sessionConnections.delete(sessionId);
      };

      this.sessionConnections.set(sessionId, ws);
    } catch (err) {
      console.error('Failed to connect WebSocket:', err);
      // Fall back to polling
      this.pollSessionStatus(sessionId, conversation, processingMsg);
    }
  }

  unpackMessage(data) {
    // Simple msgpackr unpacking
    // For now, we'll use a fallback if msgpackr is not available
    try {
      if (window.msgpackr) {
        return window.msgpackr.unpack(new Uint8Array(data));
      } else {
        // Fallback: try JSON
        return JSON.parse(new TextDecoder().decode(data));
      }
    } catch (e) {
      console.error('Unpack error:', e);
      return null;
    }
  }

  handleSessionUpdate(sessionState, conversation, processingMsg) {
    if (!sessionState) return;

    const msgIndex = conversation.messages.indexOf(processingMsg);
    if (msgIndex === -1) return;

    if (sessionState.status === 'completed') {
      const responseText = this.extractACPResponse(sessionState.response);
      const agentMsg = {
        role: 'assistant',
        content: responseText || `Completed in ${sessionState.folderPath || 'current directory'}`,
        timestamp: Date.now(),
      };
      conversation.messages[msgIndex] = agentMsg;
      this.saveConversations();
      this.displayConversation(this.currentConversation);

      // Close WebSocket connection
      if (this.sessionConnections.has(sessionState.sessionId)) {
        this.sessionConnections.get(sessionState.sessionId).close();
      }
    } else if (sessionState.status === 'error') {
      const errorMsg = {
        role: 'system',
        content: `Error: ${sessionState.error}`,
        timestamp: Date.now(),
      };
      conversation.messages[msgIndex] = errorMsg;
      this.saveConversations();
      this.displayConversation(this.currentConversation);

      // Close WebSocket connection
      if (this.sessionConnections.has(sessionState.sessionId)) {
        this.sessionConnections.get(sessionState.sessionId).close();
      }
    } else if (sessionState.status === 'processing' && sessionState.progress) {
      // Update with progress
      processingMsg.content = `${sessionState.agentId}: ${sessionState.progress}`;
      this.displayConversation(this.currentConversation);
    }
  }

  async pollSessionStatus(sessionId, conversation, processingMsg) {
    // Fallback polling for when WebSocket is not available
    const maxAttempts = 1200; // 10 minutes with 500ms intervals
    let attempt = 0;

    const poll = async () => {
      try {
        const response = await fetch(`/api/sessions/${sessionId}`);
        if (!response.ok) {
          console.error('Failed to poll session:', response.status);
          return;
        }

        const sessionState = await response.json();
        this.handleSessionUpdate(sessionState, conversation, processingMsg);

        if (sessionState.status === 'processing' && attempt < maxAttempts) {
          // Still processing, poll again
          attempt++;
          setTimeout(poll, 500);
        }
      } catch (error) {
        console.error('Polling error:', error);
      }
    };

    poll();
  }

  updateSendButtonState() {
    const input = document.getElementById('messageInput');
    const sendBtn = document.getElementById('sendBtn');
    
    if (sendBtn) {
      sendBtn.disabled = !input || !input.value.trim();
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
        this.logMessage('system', 'Screenshot captured');
      } else {
        const error = await response.json();
        this.logMessage('system', `Screenshot failed: ${error.error}`);
      }
    } catch (error) {
      this.logMessage('system', `Screenshot error: ${error.message}`);
    } finally {
      this.showLoading(false);
    }
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
      this.logMessage('system', 'No screenshot or agent selected');
      return;
    }

    try {
      const message = `Captured screenshot: ${this.lastScreenshot.filename}`;
      const payload = {
        type: 'message',
        content: message,
        agentId: this.selectedAgent,
        attachment: {
          type: 'screenshot',
          path: this.lastScreenshot.path,
        },
        timestamp: Date.now(),
      };

      const response = await fetch(`/api/agents/${this.selectedAgent}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (response.ok) {
        this.logMessage('system', 'Screenshot sent to agent');
        this.closeScreenshotModal();
      } else {
        const error = await response.json();
        this.logMessage('system', `Send failed: ${error.error}`);
      }
    } catch (error) {
      this.logMessage('system', `Send error: ${error.message}`);
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
        this.logMessage('system', `Uploaded ${data.files.length} file(s)`);
        input.value = '';
      } else {
        const error = await response.json();
        this.logMessage('system', `Upload failed: ${error.error}`);
      }
    } catch (error) {
      this.logMessage('system', `Upload error: ${error.message}`);
    } finally {
      this.showLoading(false);
    }
  }

  logMessage(type, content) {
    if (!this.currentConversation) {
      this.startNewChat();
    }

    const conversation = this.conversations.get(this.currentConversation);
    if (!conversation) return;

    const msg = {
      role: type,
      content,
      timestamp: Date.now(),
    };

    conversation.messages.push(msg);
    this.addMessageToDisplay(msg);
    this.saveConversations();

    if (this.settings.autoScroll) {
      const messagesDiv = document.getElementById('chatMessages');
      if (messagesDiv) {
        messagesDiv.scrollTop = messagesDiv.scrollHeight;
      }
    }
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

  openFolderBrowser() {
    const modal = document.getElementById('folderBrowserModal');
    if (!modal) return;

    const pathInput = document.getElementById('folderPath');
    pathInput.value = '~/';

    this.loadFolderContents(this.expandHome('~/'));
    modal.classList.add('active');
  }

  closeFolderBrowser() {
    const modal = document.getElementById('folderBrowserModal');
    if (modal) {
      modal.classList.remove('active');
    }
  }

  async loadFolderContents(folderPath) {
    const list = document.getElementById('folderBrowserList');
    if (!list) return;

    list.innerHTML = '<div style="padding: 1rem; color: var(--text-tertiary);">Loading...</div>';

    try {
      const response = await fetch('/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: folderPath }),
      });

      if (response.ok) {
        const data = await response.json();
        this.renderFolderList(data.folders, folderPath);
      } else {
        list.innerHTML = '<div style="padding: 1rem; color: var(--color-danger);">Error loading folder</div>';
      }
    } catch (error) {
      console.error('Error loading folder:', error);
      list.innerHTML = '<div style="padding: 1rem; color: var(--color-danger);">Error: ' + error.message + '</div>';
    }
  }

  renderFolderList(folders, currentPath) {
    const list = document.getElementById('folderBrowserList');
    if (!list) return;

    list.innerHTML = '';

    if (currentPath !== '/' && currentPath !== '/root') {
      const parentPath = currentPath.substring(0, currentPath.lastIndexOf('/')) || '/';
      const parentItem = document.createElement('div');
      parentItem.className = 'folder-item';
      parentItem.style.cssText = 'padding: 0.75rem 1rem; cursor: pointer; display: flex; align-items: center; gap: 0.75rem; border-bottom: 1px solid var(--border-color); transition: var(--transition-fast);';
      parentItem.innerHTML = '<span style="font-size: 1rem;">📁</span><span>..</span>';
      parentItem.onmouseover = () => parentItem.style.background = 'var(--bg-tertiary)';
      parentItem.onmouseout = () => parentItem.style.background = 'transparent';
      parentItem.onclick = () => {
        document.getElementById('folderPath').value = parentPath;
        this.loadFolderContents(parentPath);
      };
      list.appendChild(parentItem);
    }

    if (!folders || folders.length === 0) {
      const emptyItem = document.createElement('div');
      emptyItem.style.cssText = 'padding: 1rem; color: var(--text-tertiary); text-align: center;';
      emptyItem.textContent = 'No subfolders found';
      list.appendChild(emptyItem);
      return;
    }

    folders.forEach(folder => {
      const item = document.createElement('div');
      item.className = 'folder-item';
      item.style.cssText = 'padding: 0.75rem 1rem; cursor: pointer; display: flex; align-items: center; gap: 0.75rem; border-bottom: 1px solid var(--border-color); transition: var(--transition-fast);';
      item.innerHTML = `<span style="font-size: 1rem;">📁</span><span>${escapeHtml(folder.name)}</span>`;

      item.onmouseover = () => item.style.background = 'var(--bg-tertiary)';
      item.onmouseout = () => item.style.background = 'transparent';
      item.onclick = () => {
        const newPath = currentPath === '/' ? '/' + folder.name : currentPath + '/' + folder.name;
        document.getElementById('folderPath').value = newPath;
        this.loadFolderContents(newPath);
      };

      list.appendChild(item);
    });
  }

  extractACPResponse(response) {
    if (!response) return '';
    
    let text = '';
    
    if (response.updates && Array.isArray(response.updates)) {
      for (const update of response.updates) {
        if (update.textDelta) {
          text += update.textDelta;
        } else if (update.content && typeof update.content === 'string') {
          text += update.content;
        }
      }
    }
    
    if (response.stopReason) {
      if (text) {
        text += `\n\n[Completed: ${response.stopReason}]`;
      } else {
        text = `Operation completed: ${response.stopReason}`;
      }
    }
    
    return text.trim();
  }
}

// Global helper functions
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showNewChatModal() {
  const modal = document.getElementById('newChatModal');
  if (modal) {
    modal.classList.add('active');
  }
}

function closeNewChatModal() {
  const modal = document.getElementById('newChatModal');
  if (modal) {
    modal.classList.remove('active');
  }
}

function createChatInWorkspace() {
  closeNewChatModal();
  app.startNewChat();
}

function createChatInFolder() {
  closeNewChatModal();
  app.openFolderBrowser();
}

function sendMessage() {
  app.sendMessage();
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    sidebar.classList.toggle('open');
  }
}

function switchTab(tabName) {
  if (tabName === 'settings') {
    const panel = document.getElementById('settingsPanel');
    const mainContent = document.querySelector('.main-content');
    if (panel && mainContent) {
      panel.style.display = 'flex';
      mainContent.style.display = 'none';
    }
  } else if (tabName === 'chat') {
    const panel = document.getElementById('settingsPanel');
    const mainContent = document.querySelector('.main-content');
    if (panel && mainContent) {
      panel.style.display = 'none';
      mainContent.style.display = 'flex';
    }
  }
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

function closeFolderBrowser() {
  app.closeFolderBrowser();
}

function browseFolders() {
  const pathInput = document.getElementById('folderPath');
  const path = pathInput.value.trim() || '~/';
  const expandedPath = app.expandHome(path);
  app.loadFolderContents(expandedPath);
}

function confirmFolderSelection() {
  const pathInput = document.getElementById('folderPath');
  const path = pathInput.value.trim();

  if (!path) {
    app.logMessage('system', 'Please select or enter a folder path');
    return;
  }

  const expandedPath = app.expandHome(path);
  app.startNewChat(expandedPath);
  app.closeFolderBrowser();
}

// Initialize app
const app = new GMGUIApp();
