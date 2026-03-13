// codec is loaded as ES module and exposed globally by ws-client.js
// or inline: import('./codec.js').then(m => window._codec = m)

class WebSocketManager {
  constructor(config = {}) {
    this.config = {
      url: config.url || this.getWebSocketURL(),
      reconnectDelays: config.reconnectDelays || [500, 1000, 2000, 4000, 8000, 15000, 30000],
      maxReconnectDelay: config.maxReconnectDelay || 30000,
      heartbeatInterval: config.heartbeatInterval || 15000,
      messageTimeout: config.messageTimeout || 60000,
      maxBufferedMessages: config.maxBufferedMessages || 1000,
      pongTimeout: config.pongTimeout || 5000,
      latencyWindowSize: config.latencyWindowSize || 10,
      ...config
    };

    this.ws = null;
    this.isConnected = false;
    this.isConnecting = false;
    this.isManuallyDisconnected = false;
    this.reconnectCount = 0;
    this.reconnectTimer = null;
    this.messageBuffer = [];
    this.requestMap = new Map();
    this.heartbeatTimer = null;
    this.connectionState = 'disconnected';
    this.activeSubscriptions = new Set();
    this.connectionEstablishedAt = 0;
    this.cachedVoiceList = null;
    this.voiceListListeners = [];

    this.latency = {
      samples: [],
      current: 0,
      avg: 0,
      jitter: 0,
      quality: 'unknown',
      predicted: 0,
      predictedNext: 0,
      trend: 'stable',
      missedPongs: 0,
      pingCounter: 0
    };

    this._latencyEma = null; // exponential moving average for latency
    this._trendHistory = [];
    this._trendCount = 0;
    this._reconnectedAt = 0;

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

    this.lastSeqBySession = {};
    this.listeners = {};

    this._onVisibilityChange = this._handleVisibilityChange.bind(this);
    this._onOnline = this._handleOnline.bind(this);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onVisibilityChange);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this._onOnline);
    }
  }

  getWebSocketURL() {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const baseURL = window.__BASE_URL || '/gm';
    return `${protocol}//${window.location.host}${baseURL}/sync`;
  }

  async connect() {
    if (this.isConnected || this.isConnecting) return this.ws;
    this.isManuallyDisconnected = false;
    this.isConnecting = true;
    this.setConnectionState('connecting');

    try {
      this.ws = new WebSocket(this.config.url);
      this.ws.binaryType = 'arraybuffer';
      this.ws.onopen = () => this.onOpen();
      this.ws.onmessage = (event) => this.onMessage(event);
      this.ws.onerror = (error) => this.onError(error);
      this.ws.onclose = () => this.onClose();
      return await this.waitForConnection(this.config.messageTimeout);
    } catch (error) {
      this.isConnecting = false;
      this.stats.totalErrors++;
      this.scheduleReconnect();
      throw error;
    }
  }

  waitForConnection(timeout = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket connection timeout')), timeout);
      const check = () => {
        if (this.isConnected || this.ws?.readyState === WebSocket.OPEN) {
          clearTimeout(timer);
          resolve(this.ws);
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  }

  onOpen() {
    this.isConnected = true;
    this.isConnecting = false;
    this.connectionEstablishedAt = Date.now();
    this._reconnectedAt = this.stats.totalConnections > 0 ? Date.now() : 0;
    this.stats.totalConnections++;
    this.stats.lastConnectedTime = Date.now();
    this.latency.missedPongs = 0;
    this.setConnectionState('connected');

    this.flushMessageBuffer();
    this.resubscribeAll();
    this.startHeartbeat();

    this.emit('connected', { timestamp: Date.now() });
  }

  async onMessage(event) {
    try {
      let parsed;
      const buf = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
      parsed = window._codec ? window._codec.decode(buf) : msgpackr.unpack(new Uint8Array(buf));
      const messages = Array.isArray(parsed) ? parsed : [parsed];
      this.stats.totalMessagesReceived += messages.length;

      for (const data of messages) {
        if (data.type === 'pong') {
          this._handlePong(data);
          continue;
        }

        if (data.type === 'voice_list') {
          this.cachedVoiceList = data.voices || [];
          for (const listener of this.voiceListListeners) {
            try { listener(this.cachedVoiceList); } catch (_) {}
          }
        }

        if (data.seq !== undefined && data.sessionId) {
          this.lastSeqBySession[data.sessionId] = Math.max(
            this.lastSeqBySession[data.sessionId] || -1, data.seq
          );
        }

        // RPC reply envelopes — emit for WsClient to intercept, then skip broadcast
        if (data.r !== undefined && !data.type) {
          this.emit('message', data);
          continue;
        }
        this.emit('message', data);
        if (data.type) this.emit('message:' + data.type, data);
      }
    } catch (error) {
      this.stats.totalErrors++;
    }
  }

  _handlePong(data) {
    this.latency.missedPongs = 0;
    const requestId = data.requestId;
    if (requestId && this.requestMap.has(requestId)) {
      const request = this.requestMap.get(requestId);
      const rtt = Date.now() - request.sentTime;
      this.requestMap.delete(requestId);
      this._recordLatency(rtt);
      if (request.resolve) request.resolve({ latency: rtt });
    }
  }

  _recordLatency(rtt) {
    const samples = this.latency.samples;
    samples.push(rtt);
    if (samples.length > this.config.latencyWindowSize) samples.shift();

    this.latency.current = rtt;

    // EMA smoothing (α=0.2 → slow adaptation, less noise)
    const alpha = 0.2;
    this._latencyEma = this._latencyEma === null ? rtt : alpha * rtt + (1 - alpha) * this._latencyEma;
    this.latency.avg = this._latencyEma;
    this.latency.predicted = this._latencyEma;
    this.latency.predictedNext = this._latencyEma;

    if (samples.length > 1) {
      const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
      const variance = samples.reduce((sum, s) => sum + Math.pow(s - mean, 2), 0) / samples.length;
      this.latency.jitter = Math.sqrt(variance);
    }

    this._trendHistory.push(this.latency.predicted);
    if (this._trendHistory.length > 3) this._trendHistory.shift();
    if (this._trendHistory.length >= 3) {
      const [a, b, c] = this._trendHistory;
      const rising = b > a * 1.05 && c > b * 1.05;
      const falling = b < a * 0.95 && c < b * 0.95;
      this.latency.trend = rising ? 'rising' : falling ? 'falling' : 'stable';
    }

    this.latency.quality = this._qualityTier(this.latency.avg);
    this.stats.avgLatency = this.latency.avg;

    this.emit('latency_update', {
      latency: rtt,
      avg: this.latency.avg,
      predicted: this.latency.predicted,
      predictedNext: this.latency.predictedNext,
      trend: this.latency.trend,
      jitter: this.latency.jitter,
      quality: this.latency.quality
    });

    if (rtt > this.latency.avg * 3 && samples.length >= 3) {
      this.emit('latency_spike', { latency: rtt, avg: this.latency.avg });
    }

    this.emit('latency_prediction', {
      predicted: this.latency.predicted,
      predictedNext: this.latency.predictedNext,
      trend: this.latency.trend,
      gain: 0
    });

    this._checkDegradation();
  }

  _checkDegradation() {
    if (this.latency.trend === 'rising') {
      this._trendCount = (this._trendCount || 0) + 1;
    } else {
      if (this._trendCount >= 5 && (this.latency.trend === 'stable' || this.latency.trend === 'falling')) {
        this.emit('connection_recovering', { currentTier: this.latency.quality });
      }
      this._trendCount = 0;
      return;
    }
    if (this._trendCount < 5) return;
    const currentTier = this.latency.quality;
    const predictedTier = this._qualityTier(this.latency.predictedNext);
    if (predictedTier === currentTier) return;
    const thresholds = { excellent: 50, good: 150, fair: 300, poor: 500 };
    const threshold = thresholds[currentTier];
    if (!threshold) return;
    const rate = this._trendHistory.length >= 2 ? this._trendHistory[this._trendHistory.length - 1] - this._trendHistory[0] : 0;
    const timeToChange = rate > 0 ? Math.round((threshold - this.latency.predicted) / rate * 1000) : Infinity;
    this.emit('connection_degrading', { currentTier, predictedTier, predictedLatency: this.latency.predictedNext, timeToChange });
  }

  _qualityTier(avg) {
    if (avg < 50) return 'excellent';
    if (avg < 150) return 'good';
    if (avg < 300) return 'fair';
    if (avg < 500) return 'poor';
    return 'bad';
  }

  onError(error) {
    this.stats.totalErrors++;
    this.emit('error', { error, timestamp: Date.now() });
  }

  onClose() {
    this.isConnected = false;
    this.isConnecting = false;
    this.setConnectionState('disconnected');
    this.stopHeartbeat();

    if (this.stats.lastConnectedTime) {
      this.stats.connectionDuration = Date.now() - this.stats.lastConnectedTime;
    }

    this.emit('disconnected', { timestamp: Date.now() });

    if (!this.isManuallyDisconnected) {
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.isManuallyDisconnected) return;
    if (this.reconnectTimer) return;

    const delays = this.config.reconnectDelays;
    const baseDelay = this.reconnectCount < delays.length
      ? delays[this.reconnectCount]
      : this.config.maxReconnectDelay;

    const jitter = Math.random() * 0.3 * baseDelay;
    const delay = Math.round(baseDelay + jitter);

    this.reconnectCount++;
    this.stats.totalReconnects++;
    this.setConnectionState('reconnecting');

    this.emit('reconnecting', {
      delay,
      attempt: this.reconnectCount,
      nextAttemptAt: Date.now() + delay
    });

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {});
    }, delay);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    const tick = () => {
      if (!this.isConnected) return;
      if (typeof document !== 'undefined' && document.hidden) {
        this.heartbeatTimer = setTimeout(tick, this.config.heartbeatInterval);
        return;
      }
      this.latency.pingCounter++;
      this.ping().catch(() => {
        this.latency.missedPongs++;
        if (this.latency.missedPongs >= 3) {
          this.latency.missedPongs = 0;
          if (this.ws) {
            try { this.ws.close(); } catch (_) {}
          }
        }
      });
      if (this.latency.pingCounter % 10 === 0) {
        this._reportLatency();
      }
      this.heartbeatTimer = setTimeout(tick, this.config.heartbeatInterval);
    };
    this.heartbeatTimer = setTimeout(tick, this.config.heartbeatInterval);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  _reportLatency() {
    if (this.latency.avg > 0) {
      this.sendMessage({
        type: 'latency_report',
        avg: Math.round(this.latency.avg),
        jitter: Math.round(this.latency.jitter),
        quality: this.latency.quality,
        trend: this.latency.trend,
        predictedNext: Math.round(this.latency.predictedNext)
      });
    }
  }

  _handleVisibilityChange() {
    if (typeof document !== 'undefined' && document.hidden) {
      this._hiddenAt = Date.now();
      return;
    }
    if (this._hiddenAt && Date.now() - this._hiddenAt > 30000) {
      this._latencyEma = null;
      this._trendHistory = [];
      this.latency.trend = 'stable';
    }
    this._hiddenAt = 0;
    if (!this.isConnected && !this.isConnecting && !this.isManuallyDisconnected) {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.connect().catch(() => {});
    }
    if (this.isConnected) {
      const stableFor = Date.now() - this.connectionEstablishedAt;
      if (stableFor > 10000) this.reconnectCount = 0;
    }
  }

  _handleOnline() {
    if (!this.isConnected && !this.isConnecting && !this.isManuallyDisconnected) {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.connect().catch(() => {});
    }
  }

  ping() {
    const requestId = 'ping-' + Date.now() + '-' + Math.random();
    const request = { sentTime: Date.now(), resolve: null };

    const promise = new Promise((resolve, reject) => {
      request.resolve = resolve;
      setTimeout(() => {
        if (this.requestMap.has(requestId)) {
          this.stats.totalTimeouts++;
          this.requestMap.delete(requestId);
          reject(new Error('ping timeout'));
        }
      }, this.config.pongTimeout);
    });

    this.requestMap.set(requestId, request);
    this.sendMessage({ type: 'ping', requestId });
    return promise;
  }

  sendMessage(data) {
    if (!data || typeof data !== 'object') throw new Error('Invalid message data');

    if (data.type === 'subscribe') {
      const key = data.sessionId ? 'session:' + data.sessionId : 'conv:' + data.conversationId;
      this.activeSubscriptions.add(key);
    } else if (data.type === 'unsubscribe') {
      const key = data.sessionId ? 'session:' + data.sessionId : 'conv:' + data.conversationId;
      this.activeSubscriptions.delete(key);
    }

    if (!this.isConnected) {
      this.bufferMessage(data);
      return false;
    }

    try {
      this.ws.send(window._codec ? window._codec.encode(data) : msgpackr.pack(data));
      this.stats.totalMessagesSent++;
      return true;
    } catch (error) {
      this.stats.totalErrors++;
      this.bufferMessage(data);
      return false;
    }
  }

  bufferMessage(data) {
    if (this.messageBuffer.length >= this.config.maxBufferedMessages) {
      this.messageBuffer.shift();
    }
    this.messageBuffer.push(data);
    this.emit('message_buffered', { bufferLength: this.messageBuffer.length });
  }

  flushMessageBuffer() {
    if (this.messageBuffer.length === 0) return;
    const messages = [...this.messageBuffer];
    this.messageBuffer = [];
    for (const message of messages) {
      try {
        this.ws.send(window._codec ? window._codec.encode(message) : msgpackr.pack(message));
        this.stats.totalMessagesSent++;
      } catch (error) {
        this.bufferMessage(message);
      }
    }
    this.emit('buffer_flushed', { count: messages.length });
  }

  subscribeToSession(sessionId) {
    return this.sendMessage({ type: 'subscribe', sessionId, timestamp: Date.now() });
  }

  subscribeToConversation(conversationId) {
    return this.sendMessage({ type: 'subscribe', conversationId, timestamp: Date.now() });
  }

  resubscribeAll() {
    for (const key of this.activeSubscriptions) {
      const colonIdx = key.indexOf(':');
      const type = key.substring(0, colonIdx);
      const id = key.substring(colonIdx + 1);
      const msg = { type: 'subscribe', timestamp: Date.now() };
      if (type === 'session') msg.sessionId = id;
      else msg.conversationId = id;
      try {
        this.ws.send(window._codec ? window._codec.encode(msg) : msgpackr.pack(msg));
        this.stats.totalMessagesSent++;
      } catch (_) {}
    }
    // Server automatically sends streaming_start{resumed:true} on subscribe
    // when an active execution exists — no need to query conv.get here.
  }

  unsubscribeFromSession(sessionId) {
    return this.sendMessage({ type: 'unsubscribe', sessionId, timestamp: Date.now() });
  }

  requestSessionHistory(sessionId, limit = 1000, offset = 0) {
    return new Promise((resolve, reject) => {
      const requestId = 'history-' + Date.now() + '-' + Math.random();
      const timeout = setTimeout(() => {
        this.requestMap.delete(requestId);
        this.stats.totalTimeouts++;
        reject(new Error('History request timeout'));
      }, this.config.messageTimeout);

      this.requestMap.set(requestId, {
        type: 'history',
        resolve: (d) => { clearTimeout(timeout); resolve(d); },
        reject
      });

      this.sendMessage({
        type: 'request_history', requestId, sessionId, limit, offset, timestamp: Date.now()
      });
    });
  }

  getLastSeq(sessionId) {
    return this.lastSeqBySession[sessionId] || -1;
  }

  setConnectionState(state) {
    this.connectionState = state;
    this.emit('state_change', { state, timestamp: Date.now() });
  }

  disconnect() {
    this.isManuallyDisconnected = true;
    this.reconnectCount = 0;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) this.ws.close();
    this.messageBuffer = [];
    this.requestMap.clear();
    this.setConnectionState('disconnected');
  }

  getStatus() {
    return {
      isConnected: this.isConnected,
      isConnecting: this.isConnecting,
      connectionState: this.connectionState,
      reconnectCount: this.reconnectCount,
      bufferLength: this.messageBuffer.length,
      latency: { ...this.latency, samples: undefined },
      stats: { ...this.stats }
    };
  }

  on(event, callback) {
    if (!this.listeners[event]) this.listeners[event] = [];
    this.listeners[event].push(callback);
  }

  off(event, callback) {
    if (!this.listeners[event]) return;
    const index = this.listeners[event].indexOf(callback);
    if (index > -1) this.listeners[event].splice(index, 1);
  }

  emit(event, data) {
    if (!this.listeners[event]) return;
    this.listeners[event].forEach((cb) => {
      try { cb(data); } catch (error) {}
    });
  }

  destroy() {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._onVisibilityChange);
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this._onOnline);
    }
    this.disconnect();
    this.listeners = {};
  }
  subscribeToVoiceList(callback) {
    if (!this.voiceListListeners.includes(callback)) {
      this.voiceListListeners.push(callback);
    }
    if (this.cachedVoiceList !== null) {
      callback(this.cachedVoiceList);
    }
  }

  unsubscribeFromVoiceList(callback) {
    const idx = this.voiceListListeners.indexOf(callback);
    if (idx > -1) {
      this.voiceListListeners.splice(idx, 1);
    }
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = WebSocketManager;
}
