#!/usr/bin/env -S npx tsx
/**
 * Standalone smoke-test for pointing each Codeman-supported harness CLI at a
 * custom OpenAI-compatible endpoint — local (llama.cpp, Ollama, vLLM, ...) or
 * cloud (Azure AI Foundry's OpenAI-compatible endpoint, OpenRouter, a
 * self-hosted gateway, ...). Anything that answers GET /v1/models and POST
 * /v1/chat/completions in the standard shape qualifies; --base-url is not
 * assumed to be a LAN address.
 *
 * This is intentionally OUTSIDE the npm test suite and outside Codeman's own
 * session/tmux machinery: it spawns each real CLI binary directly, one-shot,
 * with the env vars / config files that CLI's own docs say redirect it to a
 * custom endpoint, and checks it can answer "hello world".
 *
 * DYNAMIC BY DESIGN: this file imports the SAME `enabledClis()` registry and
 * `buildCustomModelInjection()` builder the production feature uses (see
 * ../src/config/cli-registry/, ../src/custom-model-injection.ts,
 * ../src/custom-model-injection-apply.ts) rather than keeping a second,
 * hand-maintained copy of each CLI's env vars/config shape. A registry
 * change (a new CLI, an edited env var name, a fixed config template) is
 * picked up here automatically with zero edits to this file. Only the
 * ONE-SHOT INVOCATION FLAGS (how to make each CLI answer one prompt and
 * exit — information the registry doesn't model at all, since it only knows
 * how to launch the interactive TUI) stay in the small ONE_SHOT table below;
 * a CLI newly added to the registry with no ONE_SHOT entry is reported
 * UNKNOWN rather than silently skipped or guessed at.
 *
 * Cloud endpoints often differ from a bare llama.cpp box in two ways this
 * script accounts for: (1) auth may be an `api-key` header (Azure's
 * convention) rather than `Authorization: Bearer` — see --auth-style below.
 * (2) a cloud endpoint's "model" may actually be a deployment name distinct
 * from the model family (Azure AI Foundry deployments) — always pass
 * --model explicitly for those rather than relying on GET /v1/models
 * discovery.
 *
 * IMPORTANT CONFIDENCE NOTE: claude and opencode are verified end-to-end
 * against a real llama-swap server. codex's config STRUCTURE is verified,
 * but it only speaks the Responses API (dropped Chat-Completions support
 * Feb 2026) — expect it to fail against a plain OpenAI-compatible server,
 * that's a real protocol gap, not a bug here. gemini/pi/grok/omp have their
 * ONE-SHOT INVOCATION flags confirmed against real installed binaries'
 * `--help` output, but their custom-endpoint env/config conventions remain
 * web-researched, unverified. deepseek (dsh) is a profile launcher with no
 * documented one-shot prompt flag at all — best-effort only. antigravity
 * has no known CLI/env/config mechanism (GUI-only per public docs) — its
 * registry entry declares `customModelInjection: { kind: 'unsupported' }`,
 * which this script picks up dynamically and always skips.
 *
 * Usage:
 *   npx tsx scripts/test-local-llm-harnesses.ts --base-url http://192.168.1.50:8080 [options]
 *   npx tsx scripts/test-local-llm-harnesses.ts --base-url https://<resource>.services.ai.azure.com/openai/v1 --model <deployment-name> --api-key $AZURE_AI_KEY
 *
 * Options:
 *   --base-url <url>       Required. Root URL of the OpenAI-compatible endpoint (local or cloud).
 *   --model <name>         Model/deployment id to request. Default: first from GET /v1/models.
 *   --api-key <key>        API key to send. Default: local-dummy-key (fine for llama.cpp; required for most cloud endpoints).
 *   --auth-style <style>   "bearer" (default, Authorization: Bearer) or "api-key" (the
 *                          `api-key` header some cloud gateways, e.g. Azure, want).
 *                          NEVER send both — live-tested against a real server, doing
 *                          so reliably HANGS the request indefinitely.
 *   --prompt <text>        Prompt to send. Default: "Reply with exactly: hello world".
 *   --only <id,id,...>     Restrict to these harness ids (comma-separated).
 *   --timeout <ms>         Per-harness spawn timeout. Default: 30000.
 *   --probe-help           Instead of testing, resolve each installed binary and print --help.
 *   --keep-temp            Don't delete generated per-harness config dirs afterward.
 *   --list                 Dry run: print the resolved plan per harness, execute nothing.
 *   -h, --help              Show this help.
 */

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, delimiter, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enabledClis } from '../src/config/cli-registry/index.js';
import type { CliEntry } from '../src/config/cli-registry/types.js';
import {
  buildCustomModelInjection,
  GROK_CUSTOM_MODEL_NAME,
  type CustomModelEndpoint,
} from '../src/custom-model-injection.js';
import { applyConfigDirInjection } from '../src/custom-model-injection-apply.js';

