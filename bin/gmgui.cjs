#!/usr/bin/env node
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const projectRoot = path.join(__dirname, '..');

function hasBun() {
  try {
    spawnSync('which', ['bun'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function gmgui(args = []) {
  const command = args[0] || 'start';

  if (command === 'start') {
    const useBun = hasBun();
    const installer = useBun ? 'bun' : 'npm';

    // Ensure dependencies are installed only if node_modules is missing
    // Skip this for bunx which manages dependencies independently
    const nodeModulesPath = path.join(projectRoot, 'node_modules');
    const isBunx = process.env.npm_execpath && process.env.npm_execpath.includes('bunx');

    if (!isBunx && !fs.existsSync(nodeModulesPath)) {
      console.log(`Installing dependencies with ${installer}...`);
      const installResult = spawnSync(installer, ['install'], {
        cwd: projectRoot,
        stdio: 'inherit'
      });
      if (installResult.status !== 0) {
        throw new Error(`${installer} install failed with code ${installResult.status}`);
      }
    }

    const port = process.env.PORT || 3000;
    const baseUrl = process.env.BASE_URL || '/gm';
    const runtime = useBun ? 'bun' : 'node';

    return new Promise((resolve, reject) => {
      const ps = spawn(runtime, [path.join(projectRoot, 'server.js')], {
        cwd: projectRoot,
        env: { ...process.env, PORT: port, BASE_URL: baseUrl },
        stdio: 'inherit'
      });

      ps.on('error', (err) => {
        console.error(`Failed to start server: ${err.message}`);
        reject(err);
      });

      ps.on('exit', (code) => {
        if (code !== 0) {
          console.error(`Server exited with code ${code}`);
          // Don't reject - keep the promise pending so process stays alive
        }
      });

      // Never resolve this promise - keeps the process alive indefinitely
    });
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

// Always run when executed as a bin file (this file should only be used that way)
// Works with npm, npx, bunx, and direct execution
gmgui(process.argv.slice(2)).catch(err => {
  console.error(err.message);
  process.exit(1);
});
