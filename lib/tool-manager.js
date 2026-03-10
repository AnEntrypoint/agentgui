import { spawn, execSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';

const isWindows = os.platform() === 'win32';
const TOOLS = [
  { id: 'cli-claude', name: 'Claude Code', pkg: '@anthropic-ai/claude-code', category: 'cli' },
  { id: 'cli-opencode', name: 'OpenCode', pkg: 'opencode-ai', category: 'cli' },
  { id: 'cli-gemini', name: 'Gemini CLI', pkg: '@google/gemini-cli', category: 'cli' },
  { id: 'cli-kilo', name: 'Kilo Code', pkg: '@kilocode/cli', category: 'cli' },
  { id: 'cli-codex', name: 'Codex CLI', pkg: '@openai/codex', category: 'cli' },
  { id: 'gm-cc', name: 'GM Claude', pkg: 'gm-cc', pluginId: 'gm-cc', category: 'plugin', frameWork: 'claude' },
  { id: 'gm-oc', name: 'GM OpenCode', pkg: 'gm-oc', pluginId: 'gm', category: 'plugin', frameWork: 'opencode' },
  { id: 'gm-gc', name: 'GM Gemini', pkg: 'gm-gc', pluginId: 'gm', category: 'plugin', frameWork: 'gemini' },
  { id: 'gm-kilo', name: 'GM Kilo', pkg: 'gm-kilo', pluginId: 'gm', category: 'plugin', frameWork: 'kilo' },
];

const statusCache = new Map();
const installLocks = new Map();
const versionCache = new Map();

const getTool = (id) => TOOLS.find(t => t.id === id);

const getInstalledVersion = (pkg, pluginId = null, frameWork = null) => {
  try {
    const homeDir = os.homedir();
    const tool = TOOLS.find(t => t.pkg === pkg);
    const actualPluginId = pluginId || tool?.pluginId || pkg;
    const actualFrameWork = frameWork || tool?.frameWork;

    // Check Claude Code plugins using correct pluginId
    if (!frameWork || frameWork === 'claude') {
      const claudePath = path.join(homeDir, '.claude', 'plugins', actualPluginId, 'plugin.json');
      if (fs.existsSync(claudePath)) {
        try {
          const pluginJson = JSON.parse(fs.readFileSync(claudePath, 'utf-8'));
          if (pluginJson.version) return pluginJson.version;
        } catch (e) {
          console.warn(`[tool-manager] Failed to parse ${claudePath}:`, e.message);
        }
      }
    }

    // Check OpenCode agents using correct pluginId (stored as .md files)
    if (!frameWork || frameWork === 'opencode') {
      const opencodePath = path.join(homeDir, '.config', 'opencode', 'agents', actualPluginId + '.md');
      if (fs.existsSync(opencodePath)) {
        // Try to extract version from markdown front matter or try plugin.json in agent dir
        try {
          const agentDirPath = path.join(homeDir, '.config', 'opencode', 'agents', actualPluginId, 'plugin.json');
          if (fs.existsSync(agentDirPath)) {
            const pluginJson = JSON.parse(fs.readFileSync(agentDirPath, 'utf-8'));
            if (pluginJson.version) return pluginJson.version;
          }
        } catch (e) {
          // Fallback: skip
        }
        // For multi-framework bundles, try npm package.json in cache
        try {
          const pkgJsonPath = path.join(homeDir, '.gmweb/cache/.bun/install/cache');
          const cacheDirs = fs.readdirSync(pkgJsonPath).filter(d => d.startsWith(pkg + '@'));
          // Sort by version (get latest)
          const latestDir = cacheDirs.sort().reverse()[0];
          if (latestDir) {
            const pkgJsonFile = path.join(pkgJsonPath, latestDir, 'package.json');
            const pkgJson = JSON.parse(fs.readFileSync(pkgJsonFile, 'utf-8'));
            if (pkgJson.version) return pkgJson.version;
          }
        } catch (e) {
          // Fallback
        }
        // Last resort: try to extract from package name patterns
        return 'installed';
      }
    }

    // Check Gemini CLI agents (stored as 'gm' directory with gemini-extension.json)
    if (!frameWork || frameWork === 'gemini') {
      const geminiExtPath = path.join(homeDir, '.gemini', 'extensions', actualPluginId, 'gemini-extension.json');
      if (fs.existsSync(geminiExtPath)) {
        try {
          const extJson = JSON.parse(fs.readFileSync(geminiExtPath, 'utf-8'));
          if (extJson.version) return extJson.version;
        } catch (e) {
          console.warn(`[tool-manager] Failed to parse ${geminiExtPath}:`, e.message);
        }
      }
    }

    // Check Kilo agents (stored as .md files)
    if (!frameWork || frameWork === 'kilo') {
      const kiloPath = path.join(homeDir, '.config', 'kilo', 'agents', actualPluginId + '.md');
      if (fs.existsSync(kiloPath)) {
        // Try to extract version from markdown front matter or try plugin.json in agent dir
        try {
          const agentDirPath = path.join(homeDir, '.config', 'kilo', 'agents', actualPluginId, 'plugin.json');
          if (fs.existsSync(agentDirPath)) {
            const pluginJson = JSON.parse(fs.readFileSync(agentDirPath, 'utf-8'));
            if (pluginJson.version) return pluginJson.version;
          }
        } catch (e) {
          // Fallback: skip
        }
        // For multi-framework bundles, try npm package.json in cache
        try {
          const pkgJsonPath = path.join(homeDir, '.gmweb/cache/.bun/install/cache');
          const cacheDirs = fs.readdirSync(pkgJsonPath).filter(d => d.startsWith(pkg + '@'));
          // Sort by version (get latest)
          const latestDir = cacheDirs.sort().reverse()[0];
          if (latestDir) {
            const pkgJsonFile = path.join(pkgJsonPath, latestDir, 'package.json');
            const pkgJson = JSON.parse(fs.readFileSync(pkgJsonFile, 'utf-8'));
            if (pkgJson.version) return pkgJson.version;
          }
        } catch (e) {
          // Fallback
        }
        // Last resort: try to extract from package name patterns
        return 'installed';
      }
    }

    // Check Codex CLI (stored at ~/.codex)
    if (!frameWork || frameWork === 'codex') {
      const codexPath = path.join(homeDir, '.codex', 'plugin.json');
      if (fs.existsSync(codexPath)) {
        try {
          const pluginJson = JSON.parse(fs.readFileSync(codexPath, 'utf-8'));
          if (pluginJson.version) return pluginJson.version;
        } catch (e) {
          console.warn(`[tool-manager] Failed to parse ${codexPath}:`, e.message);
        }
      }
    }
  } catch (_) {}
  return null;
};

const getPublishedVersion = async (pkg) => {
  try {
    const cacheKey = `published-${pkg}`;
    const cached = versionCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < 3600000) {
      console.log(`[tool-manager] getPublishedVersion(${pkg}): cached = ${cached.version}`);
      return cached.version;
    }

    const cmd = isWindows ? 'npm.cmd' : 'npm';
    const result = await new Promise((resolve) => {
      const proc = spawn(cmd, ['view', pkg, 'version'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
        shell: isWindows
      });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_) {}
        console.log(`[tool-manager] npm view ${pkg} TIMEOUT`);
        resolve(null);
      }, 10000);
      proc.on('close', (code) => {
        clearTimeout(timer);
        console.log(`[tool-manager] npm view ${pkg} finished: code=${code}, stdout="${stdout.trim()}"`);
        resolve(code === 0 ? stdout.trim() : null);
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        console.log(`[tool-manager] npm view ${pkg} error:`, err.message);
        resolve(null);
      });
    });

    if (result) {
      versionCache.set(cacheKey, { version: result, timestamp: Date.now() });
      console.log(`[tool-manager] getPublishedVersion(${pkg}): result = ${result}`);
    } else {
      console.log(`[tool-manager] getPublishedVersion(${pkg}): null result`);
    }
    return result;
  } catch (err) {
    console.log(`[tool-manager] getPublishedVersion(${pkg}): error =`, err.message);
    return null;
  }
};

