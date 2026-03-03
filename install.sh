#!/bin/sh
set -e

# Clautel — installer
# Usage: curl -fsSL https://raw.githubusercontent.com/AnasNadeem/clautel/main/install.sh | sh

REQUIRED_NODE_MAJOR=18

echo "Installing clautel..."
echo "License: BSL-1.1 | Source: https://github.com/AnasNadeem/clautel"
echo ""

# Check Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js is required (>= ${REQUIRED_NODE_MAJOR})."
  echo "Install it from https://nodejs.org or via your package manager."
  exit 1
fi

NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
if [ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ]; then
  echo "Error: Node.js >= ${REQUIRED_NODE_MAJOR} required, found ${NODE_MAJOR}."
  echo "Upgrade at https://nodejs.org"
  exit 1
fi

# Check npm
if ! command -v npm >/dev/null 2>&1; then
  echo "Error: npm is required but not found."
  exit 1
fi

# Install
npm install -g clautel

echo ""
echo "Installed! Get started:"
echo ""
echo "  1. clautel setup"
echo "     (you'll need a bot token from @BotFather and your Telegram user ID from @userinfobot)"
echo ""
echo "  2. clautel start"
echo ""
echo "  3. DM your manager bot on Telegram, then use /add to attach a bot to a project."
echo ""
