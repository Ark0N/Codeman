/**
 * @fileoverview The HTTP client of the model runtime: what Codeman asks its own runtime on
 * the loopback port, and the pure functions that read the answers.
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
 *  - Every request is bounded: a listing by seconds, the two probes by minutes (the first
 *    chat loads the model). Only the pull has no deadline of its own, because its length is
 *    the download; it ends with the stream, and the caller's signal cancels it.
 *  - The runtime does not enforce the context length (a prompt of 167,012 tokens was accepted
 *    at 131072), so nothing here relies on it to.
 *  - Every function takes its `fetch` from the target, so a test passes the fake runtime's
 *    address and spawns nothing. The target is always a loopback address the caller built from
 *    the stored port: no function here takes a URL from a file or a request.
 */

import type { LocalModelErrorCode } from '../types.js';
import { formatGb } from './format.js';

/** How often a pull that ended on an error line or a cut stream is started again. */
export const PULL_RETRIES = 5;
/** `max_tokens` of the tool probe. */
export const TOOL_PROBE_MAX_TOKENS = 1024;

/** How long `/api/version` may take: it is asked while a runtime starts, many times. */
const VERSION_TIMEOUT_MS = 2_000;
/** How long a listing or a delete may take. */
const LIST_TIMEOUT_MS = 10_000;
/** How long the chat that loads the model may take. A 23 GB model loaded in 5.9 s on the test Mac; a cold disk is slower. */
const CHAT_PROBE_TIMEOUT_MS = 180_000;
/** How long the tool probe may take. The model is loaded by then. */
const TOOL_PROBE_TIMEOUT_MS = 120_000;
/** `max_tokens` of the chat that loads the model: its answer is not read. */
const CHAT_PROBE_MAX_TOKENS = 16;
/** The least time between two progress reports of a pull. */
const PULL_PROGRESS_INTERVAL_MS = 250;
/** The window the download speed is averaged over. */
const PULL_SPEED_WINDOW_MS = 5_000;
/** The first wait before a pull is started again; it doubles with every retry. */
const PULL_RETRY_DELAY_MS = 1_000;
/** A pull line longer than this is not a pull line. It is dropped, so a stream without line breaks cannot grow the buffer. */
const MAX_PULL_LINE_CHARS = 1024 * 1024;
/** More layers than any model has. Lines for further ones are counted and not added up, so the layer table cannot grow without bound. */
const MAX_PULL_LAYERS = 1024;
/** How much of a runtime's error text is kept as `detail`. */
const MAX_DETAIL_CHARS = 400;

/** Which runtime to ask. */
export interface OllamaTarget {
  /** `http://127.0.0.1:<port>`, without a trailing slash. */
  baseUrl: string;
  /** Default: the global `fetch`. */
  fetch?: typeof fetch;
}

// ---------- Plumbing ----------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A byte count or a token count as the runtime reports it: a finite number that is not negative. */
function asCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

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

/** The error text of a runtime answer: `{"error":"..."}` (its own routes) or `{"error":{"message":"..."}}` (the OpenAI routes). */
function errorOfBody(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const { error } = body;
  if (typeof error === 'string') return asString(error);
  if (isRecord(error)) return asString(error.message);
  return undefined;
}

/** The caller's signal joined with a deadline. */
function bounded(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

/** An answer of the runtime: its status and its body as JSON (`undefined` when it is not JSON). */
interface Answer {
  status: number;
  body: unknown;
  text: string;
}

/**
 * One bounded request. `undefined` when nothing answered (refused, timed out, aborted): the
 * caller looks at its own signal to tell an abort from the rest.
 */
async function ask(
  target: OllamaTarget,
  path: string,
  init: { method?: string; json?: unknown },
  timeoutMs: number,
  signal?: AbortSignal
): Promise<Answer | undefined> {
  const fetchFn = target.fetch ?? fetch;
  try {
    const res = await fetchFn(`${target.baseUrl}${path}`, {
      method: init.method ?? 'GET',
      ...(init.json !== undefined
        ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.json) }
        : {}),
      signal: bounded(signal, timeoutMs),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text === '' ? undefined : JSON.parse(text);
    } catch {
      body = undefined;
    }
    return { status: res.status, body, text };
  } catch {
    return undefined;
  }
}