const checkCliInstalled = (pkg) => {
  try {
    const cmd = isWindows ? 'where' : 'which';
    const binMap = { '@anthropic-ai/claude-code': 'claude', 'opencode-ai': 'opencode', '@google/gemini-cli': 'gemini', '@kilocode/cli': 'kilo', '@openai/codex': 'codex' };
    const bin = binMap[pkg];
    if (bin) {
      try {
        execSync(`${cmd} ${bin}`, { stdio: 'pipe', timeout: 3000 });
        return true;
      } catch (_) {
        return false;
      }
    }
  } catch (_) {}
  return false;
};

const getCliVersion = (pkg) => {
  try {
    const binMap = { '@anthropic-ai/claude-code': 'claude', 'opencode-ai': 'opencode', '@google/gemini-cli': 'gemini', '@kilocode/cli': 'kilo', '@openai/codex': 'codex' };
    const bin = binMap[pkg];
    if (bin) {
      const out = execSync(`${bin} --version`, { stdio: 'pipe', timeout: 5000, encoding: 'utf8' });
      const match = out.match(/(\d+\.\d+\.\d+)/);
      if (match) return match[1];
    }
  } catch (_) {}
  return null;
};

const checkToolInstalled = (pluginId, frameWork = null) => {
  try {
    const homeDir = os.homedir();
    if (!frameWork || frameWork === 'claude') {
      if (fs.existsSync(path.join(homeDir, '.claude', 'plugins', pluginId))) return true;
    }
    if (!frameWork || frameWork === 'gemini') {
      if (fs.existsSync(path.join(homeDir, '.gemini', 'extensions', pluginId))) return true;
    }
    if (!frameWork || frameWork === 'opencode') {
      if (fs.existsSync(path.join(homeDir, '.config', 'opencode', 'agents', pluginId + '.md'))) return true;
      if (fs.existsSync(path.join(homeDir, '.config', 'opencode', 'agents', pluginId))) return true;
    }
    if (!frameWork || frameWork === 'kilo') {
      if (fs.existsSync(path.join(homeDir, '.config', 'kilo', 'agents', pluginId + '.md'))) return true;
      if (fs.existsSync(path.join(homeDir, '.config', 'kilo', 'agents', pluginId))) return true;
    }
  } catch (_) {}
  return false;
};

