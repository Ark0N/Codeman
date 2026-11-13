/**
 * @fileoverview A fake model runtime for the local model tests: an in-process HTTP server on
 * a port the system picks, plus a fake child process that "is" the runtime, so a test starts
 * no real runtime, downloads no real model and binds no fixed port.
 *
 * Plain `node:http`, like test/fixtures/mock-openai-server.ts. Every request is captured
 * (`requests`: method, path, headers, parsed JSON body). Every answer has the shape the real
 * runtime (0.40.15) gave on 2026-11-06; where a shape was not captured, the comment at its
 * handler says so.
 *
 * What it answers:
 *
 * | Route                             | Answer                                                              |
 * |-----------------------------------|---------------------------------------------------------------------|
 * | `GET /`                           | `Ollama is running`                                                 |
 * | `GET /api/version`                | `{"version":"0.40.15"}`                                             |
 * | `GET /api/tags`                   | the model once it is installed (digest, format, runner)             |
 * | `GET /api/ps`                     | the model once a chat loaded it (`size`, `size_vram`, `context_length`) |
 * | `POST /api/pull`                  | NDJSON progress, see `FakePullSwitches`                             |
 * | `DELETE /api/delete`              | 200, or 404 for a model that is not installed                       |
 * |                                   | (the model, or one of `otherModels`)                                |
 * | `GET /v1/models`                  | the model's id, or `data: null` when none is installed (as the real one) |
 * | `POST /v1/chat/completions`       | a plain answer, or a tool call when the request carries `tools`     |
 * | `GET /download/ollama-darwin.tgz` | a small real `.tgz` with Range support, see `FakeArchiveSwitches`   |
 *
 * The switches (`fake.switches`, changeable between requests):
 *  - `pull.fail`: `error-line` (the real `{"error":"max retries exceeded: ..."}` line),
 *    `cut` (the socket is destroyed mid-stream) or `not-found`; `pull.failTimes` says how many
 *    pulls fail before one succeeds; `pull.resumeFrom` and the fake's own memory of how far the
 *    last pull got make the next pull's first line start there, as a resumed pull does.
 *  - `pull.shape`: `mlx` (one line shape, what a Mac really gets) or `gguf` (one layer after
 *    the other).
 *  - `ps`: `sizeVram` below `size` (not all on the GPU), another `contextLength`, or
 *    `loaded: false`.
 *  - `chat`: `error` makes the chat that loads the model fail.
 *  - `tool`: `call` (default), `none` (an answer without a tool call), `length` (the token
 *    limit ended the answer), `bad-arguments` (a tool call whose arguments are not JSON).
 *  - `archive`: cut the download after N bytes for the first M requests, ignore `Range`, or
 *    answer another status.
 *  - `spawn`: the fake child never listens, or exits at once.
 *
 * The fake child (`fake.spawn`, the shape of `RuntimeSupervisorDeps.spawn`): "starting" it
 * makes the fake listen on the port of `OLLAMA_HOST` from the environment it is given and
 * writes the runtime's start-up log to its stderr, including the line "inference compute"
 * with the device total. Killing it closes the listener and emits `exit`. So a supervisor
 * test reserves a port (`freeLoopbackPort()`), builds the fake with `createFakeOllama()`
 * (not listening yet) and injects `fake.spawn`.
 *
 * Port: none fixed. `startFakeOllama()` listens on 0 and reports `port`.
 */

import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type AddressInfo, type Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import type { LocalModelRuntimePin } from '../../src/types.js';

// ---------- Real log lines ----------

/**
 * The runtime's line with the device total, VERBATIM from the 16 GB Mac mini (Apple M4),
 * 2026-11-06. `parseInferenceComputeTotal()` must read 11.8 GiB from it.
 */
export const REAL_INFERENCE_COMPUTE_LINE_MAC_MINI =
  'time=2026-11-06T13:21:49.885+01:00 level=INFO source=types.go:32 msg="inference compute" id=0 filter_id=0 library=Metal compute=0.0 name=MTL0 description="Apple M4" libdirs="" driver=0.0 pci_id="" type=iGPU total="11.8 GiB" available="11.8 GiB"';

