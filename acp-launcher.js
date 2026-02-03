import { query } from '@anthropic-ai/claude-code';
import { default as SYSTEM_PROMPT } from './system-prompt.js';

export default class ACPConnection {
  constructor() {
    this.sessionId = null;
    this.onUpdate = null;
  }

  async connect(agentType, cwd) {
    console.log(`[ACP] Using Claude Code SDK (${agentType})`);
  }

  async initialize() {
    return { ready: true };
  }

  async newSession(cwd) {
    this.sessionId = Math.random().toString(36).substring(7);
    return { sessionId: this.sessionId };
  }

  async setSessionMode(modeId) {
    return { modeId };
  }

  async injectSkills(additionalContext = '') {
    return { skills: [] };
  }

  async injectSystemContext() {
    return { context: SYSTEM_PROMPT };
  }

  async sendPrompt(prompt) {
    let fullResponse = '';

    try {
      const promptText = typeof prompt === 'string' ? prompt : prompt.map(p => p.text).join('\n');
      const systemMessage = `${SYSTEM_PROMPT}\n\nUser Request: ${promptText}`;

      const response = query({
        prompt: systemMessage,
        options: {}
      });

      // query() returns an async iterable
      // Iterate through all messages and collect the response
      for await (const message of response) {
        // Try multiple content paths: direct .content or .message.content
        let content = message.content || message.message?.content;

        if (content && Array.isArray(content)) {
          const textChunks = content.map(c => c.text || '').join('');
          fullResponse += textChunks;

          // Emit update for real-time display
          if (this.onUpdate && textChunks) {
            this.onUpdate({
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { text: textChunks }
              }
            });
          }
        }
      }

      // Fallback if nothing was collected
      if (!fullResponse) {
        fullResponse = 'No response from agent';
      }

      return { content: fullResponse };
    } catch (err) {
      console.error(`[ACP] Query error: ${err.message}`);
      throw err;
    }
  }

  isRunning() {
    return true;
  }

  async terminate() {
    return;
  }
}
