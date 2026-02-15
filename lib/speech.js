import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);

const serverSTT = require('webtalk/server-stt');
const serverTTS = require('webtalk/server-tts');

const EXTRA_VOICE_DIRS = [path.join(ROOT, 'voices')];

const POCKET_TTS_VOICES = [
  { id: 'default', name: 'Default', gender: 'female', accent: 'French' },
  { id: 'alba', name: 'Alba', gender: 'female', accent: 'French' },
  { id: 'marius', name: 'Marius', gender: 'male', accent: 'French' },
  { id: 'javert', name: 'Javert', gender: 'male', accent: 'French' },
  { id: 'jean', name: 'Jean', gender: 'male', accent: 'French' },
  { id: 'fantine', name: 'Fantine', gender: 'female', accent: 'French' },
  { id: 'cosette', name: 'Cosette', gender: 'female', accent: 'French' },
  { id: 'eponine', name: 'Eponine', gender: 'female', accent: 'French' },
  { id: 'azelma', name: 'Azelma', gender: 'female', accent: 'French' },
];

const PREDEFINED_IDS = new Set(POCKET_TTS_VOICES.filter(v => v.id !== 'default').map(v => v.id));
const POCKET_PORT = 8787;

const needsPatch = !serverTTS.getVoices(EXTRA_VOICE_DIRS).some(v => v.id === 'alba' && !v.isCustom);

function synthesizeDirect(text, voiceId) {
  const voicePath = serverTTS.findVoiceFile(voiceId, EXTRA_VOICE_DIRS);
  const isPredefined = voiceId && PREDEFINED_IDS.has(voiceId);
  const boundary = '----PocketTTS' + Date.now();
  const parts = [];
  parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="text"\r\n\r\n${text}\r\n`);
  if (voicePath) {
    const data = fs.readFileSync(voicePath);
    const name = path.basename(voicePath);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="voice_wav"; filename="${name}"\r\nContent-Type: audio/wav\r\n\r\n`);
    parts.push(data);
    parts.push('\r\n');
  } else if (isPredefined) {
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="voice_url"\r\n\r\n${voiceId}\r\n`);
  }
  parts.push(`--${boundary}--\r\n`);
  const body = Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p)));
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: POCKET_PORT, path: '/tts', method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
      timeout: 60000,
    }, res => {
      if (res.statusCode !== 200) {
        let e = '';
        res.on('data', d => e += d);
        res.on('end', () => reject(new Error(`pocket-tts HTTP ${res.statusCode}: ${e}`)));
        return;
      }
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('pocket-tts timeout')); });
    req.write(body);
    req.end();
  });
}

function transcribe(audioBuffer) {
  return serverSTT.transcribe(audioBuffer);
}

function getSTT() {
  return serverSTT.getSTT();
}

function synthesize(text, voiceId) {
  if (needsPatch && voiceId && PREDEFINED_IDS.has(voiceId)) {
    return synthesizeDirect(text, voiceId);
  }
  return serverTTS.synthesize(text, voiceId, EXTRA_VOICE_DIRS);
}

function synthesizeStream(text, voiceId) {
  if (needsPatch && voiceId && PREDEFINED_IDS.has(voiceId)) {
    return (async function* () {
      const sentences = serverTTS.splitSentences(text);
      for (const sentence of sentences) {
        yield await synthesizeDirect(sentence, voiceId);
      }
    })();
  }
  return serverTTS.synthesizeStream(text, voiceId, EXTRA_VOICE_DIRS);
}

function getVoices() {
  const upstream = serverTTS.getVoices(EXTRA_VOICE_DIRS);
  const custom = upstream.filter(v => v.isCustom);
  return [...POCKET_TTS_VOICES, ...custom];
}

function getStatus() {
  const sttStatus = serverSTT.getStatus();
  const ttsStatus = serverTTS.getStatus();
  return {
    sttReady: sttStatus.ready,
    ttsReady: ttsStatus.ready,
    sttLoading: sttStatus.loading,
    ttsLoading: false,
    sttError: sttStatus.error,
    ttsError: ttsStatus.ready ? null : (ttsStatus.lastError || 'pocket-tts not running'),
    pocketTts: ttsStatus,
  };
}

function preloadTTS() {
  const defaultVoice = serverTTS.findVoiceFile('custom_cleetus', EXTRA_VOICE_DIRS) || '/config/voices/cleetus.wav';
  const voicePath = fs.existsSync(defaultVoice) ? defaultVoice : null;
  serverTTS.start(voicePath).then(ok => {
    if (ok) console.log('[TTS] pocket-tts sidecar started');
    else console.log('[TTS] pocket-tts failed to start');
  }).catch(err => {
    console.error('[TTS] pocket-tts start error:', err.message);
  });
}

function ttsCacheKey(text, voiceId) {
  return serverTTS.ttsCacheKey(text, voiceId);
}

function ttsCacheGet(key) {
  return serverTTS.ttsCacheGet(key);
}

function splitSentences(text) {
  return serverTTS.splitSentences(text);
}

export { transcribe, synthesize, synthesizeStream, getSTT, getStatus, getVoices, preloadTTS, ttsCacheKey, ttsCacheGet, splitSentences };
