import { spawnSync } from 'child_process';
import { AgentRunner } from './claude-runner.js';
import { acpProtocolHandler } from './acp-protocol.js';
import './claude-runner-direct.js';
import './claude-runner-acp.js';

const isWindows = process.platform === 'win32';

export class AgentRegistry {
  constructor() { this.agents = new Map(); }

  register(config) {
    const runner = new AgentRunner(config);
    this.agents.set(config.id, runner);
    return runner;
  }

  get(agentId) { return this.agents.get(agentId); }
  has(agentId) { return this.agents.has(agentId); }

  list() {
    return Array.from(this.agents.values()).map(a => ({
      id: a.id, name: a.name, command: a.command, protocol: a.protocol,
      requiresAdapter: a.requiresAdapter, supportedFeatures: a.supportedFeatures, npxPackage: a.npxPackage
    }));
  }

  isAvailable(agentId) {
    if (!this._availCache) this._availCache = new Map();
    if (this._availCache.has(agentId)) return this._availCache.get(agentId);
    const a = this.agents.get(agentId);
    if (!a) return false;
    let ok = false;
    try {
      const whichCmd = isWindows ? 'where' : 'which';
      const which = spawnSync(whichCmd, [a.command], { encoding: 'utf-8', timeout: 3000 });
      if (which.status === 0 && (which.stdout || '').trim()) ok = true;
      if (!ok && a.npxPackage) {
        ok = ['bun', 'npx'].some(r => {
          const c = spawnSync(whichCmd, [r], { encoding: 'utf-8', timeout: 3000 });
          return c.status === 0 && (c.stdout || '').trim();
        });
      }
    } catch { ok = false; }
    this._availCache.set(agentId, ok);
    return ok;
  }

  listWithAvailability() {
    return this.list().map(a => ({ ...a, available: this.isAvailable(a.id), npxInstallable: !!a.npxPackage }));
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
      } catch { return false; }
    });
  }
}

export const registry = new AgentRegistry();

function parseClaudeOutput(line) {
  try {
    const entry = JSON.parse(line);
    if (!entry || typeof entry !== 'object') return null;
    if (entry.type === 'user' && entry.isMeta === true) return null;
    if (entry.isApiErrorMessage === true && entry.error === 'rate_limit') entry._rateLimitDetected = true;
    if (entry.type === 'assistant' && entry.message) entry._isFragment = entry.message.stop_reason === null || entry.message.stop_reason === undefined;
    if (entry.type === 'system' && entry.subtype === 'turn_duration' && entry.durationMs) entry._turnDurationMs = entry.durationMs;
    if (entry.type === 'system' && entry.subtype === 'compact_boundary' && entry.compactMetadata) entry._preTokens = entry.compactMetadata.preTokens;
    if (entry.message?.usage) {
      const u = entry.message.usage;
      entry._cacheUsage = { cache_creation: u.cache_creation_input_tokens || u['cache_creation.ephemeral_1h_input_tokens'] || u['cache_creation.ephemeral_5m_input_tokens'] || 0, cache_read: u.cache_read_input_tokens || 0 };
    }
    return entry;
  } catch { return null; }
}

registry.register({
  id: 'claude-code', name: 'Claude Code', command: 'claude', protocol: 'direct', supportsStdin: false, closeStdin: true,
  useJsonRpcStdin: false, supportedFeatures: ['streaming', 'resume', 'system-prompt', 'permissions-skip', 'steering'],
  // claude has an npx fallback (matches agent-discovery), so when `where claude`
  // misses a non-PATH install the agent still reports as runnable rather than
  // "(not installed)".
  npxPackage: '@anthropic-ai/claude-code',
  spawnEnv: { MAX_THINKING_TOKENS: '0', AGENTGUI_SUBPROCESS: '1' },
  buildArgs(prompt, config) {
    const { verbose = true, outputFormat = 'stream-json', print = true, resumeSessionId = null, systemPrompt = null, model = null } = config;
    const flags = [];
    if (print) flags.push('--print');
    if (verbose) flags.push('--verbose');
    flags.push(`--output-format=${outputFormat}`);
    if (model) flags.push('--model', model);
    if (resumeSessionId) flags.push('--resume', resumeSessionId);
    if (systemPrompt) flags.push('--append-system-prompt', systemPrompt);
    flags.push('--dangerously-skip-permissions');
    flags.push(typeof prompt === 'string' ? prompt : String(prompt));
    return flags;
  },
  parseOutput: parseClaudeOutput
});

