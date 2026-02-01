#!/usr/bin/env node
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import process from 'process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, '..');

const args = process.argv.slice(2);
const command = args[0] || 'start';

if (command === 'start') {
  const port = process.env.PORT || 3000;
  const baseUrl = process.env.BASE_URL || '/gm';

  const ps = spawn('node', [path.join(projectRoot, 'server.js')], {
    cwd: projectRoot,
    env: { ...process.env, PORT: port, BASE_URL: baseUrl },
    stdio: 'inherit'
  });

  ps.on('exit', (code) => process.exit(code));
} else {
  console.error(`Unknown command: ${command}`);
  process.exit(1);
}
