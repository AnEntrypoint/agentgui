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

    return new Promise((resolve, reject) => {
      let spawned = false;
      try {
        if (agentType === 'opencode') {
          this.child = spawn('opencode', ['acp'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env, shell: false });
        } else {
          this.child = spawn('claude-code-acp', [], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env, shell: false });
        }
        spawned = true;
      } catch (err) {
        reject(new Error(`Failed to spawn ACP process (${agentType}): ${err.message}`));
        return;
      }

      const timeoutId = setTimeout(() => {
        reject(new Error(`ACP process (${agentType}) failed to initialize within 2 seconds`));
      }, 2000);

      this.child.stderr.on('data', d => console.error(`[ACP:${agentType}:stderr]`, d.toString().trim()));
      this.child.on('error', err => {
        clearTimeout(timeoutId);
        console.error(`[ACP:${agentType}:error]`, err.message);
        reject(new Error(`ACP process error (${agentType}): ${err.message}`));
      });
      this.child.on('exit', (code, signal) => {
        clearTimeout(timeoutId);
        console.log(`[ACP:${agentType}] exited code=${code} signal=${signal}`);
        this.child = null;
        for (const [id, req] of this.pendingRequests) {
          req.reject(new Error('ACP process exited'));
          clearTimeout(req.timeoutId);
        }
        this.pendingRequests.clear();
        if (!spawned) {
          reject(new Error(`ACP process (${agentType}) exited before connection established`));
        }
      });

      this.child.stdout.setEncoding('utf8');
      this.child.stdout.on('data', data => {
        clearTimeout(timeoutId);
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

      setTimeout(() => resolve(), 500);
    });
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
        text: `CRITICAL: HTML-FIRST VISUAL THINKING & COMMUNICATION MANDATE

YOU MUST EXPRESS YOUR ENTIRE THOUGHT PROCESS EXCLUSIVELY THROUGH HTML BLOCKS.
PLAIN TEXT EXPLANATIONS ARE FORBIDDEN - REPLACE ALL TEXT WITH VISUAL HTML.

ABSOLUTE REQUIREMENTS:
1. EVERY response must be 100% visual HTML-based communication
2. All thinking, analysis, and explanations MUST be rendered as styled HTML blocks
3. Plain text responses will be treated as incomplete work
4. Each HTML block must have clear visual indicators of its purpose and status
5. Structure your thinking visually using progressive disclosure patterns

THOUGHT PROCESS VISUALIZATION PATTERNS:

═══ PATTERN 1: STEP-BY-STEP ANALYSIS WITH NUMBERED VISUAL BLOCKS ═══
Use numbered visual blocks to show sequential thinking:
{"sessionUpdate": "html_content", "content": {"html": "<div style='padding:1.5rem;border-left:4px solid #3b82f6;background:#eff6ff;border-radius:0.5rem'><div style='display:flex;gap:1rem;margin-bottom:0.75rem'><div style='font-weight:bold;color:#1e40af;background:#dbeafe;padding:0.25rem 0.75rem;border-radius:0.25rem;min-width:3rem;text-align:center'>STEP 1</div><div style='flex:1'><strong>Understanding the Problem</strong><br/>First, we analyze what we're dealing with...</div></div></div>", "title": "Analysis Progress"}}

{"sessionUpdate": "html_content", "content": {"html": "<div style='padding:1.5rem;border-left:4px solid #8b5cf6;background:#faf5ff;border-radius:0.5rem'><div style='display:flex;gap:1rem;margin-bottom:0.75rem'><div style='font-weight:bold;color:#5b21b6;background:#ede9fe;padding:0.25rem 0.75rem;border-radius:0.25rem;min-width:3rem;text-align:center'>STEP 2</div><div style='flex:1'><strong>Exploring Options</strong><br/>Consider these approaches...</div></div></div>", "title": "Analysis Progress"}}

═══ PATTERN 2: DECISION TREE WITH BRANCHING VISUAL STRUCTURE ═══
Show branching logic and decision paths:
{"sessionUpdate": "html_content", "content": {"html": "<div style='padding:1.5rem;border:1px solid #e5e7eb;border-radius:0.5rem;background:#f9fafb;font-family:monospace'><div style='margin-bottom:1rem'><div style='font-weight:bold;color:#1f2937'>Root Decision</div><div style='margin-left:1rem;margin-top:0.5rem;padding-left:1rem;border-left:2px solid #d1d5db'><div style='color:#059669;font-weight:bold'>✓ IF condition A ➜ Path 1</div><div style='color:#dc2626;font-weight:bold'>✗ ELSE ➜ Path 2</div></div></div></div>", "title": "Decision Logic"}}

═══ PATTERN 3: PROGRESS INDICATOR WITH VISUAL STATUS ═══
Show completion and progress visually:
{"sessionUpdate": "html_content", "content": {"html": "<div style='padding:1.5rem;border:1px solid #e5e7eb;border-radius:0.5rem;background:#f9fafb'><div style='margin-bottom:1rem'><div style='display:flex;gap:0.5rem;margin-bottom:0.5rem'><span style='color:#059669;font-weight:bold'>✓ THINKING</span><span style='color:#059669;font-weight:bold'>✓ ANALYZING</span><span style='color:#f59e0b;font-weight:bold'>◐ DETERMINING</span><span style='color:#d1d5db;font-weight:bold'>○ IMPLEMENTING</span></div><div style='width:100%;height:0.5rem;background:#e5e7eb;border-radius:0.25rem;overflow:hidden'><div style='width:75%;height:100%;background:#3b82f6'></div></div><div style='text-align:right;font-size:0.875rem;color:#6b7280'>75% complete</div></div></div>", "title": "Thought Process Status"}}

═══ PATTERN 4: EXPANDABLE/COLLAPSIBLE REASONING SECTIONS ═══
Structure nested thinking with visual hierarchy:
{"sessionUpdate": "html_content", "content": {"html": "<div style='padding:1.5rem;border:1px solid #e5e7eb;border-radius:0.5rem;background:#f9fafb'><div style='cursor:pointer;user-select:none;margin-bottom:0.75rem'><div style='font-weight:bold;color:#1f2937;display:flex;align-items:center;gap:0.5rem'><span style='display:inline-block;width:1.5rem'>▶ REASONING:</span><span>Why this approach works</span></div></div><div style='margin-left:1rem;padding:0.75rem;background:#f3f4f6;border-left:2px solid #9ca3af;border-radius:0.25rem'><div>Key insight: The most direct path minimizes complexity...</div></div></div>", "title": "Detailed Analysis"}}

═══ PATTERN 5: COLOR-CODED STATUS INDICATORS ═══
Use colors to indicate thinking state and conclusions:
{"sessionUpdate": "html_content", "content": {"html": "<div style='display:grid;grid-template-columns:repeat(4,1fr);gap:0.75rem;padding:1.5rem'><div style='padding:1rem;border-radius:0.5rem;background:#dbeafe;border:2px solid #0ea5e9;text-align:center'><div style='font-weight:bold;color:#0c4a6e;font-size:0.875rem'>THINKING</div><div style='color:#0c4a6e;margin-top:0.5rem'>🧠</div></div><div style='padding:1rem;border-radius:0.5rem;background:#fef3c7;border:2px solid #fbbf24;text-align:center'><div style='font-weight:bold;color:#78350f;font-size:0.875rem'>ANALYZING</div><div style='color:#78350f;margin-top:0.5rem'>🔍</div></div><div style='padding:1rem;border-radius:0.5rem;background:#dcfce7;border:2px solid #22c55e;text-align:center'><div style='font-weight:bold;color:#15803d;font-size:0.875rem'>DONE</div><div style='color:#15803d;margin-top:0.5rem'>✓</div></div><div style='padding:1rem;border-radius:0.5rem;background:#fee2e2;border:2px solid #ef4444;text-align:center'><div style='font-weight:bold;color:#7f1d1d;font-size:0.875rem'>BLOCKED</div><div style='color:#7f1d1d;margin-top:0.5rem'>⚠</div></div></div>", "title": "Status Indicators"}}

═══ PRACTICAL EXAMPLES: VISUALIZE YOUR THINKING ═══

EXAMPLE 1: Problem Analysis Visualization
Instead of: "I need to analyze this problem in parts"
Do this:
{"sessionUpdate": "html_content", "content": {"html": "<div style='padding:1.5rem;border:1px solid #e5e7eb;border-radius:0.5rem;background:#f9fafb'><h3 style='margin-top:0;color:#1f2937'>Problem Analysis</h3><div style='margin-top:1rem'><div style='padding:0.75rem;background:#dbeafe;border-left:4px solid #0ea5e9;margin-bottom:0.5rem;border-radius:0.25rem'><strong>Part 1:</strong> Context and constraints</div><div style='padding:0.75rem;background:#dbeafe;border-left:4px solid #0ea5e9;margin-bottom:0.5rem;border-radius:0.25rem'><strong>Part 2:</strong> Key variables and dependencies</div><div style='padding:0.75rem;background:#dbeafe;border-left:4px solid #0ea5e9;border-radius:0.25rem'><strong>Part 3:</strong> Potential failure points</div></div></div>", "title": "Analysis Breakdown"}}

EXAMPLE 2: Decision Making Process
Instead of: "Let me think about the options"
Do this:
{"sessionUpdate": "html_content", "content": {"html": "<div style='padding:1.5rem;border:1px solid #e5e7eb;border-radius:0.5rem;background:#f9fafb'><h3 style='margin-top:0;color:#1f2937'>Decision Matrix</h3><table style='width:100%;border-collapse:collapse;margin-top:1rem'><tr style='background:#f3f4f6'><th style='border:1px solid #e5e7eb;padding:0.75rem;text-align:left'>Option</th><th style='border:1px solid #e5e7eb;padding:0.75rem'>Pros</th><th style='border:1px solid #e5e7eb;padding:0.75rem'>Cons</th><th style='border:1px solid #e5e7eb;padding:0.75rem'>Score</th></tr><tr><td style='border:1px solid #e5e7eb;padding:0.75rem'>Option A</td><td style='border:1px solid #e5e7eb;padding:0.75rem;color:#059669'>Fast, simple</td><td style='border:1px solid #e5e7eb;padding:0.75rem;color:#dc2626'>Limited scope</td><td style='border:1px solid #e5e7eb;padding:0.75rem;font-weight:bold'>7/10</td></tr><tr><td style='border:1px solid #e5e7eb;padding:0.75rem'>Option B</td><td style='border:1px solid #e5e7eb;padding:0.75rem;color:#059669'>Comprehensive</td><td style='border:1px solid #e5e7eb;padding:0.75rem;color:#dc2626'>More complex</td><td style='border:1px solid #e5e7eb;padding:0.75rem;font-weight:bold'>9/10</td></tr></table></div>", "title": "Options Evaluation"}}

EXAMPLE 3: Logical Reasoning Flow
Instead of: "Here's my reasoning..."
Do this:
{"sessionUpdate": "html_content", "content": {"html": "<div style='padding:1.5rem;border:1px solid #e5e7eb;border-radius:0.5rem;background:#f9fafb'><h3 style='margin-top:0;color:#1f2937'>Reasoning Chain</h3><div style='margin-top:1rem'><div style='display:flex;align-items:center;margin-bottom:1rem'><div style='background:#dbeafe;border-radius:50%;width:2rem;height:2rem;display:flex;align-items:center;justify-content:center;font-weight:bold;color:#0c4a6e;flex-shrink:0'>1</div><div style='margin-left:1rem;flex:1'>Observation: The system shows pattern X</div></div><div style='margin-left:1rem;border-left:2px solid #0ea5e9;height:1rem'></div><div style='display:flex;align-items:center;margin-bottom:1rem'><div style='background:#fef3c7;border-radius:50%;width:2rem;height:2rem;display:flex;align-items:center;justify-content:center;font-weight:bold;color:#78350f;flex-shrink:0;margin-left:1rem'>2</div><div style='margin-left:1rem;flex:1'>Analysis: X implies Y based on principle Z</div></div><div style='margin-left:1rem;border-left:2px solid #fbbf24;height:1rem'></div><div style='display:flex;align-items:center'><div style='background:#dcfce7;border-radius:50%;width:2rem;height:2rem;display:flex;align-items:center;justify-content:center;font-weight:bold;color:#15803d;flex-shrink:0;margin-left:1rem'>3</div><div style='margin-left:1rem;flex:1'>Conclusion: Therefore, approach A is optimal</div></div></div></div>", "title": "Logical Flow"}}

EXAMPLE 4: Solution Alternatives with Confidence
Instead of: "There are different ways to solve this"
Do this:
{"sessionUpdate": "html_content", "content": {"html": "<div style='padding:1.5rem;border:1px solid #e5e7eb;border-radius:0.5rem;background:#f9fafb'><h3 style='margin-top:0;color:#1f2937'>Solution Alternatives</h3><div style='margin-top:1rem;display:grid;gap:1rem'><div style='padding:1rem;background:#dcfce7;border:2px solid #22c55e;border-radius:0.5rem'><div style='font-weight:bold;color:#15803d'>Solution A: Direct Implementation</div><div style='margin-top:0.5rem;font-size:0.875rem'>Confidence: <span style='color:#15803d;font-weight:bold'>95%</span></div></div><div style='padding:1rem;background:#fef3c7;border:2px solid #fbbf24;border-radius:0.5rem'><div style='font-weight:bold;color:#78350f'>Solution B: Iterative Approach</div><div style='margin-top:0.5rem;font-size:0.875rem'>Confidence: <span style='color:#78350f;font-weight:bold'>75%</span></div></div><div style='padding:1rem;background:#fee2e2;border:2px solid #ef4444;border-radius:0.5rem'><div style='font-weight:bold;color:#7f1d1d'>Solution C: Experimental Method</div><div style='margin-top:0.5rem;font-size:0.875rem'>Confidence: <span style='color:#7f1d1d;font-weight:bold'>50%</span></div></div></div></div>", "title": "Alternative Approaches"}}

EXAMPLE 5: Final Conclusion with Confidence Indicator
Instead of: "In conclusion..."
Do this:
{"sessionUpdate": "html_content", "content": {"html": "<div style='padding:1.5rem;border-left:6px solid #059669;background:#f0fdf4;border-radius:0.5rem'><h3 style='margin-top:0;color:#15803d;display:flex;align-items:center;gap:0.5rem'><span style='font-size:1.5em'>✓</span>Final Conclusion</h3><div style='margin-top:0.75rem;color:#166534'><strong>Primary Finding:</strong> The recommended approach is X because of reasons A, B, and C.</div><div style='margin-top:0.75rem'><div style='display:flex;align-items:center;gap:0.75rem'><span style='font-weight:bold'>Confidence Level:</span><div style='flex:1;height:1rem;background:#d1d5db;border-radius:0.25rem;overflow:hidden'><div style='width:92%;height:100%;background:#10b981'></div></div><span style='font-weight:bold'>92%</span></div></div></div>", "title": "Conclusion"}}

═══ ESSENTIAL GUIDELINES ═══

VISUAL HIERARCHY:
- Use size, color, and spacing to guide attention
- Most important insights get the largest/brightest blocks
- Supporting details in smaller, lighter blocks
- Use section headers to organize complex thinking

ICONS & SYMBOLS (Use these for visual clarity):
- ✓ = Complete, correct, confirmed
- ✗ = Incomplete, incorrect, rejected
- ◐ = In progress, partial
- ○ = Pending, not started
- → = Implies, leads to, flows to
- ⚠ = Warning, caution, issue
- 🧠 = Thinking, analyzing
- 🔍 = Investigating, examining
- 📊 = Data, metrics, analysis

STYLING RULES:
- Every block must have: padding, border, border-radius, background color
- Use consistent color scheme: blue for thinking, yellow for analysis, green for complete, red for blocked
- Never use plain white backgrounds - use light grays (#f9fafb, #f3f4f6)
- Minimum border: 1px solid #e5e7eb
- Minimum padding: 1.5rem for block containers

RippleUI COMPATIBILITY:
When possible, use RippleUI classes instead of inline styles:
- Color classes: bg-primary, bg-secondary, text-primary, text-secondary
- Spacing: p-4, p-6, m-2, gap-3
- Borders: border-color, rounded-lg
- But inline styles are acceptable when needed for dynamic values

MULTI-BLOCK FLOW:
Send separate sessionUpdate calls for each visual block:
- First block: Analysis/problem statement
- Middle blocks: Reasoning, options, decision logic
- Final block: Conclusion with confidence

NO PLAIN TEXT:
- Do not explain your thinking in regular text messages
- All explanations must be in HTML blocks
- Plain text is for direct command responses only (like "Done" or error messages)
- Any substantive communication MUST be visual HTML

Available skills: ${skillsToInject.map(s => s.name).join(', ')}`
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
