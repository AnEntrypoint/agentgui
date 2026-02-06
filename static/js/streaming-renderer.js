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
      // Handle block rendering from streaming_progress events
      if (event.type === 'streaming_progress' && event.block) {
        return this.renderBlock(event.block, event);
      }

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
   * Render Claude message blocks with beautiful styling
   */
  renderBlock(block, context = {}) {
    if (!block || !block.type) return null;

    try {
      switch (block.type) {
        case 'text':
          return this.renderBlockText(block, context);
        case 'code':
          return this.renderBlockCode(block, context);
        case 'thinking':
          return this.renderBlockThinking(block, context);
        case 'tool_use':
          return this.renderBlockToolUse(block, context);
        case 'tool_result':
          return this.renderBlockToolResult(block, context);
        case 'image':
          return this.renderBlockImage(block, context);
        case 'bash':
          return this.renderBlockBash(block, context);
        case 'system':
          return this.renderBlockSystem(block, context);
        case 'result':
          return this.renderBlockResult(block, context);
        default:
          return this.renderBlockGeneric(block, context);
      }
    } catch (error) {
      console.error('Block render error:', error, block);
      return this.renderBlockError(block, error);
    }
  }

  /**
   * Render text block with semantic HTML
   */
  renderBlockText(block, context) {
    const div = document.createElement('div');
    div.className = 'block-text';

    const text = block.text || '';
    const html = this.parseAndRenderMarkdown(text);
    div.innerHTML = html;

    return div;
  }

  /**
   * Parse markdown and render links, code, bold, italic
   */
  parseAndRenderMarkdown(text) {
    let html = this.escapeHtml(text);

    // Render markdown bold: **text** -> <strong>text</strong>
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong class="font-semibold text-gray-900 dark:text-gray-100">$1</strong>');

    // Render markdown italic: *text* or _text_
    html = html.replace(/\*([^*]+)\*/g, '<em class="italic text-gray-700 dark:text-gray-300">$1</em>');
    html = html.replace(/_([^_]+)_/g, '<em class="italic text-gray-700 dark:text-gray-300">$1</em>');

    // Render inline code: `code`
    html = html.replace(/`([^`]+)`/g, '<code class="inline-code bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded text-sm font-mono text-red-600 dark:text-red-400">$1</code>');

    // Render markdown links: [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="text-blue-600 dark:text-blue-400 hover:underline" target="_blank">$1</a>');

    // Convert line breaks
    html = html.replace(/\n/g, '<br>');

    return html;
  }

  /**
   * Render code block with syntax highlighting
   */
  renderBlockCode(block, context) {
    const div = document.createElement('div');
    div.className = 'block-code';

    const code = block.code || '';
    const language = (block.language || 'plaintext').toLowerCase();

    const header = document.createElement('div');
    header.className = 'code-header';
    header.innerHTML = `
      <span class="lang-badge">${this.escapeHtml(language)}</span>
      <button class="copy-code-btn" title="Copy code">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
      </button>
    `;

    const copyBtn = header.querySelector('.copy-code-btn');
    copyBtn.addEventListener('click', () => {
      navigator.clipboard.writeText(code).then(() => {
        const orig = copyBtn.innerHTML;
        copyBtn.innerHTML = '<svg viewBox="0 0 20 20" fill="#34d399"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>';
        setTimeout(() => { copyBtn.innerHTML = orig; }, 2000);
      });
    });

    const codeContainer = document.createElement('pre');
    codeContainer.innerHTML = `<code class="language-${this.escapeHtml(language)}">${this.escapeHtml(code)}</code>`;

    div.appendChild(header);
    div.appendChild(codeContainer);

    return div;
  }

  /**
   * Render thinking block (expandable)
   */
  renderBlockThinking(block, context) {
    const div = document.createElement('div');
    div.className = 'block-thinking';

    const thinking = block.thinking || '';
    div.innerHTML = `
      <details>
        <summary>
          <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z" clip-rule="evenodd"/></svg>
          <span>Thinking Process</span>
        </summary>
        <div class="thinking-content">${this.escapeHtml(thinking)}</div>
      </details>
    `;

    return div;
  }

  /**
   * Get a tool-specific icon SVG string
   */
  getToolIcon(toolName) {
    const icons = {
      Read: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z"/></svg>',
      Write: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z"/></svg>',
      Edit: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M17.414 2.586a2 2 0 00-2.828 0L7 10.172V13h2.828l7.586-7.586a2 2 0 000-2.828z"/><path fill-rule="evenodd" d="M2 6a2 2 0 012-2h4a1 1 0 010 2H4v10h10v-4a1 1 0 112 0v4a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" clip-rule="evenodd"/></svg>',
      Bash: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M2 5a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V5zm3.293 1.293a1 1 0 011.414 0l3 3a1 1 0 010 1.414l-3 3a1 1 0 01-1.414-1.414L7.586 10 5.293 7.707a1 1 0 010-1.414zM11 12a1 1 0 100 2h3a1 1 0 100-2h-3z" clip-rule="evenodd"/></svg>',
      Glob: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/></svg>',
      Grep: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clip-rule="evenodd"/></svg>',
      WebFetch: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM4.332 8.027a6.012 6.012 0 011.912-2.706C6.512 5.73 6.974 6 7.5 6A1.5 1.5 0 019 7.5V8a2 2 0 004 0 2 2 0 012 2v1a2 2 0 01-2 2 2 2 0 01-2 2v.5a6.003 6.003 0 01-6.668-7.473z" clip-rule="evenodd"/></svg>',
      WebSearch: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clip-rule="evenodd"/></svg>',
      TodoWrite: '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M6 2a1 1 0 00-1 1v1H4a2 2 0 00-2 2v10a2 2 0 002 2h12a2 2 0 002-2V6a2 2 0 00-2-2h-1V3a1 1 0 10-2 0v1H7V3a1 1 0 00-1-1zm0 5a1 1 0 011 1v3.586l1.293-1.293a1 1 0 111.414 1.414l-3 3a1 1 0 01-1.414 0l-3-3a1 1 0 111.414-1.414L6 11.586V8a1 1 0 011-1z" clip-rule="evenodd"/></svg>',
      Task: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9z"/><path fill-rule="evenodd" d="M4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm3 4a1 1 0 000 2h.01a1 1 0 100-2H7zm3 0a1 1 0 000 2h3a1 1 0 100-2h-3zm-3 4a1 1 0 100 2h.01a1 1 0 100-2H7zm3 0a1 1 0 100 2h3a1 1 0 100-2h-3z" clip-rule="evenodd"/></svg>',
      NotebookEdit: '<svg viewBox="0 0 20 20" fill="currentColor"><path d="M9 4.804A7.968 7.968 0 005.5 4c-1.255 0-2.443.29-3.5.804v10A7.969 7.969 0 015.5 14c1.669 0 3.218.51 4.5 1.385A7.962 7.962 0 0114.5 14c1.255 0 2.443.29 3.5.804v-10A7.968 7.968 0 0014.5 4c-1.255 0-2.443.29-3.5.804V12a1 1 0 11-2 0V4.804z"/></svg>'
    };
    return icons[toolName] || '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M11.3 1.046A1 1 0 0112 2v5h4a1 1 0 01.82 1.573l-7 10.666a1 1 0 11-1.64-1.118L9.687 10H5a1 1 0 01-.82-1.573l7-10.666a1 1 0 011.12-.373z" clip-rule="evenodd"/></svg>';
  }

  /**
   * Render a file path with icon, directory breadcrumb, and filename
   */
  renderFilePath(filePath) {
    if (!filePath) return '';
    const parts = filePath.split('/');
    const fileName = parts.pop();
    const dir = parts.join('/');
    return `<div class="tool-param-file"><span class="file-icon">&#128196;</span>${dir ? `<span class="file-dir">${this.escapeHtml(dir)}/</span>` : ''}<span class="file-name">${this.escapeHtml(fileName)}</span></div>`;
  }

  /**
   * Render smart tool parameters based on tool type
   */
  renderSmartParams(toolName, input) {
    if (!input || Object.keys(input).length === 0) return '';

    const normalizedName = toolName.replace(/^mcp__[^_]+__/, '');

    switch (normalizedName) {
      case 'Read':
        return `<div class="tool-params">${this.renderFilePath(input.file_path)}${input.offset ? `<div style="margin-top:0.375rem;font-size:0.75rem;color:var(--color-text-secondary)">Lines ${input.offset}${input.limit ? '–' + (input.offset + input.limit) : '+'}</div>` : ''}</div>`;

      case 'Write':
        return `<div class="tool-params">${this.renderFilePath(input.file_path)}${input.content ? this.renderContentPreview(input.content, 'Content') : ''}</div>`;

      case 'Edit': {
        let html = `<div class="tool-params">${this.renderFilePath(input.file_path)}`;
        if (input.old_string || input.new_string) {
          html += `<div class="tool-param-diff" style="margin-top:0.5rem">`;
          if (input.old_string) {
            html += `<div class="diff-header">Remove</div><div class="diff-old">${this.escapeHtml(this.truncateContent(input.old_string, 500))}</div>`;
          }
          if (input.new_string) {
            html += `<div class="diff-header">Add</div><div class="diff-new">${this.escapeHtml(this.truncateContent(input.new_string, 500))}</div>`;
          }
          html += '</div>';
        }
        return html + '</div>';
      }

      case 'Bash': {
        const cmd = input.command || input.commands || '';
        const cmdText = typeof cmd === 'string' ? cmd : JSON.stringify(cmd);
        let html = `<div class="tool-params"><div class="tool-param-command"><span class="prompt-char">$</span><span class="command-text">${this.escapeHtml(cmdText)}</span></div>`;
        if (input.description) html += `<div style="margin-top:0.375rem;font-size:0.75rem;color:var(--color-text-secondary)">${this.escapeHtml(input.description)}</div>`;
        return html + '</div>';
      }

      case 'Glob':
        return `<div class="tool-params"><div class="tool-param-query"><span class="query-icon">&#128193;</span><code style="font-size:0.85rem">${this.escapeHtml(input.pattern || '')}</code></div>${input.path ? `<div style="margin-top:0.25rem;font-size:0.75rem;color:var(--color-text-secondary)">in ${this.escapeHtml(input.path)}</div>` : ''}</div>`;

      case 'Grep':
        return `<div class="tool-params"><div class="tool-param-query"><span class="query-icon">&#128269;</span><code style="font-size:0.85rem">${this.escapeHtml(input.pattern || '')}</code></div>${input.path ? `<div style="margin-top:0.25rem;font-size:0.75rem;color:var(--color-text-secondary)">in ${this.escapeHtml(input.path)}</div>` : ''}${input.glob ? `<div style="margin-top:0.125rem;font-size:0.7rem;color:var(--color-text-secondary)">files: ${this.escapeHtml(input.glob)}</div>` : ''}</div>`;

      case 'WebFetch':
        return `<div class="tool-params"><div class="tool-param-url"><span class="url-icon">&#127760;</span>${this.escapeHtml(input.url || '')}</div>${input.prompt ? `<div style="margin-top:0.375rem;font-size:0.8rem;color:var(--color-text-secondary)">${this.escapeHtml(this.truncateContent(input.prompt, 150))}</div>` : ''}</div>`;

      case 'WebSearch':
        return `<div class="tool-params"><div class="tool-param-query"><span class="query-icon">&#128269;</span><strong style="font-size:0.85rem">${this.escapeHtml(input.query || '')}</strong></div></div>`;

      case 'TodoWrite':
        if (input.todos && Array.isArray(input.todos)) {
          const statusIcons = { completed: '&#9989;', in_progress: '&#9881;', pending: '&#9744;' };
          const items = input.todos.map(t => `<div class="todo-item"><span class="todo-status">${statusIcons[t.status] || '&#9744;'}</span><span class="todo-text">${this.escapeHtml(t.content || '')}</span></div>`).join('');
          return `<div class="tool-params"><div class="tool-param-todos">${items}</div></div>`;
        }
        return this.renderJsonParams(input);

      case 'Task':
        return `<div class="tool-params">${input.description ? `<div style="font-weight:600;font-size:0.85rem;margin-bottom:0.375rem">${this.escapeHtml(input.description)}</div>` : ''}${input.prompt ? `<div style="font-size:0.8rem;color:var(--color-text-secondary);max-height:100px;overflow-y:auto;white-space:pre-wrap;word-break:break-word">${this.escapeHtml(this.truncateContent(input.prompt, 300))}</div>` : ''}${input.subagent_type ? `<div style="margin-top:0.375rem;font-size:0.7rem"><code style="background:var(--color-bg-secondary);padding:0.125rem 0.375rem;border-radius:0.25rem">${this.escapeHtml(input.subagent_type)}</code></div>` : ''}</div>`;

      case 'NotebookEdit':
        return `<div class="tool-params">${this.renderFilePath(input.notebook_path)}${input.new_source ? this.renderContentPreview(input.new_source, 'Cell content') : ''}</div>`;

      default:
        return this.renderJsonParams(input);
    }
  }

  /**
   * Render content preview with truncation
   */
  renderContentPreview(content, label) {
    const maxLen = 500;
    const truncated = content.length > maxLen;
    const displayContent = truncated ? content.substring(0, maxLen) : content;
    const lineCount = content.split('\n').length;
    return `<div class="tool-param-content-preview" style="margin-top:0.5rem"><div class="preview-header"><span>${this.escapeHtml(label)}</span><span style="font-weight:400">${lineCount} lines${truncated ? ' (truncated)' : ''}</span></div><div class="preview-body">${this.escapeHtml(displayContent)}</div>${truncated ? '<div class="preview-truncated">... ' + (content.length - maxLen) + ' more characters</div>' : ''}</div>`;
  }

  /**
   * Render params as formatted JSON (default fallback for unknown tools)
   */
  renderJsonParams(input) {
    return `<div class="tool-params"><div class="tool-param-json"><pre>${this.escapeHtml(JSON.stringify(input, null, 2))}</pre></div></div>`;
  }

  /**
   * Render tool use block with smart parameter display
   */
  renderBlockToolUse(block, context) {
    const div = document.createElement('div');
    div.className = 'block-tool-use';

    const toolName = block.name || 'unknown';
    const input = block.input || {};

    div.innerHTML = `
      <div class="tool-header">
        <span class="tool-icon">${this.getToolIcon(toolName)}</span>
        <span class="tool-name"><code>${this.escapeHtml(toolName)}</code></span>
      </div>
      ${Object.keys(input).length > 0 ? this.renderSmartParams(toolName, input) : ''}
    `;

    return div;
  }

  /**
   * Render tool result block with smart content display
   */
  renderBlockToolResult(block, context) {
    const div = document.createElement('div');
    const isError = block.is_error || false;
    div.className = `block-tool-result ${isError ? 'result-error' : 'result-success'}`;

    const content = block.content || '';
    const contentStr = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    const toolUseId = block.tool_use_id || '';
    const isLong = contentStr.length > 1500;

    const iconSvg = isError
      ? '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/></svg>'
      : '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>';

    const displayContent = isLong ? contentStr.substring(0, 1500) : contentStr;

    div.innerHTML = `
      <div class="result-header">
        <span class="status-label">${iconSvg} ${isError ? 'Error' : 'Success'}</span>
        ${toolUseId ? `<span class="result-id">${this.escapeHtml(toolUseId)}</span>` : ''}
      </div>
      <div class="result-body${isLong ? ' collapsed' : ''}">${this.escapeHtml(displayContent)}</div>
      ${isLong ? '<button class="expand-btn" onclick="this.previousElementSibling.classList.toggle(\'collapsed\');this.textContent=this.textContent===\'Show more\'?\'Show less\':\'Show more\'">Show more</button>' : ''}
    `;

    return div;
  }

  /**
   * Render image block
   */
  renderBlockImage(block, context) {
    const div = document.createElement('div');
    div.className = 'block-image';

    let src = block.image || block.src || '';
    const alt = block.alt || 'Image';

    // Handle base64 data
    if (block.data && block.media_type) {
      src = `data:${block.media_type};base64,${block.data}`;
    }

    div.innerHTML = `
      <img src="${this.escapeHtml(src)}" alt="${this.escapeHtml(alt)}" loading="lazy">
      ${block.alt ? `<div class="image-caption">${this.escapeHtml(alt)}</div>` : ''}
    `;

    return div;
  }

  /**
   * Render bash command block
   */
  renderBlockBash(block, context) {
    const div = document.createElement('div');
    div.className = 'block-bash';

    const command = block.command || block.code || '';
    const output = block.output || '';

    div.innerHTML = `
      <div class="bash-command"><span class="prompt">$</span><code>${this.escapeHtml(command)}</code></div>
      ${output ? `<pre class="bash-output"><code>${this.escapeHtml(output)}</code></pre>` : ''}
    `;

    return div;
  }

  /**
   * Render system event
   */
  renderBlockSystem(block, context) {
    const div = document.createElement('div');
    div.className = 'block-system';

    div.innerHTML = `
      <div class="system-header">Session Information</div>
      <div class="system-body">
        ${block.model ? `<div class="sys-field"><span class="sys-label">Model</span><span class="sys-value"><code>${this.escapeHtml(block.model)}</code></span></div>` : ''}
        ${block.cwd ? `<div class="sys-field"><span class="sys-label">Directory</span><span class="sys-value"><code>${this.escapeHtml(block.cwd)}</code></span></div>` : ''}
        ${block.session_id ? `<div class="sys-field"><span class="sys-label">Session</span><span class="sys-value"><code>${this.escapeHtml(block.session_id)}</code></span></div>` : ''}
        ${block.tools && Array.isArray(block.tools) ? `<div class="sys-field" style="flex-direction:column;gap:0.375rem"><span class="sys-label">Tools (${block.tools.length})</span><div class="tools-list">${block.tools.map(t => `<span class="tool-badge">${this.escapeHtml(t)}</span>`).join('')}</div></div>` : ''}
      </div>
    `;

    return div;
  }

  /**
   * Render result block (execution summary)
   */
  renderBlockResult(block, context) {
    const div = document.createElement('div');
    const isError = block.is_error || false;
    div.className = `block-result ${isError ? 'result-err' : 'result-ok'}`;

    const duration = block.duration_ms ? (block.duration_ms / 1000).toFixed(1) + 's' : '';
    const cost = block.total_cost_usd ? '$' + block.total_cost_usd.toFixed(4) : '';
    const turns = block.num_turns || '';

    div.innerHTML = `
      <div class="result-summary-header">
        ${isError
          ? '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/></svg>'
          : '<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/></svg>'}
        <span class="result-title">${isError ? 'Execution Failed' : 'Execution Complete'}</span>
      </div>
      <div class="result-stats">
        ${duration ? `<div class="result-stat"><span class="stat-icon">&#9202;</span><span class="stat-value">${this.escapeHtml(duration)}</span><span class="stat-label">duration</span></div>` : ''}
        ${cost ? `<div class="result-stat"><span class="stat-icon">&#128176;</span><span class="stat-value">${this.escapeHtml(cost)}</span><span class="stat-label">cost</span></div>` : ''}
        ${turns ? `<div class="result-stat"><span class="stat-icon">&#128260;</span><span class="stat-value">${this.escapeHtml(String(turns))}</span><span class="stat-label">turns</span></div>` : ''}
      </div>
      ${block.result ? `<div class="result-content">${this.escapeHtml(typeof block.result === 'string' ? block.result : JSON.stringify(block.result, null, 2))}</div>` : ''}
    `;

    return div;
  }

  /**
   * Render generic block with formatted key-value pairs
   */
  renderBlockGeneric(block, context) {
    const div = document.createElement('div');
    div.className = 'block-generic';

    // Show key-value pairs instead of raw JSON
    const fieldsHtml = Object.entries(block)
      .filter(([key]) => key !== 'type')
      .map(([key, value]) => {
        let displayValue;
        if (typeof value === 'string') {
          displayValue = value.length > 200 ? value.substring(0, 200) + '...' : value;
        } else if (typeof value === 'number' || typeof value === 'boolean') {
          displayValue = String(value);
        } else {
          displayValue = JSON.stringify(value, null, 2);
          if (displayValue.length > 200) displayValue = displayValue.substring(0, 200) + '...';
        }
        return `<div class="generic-field"><span class="field-key">${this.escapeHtml(key)}:</span><span class="field-value">${this.escapeHtml(displayValue)}</span></div>`;
      }).join('');

    div.innerHTML = `
      <div class="generic-type">${this.escapeHtml(block.type)}</div>
      <div class="generic-fields">${fieldsHtml}</div>
    `;

    return div;
  }

  /**
   * Render block error
   */
  renderBlockError(block, error) {
    const div = document.createElement('div');
    div.className = 'block-error';

    div.innerHTML = `
      <div style="display:flex;align-items:flex-start;gap:0.625rem">
        <svg viewBox="0 0 20 20" fill="currentColor" style="color:#ef4444;flex-shrink:0;margin-top:0.125rem">
          <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clip-rule="evenodd"/>
        </svg>
        <div>
          <div style="font-weight:600;color:#991b1b">Render Error</div>
          <div style="font-size:0.85rem;color:#7f1d1d;margin-top:0.25rem">${this.escapeHtml(error.message)}</div>
        </div>
      </div>
    `;

    return div;
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
    // If there's a block in the progress event, render it beautifully
    if (event.block) {
      return this.renderBlock(event.block, event);
    }

    // Fallback: simple progress indicator
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
   * Render streaming complete event with metadata
   */
  renderStreamingComplete(event) {
    const div = document.createElement('div');
    div.className = 'event-streaming-complete card mb-3 p-4 bg-gradient-to-r from-green-50 to-emerald-50 dark:from-green-950 dark:to-emerald-950 border border-green-200 dark:border-green-800 rounded-lg';
    div.dataset.eventId = event.id || event.sessionId || '';
    div.dataset.eventType = 'streaming_complete';

    const time = new Date(event.timestamp).toLocaleTimeString();
    const eventCount = event.eventCount || 0;

    div.innerHTML = `
      <div class="flex items-start gap-3">
        <div class="flex-shrink-0 mt-0.5">
          <svg class="w-6 h-6 text-green-600 dark:text-green-400 animate-bounce" fill="currentColor" viewBox="0 0 20 20">
            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"></path>
          </svg>
        </div>
        <div class="flex-1">
          <h4 class="font-bold text-lg text-green-900 dark:text-green-200">✨ Execution Complete</h4>
          <div class="mt-2 grid grid-cols-2 gap-3 text-sm">
            <div>
              <span class="text-green-700 dark:text-green-400 font-semibold">${eventCount}</span>
              <span class="text-green-600 dark:text-green-500">events processed</span>
            </div>
            <div class="text-right">
              <span class="text-green-600 dark:text-green-500">${time}</span>
            </div>
          </div>
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
        parts.push({ type: this.isHtmlContent(segment) ? 'html' : 'text', content: segment });
      }
      parts.push({ type: 'code', language: match[1] || 'plain', code: match[2] });
      lastIndex = codeBlockRegex.lastIndex;
    }

    if (lastIndex < text.length) {
      const segment = text.substring(lastIndex);
      parts.push({ type: this.isHtmlContent(segment) ? 'html' : 'text', content: segment });
    }

    if (parts.length === 0) {
      return [{ type: this.isHtmlContent(text) ? 'html' : 'text', content: text }];
    }

    return parts;
  }

  /**
   * Render text block event - for backward compatibility
   */
  renderText(event) {
    const div = document.createElement('div');
    div.className = 'event-text mb-3';
    div.dataset.eventId = event.id || '';
    div.dataset.eventType = 'text_block';

    const text = event.text || event.content || '';
    const parts = this.parseMarkdownCodeBlocks(text);
    let html = '';
    parts.forEach(part => {
      if (part.type === 'html') {
        html += `<div class="html-content bg-white dark:bg-gray-800 p-4 rounded border border-gray-200 dark:border-gray-700 overflow-x-auto mb-3">${part.content}</div>`;
      } else if (part.type === 'text') {
        html += `<div class="p-4 bg-white dark:bg-gray-950 rounded-lg border border-gray-200 dark:border-gray-800 mb-3 leading-relaxed text-sm">${this.parseAndRenderMarkdown(part.content)}</div>`;
      } else if (part.type === 'code') {
        if (part.language.toLowerCase() === 'html') {
          html += `<div class="html-rendered-container mb-3 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-800">
            <div class="html-rendered-label px-4 py-2 bg-blue-100 dark:bg-blue-900 text-xs font-semibold text-blue-900 dark:text-blue-200">Rendered HTML</div>
            <div class="html-content bg-white dark:bg-gray-800 p-4 overflow-x-auto">${part.code}</div>
          </div>`;
        } else {
          html += `<div class="mb-3 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-800">
            <div class="flex items-center justify-between gap-2 bg-gray-900 dark:bg-gray-950 px-4 py-2 border-b border-gray-800">
              <span class="text-xs font-mono text-gray-400 uppercase">${this.escapeHtml(part.language)}</span>
              <button class="copy-code-btn text-gray-400 hover:text-gray-200 transition-colors p-1 rounded hover:bg-gray-800" title="Copy code">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"></path>
                </svg>
              </button>
            </div>
            <pre class="bg-gray-900 text-gray-100 p-4 overflow-x-auto"><code class="language-${this.escapeHtml(part.language)}">${this.escapeHtml(part.code)}</code></pre>
          </div>`;
        }
      }
    });
    div.innerHTML = html;

    // Add copy button functionality
    div.querySelectorAll('.copy-code-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const codeElement = btn.closest('.mb-3')?.querySelector('code');
        if (codeElement) {
          const code = codeElement.textContent;
          navigator.clipboard.writeText(code).then(() => {
            const originalText = btn.innerHTML;
            btn.innerHTML = '<svg class="w-4 h-4 text-green-400" fill="currentColor" viewBox="0 0 20 20"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"></path></svg>';
            setTimeout(() => { btn.innerHTML = originalText; }, 2000);
          });
        }
      });
    });

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
   * Render tool use event - for backward compatibility
   */
  renderToolUse(event) {
    // Use the new block-based renderer for consistency
    const block = {
      type: 'tool_use',
      name: event.toolName || event.tool || 'unknown',
      input: event.input || {}
    };
    const div = this.renderBlockToolUse(block, event);
    div.className = 'event-tool-use mb-3';
    div.dataset.eventId = event.id || '';
    div.dataset.eventType = 'tool_use';
    return div;
  }

  /**
   * Render generic event with formatted key-value pairs
   */
  renderGeneric(event) {
    const div = document.createElement('div');
    div.className = 'event-generic mb-3 p-3 bg-gray-100 dark:bg-gray-800 rounded text-sm';
    div.dataset.eventId = event.id || '';
    div.dataset.eventType = event.type;

    const time = new Date(event.timestamp).toLocaleTimeString();

    // Format event data as key-value pairs
    const fieldsHtml = Object.entries(event)
      .filter(([key]) => !['type', 'timestamp'].includes(key))
      .map(([key, value]) => {
        let displayValue;
        if (typeof value === 'string') {
          displayValue = value.length > 100 ? value.substring(0, 100) + '...' : value;
        } else if (typeof value === 'number' || typeof value === 'boolean') {
          displayValue = String(value);
        } else if (value === null) {
          displayValue = 'null';
        } else {
          displayValue = JSON.stringify(value);
          if (displayValue.length > 100) displayValue = displayValue.substring(0, 100) + '...';
        }
        return `<div style="font-size:0.75rem;margin-bottom:0.25rem"><span style="font-weight:600;color:var(--color-text-secondary)">${this.escapeHtml(key)}:</span> <span style="font-family:'Monaco','Menlo','Ubuntu Mono',monospace">${this.escapeHtml(displayValue)}</span></div>`;
      }).join('');

    div.innerHTML = `
      <div style="display:flex;justify-content:space-between;margin-bottom:0.5rem">
        <span style="font-weight:600;color:var(--color-text-primary)">${this.escapeHtml(event.type)}</span>
        <span style="font-size:0.75rem;color:var(--color-text-secondary)">${time}</span>
      </div>
      <div>${fieldsHtml || '<span style="color:var(--color-text-secondary);font-size:0.75rem">No additional data</span>'}</div>
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
