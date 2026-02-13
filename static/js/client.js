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
      streamingConversations: new Map(),
      sessionEvents: [],
      conversations: [],
      agents: []
    };

    // Conversation DOM cache: store rendered DOM + scroll position per conversationId
    this.conversationCache = new Map();
    this.MAX_CACHE_SIZE = 10;

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

      // Setup UI elements (must happen before loading data so DOM refs exist)
      this.setupUI();

      // Load initial data
      await this.loadAgents();
      await this.loadConversations();

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
    if (!this.routerState) return;

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
      // Dispatch to window so other modules (conversations.js) can listen
      window.dispatchEvent(new CustomEvent('ws-message', { detail: data }));

      switch (data.type) {
        case 'streaming_start':
          this.handleStreamingStart(data).catch(e => console.error('handleStreamingStart error:', e));
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
        case 'rate_limit_hit':
          this.handleRateLimitHit(data);
          break;
        case 'rate_limit_clear':
          this.handleRateLimitClear(data);
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

  async handleStreamingStart(data) {
    console.log('Streaming started:', data);

    // If this streaming event is for a different conversation than what we are viewing,
    // just track the state but do not modify the DOM or start polling
    if (this.state.currentConversation?.id !== data.conversationId) {
      console.log('Streaming started for non-active conversation:', data.conversationId);
      this.state.streamingConversations.set(data.conversationId, true);
      this.emit('streaming:start', data);
      return;
    }

    this.state.streamingConversations.set(data.conversationId, true);
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
        const conv = this.state.currentConversation;
        const wdInfo = conv?.workingDirectory ? ` - ${this.escapeHtml(conv.workingDirectory)}` : '';
        outputEl.innerHTML = `
          <div class="conversation-header">
            <h2>${this.escapeHtml(conv?.title || 'Conversation')}</h2>
            <p class="text-secondary">${conv?.agentType || 'unknown'} - ${new Date(conv?.created_at || Date.now()).toLocaleDateString()}${wdInfo}</p>
          </div>
          <div class="conversation-messages"></div>
        `;
        messagesEl = outputEl.querySelector('.conversation-messages');
        try {
          const fullResp = await fetch(window.__BASE_URL + `/api/conversations/${data.conversationId}/full`);
          if (fullResp.ok) {
            const fullData = await fullResp.json();
            const priorChunks = (fullData.chunks || []).map(c => ({
              ...c,
              block: typeof c.data === 'string' ? JSON.parse(c.data) : c.data
            }));
            const userMsgs = (fullData.messages || []).filter(m => m.role === 'user');
            if (priorChunks.length > 0) {
              const sessionOrder = [];
              const sessionGroups = {};
              priorChunks.forEach(c => {
                if (!sessionGroups[c.sessionId]) { sessionGroups[c.sessionId] = []; sessionOrder.push(c.sessionId); }
                sessionGroups[c.sessionId].push(c);
              });
              const priorFrag = document.createDocumentFragment();
              let ui = 0;
              sessionOrder.forEach(sid => {
                const sList = sessionGroups[sid];
                const sStart = sList[0].created_at;
                while (ui < userMsgs.length && userMsgs[ui].created_at <= sStart) {
                  const m = userMsgs[ui++];
                  const uDiv = document.createElement('div');
                  uDiv.className = 'message message-user';
                  uDiv.setAttribute('data-msg-id', m.id);
                  uDiv.innerHTML = `<div class="message-role">User</div>${this.renderMessageContent(m.content)}<div class="message-timestamp">${new Date(m.created_at).toLocaleString()}</div>`;
                  priorFrag.appendChild(uDiv);
                }
                const mDiv = document.createElement('div');
                mDiv.className = 'message message-assistant';
                mDiv.id = `message-${sid}`;
                mDiv.innerHTML = '<div class="message-role">Assistant</div><div class="message-blocks streaming-blocks"></div>';
                const bEl = mDiv.querySelector('.message-blocks');
                const bFrag = document.createDocumentFragment();
                sList.forEach(chunk => { if (chunk.block?.type) { const el = this.renderer.renderBlock(chunk.block, chunk); if (el) bFrag.appendChild(el); } });
                bEl.appendChild(bFrag);
                const ts = document.createElement('div'); ts.className = 'message-timestamp'; ts.textContent = new Date(sList[sList.length - 1].created_at).toLocaleString();
                mDiv.appendChild(ts);
                priorFrag.appendChild(mDiv);
              });
              while (ui < userMsgs.length) {
                const m = userMsgs[ui++];
                const uDiv = document.createElement('div');
                uDiv.className = 'message message-user';
                uDiv.setAttribute('data-msg-id', m.id);
                uDiv.innerHTML = `<div class="message-role">User</div>${this.renderMessageContent(m.content)}<div class="message-timestamp">${new Date(m.created_at).toLocaleString()}</div>`;
                priorFrag.appendChild(uDiv);
              }
              messagesEl.appendChild(priorFrag);
            } else {
              messagesEl.appendChild(this.renderMessagesFragment(fullData.messages || []));
            }
          }
        } catch (e) {
          console.warn('Failed to load prior messages for streaming view:', e);
        }
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
        return `<div class="html-content bg-white dark:bg-gray-800 p-4 rounded border border-gray-200 dark:border-gray-700 overflow-x-auto">${this.sanitizeHtml(text)}</div>`;
      }
      const parts = this.parseMarkdownCodeBlocks(text);
      if (parts.length === 1 && parts[0].type === 'text') {
        return this.escapeHtml(text);
      }
      return parts.map(part => {
        if (part.type === 'html') {
          return `<div class="html-content bg-white dark:bg-gray-800 p-4 rounded border border-gray-200 dark:border-gray-700 overflow-x-auto">${this.sanitizeHtml(part.content)}</div>`;
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
    if (this._scrollRafPending) return;
    this._scrollRafPending = true;
    requestAnimationFrame(() => {
      this._scrollRafPending = false;
      const scrollContainer = document.getElementById('output-scroll');
      if (scrollContainer) scrollContainer.scrollTop = scrollContainer.scrollHeight;
    });
  }

  handleStreamingError(data) {
    console.error('Streaming error:', data);

    const conversationId = data.conversationId || this.state.currentSession?.conversationId;

    // If this event is for a conversation we are NOT currently viewing, just track state
    if (conversationId && this.state.currentConversation?.id !== conversationId) {
      console.log('Streaming error for non-active conversation:', conversationId);
      this.state.streamingConversations.delete(conversationId);
      this.emit('streaming:error', data);
      return;
    }

    this.state.streamingConversations.delete(conversationId);

    // Stop polling for chunks
    this.stopChunkPolling();

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

    const conversationId = data.conversationId || this.state.currentSession?.conversationId;
    if (conversationId) this.invalidateCache(conversationId);

    if (conversationId && this.state.currentConversation?.id !== conversationId) {
      console.log('Streaming completed for non-active conversation:', conversationId);
      this.state.streamingConversations.delete(conversationId);
      this.emit('streaming:complete', data);
      return;
    }

    this.state.streamingConversations.delete(conversationId);

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

    if (data.message.role === 'assistant' && this.state.streamingConversations.has(data.conversationId)) {
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

  handleRateLimitHit(data) {
    if (data.conversationId !== this.state.currentConversation?.id) return;
    this.state.streamingConversations.delete(data.conversationId);
    this.stopChunkPolling();
    this.enableControls();

    const cooldownMs = data.retryAfterMs || 60000;
    this._rateLimitSafetyTimer = setTimeout(() => {
      this.enableControls();
    }, cooldownMs + 10000);

    const sessionId = data.sessionId || this.state.currentSession?.id;
    const streamingEl = document.getElementById(`streaming-${sessionId}`);
    if (streamingEl) {
      const indicator = streamingEl.querySelector('.streaming-indicator');
      if (indicator) {
        const retrySeconds = Math.ceil(cooldownMs / 1000);
        indicator.innerHTML = `<span style="color:var(--color-warning);">Rate limited. Retrying in ${retrySeconds}s...</span>`;
        let remaining = retrySeconds;
        const countdownTimer = setInterval(() => {
          remaining--;
          if (remaining <= 0) {
            clearInterval(countdownTimer);
            indicator.innerHTML = '<span style="color:var(--color-info);">Restarting...</span>';
          } else {
            indicator.innerHTML = `<span style="color:var(--color-warning);">Rate limited. Retrying in ${remaining}s...</span>`;
          }
        }, 1000);
      }
    }
  }

  handleRateLimitClear(data) {
    if (data.conversationId !== this.state.currentConversation?.id) return;
    if (this._rateLimitSafetyTimer) {
      clearTimeout(this._rateLimitSafetyTimer);
      this._rateLimitSafetyTimer = null;
    }
    this.enableControls();
  }

  isHtmlContent(text) {
    const htmlPattern = /<(?:div|table|section|article|ul|ol|dl|nav|header|footer|main|aside|figure|details|summary|h[1-6]|p|blockquote|pre|code|span|strong|em|a|img|br|hr|li|td|tr|th|thead|tbody|tfoot)\b[^>]*>/i;
    return htmlPattern.test(text);
  }

  sanitizeHtml(html) {
    const dangerous = /<\s*\/?\s*(script|iframe|object|embed|applet|form|input|button|select|textarea)\b[^>]*>/gi;
    let cleaned = html.replace(dangerous, '');
    cleaned = cleaned.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');
    cleaned = cleaned.replace(/\s+on\w+\s*=\s*[^\s>]+/gi, '');
    cleaned = cleaned.replace(/javascript\s*:/gi, '');
    return cleaned;
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
            ${this.sanitizeHtml(code)}
          </div>
        </div>
      `;
    } else {
      const lineCount = code.split('\n').length;
      return `<div class="message-code"><details class="collapsible-code"><summary class="collapsible-code-summary">${this.escapeHtml(language)} - ${lineCount} line${lineCount !== 1 ? 's' : ''}</summary><pre style="margin:0;border-radius:0 0 0.375rem 0.375rem">${this.escapeHtml(code)}</pre></details></div>`;
    }
  }

  /**
   * Render message content based on type
   */
  renderMessageContent(content) {
    if (typeof content === 'string') {
      if (this.isHtmlContent(content)) {
        return `<div class="message-text"><div class="html-content bg-white dark:bg-gray-800 p-4 rounded border border-gray-200 dark:border-gray-700 overflow-x-auto">${this.sanitizeHtml(content)}</div></div>`;
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
                html += `<div class="message-text"><div class="html-content bg-white dark:bg-gray-800 p-4 rounded border border-gray-200 dark:border-gray-700 overflow-x-auto">${this.sanitizeHtml(part.content)}</div></div>`;
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
                    ${this.sanitizeHtml(block.code)}
                  </div>
                </div>
              `;
            } else {
              const blkLineCount = block.code.split('\n').length;
              html += `<div class="message-code"><details class="collapsible-code"><summary class="collapsible-code-summary">${this.escapeHtml(block.language || 'code')} - ${blkLineCount} line${blkLineCount !== 1 ? 's' : ''}</summary><pre style="margin:0;border-radius:0 0 0.375rem 0.375rem">${this.escapeHtml(block.code)}</pre></details></div>`;
            }
          } else if (block.type === 'tool_use') {
            let inputHtml = '';
            if (block.input && Object.keys(block.input).length > 0) {
              const inputStr = JSON.stringify(block.input, null, 2);
              inputHtml = `<div class="folded-tool-body"><pre class="tool-input-pre">${this.escapeHtml(inputStr)}</pre></div>`;
            }
            const tn = block.name || 'unknown';
            const hasRenderer = typeof StreamingRenderer !== 'undefined';
            const dName = hasRenderer ? StreamingRenderer.getToolDisplayName(tn) : tn;
            const tTitle = hasRenderer && block.input ? StreamingRenderer.getToolTitle(tn, block.input) : '';
            const iconHtml = hasRenderer && this.renderer ? `<span class="folded-tool-icon">${this.renderer.getToolIcon(tn)}</span>` : '';
            html += `<details class="folded-tool"><summary class="folded-tool-bar">${iconHtml}<span class="folded-tool-name">${this.escapeHtml(dName)}</span>${tTitle ? `<span class="folded-tool-desc">${this.escapeHtml(tTitle)}</span>` : ''}</summary>${inputHtml}</details>`;
          } else if (block.type === 'tool_result') {
            const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
            const smartHtml = typeof StreamingRenderer !== 'undefined' ? StreamingRenderer.renderSmartContentHTML(content, this.escapeHtml.bind(this)) : `<pre class="tool-result-pre">${this.escapeHtml(content.length > 2000 ? content.substring(0, 2000) + '\n... (truncated)' : content)}</pre>`;
            const resultPreview = content.length > 80 ? content.substring(0, 77).replace(/\n/g, ' ') + '...' : content.replace(/\n/g, ' ');
            const resultIcon = block.is_error
              ? '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/></svg>'
              : '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>';
            html += `<details class="folded-tool${block.is_error ? ' folded-tool-error' : ''}"><summary class="folded-tool-bar"><span class="folded-tool-icon">${resultIcon}</span><span class="folded-tool-name">${block.is_error ? 'Error' : 'Success'}</span><span class="folded-tool-desc">${this.escapeHtml(resultPreview)}</span></summary><div class="folded-tool-body">${smartHtml}</div></details>`;
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
        body: JSON.stringify({ content: prompt, agentId })
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
   * Also checks session status to detect completion
   */
  async startChunkPolling(conversationId) {
    if (!conversationId) return;

    const pollState = this.chunkPollState;
    if (pollState.isPolling) return;

    pollState.isPolling = true;
    pollState.lastFetchTimestamp = Date.now();
    pollState.backoffDelay = 150;
    pollState.sessionCheckCounter = 0;
    pollState.emptyPollCount = 0;

    const checkSessionStatus = async () => {
      if (!this.state.currentSession?.id) return false;
      const sessionResponse = await fetch(`${window.__BASE_URL}/api/sessions/${this.state.currentSession.id}`);
      if (!sessionResponse.ok) return false;
      const { session } = await sessionResponse.json();
      if (session && (session.status === 'complete' || session.status === 'error')) {
        if (session.status === 'complete') {
          this.handleStreamingComplete({ sessionId: session.id, conversationId, timestamp: Date.now() });
        } else {
          this.handleStreamingError({ sessionId: session.id, conversationId, error: session.error || 'Unknown error', timestamp: Date.now() });
        }
        return true;
      }
      return false;
    };

    const pollOnce = async () => {
      if (!pollState.isPolling) return;

      try {
        pollState.sessionCheckCounter++;
        const shouldCheckSession = pollState.sessionCheckCounter % 3 === 0 || pollState.emptyPollCount >= 3;
        if (shouldCheckSession) {
          const done = await checkSessionStatus();
          if (done) return;
          if (pollState.emptyPollCount >= 3) pollState.emptyPollCount = 0;
        }

        const chunks = await this.fetchChunks(conversationId, pollState.lastFetchTimestamp);

        if (chunks.length > 0) {
          pollState.backoffDelay = 150;
          pollState.emptyPollCount = 0;
          const lastChunk = chunks[chunks.length - 1];
          pollState.lastFetchTimestamp = lastChunk.created_at;
          this.renderChunkBatch(chunks.filter(c => c.block && c.block.type));
        } else {
          pollState.emptyPollCount++;
          pollState.backoffDelay = Math.min(pollState.backoffDelay + 50, 500);
        }

        if (pollState.isPolling) {
          pollState.pollTimer = setTimeout(pollOnce, pollState.backoffDelay);
        }
      } catch (error) {
        console.warn('Chunk poll error:', error.message);
        pollState.backoffDelay = Math.min(pollState.backoffDelay * 2, pollState.maxBackoffDelay);
        if (pollState.isPolling) {
          pollState.pollTimer = setTimeout(pollOnce, pollState.backoffDelay);
        }
      }
    };

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
  }

  /**
   * Render a single chunk to the output
   */
  renderChunk(chunk) {
    if (!chunk || !chunk.block) return;
    const streamingEl = document.getElementById(`streaming-${chunk.sessionId}`);
    if (!streamingEl) return;
    const blocksEl = streamingEl.querySelector('.streaming-blocks');
    if (!blocksEl) return;
    const element = this.renderer.renderBlock(chunk.block, chunk);
    if (element) {
      blocksEl.appendChild(element);
      this.scrollToBottom();
    }
  }

  renderChunkBatch(chunks) {
    if (!chunks.length) return;
    const groups = {};
    for (const chunk of chunks) {
      const sid = chunk.sessionId;
      if (!groups[sid]) groups[sid] = [];
      groups[sid].push(chunk);
    }
    let appended = false;
    for (const sid of Object.keys(groups)) {
      const streamingEl = document.getElementById(`streaming-${sid}`);
      if (!streamingEl) continue;
      const blocksEl = streamingEl.querySelector('.streaming-blocks');
      if (!blocksEl) continue;
      const frag = document.createDocumentFragment();
      for (const chunk of groups[sid]) {
        const el = this.renderer.renderBlock(chunk.block, chunk);
        if (el) frag.appendChild(el);
      }
      if (frag.childNodes.length) {
        blocksEl.appendChild(frag);
        appended = true;
      }
    }
    if (appended) this.scrollToBottom();
  }

  /**
   * Load agents
   */
  async loadAgents() {
    try {
      const response = await fetch(window.__BASE_URL + '/api/agents');
      const { agents } = await response.json();
      this.state.agents = agents;

      // Populate agent selector with discovered (available) agents only
      if (this.ui.agentSelector) {
        this.ui.agentSelector.innerHTML = agents
          .map(agent => `<option value="${agent.id}">${agent.name}</option>`)
          .join('');
      }

      window.dispatchEvent(new CustomEvent('agents-loaded', { detail: { agents } }));

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
    if (this.ui.agentSelector) this.ui.agentSelector.disabled = true;
  }

  /**
   * Enable UI controls
   */
  enableControls() {
    if (this.ui.sendButton) this.ui.sendButton.disabled = false;
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

  cacheCurrentConversation() {
    const convId = this.state.currentConversation?.id;
    if (!convId) return;
    const outputEl = document.getElementById('output');
    if (!outputEl || !outputEl.firstChild) return;
    if (this.state.streamingConversations.has(convId)) return;

    this.saveScrollPosition(convId);
    const clone = outputEl.cloneNode(true);
    this.conversationCache.set(convId, {
      dom: clone,
      conversation: this.state.currentConversation,
      timestamp: Date.now()
    });

    if (this.conversationCache.size > this.MAX_CACHE_SIZE) {
      const oldest = this.conversationCache.keys().next().value;
      this.conversationCache.delete(oldest);
    }
  }

  invalidateCache(conversationId) {
    this.conversationCache.delete(conversationId);
  }

  async loadConversationMessages(conversationId) {
    try {
      this.cacheCurrentConversation();
      this.stopChunkPolling();
      if (this.state.currentConversation?.id !== conversationId) {
        this.state.currentSession = null;
      }

      this.updateUrlForConversation(conversationId);
      if (this.wsManager.isConnected) {
        this.wsManager.sendMessage({ type: 'subscribe', conversationId });
      }

      const cached = this.conversationCache.get(conversationId);
      if (cached && (Date.now() - cached.timestamp) < 120000) {
        const outputEl = document.getElementById('output');
        if (outputEl) {
          outputEl.innerHTML = '';
          while (cached.dom.firstChild) {
            outputEl.appendChild(cached.dom.firstChild);
          }
          this.state.currentConversation = cached.conversation;
          this.conversationCache.delete(conversationId);
          this.restoreScrollPosition(conversationId);
          this.enableControls();
          return;
        }
      }

      this.conversationCache.delete(conversationId);

      const resp = await fetch(window.__BASE_URL + `/api/conversations/${conversationId}/full`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const { conversation, isActivelyStreaming, latestSession, chunks: rawChunks, totalChunks, messages: allMessages } = await resp.json();

      this.state.currentConversation = conversation;

      const chunks = (rawChunks || []).map(chunk => ({
        ...chunk,
        block: typeof chunk.data === 'string' ? JSON.parse(chunk.data) : chunk.data
      }));
      const userMessages = (allMessages || []).filter(m => m.role === 'user');
      const hasMoreChunks = totalChunks && chunks.length < totalChunks;

      const clientKnowsStreaming = this.state.streamingConversations.has(conversationId);
      const shouldResumeStreaming = (isActivelyStreaming || clientKnowsStreaming) && latestSession &&
        (latestSession.status === 'active' || latestSession.status === 'pending');

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

        const messagesEl = outputEl.querySelector('.conversation-messages');

        if (hasMoreChunks) {
          const loadMoreBtn = document.createElement('button');
          loadMoreBtn.className = 'btn btn-secondary';
          loadMoreBtn.style.cssText = 'width:100%;margin-bottom:1rem;padding:0.5rem;font-size:0.8rem;';
          loadMoreBtn.textContent = `Load earlier messages (${totalChunks - chunks.length} more chunks)`;
          loadMoreBtn.addEventListener('click', async () => {
            loadMoreBtn.disabled = true;
            loadMoreBtn.textContent = 'Loading...';
            try {
              const fullResp = await fetch(window.__BASE_URL + `/api/conversations/${conversationId}/full?allChunks=1`);
              if (fullResp.ok) {
                this.invalidateCache(conversationId);
                await this.loadConversationMessages(conversationId);
              }
            } catch (e) {
              loadMoreBtn.textContent = 'Failed to load. Try again.';
              loadMoreBtn.disabled = false;
            }
          });
          messagesEl.appendChild(loadMoreBtn);
        }

        if (chunks.length > 0) {
          const sessionOrder = [];
          const sessionChunks = {};
          chunks.forEach(chunk => {
            if (!sessionChunks[chunk.sessionId]) {
              sessionChunks[chunk.sessionId] = [];
              sessionOrder.push(chunk.sessionId);
            }
            sessionChunks[chunk.sessionId].push(chunk);
          });

          const frag = document.createDocumentFragment();
          let userMsgIdx = 0;

          if (hasMoreChunks && sessionOrder.length > 0) {
            const firstChunkTime = chunks[0].created_at;
            while (userMsgIdx < userMessages.length && userMessages[userMsgIdx].created_at < firstChunkTime) {
              userMsgIdx++;
            }
          }

          sessionOrder.forEach((sessionId) => {
            const sessionChunkList = sessionChunks[sessionId];
            const sessionStart = sessionChunkList[0].created_at;

            while (userMsgIdx < userMessages.length && userMessages[userMsgIdx].created_at <= sessionStart) {
              const msg = userMessages[userMsgIdx];
              const userDiv = document.createElement('div');
              userDiv.className = 'message message-user';
              userDiv.setAttribute('data-msg-id', msg.id);
              userDiv.innerHTML = `
                <div class="message-role">User</div>
                ${this.renderMessageContent(msg.content)}
                <div class="message-timestamp">${new Date(msg.created_at).toLocaleString()}</div>
              `;
              frag.appendChild(userDiv);
              userMsgIdx++;
            }

            const isCurrentActiveSession = shouldResumeStreaming && latestSession && latestSession.id === sessionId;
            const messageDiv = document.createElement('div');
            messageDiv.className = `message message-assistant${isCurrentActiveSession ? ' streaming-message' : ''}`;
            messageDiv.id = isCurrentActiveSession ? `streaming-${sessionId}` : `message-${sessionId}`;
            messageDiv.innerHTML = '<div class="message-role">Assistant</div><div class="message-blocks streaming-blocks"></div>';

            const blocksEl = messageDiv.querySelector('.message-blocks');
            const blockFrag = document.createDocumentFragment();
            sessionChunkList.forEach(chunk => {
              if (chunk.block && chunk.block.type) {
                const element = this.renderer.renderBlock(chunk.block, chunk);
                if (element) blockFrag.appendChild(element);
              }
            });
            blocksEl.appendChild(blockFrag);

            if (isCurrentActiveSession) {
              const indicatorDiv = document.createElement('div');
              indicatorDiv.className = 'streaming-indicator';
              indicatorDiv.style = 'display:flex;align-items:center;gap:0.5rem;padding:0.5rem 0;color:var(--color-text-secondary);font-size:0.875rem;';
              indicatorDiv.innerHTML = `
                <span class="animate-spin" style="display:inline-block;width:1rem;height:1rem;border:2px solid var(--color-border);border-top-color:var(--color-primary);border-radius:50%;"></span>
                <span class="streaming-indicator-label">Processing...</span>
              `;
              messageDiv.appendChild(indicatorDiv);
            } else {
              const ts = document.createElement('div');
              ts.className = 'message-timestamp';
              ts.textContent = new Date(sessionChunkList[sessionChunkList.length - 1].created_at).toLocaleString();
              messageDiv.appendChild(ts);
            }

            frag.appendChild(messageDiv);
          });

          while (userMsgIdx < userMessages.length) {
            const msg = userMessages[userMsgIdx];
            const userDiv = document.createElement('div');
            userDiv.className = 'message message-user';
            userDiv.setAttribute('data-msg-id', msg.id);
            userDiv.innerHTML = `
              <div class="message-role">User</div>
              ${this.renderMessageContent(msg.content)}
              <div class="message-timestamp">${new Date(msg.created_at).toLocaleString()}</div>
            `;
            frag.appendChild(userDiv);
            userMsgIdx++;
          }
          messagesEl.appendChild(frag);
        } else {
          messagesEl.appendChild(this.renderMessagesFragment(allMessages || []));
        }

        if (shouldResumeStreaming && latestSession) {
          this.state.streamingConversations.set(conversationId, true);
          this.state.currentSession = {
            id: latestSession.id,
            conversationId: conversationId,
            agentId: conversation.agentType || 'claude-code',
            startTime: latestSession.created_at
          };

          if (this.wsManager.isConnected) {
            this.wsManager.subscribeToSession(latestSession.id);
            this.wsManager.sendMessage({ type: 'subscribe', conversationId });
          }

          this.updateUrlForConversation(conversationId, latestSession.id);

          const lastChunkTime = chunks.length > 0
            ? chunks[chunks.length - 1].created_at
            : 0;

          this.chunkPollState.lastFetchTimestamp = lastChunkTime;
          this.startChunkPolling(conversationId);
          this.disableControls();
        }

        this.restoreScrollPosition(conversationId);
      }
    } catch (error) {
      console.error('Failed to load conversation messages:', error);
      this.showError('Failed to load conversation: ' + error.message);
    }
  }

  renderMessagesFragment(messages) {
    const frag = document.createDocumentFragment();
    if (messages.length === 0) {
      const p = document.createElement('p');
      p.className = 'text-secondary';
      p.textContent = 'No messages in this conversation yet';
      frag.appendChild(p);
      return frag;
    }
    for (const msg of messages) {
      const div = document.createElement('div');
      div.className = `message message-${msg.role}`;
      div.innerHTML = `<div class="message-role">${msg.role.charAt(0).toUpperCase() + msg.role.slice(1)}</div>${this.renderMessageContent(msg.content)}<div class="message-timestamp">${new Date(msg.created_at).toLocaleString()}</div>`;
      frag.appendChild(div);
    }
    return frag;
  }

  renderMessages(messages) {
    if (messages.length === 0) {
      return '<p class="text-secondary">No messages in this conversation yet</p>';
    }
    return messages.map(msg => `<div class="message message-${msg.role}"><div class="message-role">${msg.role.charAt(0).toUpperCase() + msg.role.slice(1)}</div>${this.renderMessageContent(msg.content)}<div class="message-timestamp">${new Date(msg.created_at).toLocaleString()}</div></div>`).join('');
  }

  /**
   * Escape HTML to prevent XSS
   */
  escapeHtml(text) {
    return window._escHtml(text);
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
