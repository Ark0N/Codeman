/**
 * @fileoverview The HTTP client of the model runtime: what Codeman asks its own runtime on
 * the loopback port, and the pure functions that read the answers.
 *
 * CONTRACT STAGE: every function below has its final signature and a body that throws; the
 * bodies are written next.
 *
 * What it asks:
 *  - `GET /api/version`, `GET /api/tags`, `GET /api/ps`, `GET /v1/models`, `DELETE /api/delete`.
 *  - `POST /api/pull` with `stream: true`. The answer is one JSON object per line, and a
 *    23 GB pull sends about 1.4 million of them, so the stream is parsed INCREMENTALLY
 *    (`createPullParser()`, pure): only the unfinished last line and the running totals are
 *    kept, never the body. Aborting the request stops the download; pulling again continues
 *    it. An error line or a stream that ends without `success` is retried, at most
 *    `PULL_RETRIES` times.
 *  - The check after the pull (`verifyModel()`), in this order: one tiny chat with
 *    `reasoning_effort: "none"` (it loads the model), then `GET /api/ps` must show the whole
 *    model on the GPU (`size_vram` equal to `size`) at the chosen context
 *    (`judgeLoaded()`, pure), then one tool probe on `/v1/chat/completions` with a `tools`
 *    array, `reasoning_effort: "none"` and `max_tokens` of `TOOL_PROBE_MAX_TOKENS`, which
 *    passes on a tool call whose arguments parse as JSON (`judgeToolProbe()`, pure).
 *
 * Rules:
 *  - Nothing here throws for something a runtime can answer: every outcome is a result with
 *    the job's error code. An abort signal is the result `cancelled`.
 *  - The runtime does not enforce the context length (a prompt of 167,012 tokens was accepted
 *    at 131072), so nothing here relies on it to.
 *  - Every function takes its `fetch` from the target, so a test passes the fake runtime's
 *    address and spawns nothing.
 */

import type { LocalModelErrorCode } from '../types.js';

/** Marks a body the contract stage left unwritten. */
function notImplemented(what: string, ..._args: unknown[]): never {
  throw new Error(`${what} is not implemented yet`);
}

/** How often a pull that ended on an error line or a cut stream is started again. */
export const PULL_RETRIES = 5;
/** `max_tokens` of the tool probe. */
export const TOOL_PROBE_MAX_TOKENS = 1024;

/** Which runtime to ask. */
export interface OllamaTarget {
  /** `http://127.0.0.1:<port>`, without a trailing slash. */
  baseUrl: string;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
}

// ---------- Listings ----------

/** One model of `GET /api/tags`: what is on disk. */
export interface OllamaTagModel {
  /** `name:tag`. */
  name: string;
  /** Size on disk in bytes. */
  size: number;
  /** The model's digest, lowercase hex without a prefix. What is stored and compared again before a session starts. */
  digest: string;
  /** `details.format` ('safetensors' for an MLX build, 'gguf'). */
  format?: string;
  /** `details.runner` ('mlx', 'ggml'). */
  runner?: string;
  /** `capabilities` ('completion', 'tools', 'thinking', 'vision'). */
  capabilities?: string[];
}

/** One model of `GET /api/ps`: what is loaded. */
export interface OllamaPsModel {
  name: string;
  /** Memory the loaded model takes, in bytes. */
  size: number;
  /** The part of `size` that is on the GPU. Equal to `size` when all of it is. */
  sizeVram: number;
  /** The context length the model was loaded with. */
  contextLength: number;
  digest?: string;
}

/** The runtime's version ('0.40.15'), or `undefined` when nothing answers there or the answer is not a runtime's. */
export async function getRuntimeVersion(target: OllamaTarget, signal?: AbortSignal): Promise<string | undefined> {
  return notImplemented('getRuntimeVersion', target, signal);
}

/** The models on disk. An empty list when the runtime has none or does not answer. */
export async function listTags(target: OllamaTarget, signal?: AbortSignal): Promise<OllamaTagModel[]> {
  return notImplemented('listTags', target, signal);
}

/** The models loaded right now. An empty list when none is or the runtime does not answer. */
export async function listRunning(target: OllamaTarget, signal?: AbortSignal): Promise<OllamaPsModel[]> {
  return notImplemented('listRunning', target, signal);
}

/** The model ids `GET /v1/models` lists, exactly as listed (the runtime answers `data: null` for none). */
export async function listOpenAiModels(target: OllamaTarget, signal?: AbortSignal): Promise<string[]> {
  return notImplemented('listOpenAiModels', target, signal);
}

/** The digest `GET /api/tags` reports for `modelId`, or `undefined` when the model is not on disk. */
export async function readModelDigest(
  target: OllamaTarget,
  modelId: string,
  signal?: AbortSignal
): Promise<string | undefined> {
  return notImplemented('readModelDigest', target, modelId, signal);
}

/** Deletes a model from the runtime's store. True when it is gone afterwards (also when it never was there). */
export async function deleteModel(target: OllamaTarget, modelId: string, signal?: AbortSignal): Promise<boolean> {
  return notImplemented('deleteModel', target, modelId, signal);
}

// ---------- Pull ----------

/** What the pull's lines add up to so far. */
export interface PullSnapshot {
  /** Sum of the last `completed` of every layer seen. */
  completedBytes: number;
  /** Sum of the `total` of every layer seen. Grows while new layers appear; 0 before the first. */
  totalBytes: number;
  /** The `status` text of the last line that had one ('pulling manifest', 'writing manifest'). */
  status?: string;
  /** A line `{"status":"success"}` was seen. */
  succeeded: boolean;
  /** The text of the first `{"error":"..."}` line. */
  error?: string;
  /** How many complete lines were parsed. */
  lines: number;
}

