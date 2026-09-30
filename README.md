# Claude Code Prompt Optimizer

![Claude Code Prompt Optimizer](./assets/header.png)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node Version](https://img.shields.io/badge/node-%3E%3D18.0.0-green)](https://nodejs.org)
[![Anthropic API](https://img.shields.io/badge/Anthropic-Claude%20Opus%205-blue)](https://www.anthropic.com)

A Claude Code hook that transforms simple prompts into detailed, structured instructions. Add `<optimize>` to any prompt and it'll expand your request into something Claude can really sink its teeth into.

## What It Does

When you tag a prompt with `<optimize>`, this hook intercepts it and runs it through Claude's extended thinking mode. The result is a fleshed-out version of your original request with:

- Specific implementation steps
- Error handling considerations
- Testing requirements
- Edge cases to watch for

Basically, it does the prompt engineering for you.

## Requirements

- Claude Code CLI installed
- Node.js 18+
- **One of the following:**
  - `CLAUDE_CODE_OAUTH_TOKEN` (Claude Pro/MAX subscribers)
  - `ANTHROPIC_API_KEY` (API credit users)
  - Stored OAuth from `claude login`

## Quick Install

### Plugin marketplace (recommended)

In Claude Code:

```
/plugin marketplace add 0-to-1-Labs/claude-marketplace
/plugin install claude-code-prompt-optimizer@0-to-1-labs
```

Then restart Claude Code. The plugin registers the hook for you and installs its
dependencies the first time you use `<optimize>`. Set up auth as described in
[Authentication](#authentication).

### Alternative: standalone install (no marketplace)

```bash
git clone https://github.com/johnpsasser/claude-code-prompt-optimizer.git
cd claude-code-prompt-optimizer
npm run install-hook
```

The installer handles dependencies, auth setup, hook configuration, and verification.

Use one method, not both. The installer adds the hook to `~/.claude/settings.json`,
and the plugin registers its own copy, so both together run the hook twice.

## Authentication

The Agent SDK checks for credentials in this order:

| Priority | Method | Variable | Best For |
|----------|--------|----------|----------|
| 1 | OAuth token | `CLAUDE_CODE_OAUTH_TOKEN` | Claude Pro/MAX subscribers |
| 2 | API key | `ANTHROPIC_API_KEY` | API credit users |
| 3 | Stored OAuth | *(none — uses `claude login`)* | Already logged in |

If `CLAUDE_CODE_OAUTH_TOKEN` is set, the API key is ignored. If neither env var is set, the Agent SDK falls back to stored OAuth credentials from `claude login`.

Auth resolution is adaptive and can be forced with `OPTIMIZER_AUTH`:

| `OPTIMIZER_AUTH` | Behavior |
|------------------|----------|
| `auto` *(default)* | An explicit `CLAUDE_CODE_OAUTH_TOKEN` wins. Inside a Claude Code session with no token, the (often invalid) parent-injected API key is stripped so the CLI uses your stored `claude login`. Outside Claude Code, a real `ANTHROPIC_API_KEY` is honored. |
| `oauth` | Always strip API keys and use OAuth / stored login. |
| `apikey` | Always keep `ANTHROPIC_API_KEY` (for pure API-credit users). |

### Setting Up OAuth Token

```bash
# Get your token
claude auth token

# Add to shell profile
export CLAUDE_CODE_OAUTH_TOKEN="your-oauth-token"
```

### Setting Up API Key

```bash
export ANTHROPIC_API_KEY="sk-ant-api03-..."
```

## Manual Setup

If you prefer to configure things yourself instead of using `npm run install-hook`:

### 1. Install Dependencies

```bash
git clone https://github.com/johnpsasser/claude-code-prompt-optimizer.git
cd claude-code-prompt-optimizer
npm install
```

### 2. Configure Auth

Set one of the environment variables above in your shell profile.

### 3. Configure the Hook

Add the hook to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/claude-code-prompt-optimizer/src/hooks/optimize-prompt.sh"
          }
        ]
      }
    ]
  }
}
```

### 4. Make Hook Executable

```bash
chmod +x src/hooks/optimize-prompt.sh
```

Test it:

```
<optimize> write a function to calculate fibonacci numbers
```

For detailed setup instructions and troubleshooting, see [QUICKSTART.md](QUICKSTART.md).

## Examples

**Before:**
```
<optimize> create a REST API
```

**After:**
The optimizer expands this into specs covering architecture, endpoints, error handling, auth, validation, and testing.

**Before:**
```
<optimize> refactor this codebase for better performance
```

**After:**
You get a structured plan with profiling steps, bottleneck identification, prioritized refactoring targets, and benchmarking criteria.

## Configuration

| Variable | Description | Default |
|----------|-------------|---------|
| `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token for Claude Pro/MAX (optional if logged in) | - |
| `ANTHROPIC_API_KEY` | Anthropic API key (used if no OAuth token) | - |
| `OPTIMIZER_AUTH` | Auth strategy: `auto`, `oauth`, or `apikey` | `auto` |
| `OPTIMIZER_MODEL` | Override the optimization model | from config |
| `OPTIMIZER_FALLBACK_MODEL` | Model to retry with if the primary errors | from config |
| `OPTIMIZER_EFFORT` | Reasoning effort: `low`, `medium`, `high`, `xhigh`, `max` | from config |
| `OPTIMIZER_TIMEOUT_MS` | Abort + fall back to the original prompt after N ms | from config |
| `DEBUG` | Enable debug logging | `false` |