/**
 * The same line for the 48 GB MacBook (Apple M5 Pro), RECONSTRUCTED: the measurement notes of
 * 2026-11-06 quote only `total="37.4 GiB" available="37.4 GiB"` from it, so the rest is the
 * Mac mini's line with the chip name and a time filled in (hence no `REAL_` in the name).
 * `parseInferenceComputeTotal()` must read 40,157,944,217 bytes from it.
 */
export const INFERENCE_COMPUTE_LINE_MACBOOK =
  'time=2026-11-06T15:04:12.371+01:00 level=INFO source=types.go:32 msg="inference compute" id=0 filter_id=0 library=Metal compute=0.0 name=MTL0 description="Apple M5 Pro" libdirs="" driver=0.0 pci_id="" type=iGPU total="37.4 GiB" available="37.4 GiB"';

/** 37.4 GiB in bytes, rounded down: what the MacBook line stands for. */
export const MACBOOK_MEASURED_TOTAL_BYTES = 40_157_944_217;

/**
 * The line that FOLLOWS it and also carries the total, under another key. Verbatim from the
 * Mac mini. A parser of the budget must not need it and must not be confused by it.
 */
export const REAL_VRAM_DEFAULT_CONTEXT_LINE_MAC_MINI =
  'time=2026-11-06T13:21:49.885+01:00 level=INFO source=routes.go:2586 msg="vram-based default context" total_vram="11.8 GiB" default_num_ctx=4096';

/**
 * What the runtime writes when it starts, in order, with `total` as the device total (the
 * text inside the quotes, such as '37.4 GiB'). The shapes are the Mac mini's.
 */
export function fakeRuntimeLog(total = '37.4 GiB', port = 11435): string[] {
  return [
    `time=2026-11-06T15:04:12.210+01:00 level=INFO source=routes.go:2536 msg="Listening on 127.0.0.1:${port} (version 0.40.15)"`,
    'time=2026-11-06T15:04:12.211+01:00 level=INFO source=runner.go:60 msg="discovering available GPUs..."',
    `time=2026-11-06T15:04:12.371+01:00 level=INFO source=types.go:32 msg="inference compute" id=0 filter_id=0 library=Metal compute=0.0 name=MTL0 description="Apple M5 Pro" libdirs="" driver=0.0 pci_id="" type=iGPU total="${total}" available="${total}"`,
    `time=2026-11-06T15:04:12.371+01:00 level=INFO source=routes.go:2586 msg="vram-based default context" total_vram="${total}" default_num_ctx=32768`,
  ];
}

/** The error line of a pull whose download kept failing. Verbatim from the Mac mini. */
export const REAL_PULL_ERROR_LINE = '{"error":"max retries exceeded: local error: tls: bad record MAC"}';

// ---------- Options and switches ----------

/** The model the fake serves. Default: what the MacBook really got for `qwen3.6:35b-a3b`. */
export interface FakeOllamaModel {
  id: string;
  /** The pull's total and the size `/api/tags` reports. */
  bytes: number;
  /** As `/api/tags` reports it: lowercase hex, no prefix. */
  digest: string;
  format: string;
  runner: string;
  quantization: string;
  capabilities: string[];
}

export const DEFAULT_FAKE_MODEL: FakeOllamaModel = {
  id: 'qwen3.6:35b-a3b',
  bytes: 23_105_798_956,
  digest: '0ce5ff81f9ffdf89dd8192ca7b5d34cefd8996a875b3aaaaafaf5c4813569eba',
  format: 'safetensors',
  runner: 'mlx',
  quantization: 'nvfp4',
  capabilities: ['completion', 'vision', 'tools', 'thinking'],
};

