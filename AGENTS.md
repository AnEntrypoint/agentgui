# AgentGUI — Agent Notes

## CRITICAL — ACP process lifecycle: two live transports, by design, not drift

`lib/acp-sdk-manager.js` owns spawning every ACP-protocol agent's underlying process — no other module spawns an ACP CLI subprocess. On top of that single spawn point, TWO transports exist for the actual per-turn prompt: **stdio JSON-RPC** (`lib/claude-runner-acp.js`'s `_runACPOnce`, the default for all ACP agents) and **HTTP+SSE** (`lib/claude-runner-acp.js`'s `_runACPHttp`, opt-in via a registry entry's `transport:'http'`, currently only `opencode` — live side-by-side verified byte-identical final output against the stdio path for the same prompt). `AgentRunner.runACP` dispatches between them by `this.transport`. Adding a new HTTP-transport agent requires the same live verification (capture real SSE frames, extend `lib/acp-http-protocol.js`'s normalizer, side-by-side prompt comparison) before flipping its registry flag — never assume HTTP-transport parity from CLI-family resemblance alone (kilo shares `@kilocode/cli`'s lineage with opencode but was never independently verified). Every `spawn()` callsite needs a `proc.on('error', …)` handler (ENOENT surfaces async under Bun). `acp-sdk-manager.js`'s `ACP_TOOLS` entries MUST pass `--port <port>` explicitly in `args` — `acp` alone defaults `--port` to `0` (an OS-assigned ephemeral port), silently breaking every health-check/HTTP-transport call against the tracked fixed port.

## CRITICAL — `authedFetch` must NOT set `Authorization: Bearer` behind an nginx Basic-Auth proxy

Same-origin app auth must never use the `Authorization` header when an upstream proxy may own Basic auth — a `Bearer` header overwrites the browser's cached `Authorization: Basic` credentials, and nginx `auth_basic` only accepts `Basic`, so the request is rejected at the proxy before it ever reaches agentgui. Use the **`?token=` query param** (`withToken()`, exactly like the WS / EventSource / image / download URLs) instead — it coexists with upstream Basic auth, and agentgui accepts `?token=` on every HTTP route, plus the `agentgui_token` cookie.

## CRITICAL — no Chrome/Puppeteer/Playwright dependency anywhere in this repo

Never add `puppeteer`/`puppeteer-core`/`playwright`/`playwright-core` as a dependency, and never hand-roll a raw headless-Chrome launch in a script. Live browser verification for this project is done via the gm skill's `browser` verb (direct CDP, no relay), not by this repo owning its own browser-automation dependency. `scripts/capture-screenshots.mjs` (puppeteer-core-driven, dead code — not wired into any CI workflow) was removed for this reason.

## Standing engineering rules

