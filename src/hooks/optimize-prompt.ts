#!/usr/bin/env tsx

import { query } from '@anthropic-ai/claude-agent-sdk';
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

interface HookInput {
  session_id: string;
  transcript_path: string;
  hook_event_name: string;
  prompt: string;
}

interface HookOutput {
  decision?: 'block';
  reason?: string;
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
  };
}

type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** Per-model time budget and the cheaper model to retry on if it fails. */
interface Policy {
  budgetMs: number;
  fallback: string | null;
}

interface OptimizerConfig {
  matchSessionModel: boolean;
  model: string;
  effort: EffortLevel;
  maxPromptChars: number;
  fallbackTimeoutMs: number;
  defaultPolicy: Policy;
  modelPolicy: Record<string, Policy>;
  budgetOverrideMs: number | null;
  systemPromptTemplate: string;
}

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

// Config lives next to the SOURCE file. When running the esbuild bundle from
// dist/, import.meta.url points at dist/ — fall back to src/hooks/ there.
const HOOK_DIR =
  [SCRIPT_DIR, join(SCRIPT_DIR, '..', 'src', 'hooks')].find((dir) =>
    existsSync(join(dir, 'optimizer.config.json')),
  ) ?? SCRIPT_DIR;
const LOG_FILE = process.env.OPTIMIZER_LOG_FILE || '/tmp/claude-code-prompt-optimizer.log';

/**
 * Append a line to the optimizer log.
 *
 * Logging is unconditional (not DEBUG-gated): when the hook fails, Claude Code
 * shows only a one-line non-blocking error, so the log is the sole record of
 * which model ran, how long it took, and why it gave up.
 */
