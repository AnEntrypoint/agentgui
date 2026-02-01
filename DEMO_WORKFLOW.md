# Complete Workflow Demo - Atomic Persistence in Action

## Scenario: Client Sends Message, Network Fails, Reconnects

### Step 1: Client Creates Conversation
```bash
POST /api/conversations
{ "agentId": "claude-code", "title": "Atomic Test" }

Response:
{
  "conversation": {
    "id": "conv-1234567890-abc123",
    "agentId": "claude-code",
    "title": "Atomic Test",
    "created_at": 1234567890,
    "updated_at": 1234567890,
    "status": "active"
  }
}
```

**Database State**:
```json
{
  "conversations": {
    "conv-1234567890-abc123": { ... }
  }
}
```

### Step 2: Client Sends Message (with Idempotency Key)
```bash
POST /api/conversations/conv-1234567890-abc123/messages
{
  "content": "What is machine learning?",
  "agentId": "claude-code",
  "folderContext": { "path": "/config", "isFolder": true },
  "idempotencyKey": "msg-1234567890-xyz789"
}

Response (201 Created):
{
  "message": {
    "id": "msg-1234567890-msg123",
    "conversationId": "conv-1234567890-abc123",
    "role": "user",
    "content": "What is machine learning?",
    "created_at": 1234567890
  },
  "session": {
    "id": "sess-1234567890-sess123",
    "conversationId": "conv-1234567890-abc123",
    "status": "pending",
    "started_at": 1234567890,
    "completed_at": null,
    "response": null,
    "error": null
  },
  "idempotencyKey": "msg-1234567890-xyz789"
}
```

**Database State**:
```json
{
  "messages": {
    "msg-1234567890-msg123": {
      "id": "msg-1234567890-msg123",
      "conversationId": "conv-1234567890-abc123",
      "role": "user",
      "content": "What is machine learning?",
      "created_at": 1234567890
    }
  },
  "sessions": {
    "sess-1234567890-sess123": {
      "id": "sess-1234567890-sess123",
      "conversationId": "conv-1234567890-abc123",
      "status": "pending",
      "started_at": 1234567890,
      "completed_at": null,
      "response": null,
      "error": null
    }
  },
  "events": {
    "evt-...": {
      "type": "message.created",
      "conversationId": "conv-1234567890-abc123",
      "data": { "role": "user", "messageId": "msg-1234567890-msg123" },
      "created_at": 1234567890
    },
    "evt-...": {
      "type": "session.created",
      "conversationId": "conv-1234567890-abc123",
      "sessionId": "sess-1234567890-sess123",
      "data": { "messageId": "msg-1234567890-msg123", "sessionId": "sess-1234567890-sess123" },
      "created_at": 1234567890
    }
  },
  "idempotencyKeys": {
    "msg-1234567890-xyz789": {
      "value": { "id": "msg-1234567890-msg123", ... },
      "created_at": 1234567890,
      "ttl": 86400000
    }
  }
}
```

**Server Event (Broadcast)**:
```json
WebSocket Message to all /sync clients:
{
  "type": "message_created",
  "conversationId": "conv-1234567890-abc123",
  "message": { ... }
}
```

**Client State**:
- Message displayed in UI
- Waiting for server to process (stream WebSocket connection)
- `idempotencyKey` stored locally: `msg-1234567890-xyz789 -> sess-1234567890-sess123`

---

### Step 3: Server Processes Message
```
Internal: processMessage() called with sessionId
1. Update session status -> "processing"
2. Broadcast: type: "status", status: "processing"
3. Connect to agent
4. Stream response...
5. Create assistant message
6. Update session status -> "completed"
7. Broadcast: type: "session_updated", status: "completed", message: {...}
```

**Session Status Transition**:
```
pending -> processing -> completed
```

**Events Created**:
```json
{
  "type": "session.processing",
  "sessionId": "sess-1234567890-sess123"
}
{
  "type": "session.completed",
  "sessionId": "sess-1234567890-sess123",
  "data": { "messageId": "msg-1234567890-assistant" }
}
```

---

### Step 4: Network Fails - Client Loses Connection

**Client State**:
- WebSocket disconnected
- Message still shown in UI
- Session ID stored: `sess-1234567890-sess123`
- Idempotency key cached locally

---

### Step 5: Client Reconnects (Network Restored)

**Client Checks Latest Session**:
```bash
GET /api/conversations/conv-1234567890-abc123/sessions/latest

Response (200 OK):
{
  "session": {
    "id": "sess-1234567890-sess123",
    "conversationId": "conv-1234567890-abc123",
    "status": "completed",
    "started_at": 1234567890,
    "completed_at": 1234567891,
    "response": {
      "text": "Machine learning is a subset of artificial intelligence...",
      "messageId": "msg-1234567890-assistant"
    },
    "error": null
  },
  "events": [...]
}
```

