import { spawn, spawnSync } from 'child_process';

const isWindows = process.platform === 'win32';

function getSpawnOptions(cwd, additionalOptions = {}) {
  const options = { cwd, windowsHide: true, ...additionalOptions };
  if (isWindows) {
    options.shell = true;
  }
  if (!options.env) {
    options.env = { ...process.env };
  }
  // Keep CLAUDECODE for plugin support (gm plugin requires this)
  // Don't delete it as it prevents plugins from loading
  return options;
}

function resolveCommand(command, npxPackage) {
  const whichCmd = isWindows ? 'where' : 'which';
  const check = spawnSync(whichCmd, [command], { encoding: 'utf-8', timeout: 3000 });
  if (check.status === 0 && (check.stdout || '').trim()) {
    return { cmd: command, prefixArgs: [] };
  }
  if (npxPackage) {
    const npxCheck = spawnSync(whichCmd, ['npx'], { encoding: 'utf-8', timeout: 3000 });
    if (npxCheck.status === 0) {
      return { cmd: 'npx', prefixArgs: ['--yes', npxPackage] };
    }
    const bunCheck = spawnSync(whichCmd, ['bun'], { encoding: 'utf-8', timeout: 3000 });
    if (bunCheck.status === 0) {
      return { cmd: 'bun', prefixArgs: ['x', npxPackage] };
    }
  }
  return { cmd: command, prefixArgs: [] };
}

/**
 * Agent Framework
 * Extensible registry for AI agent CLI integrations
 * Supports multiple protocols: direct JSON streaming, ACP (JSON-RPC), etc.
 */

class AgentRunner {
  constructor(config) {
    this.id = config.id;
    this.name = config.name;
    this.command = config.command;
    this.protocol = config.protocol || 'direct'; // 'direct' | 'acp' | etc
    this.buildArgs = config.buildArgs || this.defaultBuildArgs;
    this.parseOutput = config.parseOutput || this.defaultParseOutput;
    this.supportsStdin = config.supportsStdin ?? true;
    this.closeStdin = config.closeStdin ?? false; // close stdin so process doesn't block waiting for input
    this.supportedFeatures = config.supportedFeatures || [];
    this.protocolHandler = config.protocolHandler || null;
    this.requiresAdapter = config.requiresAdapter || false;
    this.adapterCommand = config.adapterCommand || null;
    this.adapterArgs = config.adapterArgs || [];
    this.npxPackage = config.npxPackage || null;
    this.spawnEnv = config.spawnEnv || {};
  }

  defaultBuildArgs(prompt, config) {
    return [];
  }

  defaultParseOutput(line) {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }

  async run(prompt, cwd, config = {}) {
    if (this.protocol === 'acp' && this.protocolHandler) {
      return this.runACP(prompt, cwd, config);
    }
    return this.runDirect(prompt, cwd, config);
  }

