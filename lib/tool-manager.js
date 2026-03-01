import { spawn } from 'child_process';
import { execSync } from 'child_process';
import os from 'os';
import path from 'path';
import fs from 'fs';
import fetch from 'node-fetch';

const isWindows = os.platform() === 'win32';
const TOOLS = [
  { id: 'gm-oc', name: 'OpenCode', pkg: 'gm-oc', binary: 'opencode', marker: path.join(os.homedir(), '.config', 'opencode', 'agents') },
  { id: 'gm-gc', name: 'Gemini CLI', pkg: 'gm-gc', binary: 'gemini', marker: path.join(os.homedir(), '.gemini', 'extensions', 'gm', 'agents') },
  { id: 'gm-kilo', name: 'Kilo', pkg: '@kilocode/cli', binary: 'kilo', marker: path.join(os.homedir(), '.config', 'kilo', 'agents') },
  { id: 'gm-cc', name: 'Claude Code', pkg: '@anthropic-sdk/claude-code', binary: 'claude', marker: path.join(os.homedir(), '.config', 'claude', 'agents') },
];

const versionCache = new Map();
const installLocks = new Map();

const getTool = (id) => TOOLS.find(t => t.id === id);
const isInstalled = (tool) => {
  const ext = isWindows ? '.cmd' : '';
  if (fs.existsSync(path.join(process.cwd(), 'node_modules', '.bin', tool.binary + ext))) return true;
  try { execSync(`${isWindows ? 'where' : 'which'} ${tool.binary}`, { stdio: 'pipe', timeout: 2000 }); return true; } catch (_) { return false; }
};
const detectVersion = (binary) => {
  const versionPatterns = ['--version', '-v', '-V', '--help'];
  for (const flag of versionPatterns) {
    try {
      const o = execSync(`${binary} ${flag} 2>&1`, { timeout: 2000, encoding: 'utf8', stdio: 'pipe' });
      const match = o.match(/(\d+\.\d+\.\d+)/);
      if (match?.[1]) return match[1];
    } catch (_) {}
  }
  try {
    const binPath = execSync(`${isWindows ? 'where' : 'which'} ${binary}`, { timeout: 2000, encoding: 'utf8', stdio: 'pipe' }).trim();
    let pkgDir = path.dirname(binPath);
    for (let i = 0; i < 5; i++) {
      const pkgPath = path.join(pkgDir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
          if (pkg.version && pkg.version.match(/\d+\.\d+\.\d+/)) {
            return pkg.version.match(/(\d+\.\d+\.\d+)/)[1];
          }
        } catch (_) {}
      }
      pkgDir = path.dirname(pkgDir);
    }
  } catch (_) {}
  return null;
};
const cmpVer = (v1, v2) => { const [a,b] = [v1?.split('.')?.map(Number) || [], v2?.split('.')?.map(Number) || []]; for(let i=0;i<3;i++) { const n1=a[i]||0, n2=b[i]||0; if(n1<n2)return true; if(n1>n2)return false; } return false; };

export function checkToolStatus(toolId) {
  const tool = getTool(toolId);
  if (!tool) return null;
  const installed = isInstalled(tool) || fs.existsSync(tool.marker);
  const version = installed ? detectVersion(tool.binary) : null;
  return { toolId, installed, version, timestamp: Date.now() };
}

export async function checkForUpdates(toolId, currentVersion) {
  if (!currentVersion) return { hasUpdate: false, latestVersion: null };
  const tool = getTool(toolId);
  if (!tool) return { hasUpdate: false, latestVersion: null };

  try {
    const cached = versionCache.get(toolId);
    if (cached && Date.now() - cached.timestamp < 3600000) return { hasUpdate: cmpVer(currentVersion, cached.version), latestVersion: cached.version };

    const res = await fetch(`https://registry.npmjs.org/${tool.pkg}`, { timeout: 5000, headers: { 'Accept': 'application/json' } });
    if (!res.ok) return { hasUpdate: false, latestVersion: null };

    const data = await res.json();
    const latest = data['dist-tags']?.latest;
    if (latest) { versionCache.set(toolId, { version: latest, timestamp: Date.now() }); return { hasUpdate: cmpVer(currentVersion, latest), latestVersion: latest }; }
    return { hasUpdate: false, latestVersion: null };
  } catch (_) { return { hasUpdate: false, latestVersion: null }; }
}

const createMarkerDir = (tool) => {
  try {
    const markerDir = path.dirname(tool.marker);
    if (!fs.existsSync(markerDir)) {
      fs.mkdirSync(markerDir, { recursive: true });
    }
    if (!fs.existsSync(tool.marker)) {
      fs.mkdirSync(tool.marker, { recursive: true });
    }
  } catch (_) {}
};

const spawnProc = (toolId, tool, pkg, onProgress) => new Promise((resolve) => {
  const proc = spawn(isWindows ? 'npx.cmd' : 'npx', ['--yes', pkg], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 300000, shell: isWindows });
  let completed = false, stderr = '';
  const timer = setTimeout(() => { if (!completed) { completed = true; try { proc.kill('SIGKILL'); } catch (_) {} resolve({ success: false, error: 'Timeout (5min)' }); }}, 300000);
  proc.stdout.on('data', (d) => { if (onProgress) onProgress({ type: 'progress', data: d.toString() }); });
  proc.stderr.on('data', (d) => { stderr += d.toString(); if (onProgress) onProgress({ type: 'error', data: d.toString() }); });
  proc.on('close', (code) => {
    clearTimeout(timer);
    if (completed) return;
    completed = true;
    if (code === 0) {
      createMarkerDir(tool);
      let s = checkToolStatus(toolId);
      if (!s?.installed) {
        setTimeout(() => { s = checkToolStatus(toolId); }, 500);
      }
      resolve(s?.installed ? { success: true, error: null, version: s.version } : { success: false, error: 'Tool not detected' });
    } else {
      resolve({ success: false, error: stderr.substring(0, 1000) || 'Failed' });
    }
  });
  proc.on('error', (err) => { clearTimeout(timer); if (!completed) { completed = true; resolve({ success: false, error: err.message }); }});
});

export async function install(toolId, onProgress) {
  const tool = getTool(toolId);
  if (!tool) return { success: false, error: 'Tool not found' };
  if (installLocks.get(toolId)) return { success: false, error: 'Install in progress' };
  installLocks.set(toolId, true);
  try { return await spawnProc(toolId, tool, tool.pkg, onProgress); } finally { installLocks.delete(toolId); }
}

export async function update(toolId, targetVersion, onProgress) {
  const tool = getTool(toolId);
  if (!tool) return { success: false, error: 'Tool not found' };
  const current = checkToolStatus(toolId);
  if (!current?.installed) return { success: false, error: 'Tool not installed' };
  if (installLocks.get(toolId)) return { success: false, error: 'Install in progress' };

  const target = targetVersion || (await checkForUpdates(toolId, current.version)).latestVersion;
  if (!target) return { success: false, error: 'Unable to determine target version' };

  installLocks.set(toolId, true);
  try { return await spawnProc(toolId, tool, `${tool.pkg}@${target}`, onProgress); } finally { installLocks.delete(toolId); }
}

export function getAllTools() { return TOOLS.map(tool => ({ ...tool, ...checkToolStatus(tool.id) })); }
export function getToolConfig(toolId) { return getTool(toolId) || null; }
