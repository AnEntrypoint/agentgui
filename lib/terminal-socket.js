import { WebSocketServer } from 'ws';
import { attachSocket } from './terminal.js';
import { digestEqual, originAllowed, stripBase } from './auth.js';

const SOCKET_PATH = /^\/api\/terminal\/sessions\/([0-9a-f]{16})$/;
const MAX_PAYLOAD = 1024 * 1024;

function reject(socket, status, text) {
  try {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  } catch {}
  socket.destroy();
}

export function createTerminalSocket(server, { BASE_URL, terminalEnabled }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const match = SOCKET_PATH.exec(stripBase(url.pathname, BASE_URL));
    if (!match) return reject(socket, 404, 'Not Found');
    if (!terminalEnabled()) return reject(socket, 403, 'Forbidden');
    if (!originAllowed(req)) return reject(socket, 403, 'Forbidden');
    if (!digestEqual(url.searchParams.get('token') || '', process.env.PASSWORD)) return reject(socket, 401, 'Unauthorized');
    wss.handleUpgrade(req, socket, head, (ws) => attachSocket(match[1], ws));
  });

  return wss;
}
