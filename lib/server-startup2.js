import fs from 'fs';
import path from 'path';
import os from 'os';

export function createAutoImport({ queries, broadcastSync }) {
  const importMtimeCache = new Map();

  function hasIndexFilesChanged() {
    const projectsDir = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(projectsDir)) return false;
    let changed = false;
    try {
      const dirs = fs.readdirSync(projectsDir);
      for (const d of dirs) {
        const indexPath = path.join(projectsDir, d, 'sessions-index.json');
        try {
          const stat = fs.statSync(indexPath);
          const cached = importMtimeCache.get(indexPath);
          if (!cached || cached < stat.mtimeMs) { importMtimeCache.set(indexPath, stat.mtimeMs); changed = true; }
        } catch (_) {}
      }
    } catch (_) {}
    return changed;
  }

  function performAutoImport() {
    try {
      if (process.env.AGENTGUI_SKIP_AUTO_IMPORT === '1') return;
      if (!hasIndexFilesChanged()) return;
      const imported = queries.importClaudeCodeConversations() || [];
      if (imported.length > 0) {
        const importedCount = imported.filter(i => i.status === 'imported').length;
        if (importedCount > 0) {
          console.log(`[AUTO-IMPORT] Imported ${importedCount} new Claude Code conversations`);
          broadcastSync({ type: 'conversations_updated', count: importedCount });
        }
      }
    } catch (err) { console.error('[AUTO-IMPORT] Error:', err.message); }
  }

  return { performAutoImport };
}

export function createDbRecovery({ queries, debugLog }) {
  function performDbRecovery() {
    try {
      const cleanedUp = queries.cleanupOrphanedSessions(7);
      if (cleanedUp > 0) debugLog(`[RECOVERY] Cleaned up ${cleanedUp} orphaned sessions`);
      const longRunning = queries.getSessionsProcessingLongerThan(120);
      if (longRunning.length > 0) {
        for (const session of longRunning) queries.markSessionIncomplete(session.id, 'Timeout: processing exceeded 2 hours');
        debugLog(`[RECOVERY] Marked ${longRunning.length} long-running sessions as incomplete`);
      }
    } catch (err) { console.error('[RECOVERY] Error:', err.message); }
  }

  return { performDbRecovery };
}