const compareVersions = (v1, v2) => {
  if (!v1 || !v2) return false;
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);
  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 < p2) return true;
    if (p1 > p2) return false;
  }
  return false;
};

const checkToolViaBunx = async (pkg, pluginId = null, category = 'plugin', frameWork = null) => {
  try {
    const isCli = category === 'cli';
    const installed = isCli ? checkCliInstalled(pkg) : checkToolInstalled(pluginId || pkg, frameWork);
    const installedVersion = isCli ? getCliVersion(pkg) : getInstalledVersion(pkg, pluginId, frameWork);
    const publishedVersion = await getPublishedVersion(pkg);
    const needsUpdate = installed && publishedVersion && compareVersions(installedVersion, publishedVersion);
    const isUpToDate = installed && !needsUpdate;
    return { installed, isUpToDate, upgradeNeeded: needsUpdate, output: 'version-check', installedVersion, publishedVersion };
  } catch (_) {
    const isCli = category === 'cli';
    const installed = isCli ? checkCliInstalled(pkg) : checkToolInstalled(pluginId || pkg, frameWork);
    const installedVersion = isCli ? getCliVersion(pkg) : getInstalledVersion(pkg, pluginId, frameWork);
    return { installed, isUpToDate: false, upgradeNeeded: false, output: '', installedVersion, publishedVersion: null };
  }
};

export function checkToolStatus(toolId) {
  const tool = getTool(toolId);
  if (!tool) return null;

  const cached = statusCache.get(toolId);
  if (cached && Date.now() - cached.timestamp < 1800000) {
    return {
      toolId,
      installed: cached.installed,
      isUpToDate: cached.isUpToDate,
      upgradeNeeded: cached.upgradeNeeded,
      timestamp: cached.timestamp
    };
  }

  return { toolId, installed: false, isUpToDate: false, upgradeNeeded: false, timestamp: Date.now() };
}

export async function checkToolStatusAsync(toolId) {
  const tool = getTool(toolId);
  if (!tool) return null;

  const cached = statusCache.get(toolId);
  if (cached && Date.now() - cached.timestamp < 1800000) {
    return {
      toolId,
      installed: cached.installed,
      isUpToDate: cached.isUpToDate,
      upgradeNeeded: cached.upgradeNeeded,
      installedVersion: cached.installedVersion,
      publishedVersion: cached.publishedVersion,
      timestamp: cached.timestamp
    };
  }

  const result = await checkToolViaBunx(tool.pkg, tool.pluginId, tool.category, tool.frameWork);
  const status = {
    toolId,
    category: tool.category,
    installed: result.installed,
    isUpToDate: result.isUpToDate,
    upgradeNeeded: result.upgradeNeeded,
    installedVersion: result.installedVersion,
    publishedVersion: result.publishedVersion,
    timestamp: Date.now()
  };

  statusCache.set(toolId, status);
  return status;
}