const TAG = '[test-local-llm-harnesses]';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(SCRIPT_DIR, 'local-llm-test.config.json');
const CONFIG_EXAMPLE_PATH = join(SCRIPT_DIR, 'local-llm-test.config.example.json');

type AuthStyle = 'bearer' | 'api-key';

interface ConfigDefaults {
  baseUrl?: string | null;
  model?: string | null;
  apiKey?: string;
  authStyle?: AuthStyle;
  prompt?: string;
  only?: string[] | null;
  timeout?: number;
}

/**
 * Loads scripts/local-llm-test.config.json (gitignored — real IP/model/key,
 * per-machine) if present, so you don't have to retype --base-url every run.
 * See local-llm-test.config.example.json (tracked) for the shape. CLI flags
 * always override whatever this file sets; this only supplies defaults.
 */
function loadConfigFile(): ConfigDefaults {
  if (!existsSync(CONFIG_PATH)) return {};
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
    return {
      baseUrl: raw.baseUrl ?? null,
      model: raw.model ?? null,
      apiKey: raw.apiKey || undefined, // empty string counts as "not set", not a real key
      authStyle: raw.authStyle === 'api-key' ? 'api-key' : undefined, // never 'both'
      prompt: raw.prompt ?? undefined,
      only: Array.isArray(raw.only) && raw.only.length ? raw.only : null,
      timeout: typeof raw.timeout === 'number' ? raw.timeout : undefined,
    };
  } catch (err) {
    console.error(`${TAG} failed to parse ${CONFIG_PATH}: ${(err as Error).message} (ignoring it)`);
    return {};
  }
}

interface Opts {
  baseUrl: string | null;
  model: string | null;
  apiKey: string;
  authStyle: AuthStyle;
  prompt: string;
  only: string[] | null;
  timeout: number;
  probeHelp: boolean;
  keepTemp: boolean;
  list: boolean;
  help: boolean;
}

function parseArgs(argv: string[], configDefaults: ConfigDefaults): Opts {
  const opts: Opts = {
    baseUrl: configDefaults.baseUrl ?? null,
    model: configDefaults.model ?? null,
    apiKey: configDefaults.apiKey ?? 'local-dummy-key',
    authStyle: configDefaults.authStyle ?? 'bearer',
    prompt: configDefaults.prompt ?? 'Reply with exactly: hello world',
    only: configDefaults.only ?? null,
    timeout: configDefaults.timeout ?? 30000,
    probeHelp: false,
    keepTemp: false,
    list: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--base-url':
        opts.baseUrl = argv[++i];
        break;
      case '--model':
        opts.model = argv[++i];
        break;
      case '--api-key':
        opts.apiKey = argv[++i];
        break;
      case '--auth-style':
        opts.authStyle = argv[++i] as AuthStyle;
        if (opts.authStyle !== 'bearer' && opts.authStyle !== 'api-key') {
          console.error(`${TAG} --auth-style must be "bearer" or "api-key"`);
          opts.help = true;
        }
        break;
      case '--prompt':
        opts.prompt = argv[++i];
        break;
      case '--only':
        opts.only = argv[++i]
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case '--timeout':
        opts.timeout = Number(argv[++i]);
        break;
      case '--probe-help':
        opts.probeHelp = true;
        break;
      case '--keep-temp':
        opts.keepTemp = true;
        break;
      case '--list':
        opts.list = true;
        break;
      case '-h':
      case '--help':
        opts.help = true;
        break;
      default:
        console.error(`${TAG} unknown argument: ${a}`);
        opts.help = true;
    }
  }
  return opts;
}

