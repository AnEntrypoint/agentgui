import { pack, unpack } from 'msgpackr';

function sendBinary(ws, obj) {
  if (ws.readyState === 1) ws.send(pack(obj));
}

class WsRouter {
  constructor() {
    this.handlers = new Map();
    this.legacyHandler = null;
  }

  handle(method, fn) {
    this.handlers.set(method, fn);
    return this;
  }

  onLegacy(fn) {
    this.legacyHandler = fn;
    return this;
  }

  reply(ws, requestId, data) {
    sendBinary(ws, { r: requestId, d: data || {} });
  }

  replyError(ws, requestId, code, message) {
    sendBinary(ws, { r: requestId, e: { c: code, m: message } });
  }

  send(ws, type, data) {
    sendBinary(ws, { t: type, d: data || {} });
  }

  broadcast(clients, type, data) {
    const msg = pack({ t: type, d: data || {} });
    for (const ws of clients) {
      if (ws.readyState === 1) ws.send(msg);
    }
  }

  async onMessage(ws, rawData) {
    let parsed;
    try {
      // Accept binary (msgpackr) or text (JSON fallback / legacy hot-reload)
      if (Buffer.isBuffer(rawData) || rawData instanceof Uint8Array) {
        parsed = unpack(rawData);
      } else {
        parsed = JSON.parse(rawData.toString());
      }
    } catch {
      sendBinary(ws, { r: null, e: { c: 400, m: 'Invalid message' } });
      return;
    }

    if (parsed.m && parsed.r !== undefined) {
      const handler = this.handlers.get(parsed.m);
      if (!handler) {
        this.replyError(ws, parsed.r, 404, `Unknown method: ${parsed.m}`);
        return;
      }
      try {
        const result = await handler(parsed.p || {}, ws);
        this.reply(ws, parsed.r, result);
      } catch (err) {
        const code = err.code || 500;
        const message = err.message || 'Internal error';
        this.replyError(ws, parsed.r, code, message);
      }
      return;
    }

    if (this.legacyHandler) {
      this.legacyHandler(parsed, ws);
      return;
    }

    if (parsed.r !== undefined) {
      this.replyError(ws, parsed.r, 400, 'Missing method');
    }
  }
}

export { WsRouter };
