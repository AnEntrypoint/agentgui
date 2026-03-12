/**
 * Client-side codec — mirrors lib/codec.js exactly.
 * msgpackr (global from msgpackr.min.js) + GPT tokenizer BPE compression.
 */
import { encode as tokEncode, decode as tokDecode } from 'https://esm.sh/gpt-tokenizer';

const THRESHOLD = 200;
const COMPRESSIBLE = new Set(['content', 'text', 'output', 'response', 'prompt', 'input', 'data']);

function compressText(str) {
  return { __tok: true, d: tokEncode(str) };
}

function decompressText(val) {
  return tokDecode(val.d);
}

function encodeObj(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(encodeObj);
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (COMPRESSIBLE.has(k) && typeof v === 'string' && v.length > THRESHOLD) {
      out[k] = compressText(v);
    } else if (v && typeof v === 'object' && !(v instanceof ArrayBuffer) && !ArrayBuffer.isView(v)) {
      out[k] = encodeObj(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function decodeObj(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(decodeObj);
  if (obj.__tok && obj.d) return decompressText(obj);
  const out = {};
  for (const k of Object.keys(obj)) {
    out[k] = decodeObj(obj[k]);
  }
  return out;
}

export function encode(obj) { return msgpackr.pack(encodeObj(obj)); }
export function decode(buf) { return decodeObj(msgpackr.unpack(new Uint8Array(buf instanceof ArrayBuffer ? buf : buf))); }
