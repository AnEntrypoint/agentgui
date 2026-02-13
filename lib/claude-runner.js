import { spawn } from 'child_process';

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
    this.supportedFeatures = config.supportedFeatures || [];
    this.protocolHandler = config.protocolHandler || null;
    this.requiresAdapter = config.requiresAdapter || false;
    this.adapterCommand = config.adapterCommand || null;
    this.adapterArgs = config.adapterArgs || [];
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
        onError = null
      } = config;

      const args = this.buildArgs(prompt, config);
      const proc = spawn(this.command, args, { cwd });

      if (config.onPid) {
        try { config.onPid(proc.pid); } catch (e) {}
      }

      let jsonBuffer = '';
      const outputs = [];
      let timedOut = false;
      let sessionId = null;

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        proc.kill();
        reject(new Error(`${this.name} timeout after ${timeout}ms`));
      }, timeout);

      // Write to stdin if supported
      if (this.supportsStdin) {
        proc.stdin.write(prompt);
        proc.stdin.end();
      }

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

      proc.stderr.on('data', (chunk) => {
        const errorText = chunk.toString();
        console.error(`[${this.id}] stderr:`, errorText);
        if (onError) {
          try { onError(errorText); } catch (e) {}
        }
      });

      proc.on('close', (code) => {
        clearTimeout(timeoutHandle);
        if (timedOut) return;

        // Some agents return non-zero but still produce valid output
        const success = code === 0 || (outputs.length > 0 && this.allowNonZeroExit);

        if (success) {
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
          resolve({ outputs, sessionId });
        } else {
          reject(new Error(`${this.name} exited with code ${code}`));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timeoutHandle);
        reject(err);
      });
    });
  }

  async runACP(prompt, cwd, config = {}) {
    return new Promise((resolve, reject) => {
      const {
        timeout = 300000,
        onEvent = null,
        onError = null
      } = config;

      // Use adapter if required (e.g., for Claude Code via Zed adapter)
      const cmd = this.requiresAdapter && this.adapterCommand ? this.adapterCommand : this.command;
      const baseArgs = this.requiresAdapter && this.adapterCommand ? this.adapterArgs : ['acp'];
      const args = [...baseArgs];
      
      const proc = spawn(cmd, args, { cwd });

      if (config.onPid) {
        try { config.onPid(proc.pid); } catch (e) {}
      }

      const outputs = [];
      let timedOut = false;
      let sessionId = null;
      let requestId = 0;
      let initialized = false;

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        proc.kill();
        reject(new Error(`${this.name} ACP timeout after ${timeout}ms`));
      }, timeout);

      // ACP protocol handler
      const handleMessage = (message) => {
        // Normalize ACP message to common format
        const normalized = this.protocolHandler(message, { sessionId, initialized });
        if (!normalized) {
          // Check for initialization response
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
        console.error(`[${this.id}] stderr:`, errorText);
        if (onError) {
          try { onError(errorText); } catch (e) {}
        }
      });

      // Send ACP initialize request (protocolVersion must be an integer per ACP spec)
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
      proc.stdin.write(JSON.stringify(initRequest) + '\n');

      let sessionCreated = false;

      // Wait for initialization then create session and send prompt
      const checkInitAndSend = () => {
        if (initialized && !sessionCreated) {
          sessionCreated = true;
          
          // Step 1: Create a new session
          const sessionRequest = {
            jsonrpc: '2.0',
            id: ++requestId,
            method: 'session/new',
            params: {
              cwd: cwd,
              mcpServers: []
            }
          };
          proc.stdin.write(JSON.stringify(sessionRequest) + '\n');
        } else if (!initialized) {
          setTimeout(checkInitAndSend, 100);
        }
      };

      let promptId = null;
      let completed = false;

      // Handle session creation response and send prompt
      const originalHandler = handleMessage;
      const enhancedHandler = (message) => {
        // Check for session/new response
        if (message.id && message.result && message.result.sessionId) {
          sessionId = message.result.sessionId;
          
          // Step 2: Send the prompt
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
        
        // Check for prompt response (end of turn)
        if (message.id === promptId && message.result && message.result.stopReason) {
          completed = true;
          clearTimeout(timeoutHandle);
          proc.kill();
          resolve({ outputs, sessionId });
          return;
        }
        
        originalHandler(message);
      };

      // Override the message handler
      buffer = '';
      proc.stdout.removeAllListeners('data');
      proc.stdout.on('data', (chunk) => {
        if (timedOut || completed) return;

        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (line.trim()) {
            try {
              const message = JSON.parse(line);
              
              // Check for initialization response
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

        if (code === 0 || outputs.length > 0) {
          resolve({ outputs, sessionId });
        } else {
          reject(new Error(`${this.name} ACP exited with code ${code}`));
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
      supportedFeatures: a.supportedFeatures
    }));
  }

  listACPAvailable() {
    // Check which agents are actually installed
    const { execSync } = require('child_process');
    return this.list().filter(agent => {
      try {
        execSync(`which ${agent.command} 2>/dev/null`, { encoding: 'utf-8' });
        return true;
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
  supportsStdin: true,
  supportedFeatures: ['streaming', 'resume', 'system-prompt', 'permissions-skip'],

  buildArgs(prompt, config) {
    const {
      verbose = true,
      outputFormat = 'stream-json',
      print = true,
      resumeSessionId = null,
      systemPrompt = null
    } = config;

    const flags = [];
    if (print) flags.push('--print');
    if (verbose) flags.push('--verbose');
    flags.push(`--output-format=${outputFormat}`);
    flags.push('--dangerously-skip-permissions');
    if (resumeSessionId) flags.push('--resume', resumeSessionId);
    if (systemPrompt) flags.push('--append-system-prompt', systemPrompt);

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
        return {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [update.content]
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
              name: update.title || 'tool',
              input: update.input || {}
            }]
          },
          session_id: params.sessionId
        };
      }
      
      // Tool call update (result)
      if (update.sessionUpdate === 'tool_call_update' && update.status === 'completed') {
        const content = update.content && update.content[0] ? update.content[0].content : null;
        return {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_result',
              tool_use_id: update.toolCallId,
              content: content ? (content.text || JSON.stringify(content)) : '',
              is_error: false
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
        return {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [update.content]
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
              name: update.title || 'tool',
              input: update.input || {}
            }]
          },
          session_id: params.sessionId
        };
      }
      
      // Tool call update (result)
      if (update.sessionUpdate === 'tool_call_update' && update.status === 'completed') {
        const content = update.content && update.content[0] ? update.content[0].content : null;
        return {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{
              type: 'tool_result',
              tool_use_id: update.toolCallId,
              content: content ? (content.text || JSON.stringify(content)) : '',
              is_error: false
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
  supportedFeatures: ['streaming', 'resume', 'acp-protocol'],
  buildArgs: () => ['acp'],
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
 * Main export function - runs any registered agent
 */
export async function runClaudeWithStreaming(prompt, cwd, agentId = 'claude-code', config = {}) {
  const agent = registry.get(agentId);

  if (!agent) {
    throw new Error(`Unknown agent: ${agentId}. Registered agents: ${registry.list().map(a => a.id).join(', ')}`);
  }

  return agent.run(prompt, cwd, config);
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
