/**
 * @fileoverview `codeman mcp`: a Model Context Protocol server on stdio, so any MCP
 * client (Claude Code, Claude Desktop, Codex, Gemini CLI, Cursor, ...) can start Codeman
 * sessions in any installed agent CLI, prompt them, wait for them, read their answers
 * and clean up.
 *
 * A CLIENT of the HTTP API, like `codeman agent` (src/cli-agent.ts), whose transport and
 * guards it reuses: no new route, no second server transport (the agent-control plan's
 * "Socket API" non-goal stands), auth and ownership unchanged.
 *
 * Protocol: dual-era, per the 2026-07-28 revision. A legacy client opens with
 * `initialize` (revisions 2025-11-25 and earlier) and is served that way; a modern client
 * sends per-request `_meta` (`io.modelcontextprotocol/protocolVersion` and
 * `.../clientCapabilities`) and may probe with `server/discover`. Messages are
 * newline-delimited JSON-RPC on stdin/stdout; stdout carries protocol messages ONLY,
 * every log line goes to stderr.
 *
 * Invariants (each asserted in test/mcp-server.test.ts):
 * 1. Never guesses a server: the URL comes from `--url` or `CODEMAN_API_URL`. Without
 *    one the server still starts and lists its tools (registries introspect that way),
 *    and every tool call answers with how to configure it.
 * 2. Prompting, interrupting and deleting are limited to sessions this process started,
 *    or (inside a Codeman session) sessions that session spawned, unless the user passed
 *    `--allow-any-session`. Listing, reading and waiting are open. The allowlist lives
 *    in process memory on purpose: a restart forgets it, which fails CLOSED.
 * 3. Never acts on its own session (inside Codeman), never sends a control byte
 *    (`inputRefusal`), and keeps a wait under the client's tool timeout by default
 *    (45 s; Codex's MCP default is 60 s), with a 600 s ceiling.
 * 4. A failed tool is a result with `isError: true`, which the model can act on;
 *    JSON-RPC errors are for protocol faults only.
 *
 * @module mcp-server
 */
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import {
  buildInterruptBody,
  buildSendBody,
  composerReadyMark,
  describeFailure,
  httpRequest,
  inputRefusal,
  isSelfSession,
  MIN_ID_PREFIX_LENGTH,
  stripAnsi,
  type AgentContext,
  type ApiRequest,
  type ApiResponse,
  type RequestOptions,
  type WaitResult,
} from './cli-agent.js';
import { credentialsFrom, readCodemanEnvFile } from './codeman-credentials.js';
import { listClis } from './config/cli-registry/registry.js';
import { getErrorMessage } from './types.js';

// ─────────────────────────────────────────────────────────────────────────────
// Protocol constants
// ─────────────────────────────────────────────────────────────────────────────

/** Revisions served with per-request `_meta` (no handshake). */
export const MODERN_PROTOCOL_VERSIONS = ['2026-07-28'] as const;
/** Revisions served after an `initialize` handshake, newest first. */
export const LEGACY_PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

/** JSON-RPC error codes this server emits. */
export const RPC_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  unsupportedProtocolVersion: -32022,
} as const;

/** Default wait: under Codex's 60 s MCP tool timeout, so a default call never gets cut off. */
export const DEFAULT_WAIT_MS = 45_000;
/** The server's own ceiling for one wait (`MAX_WAIT_MS` in config/agent-wait.ts). */
export const MAX_WAIT_MS = 600_000;
/** Cap on text handed back to the model, so one read cannot flood its context. */
export const MAX_OUTPUT_CHARS = 40_000;
/** Agent-scratch label for a case directory a start_session CREATES (agent-case-marker.ts). */
const MCP_AGENT_ORIGIN = 'codeman-mcp';
const WAIT_SIGNALS = ['stop', 'idle', 'exit', 'working', 'blocked'] as const;

/**
 * Caching hints the 2026-07-28 revision REQUIRES on `server/discover` and `tools/list`
 * results (Claude Code 2.1.296 rejects a modern `tools/list` without them, so the
 * server connects and shows no tools: measured). The tool list is fixed for the life of
 * this process and the same for every caller, hence a long TTL and public scope.
 */
const CACHE_HINTS = { ttlMs: 3_600_000, cacheScope: 'public' } as const;

const SERVER_INSTRUCTIONS =
  'Codeman runs AI coding agent CLIs (Claude Code, Codex, Gemini CLI, OpenCode, Antigravity, Grok, DeepSeek, OMP) ' +
  "and shells in persistent tmux sessions on the user's machine, shown as tabs in a web dashboard. Typical flow: " +
  'start_session (one fresh case per worker that edits files), send_prompt, then wait_for_session or read_output, ' +
  'and delete_session for every worker you started. Sessions you did not start can be listed and read but not ' +
  'prompted, interrupted or deleted, unless the user started this server with --allow-any-session.';

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