  async runDirect(prompt, cwd, config = {}) {
    return new Promise((resolve, reject) => {
      const {
        timeout = 300000,
        onEvent = null,
        onError = null,
        onRateLimit = null
      } = config;

      const args = this.buildArgs(prompt, config);
      const spawnOpts = getSpawnOptions(cwd);
      if (Object.keys(this.spawnEnv).length > 0) {
        spawnOpts.env = { ...spawnOpts.env, ...this.spawnEnv };
        for (const [k, v] of Object.entries(this.spawnEnv)) {
          if (v === undefined) delete spawnOpts.env[k];
        }
      }
      // Tell hooks the actual project dir (used by mcp-thorns/codebasesearch)
      if (cwd) spawnOpts.env.CLAUDE_PROJECT_DIR = cwd;
      if (this.closeStdin) {
        spawnOpts.stdio = ['ignore', 'pipe', 'pipe'];
      }
      const proc = spawn(this.command, args, spawnOpts);
      console.log(`[${this.id}] Spawned PID ${proc.pid} closeStdin=${this.closeStdin}`);

      if (config.onPid) {
        try { config.onPid(proc.pid); } catch (e) {}
      }

      if (config.onProcess) {
        try { config.onProcess(proc); } catch (e) {}
      }

      let jsonBuffer = '';
      const outputs = [];
      let timedOut = false;
      let sessionId = null;
      let rateLimited = false;
      let retryAfterSec = 60;
      let authError = false;
      let authErrorMessage = '';
      let stderrBuffer = '';

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        proc.kill();
        reject(new Error(`${this.name} timeout after ${timeout}ms`));
      }, timeout);

      // Write prompt to stdin if agent uses stdin protocol (not positional args)
      if (this.supportsStdin) {
        proc.stdin.write(prompt);
        // Don't call stdin.end() - agents need open stdin for steering
      }

      proc.stdout.on('error', () => {});
      if (proc.stderr) proc.stderr.on('error', () => {});
      proc.stdout.on('data', (chunk) => {
        if (timedOut) return;

        jsonBuffer += chunk.toString();
        const lines = jsonBuffer.split('\n');
        jsonBuffer = lines.pop();

        for (const line of lines) {
          if (line.trim()) {
            const parsed = this.parseOutput(line);
            if (!parsed) continue;

            outputs.push(parsed);

            if (parsed.session_id) {
              sessionId = parsed.session_id;
            }

            if (onEvent) {
              try { onEvent(parsed); } catch (e) {
                console.error(`[${this.id}] onEvent error: ${e.message}`);
              }
            }
          }
        }
      });

      if (proc.stderr) proc.stderr.on('data', (chunk) => {
        const errorText = chunk.toString();
        stderrBuffer += errorText;
        console.error(`[${this.id}] stderr:`, errorText);

        const authMatch = errorText.match(/401|unauthorized|invalid.*auth|invalid.*token|auth.*failed|permission denied|access denied/i);
        if (authMatch) {
          authError = true;
          authErrorMessage = errorText.trim();
        }

        const rateLimitMatch = errorText.match(/rate.?limit|429|too many requests|overloaded|throttl|hit your limit/i);
        if (rateLimitMatch) {
          rateLimited = true;
          const retryMatch = errorText.match(/retry.?after[:\s]+(\d+)/i);
          if (retryMatch) {
            retryAfterSec = parseInt(retryMatch[1], 10) || 60;
          } else {
            const resetTimeMatch = errorText.match(/resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(?(UTC|[A-Z]{2,4})\)?/i);
            if (resetTimeMatch) {
              let hours = parseInt(resetTimeMatch[1], 10);
              const minutes = resetTimeMatch[2] ? parseInt(resetTimeMatch[2], 10) : 0;
              const period = resetTimeMatch[3]?.toLowerCase();
              const tz = resetTimeMatch[4]?.toUpperCase() || 'UTC';

              if (period === 'pm' && hours !== 12) hours += 12;
              if (period === 'am' && hours === 12) hours = 0;

              const now = new Date();
              const resetTime = new Date(now);
              resetTime.setUTCHours(hours, minutes, 0, 0);

              if (resetTime <= now) {
                resetTime.setUTCDate(resetTime.getUTCDate() + 1);
              }

              retryAfterSec = Math.max(60, Math.ceil((resetTime.getTime() - now.getTime()) / 1000));
            }
          }
        }

        if (onError) {
          try { onError(errorText); } catch (e) {}
        }
      });

      proc.on('close', (code) => {
        clearTimeout(timeoutHandle);
        // Close stdin when process exits - it was kept open for steering during execution
        if (proc.stdin && !proc.stdin.destroyed) {
          try { proc.stdin.end(); } catch (e) {}
        }
        if (timedOut) return;

        if (authError) {
          const err = new Error(`Authentication failed: ${authErrorMessage || 'Invalid credentials or unauthorized access'}`);
          err.authError = true;
          err.nonRetryable = true;
          reject(err);
          return;
        }

        if (rateLimited) {
          const err = new Error(`Rate limited - retry after ${retryAfterSec}s`);
          err.rateLimited = true;
          err.retryAfterSec = retryAfterSec;
          if (onRateLimit) {
            try { onRateLimit({ retryAfterSec }); } catch (e) {}
          }
          reject(err);
          return;
        }

        if (jsonBuffer.trim()) {
          const parsed = this.parseOutput(jsonBuffer);
          if (parsed) {
            outputs.push(parsed);
            if (parsed.session_id) sessionId = parsed.session_id;
            if (onEvent) {
              try { onEvent(parsed); } catch (e) {}
            }
          }
        }

        if (code === 0 || outputs.length > 0) {
          resolve({ outputs, sessionId });
        } else {
          const stderrHint = stderrBuffer.trim() ? `: ${stderrBuffer.trim().slice(0, 200)}` : '';
          reject(new Error(`${this.name} exited with code ${code}${stderrHint}`));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeoutHandle);
        reject(err);
      });
    });
  }

  async runACP(prompt, cwd, config = {}, _retryCount = 0) {
    const maxRetries = config.maxRetries ?? 1;
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
  }

  async _runACPOnce(prompt, cwd, config = {}) {
    return new Promise((resolve, reject) => {
      const {
        timeout = 300000,
        onEvent = null,
        onError = null
      } = config;

      let cmd, args;
      if (this.requiresAdapter && this.adapterCommand) {
        cmd = this.adapterCommand;
        args = [...this.adapterArgs];
      } else {
        const resolved = resolveCommand(this.command, this.npxPackage);
        cmd = resolved.cmd;
        args = [...resolved.prefixArgs, ...this.buildArgs(prompt, config)];
      }

      const spawnOpts = getSpawnOptions(cwd);
      if (Object.keys(this.spawnEnv).length > 0) {
        spawnOpts.env = { ...spawnOpts.env, ...this.spawnEnv };
      }
      const proc = spawn(cmd, args, spawnOpts);

      if (config.onPid) {
        try { config.onPid(proc.pid); } catch (e) {}
      }

      if (config.onProcess) {
        try { config.onProcess(proc); } catch (e) {}
      }

      const outputs = [];
      let timedOut = false;
      let sessionId = null;
      let requestId = 0;
      let initialized = false;
      let stderrText = '';

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        proc.kill();
        reject(new Error(`${this.name} ACP timeout after ${timeout}ms`));
      }, timeout);

      const handleMessage = (message) => {
        const normalized = this.protocolHandler(message, { sessionId, initialized });
        if (!normalized) {
          if (message.id === 1 && message.result) {
            initialized = true;
          }
          return;
        }

        outputs.push(normalized);

        if (normalized.session_id) {
          sessionId = normalized.session_id;
        }

        if (onEvent) {
          try { onEvent(normalized); } catch (e) {
            console.error(`[${this.id}] onEvent error: ${e.message}`);
          }
        }
      };

      proc.stdout.on('error', () => {});
      proc.stderr.on('error', () => {});
      let buffer = '';
      proc.stdout.on('data', (chunk) => {
        if (timedOut) return;

        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (line.trim()) {
            try {
              const message = JSON.parse(line);
              handleMessage(message);
            } catch (e) {
              console.error(`[${this.id}] JSON parse error:`, line.substring(0, 100));
            }
          }
        }
      });

      proc.stderr.on('data', (chunk) => {
        const errorText = chunk.toString();
        stderrText += errorText;
        console.error(`[${this.id}] stderr:`, errorText);
        if (onError) {
          try { onError(errorText); } catch (e) {}
        }
      });

      const initRequest = {
        jsonrpc: '2.0',
        id: ++requestId,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: true, writeTextFile: true },
            terminal: true
          },
          clientInfo: {
            name: 'agentgui',
            title: 'AgentGUI',
            version: '1.0.0'
          }
        }
      };
      proc.stdin.on('error', () => {});
      proc.stdin.write(JSON.stringify(initRequest) + '\n');

      let sessionCreated = false;

      const checkInitAndSend = () => {
        if (initialized && !sessionCreated) {
          sessionCreated = true;

          const sessionParams = {
            cwd: cwd,
            mcpServers: []
          };
          if (config.model) sessionParams.model = config.model;
          if (config.subAgent) sessionParams.agent = config.subAgent;
          if (config.systemPrompt) sessionParams.systemPrompt = config.systemPrompt;
          const sessionRequest = {
            jsonrpc: '2.0',
            id: ++requestId,
            method: 'session/new',
            params: sessionParams
          };
          proc.stdin.write(JSON.stringify(sessionRequest) + '\n');
        } else if (!initialized) {
          setTimeout(checkInitAndSend, 100);
        }
      };

      let promptId = null;
      let completed = false;

      const originalHandler = handleMessage;
      const enhancedHandler = (message) => {
        if (message.id && message.result && message.result.sessionId) {
          sessionId = message.result.sessionId;

          promptId = ++requestId;
          const promptRequest = {
            jsonrpc: '2.0',
            id: promptId,
            method: 'session/prompt',
            params: {
              sessionId: sessionId,
              prompt: [{ type: 'text', text: prompt }]
            }
          };
          proc.stdin.write(JSON.stringify(promptRequest) + '\n');
          return;
        }

        if (message.id === promptId && message.result && message.result.stopReason) {
          completed = true;
          draining = true;
          clearTimeout(timeoutHandle);
          // Wait a short time for any remaining events to be flushed before killing
          setTimeout(() => {
            draining = false;
            try { proc.kill(); } catch (e) {}
            resolve({ outputs, sessionId });
          }, 1000);
          return;
        }

        if (message.id === promptId && message.error) {
          completed = true;
          draining = true;
          clearTimeout(timeoutHandle);
          // Process the error message first, then delay for remaining events
          originalHandler(message);
          setTimeout(() => {
            draining = false;
            try { proc.kill(); } catch (e) {}
            reject(new Error(message.error.message || 'ACP prompt error'));
          }, 1000);
          return;
        }

        originalHandler(message);
      };

      buffer = '';
      proc.stdout.removeAllListeners('data');
      let draining = false;
      proc.stdout.on('data', (chunk) => {
        if (timedOut) return;
        // Continue processing during drain period after stopReason/error
        if (completed && !draining) return;

        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (line.trim()) {
            try {
              const message = JSON.parse(line);

              if (message.id === 1 && message.result) {
                initialized = true;
              }

              enhancedHandler(message);
            } catch (e) {
              console.error(`[${this.id}] JSON parse error:`, line.substring(0, 100));
            }
          }
        }
      });

      setTimeout(checkInitAndSend, 200);

      proc.on('close', (code) => {
        clearTimeout(timeoutHandle);
        if (timedOut || completed) return;

        // Flush any remaining buffer content
        if (buffer.trim()) {
          try {
            const message = JSON.parse(buffer.trim());
            if (message.id === 1 && message.result) {
              initialized = true;
            }
            enhancedHandler(message);
          } catch (e) {
            // Buffer might be incomplete, ignore parse errors on close
          }
        }

        if (code === 0 || outputs.length > 0) {
          resolve({ outputs, sessionId });
        } else {
          const detail = stderrText ? `: ${stderrText.substring(0, 200)}` : '';
          const err = new Error(`${this.name} ACP exited with code ${code}${detail}`);
          err.isPrematureEnd = true;
          err.exitCode = code;
          err.stderrText = stderrText;
          reject(err);
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeoutHandle);
        reject(err);
      });
    });
  }
}

