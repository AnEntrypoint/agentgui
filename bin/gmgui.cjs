#!/usr/bin/env node
const { spawn, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const projectRoot = path.join(__dirname, '..');

async function gmgui(args = []) {
  const command = args[0] || 'start';

  if (command === 'start') {
    // Always use node as runtime for reliability. When invoked via bun x,
    // dependencies are already managed. When invoked via npm/npx, we install
    // dependencies ourselves. This avoids ENOENT errors on systems where bun
    // may not be in PATH even though bun x works.
    const installer = 'npm';

    // Ensure dependencies are installed only if node_modules is missing
    // Skip this for bun x/npx which manage dependencies independently
    const nodeModulesPath = path.join(projectRoot, 'node_modules');
    const execPath = process.env.npm_execpath || '';
    const isBunx = execPath.includes('bun') || process.env.BUN_INSTALL;
    const isNpx = execPath.includes('npx') || (process.env._ && process.env._.includes('npx'));
    
    // Also skip if running from temp/cache directory (bun x/npm cache)
    const isFromCache = projectRoot.includes('node_modules') && 
                        (projectRoot.includes('.bun') || projectRoot.includes('_npx') || projectRoot.includes('npm-cache'));

    if (!isBunx && !isNpx && !isFromCache && !fs.existsSync(nodeModulesPath)) {
      console.log(`Installing dependencies with ${installer}...`);
      const installResult = spawnSync(installer, ['install'], {
        cwd: projectRoot,
        stdio: 'inherit',
        shell: true
      });
      if (installResult.status !== 0 && installResult.status !== null) {
        throw new Error(`${installer} install failed with code ${installResult.status}`);
      }
      if (installResult.error) {
        throw new Error(`${installer} install failed: ${installResult.error.message}`);
      }
    }

    const port = process.env.PORT || 3000;
    const baseUrl = process.env.BASE_URL || '/gm';
    const bunAvailable = (() => { try { return spawnSync('bun', ['--version'], { shell: true }).status === 0; } catch { return false; } })();
    const runtime = bunAvailable ? 'bun' : 'node';

    return new Promise((resolve, reject) => {
      const ps = spawn(runtime, [path.join(projectRoot, 'server.js')], {
        cwd: projectRoot,
        env: { ...process.env, PORT: port, BASE_URL: baseUrl, STARTUP_CWD: process.cwd() },
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
// Works with npm, npx, bun x, and direct execution
gmgui(process.argv.slice(2)).catch(err => {
  console.error(err.message);
  process.exit(1);
});
