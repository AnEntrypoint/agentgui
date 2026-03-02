import { spawn } from 'child_process';
import { execSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';

const isWindows = os.platform() === 'win32';
const TOOLS = [
  { id: 'gm-oc', name: 'OpenCode', pkg: 'opencode-ai' },
  { id: 'gm-gc', name: 'Gemini CLI', pkg: '@google/gemini-cli' },
  { id: 'gm-kilo', name: 'Kilo', pkg: '@kilocode/cli' },
  { id: 'gm-cc', name: 'Claude Code', pkg: '@anthropic-ai/claude-code' },
];

const statusCache = new Map();
const installLocks = new Map();

const getTool = (id) => TOOLS.find(t => t.id === id);

const checkToolInstalled = (pkg) => {
  try {
    const __dirname = path.dirname(new URL(import.meta.url).pathname);
    const nodeModulesPath = path.join(__dirname, '..', 'node_modules', pkg);
    return fs.existsSync(nodeModulesPath);
  } catch (_) {
    return false;
  }
};

const checkToolViaBunx = async (pkg) => {
  try {
    const cmd = isWindows ? 'bunx.cmd' : 'bunx';
    return new Promise((resolve) => {
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
        resolve({ installed, isUpToDate: installed, upgradeNeeded: false, output: 'timeout' });
      }, 10000);
      proc.on('close', (code) => {
        clearTimeout(timer);
        const output = stdout + stderr;
        const installed = code === 0 || checkToolInstalled(pkg);
        const upgradeNeeded = output.includes('Upgrading') || output.includes('upgrade');
        const isUpToDate = installed && !upgradeNeeded;
        resolve({ installed, isUpToDate, upgradeNeeded, output });
      });
      proc.on('error', () => {
        clearTimeout(timer);
        const installed = checkToolInstalled(pkg);
        resolve({ installed, isUpToDate: false, upgradeNeeded: false, output: '' });
      });
    });
  } catch (_) {
    return { installed: checkToolInstalled(pkg), isUpToDate: false, upgradeNeeded: false, output: '' };
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
      timestamp: cached.timestamp
    };
  }

  const result = await checkToolViaBunx(tool.pkg);
  const status = {
    toolId,
    installed: result.installed,
    isUpToDate: result.isUpToDate,
    upgradeNeeded: result.upgradeNeeded,
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