export interface FakePullSwitches {
  /**
   * `mlx`: every progress line is `{"status":"pulling model","digest":"sha256:model",...}`,
   * what a Mac gets for an MLX build. `gguf`: one layer after the other, each
   * `{"status":"pulling <12 hex>","digest":"sha256:<64 hex>",...}`, the first lines of a layer
   * without `completed`, then `verifying sha256 digest`.
   */
  shape: 'mlx' | 'gguf';
  /** How many progress lines the large layer of one full pull is spread over. Default 20. */
  progressLines: number;
  /** Milliseconds between two lines. Default 0. Raise it to abort or cancel mid-stream. */
  lineDelayMs: number;
  /**
   * How a pull goes wrong.
   *  - `none`: it succeeds.
   *  - `error-line`: after `failAfterLines` progress lines, the real error line, then the body ends.
   *  - `cut`: after `failAfterLines` progress lines the socket is destroyed (no `success`, no error).
   *  - `not-found`: `pulling manifest`, then an error line saying the manifest does not exist.
   */
  fail: 'none' | 'error-line' | 'cut' | 'not-found';
  /** Progress lines sent before the failure. Default 10. */
  failAfterLines: number;
  /** How many pulls fail before one succeeds. Default `Infinity`: every pull fails. */
  failTimes: number;
  /** Bytes the first pull starts at, as if an earlier run had left partial blobs. Default 0. */
  resumeFrom: number;
}

export interface FakePsSwitches {
  /** `size`. Default: the model's bytes plus 100 MB. */
  size?: number;
  /** `size_vram`. Default: equal to `size` (all on the GPU). Set it lower for "does not fit". */
  sizeVram?: number;
  /** `context_length`. Default: `FakeOllamaOptions.contextLength`. */
  contextLength?: number;
  /** False: `/api/ps` stays empty even after a chat. */
  loaded?: boolean;
}

export interface FakeArchiveSwitches {
  /** Destroy the socket after this many bytes of the body were sent. */
  cutAfterBytes?: number;
  /** For how many requests the cut applies. Default 1. */
  cutTimes: number;
  /** True: answer 200 with the whole body even to a `Range` request. */
  ignoreRange: boolean;
  /** Answer this status with an empty body instead (404, 503). */
  status?: number;
}

export interface FakeSpawnSwitches {
  /** True: the child starts and writes its log but never listens (the supervisor's `runtime-start-failed`). */
  neverListens: boolean;
  /** A number: the child exits with this code right after it was started. */
  exitsAtOnce?: number;
  /** The device total the child logs (the text inside the quotes). Default '37.4 GiB'. */
  total: string;
  /** False: the "inference compute" line is left out of the log. */
  logsBudget: boolean;
}

export interface FakeOllamaSwitches {
  pull: FakePullSwitches;
  ps: FakePsSwitches;
  /** `error`: `POST /v1/chat/completions` WITHOUT tools answers 500. */
  chat: 'ok' | 'error';
  /**
   * What `POST /v1/chat/completions` WITH tools answers.
   *  - `call`: one tool call with JSON arguments, `finish_reason: "tool_calls"`.
   *  - `none`: a text answer, `finish_reason: "stop"`.
   *  - `length`: an empty answer with a `reasoning` text, `finish_reason: "length"`.
   *  - `bad-arguments`: a tool call whose `arguments` do not parse.
   */
  tool: 'call' | 'none' | 'length' | 'bad-arguments';
  archive: FakeArchiveSwitches;
  spawn: FakeSpawnSwitches;
}

export interface FakeOllamaOptions {
  /** What `/api/version` answers. Default '0.40.15'. */
  version?: string;
  model?: Partial<FakeOllamaModel>;
  /** True: the model is installed from the start. Default false: it appears after a pull that succeeded. */
  installed?: boolean;
  /** The context length the runtime "was started with": what `/api/ps` reports. Default 131072. */
  contextLength?: number;
  pull?: Partial<FakePullSwitches>;
  ps?: FakePsSwitches;
  chat?: FakeOllamaSwitches['chat'];
  tool?: FakeOllamaSwitches['tool'];
  archive?: Partial<FakeArchiveSwitches>;
  spawn?: Partial<FakeSpawnSwitches>;
  /** The files of the fake runtime archive, name to content. Default: one executable `ollama` script. */
  archiveFiles?: Record<string, string>;
  /**
   * More models the registry has beside `model`: each can be pulled (a short stream that
   * succeeds), listed, loaded, checked and deleted on its own. The pull, chat and tool
   * switches apply to them too, except the pull's failures and shapes, which are `model`'s.
   */
  otherModels?: FakeOllamaModel[];
  /** The ids of `otherModels` that are on disk from the start. */
  othersInstalled?: string[];
}

export interface CapturedRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  /** The parsed JSON body, the raw text when it is not JSON, `undefined` when there is none. */
  body: unknown;
}

