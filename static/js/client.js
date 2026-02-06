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

      // Initialize chunk polling state
      this.chunkPollState = {
        isPolling: false,
        lastFetchTimestamp: 0,
        pollTimer: null,
        backoffDelay: 100,
        maxBackoffDelay: 400,
        abortController: null
      };

      // Initialize router state
      this.routerState = {
        currentConversationId: null,
        currentSessionId: null
      };

      // Restore state from URL on page load
      this.restoreStateFromUrl();

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
   * Router state management: restore conversation from URL
   * Format: /conversations/<conversationId>?session=<sessionId>
   */
  restoreStateFromUrl() {
    // Parse path-based URL: /conversations/<conversationId>
    const pathMatch = window.location.pathname.match(/\/conversations\/([^\/]+)$/);
    const conversationId = pathMatch ? pathMatch[1] : null;
    
    // Session ID still in query params
    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session');

    if (conversationId && this.isValidId(conversationId)) {
      this.routerState.currentConversationId = conversationId;
      if (sessionId && this.isValidId(sessionId)) {
        this.routerState.currentSessionId = sessionId;
      }
      console.log('Restoring conversation from URL:', conversationId);
      this.loadConversationMessages(conversationId);
    }
  }

  /**
   * Validate ID format to prevent XSS
   * Alphanumeric, dash, underscore only
   */
  isValidId(id) {
    if (!id || typeof id !== 'string') return false;
    return /^[a-zA-Z0-9_-]+$/.test(id) && id.length < 256;
  }

  /**
   * Update URL when conversation is selected
   * Uses History API (pushState) for clean URLs
   * Format: /conversations/<conversationId>?session=<sessionId>
   */
  updateUrlForConversation(conversationId, sessionId) {
    if (!this.isValidId(conversationId)) return;

    this.routerState.currentConversationId = conversationId;
    if (sessionId && this.isValidId(sessionId)) {
      this.routerState.currentSessionId = sessionId;
    }

    // Use path-based URL for conversation
    const basePath = window.location.pathname.replace(/\/conversations\/[^\/]+$/, '').replace(/\/$/, '');
    let url = `${basePath}/conversations/${conversationId}`;
    
    // Session ID still in query params for optional state
    if (sessionId && this.isValidId(sessionId)) {
      url += `?session=${sessionId}`;
    }
    
    window.history.pushState({ conversationId, sessionId }, '', url);
  }

  /**
   * Save scroll position to localStorage
   * Key format: scroll_<conversationId>
   */
  saveScrollPosition(conversationId) {
    if (!this.isValidId(conversationId)) return;

    const scrollContainer = document.getElementById(this.config.scrollContainerId);
    if (scrollContainer) {
      const position = scrollContainer.scrollTop;
      try {
        localStorage.setItem(`scroll_${conversationId}`, position.toString());
        console.log(`Saved scroll position for ${conversationId}: ${position}`);
      } catch (e) {
        console.warn('Failed to save scroll position:', e);
      }
    }
  }

  /**
   * Restore scroll position from localStorage
   * Restores after conversation loads
   */
  restoreScrollPosition(conversationId) {
    if (!this.isValidId(conversationId)) return;

    try {
      const position = localStorage.getItem(`scroll_${conversationId}`);
      if (position !== null) {
        const scrollTop = parseInt(position, 10);
        const scrollContainer = document.getElementById(this.config.scrollContainerId);
        if (scrollContainer && !isNaN(scrollTop)) {
          requestAnimationFrame(() => {
            scrollContainer.scrollTop = scrollTop;
            console.log(`Restored scroll position for ${conversationId}: ${scrollTop}`);
          });
        }
      }
    } catch (e) {
      console.warn('Failed to restore scroll position:', e);
    }
  }

  /**
   * Setup scroll position tracking
   * Debounced to avoid excessive localStorage writes
   */
  setupScrollTracking() {
    const scrollContainer = document.getElementById(this.config.scrollContainerId);
    if (!scrollContainer) return;

    let scrollTimer = null;
    scrollContainer.addEventListener('scroll', () => {
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        if (this.state.currentConversation?.id) {
          this.saveScrollPosition(this.state.currentConversation.id);
        }
      }, 500); // Debounce 500ms
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

      this.ui.messageInput.addEventListener('input', () => {
        const el = this.ui.messageInput;
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 150) + 'px';
      });
    }

    // Setup theme toggle
    const themeToggle = document.querySelector('[data-theme-toggle]');
    if (themeToggle) {
      themeToggle.addEventListener('click', () => this.toggleTheme());
    }

    // Setup scroll position tracking for current conversation
    this.setupScrollTracking();

    window.addEventListener('create-new-conversation', (event) => {
      const detail = event.detail || {};
      this.createNewConversation(detail.workingDirectory, detail.title);
    });

    // Listen for conversation selection
    window.addEventListener('conversation-selected', (event) => {
      const conversationId = event.detail.conversationId;
      this.updateUrlForConversation(conversationId);
      this.loadConversationMessages(conversationId);
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

  handleWebSocketMessage(data) {
    try {
      switch (data.type) {
        case 'streaming_start':
          this.handleStreamingStart(data);
          break;
        case 'streaming_progress':
          this.handleStreamingProgress(data);
          break;
        case 'streaming_complete':
          this.handleStreamingComplete(data);
          break;
        case 'streaming_error':
          this.handleStreamingError(data);
          break;
        case 'conversation_created':
          this.handleConversationCreated(data);
          break;
        case 'message_created':
          this.handleMessageCreated(data);
          break;
        case 'queue_status':
          this.handleQueueStatus(data);
          break;
        default:
          break;
      }
    } catch (error) {
      console.error('Message handling error:', error);
    }
  }

  queueEvent(data) {
    try {
      const processed = this.eventProcessor.processEvent(data);
      if (!processed) return;
      if (data.sessionId && this.state.currentSession?.id === data.sessionId) {
        this.state.sessionEvents.push(processed);
      }
    } catch (error) {
      console.error('Event queuing error:', error);
    }
  }

  handleStreamingStart(data) {
    console.log('Streaming started:', data);
    this.state.isStreaming = true;
    this.state.currentSession = {
      id: data.sessionId,
      conversationId: data.conversationId,
      agentId: data.agentId,
      startTime: Date.now()
    };
    this.state.sessionEvents = [];
    this.state.streamingBlocks = [];

    // Update URL with session ID during streaming
    this.updateUrlForConversation(data.conversationId, data.sessionId);

    if (this.wsManager.isConnected) {
      this.wsManager.subscribeToSession(data.sessionId);
    }

    const outputEl = document.getElementById('output');
    if (outputEl) {
      let messagesEl = outputEl.querySelector('.conversation-messages');
      if (!messagesEl) {
        outputEl.innerHTML = '<div class="conversation-messages"></div>';
        messagesEl = outputEl.querySelector('.conversation-messages');
      }
      const streamingDiv = document.createElement('div');
      streamingDiv.className = 'message message-assistant streaming-message';
      streamingDiv.id = `streaming-${data.sessionId}`;
      streamingDiv.innerHTML = `
        <div class="message-role">Assistant</div>
        <div class="message-blocks streaming-blocks"></div>
        <div class="streaming-indicator" style="display:flex;align-items:center;gap:0.5rem;padding:0.5rem 0;color:var(--color-text-secondary);font-size:0.875rem;">
          <span class="animate-spin" style="display:inline-block;width:1rem;height:1rem;border:2px solid var(--color-border);border-top-color:var(--color-primary);border-radius:50%;"></span>
          <span class="streaming-indicator-label">Thinking...</span>
        </div>
      `;
      messagesEl.appendChild(streamingDiv);
      this.scrollToBottom();
    }

    // Start polling for chunks from database
    this.startChunkPolling(data.conversationId);

    this.disableControls();
    this.emit('streaming:start', data);
  }

  handleStreamingProgress(data) {
    // NOTE: With chunk-based architecture, blocks are rendered from polling
    // This handler is kept for backward compatibility and to trigger polling updates
    // But actual rendering happens in renderChunk() via polling

    if (!data.block) return;

    const block = data.block;
    if (!this.state.streamingBlocks) this.state.streamingBlocks = [];
    this.state.streamingBlocks.push(block);

    // WebSocket is now just a notification trigger, not data source
    // Actual blocks come from database polling in startChunkPolling()
  }

  renderBlockContent(block) {
    if (block.type === 'text' && block.text) {
      const text = block.text;
      if (this.isHtmlContent(text)) {
        return `<div class="html-content bg-white dark:bg-gray-800 p-4 rounded border border-gray-200 dark:border-gray-700 overflow-x-auto">${text}</div>`;
      }
      const parts = this.parseMarkdownCodeBlocks(text);
      if (parts.length === 1 && parts[0].type === 'text') {
        return this.escapeHtml(text);
      }
      return parts.map(part => {
        if (part.type === 'html') {
          return `<div class="html-content bg-white dark:bg-gray-800 p-4 rounded border border-gray-200 dark:border-gray-700 overflow-x-auto">${part.content}</div>`;
        } else if (part.type === 'code') {
          return this.renderCodeBlock(part.language, part.code);
        }
        return this.escapeHtml(part.content);
      }).join('');
    }
    // Fallback for unknown block types: show formatted key-value pairs
    const fieldsHtml = Object.entries(block)
      .filter(([key]) => key !== 'type')
      .map(([key, value]) => {
        let displayValue = typeof value === 'string' ? value : JSON.stringify(value);
        if (displayValue.length > 100) displayValue = displayValue.substring(0, 100) + '...';
        return `<div style="font-size:0.75rem;margin-bottom:0.25rem"><span style="font-weight:600">${this.escapeHtml(key)}:</span> <code>${this.escapeHtml(displayValue)}</code></div>`;
      }).join('');
    return `<div style="padding:0.5rem;background:var(--color-bg-secondary);border-radius:0.375rem;border:1px solid var(--color-border)"><div style="font-size:0.7rem;font-weight:600;text-transform:uppercase;margin-bottom:0.25rem">${this.escapeHtml(block.type)}</div>${fieldsHtml}</div>`;
  }

  scrollToBottom() {
    const scrollContainer = document.getElementById('output-scroll');
    if (scrollContainer) {
      requestAnimationFrame(() => {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
      });
    }
  }

  handleStreamingError(data) {
    console.error('Streaming error:', data);
    this.state.isStreaming = false;

    const sessionId = data.sessionId || this.state.currentSession?.id;
    const streamingEl = document.getElementById(`streaming-${sessionId}`);
    if (streamingEl) {
      const indicator = streamingEl.querySelector('.streaming-indicator');
      if (indicator) {
        indicator.innerHTML = `<span style="color:var(--color-error);">Error: ${this.escapeHtml(data.error || 'Unknown error')}</span>`;
      }
    }

    this.enableControls();
    this.emit('streaming:error', data);
  }

  handleStreamingComplete(data) {
    console.log('Streaming completed:', data);
    this.state.isStreaming = false;

    // Stop polling for chunks
    this.stopChunkPolling();

    const sessionId = data.sessionId || this.state.currentSession?.id;
    const streamingEl = document.getElementById(`streaming-${sessionId}`);
    if (streamingEl) {
      const indicator = streamingEl.querySelector('.streaming-indicator');
      if (indicator) indicator.remove();
      streamingEl.classList.remove('streaming-message');
      const prevTextEl = streamingEl.querySelector('.streaming-text-current');
      if (prevTextEl) prevTextEl.classList.remove('streaming-text-current');

      const ts = document.createElement('div');
      ts.className = 'message-timestamp';
      ts.textContent = new Date().toLocaleString();
      streamingEl.appendChild(ts);
    }

    // Save scroll position after streaming completes
    const conversationId = data.conversationId || this.state.currentSession?.conversationId;
    if (conversationId) {
      this.saveScrollPosition(conversationId);
    }

    this.enableControls();
    this.emit('streaming:complete', data);
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

  handleMessageCreated(data) {
    if (data.conversationId !== this.state.currentConversation?.id || !data.message) {
      this.emit('message:created', data);
      return;
    }

    if (data.message.role === 'assistant' && this.state.isStreaming) {
      this.emit('message:created', data);
      return;
    }

    const outputEl = document.querySelector('.conversation-messages');
    if (!outputEl) {
      this.emit('message:created', data);
      return;
    }

    const messageHtml = `
      <div class="message message-${data.message.role}" data-msg-id="${data.message.id}">
        <div class="message-role">${data.message.role.charAt(0).toUpperCase() + data.message.role.slice(1)}</div>
        ${this.renderMessageContent(data.message.content)}
        <div class="message-timestamp">${new Date(data.message.created_at).toLocaleString()}</div>
      </div>
    `;
    outputEl.insertAdjacentHTML('beforeend', messageHtml);
    this.scrollToBottom();
    this.emit('message:created', data);
  }

  handleQueueStatus(data) {
    if (data.conversationId !== this.state.currentConversation?.id) return;

    const outputEl = document.querySelector('.conversation-messages');
    if (!outputEl) return;

    let queueEl = outputEl.querySelector('.queue-indicator');
    if (data.queueLength > 0) {
      if (!queueEl) {
        queueEl = document.createElement('div');
        queueEl.className = 'queue-indicator';
        queueEl.style.cssText = 'padding:0.5rem 1rem;margin:0.5rem 0;border-radius:0.375rem;background:var(--color-warning);color:#000;font-size:0.875rem;text-align:center;';
        outputEl.appendChild(queueEl);
      }
      queueEl.textContent = `${data.queueLength} message${data.queueLength > 1 ? 's' : ''} queued`;
    } else if (queueEl) {
      queueEl.remove();
    }
  }

  isHtmlContent(text) {
    const openTag = /<(?:div|table|section|article|form|ul|ol|dl|nav|header|footer|main|aside|figure|details|summary|h[1-6])\b[^>]*>/i;
    const closeTag = /<\/(?:div|table|section|article|form|ul|ol|dl|nav|header|footer|main|aside|figure|details|summary|h[1-6])>/i;
    return openTag.test(text) && closeTag.test(text);
  }

  parseMarkdownCodeBlocks(text) {
    const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
    const parts = [];
    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        const segment = text.substring(lastIndex, match.index);
        parts.push({
          type: this.isHtmlContent(segment) ? 'html' : 'text',
          content: segment
        });
      }
      parts.push({
        type: 'code',
        language: match[1] || 'plain',
        code: match[2]
      });
      lastIndex = codeBlockRegex.lastIndex;
    }

    if (lastIndex < text.length) {
      const segment = text.substring(lastIndex);
      parts.push({
        type: this.isHtmlContent(segment) ? 'html' : 'text',
        content: segment
      });
    }

    if (parts.length === 0) {
      return [{ type: this.isHtmlContent(text) ? 'html' : 'text', content: text }];
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
      if (this.isHtmlContent(content)) {
        return `<div class="message-text"><div class="html-content bg-white dark:bg-gray-800 p-4 rounded border border-gray-200 dark:border-gray-700 overflow-x-auto">${content}</div></div>`;
      }
      return `<div class="message-text">${this.escapeHtml(content)}</div>`;
    } else if (content && typeof content === 'object' && content.type === 'claude_execution') {
      let html = '<div class="message-blocks">';
      if (content.blocks && Array.isArray(content.blocks)) {
        content.blocks.forEach(block => {
          if (block.type === 'text') {
            const parts = this.parseMarkdownCodeBlocks(block.text);
            parts.forEach(part => {
              if (part.type === 'html') {
                html += `<div class="message-text"><div class="html-content bg-white dark:bg-gray-800 p-4 rounded border border-gray-200 dark:border-gray-700 overflow-x-auto">${part.content}</div></div>`;
              } else if (part.type === 'text') {
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
            let inputHtml = '';
            if (block.input && Object.keys(block.input).length > 0) {
              const inputStr = JSON.stringify(block.input, null, 2);
              inputHtml = `<details class="tool-input-details"><summary class="tool-input-summary">Input</summary><pre class="tool-input-pre">${this.escapeHtml(inputStr)}</pre></details>`;
            }
            html += `<div class="streaming-block-tool-use"><div class="tool-use-header"><span class="tool-use-icon">&#9881;</span> <span class="tool-use-name">${this.escapeHtml(block.name || 'unknown')}</span></div>${inputHtml}</div>`;
          } else if (block.type === 'tool_result') {
            const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
            const displayContent = content.length > 2000 ? content.substring(0, 2000) + '\n... (truncated)' : content;
            html += `<div class="streaming-block-tool-result${block.is_error ? ' tool-result-error' : ''}"><div class="tool-result-header">${block.is_error ? '<span class="tool-result-error-badge">Error</span>' : '<span class="tool-result-ok-badge">Result</span>'}</div><pre class="tool-result-pre">${this.escapeHtml(displayContent)}</pre></div>`;
          }
        });
      }
      html += '</div>';
      return html;
    } else {
      // Fallback for non-array content: format as key-value pairs
      if (typeof content === 'object' && content !== null) {
        const fieldsHtml = Object.entries(content)
          .map(([key, value]) => {
            let displayValue = typeof value === 'string' ? value : JSON.stringify(value);
            if (displayValue.length > 150) displayValue = displayValue.substring(0, 150) + '...';
            return `<div style="font-size:0.8rem;margin-bottom:0.375rem"><span style="font-weight:600">${this.escapeHtml(key)}:</span> <code style="background:var(--color-bg-secondary);padding:0.125rem 0.25rem;border-radius:0.25rem">${this.escapeHtml(displayValue)}</code></div>`;
          }).join('');
        return `<div class="message-text" style="background:var(--color-bg-secondary);padding:0.75rem;border-radius:0.375rem">${fieldsHtml}</div>`;
      }
      return `<div class="message-text">${this.escapeHtml(String(content))}</div>`;
    }
  }

  async startExecution() {
    const prompt = this.ui.messageInput?.value || '';
    const agentId = this.ui.agentSelector?.value || 'claude-code';

    if (!prompt.trim()) {
      this.showError('Please enter a prompt');
      return;
    }

    if (this.ui.messageInput) {
      this.ui.messageInput.value = '';
      this.ui.messageInput.style.height = 'auto';
    }

    try {
      if (this.state.currentConversation?.id) {
        await this.streamToConversation(this.state.currentConversation.id, prompt, agentId);
      } else {
        this.disableControls();
        const response = await fetch(window.__BASE_URL + '/api/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId, title: prompt.substring(0, 50) })
        });
        const { conversation } = await response.json();
        this.state.currentConversation = conversation;

        if (window.conversationManager) {
          window.conversationManager.loadConversations();
          window.conversationManager.select(conversation.id);
        }

        await this.streamToConversation(conversation.id, prompt, agentId);
      }
    } catch (error) {
      console.error('Execution error:', error);
      this.showError('Failed to start execution: ' + error.message);
      this.enableControls();
    }
  }

  async streamToConversation(conversationId, prompt, agentId) {
    try {
      if (this.wsManager.isConnected) {
        this.wsManager.sendMessage({ type: 'subscribe', conversationId });
      }

      const response = await fetch(`${window.__BASE_URL}/api/conversations/${conversationId}/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: prompt, agentId, skipPermissions: false })
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const result = await response.json();

      if (result.queued) {
        console.log('Message queued, position:', result.queuePosition);
        return;
      }

      if (result.session && this.wsManager.isConnected) {
        this.wsManager.subscribeToSession(result.session.id);
      }

      this.emit('execution:started', result);
    } catch (error) {
      console.error('Stream execution error:', error);
      this.showError('Failed to stream execution: ' + error.message);
      this.enableControls();
    }
  }

  /**
   * Fetch chunks from database for a conversation
   * Supports incremental updates with since parameter
   */
  async fetchChunks(conversationId, since = 0) {
    if (!conversationId) return [];

    try {
      const params = new URLSearchParams();
      if (since > 0) {
        params.append('since', since.toString());
      }

      const url = `${window.__BASE_URL}/api/conversations/${conversationId}/chunks?${params.toString()}`;
      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      if (!data.ok || !Array.isArray(data.chunks)) {
        throw new Error('Invalid chunks response');
      }

      // Parse JSON data field for each chunk
      const chunks = data.chunks.map(chunk => ({
        ...chunk,
        block: typeof chunk.data === 'string' ? JSON.parse(chunk.data) : chunk.data
      }));

      return chunks;
    } catch (error) {
      console.error('Error fetching chunks:', error);
      throw error;
    }
  }

  /**
   * Poll for new chunks at regular intervals
   * Uses exponential backoff on errors
   */
  async startChunkPolling(conversationId) {
    if (!conversationId) return;

    const pollState = this.chunkPollState;
    if (pollState.isPolling) return; // Already polling

    pollState.isPolling = true;
    pollState.lastFetchTimestamp = Date.now();
    pollState.backoffDelay = 100;

    console.log('Starting chunk polling for conversation:', conversationId);

    const pollOnce = async () => {
      if (!pollState.isPolling) return;

      try {
        const chunks = await this.fetchChunks(conversationId, pollState.lastFetchTimestamp);

        if (chunks.length > 0) {
          // Reset backoff on success
          pollState.backoffDelay = 100;

          // Update last fetch timestamp
          const lastChunk = chunks[chunks.length - 1];
          pollState.lastFetchTimestamp = lastChunk.created_at;

          // Render new chunks
          chunks.forEach(chunk => {
            if (chunk.block && chunk.block.type) {
              this.renderChunk(chunk);
            }
          });
        }

        // Schedule next poll
        if (pollState.isPolling) {
          pollState.pollTimer = setTimeout(pollOnce, 100);
        }
      } catch (error) {
        console.warn('Chunk poll error, applying backoff:', error.message);

        // Apply exponential backoff
        pollState.backoffDelay = Math.min(
          pollState.backoffDelay * 2,
          pollState.maxBackoffDelay
        );

        // Schedule next poll with backoff
        if (pollState.isPolling) {
          pollState.pollTimer = setTimeout(pollOnce, pollState.backoffDelay);
        }
      }
    };

    // Start polling loop
    pollOnce();
  }

  /**
   * Stop polling for chunks
   */
  stopChunkPolling() {
    const pollState = this.chunkPollState;

    if (pollState.pollTimer) {
      clearTimeout(pollState.pollTimer);
      pollState.pollTimer = null;
    }

    if (pollState.abortController) {
      pollState.abortController.abort();
      pollState.abortController = null;
    }

    pollState.isPolling = false;
    console.log('Stopped chunk polling');
  }

  /**
   * Render a single chunk to the output
   */
  renderChunk(chunk) {
    if (!chunk || !chunk.block) return;

    const sessionId = chunk.sessionId;
    const streamingEl = document.getElementById(`streaming-${sessionId}`);
    if (!streamingEl) return;

    const blocksEl = streamingEl.querySelector('.streaming-blocks');
    if (!blocksEl) return;

    const block = chunk.block;
    const element = this.renderer.renderBlock(block, chunk);

    if (element) {
      blocksEl.appendChild(element);
      this.scrollToBottom();
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
  async createNewConversation(workingDirectory, title) {
    try {
      const agentId = this.ui.agentSelector?.value || 'claude-code';
      const convTitle = title || 'New Conversation';
      const body = { agentId, title: convTitle };
      if (workingDirectory) body.workingDirectory = workingDirectory;

      const response = await fetch(window.__BASE_URL + '/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        throw new Error(`Failed to create conversation: ${response.status}`);
      }

      const { conversation } = await response.json();
      this.state.currentConversation = conversation;

      await this.loadConversations();

      if (window.conversationManager) {
        window.conversationManager.loadConversations();
        window.conversationManager.select(conversation.id);
      }

      if (this.ui.messageInput) {
        this.ui.messageInput.value = '';
        this.ui.messageInput.focus();
      }
    } catch (error) {
      console.error('Failed to create new conversation:', error);
      this.showError(`Failed to create conversation: ${error.message}`);
    }
  }

  async loadConversationMessages(conversationId) {
    try {
      const convResponse = await fetch(window.__BASE_URL + `/api/conversations/${conversationId}`);
      const { conversation } = await convResponse.json();
      this.state.currentConversation = conversation;

      // Update URL with conversation ID
      this.updateUrlForConversation(conversationId);

      if (this.wsManager.isConnected) {
        this.wsManager.sendMessage({ type: 'subscribe', conversationId });
      }

      // Try to fetch chunks first (Wave 3 architecture)
      try {
        const chunks = await this.fetchChunks(conversationId, 0);

        const outputEl = document.getElementById('output');
        if (outputEl) {
          const wdInfo = conversation.workingDirectory ? ` - ${this.escapeHtml(conversation.workingDirectory)}` : '';
          outputEl.innerHTML = `
            <div class="conversation-header">
              <h2>${this.escapeHtml(conversation.title || 'Conversation')}</h2>
              <p class="text-secondary">${conversation.agentType || 'unknown'} - ${new Date(conversation.created_at).toLocaleDateString()}${wdInfo}</p>
            </div>
            <div class="conversation-messages"></div>
          `;

          // Render all chunks
          const messagesEl = outputEl.querySelector('.conversation-messages');
          if (chunks.length > 0) {
            // Group chunks by session
            const sessionChunks = {};
            chunks.forEach(chunk => {
              if (!sessionChunks[chunk.sessionId]) {
                sessionChunks[chunk.sessionId] = [];
              }
              sessionChunks[chunk.sessionId].push(chunk);
            });

            // Render each session's chunks
            Object.entries(sessionChunks).forEach(([sessionId, sessionChunkList]) => {
              const messageDiv = document.createElement('div');
              messageDiv.className = 'message message-assistant';
              messageDiv.id = `message-${sessionId}`;
              messageDiv.innerHTML = '<div class="message-role">Assistant</div><div class="message-blocks"></div>';

              const blocksEl = messageDiv.querySelector('.message-blocks');
              sessionChunkList.forEach(chunk => {
                if (chunk.block && chunk.block.type) {
                  const element = this.renderer.renderBlock(chunk.block, chunk);
                  if (element) {
                    blocksEl.appendChild(element);
                  }
                }
              });

              const ts = document.createElement('div');
              ts.className = 'message-timestamp';
              ts.textContent = new Date(sessionChunkList[sessionChunkList.length - 1].created_at).toLocaleString();
              messageDiv.appendChild(ts);

              messagesEl.appendChild(messageDiv);
            });
          } else {
            // Fall back to messages if no chunks
            const messagesResponse = await fetch(window.__BASE_URL + `/api/conversations/${conversationId}/messages`);
            if (messagesResponse.ok) {
              const messagesData = await messagesResponse.json();
              messagesEl.innerHTML = this.renderMessages(messagesData.messages || []);
            }
          }

          // Restore scroll position after rendering
          this.restoreScrollPosition(conversationId);
        }
      } catch (chunkError) {
        console.warn('Failed to fetch chunks, falling back to messages:', chunkError);

        // Fallback: use messages
        const messagesResponse = await fetch(window.__BASE_URL + `/api/conversations/${conversationId}/messages`);
        if (!messagesResponse.ok) throw new Error(`Failed to fetch messages: ${messagesResponse.status}`);
        const messagesData = await messagesResponse.json();

        const outputEl = document.getElementById('output');
        if (outputEl) {
          const wdInfo = conversation.workingDirectory ? ` - ${this.escapeHtml(conversation.workingDirectory)}` : '';
          outputEl.innerHTML = `
            <div class="conversation-header">
              <h2>${this.escapeHtml(conversation.title || 'Conversation')}</h2>
              <p class="text-secondary">${conversation.agentType || 'unknown'} - ${new Date(conversation.created_at).toLocaleDateString()}${wdInfo}</p>
            </div>
            <div class="conversation-messages">
              ${this.renderMessages(messagesData.messages || [])}
            </div>
          `;

          // Restore scroll position after rendering
          this.restoreScrollPosition(conversationId);
        }
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

      if (typeof msg.content === 'string') {
        if (this.isHtmlContent(msg.content)) {
          contentHtml = `<div class="message-text"><div class="html-content bg-white dark:bg-gray-800 p-4 rounded border border-gray-200 dark:border-gray-700 overflow-x-auto">${msg.content}</div></div>`;
        } else {
          contentHtml = `<div class="message-text">${this.escapeHtml(msg.content)}</div>`;
        }
      } else if (msg.content && typeof msg.content === 'object' && msg.content.type === 'claude_execution') {
        contentHtml = '<div class="message-blocks">';
        if (msg.content.blocks && Array.isArray(msg.content.blocks)) {
          msg.content.blocks.forEach(block => {
            if (block.type === 'text') {
              const parts = this.parseMarkdownCodeBlocks(block.text);
              parts.forEach(part => {
                if (part.type === 'html') {
                  contentHtml += `<div class="message-text"><div class="html-content bg-white dark:bg-gray-800 p-4 rounded border border-gray-200 dark:border-gray-700 overflow-x-auto">${part.content}</div></div>`;
                } else if (part.type === 'text') {
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
              let inputHtml = '';
              if (block.input && Object.keys(block.input).length > 0) {
                const inputStr = JSON.stringify(block.input, null, 2);
                inputHtml = `<details class="tool-input-details"><summary class="tool-input-summary">Input</summary><pre class="tool-input-pre">${this.escapeHtml(inputStr)}</pre></details>`;
              }
              contentHtml += `<div class="streaming-block-tool-use"><div class="tool-use-header"><span class="tool-use-icon">&#9881;</span> <span class="tool-use-name">${this.escapeHtml(block.name || 'unknown')}</span></div>${inputHtml}</div>`;
            } else if (block.type === 'tool_result') {
              const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
              const displayContent = content.length > 2000 ? content.substring(0, 2000) + '\n... (truncated)' : content;
              contentHtml += `<div class="streaming-block-tool-result${block.is_error ? ' tool-result-error' : ''}"><div class="tool-result-header">${block.is_error ? '<span class="tool-result-error-badge">Error</span>' : '<span class="tool-result-ok-badge">Result</span>'}</div><pre class="tool-result-pre">${this.escapeHtml(displayContent)}</pre></div>`;
            }
          });
        }
        contentHtml += '</div>';
      } else {
        // Fallback for non-array msg.content: format as key-value pairs
        if (typeof msg.content === 'object' && msg.content !== null) {
          const fieldsHtml = Object.entries(msg.content)
            .map(([key, value]) => {
              let displayValue = typeof value === 'string' ? value : JSON.stringify(value);
              if (displayValue.length > 150) displayValue = displayValue.substring(0, 150) + '...';
              return `<div style="font-size:0.8rem;margin-bottom:0.375rem"><span style="font-weight:600">${this.escapeHtml(key)}:</span> <code style="background:var(--color-bg-secondary);padding:0.125rem 0.25rem;border-radius:0.25rem">${this.escapeHtml(displayValue)}</code></div>`;
            }).join('');
          contentHtml = `<div class="message-text" style="background:var(--color-bg-secondary);padding:0.75rem;border-radius:0.375rem">${fieldsHtml}</div>`;
        } else {
          contentHtml = `<div class="message-text">${this.escapeHtml(String(msg.content))}</div>`;
        }
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
    this.stopChunkPolling();
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
