import { spawn } from 'child_process';
import fs from 'fs';

export default class ACPConnection {
  constructor() {
    this.child = null;
    this.buffer = '';
    this.nextRequestId = 1;
    this.pendingRequests = new Map();
    this.sessionId = null;
    this.onUpdate = null;
  }

  async connect(agentType, cwd) {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    delete env.NODE_INSPECT;
    delete env.NODE_DEBUG;

    if (agentType === 'opencode') {
      this.child = spawn('opencode', ['acp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env, shell: false });
    } else {
      this.child = spawn('claude-code-acp', [], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env, shell: false });
    }

    this.child.stderr.on('data', d => console.error(`[ACP:${agentType}:stderr]`, d.toString().trim()));
    this.child.on('error', err => console.error(`[ACP:${agentType}:error]`, err.message));
    this.child.on('exit', (code, signal) => {
      console.log(`[ACP:${agentType}] exited code=${code} signal=${signal}`);
      this.child = null;
      for (const [id, req] of this.pendingRequests) {
        req.reject(new Error('ACP process exited'));
        clearTimeout(req.timeoutId);
      }
      this.pendingRequests.clear();
    });

    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', data => {
      this.buffer += data;
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          this.handleMessage(JSON.parse(line));
        } catch (e) {
          console.error('[ACP:parse]', line.substring(0, 200), e.message);
        }
      }
    });

    await new Promise(r => setTimeout(r, 500));
  }

  handleMessage(msg) {
    if (msg.method) {
      this.handleIncoming(msg);
      return;
    }
    if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
      const req = this.pendingRequests.get(msg.id);
      this.pendingRequests.delete(msg.id);
      clearTimeout(req.timeoutId);
      if (msg.error) {
        req.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        req.resolve(msg.result);
      }
    }
  }

  handleIncoming(msg) {
    if (msg.method === 'session/update' && msg.params) {
      if (this.onUpdate) this.onUpdate(msg.params);
      this.resetPromptTimeout();
      return;
    }
    if (msg.method === 'session/request_permission' && msg.id !== undefined) {
      this.sendResponse(msg.id, { outcome: { outcome: 'selected', optionId: 'allow' } });
      this.resetPromptTimeout();
      return;
    }
    if (msg.method === 'fs/read_text_file' && msg.id !== undefined) {
      const filePath = msg.params?.path;
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        this.sendResponse(msg.id, { content });
      } catch (e) {
        this.sendError(msg.id, -32000, e.message);
      }
      return;
    }
    if (msg.method === 'fs/write_text_file' && msg.id !== undefined) {
      const { path: filePath, content } = msg.params || {};
      try {
        fs.writeFileSync(filePath, content, 'utf-8');
        this.sendResponse(msg.id, null);
      } catch (e) {
        this.sendError(msg.id, -32000, e.message);
      }
      return;
    }
  }

  resetPromptTimeout() {
    for (const [id, req] of this.pendingRequests) {
      if (req.method === 'session/prompt') {
        clearTimeout(req.timeoutId);
        req.timeoutId = setTimeout(() => {
          this.pendingRequests.delete(id);
          req.reject(new Error('session/prompt timeout'));
        }, 300000);
      }
    }
  }

  sendRequest(method, params, timeoutMs = 60000) {
    return new Promise((resolve, reject) => {
      if (!this.child) { reject(new Error('ACP not connected')); return; }
      const id = this.nextRequestId++;
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`${method} timeout (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pendingRequests.set(id, { resolve, reject, timeoutId, method });
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params && { params }) }) + '\n');
    });
  }

  sendResponse(id, result) {
    if (!this.child) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  sendError(id, code, message) {
    if (!this.child) return;
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
  }

  async initialize() {
    return this.sendRequest('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    });
  }

  async newSession(cwd) {
    const result = await this.sendRequest('session/new', { cwd, mcpServers: [] }, 120000);
    this.sessionId = result.sessionId;
    return result;
  }

  async setSessionMode(modeId) {
    return this.sendRequest('session/set_mode', { sessionId: this.sessionId, modeId });
  }

  async injectSkills(skills) {
    const skillDescriptions = {
      'html_rendering': {
        name: 'HTML Rendering',
        description: 'Render styled HTML blocks directly in the chat interface',
        capability: 'Send a sessionUpdate with this exact format:\n{\n  "sessionUpdate": "html_content",\n  "content": {\n    "html": "<div style=\\"padding:1rem; border:1px solid #ccc; border-radius:0.5rem; background:#f9f9f9\\">Your HTML content here</div>",\n    "title": "Optional title for the block",\n    "id": "optional-unique-id"\n  }\n}\nThe HTML will render as a styled square/box block in the conversation.'
      },
      'image_display': {
        name: 'Image Display',
        description: 'Display images from the filesystem in styled blocks',
        capability: 'Send a sessionUpdate with this exact format:\n{\n  "sessionUpdate": "image_content",\n  "content": {\n    "path": "/path/to/image.png",\n    "title": "Optional image title",\n    "alt": "Alt text for accessibility"\n  }\n}\nSupported formats: PNG, JPEG, GIF, WebP, SVG. The image will render in a styled block.'
      },
      'scrot': {
        name: 'Screenshot Utility',
        description: 'Capture screenshots of the desktop or specific windows',
        capability: 'Use scrot command-line tool to capture and save images to filesystem, then display using image_display skill'
      },
      'fs_access': {
        name: 'Filesystem Access',
        description: 'Read and write files, browse directories',
        capability: 'Full read/write access to user home directory and workspace'
      }
    };

    const skillsToInject = skills
      .map(s => skillDescriptions[s])
      .filter(Boolean);

    if (skillsToInject.length === 0) return;

    const prompt = [
      {
        type: 'text',
        text: `You have the following skills available:\n\n${skillsToInject.map(s => `• ${s.name}: ${s.description}\n  Format: ${s.capability}`).join('\n\n')}\n\nUse these skills to render formatted content directly in your responses. When you want to display HTML or images, send the exact sessionUpdate format shown above.`
      }
    ];

    return this.sendRequest('session/skill_inject', {
      sessionId: this.sessionId,
      skills: skillsToInject,
      notification: prompt
    }).catch(() => null);
  }

  async sendPrompt(prompt) {
    const promptContent = Array.isArray(prompt) ? prompt : [{ type: 'text', text: prompt }];
    return this.sendRequest('session/prompt', { sessionId: this.sessionId, prompt: promptContent }, 300000);
  }

  isRunning() {
    return this.child && !this.child.killed;
  }

  async terminate() {
    if (!this.child) return;
    this.child.stdin.end();
    this.child.kill('SIGTERM');
    await new Promise(r => { this.child?.on('exit', r); setTimeout(r, 5000); });
    this.child = null;
  }
}