/** The fake child process: enough of `ChildProcess` for a supervisor. */
export class FakeRuntimeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = null;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  /** Every signal `kill()` was called with. */
  readonly signals: (NodeJS.Signals | number)[] = [];

  constructor(
    /** Above every real pid (Linux allows at most 4194304), so a stray `process.kill(pid)` hits nothing. */
    readonly pid: number,
    readonly command: string,
    readonly args: readonly string[],
    /** The environment the child was started with: what `runtimeEnv()` built. */
    readonly env: NodeJS.ProcessEnv,
    private readonly onGone: () => Promise<void>
  ) {
    super();
  }

  /** As `ChildProcess.kill()`: the listener closes and `exit` then `close` are emitted. */
  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.signals.push(signal);
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.killed = true;
    void this.finish(null, typeof signal === 'string' ? signal : 'SIGTERM');
    return true;
  }

  /** The child dies by itself with `code`, as a crash would. */
  crash(code = 1): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    void this.finish(code, null);
  }

  private async finish(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    this.exitCode = code;
    this.signalCode = signal;
    await this.onGone();
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, signal);
    this.emit('close', code, signal);
  }
}

export interface FakeOllama {
  /** `http://127.0.0.1:<port>`. Empty while the fake does not listen. */
  readonly baseUrl: string;
  /** 0 while the fake does not listen. */
  readonly port: number;
  readonly listening: boolean;
  /** Every request so far, oldest first. */
  readonly requests: CapturedRequest[];
  /** Change these between requests. */
  readonly switches: FakeOllamaSwitches;
  readonly model: FakeOllamaModel;
  /** What the fake remembers. */
  readonly state: {
    /** The model is in `/api/tags` and `/v1/models`. */
    installed: boolean;
    /** A chat loaded the model: it is in `/api/ps`. */
    loaded: boolean;
    /** How far the pulls got: what the next pull's first progress line starts at. */
    completedBytes: number;
    /** How many `POST /api/pull` arrived. */
    pulls: number;
    /** How many `GET` of the archive arrived. */
    archiveRequests: number;
    /** Every child `spawn` made, oldest first. */
    children: FakeRuntimeChild[];
    /** The ids of `otherModels` that are on disk: pulled, or installed from the start. */
    others: string[];
    /** The id of the model the last chat loaded. The runtime holds one model at a time. */
    loadedId?: string;
  };
  /** The fake runtime archive: a real gzipped tar. */
  readonly archive: { readonly body: Buffer; readonly size: number; readonly sha256: string };
  /** A pin that points at this fake's archive (valid while it listens). */
  pin(): LocalModelRuntimePin;
  /** Starts listening on 127.0.0.1. Default port 0: the system picks one. */
  listen(port?: number): Promise<void>;
  /** Stops listening and drops every open connection. Safe to call twice. */
  close(): Promise<void>;
  /**
   * A stand-in for `child_process.spawn` that "starts the runtime": the fake listens on the
   * port of `options.env.OLLAMA_HOST` and the child logs the start-up lines. See the file header.
   */
  spawn(command: string, args: readonly string[], options: SpawnOptions): ChildProcess;
}

// ---------- Helpers ----------

/** A loopback port nothing listens on right now: bound on 0, read, closed again. */
export async function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** One file as a tar entry: a 512-byte ustar header, the content, zero padding to 512. */
function tarEntry(name: string, content: Buffer, mode: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
  header.write('0000000\0', 108, 8, 'ascii');
  header.write('0000000\0', 116, 8, 'ascii');
  header.write(content.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  header.write('00000000000\0', 136, 12, 'ascii');
  header.write('        ', 148, 8, 'ascii');
  header.write('0', 156, 1, 'ascii');
  header.write('ustar\0', 257, 6, 'ascii');
  header.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return Buffer.concat([header, content, padding]);
}

/** A gzipped tar of `files`, which `/usr/bin/tar -xzf` unpacks. A file named `ollama` is executable. */
export function buildFakeArchive(files: Record<string, string>): Buffer {
  const entries = Object.entries(files).map(([name, text]) =>
    tarEntry(name, Buffer.from(text, 'utf8'), name === 'ollama' ? 0o755 : 0o644)
  );
  return gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(raw);
      }
    });
    req.on('error', () => resolve(undefined));
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A value for one tool parameter, by its JSON schema type. */
function placeholderFor(schema: unknown): unknown {
  const type = (schema as { type?: unknown } | undefined)?.type;
  if (type === 'number' || type === 'integer') return 1;
  if (type === 'boolean') return true;
  if (type === 'array') return [];
  if (type === 'object') return {};
  return 'README.md';
}

