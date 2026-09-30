#!/bin/bash

# Claude Code Hook Wrapper Script
# Entry point for the prompt optimization hook (UserPromptSubmit).
#
# Fires on EVERY prompt, so the common case (no <optimize> tag) must be cheap:
# we read stdin and bail immediately, WITHOUT paying Node/tsx/Agent-SDK startup.

# Read the hook payload from stdin once; reuse it below.
INPUT=$(cat)

# Fast path: no <optimize> tag → emit nothing and let the prompt pass through
# unchanged. No Node process, no SDK import, no log write, no added latency.
if ! printf '%s' "$INPUT" | grep -qi '<optimize>'; then
  exit 0
fi

# Everything the hook writes (log, dedupe locks, installed deps) is per-user
# and owner-only. ${CLAUDE_PLUGIN_DATA} is provided to plugin hooks and
# survives plugin updates; the ~/.cache path covers the script install.
umask 077
DATA_DIR="${CLAUDE_PLUGIN_DATA:-$HOME/.cache/claude-code-prompt-optimizer}"
mkdir -p "$DATA_DIR" 2>/dev/null

# Logging is unconditional past the fast path. Claude Code surfaces only a
# one-line non-blocking error when a hook fails, so this file is the only place
# the real reason (missing Node, timeout, which model ran) is recorded. The log
# holds metadata only — never prompt text or credentials.
LOG_FILE="${OPTIMIZER_LOG_FILE:-$DATA_DIR/optimizer.log}"
export OPTIMIZER_LOG_FILE="$LOG_FILE"
log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) [sh] $*" >> "$LOG_FILE" 2>/dev/null; }

# Fail open: tell the user why the prompt passed through unoptimized, and exit
# 0 so Claude Code does not report a hook error on top of it.
fail_open() {
  log "FATAL $1 — passing prompt through unoptimized"
  printf '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"[prompt-optimizer] %s. Prompt passed through unoptimized. See %s."}}\n' \
    "$1" "$LOG_FILE"
  exit 0
}

# Dedupe: if the hook is registered twice (plugin AND settings.json), Claude
# Code runs both copies in parallel with the same payload. An atomic mkdir on
# a payload hash lets exactly one copy proceed. The lock is removed on exit;
# a lock older than 3 minutes is a leftover from a killed run and is ignored.
LOCK_DIR="$DATA_DIR/locks"
mkdir -p "$LOCK_DIR" 2>/dev/null
LOCK="$LOCK_DIR/$(printf '%s' "$INPUT" | cksum | cut -d' ' -f1)"
if [ -d "$LOCK" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +3 2>/dev/null)" ]; then
  rmdir "$LOCK" 2>/dev/null
fi
if ! mkdir "$LOCK" 2>/dev/null; then
  log "duplicate run for the same payload (hook registered twice?) — skipping this copy"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

# Ensure node is in PATH; only pay the nvm sourcing cost when it isn't
# (Claude Code spawns hooks without an interactive shell).
if ! command -v node >/dev/null 2>&1; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck source=/dev/null
  [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
DIST_BUNDLE="$ROOT_DIR/dist/optimize-prompt.mjs"

# Preflight: without Node there is nothing to run.
if ! command -v node >/dev/null 2>&1; then
  fail_open "node not found in PATH — install Node >=18"
fi

# Dependencies (tsx + Agent SDK, ~200 MB with the SDK's native CLI binary).
# `/plugin install` does not run `npm install`, so they are provisioned lazily
# on the first <optimize> use.
#
# As a plugin (CLAUDE_PLUGIN_ROOT is set) the hook ALWAYS uses the install in
# the data dir (kept across plugin updates) and runs a copy of the source from
# there, so ESM imports resolve against that node_modules. A node_modules/ or
# dist/ left in the plugin directory — a dev checkout served through a
# directory marketplace, say — is ignored and can never pin an old SDK whose
# bundled CLI rejects the session model. Outside a plugin (script install,
# `npm test`) the repo's own install and bundle are used.
if [ -n "$CLAUDE_PLUGIN_ROOT" ]; then
  DEPS_DIR="$DATA_DIR"
  RUN_DIR="$DATA_DIR/hook"
else
  DEPS_DIR="$ROOT_DIR"
  RUN_DIR="$SCRIPT_DIR"
fi
NM="$DEPS_DIR/node_modules"
TSX_BIN="$NM/.bin/tsx"
MARKER="$NM/.optimizer-deps-ok"
PKG_SUM="$(cksum < "$ROOT_DIR/package.json" 2>/dev/null | cut -d' ' -f1)"

# Idempotent guard: the marker is written only after a complete install and
# is keyed on package.json, so a bumped plugin re-installs and a download that
# was killed mid-way (tsx present, SDK binary absent) is retried, not wedged.
deps_ok() {
  [ -x "$TSX_BIN" ] || return 1
  [ -f "$NM/@anthropic-ai/claude-agent-sdk/sdk.mjs" ] || return 1
  ls "$NM"/@anthropic-ai/claude-agent-sdk-*/claude* >/dev/null 2>&1 || return 1
  [ -f "$MARKER" ] && [ "$(cat "$MARKER" 2>/dev/null)" = "$PKG_SUM" ]
}

if ! deps_ok; then
  log "dependencies missing or stale in $DEPS_DIR — running npm install (one-time, ~200 MB)"
  if [ "$DEPS_DIR" != "$ROOT_DIR" ]; then
    cp "$ROOT_DIR/package.json" "$DEPS_DIR/package.json" || fail_open "cannot write to $DEPS_DIR"
  fi
  if ! ( cd "$DEPS_DIR" && npm install --omit=dev --ignore-scripts --no-audit --no-fund ) >>"$LOG_FILE" 2>&1; then
    fail_open "npm install failed in $DEPS_DIR"
  fi
  printf '%s' "$PKG_SUM" > "$MARKER" 2>/dev/null
  if ! deps_ok; then
    rm -f "$MARKER"
    fail_open "Agent SDK is incomplete after npm install in $DEPS_DIR (no tsx or no native CLI binary for this platform)"
  fi
  log "dependencies installed in $DEPS_DIR"
fi

# Plugin mode: refresh the source copy next to the data-dir install (three
# small files; cheap) so the hook always runs the current plugin version
# against the data-dir node_modules. Never symlink into the plugin root.
if [ "$RUN_DIR" != "$SCRIPT_DIR" ]; then
  mkdir -p "$RUN_DIR"
  if ! cp -f "$SCRIPT_DIR"/optimize-prompt.ts "$SCRIPT_DIR"/optimizer.config.json "$SCRIPT_DIR"/system-prompt.md "$RUN_DIR/"; then
    fail_open "cannot copy the hook source to $RUN_DIR"
  fi
fi

# Outside a plugin, prefer the prebuilt bundle (no TypeScript transpile at
# hook time); otherwise the pinned tsx. Never `npx`: that would download and
# run code from the registry at hook time. Rebuild the bundle with
# `npm run build` after editing the .ts.
if [ "$RUN_DIR" = "$SCRIPT_DIR" ] && [ -f "$DIST_BUNDLE" ]; then
  OUTPUT=$(printf '%s' "$INPUT" | node "$DIST_BUNDLE")
else
  OUTPUT=$(printf '%s' "$INPUT" | "$TSX_BIN" "$RUN_DIR/optimize-prompt.ts")
fi
EXIT_CODE=$?

if [ "$EXIT_CODE" -ne 0 ]; then
  fail_open "hook exited non-zero ($EXIT_CODE) — the Agent SDK or its dependencies may be broken; delete $NM to reinstall"
fi

printf '%s\n' "$OUTPUT"
exit 0
