/**
 * @fileoverview The model runtime: which build Codeman runs, how it gets onto the disk, and
 * how it is kept running.
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
 *    `OLLAMA_MAX_LOADED_MODELS=1`, and the four memory settings of the llama.cpp runner (see
 *    MEMORY below). Nothing else gets through: no `CODEMAN_*` and none of the user's own
 *    `OLLAMA_*` or `LLAMA_ARG_*`.
 *  - MEMORY (what the catalogue's figures for its `llamacpp` rows assume, so change both
 *    together: test/local-model-catalog.test.ts holds them to each other). Read in the
 *    runtime's v0.40.15 source, not yet measured on a Mac:
 *     - `OLLAMA_KV_CACHE_TYPE=q8_0` becomes `--cache-type-k q8_0 --cache-type-v q8_0` of
 *       llama-server (llm/llama_server.go): the K/V cache takes 34 bytes per 32 values, 17/32
 *       of f16. The runtime's FAQ calls the quality loss "very small". Never q4_0: its loss
 *       grows with the context, and a coding agent works at long contexts.
 *     - `OLLAMA_FLASH_ATTENTION=1` becomes `--flash-attn on`. A quantized V cache needs flash
 *       attention, and left unset the runtime passes `auto`, or `off` where it thinks the GPU
 *       cannot, which would make every load with a q8_0 cache fail.
 *     - `LLAMA_ARG_CACHE_RAM=1024` bounds llama-server's host prompt cache (the copies of
 *       earlier prompts it keeps in memory) to 1024 MiB. The runtime passes no `--cache-ram`
 *       for a coding model, and llama-server reads the variable from the environment it
 *       inherits (`cmd.Env = os.Environ()`). Unbounded, that cache can grow by gigabytes in a
 *       session; 1024 MiB is counted in every `llamacpp` row's `overheadBytes`.
 *     - `LLAMA_ARG_CTX_CHECKPOINTS=8` bounds the context checkpoints llama-server keeps per
 *       slot (`--ctx-checkpoints`, read from the environment the same way). The llama.cpp the
 *       runtime bundles (b12111, the runtime's LLAMA_CPP_VERSION) makes them for every model
 *       of the catalogue's `llamacpp` rows: a checkpoint is a host copy of the state that
 *       cannot be rolled back (the recurrent state of the linear-attention layers, or the
 *       sliding-window cache), two or three per request, and llama-server keeps up to 32 by
 *       default. 32 copies of the 27B's 157 MB state are 5 GB, most of which an agent never
 *       uses: its next request restores the newest checkpoint of the previous one. 8
 *       (llama.cpp's own default from b6800 to b8200; it became 32 at b8250, together with a
 *       checkpoint every 8,192 tokens of a long prompt) keeps the last few requests. The cost:
 *       a prompt that differs from the last checkpoints further back (a compaction, a cleared
 *       old tool result) is processed again from the newest checkpoint before that point, or
 *       from its start. 8 checkpoints are counted in every `llamacpp` row's `overheadBytes`.
 *    The MLX runner reads none of the four (nothing under mlxrunner/ does): an `mlx` row's
 *    figures do not depend on them.
 *  - PORT (`chooseRuntimePort()`). Chosen ONCE by binding, from `RUNTIME_PORT_FIRST` across
 *    `RUNTIME_PORT_SPAN`, then stored by the caller. Never searched again on a later start.
 *  - SUPERVISOR (`createRuntimeSupervisor()`). The runtime is a NON-detached child of the
 *    server. `start()` first looks at the port: a listener that answers `/api/version` and
 *    whose pid (`previousPid`) runs a binary under our runtime folder is our own orphan and is
 *    adopted or replaced; any other listener is the answer `port-in-use`. An orphan is ADOPTED
 *    only when keeping it keeps something: it answers the pinned version and has a model loaded
 *    at the wanted context. Otherwise it is REPLACED (SIGTERM, then a child of our own), which
 *    loses nothing and gives back what an orphan cannot: its log, so the measured budget, and
 *    its exit. A child that exits by itself is restarted, at most `RUNTIME_MAX_RESTARTS` times
 *    since the last `start()`; `stop()` sends SIGTERM. The supervisor does not write the state
 *    file: it reports through `onChange`, and its caller stores the pid and the port. The pid
 *    is reported the moment the child is SPAWNED, before it answers, so a server that is
 *    killed during a start still leaves a pid that names the runtime as ours. `stop()` takes
 *    that stored pid too (`previousPid`): a runtime an earlier server left behind is ended the
 *    same way, when its command line is a binary under our runtime folder. `start()` runs the
 *    pinned version, or with `version` another one that is unpacked beside it (the version an
 *    installed model was installed with).
 *  - BUDGET (`parseInferenceComputeTotal()`, pure). Right after it starts, the runtime prints
 *    the device total in its log line "inference compute" (`total="37.4 GiB"`). The supervisor
 *    reads the child's output for it and reports it as `measuredTotalBytes`.
 *  - REMOVAL (`removeLocalModelFiles()`). Deletes the runtime, the private home and, when
 *    asked, the models. Only inside `LocalModelPaths.root`, and never through a `root` that
 *    is itself a symbolic link. `removePartialModelBlobs()` deletes what an interrupted
 *    download left in the model store.
 *
 * Under vitest nothing spawns and nothing is fetched unless a test injects it: the default
 * `spawn` and `fetch` of the dependency objects refuse there, the default `commandOfPid`
 * knows no pid and the default `kill` signals nothing.
 */

import { execFile, spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createHash, type Hash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm, rmdir, stat, unlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, resolve as resolvePath } from 'node:path';
import type { LocalModelErrorCode, LocalModelRuntimePin } from '../types.js';
import { getRuntimeVersion, listRunning } from './ollama-client.js';
import { isInsideLocalModelRoot, localModelPaths, runtimeBinaryForVersion, type LocalModelPaths } from './paths.js';

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
/** `OLLAMA_KV_CACHE_TYPE`: the K/V cache type of the llama.cpp runner. The catalogue's `llamacpp` rows are computed for it. */
export const RUNTIME_KV_CACHE_TYPE = 'q8_0';
/** `LLAMA_ARG_CACHE_RAM`, in MiB: the bound of llama-server's host prompt cache. Counted in every `llamacpp` row's overhead. */
export const RUNTIME_HOST_PROMPT_CACHE_MIB = 1024;
/** `LLAMA_ARG_CTX_CHECKPOINTS`: the context checkpoints llama-server keeps per slot. Counted in every `llamacpp` row's overhead. */
export const RUNTIME_CTX_CHECKPOINTS = 8;

