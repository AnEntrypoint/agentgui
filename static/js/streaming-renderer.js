/**
 * Streaming Renderer Engine
 * Manages real-time event processing, batching, and DOM rendering
 * for Claude Code streaming execution display
 */

class StreamingRenderer {
  constructor(config = {}) {
    // Configuration
    this.config = {
      batchSize: config.batchSize || 50,
      batchInterval: config.batchInterval || 16, // ~60fps
      maxQueueSize: config.maxQueueSize || 10000,
      maxEventHistory: config.maxEventHistory || 1000,
      virtualScrollThreshold: config.virtualScrollThreshold || 500,
      debounceDelay: config.debounceDelay || 100,
      ...config
    };

    // State
    this.eventQueue = [];
    this.eventHistory = [];
    this.isProcessing = false;
    this.batchTimer = null;
    this.dedupMap = new Map();
    this.renderCache = new Map();
    this.domNodeCount = 0;
    this.lastRenderTime = 0;
    this.performanceMetrics = {
      totalEvents: 0,
      totalBatches: 0,
      avgBatchSize: 0,
      avgRenderTime: 0,
      avgProcessTime: 0
    };

    // DOM references
    this.outputContainer = null;
    this.scrollContainer = null;
    this.virtualScroller = null;

    // Event listeners
    this.listeners = {
      'event:queued': [],
      'event:dequeued': [],
      'batch:start': [],
      'batch:complete': [],
      'render:start': [],
      'render:complete': [],
      'error:render': []
    };

    // Performance monitoring
    this.observer = null;
    this.resizeObserver = null;
  }

  /**
   * Initialize the renderer with DOM elements
   */
  init(outputContainerId, scrollContainerId = null) {
    this.outputContainer = document.getElementById(outputContainerId);
    this.scrollContainer = scrollContainerId ? document.getElementById(scrollContainerId) : this.outputContainer;

    if (!this.outputContainer) {
      throw new Error(`Output container not found: ${outputContainerId}`);
    }

    this.setupDOMObserver();
    this.setupResizeObserver();
    this.setupScrollOptimization();
    return this;
  }

  /**
   * Setup DOM mutation observer for external changes
   */
  setupDOMObserver() {
    try {
      this.observer = new MutationObserver(() => {
        this.updateDOMNodeCount();
      });

      this.observer.observe(this.outputContainer, {
        childList: true,
        subtree: true,
        characterData: false,
        attributes: false
      });
    } catch (e) {
      console.warn('DOM observer setup failed:', e.message);
    }
  }

  /**
   * Setup resize observer for viewport changes
   */
  setupResizeObserver() {
    try {
      this.resizeObserver = new ResizeObserver(() => {
        this.updateVirtualScroll();
      });

      if (this.scrollContainer) {
        this.resizeObserver.observe(this.scrollContainer);
      }
    } catch (e) {
      console.warn('Resize observer setup failed:', e.message);
    }
  }

  /**
   * Setup scroll optimization and auto-scroll
   */
  setupScrollOptimization() {
    if (this.scrollContainer) {
      this.scrollContainer.addEventListener('scroll', () => {
        this.updateVirtualScroll();
      }, { passive: true });
    }
  }

  /**
   * Queue an event for batch processing
   */
  queueEvent(event) {
    if (!event || typeof event !== 'object') return false;

    // Add timestamp if not present
    if (!event.timestamp) {
      event.timestamp = Date.now();
    }

    // Deduplication
    if (this.isDuplicate(event)) {
      return false;
    }

    // Queue size check
    if (this.eventQueue.length >= this.config.maxQueueSize) {
      console.warn('Event queue overflow, dropping oldest events');
      this.eventQueue.shift();
    }

    this.eventQueue.push(event);
    this.eventHistory.push(event);

    // Trim history
    if (this.eventHistory.length > this.config.maxEventHistory) {
      this.eventHistory.shift();
    }

    this.emit('event:queued', { event, queueLength: this.eventQueue.length });
    this.scheduleBatchProcess();
    return true;
  }

