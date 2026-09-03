import { spawn, spawnSync } from 'child_process';

const isWindows = process.platform === 'win32';

export function getSpawnOptions(cwd, additionalOptions = {}) {
  const options = { cwd, ...additionalOptions };
  // shell:true on Windows concatenates argv WITHOUT escaping, so a user prompt
  // containing &, |, >, or backticks executes as a shell command (verified
  // injection). Callers that pass untrusted args (the direct runner) must set
  // shell:false and spawn a resolved binary. Default keeps the legacy shell
  // behaviour only when a caller has not already chosen.
  if (isWindows && options.shell === undefined) options.shell = true;
  if (!options.env) options.env = { ...process.env };
  delete options.env.CLAUDECODE;
  return options;
}

// Resolve a bare command name to an absolute executable path so it can be
// spawned with shell:false (no argv concatenation, no injection surface).
// Returns the original command if resolution fails (Node will still PATH-resolve).
export function resolveBinaryPath(command) {
  try {
    const whichCmd = isWindows ? 'where' : 'which';
    const r = spawnSync(whichCmd, [command], { encoding: 'utf-8', timeout: 3000 });
    if (r.status === 0) {
      const first = (r.stdout || '').trim().split(/\r?\n/)[0].trim();
      // A .cmd/.bat shim cannot be exec'd without a shell; leave it to the caller.
      if (first && !/\.(cmd|bat)$/i.test(first)) return first;
    }
  } catch (_) {}
  return command;
}

export function resolveCommand(command, npxPackage) {
  const whichCmd = isWindows ? 'where' : 'which';
  const check = spawnSync(whichCmd, [command], { encoding: 'utf-8', timeout: 3000 });
  if (check.status === 0 && (check.stdout || '').trim()) return { cmd: command, prefixArgs: [] };
  if (npxPackage) {
    const npxCheck = spawnSync(whichCmd, ['npx'], { encoding: 'utf-8', timeout: 3000 });
    if (npxCheck.status === 0) return { cmd: 'npx', prefixArgs: ['--yes', npxPackage] };
    const bunCheck = spawnSync(whichCmd, ['bun'], { encoding: 'utf-8', timeout: 3000 });
    if (bunCheck.status === 0) return { cmd: 'bun', prefixArgs: ['x', npxPackage] };
  }
  return { cmd: command, prefixArgs: [] };
}

export class AgentRunner {
  constructor(config) {
    this.id = config.id;
    this.name = config.name;
    this.command = config.command;
    this.protocol = config.protocol || 'direct';
    this.buildArgs = config.buildArgs || this.defaultBuildArgs;
    this.parseOutput = config.parseOutput || this.defaultParseOutput;
    this.supportsStdin = config.supportsStdin ?? true;
    this.closeStdin = config.closeStdin ?? false;
    this.supportedFeatures = config.supportedFeatures || [];
    this.protocolHandler = config.protocolHandler || null;
    this.requiresAdapter = config.requiresAdapter || false;
    this.adapterCommand = config.adapterCommand || null;
    this.adapterArgs = config.adapterArgs || [];
    this.npxPackage = config.npxPackage || null;
    this.spawnEnv = config.spawnEnv || {};
  }

  defaultBuildArgs(prompt, config) { return []; }

  defaultParseOutput(line) {
    try { return JSON.parse(line); } catch { return null; }
  }

  async run(prompt, cwd, config = {}) {
    if (this.protocol === 'acp' && this.protocolHandler) return this.runACP(prompt, cwd, config);
    return this.runDirect(prompt, cwd, config);
  }
}
