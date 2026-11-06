/**
 * @fileoverview The model runtime: which build Codeman runs, how it gets onto the disk, and
 * how it is kept running.
 *
 * CONTRACT STAGE: `OLLAMA_RUNTIME_PIN` and the constants are final. Every function below has
 * its final signature and a body that throws; the bodies are written next.
 *
 * What this module does:
 *  - THE PIN. `OLLAMA_RUNTIME_PIN` is a compiled constant. No file, setting, environment
 *    variable or request can change the URL, the size or the hash.
 *  - DOWNLOAD (`ensureRuntimeInstalled()`). The archive is streamed to
 *    `LocalModelPaths.archivePartial` while it is hashed. A cut stream is continued with a
 *    Range request, at most `RUNTIME_DOWNLOAD_RETRIES` times. A body longer than `pin.bytes`
 *    is refused. The sha256 is compared BEFORE anything is unpacked, and a mismatch deletes the
 *    file. Unpacking is `/usr/bin/tar` into `LocalModelPaths.unpackDir`, then one rename to
 *    `LocalModelPaths.runtimeDir`.
 *  - ENVIRONMENT (`runtimeEnv()`, pure). The child's environment is built from an ALLOWLIST:
 *    PATH, TMPDIR, LANG and the proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`, in
 *    either case) are copied from the server's; HOME is the private one; and exactly these are
 *    set: `OLLAMA_HOST=127.0.0.1:<port>`, `OLLAMA_MODELS`, `OLLAMA_CONTEXT_LENGTH`,
 *    `OLLAMA_NO_CLOUD=1`, `OLLAMA_KEEP_ALIVE=10m`, `OLLAMA_NUM_PARALLEL=1`,
 *    `OLLAMA_MAX_LOADED_MODELS=1`. Nothing else gets through: no `CODEMAN_*` and none of the
 *    user's own `OLLAMA_*`.
 *  - PORT (`chooseRuntimePort()`). Chosen ONCE by binding, from `RUNTIME_PORT_FIRST` across
 *    `RUNTIME_PORT_SPAN`, then stored by the caller. Never searched again on a later start.
 *  - SUPERVISOR (`createRuntimeSupervisor()`). The runtime is a NON-detached child of the
 *    server. `start()` first looks at the port: a listener that answers `/api/version` and
 *    whose pid (`previousPid`) runs a binary under our runtime folder is our own orphan and is
 *    adopted or replaced; any other listener is the answer `port-in-use`. A child that exits by
 *    itself is restarted, at most `RUNTIME_MAX_RESTARTS` times in a row; `stop()` sends SIGTERM.
 *    The supervisor does not write the state file: it reports through `onChange`, and its
 *    caller stores the pid and the port.
 *  - BUDGET (`parseInferenceComputeTotal()`, pure). Right after it starts, the runtime prints
 *    the device total in its log line "inference compute" (`total="37.4 GiB"`). The supervisor
 *    reads the child's output for it and reports it as `measuredTotalBytes`.
 *  - REMOVAL (`removeLocalModelFiles()`). Deletes the runtime, the private home and, when
 *    asked, the models. Only inside `LocalModelPaths.root`.
 *
 * Under vitest nothing spawns and nothing is fetched unless a test injects it: the default
 * `spawn` and `fetch` of the dependency objects refuse there.
 */

import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { LocalModelErrorCode, LocalModelRuntimePin } from '../types.js';
import type { LocalModelPaths } from './paths.js';

/** Marks a body the contract stage left unwritten. */
function notImplemented(what: string, ..._args: unknown[]): never {
  throw new Error(`${what} is not implemented yet`);
}

// ---------- The pin and the constants ----------

/** The one runtime build Codeman downloads and runs. See the file header. */
export const OLLAMA_RUNTIME_PIN: LocalModelRuntimePin = Object.freeze({
  id: 'ollama',
  version: '0.40.15',
  url: 'https://github.com/ollama/ollama/releases/download/v0.40.15/ollama-darwin.tgz',
  bytes: 185_971_671,
  sha256: '607c79d5d6315ef9d896db83adde736a4c0057196329843544e79b95afb260a8',
  // Measured on a MacBook on 2026-11-06: the unpacked folder takes 579 MB.
  unpackedBytes: 579_000_000,
  minMacosMajor: 14,
});

/** The first loopback port tried for the runtime. Not 11434: that is the default of a runtime the user may run. */
export const RUNTIME_PORT_FIRST = 11435;
/** How many ports are tried from `RUNTIME_PORT_FIRST`. */
export const RUNTIME_PORT_SPAN = 20;
/** How often in a row a runtime that exited by itself is started again. */
export const RUNTIME_MAX_RESTARTS = 3;
/** How often a cut archive download is continued. */
export const RUNTIME_DOWNLOAD_RETRIES = 3;
/** `OLLAMA_KEEP_ALIVE`: how long the model stays loaded after the last request. */
export const RUNTIME_KEEP_ALIVE = '10m';

// ---------- Pure ----------

