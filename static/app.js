const BASE_URL = window.__BASE_URL || '';

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
    this.conversations = new Map();
    this.currentConversation = null;
    this.agents = new Map();
    this.selectedAgent = null;
    this.ws = null;
  }

  async init() {
    console.log('[APP] Initializing');

    this.setupEventListeners();
    await this.fetchAgents();

    const savedAgent = localStorage.getItem('gmgui-selectedAgent');
    if (savedAgent && this.agents.has(savedAgent)) {
      this.selectedAgent = savedAgent;
    } else if (this.agents.size > 0) {
      this.selectedAgent = Array.from(this.agents.keys())[0];
      localStorage.setItem('gmgui-selectedAgent', this.selectedAgent);
    }

    await this.fetchConversations();
    this.connectWebSocket();
    this.renderAll();
    console.log('[APP] Ready');
  }

  async fetchAgents() {
    try {
      const res = await fetch(BASE_URL + '/api/agents');
      const data = await res.json();
      for (const agent of data.agents || []) {
        this.agents.set(agent.id, agent);
      }
    } catch (e) {
      console.error('[APP] Error fetching agents:', e);
    }
  }

  async fetchConversations() {
    try {
      const res = await fetch(BASE_URL + '/api/conversations');
      const data = await res.json();
      this.conversations.clear();
      for (const conv of data.conversations || []) {
        this.conversations.set(conv.id, conv);
      }
      console.log('[APP] Loaded', this.conversations.size, 'conversations');
    } catch (e) {
      console.error('[APP] Error fetching conversations:', e);
    }
  }

  async fetchMessages(conversationId) {
    try {
      const res = await fetch(BASE_URL + `/api/conversations/${conversationId}/messages`);
      const data = await res.json();
      return data.messages || [];
    } catch (e) {
      console.error('[APP] Error fetching messages:', e);
      return [];
    }
  }

  connectWebSocket() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new ReconnectingWebSocket(`${proto}//${location.host}${BASE_URL}/sync`);

    this.ws.on('open', () => {
      console.log('[WS] Connected');
      document.getElementById('connectionStatus').textContent = 'Connected';
    });

    this.ws.on('message', (e) => {
      try {
        const event = JSON.parse(e.data);
        this.handleEvent(event);
      } catch (err) {
        console.error('[WS] Parse error:', err);
      }
    });

    this.ws.on('close', () => {
      console.log('[WS] Disconnected, reconnecting...');
      document.getElementById('connectionStatus').textContent = 'Reconnecting...';
    });

    this.ws.on('error', (err) => {
      console.error('[WS] Error:', err);
      document.getElementById('connectionStatus').textContent = 'Error';
    });
  }

  handleEvent(event) {
    if (event.type === 'message_created') {
      this.addMessageToDisplay(event.message);
      this.handleMessageReceived(event.message);
    } else if (event.type === 'conversations_updated') {
      this.fetchConversations().then(() => this.renderChatHistory());
    }
  }

  addMessageToDisplay(message) {
    if (this.currentConversation && message.conversationId === this.currentConversation) {
      const chatDiv = document.getElementById('chatMessages');
      if (!chatDiv) return;

      const msgEl = document.createElement('div');
      msgEl.className = `message ${message.role}`;

      // Try to parse content as JSON for structured display
      let contentHtml = '';
      try {
        const parsed = typeof message.content === 'string' ? JSON.parse(message.content) : message.content;
        if (parsed && parsed.type === 'claude_execution' && parsed.blocks) {
          // Render each block with appropriate formatting
          contentHtml = '<div class="execution-blocks">';
          for (const block of parsed.blocks) {
            contentHtml += this.renderMessageBlock(block);
          }
          contentHtml += '</div>';
        } else {
          throw new Error('Not a claude_execution message');
        }
      } catch (e) {
        // Fallback: render as plain text
        const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
        contentHtml = `<div class="message-content">${this.escapeHtml(text)}</div>`;
      }

      msgEl.innerHTML = contentHtml;
      chatDiv.appendChild(msgEl);
      chatDiv.scrollTop = chatDiv.scrollHeight;
    }
  }

  renderMessageBlock(block) {
    if (!block) return '';

    let html = '<div class="message-block">';

    switch (block.type) {
      case 'text':
        html += `<div class="block-text">${this.escapeHtml(block.text || '')}</div>`;
        break;

      case 'tool_use':
        html += `<div class="block-tool-use">`;
        html += `<strong class="tool-name">${this.escapeHtml(block.name || 'Tool')}</strong>`;
        html += `<div class="tool-input"><pre>${this.escapeHtml(JSON.stringify(block.input || {}, null, 2))}</pre></div>`;
        html += `</div>`;
        break;

      case 'tool_result':
        html += `<div class="block-tool-result">`;
        html += `<strong>Result:</strong>`;
        const resultText = typeof block.result === 'string' ? block.result : JSON.stringify(block.result, null, 2);
        html += `<div class="tool-result"><pre>${this.escapeHtml(resultText)}</pre></div>`;
        html += `</div>`;
        break;

      case 'file_operation':
        html += `<div class="block-file-op">`;
        html += `<strong class="file-action">${this.escapeHtml(block.action || 'File Operation')}</strong>`;
        html += `<div class="file-path">${this.escapeHtml(block.path || '')}</div>`;
        if (block.content) {
          html += `<div class="file-content"><pre>${this.escapeHtml(block.content.substring(0, 500))}</pre></div>`;
        }
        html += `</div>`;
        break;

      default:
        html += `<div class="block-unknown">${this.escapeHtml(JSON.stringify(block, null, 2))}</div>`;
    }

    html += '</div>';
    return html;
  }

  handleMessageReceived(message) {
    if (message.role === 'user') {
      document.getElementById('messageInput').value = '';
      document.getElementById('messageInput').focus();
    }
  }

  async sendMessage() {
    const input = document.getElementById('messageInput');
    const content = input.value.trim();

    if (!content || !this.currentConversation || !this.selectedAgent) return;

    try {
      const res = await fetch(BASE_URL + `/api/conversations/${this.currentConversation}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          agentId: this.selectedAgent
        })
      });

      if (res.ok) {
        input.value = '';
      }
    } catch (e) {
      console.error('[APP] Error sending message:', e);
    }
  }

  async createConversation(title = 'New Conversation') {
    if (!this.selectedAgent) {
      console.error('[APP] No agent selected');
      return;
    }

    try {
      const res = await fetch(BASE_URL + '/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, agentId: this.selectedAgent })
      });

      if (res.ok) {
        const data = await res.json();
        await this.fetchConversations();
        this.renderChatHistory();
        if (data.conversation) {
          this.selectConversation(data.conversation.id);
        }
      }
    } catch (e) {
      console.error('[APP] Error creating conversation:', e);
    }
  }

  selectConversation(convId) {
    this.currentConversation = convId;
    document.querySelectorAll('.chat-item').forEach(el => el.classList.remove('active'));
    const el = document.querySelector(`[data-conv-id="${convId}"]`);
    if (el) el.classList.add('active');
    this.renderChatMessages();
  }

  async renderChatMessages() {
    const chatDiv = document.getElementById('chatMessages');
    if (!chatDiv || !this.currentConversation) return;

    chatDiv.innerHTML = '';
    const messages = await this.fetchMessages(this.currentConversation);
    for (const msg of messages) {
      const msgEl = document.createElement('div');
      msgEl.className = `message ${msg.role}`;

      // Try to parse content as JSON for structured display
      let contentHtml = '';
      try {
        const parsed = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
        if (parsed && parsed.type === 'claude_execution' && parsed.blocks) {
          // Render each block with appropriate formatting
          contentHtml = '<div class="execution-blocks">';
          for (const block of parsed.blocks) {
            contentHtml += this.renderMessageBlock(block);
          }
          contentHtml += '</div>';
        } else {
          throw new Error('Not a claude_execution message');
        }
      } catch (e) {
        // Fallback: render as plain text
        const text = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        contentHtml = `<div class="message-content">${this.escapeHtml(text)}</div>`;
      }

      msgEl.innerHTML = contentHtml;
      chatDiv.appendChild(msgEl);
    }
  }

  renderChatHistory() {
    const list = document.getElementById('chatList');
    if (!list) return;

    list.innerHTML = '';
    const convs = Array.from(this.conversations.values())
      .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));

    for (const conv of convs) {
      const el = document.createElement('div');
      el.className = 'chat-item';
      el.setAttribute('data-conv-id', conv.id);
      el.innerHTML = `<div class="chat-item-title">${this.escapeHtml(conv.title || 'Untitled')}</div>`;
      el.onclick = () => this.selectConversation(conv.id);
      list.appendChild(el);
    }
  }

  renderAll() {
    this.renderChatHistory();
    if (this.conversations.size > 0 && !this.currentConversation) {
      const firstConv = Array.from(this.conversations.values())[0];
      this.selectConversation(firstConv.id);
    }
  }

  setupEventListeners() {
    const sendBtn = document.getElementById('sendBtn');
    if (sendBtn) {
      sendBtn.onclick = () => this.sendMessage();
    }

    const input = document.getElementById('messageInput');
    if (input) {
      input.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          this.sendMessage();
        }
      });
    }

    const newConvBtn = document.getElementById('newConversationBtn');
    if (newConvBtn) {
      newConvBtn.onclick = () => this.createConversation();
    }
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

const app = new GMGUIApp();

function initializeApp() {
  app.init().catch(err => {
    console.error('[CRITICAL] Failed to initialize app:', err);
  });
}

function sendMessage() {
  app.sendMessage();
}

function showNewChatModal() {
  const modal = document.getElementById('newChatModal');
  if (modal) {
    modal.style.display = 'flex';
  }
}

function closeNewChatModal() {
  const modal = document.getElementById('newChatModal');
  if (modal) {
    modal.style.display = 'none';
  }
}

function createChatInWorkspace() {
  const title = prompt('Enter a title for the conversation:', 'New Conversation');
  if (title) {
    app.createConversation(title);
    closeNewChatModal();
  }
}

function createChatInFolder() {
  const folderModal = document.getElementById('folderBrowserModal');
  if (folderModal) {
    folderModal.style.display = 'flex';
    closeNewChatModal();
  }
}

function closeFolderBrowser() {
  const modal = document.getElementById('folderBrowserModal');
  if (modal) {
    modal.style.display = 'none';
  }
}

function confirmFolderSelection() {
  const folderPath = document.getElementById('folderPath')?.value;
  if (folderPath) {
    const title = `Chat in ${folderPath}`;
    app.createConversation(title);
    closeFolderBrowser();
  }
}

function browseFolders() {
  // Placeholder for folder browsing functionality
  console.log('Folder browsing not yet implemented');
}

function toggleSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (sidebar) {
    sidebar.classList.toggle('collapsed');
  }
}

function switchTab(tab) {
  if (tab === 'settings') {
    const panel = document.getElementById('settingsPanel');
    if (panel) {
      panel.style.display = 'flex';
    }
    const main = document.querySelector('.main-content');
    if (main) {
      main.style.display = 'none';
    }
  } else if (tab === 'chat') {
    const panel = document.getElementById('settingsPanel');
    if (panel) {
      panel.style.display = 'none';
    }
    const main = document.querySelector('.main-content');
    if (main) {
      main.style.display = 'flex';
    }
  }
}

function triggerFileUpload() {
  const input = document.getElementById('fileInput');
  if (input) {
    input.click();
  }
}

function handleFileUpload() {
  console.log('File upload not yet implemented');
}

function closeScreenshotModal() {
  const modal = document.getElementById('screenshotModal');
  if (modal) {
    modal.style.display = 'none';
  }
}

function sendScreenshot() {
  console.log('Send screenshot not yet implemented');
}

function downloadScreenshot() {
  console.log('Download screenshot not yet implemented');
}

window.addEventListener('load', initializeApp);