export async function checkForUpdates(toolId) {
  const tool = getTool(toolId);
  if (!tool) return { needsUpdate: false };

  const status = await checkToolStatusAsync(toolId);
  return { needsUpdate: status.upgradeNeeded && status.installed };
}

const spawnNpmInstall = (pkg, onProgress) => new Promise((resolve) => {
  const cmd = isWindows ? 'npm.cmd' : 'npm';
  let completed = false, stderr = '', stdout = '';
  let proc;
  try {
    proc = spawn(cmd, ['install', '-g', pkg], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 300000, shell: isWindows });
  } catch (err) {
    return resolve({ success: false, error: `Failed to spawn npm install: ${err.message}` });
  }
  if (!proc) return resolve({ success: false, error: 'Failed to spawn npm process' });
  const timer = setTimeout(() => { if (!completed) { completed = true; try { proc.kill('SIGKILL'); } catch (_) {} resolve({ success: false, error: 'Timeout (5min)' }); } }, 300000);
  const onData = (d) => { if (onProgress) onProgress({ type: 'progress', data: d.toString() }); };
  if (proc.stdout) proc.stdout.on('data', (d) => { stdout += d.toString(); onData(d); });
  if (proc.stderr) proc.stderr.on('data', (d) => { stderr += d.toString(); onData(d); });
  proc.on('close', (code) => {
    clearTimeout(timer);
    if (completed) return;
    completed = true;
    resolve(code === 0 ? { success: true, error: null, pkg } : { success: false, error: (stdout + stderr).substring(0, 1000) || 'Failed' });
  });
  proc.on('error', (err) => { clearTimeout(timer); if (!completed) { completed = true; resolve({ success: false, error: err.message }); } });
});

const spawnBunxProc = (pkg, onProgress) => new Promise((resolve) => {
  const cmd = isWindows ? 'bun.cmd' : 'bun';
  let completed = false, stderr = '', stdout = '';
  let lastDataTime = Date.now();
  let proc;

  try {
    proc = spawn(cmd, ['x', pkg], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 300000, shell: isWindows });
  } catch (err) {
    return resolve({ success: false, error: `Failed to spawn bun x: ${err.message}` });
  }

  if (!proc) {
    return resolve({ success: false, error: 'Failed to spawn bun x process' });
  }

  const timer = setTimeout(() => {
    if (!completed) {
      completed = true;
      try { proc.kill('SIGKILL'); } catch (_) {}
      resolve({ success: false, error: 'Timeout (5min)' });
    }
  }, 300000);

  const heartbeatTimer = setInterval(() => {
    if (completed) { clearInterval(heartbeatTimer); return; }
    const timeSinceLastData = Date.now() - lastDataTime;
    if (timeSinceLastData > 30000) {
      console.warn(`[tool-manager] No output from bun x ${pkg} for ${timeSinceLastData}ms - process may be hung`);
    }
  }, 30000);

  const onData = (d) => {
    lastDataTime = Date.now();
    if (onProgress) onProgress({ type: 'progress', data: d.toString() });
  };

  if (proc.stdout) proc.stdout.on('data', (d) => { stdout += d.toString(); onData(d); });
  if (proc.stderr) proc.stderr.on('data', (d) => { stderr += d.toString(); onData(d); });

  proc.on('close', (code) => {
    clearTimeout(timer);
    clearInterval(heartbeatTimer);
    if (completed) return;
    completed = true;
    const output = stdout + stderr;
    const successPatterns = [
      code === 0,
      output.includes('upgraded'),
      output.includes('registered'),
      output.includes('Hooks registered'),
      output.includes('successfully'),
      output.includes('Done'),
      code === 0 && !output.includes('error')
    ];
    if (successPatterns.some(p => p)) {
      resolve({ success: true, error: null, pkg });
    } else {
      resolve({ success: false, error: output.substring(0, 1000) || 'Failed' });
    }
  });

  proc.on('error', (err) => {
    clearTimeout(timer);
    clearInterval(heartbeatTimer);
    if (!completed) {
      completed = true;
      resolve({ success: false, error: `Process error: ${err.message}` });
    }
  });
});

const spawnForTool = (tool, onProgress) => {
  return tool.category === 'cli' ? spawnNpmInstall(tool.pkg, onProgress) : spawnBunxProc(tool.pkg, onProgress);
};

