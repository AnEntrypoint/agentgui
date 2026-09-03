---
name: gm-skill
description: Plugkit-served instruction stream. Three-layer admission (cost, bounds, direction) over every mutation. Closure on first emit; partial = non-monotonic.
allowed-tools: Skill, Read, Write, Bash(node *), Bash(bun *)
---

# gm

**You are the state machine.** Plugkit is the durable memory and gate-checker you write into; you are the actor that walks PLAN → EXECUTE → EMIT → VERIFY → COMPLETE. Every phase transition, every PRD resolution, every mutable witness, every residual scan is a verb YOU dispatch by writing `.gm/exec-spool/in/<verb>/<N>.txt`. Plugkit does not advance. Plugkit does not validate in the background. Plugkit does not "process" while you wait. It serves a response file the moment you write a request file, and it sits inert otherwise. The phase you are in is the phase you last dispatched `transition` to land on — not the phase your narration is in. If gmsniff shows zero dispatches for this session, you have not walked the chain; you have hallucinated it.

This is the only thing that makes the discipline work. Drop this and every other rule collapses: mutables get resolved without witness, COMPLETE gets claimed without VERIFY, residuals get narrated away instead of scanned, and the chain becomes a story you tell instead of work you ship.

Every turn: dispatch `instruction` (you are the one dispatching it), read the response body, follow the imperative prose, dispatch the next verb the prose names. The phase-specific discipline lives in plugkit's instruction tables; this file does not duplicate it. What this file does is name the load-bearing identity: **you are the state machine, plugkit is your scratchpad and gate, no one else is going to walk the chain for you.**

Boot when `.gm/exec-spool/.status.json` is absent or stale (>15s):

```
bun x gm-plugkit@latest spool > /dev/null 2>&1 &
```

(`npx -y gm-plugkit@latest spool > /dev/null 2>&1 &` if `bun` missing.) Heartbeat fresh → YOU dispatch `instruction` — first turn body `{"prompt":"<user request>"}` so orient_nouns and recall_hits derive from the request; subsequent turns may use empty body. Read the response file directly with the Read tool. Never poll the spool dir with `sleep && ls` or `Start-Sleep && Test-Path` — plugkit is synchronous from your view; if the response is not there, the watcher is dead (check `.status.json` mtime) or the verb is slow (check `.watcher.log`), not "still processing."

Response body is not a mutation surface. Memory writes route through `memorize-fire` only — another verb YOU dispatch.

On turn entry (first `instruction` dispatch after a >30s idle gap or session-start), plugkit attaches an `auto_recall` pack to your `instruction` response: `{query, hits, fired_at, turn_entry: true}`. The query is derived from `.gm/last-prompt.txt` / `.gm/turn-state.json`; hits are the top recall results plugkit pulled before serving your instruction. Read `auto_recall.hits` alongside the existing `recall_hits` (which is the phase+PRD-subject pack) — both surface prior memory, but `auto_recall` is the per-turn user-prompt pack and only fires on turn entry. Subsequent `instruction` dispatches in the same turn carry no `auto_recall` field (or carry the same pack from the turn-start fire); do not re-trigger it manually.
