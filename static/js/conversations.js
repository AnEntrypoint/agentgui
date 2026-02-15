/**
 * Conversations Module
 * Manages conversation list sidebar with real-time updates
 * Includes folder browser for selecting working directory on new conversation
 */

class ConversationManager {
  constructor() {
    this.conversations = [];
    this.activeId = null;
    this.listEl = document.querySelector('[data-conversation-list]');
    this.emptyEl = document.querySelector('[data-conversation-empty]');
    this.newBtn = document.querySelector('[data-new-conversation]');
    this.sidebarEl = document.querySelector('[data-sidebar]');
    this.streamingConversations = new Set();

    this.folderBrowser = {
      modal: null,
      listEl: null,
      breadcrumbEl: null,
      currentPath: '~',
      homePath: '~',
      cwdPath: null,
      homePathReady: null
    };

    if (!this.listEl) return;

    this.init();
  }

  async init() {
    this.newBtn?.addEventListener('click', () => this.openFolderBrowser());
    this.setupDelegatedListeners();
    this.loadConversations();
    this.setupWebSocketListener();
    this.setupFolderBrowser();
    this.setupCloneUI();

    setInterval(() => this.loadConversations(), 30000);
  }

  setupDelegatedListeners() {
    this.listEl.addEventListener('click', (e) => {
      const deleteBtn = e.target.closest('[data-delete-conv]');
      if (deleteBtn) {
        e.stopPropagation();
        const convId = deleteBtn.dataset.deleteConv;
        const conv = this.conversations.find(c => c.id === convId);
        this.confirmDelete(convId, conv?.title || 'Untitled');
        return;
      }
      const item = e.target.closest('[data-conv-id]');
      if (item) {
        this.select(item.dataset.convId);
      }
    });
  }

  setupFolderBrowser() {
    this.folderBrowser.modal = document.getElementById('folderBrowserModal');
    this.folderBrowser.listEl = document.getElementById('folderList');
    this.folderBrowser.breadcrumbEl = document.getElementById('folderBreadcrumb');

    if (!this.folderBrowser.modal) return;

    const closeBtn = this.folderBrowser.modal.querySelector('[data-folder-close]');
    const cancelBtn = this.folderBrowser.modal.querySelector('[data-folder-cancel]');
    const selectBtn = this.folderBrowser.modal.querySelector('[data-folder-select]');

    closeBtn?.addEventListener('click', () => this.closeFolderBrowser());
    cancelBtn?.addEventListener('click', () => this.closeFolderBrowser());
    selectBtn?.addEventListener('click', () => this.confirmFolderSelection());

    this.folderBrowser.modal.addEventListener('click', (e) => {
      if (e.target === this.folderBrowser.modal) this.closeFolderBrowser();
    });

    this.folderBrowser.homePathReady = this.fetchHomePath();
  }

  async fetchHomePath() {
    try {
      const res = await fetch((window.__BASE_URL || '') + '/api/home');
      if (res.ok) {
        const data = await res.json();
        this.folderBrowser.homePath = data.home || '~';
        this.folderBrowser.cwdPath = data.cwd || null;
      }
    } catch (e) {
      console.error('Failed to fetch home path:', e);
    }
  }

  async openFolderBrowser() {
    if (!this.folderBrowser.modal) {
      this.createNew();
      return;
    }
    if (this.folderBrowser.homePathReady) {
      await this.folderBrowser.homePathReady;
    }
    const startPath = this.folderBrowser.cwdPath || '~';
    this.folderBrowser.currentPath = startPath;
    this.folderBrowser.modal.classList.add('visible');
    this.loadFolders(startPath);
  }

  closeFolderBrowser() {
    this.folderBrowser.modal?.classList.remove('visible');
  }

