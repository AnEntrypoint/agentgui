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
  var scriptNode = null;
  var recordedChunks = [];
  var TARGET_SAMPLE_RATE = 16000;
  var spokenChunks = new Set();
  var isLoadingHistory = false;
  var selectedVoiceId = localStorage.getItem('voice-selected-id') || 'default';

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
    fetch(BASE + '/api/voices')
      .then(function(res) { return res.json(); })
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
      .catch(function() {});
    selector.addEventListener('change', function() {
      selectedVoiceId = selector.value;
      localStorage.setItem('voice-selected-id', selectedVoiceId);
    });
  }

  function syncVoiceSelector() {
    var voiceSelector = document.querySelector('[data-voice-agent-selector]');
    var mainSelector = document.querySelector('[data-agent-selector]');
    if (!voiceSelector || !mainSelector) return;
    voiceSelector.innerHTML = mainSelector.innerHTML;
    if (mainSelector.value) voiceSelector.value = mainSelector.value;
  }

  function setupAgentSelector() {
    var voiceSelector = document.querySelector('[data-voice-agent-selector]');
    if (!voiceSelector) return;
    var mainSelector = document.querySelector('[data-agent-selector]');
    if (mainSelector) {
      syncVoiceSelector();
      mainSelector.addEventListener('change', function() {
        voiceSelector.value = mainSelector.value;
      });
      voiceSelector.addEventListener('change', function() {
        mainSelector.value = voiceSelector.value;
      });
    }
    window.addEventListener('agents-loaded', syncVoiceSelector);
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
      el.textContent = '';
      el.setAttribute('data-final', '');
    }
    try {
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
      var source = audioContext.createMediaStreamSource(mediaStream);
      scriptNode = audioContext.createScriptProcessor(4096, 1, 1);
      recordedChunks = [];
      scriptNode.onaudioprocess = function(e) {
        var data = e.inputBuffer.getChannelData(0);
        recordedChunks.push(new Float32Array(data));
      };
      source.connect(scriptNode);
      scriptNode.connect(audioContext.destination);
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
    if (scriptNode) { scriptNode.disconnect(); scriptNode = null; }
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
    if (el) el.textContent = 'Transcribing...';
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
          el.textContent = data.text;
          el.setAttribute('data-final', data.text);
        }
      } else if (data.error) {
        if (el) el.textContent = 'Error: ' + data.error;
      } else {
        if (el) el.textContent = '';
      }
    } catch (e) {
      if (el) el.textContent = 'Transcription failed: ' + e.message;
    }
  }

  function sendVoiceMessage() {
    var el = document.getElementById('voiceTranscript');
    if (!el) return;
    var text = el.textContent.trim();
    if (!text || text.startsWith('Transcribing') || text.startsWith('Error')) return;
    addVoiceBlock(text, true);
    el.textContent = '';
    el.setAttribute('data-final', '');
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
    speechQueue.push(clean);
    processQueue();
  }

  var audioChunkQueue = [];
  var isPlayingChunk = false;
  var streamDone = false;

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
    isSpeaking = true;
    streamDone = false;
    var text = speechQueue.shift();
    audioChunkQueue = [];
    isPlayingChunk = false;
    
    function tryStreaming() {
      fetch(BASE + '/api/tts-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text, voiceId: selectedVoiceId })
      }).then(function(resp) {
        if (!resp.ok) throw new Error('TTS stream failed');
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
        tryNonStreaming(text);
      });
    }
    
    function tryNonStreaming(txt) {
      fetch(BASE + '/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: txt, voiceId: selectedVoiceId })
      }).then(function(resp) {
        if (!resp.ok) throw new Error('TTS failed');
        return resp.arrayBuffer();
      }).then(function(buf) {
        var blob = new Blob([buf], { type: 'audio/wav' });
        audioChunkQueue.push(blob);
        if (!isPlayingChunk) playNextChunk();
        streamDone = true;
        isSpeaking = false;
        processQueue();
      }).catch(function() {
        streamDone = true;
        isSpeaking = false;
        processQueue();
      });
    }
    
    tryStreaming();
  }

  function stopSpeaking() {
    speechQueue = [];
    audioChunkQueue = [];
    isPlayingChunk = false;
    isSpeaking = false;
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
  }

  function stripHtml(text) {
    return text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  }

  function addVoiceBlock(text, isUser) {
    var container = document.getElementById('voiceMessages');
    if (!container) return;
    var emptyMsg = container.querySelector('.voice-empty');
    if (emptyMsg) emptyMsg.remove();
    var div = document.createElement('div');
    div.className = 'voice-block' + (isUser ? ' voice-block-user' : '');
    div.textContent = isUser ? text : stripHtml(text);
    if (!isUser) {
      var rereadBtn = document.createElement('button');
      rereadBtn.className = 'voice-reread-btn';
      rereadBtn.title = 'Re-read aloud';
      rereadBtn.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"/></svg>';
      rereadBtn.addEventListener('click', function() {
        speak(text);
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

  function setupStreamingListener() {
    window.addEventListener('ws-message', function(e) {
      if (!voiceActive) return;
      var data = e.detail;
      if (!data) return;
      if (data.type === 'streaming_progress' && data.block) {
        handleVoiceBlock(data.block, true);
      }
      if (data.type === 'streaming_start') {
        spokenChunks = new Set();
      }
    });
    window.addEventListener('conversation-selected', function(e) {
      currentConversationId = e.detail.conversationId;
      stopSpeaking();
      spokenChunks = new Set();
      if (voiceActive) {
        loadVoiceBlocks(currentConversationId);
      }
    });
  }

  function handleVoiceBlock(block, isNew) {
    if (!block || !block.type) return;
    if (block.type === 'text' && block.text) {
      var div = addVoiceBlock(block.text, false);
      if (div && isNew && ttsEnabled) {
        div.classList.add('speaking');
        speak(block.text);
        setTimeout(function() { div.classList.remove('speaking'); }, 2000);
      }
    } else if (block.type === 'result') {
      addVoiceResultBlock(block, isNew);
    }
  }

  function loadVoiceBlocks(conversationId) {
    var container = document.getElementById('voiceMessages');
    if (!container) return;
    container.innerHTML = '';
    if (!conversationId) {
      showVoiceEmpty(container);
      return;
    }
    isLoadingHistory = true;
    fetch(BASE + '/api/conversations/' + conversationId + '/chunks')
      .then(function(res) { return res.json(); })
      .then(function(data) {
        isLoadingHistory = false;
        if (!data.ok || !Array.isArray(data.chunks) || data.chunks.length === 0) {
          showVoiceEmpty(container);
          return;
        }
        var hasContent = false;
        data.chunks.forEach(function(chunk) {
          var block = typeof chunk.data === 'string' ? JSON.parse(chunk.data) : chunk.data;
          if (!block) return;
          if (block.type === 'text' && block.text) {
            addVoiceBlock(block.text, false);
            hasContent = true;
          } else if (block.type === 'result') {
            addVoiceResultBlock(block, false);
            hasContent = true;
          }
        });
        if (!hasContent) showVoiceEmpty(container);
      })
      .catch(function() {
        isLoadingHistory = false;
        showVoiceEmpty(container);
      });
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