/** The name of the runtime's binary inside its folder and inside the archive. */
const RUNTIME_BINARY_NAME = 'ollama';
/** A download that delivers no byte for this long is treated as cut. */
const DOWNLOAD_IDLE_TIMEOUT_MS = 60_000;
/** The first wait before a cut download is continued; it doubles with every retry. */
const DOWNLOAD_RETRY_DELAY_MS = 500;
/** The least time between two progress reports of the download. */
const DOWNLOAD_PROGRESS_INTERVAL_MS = 200;
/** How long `/usr/bin/tar` may take for the 579 MB of the runtime. */
const UNTAR_TIMEOUT_MS = 180_000;
/** How long a started runtime has to answer `/api/version`. The first start on the test Mac took a few seconds. */
const START_TIMEOUT_MS = 30_000;
/** The wait between two `/api/version` requests while the runtime starts. */
const START_POLL_MS = 150;
/** How long `start()` waits for the budget line once the runtime answers. It is printed within a second. */
const BUDGET_WAIT_MS = 3_000;
/** How long a runtime gets to exit after SIGTERM before it is sent SIGKILL. */
const STOP_GRACE_MS = 5_000;
/** How long the exit is awaited after SIGKILL. */
const STOP_KILL_WAIT_MS = 2_000;
/** The wait before a runtime that exited by itself is started again. */
const RESTART_DELAY_MS = 1_000;
/** How often an adopted orphan is looked at: it is not our child, so its exit is not an event. */
const ORPHAN_POLL_MS = 5_000;
/** How long `ps` may take. */
const PS_TIMEOUT_MS = 2_000;
/** How many of the runtime's last log lines are kept for the detail of a failed start. */
const LOG_TAIL_LINES = 12;
/** A log line longer than this is cut: the runtime logs request bodies in some modes. */
const LOG_LINE_MAX_CHARS = 2_000;
/** How much of a failure text is kept as `detail`. */
const MAX_DETAIL_CHARS = 600;

const UNDER_VITEST = Boolean(process.env.VITEST);

/** A default dependency that refuses under vitest: a test must inject its own. */
class NotInjectedError extends Error {
  constructor(what: string) {
    super(`${what} is not available under vitest: the test must inject its own`);
    this.name = 'NotInjectedError';
  }
}

// ---------- Small helpers ----------

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_DETAIL_CHARS ? `${trimmed.slice(0, MAX_DETAIL_CHARS)}...` : trimmed;
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    // undici wraps the reason ("fetch failed") and keeps the useful part in `cause`.
    const cause = (err as { cause?: unknown }).cause;
    return clip(cause instanceof Error && cause.message ? `${err.message}: ${cause.message}` : err.message);
  }
  return clip(String(err));
}

function errnoOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' ? code : undefined;
}

function isDiskFull(err: unknown): boolean {
  const code = errnoOf(err);
  return code === 'ENOSPC' || code === 'EDQUOT' || /no space left on device/i.test(errorText(err));
}

/** A wait on the real clock that does not keep the process alive. For grace periods, which an injected `sleep` must not shorten. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The size of a file, 0 when it is not there. */
async function fileSize(path: string): Promise<number> {
  try {
    const info = await stat(path);
    return info.isFile() ? info.size : 0;
  } catch {
    return 0;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

// ---------- Pure ----------

const BINARY_UNIT_BYTES: Record<string, number> = {
  B: 1,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
};

/**
 * The device total of the runtime's log line "inference compute", in bytes, or `undefined`
 * for any other line. The real line (a MacBook, 2026-11-06):
 *
 * `time=... level=INFO source=types.go:32 msg="inference compute" id=0 ... type=iGPU total="37.4 GiB" available="37.4 GiB"`
 *
 * reads 40,157,944,217 (37.4 x 1024^3, rounded down). The value is the quoted text after
 * ` total=`: a number and a binary unit (`B`, `KiB`, `MiB`, `GiB`, `TiB`). `total_vram=` of the
 * line "vram-based default context" is not read.
 */
export function parseInferenceComputeTotal(line: string): number | undefined {
  if (!line.includes('msg="inference compute"')) return undefined;
  // The key must stand alone: `total_vram=` and `subtotal=` are other keys.
  const match = /(?:^|\s)total="(\d+(?:\.\d+)?) ?(B|KiB|MiB|GiB|TiB)"/.exec(line);
  if (!match) return undefined;
  const bytes = Math.floor(Number(match[1]) * BINARY_UNIT_BYTES[match[2]]);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : undefined;
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

/** The names copied from the server's environment when they are set. Everything else stays behind. */
const RUNTIME_ENV_COPIED = [
  'PATH',
  'TMPDIR',
  'LANG',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
] as const;

/** The environment of the runtime child: the allowlist of the file header, nothing more. Pure. */
export function runtimeEnv(input: RuntimeEnvInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of RUNTIME_ENV_COPIED) {
    const value = input.source[name];
    if (typeof value === 'string' && value !== '') env[name] = value;
  }
  env.HOME = input.home;
  env.OLLAMA_HOST = `127.0.0.1:${input.port}`;
  env.OLLAMA_MODELS = input.modelsDir;
  env.OLLAMA_CONTEXT_LENGTH = String(input.contextLength);
  env.OLLAMA_NO_CLOUD = '1';
  env.OLLAMA_KEEP_ALIVE = RUNTIME_KEEP_ALIVE;
  env.OLLAMA_NUM_PARALLEL = '1';
  env.OLLAMA_MAX_LOADED_MODELS = '1';
  // The memory settings of the llama.cpp runner (file header, MEMORY). Inert for an MLX model.
  env.OLLAMA_KV_CACHE_TYPE = RUNTIME_KV_CACHE_TYPE;
  env.OLLAMA_FLASH_ATTENTION = '1';
  env.LLAMA_ARG_CACHE_RAM = String(RUNTIME_HOST_PROMPT_CACHE_MIB);
  env.LLAMA_ARG_CTX_CHECKPOINTS = String(RUNTIME_CTX_CHECKPOINTS);
  return env;
}

/** A path without the `/private` macOS puts in front of `/var`, `/tmp` and `/etc`. */
function withoutPrivatePrefix(path: string): string {
  return path.startsWith('/private/') ? path.slice('/private'.length) : path;
}

/**
 * Whether `command` (one line of `ps -o command= -p <pid>`) is a process whose binary lies
 * under `runtimeRoot` (`LocalModelPaths.runtimeRoot`): our own runtime, so an orphan of an
 * earlier server. Pure. `/private` in front of a path is the same path on macOS.
 *
 * It tells our orphan from a runtime the user started, so that only ours is ever signalled.
 * It is not a defence against another program of the same account, which can name itself
 * anything.
 */
export function isOwnRuntimeCommand(command: string, runtimeRoot: string): boolean {
  const root = withoutPrivatePrefix(runtimeRoot.trim()).replace(/\/+$/, '');
  if (!root.startsWith('/') || root === '') return false;
  const text = withoutPrivatePrefix(command.trimStart());
  if (!text.startsWith(`${root}/`)) return false;
  // A `..` segment could lead out of the folder again.
  return !/(?:^|\/)\.\.(?:\/|\s|$)/.test(text);
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
  /** How long the download may deliver nothing before it counts as cut. Default one minute. */
  idleTimeoutMs?: number;
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

/** A failure of `ensureRuntimeInstalled()`, without the success arm. */
type RuntimeInstallFailure = Exclude<RuntimeInstallResult, { ok: true }>;

const CANCELLED: RuntimeInstallFailure = { ok: false, code: 'cancelled' };

/** The default `fetch` of the download: the global one, refused under vitest. */
const defaultFetch: typeof fetch = (input, init) => {
  if (UNDER_VITEST) return Promise.reject(new NotInjectedError('fetch'));
  return fetch(input, init);
};

/** The default `untar`: `/usr/bin/tar -xzf <archive> -C <intoDir>`, bounded. */
function untarWithSystemTar(archive: string, intoDir: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      '/usr/bin/tar',
      ['-xzf', archive, '-C', intoDir],
      { timeout: UNTAR_TIMEOUT_MS, ...(signal ? { signal } : {}) },
      (err, _stdout, stderr) => {
        if (!err) return resolve();
        const said = typeof stderr === 'string' && stderr.trim() !== '' ? stderr : err.message;
        reject(new Error(clip(said)));
      }
    );
  });
}

