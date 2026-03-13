(function() {
  var term = null;
  var fitAddon = null;
  var termActive = false;
  var BASE = window.__BASE_URL || '';
  var _wsListener = null;

  function getCwd() {
    try {
      if (window.conversationManager && window.conversationManager.activeId) {
        var mgr = window.conversationManager;
        var conv = mgr.conversations && mgr.conversations.find(function(c) { return c.id === mgr.activeId; });
        if (conv && conv.workingDirectory) return conv.workingDirectory;
      }
      if (window.currentConversation && window.conversationManager && window.conversationManager.conversations) {
        var match = window.conversationManager.conversations.find(function(c) { return c.id === window.currentConversation; });
        if (match && match.workingDirectory) return match.workingDirectory;
      }
    } catch (_) {}
    return undefined;
  }

  function wsSend(obj) {
    if (window.wsManager && window.wsManager.sendMessage) {
      window.wsManager.sendMessage(obj);
    }
  }

  function ensureTerm() {
    var output = document.getElementById('terminalOutput');
    if (!output) return false;
    if (term) return true;
    if (!window.Terminal || !window.FitAddon) return false;

    term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#e6edf3',
        selectionBackground: '#3b4455'
      },
      convertEol: true,
      scrollback: 5000
    });
    fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    output.innerHTML = '';
    term.open(output);
    fitAddon.fit();

    term.onData(function(data) {
      var encoded = btoa(unescape(encodeURIComponent(data)));
      wsSend({ type: 'terminal_input', data: encoded });
    });

    term.onResize(function(size) {
      wsSend({ type: 'terminal_resize', cols: size.cols, rows: size.rows });
    });

    var resizeTimer;
    window.addEventListener('resize', function() {
      if (fitAddon) {
        try { fitAddon.fit(); } catch(_) {}
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function() {
          if (term) wsSend({ type: 'terminal_resize', cols: term.cols, rows: term.rows });
        }, 200);
      }
    });

    document.getElementById('terminalOutput').addEventListener('click', function() {
      if (term && term.focus) term.focus();
    });

    return true;
  }

  function installWsListener() {
    if (_wsListener || !window.wsManager) return;
    _wsListener = function(msg) {
      if (!termActive) return;
      if (msg.type === 'terminal_output' && term) {
        var raw = msg.encoding === 'base64'
          ? decodeURIComponent(escape(atob(msg.data)))
          : msg.data;
        term.write(raw);
      } else if (msg.type === 'terminal_exit' && term) {
        term.write('\r\n[Process exited with code ' + msg.code + ']\r\n');
        if (termActive) setTimeout(startSession, 2000);
      }
    };
    window.wsManager.on('message', _wsListener);
  }

  function startSession() {
    if (!window.wsManager) return;
    installWsListener();
    var cwd = getCwd();
    var dims = term ? { cols: term.cols, rows: term.rows } : { cols: 80, rows: 24 };
    wsSend({ type: 'terminal_start', cwd: cwd, cols: dims.cols, rows: dims.rows });
    setTimeout(function() { if (term && term.focus) term.focus(); }, 100);
  }

  function startTerminal() {
    if (!ensureTerm()) {
      setTimeout(startTerminal, 200);
      return;
    }
    termActive = true;
    if (window.wsManager && window.wsManager.isConnected) {
      startSession();
    } else if (window.wsManager) {
      var onConnected = function() {
        window.wsManager.off('connected', onConnected);
        startSession();
      };
      window.wsManager.on('connected', onConnected);
    }
    setTimeout(function() { if (fitAddon) try { fitAddon.fit(); } catch(_) {} }, 100);
  }

  function stopTerminal() {
    termActive = false;
    wsSend({ type: 'terminal_stop' });
  }

  function initTerminalEarly() {
    if (!ensureTerm()) {
      setTimeout(initTerminalEarly, 200);
      return;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTerminalEarly);
  } else {
    initTerminalEarly();
  }

  window.addEventListener('view-switched', function(e) {
    if (e.detail.view === 'terminal') {
      if (!ensureTerm()) {
        setTimeout(function() { window.dispatchEvent(new CustomEvent('view-switched', { detail: { view: 'terminal' } })); }, 200);
        return;
      }
      termActive = true;
      startSession();
      setTimeout(function() { if (fitAddon) try { fitAddon.fit(); } catch(_) {} }, 50);
      setTimeout(function() { if (fitAddon) try { fitAddon.fit(); } catch(_) {} }, 300);
    } else if (termActive) {
      stopTerminal();
    }
  });

  window.addEventListener('conversation-changed', function() {
    if (!termActive) return;
    var cwd = getCwd();
    var dims = term ? { cols: term.cols, rows: term.rows } : { cols: 80, rows: 24 };
    wsSend({ type: 'terminal_start', cwd: cwd, cols: dims.cols, rows: dims.rows });
    if (term) term.write('\r\n\x1b[33m[Switched to: ' + (cwd || '/') + ']\x1b[0m\r\n');
  });

  window.terminalModule = {
    start: startTerminal,
    stop: stopTerminal,
    getTerminal: function() { return term; },
    isActive: function() { return termActive; }
  };
})();
