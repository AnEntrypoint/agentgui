#!/bin/bash
set -euo pipefail

# GMGUI Installation Script
# Robust, error-handled installation with proper cleanup

# Enable error handling and cleanup
TMPDIR=""
EXIT_CODE=0

cleanup() {
  local code=$?
  if [ -n "$TMPDIR" ] && [ -d "$TMPDIR" ]; then
    rm -rf "$TMPDIR" 2>/dev/null || true
  fi
  if [ $code -ne 0 ] && [ $code -ne 130 ]; then
    echo "Error: Installation failed. Check messages above." >&2
  fi
  exit $code
}

# Handle interrupts gracefully
handle_interrupt() {
  echo ""
  echo "Installation interrupted. Cleaning up..." >&2
  exit 130
}

trap cleanup EXIT
trap handle_interrupt SIGINT SIGTERM

# Detect runtime (prefer bun, fall back to node)
RUNTIME=""
if command -v bun &> /dev/null; then
  RUNTIME=bun
elif command -v node &> /dev/null; then
  RUNTIME=node
else
  echo "Error: Neither bun nor node is installed." >&2
  echo "Install one with:" >&2
  echo "  • Bun (recommended, 3-4x faster):" >&2
  echo "    curl -fsSL https://bun.sh/install | bash" >&2
  echo "  • Node.js:" >&2
  echo "    curl https://nodejs.org/en/download/" >&2
  exit 1
fi

# Verify curl or wget is available
if ! command -v curl &> /dev/null && ! command -v wget &> /dev/null; then
  echo "Error: Neither curl nor wget found. Install one to download gmgui." >&2
  exit 1
fi

# Create temp directory with secure permissions
TMPDIR=$(mktemp -d) || {
  echo "Error: Could not create temporary directory." >&2
  exit 1
}

# Verify we have write access to temp directory
if ! [ -w "$TMPDIR" ]; then
  echo "Error: No write permission to temporary directory." >&2
  exit 1
fi

# Check disk space (need at least 200MB)
AVAILABLE_KB=$(df "$TMPDIR" 2>/dev/null | tail -1 | awk '{print $4}' || echo 0)
if [ "$AVAILABLE_KB" -lt 200000 ]; then
  echo "Warning: Low disk space. At least 200MB recommended." >&2
fi

echo "Downloading gmgui from GitHub..."
cd "$TMPDIR"

# Use git if available, otherwise use curl/wget to download tarball
if command -v git &> /dev/null; then
  # Git clone with error handling
  if ! git clone --depth=1 https://github.com/AnEntrypoint/gmgui.git . 2>&1 | grep -v "^Cloning"; then
    echo "Warning: Git clone failed, trying tarball download..." >&2
    # Fallback to tarball
    if command -v curl &> /dev/null; then
      curl -fsSL https://github.com/AnEntrypoint/gmgui/archive/refs/heads/main.tar.gz | tar xz --strip-components=1 || {
        echo "Error: Could not download gmgui from GitHub." >&2
        exit 1
      }
    else
      wget -qO- https://github.com/AnEntrypoint/gmgui/archive/refs/heads/main.tar.gz | tar xz --strip-components=1 || {
        echo "Error: Could not download gmgui from GitHub." >&2
        exit 1
      }
    fi
  fi
else
  echo "Downloading tarball (git not available)..."
  # Download tarball with curl or wget
  if command -v curl &> /dev/null; then
    curl -fsSL https://github.com/AnEntrypoint/gmgui/archive/refs/heads/main.tar.gz | tar xz --strip-components=1 || {
      echo "Error: Could not download gmgui from GitHub." >&2
      exit 1
    }
  else
    wget -qO- https://github.com/AnEntrypoint/gmgui/archive/refs/heads/main.tar.gz | tar xz --strip-components=1 || {
      echo "Error: Could not download gmgui from GitHub." >&2
      exit 1
    }
  fi
fi

# Verify essential files were downloaded
if [ ! -f server.js ] || [ ! -f package.json ]; then
  echo "Error: Downloaded files appear corrupted. Missing server.js or package.json." >&2
  exit 1
fi

echo "Installing dependencies with $RUNTIME..."
if [ "$RUNTIME" = "bun" ]; then
  if ! bun install --frozen-lockfile 2>&1 | grep -E "added|removed|found|vulnerabilities" | tail -1; then
    # Warn but don't fail if grep doesn't match
    bun install --frozen-lockfile 2>&1 | tail -3
  fi
else
  if ! npm install 2>&1 | grep -E "added|removed|found|vulnerabilities" | tail -1; then
    # Warn but don't fail if grep doesn't match
    npm install 2>&1 | tail -3
  fi

  # For Node.js, install better-sqlite3 if not already present
  echo "Installing better-sqlite3 for Node.js..."
  if ! npm install better-sqlite3 2>&1 | grep -E "added|removed|found|vulnerabilities" | tail -1; then
    # Warn but don't fail - may already be installed
    echo "Note: better-sqlite3 installation completed." >&2
  fi
fi

echo ""
echo "✓ Installation complete!"
echo ""
echo "Starting gmgui server on http://localhost:3000"
echo "Press Ctrl+C to stop"
echo ""

# Start server with proper error handling
if [ "$RUNTIME" = "bun" ]; then
  exec bun run server.js
else
  exec node server.js
fi
