import { spawn } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';

const isWindows = os.platform() === 'win32';

const GM_PACKAGES = [
  { id: 'opencode', pkg: 'gm-oc', marker: path.join(os.homedir(), '.config', 'opencode', 'agents') },
  { id: 'gemini', pkg: 'gm-gc', marker: path.join(os.homedir(), '.gemini', 'extensions', 'gm', 'agents') },
  { id: 'kilo', pkg: 'gm-kilo', marker: path.join(os.homedir(), '.config', 'kilo', 'agents') },
];

function log(msg) { console.log('[GM-CONFIG] ' + msg); }

function runInstaller(pkg) {
  return new Promise((resolve) => {
    const bunCmd = isWindows ? 'bun.cmd' : 'bun';
    const proc = spawn(bunCmd, ['x', pkg], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000,
      shell: isWindows,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.stdout.on('error', () => {});
    proc.stderr.on('error', () => {});

    proc.on('close', (code) => {
      if (code === 0) {
        log(pkg + ' installed successfully');
      } else {
        log(pkg + ' exited with code ' + code);
        if (stderr.trim()) log(pkg + ' stderr: ' + stderr.trim().substring(0, 200));
      }
      resolve(code === 0);
    });

    proc.on('error', (err) => {
      log(pkg + ' spawn error: ' + err.message);
      resolve(false);
    });
  });
}

export async function installGMAgentConfigs() {
  const needed = GM_PACKAGES.filter(p => !fs.existsSync(p.marker));
  if (needed.length === 0) {
    log('all agent configs already installed');
    return;
  }

  log('installing agent configs for: ' + needed.map(p => p.pkg).join(', '));
  const results = await Promise.allSettled(needed.map(p => runInstaller(p.pkg)));

  const summary = needed.map((p, i) => {
    const r = results[i];
    const ok = r.status === 'fulfilled' && r.value;
    return p.pkg + ': ' + (ok ? 'ok' : 'failed');
  });
  log('results: ' + summary.join(', '));
}
