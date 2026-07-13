#!/usr/bin/env tsx

import { query } from '@anthropic-ai/claude-agent-sdk';
import { readFileSync } from 'fs';
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

interface OptimizerConfig {
  model: string;
  fallbackModel?: string;
  effort: EffortLevel;
  timeoutMs: number;
  systemPrompt: string;
}

const HOOK_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Load configuration from optimizer.config.json (next to this file), with
 * environment-variable overrides. The system prompt lives in its own file so
 * it can be tuned without touching code or bumping the model in two places.
 */
function loadConfig(): OptimizerConfig {
  const raw = JSON.parse(readFileSync(join(HOOK_DIR, 'optimizer.config.json'), 'utf8'));
  const systemPrompt = readFileSync(join(HOOK_DIR, raw.systemPromptFile), 'utf8').trim();

  return {
    model: process.env.OPTIMIZER_MODEL || raw.model,
    fallbackModel: process.env.OPTIMIZER_FALLBACK_MODEL || raw.fallbackModel,
    // Prompt optimization is a single-turn rewrite, not a reasoning task, so the
    // default 'high' effort is wasteful — it drives the model past the timeout
    // (which then fails open to the un-optimized prompt). 'low' keeps adaptive
    // thinking on but minimal, so responses land well inside timeoutMs and the
    // reasoning stays in thinking blocks rather than leaking into the rewrite.
    effort: (process.env.OPTIMIZER_EFFORT || raw.effort || 'low') as EffortLevel,
    timeoutMs: Number(process.env.OPTIMIZER_TIMEOUT_MS) || raw.timeoutMs || 20000,
    systemPrompt,
  };
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

/**
 * Optimize a prompt, with an overall timeout and a model fallback chain.
 *
 * A timeout aborts and propagates (caller falls back to the original prompt
 * rather than blocking the session). A model error (overload, bad model id)
 * advances to the fallback model before giving up.
 */
async function optimizePrompt(originalPrompt: string, config: OptimizerConfig): Promise<string> {
  const env = buildCleanEnv();
  const models = [config.model, config.fallbackModel].filter(
    (m, i, a): m is string => !!m && a.indexOf(m) === i,
  );

  let lastErr: unknown;
  for (const model of models) {
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), config.timeoutMs);
    try {
      const result = await runQuery(originalPrompt, model, config.effort, config.systemPrompt, env, abortController);
      return result || originalPrompt;
    } catch (e) {
      lastErr = e;
      if (abortController.signal.aborted) {
        throw new Error(`optimization timed out after ${config.timeoutMs}ms`);
      }
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[optimizer] model ${model} failed, trying fallback: ${msg}`);
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
    const optimizedPrompt = await optimizePrompt(cleanedPrompt, config);

    console.error('\n------------------------------------------------------------');
    console.error('PROMPT OPTIMIZER - ULTRATHINK MODE ENABLED');
    console.error('------------------------------------------------------------');
    console.error('\nOriginal Prompt:');
    console.error(`   ${cleanedPrompt}`);
    console.error('\nOptimized Prompt:');
    console.error(`   ${optimizedPrompt.split('\n').join('\n   ')}`);
    console.error('\n------------------------------------------------------------\n');

    const userMessage = `------------------------------------------------------------
PROMPT OPTIMIZER - ULTRATHINK MODE ENABLED
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
