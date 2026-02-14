import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);
const DATA_DIR = path.join(ROOT, 'data');
const AUDIO_EXTENSIONS = ['.wav', '.mp3', '.ogg', '.flac', '.m4a'];

function getVoiceDirs() {
  const dirs = [];
  const seen = new Set();
  const add = (d) => { const r = path.resolve(d); if (!seen.has(r)) { seen.add(r); dirs.push(r); } };
  const startupCwd = process.env.STARTUP_CWD || process.cwd();
  add(path.join(startupCwd, 'voices'));
  add(path.join(ROOT, 'voices'));
  add(path.join(os.homedir(), 'voices'));
  return dirs;
}

const MIN_WAV_SIZE = 1000;

const BASE_VOICES = [
  { id: 'default', name: 'Default', gender: 'male', accent: 'US' },
  { id: 'bdl', name: 'BDL', gender: 'male', accent: 'US' },
  { id: 'slt', name: 'SLT', gender: 'female', accent: 'US' },
  { id: 'clb', name: 'CLB', gender: 'female', accent: 'US' },
  { id: 'rms', name: 'RMS', gender: 'male', accent: 'US' },
  { id: 'awb', name: 'AWB', gender: 'male', accent: 'Scottish' },
  { id: 'jmk', name: 'JMK', gender: 'male', accent: 'Canadian' },
  { id: 'ksp', name: 'KSP', gender: 'male', accent: 'Indian' },
];

async function convertToWav(filePath) {
  const wavPath = filePath.replace(/\.[^.]+$/, '.wav');
  if (fs.existsSync(wavPath)) return wavPath;
  try {
    console.log('[VOICES] Converting to WAV:', filePath);
    const audio = await decodeAudioFile(filePath);
    const wav = encodeWav(audio, SAMPLE_RATE_STT);
    fs.writeFileSync(wavPath, wav);
    console.log('[VOICES] Converted:', path.basename(wavPath));
    return wavPath;
  } catch (err) {
    console.error('[VOICES] Conversion failed for', filePath + ':', err.message);
    return null;
  }
}

const pendingConversions = new Map();

function scanVoiceDir(dir) {
  const voices = [];
  try {
    if (!fs.existsSync(dir)) return voices;
    const listed = new Set();
    for (const file of fs.readdirSync(dir)) {
      const ext = path.extname(file).toLowerCase();
      if (!AUDIO_EXTENSIONS.includes(ext)) continue;
      const baseName = path.basename(file, ext);
      if (ext !== '.wav') {
        const wavExists = fs.existsSync(path.join(dir, baseName + '.wav'));
        if (wavExists) continue;
        const fullPath = path.join(dir, file);
        if (!pendingConversions.has(fullPath)) {
          pendingConversions.set(fullPath, convertToWav(fullPath).then(result => {
            pendingConversions.delete(fullPath);
            return result;
          }));
        }
      }
      if (listed.has(baseName)) continue;
      listed.add(baseName);
      const id = 'custom_' + baseName.replace(/[^a-zA-Z0-9_-]/g, '_');
      const name = baseName.replace(/_/g, ' ');
      voices.push({ id, name, gender: 'custom', accent: 'custom', isCustom: true, sourceDir: dir });
    }
  } catch (err) {
    console.error('[VOICES] Error scanning', dir + ':', err.message);
  }
  return voices;
}

function loadCustomVoices() {
  const seen = new Set();
  const voices = [];
  for (const dir of getVoiceDirs()) {
    for (const v of scanVoiceDir(dir)) {
      if (seen.has(v.id)) continue;
      seen.add(v.id);
      voices.push(v);
    }
  }
  return voices;
}

function getVoices() {
  return [...BASE_VOICES, ...loadCustomVoices()];
}

