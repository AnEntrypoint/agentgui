/**
 * Image Loader Module
 * Detects image file reads from agent events and manages lazy loading
 * Supports PNG, JPG, JPEG, GIF, WebP, SVG formats
 */

class ImageLoader {
  constructor(config = {}) {
    this.config = {
      supportedExts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'],
      lazyLoadThreshold: config.lazyLoadThreshold || 0.5,
      maxImageDisplaySize: config.maxImageDisplaySize || '600px',
      ...config
    };

    this.imageCache = new Map();
    this.pendingImages = new Map();
    this.intersectionObserver = null;
    this.drawerObserver = null;
    this.initIntersectionObserver();
  }

  /**
   * Check if a path is an image file
   */
  isImagePath(filePath) {
    if (!filePath || typeof filePath !== 'string') return false;
    const ext = this.getExtension(filePath).toLowerCase();
    return this.config.supportedExts.includes(ext);
  }

  /**
   * Extract file extension from path
   */
  getExtension(filePath) {
    const match = filePath.match(/\.([^.]+)$/);
    return match ? match[1] : '';
  }

  /**
   * Extract image paths from text content
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

  /**
   * Register images from event
   */
  registerImagesFromEvent(event) {
    const images = [];

    if (event.type === 'file_read' && event.path && this.isImagePath(event.path)) {
      images.push({
        path: event.path,
        type: 'file_read',
        eventId: event.id || event.sessionId,
        timestamp: event.timestamp || Date.now()
      });
    }

    if (event.content && typeof event.content === 'string') {
      const paths = this.extractImagePaths(event.content);
      paths.forEach(path => {
        images.push({
          path,
          type: 'extracted',
          eventId: event.id || event.sessionId,
          timestamp: event.timestamp || Date.now()
        });
      });
    }

    if (event.output && typeof event.output === 'string') {
      const paths = this.extractImagePaths(event.output);
      paths.forEach(path => {
        images.push({
          path,
          type: 'extracted',
          eventId: event.id || event.sessionId,
          timestamp: event.timestamp || Date.now()
        });
      });
    }

    images.forEach(img => {
      const key = img.path;
      if (!this.imageCache.has(key)) {
        this.imageCache.set(key, img);
        this.pendingImages.set(key, img);
      }
    });

    return images;
  }

  /**
   * Create image element with lazy loading
   */
  createImageElement(imagePath, options = {}) {
    const container = document.createElement('div');
    container.className = 'image-container';
    container.dataset.imagePath = imagePath;
    container.style.cssText = `
      display: flex;
      flex-direction: column;
      gap: 0.5rem;
      padding: 0.75rem;
      border-radius: 0.375rem;
      background: var(--color-bg-secondary);
      border: 1px solid var(--color-border);
    `;

    const placeholder = document.createElement('div');
    placeholder.className = 'image-placeholder';
    placeholder.style.cssText = `
      background: linear-gradient(90deg, var(--color-bg-tertiary) 25%, var(--color-bg-secondary) 50%, var(--color-bg-tertiary) 75%);
      background-size: 200% 100%;
      animation: loading 1.5s infinite;
      border-radius: 0.375rem;
      aspect-ratio: 16/9;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--color-text-secondary);
      font-size: 0.875rem;
    `;
    placeholder.innerHTML = 'Loading image...';
    placeholder.dataset.path = imagePath;

    const img = document.createElement('img');
    img.className = 'lazy-image';
    img.alt = imagePath;
    img.style.cssText = `
      max-width: 100%;
      max-height: ${this.config.maxImageDisplaySize};
      border-radius: 0.375rem;
      display: none;
    `;
    img.dataset.src = imagePath;

    const caption = document.createElement('div');
    caption.className = 'image-caption';
    caption.style.cssText = `
      font-size: 0.75rem;
      color: var(--color-text-secondary);
      word-break: break-all;
      font-family: 'Monaco', 'Menlo', monospace;
    `;
    caption.textContent = imagePath;

    container.appendChild(placeholder);
    container.appendChild(img);
    container.appendChild(caption);

    img.addEventListener('load', () => {
      placeholder.style.display = 'none';
      img.style.display = 'block';
    });

    img.addEventListener('error', () => {
      placeholder.textContent = 'Failed to load image';
      placeholder.style.background = 'var(--color-bg-error)';
      placeholder.style.color = 'var(--color-text-error)';
    });

    if (this.intersectionObserver) {
      this.intersectionObserver.observe(container);
    }

    return container;
  }

  /**
   * Initialize Intersection Observer for lazy loading
   */
  initIntersectionObserver() {
    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const img = entry.target.querySelector('img.lazy-image');
            if (img && img.dataset.src && !img.src) {
              img.src = img.dataset.src;
              this.intersectionObserver.unobserve(entry.target);
            }
          }
        });
      },
      { threshold: this.config.lazyLoadThreshold }
    );
  }

  /**
   * Setup drawer observer to load images when drawer opens
   */
  setupDrawerObserver(drawerSelector = '.drawer-panel, [role="dialog"]') {
    const drawers = document.querySelectorAll(drawerSelector);
    drawers.forEach(drawer => {
      const observer = new MutationObserver(() => {
        if (drawer.offsetHeight > 0 && drawer.offsetWidth > 0) {
          this.loadVisibleImages(drawer);
        }
      });

      observer.observe(drawer, { attributes: true, attributeFilter: ['style', 'class'] });
    });
  }

  /**
   * Load all visible images in a container
   */
  loadVisibleImages(container = document) {
    const images = container.querySelectorAll('img.lazy-image[data-src]');
    images.forEach(img => {
      if (!img.src && img.dataset.src) {
        img.src = img.dataset.src;
      }
    });
  }

  /**
   * Get cached images for a session/conversation
   */
  getImages(eventId = null) {
    if (!eventId) {
      return Array.from(this.imageCache.values());
    }
    return Array.from(this.imageCache.values()).filter(img => img.eventId === eventId);
  }

  /**
   * Clear cache
   */
  clear() {
    this.imageCache.clear();
    this.pendingImages.clear();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ImageLoader;
}
