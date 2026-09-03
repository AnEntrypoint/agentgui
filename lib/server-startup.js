// JsonlWatcher removed; history now served by ccsniff in-process.
const JsonlWatcher = null;

export function createOnServerReady({ queries, broadcastSync, warmAssetCache, staticDir, discoveredAgents, PORT, BASE_URL, watch, setWatcher, resumeInterruptedStreams, activeExecutions, debugLog, installGMAgentConfigs, startACPTools, getACPStatus, execMachine, performAutoImport, performAgentHealthCheck, recoverStaleSessions }) {
  let jsonlWatcher = null;

  function getJsonlWatcher() { return jsonlWatcher; }

  function onServerReady() {
    console.log(`GMGUI running on http://localhost:${PORT}${BASE_URL}/`);
    console.log(`Agents: ${discoveredAgents.map(a => a.name).join(', ') || 'none'}`);
    console.log(`Hot reload: ${watch ? 'on' : 'off'}`);

    const deletedCount = queries.cleanupEmptyConversations();
    if (deletedCount > 0) console.log(`Cleaned up ${deletedCount} empty conversation(s) on startup`);

    recoverStaleSessions();
    warmAssetCache(staticDir);

    try { queries.cleanup(); console.log('[cleanup] Initial DB cleanup complete'); } catch (e) { console.error('[cleanup] Error:', e.message); }
    setInterval(() => {
      try { queries.cleanup(); console.log('[cleanup] Scheduled DB cleanup complete'); } catch (e) { console.error('[cleanup] Error:', e.message); }
    }, 6 * 60 * 60 * 1000);

    // JsonlWatcher removed; ccsniff handles JSONL history via its own watcher.

    resumeInterruptedStreams().catch(err => console.error('[RESUME] Startup error:', err.message));

    setInterval(() => {
      try {
        const streaming = queries.getStreamingConversations();
        let cleared = 0;
        for (const c of streaming) { if (!activeExecutions.has(c.id)) { queries.setIsStreaming(c.id, false); cleared++; } }
        if (cleared > 0) debugLog(`[HEALTH] Cleared ${cleared} stale streaming flag(s)`);
      } catch (e) { debugLog(`[HEALTH] Error: ${e.message}`); }
    }, 5 * 60 * 1000);

    installGMAgentConfigs().catch(err => console.error('[GM-CONFIG] Startup error:', err.message));

    startACPTools().then(() => {
      console.log('[ACP] On-demand startup enabled (ACP tools start when first used)');
      setTimeout(() => {
        const acpStatus = getACPStatus();
        if (acpStatus.length > 0) console.log(`[ACP] Tools ready: ${acpStatus.filter(s => s.healthy).map(s => s.id + ':' + s.port).join(', ') || 'none healthy yet'}`);
      }, 6000);
    }).catch(err => console.error('[ACP] Startup error:', err.message));

    performAutoImport();
    setInterval(performAutoImport, 30000);
    setInterval(performAgentHealthCheck, 30000);
  }

  return { onServerReady, getJsonlWatcher };
}