const SPEAKER_OFFSETS = { awb: 0, bdl: 1200, clb: 2300, jmk: 3500, ksp: 4700, rms: 5900, slt: 7100 };
const SPEAKER_EMBEDDINGS_URL = 'https://huggingface.co/datasets/Xenova/speaker_embeddings/resolve/main/spkrec-xvectors-voxceleb.hf';
const SPEAKER_EMBEDDINGS_PATH = path.join(DATA_DIR, 'speaker_embeddings.bin');
const DATASET_API = 'https://datasets-server.huggingface.co/rows?dataset=Xenova%2Fspeaker_embeddings&config=default&split=train';
const SAMPLES_TO_AVERAGE = 30;
const DEFAULT_EMBEDDING_B64 = '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';

let transformersModule = null;
let sttPipeline = null;
let ttsPipeline = null;
let speakerEmbeddings = null;
let speakerEmbeddingPipeline = null;
let sttLoading = false;
let ttsLoading = false;
let speakerEmbeddingLoading = false;
let ttsLoadError = null;
let ttsLoadErrorTime = 0;
let sttLoadError = null;
const voiceEmbeddingsCache = new Map();
const SAMPLE_RATE_STT = 16000;
const SAMPLE_RATE_TTS = 16000;
const TTS_ERROR_RETRY_MS = 30000;

const TTS_CACHE_MAX_BYTES = 10 * 1024 * 1024;
let ttsCacheBytes = 0;
const ttsCache = new Map();
const ttsInflight = new Map();

async function loadTransformers() {
  if (transformersModule) return transformersModule;
  transformersModule = await import('@huggingface/transformers');
  return transformersModule;
}

function whisperModelPath() {
  try {
    const webtalkDir = path.dirname(require.resolve('webtalk'));
    const p = path.join(webtalkDir, 'models', 'onnx-community', 'whisper-base');
    if (fs.existsSync(p)) return p;
  } catch (_) {}
  return 'onnx-community/whisper-base';
}

function defaultEmbedding() {
  const buf = Buffer.from(DEFAULT_EMBEDDING_B64, 'base64');
  return new Float32Array(new Uint8Array(buf).buffer);
}

async function ensureSpeakerEmbeddings() {
  if (speakerEmbeddings) return speakerEmbeddings;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(SPEAKER_EMBEDDINGS_PATH)) {
    const buf = fs.readFileSync(SPEAKER_EMBEDDINGS_PATH);
    if (buf.length === 2048) {
      speakerEmbeddings = new Float32Array(new Uint8Array(buf).buffer);
      return speakerEmbeddings;
    }
  }
  try {
    const resp = await fetch(SPEAKER_EMBEDDINGS_URL);
    if (resp.ok) {
      const data = Buffer.from(await resp.arrayBuffer());
      if (data.length >= 2048) {
        fs.writeFileSync(SPEAKER_EMBEDDINGS_PATH, data);
        speakerEmbeddings = new Float32Array(new Uint8Array(data).buffer);
        return speakerEmbeddings;
      }
    }
  } catch (_) {}
  console.log('[TTS] Using bundled default speaker embedding');
  speakerEmbeddings = defaultEmbedding();
  const buf = Buffer.from(speakerEmbeddings.buffer);
  fs.writeFileSync(SPEAKER_EMBEDDINGS_PATH, buf);
  return speakerEmbeddings;
}