function log(message: string): void {
  try {
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${message}\n`);
  } catch {
    // Never let logging break the hook.
  }
}

/**
 * Load configuration from optimizer.config.json (next to this file), with
 * environment-variable overrides. The system prompt lives in its own file so
 * it can be tuned without touching code or bumping the model in two places.
 */
function loadConfig(): OptimizerConfig {
  const raw = JSON.parse(readFileSync(join(HOOK_DIR, 'optimizer.config.json'), 'utf8'));
  const systemPromptTemplate = readFileSync(join(HOOK_DIR, raw.systemPromptFile), 'utf8').trim();

  return {
    matchSessionModel: process.env.OPTIMIZER_MATCH_SESSION_MODEL
      ? process.env.OPTIMIZER_MATCH_SESSION_MODEL !== 'false'
      : raw.matchSessionModel !== false,
    model: process.env.OPTIMIZER_MODEL || raw.model,
    // Prompt optimization is a single-turn rewrite, not a reasoning task, so the
    // default 'high' effort is wasteful — it drives the model past the timeout
    // (which then fails open to the un-optimized prompt). 'low' keeps adaptive
    // thinking on but minimal, so responses land well inside the budget and the
    // reasoning stays in thinking blocks rather than leaking into the rewrite.
    effort: (process.env.OPTIMIZER_EFFORT || raw.effort || 'low') as EffortLevel,
    maxPromptChars: Number(process.env.OPTIMIZER_MAX_PROMPT_CHARS) || raw.maxPromptChars || 12000,
    fallbackTimeoutMs: Number(process.env.OPTIMIZER_FALLBACK_TIMEOUT_MS) || raw.fallbackTimeoutMs || 20000,
    defaultPolicy: raw.defaultPolicy || { budgetMs: 30000, fallback: null },
    modelPolicy: raw.modelPolicy || {},
    // Escape hatch for measuring real latency, and for users on slow links who
    // would rather wait than lose the optimization.
    budgetOverrideMs: Number(process.env.OPTIMIZER_BUDGET_MS) || null,
    systemPromptTemplate,
  };
}

/** Model ids we are willing to pull out of a transcript, e.g. `claude-opus-5`. */
const MODEL_ID_PATTERN = /^claude-[a-z0-9][a-z0-9-]*$/;

/**
 * Recover the session's current model by reading the transcript.
 *
 * UserPromptSubmit hook input carries no `model` field and there is no
 * $CLAUDE_MODEL env var, but it does carry `transcript_path`, and every
 * assistant record in that JSONL records the model that produced it. Reading
 * the most recent one lets the optimizer run on the same model that will
 * execute the optimized prompt — and it tracks mid-session /model switches.
 *
 * Only the tail is read: transcripts grow to many megabytes and the hook runs
 * on the prompt-submit critical path.
 */
function detectSessionModel(transcriptPath: string): string | null {
  const TAIL_BYTES = 512 * 1024;

  try {
    const size = statSync(transcriptPath).size;
    if (!size) return null;

    const start = Math.max(0, size - TAIL_BYTES);
    const length = size - start;
    const buf = Buffer.alloc(length);
    const fd = openSync(transcriptPath, 'r');
    try {
      readSync(fd, buf, 0, length, start);
    } finally {
      closeSync(fd);
    }

    const lines = buf.toString('utf8').split('\n');
    // A mid-file offset almost certainly lands inside a record; drop that shard.
    if (start > 0) lines.shift();

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;

      let record: any;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }

      const model = record?.message?.model;
      // Synthetic assistant records carry model '<synthetic>'; the pattern
      // rejects those along with anything else that isn't a real model id.
      if (record?.type === 'assistant' && typeof model === 'string' && MODEL_ID_PATTERN.test(model)) {
        return model;
      }
    }
  } catch {
    // Missing/unreadable transcript (e.g. first prompt of a session) — the
    // caller falls back to the configured default model.
  }

  return null;
}

/** Write JSON to stdout and wait for it to flush before exiting. */
function writeAndExit(json: string): Promise<never> {
  return new Promise((_, reject) => {
    process.stdout.write(json + '\n', (err) => {
      if (err) reject(err);
      process.exit(0);
    });
  });
}

/**
 * Build a clean environment for the Agent SDK subprocess.
 *
 * Auth is adaptive (override with OPTIMIZER_AUTH=oauth|apikey|auto, default auto):
 *  - oauth   : strip every API-key vector so the CLI uses OAuth/stored login.
 *  - apikey  : keep ANTHROPIC_API_KEY untouched (pure API-credit users).
 *  - auto    : an explicit CLAUDE_CODE_OAUTH_TOKEN wins (strip key); inside a
 *              Claude Code session with no token we strip the (often invalid)
 *              parent-injected key and fall through to stored `claude login`;
 *              outside Claude Code we honor a real API key.
 *
 * Returns a new env object (does not mutate process.env).
 */
function buildCleanEnv(): Record<string, string | undefined> {
  const env = { ...process.env };

  const insideClaudeCode = !!process.env.CLAUDECODE;
  const hasOAuthToken = !!process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;
  const mode = (process.env.OPTIMIZER_AUTH || 'auto').toLowerCase();

  let useApiKey: boolean;
  if (mode === 'apikey') {
    useApiKey = true;
  } else if (mode === 'oauth') {
    useApiKey = false;
  } else {
    // auto
    if (hasOAuthToken) useApiKey = false; // explicit OAuth token wins
    else if (insideClaudeCode) useApiKey = false; // strip injected key, use stored login
    else useApiKey = hasApiKey; // standalone: honor a real key
  }

  // Allow Agent SDK to spawn a claude subprocess inside a Claude Code session
  delete env.CLAUDECODE;

  if (!useApiKey) {
    // Nuke every possible API key vector so the CLI subprocess cannot find a
    // key from env, file descriptor, or parent-injected vars.
    env.ANTHROPIC_API_KEY = '';
    delete env.CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR;
  }

  return env;
}

/** Run a single optimization attempt against one model, honoring an abort signal. */
async function runQuery(
  originalPrompt: string,
  model: string,
  effort: EffortLevel,
  systemPrompt: string,
  env: Record<string, string | undefined>,
  abortController: AbortController,
): Promise<string> {
  const q = query({
    prompt: `Original prompt to optimize:\n${originalPrompt}`,
    options: {
      model,
      effort,
      systemPrompt,
      maxTurns: 1,
      allowedTools: [],
      permissionMode: 'bypassPermissions',
      settingSources: [],
      // Never initialize MCP servers in the spawned CLI — they are pure
      // startup cost for a single text-rewrite completion, and they eat the
      // model's time budget before the first token is generated.
      mcpServers: {},
      strictMcpConfig: true,
      abortController,
      env,
      stderr: (data: string) => {
        console.error('[sdk]', data.trim());
      },
    },
  });

  let result = '';
  for await (const msg of q) {
    if (msg.type === 'result') {
      if ('result' in msg && msg.subtype === 'success') {
        result = msg.result;
      } else {
        const errors = 'errors' in msg ? (msg as any).errors : [];
        throw new Error(`Agent SDK returned error: ${errors.join(', ') || msg.subtype}`);
      }
    }
  }

  return result.trim();
}

/** Resolve the time budget and fallback model for a given primary model. */
function resolvePolicy(config: OptimizerConfig, model: string): Policy {
  const policy = config.modelPolicy[model] || config.defaultPolicy;
  return config.budgetOverrideMs ? { ...policy, budgetMs: config.budgetOverrideMs } : policy;
}

/**
 * Optimize a prompt, trying the session model first and a cheaper sibling second.
 *
 * A timeout is the single most common failure, so it advances to the fallback
 * model exactly like any other error rather than aborting the chain — the whole
 * point of configuring a fallback is that it fires when the primary is too slow.
 * Only when every attempt is exhausted do we throw, and the caller then fails
 * open to the unmodified prompt.
 */
async function optimizePrompt(
  originalPrompt: string,
  config: OptimizerConfig,
  primaryModel: string,
): Promise<string> {
  const env = buildCleanEnv();
  const policy = resolvePolicy(config, primaryModel);

  const attempts: Array<{ model: string; budgetMs: number }> = [
    { model: primaryModel, budgetMs: policy.budgetMs },
  ];
  if (policy.fallback && policy.fallback !== primaryModel) {
    attempts.push({ model: policy.fallback, budgetMs: config.fallbackTimeoutMs });
  }

  let lastErr: unknown;
  for (const attempt of attempts) {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), attempt.budgetMs);
    const startedAt = Date.now();

    try {
      const systemPrompt = config.systemPromptTemplate.replace(/\{\{MODEL\}\}/g, attempt.model);
      const result = await runQuery(
        originalPrompt,
        attempt.model,
        config.effort,
        systemPrompt,
        env,
        abortController,
      );
      log(`ok model=${attempt.model} effort=${config.effort} ms=${Date.now() - startedAt}`);
      return result || originalPrompt;
    } catch (e) {
      lastErr = e;
      const elapsed = Date.now() - startedAt;

      if (abortController.signal.aborted) {
        log(`timeout model=${attempt.model} ms=${elapsed} budget=${attempt.budgetMs}`);
      } else {
        const msg = e instanceof Error ? e.message : String(e);
        log(`error model=${attempt.model} ms=${elapsed}: ${msg}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error('optimization failed for all models');
}

function shouldOptimize(prompt: string): boolean {
  return /<optimize>/i.test(prompt);
}

function stripOptimizeTag(prompt: string): string {
  return prompt.replace(/<\/?optimize\/?>/gi, '').trim();
}

async function main() {
  let inputData = '';
  try {
    for await (const chunk of process.stdin) {
      inputData += chunk;
    }

    const hookInput: HookInput = JSON.parse(inputData);

    // Passthrough: emit nothing so the prompt proceeds unchanged. (The shell
    // wrapper normally short-circuits this case before launching Node; this is
    // the safety net if the hook is invoked directly.)
    if (!shouldOptimize(hookInput.prompt)) {
      await writeAndExit('');
    }

    const config = loadConfig();
    const cleanedPrompt = stripOptimizeTag(hookInput.prompt);

    // A pasted document cannot be rewritten inside any sane budget, and trying
    // is the most reliable way to burn the whole hook timeout for nothing.
    if (cleanedPrompt.length > config.maxPromptChars) {
      log(`passthrough chars=${cleanedPrompt.length} max=${config.maxPromptChars}`);
      await writeAndExit(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: `[prompt-optimizer] Prompt is ${cleanedPrompt.length} characters (limit ${config.maxPromptChars}) — passed through without optimization.`,
          },
        } satisfies HookOutput),
      );
    }

    const sessionModel = config.matchSessionModel
      ? detectSessionModel(hookInput.transcript_path)
      : null;
    const primaryModel = sessionModel || config.model;
    log(
      `start session=${hookInput.session_id} chars=${cleanedPrompt.length} ` +
        `model=${primaryModel} source=${sessionModel ? 'session' : 'config-default'}`,
    );

    const optimizedPrompt = await optimizePrompt(cleanedPrompt, config, primaryModel);

    console.error('\n------------------------------------------------------------');
    console.error(`PROMPT OPTIMIZER - ${primaryModel}`);
    console.error('------------------------------------------------------------');
    console.error('\nOriginal Prompt:');
    console.error(`   ${cleanedPrompt}`);
    console.error('\nOptimized Prompt:');
    console.error(`   ${optimizedPrompt.split('\n').join('\n   ')}`);
    console.error('\n------------------------------------------------------------\n');

    const userMessage = `------------------------------------------------------------
PROMPT OPTIMIZER - ${primaryModel}
------------------------------------------------------------

Original Prompt: ${cleanedPrompt}

Optimized Prompt:

${optimizedPrompt}`;

    const output: HookOutput = {
      systemMessage: userMessage,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: userMessage,
      },
    };

    await writeAndExit(JSON.stringify(output));
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    console.error(`[prompt-optimizer] ERROR: ${errMsg}`);
    log(`failed: ${errMsg}`);

    // Extract original prompt from input if possible
    let originalPrompt = '';
    try { originalPrompt = JSON.parse(inputData).prompt?.replace(/<\/?optimize\/?>/gi, '').trim() ?? ''; } catch {}

    // Output valid hook JSON so the user sees something went wrong
    const output: HookOutput = {
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `[prompt-optimizer] Optimization failed: ${errMsg}${originalPrompt ? `\n\nOriginal prompt (unmodified):\n${originalPrompt}` : ''}`,
      },
    };
    await writeAndExit(JSON.stringify(output));
  }
}

main();
