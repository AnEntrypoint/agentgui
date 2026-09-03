export function createProcessMessage({ queries, activeExecutions, rateLimitState, execMachine, broadcastSync, runClaudeWithStreaming, cleanupExecution, STARTUP_CWD, buildSystemPrompt, parseRateLimitResetTime, touchACP, getJsonlWatcher, debugLog, logError, scheduleRetry, drainMessageQueue, createEventHandler }) {
  async function processMessageWithStreaming(conversationId, messageId, sessionId, content, agentId, model, subAgent) {
    const startTime = Date.now();
    touchACP(agentId);
    const conv = queries.getConversation(conversationId);
    if (!conv) {
      console.error(`[stream] Conversation ${conversationId} not found, aborting`);
      queries.updateSession(sessionId, { status: 'error', error: 'Conversation not found' });
      queries.setIsStreaming(conversationId, false);
      return;
    }
    if (activeExecutions.has(conversationId)) {
      const existing = activeExecutions.get(conversationId);
      if (existing.sessionId !== sessionId) {
        debugLog(`[stream] Conversation ${conversationId} already has active execution (different session), aborting duplicate`);
        return;
      }
    }
    if (rateLimitState.has(conversationId)) {
      const rlState = rateLimitState.get(conversationId);
      if (rlState.retryAt > Date.now()) {
        debugLog(`[stream] Conversation ${conversationId} is in rate limit cooldown, aborting`);
        return;
      }
    }
    activeExecutions.set(conversationId, { pid: null, startTime, sessionId, lastActivity: startTime });
    execMachine.send(conversationId, { type: 'START', sessionId });
    queries.setIsStreaming(conversationId, true);
    queries.updateSession(sessionId, { status: 'active' });
    const cwd = conv?.workingDirectory || STARTUP_CWD;
    // Resolve agent before building stateRef so isJsonlBacked can be set correctly.
    // claude-code (protocol: direct) writes JSONL -> JsonlParser owns event broadcasting.
    // All other agents (protocol: acp) rely solely on onEvent for streaming.
    const resolvedAgentId = agentId || 'claude-code';
    const isJsonlBacked = resolvedAgentId === 'claude-code';
    // stateRef tracks eventCount (for session response metadata) and resumeSessionId
    const stateRef = { eventCount: 0, resumeSessionId: conv?.claudeSessionId || null };
    const onEvent = createEventHandler({ queries, activeExecutions, broadcastSync, rateLimitState, batcherRef: stateRef, sessionId, conversationId, messageId, content, agentId, model, subAgent, isJsonlBacked, getJsonlWatcher, scheduleRetry, debugLog, parseRateLimitResetTime });
    try {
      debugLog(`[stream] Starting: conversationId=${conversationId}, sessionId=${sessionId}, agent=${resolvedAgentId}, jsonlBacked=${isJsonlBacked}`);
      const resolvedModel = model || conv?.model || null;
      const resolvedSubAgent = subAgent || conv?.subAgent || null;
      const config = {
        verbose: true, outputFormat: 'stream-json', timeout: 1800000, print: true,
        resumeSessionId: stateRef.resumeSessionId,
        systemPrompt: buildSystemPrompt(agentId, resolvedModel, resolvedSubAgent),
        model: resolvedModel || undefined, subAgent: resolvedSubAgent || undefined, onEvent,
        onPid: (pid) => { const e = activeExecutions.get(conversationId); if (e) e.pid = pid; execMachine.send(conversationId, { type: 'SET_PID', pid }); },
        onProcess: (proc) => { const e = activeExecutions.get(conversationId); if (e) e.proc = proc; execMachine.send(conversationId, { type: 'SET_PROC', proc }); }
      };
      const { outputs, sessionId: claudeSessionId } = await runClaudeWithStreaming(content, cwd, resolvedAgentId, config);
      if (rateLimitState.get(conversationId)?.isStreamDetected) {
        debugLog(`[rate-limit] Rate limit already handled in stream for conv ${conversationId}, skipping success handler`);
        return;
      }
      activeExecutions.delete(conversationId);
      execMachine.send(conversationId, { type: 'COMPLETE' });
      debugLog(`[stream] Claude returned ${outputs.length} outputs, sessionId=${claudeSessionId}`);
      queries.updateSession(sessionId, { status: 'complete', response: JSON.stringify({ outputs, eventCount: stateRef.eventCount }), completed_at: Date.now() });
      // streaming_complete is broadcast by JsonlParser when it sees the turn_duration event.
      // We still broadcast here as a fallback for cases where the file watcher may not have
      // processed the final event yet (e.g., ACP agents that don't write JSONL files).
      broadcastSync({ type: 'streaming_complete', sessionId, conversationId, agentId, eventCount: stateRef.eventCount, timestamp: Date.now() });
      debugLog(`[stream] Completed: ${outputs.length} outputs, ${stateRef.eventCount} events`);
    } catch (error) {
      const elapsed = Date.now() - startTime;
      debugLog(`[stream] Error after ${elapsed}ms: ${error.message}`);
      if (rateLimitState.get(conversationId)?.isStreamDetected) {
        debugLog(`[rate-limit] Rate limit already handled in stream for conv ${conversationId}, skipping catch handler`);
        return;
      }
      const isAuthError = error.authError || error.nonRetryable || /401|unauthorized|invalid.*auth|invalid.*token|auth.*failed|permission denied|access denied/i.test(error.message);
      const isRateLimit = error.rateLimited || /rate.?limit|429|too many requests|overloaded|throttl/i.test(error.message);
      queries.updateSession(sessionId, { status: 'error', error: error.message, completed_at: Date.now() });
      if (isAuthError) {
        debugLog(`[auth-error] Auth error for conv ${conversationId}: ${error.message}`);
        broadcastSync({ type: 'streaming_error', sessionId, conversationId, error: `Authentication failed: ${error.message}. Please check your API credentials.`, recoverable: false, isAuthError: true, timestamp: Date.now() });
        const errMsg = queries.createMessage(conversationId, 'assistant', `Error: Authentication failed. ${error.message}. Please update your credentials and try again.`);
        broadcastSync({ type: 'message_created', conversationId, message: errMsg, timestamp: Date.now() });
        queries.setIsStreaming(conversationId, false);
        activeExecutions.delete(conversationId);
        return;
      }
      if (isRateLimit) {
        const existingState = rateLimitState.get(conversationId) || {};
        const retryCount = (existingState.retryCount || 0) + 1;
        const maxRateLimitRetries = 3;
        if (retryCount > maxRateLimitRetries) {
          broadcastSync({ type: 'streaming_error', sessionId, conversationId, error: `Rate limit exceeded after ${retryCount} attempts. Please try again later.`, recoverable: false, timestamp: Date.now() });
          const errMsg = queries.createMessage(conversationId, 'assistant', `Error: Rate limit exceeded after ${retryCount} attempts. Please try again later.`);
          broadcastSync({ type: 'message_created', conversationId, message: errMsg, timestamp: Date.now() });
          queries.setIsStreaming(conversationId, false);
          return;
        }
        const cooldownMs = (error.retryAfterSec || 60) * 1000;
        const retryAt = Date.now() + cooldownMs;
        rateLimitState.set(conversationId, { retryAt, cooldownMs, retryCount });
        broadcastSync({ type: 'rate_limit_hit', sessionId, conversationId, retryAfterMs: cooldownMs, retryAt, retryCount, timestamp: Date.now() });
        debugLog(`[rate-limit] Scheduling retry for conv ${conversationId} in ${cooldownMs}ms (attempt ${retryCount + 1})`);
        setTimeout(() => {
          debugLog(`[rate-limit] Timeout fired for conv ${conversationId}, calling scheduleRetry`);
          rateLimitState.delete(conversationId);
          broadcastSync({ type: 'rate_limit_clear', conversationId, timestamp: Date.now() });
          scheduleRetry(conversationId, messageId, content, agentId, model, subAgent);
        }, cooldownMs);
        return;
      }
      const isSessionConflict = error.exitCode === null && stateRef.eventCount === 0;
      broadcastSync({ type: 'streaming_error', sessionId, conversationId, error: error.message, isPrematureEnd: error.isPrematureEnd || false, exitCode: error.exitCode, stderrText: error.stderrText, recoverable: elapsed < 60000, isSessionConflict, timestamp: Date.now() });
      if (!isSessionConflict) {
        const errMsg = queries.createMessage(conversationId, 'assistant', `Error: ${error.message}`);
        broadcastSync({ type: 'message_created', conversationId, message: errMsg, timestamp: Date.now() });
      }
    } finally {
      if (!rateLimitState.has(conversationId)) {
        cleanupExecution(conversationId);
        drainMessageQueue(conversationId);
      }
    }
  }
  return { processMessageWithStreaming };
}
