// Normalizes opencode's REST+SSE event shape (POST /session, POST
// /session/{id}/message, GET /global/event) into the SAME internal event
// shape lib/acp-protocol.js's acpProtocolHandler produces for the stdio ACP
// JSON-RPC transport (assistant/tool_use/tool_result/result), so a caller can
// switch transports without caring which one produced the event.
//
// Live-captured event shapes this maps (opencode 1.2.15, acp --port, SSE
// frames from GET /global/event during a real session/message round trip):
//   {payload:{type:'message.part.updated', properties:{part:{type:'text',text,...}}}}
//   {payload:{type:'message.part.updated', properties:{part:{type:'reasoning',text,...}}}}
//   {payload:{type:'message.updated', properties:{info:{role,finish,...}}}}
//   {payload:{type:'session.status', properties:{status:{type:'busy'|'idle'}}}}
//   {payload:{type:'session.idle', properties:{...}}}

function normalizePart(part, sessionId) {
  if (!part || typeof part !== 'object') return null;
  // A text part streams in incrementally - the first frame for it can arrive
  // with an empty string before content lands (live-observed). An empty
  // chunk carries nothing a caller can render; drop it rather than emitting
  // a blank assistant bubble.
  if (part.type === 'text' && typeof part.text === 'string' && part.text.length > 0) {
    return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: part.text }] }, session_id: sessionId };
  }
  if (part.type === 'tool' || part.type === 'tool-invocation') {
    return {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'tool_use', id: part.id, name: part.tool || part.name || 'tool', input: part.input || part.args || {} }] },
      session_id: sessionId,
    };
  }
  // reasoning/step-start/step-finish parts carry no user-facing content in
  // agentgui's chat surface today - dropped (return null), same as the stdio
  // path drops ACP updates it doesn't recognize.
  return null;
}

// A `message.part.updated` frame's `part` carries NO role of its own - live
// capture confirmed the part's role lives on the earlier `message.updated`
// frame for the SAME messageID (the prompt echo arrives as a role:"user"
// message.updated immediately before its own message.part.updated). Each
// createACPHttpProtocolHandler() call keeps its own messageId->role map so a
// caller with one handler per session never leaks state across sessions.
export function createACPHttpProtocolHandler() {
  const roleByMessageId = new Map();

  return function (frame, context) {
    if (!frame || typeof frame !== 'object') return null;
    const payload = frame.payload;
    if (!payload || typeof payload !== 'object') return null;
    const sid = context?.sessionId;

    if (payload.type === 'message.updated') {
      const info = payload.properties?.info;
      if (!info) return null;
      if (info.id) roleByMessageId.set(info.id, info.role);
      if (info.role === 'assistant' && info.finish) {
        return { type: 'result', result: '', stopReason: info.finish, usage: info.tokens ? { used: info.tokens.total } : undefined, session_id: info.sessionID || sid };
      }
      return null;
    }

    if (payload.type === 'message.part.updated') {
      const part = payload.properties?.part;
      if (!part) return null;
      // The user's own prompt echoes back as a part on their own message -
      // only forward parts belonging to an assistant-role message.
      const role = part.messageID ? roleByMessageId.get(part.messageID) : undefined;
      if (role === 'user') return null;
      return normalizePart(part, sid);
    }

    if (payload.type === 'session.status' && payload.properties?.status?.type === 'error') {
      return { type: 'error', error: payload.properties.status };
    }

    return null;
  };
}

export const acpHttpProtocolHandler = createACPHttpProtocolHandler();

// Parse one SSE "data: {...}\n\n" frame (or a raw chunk containing several)
// into an array of parsed JSON payloads. opencode's /global/event stream
// uses the standard `data: <json>\n\n` SSE framing (live-confirmed).
export function parseSSEChunk(chunk) {
  const out = [];
  for (const block of chunk.split('\n\n')) {
    const line = block.trim();
    if (!line.startsWith('data:')) continue;
    const jsonText = line.slice(5).trim();
    if (!jsonText) continue;
    try { out.push(JSON.parse(jsonText)); } catch { /* partial frame, skip */ }
  }
  return out;
}
