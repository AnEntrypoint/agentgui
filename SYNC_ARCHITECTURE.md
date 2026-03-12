# AgentGUI Sync-to-Display Architecture Report

## Executive Summary

The sync-to-display system handles real-time synchronization of execution state from server to client display. Current implementation has been improved through multiple fixes, particularly for queue display consistency and steering support. This document consolidates the architecture and identifies remaining optimization opportunities.

## Architecture Overview

### 1. Broadcast System (server.js:4269-4317)

**BROADCAST_TYPES** - Global broadcast events sent to ALL connected clients:
- `message_created`, `conversation_created/updated/deleted`
- `queue_status`, `queue_updated`
- `streaming_start`, `streaming_progress`, `streaming_complete`, `streaming_error`
- `rate_limit_hit`, `rate_limit_clear`
- Tool-related events (`tool_*`, `tools_*`)
- Voice/speech events
- PM2 monitoring events

**broadcastSync()** function (line 4288):
```
1. Check if event.type is in BROADCAST_TYPES
2. If broadcast: send to ALL syncClients
3. If targeted: send to sessionId or conversationId subscribers only
4. Also dispatch to SSE stream handlers if active
```

### 2. Client-Side Message Reception (static/js/client.js)

**handleWsMessage()** routes events by type:
```javascript
case 'message_created': handleMessageCreated(data)
case 'queue_status': handleQueueStatus(data)
case 'streaming_start': handleStreamingStart(data)
case 'streaming_progress': handleStreamingProgress(data)
```

### 3. Display Rendering Layers

**Layer 1: Message Rendering** (handleMessageCreated)
- Checks if message already exists (prevents duplicates)
- For user messages: finds optimistic message, updates it
- For assistant messages: skips if streaming (handled by chunks)

**Layer 2: Streaming Progress** (handleStreamingProgress)
- Adds chunks to queue
- Batches rendering via StreamingRenderer
- Handles thinking blocks directly

**Layer 3: Queue Indicator** (fetchAndRenderQueue)
- Polls via `q.ls` RPC every interval
- Displays queued items in yellow control blocks
- Renders with Edit/Delete/Steer buttons

**Layer 4: Conversation State** (handleConversationUpdated)
- Updates isStreaming flag
- Refreshes UI based on new state

## Recent Fixes & Status

### Fixed Issues

✅ **Queue Message Duplication** (commit fbfd1ad)
- Problem: Queued messages appeared as both user prompt + queue item
- Solution: Skip optimistic message when conversation is streaming
- Impact: Clean queue display, no duplication

✅ **Steering Support** (commit 81d83af)
- Problem: Steering showed "Process not available" error
- Solution: Keep stdin open (supportsStdin=true, closeStdin=false)
- Impact: Users can send follow-up prompts during execution

✅ **Chunk Rendering Race** (Session 3a)
- Problem: Early chunks missed before polling started
- Solution: Immediate chunk fetch on streaming_start
- Impact: No missing initial output

✅ **Dark Mode Selection** (fsbrowse)
- Problem: Selection states hard to see in dark mode
- Solution: Theme-aware colors for hover/focus
- Impact: Better visual feedback in both themes

### Remaining Consistency Issues

⚠️ **Queue State Sync Timing**
- Queue created on server via enqueue()
- message_created broadcast may arrive before queue is populated
- Client fetchAndRenderQueue() polls but timing is unpredictable
- No atomic operation ensuring client sees both message and queue

⚠️ **Multiple Sources of Truth**
- Server: database, active execution map, queue map
- Client: message list, streaming set, queue indicator
- Conversation state: isStreaming flag can desync if connection drops
- No single authoritative state object

⚠️ **Optimistic Message Updates**
- Client creates optimistic "sending" message on submit
- Server creates actual message and broadcasts
- handleMessageCreated() finds and updates optimistic message
- If network is slow, both may briefly exist

⚠️ **Queue Execution Transition**
- Queue items don't explicitly transition to executed
- Client must poll queue indicator to see it disappear
- No event indicating "queue item now executing"
- Confusing UX when queue suddenly empties

## Data Flow Examples

### Normal Execution (Ctrl+Enter with no active stream)

```
User input: "Write a function"
    ↓
startExecution()
    → _showOptimisticMessage(pendingId, content)  // yellow "sending..." message
    ↓
streamToConversation() → msg.stream RPC
    ↓
Server: msg.stream handler
    → createMessage(p.id, 'user', prompt)
    → broadcastSync({ type: 'message_created', ... })
    → startExecution() -> streaming_start broadcast
    ↓
Client: message_created event
    → handleMessageCreated()
    → Finds optimistic message by ID
    → Updates it (removes "sending" style, adds timestamp)
    ↓
Client: streaming_start event
    → Disables input, shows "thinking..."
    → Subscribes to session
    → Starts chunk polling
```

