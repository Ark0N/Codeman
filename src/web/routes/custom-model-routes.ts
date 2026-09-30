/**
 * @fileoverview Custom Model Endpoint Profiles CRUD + discovery
 * (docs/custom-model-endpoints-plan.md). Endpoints are machine-level infra,
 * like remote/docker hosts, so writes are admin-only in multi-user mode
 * (`case-routes.ts`'s `/api/remote-hosts` is the pattern this mirrors).
 *
 * Discovery (`POST /:id/discover-models`) fetches `${baseUrl}/v1/models`
 * through `webviewFetch()` (`webview-egress.ts`), the same guarded dispatcher
 * the web-tab proxy uses: `baseUrl` is refused at save time by the schema's
 * hostname check (link-local / cloud-metadata literals and names), and the
 * undici lookup hook refuses a name that RESOLVES into one of those ranges at
 * connect time, redirects included — a save-time hostname check alone would
 * let `models.example` resolve to 169.254.169.254 later. The endpoint is
 * admin-configured, so this is defence in depth rather than the only gate.
 */

import type { FastifyInstance, FastifyRequest } from 'fastify';
import { ApiErrorCode, createErrorResponse, type ApiResponse } from '../../types.js';
import { isAdmin, parseBody, readJsonConfig, SETTINGS_PATH } from '../route-helpers.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { getDataDir } from '../../config/instance.js';
import { isBlockedWebviewUrl } from '../webview-egress-policy.js';
import { egressBlockedReason, webviewFetch } from '../webview-egress.js';
import { CustomModelHostSchema } from '../schemas.js';
import { readCustomModelHosts, writeCustomModelHosts, type CustomModelHost } from '../../custom-model-hosts.js';
import type { CliEntry } from '../../config/cli-registry/types.js';

const CODEMAN_CONFIG_DIR = getDataDir();
const DISCOVER_TIMEOUT_MS = 8000;
const PROPS_TIMEOUT_MS = 5000;

/**
 * Claude Code's own system prompt + tool schemas cost roughly this many tokens on EVERY
 * request, before a single character of conversation history — confirmed live, twice, on
 * requests reporting `in:0 out:0` (the very first exchange) failing at ~36.4K tokens. No
 * `CLAUDE_CODE_MAX_CONTEXT_TOKENS` value fixes this: that setting only changes when Claude
 * Code decides to COMPACT conversation history, and there is no history yet on the first
 * message for it to trim. A model whose real context is below this floor will refuse
 * Claude Code's very first message outright, unconditionally.
 *
 * Set well above the ~36.4K actually measured — CLAUDE.md size, active MCP servers, and
 * enabled skills all add to a project's real baseline, so the observed figure is a floor
 * for THAT one workspace, not a ceiling for every one. Erring conservative here means a
 * borderline-safe model still gets warned about (the user can launch anyway), rather than
 * this floor missing a genuinely-too-small one because a smaller test project happened to
 * fit.
 */
export const CLAUDE_MIN_SAFE_CONTEXT_TOKENS = 40000;

/**
 * True when applying this model to this CLI is heading for a guaranteed first-message
 * failure per `CLAUDE_MIN_SAFE_CONTEXT_TOKENS` above. Gated on `contextLengthVar` (today,
 * only claude's registry entry declares one) rather than a hardcoded mode check: a CLI
 * with a small enough baseline of its own to never trip this would have no reason to
 * declare the field in the first place, so the check simply never applies to it.
 */
export function exceedsSafeContextFloor(
  entry: Pick<CliEntry, 'capabilities'>,
  contextLength: number | undefined,
  slotCount?: number,
  serverContext?: number
): boolean {
  const cap = entry.capabilities.customModelInjection;
  if (cap.kind !== 'env' || !cap.contextLengthVar) return false;
  if (typeof contextLength !== 'number') return false;
  if (contextLength < CLAUDE_MIN_SAFE_CONTEXT_TOKENS) return true;
  return perSlotContext(slotPoolContext(contextLength, serverContext), slotCount) < CLAUDE_MIN_SAFE_CONTEXT_TOKENS;
}

/**
 * The context the slots actually share. `contextLength` comes from the launch command and,
 * for llama-swap's `--fit-ctx`, is only the auto-fitter's FLOOR (the real context is at least
 * that), so when the server reported a larger figure through `/props` that one is the pool.
 * Never lower than `contextLength`: a smaller report cannot be right when the floor is
 * guaranteed, and this only ever keeps a warning from firing on a server with room to spare.
 */
export function slotPoolContext(contextLength: number, serverContext: number | undefined): number {
  return typeof serverContext === 'number' && Number.isFinite(serverContext) && serverContext > contextLength
    ? serverContext
    : contextLength;
}

/**
 * The context one request can rely on when the server runs `slotCount` parallel slots.
 * llama-server divides its context across `--parallel` slots (by default they share ONE
 * unified KV pool), and Claude Code sends concurrent requests: the main session plus every
 * parallel subagent, each carrying the full `CLAUDE_MIN_SAFE_CONTEXT_TOKENS` of its own
 * system prompt and tools. With N busy slots each request therefore gets roughly
 * `contextLength / N`, and once the pool is spent llama.cpp answers HTTP 500 "Context size
 * has been exceeded" (measured: 4 slots, ~131k pool, four simultaneous 40k-token requests
 * all failed; the same requests against one slot all succeeded). An unknown or single slot
 * count leaves the context whole.
 */
export function perSlotContext(contextLength: number, slotCount: number | undefined): number {
  const slots =
    typeof slotCount === 'number' && Number.isFinite(slotCount) && slotCount > 1 ? Math.floor(slotCount) : 1;
  return Math.floor(contextLength / slots);
}

