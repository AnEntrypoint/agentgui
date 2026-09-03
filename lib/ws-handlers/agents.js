import { registry } from '../claude-runner-agents.js';
import { restart as restartAcpAgent } from '../acp-sdk-manager.js';
import { err } from './shared.js';
import { spawnSync } from 'child_process';

const SUB_AGENT_MAP = {
  'opencode': [{ id: 'gm-oc', name: 'GM OpenCode' }], 'cli-opencode': [{ id: 'gm-oc', name: 'GM OpenCode' }],
  'gemini': [{ id: 'gm-gc', name: 'GM Gemini' }], 'cli-gemini': [{ id: 'gm-gc', name: 'GM Gemini' }],
  'kilo': [{ id: 'gm-kilo', name: 'GM Kilo' }], 'cli-kilo': [{ id: 'gm-kilo', name: 'GM Kilo' }],
  'codex': [], 'cli-codex': []
};

export function register(router, deps) {
  const { getProviderConfigs, getModelsForAgent } = deps;

  // --- agents.list: enumerate registered ACP agents + claude-code ---
  router.handle('agents.list', () => {
    const agents = registry.list().map(a => ({
      id: a.id,
      name: a.name,
      protocol: a.protocol,
      supportsStdin: !!a.supportsStdin,
      features: a.supportedFeatures || [],
      available: registry.isAvailable(a.id),
      npxInstallable: !!a.npxPackage,
      // The CLI binary name a manual (non-npx) install would need - lets the
      // settings panel say what to install instead of just "not installed".
      cmd: a.command || null,
    }));
    return { agents };
  });

  // --- agents.models: model choices for a given agent ---
  router.handle('agents.models', async (p) => {
    const id = p?.id || p?.agentId;
    if (!id) err(400, 'agent id required');
    if (id === 'claude-code') {
      return { models: [
        { id: 'sonnet', name: 'Claude Sonnet (latest)' },
        { id: 'opus', name: 'Claude Opus (latest)' },
        { id: 'haiku', name: 'Claude Haiku (latest)' },
      ] };
    }
    // Other agents: discover their models via getModelsForAgent (queries the
    // running ACP server). Fail closed to an empty list on any error or when
    // the dep isn't a function.
    if (typeof getModelsForAgent === 'function') {
      try {
        const raw = await getModelsForAgent(id);
        const list = Array.isArray(raw) ? raw : (raw?.models || []);
        return { models: list.map(m => ({ id: m.id, name: m.name || m.label || m.id })) };
      } catch { return { models: [] }; }
    }
    return { models: [] };
  });

  router.handle('acp.restart', async (p) => {
    if (!p.id) err(400, 'Missing agent id');
    const ok = await restartAcpAgent(p.id);
    return { ok: !!ok };
  });

  router.handle('agent.subagents', async (p) => {
    if (!p.id) err(400, 'Missing agent id');
    if (p.id === 'claude-code' || p.id === 'cli-claude') {
      const spawnEnv = { ...process.env }; delete spawnEnv.CLAUDECODE;
      const result = spawnSync('claude', ['agents', 'list'], { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'], env: spawnEnv });
      if (result.status !== 0 || !result.stdout) return { subAgents: [] };
      const agents = result.stdout.trim().split('\n').filter(l => l.trim()).map(l => l.match(/^  (\S+)\s+·/)).filter(Boolean).map(m => ({ id: m[1], name: m[1] }));
      return { subAgents: agents };
    }
    return { subAgents: SUB_AGENT_MAP[p.id] || [] };
  });

  // --- models.availability: composes agentgui's REAL model surface into the
  // ModelsConfig component's shape (design SDK's ModelsConfig.js). agentgui
  // has no freddie-style probed-availability matrix (no /v1/models round-trip
  // per mode) - what it actually has is: discovered agent CLIs (registry,
  // same data agents.list already exposes), each agent's model choices
  // (agents.models' getModelsForAgent), and per-provider API-key presence
  // (auth.configs' getProviderConfigs). This handler is a read-only
  // composition of those three real sources, not a new probe and not fake
  // data - "usable_in_any_mode" is derived from registry.isAvailable(agentId)
  // (the CLI binary was actually found on this server), and "key_present"
  // comes straight from getProviderConfigs' filesystem check.
  router.handle('models.availability', async () => {
    const agents = registry.list();
    const providerConfigs = typeof getProviderConfigs === 'function' ? getProviderConfigs() : {};
    const providers = [];
    for (const a of agents) {
      const available = registry.isAvailable(a.id);
      let models = [];
      if (a.id === 'claude-code') {
        models = [
          { id: 'sonnet', name: 'Claude Sonnet (latest)' },
          { id: 'opus', name: 'Claude Opus (latest)' },
          { id: 'haiku', name: 'Claude Haiku (latest)' },
        ];
      } else if (typeof getModelsForAgent === 'function') {
        try {
          const raw = await getModelsForAgent(a.id);
          const list = Array.isArray(raw) ? raw : (raw?.models || []);
          models = list.map((m) => ({ id: m.id, name: m.name || m.label || m.id }));
        } catch { models = []; }
      }
      // Map onto agentgui's one real signal per model: is the agent CLI itself
      // available on this server (registry.isAvailable). agentgui does not
      // probe individual (model, mode) cells the way freddie's matrix does,
      // so every model under an available agent reports the same single
      // 'cli' mode rather than fabricating per-mode probe results.
      providers.push({
        id: a.id,
        key_present: !!(providerConfigs[a.id] && providerConfigs[a.id].hasKey) || available,
        discovery_error: available ? null : ((a.name || a.id) + ' CLI not found on this server'),
        models: models.map((m) => ({
          id: m.id,
          name: m.name,
          discovered_via: a.protocol || 'cli',
          modes: { cli: { ok: !!available, skipped: !available, reason: available ? undefined : 'agent_not_installed' } },
          usable_in_any_mode: !!available,
        })),
      });
    }
    const totalModels = providers.reduce((n, p) => n + p.models.length, 0);
    const usableModels = providers.reduce((n, p) => n + p.models.filter((m) => m.usable_in_any_mode).length, 0);
    return {
      timestamp: new Date().toISOString(),
      providers,
      sampler: [],
      summary: {
        total_providers: providers.length,
        total_models: totalModels,
        usable_in_any_mode: usableModels,
      },
    };
  });
}