/** The small layers a GGUF pull ends with: the sizes of the real `qwen2.5:0.5b` pull. */
const GGUF_SMALL_LAYERS = [68, 1482, 11343, 490];

// ---------- The fake ----------

/** A fake that does not listen yet. For a supervisor test, which injects `fake.spawn`. */
export function createFakeOllama(options: FakeOllamaOptions = {}): FakeOllama {
  const version = options.version ?? '0.40.15';
  const model: FakeOllamaModel = { ...DEFAULT_FAKE_MODEL, ...options.model };
  const contextLength = options.contextLength ?? 131072;
  const switches: FakeOllamaSwitches = {
    pull: {
      shape: 'mlx',
      progressLines: 20,
      lineDelayMs: 0,
      fail: 'none',
      failAfterLines: 10,
      failTimes: Infinity,
      resumeFrom: 0,
      ...options.pull,
    },
    ps: { ...options.ps },
    chat: options.chat ?? 'ok',
    tool: options.tool ?? 'call',
    archive: { cutTimes: 1, ignoreRange: false, ...options.archive },
    spawn: { neverListens: false, total: '37.4 GiB', logsBudget: true, ...options.spawn },
  };
  const archiveBody = buildFakeArchive(options.archiveFiles ?? { ollama: '#!/bin/sh\necho "fake runtime"\n' });
  const archive = {
    body: archiveBody,
    size: archiveBody.length,
    sha256: createHash('sha256').update(archiveBody).digest('hex'),
  };
  const state: FakeOllama['state'] = {
    installed: options.installed ?? false,
    loaded: false,
    completedBytes: 0,
    pulls: 0,
    archiveRequests: 0,
    children: [],
    others: [...(options.othersInstalled ?? [])],
  };
  const otherModels = options.otherModels ?? [];
  /** One of `otherModels` by its id, whether it is on disk or not. */
  const otherModel = (id: unknown): FakeOllamaModel | undefined => otherModels.find((other) => other.id === id);
  /** The model `id` names when it is on disk: `model` or one of the others. */
  const onDisk = (id: unknown): FakeOllamaModel | undefined => {
    if (id === model.id) return state.installed ? model : undefined;
    const other = otherModel(id);
    return other && state.others.includes(other.id) ? other : undefined;
  };
  const tagRow = (entry: FakeOllamaModel): Record<string, unknown> => ({
    name: entry.id,
    model: entry.id,
    modified_at: '2026-11-06T15:10:02.465346347+01:00',
    size: entry.bytes,
    digest: entry.digest,
    details: { ...modelDetails(), format: entry.format, context_length: 262144, runner: entry.runner },
    capabilities: entry.capabilities,
  });
  const requests: CapturedRequest[] = [];
  const sockets = new Set<Socket>();
  let server: Server | undefined;
  let port = 0;
  let failedPulls = 0;
  let archiveCuts = 0;
  let nextPid = 9_000_001;
  let chatCounter = 100;

  const modelDetails = (): Record<string, unknown> => ({
    parent_model: '',
    format: model.format,
    family: 'qwen35',
    families: ['qwen35'],
    parameter_size: '35.9B',
    quantization_level: model.quantization,
  });

  async function handlePull(res: ServerResponse, body: unknown): Promise<void> {
    state.pulls += 1;
    const asked = (body as { model?: unknown; name?: unknown } | undefined) ?? {};
    const askedId = typeof asked.model === 'string' ? asked.model : asked.name;
    const { pull } = switches;
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    let gone = false;
    res.on('close', () => {
      gone = true;
    });
    // Each line is handed to the system before the next step, so a cut that follows really
    // arrives AFTER the lines before it, as on a real connection.
    const line = async (value: unknown): Promise<boolean> => {
      if (gone) return false;
      await new Promise<void>((resolve) => res.write(JSON.stringify(value) + '\n', () => resolve()));
      if (pull.lineDelayMs > 0) await sleep(pull.lineDelayMs);
      return !gone;
    };

    if (!(await line({ status: 'pulling manifest' }))) return;
    // One of the other models: a short stream that succeeds.
    const other = otherModel(askedId);
    if (other && pull.fail !== 'not-found') {
      const layer = { status: 'pulling model', digest: 'sha256:other', total: other.bytes };
      if (!(await line({ ...layer, completed: 0 }))) return;
      if (!(await line({ ...layer, completed: other.bytes }))) return;
      if (!(await line({ status: 'writing manifest' }))) return;
      if (!state.others.includes(other.id)) state.others.push(other.id);
      await line({ status: 'success' });
      res.end();
      return;
    }
    // Not captured on a Mac: the wording of the runtime for a tag the registry does not have.
    if (pull.fail === 'not-found' || askedId !== model.id) {
      await line({ error: 'pull model manifest: file does not exist' });
      res.end();
      return;
    }

    const failing = pull.fail !== 'none' && failedPulls < pull.failTimes;
    const smallTotal = GGUF_SMALL_LAYERS.reduce((sum, size) => sum + size, 0);
    const largeTotal = pull.shape === 'gguf' ? model.bytes - smallTotal : model.bytes;
    const largeDigest = pull.shape === 'gguf' ? `sha256:${model.digest}` : 'sha256:model';
    const largeStatus = pull.shape === 'gguf' ? `pulling ${model.digest.slice(0, 12)}` : 'pulling model';
    const start = Math.min(Math.max(state.completedBytes, pull.resumeFrom), largeTotal);
    const lines = Math.max(1, pull.progressLines);

    // A GGUF layer announces itself without `completed` first.
    if (pull.shape === 'gguf' && start === 0) {
      if (!(await line({ status: largeStatus, digest: largeDigest, total: largeTotal }))) return;
    }
    for (let i = 0; i <= lines; i++) {
      if (failing && i === pull.failAfterLines) {
        failedPulls += 1;
        if (pull.fail === 'error-line') {
          res.write(REAL_PULL_ERROR_LINE + '\n');
          res.end();
        } else {
          res.socket?.destroy();
        }
        return;
      }
      const completed = i === lines ? largeTotal : start + Math.floor(((largeTotal - start) * i) / lines);
      if (!(await line({ status: largeStatus, digest: largeDigest, total: largeTotal, completed }))) return;
      state.completedBytes = completed;
    }

    if (pull.shape === 'gguf') {
      for (const [index, size] of GGUF_SMALL_LAYERS.entries()) {
        const hex = createHash('sha256').update(`${model.id}:${index}`).digest('hex');
        const layer = { status: `pulling ${hex.slice(0, 12)}`, digest: `sha256:${hex}`, total: size };
        if (!(await line(layer))) return;
        if (!(await line({ ...layer, completed: size }))) return;
      }
      if (!(await line({ status: 'verifying sha256 digest' }))) return;
    }
    if (!(await line({ status: 'writing manifest' }))) return;
    state.installed = true;
    state.completedBytes = model.bytes;
    await line({ status: 'success' });
    res.end();
  }

  function handleChat(res: ServerResponse, body: unknown): void {
    const request = (body as { model?: unknown; tools?: unknown } | undefined) ?? {};
    const served = onDisk(request.model);
    if (!served) {
      sendJson(res, 404, {
        error: {
          message: `model '${String(request.model)}' not found`,
          type: 'not_found_error',
          param: null,
          code: null,
        },
      });
      return;
    }
    const tools = Array.isArray(request.tools) ? request.tools : [];
    const envelope = (message: Record<string, unknown>, finishReason: string): Record<string, unknown> => ({
      id: `chatcmpl-${chatCounter++}`,
      object: 'chat.completion',
      created: 1793968038,
      model: served.id,
      system_fingerprint: 'fp_ollama',
      choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finishReason }],
      usage: {
        prompt_tokens: 36,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens: 2,
        total_tokens: 38,
      },
    });

    if (tools.length === 0) {
      if (switches.chat === 'error') {
        // Not captured: the runtime's 500 for a model that fails to load.
        sendJson(res, 500, {
          error: { message: 'llm server error: out of memory', type: 'api_error', param: null, code: null },
        });
        return;
      }
      if (switches.ps.loaded !== false) {
        state.loaded = true;
        state.loadedId = served.id;
      }
      sendJson(res, 200, envelope({ content: 'pong' }, 'stop'));
      return;
    }

    if (switches.ps.loaded !== false) {
      state.loaded = true;
      state.loadedId = served.id;
    }
    const fn = (tools[0] as { function?: { name?: unknown; parameters?: { properties?: unknown } } }).function ?? {};
    const name = typeof fn.name === 'string' ? fn.name : 'tool';
    const properties = (fn.parameters?.properties ?? {}) as Record<string, unknown>;
    const args = Object.fromEntries(Object.entries(properties).map(([key, schema]) => [key, placeholderFor(schema)]));
    const toolCall = (argumentsText: string): Record<string, unknown> => ({
      content: '',
      tool_calls: [{ id: 'call_ag8rmzix', index: 0, type: 'function', function: { name, arguments: argumentsText } }],
    });
    switch (switches.tool) {
      case 'call':
        sendJson(res, 200, envelope(toolCall(JSON.stringify(args)), 'tool_calls'));
        return;
      case 'bad-arguments':
        sendJson(res, 200, envelope(toolCall('{"path": '), 'tool_calls'));
        return;
      case 'length':
        sendJson(
          res,
          200,
          envelope({ content: '', reasoning: 'The user wants me to read a file. I should call the tool' }, 'length')
        );
        return;
      case 'none':
        sendJson(res, 200, envelope({ content: 'I would read the file, but I cannot.' }, 'stop'));
        return;
    }
  }

  function handleArchive(req: IncomingMessage, res: ServerResponse): void {
    state.archiveRequests += 1;
    const { archive: sw } = switches;
    if (sw.status !== undefined) {
      res.writeHead(sw.status);
      res.end();
      return;
    }
    let from = 0;
    const range = /^bytes=(\d+)-$/.exec(String(req.headers.range ?? ''));
    if (range && !sw.ignoreRange) {
      from = Number(range[1]);
      if (from >= archive.size) {
        res.writeHead(416, { 'content-range': `bytes */${archive.size}` });
        res.end();
        return;
      }
    }
    const body = archive.body.subarray(from);
    const headers: Record<string, string> = {
      'content-type': 'application/octet-stream',
      'content-length': String(body.length),
      'accept-ranges': 'bytes',
    };
    if (from > 0) headers['content-range'] = `bytes ${from}-${archive.size - 1}/${archive.size}`;
    res.writeHead(from > 0 ? 206 : 200, headers);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    if (sw.cutAfterBytes !== undefined && archiveCuts < sw.cutTimes && sw.cutAfterBytes < body.length) {
      archiveCuts += 1;
      res.write(body.subarray(0, sw.cutAfterBytes), () => res.socket?.destroy());
      return;
    }
    res.end(body);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readBody(req);
    const path = (req.url ?? '').split('?')[0];
    const method = req.method ?? 'GET';
    requests.push({ method, path, headers: req.headers, body });

    if (path === '/' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Ollama is running');
      return;
    }
    if (path === '/api/version' && method === 'GET') return sendJson(res, 200, { version });
    if (path === '/api/tags' && method === 'GET') {
      const models = [
        ...(state.installed ? [tagRow(model)] : []),
        ...otherModels.filter((other) => state.others.includes(other.id)).map(tagRow),
      ];
      return sendJson(res, 200, { models });
    }
    if (path === '/api/ps' && method === 'GET') {
      // The runtime holds ONE model: the one the last chat loaded.
      const held = state.loaded && switches.ps.loaded !== false ? onDisk(state.loadedId ?? model.id) : undefined;
      const size = switches.ps.size ?? (held ?? model).bytes + 100_000_000;
      const models = held
        ? [
            {
              name: held.id,
              model: held.id,
              size,
              digest: held.digest,
              details: modelDetails(),
              expires_at: '2026-11-06T15:20:09.488045+01:00',
              size_vram: switches.ps.sizeVram ?? size,
              context_length: switches.ps.contextLength ?? contextLength,
              runner: held.runner,
            },
          ]
        : [];
      return sendJson(res, 200, { models });
    }
    if (path === '/api/pull' && method === 'POST') return handlePull(res, body);
    if (path === '/api/delete' && method === 'DELETE') {
      // Not captured: the answers of a delete (200 with no body, 404 with an error text).
      const asked = (body as { model?: unknown; name?: unknown } | undefined) ?? {};
      const askedId = typeof asked.model === 'string' ? asked.model : asked.name;
      const other = otherModel(askedId);
      if (other && state.others.includes(other.id)) {
        state.others = state.others.filter((id) => id !== other.id);
        if (state.loadedId === other.id) {
          state.loaded = false;
          state.loadedId = undefined;
        }
        res.writeHead(200);
        res.end();
        return;
      }
      if (!state.installed || askedId !== model.id) {
        return sendJson(res, 404, { error: `model '${String(askedId)}' not found` });
      }
      state.installed = false;
      state.loaded = false;
      state.loadedId = undefined;
      state.completedBytes = 0;
      res.writeHead(200);
      res.end();
      return;
    }
    if (path === '/v1/models' && method === 'GET') {
      const ids = [
        ...(state.installed ? [model.id] : []),
        ...otherModels.filter((other) => state.others.includes(other.id)).map((other) => other.id),
      ];
      const data =
        ids.length > 0 ? ids.map((id) => ({ id, object: 'model', created: 1793967749, owned_by: 'library' })) : null;
      return sendJson(res, 200, { object: 'list', data });
    }
    if (path === '/v1/chat/completions' && method === 'POST') return handleChat(res, body);
    if (path === '/download/ollama-darwin.tgz' && (method === 'GET' || method === 'HEAD')) {
      return handleArchive(req, res);
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 page not found');
  }

  async function listen(onPort = 0): Promise<void> {
    if (server) throw new Error('The fake runtime already listens');
    const created = createServer((req, res) => {
      handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    created.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      created.once('error', reject);
      created.listen(onPort, '127.0.0.1', () => resolve());
    });
    server = created;
    port = (created.address() as AddressInfo).port;
  }

  async function close(): Promise<void> {
    const closing = server;
    if (!closing) return;
    server = undefined;
    port = 0;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => closing.close(() => resolve()));
  }

  function spawn(command: string, args: readonly string[], spawnOptions: SpawnOptions): ChildProcess {
    const env = (spawnOptions.env ?? {}) as NodeJS.ProcessEnv;
    const child = new FakeRuntimeChild(nextPid++, command, args, env, close);
    state.children.push(child);
    const wanted = Number(/:(\d+)$/.exec(env.OLLAMA_HOST ?? '')?.[1] ?? 0);
    const sw = switches.spawn;
    void (async () => {
      // A real child reports nothing before the next turn of the event loop either.
      await sleep(0);
      if (sw.exitsAtOnce !== undefined) {
        child.stderr.write('Error: listen tcp 127.0.0.1: bind: address already in use\n');
        child.crash(sw.exitsAtOnce);
        return;
      }
      if (!sw.neverListens) {
        try {
          await listen(wanted);
        } catch {
          child.stderr.write(`Error: listen tcp 127.0.0.1:${wanted}: bind: address already in use\n`);
          child.crash(1);
          return;
        }
      }
      for (const text of fakeRuntimeLog(sw.total, wanted)) {
        if (!sw.logsBudget && text.includes('msg="inference compute"')) continue;
        child.stderr.write(text + '\n');
      }
    })();
    return child as unknown as ChildProcess;
  }

  return {
    get baseUrl() {
      return server ? `http://127.0.0.1:${port}` : '';
    },
    get port() {
      return port;
    },
    get listening() {
      return server !== undefined;
    },
    requests,
    switches,
    model,
    state,
    archive,
    pin: () => ({
      id: 'ollama',
      version,
      url: `http://127.0.0.1:${port}/download/ollama-darwin.tgz`,
      bytes: archive.size,
      sha256: archive.sha256,
      unpackedBytes: 4096,
      minMacosMajor: 14,
    }),
    listen,
    close,
    spawn,
  };
}

/** A fake that listens on a port the system picked. Close it in `afterEach`. */
export async function startFakeOllama(options: FakeOllamaOptions = {}): Promise<FakeOllama> {
  const fake = createFakeOllama(options);
  await fake.listen(0);
  return fake;
}