/**
 * Reads a pull stream piece by piece. It keeps the unfinished last line and the totals per
 * layer, never the lines themselves, so its memory does not grow with the stream.
 */
export interface PullParser {
  /** Feed the next piece of the body. A line may be split anywhere across pieces, a multi-byte character too. */
  push(chunk: string | Uint8Array): void;
  /** The body ended: reads a last line that had no line break. */
  end(): void;
  snapshot(): PullSnapshot;
}

/**
 * A parser for one pull stream. Pure: no IO, no clock. Lines it understands (both real):
 *
 *  - an MLX build: `{"status":"pulling model","digest":"sha256:model","total":23105798956,"completed":N}`
 *  - a GGUF build, one layer after the other:
 *    `{"status":"pulling c5396e06af29","digest":"sha256:c539...","total":397807936,"completed":N}`
 *    (`completed` is absent until the layer's first bytes arrived)
 *  - `{"status":"pulling manifest"}`, `{"status":"verifying sha256 digest"}`,
 *    `{"status":"writing manifest"}`, `{"status":"success"}`
 *  - `{"error":"max retries exceeded: local error: tls: bad record MAC"}`
 *
 * A line that is not JSON is skipped and still counted.
 */
export function createPullParser(): PullParser {
  return notImplemented('createPullParser');
}

/** How far a pull is, for the caller's progress display. */
export interface PullProgress {
  completedBytes: number;
  totalBytes: number;
  /** Over the last few seconds. Absent until it can be told. */
  bytesPerSecond?: number;
}

export interface PullOptions {
  /** Aborts the request, which stops the download. The result is `cancelled`. */
  signal?: AbortSignal;
  /** Called at most a few times a second, and once more when the pull ends. */
  onProgress?: (progress: PullProgress) => void;
  /** Default `PULL_RETRIES`. */
  retries?: number;
  /** Waits between retries. A test injects its own. */
  sleep?: (ms: number) => Promise<void>;
  /** The clock of the speed figure, in milliseconds. A test injects its own. */
  now?: () => number;
}

/** How a pull ended. */
export type PullResult =
  | {
      ok: true;
      /** The pull's own total: what every size shown for the model comes from once it is known. */
      totalBytes: number;
    }
  | {
      ok: false;
      code: Extract<LocalModelErrorCode, 'pull-failed' | 'model-not-found' | 'disk-full'>;
      /** The runtime's last error text. */
      detail?: string;
    }
  | { ok: false; code: 'cancelled' };

/** Pulls `modelId` and waits for the end. Resuming is calling it again. Never throws. */
export async function pullModel(target: OllamaTarget, modelId: string, options: PullOptions = {}): Promise<PullResult> {
  return notImplemented('pullModel', target, modelId, options);
}

// ---------- The check after the pull ----------

/** The codes the check can end on. */
export type VerifyFailureCode = Extract<
  LocalModelErrorCode,
  'load-failed' | 'does-not-fit' | 'context-not-applied' | 'no-tool-call' | 'probe-unfinished'
>;

/** What the runtime reported about the loaded model. */
export interface LoadedModel {
  context: number;
  sizeBytes: number;
  sizeVramBytes: number;
}

/** The body of the tiny chat that loads the model: one short user message, `reasoning_effort: "none"`, a small `max_tokens`. Pure. */
export function buildChatProbeRequest(modelId: string): Record<string, unknown> {
  return notImplemented('buildChatProbeRequest', modelId);
}

/** The body of the tool probe: a `tools` array, `reasoning_effort: "none"`, `max_tokens: TOOL_PROBE_MAX_TOKENS`. Pure. */
export function buildToolProbeRequest(modelId: string): Record<string, unknown> {
  return notImplemented('buildToolProbeRequest', modelId);
}

/**
 * Judges the process list after the chat. Pure.
 *  - the model is not listed: `load-failed`;
 *  - `sizeVram` is not `size`: `does-not-fit` (part of the model is not on the GPU);
 *  - `contextLength` is not `context`: `context-not-applied`.
 */
export function judgeLoaded(
  models: readonly OllamaPsModel[],
  modelId: string,
  context: number
): { ok: true; loaded: LoadedModel } | { ok: false; code: VerifyFailureCode; detail?: string } {
  return notImplemented('judgeLoaded', models, modelId, context);
}

/**
 * Judges the answer of the tool probe. Pure. `status` is the HTTP status, `body` the parsed
 * JSON (or `undefined` when it did not parse).
 *  - a tool call whose `arguments` parse as a JSON object: passed;
 *  - `finish_reason` is `length`: `probe-unfinished` (the token limit ended it, so it proves nothing);
 *  - any other answer of status 200: `no-tool-call`;
 *  - another status: `load-failed`.
 */
export function judgeToolProbe(
  status: number,
  body: unknown
): { ok: true } | { ok: false; code: VerifyFailureCode; detail?: string } {
  return notImplemented('judgeToolProbe', status, body);
}

/** How the check ended. */
export type VerifyResult =
  | { ok: true; loaded: LoadedModel }
  | { ok: false; code: VerifyFailureCode; detail?: string }
  | { ok: false; code: 'cancelled' };

/**
 * The whole check, in order: the chat, the process list, the tool probe. Stops at the first
 * failure. Never throws.
 */
export async function verifyModel(
  target: OllamaTarget,
  modelId: string,
  context: number,
  signal?: AbortSignal
): Promise<VerifyResult> {
  return notImplemented('verifyModel', target, modelId, context, signal);
}
