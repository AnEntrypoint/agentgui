import { pipeline, env } from '@huggingface/transformers';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);
const DATA_DIR = path.join(ROOT, 'data');

const SPEAKER_EMBEDDINGS_URL = 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/speaker_embeddings.bin';
const SPEAKER_EMBEDDINGS_PATH = path.join(DATA_DIR, 'speaker_embeddings.bin');
const SAMPLE_RATE_TTS = 16000;
const SAMPLE_RATE_STT = 16000;

let sttPipeline = null;
let ttsPipeline = null;
let speakerEmbeddings = null;
let sttLoading = false;
let ttsLoading = false;

function whisperModelPath() {
  try {
    const webtalkDir = path.dirname(require.resolve('webtalk'));
    const p = path.join(webtalkDir, 'models', 'onnx-community', 'whisper-base');
    if (fs.existsSync(p)) return p;
  } catch (_) {}
  return 'onnx-community/whisper-base';
}

async function ensureSpeakerEmbeddings() {
  if (speakerEmbeddings) return speakerEmbeddings;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(SPEAKER_EMBEDDINGS_PATH)) {
    const resp = await fetch(SPEAKER_EMBEDDINGS_URL);
    if (!resp.ok) throw new Error('Failed to download speaker embeddings');
    fs.writeFileSync(SPEAKER_EMBEDDINGS_PATH, Buffer.from(await resp.arrayBuffer()));
  }
  const buf = fs.readFileSync(SPEAKER_EMBEDDINGS_PATH);
  speakerEmbeddings = new Float32Array(new Uint8Array(buf).buffer);
  return speakerEmbeddings;
}

async function getSTT() {
  if (sttPipeline) return sttPipeline;
  if (sttLoading) {
    while (sttLoading) await new Promise(r => setTimeout(r, 100));
    return sttPipeline;
  }
  sttLoading = true;
  try {
    const modelPath = whisperModelPath();
    const isLocal = !modelPath.includes('/') || fs.existsSync(modelPath);
    env.allowLocalModels = true;
    env.allowRemoteModels = !isLocal;
    if (isLocal) env.localModelPath = '';
    sttPipeline = await pipeline('automatic-speech-recognition', modelPath, {
      device: 'cpu',
      local_files_only: isLocal,
    });
    return sttPipeline;
  } finally {
    sttLoading = false;
  }
}

async function getTTS() {
  if (ttsPipeline) return ttsPipeline;
  if (ttsLoading) {
    while (ttsLoading) await new Promise(r => setTimeout(r, 100));
    return ttsPipeline;
  }
  ttsLoading = true;
  try {
    env.allowRemoteModels = true;
    ttsPipeline = await pipeline('text-to-speech', 'Xenova/speecht5_tts', {
      device: 'cpu',
      dtype: 'fp32',
    });
    await ensureSpeakerEmbeddings();
    return ttsPipeline;
  } finally {
    ttsLoading = false;
  }
}

function decodeWavToFloat32(buffer) {
  const view = new DataView(buffer.buffer || buffer);
  const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
  if (riff !== 'RIFF') throw new Error('Not a WAV file');
  const numChannels = view.getUint16(22, true);
  const sampleRate = view.getUint32(24, true);
  const bitsPerSample = view.getUint16(34, true);
  let dataOffset = 44;
  for (let i = 36; i < view.byteLength - 8; i++) {
    if (view.getUint8(i) === 0x64 && view.getUint8(i+1) === 0x61 &&
        view.getUint8(i+2) === 0x74 && view.getUint8(i+3) === 0x61) {
      dataOffset = i + 8;
      break;
    }
  }
  const bytesPerSample = bitsPerSample / 8;
  const numSamples = Math.floor((view.byteLength - dataOffset) / (bytesPerSample * numChannels));
  const audio = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    const offset = dataOffset + i * bytesPerSample * numChannels;
    if (bitsPerSample === 16) {
      audio[i] = view.getInt16(offset, true) / 32768;
    } else if (bitsPerSample === 32) {
      audio[i] = view.getFloat32(offset, true);
    } else {
      audio[i] = (view.getUint8(offset) - 128) / 128;
    }
  }
  return { audio, sampleRate };
}

function resampleTo16k(audio, fromRate) {
  if (fromRate === SAMPLE_RATE_STT) return audio;
  const ratio = fromRate / SAMPLE_RATE_STT;
  const newLen = Math.round(audio.length / ratio);
  const result = new Float32Array(newLen);
  for (let i = 0; i < newLen; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, audio.length - 1);
    const frac = srcIdx - lo;
    result[i] = audio[lo] * (1 - frac) + audio[hi] * frac;
  }
  return result;
}

function encodeWav(float32Audio, sampleRate) {
  const numSamples = float32Audio.length;
  const bytesPerSample = 2;
  const dataSize = numSamples * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, float32Audio[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true);
  }
  return Buffer.from(buffer);
}

async function transcribe(audioBuffer) {
  const stt = await getSTT();
  let audio;
  const buf = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
  const isWav = buf.length > 4 && buf.toString('ascii', 0, 4) === 'RIFF';
  if (isWav) {
    const decoded = decodeWavToFloat32(buf);
    audio = resampleTo16k(decoded.audio, decoded.sampleRate);
  } else {
    audio = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  }
  const result = await stt(audio);
  return result.text || '';
}

async function synthesize(text) {
  const tts = await getTTS();
  const embeddings = await ensureSpeakerEmbeddings();
  const result = await tts(text, { speaker_embeddings: embeddings });
  return encodeWav(result.audio, result.sampling_rate || SAMPLE_RATE_TTS);
}

function getStatus() {
  return {
    sttReady: !!sttPipeline,
    ttsReady: !!ttsPipeline,
    sttLoading,
    ttsLoading,
  };
}

export { transcribe, synthesize, getSTT, getTTS, getStatus };
