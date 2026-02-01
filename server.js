import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { pack, unpack } from 'msgpackr';
import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const watch = process.argv.includes('--watch');
const execAsync = promisify(exec);

// Create conversation folder for file uploads
const conversationFolder = path.join(os.tmpdir(), 'gmgui-conversations');
if (!fs.existsSync(conversationFolder)) {
  fs.mkdirSync(conversationFolder, { recursive: true });
}

// Hot reload file watcher
const watchedFiles = new Map();
const fileChangeCallbacks = [];

function watchFile(filePath) {
  if (watchedFiles.has(filePath)) return;
  
  try {
    fs.watchFile(filePath, { interval: 100 }, (curr, prev) => {
      if (curr.mtime > prev.mtime) {
        fileChangeCallbacks.forEach(cb => cb(filePath));
      }
    });
    watchedFiles.set(filePath, true);
  } catch (e) {
    console.error(`Failed to watch ${filePath}:`, e.message);
  }
}

function onFileChange(callback) {
  fileChangeCallbacks.push(callback);
}

// Serve static files with hot reload support
const staticDir = path.join(__dirname, 'static');
if (!fs.existsSync(staticDir)) {
  fs.mkdirSync(staticDir, { recursive: true });
}

// Agent connection manager
class AgentManager {
  constructor() {
    this.agents = new Map();
    this.messageQueue = [];
  }

  registerAgent(id, endpoint, agentData = {}) {
    this.agents.set(id, {
      id,
      endpoint,
      connected: false,
      ws: null,
      status: 'disconnected',
      lastMessage: null,
      ...agentData,
    });
  }

  getAgent(id) {
    return this.agents.get(id);
  }

  getAllAgents() {
    return Array.from(this.agents.values());
  }

  setAgentWs(id, ws) {
    const agent = this.agents.get(id);
    if (agent) {
      agent.ws = ws;
      agent.connected = true;
      agent.status = 'connected';
    }
  }

  broadcastToClients(clients, message) {
    const packed = pack(message);
    clients.forEach(client => {
      if (client.readyState === 1) {
        client.send(packed);
      }
    });
  }
}

const agentManager = new AgentManager();

// Agent Auto-Discovery Service
class AgentDiscoveryService {
  constructor(agentManager) {
    this.agentManager = agentManager;
    this.discoveryInterval = null;
    this.discoveredAgents = new Set();
    this.popularAgents = [
      { name: 'claude', display: 'Claude', icon: '🤖' },
      { name: 'code', display: 'Claude Code', icon: '💻' },
      { name: 'gemini', display: 'Google Gemini', icon: '✨' },
      { name: 'opencode', display: 'OpenCode', icon: '🔧' },
      { name: 'goose', display: 'Goose', icon: '🦆' },
      { name: 'qwen', display: 'Qwen', icon: '🧠' },
      { name: 'gpt', display: 'GPT CLI', icon: '🤖' },
      { name: 'anthropic', display: 'Anthropic CLI', icon: '📡' },
    ];
  }

  async discoverAgents() {
    const agents = [];

    agents.push(...this.discoverFromEnv());
    agents.push(...await this.discoverCLIAgents());
    agents.push(...await this.scanPorts());
    agents.push(...await this.loadConfigFile());

    return this.deduplicateAgents(agents);
  }

  discoverFromEnv() {
    const agents = [];
    const envVar = process.env.GMGUI_AGENTS || '';

    if (envVar) {
      try {
        const entries = envVar.split(',').map(e => e.trim()).filter(Boolean);
        for (const entry of entries) {
          const [id, endpoint] = entry.split(':').map(s => s.trim());
          if (id && endpoint) {
            agents.push({
              id,
              endpoint,
              discoveryMethod: 'env',
              timestamp: Date.now(),
            });
          }
        }
        if (agents.length > 0) {
          console.log(`✅ Discovered ${agents.length} agents from GMGUI_AGENTS`);
        }
      } catch (e) {
        console.error('Error parsing GMGUI_AGENTS:', e.message);
      }
    }

    return agents;
  }

