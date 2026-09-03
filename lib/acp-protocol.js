function normalizeContentBlock(content) {
  if (typeof content === 'string') return { type: 'text', text: content };
  if (content.type === 'text' && content.text) return content;
  if (content.text) return { type: 'text', text: content.text };
  if (content.content) {
    const inner = content.content;
    if (typeof inner === 'string') return { type: 'text', text: inner };
    if (inner.type === 'text' && inner.text) return inner;
    return { type: 'text', text: JSON.stringify(inner) };
  }
  return { type: 'text', text: JSON.stringify(content) };
}

function extractToolResultContent(updateContent) {
  const parts = [];
  if (!updateContent || !Array.isArray(updateContent)) return '';
  for (const item of updateContent) {
    if (item.type === 'content' && item.content) {
      const inner = item.content;
      if (inner.type === 'text' && inner.text) parts.push(inner.text);
      else if (inner.type === 'resource' && inner.resource) parts.push(inner.resource.text || JSON.stringify(inner.resource));
      else parts.push(JSON.stringify(inner));
    } else if (item.type === 'diff') {
      parts.push(item.oldText
        ? `--- ${item.path}\n+++ ${item.path}\n${item.oldText}\n---\n${item.newText}`
        : `+++ ${item.path}\n${item.newText}`);
    } else if (item.type === 'terminal') {
      parts.push(`[Terminal: ${item.terminalId}]`);
    }
  }
  return parts.join('\n');
}

function handleSessionUpdate(params) {
  const update = params.update || {};
  const sid = params.sessionId;

  if (update.sessionUpdate === 'agent_message_chunk' && update.content) {
    return { type: 'assistant', message: { role: 'assistant', content: [normalizeContentBlock(update.content)] }, session_id: sid };
  }

  if (update.sessionUpdate === 'tool_call') {
    return {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: update.toolCallId, name: update.title || update.kind || 'tool', kind: update.kind || 'other', input: update.rawInput || update.input || {} }] },
      session_id: sid
    };
  }

  if (update.sessionUpdate === 'tool_call_update') {
    const isError = update.status === 'failed';
    const isCompleted = update.status === 'completed';
    if (!isCompleted && !isError) {
      return { type: 'tool_status', tool_use_id: update.toolCallId, status: update.status, kind: update.kind || 'other', locations: update.locations || [], session_id: sid };
    }
    const content = extractToolResultContent(update.content) || (update.rawOutput ? JSON.stringify(update.rawOutput) : '');
    return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: update.toolCallId, content, is_error: isError }] }, session_id: sid };
  }

  if (update.sessionUpdate === 'usage_update') {
    return { type: 'usage', usage: { used: update.used, size: update.size, cost: update.cost }, session_id: sid };
  }

  if (update.sessionUpdate === 'plan') {
    return { type: 'plan', entries: update.entries || [], session_id: sid };
  }

  return null;
}

export function createACPProtocolHandler() {
  return function(message, context) {
    if (!message || typeof message !== 'object') return null;

    if (message.method === 'session/update') {
      return handleSessionUpdate(message.params || {});
    }

    if (message.id && message.result && message.result.stopReason) {
      return { type: 'result', result: '', stopReason: message.result.stopReason, usage: message.result.usage, session_id: context.sessionId };
    }

    if (message.method === 'error' || message.error) {
      return { type: 'error', error: message.error || message.params || { message: 'Unknown error' } };
    }

    return null;
  };
}

export const acpProtocolHandler = createACPProtocolHandler();
