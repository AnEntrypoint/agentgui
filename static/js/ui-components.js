/**
 * UI Components
 * Reusable UI building blocks for modals, tabs, buttons, and more
 */

class UIComponents {
  /**
   * Create a modal dialog
   */
  static createModal(config = {}) {
    const {
      title = 'Dialog',
      content = '',
      buttons = [],
      onClose = null,
      size = 'medium' // small, medium, large
    } = config;

    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.dataset.modal = 'true';

    const sizeClasses = {
      'small': 'max-w-sm',
      'medium': 'max-w-md',
      'large': 'max-w-2xl'
    };

    modal.innerHTML = `
      <div class="modal-content card ${sizeClasses[size] || sizeClasses['medium']}">
        <div class="card-header flex justify-between items-center">
          <h2 class="text-xl font-bold">${UIComponents.escapeHtml(title)}</h2>
          <button class="btn btn-ghost btn-sm modal-close">&times;</button>
        </div>
        <div class="card-body modal-body">
          ${typeof content === 'string' ? UIComponents.escapeHtml(content) : ''}
        </div>
        <div class="card-footer flex gap-2 justify-end">
          ${buttons.map(btn => `
            <button class="btn btn-${btn.variant || 'secondary'}" data-action="${btn.action || 'close'}">
              ${UIComponents.escapeHtml(btn.label)}
            </button>
          `).join('')}
        </div>
      </div>
    `;

    // Add close handler
    const closeBtn = modal.querySelector('.modal-close');
    closeBtn.addEventListener('click', () => {
      modal.remove();
      if (onClose) onClose();
    });

    // Add button handlers
    modal.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const action = e.target.dataset.action;
        if (action === 'close') {
          modal.remove();
          if (onClose) onClose();
        }
      });
    });

    // Close on background click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        modal.remove();
        if (onClose) onClose();
      }
    });

    return modal;
  }

  /**
   * Create a tabbed interface
   */
  static createTabs(config = {}) {
    const {
      tabs = [],
      activeTab = 0,
      onChange = null
    } = config;

    const container = document.createElement('div');
    container.className = 'tabs';

    // Tab buttons
    const tabButtons = document.createElement('div');
    tabButtons.className = 'tab-buttons flex border-b';

    tabs.forEach((tab, index) => {
      const btn = document.createElement('button');
      btn.className = `tab tab-underline tab-button ${index === activeTab ? 'tab-active' : ''}`;
      btn.textContent = tab.label;
      btn.dataset.tabIndex = index;

      btn.addEventListener('click', () => {
        // Update active button
        tabButtons.querySelectorAll('.tab-button').forEach((b, i) => {
          if (i === index) {
            b.classList.add('tab-active');
          } else {
            b.classList.remove('tab-active');
          }
        });

        // Update tab content
        tabContent.querySelectorAll('.tab-pane').forEach((pane, i) => {
          pane.style.display = i === index ? 'block' : 'none';
        });

        if (onChange) onChange(index);
      });

      tabButtons.appendChild(btn);
    });

    container.appendChild(tabButtons);

    // Tab content
    const tabContent = document.createElement('div');
    tabContent.className = 'tab-content mt-4';

    tabs.forEach((tab, index) => {
      const pane = document.createElement('div');
      pane.className = 'tab-pane';
      pane.style.display = index === activeTab ? 'block' : 'none';
      pane.innerHTML = typeof tab.content === 'string' ? tab.content : '';
      tabContent.appendChild(pane);
    });

    container.appendChild(tabContent);
    return container;
  }

  /**
   * Create an alert/notification
   */
  static createAlert(config = {}) {
    const {
      message = '',
      type = 'info', // info, success, warning, error
      duration = 5000,
      dismissible = true
    } = config;

    const alert = document.createElement('div');
    const typeClasses = {
      'info': 'alert-info',
      'success': 'alert-success',
      'warning': 'alert-warning',
      'error': 'alert-error'
    };

    alert.className = `alert ${typeClasses[type] || typeClasses['info']}`;
    alert.innerHTML = `
      <div class="flex justify-between items-center">
        <span>${UIComponents.escapeHtml(message)}</span>
        ${dismissible ? '<button class="text-current hover:opacity-75">&times;</button>' : ''}
      </div>
    `;

    if (dismissible) {
      const closeBtn = alert.querySelector('button');
      closeBtn.addEventListener('click', () => alert.remove());
    }

    if (duration > 0) {
      setTimeout(() => alert.remove(), duration);
    }

    return alert;
  }

  /**
   * Create a loading spinner
   */
  static createSpinner(config = {}) {
    const {
      size = 'medium', // small, medium, large
      text = 'Loading...'
    } = config;

    const sizeClasses = {
      'small': 'spinner-xs',
      'medium': 'spinner-sm',
      'large': 'spinner-md'
    };

    const container = document.createElement('div');
    container.className = 'flex items-center gap-3 justify-center p-4';
    container.innerHTML = `
      <div class="spinner-simple spinner-primary ${sizeClasses[size] || sizeClasses['medium']}"></div>
      <span class="text-base-content">${UIComponents.escapeHtml(text)}</span>
    `;
    return container;
  }

  /**
   * Create a progress bar
   */
  static createProgressBar(config = {}) {
    const {
      percentage = 0,
      label = '',
      showLabel = true
    } = config;

    const container = document.createElement('div');
    container.className = 'progress-container';

    let html = '';
    if (label && showLabel) {
      html += `<div class="flex justify-between mb-2 text-sm"><span>${UIComponents.escapeHtml(label)}</span><span>${Math.round(percentage)}%</span></div>`;
    }

    html += `
      <progress class="progress progress-primary progress-xs w-full" value="${Math.min(100, Math.max(0, percentage))}" max="100"></progress>
    `;

    container.innerHTML = html;
    return container;
  }

  /**
   * Create a collapsible section
   */
  static createCollapsible(config = {}) {
    const {
      title = 'Details',
      content = '',
      isOpen = false
    } = config;

    const container = document.createElement('div');
    container.className = 'collapsible';

    container.innerHTML = `
      <details ${isOpen ? 'open' : ''}>
        <summary class="cursor-pointer font-semibold hover:bg-base-200 px-2 py-1 rounded transition-colors">
          ${UIComponents.escapeHtml(title)}
        </summary>
        <div class="content mt-2 ml-4">
          ${typeof content === 'string' ? content : ''}
        </div>
      </details>
    `;

    return container;
  }

  /**
   * Create a form input
   */
  static createInput(config = {}) {
    const {
      type = 'text',
      name = '',
      label = '',
      placeholder = '',
      value = '',
      required = false
    } = config;

    const container = document.createElement('div');
    container.className = 'form-group mb-4';

    let html = '';
    if (label) {
      html += `<label class="block text-sm font-medium mb-2">${UIComponents.escapeHtml(label)}</label>`;
    }

    html += `
      <input
        type="${type}"
        name="${name}"
        placeholder="${UIComponents.escapeHtml(placeholder)}"
        value="${UIComponents.escapeHtml(value)}"
        ${required ? 'required' : ''}
        class="input input-block input-solid"
      />
    `;

    container.innerHTML = html;
    return container;
  }

  /**
   * Create a select dropdown
   */
  static createSelect(config = {}) {
    const {
      name = '',
      label = '',
      options = [],
      value = '',
      required = false
    } = config;

    const container = document.createElement('div');
    container.className = 'form-group mb-4';

    let html = '';
    if (label) {
      html += `<label class="block text-sm font-medium mb-2">${UIComponents.escapeHtml(label)}</label>`;
    }

    html += `
      <select
        name="${name}"
        ${required ? 'required' : ''}
        class="select select-block select-solid"
      >
        ${options.map(opt => `
          <option value="${opt.value}" ${opt.value === value ? 'selected' : ''}>
            ${UIComponents.escapeHtml(opt.label)}
          </option>
        `).join('')}
      </select>
    `;

    container.innerHTML = html;
    return container;
  }

  /**
   * Create a button group
   */
  static createButtonGroup(config = {}) {
    const {
      buttons = [],
      vertical = false
    } = config;

    const container = document.createElement('div');
    container.className = `button-group flex gap-2 ${vertical ? 'flex-col' : 'flex-row'}`;

    buttons.forEach(btn => {
      const button = document.createElement('button');
      button.className = `btn btn-${btn.variant || 'secondary'} flex-${vertical ? '1' : 'none'}`;
      button.textContent = btn.label;
      if (btn.onClick) {
        button.addEventListener('click', btn.onClick);
      }
      container.appendChild(button);
    });

    return container;
  }

  /**
   * Create a badge/tag
   */
  static createBadge(config = {}) {
    const {
      label = '',
      variant = 'default', // default, primary, success, warning, error
      size = 'medium' // small, medium, large
    } = config;

    const sizeClasses = {
      'small': 'badge-sm',
      'medium': 'badge-md',
      'large': 'badge-lg'
    };

    const variantClasses = {
      'default': 'badge-flat',
      'primary': 'badge-flat-primary',
      'success': 'badge-flat-success',
      'warning': 'badge-flat-warning',
      'error': 'badge-flat-error'
    };

    const badge = document.createElement('span');
    badge.className = `badge ${sizeClasses[size] || sizeClasses['medium']} ${variantClasses[variant] || variantClasses['default']}`;
    badge.textContent = label;
    return badge;
  }

  /**
   * HTML escape utility
   */
  static escapeHtml(text) {
    return window._escHtml(text);
  }

  /**
   * Copy text to clipboard
   */
  static copyToClipboard(text) {
    return navigator.clipboard.writeText(text).catch(err => {
      console.error('Failed to copy:', err);
      return false;
    });
  }

  /**
   * Download data as file
   */
  static downloadFile(data, filename, mimeType = 'text/plain') {
    const blob = new Blob([data], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}

// Export for use in browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = UIComponents;
}
