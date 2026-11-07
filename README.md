# agentgui

A multi-tab terminal host with a file manager, in one Node process and one HTML page.

- **Terminals**: open as many as you need from the `+` button. Each is a real PTY (via `tt-native`) streamed to an xterm.js tab. Output is fanned out to every attached client, late joiners get the last 256 KiB of screen, resizes follow the browser pane, Ctrl+C reaches the foreground job, and exit codes are shown in the tab.
- **Files**: a folder browser with rename, move, delete (soft, restorable), new folder, upload, preview, and download.

## Run

```bash
npm install
PASSWORD='choose-a-password' ENABLE_TERMINAL=1 npm start
```

Open `http://localhost:3000/gm/` (the app is served under `BASE_URL`, default `/gm`).

Use Node, not Bun: the PTY library runs under Node only.

## Configuration

| Variable | Default | Effect |
| --- | --- | --- |
| `PORT` | `3000` | Listen port. |
| `BASE_URL` | `/gm` | Path prefix the app is served under. |
| `PASSWORD` | unset | When set, every route requires it (Basic, `Authorization: Bearer`, `?token=`, or the `agentgui_token` cookie). |
| `ENABLE_TERMINAL` | unset | Terminals are refused unless this is `1` and `PASSWORD` is set. |
| `STARTUP_CWD` | server cwd | Default directory for new terminals and the default Files root when `PASSWORD` is set. |
| `FS_ROOTS` | unset | Extra Files roots, separated by the platform path delimiter. |
| `FS_ALLOW_CWD` | unset | `1` exposes the server cwd as a Files root without a password. |
| `CORS_ORIGIN` | unset | Allowed cross-origin origin. `*` is only for trusted networks. |
| `TRUST_PROXY` | unset | `1` takes the client address from `X-Forwarded-For` for rate limiting. |
| `RATE_LIMIT_MAX` | `3000` | Requests per minute per client address. |
| `HEALTH_NO_AUTH` | unset | `1` exposes `/health` without auth (for probes). |
| `COOKIE_SECURE` | unset | `1` marks the auth cookie `Secure` when served over TLS terminated elsewhere. |

## API

- `GET /health`
- `GET /api/list?dir=`, `GET /api/stat`, `GET /api/file/...`, `GET /api/download/...`, `GET /api/image/...`
- `POST /api/rename`, `POST /api/move`, `POST /api/delete`, `POST /api/restore`, `POST /api/mkdir`, `PUT /api/upload-file`
- `GET /api/terminal/sessions`, `POST /api/terminal/sessions` (`{cols, rows, cwd?}`), `GET|DELETE /api/terminal/sessions/:sid`
- `WS /api/terminal/sessions/:sid?token=` carries the terminal stream. Server-to-client binary frames are PTY output. Server-to-client text frames are JSON control (`{"type":"exit","code":N}`). Client-to-server binary frames are keystrokes. Client-to-server text frames are JSON control (`{"type":"resize","cols":N,"rows":M}`).

## Test

```bash
npm test
```

The suite starts the server on free ports and exercises auth, the file list, several independent terminals, fan-out and replay, resize, Ctrl+C, exit codes, the socket refusing a bad token or a cross-origin page, DELETE, and the disabled-terminal gate.
