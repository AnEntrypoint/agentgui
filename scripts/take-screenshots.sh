#!/usr/bin/env bash
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCS_DIR="$SCRIPT_DIR/../docs"
SESSION="agentgui-screenshots"
LOG_FILE="/config/logs/services/agentgui.log"

PORT=$(grep -oP 'localhost:\K[0-9]+(?=/gm/)' "$LOG_FILE" 2>/dev/null | tail -1)
PORT="${PORT:-9897}"
BASE_URL="http://localhost:$PORT/gm/"

ab() {
  agent-browser --session "$SESSION" "$@"
}

cleanup() {
  agent-browser --session "$SESSION" close 2>/dev/null || true
}
trap cleanup EXIT

echo "Taking screenshots from $BASE_URL"
echo "Saving to $DOCS_DIR"

ab open "$BASE_URL"
ab wait --load networkidle
sleep 1

ab screenshot --full "$DOCS_DIR/screenshot-main.png"
echo "Saved screenshot-main.png"

ab eval 'document.querySelector(".conversation-item")?.click()'
sleep 2
ab wait --load networkidle

ab screenshot --full "$DOCS_DIR/screenshot-chat.png"
echo "Saved screenshot-chat.png"

ab screenshot --full "$DOCS_DIR/screenshot-conversation.png"
echo "Saved screenshot-conversation.png"

ab eval 'var b=document.getElementById("toolsManagerBtn"); if(b){b.style.display="";b.click();}'
sleep 1

ab screenshot --full "$DOCS_DIR/screenshot-tools-popup.png"
echo "Saved screenshot-tools-popup.png"

ab eval 'var p=document.getElementById("toolsPopup"); if(p)p.classList.remove("open");'
sleep 0.5

ab eval 'document.querySelector(".view-toggle-btn[data-view=\"files\"]")?.click()'
sleep 2
ab wait --load networkidle

ab screenshot --full "$DOCS_DIR/screenshot-files.png"
echo "Saved screenshot-files.png"

ab eval 'document.querySelector(".view-toggle-btn[data-view=\"terminal\"]")?.click()'
sleep 1

ab screenshot --full "$DOCS_DIR/screenshot-terminal.png"
echo "Saved screenshot-terminal.png"

echo "All screenshots saved to $DOCS_DIR"
