/**
 * @fileoverview The shared runner of a STOCK CLI's install command: the one place Codeman
 * executes an install one-liner, used by `POST /api/clis/:id/install`
 * (src/web/routes/cli-registry-routes.ts) and by the local model install job.
 *
 * The code was moved here from cli-registry-routes.ts, and that route keeps its behaviour
 * byte for byte (same answers, same audit entry, same 409 for a second install of one id,
 * same environment).
 *
 * What lives here:
 *  - `installEnv()` and `npmGlobalPrefixWritable()`: the installer's environment is the
 *    server's minus every `CODEMAN_*` variable, with npm's global prefix pointed at a place
 *    the server user can write. test/routes/cli-registry-routes.test.ts imports both from the
 *    route module, which re-exports them from here.
 *  - `runInstallCommand()`: `shell: true`, its own process group, output capped, the whole
 *    group killed on timeout. New: an abort signal that kills the group the same way, so the
 *    install job's Cancel has something to stop.
 *  - `forgetResolvedCli()`: after an install, successful or not, every cached lookup of the
 *    CLI's binaries is dropped, or a pre-install miss is replayed for up to five minutes.
 *  - The set of ids with an install running. ONE set for both callers
 *    (`tryBeginCliInstall()`), so the route and the job can never run two installers of one
 *    CLI over the same prefix.
 *
 * Rules:
 *  - Which command runs is the CALLER's choice, and the two callers choose differently. The
 *    local model job passes `stockInstallCommand()`, which reads the compiled `STOCK_CLIS`
 *    and never the registry merged with `clis.json`, so an override file cannot change what
 *    that job runs. The CLI management route passes the merged entry's command
 *    (`resolveInstallCommandForPlatform(listClis()...)`), as it did before this module
 *    existed: a `clis.json` override of a stock entry's install command IS what that route
 *    runs (behind `cliManagementEnabled`, after a confirm that shows the exact text). A custom
 *    entry's install text is never executed by either. Switching the route to
 *    `stockInstallCommand()` would close that gap at the cost of a behaviour change the route
 *    tests pin; it is an owner decision, not made here.
 *  - Who may call it is the caller's rule, not this module's: the route keeps its
 *    `cliManagementEnabled` gate; the install job runs it only for a harness row of the local
 *    model catalogue, after the person's consent click on a screen that showed the literal
 *    command, admin only in multi-user mode, and writes the admin audit entry itself.
 */

import { execFile, spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { resolveInstallCommandForPlatform } from './config/cli-registry/registry.js';
import { STOCK_CLIS } from './config/cli-registry/stock.js';
import { getErrorMessage } from './types.js';
import { invalidateCliExecutableResolvers } from './utils/cli-executable-resolver.js';
import { invalidateCliResolverCache } from './utils/cli-resolver.js';

/** How long an install command may run before its process group is killed. */
export const CLI_INSTALL_TIMEOUT_MS = 300_000;

/** How an install command ended. */
export interface CliInstallResult {
  /** The exit code, `null` when the command was killed or could not be started. */
  code: number | null;
  /** stdout and stderr together, capped. */
  output: string;
  /** The timeout killed it. */
  timedOut: boolean;
  /** The abort signal killed it. */
  aborted: boolean;
}

export interface RunInstallCommandOptions {
  /** Kills the installer's whole process group (SIGTERM, then SIGKILL). */
  signal?: AbortSignal;
}

/**
 * Ids with an install running right now. A second request for the same id gets 409 rather
 * than a second `curl | bash` or `npm install -g` racing the first over the same prefix.
 */
const installsInFlight = new Set<string>();

const execFileAsync = promisify(execFile);

/**
 * True when `npm install -g` can write to this process's npm global prefix, or when that cannot
 * be determined (then nothing is redirected: a wrong guess would move installs somewhere the
 * user did not choose). `npm config get prefix` is asked rather than guessed from `process.execPath`
 * because a user `.npmrc` / `NPM_CONFIG_PREFIX` can point it anywhere.
 *
 * Async so the server keeps serving while npm boots (130 to 240 ms), and killed with SIGKILL on
 * timeout because `SIGTERM` alone leaves the wait running. A prefix that does not exist yet is
 * judged by the nearest ancestor that does: npm creates the missing directories, so a user
 * `.npmrc` pointing at `~/.npm-global` before it was made is not moved.
 */
export async function npmGlobalPrefixWritable(source: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('npm', ['config', 'get', 'prefix'], {
      env: source,
      encoding: 'utf8',
      timeout: 5_000,
      killSignal: 'SIGKILL',
    });
    const prefix = stdout.trim();
    if (!prefix) return true;
    // npm creates lib/node_modules under the prefix; walk up to the first directory that exists.
    let dir = join(prefix, 'lib', 'node_modules');
    for (;;) {
      try {
        await access(dir, fsConstants.W_OK);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return false;
        const parent = dirname(dir);
        if (parent === dir) return false;
        dir = parent;
      }
    }
  } catch {
    return true;
  }
}

