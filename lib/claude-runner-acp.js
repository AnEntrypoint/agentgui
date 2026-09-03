import { spawn } from 'child_process';
import { AgentRunner, getSpawnOptions, resolveCommand } from './claude-runner.js';
import { ensureRunning as ensureAcpHttpRunning } from './acp-sdk-manager.js';
import { createACPHttpProtocolHandler, parseSSEChunk } from './acp-http-protocol.js';

function buildEnhancedHandler({ proc, outputs, sessionRef, promptIdRef, completedRef, drainingRef, requestIdRef, originalHandler, resolve, reject, clearTimeoutHandle, promptText }) {
  return function(message) {
    if (message.id && message.result && message.result.sessionId) {
      sessionRef.value = message.result.sessionId;
      promptIdRef.value = ++requestIdRef.value;
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: promptIdRef.value, method: 'session/prompt', params: { sessionId: sessionRef.value, prompt: [{ type: 'text', text: promptText }] } }) + '\n');
      return;
    }
    if (promptIdRef.value !== null && message.id === promptIdRef.value && message.result && message.result.stopReason) {
      completedRef.value = true; drainingRef.value = true;
      clearTimeoutHandle();
      setTimeout(() => { drainingRef.value = false; try { proc.kill(); } catch (e) {} resolve({ outputs, sessionId: sessionRef.value }); }, 1000);
      return;
    }
    if (promptIdRef.value !== null && message.id === promptIdRef.value && message.error) {
      completedRef.value = true; drainingRef.value = true;
      clearTimeoutHandle();
      originalHandler(message);
      setTimeout(() => { drainingRef.value = false; try { proc.kill(); } catch (e) {} reject(new Error(message.error.message || 'ACP prompt error')); }, 1000);
      return;
    }
    originalHandler(message);
  };
}

// opencode/kilo (registry entries with transport:'http') are live-verified
// (lib/acp-http-protocol.js) to serve their normal REST+SSE API under `acp
// --port`, already spawned as a long-lived server by acp-sdk-manager.js for
// health/model discovery. This path reuses that same running server for the
// actual prompt instead of spawning a fresh stdio subprocess per turn -
// consolidating the two ACP process managers for these two agents only. The
// other stdio-based ACP agents (gemini, goose, openhands, etc) are untouched.
AgentRunner.prototype._runACPHttp = async function(prompt, cwd, config = {}) {
  const { timeout = 300000, onEvent = null } = config;
  const port = await ensureAcpHttpRunning(this.id);
  if (!port) { const e = new Error(`${this.name} ACP HTTP server not reachable`); e.isPrematureEnd = true; throw e; }
  const base = `http://127.0.0.1:${port}`;
  const sessionRes = await fetch(`${base}/session`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}), signal: AbortSignal.timeout(10000) });
  if (!sessionRes.ok) throw new Error(`${this.name} ACP HTTP session create failed: ${sessionRes.status}`);
  const session = await sessionRes.json();
  const sessionId = session.id || session.sessionID;
  if (!sessionId) throw new Error(`${this.name} ACP HTTP session response missing id`);

  const handler = createACPHttpProtocolHandler();
  const outputs = [];
  const evController = new AbortController();
  const timeoutHandle = setTimeout(() => evController.abort(), timeout);

  const evPromise = fetch(`${base}/global/event`, { signal: evController.signal }).then(async (res) => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = parseSSEChunk(buffer);
      buffer = '';
      for (const frame of frames) {
        const normalized = handler(frame, { sessionId });
        if (!normalized) continue;
        outputs.push(normalized);
        if (onEvent) { try { onEvent(normalized); } catch (e) { console.error(`[${this.id}] onEvent error: ${e.message}`); } }
        if (normalized.type === 'result') { clearTimeout(timeoutHandle); return; }
      }
    }
  }).catch(() => {});

  const messageRes = await fetch(`${base}/session/${sessionId}/message`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parts: [{ type: 'text', text: prompt }] }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!messageRes.ok) { evController.abort(); throw new Error(`${this.name} ACP HTTP message failed: ${messageRes.status}`); }

  await evPromise;
  evController.abort();
  return { outputs, sessionId };
};

AgentRunner.prototype.runACP = async function(prompt, cwd, config = {}, _retryCount = 0) {
  const maxRetries = config.maxRetries ?? 1;
  if (this.transport === 'http') return this._runACPHttp(prompt, cwd, config);
  try {
    return await this._runACPOnce(prompt, cwd, config);
  } catch (err) {
    const isEmptyExit = err.isPrematureEnd || (err.message && err.message.includes('ACP exited with code'));
    const isBinaryError = err.code === 'ENOENT' || (err.message && err.message.includes('ENOENT'));
    if ((isEmptyExit || isBinaryError) && _retryCount < maxRetries) {
      const delay = Math.min(1000 * Math.pow(2, _retryCount), 5000);
      console.error(`[${this.id}] ACP attempt ${_retryCount + 1} failed: ${err.message}. Retrying in ${delay}ms...`);
      await new Promise(r => setTimeout(r, delay));
      return this.runACP(prompt, cwd, config, _retryCount + 1);
    }
    if (err.isPrematureEnd) {
      const premErr = new Error(err.message);
      premErr.isPrematureEnd = true;
      premErr.exitCode = err.exitCode;
      premErr.stderrText = err.stderrText;
      throw premErr;
    }
    throw err;
  }
};

