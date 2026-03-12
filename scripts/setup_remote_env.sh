#!/usr/bin/env bash
# Setup environment for Claude Code remote sessions.
# Reads .env and writes vars to $CLAUDE_ENV_FILE so they persist.

# Only run in remote sessions
if [ -z "$CLAUDE_CODE_REMOTE" ]; then
  exit 0
fi

# Need CLAUDE_ENV_FILE to write to
if [ -z "$CLAUDE_ENV_FILE" ]; then
  echo "Warning: CLAUDE_ENV_FILE not set, skipping env setup"
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
ENV_FILE="$PROJECT_DIR/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "Warning: No .env file found at $ENV_FILE"
  echo "Copy .env.example to .env and fill in your values"
  exit 0
fi

# Write each non-comment, non-empty line from .env to CLAUDE_ENV_FILE
while IFS= read -r line; do
  # Skip comments and empty lines
  [[ -z "$line" || "$line" =~ ^# ]] && continue
  echo "$line" >> "$CLAUDE_ENV_FILE"
done < "$ENV_FILE"

# Install deps if needed
if [ ! -d "$PROJECT_DIR/node_modules" ]; then
  echo "Installing dependencies..."
  cd "$PROJECT_DIR" && pnpm install
fi

echo "Remote environment configured."
