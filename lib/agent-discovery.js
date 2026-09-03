import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const BINARIES = [
  { cmd: 'claude', id: 'claude-code', name: 'Claude Code', icon: 'C', protocol: 'cli' },
  { cmd: 'agy', id: 'agy', name: 'Antigravity', icon: 'Y', protocol: 'cli' },
  { cmd: 'opencode', id: 'opencode', name: 'OpenCode', icon: 'O', protocol: 'acp', npxPackage: 'opencode-ai' },
  { cmd: 'gemini', id: 'gemini', name: 'Gemini CLI', icon: 'G', protocol: 'acp', npxPackage: '@google/gemini-cli' },
  { cmd: 'kilo', id: 'kilo', name: 'Kilo Code', icon: 'K', protocol: 'acp', npxPackage: '@kilocode/cli' },
  { cmd: 'goose', id: 'goose', name: 'Goose', icon: 'g', protocol: 'acp' },
  { cmd: 'openhands', id: 'openhands', name: 'OpenHands', icon: 'H', protocol: 'acp' },
  { cmd: 'augment', id: 'augment', name: 'Augment Code', icon: 'A', protocol: 'acp' },
  { cmd: 'cline', id: 'cline', name: 'Cline', icon: 'c', protocol: 'acp' },
  { cmd: 'kimi', id: 'kimi', name: 'Kimi CLI', icon: 'K', protocol: 'acp' },
  { cmd: 'qwen-code', id: 'qwen', name: 'Qwen Code', icon: 'Q', protocol: 'acp' },
  { cmd: 'codex', id: 'codex', name: 'Codex CLI', icon: 'X', protocol: 'acp', npxPackage: '@openai/codex' },
  { cmd: 'mistral-vibe', id: 'mistral', name: 'Mistral Vibe', icon: 'M', protocol: 'acp' },
  { cmd: 'kiro', id: 'kiro', name: 'Kiro CLI', icon: 'k', protocol: 'acp' },
  { cmd: 'fast-agent', id: 'fast-agent', name: 'fast-agent', icon: 'F', protocol: 'acp' },
  { cmd: 'hermes', id: 'hermes', name: 'Hermes Agent', icon: 'h', protocol: 'acp' },
];

export function findCommand(cmd, rootDir) {
  if (!cmd) return null;
  const isWindows = os.platform() === 'win32';
  if (!rootDir) {
    try {
      const result = execSync(isWindows ? `where ${cmd}` : `which ${cmd}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 10000 }).trim();
      return result ? (isWindows ? result.split('\n')[0].trim() : result) : null;
    } catch { return null; }
  }
  const localBin = path.join(rootDir, 'node_modules', '.bin', isWindows ? cmd + '.cmd' : cmd);
  if (fs.existsSync(localBin)) {
    console.log(`[agent-discovery] Found ${cmd} in local node_modules`);
    return localBin;
  }
  try {
    const timeoutMs = 10000;
    if (isWindows) {
      const result = execSync(`where ${cmd}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], timeout: timeoutMs }).trim();
      if (result) {
        console.log(`[agent-discovery] Found ${cmd} in PATH`);
        return result.split('\n')[0].trim();
      }
    } else {
      const result = execSync(`which ${cmd}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], timeout: timeoutMs }).trim();
      if (result) {
        console.log(`[agent-discovery] Found ${cmd} in PATH`);
        return result;
      }
    }
  } catch (err) {
    console.log(`[agent-discovery] ${cmd} not found or timed out`);
    return null;
  }
  return null;
}

export function discoverAgents(rootDir) {
  const agents = [];
  for (const bin of BINARIES) {
    const result = findCommand(bin.cmd, rootDir);
    if (result) {
      agents.push({ id: bin.id, name: bin.name, icon: bin.icon, path: result, protocol: bin.protocol });
    } else if (bin.npxPackage) {
      agents.push({ id: bin.id, name: bin.name, icon: bin.icon, path: null, protocol: bin.protocol, npxPackage: bin.npxPackage, npxLaunchable: true });
    } else if (bin.id === 'claude-code') {
      agents.push({ id: bin.id, name: bin.name, icon: bin.icon, path: null, protocol: bin.protocol, npxPackage: '@anthropic-ai/claude-code', npxLaunchable: true });
    }
  }

  console.log('[discoverAgents] Final agent count:', agents.length, 'Agent IDs:', agents.map(a => a.id).join(', '));
  return agents;
}

export async function initializeAgentDiscovery(discoveredAgents, rootDir, logError) {
  try {
    const agents = discoverAgents(rootDir);
    discoveredAgents.length = 0;
    discoveredAgents.push(...agents);
    console.log('[AGENTS] Discovered:', discoveredAgents.map(a => ({ id: a.id, found: !!a.path, protocol: a.protocol })));
    console.log('[AGENTS] Total count:', discoveredAgents.length);
  } catch (err) {
    console.error('[AGENTS] Discovery error:', err.message);
    if (logError) logError('initializeAgentDiscovery', err);
  }
}
