(function() {
  const BASE = window.__BASE_URL || '';
  let currentConversationId = null;
  let scriptState = { running: false, script: null, hasStart: false, hasDev: false };
  let terminal = null;
  let fitAddon = null;
  let hasTerminalContent = false;
  let resizeObserver = null;

  function init() {
    setupListeners();
    setupButtons();
  }

  function setupListeners() {
    window.addEventListener('conversation-selected', function(e) {
      currentConversationId = e.detail.conversationId;
      hasTerminalContent = false;
      if (terminal) terminal.clear();
      hideTerminalTab();
      checkScripts();
    });

    window.addEventListener('ws-message', function(e) {
      const data = e.detail;
      if (!data || !currentConversationId) return;
      if (data.conversationId !== currentConversationId) return;

      if (data.type === 'script_started') {
        scriptState.running = true;
        scriptState.script = data.script;
        hasTerminalContent = false;
        if (terminal) terminal.clear();
        updateButtons();
        showTerminalTab();
      } else if (data.type === 'script_stopped') {
        scriptState.running = false;
        const msg = data.error ? data.error : ('exited with code ' + (data.code || 0));
        if (terminal) terminal.writeln('\r\n\x1b[90m[process ' + msg + ']\x1b[0m');
        updateButtons();
      } else if (data.type === 'script_output') {
        hasTerminalContent = true;
        showTerminalTab();
        if (terminal) terminal.write(data.data);
      }
    });

    window.addEventListener('resize', debounce(fitTerminal, 200));
  }

  function setupButtons() {
    var startBtn = document.getElementById('scriptStartBtn');
    var devBtn = document.getElementById('scriptDevBtn');
    var stopBtn = document.getElementById('scriptStopBtn');

    if (startBtn) startBtn.addEventListener('click', function() { runScript('start'); });
    if (devBtn) devBtn.addEventListener('click', function() { runScript('dev'); });
    if (stopBtn) stopBtn.addEventListener('click', function() { stopScript(); });
  }

  function checkScripts() {
    if (!currentConversationId) return;
    fetch(BASE + '/api/conversations/' + currentConversationId + '/scripts')
      .then(function(r) { return r.json(); })
      .then(function(data) {
        scriptState.hasStart = data.hasStart;
        scriptState.hasDev = data.hasDev;
        scriptState.running = data.running;
        scriptState.script = data.runningScript;
        updateButtons();
        if (data.running || hasTerminalContent) showTerminalTab();
      })
      .catch(function() {
        scriptState.hasStart = false;
        scriptState.hasDev = false;
        updateButtons();
      });
  }

  function updateButtons() {
    var container = document.getElementById('scriptButtons');
    var startBtn = document.getElementById('scriptStartBtn');
    var devBtn = document.getElementById('scriptDevBtn');
    var stopBtn = document.getElementById('scriptStopBtn');

    var showAny = scriptState.hasStart || scriptState.hasDev || scriptState.running;
    if (container) container.style.display = showAny ? 'flex' : 'none';

    if (scriptState.running) {
      if (startBtn) startBtn.style.display = 'none';
      if (devBtn) devBtn.style.display = 'none';
      if (stopBtn) stopBtn.style.display = 'flex';
    } else {
      if (startBtn) startBtn.style.display = scriptState.hasStart ? 'flex' : 'none';
      if (devBtn) devBtn.style.display = scriptState.hasDev ? 'flex' : 'none';
      if (stopBtn) stopBtn.style.display = 'none';
    }
  }

  function runScript(script) {
    if (!currentConversationId || scriptState.running) return;
    fetch(BASE + '/api/conversations/' + currentConversationId + '/run-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script: script })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok) {
        scriptState.running = true;
        scriptState.script = script;
        hasTerminalContent = false;
        updateButtons();
        showTerminalTab();
        switchToTerminalView();
        ensureTerminal();
        if (terminal) {
          terminal.clear();
          terminal.writeln('\x1b[36m[running npm run ' + script + ']\x1b[0m\r\n');
        }
      }
    })
    .catch(function(err) {
      console.error('Failed to start script:', err);
    });
  }

  function stopScript() {
    if (!currentConversationId) return;
    fetch(BASE + '/api/conversations/' + currentConversationId + '/stop-script', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    }).catch(function(err) {
      console.error('Failed to stop script:', err);
    });
  }

  function showTerminalTab() {
    var btn = document.getElementById('terminalTabBtn');
    if (btn) btn.style.display = '';
  }

  function hideTerminalTab() {
    var btn = document.getElementById('terminalTabBtn');
    if (btn) btn.style.display = 'none';
  }

  function switchToTerminalView() {
    var bar = document.getElementById('viewToggleBar');
    if (!bar) return;
    var termBtn = bar.querySelector('[data-view="terminal"]');
    if (termBtn) termBtn.click();
  }

  function ensureTerminal() {
    if (terminal) return;
    if (typeof window.Terminal === 'undefined') {
      setTimeout(ensureTerminal, 200);
      return;
    }
    var container = document.getElementById('terminalOutput');
    if (!container) return;

    terminal = new window.Terminal({
      cursorBlink: false,
      scrollback: 10000,
      fontSize: 13,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, Monaco, 'Courier New', monospace",
      theme: { background: '#1e1e1e', foreground: '#d4d4d4' },
      convertEol: true,
      disableStdin: true
    });

    if (window.FitAddon) {
      fitAddon = new window.FitAddon.FitAddon();
      terminal.loadAddon(fitAddon);
    }

    terminal.open(container);
    fitTerminal();

    if (resizeObserver) resizeObserver.disconnect();
    resizeObserver = new ResizeObserver(debounce(fitTerminal, 100));
    resizeObserver.observe(container);
  }

  function fitTerminal() {
    if (fitAddon) {
      try { fitAddon.fit(); } catch {}
    }
  }

  function debounce(fn, ms) {
    var timer;
    return function() {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  }

  window.addEventListener('view-switched', function(e) {
    if (e.detail && e.detail.view === 'terminal') {
      ensureTerminal();
      setTimeout(fitTerminal, 50);
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.scriptRunner = {
    getState: function() { return scriptState; },
    getTerminal: function() { return terminal; }
  };
})();
