import { spawn } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';

const isWindows = os.platform() === 'win32';
const TOOLS = [
  { id: 'gm-oc', name: 'gm-oc', pkg: 'gm-oc', pluginId: 'gm-oc' },
  { id: 'gm-gc', name: 'gm-gc', pkg: 'gm-gc', pluginId: 'gm' },
  { id: 'gm-kilo', name: 'gm-kilo', pkg: 'gm-kilo', pluginId: 'gm-kilo' },
  { id: 'gm-cc', name: 'gm-cc', pkg: 'gm-cc', pluginId: 'gm-cc' },
];

const statusCache = new Map();
const installLocks = new Map();
const versionCache = new Map();

const getTool = (id) => TOOLS.find(t => t.id === id);

const getInstalledVersion = (pkg, pluginId = null) => {
  try {
    const homeDir = os.homedir();
    const tool = pluginId ? TOOLS.find(t => t.pkg === pkg) : null;
    const actualPluginId = pluginId || (tool?.pluginId) || pkg;

    // Check Claude Code plugins using correct pluginId
    const claudePath = path.join(homeDir, '.claude', 'plugins', actualPluginId, 'plugin.json');
    if (fs.existsSync(claudePath)) {
      try {
        const pluginJson = JSON.parse(fs.readFileSync(claudePath, 'utf-8'));
        if (pluginJson.version) return pluginJson.version;
      } catch (e) {
        console.warn(`[tool-manager] Failed to parse ${claudePath}:`, e.message);
      }
    }

    // Check OpenCode agents using correct pluginId
    const opencodePath = path.join(homeDir, '.config', 'opencode', 'agents', actualPluginId, 'plugin.json');
    if (fs.existsSync(opencodePath)) {
      try {
        const pluginJson = JSON.parse(fs.readFileSync(opencodePath, 'utf-8'));
        if (pluginJson.version) return pluginJson.version;
      } catch (e) {
        console.warn(`[tool-manager] Failed to parse ${opencodePath}:`, e.message);
      }
    }

    // Check Gemini CLI agents (stored as 'gm' directory)
    const geminiPath = path.join(homeDir, '.gemini', 'extensions', actualPluginId, 'plugin.json');
    if (fs.existsSync(geminiPath)) {
      try {
        const pluginJson = JSON.parse(fs.readFileSync(geminiPath, 'utf-8'));
        if (pluginJson.version) return pluginJson.version;
      } catch (e) {
        console.warn(`[tool-manager] Failed to parse ${geminiPath}:`, e.message);
      }
    }
    // Try gemini-extension.json as fallback
    const geminiExtPath = path.join(homeDir, '.gemini', 'extensions', actualPluginId, 'gemini-extension.json');
    if (fs.existsSync(geminiExtPath)) {
      try {
        const extJson = JSON.parse(fs.readFileSync(geminiExtPath, 'utf-8'));
        if (extJson.version) return extJson.version;
      } catch (e) {
        console.warn(`[tool-manager] Failed to parse ${geminiExtPath}:`, e.message);
      }
    }

    // Check Kilo agents using correct pluginId
    const kiloPath = path.join(homeDir, '.config', 'kilo', 'agents', actualPluginId, 'plugin.json');
    if (fs.existsSync(kiloPath)) {
      try {
        const pluginJson = JSON.parse(fs.readFileSync(kiloPath, 'utf-8'));
        if (pluginJson.version) return pluginJson.version;
      } catch (e) {
        console.warn(`[tool-manager] Failed to parse ${kiloPath}:`, e.message);
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
      return cached.version;
    }

    const cmd = isWindows ? 'npm.cmd' : 'npm';
    const result = await new Promise((resolve) => {
      const proc = spawn(cmd, ['view', pkg, 'version'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000,
        shell: isWindows
      });
      let stdout = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_) {}
        resolve(null);
      }, 5000);
      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve(code === 0 ? stdout.trim() : null);
      });
      proc.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
    });

    if (result) {
      versionCache.set(cacheKey, { version: result, timestamp: Date.now() });
    }
    return result;
  } catch (_) {
    return null;
  }
};

const checkToolInstalled = (pluginId) => {
  try {
    const homeDir = os.homedir();
    if (fs.existsSync(path.join(homeDir, '.claude', 'plugins', pluginId))) return true;
    if (fs.existsSync(path.join(homeDir, '.gemini', 'extensions', pluginId))) return true;
    if (fs.existsSync(path.join(homeDir, '.config', 'opencode', 'agents', pluginId + '.md'))) return true;
    if (fs.existsSync(path.join(homeDir, '.config', 'kilo', 'agents', pluginId + '.md'))) return true;
    if (fs.existsSync(path.join(homeDir, '.config', 'opencode', 'agents', 'gm.md'))) return true;
    if (fs.existsSync(path.join(homeDir, '.config', 'kilo', 'agents', 'gm.md'))) return true;
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

const checkToolViaBunx = async (pkg, pluginId = null) => {
  try {
    const actualPluginId = pluginId || pkg;
    const installed = checkToolInstalled(actualPluginId);
    const installedVersion = getInstalledVersion(pkg, pluginId);
    const publishedVersion = await getPublishedVersion(pkg);
    const needsUpdate = installed && publishedVersion && compareVersions(installedVersion, publishedVersion);
    const isUpToDate = installed && !needsUpdate;

    return {
      installed,
      isUpToDate,
      upgradeNeeded: needsUpdate,
      output: 'version-check',
      installedVersion,
      publishedVersion
    };
  } catch (_) {
    const actualPluginId = pluginId || pkg;
    const installedVersion = getInstalledVersion(pkg, pluginId);
    return { installed: checkToolInstalled(actualPluginId), isUpToDate: false, upgradeNeeded: false, output: '', installedVersion, publishedVersion: null };
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

  const result = await checkToolViaBunx(tool.pkg, tool.pluginId);
  const status = {
    toolId,
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

const spawnBunxProc = (pkg, onProgress) => new Promise((resolve) => {
  const cmd = isWindows ? 'bunx.cmd' : 'bunx';
  let completed = false, stderr = '', stdout = '';
  let lastDataTime = Date.now();
  let proc;

  try {
    proc = spawn(cmd, [pkg], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 300000, shell: isWindows });
  } catch (err) {
    return resolve({ success: false, error: `Failed to spawn bunx: ${err.message}` });
  }

  if (!proc) {
    return resolve({ success: false, error: 'Failed to spawn bunx process' });
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
      console.warn(`[tool-manager] No output from bunx ${pkg} for ${timeSinceLastData}ms - process may be hung`);
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

export async function install(toolId, onProgress) {
  const tool = getTool(toolId);
  if (!tool) return { success: false, error: 'Tool not found' };
  if (installLocks.get(toolId)) return { success: false, error: 'Install in progress' };
  installLocks.set(toolId, true);
  try {
    const result = await spawnBunxProc(tool.pkg, onProgress);
    if (result.success) {
      // Give the filesystem a moment to settle after bunx install
      await new Promise(r => setTimeout(r, 500));

      // Aggressively clear all version caches to force fresh detection
      statusCache.delete(toolId);
      versionCache.clear();

      const version = getInstalledVersion(tool.pkg, tool.pluginId);
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
    const result = await spawnBunxProc(tool.pkg, onProgress);
    if (result.success) {
      await new Promise(r => setTimeout(r, 500));
      statusCache.delete(toolId);
      versionCache.clear();
      const version = getInstalledVersion(tool.pkg, tool.pluginId);
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
