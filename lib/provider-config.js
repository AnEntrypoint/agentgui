import fs from 'fs';
import path from 'path';
import os from 'os';

export function buildSystemPrompt(agentId, model, subAgent) {
  if (!agentId || agentId === 'claude-code') return '';
  const parts = [];
  const displayAgentId = agentId.split('-·-')[0];
  parts.push(`Use ${displayAgentId} subagent for all tasks.`);
  if (model) parts.push(`Model: ${model}.`);
  if (subAgent) parts.push(`Subagent: ${subAgent}.`);
  return parts.join(' ');
}

const PROVIDER_CONFIGS = {
  'anthropic': {
    name: 'Anthropic', configPaths: [
      path.join(os.homedir(), '.claude.json'),
      path.join(os.homedir(), '.config', 'claude', 'settings.json'),
      path.join(os.homedir(), '.anthropic.json')
    ],
    configFormat: (apiKey, model) => ({ api_key: apiKey, default_model: model })
  },
  'openai': {
    name: 'OpenAI', configPaths: [
      path.join(os.homedir(), '.openai.json'),
      path.join(os.homedir(), '.config', 'openai', 'api-key')
    ],
    configFormat: (apiKey, model) => ({ apiKey, defaultModel: model })
  },
  'google': {
    name: 'Google Gemini', configPaths: [
      path.join(os.homedir(), '.gemini.json'),
      path.join(os.homedir(), '.config', 'gemini', 'credentials.json')
    ],
    configFormat: (apiKey, model) => ({ api_key: apiKey, default_model: model })
  },
  'openrouter': {
    name: 'OpenRouter', configPaths: [
      path.join(os.homedir(), '.openrouter.json'),
      path.join(os.homedir(), '.config', 'openrouter', 'config.json')
    ],
    configFormat: (apiKey, model) => ({ api_key: apiKey, default_model: model })
  },
  'github': {
    name: 'GitHub Models', configPaths: [
      path.join(os.homedir(), '.github.json'),
      path.join(os.homedir(), '.config', 'github-copilot.json')
    ],
    configFormat: (apiKey, model) => ({ github_token: apiKey, default_model: model })
  },
  'azure': {
    name: 'Azure OpenAI', configPaths: [
      path.join(os.homedir(), '.azure.json'),
      path.join(os.homedir(), '.config', 'azure-openai', 'config.json')
    ],
    configFormat: (apiKey, model) => ({ api_key: apiKey, endpoint: '', default_model: model })
  },
  'anthropic-claude-code': {
    name: 'Claude Code Max', configPaths: [
      path.join(os.homedir(), '.claude', 'max.json'),
      path.join(os.homedir(), '.config', 'claude-code', 'max.json')
    ],
    configFormat: (apiKey, model) => ({ api_key: apiKey, plan: 'max', default_model: model })
  },
  'opencode': {
    name: 'OpenCode', configPaths: [
      path.join(os.homedir(), '.opencode', 'config.json'),
      path.join(os.homedir(), '.config', 'opencode', 'config.json')
    ],
    configFormat: (apiKey, model) => ({ api_key: apiKey, default_model: model, providers: ['anthropic', 'openai', 'google'] })
  },
  'proxypilot': {
    name: 'ProxyPilot', configPaths: [
      path.join(os.homedir(), '.proxypilot', 'config.json'),
      path.join(os.homedir(), '.config', 'proxypilot', 'config.json')
    ],
    configFormat: (apiKey, model) => ({ api_key: apiKey, default_model: model })
  },
  'codex': {
    name: 'Codex CLI', configPaths: [
      path.join(os.homedir(), '.codex', 'auth.json')
    ],
    configFormat: (apiKey) => ({ auth_mode: 'apikey', OPENAI_API_KEY: apiKey })
  }
};

export function maskKey(key) {
  if (!key || key.length < 8) return '****';
  return '****' + key.slice(-4);
}

export function getProviderConfigs() {
  const configs = {};
  for (const [providerId, config] of Object.entries(PROVIDER_CONFIGS)) {
    for (const configPath of config.configPaths) {
      try {
        if (fs.existsSync(configPath)) {
          const content = fs.readFileSync(configPath, 'utf8');
          const parsed = JSON.parse(content);
          const rawKey = parsed.api_key || parsed.apiKey || parsed.github_token || parsed.OPENAI_API_KEY || '';
          configs[providerId] = {
            name: config.name,
            apiKey: maskKey(rawKey),
            hasKey: !!rawKey,
            defaultModel: parsed.default_model || parsed.defaultModel || '',
            path: configPath
          };
          break;
        }
      } catch (_) {}
    }
    if (!configs[providerId]) {
      configs[providerId] = { name: config.name, apiKey: '', hasKey: false, defaultModel: '', path: '' };
    }
  }
  return configs;
}

export function saveProviderConfig(providerId, apiKey, defaultModel) {
  const config = PROVIDER_CONFIGS[providerId];
  if (!config) throw new Error('Unknown provider: ' + providerId);
  const configPath = config.configPaths[0];
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });
  let existing = {};
  try {
    if (fs.existsSync(configPath)) existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (_) {}
  const merged = { ...existing, ...config.configFormat(apiKey, defaultModel) };
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), { mode: 0o600 });
  return configPath;
}
