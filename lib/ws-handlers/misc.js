import fs from 'fs';
import os from 'os';
import path from 'path';
import { err } from './shared.js';

export function register(router, deps) {
  const { queries, wsOptimizer, getProviderConfigs, saveProviderConfig, STARTUP_CWD } = deps;

  router.handle('home', () => ({ home: os.homedir(), cwd: STARTUP_CWD }));

  router.handle('folders', (p) => {
    const folderPath = p.path || STARTUP_CWD;
    try {
      const raw = folderPath.startsWith('~') ? folderPath.replace('~', os.homedir()) : folderPath;
      const entries = fs.readdirSync(path.resolve(raw), { withFileTypes: true });
      return { folders: entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => ({ name: e.name })).sort((a, b) => a.name.localeCompare(b.name)) };
    } catch (e) { err(400, e.message); }
  });

  router.handle('auth.configs', () => getProviderConfigs());

  router.handle('auth.save', (p) => {
    const { providerId, apiKey, defaultModel } = p;
    if (typeof providerId !== 'string' || !providerId.length || providerId.length > 100) err(400, 'Invalid providerId');
    if (typeof apiKey !== 'string' || !apiKey.length || apiKey.length > 10000) err(400, 'Invalid apiKey');
    if (defaultModel !== undefined && (typeof defaultModel !== 'string' || defaultModel.length > 200)) err(400, 'Invalid defaultModel');
    const configPath = saveProviderConfig(providerId, apiKey, defaultModel || '');
    return { success: true, path: configPath };
  });

  router.handle('import.claude', () => ({ imported: queries.importClaudeCodeConversations() }));

  router.handle('discover.claude', () => ({ discovered: queries.discoverClaudeCodeConversations() }));

  router.handle('ws.stats', () => wsOptimizer.getStats());
}
