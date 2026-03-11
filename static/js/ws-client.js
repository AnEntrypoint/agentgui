class WsClient {
  constructor(wsManager) {
    this._ws = wsManager;
    this._pending = new Map();
    this._installed = false;
    this._connectPromise = null;
    this._install();
  }

  _install() {
    if (this._installed) return;
    this._installed = true;
    // Listen on decoded message objects — websocket-manager emits 'message' with decoded obj
    this._ws.on('message', (data) => {
      if (data.r && this._pending.has(data.r)) {
        const p = this._pending.get(data.r);
        this._pending.delete(data.r);
        clearTimeout(p.timer);
        if (data.e) {
          p.reject(Object.assign(new Error(data.e.m || 'RPC error'), { code: data.e.c }));
        } else {
          p.resolve(data.d);
        }
        return; // consumed — don't re-emit
      }
      // Non-RPC messages are already emitted by websocket-manager; nothing to do
    });
    this._ws.on('disconnected', () => this.cancelAll());
  }

  _ensureConnected() {
    if (this._ws.isConnected) return Promise.resolve();
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = this._ws.connect().then(() => {
      this._connectPromise = null;
    }).catch(() => {
      this._connectPromise = null;
    });
    return this._connectPromise;
  }

  _id() {
    let id = '';
    for (let i = 0; i < 8; i++) id += ((Math.random() * 16) | 0).toString(16);
    return id;
  }

  request(method, params = {}, timeout = 30000) {
    return this._ensureConnected().then(() => {
      return new Promise((resolve, reject) => {
        const r = this._id();
        const timer = setTimeout(() => {
          this._pending.delete(r);
          reject(new Error(`RPC timeout: ${method}`));
        }, timeout);
        this._pending.set(r, { resolve, reject, timer });
        this._ws.sendMessage({ r, m: method, p: params });
      });
    });
  }

  rpc(method, params) {
    return this.request(method, params);
  }

  cancelAll() {
    for (const [, p] of this._pending) {
      clearTimeout(p.timer);
      p.reject(new Error('Connection lost'));
    }
    this._pending.clear();
  }

  get pendingCount() {
    return this._pending.size;
  }
}

window.WsClient = WsClient;

try {
  window.wsManager = new WebSocketManager();
  window.wsClient = new WsClient(window.wsManager);
  window.wsManager.connect().catch(function() {});
} catch (e) {
  console.error('[ws-client] Failed to initialize:', e);
}
