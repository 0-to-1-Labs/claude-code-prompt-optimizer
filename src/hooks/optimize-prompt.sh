#!/bin/bash

# Claude Code Hook Wrapper Script
# Entry point for the prompt optimization hook (UserPromptSubmit).
#
# Fires on EVERY prompt, so the common case (no <optimize> tag) must be cheap:
# we read stdin and bail immediately, WITHOUT paying Node/tsx/Agent-SDK startup.

# Read the hook payload from stdin once; reuse it below.
INPUT=$(cat)

# Logging is unconditional past the fast path. Claude Code surfaces only a
# one-line non-blocking error when a hook fails, so this file is the only place
# the real reason (missing Node, timeout, which model ran) is recorded.
LOG_FILE="${OPTIMIZER_LOG_FILE:-/tmp/claude-code-prompt-optimizer.log}"
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [sh] $*" >> "$LOG_FILE" 2>/dev/null; }

# Fast path: no <optimize> tag → emit nothing and let the prompt pass through
# unchanged. No Node process, no SDK import, no log write, no added latency.
if ! printf '%s' "$INPUT" | grep -qi '<optimize>'; then
  exit 0
fi

# Ensure node is in PATH; only pay the nvm sourcing cost when it isn't
# (Claude Code spawns hooks without an interactive shell).
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="$HOME/.nvm"
  [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DIST_BUNDLE="$ROOT_DIR/dist/optimize-prompt.mjs"
TSX_BIN="$ROOT_DIR/node_modules/.bin/tsx"

# Preflight: without Node there is nothing to run. Fail OPEN with an explicit
# log line rather than letting the run die on `npx: command not found`, which
# reaches the user as an opaque non-blocking hook error.
if [ ! -x "$TSX_BIN" ] && ! command -v node >/dev/null 2>&1; then
  log "FATAL node not found in PATH ($PATH) and no prebuilt tsx at $TSX_BIN — install Node >=18, then run 'npm install' in $ROOT_DIR. Passing prompt through unoptimized."
  exit 0
fi

# When installed as a Claude Code plugin, `/plugin install` clones the repo but
# does NOT run `npm install`, so tsx + the Agent SDK are absent. Provision them
# lazily on the first <optimize> use (one-time cost; cached thereafter). Runs
# only inside the plugin/repo dir, never against the user's project.
if [ ! -x "$TSX_BIN" ] && [ -f "$ROOT_DIR/package.json" ]; then
  log "node_modules missing — bootstrapping deps via npm install"
  if ! ( cd "$ROOT_DIR" && npm install --omit=dev --no-audit --no-fund ) >>"$LOG_FILE" 2>&1; then
    log "FATAL npm install failed — passing prompt through unoptimized"
    exit 0
  fi
fi

# Prefer the prebuilt bundle (no TypeScript transpile at hook time — saves
# seconds of the model's timeout budget); then pinned tsx; then npx as a last
# resort. Rebuild the bundle with `npm run build` after editing the .ts.
if [ -f "$DIST_BUNDLE" ] && command -v node >/dev/null 2>&1; then
  printf '%s' "$INPUT" | node "$DIST_BUNDLE"
elif [ -x "$TSX_BIN" ]; then
  printf '%s' "$INPUT" | "$TSX_BIN" "$SCRIPT_DIR/optimize-prompt.ts"
else
  printf '%s' "$INPUT" | npx tsx "$SCRIPT_DIR/optimize-prompt.ts"
fi

EXIT_CODE=$?
[ "$EXIT_CODE" -ne 0 ] && log "hook exited non-zero: $EXIT_CODE"

exit $EXIT_CODE