/** A digest as it is stored and compared: lowercase hex without the `sha256:` prefix. */
function normalizeDigest(value: unknown): string {
  return typeof value === 'string'
    ? value
        .trim()
        .toLowerCase()
        .replace(/^sha256:/, '')
    : '';
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

/** The `models` array of a listing, or an empty one. */
function modelsOf(answer: Answer | undefined): Record<string, unknown>[] {
  if (!answer || answer.status !== 200 || !isRecord(answer.body)) return [];
  const { models } = answer.body;
  return Array.isArray(models) ? models.filter(isRecord) : [];
}

/** The runtime's version ('0.40.15'), or `undefined` when nothing answers there or the answer is not a runtime's. */
export async function getRuntimeVersion(target: OllamaTarget, signal?: AbortSignal): Promise<string | undefined> {
  const answer = await ask(target, '/api/version', {}, VERSION_TIMEOUT_MS, signal);
  if (!answer || answer.status !== 200 || !isRecord(answer.body)) return undefined;
  return asString(answer.body.version);
}

/** The models on disk. An empty list when the runtime has none or does not answer. */
export async function listTags(target: OllamaTarget, signal?: AbortSignal): Promise<OllamaTagModel[]> {
  const listed: OllamaTagModel[] = [];
  for (const row of modelsOf(await ask(target, '/api/tags', {}, LIST_TIMEOUT_MS, signal))) {
    const name = asString(row.name) ?? asString(row.model);
    if (!name) continue;
    const details = isRecord(row.details) ? row.details : {};
    const format = asString(details.format);
    const runner = asString(details.runner) ?? asString(row.runner);
    const capabilities = Array.isArray(row.capabilities)
      ? row.capabilities.filter((entry): entry is string => typeof entry === 'string')
      : undefined;
    listed.push({
      name,
      size: asCount(row.size) ?? 0,
      digest: normalizeDigest(row.digest),
      ...(format ? { format } : {}),
      ...(runner ? { runner } : {}),
      ...(capabilities ? { capabilities } : {}),
    });
  }
  return listed;
}

/** The models loaded right now. An empty list when none is or the runtime does not answer. */
export async function listRunning(target: OllamaTarget, signal?: AbortSignal): Promise<OllamaPsModel[]> {
  const listed: OllamaPsModel[] = [];
  for (const row of modelsOf(await ask(target, '/api/ps', {}, LIST_TIMEOUT_MS, signal))) {
    const name = asString(row.name) ?? asString(row.model);
    if (!name) continue;
    const digest = normalizeDigest(row.digest);
    listed.push({
      name,
      size: asCount(row.size) ?? 0,
      sizeVram: asCount(row.size_vram) ?? 0,
      contextLength: asCount(row.context_length) ?? 0,
      ...(digest ? { digest } : {}),
    });
  }
  return listed;
}

/** The model ids `GET /v1/models` lists, exactly as listed (the runtime answers `data: null` for none). */
export async function listOpenAiModels(target: OllamaTarget, signal?: AbortSignal): Promise<string[]> {
  const answer = await ask(target, '/v1/models', {}, LIST_TIMEOUT_MS, signal);
  if (!answer || answer.status !== 200 || !isRecord(answer.body)) return [];
  const { data } = answer.body;
  if (!Array.isArray(data)) return [];
  return data.flatMap((row) => (isRecord(row) && typeof row.id === 'string' && row.id !== '' ? [row.id] : []));
}

/** The digest `GET /api/tags` reports for `modelId`, or `undefined` when the model is not on disk. */
export async function readModelDigest(
  target: OllamaTarget,
  modelId: string,
  signal?: AbortSignal
): Promise<string | undefined> {
  const found = (await listTags(target, signal)).find((model) => model.name === modelId);
  return found && found.digest !== '' ? found.digest : undefined;
}

/** Deletes a model from the runtime's store. True when it is gone afterwards (also when it never was there). */
export async function deleteModel(target: OllamaTarget, modelId: string, signal?: AbortSignal): Promise<boolean> {
  const answer = await ask(
    target,
    '/api/delete',
    { method: 'DELETE', json: { model: modelId } },
    LIST_TIMEOUT_MS,
    signal
  );
  // 404 is the runtime's answer for a model it does not have.
  return answer !== undefined && (answer.status === 200 || answer.status === 404);
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
 * A line that is not JSON is skipped and still counted. A blank line is not a line.
 */
export function createPullParser(): PullParser {
  const decoder = new TextDecoder();
  // One entry per layer: what the layer's last line said. A model has a handful of layers.
  const layers = new Map<string, { total: number; completed: number }>();
  let pending = '';
  // True while a line longer than the limit is being skipped up to its line break.
  let skipping = false;
  let status: string | undefined;
  let succeeded = false;
  let error: string | undefined;
  let lines = 0;

  function line(text: string): void {
    const trimmed = text.trim();
    if (trimmed === '') return;
    lines += 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const failure = errorOfBody(parsed);
    if (failure !== undefined) {
      error ??= clip(failure);
      return;
    }
    const lineStatus = asString(parsed.status);
    if (lineStatus !== undefined) {
      status = lineStatus;
      if (lineStatus === 'success') succeeded = true;
    }
    const total = asCount(parsed.total);
    if (total === undefined) return;
    // A layer is named by its digest; a line without one by its status text.
    const key = asString(parsed.digest) ?? lineStatus;
    if (key === undefined) return;
    const known = layers.get(key);
    if (!known && layers.size >= MAX_PULL_LAYERS) return;
    // `completed` is absent until the layer's first bytes arrived: what was seen before stays.
    const completed = asCount(parsed.completed) ?? known?.completed ?? 0;
    layers.set(key, { total, completed: Math.min(completed, total) });
  }

  function feed(text: string): void {
    let rest = text;
    for (;;) {
      const breakAt = rest.indexOf('\n');
      if (breakAt < 0) break;
      const head = rest.slice(0, breakAt);
      rest = rest.slice(breakAt + 1);
      if (skipping) {
        // The end of the line that was too long: it was counted when it was dropped.
        skipping = false;
      } else {
        line(pending + head);
      }
      pending = '';
    }
    if (skipping) return;
    pending += rest;
    if (pending.length > MAX_PULL_LINE_CHARS) {
      pending = '';
      skipping = true;
      lines += 1;
    }
  }

  return {
    push(chunk) {
      feed(typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true }));
    },
    end() {
      feed(decoder.decode());
      if (!skipping && pending !== '') line(pending);
      pending = '';
      skipping = false;
    },
    snapshot() {
      let completedBytes = 0;
      let totalBytes = 0;
      for (const layer of layers.values()) {
        completedBytes += layer.completed;
        totalBytes += layer.total;
      }
      return {
        completedBytes,
        totalBytes,
        ...(status !== undefined ? { status } : {}),
        succeeded,
        ...(error !== undefined ? { error } : {}),
        lines,
      };
    },
  };
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

/** How one request of a pull ended. */
type PullAttempt =
  | { kind: 'success'; totalBytes: number }
  | { kind: 'cancelled' }
  | { kind: 'fatal'; code: 'model-not-found' | 'disk-full'; detail: string }
  | { kind: 'retry'; detail: string };

/**
 * What an error text of the runtime means for the pull. A model the registry does not have and
 * a full disk do not get better by asking again; everything else (a damaged download, a
 * dropped connection) may.
 */
function classifyPullError(text: string): PullAttempt {
  const detail = clip(text);
  if (/file does not exist|manifest unknown|manifest\b.*\bnot found|model\b.*\bnot found/i.test(text)) {
    return { kind: 'fatal', code: 'model-not-found', detail };
  }
  if (/no space left on device|disk (is )?full|not enough (free )?(disk )?space/i.test(text)) {
    return { kind: 'fatal', code: 'disk-full', detail };
  }
  return { kind: 'retry', detail };
}

/** A wait that ends early when the signal aborts. */
function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

/** One `POST /api/pull`, read to its end. */
async function pullOnce(target: OllamaTarget, modelId: string, options: PullOptions): Promise<PullAttempt> {
  const { signal, onProgress } = options;
  const now = options.now ?? Date.now;
  const fetchFn = target.fetch ?? fetch;
  let res: Response;
  try {
    res = await fetchFn(`${target.baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: modelId, stream: true }),
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    return signal?.aborted ? { kind: 'cancelled' } : { kind: 'retry', detail: errorText(err) };
  }

  const parser = createPullParser();
  // The speed is the bytes of the last few seconds: (when, how far) pairs, the oldest first.
  const samples: { at: number; completed: number }[] = [];
  let lastReport = Number.NEGATIVE_INFINITY;
  const report = (force: boolean): void => {
    if (!onProgress) return;
    const at = now();
    if (!force && at - lastReport < PULL_PROGRESS_INTERVAL_MS) return;
    const snap = parser.snapshot();
    // Before the first layer line there is no size to show.
    if (snap.totalBytes <= 0) return;
    lastReport = at;
    samples.push({ at, completed: snap.completedBytes });
    while (samples.length > 2 && at - samples[1].at >= PULL_SPEED_WINDOW_MS) samples.shift();
    const first = samples[0];
    const seconds = (at - first.at) / 1000;
    const moved = snap.completedBytes - first.completed;
    try {
      onProgress({
        completedBytes: snap.completedBytes,
        totalBytes: snap.totalBytes,
        ...(seconds > 0 && moved >= 0 ? { bytesPerSecond: Math.round(moved / seconds) } : {}),
      });
    } catch {
      // A display that fails must not fail the download.
    }
  };

  let streamError: string | undefined;
  try {
    if (res.body) {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        parser.push(chunk);
        report(false);
      }
    }
  } catch (err) {
    streamError = errorText(err);
  }
  // An abort ends the stream with an error too: it is a cancel, not a cut.
  if (signal?.aborted) return { kind: 'cancelled' };
  parser.end();
  const snap = parser.snapshot();

  if (snap.error !== undefined) return classifyPullError(snap.error);
  if (res.status !== 200) return classifyPullError(`The runtime answered ${res.status} to the pull`);
  if (!snap.succeeded) {
    return { kind: 'retry', detail: streamError ?? 'The download ended before the runtime reported success' };
  }
  report(true);
  if (snap.totalBytes > 0) return { kind: 'success', totalBytes: snap.totalBytes };
  // A pull of a model that was already complete may name no layer. The size is then what the
  // runtime lists for the model, which is the same figure a full pull reports as its total.
  const listed = (await listTags(target, signal)).find((model) => model.name === modelId);
  return { kind: 'success', totalBytes: listed?.size ?? 0 };
}

/** Pulls `modelId` and waits for the end. Resuming is calling it again. Never throws. */
export async function pullModel(target: OllamaTarget, modelId: string, options: PullOptions = {}): Promise<PullResult> {
  const { signal } = options;
  const retries =
    options.retries !== undefined && Number.isInteger(options.retries) && options.retries >= 0
      ? options.retries
      : PULL_RETRIES;
  const sleep = options.sleep ?? ((ms: number) => waitFor(ms, signal));
  let lastDetail: string | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) return { ok: false, code: 'cancelled' };
    if (attempt > 0) {
      await sleep(PULL_RETRY_DELAY_MS * 2 ** (attempt - 1));
      if (signal?.aborted) return { ok: false, code: 'cancelled' };
    }
    let outcome: PullAttempt;
    try {
      outcome = await pullOnce(target, modelId, options);
    } catch (err) {
      // Only an injected `fetch` or clock can throw here. It must not end the pull as a crash.
      outcome = { kind: 'retry', detail: errorText(err) };
    }
    if (outcome.kind === 'success') return { ok: true, totalBytes: outcome.totalBytes };
    if (outcome.kind === 'cancelled') return { ok: false, code: 'cancelled' };
    if (outcome.kind === 'fatal') return { ok: false, code: outcome.code, detail: outcome.detail };
    lastDetail = outcome.detail;
  }
  return { ok: false, code: 'pull-failed', ...(lastDetail !== undefined ? { detail: lastDetail } : {}) };
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
  return {
    model: modelId,
    messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
    reasoning_effort: 'none',
    max_tokens: CHAT_PROBE_MAX_TOKENS,
    temperature: 0,
    stream: false,
  };
}

/** A function tool of the tool probe, in the shape `/v1/chat/completions` takes. */
function probeTool(name: string, description: string, properties: Record<string, string>): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(properties).map(([key, about]) => [key, { type: 'string', description: about }])
        ),
        required: Object.keys(properties),
      },
    },
  };
}

/** The body of the tool probe: a `tools` array, `reasoning_effort: "none"`, `max_tokens: TOOL_PROBE_MAX_TOKENS`. Pure. */
export function buildToolProbeRequest(modelId: string): Record<string, unknown> {
  return {
    model: modelId,
    messages: [
      { role: 'system', content: 'You are a coding agent. Use the tools you are given to do what the user asks.' },
      { role: 'user', content: 'Read the file README.md and tell me what it says.' },
    ],
    // The three tools a coding agent always has. The task needs the first.
    tools: [
      probeTool('read_file', 'Read a file and return its content.', { path: 'The path of the file.' }),
      probeTool('write_file', 'Write a file.', { path: 'The path of the file.', content: 'The new content.' }),
      probeTool('run_command', 'Run a shell command and return its output.', { command: 'The command line.' }),
    ],
    reasoning_effort: 'none',
    max_tokens: TOOL_PROBE_MAX_TOKENS,
    temperature: 0,
    stream: false,
  };
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
  const model = models.find((entry) => entry.name === modelId);
  if (!model) return { ok: false, code: 'load-failed', detail: 'The runtime does not list the model as loaded' };
  if (model.size <= 0)
    return { ok: false, code: 'load-failed', detail: 'The runtime reports no size for the loaded model' };
  if (model.sizeVram !== model.size) {
    return {
      ok: false,
      code: 'does-not-fit',
      // A size a person reads: decimal GB, like every other size of this feature.
      detail: `${formatGb(model.sizeVram)} of ${formatGb(model.size)} GB of the model are on the GPU`,
    };
  }
  if (model.contextLength !== context) {
    return {
      ok: false,
      code: 'context-not-applied',
      detail: `The runtime reports a context of ${model.contextLength} tokens, not ${context}`,
    };
  }
  return { ok: true, loaded: { context: model.contextLength, sizeBytes: model.size, sizeVramBytes: model.sizeVram } };
}

/** Whether the arguments of a tool call are a JSON object: as text that parses to one, or already as one. */
function argumentsAreObject(value: unknown): boolean {
  if (isRecord(value)) return true;
  if (typeof value !== 'string') return false;
  try {
    return isRecord(JSON.parse(value));
  } catch {
    return false;
  }
}

/**
 * Judges the answer of the tool probe. Pure. `status` is the HTTP status, `body` the parsed
 * JSON (or `undefined` when it did not parse).
 *  - a tool call whose `arguments` parse as a JSON object: passed (when the answer holds
 *    several calls, every one must have a name and such arguments);
 *  - `finish_reason` is `length`: `probe-unfinished` (the token limit ended it, so it proves nothing);
 *  - any other answer of status 200: `no-tool-call`;
 *  - another status: `load-failed`.
 */
export function judgeToolProbe(
  status: number,
  body: unknown
): { ok: true } | { ok: false; code: VerifyFailureCode; detail?: string } {
  if (status !== 200) {
    const said = errorOfBody(body);
    return { ok: false, code: 'load-failed', detail: clip(said ?? `The runtime answered ${status}`) };
  }
  const choice = isRecord(body) && Array.isArray(body.choices) ? body.choices[0] : undefined;
  const message = isRecord(choice) && isRecord(choice.message) ? choice.message : undefined;
  const calls = message && Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (calls.length > 0) {
    const wellFormed = calls.every(
      (call) =>
        isRecord(call) &&
        isRecord(call.function) &&
        asString(call.function.name) !== undefined &&
        argumentsAreObject(call.function.arguments)
    );
    if (wellFormed) return { ok: true };
    return { ok: false, code: 'no-tool-call', detail: 'The model called a tool with arguments that are not JSON' };
  }
  if (isRecord(choice) && choice.finish_reason === 'length') {
    return { ok: false, code: 'probe-unfinished', detail: `The answer ended at ${TOOL_PROBE_MAX_TOKENS} tokens` };
  }
  const said = message ? asString(message.content) : undefined;
  return {
    ok: false,
    code: 'no-tool-call',
    detail: said ? clip(`The model answered in text: ${said}`) : 'The answer holds no tool call',
  };
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
  const cancelled: VerifyResult = { ok: false, code: 'cancelled' };
  if (signal?.aborted) return cancelled;

  // 1. The chat that loads the model. Its text is not read: only that it was answered.
  const chat = await ask(
    target,
    '/v1/chat/completions',
    { method: 'POST', json: buildChatProbeRequest(modelId) },
    CHAT_PROBE_TIMEOUT_MS,
    signal
  );
  if (signal?.aborted) return cancelled;
  if (!chat) return { ok: false, code: 'load-failed', detail: 'The runtime did not answer the first request' };
  if (chat.status !== 200) {
    return {
      ok: false,
      code: 'load-failed',
      detail: clip(errorOfBody(chat.body) ?? `The runtime answered ${chat.status}`),
    };
  }

  // 2. What the runtime says it loaded.
  const judged = judgeLoaded(await listRunning(target, signal), modelId, context);
  if (signal?.aborted) return cancelled;
  if (!judged.ok) return judged;

  // 3. One tool call.
  const probe = await ask(
    target,
    '/v1/chat/completions',
    { method: 'POST', json: buildToolProbeRequest(modelId) },
    TOOL_PROBE_TIMEOUT_MS,
    signal
  );
  if (signal?.aborted) return cancelled;
  if (!probe)
    return { ok: false, code: 'probe-unfinished', detail: 'The runtime did not answer the tool request in time' };
  const tool = judgeToolProbe(probe.status, probe.body);
  if (!tool.ok) return tool;
  return { ok: true, loaded: judged.loaded };
}
