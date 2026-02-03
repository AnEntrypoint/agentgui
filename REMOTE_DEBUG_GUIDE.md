# Remote Server Debugging Guide

## Issue
Conversations are not displaying in AgentGUI on remote server (https://buildesk.acc.l-inc.co.za/gm/), even though:
- ✅ The application loads
- ✅ The layout works
- ✅ The sidebar is visible

## Root Cause Analysis

### On Local Server ✅
- 83 conversations stored in `~/.gmgui/data.db`
- 68 Claude Code conversations discovered in `~/.claude/projects/`
- All 68 imported successfully
- API returns conversations correctly
- Frontend fetches and displays them

### On Remote Server ❓
- Unknown database state
- Unknown Claude Code availability
- Conversations showing as empty

## Diagnostic Checklist

### 1. Check if API is returning conversations

In browser console:
```javascript
fetch('/gm/api/conversations')
  .then(r => r.json())
  .then(d => console.log('Conversations from API:', d.conversations?.length || 0))
```

If this returns 0: **Database is empty or API is failing**
If this returns > 0: **API is working, issue is in frontend**

### 2. Check frontend state

In browser console:
```javascript
// Check if app was initialized
console.log('app.conversations.size:', app.conversations.size);

// If size is 0, check if fetchConversations was called
console.log('API returned data:', app.conversations);

// Force a refetch
await app.fetchConversations();
console.log('After refetch:', app.conversations.size);

// If still 0, render to see debug info
app.renderChatHistory();
```

### 3. Manually trigger import

In browser console:
```javascript
// Try to import Claude Code conversations
await fetch('/gm/api/import/claude-code')
  .then(r => r.json())
  .then(d => console.log('Import result:', d));
```

Then refetch:
```javascript
await app.fetchConversations();
app.renderChatHistory();
```

### 4. Check Claude Code projects

In terminal on remote server:
```bash
# Check if Claude Code directory exists
ls -la ~/.claude/projects/

# List all projects
find ~/.claude/projects -name "sessions-index.json" 2>/dev/null | wc -l

# Check first project
ls -la ~/.claude/projects/ | head
```

If directory doesn't exist or is empty: **Claude Code hasn't been used on this server**

### 5. Check database directly

In terminal on remote server:
```bash
# Check database location (should be ~/.gmgui/data.db)
ls -lh ~/.gmgui/data.db

# Get conversation count (if Node/better-sqlite3 available)
node -e "
const DB = require('better-sqlite3');
const db = new DB(process.env.HOME + '/.gmgui/data.db');
const count = db.prepare('SELECT COUNT(*) as c FROM conversations').get();
console.log('DB Conversations:', count.c);
db.close();
"
```

If file doesn't exist: **Database not initialized**
If count is 0: **No conversations in database**

## Solutions by Scenario

### Scenario A: API returns 0, Database is empty
**Problem:** No conversations to display (first time setup)
**Solution:** 
1. Import Claude Code conversations (if available)
2. Or create new conversations
3. Or import from JSON

### Scenario B: API returns conversations, Frontend shows 0
**Problem:** Frontend not fetching/displaying properly
**Solution:**
1. Check browser console for errors
2. Check [DEBUG] logs
3. Try `_debug.forceRefetch()` in console
4. Check if BASE_URL is set correctly

### Scenario C: Claude Code projects exist but no conversations
**Problem:** Discovered conversations but not imported
**Solution:**
1. Open browser console
2. Call import endpoint
3. Call `app.fetchConversations()`
4. Call `app.renderChatHistory()`

### Scenario D: Conversations exist but frontend won't display
**Problem:** Rendering issue
**Solution:**
1. Check HTML element `#chatList` exists
2. Check CSS isn't hiding it
3. Check for JavaScript errors
4. Test `_debug.forceRefetch()`

## What to Look For in Console

When page loads, should see these logs:
```
[DEBUG] Init: Starting initialization
[DEBUG] Init: BASE_URL = /gm
[DEBUG] Init: Window width: XXXX
[DEBUG] Init: Fetched agents, count: X
[DEBUG] Init: Auto-imported Claude Code conversations
[DEBUG] fetchConversations: Starting fetch from /gm/api/conversations
[DEBUG] fetchConversations response count: X
[DEBUG] Init: Fetched conversations, count: X
[DEBUG] renderChatHistory - conversations.size: X
```

If you see `conversations.size: 0` anywhere, that's the issue.

## Commands to Run in Browser Console

```javascript
// 1. Comprehensive status check
{
  api: await fetch('/gm/api/conversations').then(r => r.json()).then(d => d.conversations?.length),
  app: app.conversations.size,
  baseUrl: BASE_URL,
  windowWidth: window.innerWidth,
  chatList: !!document.getElementById('chatList'),
  agents: app.agents.size
}

// 2. Force refetch and render
await app.fetchConversations();
app.renderChatHistory();
window.app.conversations.size

// 3. Check Claude Code availability
await fetch('/gm/api/discover/claude-code').then(r => r.json()).then(d => console.log('Claude Code available:', d.discovered?.length))

// 4. Manual import
await fetch('/gm/api/import/claude-code').then(r => r.json()).then(d => console.log('Import:', d))
```

## Expected Behavior

**After Fix:**
1. Page loads
2. Console shows [DEBUG] logs
3. Page title shows "GMGUI (XX chats)"
4. Sidebar shows conversation list
5. Can click conversation to view it
6. Can create new conversations
7. Can import Claude Code conversations

## If Still Stuck

1. **Collect information:**
   - Output of all console commands above
   - Screenshot of browser console showing all [DEBUG] logs
   - Output of `echo $HOME` on remote server
   - Output of `ls -la ~/.claude/projects/` on remote server
   - Output of `ls -la ~/.gmgui/` on remote server

2. **Share these logs** for remote debugging

3. **Try manual steps:**
   - In console: `await _debug.forceRefetch()`
   - Then: `app.renderChatHistory()`
   - Screenshot result

## Important Notes

- `~/.gmgui/data.db` - AgentGUI database (stores conversations)
- `~/.claude/projects/` - Claude Code storage (where conversations come from)
- `/gm/api/conversations` - Endpoint to get all conversations
- `/gm/api/discover/claude-code` - Find available Claude Code conversations
- `/gm/api/import/claude-code` - Import Claude Code conversations to AgentGUI

## Performance Tip

If you have lots of conversations (100+), they might load slowly. You can paginate by checking:
```javascript
// Check how many are in the list element
document.getElementById('chatList').children.length
```

If this is less than the API count, pagination is needed (future enhancement).
