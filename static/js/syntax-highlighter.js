/**
 * Syntax Highlighter Integration
 * Handles lazy-loading and caching of Prism.js for code highlighting
 */

class SyntaxHighlighter {
  constructor(config = {}) {
    this.config = {
      cdnUrl: config.cdnUrl || 'https://cdn.jsdelivr.net/npm/prismjs@1.29.0',
      lazyLoad: config.lazyLoad !== false,
      enableCache: config.enableCache !== false,
      maxCacheSize: config.maxCacheSize || 500,
      supportedLanguages: config.supportedLanguages || [
        'javascript', 'typescript', 'python', 'java', 'cpp', 'c', 'csharp', 'go', 'rust',
        'php', 'ruby', 'swift', 'kotlin', 'sql', 'html', 'css', 'scss', 'bash', 'shell',
        'json', 'xml', 'yaml', 'markdown', 'plaintext'
      ],
      ...config
    };

    this.isLoaded = false;
    this.isLoading = false;
    this.highlightCache = new Map();
    this.loadPromise = null;
  }

  /**
   * Ensure Prism is loaded
   */
  async ensureLoaded() {
    // Already loaded
    if (typeof Prism !== 'undefined' && this.isLoaded) {
      return true;
    }

    // Currently loading
    if (this.isLoading && this.loadPromise) {
      return this.loadPromise;
    }

    // Start loading
    this.isLoading = true;
    this.loadPromise = this.loadPrism();

    try {
      const result = await this.loadPromise;
      this.isLoaded = true;
      return result;
    } catch (error) {
      console.error('Failed to load Prism:', error);
      this.isLoading = false;
      throw error;
    }
  }

  /**
   * Load Prism library
   */
  async loadPrism() {
    return new Promise((resolve, reject) => {
      try {
        // Load main Prism JS
        const script = document.createElement('script');
        script.src = `${this.config.cdnUrl}/prism.js`;
        script.async = true;

        script.onload = () => {
          // Load common language files
          this.loadLanguages();
          this.isLoading = false;
          resolve(true);
        };

        script.onerror = () => {
          this.isLoading = false;
          reject(new Error('Failed to load Prism.js'));
        };

        document.head.appendChild(script);
      } catch (error) {
        this.isLoading = false;
        reject(error);
      }
    });
  }

  /**
   * Load language files
   */
  loadLanguages() {
    const languages = ['javascript', 'python', 'sql', 'bash', 'json'];

    for (const lang of languages) {
      const script = document.createElement('script');
      script.src = `${this.config.cdnUrl}/components/prism-${lang}.js`;
      script.async = true;
      document.head.appendChild(script);
    }
  }

  /**
   * Highlight code
   */
  async highlight(code, language = 'plaintext') {
    if (!code) return '';

    // Ensure Prism is loaded
    if (this.config.lazyLoad) {
      try {
        await this.ensureLoaded();
      } catch (error) {
        console.warn('Prism loading failed, returning unformatted code');
        return this.escapeHtml(code);
      }
    }

    // Check cache
    const cacheKey = `${language}:${code}`;
    if (this.config.enableCache && this.highlightCache.has(cacheKey)) {
      return this.highlightCache.get(cacheKey);
    }

    // Highlight code
    let highlighted;
    try {
      if (typeof Prism !== 'undefined' && Prism.languages[language]) {
        highlighted = Prism.highlight(code, Prism.languages[language], language);
      } else {
        // Fallback to escaped HTML if language not supported
        highlighted = this.escapeHtml(code);
      }
    } catch (error) {
      console.error('Highlight error:', error);
      highlighted = this.escapeHtml(code);
    }

    // Cache result
    if (this.config.enableCache) {
      this.highlightCache.set(cacheKey, highlighted);

      // Trim cache if too large
      if (this.highlightCache.size > this.config.maxCacheSize) {
        const firstKey = this.highlightCache.keys().next().value;
        this.highlightCache.delete(firstKey);
      }
    }

    return highlighted;
  }

  /**
   * Create highlighted code element
   */
  async createHighlightedElement(code, language = 'plaintext') {
    const pre = document.createElement('pre');
    const code_el = document.createElement('code');

    // Set language class
    code_el.className = `language-${language}`;

    if (this.config.lazyLoad) {
      try {
        await this.ensureLoaded();
        const highlighted = await this.highlight(code, language);
        code_el.innerHTML = highlighted;
      } catch (error) {
        code_el.textContent = code;
      }
    } else {
      code_el.textContent = code;
    }

    pre.appendChild(code_el);
    return pre;
  }

  /**
   * Highlight DOM element
   */
  async highlightElement(element) {
    if (!element || !element.querySelector('code')) return;

    if (this.config.lazyLoad) {
      try {
        await this.ensureLoaded();
      } catch (error) {
        console.warn('Prism loading failed, skipping highlighting');
        return;
      }
    }

    if (typeof Prism !== 'undefined') {
      try {
        Prism.highlightElement(element.querySelector('code'));
      } catch (error) {
        console.error('Element highlighting error:', error);
      }
    }
  }

  /**
   * Detect language from code content
   */
  detectLanguage(code) {
    if (!code) return 'plaintext';

    // Shebang detection
    if (code.startsWith('#!/')) {
      if (code.includes('python')) return 'python';
      if (code.includes('node') || code.includes('node.js')) return 'javascript';
      if (code.includes('bash') || code.includes('sh')) return 'bash';
      if (code.includes('ruby')) return 'ruby';
    }

    // Pattern detection
    if (code.includes('def ') && code.includes(':')) return 'python';
    if (code.includes('function') || code.includes('=>')) return 'javascript';
    if (code.includes('fn ') && code.includes('->')) return 'rust';
    if (code.includes('public static') || code.includes('class ')) return 'java';
    if (code.includes('SELECT') || code.includes('INSERT')) return 'sql';
    if (code.includes('<html') || code.includes('<div')) return 'html';
    if (code.includes('::') && code.includes('use ')) return 'rust';

    return 'plaintext';
  }

  /**
   * Get supported languages
   */
  getSupportedLanguages() {
    return [...this.config.supportedLanguages];
  }

  /**
   * Check if language is supported
   */
  isSupportedLanguage(language) {
    return this.config.supportedLanguages.includes(language);
  }

  /**
   * Clear cache
   */
  clearCache() {
    this.highlightCache.clear();
  }

  /**
   * Get cache stats
   */
  getCacheStats() {
    return {
      size: this.highlightCache.size,
      maxSize: this.config.maxCacheSize
    };
  }

  /**
   * HTML escape utility
   */
  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// Export for use in browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SyntaxHighlighter;
}