  /**
   * Check if event is a duplicate
   */
  isDuplicate(event) {
    const key = this.getEventKey(event);
    if (!key) return false;

    const lastTime = this.dedupMap.get(key);
    const now = Date.now();

    // Deduplicate within 100ms window
    if (lastTime && (now - lastTime) < 100) {
      return true;
    }

    this.dedupMap.set(key, now);
    return false;
  }

  /**
   * Generate deduplication key for event
   */
  getEventKey(event) {
    if (!event.type) return null;
    return `${event.type}:${event.id || event.sessionId || ''}`;
  }

  /**
   * Schedule batch processing
   */
  scheduleBatchProcess() {
    if (this.isProcessing || this.batchTimer) return;

    if (this.eventQueue.length >= this.config.batchSize) {
      // Process immediately if batch is full
      this.processBatch();
    } else {
      // Schedule for later
      this.batchTimer = setTimeout(() => {
        this.batchTimer = null;
        if (this.eventQueue.length > 0) {
          this.processBatch();
        }
      }, this.config.batchInterval);
    }
  }

  /**
   * Process queued events as a batch
   */
  processBatch() {
    if (this.isProcessing) return;
    if (this.eventQueue.length === 0) return;

    this.isProcessing = true;
    const processStart = performance.now();
    const batchSize = Math.min(this.eventQueue.length, this.config.batchSize);
    const batch = this.eventQueue.splice(0, batchSize);

    this.emit('batch:start', { batchSize, queueLength: this.eventQueue.length });

    try {
      // Process and render batch
      const renderStart = performance.now();
      this.renderBatch(batch);
      const renderTime = performance.now() - renderStart;

      // Update metrics
      this.performanceMetrics.totalBatches++;
      this.performanceMetrics.totalEvents += batchSize;
      this.performanceMetrics.avgBatchSize = this.performanceMetrics.totalEvents / this.performanceMetrics.totalBatches;
      this.performanceMetrics.avgRenderTime = (this.performanceMetrics.avgRenderTime * (this.performanceMetrics.totalBatches - 1) + renderTime) / this.performanceMetrics.totalBatches;

      this.emit('batch:complete', {
        batchSize,
        renderTime,
        metrics: this.performanceMetrics
      });

      // Process more if queue is still full
      if (this.eventQueue.length >= this.config.batchSize) {
        this.isProcessing = false;
        setImmediate(() => this.processBatch());
      } else {
        this.isProcessing = false;
        if (this.eventQueue.length > 0) {
          this.scheduleBatchProcess();
        }
      }
    } catch (error) {
      console.error('Batch processing error:', error);
      this.isProcessing = false;
      this.emit('error:render', { error, batch });
    }

    const processTime = performance.now() - processStart;
    this.performanceMetrics.avgProcessTime = this.performanceMetrics.avgProcessTime || processTime;
  }

  /**
   * Render a batch of events
   */
  renderBatch(batch) {
    if (!this.outputContainer) return;

    this.emit('render:start', { eventCount: batch.length });
    const renderStart = performance.now();

    try {
      // Create document fragment for batch
      const fragment = document.createDocumentFragment();
      let nodeCount = 0;

      for (const event of batch) {
        try {
          const element = this.renderEvent(event);
          if (element) {
            fragment.appendChild(element);
            nodeCount++;
          }
        } catch (error) {
          console.error('Event render error:', error, event);
        }
      }

      // Append all at once (minimizes reflows)
      if (nodeCount > 0) {
        this.outputContainer.appendChild(fragment);
        this.domNodeCount += nodeCount;
      }

      // Auto-scroll to bottom
      this.autoScroll();

      const renderTime = performance.now() - renderStart;
      this.lastRenderTime = renderTime;

      this.emit('render:complete', {
        eventCount: batch.length,
        nodeCount,
        renderTime
      });
    } catch (error) {
      console.error('Batch render error:', error);
      this.emit('error:render', { error, batch });
    }
  }

