#!/usr/bin/env node
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const projectRoot = path.join(__dirname, '..');

async function gmgui(args = []) {
  const command = args[0] || 'start';

  if (command === 'start') {
    // Ensure dependencies are installed
    const nodeModulesPath = path.join(projectRoot, 'node_modules');
    if (!fs.existsSync(nodeModulesPath)) {
      console.log('Installing dependencies...');
      const installResult = spawnSync('npm', ['install'], {
        cwd: projectRoot,
        stdio: 'inherit'
      });
      if (installResult.status !== 0) {
        throw new Error(`npm install failed with code ${installResult.status}`);
      }
    }

    const port = process.env.PORT || 3000;
    const baseUrl = process.env.BASE_URL || '/gm';

    return new Promise((resolve, reject) => {
      const ps = spawn('node', [path.join(projectRoot, 'server.js')], {
        cwd: projectRoot,
        env: { ...process.env, PORT: port, BASE_URL: baseUrl },
        stdio: 'inherit'
      });

      ps.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Server exited with code ${code}`));
      });

      ps.on('error', reject);
    });
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

// Run if this file is executed directly (works with symlinks, npm, npx)
const isBinFile = process.argv[1].endsWith('gmgui.cjs') ||
                   process.argv[1].endsWith('gmgui.js') ||
                   process.argv[1].endsWith('/gmgui') ||
                   process.argv[1].includes('bin/gmgui');
if (isBinFile) {
  gmgui(process.argv.slice(2)).catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