/**
 * Agent Registry
 */
class AgentRegistry {
  constructor() {
    this.agents = new Map();
  }

  register(config) {
    const runner = new AgentRunner(config);
    this.agents.set(config.id, runner);
    return runner;
  }

  get(agentId) {
    return this.agents.get(agentId);
  }

  has(agentId) {
    return this.agents.has(agentId);
  }

  list() {
    return Array.from(this.agents.values()).map(a => ({
      id: a.id,
      name: a.name,
      command: a.command,
      protocol: a.protocol,
      requiresAdapter: a.requiresAdapter,
      supportedFeatures: a.supportedFeatures,
      npxPackage: a.npxPackage
    }));
  }

  listACPAvailable() {
    return this.list().filter(agent => {
      try {
        const whichCmd = isWindows ? 'where' : 'which';
        const which = spawnSync(whichCmd, [agent.command], { encoding: 'utf-8', timeout: 3000 });
        if (which.status === 0) {
          const binPath = (which.stdout || '').trim().split('\n')[0].trim();
          if (binPath) {
            const check = spawnSync(binPath, ['--version'], { encoding: 'utf-8', timeout: 10000, shell: isWindows });
            if (check.status === 0 && (check.stdout || '').trim().length > 0) return true;
          }
        }
        const a = this.agents.get(agent.id);
        if (a && a.npxPackage) {
          const npxCheck = spawnSync(whichCmd, ['npx'], { encoding: 'utf-8', timeout: 3000 });
          if (npxCheck.status === 0) return true;
          const bunCheck = spawnSync(whichCmd, ['bun'], { encoding: 'utf-8', timeout: 3000 });
          if (bunCheck.status === 0) return true;
        }
        return false;
      } catch {
        return false;
      }
    });
  }
}

