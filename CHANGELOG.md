## [Unreleased] - 44th-run docstudio design-cue follow-up: inline chat error, generic Avatar, FileSkeleton aria-busy (kit 3417592-17ee86c, app f08f698)

- kit: `ChatMessage` gains `error`/`onRetry` — an inline, destructive-toned per-turn failure notice (docstudio pins a failed message's error to that specific turn instead of a global toast) alongside the existing neutral `stopped`/`incomplete` notices; `content.js` gains a generic `Avatar({name,src,fallback,size})` primitive consolidating duplicated letter-fallback-disc logic; `FileSkeleton` gains `role=status`/`aria-busy`/`aria-label` matching every sibling skeleton. Why: a fresh docstudio survey (told what the kit already had, to avoid re-suggesting solved gaps) returned 5 candidates; verified backdrop-dismiss dialogs already do docstudio's strict target check (no change needed) and skipped a fragile Badge-collapse idea per the survey's own low-priority flag.
- kit: fixed a real wiring bug in `agent-chat.js`'s message mapper — the new `error`/`onRetry` forwarding was first gated on `!isAssistant`, but agentgui's `sendChat()` always attaches a send/stream error onto the eager assistant placeholder it pushes, never a dangling user message, so the gate would never have fired; corrected to key on trailing-message-position regardless of role.
- app: removed the now-redundant top-of-thread `chaterr` `Alert` banner (duplicate of the new inline per-turn signal); a stray leftover brace from that removal caused a real `SyntaxError: Illegal return statement` that fully blanked the live page, caught on the first post-deploy browser witness and fixed before landing.

## [Unreleased] - 39th-run gui-logic-predictability sweep: running-panel identity, stop-button wedge, live cost fallback, shortcuts affordance (kit 00dae4c, app 64f4466)

- app: `runningPanel()` rows now show the same resolved session title used on every other surface (sessions rail, history rail, Live SessionCard) instead of reading nameless; `stopActiveChat()` gains a bounded 9s timeout so a cancel that succeeds server-side but whose process lingers past the immediate refresh no longer wedges the stop button permanently disabled; `computeLiveSessions()`'s per-sid SSE tally now accumulates cost alongside tokens, so every live/external session shows a real cost figure, not just the one open in Chat; WorkspaceRail's footer gains a visible shortcuts-help icon button (the `?` overlay was previously 100% keyboard-only tribal knowledge with no discovery path outside Settings). Why: 39th `gui-logic-predictability` workflow (wf_88c431e5-931) confirmed these as real operating-logic gaps.
- kit: `CodeNode.refSink`'s syntax-highlight swap gains the same in-progress-selection guard `MdNode.refSink` already had (the two paths had drifted); `Row.sub` gains a `title=` tooltip fallback matching every other long-text field in the kit; new `help` icon path for the rail affordance.
- browser-witnessed live on buildesk via `page.context().setHTTPCredentials()` (embedded-URL Basic-Auth broke on this env's comma-containing password even percent-encoded) — help button + shortcuts overlay + Row.sub tooltip all confirmed working, zero pageErrors.

## [Unreleased] - 34th-run gui-ux-craft sweep: kit font-token fallbacks, focus-ring tokenization, agentsLoading state (kit 3b1080c, app 9c8094b)

- kit: `--fs-2`/`--fs-0` shadow font tokens (never defined in the real type scale) remapped to `--fs-lg`/`--fs-tiny`; stale `--lh-base` fallback fixed from 1.4 to 1.55; `.glyph`/`.ds-field-count`/`.ds-row-detail` hardcoded literals tokenized; ~29 more `outline: 2px solid var(--accent-ink)` focus rules converted to `var(--focus-w) solid var(--focus-color)`; `.chat-tool-copy` gained the coarse-pointer 44px touch target; `.ds-select` gained a base `min-height:32px` floor; `Btn`'s `className` prop renamed to `class` for consistency with `Panel`/`Heading`; `AgentControls`/`AgentChat` gained an `agentsLoading` disabled-select state. Why: 34th `gui-ux-craft` workflow (wf_919164f1-648) confirmed these as real, un-filed gaps.
- app: History no longer falls back to the raw session id when a session has no title/project (falls back to cwd, then "Untitled conversation"); ACP provider-error copy truncated+prefixed; settings/live-tab copy-tone fixes; ConversationList loading skeleton no longer gated to the history tab. Why: same workflow's copy-tone/perceived-perf lenses.
- parallel live-browser negative-space audit came back clean (3rd consecutive clean pass) — no dead-void/contrast/overlap regressions found.

## [Unreleased] - Mobile sessions-drawer sliver fix (kit 76b2bac, app 4bb9f3f)

- kit: fixed the closed sessions drawer's `translateX(-110%)` at the <=900px breakpoint, which was sized for a `left:0` drawer and undershot once the drawer's left offset shifted to the collapsed rail width, leaving a ~35px sliver of the closed drawer visibly overlapping content on mobile. Why: user-reported "looks very diy" prompted a live-browser negative-space review that caught the regression via DOM measurement (`getBoundingClientRect` showed the drawer's right edge at +35px instead of 0/off-screen).
- app: re-vendored the fixed kit build into `site/app/vendor/anentrypoint-design/`.

## [Unreleased] - GUI cohesion sweep: one-product chat-agent feel (kit 9ef409a, app 15b626c)

- new workflow `.claude/workflows/gui-cohesion.js` (6 cohesion lenses -> adversarial verify -> ordered plan; 61 agents -> 40 confirmed gaps, `PUNCHLIST-COHESION.md`) — hunts the product-cohesion/feel gap vs claude.ai/code / cowork / Claude-Desktop, distinct from the audit/overhaul/predictability-polish workflows. Why: the shipped surfaces still read as a kit of parts.
- kit: per-block code copy buttons; fence-aware streaming (no prose->block reflow); composer context line + per-agent avatar + follow-up chips; SessionCard stale/idle status + select + active, SessionDashboard sort/filter/errors-only + stop-selected + stream-state; FileGrid large-dir cap + role=group + permissions tag + RootsPicker; FilePreviewPane split-view + prev/next stepper; ContextPane empty state; WorkspaceShell stable column geometry; one canonical status disc + unified rail tones + 44px touch targets. Why: close the cohesion gaps as correct kit defaults.
- app: inline file preview pane, live-session stale detection + per-sid SSE tally + bulk select, stable shell frame, sentence-case titles, rail ThemeToggle footer; deleted the index.html status-dot override (kit owns the disc). Server: `/api/list` per-entry permissions + confined `/api/download`. Why: wire the kit and eliminate the last app-layer override.
- witnessed localhost:3000/gm/ 0 console/page errors across all tabs, 0 decorative glyphs, no h-scroll, a11y verified.

## [Unreleased] - GUI moved into the anentrypoint-design kit, loaded from unpkg

- the chat GUI now lives in the design kit: added a reusable `AgentChat` component to anentrypoint-design (agent-then-model picker + AICat auto-scroll/thinking + tool parts + cwd bar + caret-stable composer), pure props-in/vnode-out with all transport as host callbacks. Published via the kit's CI to npm -> unpkg.
- site/app/index.html: imports anentrypoint-design from https://unpkg.com/anentrypoint-design@latest at runtime (always-latest), replacing the vendored bundle. Trades the offline guarantee for always-latest, per project decision.
- site/app/js/app.js: chatMain renders the AgentChat kit and wires agentgui state + WS/ccsniff glue as callbacks; the agent/model picker, cwd bar, and composer moved out of agentgui into the kit. backend.js (WS client) stays as the transport glue.
- verified end-to-end in a real browser: GUI sourced from unpkg, AgentChat renders, chat round-trips (reply streams into the kit's transcript), 0 console errors.

## [Unreleased] - live e2e chat verified + composer caret fix + ccsniff memory cap

- verified the full GUI chat round-trip end-to-end in a real browser: compose -> WS chat.sendMessage -> claude-code -> streaming_progress -> transcript renders the streamed reply (not just the runner harness).
- site/app/js/app.js: composer onInput re-renders only on the empty<->non-empty draft transition (the only change that toggles the send button), not on every keystroke. Why: a synchronous re-render per character fought the caret on the controlled textarea.
- vendored anentrypoint-design DS rebuilt: ChatComposer reads the live textarea value on send and syncs the controlled value into the DOM only when it differs, so a mid-type re-render no longer resets the caret or drops keystrokes. Why: DS override belongs in the kit; the composer is shared.
- ccsniff (sibling repo, pushed): bounded the in-memory history store (event cap + eviction + per-event text cap) and bounded loadOnce to read newest events first up to the cap. Why: the store grew unbounded to 6GB+ (OOM) and parsed the entire JSONL backlog at load (~2.4GB transient peak); heap now settles ~47MB and load peak ~570MB.

- lib/agent-discovery.js + lib/claude-runner-agents.js + lib/agent-descriptors.js: added `agy` (Antigravity) as a direct-protocol CLI agent — `agy --print "<prompt>" --dangerously-skip-permissions [--continue]`, plain-text parseOutput, no model picker. Completes the four flagship orchestration targets (Claude Code, OpenCode, Kilo, Antigravity). Why: the GUI could not drive Antigravity at all.
- lib/claude-runner.js + lib/claude-runner-direct.js: SECURITY — the direct runner now spawns a resolved binary with `shell:false`. Previously `shell:true` on Windows concatenated argv unescaped, so a prompt containing `&`/`|`/`>`/backticks executed as shell commands (verified injection). Why: arbitrary command execution from chat input.
- lib/claude-runner-agents.js: claude-code registry entry gained `npxPackage` so it reports available via npx fallback when `where claude` misses a non-PATH install. Why: the flagship agent showed "(not installed)" despite being present.
- site/app/js/app.js + site/app/index.html: removed every decorative glyph (status dots, cmd/section/box/arrow/check/cross marks) in favour of ASCII words and a CSS-drawn status disc; agent picker now sorts the four flagship targets first, then available, then npx-installable, then not-installed. Why: machine-shaped glyph tells and a flat 17-item list obscured the orchestration targets.

## [Unreleased] - site/app live client migrated to 247420 SDK components

- site/app/index.html: removed 35 lines of bespoke CSS overriding design tokens; now uses SDK panel/font tokens with only structural overrides (chat flex layout, history pane grid)
- site/app/js/app.js: replaced raw h() + applyDiff loop with AppShell, Topbar, Crumb, Side, Chat, ChatComposer, Row, Status from anentrypoint-design; uses mount() so motion system fires; font resolves to Nunito via SDK

## [1.0.908] - manual audit fixes: server retry idempotency, cli-version detection, cleanup FK ordering, refresh-all path

- server.js: `onServerListenStart` one-shot guard prevents `onServerReady` + `loadPluginExtensions` from re-firing when EADDRINUSE retry succeeds — previously every retry re-ran autoProvision/installGMAgentConfigs/setIntervals causing 100+ duplicate provision passes and stacked timers
- lib/tool-version-check.js: bumped `getCliVersion` execSync timeout from 1000ms to 15000ms; bumped `checkCliInstalled` `where` timeout from 3000ms to 10000ms — Windows cmd.exe + node CLI cold-start regularly exceeds 1s/3s, leaving opencode/gemini/kilo/agent-browser with `installedVersion: null` despite being installed
- lib/db-queries-cleanup.js: reordered cleanup transaction — child rows (chunks, stream_updates) now deleted before their parent sessions; was causing FOREIGN KEY constraint failed on every `[cleanup] Initial DB cleanup complete` invocation and on the 6h periodic cleanup, silently aborting the whole transaction
- lib/routes-tools.js: `POST /api/tools/refresh-all` now calls `toolManager.refreshAllToolsAsync()` (which clears statusCache) instead of `getAllTools()` which returned stale cached values — refresh button was a no-op

## [Unreleased] - implement 247420 brand-bible chrome on main shell

- index.html: header brand line reads `247420 / agentgui / <leaf>`; sidebar brand line reads `247420 / agentgui` — mono slash `/` in muted color, matches canonical app-topbar pattern from c:/dev/design
- index.html: sidebar `New` button now uses `.btn-stamp.green` (flat mint stamp with 2px ink offset shadow) — removed `✦` sparkle, lowercase `new` label
- index.html: default theme is now `data-theme="dark"` — matches the design system's dark-first canvas (`#0B0B09` with mint `#92CEAC` accent)
- index.html: `data-message-input` moved onto the visible `#inputCardTextarea` — previous commit left it on a hidden absolutely-positioned textarea, breaking `setupUI()` binding and send-button wiring; placeholder lowercased `message agentgui...`
- theme.js: dropped `prefers-color-scheme` probe for the no-saved-theme fallback; new installs get dark unconditionally
- client-ui2.js: `_showWelcomeScreen()` rewritten — lowercase Archivo-Black h1 (`a state machine for coding agents.`), t-micro brand datelime, `.row` grid rows for new-conversation and available-agents cards, no hardcoded hex/inline Title-Case
- css/brand-bible.css: added `.brand-line` (mono slash separator), compact 40px `.main-header` / `.sidebar-header` shells, `.welcome-pane` + `.welcome-rows` styling that inherits panel tokens — all via tokens, no literals
- css/app-shell.css, css/colors_and_type.css: vendored from c:/dev/design so the same canonical token surface is available locally (currently unloaded; reserved for next-pass shell rebuild)

## [Unreleased] - remove duplicate welcome screen; wire agent/model chip selects

- index.html: removed static `#welcomeScreen` div (gradient-G logo block) that persisted over conversation views — JS `_showWelcomeScreen()` in `#output` already handles empty state
- index.html: moved `data-cli-selector` and `data-model-selector` attributes from hidden div to the visible `inputCardAgentSelect` / `inputCardModelSelect` chip selects so `loadAgents()` populates visible controls

## [Unreleased] - visible prompt controls + viewport-safe overflow menu

- brand-bible.css: chip selects (agent/model dropdowns) now use `--panel-3` background so they contrast against the `--panel-1` card; pill border-radius preserved with `!important` override of the `* { border-radius:0 }` reset
- brand-bible.css: sidebar-overflow-menu gets `max-height: calc(100dvh - 80px)` to prevent off-screen overflow
- app.js: overflow menu detects bottom-of-screen clip on open and flips to `bottom: 100%` when needed

## [Unreleased] - Clear All now soft-deletes conv rows to suppress auto-import

- `deleteAllConversations` was hard-deleting rows from the conversations table. Auto-import's skip check relies on `existingConv.status === 'deleted'` — after hard delete, existingConv is null, so the JSONL scanner re-imports everything the next poll. Visible symptom: Clear All appears to work, then the same conversations reappear.
- Fix: use `UPDATE conversations SET status='deleted'` (match individual `deleteConversation` behavior). Related data (chunks/events/sessions/messages/voice_cache/stream_updates) is still hard-deleted, and the JSONL project files are still wiped from `~/.claude/projects/`.
- Verified both paths end-to-end: HTTP `DELETE /api/conversations/:id` and WS `conv.del.all`. Added regression case in test.js.

## [Unreleased] - fix stuck "live" indicators on conversations sidebar

- Symptom: conversations show streaming dot in sidebar even when no agent is running. Root cause: `routes-conversations.js GET /api/conversations` reconcile required BOTH `!activeExecutions.has(conv.id)` AND `!activeSessionConvIds.has(conv.id)` to clear `isStreaming`. If a session crashed hard (server killed mid-stream, agent process killed without finally running), the session row stayed at `status='active'` forever, keeping the sidebar live indicator on indefinitely until next server restart triggered `recoverStaleSessions`.
- Fix: trust `activeExecutions` map as ground truth. If `isStreaming=1` but no in-memory execution, set `isStreaming=0` AND mark any orphan 'active'/'pending' session for that conv as 'interrupted'. Self-heals on every list fetch — no restart needed.

## [Unreleased] - surface stream chunk persistence errors

- lib/stream-event-handler.js: `queries.createChunk` failures were swallowed silently in the ACP streaming path. User would see live broadcast events but reload would lose all chunks. Now logs error with conv id, seq, block type for observability.

## [Unreleased] - add Hermes Agent (Nous Research) as ACP-compatible agent

- lib/agent-discovery.js BINARIES: detect `hermes` CLI in PATH (icon 'h', protocol 'acp')
- lib/claude-runner-agents.js: register hermes with `hermes acp` entry and shared acpProtocolHandler. Uses stdio JSON-RPC transport (matches hermes-agent's `acp_adapter.entry` which routes stdout to ACP and stderr to logs).
- test.js: regression case asserting hermes registration shape (buildArgs/protocol/features).
- Install with: `curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash` then `pip install 'hermes-agent[acp]'` (or included in `[all]` / `[termux]` extras).

## [Unreleased] - GUI a11y pass

- index.html: remove `maximum-scale=1.0` and `user-scalable=no` from viewport (WCAG 1.4.4 — low-vision users need pinch-zoom)
- index.html: add `theme-color` meta with light/dark media queries (native tab/chrome tinting on mobile)
- index.html: add skip-to-conversation link as first body child for keyboard users
- main.css: add `:focus-visible` outline for keyboard nav (previously no default visible focus ring)
- main.css: add `@media (prefers-reduced-motion: reduce)` to collapse animations/transitions for users with vestibular disorders or motion-sensitivity OS setting
- main.css: `.skip-link` styles (off-screen until focused)

## [Unreleased] - GUI observability + workflow-plugin fix

- Fix regression from prior commit: workflow-plugin.js declared `dependencies: ['git','database']` but git plugin was deleted; plugin init failed with "Plugin git not found in registry". Removed unused git dep and stale binding.
- Consolidate client debug registry: `window.__debug` now exposes structured sub-keys (`machines.{conv,toolInstall,voice,convList,prompt,recording,terminal,ws}`, `ws`, `auth`, `perf`, `config`, `renderer`, `conv`) via live getters that snapshot scattered `window.__*` machines into a single queryable tree. Existing `getState`/`getSyncState`/`getMessageState` methods preserved.
- Null-safe snapshot helpers: uninitialized machines return `'uninitialized'` instead of crashing.
- test.js: add regression case for workflow-plugin deps (17/17 pass).

## [Unreleased] - observability + dead-code sweep + root test suite

- Expose acp-server-machine snapshots in /api/debug/machines (previously only tool-install + execution machines)
- Add /api/debug/state endpoint consolidating active executions, queues, wsClients, machine snapshots, ws-stats, recentErrors, uptime, memory (DEBUG=1 gated)
- Alias /api/debug/ws-stats to /api/ws-stats so docs match runtime
- Add getMachineActors() export to lib/acp-server-machine.js
- Delete verified-orphan files: lib/rate-limit-machine.js, lib/model-download-machine.js, lib/agent-registry-configs.js, lib/plugin-interface.js, lib/plugins/git-plugin.js
- Add root test.js (16 cases): codec roundtrip, DB init+queries, acp-queries helpers, WsRouter dispatch/errors/legacy, XState machine actor getters + lifecycle. Uses better-sqlite3 in-memory — no mocks.
- CLAUDE.md: remove stale entries for deleted files

## [Unreleased] - merge: integrate remote UI redesign + cleanup CLAUDE.md

- Merge origin/main: resolve UU conflicts in server.js (take remote _jsonlWatcher setter) and static/index.html (take remote UI redesign with overflow menu + SVG icons)
- Accept AA (both-added) files from new modules: lib/jsonl-parser.js, lib/jsonl-watcher.js, lib/process-message.js, lib/server-startup.js, lib/stream-event-handler.js, static/css/main.css, static/js/client.js, static/js/conversations.js
- docs: cleanup CLAUDE.md — trim verbosity (499→368L, -26%): consolidate REST API (42→9L), tighten XState docs (21→4L), shrink WebSocket wire format (29→2L), compress message flow (15→1L), tighten tool detection (21→6L), merge voice model + debug sections. All key patterns preserved.

## [Unreleased] - refactor: extract routes registry + wire tool/debug routes

- Extract all route and WS handler registrations from server.js L201-270 to lib/routes-registry.js (63L, createRegistry factory)
- Move BROADCAST_TYPES set to lib/broadcast.js as exported const; server.js imports it
- Refactor http-handler.js to accept routes object (routes.conv, routes.tools, routes.debug etc.) instead of individual named parameters; wire previously-unwired tool and debug routes
- Inline _mqDeps object into createMessageQueue call; compact process.on error handlers
- server.js reduced from 337L to 200L; all lib files ≤200L


## [Unreleased]

### Refactor
- Extract WebSocket server setup and legacy message handler from server.js to lib/ws-setup.js (77L, createWsSetup factory) and lib/ws-legacy-handlers.js (154L, registerLegacyHandler); server.js reduced from 1077L to 748L; wss.on('connection'), heartbeat interval, hot-reload watcher, subscribe/unsubscribe/terminal/PM2 legacy handlers all moved; unused WebSocketServer, spawn, createRequire imports removed from server.js
- Extract express upload + fsbrowse setup from server.js to lib/routes-upload.js (79L) exporting createExpressApp; server.js imports createExpressApp and no longer contains Busboy/fsbrowse/express inline code
- Extract maskKey, getProviderConfigs, saveProviderConfig, buildSystemPrompt, PROVIDER_CONFIGS from server.js to lib/provider-config.js (151L); extract logError, makeCleanupExecution, makeGetModelsForAgent, errLogPath from server.js to lib/server-utils.js (61L); server.js imports all via named imports; cleanupExecution wired after broadcastSync; _debugRoutes receives errLogPath
- Extract parseBody, acceptsEncoding, compressAndSend, sendJSON from server.js to lib/http-utils.js (43L); server.js imports from new module; zlib import removed from server.js
- Extract message/stream/queue routes (messagesMatch, streamMatch, queueMatch handlers) to lib/routes-messages.js (140L) and session/chunk/full/execution routes to lib/routes-sessions.js (145L); server.js reduced from 2406L to 2127L; both files ≤200L; wired via _messagesRoutes._match and _sessionsRoutes._match in request handler
- Extract runs/scripts/agent-auth/auth-config HTTP routes from server.js to lib/routes-runs.js (157L), lib/routes-scripts.js (136L), lib/routes-agent-actions.js (118L), lib/routes-auth-config.js (30L); routes-auth-config uses getProviderConfigs/saveProviderConfig from server.js deps (no duplication); server.js reduced from 2406L to 1399L total (-1007L)
- Extract processMessageWithStreaming (539L), scheduleRetry, drainMessageQueue, and parseRateLimitResetTime from server.js into lib/process-message.js (127L, createProcessMessage factory), lib/stream-event-handler.js (116L, createEventHandler), lib/message-queue.js (63L, createMessageQueue), lib/process-message-rate-limit.js (19L); all files ≤200L; server.js reduced by ~660L and imports/wires all factories after broadcastSync is created
- refactor: extract broadcastSync to lib/broadcast.js (createBroadcast factory) and recovery functions to lib/recovery.js (createRecovery factory); server.js reduced from 3419L to 3226L
- refactor: remove JSDoc and standalone code comments from scripts/patch-fsbrowse.js; reduce from 229L to 200L
- Split database.js (651L) into database.js (81L) + database-schema.js (176L) + database-migrations.js (150L) + database-migrations-acp.js (134L); all files ≤200L; no circular imports; migration functions receive db as parameter
- Split claude-runner.js (1267L) into claude-runner.js (56L, AgentRunner class+helpers), claude-runner-direct.js (117L, runDirect method), claude-runner-acp.js (156L, runACP+_runACPOnce methods), claude-runner-agents.js (105L, AgentRegistry+registrations using acp-protocol.js), claude-runner-run.js (50L, runClaudeWithStreaming export); server.js updated to import from claude-runner-run.js
- Split db-queries.js (1413L) into db-queries.js (93L, factory + conv queries), db-queries-messages.js (103L), db-queries-sessions.js (113L), db-queries-events.js (69L), db-queries-del.js (143L), db-queries-cleanup.js (86L), db-queries-import.js (134L), db-queries-streams.js (101L), db-queries-chunks.js (196L), db-queries-chunks2.js (83L), db-queries-voice.js (86L), db-queries-tools.js (128L); all ≤200L; each exports addXxxQueries(q, db, prep, generateId); factory calls all helpers and returns q

## 2026-04-12
- refactor: reduce speech-manager.js from 207L to 200L by removing excess blank lines
- refactor: split ws-handlers-session.js (209L) into ws-handlers-session.js (94L) + ws-handlers-session2.js (106L); agent.auth/authstat/update handlers moved to session2; server.js imports and calls both
- refactor: split ws-handlers-conv.js (283L) into ws-handlers-conv.js (139L, conv.ls/tags/new/get/upd/del/del.all/full/chunks/chunks.earlier/reorder) and ws-handlers-conv2.js (169L, conv.export/import/sync/search/prune/cancel/inject/steer); removed 2 comment lines; server.js imports and calls both
- refactor: split client.js (3212L) into 22 files ≤200L each; all 122 methods preserved including 2 extracted helpers (_setupUIButtonEvents, _setupUIWindowEvents, _loadConvRender); index.html updated with correct load order
- refactor: split streaming-renderer.js (2193L) into 15 files ≤200L each; all 75 prototype methods and 8 static methods preserved; index.html updated with correct load order

## 2026-04-11
- refactor: replace jsonl-watcher.js with @lanmower/cc-tail npm package (subclass CCTailWatcher, override _line() via JsonlParser); remove custom file-watching logic
- refactor: split syntax-highlighter.js (216L) into syntax-highlighter.js (132L) + syntax-highlighter-render.js (73L)
- refactor: split dialogs.js (268L) into dialogs.js (54L) + dialogs-types.js (112L, window.UIDialog)
- refactor: split image-loader.js (221L) into image-loader.js (147L) + image-loader-element.js (77L)
- refactor: split conversations.js (742L) into conversations.js (116L) + conv-sidebar-actions.js (185L) + conv-list-renderer.js (198L) + conv-sidebar-clone.js (92L)
- refactor: split websocket-manager.js (643L) into ws-core.js (163L) + websocket-manager.js (108L) + ws-latency.js (89L)
- refactor: split ui-components.js into ui-components.js (89L) + ui-components-rendering.js (63L)
- refactor: split agent-auth.js into agent-auth.js (147L) + agent-auth-oauth.js (160L)
- refactor: split event-filter.js into event-filter-config.js (37L); delete event-filter.js dead code (zero external refs)
- refactor: split jsonl-watcher.js parse logic into jsonl-parser.js (180L); watcher retains file watching only
- refactor: split tool-version.js into tool-version-check.js + tool-version-fetch.js
- refactor: fix index.html script load order for all new split files
- fix: thinking blocks use theme-aware CSS vars for light/dark backgrounds
- fix: all code blocks use CSS vars instead of hardcoded dark hex colors
- fix: remove GMGUIApp dead code from app.js; add app.js and app-shortcuts.js to index.html
- fix: extend window.__debug.getSyncState() with all XState machine snapshots
