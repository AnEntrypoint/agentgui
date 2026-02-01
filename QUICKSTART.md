# GMGUI Quick Start

Get up and running with GMGUI in 5 minutes.

## 1. Installation (30 seconds)

```bash
git clone https://github.com/AnEntrypoint/gmgui.git
cd gmgui
npm install
```

## 2. Start Server (10 seconds)

```bash
npm start
```

Open browser to `http://localhost:3000`

## 3. Connect an Agent (2 minutes)

### Option A: Using Mock Agent (Easiest)

In another terminal:

```bash
node examples/mock-agent.js
```

In another terminal:

```bash
node examples/agent-client.js --endpoint ws://localhost:3001
```

Then in the browser:
- Look for agent in the sidebar
- Click "Select"
- Type a message in the input box
- Hit Enter to send

### Option B: Connect Your Own Agent

```bash
node examples/agent-client.js \
  --id my-agent \
  --endpoint ws://your-agent-server:3001
```

### Option C: Manual WebSocket Connection

In browser console:

```javascript
// Connect directly
const ws = new WebSocket('ws://localhost:3000/agent/my-agent');
ws.onopen = () => console.log('Connected!');
ws.onmessage = (e) => console.log('Message:', e.data);
```

## 4. Send a Message (5 seconds)

1. Select agent from sidebar
2. Type message in input field
3. Press Enter or click Send
4. Watch message appear in console

## 5. View Settings

Click "Settings" tab to:
- Change message format (MessagePack or JSON)
- Toggle auto-scroll
- Adjust connection timeout

## Troubleshooting

### Port Already in Use
```bash
PORT=3001 npm start
```

### Agent Won't Connect
- Check agent endpoint is valid: `curl ws://localhost:3001`
- Check GMGUI server is running: `curl http://localhost:3000`
- Check browser console for WebSocket errors

### No Messages Appearing
- Make sure agent is selected
- Check "Auto-scroll Console" is enabled
- Check browser DevTools Network tab for WebSocket activity

## Next Steps

- Read [FEATURES.md](FEATURES.md) for full capabilities
- Check [README.md](README.md) for detailed documentation
- Review [examples/](examples/) for integration patterns
- Run integration tests: `./test-integration.sh`

## Development

Enable hot reload:

```bash
npm run dev
```

Edit any file in `static/` and browser auto-refreshes.

## Key Files

| File | Purpose |
|------|---------|
| `server.js` | Main HTTP + WebSocket server |
| `static/app.js` | Frontend application logic |
| `static/index.html` | UI layout |
| `static/styles.css` | Custom styles |
| `examples/agent-client.js` | Agent client library |
| `examples/mock-agent.js` | Test agent server |

## CLI Commands

```bash
# Start server (production)
npm start

# Start with hot reload (development)
npm run dev

# Run integration tests
./test-integration.sh

# Start mock agent
node examples/mock-agent.js

# Connect agent to gmgui
node examples/agent-client.js --id agent1 --endpoint ws://localhost:3001

# Connect with verbose logging
node examples/agent-client.js --verbose
```

## API Quick Reference

```bash
# Get all agents
curl http://localhost:3000/api/agents

# Send message to agent
curl -X POST http://localhost:3000/api/agents/my-agent \
  -H "Content-Type: application/json" \
  -d '{"type":"message","content":"hello"}'
```

## WebSocket Messages

From browser to agent:
```javascript
{
  type: "message",
  content: "Hello agent",
  timestamp: 1234567890
}
```

From agent to browser:
```javascript
{
  type: "response",
  content: "Hello back",
  agentId: "my-agent",
  timestamp: 1234567890
}
```

---

**That's it! You're ready to manage multiple agents with GMGUI.**
