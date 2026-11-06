/**
 * @fileoverview The shared runner of a STOCK CLI's install command: the one place Codeman
 * executes an install one-liner, used by `POST /api/clis/:id/install`
 * (src/web/routes/cli-registry-routes.ts) and by the local model install job.
 *
 * CONTRACT STAGE: `CLI_INSTALL_TIMEOUT_MS` is final. Every function below has its final
 * signature and a body that throws. The bodies are MOVED here from cli-registry-routes.ts
 * next, and that route keeps its behaviour byte for byte (same answers, same audit entry,
 * same 409 for a second install of one id, same environment).
 *
 * What moves, unchanged in behaviour:
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
 *  - The command executed is only ever a STOCK entry's (`stockInstallCommand()` reads the
 *    compiled `STOCK_CLIS`, never the registry merged with `clis.json`, so an override file
 *    cannot change what runs). A custom entry's install text is never executed.
 *  - Who may call it is the caller's rule, not this module's: the route keeps its
 *    `cliManagementEnabled` gate; the install job runs it only for a harness row of the local
 *    model catalogue, after the person's consent click on a screen that showed the literal
 *    command, admin only in multi-user mode, and writes the admin audit entry itself.
 */

/** Marks a body the contract stage left unwritten. */
function notImplemented(what: string, ..._args: unknown[]): never {
  throw new Error(`${what} is not implemented yet`);
}

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
 * True when `npm install -g` can write to this environment's npm global prefix, or when that
 * cannot be told (then nothing is redirected). Moved from cli-registry-routes.ts unchanged.
 */
export async function npmGlobalPrefixWritable(source: NodeJS.ProcessEnv): Promise<boolean> {
  return notImplemented('npmGlobalPrefixWritable', source);
}

/**
 * The environment of an install command: `source` minus every `CODEMAN_*` variable, with
 * `NPM_CONFIG_PREFIX` pointed at `$HOME/.local` inside the Compose container or when the
 * global prefix is not writable. Moved from cli-registry-routes.ts unchanged.
 */
export function installEnv(
  source: NodeJS.ProcessEnv = process.env,
  prefixWritable: (env: NodeJS.ProcessEnv) => boolean = () => true
): NodeJS.ProcessEnv {
  return notImplemented('installEnv', source, prefixWritable);
}

/** Runs one install command to its end. Never throws: a spawn that fails is a result with `code: null`. */
export async function runInstallCommand(
  command: string,
  options: RunInstallCommandOptions = {}
): Promise<CliInstallResult> {
  return notImplemented('runInstallCommand', command, options);
}

/**
 * The install command of the STOCK CLI `id` for this platform, read from the compiled
 * `STOCK_CLIS`. `undefined` for an id that is not a stock CLI or has no command here.
 */
export function stockInstallCommand(id: string): string | undefined {
  return notImplemented('stockInstallCommand', id);
}

/**
 * Claims the one install slot of `id`. Returns the function that releases it, or `null` when
 * an install of that CLI is already running (the caller answers 409 or waits).
 */
export function tryBeginCliInstall(id: string): (() => void) | null {
  return notImplemented('tryBeginCliInstall', id);
}

/**
 * Forgets every cached binary lookup of a CLI: the per-id resolver and every per-binary cache,
 * hits and misses alike. Called after anything that may have changed what is on disk.
 */
export function forgetResolvedCli(id: string, binaries: readonly string[]): void {
  return notImplemented('forgetResolvedCli', id, binaries);
}