/**
 * The server's environment minus every `CODEMAN_*` variable. An install script is third-party
 * code, and those variables carry Codeman's own secrets and wiring (`CODEMAN_PASSWORD`, the
 * data dir, the tmux socket), none of which an installer needs.
 *
 * It also points `NPM_CONFIG_PREFIX` at `$HOME/.local` so an `npm install -g` lands somewhere the
 * server user can write and Codeman's resolvers already search (`~/.local/bin`):
 *  - inside the Docker Compose container (`CODEMAN_IN_CONTAINER=1`), so installs survive an image
 *    update (the image's own prefix is image content);
 *  - on a native install whose npm global prefix is not writable by the server user (a system node
 *    under `/usr`, installed by root). Without this `npm install -g` died with EACCES (exit 243),
 *    e.g. DeepSeek's `npm install -g @deepseek-ai/dsh`. An explicit `NPM_CONFIG_PREFIX` the
 *    operator set is respected, and so is a prefix that is writable (nvm, `~/.npm-global`, ...).
 */
export function installEnv(
  source: NodeJS.ProcessEnv = process.env,
  prefixWritable: (env: NodeJS.ProcessEnv) => boolean = () => true
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith('CODEMAN_')) env[key] = value;
  }
  // ⚠️ In the Docker Compose deployment the image sets NPM_CONFIG_PREFIX=/opt/codeman-cli, which is IMAGE
  // content: `Update-Codeman.sh` recreates the container and every CLI installed there (dsh, pi, ...)
  // vanishes. HOME is the persistent bind mount and `~/.local/bin` is already on every resolver's search
  // list, so npm-based installs are redirected there. curl|bash installers already target HOME.
  if (source.CODEMAN_IN_CONTAINER === '1' && source.HOME) {
    redirectNpmPrefix(env, source.HOME);
  } else if (process.platform !== 'win32' && source.HOME && !source.NPM_CONFIG_PREFIX && !prefixWritable(env)) {
    redirectNpmPrefix(env, source.HOME);
  }
  return env;
}

/**
 * Point npm at `$HOME/.local`, dropping every spelling of the prefix key first. `npm run` exports a
 * lowercase `npm_config_prefix`, npm reads `npm_config_*` case-insensitively, and when both spellings
 * are present a `/bin/sh` that sorts its environment (bash) lets the older value win. The explicit
 * operator guard in `installEnv` stays on the uppercase key only: npm always injects the lowercase one.
 */
function redirectNpmPrefix(env: NodeJS.ProcessEnv, home: string): void {
  for (const key of Object.keys(env)) if (/^npm_config_prefix$/i.test(key)) delete env[key];
  env.NPM_CONFIG_PREFIX = `${home}/.local`;
}

/**
 * `installEnv` for this process, with the (async) npm prefix probe done first and only when the
 * command runs npm at all: a `curl | bash` installer never pays for it.
 */
async function installEnvFor(command: string, source: NodeJS.ProcessEnv = process.env): Promise<NodeJS.ProcessEnv> {
  const usesNpm = /\bnpm\b/.test(command);
  const probeNeeded =
    usesNpm &&
    source.CODEMAN_IN_CONTAINER !== '1' &&
    process.platform !== 'win32' &&
    !!source.HOME &&
    !source.NPM_CONFIG_PREFIX;
  const writable = probeNeeded ? await npmGlobalPrefixWritable(installEnv(source)) : true;
  return installEnv(source, () => writable);
}