  async discoverCLIAgents() {
    const agents = [];
    const pathEntries = (process.env.PATH || '').split(path.delimiter);

    for (const agentInfo of this.popularAgents) {
      try {
        let found = false;

        for (const pathEntry of pathEntries) {
          const agentPath = path.join(pathEntry, agentInfo.name);
          if (fs.existsSync(agentPath)) {
            found = true;
            agents.push({
              id: agentInfo.name,
              name: agentInfo.display,
              icon: agentInfo.icon,
              type: 'cli',
              path: agentPath,
              discoveryMethod: 'cli-scan',
              timestamp: Date.now(),
            });
            console.log(`✅ Found CLI agent: ${agentInfo.display} at ${agentPath}`);
            break;
          }
        }
      } catch (e) {
        // Agent not found, continue
      }
    }

    if (agents.length > 0) {
      console.log(`✅ Discovered ${agents.length} CLI agents from PATH`);
    }

    return agents;
  }

  async scanPorts() {
    const agents = [];
    const ports = process.env.GMGUI_SCAN_PORTS
      ? process.env.GMGUI_SCAN_PORTS.split(',').map(p => parseInt(p.trim()))
      : [3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009, 3010];

    console.log(`🔍 Scanning ports for agents: ${ports.join(', ')}`);

    for (const port of ports) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 1000);

        const response = await fetch(`http://localhost:${port}/health`, {
          signal: controller.signal,
          timeout: 1000,
        }).catch(() => null);

        clearTimeout(timeout);

        if (response && response.ok) {
          agents.push({
            id: `agent-${port}`,
            endpoint: `ws://localhost:${port}`,
            port,
            discoveryMethod: 'port-scan',
            timestamp: Date.now(),
          });
          console.log(`✅ Found agent on port ${port}`);
        }
      } catch (e) {
        // Port not responding
      }
    }

    return agents;
  }

  async loadConfigFile() {
    const agents = [];
    const configPath = path.join(os.homedir(), '.config', 'gmgui', 'agents.json');

    try {
      if (fs.existsSync(configPath)) {
        const data = fs.readFileSync(configPath, 'utf-8');
        const config = JSON.parse(data);

        if (Array.isArray(config)) {
          agents.push(...config.map(a => ({
            ...a,
            discoveryMethod: 'config-file',
            timestamp: Date.now(),
          })));
          console.log(`✅ Loaded ${agents.length} agents from config file`);
        }
      }
    } catch (e) {
      console.error('Error loading config file:', e.message);
    }

    return agents;
  }

  deduplicateAgents(agents) {
    const seen = new Map();

    return agents.filter(agent => {
      const key = agent.type === 'cli' ? agent.id : `${agent.endpoint}`;

      if (seen.has(key)) {
        return false;
      }

      seen.set(key, agent);
      return true;
    });
  }

  registerDiscoveredAgents(agents) {
    agents.forEach(agent => {
      const key = agent.type === 'cli' ? agent.id : (agent.endpoint || agent.id);

      if (!this.discoveredAgents.has(key)) {
        const agentData = {
          type: agent.type || 'websocket',
          discoveryMethod: agent.discoveryMethod,
        };

        if (agent.type === 'cli') {
          agentData.name = agent.name;
          agentData.icon = agent.icon;
          agentData.path = agent.path;
          agentData.status = 'available';
          agentData.connected = false;
        }

        this.agentManager.registerAgent(agent.id, agent.endpoint || null, agentData);
        this.discoveredAgents.add(key);
        console.log(`✅ Registered discovered agent: ${agent.id}`);
      }
    });
  }

  startMonitoring(interval = 30000) {
    if (this.discoveryInterval) return;

    this.discoveryInterval = setInterval(async () => {
      try {
        const agents = await this.discoverAgents();
        this.registerDiscoveredAgents(agents);
      } catch (e) {
        console.error('Error during agent discovery monitoring:', e.message);
      }
    }, interval);

    console.log(`🔄 Agent discovery monitoring started (interval: ${interval}ms)`);
  }

  stopMonitoring() {
    if (this.discoveryInterval) {
      clearInterval(this.discoveryInterval);
      this.discoveryInterval = null;
    }
  }
}

