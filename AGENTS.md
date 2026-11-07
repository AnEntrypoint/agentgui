# AgentGUI: agent notes

Scope: a multi-tab terminal host plus a file manager. Everything else (chat, agents, history, git, settings) was removed deliberately. Do not reintroduce it without a decision.

## Runtime

- Node only. `npm start` is `node server.js`. The PTY library (`tt-native`) loads and runs under Node. Under Bun, `uv_spawn` panics and `node-pty` exits silently, so Bun is not a supported runtime.
- Dependencies are `ws`, `lru-cache`, `tt-native` (pinned at 1.1.1, which ships linux-x64 prebuilds, so there is no native compile). Do not add Express, a database, Electron, or any browser-automation library (puppeteer, playwright) to this repo.

## Terminal relay (lib/terminal.js, lib/terminal-socket.js)

Modelled on AnEntrypoint/sharesies. Keep these properties when changing it:

- One PTY per session. Output is broadcast to every attached socket. Any attached client can write.
- Spawn through `sh -c 'if T=$(tty ...); then exec 0<"$T"; fi; exec "$@"'`. libuv's setsid does not make the PTY the controlling terminal, so the reopen step is what makes Ctrl+C reach the foreground job. Keep it.
- Replay: the last 256 KiB of output is sent as one binary frame on attach. Attach then nudges the PTY size (cols-1, then cols) so full-screen apps redraw for late joiners.
- Backpressure: a socket with more than 8 MiB buffered is terminated rather than allowed to grow memory unbounded.
- Teardown is idempotent. `closeSession` sends a `{"type":"exit","code":null}` frame, sends SIGHUP, then SIGKILL after 1.5 s. A natural exit sends `{"type":"exit","code":N}` and closes the socket with 1000.
- Frames: binary is data in both directions. Text is JSON control only (`exit` server-to-client, `resize` client-to-server). Never send keystrokes as text, because a typed `{` must not be parsed as control.
- Startup latency is not a relay bug. On the dev container the interactive rc (`/config/.bashrc` sources `~/beforestart`) takes about 5 s before bash reads input, so the first keystrokes sit in the PTY until then. Check with `TERM=dumb` or `--norc` before blaming the relay.
- MAX_SESSIONS is 50. Exceeding it returns 429.
- The child environment drops `PASSWORD`. Never pass it to the shell.
- `ENABLE_TERMINAL=1` and `PASSWORD` are both required. Without them the HTTP routes return 403 and the upgrade is refused.

## Auth (lib/http-handler.js, lib/auth.js)

- With `PASSWORD` set, accept Basic, `Authorization: Bearer`, `?token=`, or the `agentgui_token` cookie. Compare SHA-256 digests with `timingSafeEqual`. A failed attempt adds 100 to the rate-limit bucket.
- The WebSocket authenticates with `?token=` only, and rejects any Origin whose host differs from the Host header (cross-site WebSocket hijacking).
- The page receives `window.__WS_TOKEN` from asset-server when `PASSWORD` is set. This is the same secret, so it is only ever delivered to an already-authenticated page.
- Do not send `Authorization: Bearer` from same-origin app fetches. Behind an nginx Basic-Auth proxy, a Bearer header replaces the browser's cached Basic credentials and the proxy rejects the request before it reaches agentgui. Use `?token=` for app fetches.
- Mutating methods (POST, PUT, DELETE) need `Sec-Fetch-Site` same-origin or none, or `application/json`, or an Authorization header, and a matching Origin when one is present.

## Files (lib/http-routes/*)

- Every path goes through `confineToRoots` with `fs.realpath` re-confinement, so a symlink pointing outside an allowed root fails closed.
- Delete is a soft delete into a per-root `.agentgui-trash/` with a restore endpoint and a retention cap. It is not a hard unlink.
- Names must pass `sanitizeEntryName`. Upload, mkdir, rename and list bodies are scanned by `SECRET_RE` before being echoed to logs or responses.
- Non-ASCII download names use RFC 5987 `Content-Disposition`.
- After touching any mutation route, run `node scripts/validate-mutations.mjs` against a running server (`PASSWORD` honoured).
- Default allowed roots still include `~/.claude/projects` (leftover from the chat app); `FS_ROOTS` and `STARTUP_CWD` widen them. Changing that default is a product decision.

## Client (site/app)

- `index.html` loads the vendored design kit (`vendor/anentrypoint-design/247420.{js,css}`) and the vendored xterm.js (`vendor/xterm/`) through the importmap. Do not load scripts from a CDN: the CSP is `script-src 'self'` with a per-request nonce.
- asset-server.js maps only .html, .js, .css, .json, .png, .jpg, .svg. Serve any new extension (for example .mjs) by adding it to MIME_TYPES, or the browser refuses it as application/octet-stream. Vendored xterm files are .js for this reason.
- Terminal xterm instances live in a plain-DOM host outside the webjsx `#app` root, so webjsx re-renders never clobber their DOM. Hidden terminal tabs stay mounted and are re-fitted when shown.
- Keyed-children rule (webjsx): mixing keyed VElements with null, strings or numbers in one children array crashes `applyDiff` with "reading 'key'". Build the array and `.filter(Boolean)` it. A component that switches between two different child shapes at one slot needs a distinct key on each branch.
- The `C` destructure in app.js must list every kit component the code calls.
- Status words are ASCII (live, connecting, exited, disconnected). No decorative glyphs in GUI output. Middot and ellipsis are fine.
- Per-viewer state (open terminal sids, file prefs) lives in localStorage behind try/catch. Nothing that must persist reliably lives there.
- Live browser verification uses the gm `playwriter` verbs or the Chrome tools. Do not add a browser dependency to the repo.

## Working rules

- Comments are forbidden in code. Anything that cannot be expressed in code belongs here, compressed to a rule.
- Work on main in the shared checkout. Do not clone scratch copies.
- Commit and push only when the task asks, under the lanmower identity.
- Run `npm test` before reporting a server change as done. Run `node --check` on any JS file you touched.