- **All GUI/design decisions live in the kit (`../design`), none in agentgui.** New surface styling is a kit CSS rule, never an inline `<style>` or `style=` prop in agentgui. A new kit component must be re-exported through `src/components.js`'s barrel to be consumable — adding it to a component file alone leaves it invisible to the built bundle even with 0 lint errors; grep the built dist for the export name before wiring the app against it. New CSS class tokens in the kit must carry a registered family prefix (`ds-`, `app-`, `ws-`, `chat-`, etc. — see `scripts/lint-classes.mjs`'s `PREFIXES`/`FROZEN` lists) or the build's lint-classes check fails; a legacy bare name like `chip` being grandfathered on the FROZEN list does not cover new sub-tokens off it (e.g. a new `chip-remove` class still needs a `ds-` prefix).
- **`confineToRoots()` in `lib/http-handler.js` applies `fs.realpathSync` re-confinement on `/api/list`, `/api/file`, `/api/image`** — a symlink pointing outside an allowed root fails closed rather than resolving through it.
- **Files is a full file manager, not a viewer**: confined `POST /api/rename`, `/api/delete` (soft-delete into a per-root `.agentgui-trash/` with a restore endpoint and a retention-window eviction cap, not a hard unlink), `/api/mkdir`, `/api/restore`, `PUT /api/upload-file`, `GET /api/stat`, all routed through `fsAllowRoots()`/`sanitizeEntryName()` and a CSRF guard on every POST/PUT/DELETE. Run `scripts/validate-mutations.mjs` after touching any part of this mutation surface. `RFC-5987` `Content-Disposition` encoding is required for non-ASCII filenames on download.
- Full hash routing state is `HASH_KEYS=[tab,sid,dir,file,q,project,section]`; `popstate` diffs the full set, and `navTo(tab,{writeHash:false})` navigates without pushing a new hash entry.
- The "Untitled conversation" fallback is one shared `UNTITLED_CONVERSATION` constant — never a locally re-typed literal (casing/wording drifts across call sites otherwise).
- Upload/mkdir/rename/list request bodies are scanned by `SECRET_RE` before being echoed into logs or responses.
- **webjsx keying:** mixing keyed VElements with `null`/strings/numbers in any children array crashes `applyDiff` ("reading 'key'"). Never pass a conditional `x?h():null` positionally — build the array and `.filter(Boolean)` it. `Btn` spreads array children. A kit component prop with an established narrow contract can silently corrupt an unrelated call site when a caller passes a richer value than the prop was designed for (e.g. a VElement where only a plain string was ever read) — grep every other use site of a prop before extending what a caller passes through it.
- **Escape ladder order (extend, never reorder):** shortcuts overlay > file dialog > confirmingEdit > cwd editor > confirmingClearData > new-chat arm > stop-arms > files multi-select clear > stop generation.
- **Status-disc shape:** live = solid+pulse, error = solid+halo, connecting = hollow ring, stale = muted solid.
- **Kit `Row` rail/rank contract:** the design-kit `Row` (`anentrypoint-design` `src/components/content.js`) renders a leading status rail from a `rail` prop (`green` | `purple` | `flame`, via `.row.rail-<tone>::before`) and accepts `rank` as an alias for the leading `code` index. `state: 'disabled'` is inert (no `onClick`/`role=button`/tab-stop, `aria-disabled=true`). Rail semantics are consistent everywhere: green = selected/ok, purple = subagent, flame = error/unavailable.
- **No decorative glyphs.** GUI source and output use ASCII words and CSS-drawn discs (`.status-dot-disc`) for status, never `●/◌/○/⌘/§/▶` etc. The middot separator `·`, ellipsis `…`, and em/en dashes in prose are kept as deliberate typographic product design, not tells — convert any other decorative glyph (arrows, box-drawing, bullets, checks) to ASCII on sight (`->`, `// --- x ---`, `-`/`*`). A dismiss control's own close icon on a dismissible Alert is a real DS icon affordance, exempt.
- **A `keepXTrack`-mounted component's interaction must produce the same visible effect on every tab it appears on** (e.g. the persistent sessions rail).
- **Any drawer/overlay whose `left`/`inset` changes across breakpoints must re-derive its closed-state transform from that breakpoint's own offset** — a transform tuned for one breakpoint's geometry silently breaks at the next if the offset shifts underneath it.
- **`.ws-rail`/`.ws-sessions`/`.ws-pane` must all three use `--bg-2`** for background — a mismatched flat `--bg` on any one reads as visually disjointed chrome.
- The app.js `C` destructure must list every kit component it calls (an undestructured component silently renders as `Icon is not defined` or similar).
- Commit and push any inherited uncommitted work found dirty in the tree before starting new work at PLAN entry — never leave it stranded under a fresh, disjoint cover.
- No new `PUNCHLIST-*.md`/`AUDIT-PUNCHLIST.md` (or similarly named) file is checked into the repo as a durable artifact. A workflow's punch-list is a transient working document for that run's synthesis step; the outcome belongs in AGENTS.md (compressed to a rule) or drains to recall, never a standing file.
- When origin advances mid-run with the same feature a concurrent writer already shipped, drop your version and adopt theirs, then re-apply only genuinely-distinct work — never a parallel implementation.
- Check a color token's contrast against its actual rendered background, not just the base paper token. A `failures`-array-shaped crash from a lint/audit lens means that scope is unaudited, not a null (clean) result. `prd-resolve` `witness_evidence` must be distinct per row, never a batch-shared string.
- This env's `PASSWORD` value can itself contain literal commas (e.g. `123,slam,123,slam`) — treat the whole string as one token, never comma-split it when testing auth.
- The `gm-plugkit` `fs_write` verb's payload key is `content` (a JSON string), not `body` — passing `{path, body:{...}}` silently no-ops with `bytes:0` and no error.
- Docstudio design-cue mining (`/config/docstudio`) is a recurring source of portable UI conventions to port into `../design`. When re-running this sweep, survey files not yet examined against the kit's actual current component list rather than trusting a prior "exhausted" verdict at face value — a narrow, genuinely new gap can still surface (e.g. `Chip.onRemove`, `RateCell`, `SpreadsheetPreview`, `ApprovalPrompt`, `PermissionMenu`, `CountdownDialog`, `withBusy` double-fire guard, `MenuButton`, `ChatSuggestions`, `BatchProgressLabel`/`formatBatchOutcome`, `InfoRow`/`InfoSection`/`DiagnosticsPanel`). Business logic with no portable visual surface (native OAuth pickers, drive integration, file-upload wiring) and app-specific cloud-provider wiring (observability deep-links) are not portable; the visual/interaction *convention* underneath sometimes still is.
- A component transitioning between two structurally-different children states at the same webjsx-diffed slot (e.g. a loading placeholder vs. a keyed-list body) needs each state's wrapper to carry a distinct `key`, not just a shared parent key — reusing one key across a text-only render and an element-children render at the same position crashed `applyDiff` with "reading 'key'" (caught live via `browser` dispatch in `InfoSection`'s loading→loaded transition, fixed by keying the two branches `body-loading`/`body-rows`).

