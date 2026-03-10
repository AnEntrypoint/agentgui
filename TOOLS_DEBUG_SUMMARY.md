# Tools Tracking & Version Detection - Complete Fix Summary

## Issues Found & Fixed

### 1. **Incorrect pluginId Mappings**
**Problem:** All plugin tools were using wrong `pluginId` values, causing version detection to fail.

**Root Cause:**
- `gm-cc` was configured with `pluginId: 'gm'` but installs to `~/.claude/plugins/gm-cc/`
- `gm-oc`, `gm-kilo`, `gm-gc` were using their tool IDs as pluginIds, but they install as `gm.md` files

**Solution:**
- Fixed `gm-cc` to use `pluginId: 'gm-cc'`
- Kept `gm-oc`, `gm-kilo`, `gm-gc` with `pluginId: 'gm'` (the actual shared agent name)

### 2. **Missing Framework Parameter**
**Problem:** Version detection couldn't distinguish which framework a tool belonged to.

**Root Cause:** Tools across different frameworks (Claude Code, OpenCode, Gemini, Kilo) were conflicting when they shared agent names.

**Solution:** Added `frameWork` parameter to each tool config:
```javascript
{ id: 'gm-cc', frameWork: 'claude', pluginId: 'gm-cc' }
{ id: 'gm-oc', frameWork: 'opencode', pluginId: 'gm' }
{ id: 'gm-gc', frameWork: 'gemini', pluginId: 'gm' }
{ id: 'gm-kilo', frameWork: 'kilo', pluginId: 'gm' }
```

### 3. **Wrong Version Detection Paths**
**Problem:** Claude Code version detection was looking in `~/.claude/plugins/{pluginId}/plugin.json` but real files exist at `~/.claude/plugins/{toolId}/plugin.json`

**Solution:** Updated `getInstalledVersion()` to check correct paths:
- Claude Code: `~/.claude/plugins/gm-cc/plugin.json`
- OpenCode: `~/.config/opencode/agents/gm.md` (framework-specific)
- Gemini: `~/.gemini/extensions/gm/gemini-extension.json`
- Kilo: `~/.config/kilo/agents/gm.md` (framework-specific)

### 4. **No Fallback for Multi-Framework Bundle Versions**
**Problem:** Tools like `gm-oc`, `gm-kilo` that use shared `gm` agent name had no version info in the `.md` files, returning generic 'installed' status.

**Solution:** Added fallback to check npm package cache for version info:
```javascript
// Check ~/.gmweb/cache/.bun/install/cache/gm-oc@2.0.92@@@1/package.json
const cacheDirs = fs.readdirSync(pkgJsonPath).filter(d => d.startsWith(pkg + '@'));
const latestDir = cacheDirs.sort().reverse()[0];
// Extract version from latest cached package.json
```

### 5. **Streaming Complete Not Being Caught** *(Secondary Issue)*
**Status:** Already correctly implemented
- `streaming_complete` event IS in BROADCAST_TYPES
- Event IS being broadcast after Claude outputs complete
- Frontend IS handling it in `handleStreamingComplete()`
- Thinking countdown IS being cleared

## Test Results

### Before Fix:
```
gm-cc: installed=false, version=null
gm-oc: installed=true, version='installed' (wrong!)
gm-kilo: installed=true, version='installed' (wrong!)
gm-gc: installed=true, version=null (not detecting)
```

### After Fix:
```
gm-cc: installed=true, v2.0.92 (published: v2.0.92) ✓
gm-oc: installed=true, v2.0.92 (published: v2.0.92) ✓
gm-kilo: installed=true, v2.0.92 (published: v2.0.92) ✓
gm-gc: installed=true, v2.0.86 (published: v2.0.92) - shows needs update ✓
```

## Critical Fix in lib/tool-manager.js

### Tool Definitions (lines 13-16):
```javascript
{ id: 'gm-cc', name: 'GM Claude', pkg: 'gm-cc', pluginId: 'gm-cc', category: 'plugin', frameWork: 'claude' },
{ id: 'gm-oc', name: 'GM OpenCode', pkg: 'gm-oc', pluginId: 'gm', category: 'plugin', frameWork: 'opencode' },
{ id: 'gm-gc', name: 'GM Gemini', pkg: 'gm-gc', pluginId: 'gm', category: 'plugin', frameWork: 'gemini' },
{ id: 'gm-kilo', name: 'GM Kilo', pkg: 'gm-kilo', pluginId: 'gm', category: 'plugin', frameWork: 'kilo' },
```

### getInstalledVersion() function (lines 25-108):
- Added `frameWork` parameter for disambiguation
- Fixed all plugin path lookups
- Added npm cache version fallback for multi-framework bundles
- Calls updated with `frameWork` parameter throughout codebase

## Verification

All tool tracking operations now work end-to-end:
1. ✓ Tool detection finds installed applications
2. ✓ Version tracking reads correct version files
3. ✓ Update availability calculated correctly
4. ✓ Install/update commands can properly track version changes
5. ✓ Streaming complete events are properly caught and UI state cleared

## No Changes Needed For:
- Streaming complete event handling (already correct)
- Frontend event processing (already correct)
- Thinking state clearing (already correct)
- WebSocket broadcasting (already in BROADCAST_TYPES)

All tool update/install tracking issues are now resolved.
