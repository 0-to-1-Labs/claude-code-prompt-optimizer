#!/usr/bin/env node

import { execFileSync } from 'child_process';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
  lstatSync,
  readlinkSync,
  unlinkSync,
  renameSync,
  symlinkSync,
} from 'fs';
import { join, dirname, resolve } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

// fileURLToPath (not URL.pathname) so a repo path with spaces or non-ASCII
// characters is decoded instead of left percent-encoded.
const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const HOOK_SCRIPT = join(PROJECT_ROOT, 'src', 'hooks', 'optimize-prompt.sh');
const PLUGIN_HOOKS_FILE = join(PROJECT_ROOT, 'hooks', 'hooks.json');
const CLAUDE_DIR = join(homedir(), '.claude');
const SETTINGS_FILE = join(CLAUDE_DIR, 'settings.json');
const INSTALLED_PLUGINS_FILE = join(CLAUDE_DIR, 'plugins', 'installed_plugins.json');
const PLUGIN_NAME = 'claude-code-prompt-optimizer';

// Single source of truth: ~/.claude/hooks/claude-code-prompt-optimizer is a
// symlink to this repo, so editing the repo updates the live hook with no copy.
const INSTALL_LINK = join(CLAUDE_DIR, 'hooks', PLUGIN_NAME);
const LINKED_HOOK_SCRIPT = join(INSTALL_LINK, 'src', 'hooks', 'optimize-prompt.sh');

function log(msg) {
  console.log(`\x1b[36m[installer]\x1b[0m ${msg}`);
}

function success(msg) {
  console.log(`\x1b[32m[OK]\x1b[0m ${msg}`);
}

function warn(msg) {
  console.log(`\x1b[33m[WARN]\x1b[0m ${msg}`);
}

function fail(msg) {
  console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`);
  process.exit(1);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ── Pre-flight checks ──────────────────────────────────────────────

function checkNode() {
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 18) {
    fail(`Node.js 18+ required (found ${process.versions.node})`);
  }
  success(`Node.js ${process.versions.node}`);
}

function checkClaude() {
  try {
    const version = execFileSync('claude', ['--version'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    success(`Claude CLI found: ${version}`);
    return true;
  } catch {
    warn('Claude CLI not found — install it and run `claude login` before using <optimize>');
    return false;
  }
}

/**
 * The plugin install and this script each register the hook, and Claude Code
 * runs a plugin's hook separately from a settings.json copy of it. Refuse to
 * add a second registration when the plugin is already installed.
 */
function checkPluginInstall() {
  const installed = readJson(INSTALLED_PLUGINS_FILE)?.plugins ?? {};
  const enabled = readJson(SETTINGS_FILE)?.enabledPlugins ?? {};
  const entries = [...Object.keys(installed), ...Object.keys(enabled)].filter((key) =>
    key.startsWith(`${PLUGIN_NAME}@`),
  );
  if (entries.length) {
    fail(
      `${entries[0]} is already installed as a Claude Code plugin. Use one install method, not both — ` +
        'the plugin and this script would each run the hook on every prompt. ' +
        `Run \`/plugin uninstall ${entries[0]}\` first if you prefer the script install.`,
    );
  }
}

// ── Install dependencies ───────────────────────────────────────────

function installDeps() {
  log('Installing dependencies...');
  execFileSync('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
  });
  success('Dependencies installed');
}

// ── Auth ───────────────────────────────────────────────────────────

function explainAuth(hasClaude) {
  console.log('\n--- Authentication ---\n');
  if (hasClaude) {
    console.log('The hook uses your stored Claude Code login (`claude login`). No env vars needed.');
  } else {
    console.log('Install the Claude Code CLI and run `claude login`; the hook uses that stored login.');
  }
  console.log('API-key users: export ANTHROPIC_API_KEY yourself and set OPTIMIZER_AUTH=apikey. See README.md.\n');
}

// ── Install hook files (symlink) ───────────────────────────────────