export interface McpConfig {
  /** Codeman server URL; undefined = not configured, and every tool says how to fix it. */
  apiUrl?: string;
  /** Why the URL given was refused, when one was given. */
  urlError?: string;
  /** This process's own session, when it runs inside a Codeman pane. */
  selfId?: string;
  auth?: AgentContext['auth'];
  /** `--allow-any-session`: prompt, interrupt and delete sessions this server did not start. */
  allowAnySession: boolean;
  version: string;
}

/**
 * Resolve the configuration from flags and the environment. Never guesses a URL: only
 * `--url` or `CODEMAN_API_URL` set one. A session id counts only inside a Codeman pane
 * (`CODEMAN_MUX=1`); a desktop client's environment has no session of its own.
 */
export function resolveMcpConfig(
  options: { url?: string; allowAnySession?: boolean; version: string },
  env: NodeJS.ProcessEnv = process.env,
  envFile: () => Record<string, string> = readCodemanEnvFile
): McpConfig {
  const raw = (options.url ?? env.CODEMAN_API_URL ?? '').trim();
  let apiUrl: string | undefined;
  let urlError: string | undefined;
  if (raw) {
    try {
      const url = new URL(raw);
      if (url.protocol === 'http:' || url.protocol === 'https:') apiUrl = raw.replace(/\/+$/, '');
      else urlError = `"${raw}" is not an http(s) URL`;
    } catch {
      urlError = `"${raw}" is not a valid URL`;
    }
  }
  const selfId = env.CODEMAN_MUX === '1' ? env.CODEMAN_SESSION_ID?.trim() || undefined : undefined;
  const credentials = credentialsFrom(env, envFile());
  return {
    apiUrl,
    urlError,
    selfId,
    auth: credentials.password ? credentials : undefined,
    allowAnySession: Boolean(options.allowAnySession),
    version: options.version,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool definitions
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint: boolean;
  };
}

const sessionIdProperty = {
  type: 'string',
  minLength: MIN_ID_PREFIX_LENGTH,
  description: 'Session id from list_sessions or start_session (the full id, or its first 8 characters).',
};

const timeoutProperty = {
  type: 'integer',
  minimum: 1000,
  maximum: MAX_WAIT_MS,
  description: `How long to wait, in ms (default ${DEFAULT_WAIT_MS}, max ${MAX_WAIT_MS}). Keep it under your own tool-call timeout; call again to keep waiting.`,
};

/**
 * The tools, in a fixed order (the spec asks for deterministic `tools/list` output, which
 * also keeps a client's prompt cache warm). `modes` are the run modes start_session
 * offers, from the CLI registry.
 */
