import { pack, unpack } from 'msgpackr';

export function encode(obj) { return pack(obj); }
export function decode(buf) { return unpack(buf instanceof Uint8Array ? buf : new Uint8Array(buf)); }