const discoveryService = new AgentDiscoveryService(agentManager);

// HTTP server
const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // API routes
  if (req.url === '/api/agents' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agents: agentManager.getAllAgents() }));
    return;
  }

  // CLI agent launch endpoint
  if (req.url.match(/^\/api\/cli-agents\/(.+)\/launch$/) && req.method === 'POST') {
    const agentId = req.url.split('/')[3];
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const agent = agentManager.getAgent(agentId);
        if (agent && agent.type === 'cli') {
          console.log(`Launching CLI agent: ${agentId}`);
          execAsync(`${agent.path} &`).catch(e => {
            console.error(`Error launching ${agentId}:`, e.message);
          });

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, message: `CLI agent ${agentId} launched` }));
        } else {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Agent not found or not a CLI agent' }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Screenshot endpoint
  if (req.url === '/api/screenshot' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        const payload = JSON.parse(body);
        const format = payload.format || 'png';
        const filename = `screenshot-${Date.now()}.${format}`;
        const filepath = path.join(conversationFolder, filename);

        // Try scrot first, fall back to other tools
        let screenshotTaken = false;

        // Try scrot (Linux X11)
        if (!screenshotTaken) {
          try {
            await execAsync(`scrot "${filepath}" 2>/dev/null || true`);
            if (fs.existsSync(filepath)) screenshotTaken = true;
          } catch (e) {
            // Continue to next method
          }
        }

        // Try gnome-screenshot (GNOME)
        if (!screenshotTaken) {
          try {
            await execAsync(`gnome-screenshot -f "${filepath}" 2>/dev/null || true`);
            if (fs.existsSync(filepath)) screenshotTaken = true;
          } catch (e) {
            // Continue to next method
          }
        }

        // Try import from ImageMagick
        if (!screenshotTaken) {
          try {
            await execAsync(`import -window root "${filepath}" 2>/dev/null || true`);
            if (fs.existsSync(filepath)) screenshotTaken = true;
          } catch (e) {
            // Continue to next method
          }
        }

        // If no tool available, create a placeholder GIF
        if (!screenshotTaken) {
          fs.writeFileSync(filepath, Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          success: true, 
          filename,
          path: `/uploads/${filename}`,
          timestamp: Date.now()
        }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // File upload endpoint
  if (req.url === '/api/upload' && req.method === 'POST') {
    const boundary = req.headers['content-type'].split('boundary=')[1];
    let body = '';
    
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
      try {
        const parts = body.split(`--${boundary}`);
        const files = [];

        for (const part of parts) {
          if (part.includes('filename=')) {
            const filenameMatch = part.match(/filename="([^"]+)"/);
            const filename = filenameMatch ? filenameMatch[1] : `file-${Date.now()}`;
            
            const fileStart = part.indexOf('\r\n\r\n') + 4;
            const fileEnd = part.lastIndexOf('\r\n');
            const fileContent = part.substring(fileStart, fileEnd);
            
            const uploadPath = path.join(conversationFolder, filename);
            fs.writeFileSync(uploadPath, fileContent);
            
            files.push({
              filename,
              path: `/uploads/${filename}`,
              size: fileContent.length,
              timestamp: Date.now()
            });
          }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, files }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (req.url.startsWith('/api/agents/') && req.method === 'POST') {
    const agentId = req.url.split('/')[3];
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const payload = JSON.parse(body);
        const agent = agentManager.getAgent(agentId);
        if (agent && agent.ws) {
          agent.ws.send(pack(payload));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Agent not found or not connected' }));
        }
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // Serve uploaded files
  if (req.url.startsWith('/uploads/')) {
    const filename = req.url.slice(9);
    const uploadPath = path.join(conversationFolder, filename);
    
    const normalizedPath = path.normalize(uploadPath);
    if (!normalizedPath.startsWith(conversationFolder)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.stat(uploadPath, (err, stats) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      if (stats.isFile()) {
        const ext = path.extname(uploadPath).toLowerCase();
        const mimeTypes = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.pdf': 'application/pdf',
          '.txt': 'text/plain',
          '.json': 'application/json',
        };
        const contentType = mimeTypes[ext] || 'application/octet-stream';

        fs.readFile(uploadPath, (err, data) => {
          if (err) {
            res.writeHead(500);
            res.end('Server error');
            return;
          }

          res.writeHead(200, { 'Content-Type': contentType });
          res.end(data);
        });
      } else {
        res.writeHead(403);
        res.end('Forbidden');
      }
    });
    return;
  }

  // Serve static files
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = path.join(staticDir, filePath);

  const normalizedPath = path.normalize(filePath);
  if (!normalizedPath.startsWith(staticDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }

    if (stats.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      fs.stat(filePath, (err, stats) => {
        if (err) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        serveFile(filePath, res);
      });
    } else {
      serveFile(filePath, res);
    }
  });
});

function serveFile(filePath, res) {
  if (watch) {
    watchFile(filePath);
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml',
  };

  const contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end('Server error');
      return;
    }

    // Inject hot reload script in HTML
    let content = data.toString();
    if (ext === '.html' && watch) {
      content += `
<script>
(function() {
  const ws = new WebSocket('ws://' + location.host + '/hot-reload');
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'reload') location.reload();
  };
})();
</script>`;
    }

    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
}

