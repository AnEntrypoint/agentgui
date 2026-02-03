# State Machine Implementation - Checklist & Reference

## ✅ Completed Features

### Core State Machine
- [x] StateManager class with 9 defined states
- [x] State transition validation
- [x] Invalid transition guards (throw errors)
- [x] State history tracking with timestamps
- [x] Reason/metadata for each transition
- [x] Automatic 120-second timeout watchdog
- [x] Promise-based completion API
- [x] Terminal state detection
- [x] State history retrieval

### Session Management
- [x] SessionStateStore global registry
- [x] Session creation with ID tracking
- [x] Session retrieval and validation
- [x] Active session filtering
- [x] Terminal session tracking
- [x] Automatic cleanup (>1 hour)
- [x] Diagnostic aggregation

### Server Integration
- [x] Import StateManager in server.js
- [x] Create global SessionStateStore
- [x] Rewrite processMessage() to use state machine
- [x] Add state transitions for each step
- [x] Implement error handling with state tracking
- [x] Add getACP() timeout protection (60s)
- [x] Create /api/diagnostics/sessions endpoint
- [x] Add comprehensive logging

### Database Fixes
- [x] Fix message content type handling (stringify objects)
- [x] Fix session response/error serialization
- [x] Fix event data JSON handling
- [x] Fix idempotencyKeys type conversion

### Documentation
- [x] StateManager code comments
- [x] Architecture diagrams
- [x] Usage examples
- [x] Monitoring guide
- [x] Diagnostics explanation
- [x] Issue diagnosis (ACP hang)
- [x] Next steps guide

---

## 📊 State Machine States

```
PENDING
  ↓
ACQUIRING_ACP  ← Connect to Claude Code ACP
  ↓
ACP_ACQUIRED   ← Connection established
  ↓
SENDING_PROMPT ← Sending prompt to ACP
  ↓
PROCESSING     ← Processing response
  ↓
COMPLETED      ← ✅ Success

ERROR          ← ❌ Any step failed (at any point)
TIMEOUT        ← ❌ Exceeded 120s (automatic)
CANCELLED      ← Stopped by user
```

---

## 🔍 Diagnostics Endpoint

**Endpoint**: `GET /api/diagnostics/sessions`

**Response Format**:
```javascript
{
  timestamp: ISO 8601 string,
  activeSessions: number,
  terminalSessions: number,
  totalSessions: number,
  active: [
    {
      sessionId: string,
      state: string,
      uptime: milliseconds
    }
  ],
  recentTerminal: [
    {
      sessionId: string,
      conversationId: string,
      messageId: string,
      state: 'completed'|'error'|'timeout'|'cancelled',
      duration: '1234ms',
      historyLength: number,
      history: ['0ms: pending (initialized)', ...],
      data: {
        fullTextLength: number,
        blocksCount: number,
        error: null | string,
        hasStackTrace: boolean
      }
    }
  ]
}
```

---

## 🚀 Usage Examples

### Create a Session
```javascript
const stateManager = sessionStateStore.create(
  sessionId,
  conversationId,
  messageId,
  120000  // timeout in ms
);
```

### Transition State
```javascript
stateManager.transition(StateManager.STATES.ACQUIRING_ACP, {
  reason: 'Starting ACP connection',
  data: {}
});
```

### Check Current State
```javascript
const state = stateManager.getState();
// 'pending' | 'acquiring_acp' | 'acp_acquired' | ...
```

### Get Full History
```javascript
const history = stateManager.getHistory();
// Array of {state, timestamp, reason, details}
```

### Wait for Completion
```javascript
try {
  const result = await stateManager.waitForCompletion();
  console.log(`Success in ${result.data.duration}`);
} catch (err) {
  console.error(`Failed: ${err.message}`);
}
```

### Get Diagnostics
```javascript
const diag = sessionStateStore.getDiagnostics();
console.log(`Active: ${diag.activeSessions}`);
console.log(`Terminal: ${diag.terminalSessions}`);
```

---

## 🛡️ Error Handling

### Invalid Transition
```javascript
// This will throw!
stateManager.transition(StateManager.STATES.COMPLETED, {});
// Error: "Invalid state transition: pending → completed. Valid: [acquiring_acp, cancelled]"
```

### Session Not Found
```javascript
const manager = sessionStateStore.getOrThrow(sessionId);
// Throws if sessionId doesn't exist
```

### Timeout
```javascript
// After 120 seconds in any non-terminal state:
// Automatically transitions to TIMEOUT state
```

---

## 📝 Logging Output

### State Transition Log
```
[StateManager] sess-123 transitioned: pending → acquiring_acp (+1ms) | Starting ACP connection
[StateManager] sess-123 transitioned: acquiring_acp → acp_acquired (+25ms) | ACP connected
[StateManager] sess-123 transitioned: acp_acquired → sending_prompt (+0ms) | Sending to ACP
[StateManager] sess-123 transitioned: sending_prompt → processing (+100ms) | Processing response
[StateManager] sess-123 transitioned: processing → completed (+2145ms) | Response successfully generated
```

### Process Message Log
```
[processMessage] Starting: conversationId=conv-123, sessionId=sess-456
[processMessage] Initial state: pending
[getACP] Step 1: Connecting to claude-code...
[getACP] Step 2: Connected, initializing...
[getACP] Step 3: Initialized, creating session...
[getACP] ✅ ACP connection ready for claude-code in /config
[processMessage] Sending prompt to ACP (45 chars)
[processMessage] ACP returned: stopReason=end_turn, fullText=12345 chars
[processMessage] ✅ Session completed: 2567ms
```

---

## 🔧 Configuration

### Timeouts
- **Session timeout**: 120 seconds (hardcoded)
- **ACP timeout**: 60 seconds (hardcoded in getACP)
- **Session cleanup TTL**: 3600000ms (1 hour)

### Cleanup Schedule
- Runs every 10 minutes (600000ms)
- Removes terminal sessions older than 1 hour

### Data Retention
- Recent terminal sessions: kept in memory indefinitely
- Cleanup prevents unbounded memory growth

---

## 🐛 Debugging

### See All Active Sessions
```bash
curl http://localhost:9899/gm/api/diagnostics/sessions | grep -A 5 "active"
```

### Find Stuck Sessions
```bash
curl http://localhost:9899/gm/api/diagnostics/sessions | grep "acquiring_acp"
```

### Get Session History
```bash
curl http://localhost:9899/gm/api/diagnostics/sessions | grep -A 20 "recentTerminal"
```

### Follow State Transitions
```bash
tail -f server.log | grep "StateManager"
```

### Find Errors
```bash
tail -f server.log | grep -E "ERROR|Stack:|❌"
```

---

## 📚 Files Modified

| File | Changes | Lines |
|------|---------|-------|
| state-manager.js | NEW | 350 |
| server.js | Modified | +300, -80 |
| database.js | Fixed | +40 |
| DIAGNOSTICS.md | NEW | 80 |
| STATE_MACHINE_SUMMARY.md | NEW | 220 |

---

## ✨ Key Improvements

**Before State Machine**:
- ❌ Fire-and-forget processing
- ❌ No visibility into failures
- ❌ Hangs cause no feedback
- ❌ Hidden race conditions
- ❌ Impossible to debug

**After State Machine**:
- ✅ Every session tracked
- ✅ Complete visibility
- ✅ Immediate timeout detection
- ✅ Explicit error handling
- ✅ Full audit trail

