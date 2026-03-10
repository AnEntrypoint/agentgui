#!/usr/bin/env node

/**
 * System Validation Script
 * Verifies that CLI tools are properly detected and agents are available
 * Usage: node test-system-validation.js
 */

import { execSync } from 'child_process';
import os from 'os';
import fs from 'fs';
import path from 'path';

const homeDir = os.homedir();
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m'
};

function log(color, label, message) {
  console.log(`${colors[color]}[${label}]${colors.reset} ${message}`);
}

function success(label, message) {
  log('green', label, message);
}

function error(label, message) {
  log('red', label, message);
}

function warn(label, message) {
  log('yellow', label, message);
}

function info(label, message) {
  log('blue', label, message);
}

// Test CLI tool detection
function testCLIDetection() {
  info('TEST', 'CLI Tool Detection');

  const tools = [
    { pkg: '@anthropic-ai/claude-code', bin: 'claude', name: 'Claude Code' },
    { pkg: 'opencode-ai', bin: 'opencode', name: 'OpenCode' },
    { pkg: '@google/gemini-cli', bin: 'gemini', name: 'Gemini CLI' },
    { pkg: '@kilocode/cli', bin: 'kilo', name: 'Kilo Code' },
    { pkg: '@openai/codex', bin: 'codex', name: 'Codex CLI' }
  ];

  let foundCount = 0;

  for (const tool of tools) {
    try {
      const cmd = os.platform() === 'win32' ? 'where' : 'which';
      const result = execSync(`${cmd} ${tool.bin}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();

      if (result) {
        success(tool.name, `Found at ${result}`);

        // Try to get version
        try {
          const version = execSync(`${tool.bin} --version`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
          const match = version.match(/(\d+\.\d+\.\d+)/);
          if (match) {
            success(tool.name, `Version ${match[1]}`);
          }
        } catch (_) {
          warn(tool.name, 'Could not detect version');
        }

        foundCount++;
      }
    } catch (_) {
      error(tool.name, 'NOT FOUND in PATH');
    }
  }

  console.log(`\n✓ CLI Detection Summary: ${foundCount}/${tools.length} tools found\n`);
  return foundCount > 0;
}

// Test agent discovery paths
function testAgentPaths() {
  info('TEST', 'Agent Plugin Paths');

  const paths = [
    { label: 'Claude Code Plugin', path: path.join(homeDir, '.claude', 'plugins', 'gm-cc') },
    { label: 'OpenCode Agent', path: path.join(homeDir, '.config', 'opencode', 'agents', 'gm.md') },
    { label: 'Gemini Extension', path: path.join(homeDir, '.gemini', 'extensions', 'gm') },
    { label: 'Kilo Agent', path: path.join(homeDir, '.config', 'kilo', 'agents', 'gm.md') }
  ];

  let foundCount = 0;

  for (const { label, path: p } of paths) {
    if (fs.existsSync(p)) {
      success(label, `Found at ${p}`);
      foundCount++;
    } else {
      warn(label, `Not found at ${p}`);
    }
  }

  console.log(`\n✓ Agent Paths Summary: ${foundCount}/${paths.length} agent paths exist\n`);
  return foundCount > 0;
}

// Test Node.js binary discovery
function testNodeBinaries() {
  info('TEST', 'Node Modules Binaries');

  const agentguiPath = '/config/workspace/agentgui';
  const binaries = ['claude', 'opencode', 'gemini', 'kilo', 'codex'];

  let foundCount = 0;

  for (const bin of binaries) {
    const path = `${agentguiPath}/node_modules/.bin/${bin}`;
    if (fs.existsSync(path)) {
      success(`Binary: ${bin}`, `Found at ${path}`);
      foundCount++;
    } else {
      warn(`Binary: ${bin}`, `NOT found at ${path}`);
    }
  }

  console.log(`\n✓ Node Binaries Summary: ${foundCount}/${binaries.length} binaries found\n`);
  return foundCount > 0;
}

// Test ES module imports
function testESModuleImports() {
  info('TEST', 'ES Module Imports (tool-manager.js)');

  try {
    const toolManagerPath = '/config/workspace/agentgui/lib/tool-manager.js';
    const content = fs.readFileSync(toolManagerPath, 'utf8');

    // Check for proper execSync import
    if (content.includes('import { spawn, execSync } from \'child_process\'')) {
      success('execSync Import', 'Properly imported from child_process');
    } else {
      error('execSync Import', 'NOT found or incorrectly imported');
      return false;
    }

    // Check that require() is not used
    if (!content.includes('require(\'child_process\')')) {
      success('No require()', 'No CommonJS require() calls found');
    } else {
      error('require() Calls', 'Found require() calls which won\'t work in ES modules');
      return false;
    }

    console.log();
    return true;
  } catch (err) {
    error('File Read', err.message);
    return false;
  }
}

// Run all tests
console.log('\n' + colors.blue + '═══════════════════════════════════════════════════════════' + colors.reset);
console.log(colors.blue + '  AgentGUI System Validation' + colors.reset);
console.log(colors.blue + '═══════════════════════════════════════════════════════════' + colors.reset + '\n');

let allPassed = true;

allPassed &= testCLIDetection();
allPassed &= testAgentPaths();
allPassed &= testNodeBinaries();
allPassed &= testESModuleImports();

console.log(colors.blue + '═══════════════════════════════════════════════════════════' + colors.reset);
if (allPassed) {
  success('RESULT', 'All critical checks passed! System should work correctly.');
} else {
  warn('RESULT', 'Some checks failed. Review errors above.');
}
console.log(colors.blue + '═══════════════════════════════════════════════════════════' + colors.reset + '\n');

process.exit(allPassed ? 0 : 1);
