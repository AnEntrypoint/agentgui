(function() {
  var ws = null;
  var term = null;
  var fitAddon = null;
  var termActive = false;
  var BASE = window.__BASE_URL || '';

  function getWsUrl() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + BASE + '/sync';
  }

  function getCwd() {
    try {
      if (window.conversationManager) {
        var mgr = window.conversationManager;
        var id = mgr.activeId;
        if (id && mgr.conversations) {
          var conv = mgr.conversations.find(function(c) { return c.id === id; });
          if (conv && conv.workingDirectory) return conv.workingDirectory;
        }
      }
    } catch (_) {}
    return undefined;
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
      if (ws && ws.readyState === WebSocket.OPEN) {
        var encoded = btoa(unescape(encodeURIComponent(data)));
        ws.send(JSON.stringify({ type: 'terminal_input', data: encoded }));
      }
    });

    term.onResize(function(size) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'terminal_resize', cols: size.cols, rows: size.rows }));
      }
    });

    var resizeTimer;
    window.addEventListener('resize', function() {
      if (fitAddon) {
        try { fitAddon.fit(); } catch(_) {}
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(function() {
          if (term && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'terminal_resize', cols: term.cols, rows: term.rows }));
          }
        }, 200);
      }
    });

    output.addEventListener('click', function() {
      if (term && term.focus) term.focus();
    });

    return true;
  }

  function connectAndStart() {
    var cwd = getCwd();
    if (ws && ws.readyState === WebSocket.OPEN) {
      var dims = term ? { cols: term.cols, rows: term.rows } : { cols: 80, rows: 24 };
      ws.send(JSON.stringify({ type: 'terminal_start', cwd: cwd, cols: dims.cols, rows: dims.rows }));
      setTimeout(function() { if (term && term.focus) term.focus(); }, 100);
      return;
    }
    if (ws && ws.readyState === WebSocket.CONNECTING) {
      return;
    }

    ws = new WebSocket(getWsUrl());
    ws.onopen = function() {
      var dims = term ? { cols: term.cols, rows: term.rows } : { cols: 80, rows: 24 };
      ws.send(JSON.stringify({ type: 'terminal_start', cwd: cwd, cols: dims.cols, rows: dims.rows }));
      setTimeout(function() { if (term && term.focus) term.focus(); }, 100);
    };
    ws.onmessage = function(e) {
      try {
        var msg = JSON.parse(e.data);
        if (msg.type === 'terminal_output' && term) {
          var raw = msg.encoding === 'base64'
            ? decodeURIComponent(escape(atob(msg.data)))
            : msg.data;
          term.write(raw);
        } else if (msg.type === 'terminal_exit' && term) {
          term.write('\r\n[Process exited with code ' + msg.code + ']\r\n');
          if (termActive) setTimeout(connectAndStart, 2000);
        }
      } catch(_) {}
    };
    ws.onclose = function() {
      ws = null;
      if (termActive) setTimeout(connectAndStart, 2000);
    };
    ws.onerror = function() {};
  }

  function startTerminal() {
    if (!ensureTerm()) {
      setTimeout(startTerminal, 200);
      return;
    }
    termActive = true;
    connectAndStart();
    setTimeout(function() { if (fitAddon) try { fitAddon.fit(); } catch(_) {} }, 100);
  }

  function stopTerminal() {
    termActive = false;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'terminal_stop' }));
    }
    if (ws) {
      ws.close();
      ws = null;
    }
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
      connectAndStart();
      setTimeout(function() { if (fitAddon) try { fitAddon.fit(); } catch(_) {} }, 50);
      setTimeout(function() { if (fitAddon) try { fitAddon.fit(); } catch(_) {} }, 300);
    } else if (termActive) {
      stopTerminal();
    }
  });

  window.terminalModule = {
    start: startTerminal,
    stop: stopTerminal,
    getTerminal: function() { return term; },
    isActive: function() { return termActive; }
  };
})();
