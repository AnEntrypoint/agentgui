export function createMessageQueue({ queries, activeExecutions, messageQueues, broadcastSync, execMachine, cleanupExecution, debugLog, getProcessMessageWithStreaming }) {
  function scheduleRetry(conversationId, messageId, content, agentId, model, subAgent) {
    debugLog(`[rate-limit] scheduleRetry called for conv ${conversationId}, messageId=${messageId}`);
    if (!content) {
      queries.getConversation(conversationId);
      const lastMsg = queries.getLastUserMessage(conversationId);
      content = lastMsg?.content || 'continue';
      debugLog(`[rate-limit] Recovered content from last message: ${content?.substring?.(0, 50)}...`);
    }
    const newSession = queries.createSession(conversationId);
    queries.createEvent('session.created', { messageId, sessionId: newSession.id, retryReason: 'rate_limit' }, conversationId, newSession.id);
    debugLog(`[rate-limit] Broadcasting streaming_start for retry session ${newSession.id}`);
    broadcastSync({ type: 'streaming_start', sessionId: newSession.id, conversationId, messageId, agentId, queueLength: messageQueues.get(conversationId)?.length || 0, timestamp: Date.now() });
    const startTime = Date.now();
    activeExecutions.set(conversationId, { pid: null, startTime, sessionId: newSession.id, lastActivity: startTime });
    debugLog(`[rate-limit] Calling processMessageWithStreaming for retry`);
    getProcessMessageWithStreaming()(conversationId, messageId, newSession.id, content, agentId, model, subAgent)
      .catch(err => {
        debugLog(`[rate-limit] Retry failed: ${err.message}`);
        console.error(`[rate-limit] Retry error for conv ${conversationId}:`, err);
        cleanupExecution(conversationId);
        broadcastSync({ type: 'streaming_error', sessionId: newSession.id, conversationId, error: `Rate limit retry failed: ${err.message}`, recoverable: false, timestamp: Date.now() });
      });
  }

  function drainMessageQueue(conversationId) {
    const machineQueue = execMachine.getQueue(conversationId);
    const mapQueue = messageQueues.get(conversationId);
    if (machineQueue.length === 0 && (!mapQueue || mapQueue.length === 0)) return;
    let next;
    if (machineQueue.length > 0) {
      execMachine.send(conversationId, { type: 'COMPLETE' });
      const ctx = execMachine.getContext(conversationId);
      next = ctx?.nextItem;
      if (mapQueue && mapQueue.length > 0) mapQueue.shift();
      if (mapQueue && mapQueue.length === 0) messageQueues.delete(conversationId);
    } else {
      next = mapQueue.shift();
      if (mapQueue.length === 0) messageQueues.delete(conversationId);
    }
    if (!next) return;
    debugLog(`[queue] Draining next message for ${conversationId}, messageId=${next.messageId}`);
    const remainingQueueLength = execMachine.getQueue(conversationId).length || messageQueues.get(conversationId)?.length || 0;
    broadcastSync({ type: 'queue_item_dequeued', conversationId, messageId: next.messageId, queueLength: remainingQueueLength, timestamp: Date.now() });
    const session = queries.createSession(conversationId);
    queries.createEvent('session.created', { messageId: next.messageId, sessionId: session.id }, conversationId, session.id);
    broadcastSync({ type: 'streaming_start', sessionId: session.id, conversationId, messageId: next.messageId, agentId: next.agentId, queueLength: remainingQueueLength, timestamp: Date.now() });
    broadcastSync({ type: 'queue_status', conversationId, queueLength: remainingQueueLength, timestamp: Date.now() });
    const startTime = Date.now();
    execMachine.send(conversationId, { type: 'START', sessionId: session.id });
    activeExecutions.set(conversationId, { pid: null, startTime, sessionId: session.id, lastActivity: startTime });
    getProcessMessageWithStreaming()(conversationId, next.messageId, session.id, next.content, next.agentId, next.model, next.subAgent)
      .catch(err => {
        debugLog(`[queue] Error processing queued message: ${err.message}`);
        cleanupExecution(conversationId);
        broadcastSync({ type: 'streaming_error', sessionId: session.id, conversationId, error: `Queue processing failed: ${err.message}`, recoverable: true, timestamp: Date.now() });
        setTimeout(() => drainMessageQueue(conversationId), 100);
      });
  }

  return { scheduleRetry, drainMessageQueue };
}