function printUsage(): void {
  console.log(`Usage: npx tsx scripts/test-local-llm-harnesses.ts [--base-url <url>] [options]

Reads defaults from scripts/local-llm-test.config.json if it exists (copy
scripts/local-llm-test.config.example.json to create it — gitignored, since
it holds a real IP/model/key). CLI flags always override the config file.
--base-url becomes optional once that file supplies one.

Works against any custom OpenAI-compatible endpoint, local or cloud
(llama.cpp, Ollama, vLLM, Azure AI Foundry, OpenRouter, a self-hosted
gateway, ...) — anything answering GET /v1/models and POST
/v1/chat/completions in the standard shape.

Options:
  --base-url <url>     Required. Root URL of the OpenAI-compatible endpoint.
  --model <name>       Model/deployment id to request. Default: first from GET /v1/models.
  --api-key <key>      API key to send. Default: local-dummy-key (required for most cloud endpoints).
  --auth-style <style> "bearer" (default) or "api-key" (Azure-style). Never both — sending
                       both headers together reliably hangs some real servers.
  --prompt <text>      Prompt to send. Default: "Reply with exactly: hello world".
  --only <id,id,...>   Restrict to these harness ids.
  --timeout <ms>       Per-harness spawn timeout. Default: 30000.
  --probe-help         Print each installed binary's --help instead of testing.
  --keep-temp          Keep generated per-harness config dirs afterward.
  --list               Dry run: print the resolved plan, execute nothing.
  -h, --help            Show this help.

Harness ids are read from the CLI registry at run time — pass an unknown
one and the error message lists what's actually enabled right now.

Examples:
  npx tsx scripts/test-local-llm-harnesses.ts --base-url http://192.168.1.50:8080
  npx tsx scripts/test-local-llm-harnesses.ts --base-url https://<resource>.services.ai.azure.com/openai/v1 --model <deployment-name> --api-key $AZURE_AI_KEY`);
}

const HOME = homedir();

/** Expands a leading `~` the way the CLI registry's own search dirs are written. */
function expandHome(p: string): string {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return join(HOME, p.slice(2));
  return p;
}

function pathWithExtraDirs(extraDirs: string[]): string {
  return [...extraDirs.map(expandHome), '/usr/local/bin', process.env.PATH ?? ''].join(delimiter);
}

/** Resolve a binary by trying `<bin> --version` with the CLI's own registry search dirs prefixed onto PATH. */
function resolveBinary(bin: string, searchDirs: string[]): string | null {
  try {
    execFileSync(bin, ['--version'], {
      timeout: 5000,
      stdio: 'pipe',
      env: { ...process.env, PATH: pathWithExtraDirs(searchDirs) },
    });
    return bin;
  } catch (err) {
    // Some CLIs (e.g. dsh) don't support --version cleanly for identity but
    // still exist on PATH; a non-ENOENT failure still counts as "found".
    if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return bin;
  }
}

function printHelp(bin: string, searchDirs: string[]): void {
  try {
    const out = execFileSync(bin, ['--help'], {
      timeout: 5000,
      stdio: 'pipe',
      env: { ...process.env, PATH: pathWithExtraDirs(searchDirs) },
    });
    console.log(out.toString());
  } catch (err) {
    const e = err as { stdout?: Buffer; message?: string };
    console.log((e.stdout ?? e.message ?? String(err)).toString());
  }
}

// --- one-shot invocation table (NOT in the registry — genuinely separate info) ---

type Confidence = 'verified' | 'researched' | 'unknown';

