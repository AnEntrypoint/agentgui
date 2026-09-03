import { registry } from './claude-runner-agents.js';

const communicationGuidelines = `
COMMUNICATION STYLE: Minimize output. Only inform the user about:
- Critical errors that block work
- User needs to know info (e.g., "port in use", "authentication failed", "file not found")
- Action required from user
- Important decisions that affect their work

DO NOT output:
- Progress updates ("doing X now", "completed Y", "searching for...")
- Verbose summaries of what was done
- Status checks or verification messages
- Detailed explanations unless asked
- "Working on...", "Looking for...", step-by-step progress

INSTEAD:
- Run tools silently
- Show results only when relevant
- Be conversational and direct
- Let code/output speak for itself
`;

export async function runClaudeWithStreaming(prompt, cwd, agentId = 'claude-code', config = {}) {
  const agent = registry.get(agentId);
  if (!agent) throw new Error(`Unknown agent: ${agentId}. Registered agents: ${registry.list().map(a => a.id).join(', ')}`);

  const enhancedConfig = { ...config };
  if (!enhancedConfig.systemPrompt) enhancedConfig.systemPrompt = '';

  if (!enhancedConfig.systemPrompt.includes('COMMUNICATION STYLE')) {
    enhancedConfig.systemPrompt = communicationGuidelines + enhancedConfig.systemPrompt;
  }

  if (agentId && agentId !== 'claude-code') {
    const displayAgentId = agentId.split('-·-')[0];
    const agentPrefix = `use ${displayAgentId} subagent to. `;
    if (!enhancedConfig.systemPrompt.includes(agentPrefix)) {
      enhancedConfig.systemPrompt = agentPrefix + enhancedConfig.systemPrompt;
    }
  }

  return agent.run(prompt, cwd, enhancedConfig);
}

export default runClaudeWithStreaming;
