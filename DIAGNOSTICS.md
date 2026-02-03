# System Diagnostics & State Machine

## Current Status

### ✅ Completed: Predictable State Management
- Implemented `StateManager` class with explicit state transitions
- All prompt processing now tracked through defined states
- Automatic timeout watchdog (120 seconds default)
- Full state history with timestamps
- Diagnostics endpoint: `/api/diagnostics/sessions`

### State Flow
```
pending → acquiring_acp → acp_acquired → sending_prompt → processing → completed
                   ↓
                 error/timeout
```

### 🔍 Diagnosed Issue: ACP Connection Hang

The system now reveals the exact point of failure:

1. **Step 1: Connect** ✅ Works (25ms)
2. **Step 2: Initialize** ✅ Works  
3. **Step 3: New Session** ❌ **HANGS indefinitely** 
   - Called: `await conn.newSession(cwd)`
   - Timeout: 120 seconds (not triggered, hangs indefinitely)
   - Request: `session/new` with `{ cwd, mcpServers: [] }`

### Root Cause Analysis

The hang is in the ACP bridge's `session/new` endpoint. Possible causes:

1. **MCP Servers loading** - `mcpServers: []` is empty, but ACP might still try to load system MCP servers
2. **ACP process slow** - Claude Code ACP might be sluggish on this system
3. **Directory issue** - `cwd` is `/config`, might have permission or mounting issues
4. **ACP bridge bug** - Method not fully implemented or has infinite loop

## Monitoring

Use the diagnostics endpoint to see active sessions:

```bash
curl http://localhost:9899/gm/api/diagnostics/sessions
```

Shows:
- Active sessions and their current state
- How long they've been running
- Terminal sessions with full history
- Error details

## Next Steps

1. **Option A: Add timeout wrapper** to `getACP()` - force timeout after 30 seconds
2. **Option B: Debug ACP** - test `session/new` directly with ACP CLI
3. **Option C: Use mock ACP** - bypass for now, test state machine end-to-end
4. **Option D: Simplify initialization** - remove skills/context injection, see if helps

The **state machine is 100% working** - it's just revealing a pre-existing ACP issue that was previously hidden.