function adminOnly(req: FastifyRequest, reply: { code: (n: number) => unknown }): ApiResponse<never> | null {
  if (!isMultiUserMode() || isAdmin(req)) return null;
  reply.code(403);
  return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Admin only in multi-user mode');
}

/**
 * `defaultModelId` names the model the Run-menu picker applies for this endpoint with
 * no further choice, so it must actually be one of the discovered `models` — a schema
 * `.refine()` can't see across the two fields the way this can, and would also run on
 * every unrelated field edit rather than only when either of these two changes.
 */
function invalidDefaultModel(host: Pick<CustomModelHost, 'defaultModelId' | 'models'>): ApiResponse<never> | null {
  if (host.defaultModelId === undefined) return null;
  if ((host.models ?? []).includes(host.defaultModelId)) return null;
  return createErrorResponse(
    ApiErrorCode.INVALID_INPUT,
    'defaultModelId must be one of the endpoint’s discovered models'
  );
}

/**
 * Never hand the stored credential back to the browser, on GET, POST or PUT
 * alike — the file is written 0600 precisely because it holds one. `apiKeySet`
 * is what lets the editor say "unchanged if left blank" without the client
 * ever holding the real value: `applyStoredApiKey()` below is the other half,
 * treating an absent key on PUT as "keep the stored one" rather than clearing
 * it, which is what makes never returning it survivable for the edit flow.
 */
function redactApiKey(host: CustomModelHost): Omit<CustomModelHost, 'apiKey'> & { apiKeySet: boolean } {
  const { apiKey, ...rest } = host;
  return { ...rest, apiKeySet: !!apiKey };
}

/**
 * A PUT body with no `apiKey` (or a blank one) means "leave it alone", never
 * "clear it": the editor never receives the real value to resend deliberately
 * unchanged (see redactApiKey), so the only way it can tell the two apart is
 * by omission. There is deliberately no way to CLEAR a key back to unset this
 * way — a pre-existing limitation, not something this changes.
 */
function applyStoredApiKey(incoming: CustomModelHost, existing: CustomModelHost): CustomModelHost {
  return incoming.apiKey ? incoming : { ...incoming, apiKey: existing.apiKey };
}

/**
 * `modelContextLengths`/`modelSlotCounts`/`modelSizesGB` are server-populated by discovery, never
 * user-entered, and PUT replaces the whole record — so merge them back in from the
 * stored host rather than trust whatever the editor's body carried (or omitted).
 * The editor only ever sends `models`/`lastDiscoveredAt` verbatim from its cached
 * copy; requiring it to also round-trip these two is exactly the kind of thing a
 * future caller forgets, same class of bug `applyStoredApiKey` exists to prevent.
 */
function applyDiscoveredFields(incoming: CustomModelHost, existing: CustomModelHost): CustomModelHost {
  return {
    ...incoming,
    modelContextLengths: existing.modelContextLengths,
    modelSlotCounts: existing.modelSlotCounts,
    modelServerContexts: existing.modelServerContexts,
    modelSizesGB: existing.modelSizesGB,
  };
}

function authHeaders(host: Pick<CustomModelHost, 'apiKey' | 'authStyle'>): Record<string, string> {
  const headers: Record<string, string> = {};
  const apiKey = host.apiKey?.trim();
  // Exactly ONE header, never both — see custom-model-hosts.ts's CustomModelAuthStyle
  // doc comment for why: sending both reliably HANGS some real servers.
  const style = host.authStyle ?? 'bearer';
  if (apiKey && style === 'bearer') headers.Authorization = `Bearer ${apiKey}`;
  if (apiKey && style === 'api-key') headers['api-key'] = apiKey;
  return headers;
}

export interface DiscoveryResult {
  models: string[];
  /** See `CustomModelHost.modelContextLengths` — only ever populated for models already loaded. */
  contextLengths: Record<string, number>;
  /** See `CustomModelHost.modelSlotCounts`; populated on the same loaded-models-only basis as `contextLengths`. */
  slotCounts: Record<string, number>;
  /** See `CustomModelHost.modelServerContexts`; only present for a model whose `/props` was probed. */
  serverContexts: Record<string, number>;
  /** See `CustomModelHost.modelSizesGB` — populated for every model whose own listing states one. */
  sizesGB: Record<string, number>;
}

/**
 * Best-effort: pulls a file size in GB out of a model's own `description`, when the
 * server states one. llama-swap writes `"Auto-discovered 16.35 GB - parameters
 * auto-fitted by llama.cpp"` for a model it found on disk itself; a hand-configured
 * profile's own description (e.g. `"General-purpose reasoning model, MoE CPU-offloaded."`)
 * has no such figure and correctly yields no estimate rather than a guess — there is no
 * separate "give me the file size" endpoint to fall back on.
 */
function parseSizeGB(description: unknown): number | undefined {
  if (typeof description !== 'string') return undefined;
  const match = /(\d+(?:\.\d+)?)\s*GB\b/i.exec(description);
  if (!match) return undefined;
  const size = Number(match[1]);
  return Number.isFinite(size) && size > 0 ? size : undefined;
}