/** Whether the pinned runtime is unpacked on disk (its binary exists). Never throws. */
export async function isRuntimeInstalled(pin?: LocalModelRuntimePin, paths?: LocalModelPaths): Promise<boolean> {
  try {
    const resolved = paths ?? localModelPaths((pin ?? OLLAMA_RUNTIME_PIN).version);
    return await isFile(resolved.binary);
  } catch {
    return false;
  }
}

/** Feeds a file on disk into `hash`: the part of the archive an earlier run left behind. */
async function hashFile(path: string, hash: Hash, signal?: AbortSignal): Promise<void> {
  for await (const chunk of createReadStream(path, signal ? { signal } : {})) {
    hash.update(chunk as Buffer);
  }
}

/** How one request for the archive ended. `detail` says why it must be asked again. */
type DownloadAttempt =
  | { kind: 'ended'; detail?: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; result: RuntimeInstallFailure };

/**
 * Downloads the pinned archive to `paths.archivePartial` and proves its hash. On success the
 * file is complete and verified; nothing was unpacked. Never throws.
 */
async function downloadArchive(
  pin: LocalModelRuntimePin,
  paths: LocalModelPaths,
  deps: RuntimeInstallDeps,
  options: RuntimeInstallOptions
): Promise<{ ok: true } | RuntimeInstallFailure> {
  const { signal, onProgress } = options;
  const idleTimeoutMs = options.idleTimeoutMs ?? DOWNLOAD_IDLE_TIMEOUT_MS;
  const partial = paths.archivePartial;

  // What an earlier run left: continue after it. More than the whole archive cannot be it.
  let offset = await fileSize(partial);
  if (offset > pin.bytes) {
    await rm(partial, { force: true });
    offset = 0;
  }
  let hash = createHash('sha256');
  if (offset > 0) await hashFile(partial, hash, signal);

  let lastReport = Number.NEGATIVE_INFINITY;
  const report = (force: boolean): void => {
    if (!onProgress) return;
    const at = Date.now();
    if (!force && at - lastReport < DOWNLOAD_PROGRESS_INTERVAL_MS) return;
    lastReport = at;
    try {
      onProgress({ completedBytes: offset, totalBytes: pin.bytes });
    } catch {
      // A display that fails must not fail the download.
    }
  };

  /** One request, written to the file as far as it gets. */
  const attempt = async (): Promise<DownloadAttempt> => {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    let idle: NodeJS.Timeout | undefined;
    let wentIdle = false;
    const armIdle = (): void => {
      clearTimeout(idle);
      idle = setTimeout(() => {
        wentIdle = true;
        controller.abort();
      }, idleTimeoutMs);
    };
    // Opened BEFORE the request, in append mode: once the answer is there, nothing is awaited
    // until its body is being read. A body that is cut while nobody reads it loses what had
    // arrived, and the continuation would start further back than it has to.
    const file = await open(partial, 'a', 0o600);
    // The file is deleted after it is closed: a download that cannot be the pinned archive.
    let unlinkAfter = false;
    const startOver = async (): Promise<void> => {
      await file.truncate(0);
      offset = 0;
      hash = createHash('sha256');
    };
    const damaged = (detail: string): DownloadAttempt => {
      unlinkAfter = true;
      return { kind: 'failed', result: { ok: false, code: 'runtime-damaged', detail } };
    };
    try {
      armIdle();
      let res: Response;
      try {
        res = await deps.fetch(pin.url, {
          ...(offset > 0 ? { headers: { range: `bytes=${offset}-` } } : {}),
          signal: controller.signal,
          redirect: 'follow',
        });
      } catch (err) {
        if (signal?.aborted) return { kind: 'cancelled' };
        if (err instanceof NotInjectedError) {
          return { kind: 'failed', result: { ok: false, code: 'runtime-download-failed', detail: err.message } };
        }
        return { kind: 'ended', detail: wentIdle ? 'The download server did not answer' : errorText(err) };
      }

      const discard = async (): Promise<void> => {
        await res.body?.cancel().catch(() => undefined);
      };
      // The size the server says the whole archive has, when it says one.
      let declaredTotal: number | undefined;
      // The whole archive from its first byte although a range was asked for: the file starts over.
      let restart = false;
      if (res.status === 206) {
        const range = /^bytes (\d+)-\d+\/(\d+)$/.exec(res.headers.get('content-range') ?? '');
        // A 206 that does not start where the file ends cannot be appended to it.
        if (!range || Number(range[1]) !== offset) {
          await discard();
          await startOver();
          return { kind: 'ended', detail: 'The server answered another range than the one asked for' };
        }
        declaredTotal = Number(range[2]);
      } else if (res.status === 200) {
        restart = offset > 0;
        const length = res.headers.get('content-length');
        if (length !== null && !res.headers.get('content-encoding') && /^\d+$/.test(length)) {
          declaredTotal = Number(length);
        }
      } else if (res.status === 416) {
        // The file on disk is not a prefix of what the server has.
        await discard();
        await startOver();
        return { kind: 'ended', detail: 'The server refused the range (HTTP 416)' };
      } else {
        await discard();
        return { kind: 'ended', detail: `The download server answered HTTP ${res.status}` };
      }
      if (declaredTotal !== undefined && declaredTotal !== pin.bytes) {
        await discard();
        return damaged(`The download is ${declaredTotal} bytes, the pinned archive has ${pin.bytes}`);
      }
      if (!res.body) return { kind: 'ended', detail: 'The download server sent no body' };

      try {
        if (restart) await startOver();
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          armIdle();
          // Refused before a byte of it is written: a longer body can never have the pinned hash.
          if (offset + chunk.length > pin.bytes) {
            return damaged(`The download is longer than the ${pin.bytes} bytes of the pinned archive`);
          }
          await file.appendFile(chunk);
          hash.update(chunk);
          offset += chunk.length;
          report(false);
        }
      } catch (err) {
        // Whatever was written past the last hashed byte is cut off, so file and hash agree.
        await file.truncate(offset).catch(() => undefined);
        if (signal?.aborted) return { kind: 'cancelled' };
        if (isDiskFull(err)) {
          return { kind: 'failed', result: { ok: false, code: 'disk-full', detail: errorText(err) } };
        }
        return {
          kind: 'ended',
          detail: wentIdle
            ? `The download delivered nothing for ${Math.max(1, Math.round(idleTimeoutMs / 1000))} s`
            : errorText(err),
        };
      }
      return { kind: 'ended' };
    } finally {
      clearTimeout(idle);
      signal?.removeEventListener('abort', onAbort);
      await file.close().catch(() => undefined);
      // An empty file is no start of a download either.
      if (unlinkAfter || offset === 0) await rm(partial, { force: true }).catch(() => undefined);
    }
  };

  // A download that continues says at once how far it already is.
  if (offset > 0) report(true);
  let failures = 0;
  while (offset < pin.bytes) {
    if (signal?.aborted) return CANCELLED;
    const outcome = await attempt();
    report(true);
    if (outcome.kind === 'cancelled') return CANCELLED;
    if (outcome.kind === 'failed') return outcome.result;
    if (offset >= pin.bytes) break;
    // Cut, or ended early: continue from where the file ends, a bounded number of times.
    failures += 1;
    if (failures > RUNTIME_DOWNLOAD_RETRIES) {
      return {
        ok: false,
        code: 'runtime-download-failed',
        detail: outcome.detail ?? `The download ended at ${offset} of ${pin.bytes} bytes`,
      };
    }
    await deps.sleep(DOWNLOAD_RETRY_DELAY_MS * 2 ** (failures - 1));
  }
  if (signal?.aborted) return CANCELLED;

  // The proof, BEFORE anything is unpacked.
  const digest = hash.digest('hex');
  if (digest !== pin.sha256.toLowerCase()) {
    await rm(partial, { force: true });
    return {
      ok: false,
      code: 'runtime-damaged',
      detail: `The sha256 of the download is ${digest}, the pinned archive has ${pin.sha256}`,
    };
  }
  return { ok: true };
}

