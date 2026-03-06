# AgentGUI

[![npm version](https://img.shields.io/npm/v/agentgui?color=brightgreen)](https://www.npmjs.com/package/agentgui)
[![npm downloads](https://img.shields.io/npm/dw/agentgui?color=brightgreen)](https://www.npmjs.com/package/agentgui)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![GitHub Pages](https://img.shields.io/badge/docs-live-blue)](https://anentrypoint.github.io/agentgui/)

Multi-agent GUI client for AI coding agents (Claude Code, Gemini CLI, OpenCode, Goose, etc.) with real-time streaming, WebSocket sync, and SQLite persistence.

![Main Interface](docs/screenshot-main.png)

## Features

- 🤖 **Multi-Agent Support** - Switch between Claude Code, Gemini CLI, OpenCode, Kilo, and more from one interface
- ⚡ **Real-Time Streaming** - Watch agents work with live streaming output and tool calls via WebSocket
- 💾 **Session Persistence** - Full conversation history stored in SQLite with WAL mode
- 🔄 **WebSocket Sync** - Live updates across multiple clients with automatic reconnection
- 🎤 **Voice Integration** - Speech-to-text and text-to-speech powered by Hugging Face Transformers (no API keys)
- 🛠️ **Tool Management** - Install and update agent plugins directly from the UI
- 📁 **File Browser** - Drag-and-drop uploads, direct file editing, and context-aware operations
- 🔌 **Developer Friendly** - Hot reload, REST API, WebSocket endpoints, and extensible plugin system

### Screenshots

| Main Interface | Chat View |
|----------------|-----------|
| ![Main](docs/screenshot-main.png) | ![Chat](docs/screenshot-chat.png) |

| Files Browser | Terminal View |
|---------------|---------------|
| ![Files](docs/screenshot-files.png) | ![Terminal](docs/screenshot-terminal.png) |

| Tools Management | Conversation |
|------------------|--------------|
| ![Tools](docs/screenshot-tools-popup.png) | ![Conversation](docs/screenshot-conversation.png) |

## Quick Start

### Using npx (Recommended)

```bash
npx agentgui
```

### Manual Installation

```bash
git clone https://github.com/AnEntrypoint/agentgui.git
cd agentgui
npm install
npm run dev
```

Server starts on `http://localhost:3000/gm/`

## System Requirements

- Node.js 18+ (LTS recommended)
- SQLite 3
- Modern browser (Chrome, Firefox, Safari, Edge)
- At least one AI coding agent installed (Claude Code, Gemini CLI, etc.)
- Optional: Python 3.9+ for text-to-speech on Windows

## Architecture

```
server.js              HTTP server + WebSocket + all API routes
database.js            SQLite setup (WAL mode), schema, query functions
lib/claude-runner.js   Agent framework - spawns CLI processes, parses stream-json output
lib/acp-manager.js     ACP tool lifecycle - auto-starts HTTP servers, restart on crash
lib/speech.js          Speech-to-text and text-to-speech via @huggingface/transformers
static/index.html      Main HTML shell
static/app.js          App initialization
static/js/client.js    Main client logic
static/js/conversations.js       Conversation management
static/js/streaming-renderer.js  Renders Claude streaming events as HTML
static/js/websocket-manager.js   WebSocket connection handling
```

### Key Details

- Agent discovery scans PATH for known CLI binaries at startup
- Database lives at `~/.gmgui/data.db` (WAL mode for concurrent access)
- WebSocket endpoint at `/gm/sync` for real-time updates
- ACP tools (OpenCode, Kilo) auto-launch as HTTP servers on startup with health checks

## REST API

All routes prefixed with `/gm`:

**Conversations:**
- `GET /api/conversations` - List conversations
- `POST /api/conversations` - Create conversation
- `GET /api/conversations/:id` - Get conversation with streaming status
- `POST /api/conversations/:id/messages` - Send message
- `DELETE /api/conversations/:id` - Delete conversation

**Agents & Tools:**
- `GET /api/agents` - List discovered agents
- `GET /api/tools` - List detected tools with installation status
- `POST /api/tools/:id/install` - Install tool
- `POST /api/tools/:id/update` - Update tool

**Speech:**
- `POST /api/stt` - Speech-to-text (raw audio input)
- `POST /api/tts` - Text-to-speech (returns audio)
- `GET /api/speech-status` - Check model download progress

**WebSocket:** `/gm/sync` - Subscribe to conversation/session updates with events like `streaming_start`, `streaming_progress`, `streaming_complete`

## Environment Variables

- `PORT` - Server port (default: 3000)
- `BASE_URL` - URL prefix (default: /gm)
- `STARTUP_CWD` - Working directory passed to agents
- `HOT_RELOAD` - Enable watch mode (default: true)

## Troubleshooting

### Server Won't Start
- Check if port 3000 is in use: `lsof -i :3000` (macOS/Linux) or `netstat -ano | findstr :3000` (Windows)
- Try a different port: `PORT=4000 npm run dev`

### Agent Not Detected
- Verify agent is installed: `which claude` / `where claude`
- Check PATH includes agent binary location
- Restart server after installing new agents

### WebSocket Connection Failed
- Verify BASE_URL matches your deployment
- Check browser console for errors
- Ensure no firewall blocking WebSocket connections

### Speech Models Not Downloading
- Check internet connection and firewall
- Verify `~/.gmgui/models/` is writable
- Monitor progress via `/api/speech-status` endpoint

## Development

```bash
npm run dev        # Start with watch mode and hot reload
npm start          # Production mode (no watch)
npm test           # Run tests (if available)
```

Hot reload is enabled by default. File changes trigger automatic restart without losing state.

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## Links

- **GitHub:** https://github.com/AnEntrypoint/agentgui
- **npm:** https://www.npmjs.com/package/agentgui
- **Documentation:** https://anentrypoint.github.io/agentgui/
- **Issues:** https://github.com/AnEntrypoint/agentgui/issues

## License

MIT © [AnEntrypoint](https://github.com/AnEntrypoint)
