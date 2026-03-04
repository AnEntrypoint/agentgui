import { spawn } from 'child_process';
import { execSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';

const isWindows = os.platform() === 'win32';
const TOOLS = [
  { id: 'gm-oc', name: 'OpenCode', pkg: 'gm-oc' },
  { id: 'gm-gc', name: 'Gemini CLI', pkg: 'gm-gc' },
  { id: 'gm-kilo', name: 'Kilo', pkg: 'gm-kilo' },
  { id: 'gm-cc', name: 'Claude Code', pkg: 'gm-cc' },
];

const statusCache = new Map();
const installLocks = new Map();
const versionCache = new Map();

const getTool = (id) => TOOLS.find(t => t.id === id);

const getNodeModulesPath = () => {
  const __dirname = path.dirname(new URL(import.meta.url).pathname);
  return path.join(__dirname, '..', 'node_modules');
};

const getInstalledVersion = (pkg) => {
  try {
    const homeDir = os.homedir();
    const pluginPath = path.join(homeDir, '.claude', 'plugins', pkg);
    const pluginJsonPath = path.join(pluginPath, 'plugin.json');
    if (fs.existsSync(pluginJsonPath)) {
      const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));
      if (pluginJson.version) {
        return pluginJson.version;
      }
    }
  } catch (_) {}
  return null;
};

const getCliToolVersion = async (pkg) => {
  try {
    const cliName = pkg.split('/').pop();
    const nodeModulesPath = getNodeModulesPath();
    const cliBinPath = path.join(nodeModulesPath, '.bin', cliName);

    if (fs.existsSync(cliBinPath)) {
      const result = await new Promise((resolve) => {
        const proc = spawn(cliBinPath, ['--version'], {
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
          if (code === 0) {
            const version = stdout.trim().split(/[\s\(]/)[0];
            resolve(version && version.match(/^\d+\.\d+/) ? version : null);
          } else {
            resolve(null);
          }
        });
        proc.on('error', () => {
          clearTimeout(timer);
          resolve(null);
        });
      });
      return result;
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

const checkToolInstalled = (pkg) => {
  try {
    const nodeModulesPath = getNodeModulesPath();
    const nodeModulesPackagePath = path.join(nodeModulesPath, pkg);
    return fs.existsSync(nodeModulesPackagePath);
  } catch (_) {
    return false;
  }
};

const checkToolViaBunx = async (pkg) => {
  try {
    const cmd = isWindows ? 'bunx.cmd' : 'bunx';
    const checkResult = await new Promise((resolve) => {
      const proc = spawn(cmd, [pkg, '--version'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
        shell: isWindows
      });
      let stdout = '', stderr = '';
      proc.stdout.on('data', (d) => { stdout += d.toString(); });
      proc.stderr.on('data', (d) => { stderr += d.toString(); });
      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_) {}
        const installed = checkToolInstalled(pkg);
        const installedVersion = getInstalledVersion(pkg);
        resolve({ installed, isUpToDate: installed, upgradeNeeded: false, output: 'timeout', installedVersion });
      }, 10000);
      proc.on('close', (code) => {
        clearTimeout(timer);
        const output = stdout + stderr;
        const installed = code === 0 || checkToolInstalled(pkg);
        const upgradeNeeded = output.includes('Upgrading') || output.includes('upgrade');
        const isUpToDate = installed && !upgradeNeeded;
        const installedVersion = getInstalledVersion(pkg);
        resolve({ installed, isUpToDate, upgradeNeeded, output, installedVersion });
      });
      proc.on('error', () => {
        clearTimeout(timer);
        const installed = checkToolInstalled(pkg);
        const installedVersion = getInstalledVersion(pkg);
        resolve({ installed, isUpToDate: false, upgradeNeeded: false, output: '', installedVersion });
      });
    });

    let finalInstalledVersion = checkResult.installedVersion;
    if (!finalInstalledVersion && checkResult.installed) {
      finalInstalledVersion = await getCliToolVersion(pkg);
    }

    const publishedVersion = await getPublishedVersion(pkg);
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

    const needsUpdate = checkResult.installed && publishedVersion && compareVersions(finalInstalledVersion, publishedVersion);
    return { ...checkResult, installedVersion: finalInstalledVersion, publishedVersion, upgradeNeeded: needsUpdate };
  } catch (_) {
    const installedVersion = getInstalledVersion(pkg);
    return { installed: checkToolInstalled(pkg), isUpToDate: false, upgradeNeeded: false, output: '', installedVersion, publishedVersion: null };
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

  const result = await checkToolViaBunx(tool.pkg);
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
  const proc = spawn(cmd, [pkg], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 300000, shell: isWindows });
  let completed = false, stderr = '', stdout = '';
  const timer = setTimeout(() => { if (!completed) { completed = true; try { proc.kill('SIGKILL'); } catch (_) {} resolve({ success: false, error: 'Timeout (5min)' }); }}, 300000);
  proc.stdout.on('data', (d) => { stdout += d.toString(); if (onProgress) onProgress({ type: 'progress', data: d.toString() }); });
  proc.stderr.on('data', (d) => { stderr += d.toString(); if (onProgress) onProgress({ type: 'error', data: d.toString() }); });
  proc.on('close', (code) => {
    clearTimeout(timer);
    if (completed) return;
    completed = true;
    const output = stdout + stderr;
    if (code === 0 || output.includes('upgraded') || output.includes('registered') || output.includes('Hooks registered')) {
      resolve({ success: true, error: null });
    } else {
      resolve({ success: false, error: output.substring(0, 1000) || 'Failed' });
    }
  });
  proc.on('error', (err) => { clearTimeout(timer); if (!completed) { completed = true; resolve({ success: false, error: err.message }); }});
});

export async function install(toolId, onProgress) {
  const tool = getTool(toolId);
  if (!tool) return { success: false, error: 'Tool not found' };
  if (installLocks.get(toolId)) return { success: false, error: 'Install in progress' };
  installLocks.set(toolId, true);
  try {
    const result = await spawnBunxProc(tool.pkg, onProgress);
    statusCache.delete(toolId);
    versionCache.delete(`published-${tool.pkg}`);
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
    statusCache.delete(toolId);
    versionCache.delete(`published-${tool.pkg}`);
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