/**
 * Unpacks the verified archive into the temporary folder and renames it to the runtime folder.
 * Never throws.
 */
async function unpackArchive(
  paths: LocalModelPaths,
  deps: RuntimeInstallDeps,
  signal?: AbortSignal
): Promise<{ ok: true } | RuntimeInstallFailure> {
  const fail = async (err: unknown): Promise<RuntimeInstallFailure> => {
    await rm(paths.unpackDir, { recursive: true, force: true }).catch(() => undefined);
    if (signal?.aborted) return CANCELLED;
    return { ok: false, code: isDiskFull(err) ? 'disk-full' : 'runtime-unpack-failed', detail: errorText(err) };
  };
  try {
    await rm(paths.unpackDir, { recursive: true, force: true });
    await mkdir(paths.unpackDir, { recursive: true, mode: 0o700 });
    await deps.untar(paths.archivePartial, paths.unpackDir, signal);
    if (signal?.aborted) return await fail(new Error('aborted'));
    if (!(await isFile(join(paths.unpackDir, RUNTIME_BINARY_NAME)))) {
      return await fail(new Error(`The archive holds no ${RUNTIME_BINARY_NAME} binary`));
    }
    // A folder without its binary is a leftover of an unpack that was interrupted.
    await rm(paths.runtimeDir, { recursive: true, force: true });
    await rename(paths.unpackDir, paths.runtimeDir);
    await rm(paths.archivePartial, { force: true });
    return { ok: true };
  } catch (err) {
    return fail(err);
  }
}

/**
 * Makes sure the pinned runtime is unpacked: nothing to do when it is, else download (with
 * Range resume), compare the hash, unpack, rename. Idempotent, so a resumed job calls it
 * again. Never throws: every outcome is a `RuntimeInstallResult`.
 */
export async function ensureRuntimeInstalled(options: RuntimeInstallOptions = {}): Promise<RuntimeInstallResult> {
  let phase: 'download' | 'unpack' = 'download';
  try {
    const pin = options.pin ?? OLLAMA_RUNTIME_PIN;
    const paths = options.paths ?? localModelPaths(pin.version);
    const deps: RuntimeInstallDeps = {
      fetch: options.deps?.fetch ?? defaultFetch,
      untar: options.deps?.untar ?? untarWithSystemTar,
      sleep: options.deps?.sleep ?? realSleep,
    };
    if (await isFile(paths.binary)) return { ok: true, binaryPath: paths.binary, alreadyInstalled: true };
    if (options.signal?.aborted) return CANCELLED;

    await mkdir(paths.runtimeRoot, { recursive: true, mode: 0o700 });
    const downloaded = await downloadArchive(pin, paths, deps, options);
    if (!downloaded.ok) return downloaded;

    phase = 'unpack';
    const unpacked = await unpackArchive(paths, deps, options.signal);
    if (!unpacked.ok) return unpacked;
    return { ok: true, binaryPath: paths.binary, alreadyInstalled: false };
  } catch (err) {
    if (options.signal?.aborted) return CANCELLED;
    if (isDiskFull(err)) return { ok: false, code: 'disk-full', detail: errorText(err) };
    return {
      ok: false,
      code: phase === 'download' ? 'runtime-download-failed' : 'runtime-unpack-failed',
      detail: errorText(err),
    };
  }
}

/** What `removeLocalModelFiles()` deletes. */
export interface RemoveLocalModelFilesOptions {
  /** True: delete the model store too. False: the runtime, its archive and the private home only. */
  models: boolean;
  /** Default `localModelPaths(OLLAMA_RUNTIME_PIN.version)`. */
  paths?: LocalModelPaths;
}

/** What is to be done with one folder of the local model: nothing, unlink the link in its place, or delete its tree. */
type RemovalStep = { target: string; how: 'absent' | 'unlink' | 'delete' };

/**
 * Decides what removing `target` means, and refuses what must not be removed. A symlink in the
 * place of a folder is unlinked and never followed; a real folder is deleted only when its
 * real path is still inside the real root. Nothing is deleted here.
 */