function installHookFiles() {
  log('Linking hook into ~/.claude/hooks...');
  mkdirSync(dirname(INSTALL_LINK), { recursive: true });

  let existing = null;
  try {
    existing = lstatSync(INSTALL_LINK);
  } catch {
    // nothing there yet
  }

  if (existing) {
    if (existing.isSymbolicLink()) {
      if (resolve(readlinkSync(INSTALL_LINK)) === resolve(PROJECT_ROOT)) {
        success('Symlink already points at this repo — single source of truth');
        return;
      }
      unlinkSync(INSTALL_LINK); // stale symlink → replace
    } else {
      // A real directory/file from an older copy-based install: back it up.
      const backup = `${INSTALL_LINK}.bak-${Date.now()}`;
      renameSync(INSTALL_LINK, backup);
      warn(`Backed up previous install to ${backup}`);
    }
  }

  symlinkSync(PROJECT_ROOT, INSTALL_LINK, 'dir');
  success(`Symlinked ${INSTALL_LINK} -> ${PROJECT_ROOT}`);
}

// ── Hook configuration ─────────────────────────────────────────────

/** The plugin's hooks.json is the one source of truth for the hook timeout. */
function hookTimeout() {
  const timeout = readJson(PLUGIN_HOOKS_FILE)?.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.timeout;
  return typeof timeout === 'number' ? timeout : 120;
}

function configureHook() {
  log('Configuring Claude Code hook...');

  let settings = {};
  if (existsSync(SETTINGS_FILE)) {
    settings = readJson(SETTINGS_FILE);
    if (!settings) {
      warn('Could not parse existing settings.json — creating fresh');
      settings = {};
    }
  }

  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.UserPromptSubmit) settings.hooks.UserPromptSubmit = [];

  // Claude Code lowers the UserPromptSubmit command-hook default to 30 s,
  // which is shorter than a rewrite on a large model. Match hooks/hooks.json.
  const timeout = hookTimeout();
  const hookEntry = {
    hooks: [
      {
        type: 'command',
        command: LINKED_HOOK_SCRIPT,
        timeout,
      },
    ],
  };

  // Check if hook is already registered; if so, make sure it has the timeout.
  const existing = settings.hooks.UserPromptSubmit.flatMap((entry) => entry.hooks ?? []).find((h) =>
    h.command?.includes('optimize-prompt'),
  );

  if (existing) {
    if (existing.timeout !== timeout) {
      existing.timeout = timeout;
      writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
      success(`Hook already registered — set timeout to ${timeout}s in ${SETTINGS_FILE}`);
    } else {
      log('Hook already registered in settings.json');
    }
  } else {
    settings.hooks.UserPromptSubmit.push(hookEntry);
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
    success(`Hook added to ${SETTINGS_FILE} (timeout ${timeout}s)`);
  }
}

// ── Permissions ────────────────────────────────────────────────────

function setPermissions() {
  chmodSync(HOOK_SCRIPT, 0o755);
  success(`chmod +x ${HOOK_SCRIPT}`);
}

// ── Verify ─────────────────────────────────────────────────────────

/**
 * Exercise the fast path only: a prompt without <optimize> must exit 0 with
 * empty output. A tagged prompt would call the model and cost money.
 */
function verify() {
  log('Running quick verification (fast path, no model call)...');
  const testInput = JSON.stringify({
    prompt: 'hello world',
    session_id: 'verify',
    transcript_path: '/tmp/verify',
    hook_event_name: 'UserPromptSubmit',
  });

  try {
    const result = execFileSync('bash', [HOOK_SCRIPT], {
      cwd: PROJECT_ROOT,
      encoding: 'utf8',
      input: testInput,
      timeout: 15000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (result.trim() === '') {
      success('Verification passed — untagged prompt passes through untouched');
    } else {
      warn(`Unexpected output for an untagged prompt: ${result.trim().slice(0, 200)}`);
    }
  } catch (err) {
    warn(`Verification failed: ${err.message}`);
    warn('Test manually: npm test');
  }
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log('\n========================================');
  console.log(' Claude Code Prompt Optimizer Installer');
  console.log('========================================\n');

  checkNode();
  const hasClaude = checkClaude();
  checkPluginInstall();

  installDeps();
  explainAuth(hasClaude);
  installHookFiles();
  configureHook();
  setPermissions();
  verify();

  console.log('\n========================================');
  console.log(' Installation complete!');
  console.log('========================================');
  console.log('\nUsage: add <optimize> to any prompt in Claude Code');
  console.log('Example: <optimize> build a REST API with auth\n');
}

main().catch((err) => {
  fail(err.message);
});