Debug logs go to `/tmp/claude-code-hook-debug.log`.

### Config file

Model selection, per-model time budgets, the prompt-size cap, and the system
prompt live in `src/hooks/optimizer.config.json` and `src/hooks/system-prompt.md`,
so you can tune behavior without editing TypeScript. Environment variables above
take precedence over the config file.

```json
{
  "matchSessionModel": true,
  "model": "claude-opus-5",
  "effort": "low",
  "maxPromptChars": 12000,
  "fallbackTimeoutMs": 30000,
  "defaultPolicy": { "budgetMs": 45000, "fallback": "claude-sonnet-5" },
  "modelPolicy": {
    "claude-opus-5":   { "budgetMs": 60000, "fallback": "claude-sonnet-5" },
    "claude-sonnet-5": { "budgetMs": 40000, "fallback": null }
  },
  "systemPromptFile": "system-prompt.md"
}
```

**Session-model matching.** With `matchSessionModel` enabled (the default), the
hook reads `transcript_path` from the hook payload and reuses the model that
produced the most recent assistant turn — so the prompt is rewritten *by* the
same model that will execute it, and mid-session `/model` switches are picked up
automatically. UserPromptSubmit carries no `model` field and there is no
`$CLAUDE_MODEL`, so the transcript is the only source for this. On the first
prompt of a session (no assistant turn yet) it falls back to `model`. Set
`OPTIMIZER_MATCH_SESSION_MODEL=false` to always use `model` instead.

**Timeouts.** Each model gets its own `budgetMs` from `modelPolicy` (Opus needs
roughly twice Sonnet's wall time for the same rewrite). If the primary times out
*or* errors, the chain advances to `fallback` with `fallbackTimeoutMs`; only when
every attempt is exhausted does the hook fail open and pass the prompt through
unmodified.

> **Keep the inner budgets under the outer hook timeout.** Claude Code lowers the
> `UserPromptSubmit` command-hook default to **30s**, so `hooks/hooks.json` sets an
> explicit `"timeout": 120`. `budgetMs + fallbackTimeoutMs` must stay comfortably
> below that value — if the outer timeout fires first, Claude Code kills the
> process and the fail-open path never runs.

`effort` defaults to `low`: prompt optimization is a single-turn rewrite, not a
reasoning task, so minimal thinking keeps latency inside the budget. Raise it if
you want the optimizer to deliberate more.

`maxPromptChars` (default 12,000) short-circuits very long prompts — a pasted
document cannot be rewritten inside any sane budget, and attempting it was the
most reliable way to burn the entire hook timeout for nothing.

### Logs

The hook always writes to `/tmp/claude-code-prompt-optimizer.log` (override with
`OPTIMIZER_LOG_FILE`), recording the chosen model and its source, elapsed time
per attempt, timeouts, and fail-open reasons. Prompts without an `<optimize>`
tag short-circuit before any logging, so the common path stays free.

```
2026-08-20T04:24:26Z start session=abc chars=1204 model=claude-opus-5 source=session
2026-08-20T04:25:03Z ok model=claude-opus-5 effort=low ms=36294
```

## Project Structure

```
claude-code-prompt-optimizer/
├── src/hooks/
│   ├── optimize-prompt.ts     # Core optimization logic (Agent SDK)
│   ├── optimize-prompt.sh     # Shell wrapper (fast-path short-circuit)
│   ├── optimizer.config.json  # Model matching, per-model budgets, size cap
│   └── system-prompt.md       # Editable optimization system prompt
├── scripts/
│   └── install.js             # Automated installer (symlinks into ~/.claude)
├── examples/                  # Usage examples
└── QUICKSTART.md              # Installation guide
```

## How It Works

1. The shell wrapper inspects every prompt and **short-circuits in bash** when there's no `<optimize>` tag — no Node, no SDK load, no added latency on normal prompts
2. When tagged, it sends your prompt to Claude via the Agent SDK with a custom system prompt, under an overall timeout
3. Returns the expanded prompt back to Claude Code (falling back to your original prompt on timeout/error)

The optimizer uses the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) which handles authentication automatically — OAuth tokens, API keys, and stored credentials all work seamlessly.

## Troubleshooting

**Hook not triggering:**
- Check your settings.json path
- Run `chmod +x src/hooks/optimize-prompt.sh`
- Enable debug mode and check the logs

**Auth errors:**
- Check that `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` is exported
- If using stored OAuth, verify `claude login` works
- Run with `DEBUG=true` to see which auth method is active

**Missing deps:**
- Run `npm install`
- Check Node version is 18+

## Development

```bash
# Run directly
npx tsx src/hooks/optimize-prompt.ts < examples/test-input.json

# Run with debug output
DEBUG=true bash src/hooks/optimize-prompt.sh < examples/test-input.json

# Automated install
npm run install-hook
```

## Contributing

PRs welcome. Fork it, make a branch, add tests, submit.

## License

MIT. See [LICENSE](LICENSE).
