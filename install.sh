#!/bin/bash
set -e

# Detect runtime (prefer bun, fall back to node)
RUNTIME=""
if command -v bun &> /dev/null; then
  RUNTIME=bun
elif command -v node &> /dev/null; then
  RUNTIME=node
else
  echo "Error: Neither bun nor node is installed. Install one with:" >&2
  echo "  curl -fsSL https://bun.sh/install | bash  # Bun (recommended, faster)" >&2
  echo "  Or: curl https://nodejs.org/en/download/" >&2
  exit 1
fi

# Create temp directory for installation
TMPDIR=$(mktemp -d)
trap "rm -rf $TMPDIR" EXIT

echo "Downloading gmgui from GitHub..."
cd "$TMPDIR"

# Use git if available, otherwise use curl to download tarball
if command -v git &> /dev/null; then
  git clone --depth=1 https://github.com/AnEntrypoint/gmgui.git . 2>&1 | grep -v "^Cloning"
else
  echo "Downloading tarball..."
  curl -fsSL https://github.com/AnEntrypoint/gmgui/archive/refs/heads/main.tar.gz | tar xz --strip-components=1
fi

echo "Installing dependencies with $RUNTIME..."
if [ "$RUNTIME" = "bun" ]; then
  bun install --frozen-lockfile 2>&1 | grep -E "added|removed|found|vulnerabilities" | tail -1
else
  npm install 2>&1 | grep -E "added|removed|found|vulnerabilities" | tail -1
  # For Node.js, we need better-sqlite3
  echo "Installing better-sqlite3 for Node.js..."
  npm install better-sqlite3 2>&1 | grep -E "added|removed|found|vulnerabilities" | tail -1
fi

echo ""
echo "Starting gmgui server on http://localhost:3000"
echo "Press Ctrl+C to stop"
echo ""

if [ "$RUNTIME" = "bun" ]; then
  bun run server.js
else
  node server.js
fi