## Browser-verb operating notes

- The `browser` spool verb's actual accepted JSON body shape is `{"code": "<script>"}`, evaluated directly in the currently-loaded page's `window`/`document` context — it is not a Puppeteer/Playwright `page`-scoped API (no `page.goto`/`page.title()`). Navigating via `window.location.href = '...'` inside one `{code}` dispatch throws `"Inspected target navigated or closed"` (expected — kills the CDP eval mid-navigation), but the session persists across dispatches, so a second `{code}` dispatch on the same session lands in the newly-navigated page. If the plain-text `url=`/`dom=`/`screenshot=`-prefixed body forms ever return empty/no-op in this environment, fall back to the two-dispatch `{code}` navigate-then-eval pattern rather than re-litigating the prefix forms.
- Zombie Chromium process trees left by earlier timed-out `browser` dispatches (under the project's own `.gm/browser-chrome-profile-` directory) can wedge every subsequent Chrome launch/reuse to full-timeout empty responses or intermittent `"plugin gm not loaded"` errors. Kill every chromium PID under that profile dir (never the daemon process itself) to unblock; this is a distinct failure mode from a genuinely stale/crash-looping supervisor process (also possible — check `.gm/exec-spool/.watcher.log` for a repeating respawn-crash-loop signature before assuming it's the Chrome-zombie case).
- A persistent (not merely zombie-Chrome-related) `"plugin gm not loaded"` error on the shared `agentplug-runner` daemon was root-caused and fixed upstream (`AnEntrypoint/agentplug` commits `b981b67`/`d388d81`, released through the `agentplug-bin` pipeline): `dispatch_and_evict_on_error` in `registry.rs` permanently cleared a plugin's pool slot on any dispatch error with no reload path on `DispatchHandle` (the browser/exec_js spawn-thread path), so one transient failure (e.g. a Chrome-launch timeout) made every later dispatch on that daemon fail until an unrelated code path happened to reload the plugin. Fixed by threading `Engine`+`Module` through `DispatchHandle` so it self-heals a missing/evicted slot. If this symptom recurs, a fresh `agentplug-runner` binary pull should already carry the fix; only re-root-cause if it persists on a confirmed-current binary.
- Embedding Basic-Auth creds directly in a `page.goto`/navigation URL (`https://user:pass@host/...`) breaks the app's own same-origin `fetch()` calls with "Request cannot be constructed from a URL that includes credentials." Do one embedded-creds navigation to seed the browser's per-origin Basic-Auth cache, then navigate again WITHOUT embedded creds (plain URL or `?token=`) for any witness that needs real fetches to succeed.
- Combine creds + goto + wait + evaluate into ONE dispatch when the tool version's session ids rotate across separate dispatches; read results via `console.log('WITNESS:'+...)` and grep stdout rather than trusting a `capture`-prefix `result` field that can come back `null` on an otherwise successful dispatch.
- Writing a spool verb input file under a task-number that collides with an existing `out/<verb>-<N>.json` from an earlier turn in the same session can silently return the STALE cached output instead of running the fresh dispatch. Pick a task number confirmed absent from `out/` (e.g. jump to a clearly-unused block) rather than trusting sequential same-session numbering, especially after a long session with many prior dispatches.

## Architecture (single surface)

