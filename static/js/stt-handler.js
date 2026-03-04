(function() {
  var BASE = window.__BASE_URL || '';
  var isRecording = false;
  var mediaStream = null;
  var audioContext = null;
  var workletNode = null;
  var recordedChunks = [];
  var TARGET_SAMPLE_RATE = 16000;

  window.STTHandler = {
    isRecording: function() { return isRecording; },

    startRecording: async function() {
      if (isRecording) return;
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
        return { success: true };
      } catch (e) {
        isRecording = false;
        return { success: false, error: e.message };
      }
    },

    stopRecording: async function() {
      if (!isRecording) return { success: false, error: 'Not recording' };
      isRecording = false;

      if (workletNode) {
        workletNode.port.postMessage('stop');
        workletNode.disconnect();
        workletNode = null;
      }

      if (mediaStream) {
        mediaStream.getTracks().forEach(function(t) { t.stop(); });
        mediaStream = null;
      }

      var sourceSampleRate = audioContext ? audioContext.sampleRate : 48000;
      if (audioContext) {
        audioContext.close().catch(function() {});
        audioContext = null;
      }

      if (recordedChunks.length === 0) {
        return { success: false, error: 'No audio recorded' };
      }

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
      var wavBuffer = encodeWav(resampled, TARGET_SAMPLE_RATE);

      try {
        var resp = await fetch(BASE + '/api/stt', {
          method: 'POST',
          headers: { 'Content-Type': 'audio/wav' },
          body: wavBuffer
        });
        var data = await resp.json();
        if (data.text) {
          return { success: true, text: data.text };
        } else if (data.error) {
          return { success: false, error: data.error };
        } else {
          return { success: false, error: 'No transcription returned' };
        }
      } catch (e) {
        return { success: false, error: 'Transcription failed: ' + e.message };
      }
    }
  };

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
})();
