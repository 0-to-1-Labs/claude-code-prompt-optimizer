#!/bin/bash
# SessionStart bootstrap for the prompt-optimizer plugin.
#
# Plugins are not `npm install`-ed when installed, but the <optimize> hook needs
# node_modules (tsx + @anthropic-ai/claude-agent-sdk). This installs them once,
# into the plugin directory, on the first session after install.
#
# Idempotent and non-fatal: it bails instantly if deps are already present, and
# always exits 0 so it can never block a session from starting.

ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Already installed → cheap exit (this is the common case on every session).
[ -d "$ROOT/node_modules/@anthropic-ai/claude-agent-sdk" ] && exit 0

# Claude Code spawns hooks without an interactive shell; pull in nvm if present.
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

if ! command -v npm >/dev/null 2>&1; then
  echo "[prompt-optimizer] npm not found — skipping dependency install." >&2
  echo "[prompt-optimizer] The <optimize> hook stays dormant until you run 'npm install' in $ROOT." >&2
  exit 0
fi

echo "[prompt-optimizer] Installing hook dependencies (first run, ~once)..." >&2
if (cd "$ROOT" && npm install --no-audit --no-fund >/dev/null 2>&1); then
  echo "[prompt-optimizer] Dependencies installed. <optimize> is ready." >&2
else
  echo "[prompt-optimizer] npm install failed — run 'npm install' in $ROOT manually." >&2
fi

exit 0