One surface. `server.js` serves `site/app/` under `BASE_URL` (default `/gm`) and mounts `ccsniff`'s `/v1/history/*` Express router in-process at both `/` and `BASE_URL`. There is no legacy `static/` tree and no `lib/plugins/` system — all server logic lives directly in `server.js` + `lib/ws-handlers-util.js` + `lib/http-handler.js` + `lib/routes-upload.js` + `database.js`. `acptoapi` is not used by this project.

When `PASSWORD` env var is set, every HTTP route is gated by `lib/http-handler.js` accepting **Basic auth**, **`Authorization: Bearer <pwd>`**, OR **`?token=<pwd>`** query param (the query-param path exists because `EventSource` and direct deep-links cannot set headers). WS `/sync` requires `?token=` only. The HTML head script injects `window.__BASE_URL`, `window.__SERVER_VERSION`, and `window.__WS_TOKEN`; `site/app/js/backend.js` reads `__WS_TOKEN` and threads it onto every fetch (Bearer header) / EventSource (qs) / WebSocket (qs).

- `site/app/index.html` — shell + CSS; imports `anentrypoint-design` from the local vendored copy `./vendor/anentrypoint-design/247420.{js,css}` (a predictable shipped UI that does not shift when upstream publishes, plus offline operation — the markdown stack marked/dompurify/prismjs still fetches from jsdelivr on first chat render). Update flow: edit the kit at `../design`, `node scripts/build.mjs`, copy `dist/247420.{js,css}` into `site/app/vendor/anentrypoint-design/`, then publish the kit so unpkg stays in sync.
- `site/app/js/backend.js` — same-origin WS/HTTP client (`DEFAULT_BACKEND = ''`); the transport glue that wires the kit; `?backend=` query override for cross-origin debugging.
- `site/app/js/app.js` — webjsx view + state; renders the `AgentChat` kit component for the chat surface and wires agentgui's WS/ccsniff state as kit callbacks; history/settings remain agentgui-local. Exposes `window.__agentgui`.
- The chat GUI lives in the design kit, not in agentgui. The reusable multi-agent chat surface is the `AgentChat` component in `anentrypoint-design` (`src/components/agent-chat.js`); agentgui keeps only the transport glue (WS `backend.js`, ccsniff history wiring, agent orchestration) and passes state + callbacks into the kit. To change chat UI, edit the kit and push it (CI publishes to npm -> unpkg `@latest`), not agentgui.
- `server.js` — initializes the ACP-SDK manager + agent registry, registers WS handlers (`ws-handlers-util.js`), mounts `createHistoryRouter()` from `ccsniff` at `/`, serves `site/app/` as static root.

Dependencies:
- `ccsniff` (>=1.1.0) — exports `createHistoryRouter({projectsDir})` mountable on Express; serves `/v1/history/{sessions,sessions/:sid/events,search,snapshot,reindex,stream}`. Reads `~/.claude/projects` (override via `CLAUDE_PROJECTS_DIR`).
- `anentrypoint-design` (>=0.0.119) — kit library, single-file ESM, vendored locally (not loaded from unpkg at runtime).

## Orchestration agents

The four flagship agents the GUI drives are **Claude Code, OpenCode, Kilo, and Antigravity (`agy`)**; the agent picker (`site/app/js/app.js`, `PRIMARY_AGENTS`) sorts these first, then other-available, then npx-installable, then not-installed.

Two runner protocols exist. **Direct** (`lib/claude-runner-direct.js`): claude-code and agy — spawn the CLI per turn, parse stdout. **ACP** (`lib/acp-sdk-manager.js`): opencode/kilo/codex — an on-demand long-lived server on ports 18100/18101/18102, health-checked via `/provider`. The on-demand start + restart-backoff is correct even when an ACP agent lacks provider auth (it reports running-not-healthy rather than crashing).

`agy` (Antigravity) is a Gemini-backed Go CLI. Its invocation is `agy --print "<prompt>" --dangerously-skip-permissions [--continue]` — `--print` is a **value flag** (the prompt is its argument; a positional prompt exits 2). It emits **plain text** (not stream-json) and prints no session id, so its `parseOutput` wraps each line into an assistant-text event and resume is `--continue`-only. A live model response needs an authenticated Antigravity session; without it `agy` returns empty (the direct runner resolves gracefully, no hang).

**The direct runner spawns with `shell:false` against a resolved binary path — never `shell:true`.** `shell:true` on Windows concatenates argv without escaping, so a chat prompt containing `&`/`|`/`>`/backticks executes as shell commands (arbitrary command execution). `lib/claude-runner.js` `resolveBinaryPath` resolves the command to an absolute `.exe`; `getSpawnOptions` only defaults `shell:true` when a caller passes no explicit `shell`.

