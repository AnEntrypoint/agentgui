const agentDescriptorCache = new Map();

const AGENT_DESCRIPTIONS = {
  'claude-code': 'Claude Code is an AI coding agent that can read, write, and execute code with streaming output support. It provides comprehensive code editing, file management, and terminal execution capabilities.',
  'agy': 'Antigravity (agy) is a Gemini-backed coding agent CLI. It runs prompts non-interactively with plain-text streaming output, workspace directory scoping, and conversation resume.',
  'gemini': 'Gemini CLI is Google AI coding agent with streaming support, code execution, and file management capabilities.',
  'opencode': 'OpenCode is a multi-provider AI coding agent with streaming support and comprehensive code manipulation capabilities.',
};

const BASE_SPECS = {
  capabilities: { threads: true, interrupts: false, callbacks: false, streaming: { values: false, custom: true } },
  input: { type: 'object', properties: { content: { type: 'string', description: 'The user prompt or instruction to send to the agent' } }, required: ['content'] },
  output: { type: 'object', properties: { result: { type: 'string' } } },
  custom_streaming_update: { type: 'object', properties: { type: { type: 'string' }, data: { type: 'object' } } },
  thread_state: { type: 'object', properties: { messages: { type: 'array', items: { type: 'object' } } } },
  config: { type: 'object', properties: { workingDirectory: { type: 'string' } } },
};

function buildDescriptor(agent) {
  const description = AGENT_DESCRIPTIONS[agent.id] || `${agent.name} is an AI coding agent with basic streaming and execution capabilities.`;
  const specs = JSON.parse(JSON.stringify(BASE_SPECS));
  if (agent.id === 'claude-code' || agent.id === 'gemini' || agent.id === 'opencode') {
    specs.input.properties.model = { type: 'string', description: 'Optional model identifier to use for this run' };
    specs.output.properties.events = { type: 'array', description: 'Stream of execution events', items: { type: 'object' } };
    specs.config.properties.model = { type: 'string' };
  }
  if (agent.id === 'claude-code') {
    specs.thread_state.description = 'Conversation history with messages and session state';
    specs.thread_state.properties.sessionId = { type: 'string' };
    specs.config.properties.model.description = 'Default model to use';
    specs.config.properties.workingDirectory.description = 'Working directory for file operations';
  }
  return { metadata: { ref: { name: agent.name, version: '1.0.0', url: agent.path }, description }, specs };
}

export function initializeDescriptors(agents) {
  agentDescriptorCache.clear();
  for (const agent of agents) agentDescriptorCache.set(agent.id, buildDescriptor(agent));
  return agentDescriptorCache.size;
}

export function getAgentDescriptor(agentId) {
  return agentDescriptorCache.get(agentId) || null;
}