export function buildToolDefinitions(modes: readonly string[]): ToolDefinition[] {
  return [
    {
      name: 'list_sessions',
      title: 'List Codeman sessions',
      description:
        'List the Codeman sessions you can see. Each one is an AI coding agent CLI (Claude Code, Codex, Gemini CLI, ' +
        'OpenCode, Grok, DeepSeek, ...) or a shell, running in a persistent tmux pane on the Codeman host and shown ' +
        'to the user as a tab. Returns id, name, run mode, status, folder, and whether this server may prompt it. ' +
        'The status is a hint for humans, not something to synchronize on.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'start_session',
      title: 'Start a worker session',
      description:
        'Start a new worker: an AI coding agent CLI or a shell in a persistent tmux pane on the Codeman host, ' +
        "visible to the user as a new tab in their Codeman dashboard and running on the user's own CLI logins. Use " +
        'it to run work in parallel, get a second opinion from a different CLI or model, or hand off a long task. ' +
        "`case` names a Codeman case (a folder): a new name creates a fresh scratch folder in Codeman's cases " +
        'directory, an existing case name runs the worker in that project. Give every worker that edits files its ' +
        'own fresh case, and put absolute paths in its prompt. Waits until the CLI can take a prompt where the CLI ' +
        'shows a ready mark. Returns the session id for send_prompt, wait_for_session, read_output and delete_session.',
      inputSchema: {
        type: 'object',
        properties: {
          case: {
            type: 'string',
            minLength: 1,
            maxLength: 100,
            description: 'Case name: a fresh name such as "review-auth-1", or an existing case.',
          },
          mode: {
            type: 'string',
            enum: [...modes],
            default: 'claude',
            description: 'Which agent CLI runs in the session. Only CLIs installed on the Codeman host start.',
          },
          name: { type: 'string', maxLength: 100, description: 'Optional tab name shown in the dashboard.' },
          wait_ready: {
            type: 'boolean',
            default: true,
            description: 'Wait until the CLI can take a prompt (default true).',
          },
          timeout_ms: timeoutProperty,
        },
        required: ['case'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'send_prompt',
      title: 'Send a prompt to a session',
      description:
        'Type a one-line prompt into a session this server started and press Enter. With wait (default true) it ' +
        'blocks until the worker finishes its turn or timeout_ms passes, and reports finished, still_working (call ' +
        'wait_for_session to keep waiting) or exited. Only claude and deepseek sessions report a definite end of ' +
        'turn; for the other CLIs "finished" is inferred from a quiet screen, so for a reliable result ask the ' +
        'worker to print a unique marker when done and use wait_for_session with match. Newlines and control ' +
        'characters are refused: put long instructions in a file and send its path.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: sessionIdProperty,
          text: { type: 'string', minLength: 1, description: 'The prompt: one line of printable text.' },
          wait: { type: 'boolean', default: true, description: 'Block until the turn ends (default true).' },
          timeout_ms: timeoutProperty,
        },
        required: ['session_id', 'text'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'wait_for_session',
      title: 'Wait for a session',
      description:
        'Wait until a session reaches a state (until: stop = finished its turn, blocked = waiting on a permission ' +
        'prompt, idle, working, exit) or prints a literal marker (match). Returns timed_out when timeout_ms passes: ' +
        'call again to keep waiting. Your own prompt is echoed into the output, so a marker written whole in the ' +
        'prompt matches at once: ask for it in two halves ("print DONE followed by _7f3a") and match the joined ' +
        'form (DONE_7f3a), one word without spaces. stop exists only for claude and deepseek sessions; blocked ' +
        'also for codex, whose dialogs Codeman reads off its screen.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: sessionIdProperty,
          until: {
            type: 'array',
            items: { type: 'string', enum: [...WAIT_SIGNALS] },
            minItems: 1,
            uniqueItems: true,
            description: 'Signals to wait for, for example ["stop", "exit"].',
          },
          match: { type: 'string', minLength: 1, maxLength: 200, description: 'Literal text to wait for (no regex).' },
          from: {
            type: 'string',
            enum: ['buffer', 'now'],
            default: 'buffer',
            description: 'With match: also search output already printed (buffer, default) or only new output (now).',
          },
          timeout_ms: timeoutProperty,
        },
        required: ['session_id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'read_output',
      title: "Read a session's output",
      description:
        "Read what a session produced. last_answer (default) is the worker's last reply, conversation the whole " +
        'exchange, terminal the last tail_bytes of its screen with colors stripped (works for every CLI, use it ' +
        `when the others come back empty). Output is capped at ${MAX_OUTPUT_CHARS} characters.`,
      inputSchema: {
        type: 'object',
        properties: {
          session_id: sessionIdProperty,
          source: {
            type: 'string',
            enum: ['last_answer', 'conversation', 'terminal'],
            default: 'last_answer',
            description: 'What to read.',
          },
          tail_bytes: {
            type: 'integer',
            minimum: 100,
            maximum: 200_000,
            default: 4000,
            description: 'With source terminal: how many bytes of the screen to read (default 4000).',
          },
        },
        required: ['session_id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    {
      name: 'interrupt_session',
      title: 'Interrupt a session',
      description:
        'Press Escape in a session this server started, to stop its current turn. The conversation is kept. One ' +
        'Escape does not always land, so read_output before the next prompt.',
      inputSchema: {
        type: 'object',
        properties: { session_id: sessionIdProperty },
        required: ['session_id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    {
      name: 'delete_session',
      title: 'Delete a session',
      description:
        'Close a session this server started: ends its CLI and removes its tab. The case folder stays on disk. ' +
        'Delete every worker you started once you have its answer.',
      inputSchema: {
        type: 'object',
        properties: { session_id: sessionIdProperty },
        required: ['session_id'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
  ];
}

/** Run modes start_session offers: every enabled registry entry, in registry order. */
export function registryModes(): string[] {
  return listClis()
    .filter((cli) => cli.enabled !== false)
    .map((cli) => cli.id as string);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool execution
// ─────────────────────────────────────────────────────────────────────────────

export interface ToolResult {
  text: string;
  structured?: Record<string, unknown>;
  isError?: boolean;
}

/** A refusal or failure the model can act on: becomes an `isError` result, never a JSON-RPC error. */
export class ToolError extends Error {}

interface SessionRow {
  id: string;
  name?: string;
  mode?: string;
  status?: string;
  workingDir?: string;
  parentSessionId?: string | null;
}

export interface ToolRunnerDeps {
  config: McpConfig;
  request: ApiRequest;
  /** Ids of sessions this process started: the default allowlist for prompting and deleting. */
  started: Set<string>;
  /** Exactly-once tag for this process's input (`seq` is the clock, kept strictly increasing). */
  clientId: string;
  now?: () => number;
}

const FULL_ID_LENGTH = 36;

/**
 * Output handed to the model as plain text and nothing else: no structuredContent beside
 * it, because a client that prefers structuredContent (Claude Code does) would then show
 * the model the metadata instead of the output (measured: a terminal read came back
 * "empty"). Over the cap, the kept end is marked in the text itself.
 */
function readableText(text: string, keep: 'head' | 'tail'): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return keep === 'tail'
    ? `[showing the last ${MAX_OUTPUT_CHARS} of ${text.length} characters]\n${text.slice(text.length - MAX_OUTPUT_CHARS)}`
    : `${text.slice(0, MAX_OUTPUT_CHARS)}\n[showing the first ${MAX_OUTPUT_CHARS} of ${text.length} characters]`;
}

/** A pane capture for reading: CRLF to LF, blank runs collapsed, trailing blank lines dropped. */
function tidyTerminal(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

/** `structured` as pretty JSON text: the spec asks for a text copy of structured content. */
function structuredResult(structured: Record<string, unknown>, isError = false): ToolResult {
  return { text: JSON.stringify(structured, null, 2), structured, isError };
}

// Argument readers: the schema in tools/list is advisory to the client, so every value
// is checked again here and a bad one is an isError result the model can correct.
function readString(
  args: Record<string, unknown>,
  key: string,
  opts: { required?: boolean; max?: number } = {}
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    if (opts.required) throw new ToolError(`${key} is required`);
    return undefined;
  }
  if (typeof value !== 'string') throw new ToolError(`${key} must be a string`);
  if (opts.required && value.length === 0) throw new ToolError(`${key} must not be empty`);
  if (opts.max !== undefined && value.length > opts.max) throw new ToolError(`${key} is longer than ${opts.max}`);
  return value;
}

function readBool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new ToolError(`${key} must be true or false`);
  return value;
}

function readInt(args: Record<string, unknown>, key: string, fallback: number, min: number, max: number): number {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new ToolError(`${key} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function readEnum<T extends string>(args: Record<string, unknown>, key: string, allowed: readonly T[], fallback: T): T {
  const value = args[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ToolError(`${key} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

export function createToolRunner(deps: ToolRunnerDeps) {
  const { config } = deps;
  // The server drops any seq at or below the last one it saw for this clientId (and
  // still answers 200), so two inputs in one millisecond, or a clock stepped back,
  // must not reuse a seq: keep it strictly increasing for the life of the process.
  let lastSeq = 0;
  const nextSeq = (): number => (lastSeq = Math.max(lastSeq + 1, (deps.now ?? Date.now)()));

  function context(): AgentContext {
    if (!config.apiUrl) {
      throw new ToolError(
        config.urlError
          ? `Codeman URL refused: ${config.urlError}.`
          : 'This MCP server does not know where Codeman runs. Set CODEMAN_API_URL in its environment (for example ' +
              'https://127.0.0.1:3000, the address you open Codeman at) or pass --url, plus CODEMAN_PASSWORD when the ' +
              'server has one, then restart the MCP server.'
      );
    }
    return { apiUrl: config.apiUrl, selfId: config.selfId ?? '', auth: config.auth };
  }

  async function call(options: RequestOptions, signal?: AbortSignal): Promise<ApiResponse> {
    const ctx = context();
    try {
      return await deps.request(ctx, { ...options, signal });
    } catch (err) {
      if (signal?.aborted) throw err;
      throw new ToolError(
        `Cannot reach Codeman at ${ctx.apiUrl}: ${getErrorMessage(err)}. Check that it is running. If every call ` +
          'fails at once, a sandbox around this MCP server may be blocking network access to this machine.'
      );
    }
  }

  function ensureOk(res: ApiResponse): void {
    if (!res.json?.success) throw new ToolError(describeFailure(res));
  }

  async function listRows(signal?: AbortSignal): Promise<SessionRow[]> {
    const res = await call({ method: 'GET', path: '/api/v1/sessions' }, signal);
    ensureOk(res);
    return (res.json?.data as SessionRow[] | undefined) ?? [];
  }

  /** The session an id names: the full id or a unique prefix of at least 8 characters. */
  async function findSession(id: string, signal?: AbortSignal): Promise<SessionRow> {
    if (id.length < MIN_ID_PREFIX_LENGTH) {
      throw new ToolError(`session_id "${id}" is shorter than ${MIN_ID_PREFIX_LENGTH} characters`);
    }
    const rows = await listRows(signal);
    const exact = rows.find((row) => row.id === id);
    if (exact) return exact;
    const matches = id.length < FULL_ID_LENGTH ? rows.filter((row) => row.id.startsWith(id)) : [];
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) throw new ToolError(`No session ${id} (list_sessions shows the current ones)`);
    throw new ToolError(`session_id "${id}" is ambiguous: ${matches.map((row) => row.id.slice(0, 13)).join(', ')}`);
  }

  function isSelf(id: string): boolean {
    return config.selfId !== undefined && isSelfSession(config.selfId, id);
  }

  function mayControl(row: SessionRow): boolean {
    if (config.allowAnySession) return true;
    if (deps.started.has(row.id)) return true;
    return config.selfId !== undefined && row.parentSessionId === config.selfId;
  }

  function guardControl(row: SessionRow, verb: string): void {
    if (isSelf(row.id))
      throw new ToolError(`Refusing to ${verb} session ${row.id}: it is the session this server runs in.`);
    if (!mayControl(row)) {
      throw new ToolError(
        `Refusing to ${verb} session ${row.id.slice(0, 8)}${row.name ? ` (${row.name})` : ''}: this server did not ` +
          'start it. Tools may only prompt, interrupt or delete sessions started through them. If the user wants ' +
          'you to drive their existing sessions, they can restart this MCP server with --allow-any-session.'
      );
    }
  }

  async function waitCall(
    sessionId: string,
    query: Record<string, string | number | undefined>,
    path: 'wait' | 'wait-output',
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<{ wait?: WaitResult; limitPaused?: boolean }> {
    const res = await call(
      {
        method: 'GET',
        path: `/api/v1/sessions/${encodeURIComponent(sessionId)}/${path}`,
        query: { ...query, timeout: timeoutMs },
        timeoutMs: timeoutMs + 10_000,
      },
      signal
    );
    ensureOk(res);
    return (res.json?.data as { wait?: WaitResult; limitPaused?: boolean } | undefined) ?? {};
  }

  /** One word for a wait's outcome, the shape every waiting tool reports. */
  function waitOutcome(wait: WaitResult | undefined): string {
    if (!wait) return 'unknown';
    if (wait.signal === 'exit') return 'exited';
    if (wait.ended) return 'ended';
    if (wait.timedOut) return 'timed_out';
    if (wait.matched !== undefined) return wait.matched ? 'matched' : 'timed_out';
    return 'signal';
  }

  const tools: Record<string, (args: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>> = {
    async list_sessions(_args, signal) {
      const rows = await listRows(signal);
      const sessions = rows.map((row) => ({
        id: row.id,
        short_id: row.id.slice(0, 8),
        name: row.name ?? '',
        mode: row.mode ?? '',
        status: row.status ?? '',
        folder: row.workingDir ?? '',
        you: isSelf(row.id),
        controllable: !isSelf(row.id) && mayControl(row),
      }));
      return structuredResult({ sessions, count: sessions.length });
    },

    async start_session(args, signal) {
      const caseName = readString(args, 'case', { required: true, max: 100 })!;
      const modes = registryModes();
      const mode = readEnum(args, 'mode', modes, 'claude');
      const name = readString(args, 'name', { max: 100 });
      const waitReady = readBool(args, 'wait_ready', true);
      const timeoutMs = readInt(args, 'timeout_ms', DEFAULT_WAIT_MS, 1000, MAX_WAIT_MS);

      const body: Record<string, unknown> = { caseName, mode };
      if (config.selfId) body.parentSessionId = config.selfId;
      if (name) body.sessionName = name;
      const res = await call(
        {
          method: 'POST',
          path: '/api/v1/quick-start',
          body,
          headers: { 'X-Codeman-Agent-Origin': MCP_AGENT_ORIGIN },
          timeoutMs: 120_000,
        },
        signal
      );
      ensureOk(res);
      const data = res.json?.data as { sessionId?: string; caseName?: string; casePath?: string } | undefined;
      if (!data?.sessionId) throw new ToolError('Codeman answered without a session id');
      deps.started.add(data.sessionId);

      let ready: boolean | null = null;
      let note = 'Ready for send_prompt.';
      const mark = composerReadyMark(mode);
      if (waitReady && mark) {
        let wait: WaitResult | undefined;
        try {
          ({ wait } = await waitCall(
            data.sessionId,
            { match: mark, from: 'buffer' },
            'wait-output',
            timeoutMs,
            signal
          ));
        } catch (err) {
          // The worker is already running: a failed readiness CALL (429, a network blip)
          // must still hand the model its id, or it cannot prompt or delete it.
          if (!(err instanceof ToolError)) throw err;
          return structuredResult({
            session_id: data.sessionId,
            mode,
            case: data.caseName ?? caseName,
            case_path: data.casePath ?? '',
            ready: null,
            note: `Started, but the readiness check failed (${err.message}): read_output with source terminal before send_prompt.`,
          });
        }
        const outcome = waitOutcome(wait);
        if (outcome === 'exited' || outcome === 'ended') {
          ready = false;
          note = 'The CLI exited during startup: read_output with source terminal shows why.';
        } else {
          ready = outcome === 'matched';
          if (!ready) {
            note =
              `Not ready within ${timeoutMs} ms (a startup dialog, or a slow first start): read_output with source ` +
              'terminal, then send_prompt once it shows its prompt.';
          }
        }
      } else if (waitReady) {
        note = `${mode} has no ready mark: give it a few seconds, then use markers with wait_for_session to synchronize.`;
      }
      return structuredResult({
        session_id: data.sessionId,
        mode,
        case: data.caseName ?? caseName,
        case_path: data.casePath ?? '',
        ready,
        note,
      });
    },

    async send_prompt(args, signal) {
      const id = readString(args, 'session_id', { required: true })!;
      const text = readString(args, 'text', { required: true })!;
      const wait = readBool(args, 'wait', true);
      const timeoutMs = readInt(args, 'timeout_ms', DEFAULT_WAIT_MS, 1000, MAX_WAIT_MS);
      const refusal = inputRefusal(text);
      if (refusal) throw new ToolError(refusal);
      const row = await findSession(id, signal);
      guardControl(row, 'prompt');

      const body = buildSendBody(text, {
        enter: true,
        clientId: deps.clientId,
        seq: nextSeq(),
        wait: wait ? true : undefined,
        waitTimeout: wait ? timeoutMs : undefined,
      });
      const res = await call(
        {
          method: 'POST',
          path: `/api/v1/sessions/${encodeURIComponent(row.id)}/input`,
          body,
          timeoutMs: timeoutMs + 10_000,
        },
        signal
      );
      ensureOk(res);
      const data = res.json?.data as
        | { delivered?: boolean; duplicate?: boolean; buffered?: boolean; dropped?: boolean; wait?: WaitResult }
        | undefined;
      if (data?.dropped) {
        throw new ToolError("Dropped: the session's host is waking and its input buffer is full. Send again later.");
      }
      if (data?.delivered === false && !data.duplicate) {
        return structuredResult(
          { session_id: row.id, outcome: 'not_delivered', note: 'The session has no live CLI (its pane exited).' },
          true
        );
      }
      if (!wait) {
        return structuredResult({
          session_id: row.id,
          outcome: data?.buffered ? 'buffered' : 'sent',
          note: 'Sent without waiting: use wait_for_session or read_output.',
        });
      }
      const outcome = waitOutcome(data?.wait);
      const definite = data?.wait?.until?.includes('stop') ?? false;
      const result: Record<string, unknown> = {
        session_id: row.id,
        outcome: outcome === 'signal' ? 'finished' : outcome === 'timed_out' ? 'still_working' : outcome,
        signal: data?.wait?.signal ?? null,
      };
      if (outcome === 'signal') {
        result.note = definite
          ? 'The worker finished its turn: read_output for its answer.'
          : 'The screen went quiet, which for this CLI usually means done but is not definite: read_output to check, ' +
            'or ask for a marker and use wait_for_session with match.';
      } else if (outcome === 'timed_out') {
        result.note = 'Still working: call wait_for_session to keep waiting.';
      }
      return structuredResult(result);
    },

    async wait_for_session(args, signal) {
      const id = readString(args, 'session_id', { required: true })!;
      const match = readString(args, 'match', { max: 200 });
      const rawUntil = args.until;
      const timeoutMs = readInt(args, 'timeout_ms', DEFAULT_WAIT_MS, 1000, MAX_WAIT_MS);
      const from = readEnum(args, 'from', ['buffer', 'now'] as const, 'buffer');
      let until: string[] | undefined;
      if (rawUntil !== undefined && rawUntil !== null) {
        if (!Array.isArray(rawUntil) || rawUntil.length === 0) throw new ToolError('until must be a non-empty list');
        for (const signalName of rawUntil) {
          if (typeof signalName !== 'string' || !(WAIT_SIGNALS as readonly string[]).includes(signalName)) {
            throw new ToolError(`until entries must be among: ${WAIT_SIGNALS.join(', ')}`);
          }
        }
        until = rawUntil as string[];
      }
      if (until && match) throw new ToolError('Use either until or match, not both.');
      if (!until && !match) throw new ToolError('Give until (signals) or match (a literal marker).');
      const row = await findSession(id, signal);
      const data = match
        ? await waitCall(row.id, { match, from }, 'wait-output', timeoutMs, signal)
        : await waitCall(row.id, { until: until!.join(',') }, 'wait', timeoutMs, signal);
      const outcome = waitOutcome(data.wait);
      const result: Record<string, unknown> = { session_id: row.id, outcome, signal: data.wait?.signal ?? null };
      if (data.wait?.snippet) result.snippet = data.wait.snippet;
      if (data.limitPaused) result.note = 'The session is paused on a usage limit, so a timeout is expected.';
      else if (outcome === 'timed_out') result.note = 'Not yet: call wait_for_session again to keep waiting.';
      return structuredResult(result);
    },

    async read_output(args, signal) {
      const id = readString(args, 'session_id', { required: true })!;
      const source = readEnum(args, 'source', ['last_answer', 'conversation', 'terminal'] as const, 'last_answer');
      const tailBytes = readInt(args, 'tail_bytes', 4000, 100, 200_000);
      const row = await findSession(id, signal);
      const sid = encodeURIComponent(row.id);
      if (source === 'terminal') {
        const res = await call(
          { method: 'GET', path: `/api/v1/sessions/${sid}/terminal`, query: { tail: tailBytes } },
          signal
        );
        ensureOk(res);
        const buffer = (res.json?.data as { terminalBuffer?: string } | undefined)?.terminalBuffer ?? '';
        return { text: readableText(tidyTerminal(stripAnsi(buffer)), 'tail') || '(the terminal is empty)' };
      }
      const res = await call(
        {
          method: 'GET',
          path: `/api/v1/sessions/${sid}/last-response`,
          query: { context: source === 'conversation' ? 'full' : undefined },
        },
        signal
      );
      ensureOk(res);
      const data = res.json?.data as { text?: string; messages?: Array<{ role: string; text: string }> } | undefined;
      const raw =
        source === 'conversation' && data?.messages
          ? data.messages.map((message) => `${message.role}: ${message.text}`).join('\n\n')
          : (data?.text ?? '');
      if (!raw.trim()) {
        return { text: 'Nothing to read yet (no answer, or none the server could cut out). Try source terminal.' };
      }
      return { text: readableText(raw, source === 'conversation' ? 'tail' : 'head') };
    },

    async interrupt_session(args, signal) {
      const id = readString(args, 'session_id', { required: true })!;
      const row = await findSession(id, signal);
      guardControl(row, 'interrupt');
      const res = await call(
        {
          method: 'POST',
          path: `/api/v1/sessions/${encodeURIComponent(row.id)}/input`,
          body: buildInterruptBody(deps.clientId, nextSeq()),
        },
        signal
      );
      ensureOk(res);
      return structuredResult({
        session_id: row.id,
        outcome: 'escape_sent',
        note: 'One Escape does not always land: read_output before the next prompt.',
      });
    },

    async delete_session(args, signal) {
      const id = readString(args, 'session_id', { required: true })!;
      const row = await findSession(id, signal);
      guardControl(row, 'delete');
      const res = await call({ method: 'DELETE', path: `/api/v1/sessions/${encodeURIComponent(row.id)}` }, signal);
      ensureOk(res);
      deps.started.delete(row.id);
      return structuredResult({
        session_id: row.id,
        outcome: 'deleted',
        note: 'Its case folder stays on disk.',
      });
    },
  };

  return {
    has(name: string): boolean {
      return Object.prototype.hasOwnProperty.call(tools, name);
    },
    async run(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
      try {
        return await tools[name](args, signal);
      } catch (err) {
        if (err instanceof ToolError) return { text: err.message, isError: true };
        throw err;
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Protocol
// ─────────────────────────────────────────────────────────────────────────────

type JsonRpcId = string | number;

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface McpServerOptions {
  config: McpConfig;
  /** One JSON-RPC message out (a line on stdout in production). */
  write: (message: Record<string, unknown>) => void;
  log?: (line: string) => void;
  request?: ApiRequest;
  /** Run modes start_session offers; defaults to the registry's enabled entries. */
  modes?: readonly string[];
  now?: () => number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The protocol core, transport-free so tests drive it message by message. Requests run
 * concurrently (a long wait must not hold up a list), each answered once, by id.
 */
export function createMcpServer(options: McpServerOptions) {
  const { config, write } = options;
  const log = options.log ?? (() => {});
  const serverInfo = { name: 'codeman', title: 'Codeman', version: config.version };
  const tools = buildToolDefinitions(options.modes ?? registryModes());
  const runner = createToolRunner({
    config,
    request: options.request ?? httpRequest,
    started: new Set<string>(),
    clientId: `codeman-mcp-${randomBytes(4).toString('hex')}`,
    now: options.now,
  });
  const inflight = new Map<JsonRpcId, AbortController>();
  let closed = false;

  function send(message: Record<string, unknown>): void {
    if (!closed) write({ jsonrpc: '2.0', ...message });
  }

  function sendError(id: JsonRpcId | null, code: number, message: string, data?: unknown): void {
    send({ id, error: data === undefined ? { code, message } : { code, message, data } });
  }

  /** A result, decorated for the era the request was made in. */
  function sendResult(id: JsonRpcId, result: Record<string, unknown>, modern: boolean): void {
    if (!modern) {
      send({ id, result });
      return;
    }
    const meta = isObject(result._meta) ? result._meta : {};
    send({ id, result: { resultType: 'complete', ...result, _meta: { ...meta, [META_SERVER_INFO]: serverInfo } } });
  }

  async function handleRequest(id: JsonRpcId, method: string, params: Record<string, unknown>): Promise<void> {
    if (method === 'initialize') {
      // Legacy handshake: answer with the client's revision when we serve it, else our newest legacy one.
      const requested = params.protocolVersion;
      const protocolVersion =
        typeof requested === 'string' && (LEGACY_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
          ? requested
          : LEGACY_PROTOCOL_VERSIONS[0];
      sendResult(
        id,
        {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo,
          instructions: SERVER_INSTRUCTIONS,
        },
        false
      );
      return;
    }

    const meta = isObject(params._meta) ? params._meta : undefined;
    const version = meta?.[META_PROTOCOL_VERSION];
    const modern = version !== undefined;
    if (modern) {
      if (typeof version !== 'string' || !(MODERN_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
        sendError(id, RPC_ERROR.unsupportedProtocolVersion, 'Unsupported protocol version', {
          supported: [...MODERN_PROTOCOL_VERSIONS],
          requested: version,
        });
        return;
      }
      if (!isObject(meta?.[META_CLIENT_CAPABILITIES])) {
        sendError(id, RPC_ERROR.invalidParams, `Missing _meta["${META_CLIENT_CAPABILITIES}"]`);
        return;
      }
    }

    switch (method) {
      case 'server/discover':
        sendResult(
          id,
          {
            supportedVersions: [...MODERN_PROTOCOL_VERSIONS],
            capabilities: { tools: { listChanged: false } },
            instructions: SERVER_INSTRUCTIONS,
            ...CACHE_HINTS,
          },
          true
        );
        return;
      case 'ping':
        sendResult(id, {}, modern);
        return;
      case 'tools/list':
        sendResult(id, modern ? { tools, ...CACHE_HINTS } : { tools }, modern);
        return;
      case 'tools/call': {
        const name = params.name;
        if (typeof name !== 'string' || !runner.has(name)) {
          sendError(id, RPC_ERROR.invalidParams, `Unknown tool: ${String(name)}`);
          return;
        }
        const args = params.arguments === undefined ? {} : params.arguments;
        if (!isObject(args)) {
          sendError(id, RPC_ERROR.invalidParams, 'arguments must be an object');
          return;
        }
        const controller = new AbortController();
        inflight.set(id, controller);
        try {
          const result = await runner.run(name, args, controller.signal);
          if (controller.signal.aborted) return; // cancelled: no further message for this id
          const payload: Record<string, unknown> = {
            content: [{ type: 'text', text: result.text }],
            isError: Boolean(result.isError),
          };
          if (result.structured) payload.structuredContent = result.structured;
          sendResult(id, payload, modern);
        } catch (err) {
          if (controller.signal.aborted) return;
          log(`codeman mcp: ${name} failed: ${getErrorMessage(err)}`);
          sendError(id, RPC_ERROR.internal, `Internal error in ${name}: ${getErrorMessage(err)}`);
        } finally {
          inflight.delete(id);
        }
        return;
      }
      default:
        sendError(id, RPC_ERROR.methodNotFound, `Method not found: ${method}`);
    }
  }

  function handleNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'notifications/cancelled') {
      const requestId = params.requestId;
      if (typeof requestId === 'string' || typeof requestId === 'number') inflight.get(requestId)?.abort();
    }
    // notifications/initialized and anything else: nothing to do, and never an answer.
  }

  return {
    /** One stdin line. Resolves when that message is fully handled. */
    async handleLine(line: string): Promise<void> {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message: unknown;
      try {
        message = JSON.parse(trimmed);
      } catch {
        sendError(null, RPC_ERROR.parse, 'Parse error');
        return;
      }
      if (!isObject(message)) {
        sendError(null, RPC_ERROR.invalidRequest, 'Expected one JSON-RPC message object per line');
        return;
      }
      const msg = message as JsonRpcMessage;
      const params = isObject(msg.params) ? msg.params : {};
      if (typeof msg.method !== 'string') return; // a response to nothing we sent: ignore
      const hasId = msg.id !== undefined;
      if (!hasId) {
        handleNotification(msg.method, params);
        return;
      }
      if (typeof msg.id !== 'string' && typeof msg.id !== 'number') {
        sendError(null, RPC_ERROR.invalidRequest, 'Request id must be a string or a number');
        return;
      }
      if (msg.jsonrpc !== '2.0') {
        sendError(msg.id, RPC_ERROR.invalidRequest, 'jsonrpc must be "2.0"');
        return;
      }
      await handleRequest(msg.id, msg.method, params);
    },
    /** Stop: abort every in-flight call and write nothing more. */
    close(): void {
      for (const controller of inflight.values()) controller.abort();
      inflight.clear();
      closed = true;
    },
    inflightCount(): number {
      return inflight.size;
    },
  };
}

/**
 * Serve MCP on this process's stdin/stdout until stdin closes (the client's shutdown
 * signal), then abort whatever is still in flight.
 */
export async function runMcpStdio(
  config: McpConfig,
  io: { stdin: NodeJS.ReadableStream; stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream } = process
): Promise<void> {
  const log = (line: string) => io.stderr.write(`${line}\n`);
  const server = createMcpServer({
    config,
    write: (message) => io.stdout.write(`${JSON.stringify(message)}\n`),
    log,
  });
  log(
    `codeman mcp ${config.version}: ${config.apiUrl ? `driving ${config.apiUrl}` : `not configured (${config.urlError ?? 'set CODEMAN_API_URL or --url'})`}` +
      `${config.selfId ? `, inside session ${config.selfId.slice(0, 8)}` : ''}` +
      `${config.allowAnySession ? ', --allow-any-session' : ''}`
  );
  const lines = createInterface({ input: io.stdin, crlfDelay: Infinity });
  lines.on('line', (line) => {
    void server.handleLine(line).catch((err: unknown) => log(`codeman mcp: ${getErrorMessage(err)}`));
  });
  await new Promise<void>((resolve) => lines.on('close', () => resolve()));
  server.close();
}
