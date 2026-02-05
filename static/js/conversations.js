/**
 * Conversations Module
 * Manages conversation list sidebar with real-time updates
 */

class ConversationManager {
  constructor() {
    this.conversations = [];
    this.activeId = null;
    this.listEl = document.querySelector('[data-conversation-list]');
    this.emptyEl = document.querySelector('[data-conversation-empty]');
    this.newBtn = document.querySelector('[data-new-conversation]');
    this.sidebarEl = document.querySelector('[data-sidebar]');

    if (!this.listEl) return;

    this.init();
  }

  async init() {
    this.newBtn?.addEventListener('click', () => this.createNew());
    this.loadConversations();
    this.setupWebSocketListener();

    // Auto-refresh every 30 seconds
    setInterval(() => this.loadConversations(), 30000);
  }

  async loadConversations() {
    try {
      const res = await fetch('/gm/api/conversations');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      this.conversations = data.conversations || [];
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

    this.listEl.innerHTML = '';
    this.emptyEl.style.display = 'none';

    // Sort by most recent first
    const sorted = [...this.conversations].sort((a, b) =>
      new Date(b.createdAt || 0) - new Date(a.createdAt || 0)
    );

    sorted.forEach(conv => {
      const item = this.createConversationItem(conv);
      this.listEl.appendChild(item);
    });
  }

  createConversationItem(conv) {
    const li = document.createElement('li');
    li.className = 'conversation-item';
    li.dataset.convId = conv.id;
    if (conv.id === this.activeId) li.classList.add('active');

    const title = conv.title || `Conversation ${conv.id.slice(0, 8)}`;
    const timestamp = conv.created_at ? new Date(conv.created_at).toLocaleDateString() : 'Unknown';
    const agent = conv.agentType || 'unknown';

    li.innerHTML = `
      <div class="conversation-item-title">${this.escapeHtml(title)}</div>
      <div class="conversation-item-meta">${agent} • ${timestamp}</div>
    `;

    li.addEventListener('click', () => this.select(conv.id));
    return li;
  }

  select(convId) {
    this.activeId = convId;

    // Update active indicator
    document.querySelectorAll('.conversation-item').forEach(item => {
      item.classList.remove('active');
    });

    const active = document.querySelector(`[data-conv-id="${convId}"]`);
    if (active) active.classList.add('active');

    // Emit event for client.js to handle
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
    // Add to beginning (most recent)
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
      }
    });
  }

  escapeHtml(text) {
    const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return text.replace(/[&<>"']/g, c => map[c]);
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.conversationManager = new ConversationManager();
  });
} else {
  window.conversationManager = new ConversationManager();
}