export async function install(toolId, onProgress) {
  const tool = getTool(toolId);
  if (!tool) return { success: false, error: 'Tool not found' };
  if (installLocks.get(toolId)) return { success: false, error: 'Install in progress' };
  installLocks.set(toolId, true);
  try {
    const result = await spawnForTool(tool, onProgress);
    if (result.success) {
      await new Promise(r => setTimeout(r, 500));
      statusCache.delete(toolId);
      versionCache.clear();
      const version = tool.category === 'cli' ? getCliVersion(tool.pkg) : getInstalledVersion(tool.pkg, tool.pluginId, tool.frameWork);
      const freshStatus = await checkToolStatusAsync(toolId);
      return { success: true, error: null, version: version || freshStatus.publishedVersion || 'unknown', ...freshStatus };
    }
    return result;
  } finally {
    installLocks.delete(toolId);
  }
}

export async function update(toolId, onProgress) {
  const tool = getTool(toolId);
  if (!tool) return { success: false, error: 'Tool not found' };
  const current = await checkToolStatusAsync(toolId);
  if (!current?.installed) return { success: false, error: 'Tool not installed' };
  if (installLocks.get(toolId)) return { success: false, error: 'Install in progress' };

  installLocks.set(toolId, true);
  try {
    const result = await spawnForTool(tool, onProgress);
    if (result.success) {
      await new Promise(r => setTimeout(r, 500));
      statusCache.delete(toolId);
      versionCache.clear();
      const version = tool.category === 'cli' ? getCliVersion(tool.pkg) : getInstalledVersion(tool.pkg, tool.pluginId, tool.frameWork);
      const freshStatus = await checkToolStatusAsync(toolId);
      return { success: true, error: null, version: version || freshStatus.publishedVersion || 'unknown', ...freshStatus };
    }
    return result;
  } finally {
    installLocks.delete(toolId);
  }
}

export function getAllTools() {
  return TOOLS.map(tool => {
    const cached = statusCache.get(tool.id);
    return {
      ...tool,
      toolId: tool.id,
      installed: cached?.installed ?? false,
      isUpToDate: cached?.isUpToDate ?? false,
      upgradeNeeded: cached?.upgradeNeeded ?? false,
      installedVersion: cached?.installedVersion ?? null,
      publishedVersion: cached?.publishedVersion ?? null,
      timestamp: cached?.timestamp ?? 0
    };
  });
}

export async function getAllToolsAsync() {
  const results = await Promise.all(TOOLS.map(tool => checkToolStatusAsync(tool.id)));
  return results.map((status, idx) => ({
    ...TOOLS[idx],
    ...status
  }));
}

export function getToolConfig(toolId) {
  return getTool(toolId) || null;
}

export async function autoProvision(broadcast) {
  const log = (msg) => console.log('[TOOLS-AUTO] ' + msg);
  log('Starting background tool provisioning...');
  for (const tool of TOOLS) {
    try {
      const status = await checkToolViaBunx(tool.pkg, tool.pluginId, tool.category, tool.frameWork);
      statusCache.set(tool.id, { ...status, toolId: tool.id, timestamp: Date.now() });
      if (!status.installed) {
        log(`${tool.id} not installed, installing...`);
        broadcast({ type: 'tool_install_started', toolId: tool.id });
        const result = await install(tool.id, (msg) => {
          broadcast({ type: 'tool_install_progress', toolId: tool.id, data: msg });
        });
        if (result.success) {
          log(`${tool.id} installed v${result.version}`);
          broadcast({ type: 'tool_install_complete', toolId: tool.id, data: result });
        } else {
          log(`${tool.id} install failed: ${result.error}`);
          broadcast({ type: 'tool_install_failed', toolId: tool.id, data: result });
        }
      } else if (status.upgradeNeeded) {
        log(`${tool.id} needs update (${status.installedVersion} -> ${status.publishedVersion})`);
        broadcast({ type: 'tool_install_started', toolId: tool.id });
        const result = await update(tool.id, (msg) => {
          broadcast({ type: 'tool_update_progress', toolId: tool.id, data: msg });
        });
        if (result.success) {
          log(`${tool.id} updated to v${result.version}`);
          broadcast({ type: 'tool_update_complete', toolId: tool.id, data: result });
        } else {
          log(`${tool.id} update failed: ${result.error}`);
          broadcast({ type: 'tool_update_failed', toolId: tool.id, data: result });
        }
      } else {
        log(`${tool.id} v${status.installedVersion} up-to-date`);
      }
    } catch (err) {
      log(`${tool.id} error: ${err.message}`);
    }
  }
  log('Provisioning complete');
}
