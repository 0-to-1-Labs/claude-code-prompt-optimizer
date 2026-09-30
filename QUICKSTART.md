# Quick Start Guide - Claude Code Prompt Optimizer

Get the prompt optimizer running in under 5 minutes!

## Plugin Marketplace Install (Recommended)

The fastest way to get started. In Claude Code:

```
/plugin marketplace add 0-to-1-Labs/claude-marketplace
/plugin install claude-code-prompt-optimizer@0-to-1-labs
```

Then restart Claude Code. That is the whole install:

- The plugin registers the hook for you. Do not edit `~/.claude/settings.json`.
- Dependencies install the first time you use `<optimize>` (about 200 MB, kept in
  `~/.claude/plugins/data/claude-code-prompt-optimizer/` across updates). You need Node.js 18+.
- If you are logged into Claude Code, auth already works. API-key users, see
  [Step 3: Configure Authentication](#step-3-configure-authentication).
- If a prompt passes through unoptimized, check
  `~/.claude/plugins/data/claude-code-prompt-optimizer/optimizer.log`.
- To get updates automatically, see [Keep the plugin updated](README.md#keep-the-plugin-updated) in the README.

Skip to [Using the Optimizer](#using-the-optimizer). The rest of the install steps
in this guide are for the script install below.

Use one install method, not both. The plugin and the script installer each register
the hook, so both together run it twice.

## Automated Script Install (Alternative)

Without the marketplace:

```bash
git clone https://github.com/0-to-1-Labs/claude-code-prompt-optimizer.git
cd claude-code-prompt-optimizer
npm run install-hook
```

The installer will:
1. Check prerequisites (Node.js, Claude CLI) and refuse to run if the plugin is already installed
2. Install dependencies
3. Link the repo into `~/.claude/hooks`
4. Configure the hook in `~/.claude/settings.json` with a 120 s timeout
5. Set file permissions
6. Run a quick verification (fast path only, no model call)

If you prefer manual setup, continue below.

## Pre-flight Checklist

Before starting, ensure you have:
- Claude Code CLI installed and logged in (`claude login`)
- Node.js 18.0.0+ (`node --version`)
- npm

## Step-by-Step Installation

### Step 1: Clone the Repository

```bash
# Navigate to your preferred directory
cd ~/projects  # or wherever you keep your code

# Clone the repository
git clone https://github.com/0-to-1-Labs/claude-code-prompt-optimizer.git

# Enter the project directory
cd claude-code-prompt-optimizer
```

### Step 2: Install Dependencies

```bash
# Install required packages
npm install --omit=dev

# Verify installation
npm list @anthropic-ai/claude-agent-sdk tsx
```

Expected output (versions track the latest release, so yours will be newer):
```
claude-code-prompt-optimizer@2.2.1
├── @anthropic-ai/claude-agent-sdk@0.3.285
└── tsx@4.23.15
```

### Step 3: Configure Authentication

#### Option A: Stored login (Recommended)

No env vars needed. If you're logged into Claude Code, the Agent SDK uses your stored credentials automatically.

Just verify you're logged in:
```bash
# Check CLI is installed
claude --version

# Start Claude to verify auth (exit with Ctrl+C)
claude
```

#### Option B: API Key (For API Credit Users)

Export `ANTHROPIC_API_KEY` the way you already do for other tools, and set
`OPTIMIZER_AUTH=apikey` so the hook keeps it inside a Claude Code session.

Do not paste tokens or keys into your shell profile for this plugin. A long-lived
credential in `~/.zshrc` is exported to every process you start and often ends up
in a dotfiles repo.

### Step 4: Configure Claude Code Hook

1. **Find your Claude Code config directory:**
```bash
# Check if config directory exists
ls -la ~/.claude/
```

2. **Create or edit settings.json:**
```bash
# Open the settings file (create if doesn't exist)
nano ~/.claude/settings.json
```

3. **Add the hook configuration:**
```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/absolute/path/to/claude-code-prompt-optimizer/src/hooks/optimize-prompt.sh",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

**Important**: Replace `/absolute/path/to/` with your actual path, and keep the
`timeout`. Claude Code's default for this hook is 30 s, which is shorter than a
rewrite on a large model.

To get the correct path:
```bash
# From within the project directory
echo "$PWD/src/hooks/optimize-prompt.sh"
```

### Step 5: Make Hook Executable

```bash
# Ensure the shell script has execute permissions
chmod +x src/hooks/optimize-prompt.sh
```

### Step 6: Test the Installation

The free check: an untagged prompt must pass through with no output.

```bash
npm test
```

The full check calls the model (and costs money):

```bash
npm run smoke
```

You should see something like:
```
------------------------------------------------------------
PROMPT OPTIMIZER - claude-sonnet-5-5
------------------------------------------------------------

Original Prompt:
   create a user authentication system with JWT tokens

Optimized Prompt:
   [Enhanced version will appear here]
```

## Using the Optimizer

### In Claude Code

Simply add `<optimize>` to any prompt:

```
<optimize> create a user authentication system
```

The optimizer will:
1. Detect the `<optimize>` tag
2. Send your prompt to the session model via the Agent SDK, framed as text to rewrite
3. Return an enhanced, structured version to Claude Code as additional context
4. Claude Code shows you the rewrite and the main model continues with it

### Examples

#### Simple Task
**Input:**
```
<optimize> fix this bug
```

**Result:** Comprehensive debugging framework with root cause analysis steps

#### Complex Project
**Input:**
```
<optimize> build a real-time chat application
```

**Result:** Detailed architecture plan with phases, technologies, and implementation steps

## Configuration Options

### Logs

The hook always logs metadata (never prompt text) to
`~/.claude/plugins/data/claude-code-prompt-optimizer/optimizer.log` for a plugin
install, or `~/.cache/claude-code-prompt-optimizer/optimizer.log` for a script
install. Override with `OPTIMIZER_LOG_FILE`.

```bash
tail -f ~/.cache/claude-code-prompt-optimizer/optimizer.log
```

### Custom Installation Paths

If you prefer a different location:

```bash
# System-wide installation
sudo cp -r claude-code-prompt-optimizer /opt/
sudo chmod 755 /opt/claude-code-prompt-optimizer/src/hooks/optimize-prompt.sh

# Update settings.json to:
"command": "/opt/claude-code-prompt-optimizer/src/hooks/optimize-prompt.sh"
```

## Troubleshooting

### Hook Not Triggering

**Check 1: Verify Claude Code sees the hook**
```bash
cat ~/.claude/settings.json
```

**Check 2: Test hook directly (calls the model)**
```bash
echo '{"prompt": "<optimize> test", "session_id": "test", "transcript_path": "/tmp/test", "hook_event_name": "UserPromptSubmit"}' | bash src/hooks/optimize-prompt.sh
```

**Check 3: Verify permissions**
```bash
ls -la src/hooks/optimize-prompt.sh
# Should show: -rwxr-xr-x (with x for execute)
```

### Auth Issues

**Error:** "Invalid API key" or auth-related failures

Check which auth is active:
```bash
echo "OAuth token: ${CLAUDE_CODE_OAUTH_TOKEN:+set}"
echo "API key: ${ANTHROPIC_API_KEY:+set}"
```

If neither is set, ensure `claude login` has been run successfully. The SDK will use your stored login credentials.

### Model Not Supported

**Error in the log:** `does not support this model; version X or newer is required`

The installed Agent SDK bundles a Claude Code binary older than your session model.
Delete the `node_modules` directory next to the log file (plugin install) or run
`npm update` in the repo (script install). The hook reinstalls the latest SDK on the
next `<optimize>`.

### Node.js Issues

**Error:** "node not found in PATH"

Install Node.js 18+:
```bash
# macOS:
brew install node

# Ubuntu/Debian:
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### Path Issues

**Error:** Hook path not found

```bash
# Get absolute path from project directory
cd claude-code-prompt-optimizer
echo "$PWD/src/hooks/optimize-prompt.sh"

# Copy this exact path to settings.json
```

## Updating the Optimizer

Plugin install: see [Keep the plugin updated](README.md#keep-the-plugin-updated).

Script install:

```bash
cd claude-code-prompt-optimizer
git pull origin main
npm install --omit=dev
```

## Testing Without Claude Code

Test the optimizer standalone (calls the model):

```bash
node -e "
const input = {
  prompt: '<optimize> create a REST API',
  session_id: 'test',
  transcript_path: '/tmp/test',
  hook_event_name: 'UserPromptSubmit'
};
console.log(JSON.stringify(input));
" | bash src/hooks/optimize-prompt.sh
```

## Verification Checklist

Run through this checklist to ensure everything works:

- [ ] Node.js 18+ installed (`node --version`)
- [ ] Repository cloned and dependencies installed
- [ ] Logged in with `claude login` (or `ANTHROPIC_API_KEY` + `OPTIMIZER_AUTH=apikey`)
- [ ] Claude Code settings.json configured with correct path and `"timeout": 120`
- [ ] Hook script has execute permissions
- [ ] `npm test` exits 0 with no output
- [ ] `<optimize>` tag triggers in Claude Code

## Pro Tips

1. **Use quotes to preserve exact text:**
   ```
   <optimize> implement a function called "calculateTotalPrice" that does X
   ```

2. **Combine with specific requirements:**
   ```
   <optimize> create a secure API with rate limiting and JWT auth
   ```

3. **See what each run cost:**
   ```bash
   grep ' ok ' ~/.cache/claude-code-prompt-optimizer/optimizer.log
   ```

## Getting Help

- **GitHub Issues:** [Report bugs or request features](https://github.com/0-to-1-Labs/claude-code-prompt-optimizer/issues)
- **Discussions:** [Ask questions and share tips](https://github.com/0-to-1-Labs/claude-code-prompt-optimizer/discussions)
- **Logs:** See [Logs](#logs) above

---

**Ready to supercharge your prompts? Try it now with `<optimize>` in Claude Code!**