/**
 * The device total of the runtime's log line "inference compute", in bytes, or `undefined`
 * for any other line. The real line (a MacBook, 2026-11-06):
 *
 * `time=... level=INFO source=types.go:32 msg="inference compute" id=0 ... type=iGPU total="37.4 GiB" available="37.4 GiB"`
 *
 * reads 40,157,944,217 (37.4 x 1024^3, rounded down). The value is the quoted text after
 * ` total=`: a number and a binary unit (`KiB`, `MiB`, `GiB`, `TiB`). `total_vram=` of the
 * line "vram-based default context" is not read.
 */
export function parseInferenceComputeTotal(line: string): number | undefined {
  return notImplemented('parseInferenceComputeTotal', line);
}

/** What `runtimeEnv()` is built from. */
export interface RuntimeEnvInput {
  /** The server's environment. Only the allowlisted names are read from it. */
  source: NodeJS.ProcessEnv;
  /** The private HOME (`LocalModelPaths.homeDir`). */
  home: string;
  /** The model store (`LocalModelPaths.modelsDir`). */
  modelsDir: string;
  /** The loopback port. */
  port: number;
  /** The context length in tokens. */
  contextLength: number;
}

/** The environment of the runtime child: the allowlist of the file header, nothing more. Pure. */
export function runtimeEnv(input: RuntimeEnvInput): NodeJS.ProcessEnv {
  return notImplemented('runtimeEnv', input);
}

/**
 * Whether `command` (one line of `ps -o command= -p <pid>`) is a process whose binary lies
 * under `runtimeRoot` (`LocalModelPaths.runtimeRoot`): our own runtime, so an orphan of an
 * earlier server. Pure. `/private` in front of a path is the same path on macOS.
 */
export function isOwnRuntimeCommand(command: string, runtimeRoot: string): boolean {
  return notImplemented('isOwnRuntimeCommand', command, runtimeRoot);
}

// ---------- Download and unpack ----------

/** How far the archive download is. */
export interface RuntimeDownloadProgress {
  completedBytes: number;
  /** `pin.bytes`. */
  totalBytes: number;
}

/** What `ensureRuntimeInstalled()` calls. Each member defaults to the real thing; a test injects its own. */
export interface RuntimeInstallDeps {
  /** Fetches the archive. Must honour `signal` and a `Range` header. */
  fetch: typeof fetch;
  /** Unpacks `archive` into the existing empty folder `intoDir` (`/usr/bin/tar -xzf`). Rejects on a non-zero exit. */
  untar: (archive: string, intoDir: string, signal?: AbortSignal) => Promise<void>;
  /** Waits between retries. */
  sleep: (ms: number) => Promise<void>;
}

export interface RuntimeInstallOptions {
  /** Default `OLLAMA_RUNTIME_PIN`. A test passes a pin that points at its fake server. */
  pin?: LocalModelRuntimePin;
  /** Default `localModelPaths(pin.version)`. */
  paths?: LocalModelPaths;
  /** Aborts the download or the unpack. The partial archive stays for a later Range request. */
  signal?: AbortSignal;
  /** Called while the archive downloads, at most a few times a second. */
  onProgress?: (progress: RuntimeDownloadProgress) => void;
  deps?: Partial<RuntimeInstallDeps>;
}

/**
 * How getting the runtime ended. A failure carries the job's error code; `cancelled` is the
 * abort signal and is not an error.
 */
export type RuntimeInstallResult =
  | {
      ok: true;
      /** `LocalModelPaths.binary`. */
      binaryPath: string;
      /** True: the folder was already unpacked and nothing was downloaded. */
      alreadyInstalled: boolean;
    }
  | {
      ok: false;
      code: Extract<
        LocalModelErrorCode,
        'runtime-download-failed' | 'runtime-damaged' | 'runtime-unpack-failed' | 'disk-full'
      >;
      detail?: string;
    }
  | { ok: false; code: 'cancelled' };

/** Whether the pinned runtime is unpacked on disk (its binary exists). Never throws. */
export async function isRuntimeInstalled(pin?: LocalModelRuntimePin, paths?: LocalModelPaths): Promise<boolean> {
  return notImplemented('isRuntimeInstalled', pin, paths);
}

/**
 * Makes sure the pinned runtime is unpacked: nothing to do when it is, else download (with
 * Range resume), compare the hash, unpack, rename. Idempotent, so a resumed job calls it
 * again. Never throws: every outcome is a `RuntimeInstallResult`.
 */
export async function ensureRuntimeInstalled(options: RuntimeInstallOptions = {}): Promise<RuntimeInstallResult> {
  return notImplemented('ensureRuntimeInstalled', options);
}

/** What `removeLocalModelFiles()` deletes. */
export interface RemoveLocalModelFilesOptions {
  /** True: delete the model store too. False: the runtime, its archive and the private home only. */
  models: boolean;
  /** Default `localModelPaths(OLLAMA_RUNTIME_PIN.version)`. */
  paths?: LocalModelPaths;
}