  /**
   * Render a single event to DOM element
   */
  renderEvent(event) {
    if (!event.type) return null;

    try {
      switch (event.type) {
        case 'streaming_start':
          return this.renderStreamingStart(event);
        case 'streaming_progress':
          return this.renderStreamingProgress(event);
        case 'streaming_complete':
          return this.renderStreamingComplete(event);
        case 'file_read':
          return this.renderFileRead(event);
        case 'file_write':
          return this.renderFileWrite(event);
        case 'git_status':
          return this.renderGitStatus(event);
        case 'command_execute':
          return this.renderCommand(event);
        case 'error':
          return this.renderError(event);
        case 'text_block':
          return this.renderText(event);
        case 'code_block':
          return this.renderCode(event);
        case 'thinking_block':
          return this.renderThinking(event);
        case 'tool_use':
          return this.renderToolUse(event);
        default:
          return this.renderGeneric(event);
      }
    } catch (error) {
      console.error('Event render error:', error, event);
      return this.renderError({ message: error.message, event });
    }
  }

  /**
   * Render streaming start event
   */
  renderStreamingStart(event) {
    const div = document.createElement('div');
    div.className = 'event-streaming-start card mb-3 p-4 bg-blue-50 dark:bg-blue-900';
    div.dataset.eventId = event.id || event.sessionId || '';
    div.dataset.eventType = 'streaming_start';

    const time = new Date(event.timestamp).toLocaleTimeString();
    div.innerHTML = `
      <div class="flex items-center gap-2">
        <svg class="w-5 h-5 text-blue-600 dark:text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="2" fill="none" opacity="0.25"></circle>
          <path d="M4 12a8 8 0 018-8" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path>
        </svg>
        <div class="flex-1">
          <h4 class="font-semibold text-blue-900 dark:text-blue-200">Streaming Started</h4>
          <p class="text-sm text-blue-700 dark:text-blue-300">Agent: ${this.escapeHtml(event.agentId || 'unknown')} • ${time}</p>
        </div>
      </div>
    `;
    return div;
  }

  /**
   * Render streaming progress event
   */
  renderStreamingProgress(event) {
    const div = document.createElement('div');
    div.className = 'event-streaming-progress mb-2 p-2 border-l-4 border-blue-500';
    div.dataset.eventId = event.id || '';
    div.dataset.eventType = 'streaming_progress';

    const percentage = event.progress || 0;
    div.innerHTML = `
      <div class="flex items-center gap-2 text-sm">
        <span class="text-secondary">${percentage}%</span>
        <div class="flex-1 bg-gray-200 dark:bg-gray-700 rounded-full h-2 overflow-hidden">
          <div class="bg-blue-500 h-full transition-all" style="width: ${percentage}%"></div>
        </div>
      </div>
    `;
    return div;
  }

  /**
   * Render streaming complete event
   */
  renderStreamingComplete(event) {
    const div = document.createElement('div');
    div.className = 'event-streaming-complete card mb-3 p-4 bg-green-50 dark:bg-green-900';
    div.dataset.eventId = event.id || event.sessionId || '';
    div.dataset.eventType = 'streaming_complete';

    const time = new Date(event.timestamp).toLocaleTimeString();
    const duration = event.duration ? `${(event.duration / 1000).toFixed(2)}s` : 'unknown';
    div.innerHTML = `
      <div class="flex items-center gap-2">
        <svg class="w-5 h-5 text-green-600 dark:text-green-400" fill="currentColor" viewBox="0 0 20 20">
          <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"></path>
        </svg>
        <div class="flex-1">
          <h4 class="font-semibold text-green-900 dark:text-green-200">Streaming Complete</h4>
          <p class="text-sm text-green-700 dark:text-green-300">Duration: ${this.escapeHtml(duration)} • ${time}</p>
        </div>
      </div>
    `;
    return div;
  }

