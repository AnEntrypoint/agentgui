import fs from 'fs';
import path from 'path';
import os from 'os';

export const errLogPath = path.join(os.homedir(), 'logs', 'agentgui-errors.log');

export function logError(op, err, ctx = {}) {
  try {
    const line = JSON.stringify({ ts: new Date().toISOString(), op, msg: err?.message, stack: err?.stack, ...ctx }) + '\n';
    fs.appendFile(errLogPath, line, () => {});
  } catch (_) {}
}

export function makeCleanupExecution(deps) {
  const { execMachine, activeExecutions, queries, broadcastSync, debugLog } = deps;
  return function cleanupExecution(conversationId, broadcastCompletion = false) {
    debugLog(`[cleanup] Starting cleanup for ${conversationId}`);
    const machineSnap = execMachine.snapshot(conversationId);
    if (machineSnap && machineSnap.value !== 'idle') {
      execMachine.send(conversationId, { type: 'CANCEL' });
    }
    activeExecutions.delete(conversationId);
    queries.setIsStreaming(conversationId, false);
    if (broadcastCompletion) {
      broadcastSync({
        type: 'execution_cleaned_up',
        conversationId,
        timestamp: Date.now()
      });
    }
    debugLog(`[cleanup] Cleanup complete for ${conversationId}`);
  };
}

export function makeGetModelsForAgent(deps) {
  const { modelCache, discoveredAgents, ensureRunning, queryACPModels } = deps;
  return async function getModelsForAgent(agentId) {
    const cached = modelCache.get(agentId);
    if (cached && Date.now() - cached.timestamp < 300000) return cached.models;
    let models = [];
    if (agentId === 'claude-code') {
      models = [
        { id: 'haiku', label: 'Haiku' },
        { id: 'sonnet', label: 'Sonnet' },
        { id: 'opus', label: 'Opus' }
      ];
    } else {
      const agent = discoveredAgents.find(a => a.id === agentId);
      if (agent?.protocol === 'acp') {
        await ensureRunning(agentId);
        try { models = await queryACPModels(agentId); } catch (_) {}
      }
    }
    modelCache.set(agentId, { models, timestamp: Date.now() });
    return models;
  };
}