/**
 * Runs a STOCK entry's already-vetted install command. `shell: true` is unavoidable here:
 * the shipped commands are genuinely `curl | bash` / `npm install -g` one-liners. This is NOT
 * a reopening of the config-shell-text concern the registry's `shellToken` pattern exists to
 * prevent: the string executed here is NEVER user input, only ever what is already hardcoded
 * and reviewed in `stock.ts`, and a CUSTOM entry can never reach this function at all (see the
 * guard of each caller).
 *
 * Never throws: a spawn that fails is a result with `code: null`.
 */
export async function runInstallCommand(
  command: string,
  options: RunInstallCommandOptions = {}
): Promise<CliInstallResult> {
  const { signal } = options;
  if (signal?.aborted) return { code: null, output: '', timedOut: false, aborted: true };
  const env = await installEnvFor(command);
  // The environment probe above can take a moment (npm boots): an abort during it starts nothing.
  if (signal?.aborted) return { code: null, output: '', timedOut: false, aborted: true };
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, {
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Own process group; the timeout below kills the whole tree by hand, mirroring
        // the DeepSeek profile-install endpoint's own reasoning: an install command fans
        // out into package-manager children, and spawn's own `timeout` option signals
        // only the direct child, leaving survivors holding the pipes open forever.
        detached: true,
        env,
      });
    } catch (err) {
      resolve({ code: null, output: `spawn failed: ${getErrorMessage(err)}`, timedOut: false, aborted: false });
      return;
    }

    let output = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let reapTimer: NodeJS.Timeout | undefined;

    const capture = (chunk: Buffer) => {
      if (output.length < 16_384) output += chunk.toString('utf-8');
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);

    const killTree = (killSignal: NodeJS.Signals) => {
      try {
        if (child.pid) process.kill(-child.pid, killSignal);
      } catch {
        /* already gone */
      }
    };

    /** SIGTERM to the group, SIGKILL three seconds later, and give up waiting after eight. */
    const stopTree = () => {
      if (killTimer) return;
      killTree('SIGTERM');
      killTimer = setTimeout(() => killTree('SIGKILL'), 3_000);
      reapTimer = setTimeout(() => finish(null), 8_000);
    };

    const onAbort = () => {
      aborted = true;
      stopTree();
    };

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (reapTimer) clearTimeout(reapTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code, output, timedOut, aborted });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stopTree();
    }, CLI_INSTALL_TIMEOUT_MS);

    signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (err) => {
      output = `${output}\n${err.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}

/**
 * The install command of the STOCK CLI `id` for this platform, read from the compiled
 * `STOCK_CLIS`. `undefined` for an id that is not a stock CLI or has no command here.
 */
export function stockInstallCommand(id: string): string | undefined {
  const entry = STOCK_CLIS.find((candidate) => (candidate.id as string) === id);
  if (!entry) return undefined;
  const command = resolveInstallCommandForPlatform(entry);
  return command !== undefined && command.trim() !== '' ? command : undefined;
}

/**
 * Claims the one install slot of `id`. Returns the function that releases it, or `null` when
 * an install of that CLI is already running (the caller answers 409 or waits).
 */
export function tryBeginCliInstall(id: string): (() => void) | null {
  if (installsInFlight.has(id)) return null;
  installsInFlight.add(id);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    installsInFlight.delete(id);
  };
}

/**
 * Forgets every cached binary lookup of a CLI: the generic per-id resolver (which captures
 * the entry's binaries when first built) and every per-binary cache, hits and negative-cache
 * backoff alike. Called after anything that changes what is on disk or what the CLI's binary
 * IS; see `invalidateCliExecutableResolvers`.
 */
export function forgetResolvedCli(id: string, binaries: readonly string[]): void {
  invalidateCliExecutableResolvers(binaries);
  invalidateCliResolverCache(id);
}