async function planRemoval(target: string, root: string): Promise<RemovalStep> {
  if (!isInsideLocalModelRoot(target, root) || resolvePath(target) === resolvePath(root)) {
    throw new Error(`Refusing to delete ${target}: it is not a folder inside ${root}`);
  }
  let info;
  try {
    info = await lstat(target);
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return { target, how: 'absent' };
    throw err;
  }
  // The link goes, what it points at stays: that is somebody else's folder.
  if (info.isSymbolicLink()) return { target, how: 'unlink' };
  const [realTarget, realRoot] = await Promise.all([realpath(target), realpath(root)]);
  if (!isInsideLocalModelRoot(realTarget, realRoot) || realTarget === realRoot) {
    throw new Error(`Refusing to delete ${target}: it resolves to ${realTarget}, outside ${realRoot}`);
  }
  return { target, how: 'delete' };
}

/**
 * Whether `root` may be deleted in: it is absent (nothing to do) or a real folder. A `root`
 * that is itself a symbolic link is REFUSED: every check below compares against the real
 * path of the root, so a link in its place would make whatever it points at pass as ours.
 */
async function rootIsDeletable(root: string): Promise<'absent' | 'folder'> {
  let info;
  try {
    info = await lstat(root);
  } catch (err) {
    if (errnoOf(err) === 'ENOENT') return 'absent';
    throw err;
  }
  if (info.isSymbolicLink()) {
    throw new Error(`Refusing to delete in ${root}: it is a symbolic link, not the folder Codeman made`);
  }
  if (!info.isDirectory()) throw new Error(`Refusing to delete in ${root}: it is not a folder`);
  return 'folder';
}

/**
 * Deletes what this feature put on disk: every runtime folder and archive, the private home
 * and, when asked, the models. Refuses any path that is not inside `LocalModelPaths.root`,
 * refuses a `root` that is a symbolic link, follows no symlink out of it, and removes `root`
 * itself only when it is empty afterwards. Every folder is judged BEFORE the first one is
 * deleted, so a refusal deletes nothing. The state file and the coding agent are not its
 * business.
 */
export async function removeLocalModelFiles(options: RemoveLocalModelFilesOptions): Promise<void> {
  const paths = options.paths ?? localModelPaths(OLLAMA_RUNTIME_PIN.version);
  if ((await rootIsDeletable(paths.root)) === 'absent') return;
  const targets = [paths.runtimeRoot, paths.homeDir, ...(options.models ? [paths.modelsDir] : [])];
  const plan: RemovalStep[] = [];
  for (const target of targets) plan.push(await planRemoval(target, paths.root));
  for (const step of plan) {
    if (step.how === 'unlink') await unlink(step.target);
    // `rm` removes a symlink it meets inside the tree, never the tree behind it.
    if (step.how === 'delete') await rm(step.target, { recursive: true, force: true });
  }
  // Empty now (the models went too, or there never were any): the folder itself goes.
  await rmdir(paths.root).catch(() => undefined);
}

/** The marker the runtime puts into the name of a blob it has not finished downloading. */
const PARTIAL_BLOB_MARK = '-partial';

/**
 * Deletes what an interrupted download left in the model store: the files directly in
 * `<models>/blobs` whose name carries the runtime's partial marker (`sha256-<hex>-partial`
 * and its numbered parts). A model the runtime has no manifest for cannot be deleted through
 * the runtime (it answers "not found" and touches no blob), so its partial blobs are removed
 * here. Call it only while NO download is in flight: every partial file is then a dead one.
 *
 * Only regular files, only that one folder, only inside `LocalModelPaths.root`; a `root`, a
 * model store or a blob folder that is a symbolic link is left alone. Resolves with the bytes
 * that were freed. Never throws: a file that cannot be deleted stays for Remove.
 */
export async function removePartialModelBlobs(paths?: LocalModelPaths): Promise<number> {
  let freed = 0;
  try {
    const resolved = paths ?? localModelPaths(OLLAMA_RUNTIME_PIN.version);
    const blobs = join(resolved.modelsDir, 'blobs');
    if (!isInsideLocalModelRoot(blobs, resolved.root)) return 0;
    for (const folder of [resolved.root, resolved.modelsDir, blobs]) {
      const info = await lstat(folder);
      if (info.isSymbolicLink() || !info.isDirectory()) return 0;
    }
    for (const name of await readdir(blobs)) {
      if (!name.includes(PARTIAL_BLOB_MARK)) continue;
      const file = join(blobs, name);
      try {
        const info = await lstat(file);
        if (!info.isFile()) continue;
        await unlink(file);
        freed += info.size;
      } catch {
        // Gone already, or not ours to delete: Remove with the models takes the rest.
      }
    }
  } catch {
    // No model store yet: nothing was left behind.
  }
  return freed;
}

/** How many files of the blob folder are counted at most: a store holds a few dozen, and a walk must end. */
const STORE_MEASURE_MAX_FILES = 20_000;

/**
 * What the model store takes on disk: the sizes of the regular files directly in
 * `<models>/blobs`, summed. That folder is flat (one file per layer, plus the partial files of
 * a download), so this is the store's real disk use, shared layers counted once, an
 * interrupted download included. The manifests beside it are a few kilobytes and are left out.
 *
 * One `readdir` and one `lstat` per file, at most `STORE_MEASURE_MAX_FILES` of them. Nothing is
 * followed: a `root`, a model store or a blob folder that is a symbolic link counts as empty,
 * and so does a link in the place of a file. Never outside `LocalModelPaths.root`. Resolves 0
 * when there is no store. Never throws.
 */
export async function measureModelStore(paths?: LocalModelPaths): Promise<number> {
  let total = 0;
  try {
    const resolved = paths ?? localModelPaths(OLLAMA_RUNTIME_PIN.version);
    const blobs = join(resolved.modelsDir, 'blobs');
    if (!isInsideLocalModelRoot(blobs, resolved.root)) return 0;
    for (const folder of [resolved.root, resolved.modelsDir, blobs]) {
      const info = await lstat(folder);
      if (info.isSymbolicLink() || !info.isDirectory()) return 0;
    }
    const names = await readdir(blobs);
    for (const name of names.slice(0, STORE_MEASURE_MAX_FILES)) {
      try {
        const info = await lstat(join(blobs, name));
        if (info.isFile()) total += info.size;
      } catch {
        // Gone between the listing and the look: a download or a delete is under way.
      }
    }
  } catch {
    // No model store yet.
  }
  return total;
}

// ---------- Port ----------

/** Whether nothing holds `port` on 127.0.0.1, decided by binding it and letting go again. */
export function isLoopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return resolve(false);
    const probe = createServer();
    probe.unref();
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(true));
    });
  });
}

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
  const first = options.first ?? RUNTIME_PORT_FIRST;
  const span = options.span ?? RUNTIME_PORT_SPAN;
  const isFree = options.isFree ?? isLoopbackPortFree;
  const avoid = new Set(options.avoid ?? []);
  for (let port = first; port < first + span; port++) {
    if (avoid.has(port)) continue;
    try {
      if (await isFree(port)) return port;
    } catch {
      // A probe that fails says nothing about the port: it is not taken as free.
    }
  }
  return undefined;
}

// ---------- Supervisor ----------

