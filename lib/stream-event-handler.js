/**
 * Claude stdout event handler.
 *
 * For claude-code (isJsonlBacked=true):
 *   JsonlParser owns all event broadcasting via the JSONL file watcher.
 *   This handler only needs to:
 *     1. Extract session_id -> setClaudeSessionId + registerSession
 *     2. Detect inline rate-limit messages -> scheduleRetry
 *
 * For ACP agents (isJsonlBacked=false):
 *   No JSONL file is written. This handler broadcasts streaming_start,
 *   streaming_progress blocks, and persists chunks to the DB.
 */
export function createEventHandler({ queries, activeExecutions, broadcastSync, rateLimitState, batcherRef, sessionId, conversationId, messageId, content, agentId, model, subAgent, isJsonlBacked, getJsonlWatcher, scheduleRetry, debugLog, parseRateLimitResetTime }) {
  return function onEvent(parsed) {
    batcherRef.eventCount++;
    const entry = activeExecutions.get(conversationId);
    if (entry) entry.lastActivity = Date.now();

    // Register session with file watcher as soon as we see the session_id.
    // This pre-maps claudeSessionId -> (convId, dbSessionId) in JsonlParser before
    // the 16ms file-watcher debounce fires, preventing duplicate conversation creation.
    if (parsed.session_id) {
      if (!batcherRef.resumeSessionId || batcherRef.resumeSessionId !== parsed.session_id) {
        batcherRef.resumeSessionId = parsed.session_id;
        queries.setClaudeSessionId(conversationId, parsed.session_id, sessionId);
        try { getJsonlWatcher()?.registerSession(parsed.session_id, conversationId, sessionId); } catch (_) {}
      }
    }

    debugLog(`[stream] Event ${batcherRef.eventCount}: type=${parsed.type}`);

    // --- ACP agent broadcasting (not backed by JSONL watcher) ---
    if (!isJsonlBacked) {
      // Send streaming_start on first event
      if (batcherRef.eventCount === 1) {
        queries.setIsStreaming(conversationId, true);
        broadcastSync({ type: 'streaming_start', sessionId, conversationId, agentId, timestamp: Date.now() });
      }

      const emitBlock = (block, role, extra) => {
        if (!block || !block.type) return;
        batcherRef.currentSeq = (batcherRef.currentSeq || 0) + 1;
        try { queries.createChunk(sessionId, conversationId, batcherRef.currentSeq, block.type, block); }
        catch (err) { console.error(`[stream] createChunk failed conv=${conversationId} seq=${batcherRef.currentSeq} type=${block.type}:`, err.message); }
        broadcastSync({ type: 'streaming_progress', sessionId, conversationId, block, blockRole: role, seq: batcherRef.currentSeq, timestamp: Date.now(), ...extra });
      };

      if (parsed.type === 'assistant' && parsed.message?.content) {
        for (const block of parsed.message.content) emitBlock(block, 'assistant');
      }

      if (parsed.type === 'user' && parsed.message?.content) {
        const blocks = Array.isArray(parsed.message.content) ? parsed.message.content : [];
        for (const block of blocks) if (block?.type === 'tool_result') emitBlock(block, 'tool_result');
      }

      if (parsed.type === 'result') {
        const block = { type: 'result', result: parsed.result, subtype: parsed.subtype, duration_ms: parsed.duration_ms, total_cost_usd: parsed.total_cost_usd, is_error: parsed.is_error || false };
        emitBlock(block, 'result', { isResult: true });
      }
    }

    // --- Rate-limit detection in assistant text blocks (all agents) ---
    if (parsed.type === 'assistant' && parsed.message?.content) {
      for (const block of parsed.message.content) {
        if (block.type === 'text' && block.text) {
          const rateLimitMatch = block.text.match(/you'?ve hit your limit|rate limit exceeded/i);
          if (rateLimitMatch) {
            debugLog(`[rate-limit] Detected rate limit message in stream for conv ${conversationId}`);
            const retryAfterSec = parseRateLimitResetTime(block.text);
            const entry2 = activeExecutions.get(conversationId);
            if (entry2 && entry2.pid) { try { process.kill(entry2.pid); } catch (_) {} }
            const existingCount = rateLimitState.get(conversationId)?.retryCount || 0;
            if (existingCount >= 3) {
              activeExecutions.delete(conversationId);
              queries.setIsStreaming(conversationId, false);
              const errMsg = queries.createMessage(conversationId, 'assistant', `Error: Rate limit exceeded after ${existingCount + 1} attempts. Please try again later.`);
              broadcastSync({ type: 'message_created', conversationId, message: errMsg, timestamp: Date.now() });
              broadcastSync({ type: 'streaming_complete', sessionId, conversationId, interrupted: true, timestamp: Date.now() });
              return;
            }
            rateLimitState.set(conversationId, { retryAt: Date.now() + (retryAfterSec * 1000), cooldownMs: retryAfterSec * 1000, retryCount: existingCount + 1, isStreamDetected: true });
            broadcastSync({ type: 'rate_limit_hit', sessionId, conversationId, retryAfterMs: retryAfterSec * 1000, retryAt: Date.now() + (retryAfterSec * 1000), retryCount: 1, timestamp: Date.now() });
            activeExecutions.delete(conversationId);
            queries.setIsStreaming(conversationId, false);
            setTimeout(() => {
              rateLimitState.delete(conversationId);
              broadcastSync({ type: 'rate_limit_clear', conversationId, timestamp: Date.now() });
              scheduleRetry(conversationId, messageId, content, agentId, model, subAgent);
            }, retryAfterSec * 1000);
            return;
          }
        }
      }
    }

    // --- Rate-limit detection in result blocks (all agents) ---
    if (parsed.type === 'result' && parsed.result) {
      const resultText = typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result);
      const rlMatch = resultText.match(/you'?ve hit your limit|rate limit exceeded/i);
      if (rlMatch) {
        debugLog(`[rate-limit] Detected rate limit in result for conv ${conversationId}`);
        const retryAfterSec = parseRateLimitResetTime(resultText);
        const entry3 = activeExecutions.get(conversationId);
        if (entry3 && entry3.pid) { try { process.kill(entry3.pid); } catch (_) {} }
        const existingCount2 = rateLimitState.get(conversationId)?.retryCount || 0;
        if (existingCount2 >= 3) {
          activeExecutions.delete(conversationId);
          queries.setIsStreaming(conversationId, false);
          const errMsg2 = queries.createMessage(conversationId, 'assistant', `Error: Rate limit exceeded after ${existingCount2 + 1} attempts. Please try again later.`);
          broadcastSync({ type: 'message_created', conversationId, message: errMsg2, timestamp: Date.now() });
          broadcastSync({ type: 'streaming_complete', sessionId, conversationId, interrupted: true, timestamp: Date.now() });
          return;
        }
        rateLimitState.set(conversationId, { retryAt: Date.now() + (retryAfterSec * 1000), cooldownMs: retryAfterSec * 1000, retryCount: existingCount2 + 1, isStreamDetected: true });
        broadcastSync({ type: 'rate_limit_hit', sessionId, conversationId, retryAfterMs: retryAfterSec * 1000, retryAt: Date.now() + (retryAfterSec * 1000), retryCount: existingCount2 + 1, timestamp: Date.now() });
        activeExecutions.delete(conversationId);
        queries.setIsStreaming(conversationId, false);
        setTimeout(() => {
          rateLimitState.delete(conversationId);
          broadcastSync({ type: 'rate_limit_clear', conversationId, timestamp: Date.now() });
          scheduleRetry(conversationId, messageId, content, agentId, model, subAgent);
        }, retryAfterSec * 1000);
        return;
      }
    }
  };
}
