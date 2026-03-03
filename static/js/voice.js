(function() {
  var BASE = window.__BASE_URL || '';
  var isRecording = false;
  var ttsEnabled = true;
  var voiceActive = false;
  var currentConversationId = null;
  var speechQueue = [];
  var isSpeaking = false;
  var currentAudio = null;
  var mediaStream = null;
  var audioContext = null;
  var workletNode = null;
  var recordedChunks = [];
  var TARGET_SAMPLE_RATE = 16000;
  var spokenChunks = new Set();
  var renderedSeqs = new Set();
  var isLoadingHistory = false;
  var _lastVoiceBlockText = null;
  var _lastVoiceBlockTime = 0;
  var _voiceBreakNext = false;
  var selectedVoiceId = localStorage.getItem('voice-selected-id') || 'default';
  var ttsAudioCache = new Map();
  var TTS_CLIENT_CACHE_MAX = 50;

  function init() {
    setupTTSToggle();
    setupUI();
    setupStreamingListener();
    setupAgentSelector();
    setupVoiceSelector();
  }

  function setupVoiceSelector() {
    var selector = document.getElementById('voiceSelector');
    if (!selector) return;
    var saved = localStorage.getItem('voice-selected-id');
    if (saved) selectedVoiceId = saved;
    if (window.wsManager) {
      window.wsManager.subscribeToVoiceList(function(voices) {
        if (!Array.isArray(voices)) return;
        selector.innerHTML = '';
        var builtIn = voices.filter(function(v) { return !v.isCustom; });
        var custom = voices.filter(function(v) { return v.isCustom; });
        if (builtIn.length) {
          var grp1 = document.createElement('optgroup');
          grp1.label = 'Built-in Voices';
          builtIn.forEach(function(voice) {
            var opt = document.createElement('option');
            opt.value = voice.id;
            var parts = [];
            if (voice.gender) parts.push(voice.gender);
            if (voice.accent) parts.push(voice.accent);
            opt.textContent = voice.name + (parts.length ? ' (' + parts.join(', ') + ')' : '');
            grp1.appendChild(opt);
          });
          selector.appendChild(grp1);
        }
        if (custom.length) {
          var grp2 = document.createElement('optgroup');
          grp2.label = 'Custom Voices';
          custom.forEach(function(voice) {
            var opt = document.createElement('option');
            opt.value = voice.id;
            opt.textContent = voice.name;
            grp2.appendChild(opt);
          });
          selector.appendChild(grp2);
        }
        if (saved && selector.querySelector('option[value="' + saved + '"]')) {
          selector.value = saved;
        }
      });
      return;
    }
    if (window.wsClient) {
      window.wsClient.rpc('voices')
        .then(function(data) {
          if (!data.ok || !Array.isArray(data.voices)) return;
          selector.innerHTML = '';
          var builtIn = data.voices.filter(function(v) { return !v.isCustom; });
          var custom = data.voices.filter(function(v) { return v.isCustom; });
          if (builtIn.length) {
            var grp1 = document.createElement('optgroup');
            grp1.label = 'Built-in Voices';
            builtIn.forEach(function(voice) {
              var opt = document.createElement('option');
              opt.value = voice.id;
              var parts = [];
              if (voice.gender) parts.push(voice.gender);
              if (voice.accent) parts.push(voice.accent);
              opt.textContent = voice.name + (parts.length ? ' (' + parts.join(', ') + ')' : '');
              grp1.appendChild(opt);
            });
            selector.appendChild(grp1);
          }
          if (custom.length) {
            var grp2 = document.createElement('optgroup');
            grp2.label = 'Custom Voices';
            custom.forEach(function(voice) {
              var opt = document.createElement('option');
              opt.value = voice.id;
              opt.textContent = voice.name;
              grp2.appendChild(opt);
            });
            selector.appendChild(grp2);
          }
          if (saved && selector.querySelector('option[value="' + saved + '"]')) {
            selector.value = saved;
          }
        })
        .catch(function(err) { console.error('[Voice] Failed to load voices:', err); });
    }
    selector.addEventListener('change', function() {
      selectedVoiceId = selector.value;
      localStorage.setItem('voice-selected-id', selectedVoiceId);
      sendVoiceToServer();
    });
  }

  function syncVoiceSelectorWithRetry(maxRetries) {
    maxRetries = maxRetries || 20;
    var voiceSelector = document.querySelector('[data-voice-agent-selector]');
    var mainSelector = document.querySelector('[data-agent-selector]');
    if (!voiceSelector || !mainSelector) return;
    if (mainSelector.innerHTML.trim() === '' && maxRetries > 0) {
      setTimeout(function() { syncVoiceSelectorWithRetry(maxRetries - 1); }, 250);
      return;
    }
    voiceSelector.innerHTML = mainSelector.innerHTML;
    if (mainSelector.value) voiceSelector.value = mainSelector.value;
  }

  function syncVoiceCliSelectorWithRetry(maxRetries) {
    maxRetries = maxRetries || 20;
    var voiceCliSelector = document.querySelector('[data-voice-cli-selector]');
    var mainCliSelector = document.querySelector('[data-cli-selector]');
    if (!voiceCliSelector || !mainCliSelector) return;
    if (mainCliSelector.innerHTML.trim() === '' && maxRetries > 0) {
      setTimeout(function() { syncVoiceCliSelectorWithRetry(maxRetries - 1); }, 250);
      return;
    }
    voiceCliSelector.innerHTML = mainCliSelector.innerHTML;
    if (mainCliSelector.value) voiceCliSelector.value = mainCliSelector.value;
  }

  function syncVoiceModelSelectorWithRetry(maxRetries) {
    maxRetries = maxRetries || 20;
    var voiceModelSelector = document.querySelector('[data-voice-model-selector]');
    var mainModelSelector = document.querySelector('[data-model-selector]');
    if (!voiceModelSelector || !mainModelSelector) return;
    if (mainModelSelector.innerHTML.trim() === '' && maxRetries > 0) {
      setTimeout(function() { syncVoiceModelSelectorWithRetry(maxRetries - 1); }, 250);
      return;
    }
    voiceModelSelector.innerHTML = mainModelSelector.innerHTML;
    if (mainModelSelector.value) voiceModelSelector.value = mainModelSelector.value;
  }

  function setupAgentSelector() {
    var voiceSelector = document.querySelector('[data-voice-agent-selector]');
    if (!voiceSelector) return;
    var mainSelector = document.querySelector('[data-agent-selector]');
    if (mainSelector) {
      syncVoiceSelectorWithRetry();
      var observer = new MutationObserver(syncVoiceSelectorWithRetry);
      observer.observe(mainSelector, { childList: true, subtree: true });
      mainSelector.addEventListener('change', function() {
        voiceSelector.value = mainSelector.value;
      });
      voiceSelector.addEventListener('change', function() {
        mainSelector.value = voiceSelector.value;
      });
    }
    window.addEventListener('agents-loaded', syncVoiceSelectorWithRetry);

    var mainCliSelector = document.querySelector('[data-cli-selector]');
    if (mainCliSelector) {
      syncVoiceCliSelectorWithRetry();
      var cliObserver = new MutationObserver(syncVoiceCliSelectorWithRetry);
      cliObserver.observe(mainCliSelector, { childList: true, subtree: true });
      mainCliSelector.addEventListener('change', function() {
        var voiceCliSelector = document.querySelector('[data-voice-cli-selector]');
        if (voiceCliSelector) voiceCliSelector.value = mainCliSelector.value;
      });
      var voiceCliSelector = document.querySelector('[data-voice-cli-selector]');
      if (voiceCliSelector) {
        voiceCliSelector.addEventListener('change', function() {
          mainCliSelector.value = voiceCliSelector.value;
        });
      }
    }

    var mainModelSelector = document.querySelector('[data-model-selector]');
    if (mainModelSelector) {
      syncVoiceModelSelectorWithRetry();
      var modelObserver = new MutationObserver(syncVoiceModelSelectorWithRetry);
      modelObserver.observe(mainModelSelector, { childList: true, subtree: true });
      mainModelSelector.addEventListener('change', function() {
        var voiceModelSelector = document.querySelector('[data-voice-model-selector]');
        if (voiceModelSelector) voiceModelSelector.value = mainModelSelector.value;
      });
      var voiceModelSelector = document.querySelector('[data-voice-model-selector]');
      if (voiceModelSelector) {
        voiceModelSelector.addEventListener('change', function() {
          mainModelSelector.value = voiceModelSelector.value;
        });
      }
    }
  }

  function setupTTSToggle() {
    var toggle = document.getElementById('voiceTTSToggle');
    if (toggle) {
      var saved = localStorage.getItem('voice-tts-enabled');
      if (saved !== null) {
        ttsEnabled = saved === 'true';
        toggle.checked = ttsEnabled;
      }
      toggle.addEventListener('change', function() {
        ttsEnabled = toggle.checked;
        localStorage.setItem('voice-tts-enabled', ttsEnabled);
        if (!ttsEnabled) stopSpeaking();
      });
    }
    var stopBtn = document.getElementById('voiceStopSpeaking');
    if (stopBtn) {
      stopBtn.addEventListener('click', stopSpeaking);
    }
  }

  function setupUI() {
    var micBtn = document.getElementById('voiceMicBtn');
    if (micBtn) {
      micBtn.removeAttribute('disabled');
      micBtn.title = 'Hold to record';
      micBtn.addEventListener('mousedown', function(e) {
        e.preventDefault();
        startRecording();
      });
      micBtn.addEventListener('mouseup', function(e) {
        e.preventDefault();
        stopRecording();
      });
      micBtn.addEventListener('mouseleave', function(e) {
        if (isRecording) stopRecording();
      });
      micBtn.addEventListener('touchstart', function(e) {
        e.preventDefault();
        startRecording();
      });
      micBtn.addEventListener('touchend', function(e) {
        e.preventDefault();
        stopRecording();
      });
      micBtn.addEventListener('touchcancel', function(e) {
        if (isRecording) stopRecording();
      });
    }
    var sendBtn = document.getElementById('voiceSendBtn');
    if (sendBtn) {
      sendBtn.addEventListener('click', sendVoiceMessage);
    }
    var transcript = document.getElementById('voiceTranscript');
    if (transcript) {
      transcript.addEventListener('keydown', function(e) {
        if (e.ctrlKey && e.key === 'Enter' || e.metaKey && e.key === 'Enter') {
          e.preventDefault();
          sendVoiceMessage();
        }
      });
    }
  }

  function resampleBuffer(inputBuffer, fromRate, toRate) {
    if (fromRate === toRate) return inputBuffer;
    var ratio = fromRate / toRate;
    var newLen = Math.round(inputBuffer.length / ratio);
    var result = new Float32Array(newLen);
    for (var i = 0; i < newLen; i++) {
      var srcIdx = i * ratio;
      var lo = Math.floor(srcIdx);
      var hi = Math.min(lo + 1, inputBuffer.length - 1);
      var frac = srcIdx - lo;
      result[i] = inputBuffer[lo] * (1 - frac) + inputBuffer[hi] * frac;
    }
    return result;
  }

  function encodeWav(float32Audio, sampleRate) {
    var numSamples = float32Audio.length;
    var bytesPerSample = 2;
    var dataSize = numSamples * bytesPerSample;
    var buffer = new ArrayBuffer(44 + dataSize);
    var view = new DataView(buffer);
    function writeStr(off, str) {
      for (var i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
    }
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
    for (var i = 0; i < numSamples; i++) {
      var s = Math.max(-1, Math.min(1, float32Audio[i]));
      view.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true);
    }
    return buffer;
  }

  async function startRecording() {
    if (isRecording) return;
    var el = document.getElementById('voiceTranscript');
    if (el) {
      if (el.value !== undefined) {
        el.value = '';
      } else {
        el.textContent = '';
        el.setAttribute('data-final', '');
      }
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      var source = audioContext.createMediaStreamSource(mediaStream);
      recordedChunks = [];
      await audioContext.audioWorklet.addModule(BASE + '/js/audio-recorder-processor.js');
      workletNode = new AudioWorkletNode(audioContext, 'recorder-processor');
      workletNode.port.onmessage = function(e) {
        recordedChunks.push(e.data);
      };
      source.connect(workletNode);
      isRecording = true;
      var micBtn = document.getElementById('voiceMicBtn');
      if (micBtn) micBtn.classList.add('recording');
    } catch (e) {
      isRecording = false;
      if (el) el.textContent = 'Mic access denied or unavailable: ' + e.message;
    }
  }

  async function stopRecording() {
    if (!isRecording) return;
    isRecording = false;
    var micBtn = document.getElementById('voiceMicBtn');
    if (micBtn) micBtn.classList.remove('recording');
    var el = document.getElementById('voiceTranscript');
    if (workletNode) { workletNode.port.postMessage('stop'); workletNode.disconnect(); workletNode = null; }
    if (mediaStream) {
      mediaStream.getTracks().forEach(function(t) { t.stop(); });
      mediaStream = null;
    }
    var sourceSampleRate = audioContext ? audioContext.sampleRate : 48000;
    if (audioContext) { audioContext.close().catch(function() {}); audioContext = null; }
    if (recordedChunks.length === 0) return;
    var totalLen = 0;
    for (var i = 0; i < recordedChunks.length; i++) totalLen += recordedChunks[i].length;
    var merged = new Float32Array(totalLen);
    var offset = 0;
    for (var j = 0; j < recordedChunks.length; j++) {
      merged.set(recordedChunks[j], offset);
      offset += recordedChunks[j].length;
    }
    recordedChunks = [];
    var resampled = resampleBuffer(merged, sourceSampleRate, TARGET_SAMPLE_RATE);
    if (el) {
      if (el.value !== undefined) {
        el.value = 'Transcribing...';
      } else {
        el.textContent = 'Transcribing...';
      }
    }
    try {
      var wavBuffer = encodeWav(resampled, TARGET_SAMPLE_RATE);
      var resp = await fetch(BASE + '/api/stt', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: wavBuffer
      });
      var data = await resp.json();
      if (data.text) {
        if (el) {
          if (el.value !== undefined) {
            el.value = data.text;
          } else {
            el.textContent = data.text;
            el.setAttribute('data-final', data.text);
          }
        }
      } else if (data.error) {
        if (el) {
          if (el.value !== undefined) {
            el.value = 'Error: ' + data.error;
          } else {
            el.textContent = 'Error: ' + data.error;
          }
        }
      } else {
        if (el) {
          if (el.value !== undefined) {
            el.value = '';
          } else {
            el.textContent = '';
          }
        }
      }
    } catch (e) {
      if (el) {
        if (el.value !== undefined) {
          el.value = 'Transcription failed: ' + e.message;
        } else {
          el.textContent = 'Transcription failed: ' + e.message;
        }
      }
    }
  }

  function sendVoiceMessage() {
    var el = document.getElementById('voiceTranscript');
    if (!el) return;
    var text = (el.value || el.textContent || '').trim();
    if (!text || text.startsWith('Transcribing') || text.startsWith('Error')) return;
    addVoiceBlock(text, true);
    if (el.value !== undefined) {
      el.value = '';
    } else {
      el.textContent = '';
      el.setAttribute('data-final', '');
    }
    if (typeof agentGUIClient !== 'undefined' && agentGUIClient) {
      var input = agentGUIClient.ui.messageInput;
      if (input) {
        input.value = text;
        agentGUIClient.startExecution();
      }
    }
  }

  function speak(text) {
    if (!ttsEnabled) return;
    var clean = text.replace(/<[^>]*>/g, '').trim();
    if (!clean) return;
    var parts = [];
    if (typeof agentGUIClient !== 'undefined' && agentGUIClient && typeof agentGUIClient.parseMarkdownCodeBlocks === 'function') {
      parts = agentGUIClient.parseMarkdownCodeBlocks(clean);
    } else {
      parts = [{ type: 'text', content: clean }];
    }
    parts.forEach(function(part) {
      if (part.type === 'code') return;
      var segment = part.content.trim();
      if (segment) {
        speechQueue.push(segment);
      }
    });
    processQueue();
  }

  function cacheTTSAudio(cacheKey, b64) {
    if (ttsAudioCache.size >= TTS_CLIENT_CACHE_MAX) {
      var oldest = ttsAudioCache.keys().next().value;
      ttsAudioCache.delete(oldest);
    }
    var binary = atob(b64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    ttsAudioCache.set(cacheKey, new Blob([bytes], { type: 'audio/wav' }));
  }

  function getCachedTTSBlob(text) {
    var key = selectedVoiceId + ':' + text;
    return ttsAudioCache.get(key) || null;
  }

  function splitSentences(text) {
    if (!text) return [text];
    var raw = text.match(/[^.!?]+[.!?]+[\s]?|[^.!?]+$/g);
    if (!raw) return [text];
    var sentences = raw.map(function(s) { return s.trim(); }).filter(function(s) { return s.length > 0; });
    var result = [];
    for (var i = 0; i < sentences.length; i++) {
      var s = sentences[i];
      if (result.length > 0) {
        var prev = result[result.length - 1];
        if (s.match(/^(\d+[\.\)]|\d+\s)/) || prev.match(/\d+[\.\)]$/)) {
          result[result.length - 1] = prev + ' ' + s;
          continue;
        }
      }
      result.push(s);
    }
    return result;
  }

  var audioChunkQueue = [];
  var isPlayingChunk = false;
  var streamDone = false;
  var ttsConsecutiveFailures = 0;
  var TTS_MAX_FAILURES = 3;
  var ttsDisabledUntilReset = false;
  var streamingSupported = true;
  var streamingFailedAt = 0;

  function playNextChunk() {
    if (audioChunkQueue.length === 0) {
      isPlayingChunk = false;
      if (streamDone) {
        isSpeaking = false;
        processQueue();
      }
      return;
    }
    isPlayingChunk = true;
    var blob = audioChunkQueue.shift();
    var url = URL.createObjectURL(blob);
    currentAudio = new Audio(url);
    currentAudio.onended = function() {
      URL.revokeObjectURL(url);
      currentAudio = null;
      playNextChunk();
    };
    currentAudio.onerror = function() {
      URL.revokeObjectURL(url);
      currentAudio = null;
      playNextChunk();
    };
    currentAudio.play().catch(function() {
      URL.revokeObjectURL(url);
      currentAudio = null;
      playNextChunk();
    });
  }

  function processQueue() {
    if (isSpeaking || speechQueue.length === 0) return;
    if (ttsDisabledUntilReset) {
      speechQueue = [];
      return;
    }
    isSpeaking = true;
    streamDone = false;
    var text = speechQueue.shift();
    audioChunkQueue = [];
    isPlayingChunk = false;

    var cachedBlob = getCachedTTSBlob(text);
    if (cachedBlob) {
      ttsConsecutiveFailures = 0;
      audioChunkQueue.push(cachedBlob);
      streamDone = true;
      if (!isPlayingChunk) playNextChunk();
      return;
    }

    var sentences = [text];
    var cachedSentences = [];
    var uncachedText = [text];

    if (cachedSentences.length === sentences.length) {
      ttsConsecutiveFailures = 0;
      for (var j = 0; j < cachedSentences.length; j++) {
        audioChunkQueue.push(cachedSentences[j].blob);
      }
      streamDone = true;
      if (!isPlayingChunk) playNextChunk();
      return;
    }

    if (cachedSentences.length > 0) {
      ttsConsecutiveFailures = 0;
      for (var k = 0; k < cachedSentences.length; k++) {
        audioChunkQueue.push(cachedSentences[k].blob);
      }
      if (!isPlayingChunk) playNextChunk();
    }

    var remainingText = uncachedText.join(' ');

    function onTtsSuccess() {
      ttsConsecutiveFailures = 0;
    }

    function onTtsFailed() {
      ttsConsecutiveFailures++;
      if (ttsConsecutiveFailures >= TTS_MAX_FAILURES) {
        console.warn('[Voice] TTS failed ' + ttsConsecutiveFailures + ' times consecutively, disabling until reset');
        ttsDisabledUntilReset = true;
        speechQueue = [];
      }
      streamDone = true;
      isSpeaking = false;
      if (!ttsDisabledUntilReset) {
        processQueue();
      }
    }

    function tryStreaming() {
      if (!streamingSupported) { tryNonStreaming(remainingText); return; }
      fetch(BASE + '/api/tts-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: remainingText, voiceId: selectedVoiceId })
      }).then(function(resp) {
        if (!resp.ok) {
          streamingSupported = false;
          streamingFailedAt = Date.now();
          throw new Error('TTS stream failed: ' + resp.status);
        }
        var reader = resp.body.getReader();
        var buffer = new Uint8Array(0);

        function concat(a, b) {
          var c = new Uint8Array(a.length + b.length);
          c.set(a, 0);
          c.set(b, a.length);
          return c;
        }

        function pump() {
          return reader.read().then(function(result) {
            if (result.done) {
              onTtsSuccess();
              streamDone = true;
              if (!isPlayingChunk && audioChunkQueue.length === 0) {
                isSpeaking = false;
                processQueue();
              }
              return;
            }
            buffer = concat(buffer, result.value);
            while (buffer.length >= 4) {
              var view = new DataView(buffer.buffer, buffer.byteOffset, 4);
              var chunkLen = view.getUint32(0, false);
              if (buffer.length < 4 + chunkLen) break;
              var wavData = buffer.slice(4, 4 + chunkLen);
              buffer = buffer.slice(4 + chunkLen);
              var blob = new Blob([wavData], { type: 'audio/wav' });
              audioChunkQueue.push(blob);
              if (!isPlayingChunk) playNextChunk();
            }
            return pump();
          });
        }

        return pump();
      }).catch(function() {
        tryNonStreaming(remainingText);
      });
    }

    function tryNonStreaming(txt) {
      fetch(BASE + '/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: txt, voiceId: selectedVoiceId })
      }).then(function(resp) {
        if (!resp.ok) throw new Error('TTS failed: ' + resp.status);
        return resp.arrayBuffer();
      }).then(function(buf) {
        onTtsSuccess();
        var blob = new Blob([buf], { type: 'audio/wav' });
        audioChunkQueue.push(blob);
        streamDone = true;
        if (!isPlayingChunk) playNextChunk();
      }).catch(function() {
        onTtsFailed();
      });
    }

    tryStreaming();
  }

  function stopSpeaking() {
    speechQueue = [];
    audioChunkQueue = [];
    isPlayingChunk = false;
    isSpeaking = false;
    ttsConsecutiveFailures = 0;
    ttsDisabledUntilReset = false;
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
  }

  function stripHtml(text) {
    return text.replace(/<[^>]*>/g, '').replace(/[ \t]+/g, ' ').trim();
  }

  function addVoiceBlock(text, isUser) {
    var container = document.getElementById('voiceMessages');
    if (!container) return;
    var emptyMsg = container.querySelector('.voice-empty');
    if (emptyMsg) emptyMsg.remove();
    var lastChild = container.lastElementChild;
    if (!isUser && !_voiceBreakNext && !isLoadingHistory && lastChild && lastChild.classList.contains('voice-block') && !lastChild.classList.contains('voice-block-user')) {
      var contentSpan = lastChild.querySelector('.voice-block-content');
      if (contentSpan) {
        contentSpan.textContent += '\n' + stripHtml(text);
        lastChild._fullText = (lastChild._fullText || contentSpan.textContent) + '\n' + text;
        scrollVoiceToBottom();
        return lastChild;
      }
    }
    _voiceBreakNext = false;
    var div = document.createElement('div');
    div.className = 'voice-block' + (isUser ? ' voice-block-user' : '');
    if (isUser) {
      div.textContent = text;
    } else {
      var contentSpan = document.createElement('span');
      contentSpan.className = 'voice-block-content';
      contentSpan.textContent = stripHtml(text);
      div.appendChild(contentSpan);
      div._fullText = text;
      var rereadBtn = document.createElement('button');
      rereadBtn.className = 'voice-reread-btn';
      rereadBtn.title = 'Re-read aloud';
      rereadBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
      rereadBtn.addEventListener('click', function() {
        speak(div._fullText || contentSpan.textContent);
      });
      div.appendChild(rereadBtn);
    }
    container.appendChild(div);
    scrollVoiceToBottom();
    return div;
  }

  function addVoiceResultBlock(block, autoSpeak) {
    var container = document.getElementById('voiceMessages');
    if (!container) return;
    var emptyMsg = container.querySelector('.voice-empty');
    if (emptyMsg) emptyMsg.remove();
    var div = document.createElement('div');
    div.className = 'voice-block';
    var isError = block.is_error || false;
    var duration = block.duration_ms ? (block.duration_ms / 1000).toFixed(1) + 's' : '';
    var cost = block.total_cost_usd ? '$' + block.total_cost_usd.toFixed(4) : '';
    var resultText = '';
    if (block.result) {
      resultText = typeof block.result === 'string' ? block.result : JSON.stringify(block.result);
    }
    var displayText = stripHtml(resultText);
    var html = '';
    if (displayText) {
      html += '<div>' + escapeHtml(displayText) + '</div>';
    }
    if (duration || cost) {
      html += '<div class="voice-result-stats">';
      if (duration) html += duration;
      if (duration && cost) html += ' | ';
      if (cost) html += cost;
      html += '</div>';
    }
    if (!html) {
      html = isError ? 'Execution failed' : 'Execution complete';
    }
    div.innerHTML = html;
    if (resultText) {
      var rereadBtn = document.createElement('button');
      rereadBtn.className = 'voice-reread-btn';
      rereadBtn.title = 'Re-read aloud';
      rereadBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
      rereadBtn.addEventListener('click', function() {
        speak(resultText);
      });
      div.appendChild(rereadBtn);
    }
    container.appendChild(div);
    scrollVoiceToBottom();
    if (autoSpeak && ttsEnabled && resultText) {
      speak(resultText);
    }
    return div;
  }

  function scrollVoiceToBottom() {
    var scroll = document.getElementById('voiceScroll');
    if (scroll) {
      requestAnimationFrame(function() {
        scroll.scrollTop = scroll.scrollHeight;
      });
    }
  }

  function sendVoiceToServer() {
    if (typeof agentGUIClient !== 'undefined' && agentGUIClient && agentGUIClient.wsManager && agentGUIClient.wsManager.isConnected) {
      agentGUIClient.wsManager.sendMessage({ type: 'set_voice', voiceId: selectedVoiceId });
    }
  }

  function setupStreamingListener() {
    window.addEventListener('ws-message', function(e) {
      var data = e.detail;
      if (!data) return;
      if (data.type === 'tts_audio' && data.audio && data.voiceId === selectedVoiceId) {
        cacheTTSAudio(data.cacheKey, data.audio);
      }
      if (data.type === 'sync_connected') {
        sendVoiceToServer();
      }
      if (!voiceActive) return;
      if (data.type === 'streaming_progress' && data.block) {
        if (data.conversationId && data.conversationId !== currentConversationId) return;
        if (data.seq !== undefined && renderedSeqs.has(data.seq)) return;
        if (data.seq !== undefined) renderedSeqs.add(data.seq);
        handleVoiceBlock(data.block, true, data.blockRole);
      }
      if (data.type === 'message_created' && data.message) {
        if (data.conversationId && data.conversationId !== currentConversationId) return;
        var message = data.message;
        if (message.role === 'user' && message.content) {
          handleVoiceBlock({ type: 'text', text: message.content }, true, 'user');
        }
      }
      if (data.type === 'streaming_start') {
        if (data.conversationId && data.conversationId !== currentConversationId) return;
        spokenChunks = new Set();
        renderedSeqs = new Set();
        _voiceBreakNext = false;
      }
    });
    window.addEventListener('conversation-selected', function(e) {
      var newConversationId = e.detail.conversationId;
      if (currentConversationId && currentConversationId !== newConversationId) {
        unsubscribeFromConversation();
      }
      currentConversationId = newConversationId;
      stopSpeaking();
      spokenChunks = new Set();
      renderedSeqs = new Set();
      if (voiceActive) {
        loadVoiceBlocks(currentConversationId);
      }
    });
  }

  function handleVoiceBlock(block, isNew, blockRole) {
    if (!block || !block.type) return;
    if (block.type === 'text' && block.text) {
      var now = Date.now();
      if (_lastVoiceBlockText === block.text && (now - _lastVoiceBlockTime) < 500) {
        return;
      }
      _lastVoiceBlockText = block.text;
      _lastVoiceBlockTime = now;

      var isUser = blockRole === 'user' || blockRole === 'tool_result';
      var div = addVoiceBlock(block.text, isUser);
      if (div && isNew && ttsEnabled && blockRole === 'assistant') {
        div.classList.add('speaking');
        speak(block.text);
        setTimeout(function() { div.classList.remove('speaking'); }, 2000);
      }
    } else if (block.type === 'result') {
      _voiceBreakNext = true;
    }
  }

  function loadVoiceBlocks(conversationId) {
    var container = document.getElementById('voiceMessages');
    if (!container) return;
    container.innerHTML = '';
    _lastVoiceBlockText = null;
    _lastVoiceBlockTime = 0;
    _voiceBreakNext = false;
    if (!conversationId) {
      showVoiceEmpty(container);
      unsubscribeFromConversation();
      return;
    }
    isLoadingHistory = true;
    subscribeToConversation(conversationId);
    if (window.wsClient) {
      window.wsClient.rpc('conv.chunks', { id: conversationId })
        .then(function(data) {
          if (!data.ok || !Array.isArray(data.chunks) || data.chunks.length === 0) {
            isLoadingHistory = false;
            showVoiceEmpty(container);
            return;
          }
          var hasContent = false;
          _voiceBreakNext = false;
          data.chunks.forEach(function(chunk) {
            if (chunk.sequence !== undefined) renderedSeqs.add(chunk.sequence);
            var block = typeof chunk.data === 'string' ? JSON.parse(chunk.data) : chunk.data;
            if (!block) return;
            if (block.type === 'text' && block.text) {
              var isUser = chunk.type === 'user';
              addVoiceBlock(block.text, isUser);
              hasContent = true;
            } else if (block.type === 'result') {
              _voiceBreakNext = true;
            }
          });
          if (!hasContent) showVoiceEmpty(container);
          isLoadingHistory = false;
        })
        .catch(function() {
          isLoadingHistory = false;
          showVoiceEmpty(container);
        });
    } else {
      isLoadingHistory = false;
      showVoiceEmpty(container);
    }
  }

  function subscribeToConversation(conversationId) {
    if (!conversationId || typeof agentGUIClient === 'undefined' || !agentGUIClient || !agentGUIClient.wsManager) {
      return;
    }
    agentGUIClient.wsManager.sendMessage({ type: 'subscribe', conversationId: conversationId, timestamp: Date.now() });
  }

  function unsubscribeFromConversation() {
    if (typeof agentGUIClient === 'undefined' || !agentGUIClient || !agentGUIClient.wsManager || !currentConversationId) {
      return;
    }
    agentGUIClient.wsManager.sendMessage({ type: 'unsubscribe', conversationId: currentConversationId, timestamp: Date.now() });
  }

  function showVoiceEmpty(container) {
    container.innerHTML = '<div class="voice-empty"><div class="voice-empty-icon"><svg viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg></div><div>Hold the microphone button to record.<br>Release to transcribe. Tap Send to submit.<br>New responses will be read aloud.</div></div>';
  }

  function activate() {
    voiceActive = true;
    if (currentConversationId) {
      loadVoiceBlocks(currentConversationId);
    } else {
      var container = document.getElementById('voiceMessages');
      if (container && !container.hasChildNodes()) {
        showVoiceEmpty(container);
      }
    }
  }

  function deactivate() {
    voiceActive = false;
    stopSpeaking();
    unsubscribeFromConversation();
  }

  function escapeHtml(text) {
    var map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return text.replace(/[&<>"']/g, function(c) { return map[c]; });
  }

  window.voiceModule = {
    activate: activate,
    deactivate: deactivate,
    handleBlock: handleVoiceBlock
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