// Create global registry
const registry = new AgentRegistry();

/**
 * Claude Code Agent
 * Uses direct JSON streaming protocol
 */
registry.register({
  id: 'claude-code',
  name: 'Claude Code',
  command: 'claude',
  protocol: 'direct',
  supportsStdin: true, // keep stdin open for JSON-RPC steering commands
  closeStdin: false, // must stay open for steering to work
  useJsonRpcStdin: false,
  supportedFeatures: ['streaming', 'resume', 'system-prompt', 'permissions-skip', 'steering'],
  spawnEnv: { MAX_THINKING_TOKENS: '0', AGENTGUI_SUBPROCESS: '1' },

  buildArgs(prompt, config) {
    const {
      verbose = true,
      outputFormat = 'stream-json',
      print = true,
      resumeSessionId = null,
      systemPrompt = null,
      model = null
    } = config;

    const flags = [];
    if (print) flags.push('--print');
    if (verbose) flags.push('--verbose');
    flags.push(`--output-format=${outputFormat}`);
    flags.push('--dangerously-skip-permissions');
    if (model) flags.push('--model', model);
    if (resumeSessionId) flags.push('--resume', resumeSessionId);
    if (systemPrompt) flags.push('--append-system-prompt', systemPrompt);
    flags.push(prompt); // positional arg - stdin stays open separately for steering

    return flags;
  },

  parseOutput(line) {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }
});