/** What the supervisor knows about the runtime right now. Plain data. */
export interface RuntimeStatus {
  /** The child Codeman started (or adopted) is alive and answered `/api/version`. */
  running: boolean;
  /**
   * The pid of the child. Present from the moment it is SPAWNED, so also while `running` is
   * still false: the caller stores it at once, and a server killed during a start leaves a
   * pid that names the runtime as ours.
   */
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
  /**
   * Another unpacked runtime version than the pinned one: the version an installed model was
   * installed with. Its binary is `runtimeBinaryForVersion()`, and it must answer this
   * version. Absent: the pinned version.
   */
  version?: string;
}

/** What `stop()` may be told. */
export interface RuntimeStopOptions {
  /**
   * The pid the state file holds. When no child of this process runs under it and its command
   * line is a binary under our runtime folder, it is a runtime an earlier server left behind,
   * and it is ended like our own child (SIGTERM, then SIGKILL). Any other pid is left alone.
   */
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
  /** How long a started runtime has to answer `/api/version`. Default 30 seconds. */
  startTimeoutMs?: number;
  /** How often an adopted orphan is looked at. Default 5 seconds. */
  orphanPollMs?: number;
  /** How long `start()` waits for the budget line once the runtime answers. Default 3 seconds. */
  budgetWaitMs?: number;
}

/** The one supervisor of the runtime child. */
export interface RuntimeSupervisor {
  /**
   * Makes sure the runtime runs on `port` with `contextLength`. Idempotent: a child that
   * already runs with both is kept. Resolves once `/api/version` answers the pinned version
   * and the budget line was read (or a few seconds passed without it). Never throws.
   */
  start(options: RuntimeStartOptions): Promise<RuntimeStartResult>;
  /**
   * SIGTERM to the child, SIGKILL after a grace period. Resolves once it is gone. Safe to call
   * when nothing runs. With `previousPid` it also ends a runtime an earlier server left behind
   * (see `RuntimeStopOptions`), so no caller deletes the runtime folder under a live process.
   */
  stop(options?: RuntimeStopOptions): Promise<void>;
  status(): RuntimeStatus;
}

const defaultSpawn: RuntimeSupervisorDeps['spawn'] = (command, args, options) => {
  if (UNDER_VITEST) throw new NotInjectedError('spawn');
  return nodeSpawn(command, [...args], options);
};

/** `ps -o command= -p <pid>`: the command line of a pid, `undefined` when it is gone. Spawns nothing under vitest. */
function defaultCommandOfPid(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    if (UNDER_VITEST || !Number.isInteger(pid) || pid <= 1) return resolve(undefined);
    execFile('/bin/ps', ['-o', 'command=', '-p', String(pid)], { timeout: PS_TIMEOUT_MS }, (err, stdout) => {
      const line = typeof stdout === 'string' ? stdout.trim() : '';
      resolve(err || line === '' ? undefined : line);
    });
  });
}

const defaultKill: RuntimeSupervisorDeps['kill'] = (pid, signal) => {
  if (UNDER_VITEST || !Number.isInteger(pid) || pid <= 1) return;
  try {
    process.kill(pid, signal);
  } catch {
    // Gone already.
  }
};

function hasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

/** How one launch of the child ended. */
type LaunchResult = { ok: true; pid: number; measuredTotalBytes?: number } | { ok: false; detail: string };