  /**
   * Render file read event
   */
  renderFileRead(event) {
    const div = document.createElement('div');
    div.className = 'event-file-read card mb-3 p-4';
    div.dataset.eventId = event.id || '';
    div.dataset.eventType = 'file_read';

    const fileName = event.path ? event.path.split('/').pop() : 'unknown';
    const size = event.size || 0;
    const sizeStr = this.formatFileSize(size);

    div.innerHTML = `
      <div class="flex items-start justify-between gap-3 mb-3">
        <div class="flex items-center gap-2 flex-1">
          <svg class="w-4 h-4 text-primary flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path d="M5.5 13a3 3 0 01.369-1.618l1.83-1.83a3 3 0 015.604 0l.83 1.83A3 3 0 0113.5 13H11V9.413l1.293 1.293a1 1 0 001.414-1.414l-3-3a1 1 0 00-1.414 0l-3 3a1 1 0 001.414 1.414L9 9.414V13H5.5z"></path>
          </svg>
          <div class="flex-1 min-w-0">
            <h4 class="font-semibold text-sm truncate">${this.escapeHtml(fileName)}</h4>
            <p class="text-xs text-secondary truncate" title="${this.escapeHtml(event.path || '')}">${this.escapeHtml(event.path || '')}</p>
          </div>
        </div>
        <span class="badge badge-sm flex-shrink-0">${this.escapeHtml(sizeStr)}</span>
      </div>
      ${event.content ? `
        <pre class="bg-gray-50 dark:bg-gray-900 p-3 rounded border text-xs overflow-x-auto"><code>${this.escapeHtml(this.truncateContent(event.content, 500))}</code></pre>
      ` : ''}
    `;
    return div;
  }

  /**
   * Render file write event
   */
  renderFileWrite(event) {
    const div = document.createElement('div');
    div.className = 'event-file-write card mb-3 p-4 border-l-4 border-yellow-500';
    div.dataset.eventId = event.id || '';
    div.dataset.eventType = 'file_write';

    const fileName = event.path ? event.path.split('/').pop() : 'unknown';
    const size = event.size || 0;
    const sizeStr = this.formatFileSize(size);

    div.innerHTML = `
      <div class="flex items-start justify-between gap-3 mb-3">
        <div class="flex items-center gap-2 flex-1">
          <svg class="w-4 h-4 text-yellow-600 dark:text-yellow-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path d="M4 4a2 2 0 012-2h8a2 2 0 012 2v12a1 1 0 110 2h-3a1 1 0 01-1-1v-2a1 1 0 00-1-1H9a1 1 0 00-1 1v2a1 1 0 01-1 1H4a1 1 0 110-2V4z"></path>
          </svg>
          <div class="flex-1 min-w-0">
            <h4 class="font-semibold text-sm truncate">${this.escapeHtml(fileName)}</h4>
            <p class="text-xs text-secondary truncate" title="${this.escapeHtml(event.path || '')}">${this.escapeHtml(event.path || '')}</p>
          </div>
        </div>
        <span class="badge badge-sm bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200 flex-shrink-0">Written</span>
      </div>
      <span class="text-xs text-secondary">${this.escapeHtml(sizeStr)}</span>
    `;
    return div;
  }

