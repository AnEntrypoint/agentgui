/**
 * Conversation History Management
 * Stores and retrieves conversations, drafts, and message history
 * Uses file references instead of binary content for scalability
 */

class ConversationHistory {
  constructor() {
    this.db = null;
    this.currentConversationId = null;
    this.messageCache = [];
    this.contentCache = new Map();
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('gmgui-conversations', 2);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        console.log('✅ Conversation history initialized');
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;

        // Conversations table
        if (!db.objectStoreNames.contains('conversations')) {
          const store = db.createObjectStore('conversations', { keyPath: 'id' });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('agentId', 'agentId', { unique: false });
        }

        // Messages table - stores metadata and text only
        if (!db.objectStoreNames.contains('messages')) {
          const store = db.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
          store.createIndex('conversationId', 'conversationId', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
          store.createIndex('agentId', 'agentId', { unique: false });
        }

        // Drafts table
        if (!db.objectStoreNames.contains('drafts')) {
          const store = db.createObjectStore('drafts', { keyPath: 'id' });
          store.createIndex('conversationId', 'conversationId', { unique: false });
          store.createIndex('status', 'status', { unique: false });
        }

        console.log('✅ Database schema created');
      };
    });
  }

  async startConversation(agentId, metadata = {}) {
    const conversation = {
      id: this.generateId(),
      agentId,
      startedAt: Date.now(),
      endedAt: null,
      messageCount: 0,
      draftCount: 0,
      metadata: {
        ...metadata,
        title: metadata.title || `Chat with ${agentId}`,
      },
    };

    await this.saveConversation(conversation);
    this.currentConversationId = conversation.id;
    this.messageCache = [];

    console.log(`✅ Conversation started: ${conversation.id}`);
    return conversation;
  }

  async saveConversation(conversation) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['conversations'], 'readwrite');
      const store = tx.objectStore('conversations');
      const request = store.put(conversation);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(conversation);
    });
  }

  async addMessage(content, direction = 'out', agentId = null, attachments = []) {
    const message = {
      conversationId: this.currentConversationId,
      content,
      direction, // 'out' for user, 'in' for agent
      agentId: agentId || 'user',
      timestamp: Date.now(),
      metadata: {
        type: 'text',
        edited: false,
      },
      attachments: attachments.map(att => ({
        type: att.type,
        path: att.path,
        mime: att.mime,
        filename: att.filename,
        size: att.size,
      })),
    };

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['messages'], 'readwrite');
      const store = tx.objectStore('messages');
      const request = store.add(message);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        message.id = request.result;
        this.messageCache.push(message);
        resolve(message);
      };
    });
  }

  async getMessages(conversationId, limit = 100) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['messages'], 'readonly');
      const store = tx.objectStore('messages');
      const index = store.index('conversationId');
      const range = IDBKeyRange.only(conversationId);
      const request = index.getAll(range);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const messages = request.result.slice(-limit);
        resolve(messages);
      };
    });
  }

  async createDraft(content, conversationId = null) {
    const draft = {
      id: this.generateId(),
      conversationId: conversationId || this.currentConversationId,
      content,
      status: 'editing', // editing, saved, sent, discarded
      createdAt: Date.now(),
      updatedAt: Date.now(),
      iterations: [
        {
          content,
          timestamp: Date.now(),
          status: 'initial',
        },
      ],
    };

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['drafts'], 'readwrite');
      const store = tx.objectStore('drafts');
      const request = store.put(draft);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        console.log(`✅ Draft created: ${draft.id}`);
        resolve(draft);
      };
    });
  }

  async updateDraft(draftId, content) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['drafts'], 'readwrite');
      const store = tx.objectStore('drafts');
      const getRequest = store.get(draftId);

      getRequest.onerror = () => reject(getRequest.error);
      getRequest.onsuccess = () => {
        const draft = getRequest.result;

        // Add iteration
        draft.iterations.push({
          content,
          timestamp: Date.now(),
          status: 'iteration',
        });

        draft.content = content;
        draft.updatedAt = Date.now();

        const putRequest = store.put(draft);
        putRequest.onerror = () => reject(putRequest.error);
        putRequest.onsuccess = () => resolve(draft);
      };
    });
  }

  async finalizeDraft(draftId, status = 'sent') {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['drafts'], 'readwrite');
      const store = tx.objectStore('drafts');
      const request = store.get(draftId);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const draft = request.result;
        draft.status = status;
        draft.finalizedAt = Date.now();

        const putRequest = store.put(draft);
        putRequest.onerror = () => reject(putRequest.error);
        putRequest.onsuccess = () => resolve(draft);
      };
    });
  }

  async getDrafts(conversationId) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['drafts'], 'readonly');
      const store = tx.objectStore('drafts');
      const index = store.index('conversationId');
      const range = IDBKeyRange.only(conversationId);
      const request = index.getAll(range);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const drafts = request.result.filter((d) => d.status === 'editing');
        resolve(drafts);
      };
    });
  }

  async getConversations(agentId = null, limit = 50) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['conversations'], 'readonly');
      const store = tx.objectStore('conversations');

      let request;
      if (agentId) {
        const index = store.index('agentId');
        request = index.getAll(IDBKeyRange.only(agentId));
      } else {
        request = store.getAll();
      }

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const conversations = request.result
          .sort((a, b) => b.timestamp - a.timestamp)
          .slice(0, limit);
        resolve(conversations);
      };
    });
  }

  async endConversation(conversationId = null) {
    const id = conversationId || this.currentConversationId;

    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['conversations'], 'readwrite');
      const store = tx.objectStore('conversations');
      const request = store.get(id);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const conversation = request.result;
        conversation.endedAt = Date.now();

        const putRequest = store.put(conversation);
        putRequest.onerror = () => reject(putRequest.error);
        putRequest.onsuccess = () => resolve(conversation);
      };
    });
  }

  async deleteConversation(conversationId) {
    return new Promise((resolve, reject) => {
      // Delete conversation
      const tx1 = this.db.transaction(['conversations'], 'readwrite');
      const store1 = tx1.objectStore('conversations');
      const request1 = store1.delete(conversationId);

      request1.onerror = () => reject(request1.error);
      request1.onsuccess = () => {
        // Delete associated messages
        const tx2 = this.db.transaction(['messages'], 'readwrite');
        const store2 = tx2.objectStore('messages');
        const index2 = store2.index('conversationId');
        const request2 = index2.openCursor(IDBKeyRange.only(conversationId));

        request2.onerror = () => reject(request2.error);
        request2.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            resolve();
          }
        };
      };
    });
  }

  async searchMessages(query, conversationId = null) {
    const messages = conversationId
      ? await this.getMessages(conversationId, 1000)
      : this.messageCache;

    const lowerQuery = query.toLowerCase();
    return messages.filter((m) => m.content.toLowerCase().includes(lowerQuery));
  }

  async loadFileReference(reference) {
    if (!reference || !reference.path) {
      return null;
    }

    if (this.contentCache.has(reference.path)) {
      return this.contentCache.get(reference.path);
    }

    try {
      const response = await fetch(reference.path);
      if (!response.ok) {
        console.warn(`Failed to load file reference: ${reference.path}`);
        return null;
      }

      const blob = await response.blob();
      const data = {
        blob,
        url: reference.path,
        mime: reference.mime || response.headers.get('content-type'),
        filename: reference.filename,
        loadedAt: Date.now(),
      };

      this.contentCache.set(reference.path, data);
      return data;
    } catch (error) {
      console.error(`Error loading file reference ${reference.path}:`, error);
      return null;
    }
  }

  createFileReference(path, mime, filename, size = 0) {
    return {
      type: 'file',
      path,
      mime,
      filename,
      size,
      createdAt: Date.now(),
    };
  }

  createScreenshotReference(path, filename) {
    return {
      type: 'screenshot',
      path,
      filename,
      mime: 'image/png',
      createdAt: Date.now(),
    };
  }

  async exportConversation(conversationId) {
    const conversation = await this.getConversation(conversationId);
    const messages = await this.getMessages(conversationId, 10000);

    return {
      conversation,
      messages,
      exportedAt: Date.now(),
    };
  }

  async getConversation(conversationId) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['conversations'], 'readonly');
      const store = tx.objectStore('conversations');
      const request = store.get(conversationId);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
  }

  generateId() {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  getStats() {
    return {
      currentConversationId: this.currentConversationId,
      messageCount: this.messageCache.length,
      hasPendingDrafts: false, // Would check DB
    };
  }
}

// Create and export global instance
window.conversationHistory = new ConversationHistory();
window.conversationHistory.init();

console.log('✅ Conversation history system loaded');