/**
 * OpenCode Agent
 * Native ACP support
 */
registry.register({
  id: 'opencode',
  name: 'OpenCode',
  command: 'opencode',
  protocol: 'acp',
  supportsStdin: false,
  npxPackage: 'opencode-ai',
  supportedFeatures: ['streaming', 'resume', 'acp-protocol'],

  buildArgs(prompt, config) {
    return ['acp'];
  },

  protocolHandler(message, context) {
    if (!message || typeof message !== 'object') return null;

    // Handle ACP session/update notifications
    if (message.method === 'session/update') {
      const params = message.params || {};
      const update = params.update || {};
      
      // Agent message chunk (text response)
      if (update.sessionUpdate === 'agent_message_chunk' && update.content) {
        let contentBlock;
        
        // Handle different content formats
        if (typeof update.content === 'string') {
          contentBlock = { type: 'text', text: update.content };
        } else if (update.content.type === 'text' && update.content.text) {
          contentBlock = update.content;
        } else if (update.content.text) {
          contentBlock = { type: 'text', text: update.content.text };
        } else if (update.content.content) {
          const inner = update.content.content;
          if (typeof inner === 'string') {
            contentBlock = { type: 'text', text: inner };
          } else if (inner.type === 'text' && inner.text) {
            contentBlock = inner;
          } else {
            contentBlock = { type: 'text', text: JSON.stringify(inner) };
          }
        } else {
          contentBlock = { type: 'text', text: JSON.stringify(update.content) };
        }
        
        return {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [contentBlock]
          },
          session_id: params.sessionId
        };
      }
      
      // Tool call
      if (update.sessionUpdate === 'tool_call') {
        return {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: update.toolCallId,
              name: update.title || update.kind || 'tool',
              kind: update.kind || 'other',
              input: update.rawInput || update.input || {}
            }]
          },
          session_id: params.sessionId
        };
      }
      
      // Tool call update (result) - handle all statuses
      if (update.sessionUpdate === 'tool_call_update') {
        const status = update.status;
        const isError = status === 'failed';
        const isCompleted = status === 'completed';
        
        if (!isCompleted && !isError) {
          return {
            type: 'tool_status',
            tool_use_id: update.toolCallId,
            status: status,
            kind: update.kind || 'other',
            locations: update.locations || [],
            session_id: params.sessionId
          };
        }
        
        const contentParts = [];
        if (update.content && Array.isArray(update.content)) {
          for (const item of update.content) {
            if (item.type === 'content' && item.content) {
              const innerContent = item.content;
              if (innerContent.type === 'text' && innerContent.text) {
                contentParts.push(innerContent.text);
              } else if (innerContent.type === 'resource' && innerContent.resource) {
                contentParts.push(innerContent.resource.text || JSON.stringify(innerContent.resource));
              } else {
                contentParts.push(JSON.stringify(innerContent));
              }
            } else if (item.type === 'diff') {
              const diffText = item.oldText 
                ? `--- ${item.path}\n+++ ${item.path}\n${item.oldText}\n---\n${item.newText}`
                : `+++ ${item.path}\n${item.newText}`;
              contentParts.push(diffText);
            } else if (item.type === 'terminal') {
              contentParts.push(`[Terminal: ${item.terminalId}]`);
            }
          }
        }
        
        const combinedContent = contentParts.join('\n') || (update.rawOutput ? JSON.stringify(update.rawOutput) : '');
        
        return {
          type: 'user',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: update.toolCallId,
              content: combinedContent,
              is_error: isError
            }]
          },
          session_id: params.sessionId
        };
      }
      
      // Usage update
      if (update.sessionUpdate === 'usage_update') {
        return {
          type: 'usage',
          usage: {
            used: update.used,
            size: update.size,
            cost: update.cost
          },
          session_id: params.sessionId
        };
      }
      
      // Plan update
      if (update.sessionUpdate === 'plan') {
        return {
          type: 'plan',
          entries: update.entries || [],
          session_id: params.sessionId
        };
      }
      
      // Skip other updates like available_commands_update
      return null;
    }

    // Handle prompt response (end of turn)
    if (message.id && message.result && message.result.stopReason) {
      return {
        type: 'result',
        result: '',
        stopReason: message.result.stopReason,
        usage: message.result.usage,
        session_id: context.sessionId
      };
    }

    if (message.method === 'error' || message.error) {
      return {
        type: 'error',
        error: message.error || message.params || { message: 'Unknown error' }
      };
    }

    return null;
  }
});

