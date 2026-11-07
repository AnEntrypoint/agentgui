import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LRUCache } from 'lru-cache';
import { createHttpHandler } from './lib/http-handler.js';
import { createTerminalSocket } from './lib/terminal-socket.js';
import { closeAllSessions } from './lib/terminal.js';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8')).version;
const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || '/gm').replace(/\/+/g, '/').replace(/\/+$/, '');
const staticDir = path.join(rootDir, 'site', 'app');
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '3000', 10);
const rateLimitMap = new LRUCache({ max: 1000, ttl: 60000 });
const terminalEnabled = () => !!process.env.PASSWORD && process.env.ENABLE_TERMINAL === '1';

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason instanceof Error ? reason.message : reason);
});

const server = http.createServer(createHttpHandler({ BASE_URL, staticDir, PKG_VERSION, RATE_LIMIT_MAX, rateLimitMap, terminalEnabled }));
createTerminalSocket(server, { BASE_URL, terminalEnabled });

function shutdown(code) {
  closeAllSessions();
  server.close(() => process.exit(code));
  setTimeout(() => process.exit(code), 1000).unref();
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Set PORT to a free port.`);
    process.exit(1);
  }
  console.error('[SERVER] Error:', err.message);
});

server.listen(PORT, () => {
  console.log(`agentgui terminal host: http://localhost:${PORT}${BASE_URL}/ (terminals ${terminalEnabled() ? 'enabled' : 'disabled: needs PASSWORD and ENABLE_TERMINAL=1'})`);
});
