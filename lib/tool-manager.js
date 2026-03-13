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
  { id: 'cli-agent-browser', name: 'Agent Browser', pkg: 'agent-browser', category: 'cli' },
  { id: 'gm-cc', name: 'GM Claude', pkg: 'gm-cc', installPkg: 'gm-cc@latest', pluginId: 'gm-cc', category: 'plugin', frameWork: 'claude' },
  { id: 'gm-oc', name: 'GM OpenCode', pkg: 'gm-oc', installPkg: 'gm-oc@latest', pluginId: 'gm', category: 'plugin', frameWork: 'opencode' },
  { id: 'gm-gc', name: 'GM Gemini', pkg: 'gm-gc', installPkg: 'gm-gc@latest', pluginId: 'gm', category: 'plugin', frameWork: 'gemini' },
  { id: 'gm-kilo', name: 'GM Kilo', pkg: 'gm-kilo', installPkg: 'gm-kilo@latest', pluginId: 'gm', category: 'plugin', frameWork: 'kilo' },
  { id: 'gm-codex', name: 'GM Codex', pkg: 'gm-codex', installPkg: 'gm-codex@latest', pluginId: 'gm', category: 'plugin', frameWork: 'codex' },
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
      const codexPluginPath = path.join(homeDir, '.codex', 'plugins', actualPluginId, 'plugin.json');
      if (fs.existsSync(codexPluginPath)) {
        try {
          const pluginJson = JSON.parse(fs.readFileSync(codexPluginPath, 'utf-8'));
          if (pluginJson.version) return pluginJson.version;
        } catch (e) {
          console.warn(`[tool-manager] Failed to parse ${codexPluginPath}:`, e.message);
        }
        return 'installed';
      }
    }
  } catch (_) {}
  return null;
};

const getPublishedVersion = async (pkg) => {
  const cacheKey = `published-${pkg}`;
  const cached = versionCache.get(cacheKey);
  // Use very aggressive caching - 24 hours
  if (cached && Date.now() - cached.timestamp < 86400000) {
    return cached.version;
  }

  // Return null immediately if npm view would block - never block on published versions
  // The server should prioritize installed detection over update availability
  return null;
};

const checkCliInstalled = (pkg) => {
  try {
    const cmd = isWindows ? 'where' : 'which';
    const binMap = { '@anthropic-ai/claude-code': 'claude', 'opencode-ai': 'opencode', '@google/gemini-cli': 'gemini', '@kilocode/cli': 'kilo', '@openai/codex': 'codex', 'agent-browser': 'agent-browser' };
    const bin = binMap[pkg];
    if (bin) {
      execSync(`${cmd} ${bin}`, { stdio: 'pipe', timeout: 3000, windowsHide: true });
      return true;
    }
  } catch (_) {}
  return false;
};

