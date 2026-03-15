export function encode(obj) { return msgpackr.pack(obj); }
export function decode(buf) { return msgpackr.unpack(new Uint8Array(buf instanceof ArrayBuffer ? buf : buf)); }
