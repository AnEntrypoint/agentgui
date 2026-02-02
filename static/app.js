const BASE_URL = window.__BASE_URL || '';

// Auto-reconnecting WebSocket wrapper
class ReconnectingWebSocket {
  constructor(url, options = {}) {
    this.url = url;
    this.reconnectDelay = options.reconnectDelay || 1000;
    this.maxReconnectDelay = options.maxReconnectDelay || 30000;
    this.reconnectDecay = options.reconnectDecay || 1.5;
    this.currentDelay = this.reconnectDelay;
    this.ws = null;
    this.listeners = new Map();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnectAttempts || Infinity;
    this.shouldReconnect = true;
    this.connect();
  }

  connect() {
    this.ws = new WebSocket(this.url);

    this.ws.onopen = (e) => {
      this.currentDelay = this.reconnectDelay;
      this.reconnectAttempts = 0;
      this.emit('open', e);
    };

    this.ws.onmessage = (e) => {
      this.emit('message', e);
    };

    this.ws.onerror = (e) => {
      this.emit('error', e);
    };

    this.ws.onclose = (e) => {
      this.emit('close', e);
      if (this.shouldReconnect && this.reconnectAttempts < this.maxReconnectAttempts) {
        setTimeout(() => {
          this.reconnectAttempts++;
          this.currentDelay = Math.min(
            this.currentDelay * this.reconnectDecay,
            this.maxReconnectDelay
          );
          console.log(`Attempting to reconnect (${this.reconnectAttempts})...`);
          this.connect();
        }, this.currentDelay);
      }
    };
  }

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event).push(callback);
  }

  emit(event, data) {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      callbacks.forEach(cb => cb(data));
    }
  }

  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  close() {
    this.shouldReconnect = false;
    if (this.ws) {
      this.ws.close();
    }
  }
}

class GMGUIApp {
  constructor() {
    this.agents = new Map();
    this.selectedAgent = null;
    this.conversations = new Map();
    this.currentConversation = null;
    this.activeStream = null;
    this.pollingInterval = null;
    this.syncWs = null;
    this.broadcastChannel = null;
    this.settings = { autoScroll: true, connectTimeout: 30000 };
    this.pendingMessages = new Map();
    this.idempotencyKeys = new Map();
    this.init();
  }

  async init() {
    this.loadSettings();
    this.setupEventListeners();
    await this.fetchHome();
    await this.fetchAgents();
    await this.autoImportClaudeCode();
    await this.fetchConversations();
    this.connectSyncWebSocket();
    this.setupCrossTabSync();
    this.startPeriodicSync();
    this.renderAll();
  }

  startPeriodicSync() {
    // Rapid sync every 10 seconds: check for new Claude Code conversations and sync
    setInterval(() => {
      this.autoImportClaudeCode().then(() => {
        this.fetchConversations().then(() => this.renderChatHistory());
      });
    }, 10000);
  }

  async autoImportClaudeCode() {
    try {
      await fetch(BASE_URL + '/api/import/claude-code');
    } catch (e) {
      console.error('autoImportClaudeCode:', e);
    }
  }

  connectSyncWebSocket() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.syncWs = new ReconnectingWebSocket(
      `${proto}//${location.host}${BASE_URL}/sync`
    );

    this.syncWs.on('open', () => {
      console.log('Sync WebSocket connected');
      this.updateConnectionStatus('connected');
    });

    this.syncWs.on('message', (e) => {
      try {
        const event = JSON.parse(e.data);
        this.handleSyncEvent(event, false);
      } catch (err) {
        console.error('Sync message parse error:', err);
      }
    });

    this.syncWs.on('close', () => {
      console.log('Sync WebSocket disconnected, will auto-reconnect...');
      this.updateConnectionStatus('reconnecting');
    });