/**
 * Common ACP protocol handler for all ACP agents
 */
function createACPProtocolHandler() {
  return function(message, context) {
    if (!message || typeof message !== 'object') return null;

    // Handle ACP session/update notifications
    if (message.method === 'session/update') {
      const params = message.params || {};
      const update = params.update || {};
      
      // Agent message chunk (text response)
      if (update.sessionUpdate === 'agent_message_chunk' && update.content) {
        let contentBlock;
        
        // Handle different content formats
        if (typeof update.content === 'string') {
          contentBlock = { type: 'text', text: update.content };
        } else if (update.content.type === 'text' && update.content.text) {
          contentBlock = update.content;
        } else if (update.content.text) {
          contentBlock = { type: 'text', text: update.content.text };
        } else if (update.content.content) {
          const inner = update.content.content;
          if (typeof inner === 'string') {
            contentBlock = { type: 'text', text: inner };
          } else if (inner.type === 'text' && inner.text) {
            contentBlock = inner;
          } else {
            contentBlock = { type: 'text', text: JSON.stringify(inner) };
          }
        } else {
          contentBlock = { type: 'text', text: JSON.stringify(update.content) };
        }
        
        return {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [contentBlock]
          },
          session_id: params.sessionId
        };
      }
      
      // Tool call
      if (update.sessionUpdate === 'tool_call') {
        return {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_use',
              id: update.toolCallId,
              name: update.title || update.kind || 'tool',
              kind: update.kind || 'other',
              input: update.rawInput || update.input || {}
            }]
          },
          session_id: params.sessionId
        };
      }
      
      // Tool call update (result) - handle all statuses
      if (update.sessionUpdate === 'tool_call_update') {
        const status = update.status;
        const isError = status === 'failed';
        const isCompleted = status === 'completed';
        
        if (!isCompleted && !isError) {
          return {
            type: 'tool_status',
            tool_use_id: update.toolCallId,
            status: status,
            kind: update.kind || 'other',
            locations: update.locations || [],
            session_id: params.sessionId
          };
        }
        
        const contentParts = [];
        if (update.content && Array.isArray(update.content)) {
          for (const item of update.content) {
            if (item.type === 'content' && item.content) {
              const innerContent = item.content;
              if (innerContent.type === 'text' && innerContent.text) {
                contentParts.push(innerContent.text);
              } else if (innerContent.type === 'resource' && innerContent.resource) {
                contentParts.push(innerContent.resource.text || JSON.stringify(innerContent.resource));
              } else {
                contentParts.push(JSON.stringify(innerContent));
              }
            } else if (item.type === 'diff') {
              const diffText = item.oldText 
                ? `--- ${item.path}\n+++ ${item.path}\n${item.oldText}\n---\n${item.newText}`
                : `+++ ${item.path}\n${item.newText}`;
              contentParts.push(diffText);
            } else if (item.type === 'terminal') {
              contentParts.push(`[Terminal: ${item.terminalId}]`);
            }
          }
        }
        
        const combinedContent = contentParts.join('\n') || (update.rawOutput ? JSON.stringify(update.rawOutput) : '');
        
        return {
          type: 'user',
          message: {
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: update.toolCallId,
              content: combinedContent,
              is_error: isError
            }]
          },
          session_id: params.sessionId
        };
      }
      
      // Usage update
      if (update.sessionUpdate === 'usage_update') {
        return {
          type: 'usage',
          usage: {
            used: update.used,
            size: update.size,
            cost: update.cost
          },
          session_id: params.sessionId
        };
      }
      
      // Plan update
      if (update.sessionUpdate === 'plan') {
        return {
          type: 'plan',
          entries: update.entries || [],
          session_id: params.sessionId
        };
      }
      
      return null;
    }

    // Handle prompt response (end of turn)
    if (message.id && message.result && message.result.stopReason) {
      return {
        type: 'result',
        result: '',
        stopReason: message.result.stopReason,
        usage: message.result.usage,
        session_id: context.sessionId
      };
    }

    if (message.method === 'error' || message.error) {
      return {
        type: 'error',
        error: message.error || message.params || { message: 'Unknown error' }
      };
    }

    return null;
  };
}