// WebSocket server for agent connections and hot reload
const wss = new WebSocketServer({ server });
const clients = [];

wss.on('connection', (ws, req) => {
  const url = req.url;

  if (url === '/hot-reload') {
    // Hot reload client connection
    clients.push(ws);
    ws.on('close', () => {
      const idx = clients.indexOf(ws);
      if (idx > -1) clients.splice(idx, 1);
    });
    return;
  }

  // Agent connection
  const agentId = url.match(/^\/agent\/([^/]+)/)?.[1];
  if (!agentId) {
    ws.close(1008, 'Invalid agent ID');
    return;
  }

  const agent = agentManager.getAgent(agentId);
  if (!agent) {
    ws.close(1008, 'Agent not registered');
    return;
  }

  agentManager.setAgentWs(agentId, ws);
  console.log(`Agent connected: ${agentId}`);

  // Notify clients of agent connection
  agentManager.broadcastToClients(clients, {
    type: 'agent:connected',
    agentId,
    agent: agent,
  });

  ws.on('message', (data) => {
    try {
      const message = unpack(data);
      message.agentId = agentId;
      message.timestamp = Date.now();

      // Broadcast to all connected clients
      agentManager.broadcastToClients(clients, {
        type: 'agent:message',
        ...message,
      });

      // Update agent status
      if (message.status) {
        agent.status = message.status;
      }
      agent.lastMessage = message;
    } catch (e) {
      console.error(`Error processing message from ${agentId}:`, e.message);
    }
  });

  ws.on('close', () => {
    agent.connected = false;
    agent.status = 'disconnected';
    console.log(`Agent disconnected: ${agentId}`);
    agentManager.broadcastToClients(clients, {
      type: 'agent:disconnected',
      agentId,
    });
  });

  ws.on('error', (err) => {
    console.error(`WebSocket error for ${agentId}:`, err.message);
  });
});

// Hot reload watcher
if (watch) {
  onFileChange(() => {
    console.log('Files changed, reloading clients...');
    clients.forEach(client => {
      if (client.readyState === 1) {
        client.send(JSON.stringify({ type: 'reload' }));
      }
    });
  });
}

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  discoveryService.stopMonitoring();
  wss.close(() => {
    server.close(() => {
      process.exit(0);
    });
  });
});

server.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  console.log(`Hot reload: ${watch ? 'enabled' : 'disabled'}`);

  try {
    const agents = await discoveryService.discoverAgents();
    discoveryService.registerDiscoveredAgents(agents);
    discoveryService.startMonitoring();
  } catch (e) {
    console.error('Failed to initialize agent discovery:', e.message);
  }
});