AgentRunner.prototype._runACPOnce = function(prompt, cwd, config = {}) {
  return new Promise((resolve, reject) => {
    const { timeout = 300000, onEvent = null, onError = null } = config;
    let cmd, args;
    if (this.requiresAdapter && this.adapterCommand) {
      cmd = this.adapterCommand; args = [...this.adapterArgs];
    } else {
      const resolved = resolveCommand(this.command, this.npxPackage);
      cmd = resolved.cmd; args = [...resolved.prefixArgs, ...this.buildArgs(prompt, config)];
    }
    const spawnOpts = getSpawnOptions(cwd);
    if (Object.keys(this.spawnEnv).length > 0) spawnOpts.env = { ...spawnOpts.env, ...this.spawnEnv };
    const proc = spawn(cmd, args, spawnOpts);

    if (config.onPid) { try { config.onPid(proc.pid); } catch (e) { console.error(`[${this.id}] onPid callback failed:`, e.message); } }
    if (config.onProcess) { try { config.onProcess(proc); } catch (e) { console.error(`[${this.id}] onProcess callback failed:`, e.message); } }

    const outputs = [];
    let timedOut = false;
    let stderrText = '';
    const sessionRef = { value: null };
    const promptIdRef = { value: null };
    const completedRef = { value: false };
    const drainingRef = { value: false };
    const requestIdRef = { value: 0 };
    let initialized = false;

    const timeoutHandle = setTimeout(() => { timedOut = true; proc.kill(); reject(new Error(`${this.name} ACP timeout after ${timeout}ms`)); }, timeout);
    const clearTimeoutHandle = () => clearTimeout(timeoutHandle);

    const originalHandler = (message) => {
      const normalized = this.protocolHandler(message, { sessionId: sessionRef.value, initialized });
      if (!normalized) { if (message.id === 1 && message.result) initialized = true; return; }
      outputs.push(normalized);
      if (normalized.session_id) sessionRef.value = normalized.session_id;
      if (onEvent) { try { onEvent(normalized); } catch (e) { console.error(`[${this.id}] onEvent error: ${e.message}`); } }
    };

    const enhancedHandler = buildEnhancedHandler({ proc, outputs, sessionRef, promptIdRef, completedRef, drainingRef, requestIdRef, originalHandler, resolve, reject, clearTimeoutHandle, promptText: prompt });

    proc.stdout.on('error', () => {});
    proc.stderr.on('error', () => {});
    proc.stderr.on('data', (chunk) => {
      const errorText = chunk.toString();
      stderrText += errorText;
      console.error(`[${this.id}] stderr:`, errorText);
      if (onError) { try { onError(errorText); } catch (e) {} }
    });

    proc.stdin.on('error', () => {});
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++requestIdRef.value, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true }, clientInfo: { name: 'agentgui', title: 'AgentGUI', version: '1.0.0' } } }) + '\n');

    let buffer = '';
    proc.stdout.on('data', (chunk) => {
      if (timedOut || (completedRef.value && !drainingRef.value)) return;
      buffer += chunk.toString();
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        if (line.trim()) {
          try {
            const message = JSON.parse(line);
            if (message.id === 1 && message.result) initialized = true;
            enhancedHandler(message);
          } catch (e) { console.error(`[${this.id}] JSON parse error:`, line.substring(0, 100)); }
        }
      }
    });

    const checkInitAndSend = () => {
      if (initialized) {
        const sessionParams = { cwd, mcpServers: [] };
        if (config.model) sessionParams.model = config.model;
        if (config.subAgent) sessionParams.agent = config.subAgent;
        if (config.systemPrompt) sessionParams.systemPrompt = config.systemPrompt;
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: ++requestIdRef.value, method: 'session/new', params: sessionParams }) + '\n');
      } else {
        setTimeout(checkInitAndSend, 100);
      }
    };
    setTimeout(checkInitAndSend, 200);

    proc.on('close', (code) => {
      clearTimeout(timeoutHandle);
      if (timedOut || completedRef.value) return;
      if (buffer.trim()) {
        try {
          const message = JSON.parse(buffer.trim());
          if (message.id === 1 && message.result) initialized = true;
          enhancedHandler(message);
        } catch (e) {}
      }
      if (code === 0 || outputs.length > 0) resolve({ outputs, sessionId: sessionRef.value });
      else {
        const detail = stderrText ? `: ${stderrText.substring(0, 200)}` : '';
        const err = new Error(`${this.name} ACP exited with code ${code}${detail}`);
        err.isPrematureEnd = true; err.exitCode = code; err.stderrText = stderrText;
        reject(err);
      }
    });

    proc.on('error', (err) => { clearTimeout(timeoutHandle); reject(err); });
  });
};