async function loadVoiceEmbedding(voiceId) {
  if (!voiceId || voiceId === 'default') return ensureSpeakerEmbeddings();
  if (voiceEmbeddingsCache.has(voiceId)) return voiceEmbeddingsCache.get(voiceId);
  const binPath = path.join(DATA_DIR, `speaker_${voiceId}.bin`);
  if (fs.existsSync(binPath)) {
    const buf = fs.readFileSync(binPath);
    const emb = new Float32Array(new Uint8Array(buf).buffer);
    voiceEmbeddingsCache.set(voiceId, emb);
    return emb;
  }
  if (voiceId.startsWith('custom_')) {
    return generateEmbeddingFromCustomVoice(voiceId);
  }
  const offset = SPEAKER_OFFSETS[voiceId];
  if (offset === undefined) return ensureSpeakerEmbeddings();
  try {
    const url = `${DATASET_API}&offset=${offset}&length=${SAMPLES_TO_AVERAGE}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    const avg = new Float32Array(512);
    let count = 0;
    for (const item of data.rows) {
      const match = item.row.filename.match(/cmu_us_(\w+)_arctic/);
      if (match && match[1] === voiceId) {
        for (let i = 0; i < 512; i++) avg[i] += item.row.xvector[i];
        count++;
      }
    }
    if (count === 0) return ensureSpeakerEmbeddings();
    for (let i = 0; i < 512; i++) avg[i] /= count;
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(binPath, Buffer.from(avg.buffer));
    voiceEmbeddingsCache.set(voiceId, avg);
    return avg;
  } catch (err) {
    console.error('[TTS] Failed to fetch voice embedding for ' + voiceId + ':', err.message);
    return ensureSpeakerEmbeddings();
  }
}

async function getSpeakerEmbeddingPipeline() {
  if (speakerEmbeddingPipeline) return speakerEmbeddingPipeline;
  if (speakerEmbeddingLoading) {
    while (speakerEmbeddingLoading) await new Promise(r => setTimeout(r, 100));
    if (!speakerEmbeddingPipeline) throw new Error('Speaker embedding pipeline failed to load');
    return speakerEmbeddingPipeline;
  }
  speakerEmbeddingLoading = true;
  try {
    const { pipeline, env } = await loadTransformers();
    env.allowRemoteModels = true;
    speakerEmbeddingPipeline = await pipeline('feature-extraction', 'speechbrain/spkrec-xvectors-voxceleb', {
      device: 'cpu',
      dtype: 'fp32',
    });
    return speakerEmbeddingPipeline;
  } catch (err) {
    speakerEmbeddingPipeline = null;
    throw new Error('Speaker embedding model load failed: ' + err.message);
  } finally {
    speakerEmbeddingLoading = false;
  }
}

function findCustomVoiceFile(voiceId) {
  const baseName = voiceId.replace(/^custom_/, '');
  for (const dir of getVoiceDirs()) {
    for (const ext of AUDIO_EXTENSIONS) {
      const candidate = path.join(dir, baseName + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

async function decodeAudioFile(filePath) {
  const buf = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.wav') {
    const decoded = decodeWavToFloat32(buf);
    return resampleTo16k(decoded.audio, decoded.sampleRate);
  }
  const wavPath = filePath.replace(/\.[^.]+$/, '.wav');
  if (fs.existsSync(wavPath)) {
    const wavBuf = fs.readFileSync(wavPath);
    const decoded = decodeWavToFloat32(wavBuf);
    return resampleTo16k(decoded.audio, decoded.sampleRate);
  }
  const decode = (await import('audio-decode')).default;
  const audioBuffer = await decode(buf);
  const mono = audioBuffer.getChannelData(0);
  return resampleTo16k(mono, audioBuffer.sampleRate);
}

async function generateEmbeddingFromCustomVoice(voiceId) {
  const audioFile = findCustomVoiceFile(voiceId);
  if (!audioFile) {
    console.error('[VOICES] Custom voice file not found for:', voiceId);
    return ensureSpeakerEmbeddings();
  }
  try {
    console.log('[VOICES] Generating embedding from:', audioFile);
    const audio = await decodeAudioFile(audioFile);
    if (audio.length < SAMPLE_RATE_STT * 0.5) {
      throw new Error('Audio too short for embedding extraction');
    }
    const pipe = await getSpeakerEmbeddingPipeline();
    const output = await pipe(audio, { pooling: 'mean', normalize: true });
    const embedding = new Float32Array(512);
    for (let i = 0; i < Math.min(512, output.data.length); i++) {
      embedding[i] = output.data[i];
    }
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const binPath = path.join(DATA_DIR, `speaker_${voiceId}.bin`);
    fs.writeFileSync(binPath, Buffer.from(embedding.buffer));
    voiceEmbeddingsCache.set(voiceId, embedding);
    console.log('[VOICES] Generated embedding for custom voice:', voiceId);
    return embedding;
  } catch (err) {
    console.error('[VOICES] Failed to generate embedding for', voiceId + ':', err.message);
    return ensureSpeakerEmbeddings();
  }
}

async function getSTT() {
  if (sttPipeline) return sttPipeline;
  if (sttLoadError) throw sttLoadError;
  if (sttLoading) {
    while (sttLoading) await new Promise(r => setTimeout(r, 100));
    if (sttLoadError) throw sttLoadError;
    if (!sttPipeline) throw new Error('STT pipeline failed to load');
    return sttPipeline;
  }
  sttLoading = true;
  try {
    const { pipeline, env } = await loadTransformers();
    const modelPath = whisperModelPath();
    const isLocal = !modelPath.includes('/') || fs.existsSync(modelPath);
    env.allowLocalModels = true;
    env.allowRemoteModels = !isLocal;
    if (isLocal) env.localModelPath = '';
    sttPipeline = await pipeline('automatic-speech-recognition', modelPath, {
      device: 'cpu',
      local_files_only: isLocal,
    });
    sttLoadError = null;
    return sttPipeline;
  } catch (err) {
    sttPipeline = null;
    sttLoadError = new Error('STT model load failed: ' + err.message);
    throw sttLoadError;
  } finally {
    sttLoading = false;
  }
}

async function getTTS() {
  if (ttsPipeline) return ttsPipeline;
  if (ttsLoadError) {
    if (Date.now() - ttsLoadErrorTime < TTS_ERROR_RETRY_MS) throw ttsLoadError;
    ttsLoadError = null;
    ttsLoadErrorTime = 0;
  }
  if (ttsLoading) {
    while (ttsLoading) await new Promise(r => setTimeout(r, 100));
    if (ttsLoadError) throw ttsLoadError;
    if (!ttsPipeline) throw new Error('TTS pipeline failed to load');
    return ttsPipeline;
  }
  ttsLoading = true;
  try {
    const { pipeline, env } = await loadTransformers();
    env.allowRemoteModels = true;
    ttsPipeline = await pipeline('text-to-speech', 'Xenova/speecht5_tts', {
      device: 'cpu',
      dtype: 'fp32',
    });
    await ensureSpeakerEmbeddings();
    ttsLoadError = null;
    ttsLoadErrorTime = 0;
    return ttsPipeline;
  } catch (err) {
    ttsPipeline = null;
    ttsLoadError = new Error('TTS model load failed: ' + err.message);
    ttsLoadErrorTime = Date.now();
    throw ttsLoadError;
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
  const buf = Buffer.isBuffer(audioBuffer) ? audioBuffer : Buffer.from(audioBuffer);
  if (buf.length < MIN_WAV_SIZE) {
    throw new Error('Audio too short (' + buf.length + ' bytes)');
  }
  let audio;
  const isWav = buf.length > 4 && buf.toString('ascii', 0, 4) === 'RIFF';
  if (isWav) {
    let decoded;
    try {
      decoded = decodeWavToFloat32(buf);
    } catch (err) {
      throw new Error('WAV decode failed: ' + err.message);
    }
    if (!decoded.audio || decoded.audio.length === 0) {
      throw new Error('WAV contains no audio samples');
    }
    audio = resampleTo16k(decoded.audio, decoded.sampleRate);
  } else {
    const sampleCount = Math.floor(buf.byteLength / 4);
    if (sampleCount === 0) throw new Error('Audio buffer too small');
    const aligned = new ArrayBuffer(sampleCount * 4);
    new Uint8Array(aligned).set(buf.subarray(0, sampleCount * 4));
    audio = new Float32Array(aligned);
  }
  if (audio.length < 100) {
    throw new Error('Audio too short for transcription');
  }
  const stt = await getSTT();
  let result;
  try {
    result = await stt(audio);
  } catch (err) {
    throw new Error('Transcription engine error: ' + err.message);
  }
  if (!result || typeof result.text !== 'string') {
    return '';
  }
  return result.text;
}

function splitSentences(text) {
  const raw = text.match(/[^.!?]+[.!?]+[\s]?|[^.!?]+$/g);
  if (!raw) return [text];
  return raw.map(s => s.trim()).filter(s => s.length > 0);
}

function cachePut(key, buf) {
  if (ttsCache.has(key)) {
    ttsCacheBytes -= ttsCache.get(key).length;
    ttsCache.delete(key);
  }
  while (ttsCacheBytes + buf.length > TTS_CACHE_MAX_BYTES && ttsCache.size > 0) {
    const oldest = ttsCache.keys().next().value;
    ttsCacheBytes -= ttsCache.get(oldest).length;
    ttsCache.delete(oldest);
  }
  ttsCache.set(key, buf);
  ttsCacheBytes += buf.length;
}

async function synthesize(text, voiceId) {
  const cacheKey = (voiceId || 'default') + ':' + text;
  const cached = ttsCache.get(cacheKey);
  if (cached) {
    ttsCache.delete(cacheKey);
    ttsCache.set(cacheKey, cached);
    return cached;
  }
  const inflight = ttsInflight.get(cacheKey);
  if (inflight) return inflight;
  const promise = (async () => {
    const tts = await getTTS();
    const embeddings = await loadVoiceEmbedding(voiceId);
    const result = await tts(text, { speaker_embeddings: embeddings });
    const wav = encodeWav(result.audio, result.sampling_rate || SAMPLE_RATE_TTS);
    cachePut(cacheKey, wav);
    return wav;
  })();
  ttsInflight.set(cacheKey, promise);
  try { return await promise; } finally { ttsInflight.delete(cacheKey); }
}

async function* synthesizeStream(text, voiceId) {
  const sentences = splitSentences(text);
  const tts = await getTTS();
  const embeddings = await loadVoiceEmbedding(voiceId);
  for (const sentence of sentences) {
    const cacheKey = (voiceId || 'default') + ':' + sentence;
    const cached = ttsCache.get(cacheKey);
    if (cached) {
      ttsCache.delete(cacheKey);
      ttsCache.set(cacheKey, cached);
      yield cached;
      continue;
    }
    const result = await tts(sentence, { speaker_embeddings: embeddings });
    const wav = encodeWav(result.audio, result.sampling_rate || SAMPLE_RATE_TTS);
    cachePut(cacheKey, wav);
    yield wav;
  }
}

function getStatus() {
  const ttsRetryExpired = ttsLoadError && (Date.now() - ttsLoadErrorTime >= TTS_ERROR_RETRY_MS);
  return {
    sttReady: !!sttPipeline,
    ttsReady: !!ttsPipeline,
    sttLoading,
    ttsLoading,
    sttError: sttLoadError ? sttLoadError.message : null,
    ttsError: (ttsLoadError && !ttsRetryExpired) ? ttsLoadError.message : null,
  };
}

function preloadTTS() {
  getTTS().catch(err => console.error('[TTS] Preload failed:', err.message));
}

function ttsCacheKey(text, voiceId) {
  return (voiceId || 'default') + ':' + text;
}

function ttsCacheGet(key) {
  const cached = ttsCache.get(key);
  if (cached) { ttsCache.delete(key); ttsCache.set(key, cached); }
  return cached || null;
}

export { transcribe, synthesize, synthesizeStream, getSTT, getTTS, getStatus, getVoices, preloadTTS, ttsCacheKey, ttsCacheGet, splitSentences };
