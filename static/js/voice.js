import { STT, TTS } from '/gm/webtalk/sdk.js';

(function() {
  const BASE = window.__BASE_URL || '';
  let stt = null;
  let tts = null;
  let isRecording = false;
  let ttsEnabled = true;
  let voiceActive = false;
  let lastSpokenBlockIndex = -1;
  let currentConversationId = null;
  let sttReady = false;
  let ttsReady = false;
  let speechQueue = [];
  let isSpeaking = false;

  async function init() {
    setupTTSToggle();
    setupUI();
    setupStreamingListener();
    setupAgentSelector();
    initSTT();
    initTTS();
  }

  async function initSTT() {
    try {
      stt = new STT({
        basePath: BASE + '/webtalk',
        onTranscript: function(text) {
          var el = document.getElementById('voiceTranscript');
          if (el) {
            el.textContent = text;
            el.setAttribute('data-final', text);
          }
        },
        onPartial: function(text) {
          var el = document.getElementById('voiceTranscript');
          if (el) {
            var existing = el.getAttribute('data-final') || '';
            el.textContent = existing + text;
          }
        },
        onStatus: function(status) {
          var micBtn = document.getElementById('voiceMicBtn');
          if (!micBtn) return;
          if (status === 'recording') {
            micBtn.classList.add('recording');
          } else {
            micBtn.classList.remove('recording');
          }
        }
      });
      await stt.init();
      sttReady = true;
    } catch (e) {
      console.warn('STT init failed:', e.message);
    }
  }

  async function initTTS() {
    try {
      tts = new TTS({
        basePath: BASE + '/webtalk',
        apiBasePath: BASE,
        onStatus: function() {},
        onAudioReady: function(url) {
          var audio = new Audio(url);
          audio.onended = function() {
            isSpeaking = false;
            processQueue();
          };
          audio.onerror = function() {
            isSpeaking = false;
            processQueue();
          };
          audio.play().catch(function() {
            isSpeaking = false;
            processQueue();
          });
        }
      });
      await tts.init();
      ttsReady = true;
    } catch (e) {
      console.warn('TTS init failed:', e.message);
    }
  }

  function setupAgentSelector() {
    var voiceSelector = document.querySelector('[data-voice-agent-selector]');
    if (!voiceSelector) return;
    var mainSelector = document.querySelector('[data-agent-selector]');
    if (mainSelector) {
      voiceSelector.innerHTML = mainSelector.innerHTML;
      voiceSelector.value = mainSelector.value;
      mainSelector.addEventListener('change', function() {
        voiceSelector.value = mainSelector.value;
      });
      voiceSelector.addEventListener('change', function() {
        mainSelector.value = voiceSelector.value;
      });
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
      micBtn.addEventListener('click', function(e) {
        e.preventDefault();
        if (!isRecording) {
          startRecording();
        } else {
          stopRecording();
        }
      });
    }
    var sendBtn = document.getElementById('voiceSendBtn');
    if (sendBtn) {
      sendBtn.addEventListener('click', sendVoiceMessage);
    }
  }

  async function startRecording() {
    if (!stt || !sttReady || isRecording) return;
    var el = document.getElementById('voiceTranscript');
    if (el) {
      el.textContent = '';
      el.setAttribute('data-final', '');
    }
    isRecording = true;
    try {
      await stt.startRecording();
    } catch (e) {
      isRecording = false;
      console.warn('Recording start failed:', e.message);
    }
  }

  async function stopRecording() {
    if (!stt || !isRecording) return;
    isRecording = false;
    try {
      await stt.stopRecording();
    } catch (e) {}
  }

  function sendVoiceMessage() {
    var el = document.getElementById('voiceTranscript');
    if (!el) return;
    var text = el.textContent.trim();
    if (!text) return;
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
    if (!ttsEnabled || !tts || !ttsReady) return;
    var clean = text.replace(/<[^>]*>/g, '').trim();
    if (!clean) return;
    speechQueue.push(clean);
    processQueue();
  }

  function processQueue() {
    if (isSpeaking || speechQueue.length === 0) return;
    isSpeaking = true;
    var text = speechQueue.shift();
    tts.generate(text).catch(function() {
      isSpeaking = false;
      processQueue();
    });
  }

  function stopSpeaking() {
    speechQueue = [];
    isSpeaking = false;
    if (tts) tts.stop();
  }

  function addVoiceBlock(text, isUser) {
    var container = document.getElementById('voiceMessages');
    if (!container) return;
    var emptyMsg = container.querySelector('.voice-empty');
    if (emptyMsg) emptyMsg.remove();
    var div = document.createElement('div');
    div.className = 'voice-block' + (isUser ? ' voice-block-user' : '');
    div.textContent = text;
    container.appendChild(div);
    scrollVoiceToBottom();
    return div;
  }

  function addVoiceResultBlock(block) {
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
    var html = '';
    if (resultText) {
      html += '<div>' + escapeHtml(resultText) + '</div>';
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
    container.appendChild(div);
    scrollVoiceToBottom();
    if (ttsEnabled && resultText) {
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
        handleVoiceBlock(data.block);
      }
      if (data.type === 'streaming_start') {
        lastSpokenBlockIndex = -1;
      }
    });
    window.addEventListener('conversation-selected', function(e) {
      currentConversationId = e.detail.conversationId;
      if (voiceActive) {
        loadVoiceBlocks(currentConversationId);
      }
    });
  }

  function handleVoiceBlock(block) {
    if (!block || !block.type) return;
    if (block.type === 'text' && block.text) {
      var div = addVoiceBlock(block.text, false);
      if (div && ttsEnabled) {
        div.classList.add('speaking');
        speak(block.text);
        setTimeout(function() { div.classList.remove('speaking'); }, 2000);
      }
    } else if (block.type === 'result') {
      addVoiceResultBlock(block);
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
    fetch(BASE + '/api/conversations/' + conversationId + '/chunks')
      .then(function(res) { return res.json(); })
      .then(function(data) {
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
            addVoiceResultBlock(block);
            hasContent = true;
          }
        });
        if (!hasContent) showVoiceEmpty(container);
      })
      .catch(function() {
        showVoiceEmpty(container);
      });
  }

  function showVoiceEmpty(container) {
    container.innerHTML = '<div class="voice-empty"><div class="voice-empty-icon"><svg viewBox="0 0 24 24" width="64" height="64" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg></div><div>Tap the microphone and speak to send a message.<br>Responses will be read aloud.</div></div>';
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