// Shared ACP handler
const acpProtocolHandler = createACPProtocolHandler();

/**
 * Gemini CLI Agent
 * Native ACP support
 */
registry.register({
  id: 'gemini',
  name: 'Gemini CLI',
  command: 'gemini',
  protocol: 'acp',
  supportsStdin: false,
  npxPackage: '@google/gemini-cli',
  supportedFeatures: ['streaming', 'resume', 'acp-protocol'],
  buildArgs(prompt, config) {
    const args = ['--experimental-acp', '--yolo'];
    if (config?.model) args.push('--model', config.model);
    return args;
  },
  protocolHandler: acpProtocolHandler
});

/**
 * Goose Agent
 * Native ACP support
 */
registry.register({
  id: 'goose',
  name: 'Goose',
  command: 'goose',
  protocol: 'acp',
  supportsStdin: false,
  supportedFeatures: ['streaming', 'resume', 'acp-protocol'],
  buildArgs: () => ['acp'],
  protocolHandler: acpProtocolHandler
});

/**
 * OpenHands Agent
 * Native ACP support
 */
registry.register({
  id: 'openhands',
  name: 'OpenHands',
  command: 'openhands',
  protocol: 'acp',
  supportsStdin: false,
  supportedFeatures: ['streaming', 'resume', 'acp-protocol'],
  buildArgs: () => ['acp'],
  protocolHandler: acpProtocolHandler
});

/**
 * Augment Code Agent - Native ACP support
 */
registry.register({
  id: 'augment',
  name: 'Augment Code',
  command: 'augment',
  protocol: 'acp',
  supportsStdin: false,
  supportedFeatures: ['streaming', 'resume', 'acp-protocol'],
  buildArgs: () => ['acp'],
  protocolHandler: acpProtocolHandler
});

/**
 * Cline Agent - Native ACP support
 */
registry.register({
  id: 'cline',
  name: 'Cline',
  command: 'cline',
  protocol: 'acp',
  supportsStdin: false,
  supportedFeatures: ['streaming', 'resume', 'acp-protocol'],
  buildArgs: () => ['acp'],
  protocolHandler: acpProtocolHandler
});

/**
 * Kimi CLI Agent (Moonshot AI) - Native ACP support
 */
registry.register({
  id: 'kimi',
  name: 'Kimi CLI',
  command: 'kimi',
  protocol: 'acp',
  supportsStdin: false,
  supportedFeatures: ['streaming', 'resume', 'acp-protocol'],
  buildArgs: () => ['acp'],
  protocolHandler: acpProtocolHandler
});

/**
 * Qwen Code Agent (Alibaba) - Native ACP support
 */
registry.register({
  id: 'qwen',
  name: 'Qwen Code',
  command: 'qwen-code',
  protocol: 'acp',
  supportsStdin: false,
  supportedFeatures: ['streaming', 'resume', 'acp-protocol'],
  buildArgs: () => ['acp'],
  protocolHandler: acpProtocolHandler
});

/**
 * Codex CLI Agent (OpenAI) - ACP support
 */
