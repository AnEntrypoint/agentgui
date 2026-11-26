# gmweb terminal handoff for agentgui

Written by the gmweb side (`/config/gmweb`). agentgui's own side is already on `main` at `fbf6fc7` ("enable terminals by default when PASSWORD is set"): terminals are on whenever `PASSWORD` is set, and `ENABLE_TERMINAL=0` turns them off. This note records what gmweb now relies on, so agentgui changes keep it true.

## What gmweb runs

- `startup/services/agentgui.js` launches `npx -y github:AnEntrypoint/agentgui#main`. No version pin. The resolved `main` is `fbf6fc7`, which has terminals.
- `docker-compose.yaml` and `docker-compose.headless.yaml` pass `PASSWORD=${PASSWORD:-password}` and `ENABLE_TERMINAL=${ENABLE_TERMINAL:-1}`. The service still forces `ENABLE_TERMINAL=1` in the child env, so the compose default is visible, not a second source.
- Run agentgui at `320b7d0` or later (rate-limit key fix; runtime change since `fbf6fc7` is only `lib/http-handler.js`). After the restart, confirm the `resolved` field of `/config/.gmweb/npm-cache/_npx/*/package-lock.json` names that commit.
- The child env inherits the supervisor env (so `PASSWORD` arrives) and sets `BASE_URL=/gm`, `PORT=9897`, `HOT_RELOAD=false`, `NODE_ENV=production`, and `ENABLE_TERMINAL=1`. If `PASSWORD` is unset, gmweb logs a warning, and agentgui then refuses terminals with 403.
- nginx (`docker/nginx-sites-enabled-default`, both server blocks, and the `docker/nginx-setup.sh` fallback) serves:
  - `/gm/` with nginx Basic auth, upgrade headers, and the `/gm/` prefix. This carries the terminal REST routes `/gm/api/terminal/*`.
  - `/gm/sync` with Basic auth off, as before.
  - `~ "^/gm/api/terminal/sessions/[0-9a-f]{16}$"` with Basic auth off (the regex must be quoted: nginx reads an unquoted `{` as a block opener), upgrade headers, and `proxy_pass http://127.0.0.1:9897;` with no URI, so the original `/gm/...` path reaches agentgui unchanged.

## Why the terminal socket has its own nginx location

On the live host before this change: unauthenticated `GET /gm/api/terminal/sessions` gave 401, authenticated gave 200, and a WebSocket upgrade to `/gm/api/terminal/sessions/<id>?token=...` gave 401 with a `WWW-Authenticate: Basic` challenge from nginx. A browser WebSocket cannot answer that challenge, so the terminal could not connect. The socket location removes only the nginx Basic gate on that one path.

## What agentgui must keep

- Keep the PASSWORD requirement and the `ENABLE_TERMINAL !== '0'` gate, as in `fbf6fc7`.
- Keep the `?token=` check on `/api/terminal/sessions/<16 hex>` and the origin check. With nginx Basic off on that path, this check is the only gate on the socket.
- Keep `GET /api/terminal/sessions` answering 200 when authenticated. The gmweb live probe relies on it: a 404 would mean a build without terminals.
- Terminal sessions are in memory. Restarting agentgui closes every open terminal.

## Verify

- Offline: `npm run check:agentgui-terminal` (static assertions over agentgui.js, both nginx files, the ENABLE_TERMINAL guard, and the docs).
- Live, on a running host with PASSWORD in the environment: `npm run check:agentgui-terminal:live`. It prints status codes only and never the password.

## Rollout (not performed here)

- The live host still runs the pre-change nginx, which is byte-identical to the previous template. Applying the change there means copying the template to `/etc/nginx/sites-available/default` and running `sudo nginx -s reload`. The reload is graceful: established connections finish on the old workers. This needs the owner's go-ahead and has not been done.
- On the next container boot, `docker/rest-of-startup.sh` fetches the startup tree and template from `main`, so the change lands then.
- An agentgui restart is not needed for the socket fix. `ENABLE_TERMINAL=1` makes an existing default explicit. A restart closes every open terminal and chat session, so it is not part of the rollout.

## Open

- The full `npm run check` is red on this box for reasons outside this change. `startup/check-runtime-install.mjs`, `startup/check-post-restart.mjs --offline`, `scripts/check-gm-upstream-drift.mjs`, and `startup/check-startup-sources.mjs` read `/workspace/gm/scripts/install.sh`, which is absent here (the upstream checkout is at `/config/workspace/gm`), and the vendored installer differs from the upstream bytes. `scripts/check-rollout-docs.mjs` and `startup/validate-rollout-report.mjs` hard-fail on the same missing path.
- Commit identity: `git config user.email` in gmweb is `almagestfraternite@gmail.com`, not the `admin@coas.co.za` the publish guardrail requires. Nothing is committed or pushed until the owner confirms the identity.
- The agentgui-side handoff `/config/gmweb/docs/agentgui-terminal-handoff.md` was not present when this note was written.

## agentgui side (added by agentgui, not part of the gmweb note above)

- agentgui `main` is at `ce70e2a`. Run `320b7d0` or later. `ce70e2a` adds only `scripts/witness-gm-terminal.mjs`, the `check` and `check:gm-terminal` scripts and AGENTS.md.
- The rate-limit key is the last `X-Forwarded-For` hop when the socket peer is loopback. `TRUST_PROXY` no longer needs to be set. `TRUST_PROXY=0` turns this off.
- Local witness: `npm run check` runs the unit tests and `npm run check:gm-terminal`. The witness fails with `TRUST_PROXY=0` (429 for every client) and passes by default (11 of 11).
- The `/gm/` socket still needs the nginx location in the gmweb handoff at `/config/gmweb/docs/agentgui-terminal-handoff.md`. Nothing in agentgui can replace it.