  /**
   * Render git status event
   */
  renderGitStatus(event) {
    const div = document.createElement('div');
    div.className = 'event-git-status card mb-3 p-4 border-l-4 border-orange-500';
    div.dataset.eventId = event.id || '';
    div.dataset.eventType = 'git_status';

    const branch = event.branch || 'unknown';
    const changes = event.changes || {};
    const total = (changes.added || 0) + (changes.modified || 0) + (changes.deleted || 0);

    div.innerHTML = `
      <div class="flex items-center gap-3 mb-2">
        <svg class="w-4 h-4 text-orange-600 dark:text-orange-400" fill="currentColor" viewBox="0 0 20 20">
          <path fill-rule="evenodd" d="M9.243 3.03a1 1 0 01.727 1.155L9.53 6h2.94l.56-2.243a1 1 0 111.94.486L14.53 6H17a1 1 0 110 2h-2.97l-.5 2H17a1 1 0 110 2h-3.03l-.56 2.243a1 1 0 11-1.94-.486L12.47 14H9.53l-.56 2.243a1 1 0 11-1.94-.486L7.47 14H4a1 1 0 110-2h3.03l.5-2H4a1 1 0 110-2h2.97l.56-2.243a1 1 0 011.155-.727zM9.03 8l.5 2h2.94l-.5-2H9.03z" clip-rule="evenodd"></path>
        </svg>
        <div class="flex-1">
          <h4 class="font-semibold text-sm">Git Status</h4>
          <p class="text-xs text-secondary">Branch: ${this.escapeHtml(branch)}</p>
        </div>
      </div>
      <div class="flex gap-4 text-xs">
        ${changes.added ? `<span class="text-green-600 dark:text-green-400">+${changes.added}</span>` : ''}
        ${changes.modified ? `<span class="text-blue-600 dark:text-blue-400">~${changes.modified}</span>` : ''}
        ${changes.deleted ? `<span class="text-red-600 dark:text-red-400">-${changes.deleted}</span>` : ''}
        ${total === 0 ? '<span class="text-secondary">no changes</span>' : ''}
      </div>
    `;
    return div;
  }

  /**
   * Render command execution event
   */
  renderCommand(event) {
    const div = document.createElement('div');
    div.className = 'event-command card mb-3 p-4 font-mono text-sm';
    div.dataset.eventId = event.id || '';
    div.dataset.eventType = 'command_execute';

    const command = event.command || '';
    const output = event.output || '';
    const exitCode = event.exitCode !== undefined ? event.exitCode : null;

    div.innerHTML = `
      <div class="bg-gray-900 text-gray-100 p-3 rounded mb-2 overflow-x-auto">
        <div class="text-green-400">$ ${this.escapeHtml(command)}</div>
      </div>
      ${output ? `
        <div class="bg-gray-50 dark:bg-gray-900 p-3 rounded border text-xs overflow-x-auto">
          <pre><code>${this.escapeHtml(this.truncateContent(output, 500))}</code></pre>
        </div>
      ` : ''}
      ${exitCode !== null ? `
        <div class="text-xs mt-2 ${exitCode === 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}">
          Exit code: ${exitCode}
        </div>
      ` : ''}
    `;
    return div;
  }

  /**
   * Render error event
   */
  renderError(event) {
    const div = document.createElement('div');
    div.className = 'event-error card mb-3 p-4 bg-red-50 dark:bg-red-900 border-l-4 border-red-500';
    div.dataset.eventId = event.id || '';
    div.dataset.eventType = 'error';

    const message = event.message || event.error || 'Unknown error';
    const severity = event.severity || 'error';

    div.innerHTML = `
      <div class="flex items-start gap-3">
        <svg class="w-5 h-5 text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
          <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"></path>
        </svg>
        <div class="flex-1">
          <h4 class="font-semibold text-red-900 dark:text-red-200">Error: ${this.escapeHtml(severity)}</h4>
          <p class="text-sm text-red-800 dark:text-red-300 mt-1">${this.escapeHtml(message)}</p>
        </div>
      </div>
    `;
    return div;
  }

