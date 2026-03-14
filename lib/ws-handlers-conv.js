import path from 'path';
import os from 'os';

function fail(code, message) { const e = new Error(message); e.code = code; throw e; }
function notFound(msg = 'Not found') { fail(404, msg); }
function expandTilde(p) { return p && p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p; }

export function register(router, deps) {
  const { queries, activeExecutions, messageQueues, rateLimitState,
    broadcastSync, processMessageWithStreaming, cleanupExecution, activeProcessesByConvId, steeringTimeouts } = deps;

  // Per-conversation queue seq counter for event ordering
  const queueSeqByConv = new Map();

  function getNextQueueSeq(conversationId) {
    const current = queueSeqByConv.get(conversationId) || 0;
    const next = current + 1;
    queueSeqByConv.set(conversationId, next);
    return next;
  }

  router.handle('conv.ls', () => {
    const conversations = queries.getConversationsList();
    for (const c of conversations) { if (c.isStreaming && !activeExecutions.has(c.id)) c.isStreaming = 0; }
    return { conversations };
  });

  router.handle('conv.new', (p) => {
    const wd = p.workingDirectory ? path.resolve(expandTilde(p.workingDirectory)) : null;
    const conv = queries.createConversation(p.agentId, p.title, wd, p.model || null, p.subAgent || null);
    queries.createEvent('conversation.created', { agentId: p.agentId, workingDirectory: conv.workingDirectory, model: conv.model, subAgent: conv.subAgent }, conv.id);
    broadcastSync({ type: 'conversation_created', conversation: conv });
    return { conversation: conv };
  });

  router.handle('conv.get', (p) => {
    const conv = queries.getConversation(p.id);
    if (!conv) notFound();
    return { conversation: conv, isActivelyStreaming: activeExecutions.has(p.id), latestSession: queries.getLatestSession(p.id) };
  });

  router.handle('conv.upd', (p) => {
    const { id, ...data } = p;
    if (data.workingDirectory) data.workingDirectory = path.resolve(data.workingDirectory);
    const conv = queries.updateConversation(id, data);
    if (!conv) notFound('Conversation not found');
    queries.createEvent('conversation.updated', data, id);
    broadcastSync({ type: 'conversation_updated', conversation: conv });
    return { conversation: conv };
  });

  router.handle('conv.del', (p) => {
    if (!queries.deleteConversation(p.id)) notFound();
    broadcastSync({ type: 'conversation_deleted', conversationId: p.id });
    return { deleted: true };
  });

  router.handle('conv.del.all', (p) => {
    if (!queries.deleteAllConversations()) fail(500, 'Failed to delete all conversations');
    broadcastSync({ type: 'all_conversations_deleted', timestamp: Date.now() });
    return { deleted: true, message: 'All conversations deleted' };
  });

  router.handle('conv.full', (p) => {
    const conv = queries.getConversation(p.id);
    if (!conv) notFound();
    const chunkLimit = Math.min(p.chunkLimit || 500, 5000);
    const messageLimit = Math.min(p.messageLimit || 20, 100);
    const totalChunks = queries.getConversationChunkCount(p.id);
    const chunks = (p.allChunks || totalChunks <= chunkLimit)
      ? queries.getConversationChunks(p.id) : queries.getRecentConversationChunks(p.id, chunkLimit);
    const messagesResult = queries.getRecentMessages(p.id, messageLimit);
    return {
      conversation: conv,
      isActivelyStreaming: activeExecutions.has(p.id),
      latestSession: queries.getLatestSession(p.id),
      chunks,
      totalChunks,
      hasMoreChunks: totalChunks > chunkLimit,
      messages: messagesResult.messages,
      totalMessages: messagesResult.total,
      hasMoreMessages: messagesResult.hasMore,
      rateLimitInfo: rateLimitState.get(p.id) || null
    };
  });

  router.handle('conv.chunks', (p) => {
    if (!queries.getConversation(p.id)) notFound('Conversation not found');
    const since = parseInt(p.since || '0');
    const chunks = since > 0
      ? queries.getConversationChunksSince(p.id, since)
      : queries.getConversationChunks(p.id);
    return { ok: true, chunks };
  });

  router.handle('conv.chunks.earlier', (p) => {
    if (!queries.getConversation(p.id)) notFound('Conversation not found');
    const beforeTimestamp = parseInt(p.before || Date.now());
    const limit = Math.min(p.limit || 500, 5000);
    const result = queries.getChunksBefore(p.id, beforeTimestamp, limit);
    return { ok: true, chunks: result.chunks, total: result.total, hasMore: result.hasMore, limit: result.limit };
  });

  router.handle('conv.cancel', (p) => {
    const entry = activeExecutions.get(p.id);
    if (!entry) notFound('No active execution to cancel');
    const { pid, sessionId } = entry;
    if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch {} } }
    if (sessionId) queries.updateSession(sessionId, { status: 'interrupted', completed_at: Date.now() });

    // Use atomic cleanup function to ensure state consistency
    cleanupExecution(p.id, false);

    broadcastSync({ type: 'streaming_complete', sessionId, conversationId: p.id, interrupted: true, timestamp: Date.now() });
    return { ok: true, cancelled: true, conversationId: p.id, sessionId };
  });

  router.handle('conv.inject', (p) => {
    const conv = queries.getConversation(p.id);
    if (!conv) notFound('Conversation not found');
    if (!p.content) fail(400, 'Missing content');
    const entry = activeExecutions.get(p.id);
    const message = queries.createMessage(p.id, 'user', '[INJECTED] ' + p.content);
    if (!entry) {
      const agentId = conv.agentId || 'claude-code';
      const session = queries.createSession(p.id, agentId, 'pending');
      processMessageWithStreaming(p.id, message.id, session.id, message.content, agentId, conv.model || null, conv.subAgent || null);
    }
    return { ok: true, injected: true, conversationId: p.id, messageId: message.id };
  });

  router.handle('conv.steer', (p) => {
    const conv = queries.getConversation(p.id);
    if (!conv) notFound('Conversation not found');
    if (!p.content) fail(400, 'Missing content');

    const entry = activeExecutions.get(p.id);
    const proc = (entry && entry.proc) || activeProcessesByConvId.get(p.id);

    if (proc && proc.stdin && !proc.stdin.destroyed) {
      // Agent is running and stdin is alive — inject prompt directly
      const message = queries.createMessage(p.id, 'user', p.content);
      queries.createEvent('message.created', { role: 'user', messageId: message.id }, p.id);
      broadcastSync({ type: 'message_created', conversationId: p.id, message, timestamp: Date.now() });

      const sessionId = entry?.sessionId;
      const promptRequest = {
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'session/prompt',
        params: { sessionId, prompt: [{ type: 'text', text: p.content }] }
      };
      proc.stdin.write(JSON.stringify(promptRequest) + '\n');

      // Reset steering timeout
      const existing = steeringTimeouts.get(p.id);
      if (existing) clearTimeout(existing);
      const t = setTimeout(() => { activeProcessesByConvId.delete(p.id); steeringTimeouts.delete(p.id); }, 30000);
      steeringTimeouts.set(p.id, t);

      return { ok: true, steered: true, conversationId: p.id, messageId: message.id };
    }

    fail(409, 'Process not available for steering');
  });

  router.handle('msg.ls', (p) => {
    return queries.getPaginatedMessages(p.id, Math.min(p.limit || 50, 100), Math.max(p.offset || 0, 0));
  });

  router.handle('msg.ls.earlier', (p) => {
    if (!p.id) fail(400, 'Missing conversation id');
    if (!p.before) fail(400, 'Missing before messageId parameter');
    const limit = Math.min(p.limit || 50, 100);
    const result = queries.getMessagesBefore(p.id, p.before, limit);
    return { ok: true, messages: result.messages, total: result.total, hasMore: result.hasMore, limit: result.limit };
  });

  function startExecution(convId, message, agentId, model, content, subAgent) {
    const session = queries.createSession(convId);
    queries.createEvent('session.created', { messageId: message.id, sessionId: session.id }, convId, session.id);
    activeExecutions.set(convId, { pid: null, startTime: Date.now(), sessionId: session.id, lastActivity: Date.now() });
    queries.setIsStreaming(convId, true);
    broadcastSync({ type: 'streaming_start', sessionId: session.id, conversationId: convId, messageId: message.id, agentId, timestamp: Date.now() });
    processMessageWithStreaming(convId, message.id, session.id, content, agentId, model, subAgent).catch(() => {});
    return session;
  }

  function enqueue(convId, content, agentId, model, messageId, subAgent) {
    if (!messageQueues.has(convId)) messageQueues.set(convId, []);
    messageQueues.get(convId).push({ content, agentId, model, messageId, subAgent });
    const queueLength = messageQueues.get(convId).length;
    broadcastSync({ type: 'queue_status', conversationId: convId, queueLength, messageId, timestamp: Date.now() });
    return queueLength;
  }

  router.handle('msg.send', (p) => {
    const conv = queries.getConversation(p.id);
    if (!conv) notFound('Conversation not found');
    const agentId = p.agentId || conv.agentType || conv.agentId || 'claude-code';
    const model = p.model || conv.model || null;
    const subAgent = p.subAgent || conv.subAgent || null;
    const idempotencyKey = p.idempotencyKey || null;
    const message = queries.createMessage(p.id, 'user', p.content, idempotencyKey);
    queries.createEvent('message.created', { role: 'user', messageId: message.id }, p.id);

    // Only broadcast message_created if NOT queuing - queued messages show in queue indicator instead
    if (!activeExecutions.has(p.id)) {
      broadcastSync({ type: 'message_created', conversationId: p.id, message, timestamp: Date.now() });
      const session = startExecution(p.id, message, agentId, model, p.content, subAgent);
      return { message, session, idempotencyKey };
    }

    // Message is queued - don't broadcast as message_created, let queue_status handle the UI update
    const qp = enqueue(p.id, p.content, agentId, model, message.id, subAgent);
    return { message, queued: true, queuePosition: qp, idempotencyKey };
  });

  router.handle('msg.get', (p) => {
    const msg = queries.getMessage(p.messageId);
    if (!msg || msg.conversationId !== p.id) notFound();
    return { message: msg };
  });

  router.handle('msg.stream', (p) => {
    const conv = queries.getConversation(p.id);
    if (!conv) notFound('Conversation not found');
    const prompt = p.content || p.message || '';
    const agentId = p.agentId || conv.agentType || conv.agentId || 'claude-code';
    const model = p.model || conv.model || null;
    const subAgent = p.subAgent || conv.subAgent || null;
    const userMessage = queries.createMessage(p.id, 'user', prompt);
    queries.createEvent('message.created', { role: 'user', messageId: userMessage.id }, p.id);

    // Only broadcast message_created if NOT queuing - queued messages show in queue indicator instead
    if (!activeExecutions.has(p.id)) {
      broadcastSync({ type: 'message_created', conversationId: p.id, message: userMessage, timestamp: Date.now() });
      const session = startExecution(p.id, userMessage, agentId, model, prompt, subAgent);
      return { message: userMessage, session, streamId: session.id };
    }

    // Message is queued - don't broadcast as message_created, let queue_status handle the UI update
    const qp = enqueue(p.id, prompt, agentId, model, userMessage.id, subAgent);
    const seq = getNextQueueSeq(p.id);
    broadcastSync({
      type: 'queue_status',
      conversationId: p.id,
      queueLength: messageQueues.get(p.id)?.length || 1,
      seq,
      timestamp: Date.now()
    });
    return { message: userMessage, queued: true, queuePosition: qp };
  });

  router.handle('q.ls', (p) => {
    if (!queries.getConversation(p.id)) notFound('Conversation not found');
    return { queue: messageQueues.get(p.id) || [] };
  });

  router.handle('q.del', (p) => {
    const queue = messageQueues.get(p.id);
    if (!queue) notFound('Queue not found');
    const idx = queue.findIndex(q => q.messageId === p.messageId);
    if (idx === -1) notFound('Queued message not found');
    queue.splice(idx, 1);
    if (queue.length === 0) messageQueues.delete(p.id);
    const seq = getNextQueueSeq(p.id);
    broadcastSync({
      type: 'queue_status',
      conversationId: p.id,
      queueLength: queue?.length || 0,
      seq,
      timestamp: Date.now()
    });
    return { deleted: true };
  });

  router.handle('q.upd', (p) => {
    const queue = messageQueues.get(p.id);
    if (!queue) notFound('Queue not found');
    const item = queue.find(q => q.messageId === p.messageId);
    if (!item) notFound('Queued message not found');
    if (p.content !== undefined) item.content = p.content;
    if (p.agentId !== undefined) item.agentId = p.agentId;
    const seq = getNextQueueSeq(p.id);
    broadcastSync({
      type: 'queue_updated',
      conversationId: p.id,
      messageId: p.messageId,
      content: item.content,
      agentId: item.agentId,
      seq,
      timestamp: Date.now()
    });
    return { updated: true, item };
  });
}
