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

    // Initialize components - reuse global wsManager/wsClient if available
    this.renderer = new StreamingRenderer(config.renderer || {});
    this.wsManager = window.wsManager || new WebSocketManager(config.websocket || {});
    if (!window.wsManager) window.wsManager = this.wsManager;
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

    // Conversation list cache with TTL
    this.conversationListCache = {
      data: [],
      timestamp: 0,
      ttl: 30000 // 30 seconds
    };

    // Draft prompts per conversation
    this.draftPrompts = new Map();

    // Event handlers
    this.eventHandlers = {};

    // UI state
    this.ui = {
      statusIndicator: null,
      messageInput: null,
      sendButton: null,
      cliSelector: null,
      agentSelector: null,
      modelSelector: null
    };

    this._agentLocked = false;
    this._isLoadingConversation = false;
    this._modelCache = new Map();

    this._renderedSeqs = new Map();
    this._inflightRequests = new Map();
    this._previousConvAbort = null;

    // Background conversation cache: keeps last 50 conversations' streaming blocks in memory
    // Blocks are stored as packed msgpackr Uint8Arrays for memory efficiency
    // Map<conversationId, { packed: Uint8Array[], seqSet: Set<number>, sessionId: string }>
    this._bgCache = new Map();
    this.BG_CACHE_MAX = 50;

    // PHASE 2: Request Lifetime Tracking
    this._loadInProgress = {}; // { [conversationId]: { requestId, abortController, timestamp, prevConversationId } }
    this._currentRequestId = 0; // Auto-incrementing request counter

    // Prompt area state machine: READY | LOADING | STREAMING | QUEUED | DISABLED
    // Controls atomic transitions to prevent inconsistent UI states
    this._promptState = 'READY'; // Initial state
    this._promptStateTransitions = {
      'READY': ['LOADING', 'STREAMING', 'DISABLED'],
      'LOADING': ['READY', 'STREAMING', 'DISABLED'],
      'STREAMING': ['QUEUED', 'READY'],
      'QUEUED': ['STREAMING', 'READY'],
      'DISABLED': ['READY']
    };

    this._scrollTarget = 0;
    this._scrollAnimating = false;
    this._scrollLerpFactor = config.scrollAnimationSpeed || 0.15;


    this._serverProcessingEstimate = 2000;
    this._lastSendTime = 0;
    this._countdownTimer = null;

    // Router state
    this.routerState = {
      currentConversationId: null,
      currentSessionId: null
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

      // Initialize image loader
      if (typeof ImageLoader !== 'undefined') {
        window.imageLoader = new ImageLoader();
        console.log('Image loader initialized');
      }

      // Setup event listeners
      this.setupWebSocketListeners();
      this.setupRendererListeners();

      // Setup UI elements (must happen before loading data so DOM refs exist)
      this.setupUI();

      // Connect WebSocket before loading data (RPC requires connection)
      if (this.config.autoConnect) {
        await this.connectWebSocket();
      }

      // Load initial data
      await this.loadAgents();
      await this.loadConversations();

      // Check speech model status
      await this.checkSpeechStatus();

      // Enable controls for initial interaction
      this.enableControls();

      // Restore state from URL on page load
      this.restoreStateFromUrl();

      this.state.isInitialized = true;
      this.emit('initialized');
      this._setupDebugHooks();

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
      this._subscribeToConversationUpdates();
      // On reconnect (not initial connect), invalidate current conversation's DOM
      // cache so we fetch fresh chunks rather than serving potentially stale DOM.
      if (this.wsManager.stats.totalReconnects > 0 && this.state.currentConversation?.id) {
        this.invalidateCache(this.state.currentConversation.id);
      }
      this._recoverMissedChunks();
      this.updateSendButtonState();
      this.enablePromptArea();
      if (this.state.currentConversation?.id) {
        this.updateBusyPromptArea(this.state.currentConversation.id);
      }
      this.emit('ws:connected');
      // Check if server was updated while client was loaded - reload if version changed
      if (window.__SERVER_VERSION) {
        fetch((window.__BASE_URL || '') + '/api/version').then(r => r.json()).then(d => {
          if (d.version && d.version !== window.__SERVER_VERSION) {
            console.log(`Server updated ${window.__SERVER_VERSION} → ${d.version}, reloading`);
            window.location.reload();
          }
        }).catch(() => {});
      }
    });

    this.wsManager.on('disconnected', () => {
      console.log('WebSocket disconnected');
      this.updateConnectionStatus('disconnected');
      this.updateSendButtonState();
      this.disablePromptArea();
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
    });

    this.wsManager.on('latency_update', (data) => {
      this._updateConnectionIndicator(data.quality);
    });

    this.wsManager.on('connection_degrading', () => {
      const dot = document.querySelector('.connection-dot');
      if (dot) dot.classList.add('degrading');
    });

    this.wsManager.on('connection_recovering', () => {
      const dot = document.querySelector('.connection-dot');
      if (dot) dot.classList.remove('degrading');
    });

    // Switch to idle view when selecting non-streaming conversation
    window.addEventListener('conversation-selected', (e) => {
      const convId = e.detail.conversationId;
      // Save draft from previous conversation before switching
      this.saveDraftPrompt();

      const isStreaming = convId && this.state.streamingConversations.has(convId);
      if (!isStreaming && window.switchView) {
        window.switchView('chat');
      }

      // Restore draft for new conversation after a tick
      setTimeout(() => this.restoreDraftPrompt(convId), 0);
    });

    // Preserve controls state across tab switches
    window.addEventListener('view-switched', (e) => {
      const view = e.detail.view;
      if (view === 'chat') {
        const convId = this.state.currentConversation?.id;
        const isStreaming = convId && this.state.streamingConversations.has(convId);
        if (isStreaming) {
          this.disableControls();
        } else {
          this.enableControls();
        }
      }
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
      this._isLoadingConversation = true;
      if (window.conversationManager) {
        window.conversationManager.select(conversationId);
      } else {
        this.loadConversationMessages(conversationId).catch((err) => {
          console.warn('Failed to restore conversation from URL, loading latest instead:', err);
          // If the URL conversation doesn't exist, try loading the most recent conversation
          if (this.state.conversations && this.state.conversations.length > 0) {
            const latestConv = this.state.conversations[0];
            console.log('Loading latest conversation instead:', latestConv.id);
            return this.loadConversationMessages(latestConv.id);
          } else {
            // No conversations available - show welcome screen
            this._showWelcomeScreen();
          }
        }).finally(() => {
          this._isLoadingConversation = false;
        });
      }
    } else {
      // No conversation in URL - show welcome screen
      this._showWelcomeScreen();
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
      const scrollContainer = document.getElementById(this.config.scrollContainerId);
      if (!scrollContainer) return;
      
      if (position !== null) {
        const scrollTop = parseInt(position, 10);
        if (!isNaN(scrollTop)) {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              const maxScroll = scrollContainer.scrollHeight - scrollContainer.clientHeight;
              scrollContainer.scrollTop = Math.min(scrollTop, maxScroll);
            });
          });
        }
      } else {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            scrollContainer.scrollTop = 0;
          });
        });
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

    this._userScrolledUp = false;
    let scrollTimer = null;
    let lastScrollTop = scrollContainer.scrollTop;
    scrollContainer.addEventListener('scroll', () => {
      const distFromBottom = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;
      if (scrollContainer.scrollTop < lastScrollTop && distFromBottom > 200) {
        this._userScrolledUp = true;
      } else if (distFromBottom < 50) {
        this._userScrolledUp = false;
        this._removeNewContentPill();
      }
      lastScrollTop = scrollContainer.scrollTop;
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        if (this.state.currentConversation?.id) {
          this.saveScrollPosition(this.state.currentConversation.id);
        }
      }, 500);
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
    this.ui.cliSelector = document.querySelector('[data-cli-selector]');
    this.ui.agentSelector = document.querySelector('[data-agent-selector]');
    this.ui.modelSelector = document.querySelector('[data-model-selector]');

    // Auto-save drafts on input
    if (this.ui.messageInput) {
      this.ui.messageInput.addEventListener('input', () => {
        this.saveDraftPrompt();
      });

      // Restore draft when conversation loads
      const currentConvId = this.state.currentConversation?.id;
      if (currentConvId) {
        this.restoreDraftPrompt(currentConvId);
      }
    }

    if (this.ui.cliSelector) {
      this.ui.cliSelector.addEventListener('change', () => {
        if (!this._agentLocked) {
          this.loadSubAgentsForCli(this.ui.cliSelector.value);
          this.loadModelsForAgent(this.ui.cliSelector.value);
          this.saveAgentAndModelToConversation();
        }
      });
    }

    if (this.ui.agentSelector) {
      this.ui.agentSelector.addEventListener('change', () => {
        // Load models for parent CLI agent when sub-agent changes
        const parentAgentId = this.ui.cliSelector?.value;
        if (parentAgentId) {
          this.loadModelsForAgent(parentAgentId);
        }
        if (!this._agentLocked) {
          this.saveAgentAndModelToConversation();
        }
      });
    }

    if (this.ui.modelSelector) {
      this.ui.modelSelector.addEventListener('change', () => {
        this.saveAgentAndModelToConversation();
      });
    }

    // Setup event listeners
    if (this.ui.sendButton) {
      this.ui.sendButton.addEventListener('click', () => this.startExecution());
    }

    this.setupChatMicButton();

    this.ui.stopButton = document.getElementById('stopBtn');
    this.ui.injectButton = document.getElementById('injectBtn');
    this.ui.queueButton = document.getElementById('queueBtn');

    if (this.ui.stopButton) {
      this.ui.stopButton.addEventListener('click', async () => {
        if (!this.state.currentConversation) return;
        try {
          const data = await window.wsClient.rpc('conv.cancel', { id: this.state.currentConversation.id });
          console.log('Stop response:', data);
        } catch (err) {
          console.error('Failed to stop:', err);
        }
      });
    }

    if (this.ui.injectButton) {
      this.ui.injectButton.addEventListener('click', async () => {
        if (!this.state.currentConversation) return;
        const isStreaming = this.state.streamingConversations.has(this.state.currentConversation.id);

        if (isStreaming) {
          const message = this.ui.messageInput?.value || '';
          if (!message.trim()) {
            this.showError('Please enter a message to steer');
            return;
          }

          // Capture message and clear UI immediately (no await)
          const steerMsg = message;
          if (this.ui.messageInput) {
            this.ui.messageInput.value = '';
            this.ui.messageInput.style.height = 'auto';
          }

          // Fire RPC in background, don't await
          window.wsClient.rpc('conv.steer', { id: this.state.currentConversation.id, content: steerMsg })
            .then(data => console.log('Steer response:', data))
            .catch(err => {
              console.error('Failed to steer:', err);
              this.showError('Failed to steer: ' + err.message);
            });
        } else {
          const instructions = await window.UIDialog.prompt('Enter instructions to inject into the running agent:', '', 'Inject Instructions');
          if (!instructions) return;
          try {
            const data = await window.wsClient.rpc('conv.inject', { id: this.state.currentConversation.id, content: instructions });
            console.log('Inject response:', data);
          } catch (err) {
            console.error('Failed to inject:', err);
          }
        }
      });
    }

    if (this.ui.queueButton) {
      this.ui.queueButton.addEventListener('click', async () => {
        if (!this.state.currentConversation) return;
        const message = this.ui.messageInput?.value || '';
        if (!message.trim()) {
          this.showError('Please enter a message to queue');
          return;
        }
        try {
          // Queue uses msg.send which will enqueue if streaming is active
          const data = await window.wsClient.rpc('msg.send', { id: this.state.currentConversation.id, content: message });
          console.log('Queue response:', data);
          if (this.ui.messageInput) {
            this.ui.messageInput.value = '';
            this.ui.messageInput.style.height = 'auto';
          }
        } catch (err) {
          console.error('Failed to queue:', err);
          this.showError('Failed to queue: ' + err.message);
        }
      });
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
      this.unlockAgentAndModel();
      const detail = event.detail || {};
      this.createNewConversation(detail.workingDirectory, detail.title);
    });

    window.addEventListener('preparing-new-conversation', () => {
      this.unlockAgentAndModel();
    });

    // Listen for conversation selection
    window.addEventListener('conversation-selected', async (event) => {
      const conversationId = event.detail.conversationId;
      this.updateUrlForConversation(conversationId);
      this._isLoadingConversation = true;
      try {
        await this.loadConversationMessages(conversationId);
      } finally {
        this._isLoadingConversation = false;
      }
    });

    // Listen for active conversation deletion
    window.addEventListener('conversation-deselected', () => {
      window.ConversationState?.clear('deselected');
      this.state.currentConversation = null;
      this.state.currentSession = null;
      this.updateUrlForConversation(null);
      this.enableControls();
      this._showWelcomeScreen();
      if (this.ui.messageInput) {
        this.ui.messageInput.value = '';
        this.ui.messageInput.style.height = 'auto';
      }
      this.unlockAgentAndModel();
    });
  }

  setupChatMicButton() {
    const chatMicBtn = document.getElementById('chatMicBtn');
    if (!chatMicBtn) return;

    let isRecording = false;

    const startRecording = async () => {
      if (isRecording) return;
      isRecording = true;
      chatMicBtn.classList.add('recording');
      const result = await window.STTHandler.startRecording();
      if (!result.success) {
        isRecording = false;
        chatMicBtn.classList.remove('recording');
        alert('Microphone access denied: ' + result.error);
      }
    };

    const stopRecording = async () => {
      if (!isRecording) return;
      isRecording = false;
      chatMicBtn.classList.remove('recording');
      const result = await window.STTHandler.stopRecording();
      if (result.success) {
        if (this.ui.messageInput) {
          this.ui.messageInput.value = result.text;
        }
      } else {
        alert('Transcription failed: ' + result.error);
      }
    };

    chatMicBtn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      startRecording();
    });

    chatMicBtn.addEventListener('mouseup', (e) => {
      e.preventDefault();
      stopRecording();
    });

    chatMicBtn.addEventListener('mouseleave', (e) => {
      if (isRecording) {
        stopRecording();
      }
    });

    chatMicBtn.addEventListener('touchstart', (e) => {
      e.preventDefault();
      startRecording();
    });

    chatMicBtn.addEventListener('touchend', (e) => {
      e.preventDefault();
      stopRecording();
    });

    chatMicBtn.addEventListener('touchcancel', (e) => {
      if (isRecording) {
        stopRecording();
      }
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
          window.syncDebugger?.logEvent('streaming_start', data);
          this.handleStreamingStart(data).catch(e => console.error('handleStreamingStart error:', e));
          break;
        case 'streaming_resumed':
          window.syncDebugger?.logEvent('streaming_resumed', data);
          this.handleStreamingResumed(data).catch(e => console.error('handleStreamingResumed error:', e));
          break;
        case 'streaming_progress':
          window.syncDebugger?.logEvent('streaming_progress', { sessionId: data.sessionId });
          this.handleStreamingProgress(data);
          break;
        case 'streaming_complete':
          window.syncDebugger?.logEvent('streaming_complete', data);
          this.handleStreamingComplete(data);
          break;
        case 'streaming_error':
          window.syncDebugger?.logEvent('streaming_error', data);
          this.handleStreamingError(data);
          break;
        case 'conversation_created':
          this.handleConversationCreated(data);
          break;
        case 'all_conversations_deleted':
          this.handleAllConversationsDeleted(data);
          break;
        case 'message_created':
          window.syncDebugger?.logEvent('message_created', data);
          this.handleMessageCreated(data);
          break;
        case 'conversation_updated':
          window.syncDebugger?.logEvent('conversation_updated', data);
          this.handleConversationUpdated(data);
          break;
        case 'queue_status':
          this.handleQueueStatus(data);
          break;
        case 'queue_updated':
          this.handleQueueUpdated(data);
          break;
        case 'queue_item_dequeued':
          this.handleQueueItemDequeued(data);
          break;
        case 'rate_limit_hit':
          this.handleRateLimitHit(data);
          break;
        case 'rate_limit_clear':
          this.handleRateLimitClear(data);
          break;
        case 'model_download_progress':
          this._handleModelDownloadProgress(data.progress || data);
          break;
        case 'tts_setup_progress':
          this._handleTTSSetupProgress(data);
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
    this._clearThinkingCountdown();
    if (this._lastSendTime > 0) {
      const actual = Date.now() - this._lastSendTime;
      const predicted = this.wsManager?.latency?.predicted || 0;
      const serverTime = Math.max(500, actual - predicted);
      this._serverProcessingEstimate = 0.7 * this._serverProcessingEstimate + 0.3 * serverTime;
    }

    // Subscribe to the session so blocks are not lost, but skip conversation
    // re-subscribe when resumed=true to prevent infinite loop (server sends
    // streaming_start on subscribe when activeExecutions exists, which would
    // trigger another subscribe here, looping forever)
    if (this.wsManager.isConnected) {
      this.wsManager.subscribeToSession(data.sessionId);
      if (!data.resumed) {
        this.wsManager.sendMessage({ type: 'subscribe', conversationId: data.conversationId });
      }
    }

    // If this streaming event is for a different conversation than what we are viewing,
    // just track the state but do not modify the DOM or start polling
    if (this.state.currentConversation?.id !== data.conversationId) {
      console.log('Streaming started for non-active conversation:', data.conversationId);
      this.state.streamingConversations.set(data.conversationId, true);
      console.log('[SYNC] streaming_start - non-active conv:', { convId: data.conversationId, sessionId: data.sessionId, streamingCount: this.state.streamingConversations.size });
      this.updateBusyPromptArea(data.conversationId);
      this.emit('streaming:start', data);

      // Auto-load if no conversation is currently selected (e.g. server resumed on startup)
      if (!this.state.currentConversation && !this._isLoadingConversation) {
        this._isLoadingConversation = true;
        this.loadConversationMessages(data.conversationId).finally(() => {
          this._isLoadingConversation = false;
        });
      }
      return;
    }

    this.state.streamingConversations.set(data.conversationId, true);
    this.updateBusyPromptArea(data.conversationId);
    this.state.currentSession = {
      id: data.sessionId,
      conversationId: data.conversationId,
      agentId: data.agentId,
      startTime: Date.now()
    };
    this.state.sessionEvents = [];

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
        const wdInfo = conv?.workingDirectory ? `${this.escapeHtml(conv.workingDirectory)}` : '';
        const timestamp = new Date(conv?.created_at || Date.now()).toLocaleDateString();
        const metaParts = [timestamp];
        if (wdInfo) metaParts.push(wdInfo);
        outputEl.innerHTML = `
          <div class="conversation-header">
            <h2>${this.escapeHtml(conv?.title || 'Conversation')}</h2>
            <p class="text-secondary">${metaParts.join(' - ')}</p>
          </div>
          <div class="conversation-messages"></div>
        `;
        messagesEl = outputEl.querySelector('.conversation-messages');
        try {
          const fullData = await window.wsClient.rpc('conv.full', { id: data.conversationId });
          if (fullData) {
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
                sList.forEach(chunk => {
                  if (!chunk.block?.type) return;
                  if (chunk.block.type === 'tool_result') {
                    const lastInFrag = bFrag.lastElementChild;
                    if (lastInFrag?.classList?.contains('block-tool-use')) {
                      lastInFrag.classList.remove('has-success', 'has-error');
                      lastInFrag.classList.add(chunk.block.is_error ? 'has-error' : 'has-success');
                      const parentIsOpen = lastInFrag.hasAttribute('open');
                      const contextWithParent = { ...chunk, parentIsOpen };
                      const el = this.renderer.renderBlock(chunk.block, contextWithParent, bFrag);
                      if (el) { lastInFrag.appendChild(el); }
                      return;
                    }
                  }
                  const el = this.renderer.renderBlock(chunk.block, chunk, bFrag);
                  if (!el) return;
                  bFrag.appendChild(el);
                });
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
      let streamingDiv = document.getElementById(`streaming-${data.sessionId}`);
      if (!streamingDiv) {
        streamingDiv = document.createElement('div');
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
      } else {
        // Reuse existing div - ensure streaming class and single indicator
        streamingDiv.classList.add('streaming-message');
        streamingDiv.querySelectorAll('.streaming-indicator').forEach(ind => ind.remove());
        const indDiv = document.createElement('div');
        indDiv.className = 'streaming-indicator';
        indDiv.style = 'display:flex;align-items:center;gap:0.5rem;padding:0.5rem 0;color:var(--color-text-secondary);font-size:0.875rem;';
        indDiv.innerHTML = `<span class="animate-spin" style="display:inline-block;width:1rem;height:1rem;border:2px solid var(--color-border);border-top-color:var(--color-primary);border-radius:50%;"></span><span class="streaming-indicator-label">Thinking...</span>`;
        streamingDiv.appendChild(indDiv);
      }
      this.scrollToBottom(true);
    }

    // Reset rendered block seq tracker for this session
    this._renderedSeqs = this._renderedSeqs || {};
    this._renderedSeqs[data.sessionId] = new Set();

    // Show queue/steer UI when streaming starts (for busy prompt)
    this.showStreamingPromptButtons();

    // IMMUTABLE: Prompt area remains enabled - user can queue/steer messages
    this.emit('streaming:start', data);
  }

  async handleStreamingResumed(data) {
    console.log('Streaming resumed:', data);
    const conv = this.state.currentConversation || { id: data.conversationId };
    await this.handleStreamingStart({
      type: 'streaming_start',
      sessionId: data.sessionId,
      conversationId: data.conversationId,
      agentId: conv.agentType || conv.agentId || 'claude-code',
      resumed: true,
      timestamp: data.timestamp
    });
  }

  handleStreamingProgress(data) {
    if (!data.block || !data.sessionId) return;

    // Deduplicate by seq number to guarantee exactly-once rendering
    this._renderedSeqs = this._renderedSeqs || {};
    const seen = this._renderedSeqs[data.sessionId] || (this._renderedSeqs[data.sessionId] = new Set());
    if (data.seq !== undefined) {
      if (seen.has(data.seq)) return;
      seen.add(data.seq);
    }

    const block = data.block;

    // Cache block for background conversations (all 50 cached convs, not just active)
    const convId = data.conversationId;
    if (convId) {
      let entry = this._bgCache.get(convId);
      if (!entry) {
        // Evict oldest if at capacity
        if (this._bgCache.size >= this.BG_CACHE_MAX) {
          const oldestKey = this._bgCache.keys().next().value;
          this._bgCache.delete(oldestKey);
        }
        entry = { items: [], seqSet: new Set(), sessionId: data.sessionId };
        this._bgCache.set(convId, entry);
      }
      if (data.seq === undefined || !entry.seqSet.has(data.seq)) {
        if (data.seq !== undefined) entry.seqSet.add(data.seq);
        entry.sessionId = data.sessionId;
        // Store seq alongside packed data so _flushBgCache can dedup against _renderedSeqs
        try {
          const packed = typeof msgpackr !== 'undefined' ? msgpackr.pack(block) : block;
          entry.items.push({ seq: data.seq, packed });
        } catch (_) { entry.items.push({ seq: data.seq, packed: block }); }
      }
    }

    // Only render for the currently-visible session
    if (this.state.currentSession?.id !== data.sessionId) return;

    const streamingEl = document.getElementById(`streaming-${data.sessionId}`);
    if (!streamingEl) return;
    const blocksEl = streamingEl.querySelector('.streaming-blocks');
    if (!blocksEl) return;

    const el = this.renderer.renderBlock(block, data, blocksEl);
    if (el) {
      blocksEl.appendChild(el);
      this.scrollToBottom();
    }
  }

  renderBlockContent(block) {
    if (block.type === 'text' && block.text) {
      const text = block.text;
      if (this.isHtmlContent(text)) {
        return `<div class="html-content">${this.sanitizeHtml(text)}</div>`;
      }
      const parts = this.parseMarkdownCodeBlocks(text);
      if (parts.length === 1 && parts[0].type === 'text') {
        return this.escapeHtml(text);
      }
      return parts.map(part => {
        if (part.type === 'html') {
          return `<div class="html-content">${this.sanitizeHtml(part.content)}</div>`;
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

  scrollToBottom(force = false) {
    const scrollContainer = document.getElementById('output-scroll');
    if (!scrollContainer) return;
    const distFromBottom = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight;

    if (this._userScrolledUp && !force) {
      this._unseenCount = (this._unseenCount || 0) + 1;
      this._showNewContentPill();
      return;
    }

    if (!force && distFromBottom > 150) {
      this._unseenCount = (this._unseenCount || 0) + 1;
      this._showNewContentPill();
      return;
    }

    scrollContainer.scrollTop = scrollContainer.scrollHeight;
    this._removeNewContentPill();
    this._scrollAnimating = false;
  }

  _showNewContentPill() {
    let pill = document.getElementById('new-content-pill');
    const scrollContainer = document.getElementById('output-scroll');
    if (!scrollContainer) return;
    if (!pill) {
      pill = document.createElement('button');
      pill.id = 'new-content-pill';
      pill.className = 'new-content-pill';
      pill.addEventListener('click', () => {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
        this._removeNewContentPill();
      });
      scrollContainer.appendChild(pill);
    }
    pill.textContent = (this._unseenCount || 1) + ' new';
  }

  _removeNewContentPill() {
    this._unseenCount = 0;
    const pill = document.getElementById('new-content-pill');
    if (pill) pill.remove();
  }

  handleStreamingError(data) {
    console.error('Streaming error:', data);
    this._clearThinkingCountdown();

    // Hide stop and inject buttons on error
    if (this.ui.stopButton) this.ui.stopButton.classList.remove('visible');
    if (this.ui.injectButton) this.ui.injectButton.classList.remove('visible');
    if (this.ui.sendButton) this.ui.sendButton.style.display = '';

    const conversationId = data.conversationId || this.state.currentSession?.conversationId;

    // If this event is for a conversation we are NOT currently viewing, just track state
    if (conversationId && this.state.currentConversation?.id !== conversationId) {
      console.log('Streaming error for non-active conversation:', conversationId);
      this.state.streamingConversations.delete(conversationId);
      this.updateBusyPromptArea(conversationId);
      this.emit('streaming:error', data);
      return;
    }

    this.state.streamingConversations.delete(conversationId);
    this.updateBusyPromptArea(conversationId);

    // Clear queue indicator on error
    const queueEl = document.querySelector('.queue-indicator');
    if (queueEl) queueEl.remove();

    // If this is a premature ACP end, render distinct warning block
    if (data.isPrematureEnd) {
      this.renderer.queueEvent({
        type: 'streaming_error',
        isPrematureEnd: true,
        exitCode: data.exitCode,
        error: data.error,
        stderrText: data.stderrText,
        sessionId: data.sessionId,
        conversationId: data.conversationId,
        timestamp: data.timestamp || Date.now()
      });
    }

    const sessionId = data.sessionId || this.state.currentSession?.id;

    // Remove all orphaned streaming indicators (handles case where session never started)
    const outputEl2 = document.getElementById('output');
    if (outputEl2) {
      outputEl2.querySelectorAll('.streaming-indicator').forEach(ind => {
        ind.innerHTML = `<span style="color:var(--color-error);">Error: ${this.escapeHtml(data.error || 'Unknown error')}</span>`;
      });
    }

    const streamingEl = document.getElementById(`streaming-${sessionId}`);
    if (streamingEl) {
      streamingEl.classList.remove('streaming-message');
      const indicator = streamingEl.querySelector('.streaming-indicator');
      if (indicator) {
        indicator.innerHTML = `<span style="color:var(--color-error);">Error: ${this.escapeHtml(data.error || 'Unknown error')}</span>`;
      }
      // Remove all thinking blocks on error
      streamingEl.querySelectorAll('.block-thinking').forEach(block => block.remove());
    } else {
      const outputEl3 = document.getElementById('output');
      const messagesEl3 = outputEl3 && outputEl3.querySelector('.conversation-messages');
      if (messagesEl3 && data.error) {
        const errDiv = document.createElement('div');
        errDiv.className = 'message';
        errDiv.style = 'padding:0.75rem;border:1px solid var(--color-error, #e53e3e);border-radius:4px;margin:0.5rem 0;';
        errDiv.innerHTML = `<span style="color:var(--color-error, #e53e3e);">Error: ${this.escapeHtml(data.error)}</span>`;
        messagesEl3.appendChild(errDiv);
      }
    }

    this.unlockAgentAndModel();
    this.enableControls();
    this.emit('streaming:error', data);
  }

  handleStreamingComplete(data) {
    console.log('Streaming completed:', data);
    this._clearThinkingCountdown();

    const conversationId = data.conversationId || this.state.currentSession?.conversationId;
    if (conversationId) this.invalidateCache(conversationId);

    if (conversationId && this.state.currentConversation?.id !== conversationId) {
      console.log('Streaming completed for non-active conversation:', conversationId);
      this.state.streamingConversations.delete(conversationId);
      console.log('[SYNC] streaming_complete - non-active conv:', { convId: conversationId, streamingCount: this.state.streamingConversations.size });
      this.updateBusyPromptArea(conversationId);
      this.emit('streaming:complete', data);
      return;
    }

    this.state.streamingConversations.delete(conversationId);
    console.log('[SYNC] streaming_complete - active conv:', { convId: conversationId, streamingCount: this.state.streamingConversations.size, interrupted: data.interrupted });
    this.updateBusyPromptArea(conversationId);

    const sessionId = data.sessionId || this.state.currentSession?.id;

    // Unsubscribe from session to prevent subscription leak
    if (sessionId && this.wsManager) {
      try {
        this.wsManager.unsubscribeFromSession(sessionId);
      } catch (e) {
        // Session may not exist, ignore
      }
    }

    // Clear queue indicator when streaming completes
    const queueEl = document.querySelector('.queue-indicator');
    if (queueEl) queueEl.remove();

    // Remove ALL streaming indicators from the entire messages container
    const outputEl2 = document.getElementById('output');
    if (outputEl2) {
      outputEl2.querySelectorAll('.streaming-indicator').forEach(ind => ind.remove());
      // Remove session start/complete blocks that clutter the chat
      outputEl2.querySelectorAll('.event-streaming-start, .event-streaming-complete').forEach(block => block.remove());
    }
    const streamingEl = document.getElementById(`streaming-${sessionId}`);
    if (streamingEl) {
      streamingEl.classList.remove('streaming-message');
      const prevTextEl = streamingEl.querySelector('.streaming-text-current');
      if (prevTextEl) prevTextEl.classList.remove('streaming-text-current');

      // Remove all thinking blocks (block-thinking elements)
      streamingEl.querySelectorAll('.block-thinking').forEach(block => block.remove());

      const ts = document.createElement('div');
      ts.className = 'message-timestamp';
      ts.textContent = new Date().toLocaleString();
      streamingEl.appendChild(ts);
    }

    if (conversationId) {
      this.saveScrollPosition(conversationId);
    }

    // Recover any blocks missed during streaming (e.g. WS reconnects)
    this._recoverMissedChunks().catch(err => {
      console.warn('Chunk recovery failed:', err.message);
    });

    this.enableControls();
    this.emit('streaming:complete', data);

    this._promptPushIfWeOwnRemote();
  }

  async _promptPushIfWeOwnRemote() {
    try {
      const { ownsRemote, hasChanges, hasUnpushed, remoteUrl } = await window.wsClient.rpc('git.check');
      if (ownsRemote && (hasChanges || hasUnpushed)) {
        const conv = this.state.currentConversation;
        if (conv) {
          this.streamToConversation(conv.id, 'Push the changes to the remote repository.', conv.agentId);
        }
      }
    } catch (e) {
      console.warn('Auto-push check failed:', e);
    }
  }

  /**
   * Handle conversation created
   */
  handleConversationCreated(data) {
    if (data.conversation) {
      if (this.state.conversations.some(c => c.id === data.conversation.id)) {
        return;
      }
      this.state.conversations.push(data.conversation);
      this.emit('conversation:created', data.conversation);
    }
  }

  handleMessageCreated(data) {
    if (data.conversationId !== this.state.currentConversation?.id || !data.message) {
      this.emit('message:created', data);
      return;
    }

    console.log('[SYNC] message_created:', { msgId: data.message.id, role: data.message.role, convId: data.conversationId });

    // Update messageCount in current conversation state for user messages
    if (data.message.role === 'user' && this.state.currentConversation) {
      this.state.currentConversation.messageCount = (this.state.currentConversation.messageCount || 0) + 1;
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

    if (data.message.role === 'user') {
      // Find pending message by matching content to avoid duplicates
      const pending = outputEl.querySelector('.message-sending');
      if (pending) {
        pending.id = '';
        pending.setAttribute('data-msg-id', data.message.id);
        pending.classList.remove('message-sending');
        const ts = pending.querySelector('.message-timestamp');
        if (ts) {
          ts.style.opacity = '1';
          ts.textContent = new Date(data.message.created_at).toLocaleString();
        }
        this.emit('message:created', data);
        return;
      }
      // Also check for pending ID (in case message-sending was already removed by _confirmOptimisticMessage)
      const pendingById = outputEl.querySelector('[id^="pending-"]');
      if (pendingById) {
        pendingById.id = '';
        pendingById.setAttribute('data-msg-id', data.message.id);
        const ts = pendingById.querySelector('.message-timestamp');
        if (ts) {
          ts.style.opacity = '1';
          ts.textContent = new Date(data.message.created_at).toLocaleString();
        }
        this.emit('message:created', data);
        return;
      }
      // Check if a user message with this ID already exists (prevents duplicate on race condition)
      const existingMsg = outputEl.querySelector(`[data-msg-id="${data.message.id}"]`);
      if (existingMsg) {
        this.emit('message:created', data);
        return;
      }
    }

    outputEl.querySelectorAll('p.text-secondary').forEach(p => p.remove());
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

  handleConversationUpdated(data) {
    // Update current conversation metadata if this is the active conversation
    if (data.conversation && data.conversation.id === this.state.currentConversation?.id) {
      this.state.currentConversation = data.conversation;
    }
    // Emit event for sidebar/other listeners
    this.emit('conversation:updated', data);
  }

  handleQueueStatus(data) {
    if (data.conversationId !== this.state.currentConversation?.id) return;
    this.fetchAndRenderQueue(data.conversationId);
  }

  handleQueueUpdated(data) {
    if (data.conversationId !== this.state.currentConversation?.id) return;
    this.fetchAndRenderQueue(data.conversationId);
  }

  handleQueueItemDequeued(data) {
    if (data.conversationId !== this.state.currentConversation?.id) return;
    // Item was dequeued and execution started - remove from queue indicator
    // and update queue display
    this.fetchAndRenderQueue(data.conversationId);
  }

  async fetchAndRenderQueue(conversationId) {
    const outputEl = document.querySelector('.conversation-messages');
    if (!outputEl) return;

    try {
      const { queue } = await window.wsClient.rpc('q.ls', { id: conversationId });

      let queueEl = outputEl.querySelector('.queue-indicator');
      if (!queue || queue.length === 0) {
        if (queueEl) queueEl.remove();
        return;
      }

      if (!queueEl) {
        queueEl = document.createElement('div');
        queueEl.className = 'queue-indicator';
        outputEl.appendChild(queueEl);
      }

      const isStreaming = this.state.streamingConversations.has(conversationId);
      queueEl.innerHTML = queue.map((q, i) => `
        <div class="queue-item" data-message-id="${q.messageId}" style="padding:0.5rem 1rem;margin:0.5rem 0;border-radius:0.375rem;background:var(--color-warning);color:#000;font-size:0.875rem;display:flex;align-items:center;gap:0.5rem;">
          <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${i + 1}. ${this.escapeHtml(q.content)}</span>
          ${isStreaming ? `<button class="queue-steer-btn" data-index="${i}" style="padding:0.25rem 0.5rem;background:#06b6d4;border:1px solid #0891b2;border-radius:0.25rem;cursor:pointer;font-size:0.75rem;color:#fff;">Steer</button>` : ''}
          <button class="queue-edit-btn" data-index="${i}" style="padding:0.25rem 0.5rem;background:transparent;border:1px solid #000;border-radius:0.25rem;cursor:pointer;font-size:0.75rem;">Edit</button>
          <button class="queue-delete-btn" data-index="${i}" style="padding:0.25rem 0.5rem;background:transparent;border:1px solid #000;border-radius:0.25rem;cursor:pointer;font-size:0.75rem;">Delete</button>
        </div>
      `).join('');

      if (!queueEl._listenersAttached) {
        queueEl._listenersAttached = true;
        queueEl.addEventListener('click', async (e) => {
          if (e.target.classList.contains('queue-steer-btn')) {
            const index = parseInt(e.target.dataset.index);
            const q = queue[index];
            try {
              const data = await window.wsClient.rpc('conv.steer', { id: conversationId, content: q.content });
              console.log('Steer response:', data);
              if (data.ok && data.steered) {
                // Remove from queue after successful steer
                await window.wsClient.rpc('q.del', { id: conversationId, messageId: q.messageId });
              }
            } catch (err) {
              console.error('Failed to steer:', err);
              this.showError('Failed to steer: ' + err.message);
            }
          } else if (e.target.classList.contains('queue-delete-btn')) {
            const index = parseInt(e.target.dataset.index);
            const msgId = queue[index].messageId;
            if (await window.UIDialog.confirm('Delete this queued message?', 'Delete Message')) {
              await window.wsClient.rpc('q.del', { id: conversationId, messageId: msgId });
            }
          } else if (e.target.classList.contains('queue-edit-btn')) {
            const index = parseInt(e.target.dataset.index);
            const q = queue[index];
            const newContent = await window.UIDialog.prompt('Edit message:', q.content, 'Edit Queued Message');
            if (newContent !== null && newContent !== q.content) {
              window.wsClient.rpc('q.upd', { id: conversationId, messageId: q.messageId, content: newContent });
            }
          }
        });
      }
    } catch (err) {
      console.error('Failed to fetch queue:', err);
    }
  }

  handleRateLimitHit(data) {
    if (data.conversationId !== this.state.currentConversation?.id) return;
    this.state.streamingConversations.delete(data.conversationId);

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

  handleAllConversationsDeleted(data) {
    window.ConversationState?.clear('all_deleted');
    this.state.currentConversation = null;
    this.state.conversations = [];
    this.state.sessionEvents = [];
    this.conversationCache.clear();
    this.conversationListCache = { data: [], timestamp: 0, ttl: 30000 };
    this.draftPrompts.clear();
    window.dispatchEvent(new CustomEvent('conversation-deselected'));
    const outputEl = document.getElementById('output');
    if (outputEl) outputEl.innerHTML = '';
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
          <div class="html-rendered-label">
            Rendered HTML
          </div>
          <div class="html-content">
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
        return `<div class="message-text"><div class="html-content">${this.sanitizeHtml(content)}</div></div>`;
      }
      return `<div class="message-text">${this.escapeHtml(content)}</div>`;
    } else if (content && typeof content === 'object' && content.type === 'claude_execution') {
      let html = '<div class="message-blocks">';
      if (content.blocks && Array.isArray(content.blocks)) {
        let pendingToolUseClose = false;
        content.blocks.forEach((block, blockIdx, blocks) => {
          if (block.type !== 'tool_result' && pendingToolUseClose) {
            html += '</details>';
            pendingToolUseClose = false;
          }
          if (block.type === 'text') {
            const parts = this.parseMarkdownCodeBlocks(block.text);
            parts.forEach(part => {
              if (part.type === 'html') {
                html += `<div class="message-text"><div class="html-content">${this.sanitizeHtml(part.content)}</div></div>`;
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
                  <div class="html-rendered-label">
                    Rendered HTML
                  </div>
                  <div class="html-content">
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
            const typeClass = hasRenderer && this.renderer ? this.renderer._getBlockTypeClass('tool_use') : 'block-type-tool_use';
            const toolColorClass = hasRenderer && this.renderer ? this.renderer._getToolColorClass(tn) : 'tool-color-default';
            const nextBlock = blocks[blockIdx + 1];
            const resultClass = nextBlock?.type === 'tool_result' ? (nextBlock.is_error ? 'has-error' : 'has-success') : '';
            html += `<details class="block-tool-use folded-tool ${typeClass} ${toolColorClass} ${resultClass}"><summary class="folded-tool-bar">${iconHtml}<span class="folded-tool-name">${this.escapeHtml(dName)}</span>${tTitle ? `<span class="folded-tool-desc">${this.escapeHtml(tTitle)}</span>` : ''}</summary>${inputHtml}`;
            pendingToolUseClose = true;
          } else if (block.type === 'tool_result') {
            const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
            const smartHtml = typeof StreamingRenderer !== 'undefined' ? StreamingRenderer.renderSmartContentHTML(content, this.escapeHtml.bind(this), true) : `<pre class="tool-result-pre">${this.escapeHtml(content.length > 2000 ? content.substring(0, 2000) + '\n... (truncated)' : content)}</pre>`;
            const resultPreview = content.length > 80 ? content.substring(0, 77).replace(/\n/g, ' ') + '...' : content.replace(/\n/g, ' ');
            const resultIcon = block.is_error
              ? '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/></svg>'
              : '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>';
            const resultTypeClass = hasRenderer && this.renderer ? this.renderer._getBlockTypeClass('tool_result') : 'block-type-tool_result';
            const resultHtml = `<div class="tool-result-inline${block.is_error ? ' tool-result-error' : ' tool-result-success'} ${resultTypeClass}"><div class="tool-result-status"><span class="folded-tool-icon">${resultIcon}</span><span class="folded-tool-name">${block.is_error ? 'Error' : 'Success'}</span></div><div class="folded-tool-body">${smartHtml}</div></div>`;
            if (pendingToolUseClose) {
              html += resultHtml + '</details>';
              pendingToolUseClose = false;
            } else {
              html += resultHtml;
            }
          }
        });
        if (pendingToolUseClose) html += '</details>';
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

    if (!prompt.trim()) {
      this.showError('Please enter a prompt');
      return;
    }

    this.disableControls();
    const ttsActive = window.TTSHandler && window.TTSHandler.getAutoSpeak && window.TTSHandler.getAutoSpeak();
    const savedPrompt = ttsActive ? prompt + '\n\n[Respond optimized for text-to-speech: use short sentences, simple words, and focus on clarity.]' : prompt;
    if (this.ui.messageInput) {
      this.ui.messageInput.value = '';
      this.ui.messageInput.style.height = 'auto';
    }

    const pendingId = 'pending-' + Date.now() + '-' + Math.random().toString(36).substr(2, 6);

    // Check if streaming - only show optimistic message if NOT queuing
    const isStreaming = this.state.currentConversation && this.state.streamingConversations.has(this.state.currentConversation.id);
    if (!isStreaming) {
      this._showOptimisticMessage(pendingId, savedPrompt);
    }

    try {
      let conv = this.state.currentConversation;

      if (this._isLoadingConversation) {
        this.showError('Conversation still loading. Please try again.');
        this.enableControls();
        return;
      }

      if (conv && typeof conv === 'string') {
        this.showError('Conversation state invalid. Please reload.');
        this.enableControls();
        return;
      }

      if (conv?.id) {
        const isNewConversation = !conv.messageCount && !this.state.streamingConversations.has(conv.id);
        const agentId = (isNewConversation ? this.getCurrentAgent() : null) || conv?.agentType || this.getCurrentAgent();
        const subAgent = this.getEffectiveSubAgent() || conv?.subAgent || null;
        const model = this.ui.modelSelector?.value || null;

        this.lockAgentAndModel(agentId, model);
        await this.streamToConversation(conv.id, savedPrompt, agentId, model, subAgent);
        this.clearDraft(conv.id);
        // Only confirm optimistic message if it was shown (not queued)
        if (!isStreaming) {
          this._confirmOptimisticMessage(pendingId);
        }
      } else {
        const agentId = this.getCurrentAgent();
        const subAgent = this.getEffectiveSubAgent() || null;
        const model = this.ui.modelSelector?.value || null;

        const body = { agentId, title: savedPrompt.substring(0, 50) };
        if (model) body.model = model;
        if (subAgent) body.subAgent = subAgent;
        const { conversation } = await window.wsClient.rpc('conv.new', body);
        window.ConversationState?.selectConversation(conversation.id, 'conversation_created', 1);
        this.state.currentConversation = conversation;
        this.lockAgentAndModel(agentId, model);

        if (window.conversationManager) {
          window.conversationManager.loadConversations();
          window.conversationManager.select(conversation.id);
        }

        await this.streamToConversation(conversation.id, savedPrompt, agentId, model, subAgent);
        this.clearDraft(conversation.id);
        this._confirmOptimisticMessage(pendingId);
      }
    } catch (error) {
      console.error('Execution error:', error);
      // Only fail optimistic message if it was shown
      if (!isStreaming) {
        this._failOptimisticMessage(pendingId, savedPrompt, error.message);
      }
      this.enableControls();
    }
  }

  _showOptimisticMessage(pendingId, content) {
    const messagesEl = document.querySelector('.conversation-messages');
    if (!messagesEl) return;
    messagesEl.querySelectorAll('p.text-secondary').forEach(p => p.remove());
    const div = document.createElement('div');
    div.className = 'message message-user message-sending';
    div.id = pendingId;
    div.innerHTML = `<div class="message-role">User</div><div class="message-text">${this.escapeHtml(content)}</div><div class="message-timestamp" style="opacity:0.5">Sending...</div>`;
    messagesEl.appendChild(div);
    this.scrollToBottom(true);
  }

  _confirmOptimisticMessage(pendingId) {
    const el = document.getElementById(pendingId);
    if (!el) return;
    el.classList.remove('message-sending');
    const ts = el.querySelector('.message-timestamp');
    if (ts) {
      ts.style.opacity = '1';
      ts.textContent = new Date().toLocaleString();
    }
  }

  _failOptimisticMessage(pendingId, content, errorMsg) {
    const el = document.getElementById(pendingId);
    if (!el) return;
    el.classList.remove('message-sending');
    el.classList.add('message-send-failed');
    const ts = el.querySelector('.message-timestamp');
    if (ts) {
      ts.style.opacity = '1';
      ts.innerHTML = `<span style="color:var(--color-error)">Failed: ${this.escapeHtml(errorMsg)}</span>`;
    }
    if (this.ui.messageInput) {
      this.ui.messageInput.value = content;
    }
  }

  _subscribeToConversationUpdates() {
    if (!this.state.conversations || this.state.conversations.length === 0) return;
    for (const conv of this.state.conversations) {
      this.wsManager.subscribeToConversation(conv.id);
    }
  }

  // Flush background-cached blocks into the active streaming container
  _flushBgCache(conversationId, sessionId) {
    const entry = this._bgCache.get(conversationId);
    if (!entry || entry.items.length === 0) return;
    if (entry.sessionId !== sessionId) { this._bgCache.delete(conversationId); return; }

    const streamingEl = document.getElementById(`streaming-${sessionId}`);
    if (!streamingEl) return;
    const blocksEl = streamingEl.querySelector('.streaming-blocks');
    if (!blocksEl) return;

    if (!this._renderedSeqs) this._renderedSeqs = {};
    const seenSeqs = this._renderedSeqs[sessionId] || (this._renderedSeqs[sessionId] = new Set());
    for (const item of entry.items) {
      // Skip blocks already rendered (dedup by seq)
      if (item.seq !== undefined && seenSeqs.has(item.seq)) continue;
      try {
        const block = (typeof msgpackr !== 'undefined' && item.packed instanceof Uint8Array)
          ? msgpackr.unpack(item.packed) : item.packed;
        const el = this.renderer.renderBlock(block, { sessionId }, blocksEl);
        if (el) {
          if (item.seq !== undefined) seenSeqs.add(item.seq);
          blocksEl.appendChild(el);
        }
      } catch (_) {}
    }
    this._bgCache.delete(conversationId);
    this.scrollToBottom();
  }

  async _recoverMissedChunks() {
    if (!this.state.currentSession?.id) return;
    // Note: do NOT gate on streamingConversations - this is called from handleStreamingComplete
    // where we've already removed the conversation from the set. Allow recovery always.

    const sessionId = this.state.currentSession.id;
    // Use lastSeq=-1 when no WS messages received yet (fresh load/full disconnect).
    // Server query is `sequence > sinceSeq`, so -1 returns all chunks from seq 0.
    // _renderedSeqs dedup prevents double-rendering anything already shown.
    const lastSeq = this.wsManager.getLastSeq(sessionId);

    try {
      const { chunks: rawChunks } = await window.wsClient.rpc('sess.chunks', { id: sessionId, sinceSeq: lastSeq });
      if (!rawChunks || rawChunks.length === 0) return;

      const chunks = rawChunks.map(c => ({
        ...c,
        block: typeof c.data === 'string' ? JSON.parse(c.data) : c.data
      })).filter(c => c.block && c.block.type);

      const seenSeqs = (this._renderedSeqs || {})[sessionId];
      const dedupedChunks = chunks.filter(c => !seenSeqs || !seenSeqs.has(c.sequence));

      if (dedupedChunks.length > 0) {
        for (const chunk of dedupedChunks) this.renderChunk(chunk);
      }
    } catch (e) {
      console.warn('Chunk recovery failed:', e.message);
    }
  }

  _dedupedFetch(key, fetchFn) {
    if (this._inflightRequests.has(key)) {
      return this._inflightRequests.get(key);
    }
    const promise = fetchFn().finally(() => {
      this._inflightRequests.delete(key);
    });
    this._inflightRequests.set(key, promise);
    return promise;
  }

  _insertPlaceholder(sessionId) {
    this._removePlaceholder();
    const streamingEl = document.getElementById(`streaming-${sessionId}`);
    if (!streamingEl) return;
    const blocksEl = streamingEl.querySelector('.streaming-blocks');
    if (!blocksEl) return;
    const ph = document.createElement('div');
    ph.className = 'chunk-placeholder';
    ph.id = 'chunk-placeholder-active';
    blocksEl.appendChild(ph);
    this._placeholderAutoRemove = setTimeout(() => this._removePlaceholder(), 500);
  }

  _removePlaceholder() {
    if (this._placeholderAutoRemove) { clearTimeout(this._placeholderAutoRemove); this._placeholderAutoRemove = null; }
    const ph = document.getElementById('chunk-placeholder-active');
    if (ph && ph.parentNode) ph.remove();
  }

  _trackBlockHeight(block, element) {
    if (!element || !block?.type) return;
    const h = element.offsetHeight;
    if (h <= 0) return;
    if (!this._blockHeightAvg) this._blockHeightAvg = {};
    const t = block.type;
    if (!this._blockHeightAvg[t]) this._blockHeightAvg[t] = { sum: 0, count: 0 };
    this._blockHeightAvg[t].sum += h;
    this._blockHeightAvg[t].count++;
  }

  _estimatedBlockHeight(type) {
    const defaults = { text: 40, tool_use: 60, tool_result: 40 };
    if (this._blockHeightAvg?.[type]?.count >= 3) {
      return this._blockHeightAvg[type].sum / this._blockHeightAvg[type].count;
    }
    return defaults[type] || 40;
  }

  _startThinkingCountdown() {
    this._clearThinkingCountdown();
    if (!this._lastSendTime) return;
    const predicted = this.wsManager?.latency?.predicted || 0;
    const estimatedWait = predicted + this._serverProcessingEstimate;
    if (estimatedWait < 1000) return;
    let remaining = Math.ceil(estimatedWait / 1000);
    const update = () => {
      const indicator = document.querySelector('.streaming-indicator');
      if (!indicator) return;
      if (remaining > 0) {
        indicator.textContent = `Thinking... (~${remaining}s)`;
        remaining--;
        this._countdownTimer = setTimeout(update, 1000);
      } else {
        indicator.textContent = 'Thinking... (taking longer than expected)';
      }
    };
    this._countdownTimer = setTimeout(update, 100);
  }

  _clearThinkingCountdown() {
    if (this._countdownTimer) { clearTimeout(this._countdownTimer); this._countdownTimer = null; }
  }

  _setupDebugHooks() {
    if (typeof window === 'undefined') return;
    const self = this;
    window.__debug = {
      getState: () => ({
        latencyEma: self.wsManager?._latencyEma || null,
        serverProcessingEstimate: self._serverProcessingEstimate,
        latencyTrend: self.wsManager?.latency?.trend || null
      }),

      // Sync-to-display debugging
      getSyncState: () => ({
        currentConversation: self.state.currentConversation,
        isStreaming: self.state.currentConversation && self.state.streamingConversations.has(self.state.currentConversation.id),
        streamingConversations: Array.from(self.state.streamingConversations),
        rendererEventQueueLength: self.renderer?.eventQueue?.length || 0,
        rendererEventHistoryLength: self.renderer?.eventHistory?.length || 0,
      }),

      // Message DOM state
      getMessageState: () => {
        const output = document.querySelector('.conversation-messages');
        if (!output) return { error: 'No conversation output found' };
        const messageCount = output.querySelectorAll('.message').length;
        const queueItems = output.querySelectorAll('.queue-item').length;
        const pendingMessages = output.querySelectorAll('.message-sending').length;
        return { messageCount, queueItems, pendingMessages };
      }
    };
  }

  /**
   * Show native loading spinner on document element
   */
  showLoadingSpinner() {
    document.documentElement.style.pointerEvents = 'auto';
    // Show native CSS loading indicator (not removing, just visual cue)
    const indicator = document.querySelector('[data-model-dl-indicator]');
    if (indicator && !indicator.classList.contains('visible')) {
      indicator.classList.add('visible');
    }
  }

  /**
   * Hide native loading spinner
   */
  hideLoadingSpinner() {
    const indicator = document.querySelector('[data-model-dl-indicator]');
    if (indicator && indicator.classList.contains('visible')) {
      indicator.classList.remove('visible');
    }
  }

  /**
   * Show welcome screen when no conversation is selected
   */
  _showWelcomeScreen() {
    const outputEl = document.getElementById('output');
    if (!outputEl) return;
    // Build agent options from loaded agents list
    const agents = this.state.agents || [];
    const agentOptions = agents.map(a =>
      `<option value="${this.escapeHtml(a.id)}">${this.escapeHtml(a.name.split(/[\s\-]+/)[0])}</option>`
    ).join('');
    outputEl.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100%;flex-direction:column;gap:2rem;padding:2rem;">
        <div style="text-align:center;">
          <h1 style="margin:0;font-size:2.5rem;color:var(--color-text-primary);">Welcome to AgentGUI</h1>
          <p style="margin:1rem 0 0 0;font-size:1.1rem;color:var(--color-text-secondary);">Start a new conversation or select one from the sidebar</p>
        </div>
        ${agents.length > 0 ? `
        <div style="display:flex;flex-direction:column;align-items:center;gap:0.75rem;">
          <label style="font-size:0.85rem;color:var(--color-text-secondary);font-weight:500;">Select Agent</label>
          <select id="welcomeAgentSelect" style="padding:0.5rem 1rem;border-radius:0.375rem;border:1px solid var(--color-border);background:var(--color-bg-secondary);color:var(--color-text-primary);font-size:1rem;cursor:pointer;">
            ${agentOptions}
          </select>
        </div>
        ` : ''}
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:1rem;max-width:600px;">
          <div style="padding:1.5rem;border-radius:0.5rem;background:var(--color-bg-secondary);border:1px solid var(--color-border);">
            <h3 style="margin:0 0 0.5rem 0;color:var(--color-primary);">New Conversation</h3>
            <p style="margin:0;font-size:0.9rem;color:var(--color-text-secondary);">Create a new chat with any AI agent</p>
          </div>
          <div style="padding:1.5rem;border-radius:0.5rem;background:var(--color-bg-secondary);border:1px solid var(--color-border);">
            <h3 style="margin:0 0 0.5rem 0;color:var(--color-primary);">Available Agents</h3>
            <p style="margin:0;font-size:0.9rem;color:var(--color-text-secondary);">${agents.length > 0 ? agents.map(a => a.name.split(/[\s\-]+/)[0]).join(', ') : 'Claude Code, Gemini, OpenCode, and more'}</p>
          </div>
        </div>
      </div>
    `;
    // Sync welcome agent select with the bottom bar cli selector
    const welcomeSel = document.getElementById('welcomeAgentSelect');
    if (welcomeSel) {
      if (this.ui.cliSelector) welcomeSel.value = this.ui.cliSelector.value;
      welcomeSel.addEventListener('change', () => {
        if (this.ui.cliSelector) {
          this.ui.cliSelector.value = welcomeSel.value;
          this.ui.cliSelector.dispatchEvent(new Event('change'));
        }
      });
    }
  }

  _showSkeletonLoading(conversationId) {
    const outputEl = document.getElementById('output');
    if (!outputEl) return;
    const conv = this.state.conversations.find(c => c.id === conversationId);
    const title = conv?.title || 'Conversation';
    const wdInfo = conv?.workingDirectory ? `${this.escapeHtml(conv.workingDirectory)}` : '';
    const timestamp = conv ? new Date(conv.created_at).toLocaleDateString() : '';
    const metaParts = [timestamp];
    if (wdInfo) metaParts.push(wdInfo);
    outputEl.innerHTML = `
      <div class="conversation-header">
        <h2>${this.escapeHtml(title)}</h2>
        <p class="text-secondary">${metaParts.join(' - ')}</p>
      </div>
      <div class="conversation-messages">
        <div class="skeleton-loading">
          <div class="skeleton-block skeleton-pulse" style="height:3rem;margin-bottom:0.75rem;border-radius:0.5rem;background:var(--color-bg-secondary);"></div>
          <div class="skeleton-block skeleton-pulse" style="height:6rem;margin-bottom:0.75rem;border-radius:0.5rem;background:var(--color-bg-secondary);"></div>
          <div class="skeleton-block skeleton-pulse" style="height:2rem;margin-bottom:0.75rem;border-radius:0.5rem;background:var(--color-bg-secondary);"></div>
          <div class="skeleton-block skeleton-pulse" style="height:5rem;margin-bottom:0.75rem;border-radius:0.5rem;background:var(--color-bg-secondary);"></div>
        </div>
      </div>
    `;
  }

  async streamToConversation(conversationId, prompt, agentId, model, subAgent) {
    try {
      if (this.wsManager.isConnected) {
        this.wsManager.sendMessage({ type: 'subscribe', conversationId });
      }

      let finalPrompt = prompt;
      const streamBody = { id: conversationId, content: finalPrompt, agentId };
      if (model) streamBody.model = model;
      if (subAgent) streamBody.subAgent = subAgent;
      let result;
      try {
        result = await window.wsClient.rpc('msg.stream', streamBody);
      } catch (e) {
        if (e.code === 404) {
          console.warn('Conversation not found, recreating:', conversationId);
          const conv = this.state.currentConversation;
          const createBody = { agentId, title: conv?.title || prompt.substring(0, 50), workingDirectory: conv?.workingDirectory || null };
          if (model) createBody.model = model;
          if (subAgent) createBody.subAgent = subAgent;
          const { conversation: newConv } = await window.wsClient.rpc('conv.new', createBody);
          window.ConversationState?.selectConversation(newConv.id, 'stream_recreate', 1);
          this.state.currentConversation = newConv;
          if (window.conversationManager) {
            window.conversationManager.loadConversations();
            window.conversationManager.select(newConv.id);
          }
          this.updateUrlForConversation(newConv.id);
          return this.streamToConversation(newConv.id, prompt, agentId, model, subAgent);
        }
        throw e;
      }

      if (result.queued) {
        console.log('Message queued, position:', result.queuePosition);
        this.enableControls();
        return;
      }

      if (result.session && this.wsManager.isConnected) {
        this.wsManager.subscribeToSession(result.session.id);
      }

      this._lastSendTime = Date.now();
      this.emit('execution:started', result);
    } catch (error) {
      console.error('Stream execution error:', error);
      this.showError('Failed to stream execution: ' + error.message);
      this.enableControls();
    }
  }

  /**
   * Render a single chunk to the output
   */
  renderChunk(chunk) {
    if (!chunk || !chunk.block) return;
    // Deduplicate: skip if already rendered via WebSocket streaming_progress
    const seq = chunk.sequence;
    if (seq !== undefined) {
      const seen = (this._renderedSeqs = this._renderedSeqs || {})[chunk.sessionId] || (this._renderedSeqs[chunk.sessionId] = new Set());
      if (seen.has(seq)) return;
      seen.add(seq);
    }
    const streamingEl = document.getElementById(`streaming-${chunk.sessionId}`);
    if (!streamingEl) return;
    const blocksEl = streamingEl.querySelector('.streaming-blocks');
    if (!blocksEl) return;
    if (chunk.block.type === 'tool_result') {
      const matchById = chunk.block.tool_use_id && blocksEl.querySelector(`.block-tool-use[data-tool-use-id="${chunk.block.tool_use_id}"]`);
      const lastEl = blocksEl.lastElementChild;
      const toolUseEl = matchById || (lastEl?.classList?.contains('block-tool-use') ? lastEl : null);
      if (toolUseEl) {
        toolUseEl.classList.remove('has-success', 'has-error');
        toolUseEl.classList.add(chunk.block.is_error ? 'has-error' : 'has-success');
        const parentIsOpen = toolUseEl.hasAttribute('open');
        const contextWithParent = { ...chunk, parentIsOpen };
        const element = this.renderer.renderBlock(chunk.block, contextWithParent, blocksEl);
        if (element) { toolUseEl.appendChild(element); this.scrollToBottom(); }
        return;
      }
    }
    const element = this.renderer.renderBlock(chunk.block, chunk, blocksEl);
    if (!element) { this.scrollToBottom(); return; }
    blocksEl.appendChild(element);
    this.scrollToBottom();
  }

  /**
   * Load agents
   */
  async loadAgents() {
    return this._dedupedFetch('loadAgents', async () => {
      try {
        const { agents } = await window.wsClient.rpc('agent.ls');
        this.state.agents = agents;

        const displayAgents = agents;

        if (this.ui.cliSelector) {
          if (displayAgents.length > 0) {
            this.ui.cliSelector.innerHTML = displayAgents
              .map(a => `<option value="${a.id}">${a.name.split(/[\s\-]+/)[0]}</option>`)
              .join('');
            this.ui.cliSelector.style.display = 'inline-block';
          } else {
            this.ui.cliSelector.innerHTML = '';
            this.ui.cliSelector.style.display = 'none';
          }
        }

        window.dispatchEvent(new CustomEvent('agents-loaded', { detail: { agents } }));

        if (displayAgents.length > 0 && !this._agentLocked) {
          const firstId = displayAgents[0].id;
          await this.loadSubAgentsForCli(firstId);
          this.loadModelsForAgent(this.getEffectiveAgentId());
        }
        return agents;
      } catch (error) {
        console.error('Failed to load agents:', error);
        return [];
      }
    });
  }

  async loadSubAgentsForCli(cliAgentId) {
    if (this.ui.agentSelector) {
      this.ui.agentSelector.innerHTML = '';
      this.ui.agentSelector.style.display = 'none';
    }
    try {
      const { subAgents } = await window.wsClient.rpc('agent.subagents', { id: cliAgentId });
      if (subAgents && subAgents.length > 0 && this.ui.agentSelector) {
        this.ui.agentSelector.innerHTML = subAgents
          .map(a => `<option value="${a.id}">${a.name.split(/[\s\-]+/)[0]}</option>`)
          .join('');
        this.ui.agentSelector.style.display = 'inline-block';
        console.log(`[Agent Selector] Loaded ${subAgents.length} sub-agents for ${cliAgentId}`);
        // Auto-select first sub-agent and load its models
        const firstSubAgentId = subAgents[0].id;
        this.ui.agentSelector.value = firstSubAgentId;
        this.loadModelsForAgent(cliAgentId); // models keyed to parent agent
      } else {
        console.log(`[Agent Selector] No sub-agents found for ${cliAgentId}`);
        // Load models for the CLI agent itself (fallback for agents without sub-agents)
        const cliToAcpMap = {
          'cli-opencode': 'opencode',
          'cli-gemini': 'gemini',
          'cli-kilo': 'kilo',
          'cli-codex': 'codex'
        };
        const acpAgentId = cliToAcpMap[cliAgentId] || cliAgentId;
        this.loadModelsForAgent(acpAgentId);
      }
    } catch (err) {
      // No sub-agents available for this CLI tool — keep hidden
      console.warn(`[Agent Selector] Failed to load sub-agents for ${cliAgentId}:`, err.message);
      // Fallback: load models for the corresponding ACP agent
      const cliToAcpMap = {
        'cli-opencode': 'opencode',
        'cli-gemini': 'gemini',
        'cli-kilo': 'kilo',
        'cli-codex': 'codex'
      };
      const acpAgentId = cliToAcpMap[cliAgentId] || cliAgentId;
      this.loadModelsForAgent(acpAgentId);
    }
  }

  async checkSpeechStatus() {
    try {
      const status = await window.wsClient.rpc('speech.status');
      if (status.modelsComplete) {
        this._modelDownloadProgress = { done: true, complete: true };
        this._modelDownloadInProgress = false;
      } else if (status.modelsDownloading) {
        this._modelDownloadProgress = status.modelsProgress || { downloading: true };
        this._modelDownloadInProgress = true;
      } else {
        this._modelDownloadProgress = { done: false };
        this._modelDownloadInProgress = false;
      }
    } catch (error) {
      console.error('Failed to check speech status:', error);
      this._modelDownloadProgress = { done: false };
      this._modelDownloadInProgress = false;
    }
  }

  async loadModelsForAgent(agentId) {
    if (!agentId || !this.ui.modelSelector) return;
    const cached = this._modelCache.get(agentId);
    if (cached) {
      this._populateModelSelector(cached);
      return;
    }
    try {
      const { models } = await window.wsClient.rpc('agent.models', { id: agentId });
      this._modelCache.set(agentId, models);
      this._populateModelSelector(models);
    } catch (error) {
      console.error('Failed to load models:', error);
      this._populateModelSelector([]);
    }
  }

  _populateModelSelector(models) {
    if (!this.ui.modelSelector) return;
    if (!models || models.length === 0) {
      this.ui.modelSelector.innerHTML = '';
      this.ui.modelSelector.setAttribute('data-empty', 'true');
      return;
    }
    this.ui.modelSelector.removeAttribute('data-empty');
    this.ui.modelSelector.innerHTML = models
      .map(m => `<option value="${m.id}">${this.escapeHtml(m.label)}</option>`)
      .join('');
  }

  lockAgentAndModel(agentId, model) {
    this._agentLocked = true;
    if (this.ui.cliSelector) {
      this.ui.cliSelector.disabled = true;
    }

    this.loadModelsForAgent(agentId).then(() => {
      if (this.ui.modelSelector && model) {
        this.ui.modelSelector.value = model;
      }
    });
  }

  unlockAgentAndModel() {
    this._agentLocked = false;
    if (this.ui.cliSelector) {
      this.ui.cliSelector.disabled = false;
      if (this.ui.cliSelector.options.length > 0) {
        this.ui.cliSelector.style.display = 'inline-block';
      }
    }
    if (this.ui.modelSelector) {
      this.ui.modelSelector.disabled = false;
    }
  }

  /**
   * Apply agent and model selection based on conversation state
   * Consolidates duplicate logic for cached and fresh conversation loads
   */
  applyAgentAndModelSelection(conversation, hasActivity) {
    const agentId = conversation.agentId || conversation.agentType || null;
    const model = conversation.model || null;
    const subAgent = conversation.subAgent || null;

    if (hasActivity) {
      this._setCliSelectorToAgent(agentId);
      this.lockAgentAndModel(agentId, model);
    } else {
      this.unlockAgentAndModel();
      this._setCliSelectorToAgent(agentId);

      const effectiveAgentId = agentId || this.getEffectiveAgentId();
      this.loadSubAgentsForCli(effectiveAgentId).then(() => {
        if (subAgent && this.ui.agentSelector) {
          this.ui.agentSelector.value = subAgent;
        }
      });
      this.loadModelsForAgent(effectiveAgentId).then(() => {
        if (model && this.ui.modelSelector) {
          this.ui.modelSelector.value = model;
        }
      });
    }
  }

  _setCliSelectorToAgent(agentId) {
    if (this.ui.cliSelector) {
      this.ui.cliSelector.value = agentId;
      if (!this.ui.cliSelector.value) {
        this.ui.cliSelector.selectedIndex = 0;
      }
    }
  }

  /**
   * Load conversations
   */
  async loadConversations() {
    // Return cached conversations if still fresh
    const now = Date.now();
    if (this.conversationListCache.data.length > 0 &&
        (now - this.conversationListCache.timestamp) < this.conversationListCache.ttl) {
      this.state.conversations = this.conversationListCache.data;
      return this.conversationListCache.data;
    }

    return this._dedupedFetch('loadConversations', async () => {
      try {
        const { conversations } = await window.wsClient.rpc('conv.ls');
        this.state.conversations = conversations;
        // Update cache
        this.conversationListCache.data = conversations;
        this.conversationListCache.timestamp = Date.now();
        return conversations;
      } catch (error) {
        console.error('Failed to load conversations:', error);
        return [];
      }
    });
  }

  /**
   * Update connection status UI
   */
  updateConnectionStatus(status) {
    if (this.ui.statusIndicator) {
      this.ui.statusIndicator.dataset.status = status;
      this.ui.statusIndicator.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    }
    if (status === 'disconnected' || status === 'reconnecting') {
      this._updateConnectionIndicator(status);
    } else if (status === 'connected') {
      this._updateConnectionIndicator(this.wsManager?.latency?.quality || 'unknown');
    }
  }

  _updateConnectionIndicator(quality) {
    if (this._indicatorDebounce && !this._modelDownloadInProgress) return;
    this._indicatorDebounce = true;
    setTimeout(() => { this._indicatorDebounce = false; }, 1000);

    let indicator = document.getElementById('connection-indicator');
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'connection-indicator';
      indicator.className = 'connection-indicator';
      indicator.innerHTML = '<span class="connection-dot"></span><span class="connection-label"></span>';
      indicator.addEventListener('click', () => this._toggleConnectionTooltip());
      const header = document.querySelector('.header-right') || document.querySelector('.app-header');
      if (header) {
        header.style.position = 'relative';
        header.appendChild(indicator);
      }
    }

    const dot = indicator.querySelector('.connection-dot');
    const label = indicator.querySelector('.connection-label');
    if (!dot || !label) return;

    // Check if model download is in progress
    if (this._modelDownloadInProgress) {
      dot.className = 'connection-dot downloading';
      const progress = this._modelDownloadProgress;
      if (progress && progress.totalBytes > 0) {
        const pct = Math.round((progress.totalDownloaded / progress.totalBytes) * 100);
        label.textContent = `Models ${pct}%`;
      } else if (progress && progress.downloading) {
        label.textContent = 'Downloading...';
      } else {
        label.textContent = 'Loading models...';
      }
      return;
    }

    dot.className = 'connection-dot';
    if (quality === 'disconnected' || quality === 'reconnecting') {
      dot.classList.add(quality);
      label.textContent = quality === 'reconnecting' ? 'Reconnecting...' : 'Disconnected';
    } else {
      dot.classList.add(quality);
      const latency = this.wsManager?.latency;
      label.textContent = latency?.avg > 0 ? Math.round(latency.avg) + 'ms' : '';
    }
  }

  _handleModelDownloadProgress(progress) {
    this._modelDownloadProgress = progress;
    if (progress.status === 'failed' || progress.error) {
      this._modelDownloadInProgress = false;
      console.error('[Models] Download error:', progress.error || progress.status);
      this._updateConnectionIndicator(this.wsManager?.latency?.quality || 'unknown');
      return;
    }
    if (progress.done || progress.status === 'completed') {
      this._modelDownloadInProgress = false;
      console.log('[Models] Download complete');
      this._updateConnectionIndicator(this.wsManager?.latency?.quality || 'unknown');
      return;
    }
    if (progress.started || progress.downloading || progress.status === 'downloading' || progress.status === 'connecting') {
      this._modelDownloadInProgress = true;
      this._updateConnectionIndicator(this.wsManager?.latency?.quality || 'unknown');
    }
  }

  _handleTTSSetupProgress(data) {
    if (data.step && data.status) {
      console.log('[TTS Setup]', data.step, ':', data.status, data.message || '');
    }
  }

  _toggleConnectionTooltip() {
    let tooltip = document.getElementById('connection-tooltip');
    if (tooltip) { tooltip.remove(); return; }

    const indicator = document.getElementById('connection-indicator');
    if (!indicator) return;

    tooltip = document.createElement('div');
    tooltip.id = 'connection-tooltip';
    tooltip.className = 'connection-tooltip';

    const latency = this.wsManager?.latency || {};
    const stats = this.wsManager?.stats || {};
    const state = this.wsManager?.connectionState || 'unknown';

    tooltip.innerHTML = [
      `<div>State: ${state}</div>`,
      `<div>Latency: ${Math.round(latency.avg || 0)}ms</div>`,
      `<div>Predicted: ${Math.round(latency.predicted || 0)}ms (Kalman)</div>`,
      `<div>Trend: ${latency.trend || 'unknown'}</div>`,
      `<div>Jitter: ${Math.round(latency.jitter || 0)}ms</div>`,
      `<div>Quality: ${latency.quality || 'unknown'}</div>`,
      `<div>Reconnects: ${stats.totalReconnects || 0}</div>`,
      `<div>Uptime: ${stats.lastConnectedTime ? Math.round((Date.now() - stats.lastConnectedTime) / 1000) + 's' : 'N/A'}</div>`
    ].join('');

    indicator.appendChild(tooltip);
    setTimeout(() => { if (tooltip.parentNode) tooltip.remove(); }, 5000);
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
   * Disable UI controls during execution - prevents double-sends
   */
  disableControls() {
    if (this.ui.sendButton) this.ui.sendButton.disabled = true;
  }

  /**
   * Enable UI controls after execution completes or fails
   */
  enableControls() {
    if (this.ui.sendButton) {
      this.ui.sendButton.disabled = !this.wsManager?.isConnected;
    }
    this.updateBusyPromptArea(this.state.currentConversation?.id);
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
      const agentId = this.getEffectiveAgentId();
      const model = this.ui.modelSelector?.value || null;
      const convTitle = title || 'New Conversation';
      const body = { agentId, title: convTitle };
      if (workingDirectory) body.workingDirectory = workingDirectory;
      if (model) body.model = model;

      const { conversation } = await window.wsClient.rpc('conv.new', body);

      await this.loadConversations();

      if (window.conversationManager) {
        await window.conversationManager.loadConversations();
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

  /**
   * PHASE 2: Create a new load request with lifetime tracking
   * Assigns unique requestId, tracks in _loadInProgress, returns abort signal
   * Automatically cancels previous loads to this conversation
   */
  _makeLoadRequest(conversationId) {
    const requestId = ++this._currentRequestId;
    const abortController = new AbortController();

    // Cancel previous request to this conversation
    if (this._loadInProgress[conversationId]) {
      const prevReq = this._loadInProgress[conversationId];
      try {
        prevReq.abortController.abort();
      } catch (e) {}
    }

    this._loadInProgress[conversationId] = {
      requestId,
      abortController,
      timestamp: Date.now(),
      prevConversationId: this.state.currentConversation?.id
    };

    return { requestId, abortController: abortController.signal };
  }

  /**
   * PHASE 2: Verify request is still current before rendering
   * Returns true if requestId matches current load for this conversation
   * Returns false if newer request arrived, or request was cancelled
   */
  _verifyRequestId(conversationId, requestId) {
    const current = this._loadInProgress[conversationId];
    if (!current) return false;
    if (current.requestId !== requestId) return false;
    return true;
  }

  /**
   * PHASE 2: Complete/cleanup a load request
   */
  _completeLoadRequest(conversationId, requestId) {
    const req = this._loadInProgress[conversationId];
    if (req && req.requestId === requestId) {
      delete this._loadInProgress[conversationId];
    }
  }

  async loadConversationMessages(conversationId) {
    try {
      if (this._previousConvAbort) {
        this._previousConvAbort.abort();
      }
      this._previousConvAbort = new AbortController();
      const convSignal = this._previousConvAbort.signal;

      const prevConversationId = this.state.currentConversation?.id;
      const availableFallback = this.state.conversations?.find(c => c.id !== conversationId) || null;
      this.cacheCurrentConversation();
  
      this.removeScrollUpDetection();
      if (this.renderer.resetScrollState) this.renderer.resetScrollState();
      this._userScrolledUp = false;
      this._removeNewContentPill();

      if (this.ui.messageInput) {
        this.ui.messageInput.value = '';
        this.ui.messageInput.style.height = 'auto';
        // Note: prompt disabled state will be set immutably based on shouldResumeStreaming
        // after conversation data loads, don't set here
      }

      if (this.ui.stopButton) this.ui.stopButton.classList.remove('visible');
      if (this.ui.injectButton) this.ui.injectButton.classList.remove('visible');
      if (this.ui.queueButton) this.ui.queueButton.classList.remove('visible');
      if (this.ui.sendButton) this.ui.sendButton.style.display = '';

      var prevId = this.state.currentConversation?.id;
      if (prevId && prevId !== conversationId) {
        if (this.wsManager.isConnected && !this.state.streamingConversations.has(prevId)) {
          this.wsManager.sendMessage({ type: 'unsubscribe', conversationId: prevId });
        }
        this.state.currentSession = null;
      }

      const cachedConv = this.state.conversations.find(c => c.id === conversationId);
      if (cachedConv && this.state.currentConversation?.id !== conversationId) {
        window.ConversationState?.selectConversation(conversationId, 'cache_load', 1);
        this.state.currentConversation = cachedConv;
      }

      this.updateUrlForConversation(conversationId);
      if (this.wsManager.isConnected) {
        this.wsManager.sendMessage({ type: 'subscribe', conversationId });
      }

      const cached = this.conversationCache.get(conversationId);
      if (cached && (Date.now() - cached.timestamp) < 300000) {
        const outputEl = document.getElementById('output');
        if (outputEl) {
          outputEl.innerHTML = '';
          while (cached.dom.firstChild) {
            outputEl.appendChild(cached.dom.firstChild);
          }
          window.ConversationState?.selectConversation(conversationId, 'dom_cache_load', 1);
          this.state.currentConversation = cached.conversation;
          window.dispatchEvent(new CustomEvent('conversation-changed', { detail: { conversationId, conversation: cached.conversation } }));
          const cachedHasActivity = cached.conversation.messageCount > 0 || this.state.streamingConversations.has(conversationId);
          this.applyAgentAndModelSelection(cached.conversation, cachedHasActivity);
          this.conversationCache.delete(conversationId);
          this.syncPromptState(conversationId);
          this.restoreScrollPosition(conversationId);
          return;
        }
      }

      this.conversationCache.delete(conversationId);

      this._showSkeletonLoading(conversationId);

      // Disable send button during skeleton loading to prevent race conditions
      if (this.ui.sendButton) {
        this.ui.sendButton.disabled = true;
      }

      let fullData;
      try {
        fullData = await window.wsClient.rpc('conv.full', { id: conversationId, chunkLimit: 50 });
        if (convSignal.aborted) return;
      } catch (e) {
        if (e.code === 404) {
          console.warn('Conversation no longer exists:', conversationId);
          window.ConversationState?.clear('conversation_not_found');
          this.state.currentConversation = null;
          if (window.conversationManager) window.conversationManager.loadConversations();
          // Resume from last successful conversation if available, or fall back to any available conversation
          const fallbackConv = prevConversationId ? prevConversationId : availableFallback?.id;
          if (fallbackConv && fallbackConv !== conversationId) {
            console.log('Resuming from fallback conversation:', fallbackConv);
            this.showError('Conversation not found. Resuming previous conversation.');
            await this.loadConversationMessages(fallbackConv);
          } else {
            const outputEl = document.getElementById('output');
            if (outputEl) outputEl.innerHTML = '<p class="text-secondary" style="padding:2rem;text-align:center">Conversation not found. It may have been lost during a server restart.</p>';
            this.enableControls();
          }
          return;
        }
        throw e;
      }
      if (convSignal.aborted) return;
      const { conversation, isActivelyStreaming, latestSession, chunks: rawChunks, totalChunks, messages: allMessages } = fullData;

      window.ConversationState?.selectConversation(conversationId, 'server_load', 1);
      this.state.currentConversation = conversation;
      window.dispatchEvent(new CustomEvent('conversation-changed', { detail: { conversationId, conversation } }));
      const hasActivity = (allMessages && allMessages.length > 0) || isActivelyStreaming || latestSession || this.state.streamingConversations.has(conversationId);
      this.applyAgentAndModelSelection(conversation, hasActivity);

      const chunks = (rawChunks || []).map(chunk => ({
        ...chunk,
        block: typeof chunk.data === 'string' ? JSON.parse(chunk.data) : chunk.data
      }));

      // Fetch queue to exclude queued messages from being rendered as regular user messages
      let queuedMessageIds = new Set();
      try {
        const { queue } = await window.wsClient.rpc('q.ls', { id: conversationId });
        if (queue && queue.length > 0) {
          queuedMessageIds = new Set(queue.map(q => q.messageId));
        }
      } catch (e) {
        console.warn('Failed to fetch queue:', e.message);
      }

      // Filter out queued messages from user messages - they'll be rendered in queue indicator instead
      const userMessages = (allMessages || []).filter(m => m.role === 'user' && !queuedMessageIds.has(m.id));
      const hasMoreChunks = totalChunks && chunks.length < totalChunks;

      const clientKnowsStreaming = this.state.streamingConversations.has(conversationId);
      const shouldResumeStreaming = latestSession &&
        (latestSession.status === 'active' || latestSession.status === 'pending');

      if (shouldResumeStreaming) {
        this.state.streamingConversations.set(conversationId, true);
        window.dispatchEvent(new CustomEvent('ws-message', { detail: { type: 'streaming_start', conversationId, sessionId: latestSession?.id } }));
      } else {
        this.state.streamingConversations.delete(conversationId);
        window.dispatchEvent(new CustomEvent('ws-message', { detail: { type: 'streaming_complete', conversationId } }));
      }

      if (this.ui.messageInput) {
        this.ui.messageInput.disabled = false;
      }

      const outputEl = document.getElementById('output');
      if (outputEl) {
        const wdInfo = conversation.workingDirectory ? `${this.escapeHtml(conversation.workingDirectory)}` : '';
        const timestamp = new Date(conversation.created_at).toLocaleDateString();
        const metaParts = [timestamp];
        if (wdInfo) metaParts.push(wdInfo);
        outputEl.innerHTML = `
          <div class="conversation-header">
            <h2>${this.escapeHtml(conversation.title || 'Conversation')}</h2>
            <p class="text-secondary">${metaParts.join(' - ')}</p>
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
              await window.wsClient.rpc('conv.full', { id: conversationId, allChunks: true });
              this.invalidateCache(conversationId);
              await this.loadConversationMessages(conversationId);
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
            const toolResultBlocks = new Map();

            sessionChunkList.forEach(chunk => {
              if (!chunk.block?.type) return;
              if (chunk.block.type === 'tool_result') {
                toolResultBlocks.set(chunk.id, chunk);
                return;
              }
              const element = this.renderer.renderBlock(chunk.block, chunk, blockFrag);
              if (!element) return;
              element.classList.add('block-loaded');
              blockFrag.appendChild(element);
            });

            blocksEl.appendChild(blockFrag);

            toolResultBlocks.forEach((chunk) => {
              const toolUseId = chunk.block.tool_use_id;
              const toolUseEl = toolUseId
                ? blocksEl.querySelector(`.block-tool-use[data-tool-use-id="${toolUseId}"]`)
                : blocksEl.lastElementChild?.classList?.contains('block-type-tool_use') ? blocksEl.lastElementChild : null;
              if (!toolUseEl) return;
              toolUseEl.classList.remove('has-success', 'has-error');
              toolUseEl.classList.add(chunk.block.is_error ? 'has-error' : 'has-success');
              const contextWithParent = { ...chunk, parentIsOpen: toolUseEl.hasAttribute('open') };
              const element = this.renderer.renderBlock(chunk.block, contextWithParent, toolUseEl);
              if (element) {
                element.classList.add('block-loaded');
                toolUseEl.appendChild(element);
              }
            });

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
          if (!convSignal.aborted) messagesEl.appendChild(frag);
        } else {
          if (!convSignal.aborted) messagesEl.appendChild(this.renderMessagesFragment(allMessages || []));
        }

        if (!convSignal.aborted && shouldResumeStreaming && latestSession && chunks.length === 0) {
          const streamDiv = document.createElement('div');
          streamDiv.id = `streaming-${latestSession.id}`;
          streamDiv.className = 'streaming-message';
          const indicatorDiv = document.createElement('div');
          indicatorDiv.className = 'streaming-indicator';
          indicatorDiv.style = 'display:flex;align-items:center;gap:0.5rem;padding:0.5rem 0;color:var(--color-text-secondary);font-size:0.875rem;';
          indicatorDiv.innerHTML = `
            <span class="animate-spin" style="display:inline-block;width:1rem;height:1rem;border:2px solid var(--color-border);border-top-color:var(--color-primary);border-radius:50%;"></span>
            <span class="streaming-indicator-label">Agent is starting...</span>
          `;
          streamDiv.appendChild(indicatorDiv);
          messagesEl.appendChild(streamDiv);
        }

        if (shouldResumeStreaming && latestSession) {
          this.state.streamingConversations.set(conversationId, true);
          this.state.currentSession = {
            id: latestSession.id,
            conversationId: conversationId,
            agentId: conversation.agentType || null,
            startTime: latestSession.created_at
          };

          if (this.wsManager.isConnected) {
            this.wsManager.subscribeToSession(latestSession.id);
            this.wsManager.sendMessage({ type: 'subscribe', conversationId });
          }

          this.updateUrlForConversation(conversationId, latestSession.id);

          // Flush any blocks accumulated in the background cache while this conv wasn't active
          this._flushBgCache(conversationId, latestSession.id);

          // IMMUTABLE: Prompt remains enabled - syncPromptState will set correct state
          this.syncPromptState(conversationId);
        } else {
          this.syncPromptState(conversationId);
        }

        // Re-enable send button after skeleton loading completes
        if (this.ui.sendButton) {
          this.ui.sendButton.disabled = false;
        }

        this.restoreScrollPosition(conversationId);
        this.setupScrollUpDetection(conversationId);

        // Fetch and display queue items so queued messages show in yellow blocks, not as user messages
        this.fetchAndRenderQueue(conversationId);

      }
    } catch (error) {
      if (error.name === 'AbortError') return;
      console.error('Failed to load conversation messages:', error);
      // Resume from last successful conversation if available, or fall back to any available conversation
      const fallbackConv = prevConversationId ? prevConversationId : availableFallback?.id;
      if (fallbackConv && fallbackConv !== conversationId) {
        console.log('Resuming from fallback conversation due to error:', fallbackConv);
        this.showError('Failed to load conversation. Resuming previous conversation.');
        try {
          await this.loadConversationMessages(fallbackConv);
        } catch (fallbackError) {
          console.error('Failed to resume fallback conversation:', fallbackError);
          this.showError('Failed to load conversation: ' + error.message);
        }
      } else {
        this.showError('Failed to load conversation: ' + error.message);
      }
    }
  }

  syncPromptState(conversationId) {
    const conversation = this.state.currentConversation;
    if (!conversation || conversation.id !== conversationId) return;

    if (this.ui.messageInput) {
      this.ui.messageInput.disabled = false;
    }

    this.updateBusyPromptArea(conversationId);
  }

  updateBusyPromptArea(conversationId) {
    if (this.state.currentConversation?.id !== conversationId) return;
    const isStreaming = this.state.streamingConversations.has(conversationId);
    const isConnected = this.wsManager?.isConnected;

    const injectBtn = document.getElementById('injectBtn');
    const queueBtn = document.getElementById('queueBtn');
    const stopBtn = document.getElementById('stopBtn');

    [injectBtn, queueBtn, stopBtn].forEach(btn => {
      if (!btn) return;
      btn.classList.toggle('visible', isStreaming);
      btn.disabled = !isConnected;
    });

    if (this.ui.sendButton) this.ui.sendButton.style.display = isStreaming ? 'none' : '';
  }

  removeScrollUpDetection() {
    const scrollContainer = document.getElementById(this.config.scrollContainerId);
    if (scrollContainer && this._scrollUpHandler) {
      scrollContainer.removeEventListener('scroll', this._scrollUpHandler);
      this._scrollUpHandler = null;
    }
  }

  setupScrollUpDetection(conversationId) {
    const scrollContainer = document.getElementById(this.config.scrollContainerId);
    if (!scrollContainer) return;

    if (!this._scrollDetectionState) this._scrollDetectionState = {};

    const detectionState = {
      isLoading: false,
      oldestTimestamp: Date.now(),
      oldestMessageId: null,
      conversation: conversationId
    };

    const handleScroll = async () => {
      const scrollTop = scrollContainer.scrollTop;
      const scrollHeight = scrollContainer.scrollHeight;
      const clientHeight = scrollContainer.clientHeight;
      const THRESHOLD = 300;

      if (scrollTop < THRESHOLD && !detectionState.isLoading && scrollHeight > clientHeight) {
        detectionState.isLoading = true;

        try {
          const messagesEl = document.querySelector('.conversation-messages');
          if (!messagesEl) {
            detectionState.isLoading = false;
            return;
          }

          const firstMessageEl = messagesEl.querySelector('.message[data-msg-id]');
          if (!firstMessageEl) {
            const firstChunkEl = messagesEl.querySelector('[data-chunk-created]');
            if (firstChunkEl) {
              detectionState.oldestTimestamp = parseInt(firstChunkEl.getAttribute('data-chunk-created')) || 0;
            }
          } else {
            detectionState.oldestMessageId = firstMessageEl.getAttribute('data-msg-id');
          }

          let result;
          if (detectionState.oldestMessageId) {
            result = await window.wsClient.rpc('msg.ls.earlier', {
              id: conversationId,
              before: detectionState.oldestMessageId,
              limit: 50
            });
          } else if (detectionState.oldestTimestamp > 0) {
            result = await window.wsClient.rpc('conv.chunks.earlier', {
              id: conversationId,
              before: detectionState.oldestTimestamp,
              limit: 500
            });
          }

          if (result && ((result.messages && result.messages.length > 0) || (result.chunks && result.chunks.length > 0))) {
            const scrollHeightBefore = scrollContainer.scrollHeight;
            const scrollTopBefore = scrollContainer.scrollTop;
            const newContent = document.createDocumentFragment();

            if (result.messages && result.messages.length > 0) {
              result.messages.forEach(msg => {
                const div = document.createElement('div');
                div.className = `message message-${msg.role}`;
                div.setAttribute('data-msg-id', msg.id);
                div.innerHTML = `<div class="message-role">${msg.role.charAt(0).toUpperCase() + msg.role.slice(1)}</div>${this.renderMessageContent(msg.content)}<div class="message-timestamp">${new Date(msg.created_at).toLocaleString()}</div>`;
                newContent.appendChild(div);
              });
            }

            if (result.chunks && result.chunks.length > 0) {
              result.chunks.forEach(chunk => {
                const blockEl = this.renderer.renderBlock(chunk.data, {}, false);
                if (blockEl) {
                  const wrapper = document.createElement('div');
                  wrapper.setAttribute('data-chunk-created', chunk.created_at);
                  wrapper.appendChild(blockEl);
                  newContent.appendChild(wrapper);
                }
              });
            }

            if (messagesEl.firstChild) {
              messagesEl.insertBefore(newContent, messagesEl.firstChild);
            } else {
              messagesEl.appendChild(newContent);
            }

            const scrollHeightAfter = scrollContainer.scrollHeight;
            scrollContainer.scrollTop = scrollTopBefore + (scrollHeightAfter - scrollHeightBefore);
          }
        } catch (error) {
          console.error('Failed to load earlier messages:', error);
        } finally {
          detectionState.isLoading = false;
        }
      }
    };

    scrollContainer.removeEventListener('scroll', this._scrollUpHandler);
    this._scrollUpHandler = handleScroll;
    scrollContainer.addEventListener('scroll', this._scrollUpHandler, { passive: true });
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
    if (window.UIDialog) {
      window.UIDialog.alert(message, 'Error');
    }
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
   * Get current selected agent
   */
  getEffectiveAgentId() {
    return this.ui.cliSelector?.value || null;
  }

  getEffectiveSubAgent() {
    if (this.ui.agentSelector?.value && this.ui.agentSelector.style.display !== 'none') {
      return this.ui.agentSelector.value;
    }
    return null;
  }

  getCurrentAgent() {
    return this.getEffectiveAgentId();
  }

  saveAgentAndModelToConversation() {
    const convId = this.state.currentConversation?.id;
    if (!convId || this._agentLocked) return;
    const agentId = this.getEffectiveAgentId();
    const subAgent = this.getEffectiveSubAgent();
    const model = this.getCurrentModel();
    window.wsClient.rpc('conv.upd', { id: convId, agentType: agentId, subAgent: subAgent || undefined, model: model || undefined }).catch(() => {});
  }

  /**
   * Get current selected model
   */
  getCurrentModel() {
    return this.ui.modelSelector?.value || null;
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
   * Save draft prompt for current conversation
   */
  saveDraftPrompt() {
    const convId = this.state.currentConversation?.id;
    if (convId && this.ui.messageInput) {
      const draft = this.ui.messageInput.value;
      this.draftPrompts.set(convId, draft);
      if (draft) {
        localStorage.setItem(`draft-${convId}`, draft);
      }
    }
  }

  /**
   * Restore draft prompt for conversation
   */
  restoreDraftPrompt(conversationId) {
    if (!this.ui.messageInput) return;

    let draft = this.draftPrompts.get(conversationId) || '';
    if (!draft) {
      draft = localStorage.getItem(`draft-${conversationId}`) || '';
      if (draft) this.draftPrompts.set(conversationId, draft);
    }

    this.ui.messageInput.value = draft;
  }

  /**
   * Clear draft for conversation
   */
  clearDraft(conversationId) {
    this.draftPrompts.delete(conversationId);
    localStorage.removeItem(`draft-${conversationId}`);
  }

  /**
   * Update send button state based on WebSocket connection
   */
  updateSendButtonState() {
    if (this.ui.sendButton) {
      this.ui.sendButton.disabled = !this.wsManager.isConnected;
    }
    // Also disable queue and inject buttons if disconnected
    if (this.ui.injectButton && this.ui.injectButton.classList.contains('visible')) {
      this.ui.injectButton.disabled = !this.wsManager.isConnected;
    }
    if (this.ui.queueButton && this.ui.queueButton.classList.contains('visible')) {
      this.ui.queueButton.disabled = !this.wsManager.isConnected;
    }
  }

  /**
   * Disable prompt area - NEVER CALLED. Prompt must always be enabled.
   * Keeping method for backward compatibility but it does nothing.
   */
  disablePromptArea() {
    // NEVER disable messageInput - prompt must always be writable
  }

  /**
   * Enable prompt area (input and inject button) on connect
   */
  enablePromptArea() {
    if (this.ui.messageInput) {
      this.ui.messageInput.disabled = false;
    }
    const injectBtn = document.getElementById('injectBtn');
    if (injectBtn) injectBtn.disabled = false;
  }

  /**
   * Show queue/inject buttons when streaming (busy prompt state)
   */
  showStreamingPromptButtons() {
    if (this.ui.injectButton) {
      this.ui.injectButton.classList.add('visible');
      this.ui.injectButton.disabled = !this.wsManager.isConnected;
    }
    if (this.ui.queueButton) {
      this.ui.queueButton.classList.add('visible');
      this.ui.queueButton.disabled = !this.wsManager.isConnected;
    }
  }

  /**
   * Ensure prompt area is always enabled and shows queue/inject when agent streaming
   */
  ensurePromptAreaAlwaysEnabled() {
    if (this.ui.messageInput) {
      this.ui.messageInput.disabled = false;
    }
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
    window.agentGuiClient = agentGUIClient;
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