**Client Logic**:
```javascript
const latestSession = await fetchLatestSession(convId);

if (latestSession.status === 'processing') {
  // Resume streaming
  this.streamResponse(convId);
} else if (latestSession.status === 'completed') {
  // Display already-completed response
  this.addMessageToDisplay(latestSession.response);
}

// Result: User sees response immediately without reprocessing
```

---

### Step 6: Client Retries Same Message (Network Error Earlier)

**If network failed before receiving response**:
```bash
POST /api/conversations/conv-1234567890-abc123/messages
{
  "content": "What is machine learning?",
  "agentId": "claude-code",
  "folderContext": { "path": "/config", "isFolder": true },
  "idempotencyKey": "msg-1234567890-xyz789"  // SAME KEY
}

Response (201 Created):
{
  "message": {
    "id": "msg-1234567890-msg123",  // SAME MESSAGE ID
    "conversationId": "conv-1234567890-abc123",
    "role": "user",
    "content": "What is machine learning?",
    "created_at": 1234567890
  },
  "session": {
    "id": "sess-1234567890-sess123",
    "conversationId": "conv-1234567890-abc123",
    "status": "pending",
    ...
  },
  "idempotencyKey": "msg-1234567890-xyz789"
}
```

**Why No Duplicate?**
```
Server Flow:
1. Extract idempotencyKey: "msg-1234567890-xyz789"
2. Call createMessage(convId, "user", content, idempotencyKey)
3. Inside createMessage:
   - Check cache: getIdempotencyKey("msg-1234567890-xyz789")
   - Found! Return cached message ID: "msg-1234567890-msg123"
   - No new message created
4. Return same message object
```

**Database**:
- Still 1 message (no duplicate)
- Idempotency key cache hit
- No new session created

---

### Step 7: Multiple Clients on Same Conversation

**Client A**:
```bash
POST /api/conversations/conv-1234567890-abc123/messages
{ "content": "Question 1", "idempotencyKey": "client-a-msg1" }

Message A created: msg-client-a-1
```

**Client B** (simultaneously):
```bash
POST /api/conversations/conv-1234567890-abc123/messages
{ "content": "Question 2", "idempotencyKey": "client-b-msg1" }

Message B created: msg-client-b-1
```

**Both Clients Fetch Messages**:
```bash
GET /api/conversations/conv-1234567890-abc123/messages

Response:
{
  "messages": [
    {
      "id": "msg-client-a-1",
      "role": "user",
      "content": "Question 1",
      "created_at": 1234567890
    },
    {
      "id": "msg-client-b-1",
      "role": "user",
      "content": "Question 2",
      "created_at": 1234567891
    }
  ]
}
```

**Consistency**:
- Both clients see both messages
- Order preserved (A before B)
- No duplicates
- No data loss

**WebSocket Sync Event** (Broadcast to all):
```json
{
  "type": "message_created",
  "conversationId": "conv-1234567890-abc123",
  "message": {
    "id": "msg-client-a-1",
    "role": "user",
    "content": "Question 1"
  }
}

// Then
{
  "type": "message_created",
  "conversationId": "conv-1234567890-abc123",
  "message": {
    "id": "msg-client-b-1",
    "role": "user",
    "content": "Question 2"
  }
}
```

---

## Guarantees Demonstrated

### 1. Atomic Persistence
✓ Message persisted before response (Step 2)
✓ Session status updated atomically (Step 3)
✓ Events created for audit trail

### 2. Idempotency
✓ Retry with same key = same message (Step 6)
✓ No duplicates created
✓ No additional database writes

### 3. Session Recovery
✓ Client reconnects and checks status (Step 5)
✓ Can resume or display completed response
✓ No need to reprocess

### 4. Multi-Client Consistency
✓ Multiple clients see same messages (Step 7)
✓ Order preserved across clients
✓ Sync events keep everyone updated

### 5. Event Sourcing
✓ Every change recorded
✓ Can replay to rebuild state
✓ Complete audit trail

---

## Error Scenario: What If Server Crashes?

**If server crashes during processing (Step 3)**:

On restart:
1. Database is loaded from disk (latest state)
2. Session status = "processing"
3. Client reconnects, checks latest session
4. Detects "processing" status
5. Resumes streaming or retries

**No Message Loss**:
- Original user message already saved
- Session created and saved
- Client can retry safely

**On Retry**:
- Uses same idempotencyKey
- Server returns cached result
- No duplicate processing
