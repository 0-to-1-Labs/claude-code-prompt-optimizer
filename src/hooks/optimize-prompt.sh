#!/bin/bash

# Claude Code Hook Wrapper Script
# Entry point for the prompt optimization hook (UserPromptSubmit).
#
# Fires on EVERY prompt, so the common case (no <optimize> tag) must be cheap:
# we read stdin and bail immediately, WITHOUT paying Node/tsx/Agent-SDK startup.

# Read the hook payload from stdin once; reuse it below.
INPUT=$(cat)

LOG_FILE="/tmp/claude-code-hook-debug.log"
if [ "$DEBUG" = "true" ]; then
  echo "=== Hook called at $(date) ===" >> "$LOG_FILE"
  echo "Working directory: $(pwd)" >> "$LOG_FILE"
  echo "CLAUDE_CODE_OAUTH_TOKEN set: ${CLAUDE_CODE_OAUTH_TOKEN:+yes}" >> "$LOG_FILE"
  echo "ANTHROPIC_API_KEY set: ${ANTHROPIC_API_KEY:+yes}" >> "$LOG_FILE"
fi

# Fast path: no <optimize> tag → emit nothing and let the prompt pass through
# unchanged. No Node process, no SDK import, no added latency.
if ! printf '%s' "$INPUT" | grep -qi '<optimize>'; then
  [ "$DEBUG" = "true" ] && echo "No <optimize> tag — passthrough (no Node spawn)" >> "$LOG_FILE"
  exit 0
fi

# Ensure nvm/node is in PATH (Claude Code spawns hooks without an interactive shell)
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
TSX_BIN="$ROOT_DIR/node_modules/.bin/tsx"

# When installed as a Claude Code plugin, `/plugin install` clones the repo but
# does NOT run `npm install`, so tsx + the Agent SDK are absent. Provision them
# lazily on the first <optimize> use (one-time cost; cached thereafter). Runs
# only inside the plugin/repo dir, never against the user's project.
if [ ! -x "$TSX_BIN" ] && [ -f "$ROOT_DIR/package.json" ]; then
  [ "$DEBUG" = "true" ] && echo "node_modules missing — bootstrapping deps via npm install" >> "$LOG_FILE"
  ( cd "$ROOT_DIR" && npm install --omit=dev --no-audit --no-fund ) >>"$LOG_FILE" 2>&1
fi

# Prefer the pinned local tsx (no npx resolution overhead); fall back to npx.
if [ -x "$TSX_BIN" ]; then
  printf '%s' "$INPUT" | "$TSX_BIN" "$SCRIPT_DIR/optimize-prompt.ts"
else
  printf '%s' "$INPUT" | npx tsx "$SCRIPT_DIR/optimize-prompt.ts"
fi

EXIT_CODE=$?

if [ "$DEBUG" = "true" ]; then
  echo "Hook completed with exit code: $EXIT_CODE" >> "$LOG_FILE"
  echo "" >> "$LOG_FILE"
fi

exit $EXIT_CODE
