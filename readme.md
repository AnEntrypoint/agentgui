# AgentGUI

A multi-agent GUI for AI coding assistants. Connects to CLI-based agents (Claude Code, Gemini CLI, OpenCode, Goose, and others) and provides a web interface with real-time streaming output.

## Quick Start

```bash
npx agentgui
```

Or install and run manually:

```bash
git clone https://github.com/AnEntrypoint/agentgui.git
cd agentgui
npm install
npm run dev
```

Open `http://localhost:3000` in your browser.

## What It Does

- Auto-discovers AI coding agents installed on your system (Claude Code, Gemini CLI, OpenCode, Goose, Codex, Kiro, etc.)
- Runs agents with streaming JSON output and displays results in real-time via WebSocket
- Manages conversations with SQLite persistence
- Supports concurrent agent sessions
- Provides file browsing and upload for agent working directories
- Includes speech-to-text and text-to-speech

## Architecture

- `server.js` - HTTP server, REST API, WebSocket endpoint, static file serving
- `database.js` - SQLite database (WAL mode) at `~/.gmgui/data.db`
- `lib/claude-runner.js` - Agent runner framework, spawns CLI processes and parses streaming output
- `lib/speech.js` - Speech processing via Hugging Face transformers
- `static/` - Browser client with streaming renderer, WebSocket manager, and HTML templates
- `bin/gmgui.cjs` - CLI entry point for `npx agentgui`

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | 3000 | Server port |
| `BASE_URL` | /gm | URL prefix |
| `HOT_RELOAD` | true | Watch mode for development |

## License

MIT

## Repository

https://github.com/AnEntrypoint/agentgui