// Antigravity (`agy`): a direct-protocol CLI like claude-code, but emits PLAIN
// TEXT (no stream-json, no model flag, no printed session_id). Each stdout line
// is wrapped into the assistant-text event the non-JSONL stream handler expects.
// Resume uses --continue (most-recent conversation) since agy prints no session id.
registry.register({
  id: 'agy', name: 'Antigravity', command: 'agy', protocol: 'direct',
  supportsStdin: false, closeStdin: true,
  supportedFeatures: ['streaming', 'resume'],
  spawnEnv: { AGENTGUI_SUBPROCESS: '1' },
  buildArgs(prompt, config) {
    const { resumeSessionId = null } = config;
    // agy's --print is a VALUE flag (the prompt is its argument), not a boolean
    // followed by a positional. A positional prompt exits with code 2.
    const flags = ['--print', typeof prompt === 'string' ? prompt : String(prompt), '--dangerously-skip-permissions'];
    if (resumeSessionId) flags.push('--continue');
    return flags;
  },
  parseOutput(line) {
    const text = line.replace(/\r$/, '');
    if (!text.trim()) return null;
    return { type: 'assistant', message: { content: [{ type: 'text', text }] } };
  },
});
// transport:'http' routes runACP through AgentRunner._runACPHttp (reuses the
// long-lived server acp-sdk-manager.js already spawns for health/model
// discovery) instead of spawning a fresh stdio subprocess per turn -
// live-verified equivalent to the stdio path (same prompt, byte-identical
// final assistant text, side-by-side witnessed). kilo is NOT flagged here:
// its HTTP event shape was never independently live-verified this session.
registry.register({ id: 'opencode', name: 'OpenCode', command: 'opencode', protocol: 'acp', transport: 'http', supportsStdin: false, npxPackage: 'opencode-ai', supportedFeatures: ['streaming', 'resume', 'acp-protocol'], buildArgs: () => ['acp'], protocolHandler: acpProtocolHandler });
registry.register({ id: 'gemini', name: 'Gemini CLI', command: 'gemini', protocol: 'acp', supportsStdin: false, npxPackage: '@google/gemini-cli', supportedFeatures: ['streaming', 'resume', 'acp-protocol'], buildArgs(prompt, config) { const args = ['--experimental-acp', '--yolo']; if (config?.model) args.push('--model', config.model); return args; }, protocolHandler: acpProtocolHandler });
registry.register({ id: 'goose', name: 'Goose', command: 'goose', protocol: 'acp', supportsStdin: false, supportedFeatures: ['streaming', 'resume', 'acp-protocol'], buildArgs: () => ['acp'], protocolHandler: acpProtocolHandler });
registry.register({ id: 'openhands', name: 'OpenHands', command: 'openhands', protocol: 'acp', supportsStdin: false, supportedFeatures: ['streaming', 'resume', 'acp-protocol'], buildArgs: () => ['acp'], protocolHandler: acpProtocolHandler });
registry.register({ id: 'augment', name: 'Augment Code', command: 'augment', protocol: 'acp', supportsStdin: false, supportedFeatures: ['streaming', 'resume', 'acp-protocol'], buildArgs: () => ['acp'], protocolHandler: acpProtocolHandler });
registry.register({ id: 'cline', name: 'Cline', command: 'cline', protocol: 'acp', supportsStdin: false, supportedFeatures: ['streaming', 'resume', 'acp-protocol'], buildArgs: () => ['acp'], protocolHandler: acpProtocolHandler });
registry.register({ id: 'kimi', name: 'Kimi CLI', command: 'kimi', protocol: 'acp', supportsStdin: false, supportedFeatures: ['streaming', 'resume', 'acp-protocol'], buildArgs: () => ['acp'], protocolHandler: acpProtocolHandler });
registry.register({ id: 'qwen', name: 'Qwen Code', command: 'qwen-code', protocol: 'acp', supportsStdin: false, supportedFeatures: ['streaming', 'resume', 'acp-protocol'], buildArgs: () => ['acp'], protocolHandler: acpProtocolHandler });
// codex (@openai/codex >=0.147.0) has no `acp` subcommand - live-confirmed
// via `codex --help`/`codex app-server --help`: `codex acp` is parsed as the
// interactive TUI with prompt text "acp" and errors "stdin is not a
// terminal" non-interactively. Its ACP-equivalent is `app-server` over a
// WebSocket, a different transport this stdio-JSON-RPC runner cannot drive.
// Registering it with buildArgs:()=>['acp'] would spawn a command that can
// never succeed. Disabled until a WebSocket app-server client exists (see
// PRD row aaa-codex-app-server-client).
registry.register({ id: 'mistral', name: 'Mistral Vibe', command: 'mistral-vibe', protocol: 'acp', supportsStdin: false, supportedFeatures: ['streaming', 'resume', 'acp-protocol'], buildArgs: () => ['acp'], protocolHandler: acpProtocolHandler });
registry.register({ id: 'kiro', name: 'Kiro CLI', command: 'kiro', protocol: 'acp', supportsStdin: false, supportedFeatures: ['streaming', 'resume', 'acp-protocol'], buildArgs: () => ['acp'], protocolHandler: acpProtocolHandler });
registry.register({ id: 'fast-agent', name: 'fast-agent', command: 'fast-agent', protocol: 'acp', supportsStdin: false, supportedFeatures: ['streaming', 'resume', 'acp-protocol'], buildArgs: () => ['acp'], protocolHandler: acpProtocolHandler });
registry.register({ id: 'kilo', name: 'Kilo CLI', command: 'kilo', protocol: 'acp', supportsStdin: false, npxPackage: '@kilocode/cli', supportedFeatures: ['streaming', 'resume', 'acp-protocol', 'models'], buildArgs: () => ['acp'], protocolHandler: acpProtocolHandler });
registry.register({ id: 'hermes', name: 'Hermes Agent', command: 'hermes', protocol: 'acp', supportsStdin: false, supportedFeatures: ['streaming', 'resume', 'acp-protocol'], buildArgs: () => ['acp'], protocolHandler: acpProtocolHandler });
