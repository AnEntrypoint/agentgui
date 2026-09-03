export function createRecovery({ activeExecutions, processMessageWithStreaming, queries, broadcastSync, drainMessageQueue, stuckThresholdMs, noPidGracePeriodMs }) {
  function isProcessAlive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      if (err.code === 'EPERM') return true;
      return false;
    }
  }

  function killActiveExecutions() {
    for (const [convId, entry] of activeExecutions.entries()) {
      if (entry.pid) {
        try { process.kill(-entry.pid, 'SIGTERM'); } catch { try { process.kill(entry.pid, 'SIGTERM'); } catch (_) {} }
      }
      if (entry.proc) {
        try { entry.proc.kill('SIGTERM'); } catch (_) {}
      }
    }
    activeExecutions.clear();
  }

  function recoverStaleSessions() {
    try {
      const RESUME_WINDOW_MS = 600000;
      const cutoff = Date.now() - RESUME_WINDOW_MS;
      const staleSessions = queries.getActiveSessions();
      for (const session of staleSessions) {
        queries.updateSession(session.id, {
          status: session.started_at > cutoff ? 'interrupted' : 'error',
          error: 'Server restarted',
          completed_at: Date.now()
        });
      }
      queries.clearAllStreamingFlags();
      if (staleSessions.length > 0) {
        console.log(`[RECOVERY] Marked ${staleSessions.length} stale session(s); cleared streaming flags`);
      }
    } catch (err) {
      console.error('[RECOVERY] Error:', err.message);
    }
  }

  async function resumeConversation(conversationId, previousSessionId, reason) {
    const conv = queries.getConversation(conversationId);
    if (!conv) throw new Error('Conversation not found');
    if (previousSessionId) {
      const prev = queries.getSession ? queries.getSession(previousSessionId) : null;
      if (prev && prev.status !== 'interrupted') {
        queries.updateSession(previousSessionId, { status: 'interrupted', error: reason || 'Restarting', completed_at: Date.now() });
      }
    }
    const lastMsg = queries.getLastUserMessage(conversationId);
    const promptText = typeof lastMsg?.content === 'string' ? lastMsg.content : JSON.stringify(lastMsg?.content || 'continue');
    const session = queries.createSession(conversationId);
    queries.createEvent('session.created', {
      sessionId: session.id,
      resumeReason: 'interrupted',
      claudeSessionId: conv.claudeSessionId
    }, conversationId, session.id);
    activeExecutions.set(conversationId, {
      pid: null,
      startTime: Date.now(),
      sessionId: session.id,
      lastActivity: Date.now()
    });
    broadcastSync({
      type: 'streaming_start',
      sessionId: session.id,
      conversationId,
      agentId: conv.agentType,
      resumed: true,
      timestamp: Date.now()
    });
    console.log(`[RESUME] Restarting conv ${conversationId} (reason: ${reason})`);
    await processMessageWithStreaming(conversationId, lastMsg?.id || null, session.id, promptText, conv.agentType, conv.model, conv.subAgent);
  }

  function markAgentDead(conversationId, entry, reason) {
    if (!activeExecutions.has(conversationId)) return;
    activeExecutions.delete(conversationId);
    const RESUME_WINDOW_MS = 600000;
    const sessionAge = entry.startTime ? Date.now() - entry.startTime : Infinity;
    const shouldRestart = sessionAge < RESUME_WINDOW_MS;
    queries.setIsStreaming(conversationId, false);
    if (entry.sessionId) {
      queries.updateSession(entry.sessionId, {
        status: shouldRestart ? 'interrupted' : 'error',
        error: reason,
        completed_at: Date.now()
      });
    }
    if (shouldRestart) {
      resumeConversation(conversationId, entry.sessionId, reason).catch(err => {
        console.error(`[RESUME] Auto-restart failed for conv ${conversationId}: ${err.message}`);
        queries.setIsStreaming(conversationId, false);
      });
      return;
    }
    broadcastSync({
      type: 'streaming_error',
      sessionId: entry.sessionId,
      conversationId,
      error: reason,
      recoverable: false,
      timestamp: Date.now()
    });
    drainMessageQueue(conversationId);
  }

  async function resumeInterruptedStreams() {
    try {
      const toResume = queries.getResumableConversations(600000);
      if (toResume.length === 0) return;
      console.log(`[RESUME] Resuming ${toResume.length} interrupted conversation(s)`);
      for (let i = 0; i < toResume.length; i++) {
        const conv = toResume[i];
        try {
          const lastSession = queries.getLatestSession(conv.id);
          await resumeConversation(conv.id, lastSession?.id || null, 'Server restarted');
          if (i < toResume.length - 1) await new Promise(r => setTimeout(r, 200));
        } catch (err) {
          console.error(`[RESUME] Failed to resume conv ${conv.id}: ${err.message}`);
          queries.setIsStreaming(conv.id, false);
        }
      }
    } catch (err) {
      console.error('[RESUME] Error:', err.message);
    }
  }

  function performAgentHealthCheck() {
    const now = Date.now();
    for (const [conversationId, entry] of activeExecutions) {
      if (!entry) continue;
      if (entry.pid) {
        if (!isProcessAlive(entry.pid)) {
          console.error(`[HEALTH] Agent PID ${entry.pid} for conv ${conversationId} is dead`);
          markAgentDead(conversationId, entry, 'Agent process died unexpectedly');
        } else if (now - entry.lastActivity > stuckThresholdMs) {
          console.error(`[HEALTH] Agent PID ${entry.pid} for conv ${conversationId} has no activity for ${Math.round((now - entry.lastActivity) / 1000)}s`);
          try { process.kill(entry.pid, 'SIGTERM'); } catch (e) {}
          markAgentDead(conversationId, entry, 'Agent was stuck (no activity for 30 minutes)');
        }
      } else {
        if (now - entry.startTime > noPidGracePeriodMs) {
          console.error(`[HEALTH] Agent for conv ${conversationId} never reported PID after ${Math.round((now - entry.startTime) / 1000)}s`);
          markAgentDead(conversationId, entry, 'Agent failed to start (no PID reported)');
        }
      }
    }
  }

  return { killActiveExecutions, recoverStaleSessions, resumeInterruptedStreams, isProcessAlive, markAgentDead, resumeConversation, performAgentHealthCheck };
}