    this.syncWs.on('error', (err) => {
      console.error('Sync WebSocket error:', err);
      this.updateConnectionStatus('disconnected');
    });
  }

  setupCrossTabSync() {
    if ('BroadcastChannel' in window) {
      try {
        this.broadcastChannel = new BroadcastChannel('gmgui-sync');
        this.broadcastChannel.onmessage = (e) => {
          this.handleSyncEvent(e.data, true);
        };
      } catch (err) {
        console.error('BroadcastChannel error:', err);
      }
    }
  }

  handleSyncEvent(event, fromBroadcast = false) {
    switch (event.type) {
      case 'sync_connected':
        break;

      case 'conversation_created':
        this.conversations.set(event.conversation.id, event.conversation);
        this.renderChatHistory();
        if (!fromBroadcast && this.broadcastChannel) {
          this.broadcastChannel.postMessage(event);
        }
        break;

      case 'conversation_updated':
        this.conversations.set(event.conversation.id, event.conversation);
        this.renderChatHistory();
        if (this.currentConversation?.id === event.conversation.id) {
          this.currentConversation = event.conversation;
          this.renderCurrentConversation();
        }
        if (!fromBroadcast && this.broadcastChannel) {
          this.broadcastChannel.postMessage(event);
        }
        break;

      case 'conversation_deleted':
        this.conversations.delete(event.conversationId);
        this.renderChatHistory();
        if (this.currentConversation?.id === event.conversationId) {
          this.currentConversation = null;
          this.renderCurrentConversation();
        }
        if (!fromBroadcast && this.broadcastChannel) {
          this.broadcastChannel.postMessage(event);
        }
        break;

      case 'message_created':
        if (!fromBroadcast && this.broadcastChannel) {
          this.broadcastChannel.postMessage(event);
        }
        break;

      case 'session_updated':
        if (event.status === 'completed' && event.message) {
          if (this.currentConversation === event.conversationId) {
            this.addMessageToDisplay(event.message);
            if (this.settings.autoScroll) {
              const div = document.getElementById('chatMessages');
              if (div) div.scrollTop = div.scrollHeight;
            }
          }
        }
        if (!fromBroadcast && this.broadcastChannel) {
          this.broadcastChannel.postMessage(event);
        }
        break;
    }
  }

  updateConnectionStatus(status) {
    const el = document.getElementById('connectionStatus');
    if (!el) return;

    el.className = `connection-status ${status}`;
    const text = el.querySelector('.status-text');
    if (text) {
      text.textContent = status === 'connected' ? 'Connected' :
                         status === 'reconnecting' ? 'Reconnecting...' :
                         'Disconnected';
    }
  }

  async fetchHome() {
    try {
      const res = await fetch(BASE_URL + '/api/home');
      if (res.ok) {
        const data = await res.json();
        localStorage.setItem('gmgui-home', data.home);
      }
    } catch (e) {
      console.error('fetchHome:', e);
    }
  }

  loadSettings() {
    const stored = localStorage.getItem('gmgui-settings');
    if (stored) {
      try { this.settings = { ...this.settings, ...JSON.parse(stored) }; } catch (_) {}
    }
    this.applySettings();
  }

  saveSettings() {
    localStorage.setItem('gmgui-settings', JSON.stringify(this.settings));
  }

  applySettings() {
    const el = document.getElementById('autoScroll');
    if (el) el.checked = this.settings.autoScroll;
    const t = document.getElementById('connectTimeout');
    if (t) t.value = this.settings.connectTimeout / 1000;
  }

  expandHome(p) {
    if (!p) return p;
    const home = localStorage.getItem('gmgui-home') || '/config';
    return p.startsWith('~') ? p.replace('~', home) : p;
  }

  setupEventListeners() {
    window.addEventListener('focus', () => {
      this.autoImportClaudeCode().then(() => {
        this.fetchConversations().then(() => this.renderChatHistory());
      });
    });
    const input = document.getElementById('messageInput');
    if (input) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.sendMessage();
        }
      });
      input.addEventListener('input', () => this.updateSendButtonState());
    }
    document.getElementById('autoScroll')?.addEventListener('change', (e) => {
      this.settings.autoScroll = e.target.checked;
      this.saveSettings();
    });
    document.getElementById('connectTimeout')?.addEventListener('change', (e) => {
      this.settings.connectTimeout = parseInt(e.target.value) * 1000;
      this.saveSettings();
    });
  }

  async fetchAgents() {
    try {
      const res = await fetch(BASE_URL + '/api/agents');
      const data = await res.json();
      if (data.agents) {
        data.agents.forEach(a => this.agents.set(a.id, a));
      }
    } catch (e) {
      console.error('fetchAgents:', e);
    }
  }

  async fetchConversations() {
    try {
      const res = await fetch(BASE_URL + '/api/conversations');
      const data = await res.json();
      if (data.conversations) {
        this.conversations.clear();
        data.conversations.forEach(c => this.conversations.set(c.id, c));
      }
    } catch (e) {
      console.error('fetchConversations:', e);
    }
  }

  async fetchMessages(conversationId) {
    try {
      const res = await fetch(`${BASE_URL}/api/conversations/${conversationId}/messages`);
      const data = await res.json();
      return data.messages || [];
    } catch (e) {
      console.error('fetchMessages:', e);
      return [];
    }
  }

  renderAll() {
    this.renderAgentCards();
    this.renderChatHistory();
    if (this.currentConversation) {
      this.displayConversation(this.currentConversation);
    }
  }

  renderAgentCards() {
    const container = document.getElementById('agentCards');
    if (!container) return;
    container.innerHTML = '';
    if (this.agents.size === 0) {
      container.innerHTML = '<p style="color: var(--text-tertiary); font-size: 0.875rem;">No agents found. Install claude or opencode.</p>';
      return;
    }
    let first = true;
    this.agents.forEach((agent, id) => {
      if (!first) {
        const sep = document.createElement('span');
        sep.className = 'agent-separator';
        sep.textContent = '|';
        container.appendChild(sep);
      }
      first = false;
      const card = document.createElement('button');
      card.className = `agent-card ${this.selectedAgent === id ? 'active' : ''}`;
      card.onclick = () => this.selectAgent(id);
      card.innerHTML = `
        <span class="agent-card-icon">${escapeHtml(agent.icon || 'A')}</span>
        <span class="agent-card-name">${escapeHtml(agent.name || id)}</span>
      `;
      container.appendChild(card);
    });
  }

  selectAgent(id) {
    this.selectedAgent = id;
    localStorage.setItem('gmgui-selectedAgent', id);
    this.renderAgentCards();
    const welcome = document.querySelector('.welcome-section');
    if (welcome) welcome.style.display = 'none';
    const input = document.getElementById('messageInput');
    if (input) input.focus();
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
      (a, b) => (b.updated_at || 0) - (a.updated_at || 0)
    );
    sorted.forEach(conv => {
      const item = document.createElement('button');
      item.className = `chat-item ${this.currentConversation === conv.id ? 'active' : ''}`;
      const titleSpan = document.createElement('span');
      titleSpan.className = 'chat-item-title';
      titleSpan.textContent = conv.title || 'Untitled';
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'chat-item-delete';
      deleteBtn.textContent = 'x';
      deleteBtn.title = 'Delete chat';
      deleteBtn.onclick = (e) => {
        e.stopPropagation();
        this.deleteConversation(conv.id);
      };
      item.appendChild(titleSpan);
      item.appendChild(deleteBtn);
      item.onclick = () => this.displayConversation(conv.id);
      list.appendChild(item);
    });
  }

  async deleteConversation(id) {
    try {
      const res = await fetch(`${BASE_URL}/api/conversations/${id}`, { method: 'DELETE' });
    } catch (e) {
      console.error('deleteConversation:', e);
    }
    this.conversations.delete(id);
    if (this.currentConversation === id) {
      this.currentConversation = null;
      const first = Array.from(this.conversations.values())[0];
      if (first) {
        this.displayConversation(first.id);
      } else {
        this.showWelcome();
      }
    }
    this.renderChatHistory();
  }

  showWelcome() {
    const div = document.getElementById('chatMessages');
    if (!div) return;
    div.innerHTML = `
      <div class="welcome-section">
        <h2>Hi, what's your plan for today?</h2>
        <div class="agent-selection">
          <div id="agentCards" class="agent-cards"></div>
        </div>
      </div>
    `;
    this.renderAgentCards();
  }

  async displayConversation(id) {
    this.currentConversation = id;
    const conv = this.conversations.get(id);
    if (!conv) return;
    if (conv.agentId && !this.selectedAgent) {
      this.selectedAgent = conv.agentId;
    }

    const messages = await this.fetchMessages(id);

    const div = document.getElementById('chatMessages');
    if (!div) return;
    div.innerHTML = '';

    if (messages.length === 0 && !this.selectedAgent) {
      div.innerHTML = `
        <div class="welcome-section">
          <h2>Hi, what's your plan for today?</h2>
          <div class="agent-selection">
            <div id="agentCards" class="agent-cards"></div>
          </div>
        </div>
      `;
      this.renderAgentCards();
    } else {
      messages.forEach(msg => this.addMessageToDisplay(msg));

      if (this.settings.autoScroll) {
        div.scrollTop = div.scrollHeight;
      }
    }
    this.renderChatHistory();
    this.renderAgentCards();
  }


  parseAndRenderContent(content) {
    const elements = [];
    if (typeof content === 'string') {
      const htmlCodeBlockRegex = /```html\n([\s\S]*?)\n```/g;
      let lastIndex = 0;
      let match;

      while ((match = htmlCodeBlockRegex.exec(content)) !== null) {
        if (match.index > lastIndex) {
          const textBefore = content.substring(lastIndex, match.index);
          if (textBefore.trim()) {
            const bubble = document.createElement('div');
            bubble.className = 'message-bubble';
            bubble.textContent = textBefore;
            elements.push(bubble);
          }
        }

        const htmlContent = match[1];
        const htmlEl = this.createHtmlBlock({ html: htmlContent });
        elements.push(htmlEl);
        lastIndex = htmlCodeBlockRegex.lastIndex;
      }

      if (lastIndex < content.length) {
        const textAfter = content.substring(lastIndex);
        if (textAfter.trim()) {
          const bubble = document.createElement('div');
          bubble.className = 'message-bubble';
          bubble.textContent = textAfter;
          elements.push(bubble);
        }
      }

      return elements.length > 0 ? elements : null;
    }
    return null;
  }

  addMessageToDisplay(msg) {
    const div = document.getElementById('chatMessages');
    if (!div) return;
    const el = document.createElement('div');
    el.className = `message ${msg.role}`;
    el.dataset.messageId = msg.id;

    if (typeof msg.content === 'string') {
      const parsed = this.parseAndRenderContent(msg.content);
      if (parsed) {
        parsed.forEach(elem => el.appendChild(elem));
      } else {
        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';
        bubble.textContent = msg.content;
        el.appendChild(bubble);
      }
    } else if (typeof msg.content === 'object' && msg.content !== null) {
      if (msg.content.text) {
        const parsed = this.parseAndRenderContent(msg.content.text);
        if (parsed) {
          parsed.forEach(elem => el.appendChild(elem));
        } else {
          const bubble = document.createElement('div');
          bubble.className = 'message-bubble';
          bubble.textContent = msg.content.text;
          el.appendChild(bubble);
        }
      }
      if (msg.content.blocks && Array.isArray(msg.content.blocks)) {
        msg.content.blocks.forEach(block => {
          if (block.type === 'html') {
            const htmlEl = this.createHtmlBlock(block);
            el.appendChild(htmlEl);
          } else if (block.type === 'image') {
            const imgEl = this.createImageBlock(block);
            el.appendChild(imgEl);
          }
        });
      }
    } else {
      const bubble = document.createElement('div');
      bubble.className = 'message-bubble';
      bubble.textContent = JSON.stringify(msg.content);
      el.appendChild(bubble);
    }

    div.appendChild(el);
  }

  async startNewChat(folderPath) {
    if (!this.selectedAgent) {
      const firstAgent = Array.from(this.agents.keys())[0];
      if (firstAgent) {
        this.selectedAgent = firstAgent;
      }
    }
    const title = folderPath
      ? folderPath.split('/').pop() || folderPath
      : `Chat ${this.conversations.size + 1}`;
    try {
      const res = await fetch(BASE_URL + '/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: this.selectedAgent || 'claude-code', title }),
      });
      const data = await res.json();
      if (data.conversation) {
        const conv = data.conversation;
        if (folderPath) conv.folderPath = folderPath;
        this.conversations.set(conv.id, conv);
        this.currentConversation = conv.id;
        this.renderChatHistory();
        this.displayConversation(conv.id);
      }
    } catch (e) {
      console.error('startNewChat:', e);
    }
  }

  async sendMessage() {
    const input = document.getElementById('messageInput');
    const message = input.value.trim();
    if (!message) return;
    if (!this.selectedAgent) {
      this.addSystemMessage('Please select an agent first');
      return;
    }
    if (!this.currentConversation) {
      await this.startNewChat();
    }
    if (!this.currentConversation) return;
    const conv = this.conversations.get(this.currentConversation);

    const idempotencyKey = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    this.addMessageToDisplay({ role: 'user', content: message });
    input.value = '';
    this.updateSendButtonState();

    try {
      const folderPath = conv?.folderPath || localStorage.getItem('gmgui-home') || '/config';
      const res = await fetch(`${BASE_URL}/api/conversations/${this.currentConversation}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: message,
          agentId: this.selectedAgent,
          folderContext: { path: folderPath, isFolder: true },
          idempotencyKey,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        this.addMessageToDisplay({ role: 'system', content: `Error: ${err.error || 'Request failed'}` });
        return;
      }
      const data = await res.json();
      this.idempotencyKeys.set(idempotencyKey, data.session.id);
      this.startPollingMessages(this.currentConversation);
    } catch (e) {
      this.addMessageToDisplay({ role: 'system', content: `Error: ${e.message}` });
    }
    if (this.settings.autoScroll) {
      const div = document.getElementById('chatMessages');
      if (div) div.scrollTop = div.scrollHeight;
    }
  }

  addSystemMessage(text) {
    this.addMessageToDisplay({ role: 'system', content: text });
  }

  startPollingMessages(conversationId) {
    if (this.pollingInterval) clearInterval(this.pollingInterval);

    let pollCount = 0;
    const maxNoResponsePolls = 60; // Stop polling after 60 polls with no change
    let lastMessageCount = 0;

    this.pollingInterval = setInterval(async () => {
      try {
        const res = await fetch(`${BASE_URL}/api/conversations/${conversationId}/messages`);
        const data = await res.json();
        const messages = data.messages || [];

        // If we got new messages, render them
        if (messages.length > lastMessageCount) {
          const newMessages = messages.slice(lastMessageCount);
          newMessages.forEach(msg => {
            const existingEl = document.querySelector(`[data-message-id="${msg.id}"]`);
            if (!existingEl) {
              this.addMessageToDisplay(msg);
            }
          });
          lastMessageCount = messages.length;
          pollCount = 0; // Reset counter when we get activity

          if (this.settings.autoScroll) {
            const div = document.getElementById('chatMessages');
            if (div) div.scrollTop = div.scrollHeight;
          }
        } else {
          pollCount++;
        }

        // Stop polling if no changes for a while
        if (pollCount > maxNoResponsePolls) {
          clearInterval(this.pollingInterval);
          this.pollingInterval = null;
        }
      } catch (e) {
        console.error('Polling error:', e);
        clearInterval(this.pollingInterval);
        this.pollingInterval = null;
      }
    }, 500); // Poll every 500ms
  }

  createThoughtBlock() {
    const wrap = document.createElement('div');
    wrap.className = 'thought-block';
    const header = document.createElement('div');
    header.className = 'thought-header';
    header.textContent = 'Thinking...';
    header.onclick = () => wrap.classList.toggle('collapsed');
    const content = document.createElement('div');
    content.className = 'thought-content';
    wrap.appendChild(header);
    wrap.appendChild(content);
    return wrap;
  }

  createToolBlock(event) {
    const wrap = document.createElement('div');
    wrap.className = `tool-block status-${event.status || 'running'}`;
    const header = document.createElement('div');
    header.className = 'tool-header';
    const kindIcons = { execute: '>', read: '?', edit: '/', search: '~', fetch: '@', write: '/', think: '!', other: '#' };
    const icon = kindIcons[event.kind] || '#';
    header.innerHTML = `<span class="tool-icon">${escapeHtml(icon)}</span><span class="tool-title">${escapeHtml(event.title || event.kind || 'tool')}</span><span class="tool-status">${escapeHtml(event.status || 'running')}</span>`;
    header.onclick = () => wrap.classList.toggle('collapsed');
    wrap.appendChild(header);
    if (event.content && event.content.length) {
      const body = document.createElement('div');
      body.className = 'tool-body';
      event.content.forEach(c => {
        if (c.text) body.textContent += c.text;
      });
      wrap.appendChild(body);
    }
    return wrap;
  }

  updateToolBlock(block, event) {
    block.className = `tool-block status-${event.status || 'completed'}`;
    const statusEl = block.querySelector('.tool-status');
    if (statusEl) statusEl.textContent = event.status || 'completed';
    if (event.content && event.content.length) {
      let body = block.querySelector('.tool-body');
      if (!body) { body = document.createElement('div'); body.className = 'tool-body'; block.appendChild(body); }
      event.content.forEach(c => {
        if (c.text) body.textContent += c.text;
      });
    }
  }

  createPlanBlock(entries) {
    const wrap = document.createElement('div');
    wrap.className = 'plan-block';
    const header = document.createElement('div');
    header.className = 'plan-header';
    header.textContent = 'Plan';
    wrap.appendChild(header);
    if (entries && entries.length) {
      entries.forEach(entry => {
        const item = document.createElement('div');
        item.className = 'plan-item';
        item.textContent = entry.title || entry.description || JSON.stringify(entry);
        wrap.appendChild(item);
      });
    }
    return wrap;
  }

  createHtmlBlock(event) {
    const wrap = document.createElement('div');
    wrap.className = 'html-block';
    if (event.id) wrap.id = `html-${event.id}`;
    if (event.title) {
      const header = document.createElement('div');
      header.className = 'html-header';
      header.textContent = event.title;
      wrap.appendChild(header);
    }
    const content = document.createElement('div');
    content.className = 'html-content';
    content.innerHTML = event.html;
    wrap.appendChild(content);
    return wrap;
  }

  createImageBlock(event) {
    const wrap = document.createElement('div');
    wrap.className = 'image-block';
    if (event.title) {
      const header = document.createElement('div');
      header.className = 'image-header';
      header.textContent = event.title;
      wrap.appendChild(header);
    }
    const img = document.createElement('img');
    img.src = event.url;
    img.alt = event.alt || 'Image from agent';
    img.className = 'image-content';
    img.style.maxWidth = '100%';
    img.style.height = 'auto';
    img.style.borderRadius = '0.25rem';
    wrap.appendChild(img);
    return wrap;
  }

  updateSendButtonState() {
    const input = document.getElementById('messageInput');
    const btn = document.getElementById('sendBtn');
    if (btn) btn.disabled = !input || !input.value.trim();
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
    if (modal) modal.classList.remove('active');
  }

  async loadFolderContents(folderPath) {
    const list = document.getElementById('folderBrowserList');
    if (!list) return;
    list.innerHTML = '<div style="padding: 1rem; color: var(--text-tertiary);">Loading...</div>';
    try {
      const res = await fetch(BASE_URL + '/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: folderPath }),
      });
      if (res.ok) {
        const data = await res.json();
        this.renderFolderList(data.folders, folderPath);
      } else {
        list.innerHTML = '<div style="padding: 1rem; color: var(--color-danger);">Error loading folder</div>';
      }
    } catch (e) {
      list.innerHTML = '<div style="padding: 1rem; color: var(--color-danger);">Error: ' + e.message + '</div>';
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
      parentItem.style.cssText = 'padding: 0.75rem 1rem; cursor: pointer; display: flex; align-items: center; gap: 0.75rem; border-bottom: 1px solid var(--border-color);';
      parentItem.innerHTML = '<span>../</span>';
      parentItem.onclick = () => {
        document.getElementById('folderPath').value = parentPath;
        this.loadFolderContents(parentPath);
      };
      list.appendChild(parentItem);
    }
    if (!folders || folders.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'padding: 1rem; color: var(--text-tertiary); text-align: center;';
      empty.textContent = 'No subfolders found';
      list.appendChild(empty);
      return;
    }
    folders.forEach(folder => {
      const item = document.createElement('div');
      item.style.cssText = 'padding: 0.75rem 1rem; cursor: pointer; display: flex; align-items: center; gap: 0.75rem; border-bottom: 1px solid var(--border-color);';
      item.textContent = folder.name;
      item.onclick = () => {
        const newPath = currentPath === '/' ? '/' + folder.name : currentPath + '/' + folder.name;
        document.getElementById('folderPath').value = newPath;
        this.loadFolderContents(newPath);
      };
      list.appendChild(item);
    });
  }
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showNewChatModal() {
  const modal = document.getElementById('newChatModal');
  if (modal) modal.classList.add('active');
}

function closeNewChatModal() {
  const modal = document.getElementById('newChatModal');
  if (modal) modal.classList.remove('active');
}

function createChatInWorkspace() {
  closeNewChatModal();
  app.startNewChat();
}

function createChatInFolder() {
  closeNewChatModal();
  app.openFolderBrowser();
}

async function importClaudeCodeConversations() {
  closeNewChatModal();
  try {
    const res = await fetch(BASE_URL + '/api/import/claude-code');
    const data = await res.json();

    if (!data.imported) {
      alert('No Claude Code conversations found to import.');
      return;
    }

    const imported = data.imported.filter(r => r.status === 'imported');
    const skipped = data.imported.filter(r => r.status === 'skipped');
    const errors = data.imported.filter(r => r.status === 'error');

    let message = `Import complete!\n\n`;
    if (imported.length > 0) {
      message += `✓ Imported: ${imported.length} conversation(s)\n`;
    }
    if (skipped.length > 0) {
      message += `⊘ Skipped: ${skipped.length} (already imported)\n`;
    }
    if (errors.length > 0) {
      message += `✗ Errors: ${errors.length}\n`;
    }

    alert(message.trim());

    if (imported.length > 0) {
      await app.fetchConversations();
      app.renderAll();
    }
  } catch (e) {
    console.error('Import error:', e);
    alert('Failed to import Claude Code conversations: ' + e.message);
  }
}

function sendMessage() { app.sendMessage(); }

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.classList.toggle('open');
}

function switchTab(tabName) {
  const panel = document.getElementById('settingsPanel');
  const main = document.querySelector('.main-content');
  if (tabName === 'settings' && panel && main) {
    panel.style.display = 'flex';
    main.style.display = 'none';
  } else if (tabName === 'chat' && panel && main) {
    panel.style.display = 'none';
    main.style.display = 'flex';
  }
}

function closeFolderBrowser() { app.closeFolderBrowser(); }

function browseFolders() {
  const pathInput = document.getElementById('folderPath');
  const p = pathInput.value.trim() || '~/';
  app.loadFolderContents(app.expandHome(p));
}

function confirmFolderSelection() {
  const pathInput = document.getElementById('folderPath');
  const p = pathInput.value.trim();
  if (!p) return;
  app.startNewChat(app.expandHome(p));
  app.closeFolderBrowser();
}

const app = new GMGUIApp();
window._app = app;
