/**
 * WebSocket Manager
 * Handles WebSocket connection, auto-reconnect, message buffering,
 * and event distribution for streaming events
 */

class WebSocketManager {
  constructor(config = {}) {
    // Configuration
    this.config = {
      url: config.url || this.getWebSocketURL(),
      reconnectDelays: config.reconnectDelays || [1000, 2000, 4000, 8000, 16000],
      maxReconnectDelay: config.maxReconnectDelay || 30000,
      heartbeatInterval: config.heartbeatInterval || 30000,
      messageTimeout: config.messageTimeout || 60000,
      maxBufferedMessages: config.maxBufferedMessages || 1000,
      ...config
    };

    // State
    this.ws = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.reconnectCount = 0;
    this.messageBuffer = [];
    this.requestMap = new Map();
    this.heartbeatTimer = null;
    this.connectionState = 'disconnected';

    // Statistics
    this.stats = {
      totalConnections: 0,
      totalReconnects: 0,
      totalMessagesSent: 0,
      totalMessagesReceived: 0,
      totalErrors: 0,
      totalTimeouts: 0,
      avgLatency: 0,
      lastConnectedTime: null,
      connectionDuration: 0
    };

    // Event listeners
    this.listeners = {};
  }

  /**
   * Get WebSocket URL from current window location
   */
  getWebSocketURL() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const baseURL = window.__BASE_URL || '/gm';
    return `${protocol}//${window.location.host}${baseURL}/sync`;
  }

  /**
   * Connect to WebSocket server
   */
  async connect() {
    if (this.isConnected || this.isConnecting) {
      return this.ws;
    }

    this.isConnecting = true;
    this.setConnectionState('connecting');

    try {
      console.log('WebSocket connecting to:', this.config.url);

      this.ws = new WebSocket(this.config.url);

      this.ws.onopen = () => this.onOpen();
      this.ws.onmessage = (event) => this.onMessage(event);
      this.ws.onerror = (error) => this.onError(error);
      this.ws.onclose = () => this.onClose();

      // Wait for connection with timeout
      return await this.waitForConnection(this.config.messageTimeout);
    } catch (error) {
      console.error('WebSocket connection error:', error);
      this.isConnecting = false;
      this.stats.totalErrors++;
      await this.scheduleReconnect();
      throw error;
    }
  }

  /**
   * Wait for connection to establish
   */
  waitForConnection(timeout = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('WebSocket connection timeout'));
      }, timeout);

      const checkConnection = () => {
        if (this.isConnected) {
          clearTimeout(timer);
          resolve(this.ws);
        } else if (this.ws?.readyState === WebSocket.OPEN) {
          clearTimeout(timer);
          resolve(this.ws);
        } else {
          setTimeout(checkConnection, 50);
        }
      };

      checkConnection();
    });
  }

  /**
   * Handle WebSocket open
   */
  onOpen() {
    console.log('WebSocket connected');
    this.isConnected = true;
    this.isConnecting = false;
    this.reconnectCount = 0;
    this.stats.totalConnections++;
    this.stats.lastConnectedTime = Date.now();
    this.setConnectionState('connected');

    // Flush buffered messages
    this.flushMessageBuffer();

    // Start heartbeat
    this.startHeartbeat();

    // Emit connected event
    this.emit('connected', { timestamp: Date.now() });
  }

  /**
   * Handle WebSocket message
   */
  onMessage(event) {
    try {
      const parsed = JSON.parse(event.data);
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      this.stats.totalMessagesReceived += messages.length;

      for (const data of messages) {
        if (data.type === 'pong') {
          const requestId = data.requestId;
          if (requestId && this.requestMap.has(requestId)) {
            const request = this.requestMap.get(requestId);
            request.resolve({ latency: Date.now() - request.sentTime });
            this.requestMap.delete(requestId);
          }
          continue;
        }

        this.emit('message', data);
        if (data.type) this.emit(`message:${data.type}`, data);
      }
    } catch (error) {
      console.error('WebSocket message parse error:', error);
      this.stats.totalErrors++;
    }
  }

  /**
   * Handle WebSocket error
   */
  onError(error) {
    console.error('WebSocket error:', error);
    this.stats.totalErrors++;
    this.emit('error', { error, timestamp: Date.now() });
  }

  /**
   * Handle WebSocket close
   */
  onClose() {
    console.log('WebSocket disconnected');
    this.isConnected = false;
    this.isConnecting = false;
    this.setConnectionState('disconnected');

    // Stop heartbeat
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
    }

    // Update connection duration
    if (this.stats.lastConnectedTime) {
      this.stats.connectionDuration = Date.now() - this.stats.lastConnectedTime;
    }

    this.emit('disconnected', { timestamp: Date.now() });

    // Attempt reconnect
    if (!this.isManuallyDisconnected) {
      this.scheduleReconnect();
    }
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  async scheduleReconnect() {
    if (this.reconnectCount >= this.config.reconnectDelays.length) {
      this.setConnectionState('reconnect_failed');
      console.error('Max reconnection attempts reached');
      this.emit('reconnect_failed', { attempts: this.reconnectCount });
      return;
    }

    const delay = this.config.reconnectDelays[this.reconnectCount];
    this.reconnectCount++;
    this.stats.totalReconnects++;
    this.setConnectionState('reconnecting');

    console.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectCount}/${this.config.reconnectDelays.length})`);

    this.emit('reconnecting', { delay, attempt: this.reconnectCount });

    return new Promise((resolve) => {
      setTimeout(() => {
        this.connect().catch((error) => {
          console.error('Reconnection attempt failed:', error);
        });
        resolve();
      }, delay);
    });
  }

  /**
   * Start heartbeat/keepalive
   */
  startHeartbeat() {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
  }

  /**
   * Send ping message
   */
  ping() {
    const requestId = `ping-${Date.now()}-${Math.random()}`;
    const request = {
      sentTime: Date.now(),
      resolve: null
    };

    const promise = new Promise((resolve) => {
      request.resolve = resolve;
    });

    this.requestMap.set(requestId, request);

    // Timeout if no response
    setTimeout(() => {
      if (this.requestMap.has(requestId)) {
        this.stats.totalTimeouts++;
        this.requestMap.delete(requestId);
        this.emit('ping_timeout', { requestId });
      }
    }, 5000);

    this.sendMessage({ type: 'ping', requestId });
    return promise;
  }

  /**
   * Send message through WebSocket
   */
  sendMessage(data) {
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid message data');
    }

    if (!this.isConnected) {
      // Buffer message if not connected
      this.bufferMessage(data);
      return false;
    }

    try {
      this.ws.send(JSON.stringify(data));
      this.stats.totalMessagesSent++;
      return true;
    } catch (error) {
      console.error('WebSocket send error:', error);
      this.stats.totalErrors++;
      this.bufferMessage(data);
      return false;
    }
  }

  /**
   * Buffer message for sending when connected
   */
  bufferMessage(data) {
    if (this.messageBuffer.length >= this.config.maxBufferedMessages) {
      console.warn('Message buffer full, dropping oldest message');
      this.messageBuffer.shift();
    }
    this.messageBuffer.push(data);
    this.emit('message_buffered', { bufferLength: this.messageBuffer.length });
  }

  /**
   * Flush buffered messages
   */
  flushMessageBuffer() {
    if (this.messageBuffer.length === 0) return;

    console.log(`Flushing ${this.messageBuffer.length} buffered messages`);
    const messages = [...this.messageBuffer];
    this.messageBuffer = [];

    for (const message of messages) {
      try {
        this.ws.send(JSON.stringify(message));
        this.stats.totalMessagesSent++;
      } catch (error) {
        console.error('Error sending buffered message:', error);
        this.bufferMessage(message);
      }
    }

    this.emit('buffer_flushed', { count: messages.length });
  }

  /**
   * Subscribe to streaming session
   */
  subscribeToSession(sessionId) {
    return this.sendMessage({
      type: 'subscribe',
      sessionId,
      timestamp: Date.now()
    });
  }

  /**
   * Unsubscribe from streaming session
   */
  unsubscribeFromSession(sessionId) {
    return this.sendMessage({
      type: 'unsubscribe',
      sessionId,
      timestamp: Date.now()
    });
  }

  /**
   * Request session history
   */
  requestSessionHistory(sessionId, limit = 1000, offset = 0) {
    return new Promise((resolve, reject) => {
      const requestId = `history-${Date.now()}-${Math.random()}`;

      const timeout = setTimeout(() => {
        this.requestMap.delete(requestId);
        this.stats.totalTimeouts++;
        reject(new Error('History request timeout'));
      }, this.config.messageTimeout);

      this.requestMap.set(requestId, {
        type: 'history',
        resolve: (data) => {
          clearTimeout(timeout);
          resolve(data);
        },
        reject
      });

      this.sendMessage({
        type: 'request_history',
        requestId,
        sessionId,
        limit,
        offset,
        timestamp: Date.now()
      });
    });
  }

  /**
   * Set connection state
   */
  setConnectionState(state) {
    this.connectionState = state;
    this.emit('state_change', { state, timestamp: Date.now() });
  }

  /**
   * Disconnect manually
   */
  disconnect() {
    this.isManuallyDisconnected = true;
    this.reconnectCount = 0;

    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
    }

    if (this.ws) {
      this.ws.close();
    }

    this.messageBuffer = [];
    this.requestMap.clear();
    this.setConnectionState('disconnected');
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      isConnected: this.isConnected,
      isConnecting: this.isConnecting,
      connectionState: this.connectionState,
      reconnectCount: this.reconnectCount,
      bufferLength: this.messageBuffer.length,
      stats: { ...this.stats }
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
   * Remove event listener
   */
  off(event, callback) {
    if (!this.listeners[event]) return;
    const index = this.listeners[event].indexOf(callback);
    if (index > -1) {
      this.listeners[event].splice(index, 1);
    }
  }

  /**
   * Emit event
   */
  emit(event, data) {
    if (!this.listeners[event]) return;
    this.listeners[event].forEach((callback) => {
      try {
        callback(data);
      } catch (error) {
        console.error(`Listener error for event ${event}:`, error);
      }
    });
  }

  /**
   * Cleanup resources
   */
  destroy() {
    this.disconnect();
    this.listeners = {};
  }
}

// Export for use in browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = WebSocketManager;
}