const getCliVersion = (pkg) => {
  try {
    const binMap = { '@anthropic-ai/claude-code': 'claude', 'opencode-ai': 'opencode', '@google/gemini-cli': 'gemini', '@kilocode/cli': 'kilo', '@openai/codex': 'codex', 'agent-browser': 'agent-browser' };
    const bin = binMap[pkg];
    if (bin) {
      try {
        // Use short timeout - we already know the binary exists from checkCliInstalled
        // agent-browser uses -V (--version prints help); others use --version
        const versionFlag = pkg === 'agent-browser' ? '-V' : '--version';
        const out = execSync(`${bin} ${versionFlag}`, { stdio: 'pipe', timeout: 1000, encoding: 'utf8', windowsHide: true });
        const match = out.match(/(\d+\.\d+\.\d+)/);
        if (match) {
          console.log(`[tool-manager] CLI ${pkg} (${bin}) version: ${match[1]}`);
          return match[1];
        }
      } catch (err) {
        // If version detection times out or fails, return null (binary exists but version unknown)
        console.log(`[tool-manager] CLI ${pkg} (${bin}) version detection failed: ${err.message.split('\n')[0]}`);
      }
    }
  } catch (err) {
    console.log(`[tool-manager] Error in getCliVersion for ${pkg}:`, err.message);
  }
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
    if (!frameWork || frameWork === 'codex') {
      if (fs.existsSync(path.join(homeDir, '.codex', 'plugins', pluginId))) return true;
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

const checkToolViaBunx = async (pkg, pluginId = null, category = 'plugin', frameWork = null, skipPublishedVersion = false) => {
  try {
    const isCli = category === 'cli';
    const installed = isCli ? checkCliInstalled(pkg) : checkToolInstalled(pluginId || pkg, frameWork);
    const installedVersion = isCli ? getCliVersion(pkg) : getInstalledVersion(pkg, pluginId, frameWork);

    // Skip published version check if requested (for faster initial detection during startup)
    let publishedVersion = null;
    if (!skipPublishedVersion) {
      publishedVersion = await getPublishedVersion(pkg);
    }

    const needsUpdate = installed && publishedVersion && compareVersions(installedVersion, publishedVersion);
    const isUpToDate = installed && !needsUpdate;
    return { installed, isUpToDate, upgradeNeeded: needsUpdate, output: 'version-check', installedVersion, publishedVersion };
  } catch (err) {
    console.log(`[tool-manager] Error checking ${pkg}:`, err.message);
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

export async function checkToolStatusAsync(toolId, skipPublishedVersion = true) {
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

  // Skip published version check by default for faster responses during initial tool detection
  const result = await checkToolViaBunx(tool.pkg, tool.pluginId, tool.category, tool.frameWork, skipPublishedVersion);
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
    proc = spawn(cmd, ['install', '-g', pkg], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 300000, shell: isWindows, windowsHide: true });
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
    proc = spawn(cmd, ['x', pkg], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 300000, shell: isWindows, windowsHide: true });
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
  const pkg = tool.installPkg || tool.pkg;
  return tool.category === 'cli' ? spawnNpmInstall(pkg, onProgress) : spawnBunxProc(pkg, onProgress);
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

export async function getAllToolsAsync(skipPublishedVersion = false) {
  const results = await Promise.all(TOOLS.map(tool => checkToolStatusAsync(tool.id, skipPublishedVersion)));
  return results.map((status, idx) => ({
    ...TOOLS[idx],
    ...status
  }));
}

export function clearStatusCache() {
  statusCache.clear();
  versionCache.clear();
  console.log('[tool-manager] Caches cleared, forcing fresh tool detection');
}

export async function refreshAllToolsAsync() {
  clearStatusCache();
  return getAllToolsAsync();
}

export function getAllToolsSync() {
  return TOOLS.map(tool => {
    const cached = statusCache.get(tool.id);
    return { ...tool, ...cached };
  });
}

export function getToolConfig(toolId) {
  return getTool(toolId) || null;
}

export async function autoProvision(broadcast) {
  const log = (msg) => console.log('[TOOLS-AUTO] ' + msg);
  log('Starting background tool provisioning...');
  for (const tool of TOOLS) {
    try {
      // Skip published version check initially for faster startup - agents need to be available immediately
      const status = await checkToolViaBunx(tool.pkg, tool.pluginId, tool.category, tool.frameWork, true);
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
        broadcast({ type: 'tool_status_update', toolId: tool.id, data: { installed: true, isUpToDate: true, installedVersion: status.installedVersion, status: 'installed' } });
      }
    } catch (err) {
      log(`${tool.id} error: ${err.message}`);
    }
  }
  log('Provisioning complete');
}

// Periodic tool update checker - runs in background every 6 hours
let updateCheckInterval = null;
const UPDATE_CHECK_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours

export function startPeriodicUpdateCheck(broadcast) {
  const log = (msg) => console.log('[TOOLS-PERIODIC] ' + msg);

  if (updateCheckInterval) {
    log('Update check already running');
    return;
  }

  log('Starting periodic tool update checker (every 6 hours)');

  // Run check immediately on startup (non-blocking)
  setImmediate(() => {
    checkAndUpdateTools(broadcast).catch(err => {
      log(`Initial check failed: ${err.message}`);
    });
  });

  // Then run periodically every 6 hours
  updateCheckInterval = setInterval(() => {
    checkAndUpdateTools(broadcast).catch(err => {
      log(`Periodic check failed: ${err.message}`);
    });
  }, UPDATE_CHECK_INTERVAL);
}

export function stopPeriodicUpdateCheck() {
  if (updateCheckInterval) {
    clearInterval(updateCheckInterval);
    updateCheckInterval = null;
    console.log('[TOOLS-PERIODIC] Update check stopped');
  }
}

async function checkAndUpdateTools(broadcast) {
  const log = (msg) => console.log('[TOOLS-PERIODIC] ' + msg);
  log('Checking for tool updates...');

  for (const tool of TOOLS) {
    try {
      const status = await checkToolViaBunx(tool.pkg, tool.pluginId, tool.category, tool.frameWork, false);

      if (status.upgradeNeeded) {
        log(`Update available for ${tool.id}: ${status.installedVersion} -> ${status.publishedVersion}`);
        broadcast({ type: 'tool_update_available', toolId: tool.id, data: { installedVersion: status.installedVersion, publishedVersion: status.publishedVersion } });

        // Auto-update in background (non-blocking)
        log(`Auto-updating ${tool.id}...`);
        const result = await update(tool.id, (msg) => {
          broadcast({ type: 'tool_update_progress', toolId: tool.id, data: msg });
        });

        if (result.success) {
          log(`${tool.id} auto-updated to v${result.version}`);
          broadcast({ type: 'tool_update_complete', toolId: tool.id, data: { ...result, autoUpdated: true } });
        } else {
          log(`${tool.id} auto-update failed: ${result.error}`);
          broadcast({ type: 'tool_update_failed', toolId: tool.id, data: { ...result, autoUpdated: true } });
        }
      }
    } catch (err) {
      log(`Error checking ${tool.id}: ${err.message}`);
    }
  }

  log('Update check complete');
}
