import { app, BrowserWindow, dialog } from 'electron';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import http from 'http';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || '/gm').replace(/\/+$/, '');
const APP_URL = `http://localhost:${PORT}${BASE_URL}/`;

let serverProcess = null;
let mainWindow = null;

function startServer() {
  // process.execPath is the Electron binary; ELECTRON_RUN_AS_NODE makes it run
  // server.js as a plain Node process instead of spinning up a second
  // Electron/Chromium app runtime just to host the background HTTP server.
  serverProcess = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
  serverProcess.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
  serverProcess.on('exit', code => {
    if (code !== 0 && mainWindow) {
      dialog.showErrorBox('Server exited', `AgentGUI server exited with code ${code}`);
    }
  });
}

function pollReady(retries = 40) {
  return new Promise((resolve, reject) => {
    function attempt(n) {
      http.get(APP_URL, res => {
        res.resume(); // drain the response so the socket is freed between polls
        if (res.statusCode === 200 || res.statusCode === 401) return resolve();
        if (n <= 0) return reject(new Error(`Server not ready after polling (last status: ${res.statusCode})`));
        setTimeout(() => attempt(n - 1), 500);
      }).on('error', err => {
        if (n <= 0) return reject(new Error(`Server not reachable: ${err.message}`));
        setTimeout(() => attempt(n - 1), 500);
      });
    }
    attempt(retries);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'AgentGUI',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL(APP_URL);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  startServer();
  try {
    await pollReady();
  } catch (e) {
    dialog.showErrorBox('Startup failed', e.message);
    app.quit();
    return;
  }
  createWindow();
  app.on('activate', () => { if (!mainWindow) createWindow(); });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
});