registry.register({
  id: 'codex',
  name: 'Codex CLI',
  command: 'codex',
  protocol: 'acp',
  supportsStdin: false,
  supportedFeatures: ['streaming', 'resume', 'acp-protocol'],
  buildArgs: () => ['acp'],
  protocolHandler: acpProtocolHandler
});

/**
 * Mistral Vibe Agent - Native ACP support
 */
registry.register({
  id: 'mistral',
  name: 'Mistral Vibe',
  command: 'mistral-vibe',
  protocol: 'acp',
  supportsStdin: false,
  supportedFeatures: ['streaming', 'resume', 'acp-protocol'],
  buildArgs: () => ['acp'],
  protocolHandler: acpProtocolHandler
});

/**
 * Kiro CLI Agent - Native ACP support
 */
registry.register({
  id: 'kiro',
  name: 'Kiro CLI',
  command: 'kiro',
  protocol: 'acp',
  supportsStdin: false,
  supportedFeatures: ['streaming', 'resume', 'acp-protocol'],
  buildArgs: () => ['acp'],
  protocolHandler: acpProtocolHandler
});

/**
 * fast-agent - Native ACP support
 */
registry.register({
  id: 'fast-agent',
  name: 'fast-agent',
  command: 'fast-agent',
  protocol: 'acp',
  supportsStdin: false,
  supportedFeatures: ['streaming', 'resume', 'acp-protocol'],
  buildArgs: () => ['acp'],
  protocolHandler: acpProtocolHandler
});

/**
 * Kilo CLI Agent (OpenCode fork)
 * Built on OpenCode, supports ACP protocol
 * Uses 'kilo' command - installed via npm install -g @kilocode/cli
 */
registry.register({
  id: 'kilo',
  name: 'Kilo CLI',
  command: 'kilo',
  protocol: 'acp',
  supportsStdin: false,
  npxPackage: '@kilocode/cli',
  supportedFeatures: ['streaming', 'resume', 'acp-protocol', 'models'],

  buildArgs(prompt, config) {
    return ['acp'];
  },

  protocolHandler(message, context) {
    return acpProtocolHandler(message, context);
  }
});

/**
 * Main export function - runs any registered agent
 */
export async function runClaudeWithStreaming(prompt, cwd, agentId = 'claude-code', config = {}) {
  const agent = registry.get(agentId);

  if (!agent) {
    throw new Error(`Unknown agent: ${agentId}. Registered agents: ${registry.list().map(a => a.id).join(', ')}`);
  }

  const enhancedConfig = { ...config };
  if (!enhancedConfig.systemPrompt) {
    enhancedConfig.systemPrompt = '';
  }

  // Append communication guidelines for all agents
  const communicationGuidelines = `
COMMUNICATION STYLE: Minimize output. Only inform the user about:
- Critical errors that block work
- User needs to know info (e.g., "port in use", "authentication failed", "file not found")
- Action required from user
- Important decisions that affect their work

DO NOT output:
- Progress updates ("doing X now", "completed Y", "searching for...")
- Verbose summaries of what was done
- Status checks or verification messages
- Detailed explanations unless asked
- "Working on...", "Looking for...", step-by-step progress

INSTEAD:
- Run tools silently
- Show results only when relevant
- Be conversational and direct
- Let code/output speak for itself
`;

  if (!enhancedConfig.systemPrompt.includes('COMMUNICATION STYLE')) {
    enhancedConfig.systemPrompt = communicationGuidelines + enhancedConfig.systemPrompt;
  }

  if (agentId && agentId !== 'claude-code') {
    const displayAgentId = agentId.split('-·-')[0];
    const agentPrefix = `use ${displayAgentId} subagent to. `;
    if (!enhancedConfig.systemPrompt.includes(agentPrefix)) {
      enhancedConfig.systemPrompt = agentPrefix + enhancedConfig.systemPrompt;
    }
  }

  return agent.run(prompt, cwd, enhancedConfig);
}

/**
 * Get list of registered agents
 */
export function getRegisteredAgents() {
  return registry.list();
}

/**
 * Get list of installed/available agents
 */
export function getAvailableAgents() {
  return registry.listACPAvailable();
}

/**
 * Check if an agent is registered
 */
export function isAgentRegistered(agentId) {
  return registry.has(agentId);
}

export default runClaudeWithStreaming;