**Agent availability comes from `registry.isAvailable(id)`** (`lib/ws-handlers-util.js`, `agents.list`), which runs `where`/`which`. A binary installed outside the system PATH reads as "(not installed)"; the fix is an `npxPackage` on the registry entry so it falls back to bun/npx presence.

**`lib/tool-spawner.js`** iterates `BUNX_RUNNERS=['bun','npx']` and detects missing-command via regex on both `error.message` and stdout+stderr.

## Browser Witness

`bun server.js`. Default `PORT=3000` (server.js); the SPA is served under `BASE_URL` (default `/gm/`), so the live app is **http://localhost:3000/gm/** — `/health` and `/` answer at root, the app is under `/gm/`. First request to `/gm/` or `/v1/history/*` triggers a 30-90s ccsniff JSONL walk (curl with a short timeout returns 000 during warmup). AppShell renders nav=[chat,history,settings], SSE `hello`, 0 console errors, backend resolves to `''` (same origin).

## CI / GitHub Actions

Any CI step that spawns the agentgui server must invoke it with `bun`, not `node` (`--ignore-scripts` npm installs leave `better-sqlite3` uncompiled, so `bun:sqlite`'s fallback also fails under Node).

## GM Plugin Autonomy Blocker

gm plugin's pre-tool-use hook gates multi-tool autonomy via a `.gm/needs-gm` marker; the hook content is templated from the gm codebase, not `gm-starter/hooks/` — patching those files does not propagate.

## History Integration via ccsniff

agentgui mounts `ccsniff`'s history router in-process — no external proxy. `server.js` imports `createHistoryRouter` from the `ccsniff` package and mounts it on the internal Express app at `/`, exposing `GET /v1/history/{snapshot,sessions,sessions/:sid/events,search,reindex,stream}`. Reads `~/.claude/projects` by default; override with `CLAUDE_PROJECTS_DIR` env var. Browser client (`site/app/js/backend.js`) calls these same-origin via the agentgui server.

## buildSystemPrompt for claude-code

`lib/provider-config.js` `buildSystemPrompt()` must return `''` for the claude-code agent — a non-empty return (e.g. `"Model: X."`) causes `buildArgs` in `lib/claude-runner-agents.js` to pass `--append-system-prompt` to the claude CLI, which triggers an "argument missing" error on conversation resume. The model is already passed via `--model`; system prompt is only for non-claude-code agents.

## WebSocket Sync Endpoint Testing

`/sync` sends `sync_connected`+clientId on connect; the legacy handler in `lib/ws-legacy-handlers.js` (ping/subscribe/get_subscriptions/unsubscribe/latency_report) runs via codec. Tests must register the message handler before sending.

## better-sqlite3 & Node v24 Startup

Node v24 lacks a prebuilt better-sqlite3 binary; the node path needs a from-source `postinstall` compile, and `start` is `bun server.js || node server.js`. `database.js` tries `bun:sqlite` first.

## Agent/model/session management

- `agents.list` (WS) returns `available` + `npxInstallable` per agent; `agents.models` returns model choices (claude-code -> sonnet/opus/haiku). The chat picker is **agent-then-model**, not a flat model list. Unavailable agents are disabled/gated.
- `chat.sendMessage` accepts `cwd` (defaults to STARTUP_CWD) and `model`/`agentId` separately. `chat.active` (WS) lists in-flight chats with agentId/model/cwd/startedAt/pid; the history tab polls it (3s) and shows a running panel with per-session stop.
- Client (`app.js`): chat transcript persists to `localStorage[agentgui.chat]` and restores on load; tool_use/result events render as chat parts; keyboard shortcuts (g+c/h/s, n, /, ?); settings has an agents-status panel from `health.acp[]`.

## DS CSS cascade — overriding component styles

`installStyles()` injects DS CSS into a runtime `<style>` after the head `<style>`, so local overrides need `!important` or higher specificity than the DS's `.ds-247420`-prefixed rules.

## DS SearchInput accessible name comes from `label`, not `aria-label`

`anentrypoint-design`'s `SearchInput` sets `aria-label = label || placeholder`; it ignores any `aria-label` prop passed directly. To give the search box a real accessible name, pass `label:` (and a matching `placeholder:` for the visible hint) — a post-render `setAttribute` race-loses against the DS re-render, so the prop is the only durable fix.

@.gm/next-step.md