interface OneShot {
  /** `modelId` is the RAW model/deployment id (e.g. "qwen3.5-0.8b-...") — CLIs whose
   *  config wraps it under a provider/block name (pi/omp's "custom/<id>", grok's fixed
   *  block name) build the full `--model` value here, not in the injection layer. */
  argv: (prompt: string, modelId: string) => string[];
  confidence: Confidence;
  note?: string;
}

/**
 * How to make each CLI answer ONE prompt and exit. The registry has no concept
 * of this (it only knows the interactive TUI launch line), so this table is
 * necessarily hand-maintained — but it is the ONLY hand-maintained part left;
 * everything about WHERE the prompt goes (env vars, config files) comes from
 * the real registry + `buildCustomModelInjection()` above.
 *
 * A CLI enabled in the registry with no entry here reports UNKNOWN rather
 * than being silently skipped or guessed at — see `resolveOneShot()`.
 */
const ONE_SHOT: Record<string, OneShot> = {
  claude: {
    confidence: 'verified',
    // Claude Code's async session-title-generation call also uses
    // ANTHROPIC_DEFAULT_HAIKU_MODEL and validates it against Claude's OWN internal
    // recognized-model list, printing [claude-code:unrecognized_model] to stderr for
    // a local model name. Confirmed live: `--settings '{"autoTitle":false}'` does NOT
    // stop it (still hung the whole run); `--bare` does — the warning still prints,
    // but the actual prompt now runs and returns the real answer. Confirmed against
    // a real llama-swap server. ⚠️ `--bare` also disables hooks/LSP/plugin sync/
    // CLAUDE.md auto-discovery — fine for this ISOLATED one-shot test, never safe to
    // apply to a real interactive Codeman session (which needs hooks).
    argv: (prompt) => ['--dangerously-skip-permissions', '--bare', '-p', prompt],
  },
  opencode: { confidence: 'verified', argv: (prompt) => ['run', prompt] },
  codex: {
    confidence: 'verified',
    note: 'config STRUCTURE verified; codex only speaks the Responses API (dropped Chat-Completions Feb 2026) — expect FAIL against a plain OpenAI-compatible server, that is a protocol gap, not a bug here.',
    argv: (prompt) => ['exec', '--dangerously-bypass-approvals-and-sandbox', prompt],
  },
  gemini: {
    confidence: 'researched',
    // --skip-trust: without it, an untrusted-folder check silently overrides
    // --approval-mode yolo back to 'default' (confirmed live: "Approval mode
    // overridden to 'default' because the current folder is not trusted").
    argv: (prompt) => ['-p', prompt, '--approval-mode', 'yolo', '--skip-trust'],
  },
  pi: {
    confidence: 'verified',
    // --model custom/<id>: without an explicit --model, pi uses its own default
    // provider (not our injected "custom" one) and fails with "No API key found
    // for the selected model" — confirmed live. "custom" matches the provider name
    // pi-models-json writes in custom-model-injection.ts. Verified end-to-end
    // against a real llama-swap server after two real bugs were found and fixed:
    // pi's `models` field must be an ARRAY of `{id}` objects (an object keyed by
    // id silently loaded zero models), and PI_CONFIG_DIR does nothing for pi at
    // all (grepped pi's own bundled source — not present anywhere); the actual
    // working redirect is the CHILD PROCESS's `HOME` itself, since pi hardcodes
    // `~/.pi/agent/models.json` with no dedicated override.
    argv: (prompt, modelId) => ['--approve', '--model', `custom/${modelId}`, '-p', prompt],
  },
  grok: {
    confidence: 'verified',
    // -m <block name>: grok's config.toml (grok-toml template) declares the custom
    // model under a fixed [model.<name>] block; GROK_CUSTOM_MODEL_NAME is that same
    // name, imported from custom-model-injection.ts so the two can never drift apart.
    // Verified end-to-end against a real llama-swap server after correcting the
    // ORIGINAL recipe, which was wrong (env vars, not a config file — see the
    // customModelInjection comment on grok's registry entry).
    argv: (prompt) => ['--always-approve', '-m', GROK_CUSTOM_MODEL_NAME, '-p', prompt],
  },
  deepseek: {
    confidence: 'unknown',
    note: 'dsh is a profile launcher, not a documented one-shot prompt flag. Best-effort only.',
    argv: (prompt) => ['--profile', 'headless', prompt],
  },
  omp: {
    confidence: 'verified',
    // --model custom/<id>: same reasoning as pi — omp's own default model has no
    // credential, so without an explicit --model it never reaches our injected
    // provider at all. Verified end-to-end against a real llama-swap server after
    // the same two fixes as pi (array-shaped `models`, HOME-redirect instead of
    // PI_CONFIG_DIR — omp hardcodes `~/.omp/agent/models.yml`).
    argv: (prompt, modelId) => ['--model', `custom/${modelId}`, '-p', prompt],
  },
};