/** A supervisor. The server keeps ONE (see `getLocalModelService()` in install-job.ts). */
export function createRuntimeSupervisor(overrides: Partial<RuntimeSupervisorDeps> = {}): RuntimeSupervisor {
  const pin = overrides.pin ?? OLLAMA_RUNTIME_PIN;
  const deps = {
    spawn: overrides.spawn ?? defaultSpawn,
    fetch: overrides.fetch ?? defaultFetch,
    env: overrides.env ?? process.env,
    commandOfPid: overrides.commandOfPid ?? defaultCommandOfPid,
    kill: overrides.kill ?? defaultKill,
    isPortFree: overrides.isPortFree ?? isLoopbackPortFree,
    sleep: overrides.sleep ?? realSleep,
    onChange: overrides.onChange ?? ((): void => undefined),
    startTimeoutMs: overrides.startTimeoutMs ?? START_TIMEOUT_MS,
    orphanPollMs: overrides.orphanPollMs ?? ORPHAN_POLL_MS,
    budgetWaitMs: overrides.budgetWaitMs ?? BUDGET_WAIT_MS,
  };
  // Resolved on first use: `localModelPaths()` creates the data dir, which making a supervisor must not.
  let resolvedPaths = overrides.paths;
  const paths = (): LocalModelPaths => (resolvedPaths ??= localModelPaths(pin.version));

  /** Our child, once it answered. */
  let child: ChildProcess | undefined;
  /** A child that was spawned and has not answered yet. */
  let starting: ChildProcess | undefined;
  /** An orphan of an earlier server that was adopted: not our child, so it is signalled by pid. */
  let adoptedPid: number | undefined;
  let orphanTimer: NodeJS.Timeout | undefined;
  /** What the last `start()` asked for: what a restart starts again. */
  let wanted: { port: number; contextLength: number; version: string } | undefined;
  /** The version the running child was started as. */
  let runningVersion: string | undefined;
  /** Bumped by every `start()` and `stop()`: work of an older generation stops when it notices. */
  let generation = 0;
  /** The restart loop that is running, if one is. */
  let restarting: Promise<void> | undefined;
  /** `start()` and `stop()` run one after the other. */
  let queue: Promise<unknown> = Promise.resolve();
  let state: RuntimeStatus = { running: false, restarts: 0, gaveUp: false };

  function setState(patch: Partial<RuntimeStatus>): void {
    const next: RuntimeStatus = { ...state, ...patch };
    for (const key of Object.keys(next) as (keyof RuntimeStatus)[]) {
      if (next[key] === undefined) delete next[key];
    }
    const changed =
      Object.keys(next).length !== Object.keys(state).length ||
      (Object.keys(next) as (keyof RuntimeStatus)[]).some((key) => next[key] !== state[key]);
    state = next;
    if (!changed) return;
    try {
      deps.onChange({ ...state });
    } catch {
      // A caller that throws must not stop the supervisor.
    }
  }

  function serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = queue.then(work, work);
    queue = run.catch(() => undefined);
    return run;
  }

  const isOwn = (command: string | undefined): boolean =>
    command !== undefined && isOwnRuntimeCommand(command, paths().runtimeRoot);

  /** SIGTERM, then SIGKILL after the grace period. Resolves once the child is gone. */
  async function stopChild(proc: ChildProcess): Promise<void> {
    // A child that never got a pid was never started: there is no exit to wait for.
    if (hasExited(proc) || proc.pid === undefined) return;
    const gone = new Promise<void>((resolve) => proc.once('exit', () => resolve()));
    try {
      if (!proc.kill('SIGTERM')) return;
    } catch {
      return;
    }
    const force = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // Gone already.
      }
    }, STOP_GRACE_MS);
    force.unref();
    await Promise.race([gone, pause(STOP_GRACE_MS + STOP_KILL_WAIT_MS)]);
    clearTimeout(force);
  }

  /** The same for a pid that is not our child: signalled through `deps.kill`, watched through `ps`. */
  async function stopOrphan(pid: number): Promise<void> {
    const goneWithin = async (ms: number): Promise<boolean> => {
      const until = Date.now() + ms;
      for (;;) {
        if (!isOwn(await deps.commandOfPid(pid))) return true;
        if (Date.now() >= until) return false;
        await pause(100);
      }
    };
    deps.kill(pid, 'SIGTERM');
    if (await goneWithin(STOP_GRACE_MS)) return;
    deps.kill(pid, 'SIGKILL');
    await goneWithin(STOP_KILL_WAIT_MS);
  }

  /** Stops whatever runs now: our child, one that is starting, an adopted orphan. */
  async function stopCurrent(): Promise<void> {
    clearInterval(orphanTimer);
    orphanTimer = undefined;
    const procs = [child, starting].filter((proc): proc is ChildProcess => proc !== undefined);
    // Forgotten first, so that its exit is not taken for a crash.
    child = undefined;
    starting = undefined;
    const orphan = adoptedPid;
    adoptedPid = undefined;
    await Promise.all(procs.map((proc) => stopChild(proc)));
    if (orphan !== undefined) await stopOrphan(orphan);
  }

  /** The runtime exited by itself: start it again, a bounded number of times. */
  function restart(): void {
    if (restarting) return;
    const gen = generation;
    const loop = async (): Promise<void> => {
      while (gen === generation && wanted) {
        if (state.restarts >= RUNTIME_MAX_RESTARTS) {
          setState({ gaveUp: true });
          return;
        }
        setState({ restarts: state.restarts + 1 });
        await deps.sleep(RESTART_DELAY_MS);
        if (gen !== generation || !wanted) return;
        const launched = await launch(wanted.port, wanted.contextLength, wanted.version, gen);
        // Running again: a later exit comes back here through the child's exit handler.
        if (launched.ok) return;
      }
    };
    restarting = loop()
      .catch(() => undefined)
      .finally(() => {
        restarting = undefined;
      });
  }

  /** Spawns the runtime and waits until it answers. The child becomes `child` only then. */
  async function launch(port: number, contextLength: number, version: string, gen: number): Promise<LaunchResult> {
    const folders = paths();
    let spawned: ChildProcess;
    try {
      // The pinned build, or the one an installed model was installed with.
      const binary = version === pin.version ? folders.binary : runtimeBinaryForVersion(folders, version);
      await mkdir(folders.homeDir, { recursive: true, mode: 0o700 });
      await mkdir(folders.modelsDir, { recursive: true, mode: 0o700 });
      // Asked to stop in the meantime: nothing is started only to be stopped again.
      if (gen !== generation) return { ok: false, detail: 'The start was replaced by a newer request' };
      spawned = deps.spawn(binary, ['serve'], {
        env: runtimeEnv({
          source: deps.env,
          home: folders.homeDir,
          modelsDir: folders.modelsDir,
          port,
          contextLength,
        }),
        cwd: folders.homeDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        // A child of the server, in its process group: it is not left behind by a normal exit.
        detached: false,
      });
    } catch (err) {
      return { ok: false, detail: errorText(err) };
    }
    starting = spawned;
    // Said at once, before the child answers: the caller stores the pid, so a server that is
    // killed during this start still leaves a pid that names the runtime as ours.
    if (spawned.pid !== undefined) setState({ pid: spawned.pid });

    // The child's output: the budget line, and the last lines for the detail of a failure.
    // It is read for as long as the child lives, so a full pipe never blocks it.
    const tail: string[] = [];
    let measured: number | undefined;
    let budgetSeen: () => void = () => undefined;
    const budget = new Promise<void>((resolve) => {
      budgetSeen = resolve;
    });
    const onLine = (text: string): void => {
      const line = text.length > LOG_LINE_MAX_CHARS ? text.slice(0, LOG_LINE_MAX_CHARS) : text;
      if (line.trim() === '') return;
      tail.push(line);
      if (tail.length > LOG_TAIL_LINES) tail.shift();
      const total = parseInferenceComputeTotal(line);
      if (total === undefined) return;
      measured = total;
      if (child === spawned) setState({ measuredTotalBytes: total });
      budgetSeen();
    };
    for (const stream of [spawned.stdout, spawned.stderr]) {
      if (!stream) continue;
      let pending = '';
      stream.setEncoding('utf8');
      stream.on('data', (chunk: string) => {
        pending += chunk;
        let breakAt = pending.indexOf('\n');
        while (breakAt >= 0) {
          onLine(pending.slice(0, breakAt));
          pending = pending.slice(breakAt + 1);
          breakAt = pending.indexOf('\n');
        }
        // A line without an end is cut, so the buffer cannot grow without bound.
        if (pending.length > LOG_LINE_MAX_CHARS) pending = pending.slice(0, LOG_LINE_MAX_CHARS);
      });
      stream.on('error', () => undefined);
    }

    let ended: string | undefined;
    let goneNow: () => void = () => undefined;
    const gone = new Promise<void>((resolve) => {
      goneNow = resolve;
    });
    // The last resort when the server exits without its shutdown: the child must not outlive it.
    const onProcessExit = (): void => {
      try {
        spawned.kill('SIGTERM');
      } catch {
        // Gone already.
      }
    };
    process.once('exit', onProcessExit);
    spawned.once('error', (err) => {
      // A spawn that failed emits no exit.
      if (spawned.pid === undefined) process.off('exit', onProcessExit);
      ended ??= `The runtime could not be started: ${errorText(err)}`;
      goneNow();
    });
    spawned.once('exit', (code, signal) => {
      process.off('exit', onProcessExit);
      ended ??= signal ? `The runtime was ended by ${signal}` : `The runtime exited with code ${String(code)}`;
      goneNow();
      if (starting === spawned) starting = undefined;
      if (child !== spawned) return;
      // Our running child exited by itself.
      child = undefined;
      setState({ running: false, pid: undefined });
      restart();
    });

    const fail = async (reason: string): Promise<LaunchResult> => {
      if (starting === spawned) starting = undefined;
      await stopChild(spawned);
      // The pid that was announced at the spawn is no runtime any more.
      if (state.pid === spawned.pid && child !== spawned) setState({ pid: undefined });
      const log = tail.join('\n');
      return { ok: false, detail: clip(log === '' ? reason : `${reason}\n${log}`) };
    };

    const target = { baseUrl: `http://127.0.0.1:${port}`, fetch: deps.fetch };
    const deadline = Date.now() + deps.startTimeoutMs;
    for (;;) {
      if (ended !== undefined) return fail(ended);
      if (gen !== generation) return fail('The start was replaced by a newer request');
      const answered = await getRuntimeVersion(target);
      if (ended !== undefined) return fail(ended);
      if (answered !== undefined) {
        if (answered !== version) return fail(`The runtime answers as version ${answered}, not ${version}`);
        break;
      }
      if (Date.now() >= deadline) {
        return fail(`The runtime did not answer within ${Math.round(deps.startTimeoutMs / 1000)} seconds`);
      }
      await deps.sleep(START_POLL_MS);
    }

    // The budget line follows the first answer within a moment. An older runtime may not print it.
    if (measured === undefined) await Promise.race([budget, gone, pause(deps.budgetWaitMs)]);
    if (ended !== undefined) return fail(ended);
    if (gen !== generation) return fail('The start was replaced by a newer request');

    starting = undefined;
    child = spawned;
    runningVersion = version;
    const pid = spawned.pid ?? 0;
    setState({
      running: true,
      pid,
      port,
      contextLength,
      measuredTotalBytes: measured,
      gaveUp: false,
    });
    return { ok: true, pid, ...(measured !== undefined ? { measuredTotalBytes: measured } : {}) };
  }

  /** Keeps an orphan of an earlier server: it is watched by pid, because its exit is no event of ours. */
  function adopt(pid: number, port: number, contextLength: number, version: string): void {
    adoptedPid = pid;
    runningVersion = version;
    setState({ running: true, pid, port, contextLength, measuredTotalBytes: undefined, gaveUp: false });
    let looking = false;
    orphanTimer = setInterval(() => {
      if (looking || adoptedPid !== pid) return;
      looking = true;
      void deps
        .commandOfPid(pid)
        .catch(() => undefined)
        .then((command) => {
          looking = false;
          if (adoptedPid !== pid || isOwn(command)) return;
          // The orphan is gone: from here on the runtime is a child of our own.
          clearInterval(orphanTimer);
          orphanTimer = undefined;
          adoptedPid = undefined;
          setState({ running: false, pid: undefined });
          restart();
        });
    }, deps.orphanPollMs);
    orphanTimer.unref();
  }

  /** Whether keeping this orphan keeps something: a model is loaded, and at the wanted context. */
  async function worthAdopting(
    target: { baseUrl: string; fetch: typeof fetch },
    contextLength: number
  ): Promise<boolean> {
    const loaded = await listRunning(target);
    return loaded.length > 0 && loaded.every((model) => model.contextLength === contextLength);
  }

  /** Waits for the port to come free after an orphan was told to go. */
  async function portFreeWithin(port: number, ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    for (;;) {
      if (await deps.isPortFree(port).catch(() => false)) return true;
      if (Date.now() >= until) return false;
      await pause(100);
    }
  }

  async function doStart(options: RuntimeStartOptions): Promise<RuntimeStartResult> {
    const { port, contextLength, previousPid } = options;
    const version = options.version ?? pin.version;
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { ok: false, code: 'runtime-start-failed', detail: `Not a port: ${String(port)}` };
    }
    if (!Number.isInteger(contextLength) || contextLength < 1) {
      return { ok: false, code: 'runtime-start-failed', detail: `Not a context length: ${String(contextLength)}` };
    }
    // Already running as asked: nothing to do.
    const alive = (child !== undefined && !hasExited(child)) || adoptedPid !== undefined;
    if (
      alive &&
      state.running &&
      state.port === port &&
      state.contextLength === contextLength &&
      runningVersion === version
    ) {
      return {
        ok: true,
        pid: state.pid ?? 0,
        port,
        orphan: 'none',
        ...(state.measuredTotalBytes !== undefined ? { measuredTotalBytes: state.measuredTotalBytes } : {}),
      };
    }

    generation += 1;
    const gen = generation;
    await restarting;
    await stopCurrent();
    wanted = { port, contextLength, version };
    runningVersion = undefined;
    setState({
      running: false,
      pid: undefined,
      port: undefined,
      contextLength: undefined,
      measuredTotalBytes: undefined,
      restarts: 0,
      gaveUp: false,
    });

    // Who holds the port, if anybody does.
    const target = { baseUrl: `http://127.0.0.1:${port}`, fetch: deps.fetch };
    const ownOrphan =
      previousPid !== undefined &&
      Number.isInteger(previousPid) &&
      isOwn(await deps.commandOfPid(previousPid).catch(() => undefined))
        ? previousPid
        : undefined;
    const answering = await getRuntimeVersion(target);
    let orphan: 'none' | 'adopted' | 'replaced' = 'none';
    if (ownOrphan !== undefined) {
      if (answering === version && (await worthAdopting(target, contextLength))) {
        adopt(ownOrphan, port, contextLength, version);
        return { ok: true, pid: ownOrphan, port, orphan: 'adopted' };
      }
      await stopOrphan(ownOrphan);
      orphan = 'replaced';
    } else if (answering !== undefined) {
      return {
        ok: false,
        code: 'port-in-use',
        detail: `A model runtime that Codeman did not start answers on port ${port} (version ${answering})`,
      };
    }
    if (!(await portFreeWithin(port, orphan === 'replaced' ? STOP_GRACE_MS : 0))) {
      return { ok: false, code: 'port-in-use', detail: `Another program holds port ${port}` };
    }

    const launched = await launch(port, contextLength, version, gen);
    if (!launched.ok) return { ok: false, code: 'runtime-start-failed', detail: launched.detail };
    return {
      ok: true,
      pid: launched.pid,
      port,
      orphan,
      ...(launched.measuredTotalBytes !== undefined ? { measuredTotalBytes: launched.measuredTotalBytes } : {}),
    };
  }

  async function doStop(options: RuntimeStopOptions = {}): Promise<void> {
    generation += 1;
    wanted = undefined;
    await restarting;
    await stopCurrent();
    runningVersion = undefined;
    // A runtime an earlier server left behind: not a child of this process, known only by the
    // pid the state file kept. Ended when (and only when) its command line is our own binary.
    const { previousPid } = options;
    if (previousPid !== undefined && Number.isInteger(previousPid) && previousPid > 1) {
      if (isOwn(await deps.commandOfPid(previousPid).catch(() => undefined))) await stopOrphan(previousPid);
    }
    setState({
      running: false,
      pid: undefined,
      port: undefined,
      contextLength: undefined,
      measuredTotalBytes: undefined,
      restarts: 0,
      gaveUp: false,
    });
  }

  return {
    start: (options) =>
      serialize(() => doStart(options)).catch(
        (err): RuntimeStartResult => ({ ok: false, code: 'runtime-start-failed', detail: errorText(err) })
      ),
    stop: (options) => {
      // At once, not when its turn comes: a start that is still waiting for the runtime gives up.
      generation += 1;
      return serialize(() => doStop(options)).catch(() => undefined);
    },
    status: () => ({ ...state }),
  };
}
