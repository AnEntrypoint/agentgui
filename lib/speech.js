import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(__dirname);

// Use webtalk's server-side modules
const serverSTT = require('webtalk/server-stt');
const serverTTS = require('webtalk/server-tts');

const EXTRA_VOICE_DIRS = [path.join(ROOT, 'voices')];

function transcribe(audioBuffer) {
  return serverSTT.transcribe(audioBuffer);
}

function getSTT() {
  return serverSTT.getSTT();
}

function synthesize(text, voiceId) {
  return serverTTS.synthesize(text, voiceId, EXTRA_VOICE_DIRS);
}

function synthesizeStream(text, voiceId) {
  return serverTTS.synthesizeStream(text, voiceId, EXTRA_VOICE_DIRS);
}

function getVoices() {
  return serverTTS.getVoices(EXTRA_VOICE_DIRS);
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
