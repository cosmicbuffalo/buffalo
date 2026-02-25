#!/bin/sh
set -e

REPO_URL="https://github.com/owner/buffalo.git"
INSTALL_DIR="${BUFFALO_INSTALL_DIR:-$HOME/.buffalo-cli}"

echo "🦬 Installing Buffalo — GitHub PR Collaborator Bot"
echo ""

# Check Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "❌ Node.js is required but not installed."
  echo "   Install Node >= 22: https://nodejs.org/"
  exit 1
fi

NODE_VERSION=$(node -e "console.log(process.versions.node.split('.')[0])")
if [ "$NODE_VERSION" -lt 22 ]; then
  echo "❌ Node.js >= 22 is required (found v$(node -v))"
  echo "   Update Node: https://nodejs.org/"
  exit 1
fi

# Check tmux
if ! command -v tmux >/dev/null 2>&1; then
  echo "⚠️  tmux is required but not installed."
  echo ""
  if command -v apt-get >/dev/null 2>&1; then
    echo "Install with: sudo apt-get install tmux"
  elif command -v brew >/dev/null 2>&1; then
    echo "Install with: brew install tmux"
  elif command -v yum >/dev/null 2>&1; then
    echo "Install with: sudo yum install tmux"
  else
    echo "Install tmux for your system: https://github.com/tmux/tmux"
  fi
  exit 1
fi

echo "✅ Node.js $(node -v) detected"
echo "✅ tmux $(tmux -V) detected"
echo ""

# Clone or update the repo
if [ -d "$INSTALL_DIR" ]; then
  echo "Updating existing installation..."
  cd "$INSTALL_DIR"
  git pull --ff-only
else
  echo "Cloning buffalo..."
  git clone --depth=1 "$REPO_URL" "$INSTALL_DIR"
  cd "$INSTALL_DIR"
fi

# Install deps and build
echo "Installing dependencies..."
npm ci --ignore-scripts
echo "Building..."
npm run build

# Link globally
echo "Linking buffalo to PATH..."
npm link

# Create config directory
mkdir -p "$HOME/.buffalo"

echo ""
echo "✅ Buffalo installed successfully!"
echo ""
echo "Get started:"
echo "  cd <your-repo>"
echo "  buffalo init"
echo "  buffalo start"
echo ""
