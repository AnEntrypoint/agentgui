# AgentGUI

[![GitHub Pages](https://img.shields.io/badge/GitHub_Pages-Enabled-blue?logo=github)](https://anentrypoint.github.io/agentgui/)
[![npm version](https://badge.fury.io/js/agentgui.svg)](https://www.npmjs.com/package/agentgui)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Multi-agent GUI client for AI coding agents** with real-time streaming, WebSocket sync, and SQLite persistence.

![AgentGUI Main Interface](docs/screenshot-main.png)

## ✨ Features

- **🤖 Multi-Agent Support** - Claude Code, Gemini CLI, OpenCode, Goose, Kilo, and more
- **📡 Real-Time Streaming** - Live execution visualization with WebSocket sync
- **💾 Persistent Storage** - SQLite-based conversation and session history
- **🎤 Voice I/O** - Built-in speech-to-text and text-to-speech with @huggingface/transformers
- **📁 File Browser** - Integrated file system explorer with drag-drop upload
- **🔧 Tool Manager** - Install and update agent plugins directly from UI
- **🎨 Modern UI** - Dark/light themes with responsive design
- **🔌 ACP Protocol** - Auto-discovery and lifecycle management for ACP tools

## 📸 Screenshots

<table>
  <tr>
    <td><img src="docs/screenshot-chat.png" alt="Chat View" width="400"/><br/><em>Chat & Conversation View</em></td>
    <td><img src="docs/screenshot-files.png" alt="Files Browser" width="400"/><br/><em>File System Browser</em></td>
  </tr>
  <tr>
    <td><img src="docs/screenshot-terminal.png" alt="Terminal" width="400"/><br/><em>Terminal & Execution Output</em></td>
    <td><img src="docs/screenshot-tools-popup.png" alt="Tools" width="400"/><br/><em>Tool Management</em></td>
  </tr>
</table>

## 🚀 Quick Start

```bash
# Install globally
npm install -g agentgui

# Run the server
agentgui

# Or use npx
npx agentgui
```

Server starts on `http://localhost:3000` and redirects to `/gm/`.

## 📋 System Requirements

- **Node.js**: v18+ or Bun v1.0+
- **OS**: Linux, macOS, or Windows
- **RAM**: 2GB+ recommended
- **Disk**: 500MB for voice models (auto-downloaded)

## 🏗️ Architecture

```
server.js              HTTP server + WebSocket + API routes
database.js            SQLite (WAL mode) + queries
lib/claude-runner.js   Agent framework - spawns CLI processes
lib/acp-manager.js     ACP tool lifecycle management
lib/speech.js          Speech-to-text + text-to-speech
static/                Frontend (vanilla JS, no build step)
```

### Key Components

- **Agent Discovery**: Scans PATH for known CLI binaries at startup
- **Database**: `~/.gmgui/data.db` - conversations, messages, events, sessions, stream chunks
- **WebSocket**: Real-time sync at `BASE_URL/sync` with subscribe/unsubscribe
- **ACP Tools**: Auto-launches OpenCode (port 18100) and Kilo (port 18101) as HTTP servers

## 🔌 API Endpoints

All routes prefixed with `BASE_URL` (default `/gm`):

### Conversations
- `GET /api/conversations` - List all conversations
- `POST /api/conversations` - Create new conversation
- `GET /api/conversations/:id` - Get conversation details
- `POST /api/conversations/:id/messages` - Send message
- `POST /api/conversations/:id/stream` - Start streaming execution

### Tools
- `GET /api/tools` - List detected tools with installation status
- `POST /api/tools/:id/install` - Install tool
- `POST /api/tools/:id/update` - Update tool
- `POST /api/tools/update` - Batch update all tools

### Voice
- `POST /api/stt` - Speech-to-text (raw audio)
- `POST /api/tts` - Text-to-speech
- `GET /api/speech-status` - Model loading status

## 🎙️ Voice Models

Speech models (~470MB) are auto-downloaded on first launch:
- **Whisper Base** (~280MB) - STT from HuggingFace
- **TTS Models** (~190MB) - Custom text-to-speech

Models cached at `~/.gmgui/models/`.

## 🛠️ Development

```bash
# Clone repository
git clone https://github.com/AnEntrypoint/agentgui.git
cd agentgui

# Install dependencies
npm install

# Run dev server with watch mode
npm run dev

# Build portable binaries
npm run build:portable
```

## 📦 Tool Detection

AgentGUI auto-detects installed AI coding tools:
- **Claude Code**: `@anthropic-ai/claude-code`
- **Gemini CLI**: `@google/gemini-cli`
- **OpenCode**: `opencode-ai`
- **Kilo**: `@kilocode/cli`
- **Codex**: `@openai/codex`

Install/update directly from the Tools UI.

## 🌐 Environment Variables

- `PORT` - Server port (default: 3000)
- `BASE_URL` - URL prefix (default: /gm)
- `STARTUP_CWD` - Working directory for agents
- `HOT_RELOAD` - Set to "false" to disable watch mode

## 📝 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions welcome! Please read our contributing guidelines before submitting PRs.

## 🔗 Links

- [GitHub Repository](https://github.com/AnEntrypoint/agentgui)
- [npm Package](https://www.npmjs.com/package/agentgui)
- [Documentation](https://anentrypoint.github.io/agentgui/)
- [Issue Tracker](https://github.com/AnEntrypoint/agentgui/issues)