/**
 * Deletes what this feature put on disk: every runtime folder and archive, the private home
 * and, when asked, the models. Refuses any path that is not inside `LocalModelPaths.root`,
 * follows no symlink out of it, and removes `root` itself only when it is empty afterwards.
 * The state file and the coding agent are not its business.
 */
export async function removeLocalModelFiles(options: RemoveLocalModelFilesOptions): Promise<void> {
  return notImplemented('removeLocalModelFiles', options);
}

// ---------- Port ----------

export interface ChooseRuntimePortOptions {
  /** Default `RUNTIME_PORT_FIRST`. */
  first?: number;
  /** Default `RUNTIME_PORT_SPAN`. */
  span?: number;
  /** Ports to skip: the one that is in use when the person asked for another. */
  avoid?: readonly number[];
  /** Whether nothing holds `port` on 127.0.0.1, decided by BINDING it. A test injects its own. */
  isFree?: (port: number) => Promise<boolean>;
}

/** The first free loopback port of the span, or `undefined` when none is free. Chosen once, then stored by the caller. */
export async function chooseRuntimePort(options: ChooseRuntimePortOptions = {}): Promise<number | undefined> {
  return notImplemented('chooseRuntimePort', options);
}

// ---------- Supervisor ----------

/** What the supervisor knows about the runtime right now. Plain data. */
export interface RuntimeStatus {
  /** The child Codeman started (or adopted) is alive and answered `/api/version`. */
  running: boolean;
  pid?: number;
  port?: number;
  /** The context length the running child was started with. */
  contextLength?: number;
  /** The device total parsed from the child's log, in bytes. Absent for an adopted orphan (its log is not ours to read). */
  measuredTotalBytes?: number;
  /** How often the child was restarted since the last `start()`. */
  restarts: number;
  /** True: the child exited `RUNTIME_MAX_RESTARTS` times in a row and is no longer restarted (`runtime-stopped`). */
  gaveUp: boolean;
}

export interface RuntimeStartOptions {
  /** The stored port. */
  port: number;
  /** The context length in tokens (`OLLAMA_CONTEXT_LENGTH`). A running child with another value is replaced. */
  contextLength: number;
  /** The pid the state file holds from an earlier server: decides whether a listener on `port` is our own orphan. */
  previousPid?: number;
}

/** How a `start()` ended. */
export type RuntimeStartResult =
  | {
      ok: true;
      pid: number;
      port: number;
      /** What happened to a listener that was already on the port: there was none, or it was ours. */
      orphan: 'none' | 'adopted' | 'replaced';
      /** The device total, when the log line was read before `start()` returned. */
      measuredTotalBytes?: number;
    }
  | {
      ok: false;
      /** `port-in-use`: a listener that is not ours. `runtime-start-failed`: no answer in time, or the child exited. */
      code: Extract<LocalModelErrorCode, 'port-in-use' | 'runtime-start-failed'>;
      detail?: string;
    };

/** What the supervisor calls. Each member defaults to the real thing; a test injects its own. */
export interface RuntimeSupervisorDeps {
  /** Starts the child. The default refuses under vitest. */
  spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
  /** Asks the runtime for `/api/version`. */
  fetch: typeof fetch;
  /** The server's environment, the `source` of `runtimeEnv()`. */
  env: NodeJS.ProcessEnv;
  /** `ps -o command= -p <pid>`, bounded. `undefined` when the pid is gone. */
  commandOfPid: (pid: number) => Promise<string | undefined>;
  /** Signals a pid that is not our child (an orphan). */
  kill: (pid: number, signal: NodeJS.Signals) => void;
  /** Whether nothing holds `port` on 127.0.0.1, decided by binding it. */
  isPortFree: (port: number) => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  /** Default `OLLAMA_RUNTIME_PIN`. */
  pin: LocalModelRuntimePin;
  /** Default `localModelPaths(pin.version)`. */
  paths: LocalModelPaths;
  /** Called after every change of `status()`: a start, an exit, a restart, the budget line. The caller stores pid and port. */
  onChange: (status: RuntimeStatus) => void;
}

/** The one supervisor of the runtime child. */
export interface RuntimeSupervisor {
  /**
   * Makes sure the runtime runs on `port` with `contextLength`. Idempotent: a child that
   * already runs with both is kept. Resolves once `/api/version` answers the pinned version
   * and the budget line was read (or a few seconds passed without it). Never throws.
   */
  start(options: RuntimeStartOptions): Promise<RuntimeStartResult>;
  /** SIGTERM to the child, SIGKILL after a grace period. Resolves once it is gone. Safe to call when nothing runs. */
  stop(): Promise<void>;
  status(): RuntimeStatus;
}

/** A supervisor. The server keeps ONE (see `getLocalModelService()` in install-job.ts). */
export function createRuntimeSupervisor(deps: Partial<RuntimeSupervisorDeps> = {}): RuntimeSupervisor {
  return notImplemented('createRuntimeSupervisor', deps);
}
