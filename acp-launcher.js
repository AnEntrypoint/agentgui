import { createClient } from 'claude-code-acp';

const RIPPLEUI_SYSTEM_PROMPT = `CRITICAL INSTRUCTION: You are responding in a web-based HTML interface. EVERY response must be formatted as beautiful, styled HTML using RippleUI and Tailwind CSS. This is NOT a text-based interface - users see raw HTML rendered in their browser.

YOUR RESPONSE FORMAT MUST BE:
Wrap your ENTIRE response in a single HTML container with these elements:

\`\`\`html
<div class="space-y-4 p-6 max-w-4xl">
  <!-- Main content goes here -->
</div>
\`\`\`

STRUCTURE YOUR RESPONSES LIKE THIS:

For questions/answers:
\`\`\`html
<div class="space-y-4 p-6">
  <h2 class="text-2xl font-bold text-gray-900">Your Answer</h2>
  <div class="card bg-blue-50 border-l-4 border-blue-500 p-4">
    <p class="text-gray-700">Your detailed answer here</p>
  </div>
</div>
\`\`\`

For code:
\`\`\`html
<div class="space-y-4 p-6">
  <h3 class="text-xl font-bold">Code Example</h3>
  <pre class="bg-gray-900 text-white p-4 rounded-lg overflow-x-auto"><code>// Your code here
function example() { }</code></pre>
</div>
\`\`\`

For lists:
\`\`\`html
<div class="space-y-4 p-6">
  <h3 class="text-xl font-bold">Items</h3>
  <ul class="list-none space-y-2">
    <li class="p-3 bg-gray-100 rounded border-l-4 border-gray-400">• Item one</li>
    <li class="p-3 bg-gray-100 rounded border-l-4 border-gray-400">• Item two</li>
  </ul>
</div>
\`\`\`

COMPONENT LIBRARY:
- Card: <div class="card bg-white shadow-lg p-6 rounded-lg"><h4 class="font-bold">Title</h4><p>Content</p></div>
- Alert: <div class="alert bg-red-100 border-l-4 border-red-500 p-4"><span class="text-red-800">Warning message</span></div>
- Success: <div class="alert bg-green-100 border-l-4 border-green-500 p-4"><span class="text-green-800">Success</span></div>
- Table: <table class="w-full border-collapse border border-gray-300"><thead class="bg-gray-100"><tr><th class="p-2 text-left">Col</th></tr></thead><tbody><tr><td class="p-2 border border-gray-300">Data</td></tr></tbody></table>
- Badge: <span class="inline-block bg-blue-500 text-white px-3 py-1 rounded-full text-sm">Label</span>
- Code inline: <code class="bg-gray-200 px-2 py-1 rounded text-red-600 font-mono">code</code>

MANDATORY RULES:
✓ EVERY response MUST be wrapped in a div with class "space-y-4 p-6"
✓ Use semantic HTML: <h1>-<h6>, <p>, <ul>, <ol>, <table>, <pre>
✓ Always add Tailwind classes for styling: colors, padding, margins, rounded corners
✓ Code blocks MUST use <pre><code> with language class like \`class="language-javascript"\`
✓ NEVER send plain text without HTML wrapping
✓ NEVER respond outside of HTML container
✓ Use color classes: text-gray-700, bg-blue-50, border-blue-500
✓ Make visual hierarchy clear: use different font sizes, colors, cards

YOU MUST ALWAYS OUTPUT VALID, COMPLETE HTML.
The user's interface shows YOUR HTML directly - make it beautiful, well-organized, and professional.`;

export default class ACPConnection {
  constructor() {
    this.client = null;
    this.sessionId = null;
    this.onUpdate = null;
  }

  /**
   * Connect to ACP bridge and create session
   */
  async connect(agentType, cwd) {
    try {
      console.log(`[ACP] Connecting to ${agentType}...`);

      // Create client directly from npm module
      this.client = await createClient({
        agent: agentType === 'opencode' ? 'opencode' : 'claude-code',
        cwd
      });

      console.log(`[ACP] ✅ Connected to ${agentType} (direct module)`);
    } catch (err) {
      console.error(`[ACP] ❌ FATAL: Connection failed: ${err.message}`);
      throw new Error(`ACP connection failed for ${agentType}: ${err.message}`);
    }
  }

  /**
   * Initialize ACP session
   */
  async initialize() {
    if (!this.client) throw new Error('ACP not connected');
    return this.client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }
    });
  }

  /**
   * Create new session
   */
  async newSession(cwd) {
    if (!this.client) throw new Error('ACP not connected');
    const result = await this.client.request('session/new', { cwd, mcpServers: [] });
    this.sessionId = result.sessionId;
    return result;
  }

  /**
   * Set session mode
   */
  async setSessionMode(modeId) {
    if (!this.client) throw new Error('ACP not connected');
    return this.client.request('session/set_mode', { sessionId: this.sessionId, modeId });
  }

  /**
   * Inject skills and system prompt
   */
  async injectSkills(additionalContext = '') {
    if (!this.client) throw new Error('ACP not connected');

    const systemPrompt = additionalContext
      ? `${RIPPLEUI_SYSTEM_PROMPT}\n\n---\n\n${additionalContext}`
      : RIPPLEUI_SYSTEM_PROMPT;

    return this.client.request('session/skill_inject', {
      sessionId: this.sessionId,
      skills: [],
      notification: [{ type: 'text', text: systemPrompt }]
    });
  }

  /**
   * Inject system context
   */
  async injectSystemContext() {
    if (!this.client) throw new Error('ACP not connected');

    return this.client.request('session/context', {
      sessionId: this.sessionId,
      context: RIPPLEUI_SYSTEM_PROMPT,
      role: 'system'
    });
  }

  /**
   * Send prompt and stream updates
   */
  async sendPrompt(prompt) {
    if (!this.client) throw new Error('ACP not connected');

    const promptContent = Array.isArray(prompt) ? prompt : [{ type: 'text', text: prompt }];

    // Setup update handler before sending
    if (this.onUpdate) {
      this.client.on('update', (update) => {
        // Forward updates immediately with no delay
        this.onUpdate({ update });
      });
    }

    // Send prompt and get result
    return this.client.request('session/prompt', {
      sessionId: this.sessionId,
      prompt: promptContent
    }, 300000);
  }

  /**
   * Check if connection is running
   */
  isRunning() {
    return this.client !== null;
  }

  /**
   * Terminate connection
   */
  async terminate() {
    if (!this.client) return;

    try {
      await this.client.close();
    } catch (err) {
      console.error(`[ACP] Error during terminate: ${err.message}`);
    } finally {
      this.client = null;
      this.sessionId = null;
    }
  }
}
