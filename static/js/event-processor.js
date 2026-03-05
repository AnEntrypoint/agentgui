/**
 * Event Processor
 * Transforms, validates, and enriches streaming events
 * Handles ANSI colors, markdown, diffs, and other data transformations
 */

class EventProcessor {
  constructor(config = {}) {
    this.config = {
      enableSyntaxHighlight: config.enableSyntaxHighlight !== false,
      enableMarkdown: config.enableMarkdown !== false,
      enableANSI: config.enableANSI !== false,
      maxContentLength: config.maxContentLength || 100000,
      ...config
    };

    // ANSI color codes mapping
    this.ansiCodes = {
      reset: '\x1b[0m',
      bold: '\x1b[1m',
      dim: '\x1b[2m',
      italic: '\x1b[3m',
      underline: '\x1b[4m',
      blink: '\x1b[5m',
      reverse: '\x1b[7m',
      hidden: '\x1b[8m',
      strikethrough: '\x1b[9m',
      // Foreground colors
      black: '\x1b[30m',
      red: '\x1b[31m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      blue: '\x1b[34m',
      magenta: '\x1b[35m',
      cyan: '\x1b[36m',
      white: '\x1b[37m',
      // Background colors
      bgBlack: '\x1b[40m',
      bgRed: '\x1b[41m',
      bgGreen: '\x1b[42m',
      bgYellow: '\x1b[43m',
      bgBlue: '\x1b[44m',
      bgMagenta: '\x1b[45m',
      bgCyan: '\x1b[46m',
      bgWhite: '\x1b[47m'
    };

    // CSS color mapping
    this.colorMap = {
      '30': '#000000', // black
      '31': '#ff6b6b', // red
      '32': '#51cf66', // green
      '33': '#ffd43b', // yellow
      '34': '#4dabf7', // blue
      '35': '#da77f2', // magenta
      '36': '#20c997', // cyan
      '37': '#ffffff', // white
      '90': '#666666', // bright black
      '91': '#ff8787', // bright red
      '92': '#69db7c', // bright green
      '93': '#ffe066', // bright yellow
      '94': '#74c0fc', // bright blue
      '95': '#e599f7', // bright magenta
      '96': '#38f9d7', // bright cyan
      '97': '#f8f9fa'  // bright white
    };

    // Statistics
    this.stats = {
      totalEvents: 0,
      processedEvents: 0,
      validatedEvents: 0,
      transformedEvents: 0,
      errorCount: 0,
      avgProcessTime: 0
    };
  }

  /**
   * Process and enrich event
   */
  processEvent(event) {
    if (!event || typeof event !== 'object') {
      return null;
    }

    const startTime = performance.now();
    this.stats.totalEvents++;

    try {
      // Validate event structure
      if (!this.validateEvent(event)) {
        this.stats.errorCount++;
        return null;
      }

      this.stats.validatedEvents++;

      // Add processing metadata
      const processed = {
        ...event,
        processedAt: Date.now(),
        processTime: 0
      };

      // Transform event based on type
      if (event.type === 'text_block' || event.type === 'code_block') {
        processed.content = this.transformContent(event.content || '', event.type);
        this.stats.transformedEvents++;
      }

      if (event.type === 'command_execute' && event.output) {
        processed.output = this.transformANSI(event.output);
        this.stats.transformedEvents++;
      }

      if (event.type === 'file_diff' || event.type === 'git_diff') {
        processed.diff = this.transformDiff(event.diff || event.content || '');
        this.stats.transformedEvents++;
      }

      if (event.type === 'file_read' && event.path && this.isImagePath(event.path)) {
        processed.isImage = true;
        processed.imagePath = event.path;
        this.stats.transformedEvents++;
      }

      if ((event.type === 'text_block' || event.type === 'command_execute' || event.type === 'streaming_progress') && event.content || event.output) {
        const imagePaths = this.extractImagePaths(event.content || event.output || '');
        if (imagePaths.length > 0) {
          processed.detectedImages = imagePaths;
          this.stats.transformedEvents++;
        }
      }

      processed.processTime = performance.now() - startTime;
      this.stats.processedEvents++;

      // Update average processing time
      this.stats.avgProcessTime = (this.stats.avgProcessTime * (this.stats.processedEvents - 1) + processed.processTime) / this.stats.processedEvents;

      return processed;
    } catch (error) {
      console.error('Event processing error:', error);
      this.stats.errorCount++;
      return null;
    }
  }

  /**
   * Validate event structure
   */
  validateEvent(event) {
    if (!event.type) {
      return false;
    }

    // Required fields by type
    const typeRequirements = {
      streaming_start: ['sessionId', 'conversationId'],
      streaming_complete: ['sessionId'],
      file_read: ['path'],
      file_write: ['path'],
      command_execute: ['command'],
      git_status: [],
      error: ['message']
    };

    const requirements = typeRequirements[event.type];
    if (requirements) {
      for (const field of requirements) {
        if (!event[field]) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Transform content based on type
   */
  transformContent(content, type) {
    if (typeof content !== 'string') {
      return content;
    }

    if (content.length > this.config.maxContentLength) {
      return content.substring(0, this.config.maxContentLength) + '\n... (truncated)';
    }

    return content;
  }

  /**
   * Transform ANSI escape codes to HTML/CSS
   */
  transformANSI(text) {
    if (!this.config.enableANSI || typeof text !== 'string') {
      return text;
    }

    let result = '';
    let currentStyle = { fg: null, bg: null, bold: false };
    const stack = [];

    // Pattern for ANSI escape sequences
    const pattern = /\x1b\[([0-9;]*?)m/g;
    let lastIndex = 0;
    let match;

    while ((match = pattern.exec(text)) !== null) {
      // Add text before this escape sequence
      if (match.index > lastIndex) {
        const plainText = text.substring(lastIndex, match.index);
        result += this.escapeHtml(plainText);
      }

      // Parse ANSI code
      const codes = match[1].split(';').map(c => parseInt(c, 10));
      for (const code of codes) {
        if (code === 0) {
          // Reset
          currentStyle = { fg: null, bg: null, bold: false };
        } else if (code === 1) {
          currentStyle.bold = true;
        } else if (code >= 30 && code <= 37) {
          currentStyle.fg = this.colorMap[code];
        } else if (code >= 40 && code <= 47) {
          currentStyle.bg = this.colorMap[String(code - 10)];
        } else if (code >= 90 && code <= 97) {
          currentStyle.fg = this.colorMap[code];
        }
      }

      lastIndex = pattern.lastIndex;
    }

    // Add remaining text
    if (lastIndex < text.length) {
      result += this.escapeHtml(text.substring(lastIndex));
    }

    return result;
  }

  /**
   * Transform unified diff format
   */
  transformDiff(diffText) {
    if (typeof diffText !== 'string') {
      return diffText;
    }

    const lines = diffText.split('\n');
    const parsed = {
      headers: [],
      hunks: []
    };

    let currentHunk = null;

    for (const line of lines) {
      if (line.startsWith('---') || line.startsWith('+++')) {
        parsed.headers.push(line);
      } else if (line.startsWith('@@')) {
        if (currentHunk) {
          parsed.hunks.push(currentHunk);
        }
        currentHunk = {
          header: line,
          changes: []
        };
      } else if (currentHunk) {
        if (line.startsWith('-')) {
          currentHunk.changes.push({ type: 'deleted', line: line.substring(1) });
        } else if (line.startsWith('+')) {
          currentHunk.changes.push({ type: 'added', line: line.substring(1) });
        } else if (line.startsWith(' ')) {
          currentHunk.changes.push({ type: 'context', line: line.substring(1) });
        }
      }
    }

    if (currentHunk) {
      parsed.hunks.push(currentHunk);
    }

    return parsed;
  }

  /**
   * Convert markdown to HTML (simple implementation)
   */
  transformMarkdown(markdown) {
    if (!this.config.enableMarkdown || typeof markdown !== 'string') {
      return markdown;
    }

    let html = this.escapeHtml(markdown);

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

    // Code
    html = html.replace(/`(.+?)`/g, '<code>$1</code>');

    // Links
    html = html.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank">$1</a>');

    // Headings
    html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // Line breaks
    html = html.replace(/\n/g, '<br>');

    return html;
  }

  /**
   * Detect language from content or hint
   */
  detectLanguage(content, hint = null) {
    if (hint) {
      return hint.toLowerCase();
    }

    // Simple language detection based on shebang or content patterns
    if (content.startsWith('#!/')) {
      if (content.includes('python')) return 'python';
      if (content.includes('node') || content.includes('javascript')) return 'javascript';
      if (content.includes('bash') || content.includes('sh')) return 'bash';
      if (content.includes('ruby')) return 'ruby';
    }

    // Pattern detection
    if (content.includes('def ') && content.includes(':')) return 'python';
    if (content.includes('function') || content.includes('=>')) return 'javascript';
    if (content.includes('fn ') && content.includes('->')) return 'rust';
    if (content.includes('public static void') || content.includes('class ')) return 'java';

    return 'plaintext';
  }

  /**
   * Parse JSON safely
   */
  parseJSON(jsonStr) {
    try {
      return JSON.parse(jsonStr);
    } catch (e) {
      console.error('JSON parse error:', e);
      return null;
    }
  }

  /**
   * Format JSON for display
   */
  formatJSON(obj, indent = 2) {
    try {
      return JSON.stringify(obj, null, indent);
    } catch (e) {
      return String(obj);
    }
  }

  /**
   * Extract file extension
   */
  getFileExtension(filePath) {
    const match = filePath.match(/\.([^.]+)$/);
    return match ? match[1].toLowerCase() : null;
  }

  /**
   * Determine syntax highlighter language from file extension
   */
  getLanguageFromExtension(ext) {
    const extMap = {
      'js': 'javascript',
      'jsx': 'jsx',
      'ts': 'typescript',
      'tsx': 'typescript',
      'py': 'python',
      'java': 'java',
      'cpp': 'cpp',
      'c': 'c',
      'cs': 'csharp',
      'php': 'php',
      'rb': 'ruby',
      'go': 'go',
      'rs': 'rust',
      'json': 'json',
      'xml': 'xml',
      'html': 'html',
      'css': 'css',
      'scss': 'scss',
      'yaml': 'yaml',
      'yml': 'yaml',
      'sql': 'sql',
      'sh': 'bash',
      'bash': 'bash',
      'zsh': 'bash'
    };

    return extMap[ext?.toLowerCase()] || 'plaintext';
  }

  /**
   * Truncate text with ellipsis
   */
  truncateText(text, maxLength = 200) {
    if (text.length <= maxLength) {
      return text;
    }
    return text.substring(0, maxLength) + '...';
  }

  /**
   * HTML escape utility
   */
  escapeHtml(text) {
    return window._escHtml(text);
  }

  /**
   * Format timestamp
   */
  formatTimestamp(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleTimeString();
  }

  /**
   * Get statistics
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Reset statistics
   */
  resetStats() {
    this.stats = {
      totalEvents: 0,
      processedEvents: 0,
      validatedEvents: 0,
      transformedEvents: 0,
      errorCount: 0,
      avgProcessTime: 0
    };
  }

  /**
   * Check if a path is an image file
   */
  isImagePath(filePath) {
    if (!filePath || typeof filePath !== 'string') return false;
    const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'];
    const ext = this.getFileExtension(filePath);
    return imageExts.includes(ext);
  }

  /**
   * Extract image file paths from text content
   */
  extractImagePaths(content) {
    if (typeof content !== 'string') return [];
    const paths = [];
    const pathPattern = /(?:\/[a-zA-Z0-9_.\-]+)+\/[a-zA-Z0-9_.\-]+\.(?:png|jpg|jpeg|gif|webp|svg)/gi;
    let match;
    while ((match = pathPattern.exec(content)) !== null) {
      if (this.isImagePath(match[0])) {
        paths.push(match[0]);
      }
    }
    return [...new Set(paths)];
  }
}

// Export for use in browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = EventProcessor;
}