  async loadFolders(dirPath) {
    this.folderBrowser.currentPath = dirPath;
    this.renderBreadcrumb(dirPath);

    if (!this.folderBrowser.listEl) return;
    this.folderBrowser.listEl.innerHTML = '<li class="folder-list-loading">Loading...</li>';

    try {
      const res = await fetch((window.__BASE_URL || '') + '/api/folders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: dirPath })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      const folders = data.folders || [];

      this.folderBrowser.listEl.innerHTML = '';

      if (dirPath !== '~' && dirPath !== '/' && dirPath !== this.folderBrowser.homePath) {
        const parentPath = this.getParentPath(dirPath);
        const upItem = document.createElement('li');
        upItem.className = 'folder-list-item';
        upItem.innerHTML = '<span class="folder-list-item-icon">..</span><span class="folder-list-item-name">Parent Directory</span>';
        upItem.addEventListener('click', () => this.loadFolders(parentPath));
        this.folderBrowser.listEl.appendChild(upItem);
      }

      if (folders.length === 0 && this.folderBrowser.listEl.children.length === 0) {
        this.folderBrowser.listEl.innerHTML = '<li class="folder-list-empty">No subdirectories</li>';
        return;
      }

      for (const folder of folders) {
        const li = document.createElement('li');
        li.className = 'folder-list-item';
        li.innerHTML = `<span class="folder-list-item-icon">&#128193;</span><span class="folder-list-item-name">${this.escapeHtml(folder.name)}</span>`;
        li.addEventListener('click', () => {
          const expandedBase = dirPath === '~' ? this.folderBrowser.homePath : dirPath;
          const newPath = expandedBase + '/' + folder.name;
          this.loadFolders(newPath);
        });
        this.folderBrowser.listEl.appendChild(li);
      }
    } catch (err) {
      console.error('Failed to load folders:', err);
      this.folderBrowser.listEl.innerHTML = `<li class="folder-list-error">Error: ${this.escapeHtml(err.message)}</li>`;
    }
  }

  getParentPath(dirPath) {
    const expanded = dirPath === '~' ? this.folderBrowser.homePath : dirPath;
    const parts = expanded.split('/').filter(Boolean);
    if (parts.length <= 1) return '/';
    parts.pop();
    return '/' + parts.join('/');
  }

  renderBreadcrumb(dirPath) {
    if (!this.folderBrowser.breadcrumbEl) return;

    const expanded = dirPath === '~' ? this.folderBrowser.homePath : dirPath;
    const parts = expanded.split('/').filter(Boolean);

    let html = '';
    html += '<span class="folder-breadcrumb-segment" data-path="/">/ </span>';

    let accumulated = '';
    for (let i = 0; i < parts.length; i++) {
      accumulated += '/' + parts[i];
      const isLast = i === parts.length - 1;
      html += '<span class="folder-breadcrumb-separator">/</span>';
      html += `<span class="folder-breadcrumb-segment${isLast ? '' : ''}" data-path="${this.escapeHtml(accumulated)}">${this.escapeHtml(parts[i])}</span>`;
    }

    this.folderBrowser.breadcrumbEl.innerHTML = html;

    this.folderBrowser.breadcrumbEl.querySelectorAll('.folder-breadcrumb-segment').forEach(seg => {
      seg.addEventListener('click', () => {
        const p = seg.dataset.path;
        if (p) this.loadFolders(p);
      });
    });
  }

  confirmFolderSelection() {
    const currentPath = this.folderBrowser.currentPath;
    const expanded = currentPath === '~' ? this.folderBrowser.homePath : currentPath;
    this.closeFolderBrowser();

    const dirName = expanded.split('/').filter(Boolean).pop() || 'root';
    window.dispatchEvent(new CustomEvent('create-new-conversation', {
      detail: { workingDirectory: expanded, title: dirName }
    }));
  }

  setupCloneUI() {
    this.cloneBtn = document.getElementById('cloneRepoBtn');
    this.cloneBar = document.getElementById('cloneInputBar');
    this.cloneInput = document.getElementById('cloneRepoInput');
    this.cloneGoBtn = document.getElementById('cloneGoBtn');
    this.cloneCancelBtn = document.getElementById('cloneCancelBtn');

    if (!this.cloneBtn || !this.cloneBar) return;

    this.cloneBtn.addEventListener('click', () => this.toggleCloneBar());

    this.cloneCancelBtn?.addEventListener('click', () => this.hideCloneBar());

    this.cloneGoBtn?.addEventListener('click', () => this.performClone());

    this.cloneInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.performClone();
      if (e.key === 'Escape') this.hideCloneBar();
    });
  }

  toggleCloneBar() {
    if (!this.cloneBar) return;
    const visible = this.cloneBar.style.display !== 'none';
    if (visible) {
      this.hideCloneBar();
    } else {
      this.cloneBar.style.display = 'flex';
      this.cloneInput.value = '';
      this.cloneInput.focus();
      this.removeCloneStatus();
    }
  }

  hideCloneBar() {
    if (this.cloneBar) this.cloneBar.style.display = 'none';
    this.removeCloneStatus();
  }

  removeCloneStatus() {
    const existing = this.sidebarEl?.querySelector('.clone-status');
    if (existing) existing.remove();
  }

  showCloneStatus(message, type) {
    this.removeCloneStatus();
    const statusEl = document.createElement('div');
    statusEl.className = `clone-status ${type}`;
    statusEl.textContent = message;
    if (this.cloneBar && this.cloneBar.parentNode) {
      this.cloneBar.parentNode.insertBefore(statusEl, this.cloneBar.nextSibling);
    }
    if (type === 'clone-success' || type === 'clone-error') {
      setTimeout(() => statusEl.remove(), 5000);
    }
  }

  async performClone() {
    const repo = (this.cloneInput?.value || '').trim();
    if (!repo) return;
    if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo)) {
      this.showCloneStatus('Invalid format. Use org/repo', 'clone-error');
      return;
    }

    this.cloneGoBtn.disabled = true;
    this.cloneInput.disabled = true;
    this.showCloneStatus(`Cloning ${repo}...`, 'cloning');

    try {
      const res = await fetch((window.__BASE_URL || '') + '/api/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ repo })
      });

      const data = await res.json();

      if (!res.ok) {
        this.showCloneStatus(data.error || 'Clone failed', 'clone-error');
        return;
      }

      this.showCloneStatus(`Cloned ${data.name}`, 'clone-success');
      this.hideCloneBar();

      window.dispatchEvent(new CustomEvent('create-new-conversation', {
        detail: { workingDirectory: data.path, title: data.name }
      }));
    } catch (err) {
      this.showCloneStatus('Network error: ' + err.message, 'clone-error');
    } finally {
      if (this.cloneGoBtn) this.cloneGoBtn.disabled = false;
      if (this.cloneInput) this.cloneInput.disabled = false;
    }
  }

  async loadConversations() {
    try {
      const res = await fetch((window.__BASE_URL || '') + '/api/conversations');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      this.conversations = data.conversations || [];

      for (const conv of this.conversations) {
        if (conv.isStreaming === 1 || conv.isStreaming === true) {
          this.streamingConversations.add(conv.id);
        } else {
          this.streamingConversations.delete(conv.id);
        }
      }

      this.render();
    } catch (err) {
      console.error('Failed to load conversations:', err);
      this.showEmpty('Failed to load conversations');
    }
  }

  render() {
    if (!this.listEl) return;

    if (this.conversations.length === 0) {
      this.showEmpty();
      return;
    }

    this.emptyEl.style.display = 'none';

    const sorted = [...this.conversations].sort((a, b) =>
      new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
    );

    const existingMap = {};
    for (const child of Array.from(this.listEl.children)) {
      const cid = child.dataset.convId;
      if (cid) existingMap[cid] = child;
    }

    const frag = document.createDocumentFragment();
    for (const conv of sorted) {
      const existing = existingMap[conv.id];
      if (existing) {
        this.updateConversationItem(existing, conv);
        delete existingMap[conv.id];
        frag.appendChild(existing);
      } else {
        frag.appendChild(this.createConversationItem(conv));
      }
    }

    for (const orphan of Object.values(existingMap)) orphan.remove();
    this.listEl.appendChild(frag);
  }

  updateConversationItem(el, conv) {
    const isActive = conv.id === this.activeId;
    el.classList.toggle('active', isActive);

    const isStreaming = this.streamingConversations.has(conv.id);
    const title = conv.title || `Conversation ${conv.id.slice(0, 8)}`;
    const timestamp = conv.created_at ? new Date(conv.created_at).toLocaleDateString() : 'Unknown';
    const agent = conv.agentType || 'unknown';
    const wd = conv.workingDirectory ? conv.workingDirectory.split('/').pop() : '';
    const metaParts = [agent, timestamp];
    if (wd) metaParts.push(wd);

    const titleEl = el.querySelector('.conversation-item-title');
    if (titleEl) {
      const badgeHtml = isStreaming
        ? '<span class="conversation-streaming-badge" title="Streaming in progress"><span class="streaming-dot"></span></span>'
        : '';
      titleEl.innerHTML = `${badgeHtml}${this.escapeHtml(title)}`;
    }

    const metaEl = el.querySelector('.conversation-item-meta');
    if (metaEl) metaEl.textContent = metaParts.join(' \u2022 ');
  }

  createConversationItem(conv) {
    const li = document.createElement('li');
    li.className = 'conversation-item';
    li.dataset.convId = conv.id;
    if (conv.id === this.activeId) li.classList.add('active');

    const isStreaming = this.streamingConversations.has(conv.id);

    const title = conv.title || `Conversation ${conv.id.slice(0, 8)}`;
    const timestamp = conv.created_at ? new Date(conv.created_at).toLocaleDateString() : 'Unknown';
    const agent = conv.agentType || 'unknown';
    const wd = conv.workingDirectory ? conv.workingDirectory.split('/').pop() : '';
    const metaParts = [agent, timestamp];
    if (wd) metaParts.push(wd);

    const streamingBadge = isStreaming
      ? '<span class="conversation-streaming-badge" title="Streaming in progress"><span class="streaming-dot"></span></span>'
      : '';

    li.innerHTML = `
      <div class="conversation-item-content">
        <div class="conversation-item-title">${streamingBadge}${this.escapeHtml(title)}</div>
        <div class="conversation-item-meta">${metaParts.join(' • ')}</div>
      </div>
      <button class="conversation-item-delete" title="Delete conversation" data-delete-conv="${conv.id}">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"></polyline>
          <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
        </svg>
      </button>
    `;

    return li;
  }

  async confirmDelete(convId, title) {
    const confirmed = confirm(`Delete conversation "${title || 'Untitled'}"?\n\nThis will also delete any associated Claude Code session data. This action cannot be undone.`);
    if (!confirmed) return;

    try {
      const res = await fetch((window.__BASE_URL || '') + `/api/conversations/${convId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' }
      });

      if (res.ok) {
        console.log(`[ConversationManager] Deleted conversation ${convId}`);
        // Remove from local list immediately for responsive UI
        this.deleteConversation(convId);
      } else {
        const error = await res.json().catch(() => ({ error: 'Failed to delete' }));
        alert('Failed to delete conversation: ' + (error.error || 'Unknown error'));
      }
    } catch (err) {
      console.error('[ConversationManager] Delete error:', err);
      alert('Failed to delete conversation: ' + err.message);
    }
  }

  select(convId) {
    this.activeId = convId;

    document.querySelectorAll('.conversation-item').forEach(item => {
      item.classList.remove('active');
    });

    const active = document.querySelector(`[data-conv-id="${convId}"]`);
    if (active) active.classList.add('active');

    window.dispatchEvent(new CustomEvent('conversation-selected', {
      detail: { conversationId: convId }
    }));
  }

  createNew() {
    window.dispatchEvent(new CustomEvent('create-new-conversation'));
  }

  showEmpty(message = 'No conversations yet') {
    if (!this.listEl) return;
    this.listEl.innerHTML = '';
    this.emptyEl.textContent = message;
    this.emptyEl.style.display = 'block';
  }

  addConversation(conv) {
    this.conversations.unshift(conv);
    this.render();
  }

  updateConversation(convId, updates) {
    const conv = this.conversations.find(c => c.id === convId);
    if (conv) {
      Object.assign(conv, updates);
      this.render();
    }
  }

  deleteConversation(convId) {
    this.conversations = this.conversations.filter(c => c.id !== convId);
    if (this.activeId === convId) this.activeId = null;
    this.render();
  }

  setupWebSocketListener() {
    window.addEventListener('ws-message', (event) => {
      const msg = event.detail;

      if (msg.type === 'conversation_created') {
        this.addConversation(msg.conversation);
      } else if (msg.type === 'conversation_updated') {
        this.updateConversation(msg.conversation.id, msg.conversation);
      } else if (msg.type === 'conversation_deleted') {
        this.deleteConversation(msg.conversationId);
      } else if (msg.type === 'streaming_start' && msg.conversationId) {
        this.streamingConversations.add(msg.conversationId);
        this.render();
      } else if ((msg.type === 'streaming_complete' || msg.type === 'streaming_error') && msg.conversationId) {
        this.streamingConversations.delete(msg.conversationId);
        this.render();
      }
    });
  }

  escapeHtml(text) {
    return window._escHtml(text);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.conversationManager = new ConversationManager();
  });
} else {
  window.conversationManager = new ConversationManager();
}
