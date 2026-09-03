// Browser mirror of lib/codec.js. JSON over WS text frames.
export function encode(obj) { return JSON.stringify(obj); }
export function decode(buf) {
  if (typeof buf === 'string') return JSON.parse(buf);
  if (buf instanceof ArrayBuffer) return JSON.parse(new TextDecoder().decode(new Uint8Array(buf)));
  if (buf instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(buf));
  return JSON.parse(String(buf));
}