// --- baseline server check ---------------------------------------------------

async function baselineCheck(
  baseUrl: string,
  apiKey: string,
  authStyle: AuthStyle,
  model: string | null,
  prompt: string,
  timeoutMs: number
): Promise<string> {
  console.log(`\n=== Step 0: baseline check against ${baseUrl} (auth: ${authStyle}) ===`);

  // Exactly ONE header, never both. An earlier version sent both auth conventions
  // (Bearer + api-key) on the theory that an unused header is harmless — live-
  // tested against a real llama-swap server, sending both reliably HUNG the
  // request indefinitely (reproduced 3x: Bearer alone ~500ms, api-key alone
  // ~600ms, both together no response inside a 15s timeout). Use --auth-style
  // api-key for endpoints that specifically want that header (e.g. Azure AI
  // Foundry); default 'bearer' covers everything else.
  const authHeaders: Record<string, string> =
    authStyle === 'api-key' ? { 'api-key': apiKey } : { Authorization: `Bearer ${apiKey}` };

  let discoveredModel = model;
  try {
    const res = await fetch(`${baseUrl}/v1/models`, {
      headers: authHeaders,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const ids: string[] = (body.data ?? []).map((m: { id: string }) => m.id);
    console.log(`GET /v1/models -> ${ids.length ? ids.join(', ') : '(empty list)'}`);
    if (!discoveredModel && ids.length) discoveredModel = ids[0];
  } catch (err) {
    console.error(`${TAG} GET /v1/models failed: ${(err as Error).message}`);
    console.error(`${TAG} Is the server actually running at ${baseUrl}? Aborting.`);
    process.exit(1);
  }

  if (!discoveredModel) {
    console.error(`${TAG} No --model given and none discovered from /v1/models. Aborting.`);
    process.exit(1);
  }

  // Live-tested against a real llama-swap server: a POST issued right after a GET on
  // the same Node process reliably HANGS indefinitely (reproduced repeatedly — GET
  // alone ~30ms, POST alone ~1-2s, GET-then-immediate-POST times out completely; a
  // 2s pause between them fixed it every time). This looks like Node's fetch (undici)
  // reusing a pooled keep-alive connection the server doesn't handle cleanly for a
  // second request right behind a first. A short pause is the simplest portable fix
  // (no extra deps, no need for undici's Agent/dispatcher API).
  await new Promise((resolve) => setTimeout(resolve, 2000));

  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        model: discoveredModel,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const body = await res.json();
    const reply: string = body.choices?.[0]?.message?.content ?? '';
    if (!reply.trim()) throw new Error('empty reply');
    console.log(`POST /v1/chat/completions -> "${reply.trim().slice(0, 200)}"`);
    console.log('Server baseline: PASS\n');
  } catch (err) {
    console.error(`${TAG} POST /v1/chat/completions failed: ${(err as Error).message}`);
    console.error(`${TAG} Server responded to /v1/models but not to a chat request. Aborting.`);
    process.exit(1);
  }

  return discoveredModel;
}

// --- per-harness run ----------------------------------------------------------

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runChild(bin: string, argv: string[], env: Record<string, string>, searchDirs: string[], timeoutMs: number) {
  return new Promise<ChildResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(bin, argv, {
      env: { ...process.env, ...env, PATH: pathWithExtraDirs(searchDirs) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}`, timedOut: false });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut: false });
    });
  });
}

interface HarnessResult {
  id: string;
  confidence: Confidence | 'unsupported' | 'no-one-shot-recipe';
  status: 'PASS' | 'FAIL' | 'UNCONFIRMED' | 'SKIP' | 'LIST';
  detail: string;
}

async function runHarness(
  entry: CliEntry,
  opts: Opts,
  model: string,
  endpoint: CustomModelEndpoint
): Promise<HarnessResult> {
  const id = entry.id;
  const injectionCap = entry.capabilities.customModelInjection;

  // Dynamic: driven by the REGISTRY's own capability, not a hardcoded id check.
  // A future CLI declared unsupported is skipped automatically, same as antigravity today.
  if (injectionCap.kind === 'unsupported') {
    return {
      id,
      confidence: 'unsupported',
      status: 'SKIP',
      detail: 'no known custom-model mechanism (registry: unsupported)',
    };
  }

  const oneShot = ONE_SHOT[id];
  if (!oneShot) {
    return {
      id,
      confidence: 'no-one-shot-recipe',
      status: 'SKIP',
      detail:
        'registry supports custom-model injection for this CLI, but this script has no ONE_SHOT invocation entry yet — add one to test it',
    };
  }

  const binary = entry.discovery.binaries[0] ?? id;
  const searchDirs = entry.discovery.searchDirs;
  const resolved = resolveBinary(binary, searchDirs);
  if (!resolved) {
    return {
      id,
      confidence: oneShot.confidence,
      status: 'SKIP',
      detail: `binary "${binary}" not found on PATH or search dirs`,
    };
  }

  // The REAL injection logic — same function the production route calls.
  const injection = buildCustomModelInjection(entry, endpoint, model);

  let env: Record<string, string> = {};
  let tempDir: string | null = null;

  if (injection.kind === 'env') {
    env = injection.envOverrides;
  } else if (injection.kind === 'configDir') {
    tempDir = mkdtempSync(join(tmpdir(), `codeman-local-llm-test-${id}-`));
    env = applyConfigDirInjection(tempDir, injection);
  }
  // injection.kind === 'unsupported' already handled via injectionCap above.

  const argv = oneShot.argv(opts.prompt, model);

  if (opts.list) {
    const detail = `${binary} ${argv.join(' ')} | env: ${Object.keys(env).join(', ')}${tempDir ? ` | configDir: ${tempDir}` : ''}`;
    if (tempDir && !opts.keepTemp) rmSync(tempDir, { recursive: true, force: true });
    return { id, confidence: oneShot.confidence, status: 'LIST', detail };
  }

  const { code, stdout, stderr, timedOut } = await runChild(binary, argv, env, searchDirs, opts.timeout);

  let detailSuffix = '';
  if (tempDir && !opts.keepTemp) rmSync(tempDir, { recursive: true, force: true });
  else if (tempDir) detailSuffix = ` [config kept at ${tempDir}]`;

  if (timedOut) {
    return {
      id,
      confidence: oneShot.confidence,
      status: 'FAIL',
      detail: `timed out after ${opts.timeout}ms. stderr: ${stderr.slice(-300)}${detailSuffix}`,
    };
  }

  const reply = stdout.trim();
  const matched = /hello/i.test(reply) && /world/i.test(reply);
  const softStatus: HarnessResult['status'] = oneShot.confidence === 'verified' ? 'FAIL' : 'UNCONFIRMED';

  if (code !== 0) {
    return {
      id,
      confidence: oneShot.confidence,
      status: softStatus,
      detail: `exit ${code}. stderr: ${stderr.trim().slice(-300) || '(empty)'}${detailSuffix}`,
    };
  }
  if (!reply) {
    return { id, confidence: oneShot.confidence, status: softStatus, detail: `exit 0 but empty stdout${detailSuffix}` };
  }
  if (matched) {
    return { id, confidence: oneShot.confidence, status: 'PASS', detail: `${reply.slice(0, 200)}${detailSuffix}` };
  }
  return {
    id,
    confidence: oneShot.confidence,
    status: 'UNCONFIRMED',
    detail: `reply didn't match heuristic, judge by eye: "${reply.slice(0, 300)}"${detailSuffix}`,
  };
}

// --- main ---------------------------------------------------------------------

async function main(): Promise<void> {
  const configDefaults = loadConfigFile();
  const opts = parseArgs(process.argv.slice(2), configDefaults);
  if (opts.help) {
    printUsage();
    process.exit(0);
  }

  // Dynamic: pulled from the live registry, not a hardcoded id list. `kind === 'agent'`
  // excludes 'shell' (no model/endpoint concept). Antigravity stays in this list (it IS
  // an enabled agent CLI) — it's the `unsupported` capability check in runHarness that
  // skips it, not an exclusion here.
  const allEntries = enabledClis().filter((e) => e.kind === 'agent');
  const byId = new Map(allEntries.map((e) => [e.id, e]));
  const ids = opts.only ?? [...byId.keys()];
  const unknownIds = ids.filter((id) => !byId.has(id));
  if (unknownIds.length) {
    console.error(`${TAG} unknown harness id(s): ${unknownIds.join(', ')}`);
    console.error(`${TAG} known ids (from the live CLI registry): ${[...byId.keys()].join(', ')}`);
    process.exit(1);
  }
  const entries = ids.map((id) => byId.get(id)!);

  // --probe-help never touches the network — no --base-url needed for it.
  if (opts.probeHelp) {
    for (const entry of entries) {
      const binary = entry.discovery.binaries[0] ?? entry.id;
      const resolved = resolveBinary(binary, entry.discovery.searchDirs);
      console.log(`\n=== ${entry.id} (${binary}) ===`);
      if (!resolved) {
        console.log('(not found on PATH or search dirs)');
        continue;
      }
      printHelp(binary, entry.discovery.searchDirs);
    }
    process.exit(0);
  }

  if (!opts.baseUrl) {
    console.error(`${TAG} --base-url is required (pass it, or set "baseUrl" in ${CONFIG_PATH}).`);
    console.error(`${TAG} See ${CONFIG_EXAMPLE_PATH} for the config file shape.\n`);
    printUsage();
    process.exit(1);
  }
  opts.baseUrl = opts.baseUrl.replace(/\/+$/, '');

  const endpoint: CustomModelEndpoint = {
    id: 'standalone-test',
    label: 'standalone test',
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
  };

  // --list is a pure dry run: never touch the network, even if --model was given.
  let model: string;
  if (opts.list) {
    model = opts.model ?? 'local-model';
    console.log(`\n=== Step 0 skipped (--list never hits the network; using placeholder "${model}") ===\n`);
  } else {
    model = await baselineCheck(opts.baseUrl, opts.apiKey, opts.authStyle, opts.model, opts.prompt, opts.timeout);
  }

  console.log(`=== Testing ${entries.length} harness(es) ===`);
  const results: HarnessResult[] = [];
  for (const entry of entries) {
    process.stdout.write(`\n--- ${entry.id} ---\n`);
    const result = await runHarness(entry, opts, model, endpoint);
    results.push(result);
    console.log(`${result.status}: ${result.detail}`);
  }

  console.log('\n=== Summary ===');
  const width = Math.max(...results.map((r) => r.id.length)) + 2;
  for (const r of results) {
    console.log(`${r.id.padEnd(width)} [${r.confidence.padEnd(20)}] ${r.status.padEnd(11)} ${r.detail.slice(0, 100)}`);
  }

  const hardFail = results.some((r) => r.status === 'FAIL' && r.confidence === 'verified');
  if (hardFail) {
    console.error(
      `\n${TAG} at least one VERIFIED harness FAILed — that's a real regression, not just an unconfirmed guess.`
    );
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(`${TAG} unexpected error:`, err);
  process.exit(1);
});