/**
 * Best-effort: fetches `GET /props?model=<id>` (llama.cpp-native, llama-swap-proxied) for
 * ONE already-loaded model and pulls its `n_ctx` and `total_slots` out. Never called for a model that
 * isn't already loaded — see the caller and `CustomModelHost.modelContextLengths` for why
 * that's a hard safety requirement, not just a nicety: llama-swap treats this endpoint's
 * `?model=` as a routing hint, and asking it about an unloaded model risks triggering an
 * actual (slow, GPU-swapping) load as a side effect of what should be read-only discovery.
 * Any failure (unreachable, non-2xx, missing/malformed field) is swallowed — one model's
 * context length is a nice-to-have, never worth failing the whole discovery pass over.
 *
 * ⚠️ FALLBACK ONLY — confirmed live to be actively WRONG for a `--fit-ctx`-launched llama-
 * swap backend: `/props`'s `n_ctx` read 154112 for a model llama-swap itself had launched
 * with `--fit-ctx 16384` (visible in `/running`'s own `cmd`), and the real server then
 * refused a request at the real 16384-token limit — `n_ctx` here appears to report the
 * model's theoretical/trained maximum, not the runtime-configured one. `parseCtxFromCmd`
 * (below), which reads the actual launch flag `/running` reports, is the primary source;
 * this is only used when that parse comes up empty (no recognized flag in `cmd`, or `cmd`
 * itself unavailable).
 */
async function fetchServerProps(
  host: Pick<CustomModelHost, 'baseUrl'>,
  modelId: string,
  headers: Record<string, string>
): Promise<{ nCtx?: number; totalSlots?: number }> {
  try {
    const url = new URL(`${host.baseUrl.replace(/\/+$/, '')}/props`);
    url.searchParams.set('model', modelId);
    const res = await webviewFetch(url, { headers, signal: AbortSignal.timeout(PROPS_TIMEOUT_MS) });
    if (!res.ok) return {};
    const body = (await res.json()) as {
      n_ctx?: unknown;
      total_slots?: unknown;
      default_generation_settings?: { n_ctx?: unknown };
    };
    const nCtx = body.n_ctx ?? body.default_generation_settings?.n_ctx;
    const positive = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
    return { nCtx: positive(nCtx), totalSlots: positive(body.total_slots) };
  } catch {
    return {};
  }
}

/**
 * Parses the REAL configured context size out of llama-swap's own launch command for a
 * model (`/running`'s `cmd` field, e.g. `"llama-server -m ... --fit-ctx 16384 ..."`) —
 * the primary source for `modelContextLengths`, preferred over `/props`'s `n_ctx` (see
 * `fetchServerProps`'s own doc comment for why that field is unreliable here). Checks
 * `--fit-ctx` first (llama-swap's own auto-fit flag), then the plain llama.cpp
 * `-c`/`--ctx-size`/`--ctx_size` flags a hand-written launch command might use instead.
 * Returns `undefined` when `cmd` has none of these — not every launch command needs to
 * state one explicitly (llama.cpp has its own default), and guessing one would be worse
 * than the "no override applied" the caller already treats an unknown length as.
 */
