(function() {
  var BASE = window.__BASE_URL || '';
  var ttsEnabled = true;
  var speechQueue = [];
  var isSpeaking = false;
  var currentAudio = null;
  var selectedVoiceId = localStorage.getItem('gmgui-voice-selection') || 'default';
  var ttsAudioCache = new Map();
  var TTS_CLIENT_CACHE_MAX = 50;
  var audioChunkQueue = [];
  var isPlayingChunk = false;
  var streamDone = false;
  var ttsConsecutiveFailures = 0;
  var TTS_MAX_FAILURES = 3;
  var ttsDisabledUntilReset = false;
  var streamingSupported = true;

  window.addEventListener('ws-message', function(e) {
    var data = e.detail;
    if (!data) return;
    if (data.type === 'tts_audio' && data.audio && data.voiceId === selectedVoiceId) cacheTTSAudio(data.cacheKey, data.audio);
    if (data.type === 'sync_connected') sendVoiceToServer();
  });

  function cacheTTSAudio(cacheKey, b64) {
    if (ttsAudioCache.size >= TTS_CLIENT_CACHE_MAX) ttsAudioCache.delete(ttsAudioCache.keys().next().value);
    var binary = atob(b64), bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    ttsAudioCache.set(cacheKey, new Blob([bytes], { type: 'audio/wav' }));
  }

  function speakDirect(text) {
    var clean = text.replace(/<[^>]*>/g, '').trim();
    if (!clean) return;
    var parts = (typeof agentGUIClient !== 'undefined' && agentGUIClient && typeof agentGUIClient.parseMarkdownCodeBlocks === 'function')
      ? agentGUIClient.parseMarkdownCodeBlocks(clean) : [{ type: 'text', content: clean }];
    parts.forEach(function(p) { if (p.type !== 'code' && p.content.trim()) speechQueue.push(p.content.trim()); });
    processQueue();
  }

  function playNextChunk() {
    if (!audioChunkQueue.length) {
      isPlayingChunk = false;
      if (streamDone) { isSpeaking = false; processQueue(); }
      return;
    }
    isPlayingChunk = true;
    var blob = audioChunkQueue.shift(), url = URL.createObjectURL(blob);
    currentAudio = new Audio(url);
    var next = function() { URL.revokeObjectURL(url); currentAudio = null; playNextChunk(); };
    currentAudio.onended = next; currentAudio.onerror = next;
    currentAudio.play().catch(next);
  }

  function processQueue() {
    if (isSpeaking || !speechQueue.length) return;
    if (ttsDisabledUntilReset) { speechQueue = []; return; }
    isSpeaking = true; streamDone = false;
    var text = speechQueue.shift();
    audioChunkQueue = []; isPlayingChunk = false;
    var cached = ttsAudioCache.get(selectedVoiceId + ':' + text);
    if (cached) { ttsConsecutiveFailures = 0; audioChunkQueue.push(cached); streamDone = true; if (!isPlayingChunk) playNextChunk(); return; }
    function ok() { ttsConsecutiveFailures = 0; }
    function fail() {
      if (++ttsConsecutiveFailures >= TTS_MAX_FAILURES) { ttsDisabledUntilReset = true; speechQueue = []; }
      streamDone = true; isSpeaking = false;
      if (!ttsDisabledUntilReset) processQueue();
    }
    function stream() {
      if (!streamingSupported) { nonStream(text); return; }
      fetch(BASE + '/api/tts-stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: text, voiceId: selectedVoiceId }) })
        .then(function(r) {
          if (!r.ok) { streamingSupported = false; throw 0; }
          var reader = r.body.getReader(), buf = new Uint8Array(0);
          function cat(a, b) { var c = new Uint8Array(a.length + b.length); c.set(a); c.set(b, a.length); return c; }
          function pump() { return reader.read().then(function(res) {
            if (res.done) { ok(); streamDone = true; if (!isPlayingChunk && !audioChunkQueue.length) { isSpeaking = false; processQueue(); } return; }
            buf = cat(buf, res.value);
            while (buf.length >= 4) {
              var len = new DataView(buf.buffer, buf.byteOffset, 4).getUint32(0, false);
              if (buf.length < 4 + len) break;
              audioChunkQueue.push(new Blob([buf.slice(4, 4 + len)], { type: 'audio/wav' }));
              buf = buf.slice(4 + len);
              if (!isPlayingChunk) playNextChunk();
            }
            return pump();
          }); }
          return pump();
        }).catch(function() { nonStream(text); });
    }
    function nonStream(txt) {
      fetch(BASE + '/api/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: txt, voiceId: selectedVoiceId }) })
        .then(function(r) { if (!r.ok) throw 0; return r.arrayBuffer(); })
        .then(function(b) { ok(); audioChunkQueue.push(new Blob([b], { type: 'audio/wav' })); streamDone = true; if (!isPlayingChunk) playNextChunk(); })
        .catch(fail);
    }
    stream();
  }

  function stopSpeaking() {
    speechQueue = []; audioChunkQueue = []; isPlayingChunk = false; isSpeaking = false;
    ttsConsecutiveFailures = 0; ttsDisabledUntilReset = false;
    if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  }

  function sendVoiceToServer() {
    if (typeof agentGUIClient !== 'undefined' && agentGUIClient && agentGUIClient.wsManager && agentGUIClient.wsManager.isConnected)
      agentGUIClient.wsManager.sendMessage({ type: 'set_voice', voiceId: selectedVoiceId });
  }

  window.voiceModule = {
    getAutoSpeak: function() { return ttsEnabled; },
    setAutoSpeak: function(v) { ttsEnabled = Boolean(v); localStorage.setItem('gmgui-auto-speak', ttsEnabled); if (!ttsEnabled) stopSpeaking(); },
    getVoice: function() { return selectedVoiceId; },
    setVoice: function(id) { selectedVoiceId = String(id); localStorage.setItem('gmgui-voice-selection', selectedVoiceId); sendVoiceToServer(); },
    speakText: speakDirect,
    stopSpeaking: stopSpeaking
  };
})();
