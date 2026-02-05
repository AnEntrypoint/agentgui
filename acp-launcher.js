import { query } from '@anthropic-ai/claude-code';

/**
 * ACPConnection - Uses @anthropic-ai/claude-code SDK directly
 *
 * This uses the real Claude Code SDK which handles:
 * - Plugin execution with real system prompt
 * - Actual filesystem operations
 * - Streaming responses with onUpdate callbacks
 * - No subprocess spawning needed (SDK handles it)
 * - Integrated glootie-cc MCP servers for full capabilities
 */
export default class ACPConnection {
  constructor() {
    this.sessionId = null;
    this.onUpdate = null;
    this.cwd = process.cwd();
    this.mcpServers = this.buildMcpServers();
  }

  buildMcpServers() {
    const mcpServers = {};

    // Add glootie-cc MCP servers for full execution capabilities
    if (process.env.CLAUDE_PLUGIN_ROOT) {
      const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
      mcpServers['dev'] = {
        type: 'stdio',
        command: 'bunx',
        args: ['mcp-glootie@latest'],
        timeout: 360000
      };
      mcpServers['code-search'] = {
        type: 'stdio',
        command: 'bunx',
        args: ['codebasesearch@latest'],
        timeout: 360000
      };
    } else {
      // Fallback to standard MCP configuration
      mcpServers['dev'] = {
        type: 'stdio',
        command: 'bunx',
        args: ['mcp-glootie@latest'],
        timeout: 360000
      };
      mcpServers['code-search'] = {
        type: 'stdio',
        command: 'bunx',
        args: ['codebasesearch@latest'],
        timeout: 360000
      };
    }

    return mcpServers;
  }

  async connect(agentType, cwd) {
    console.log(`[ACP] Using @anthropic-ai/claude-code SDK (${agentType})`);
    console.log(`[ACP] MCP servers configured: ${Object.keys(this.mcpServers).join(', ')}`);
    if (cwd) {
      this.cwd = cwd;
    }
    return { connected: true };
  }

  async initialize() {
    return { ready: true };
  }

  async newSession(cwd) {
    this.sessionId = Math.random().toString(36).substring(7);
    if (cwd) {
      this.cwd = cwd;
    }
    console.log(`[ACP] Session ${this.sessionId} in ${this.cwd}`);
    return { sessionId: this.sessionId };
  }

  async setSessionMode(modeId) {
    return { modeId };
  }

  async injectSkills(additionalContext = '') {
    return { skills: [] };
  }

  async injectSystemContext() {
    return { context: 'Using Claude Code SDK with glootie-cc MCP integration' };
  }

  async sendPrompt(prompt) {
    const promptText = typeof prompt === 'string' ? prompt : prompt.map(p => p.text).join('\n');

    try {
      console.log(`[ACP] Sending prompt (${promptText.length} chars) in ${this.cwd}`);

      // Build environment with proper permissions and working directory setup
      const env = {
        ...process.env,
        HOME: process.env.HOME || '/config',
        USER: process.env.USER || 'abc',
        PATH: process.env.PATH || '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        // Ensure file operations are fully enabled
        CLAUDE_CODE_ALLOW_ALL: 'true',
        CLAUDE_CODE_BYPASS_PERMISSIONS: 'true'
      };

      // Build permission updates to allow directory access
      const permissionUpdates = [
        {
          type: 'addDirectories',
          directories: ['/tmp/test-projects', this.cwd, '/tmp', '/config'],
          destination: 'session'
        },
        {
          type: 'addRules',
          rules: ['*'],
          behavior: 'allow',
          destination: 'session'
        }
      ];

      // Use the SDK directly to execute the prompt
      // The SDK handles plugins, system prompt, and all real execution
      const session = await query({
        prompt: promptText,
        options: {
          cwd: this.cwd,
          env: env,
          mcpServers: this.mcpServers,
          permissionMode: 'acceptEdits',
          additionalDirectories: ['/tmp/test-projects', this.cwd, '/tmp', '/config']
        }
      });

      let fullResponse = '';

      // Stream messages and collect the final result
      for await (const message of session.sdkMessages) {
        if (message.type === 'result') {
          // Extract the actual result from the final message
          if (message.result) {
            fullResponse = String(message.result);
            console.log(`[ACP] Got result: ${fullResponse.length} chars`);

            // Emit update callback if provided
            if (this.onUpdate && fullResponse) {
              this.onUpdate({
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { text: fullResponse }
                }
              });
            }
          }

          return {
            content: fullResponse,
            stopReason: 'end_turn',
            result: fullResponse,
            sessionId: this.sessionId,
            usage: message.usage
          };
        }
      }

      // Fallback if no result message found
      return {
        content: fullResponse,
        stopReason: 'end_turn',
        result: fullResponse,
        sessionId: this.sessionId
      };

    } catch (err) {
      console.error(`[ACP] Query error: ${err.message}`);
      throw err;
    }
  }

  isRunning() {
    return true; // SDK manages process lifecycle
  }

  async terminate() {
    console.log(`[ACP] Terminating session ${this.sessionId}`);
    return { terminated: true };
  }
}
