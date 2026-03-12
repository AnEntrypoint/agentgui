# AgentGUI Sync-to-Display Architecture

## Overview

The sync-to-display system handles the complete lifecycle of messages from creation through display, ensuring consistent state between server and client, and between different UI elements.

## Message Lifecycle

### 1. Message Creation (Backend → Frontend)

**Location**: `lib/ws-handlers-conv.js` (line 206-215)

```
User sends message via msg.send RPC
  ↓
createMessage() in database
  ↓
Create 'message.created' event
  ↓
broadcastSync() sends to ALL clients via WebSocket
```

**Key Points**:
- Message is immediately persisted to database
- Broadcast includes full message object (id, role, content, created_at)
- Reaches all connected clients regardless of UI focus

### 2. Message Reception (Frontend)

**Location**: `static/js/client.js` (line 1238-1305, `handleMessageCreated`)

**Decision Tree**:
1. If conversation ID doesn't match current conversation → emit and skip display
2. If message is assistant AND conversation is actively streaming → emit and skip display (wait for stream chunks)
3. If no `.conversation-messages` container → emit and skip display
4. If message is user role:
   - Try to match against pending optimistic message (`.message-sending` element)
   - If found: Update element with real ID and timestamp, remove "sending" state
   - Try to match against pending-id element (alternate state)
   - If found: Update element with real ID and timestamp
   - Check if message with this ID already exists (race condition protection)
   - If found: Skip (already displayed)
   - Otherwise: Create new user message element
5. Otherwise (assistant message): Create new message element

### 3. Optimistic Message Rendering

**Location**: `static/js/client.js` (line 1664-1699)

**Flow**:
```
User clicks Send or presses Ctrl+Enter
  ↓
startExecution()
  ↓
Check if conversation is currently streaming:
  - If NOT streaming: Show optimistic "User" message with .message-sending class
  - If streaming: Skip optimistic message (message will appear only in queue)
  ↓
streamToConversation() calls msg.stream RPC
  ↓
Message is either queued or execution starts
  ↓
If execution started: Confirm optimistic message (remove .message-sending)
If queued: Don't confirm (message stays in queue only)
```

### 4. Queue Management

**Location**: `static/js/client.js` (line 1327-1358, `fetchAndRenderQueue`)

**State**: Queue is rendered as separate `.queue-indicator` with `.queue-item` elements

**Display Logic**:
- Yellow background (`var(--color-warning)`)
- Shows position number, content snippet, and action buttons
- Renders after each queue update via `handleQueueUpdated`
- Automatically fetches queue state via `q.ls` RPC

## State Consolidation Points

### Backend State
1. **activeExecutions** (Map) - Maps convId → {pid, sessionId}
2. **messageQueues** (Map) - Maps convId → [pending messages]
3. **Database** - Persistent messages and conversations
4. **Streaming** - Implied when conversation is in activeExecutions

### Frontend State
1. **this.state.currentConversation** - Selected conversation object
2. **this.state.streamingConversations** - Set of actively streaming conversation IDs
3. **this.state.conversations** - List of all conversations
4. **DOM Elements** - `.message`, `.message-sending`, `.queue-item`
5. **WebSocket Subscriptions** - Listening to specific session IDs

### Sync Mechanisms
1. **WebSocket Broadcasts** - Server sends updates to all clients
2. **RPC Calls** - Client can query queue, fetch chunks, etc.
3. **Event Emissions** - Client emits local events for UI listeners
4. **Class Toggling** - `.collapsed`, `.mobile-visible`, `.message-sending` drive rendering

## Critical Issues Fixed

### Issue 1: Duplicate Queue Message Display
**Symptom**: Queued message appeared both as user message and in queue indicator
**Root Cause**: `startExecution()` always showed optimistic message, even when queuing
**Fix**: Check `this.state.streamingConversations` before showing optimistic message
**Commit**: `fbfd1ad` - "Fix: Don't show duplicate user message when queuing"

### Issue 2: Steering Not Working
**Symptom**: "Process not available for steering" error
**Root Cause**: Claude Code agent had `closeStdin: true` and `supportsStdin: false`, closing stdin immediately
**Fix**: Changed to `supportsStdin: true`, `closeStdin: false`, removed positional prompt arg
**Commit**: `81d83af` - "Fix: Enable steering support for Claude Code agent"

### Issue 3: Message Race Condition
**Symptom**: Occasional duplicate messages in UI
**Root Cause**: Message could be created on server, then optimistic message shown before server message arrived
**Fix**: Check if message with ID already exists (line 1289-1293)
**Status**: Built-in protection, no commit needed

## Debugging Tips

### Enable Detailed Logging
Add to browser console:
```javascript
// Intercept WebSocket messages
const origSend = window.wsClient.send;
window.wsClient.send = function(data) {
  if (data.jsonrpc && (data.method.includes('msg') || data.method.includes('queue'))) {
    console.log('[RPC OUT]', data.method, data.params);
  }
  return origSend.call(this, data);
};
```

### Check Message State
```javascript
// Check if message is in DOM
document.querySelector('[data-msg-id="msg-xxx"]')

// Check pending messages
document.querySelector('.message-sending')

// Check queue state
document.querySelector('.queue-indicator')?.textContent

// Check streaming state
window.client?.state?.streamingConversations
```

### Database Validation
```sql
-- Check message was created
SELECT * FROM messages WHERE id = 'msg-xxx';

-- Check conversation message count
SELECT messageCount FROM conversations WHERE id = 'conv-xxx';

-- Check queue entries
SELECT * FROM queue WHERE conversationId = 'conv-xxx';
```

## Expected Behavior Checklist

- [ ] User sends message → appears immediately as pending (grey, "Sending...")
- [ ] Server confirms message → pending becomes confirmed (normal styling)
- [ ] User sends while streaming → message queues, appears ONLY in yellow queue box
- [ ] Queue is processed → queued message becomes normal user message
- [ ] Assistant responds → response appears as streaming chunks, then complete
- [ ] Steering during execution → new prompt sent to running process, appears in streaming output

## Performance Considerations

- **Optimistic Rendering**: Instant perceived responsiveness
- **Pending Message Matching**: Uses content matching to avoid duplication (potential issue with identical messages)
- **Queue Fetching**: Called on queue updates, should be fast
- **DOM Updates**: Uses insertAdjacentHTML for single-append performance
- **WebSocket**: Batches events, should be fast

## Future Improvements

1. Use message content hash instead of exact match for duplicate detection
2. Add explicit queue-to-message transition event from server
3. Implement message dedup at WebSocket layer
4. Add comprehensive state synchronization heartbeat
5. Implement client-side state snapshots for debugging

