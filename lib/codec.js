// agentgui WS wire codec - plain JSON (UTF-8 text frames).
// Browser-compatible (no msgpackr). encode() returns a string the ws library
// sends as a text frame; decode() handles both Buffer/Uint8Array (Node) and
// string (browser) inputs.

export function encode(obj) { return JSON.stringify(obj); }

export function decode(buf) {
  if (typeof buf === 'string') return JSON.parse(buf);
  if (buf instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(buf));
  if (buf && typeof buf.toString === 'function') return JSON.parse(buf.toString('utf8'));
  return JSON.parse(String(buf));
}