function parseCtxFromCmd(cmd: unknown): number | undefined {
  if (typeof cmd !== 'string') return undefined;
  const match = /--fit-ctx\s+(\d+)/.exec(cmd) ?? /(?:^|\s)(?:-c|--ctx-size|--ctx_size)\s+(\d+)/.exec(cmd);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

/**
 * Parses an explicit `--parallel N` / `-np N` (or `--parallel=N`) out of a launch command.
 * Returns `undefined` when the command states none, including `-np -1` (llama.cpp's "pick
 * automatically"), because a llama-server started without it chooses the slot count itself
 * (4 on the build this was measured on) and only `/props`'s `total_slots` can say what it chose.
 */
function parseSlotsFromCmd(cmd: unknown): number | undefined {
  if (typeof cmd !== 'string') return undefined;
  const match = /(?:^|\s)(?:-np|--parallel)(?:\s+|=)(\d+)(?=\s|$)/.exec(cmd);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

async function discoverModels(
  host: Pick<CustomModelHost, 'baseUrl' | 'apiKey' | 'authStyle'>
): Promise<DiscoveryResult> {
  const headers = authHeaders(host);
  const res = await webviewFetch(new URL(`${host.baseUrl.replace(/\/+$/, '')}/v1/models`), {
    headers,
    signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as {
    data?: Array<{ id?: unknown; status?: { value?: unknown }; description?: unknown }>;
  };
  const entries = body.data ?? [];
  const models = entries.map((m) => m.id).filter((id): id is string => typeof id === 'string' && id.length > 0);

  const sizesGB: Record<string, number> = {};
  for (const entry of entries) {
    if (typeof entry.id !== 'string' || !entry.id) continue;
    const size = parseSizeGB(entry.description);
    if (size !== undefined) sizesGB[entry.id] = size;
  }

  // llama-swap-specific, feature-detected: a server that never mentions `status` on ANY
  // entry gets no context-length enrichment at all, rather than treating "no status field"
  // as "assume unloaded" — either reading is a guess, and skipping is the safe one, since
  // fetchContextLength must only ever run against a model this server itself calls loaded.
  const hasStatusField = entries.some((m) => m && typeof m === 'object' && 'status' in m);
  const contextLengths: Record<string, number> = {};
  const slotCounts: Record<string, number> = {};
  const serverContexts: Record<string, number> = {};
  if (hasStatusField) {
    const loadedIds = entries
      .filter((m) => m.status && typeof m.status === 'object' && (m.status as { value?: unknown }).value === 'loaded')
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    if (loadedIds.length > 0) {
      // Primary source: the REAL launch command (see parseCtxFromCmd's own doc comment
      // for why /props's n_ctx cannot be trusted here). One /running call covers every
      // loaded model, so this never costs more requests than the old /props-only path did
      // when the cmd parse succeeds, and exactly one extra when it has to fall back.
      const swapStatus = await getLlamaSwapStatus(host);
      const cmdById = new Map(swapStatus.running.map((r) => [r.model, r.cmd]));
      for (const id of loadedIds) {
        const cmd = cmdById.get(id);
        let ctx = parseCtxFromCmd(cmd);
        let slots = parseSlotsFromCmd(cmd);
        // /props is only needed for whatever the launch command did not answer. The context
        // still comes from the command whenever it states one (see fetchServerProps's doc
        // comment for why /props's n_ctx is only a fallback); the slot count usually cannot
        // come from the command at all, since an unset --parallel is chosen by the server.
        if (ctx === undefined || slots === undefined) {
          const props = await fetchServerProps(host, id, headers);
          if (props.nCtx !== undefined) serverContexts[id] = props.nCtx;
          ctx ??= props.nCtx;
          slots ??= props.totalSlots;
        }
        if (ctx !== undefined) contextLengths[id] = ctx;
        if (slots !== undefined) slotCounts[id] = slots;
      }
    }
  }
  return { models, contextLengths, slotCounts, serverContexts, sizesGB };
}

/**
 * undici reports every network failure as `TypeError('fetch failed', { cause })`, with the
 * useful part (`connect ECONNREFUSED 127.0.0.1:8080`) one level down; surface the deepest
 * message so the user sees the refused connection, not the wrapper.
 */
function describeFetchError(err: unknown): string {
  let message = err instanceof Error ? err.message : String(err);
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error && current.cause !== undefined; depth++) {
    current = current.cause;
    if (current instanceof Error && current.message) message = current.message;
  }
  return message;
}

type RedactedHost = ReturnType<typeof redactApiKey>;

/**
 * Merges a fresh `GET /v1/models` result into a host record: stamps
 * `lastDiscoveredAt`, and drops `defaultModelId` if it no longer appears in
 * the fresh list (it would otherwise leave the Run-menu picker applying a
 * model id the endpoint just told us it doesn't serve). Pure — no IO, so the
 * manual route (which reports a fetch failure's *reason* to the caller) and
 * the periodic sweep below (which only cares whether it can move on) can
 * each do their own `discoverModels()` + error handling around one shared
 * "how to apply a successful result" step.
 */
const RUNNING_TIMEOUT_MS = 5000;

export interface LlamaSwapRunningModel {
  model: string;
  state: string;
  /** The actual launch command llama-swap started this backend with, when it says one —
   *  see `parseCtxFromCmd`, which reads the real configured context size out of this. */
  cmd?: string;
}

export interface LlamaSwapStatus {
  /**
   * Feature-detected via `GET /running`: true only when the server answered with
   * llama-swap's own shape (`{ running: [...] }`). Plain llama.cpp (and any other
   * OpenAI-compatible server) has no such endpoint and always runs the single model
   * it was started with, so there is no "current model" to conflict with — every
   * caller must treat `isLlamaSwap: false` as "nothing to check", never as an error.
   */
  isLlamaSwap: boolean;
  running: LlamaSwapRunningModel[];
}

/**
 * Distinguishes llama-swap from a plain llama.cpp/OpenAI-compatible server, and reports
 * what llama-swap currently has loaded — llama.cpp only ever runs one GGUF at a time, and
 * llama-swap unloads/reloads it on demand when a request asks for a different one, which
 * can take anywhere from a few seconds to over a minute. Read-only: this never triggers a
 * swap itself (unlike `/props?model=`, `/running` takes no `model` parameter to route by).
 * Best-effort like `discoverModels()`'s siblings: any failure (unreachable, non-2xx,
 * unexpected shape) reads as "not llama-swap", never thrown.
 */
export async function getLlamaSwapStatus(
  host: Pick<CustomModelHost, 'baseUrl' | 'apiKey' | 'authStyle'>
): Promise<LlamaSwapStatus> {
  try {
    const res = await webviewFetch(new URL(`${host.baseUrl.replace(/\/+$/, '')}/running`), {
      headers: authHeaders(host),
      signal: AbortSignal.timeout(RUNNING_TIMEOUT_MS),
    });
    if (!res.ok) return { isLlamaSwap: false, running: [] };
    const body = (await res.json()) as { running?: unknown };
    if (!Array.isArray(body.running)) return { isLlamaSwap: false, running: [] };
    const running = body.running
      .filter(
        (r): r is { model: string; state?: unknown; cmd?: unknown } =>
          !!r && typeof r === 'object' && typeof (r as { model?: unknown }).model === 'string'
      )
      .map((r) => ({
        model: r.model,
        state: typeof r.state === 'string' ? r.state : 'unknown',
        cmd: typeof r.cmd === 'string' ? r.cmd : undefined,
      }));
    return { isLlamaSwap: true, running };
  } catch {
    return { isLlamaSwap: false, running: [] };
  }
}

interface LlamaSwapLogTail {
  latestLine?: string;
  lastAccessedAt: number;
  controller: AbortController;
}

/** One open `/api/events` tail per endpoint, keyed by host id — see `getLatestLlamaSwapLogLine`. */
const llamaSwapLogTails = new Map<string, LlamaSwapLogTail>();

/** A tail nothing has asked about in this long is closed by the next `pruneIdleLlamaSwapLogTails` sweep. */
const LOG_TAIL_IDLE_MS = 30_000;

/**
 * Parses one `data: {...}` payload from llama-swap's `GET /api/events` SSE stream and
 * returns the backend (never llama-swap's own proxy) log text it carries, or `undefined`
 * for anything else (a different event `type`, a malformed frame, a proxy-sourced one).
 *
 * The real shape, confirmed live against a real llama-swap deployment — NOT documented
 * anywhere the plan doc's original research found, and genuinely surprising the first
 * time around: `GET /logs` (the endpoint that name suggests, and this feature's own
 * first cut was built against) turns out to carry ONLY llama-swap's own proxy
 * request-access log — it never once showed a single backend line even seconds after a
 * real, confirmed model swap. The backend llama-server process's actual stdout
 * (`load_model: ...`, `llama_server: model loaded`) only ever showed up in `/api/events`,
 * as `{"type":"logData","data":"<JSON-string>"}` whose OWN `data` field parses to a
 * second object, `{"data": "<newline-joined log text>", "source": "proxy" | "upstream"}`
 * — `source` is the exact, explicit distinguisher (`upstream` = the backend process,
 * `proxy` = llama-swap's own line), not a guessed regex against the text itself.
 */
function parseBackendLogDataEvent(dataLine: string): string | undefined {
  let outer: unknown;
  try {
    outer = JSON.parse(dataLine);
  } catch {
    return undefined;
  }
  if (
    !outer ||
    typeof outer !== 'object' ||
    (outer as { type?: unknown }).type !== 'logData' ||
    typeof (outer as { data?: unknown }).data !== 'string'
  ) {
    return undefined;
  }
  let inner: unknown;
  try {
    inner = JSON.parse((outer as { data: string }).data);
  } catch {
    return undefined;
  }
  if (
    !inner ||
    typeof inner !== 'object' ||
    (inner as { source?: unknown }).source !== 'upstream' ||
    typeof (inner as { data?: unknown }).data !== 'string'
  ) {
    return undefined;
  }
  return (inner as { data: string }).data;
}

/**
 * Reads `GET /api/events` forever (until `entry.controller` aborts it), updating
 * `entry.latestLine` with the most recent BACKEND log line seen (see
 * `parseBackendLogDataEvent`). Fire-and-forget: the caller never awaits this — it runs
 * for the tail's whole lifetime in the background, and `getLatestLlamaSwapLogLine` just
 * reads whatever `entry.latestLine` currently holds. SSE frames are separated by a blank
 * line (`\n\n`), buffered the same way `/running`'s NDJSON-shaped siblings buffer partial
 * chunks — a frame split across two `reader.read()` calls must not be parsed early.
 */
/**
 * Cap on the unparsed remainder held between reads of the backend log stream. One
 * SSE frame is a status line, so this is orders of magnitude more than a real frame
 * needs; it exists so a server that never emits a frame boundary cannot grow the
 * buffer without bound for the life of the connection.
 */
const MAX_LOG_TAIL_BUFFER_CHARS = 64 * 1024;

async function pumpLlamaSwapLogTail(
  host: Pick<CustomModelHost, 'id' | 'baseUrl' | 'apiKey' | 'authStyle'>,
  entry: LlamaSwapLogTail
): Promise<void> {
  try {
    const res = await webviewFetch(new URL(`${host.baseUrl.replace(/\/+$/, '')}/api/events`), {
      headers: authHeaders(host),
      signal: entry.controller.signal,
    });
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      // The remainder only shrinks at a frame boundary, so a server that streams
      // without `\n\n` (or one very long frame) would grow it for as long as the
      // connection is held, which is indefinitely by design. Past the cap the
      // partial frame cannot become a useful log line anyway, so drop it and
      // resynchronise on the next boundary rather than buffering forever.
      if (buffer.length > MAX_LOG_TAIL_BUFFER_CHARS) buffer = '';
      for (const frame of frames) {
        const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
        if (!dataLine) continue;
        const backendText = parseBackendLogDataEvent(dataLine.slice('data:'.length));
        if (!backendText) continue;
        const lines = backendText.split('\n').filter((l) => l.trim());
        if (lines.length > 0) entry.latestLine = lines[lines.length - 1]!.trim();
      }
    }
  } catch {
    // connection dropped / aborted / endpoint unreachable — a future access starts fresh
  } finally {
    // Delete by IDENTITY, not just by key: an aborted pump can finish after a NEWER
    // entry was already created for the same endpoint id (e.g. abort-then-immediately-
    // re-request), and deleting unconditionally would remove that newer entry and orphan
    // its connection — nothing would ever prune it, since pruneIdleLlamaSwapLogTails only
    // walks entries still present in the map.
    if (llamaSwapLogTails.get(host.id) === entry) {
      llamaSwapLogTails.delete(host.id);
    }
  }
}

/**
 * Real-time "what is llama.cpp actually doing right now" for the loading banner
 * (docs/custom-model-endpoints-plan.md): llama-swap's `GET /api/events` SSE stream
 * carries the backend llama-server process's own stdout — `load_model: loading model
 * '<path>'`, `load_model: initializing, n_slots = N, n_ctx_slot = N`, `llama_server:
 * model loaded`, etc — tagged `source: "upstream"`, distinct from llama-swap's own
 * `source: "proxy"` request-access lines (see `parseBackendLogDataEvent`). Confirmed
 * live against a real llama-swap deployment, including through an actual forced model
 * swap end-to-end.
 *
 * Held OPEN per endpoint rather than re-opened on every 1s poll — confirmed live to stay
 * open indefinitely (read past 220KB over 8 seconds with no `done`), unlike `/logs`
 * (see `parseBackendLogDataEvent`'s doc comment), so reconnecting each poll would be
 * pure waste. One connection is reused across every session currently watching a load on
 * that endpoint; since llama.cpp/llama-swap only ever runs one model at a time, a line
 * seen while a load is in flight is safe to attribute to that load (a deployment that
 * could load several models concurrently would need a per-model tag this format doesn't
 * provide).
 *
 * Lazily started on first access and idle-closed rather than left open forever — see
 * `pruneIdleLlamaSwapLogTails`.
 */
export function getLatestLlamaSwapLogLine(
  host: Pick<CustomModelHost, 'id' | 'baseUrl' | 'apiKey' | 'authStyle'>
): string | undefined {
  let entry = llamaSwapLogTails.get(host.id);
  if (!entry) {
    entry = { lastAccessedAt: Date.now(), controller: new AbortController() };
    llamaSwapLogTails.set(host.id, entry);
    void pumpLlamaSwapLogTail(host, entry);
  }
  entry.lastAccessedAt = Date.now();
  return entry.latestLine;
}

/**
 * Closes EVERY open log tail. The idle sweep above only runs on server.ts's periodic
 * interval, and that interval is disposed on shutdown, so without this an outbound
 * stream outlives `WebServer.stop()` against CLAUDE.md's "clear Maps in stop()" rule.
 * Harmless today only because `cli.ts`'s shutdown handler reaches `process.exit(0)`,
 * which is not a property to rely on: tests and any in-process restart do not.
 */
export function closeAllLlamaSwapLogTails(): void {
  for (const entry of llamaSwapLogTails.values()) entry.controller.abort();
  llamaSwapLogTails.clear();
}

/**
 * Closes any log tail nothing has called `getLatestLlamaSwapLogLine` about in
 * `LOG_TAIL_IDLE_MS` — a stream nobody is polling is an open connection with nothing to
 * show for it. Called from the same periodic sweep as `detectCustomModelSwapDisplacements`
 * in server.ts, not its own timer.
 */
export function pruneIdleLlamaSwapLogTails(now = Date.now()): void {
  for (const [id, entry] of llamaSwapLogTails) {
    if (now - entry.lastAccessedAt > LOG_TAIL_IDLE_MS) {
      entry.controller.abort();
      llamaSwapLogTails.delete(id);
    }
  }
}

/**
 * Actually kicks off llama-swap's lazy model load, rather than waiting for the launched
 * CLI's own first prompt to do it. llama-swap has no separate "switch model" admin
 * endpoint — the ONLY thing that starts a swap is a real inference request naming the
 * model (confirmed live: applying a selection alone never appeared in the llama-swap
 * server's own logs; nothing had actually asked it to load anything). This sends the
 * smallest real request that will — `max_tokens: 1`, one throwaway user message — to
 * `${baseUrl}/v1/chat/completions`, the OpenAI-compatible endpoint every supported
 * harness already points at.
 *
 * Deliberately fire-and-forget: the caller (the apply/create routes) returns to the
 * client immediately, and the frontend's own polling (`GET .../running-status`) is what
 * actually confirms readiness — this call's response is never read, just its side
 * effect. No abort/timeout of its own either: a real load can take well over a minute for
 * a large model, and this is a normal long-running Node process, so there is nothing to
 * clean up by cutting it short. Errors are swallowed for the same reason `discoverModels`'s
 * siblings swallow theirs — one endpoint's hiccup here is a nice-to-have that failed, not
 * something worth surfacing as a request failure four layers up.
 */
export function triggerLlamaSwapLoad(
  host: Pick<CustomModelHost, 'baseUrl' | 'apiKey' | 'authStyle'>,
  modelId: string
): void {
  const url = new URL(`${host.baseUrl.replace(/\/+$/, '')}/v1/chat/completions`);
  webviewFetch(url, {
    method: 'POST',
    headers: { ...authHeaders(host), 'content-type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: 'Hi' }],
      max_tokens: 1,
      stream: false,
    }),
  }).catch(() => {
    // best-effort — see the doc comment above
  });
}

function applyDiscoveredModels(host: CustomModelHost, result: DiscoveryResult): CustomModelHost {
  const { models, contextLengths, slotCounts, serverContexts, sizesGB } = result;
  const defaultModelId = host.defaultModelId && models.includes(host.defaultModelId) ? host.defaultModelId : undefined;
  // Merge onto what's already known rather than replacing: a model not probed this round
  // (not currently loaded) keeps whatever context length an earlier round already learned
  // for it, and one no longer in the fresh list is dropped, same reasoning as defaultModelId.
  const merged = { ...host.modelContextLengths, ...contextLengths };
  const kept = Object.fromEntries(Object.entries(merged).filter(([id]) => models.includes(id)));
  const modelContextLengths = Object.keys(kept).length > 0 ? kept : undefined;
  // Slot counts follow the same loaded-only, keep-what-an-earlier-round-learned rule.
  const mergedSlots = { ...host.modelSlotCounts, ...slotCounts };
  const keptSlots = Object.fromEntries(Object.entries(mergedSlots).filter(([id]) => models.includes(id)));
  const modelSlotCounts = Object.keys(keptSlots).length > 0 ? keptSlots : undefined;
  const mergedServer = { ...host.modelServerContexts, ...serverContexts };
  const keptServer = Object.fromEntries(Object.entries(mergedServer).filter(([id]) => models.includes(id)));
  const modelServerContexts = Object.keys(keptServer).length > 0 ? keptServer : undefined;
  // sizesGB, unlike contextLengths, is populated for every model in the SAME pass (no
  // loaded-only restriction — see parseSizeGB), so this is closer to a plain replace, but
  // still merges onto the previous round rather than dropping a size for a model whose
  // description happened to omit the figure on this particular pass.
  const mergedSizes = { ...host.modelSizesGB, ...sizesGB };
  const keptSizes = Object.fromEntries(Object.entries(mergedSizes).filter(([id]) => models.includes(id)));
  const modelSizesGB = Object.keys(keptSizes).length > 0 ? keptSizes : undefined;
  return {
    ...host,
    models,
    defaultModelId,
    modelContextLengths,
    modelSlotCounts,
    modelServerContexts,
    modelSizesGB,
    lastDiscoveredAt: new Date().toISOString(),
  };
}

/**
 * `customModelEndpointsEnabled` defaults OFF (unlike `showPlanUsageLimits`'s
 * absent-means-on in `readPlanUsageTelemetryEnabled`), so mirror the frontend's
 * own gate (`session-ui.js`'s `!settings.customModelEndpointsEnabled`) rather
 * than that reader's default. Exists so the periodic re-discovery sweep in
 * server.ts can skip entirely while the feature is off, instead of polling
 * every saved endpoint forever regardless of the setting.
 */
export async function readCustomModelEndpointsEnabled(): Promise<boolean> {
  const settings = await readJsonConfig<Record<string, unknown>>(SETTINGS_PATH, 'settings.json', {});
  return settings.customModelEndpointsEnabled === true;
}

/**
 * Re-discovers every saved endpoint's models, best-effort. One endpoint being
 * unreachable (powered off, wrong network) must not stop the others from
 * refreshing, and a read-modify-write per host (rather than one batch write
 * at the end) means a crash or restart mid-sweep loses at most the endpoints
 * not yet reached, never a write already applied. Exported so both the
 * periodic timer (server.ts) and a test can drive it directly.
 */
export async function refreshAllCustomModelHosts(): Promise<void> {
  const dataDir = getDataDir();
  const hosts = await readCustomModelHosts(dataDir);
  for (const host of hosts) {
    if (isBlockedWebviewUrl(host.baseUrl)) continue;
    let result: DiscoveryResult;
    try {
      result = await discoverModels(host);
    } catch {
      continue; // unreachable this cycle — try again next tick, not fatal to the sweep
    }
    // Re-read + splice by id rather than reusing the array captured above: an
    // admin editing or deleting an endpoint via the API mid-sweep must win,
    // not be silently overwritten by a refresh that started before their change.
    const current = await readCustomModelHosts(dataDir);
    const index = current.findIndex((item) => item.id === host.id);
    if (index === -1) continue; // deleted mid-sweep
    current[index] = applyDiscoveredModels(current[index], result);
    await writeCustomModelHosts(dataDir, current);
  }
}

/** The subset of `Session` this sweep needs — kept minimal so a test can pass a plain object. */
export interface CustomModelSessionLike {
  id: string;
  name: string;
  customModel?: { endpointId: string; modelId: string; label?: string };
}

/** One session whose model was just found evicted, ready to broadcast as `CustomModelSwappedOut`. */
export interface CustomModelSwapDisplacement {
  sessionId: string;
  sessionName: string;
  endpointId: string;
  previousModel: string;
  currentlyLoadedModel: string;
}

/**
 * Detects when a live session's own custom-model selection is no longer the model
 * llama-swap actually has loaded — evicted by ANOTHER session's activity on the same
 * endpoint, since llama.cpp/llama-swap runs one model at a time (the apply/create routes'
 * own swap-conflict check only ever runs at THAT session's own launch/apply moment, so it
 * cannot catch a later eviction triggered by a different session's normal use — confirmed
 * live: a session created while nothing else had a live conflict at that instant can still
 * get silently displaced afterward). Read-only, and best-effort per endpoint exactly like
 * `refreshAllCustomModelHosts`'s sibling sweep — one endpoint's hiccup here never blocks
 * checking the others.
 *
 * `notifiedSessionIds` is the caller's own de-dupe state (`server.ts` keeps one `Set` across
 * sweeps), mutated in place: a session id is added once displaced and removed again once its
 * own model is loaded and ready — so a LATER, genuinely new displacement can notify again
 * rather than the session staying silently un-notified forever after the first one.
 */
export async function detectCustomModelSwapDisplacements(
  sessions: Iterable<CustomModelSessionLike>,
  notifiedSessionIds: Set<string>
): Promise<CustomModelSwapDisplacement[]> {
  const byEndpoint = new Map<string, CustomModelSessionLike[]>();
  for (const session of sessions) {
    if (!session.customModel) continue;
    const group = byEndpoint.get(session.customModel.endpointId);
    if (group) group.push(session);
    else byEndpoint.set(session.customModel.endpointId, [session]);
  }
  if (byEndpoint.size === 0) return [];

  const hosts = await readCustomModelHosts(getDataDir());
  const displacements: CustomModelSwapDisplacement[] = [];

  for (const [endpointId, group] of byEndpoint) {
    const host = hosts.find((h) => h.id === endpointId);
    if (!host) continue; // endpoint deleted since these sessions were created — nothing to check
    let status: LlamaSwapStatus;
    try {
      status = await getLlamaSwapStatus(host);
    } catch {
      continue; // unreachable this cycle — try again next tick, not fatal to the sweep
    }
    // Not llama-swap (feature-detected) or nothing loaded at all: nothing has been evicted,
    // by construction — a plain llama.cpp/OpenAI-compatible server only ever runs the one
    // model it was started with, so there is no "current model" to conflict with.
    if (!status.isLlamaSwap || status.running.length === 0) continue;
    const currentlyLoaded = status.running.find((r) => r.state === 'ready')?.model ?? status.running[0]?.model;
    if (!currentlyLoaded) continue;

    for (const session of group) {
      const modelId = session.customModel!.modelId;
      const stillLoaded = status.running.some((r) => r.model === modelId);
      if (stillLoaded) {
        notifiedSessionIds.delete(session.id); // back to normal — a future eviction can notify again
        continue;
      }
      if (notifiedSessionIds.has(session.id)) continue; // already told them once for this displacement
      notifiedSessionIds.add(session.id);
      displacements.push({
        sessionId: session.id,
        sessionName: session.name,
        endpointId,
        previousModel: modelId,
        currentlyLoadedModel: currentlyLoaded,
      });
    }
  }
  return displacements;
}

export function registerCustomModelRoutes(app: FastifyInstance): void {
  app.get('/api/model-endpoints', async (req): Promise<RedactedHost[]> => {
    if (isMultiUserMode() && !isAdmin(req)) return [];
    const hosts = await readCustomModelHosts(CODEMAN_CONFIG_DIR);
    return hosts.map(redactApiKey);
  });

  app.post('/api/model-endpoints', async (req, reply): Promise<ApiResponse<{ host: RedactedHost }>> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const host = parseBody(CustomModelHostSchema, req.body);
    if (isBlockedWebviewUrl(host.baseUrl)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Endpoint base URL is not allowed');
    }
    const badDefault = invalidDefaultModel(host);
    if (badDefault) return badDefault;
    const hosts = await readCustomModelHosts(CODEMAN_CONFIG_DIR);
    if (hosts.some((item) => item.id === host.id)) {
      return createErrorResponse(ApiErrorCode.ALREADY_EXISTS, 'Model endpoint already exists');
    }
    await writeCustomModelHosts(CODEMAN_CONFIG_DIR, [...hosts, host]);
    return { success: true, data: { host: redactApiKey(host) } };
  });

  app.put('/api/model-endpoints/:id', async (req, reply): Promise<ApiResponse<{ host: RedactedHost }>> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const { id } = req.params as { id: string };
    const incoming = parseBody(CustomModelHostSchema, { ...(req.body as object), id });
    if (isBlockedWebviewUrl(incoming.baseUrl)) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Endpoint base URL is not allowed');
    }
    const badDefault = invalidDefaultModel(incoming);
    if (badDefault) return badDefault;
    const hosts = await readCustomModelHosts(CODEMAN_CONFIG_DIR);
    const index = hosts.findIndex((item) => item.id === id);
    if (index === -1) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Model endpoint not found');
    const host = applyDiscoveredFields(applyStoredApiKey(incoming, hosts[index]), hosts[index]);
    const next = [...hosts];
    next[index] = host;
    await writeCustomModelHosts(CODEMAN_CONFIG_DIR, next);
    return { success: true, data: { host: redactApiKey(host) } };
  });

  app.delete('/api/model-endpoints/:id', async (req, reply): Promise<ApiResponse<{ id: string }>> => {
    const denied = adminOnly(req, reply);
    if (denied) return denied;
    const { id } = req.params as { id: string };
    const hosts = await readCustomModelHosts(CODEMAN_CONFIG_DIR);
    await writeCustomModelHosts(
      CODEMAN_CONFIG_DIR,
      hosts.filter((item) => item.id !== id)
    );
    return { success: true, data: { id } };
  });

  app.post(
    '/api/model-endpoints/:id/discover-models',
    async (req, reply): Promise<ApiResponse<{ models: string[] }>> => {
      const denied = adminOnly(req, reply);
      if (denied) return denied;
      const { id } = req.params as { id: string };
      const hosts = await readCustomModelHosts(CODEMAN_CONFIG_DIR);
      const index = hosts.findIndex((item) => item.id === id);
      if (index === -1) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Model endpoint not found');
      const host = hosts[index];
      if (isBlockedWebviewUrl(host.baseUrl)) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Endpoint base URL is not allowed');
      }
      try {
        const result = await discoverModels(host);
        const next = [...hosts];
        next[index] = applyDiscoveredModels(host, result);
        await writeCustomModelHosts(CODEMAN_CONFIG_DIR, next);
        return { success: true, data: { models: result.models } };
      } catch (err) {
        const blocked = egressBlockedReason(err);
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          blocked ? `Endpoint refused: ${blocked}` : `Could not reach endpoint: ${describeFetchError(err)}`
        );
      }
    }
  );

  // Read-only, no admin gate: any session owner who can already point their own session
  // at this endpoint (POST .../custom-model, ungated by design — see session-routes.ts)
  // can equally ask what it currently has loaded, before or while that apply is pending.
  app.get(
    '/api/model-endpoints/:id/running-status',
    async (
      req
    ): Promise<
      ApiResponse<{
        isLlamaSwap: boolean;
        running: Array<Pick<LlamaSwapRunningModel, 'model' | 'state'>>;
        logLine?: string;
      }>
    > => {
      const { id } = req.params as { id: string };
      const hosts = await readCustomModelHosts(CODEMAN_CONFIG_DIR);
      const host = hosts.find((item) => item.id === id);
      if (!host) return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Model endpoint not found');
      if (isBlockedWebviewUrl(host.baseUrl)) {
        return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Endpoint base URL is not allowed');
      }
      const status = await getLlamaSwapStatus(host);
      // Only worth tailing /api/events once llama-swap is actually confirmed — a plain
      // llama.cpp/OpenAI-compatible server has no such endpoint at all.
      const logLine = status.isLlamaSwap ? getLatestLlamaSwapLogLine(host) : undefined;
      // `cmd` (the literal llama-server launch line, which can carry model paths and
      // --api-key) exists only so parseCtxFromCmd() can read it server-side during
      // discovery — this un-gated, polled-every-second route has no reason to hand it
      // to the browser, which only ever reads `model`/`state`.
      const running = status.running.map(({ model, state }) => ({ model, state }));
      return { success: true, data: { isLlamaSwap: status.isLlamaSwap, running, logLine } };
    }
  );
}