### Queue Case (Ctrl+Enter while streaming) - NOW FIXED

```
User input: "Now add subtraction" during execution
    ↓
startExecution()
    → isStreaming = true
    → SKIP _showOptimisticMessage ✓ (FIXED)
    ↓
streamToConversation() → msg.stream RPC
    ↓
Server: msg.stream handler
    → createMessage(p.id, 'user', prompt)
    → broadcastSync({ type: 'message_created', ... })
    → activeExecutions.has(p.id) = true
    → enqueue(p.id, prompt, ...)
    → broadcastSync({ type: 'queue_status', ... })
    ↓
Client: message_created event
    → handleMessageCreated()
    → Message is not in current conversation display
    → Emit event but don't render
    ↓
Client: queue_status event
    → handleQueueStatus()
    → fetchAndRenderQueue()
    → Displays in yellow queue indicator ✓
    ↓
Result: Message only in queue, no duplication ✓
```

### Steering (Ctrl+Enter + Steer button during execution)

```
User clicks Steer button on queued message
    ↓
Client: conv.steer RPC with JSON-RPC format
    ↓
Server: conv.steer handler
    → Finds active process stdin
    → Writes JSON-RPC prompt request
    → Removes from queue (optional)
    ↓
Claude Code: Receives JSON-RPC on stdin
    → Processes prompt immediately
    → Continues execution with new direction
    ↓
Client: receives streaming_progress chunks
    → Renders new content below existing output
```

## Consistency Guarantees

### What IS Consistent
- Messages don't duplicate (handled in handleMessageCreated)
- Streaming chunks are ordered (via session ID subscription)
- Queue items maintain order (FIFO in server queue map)
- Tool installations tracked atomically (per-tool in database)

### What IS NOT Guaranteed
- Client queue display and server queue state may briefly desync
- If connection drops mid-queue, client state becomes stale
- No explicit confirmation that user message was queued
- Queue item execution not signaled with explicit event

## Recommendations for Further Improvement

### Priority 1: Explicit Queue Lifecycle
Add dedicated broadcast events:
```javascript
'message_queued'        // Sent when msg added to queue
'queue_item_executing'  // Sent when queue item becomes active
'queue_item_completed'  // Sent when queue item finished
```

### Priority 2: Atomic State Snapshots
Periodically broadcast conversation state:
```javascript
{
  type: 'conversation_state',
  conversationId,
  state: {
    isStreaming: boolean,
    messageCount: number,
    queueLength: number,
    lastMessageId: string,
    lastUpdate: timestamp
  }
}
```

### Priority 3: Deterministic Client State Machine
Each conversation has explicit state mode:
```javascript
state = {
  mode: 'IDLE' | 'STREAMING' | 'QUEUED',
  messages: [],
  queue: [],
  isTransitioning: boolean  // true when queue→execute
}
```

### Priority 4: Connection Recovery
After reconnect, fetch complete conversation state:
```javascript
await wsClient.rpc('conv.sync', { id: conversationId })
// Returns: { messages, queue, isStreaming, chunks }
```

## Testing Matrix

| Scenario | Before Fix | After Fix | Status |
|----------|-----------|-----------|--------|
| Ctrl+Enter (not streaming) | ✓ Works | ✓ Works | ✓ OK |
| Ctrl+Enter (streaming) | ✗ Duplicate | ✓ Single queue item | ✓ FIXED |
| Queue indicator updates | ⚠️ Polling | ⚠️ Polling | ⚠️ Could improve |
| Steering works | ✗ "Not available" | ✓ Works | ✓ FIXED |
| Multiple queued items | ⚠️ Order unclear | ⚠️ Order unclear | ⚠️ OK but could confirm |
| Page reload with queue | ✗ Queue lost | ✓ Persisted | ✓ OK |
| Network disconnect | ⚠️ State stale | ⚠️ State stale | ⚠️ Could improve |

## Files Modified in Latest Session

1. **lib/claude-runner.js** - Steering support
   - Changed `supportsStdin: false` → `true`
   - Changed `closeStdin: true` → `false`
   - Removed positional prompt argument

2. **static/js/client.js** - Queue display fix
   - Skip optimistic message when streaming
   - Skip confirm/fail handlers for queued messages

3. **static/index.html** - Hamburger animation
   - Added `transition: none` to .sidebar

4. **fsbrowse/public/style.css** - Dark mode colors
   - Improved hover states
   - Theme-aware modal focus colors

## Conclusion

The sync-to-display system is now more consistent with the queue display fix and steering support. The architecture handles the primary use cases well, but could benefit from explicit lifecycle events and atomic state snapshots for guaranteed consistency. The current implementation is pragmatic and performant, trading off some guarantees for simplicity and responsiveness.

