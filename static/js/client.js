/**
 * AgentGUI Client
 * Main application orchestrator that integrates WebSocket, event processing,
 * and streaming renderer for real-time Claude Code execution visualization
 */

class AgentGUIClient {
  constructor(config = {}) {
    this.config = {
      containerId: config.containerId || 'app',
      outputContainerId: config.outputContainerId || 'output',
      scrollContainerId: config.scrollContainerId || 'output-scroll',
      autoConnect: config.autoConnect !== false,
      ...config
    };

    // Initialize components
    this.renderer = new StreamingRenderer(config.renderer || {});
    this.wsManager = new WebSocketManager(config.websocket || {});
    this.eventProcessor = new EventProcessor(config.eventProcessor || {});

    // Application state
    this.state = {
      isInitialized: false,
      currentSession: null,
      currentConversation: null,
      isStreaming: false,
      sessionEvents: [],
      conversations: [],
      agents: []
    };

    // Event handlers
    this.eventHandlers = {};

    // UI state
    this.ui = {
      statusIndicator: null,
      messageInput: null,
      sendButton: null,
      agentSelector: null
    };
  }

  /**
   * Initialize the client
   */
  async init() {
    try {
      console.log('Initializing AgentGUI client');

      // Initialize renderer
      this.renderer.init(this.config.outputContainerId, this.config.scrollContainerId);

      // Setup event listeners
      this.setupWebSocketListeners();
      this.setupRendererListeners();

      // Load initial data
      await this.loadAgents();
      await this.loadConversations();

      // Setup UI elements
      this.setupUI();

      // Enable controls for initial interaction
      this.enableControls();

      // Connect WebSocket
      if (this.config.autoConnect) {
        await this.connectWebSocket();
      }

      this.state.isInitialized = true;
      this.emit('initialized');

      console.log('AgentGUI client initialized');
      return this;
    } catch (error) {
      console.error('Client initialization error:', error);
      this.showError('Failed to initialize client: ' + error.message);
      throw error;
    }
  }

  /**
   * Setup WebSocket event listeners
   */
  setupWebSocketListeners() {
    this.wsManager.on('connected', () => {
      console.log('WebSocket connected');
      this.updateConnectionStatus('connected');
      this.emit('ws:connected');
    });

    this.wsManager.on('disconnected', () => {
      console.log('WebSocket disconnected');
      this.updateConnectionStatus('disconnected');
      this.emit('ws:disconnected');
    });

    this.wsManager.on('reconnecting', (data) => {
      console.log('WebSocket reconnecting:', data);
      this.updateConnectionStatus('reconnecting');
    });

    this.wsManager.on('message', (data) => {
      this.handleWebSocketMessage(data);
    });

    this.wsManager.on('error', (data) => {
      console.error('WebSocket error:', data);
      this.showError('Connection error: ' + (data.error?.message || 'unknown'));
    });

    this.wsManager.on('reconnect_failed', (data) => {
      console.error('WebSocket reconnection failed:', data);
      this.updateConnectionStatus('error');
      this.showError('Failed to reconnect to server after ' + data.attempts + ' attempts');
    });
  }

  /**
   * Setup renderer event listeners
   */
  setupRendererListeners() {
    this.renderer.on('batch:complete', (data) => {
      console.log('Batch rendered:', data);
      this.updateMetrics(data.metrics);
    });

    this.renderer.on('error:render', (data) => {
      console.error('Render error:', data.error);
    });
  }