  /**
   * Parse markdown code blocks from text
   */
  parseMarkdownCodeBlocks(text) {
    const codeBlockRegex = /```(\w*)\n([\s\S]*?)```/g;
    const parts = [];
    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        parts.push({ type: 'text', content: text.substring(lastIndex, match.index) });
      }
      parts.push({ type: 'code', language: match[1] || 'plain', code: match[2] });
      lastIndex = codeBlockRegex.lastIndex;
    }

    if (lastIndex < text.length) {
      parts.push({ type: 'text', content: text.substring(lastIndex) });
    }

    if (parts.length === 0) {
      return [{ type: 'text', content: text }];
    }

    return parts;
  }

  /**
   * Render text block event
   */
  renderText(event) {
    const div = document.createElement('div');
    div.className = 'event-text mb-3 p-3 bg-gray-50 dark:bg-gray-900 rounded border';
    div.dataset.eventId = event.id || '';
    div.dataset.eventType = 'text_block';

    const text = event.text || event.content || '';
    const parts = this.parseMarkdownCodeBlocks(text);
    let html = '';
    parts.forEach(part => {
      if (part.type === 'text') {
        html += `<p class="text-sm leading-relaxed">${this.escapeHtml(part.content)}</p>`;
      } else if (part.type === 'code') {
        if (part.language.toLowerCase() === 'html') {
          html += `<div class="html-rendered-label mb-2 p-2 bg-blue-50 rounded border text-xs" style="color:#1d4ed8;background:#eff6ff;border-color:#bfdbfe;">Rendered HTML</div>`;
          html += `<div class="html-content bg-white p-4 rounded border overflow-x-auto" style="background:#fff;border-color:#e5e7eb;">${part.code}</div>`;
        } else {
          html += `<pre class="bg-gray-900 text-gray-100 p-4 rounded overflow-x-auto"><code>${this.escapeHtml(part.code)}</code></pre>`;
        }
      }
    });
    div.innerHTML = html;
    return div;
  }

  /**
   * Render code block event
   */
  renderCode(event) {
    const div = document.createElement('div');
    div.className = 'event-code mb-3';
    div.dataset.eventId = event.id || '';
    div.dataset.eventType = 'code_block';

    const code = event.code || event.content || '';
    const language = event.language || 'plaintext';

    // Render HTML code blocks as actual HTML elements
    if (language === 'html') {
      div.innerHTML = `
        <div class="html-rendered-container mb-2 p-2 bg-blue-50 dark:bg-blue-900 rounded border border-blue-200 dark:border-blue-700 text-xs text-blue-700 dark:text-blue-300">
          Rendered HTML
        </div>
        <div class="html-content bg-white dark:bg-gray-800 p-4 rounded border border-gray-200 dark:border-gray-700 overflow-x-auto">
          ${code}
        </div>
      `;
    } else {
      div.innerHTML = `
        <pre class="bg-gray-900 text-gray-100 p-4 rounded overflow-x-auto"><code class="language-${this.escapeHtml(language)}">${this.escapeHtml(code)}</code></pre>
      `;
    }
    return div;
  }

  /**
   * Render thinking block event
   */
  renderThinking(event) {
    const div = document.createElement('div');
    div.className = 'event-thinking mb-3 p-4 bg-purple-50 dark:bg-purple-900 rounded border-l-4 border-purple-500';
    div.dataset.eventId = event.id || '';
    div.dataset.eventType = 'thinking_block';

    const text = event.thinking || event.content || '';
    div.innerHTML = `
      <details>
        <summary class="cursor-pointer font-semibold text-purple-900 dark:text-purple-200">Thinking</summary>
        <p class="mt-3 text-sm text-purple-800 dark:text-purple-300 whitespace-pre-wrap">${this.escapeHtml(text)}</p>
      </details>
    `;
    return div;
  }

  /**
   * Render tool use event
   */
  renderToolUse(event) {
    const div = document.createElement('div');
    div.className = 'event-tool-use card mb-3 p-4 border-l-4 border-cyan-500';
    div.dataset.eventId = event.id || '';
    div.dataset.eventType = 'tool_use';

    const toolName = event.toolName || event.tool || 'unknown';
    const input = event.input || {};

    div.innerHTML = `
      <div class="flex items-center gap-2 mb-2">
        <svg class="w-4 h-4 text-cyan-600 dark:text-cyan-400" fill="currentColor" viewBox="0 0 20 20">
          <path fill-rule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10.666a1 1 0 11-1.64-1.118L9.687 10H5a1 1 0 01-.82-1.573l7-10.666a1 1 0 011.12-.373zM14.6 15.477l-5.223-7.912h-3.5l5.223 7.912h3.5z" clip-rule="evenodd"></path>
        </svg>
        <h4 class="font-semibold text-sm">Tool: ${this.escapeHtml(toolName)}</h4>
      </div>
      ${Object.keys(input).length > 0 ? `
        <pre class="bg-gray-50 dark:bg-gray-900 p-3 rounded text-xs overflow-x-auto"><code>${this.escapeHtml(JSON.stringify(input, null, 2))}</code></pre>
      ` : ''}
    `;
    return div;
  }

  /**
   * Render generic event
   */
  renderGeneric(event) {
    const div = document.createElement('div');
    div.className = 'event-generic mb-3 p-3 bg-gray-100 dark:bg-gray-800 rounded text-sm';
    div.dataset.eventId = event.id || '';
    div.dataset.eventType = event.type;

    const time = new Date(event.timestamp).toLocaleTimeString();
    div.innerHTML = `
      <div class="flex items-center justify-between mb-2">
        <span class="font-semibold text-gray-900 dark:text-gray-100">${this.escapeHtml(event.type)}</span>
        <span class="text-xs text-gray-600 dark:text-gray-400">${time}</span>
      </div>
      <pre class="text-xs overflow-x-auto"><code>${this.escapeHtml(JSON.stringify(event, null, 2))}</code></pre>
    `;
    return div;
  }

  /**
   * Auto-scroll to bottom of container
   */
  autoScroll() {
    if (this.scrollContainer) {
      try {
        this.scrollContainer.scrollTop = this.scrollContainer.scrollHeight;
      } catch (e) {
        // Ignore scroll errors
      }
    }
  }

  /**
   * Update virtual scroll based on viewport
   */
  updateVirtualScroll() {
    if (!this.scrollContainer) return;

    // Calculate visible items
    const scrollTop = this.scrollContainer.scrollTop;
    const viewportHeight = this.scrollContainer.clientHeight;
    const itemHeight = 80; // Approximate item height

    const firstVisible = Math.floor(scrollTop / itemHeight);
    const lastVisible = Math.ceil((scrollTop + viewportHeight) / itemHeight);

    // Update visibility of DOM nodes
    const items = this.outputContainer?.querySelectorAll('[data-event-id]');
    if (!items) return;

    items.forEach((item, index) => {
      const isVisible = index >= firstVisible && index <= lastVisible;
      item.style.display = isVisible ? '' : 'none';
    });
  }

  /**
   * Update DOM node count for monitoring
   */
  updateDOMNodeCount() {
    this.domNodeCount = this.outputContainer?.querySelectorAll('[data-event-id]').length || 0;
  }

  /**
   * HTML escape utility
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Format file size for display
   */
  formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
  }

  /**
   * Truncate content for display
   */
  truncateContent(content, maxLength = 200) {
    if (content.length <= maxLength) return content;
    return content.substring(0, maxLength) + '...';
  }

  /**
   * Clear all rendered events
   */
  clear() {
    if (this.outputContainer) {
      this.outputContainer.innerHTML = '';
    }
    this.eventQueue = [];
    this.eventHistory = [];
    this.domNodeCount = 0;
    this.dedupMap.clear();
  }

  /**
   * Get performance metrics
   */
  getMetrics() {
    return {
      ...this.performanceMetrics,
      domNodeCount: this.domNodeCount,
      queueLength: this.eventQueue.length,
      historyLength: this.eventHistory.length,
      lastRenderTime: this.lastRenderTime
    };
  }

  /**
   * Add event listener
   */
  on(event, callback) {
    if (!this.listeners[event]) {
      this.listeners[event] = [];
    }
    this.listeners[event].push(callback);
  }

  /**
   * Emit event to listeners
   */
  emit(event, data) {
    if (this.listeners[event]) {
      this.listeners[event].forEach(callback => {
        try {
          callback(data);
        } catch (e) {
          console.error('Listener error:', e);
        }
      });
    }
  }

  /**
   * Cleanup resources
   */
  destroy() {
    if (this.observer) {
      this.observer.disconnect();
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
    }
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }
    this.listeners = {};
    this.clear();
  }
}

// Export for use in browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = StreamingRenderer;
}