  /**
   * Setup UI elements
   */
  setupUI() {
    const container = document.getElementById(this.config.containerId);
    if (!container) {
      throw new Error(`Container not found: ${this.config.containerId}`);
    }

    // Get references to key UI elements
    this.ui.statusIndicator = document.querySelector('[data-status-indicator]');
    this.ui.messageInput = document.querySelector('[data-message-input]');
    this.ui.sendButton = document.querySelector('[data-send-button]');
    this.ui.agentSelector = document.querySelector('[data-agent-selector]');

    // Setup event listeners
    if (this.ui.sendButton) {
      this.ui.sendButton.addEventListener('click', () => this.startExecution());
    }

    if (this.ui.messageInput) {
      this.ui.messageInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.ctrlKey) {
          this.startExecution();
        }
      });
    }

    // Setup theme toggle
    const themeToggle = document.querySelector('[data-theme-toggle]');
    if (themeToggle) {
      themeToggle.addEventListener('click', () => this.toggleTheme());
    }

    // Listen for new conversation creation
    window.addEventListener('create-new-conversation', () => this.createNewConversation());

    // Listen for conversation selection
    window.addEventListener('conversation-selected', (event) => {
      this.loadConversationMessages(event.detail.conversationId);
    });
  }

  /**
   * Connect to WebSocket
   */
  async connectWebSocket() {
    try {
      await this.wsManager.connect();
      this.updateConnectionStatus('connected');
    } catch (error) {
      console.error('WebSocket connection failed:', error);
      this.updateConnectionStatus('error');
      throw error;
    }
  }

  /**
   * Handle incoming WebSocket message
   */
  handleWebSocketMessage(data) {
    try {
      // Route by message type
      switch (data.type) {
        case 'streaming_start':
          this.handleStreamingStart(data);
          break;

        case 'streaming_progress':
          this.queueEvent(data);
          break;

        case 'streaming_complete':
          this.handleStreamingComplete(data);
          break;

        case 'file_read':
        case 'file_write':
        case 'command_execute':
        case 'git_status':
        case 'error':
        case 'text_block':
        case 'code_block':
        case 'thinking_block':
        case 'tool_use':
          this.queueEvent(data);
          break;

        case 'conversation_created':
          this.handleConversationCreated(data);
          break;

        case 'message_created':
          this.handleMessageCreated(data);
          break;

        default:
          console.log('Unhandled message type:', data.type);
      }
    } catch (error) {
      console.error('Message handling error:', error);
    }
  }

  /**
   * Queue event for rendering
   */
  queueEvent(data) {
    try {
      // Process event
      const processed = this.eventProcessor.processEvent(data);
      if (!processed) return;

      // Queue for rendering
      this.renderer.queueEvent(processed);

      // Track session events
      if (data.sessionId && this.state.currentSession?.id === data.sessionId) {
        this.state.sessionEvents.push(processed);
      }
    } catch (error) {
      console.error('Event queuing error:', error);
    }
  }

  /**
   * Handle streaming start
   */
  handleStreamingStart(data) {
    console.log('Streaming started:', data);
    this.state.isStreaming = true;
    this.state.currentSession = {
      id: data.sessionId,
      conversationId: data.conversationId,
      agentId: data.agentId,
      startTime: Date.now()
    };
    this.state.currentConversation = { id: data.conversationId };
    this.state.sessionEvents = [];

    // Auto-select the streaming conversation in the sidebar
    if (window.conversationManager) {
      window.conversationManager.select(data.conversationId);
    }

    // Load the conversation to display it in real-time
    this.loadConversationMessages(data.conversationId).then(() => {
      // Clear output and prepare for streaming
      const outputEl = document.getElementById('output');
      if (outputEl) {
        outputEl.innerHTML = '';
      }
    }).catch(err => {
      console.error('Failed to load conversation during streaming:', err);
      this.renderer.clear();
    });

    this.renderer.queueEvent({
      type: 'streaming_start',
      sessionId: data.sessionId,
      conversationId: data.conversationId,
      agentId: data.agentId,
      timestamp: data.timestamp || Date.now()
    });

    this.disableControls();
    this.emit('streaming:start', data);
  }

  /**
   * Handle streaming complete
   */
  handleStreamingComplete(data) {
    console.log('Streaming completed:', data);
    this.state.isStreaming = false;

    const duration = data.duration || (Date.now() - (this.state.currentSession?.startTime || Date.now()));

    this.renderer.queueEvent({
      type: 'streaming_complete',
      sessionId: data.sessionId,
      duration,
      timestamp: data.timestamp || Date.now()
    });

    this.enableControls();
    this.emit('streaming:complete', {
      ...data,
      duration,
      eventCount: this.state.sessionEvents.length
    });
  }

  /**
   * Handle conversation created
   */
  handleConversationCreated(data) {
    if (data.conversation) {
      this.state.conversations.push(data.conversation);
      this.emit('conversation:created', data.conversation);
    }
  }

  /**
   * Handle message created
   */
  handleMessageCreated(data) {
    // If the message is for the currently displayed conversation, append it to the output
    if (data.conversationId === this.state.currentConversation?.id && data.message) {
      const outputEl = document.querySelector('.conversation-messages');
      if (outputEl) {
        const messageHtml = `
          <div class="message message-${data.message.role}">
            <div class="message-role">${data.message.role.charAt(0).toUpperCase() + data.message.role.slice(1)}</div>
            ${this.renderMessageContent(data.message.content)}
            <div class="message-timestamp">${new Date(data.message.created_at).toLocaleString()}</div>
          </div>
        `;
        outputEl.insertAdjacentHTML('beforeend', messageHtml);
        // Scroll to bottom
        const scrollContainer = document.getElementById('output-scroll');
        if (scrollContainer) {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
        }
      }
    }
    this.emit('message:created', data);
  }

  /**
   * Parse markdown code blocks from text
   * Returns array of parts with type ('text' or 'code') and content/language/code
   */
  parseMarkdownCodeBlocks(text) {
    const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
    const parts = [];
    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(text)) !== null) {
      // Add text before the code block
      if (match.index > lastIndex) {
        parts.push({
          type: 'text',
          content: text.substring(lastIndex, match.index)
        });
      }
      // Add the code block
      parts.push({
        type: 'code',
        language: match[1] || 'plain',
        code: match[2]
      });
      lastIndex = codeBlockRegex.lastIndex;
    }

    // Add remaining text after last code block
    if (lastIndex < text.length) {
      parts.push({
        type: 'text',
        content: text.substring(lastIndex)
      });
    }

    // If no code blocks found, return the text as-is
    if (parts.length === 0) {
      return [{ type: 'text', content: text }];
    }

    return parts;
  }

  /**
   * Render a markdown code block part
   */
  renderCodeBlock(language, code) {
    if (language.toLowerCase() === 'html') {
      return `
        <div class="message-code">
          <div class="html-rendered-label mb-2 p-2 bg-blue-50 dark:bg-blue-900 rounded border border-blue-200 dark:border-blue-700 text-xs text-blue-700 dark:text-blue-300">
            Rendered HTML
          </div>
          <div class="html-content bg-white dark:bg-gray-800 p-4 rounded border border-gray-200 dark:border-gray-700 overflow-x-auto">
            ${code}
          </div>
        </div>
      `;
    } else {
      return `<div class="message-code"><pre>${this.escapeHtml(code)}</pre></div>`;
    }
  }

  /**
   * Render message content based on type
   */
  renderMessageContent(content) {
    if (typeof content === 'string') {
      return `<div class="message-text">${this.escapeHtml(content)}</div>`;
    } else if (content && typeof content === 'object' && content.type === 'claude_execution') {
      let html = '<div class="message-blocks">';
      if (content.blocks && Array.isArray(content.blocks)) {
        content.blocks.forEach(block => {
          if (block.type === 'text') {
            // Parse markdown code blocks from text
            const parts = this.parseMarkdownCodeBlocks(block.text);
            parts.forEach(part => {
              if (part.type === 'text') {
                html += `<div class="message-text">${this.escapeHtml(part.content)}</div>`;
              } else if (part.type === 'code') {
                html += this.renderCodeBlock(part.language, part.code);
              }
            });
          } else if (block.type === 'code_block') {
            // Render HTML code blocks as actual HTML elements
            if (block.language === 'html') {
              html += `
                <div class="message-code">
                  <div class="html-rendered-label mb-2 p-2 bg-blue-50 dark:bg-blue-900 rounded border border-blue-200 dark:border-blue-700 text-xs text-blue-700 dark:text-blue-300">
                    Rendered HTML
                  </div>
                  <div class="html-content bg-white dark:bg-gray-800 p-4 rounded border border-gray-200 dark:border-gray-700 overflow-x-auto">
                    ${block.code}
                  </div>
                </div>
              `;
            } else {
              html += `<div class="message-code"><pre>${this.escapeHtml(block.code)}</pre></div>`;
            }
          } else if (block.type === 'tool_use') {
            html += `<div class="message-tool">[Tool: ${this.escapeHtml(block.name)}]</div>`;
          }
        });
      }
      html += '</div>';
      return html;
    } else {
      return `<div class="message-text">${this.escapeHtml(JSON.stringify(content))}</div>`;
    }
  }

  /**
   * Start execution
   */
  async startExecution() {
    if (this.state.isStreaming) {
      this.showError('Streaming already in progress');
      return;
    }

    const prompt = this.ui.messageInput?.value || '';
    const agentId = this.ui.agentSelector?.value || 'claude-code';

    if (!prompt.trim()) {
      this.showError('Please enter a prompt');
      return;
    }

    try {
      this.disableControls();

      const response = await fetch(window.__BASE_URL + '/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId,
          title: prompt.substring(0, 50)
        })
      });

      const { conversation } = await response.json();
      this.state.currentConversation = conversation;

      // Start streaming
      await this.streamToConversation(conversation.id, prompt, agentId);
    } catch (error) {
      console.error('Execution error:', error);
      this.showError('Failed to start execution: ' + error.message);
      this.enableControls();
    }
  }

  /**
   * Stream execution to conversation
   */
  async streamToConversation(conversationId, prompt, agentId) {
    try {
      const response = await fetch(`${window.__BASE_URL}/api/conversations/${conversationId}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: prompt,
          agentId,
          skipPermissions: false
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const { session, streamId } = await response.json();

      // Subscribe to session events via WebSocket
      if (this.wsManager.isConnected) {
        this.wsManager.subscribeToSession(session.id);
      }

      this.emit('execution:started', { session, streamId });
    } catch (error) {
      console.error('Stream execution error:', error);
      this.showError('Failed to stream execution: ' + error.message);
      this.enableControls();
    }
  }

  /**
   * Load agents
   */
  async loadAgents() {
    try {
      const response = await fetch(window.__BASE_URL + '/api/agents');
      const { agents } = await response.json();
      this.state.agents = agents;

      // Populate agent selector
      if (this.ui.agentSelector) {
        this.ui.agentSelector.innerHTML = agents
          .map(agent => `<option value="${agent.id}">${agent.name}</option>`)
          .join('');
      }

      return agents;
    } catch (error) {
      console.error('Failed to load agents:', error);
      return [];
    }
  }

  /**
   * Load conversations
   */
  async loadConversations() {
    try {
      const response = await fetch(window.__BASE_URL + '/api/conversations');
      const { conversations } = await response.json();
      this.state.conversations = conversations;
      return conversations;
    } catch (error) {
      console.error('Failed to load conversations:', error);
      return [];
    }
  }

  /**
   * Update connection status UI
   */
  updateConnectionStatus(status) {
    if (this.ui.statusIndicator) {
      this.ui.statusIndicator.dataset.status = status;
      this.ui.statusIndicator.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    }
  }

  /**
   * Update metrics display
   */
  updateMetrics(metrics) {
    const metricsDisplay = document.querySelector('[data-metrics]');
    if (metricsDisplay && metrics) {
      metricsDisplay.textContent = `Batches: ${metrics.totalBatches} | Events: ${metrics.totalEvents} | Avg render: ${metrics.avgRenderTime.toFixed(2)}ms`;
    }
  }

  /**
   * Disable UI controls during streaming
   */
  disableControls() {
    if (this.ui.sendButton) this.ui.sendButton.disabled = true;
    if (this.ui.messageInput) this.ui.messageInput.disabled = true;
    if (this.ui.agentSelector) this.ui.agentSelector.disabled = true;
  }

  /**
   * Enable UI controls
   */
  enableControls() {
    if (this.ui.sendButton) this.ui.sendButton.disabled = false;
    if (this.ui.messageInput) this.ui.messageInput.disabled = false;
    if (this.ui.agentSelector) this.ui.agentSelector.disabled = false;
  }

  /**
   * Toggle theme
   */
  toggleTheme() {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  }

  /**
   * Create a new empty conversation
   */
  async createNewConversation() {
    try {
      const agentId = this.ui.agentSelector?.value || 'claude-code';
      const response = await fetch(window.__BASE_URL + '/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId,
          title: 'New Conversation'
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to create conversation: ${response.status}`);
      }

      const { conversation } = await response.json();
      this.state.currentConversation = conversation;

      // Refresh conversation list
      await this.loadConversations();

      // Clear input for next execution
      if (this.ui.messageInput) {
        this.ui.messageInput.value = '';
        this.ui.messageInput.focus();
      }
    } catch (error) {
      console.error('Failed to create new conversation:', error);
      this.showError(`Failed to create conversation: ${error.message}`);
    }
  }

  /**
   * Load and display conversation messages
   */
  async loadConversationMessages(conversationId) {
    try {
      this.state.currentConversation = { id: conversationId };

      // Fetch conversation details
      const convResponse = await fetch(window.__BASE_URL + `/api/conversations/${conversationId}`);
      const { conversation } = await convResponse.json();

      // Fetch messages
      const messagesResponse = await fetch(window.__BASE_URL + `/api/conversations/${conversationId}/messages`);
      if (!messagesResponse.ok) {
        throw new Error(`Failed to fetch messages: ${messagesResponse.status}`);
      }
      const messagesData = await messagesResponse.json();

      // Clear output and display conversation header
      const outputEl = document.getElementById('output');
      if (outputEl) {
        outputEl.innerHTML = `
          <div class="conversation-header">
            <h2>${this.escapeHtml(conversation.title || 'Conversation')}</h2>
            <p class="text-secondary">${conversation.agentType || 'unknown'} • ${new Date(conversation.created_at).toLocaleDateString()}</p>
          </div>
          <div class="conversation-messages">
            ${this.renderMessages(messagesData.messages || [])}
          </div>
        `;
      }
    } catch (error) {
      console.error('Failed to load conversation messages:', error);
      this.showError('Failed to load conversation: ' + error.message);
    }
  }

  /**
   * Render messages for display
   */
  renderMessages(messages) {
    if (messages.length === 0) {
      return '<p class="text-secondary">No messages in this conversation yet</p>';
    }

    return messages.map(msg => {
      let contentHtml = '';

      // Handle different content types
      if (typeof msg.content === 'string') {
        contentHtml = `<div class="message-text">${this.escapeHtml(msg.content)}</div>`;
      } else if (msg.content && typeof msg.content === 'object' && msg.content.type === 'claude_execution') {
        // Handle Claude execution blocks
        contentHtml = '<div class="message-blocks">';
        if (msg.content.blocks && Array.isArray(msg.content.blocks)) {
          msg.content.blocks.forEach(block => {
            if (block.type === 'text') {
              const parts = this.parseMarkdownCodeBlocks(block.text);
              parts.forEach(part => {
                if (part.type === 'text') {
                  contentHtml += `<div class="message-text">${this.escapeHtml(part.content)}</div>`;
                } else if (part.type === 'code') {
                  contentHtml += this.renderCodeBlock(part.language, part.code);
                }
              });
            } else if (block.type === 'code_block') {
              // Render HTML code blocks as actual HTML elements
              if (block.language === 'html') {
                contentHtml += `
                  <div class="message-code">
                    <div class="html-rendered-label mb-2 p-2 bg-blue-50 dark:bg-blue-900 rounded border border-blue-200 dark:border-blue-700 text-xs text-blue-700 dark:text-blue-300">
                      Rendered HTML
                    </div>
                    <div class="html-content bg-white dark:bg-gray-800 p-4 rounded border border-gray-200 dark:border-gray-700 overflow-x-auto">
                      ${block.code}
                    </div>
                  </div>
                `;
              } else {
                contentHtml += `<div class="message-code"><pre>${this.escapeHtml(block.code)}</pre></div>`;
              }
            } else if (block.type === 'tool_use') {
              contentHtml += `<div class="message-tool">[Tool: ${this.escapeHtml(block.name)}]</div>`;
            }
          });
        }
        contentHtml += '</div>';
      } else {
        contentHtml = `<div class="message-text">${this.escapeHtml(JSON.stringify(msg.content))}</div>`;
      }

      return `
        <div class="message message-${msg.role}">
          <div class="message-role">${msg.role.charAt(0).toUpperCase() + msg.role.slice(1)}</div>
          ${contentHtml}
          <div class="message-timestamp">${new Date(msg.created_at).toLocaleString()}</div>
        </div>
      `;
    }).join('');
  }

  /**
   * Escape HTML to prevent XSS
   */
  escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return text.replace(/[&<>"']/g, c => map[c]);
  }

  /**
   * Show error message
   */
  showError(message) {
    console.error(message);
    // Could display in a toast or alert
    alert(message);
  }

  /**
   * Add event listener
   */
  on(event, callback) {
    if (!this.eventHandlers[event]) {
      this.eventHandlers[event] = [];
    }
    this.eventHandlers[event].push(callback);
  }

  /**
   * Emit event
   */
  emit(event, data) {
    if (this.eventHandlers[event]) {
      this.eventHandlers[event].forEach(callback => {
        try {
          callback(data);
        } catch (error) {
          console.error(`Event handler error for ${event}:`, error);
        }
      });
    }
  }

  /**
   * Get application state
   */
  getState() {
    return { ...this.state };
  }

  /**
   * Get metrics
   */
  getMetrics() {
    return {
      renderer: this.renderer.getMetrics(),
      websocket: this.wsManager.getStatus(),
      eventProcessor: this.eventProcessor.getStats(),
      state: this.state
    };
  }

  /**
   * Cleanup resources
   */
  destroy() {
    this.renderer.destroy();
    this.wsManager.destroy();
    this.eventHandlers = {};
  }
}

// Global instance
let agentGUIClient = null;

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', async () => {
  try {
    agentGUIClient = new AgentGUIClient();
    await agentGUIClient.init();
    console.log('AgentGUI ready');
  } catch (error) {
    console.error('Failed to initialize AgentGUI:', error);
  }
});

// Export for testing
if (typeof module !== 'undefined' && module.exports) {
  module.exports = AgentGUIClient;
}
