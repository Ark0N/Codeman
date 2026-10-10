/**
 * @fileoverview Everything `codeman tui` needs from the outside world.
 *
 * The TUI is a CLIENT of the running server, never a second brain (see
 * docs/tui-plan.md §4): states, approvals and history all come from the same
 * API the web UI uses, so the two surfaces can never disagree. This module is
 * the only place in `src/tui/` that does IO. It covers four jobs:
 *
 * 1. **Discovery + auth**: find the instance's server (`CODEMAN_API_URL`, else
 *    loopback on `CODEMAN_PORT`), accepting the self-signed cert `--https`
 *    generates, and read credentials the way `codeman attach` already does
 *    (env, then the data dir's `.env`).
 * 2. **Typed API calls** that unwrap the `{success,data}` envelope and throw a
 *    `TuiApiError` carrying the status and `errorCode` on failure.
 * 3. **Live updates** over SSE, decoded by `tui-sse.ts`, with a staleness
 *    watchdog and capped backoff. The TUI does not patch rows from payloads: an
 *    interesting event means "resync", and the app layer debounces the refetch.
 * 4. **Degraded mode**: when nothing answers, sessions are enumerated straight
 *    from tmux plus a read-only peek at `state.json`, which keeps the "the
 *    server died, get me to my sessions" path that `sc` has today.
 *
 * IMPORT-SAFE: no probing, no timers and no tmux at import time. Everything a
 * `TuiClient` starts is owned by it and released by `close()`; a leaked SSE
 * socket or watchdog interval would keep the process alive after the TUI exits.
 *
 * LIMITATIONS (server surfaces that do not exist, worked around here rather
 * than by touching `src/web/`):
 * - There is no endpoint that reports the server's hostname, so the header's
 *   hostname is this machine's (`os.hostname()`) unless `CODEMAN_API_URL`
 *   points somewhere non-loopback, in which case that host is used.
 * - Plan usage has no route of its own: the last-known snapshot rides
 *   `GET /api/status` as `planUsage` (`web/plan-usage-latest.ts`) and updates
 *   arrive as `session:statusTelemetry` SSE frames.
 * - The unified list carries no token counters and no turn-start stamp
 *   (`TuiSessionRow.lastSubmitAt`), which the WORKING group is ordered by, so
 *   `fetchLiveSessionMetrics()` reads them from `GET /api/sessions` and
 *   `applyLiveMetrics()` (tui-app) folds them onto the rows. That route answers
 *   from the server's cached LIGHT state (no terminal buffers, ~10ms), which is
 *   what makes it cheap enough to ride every refresh.
 *
 * @module tui/tui-client
 */

import { execFile as execFileCb } from 'node:child_process';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { hostname as osHostname } from 'node:os';
import { promisify } from 'node:util';
import { CODEMAN_INSTANCE, dataPath, resolveTmuxSocketName } from '../config/instance.js';
import {
  basicAuthHeader,
  parseEnvFile,
  readCodemanCredentials,
  type CodemanCredentials,
} from '../codeman-credentials.js';
import { EXEC_TIMEOUT_MS } from '../config/exec-timeout.js';
import { probeServer } from '../daemon-control.js';
import { getErrorMessage } from '../types/api.js';
import {
  SseFrameParser,
  SSE_BASE_BACKOFF_MS,
  SSE_MAX_BACKOFF_MS,
  SSE_STALE_TIMEOUT_MS,
  approvalEventKind,
  classifySseEvent,
  sseBackoffDelay,
} from './tui-sse.js';
import type { UnifiedSessionItem } from '../services/unified-session-service.js';
import type { CaseInfo } from '../types/api.js';
import type { SearchResponseData } from '../types/search.js';
import type { StatusTelemetry } from '../usage-telemetry.js';
import type { ApprovalItem, ApprovalResolvedInfo } from '../web/approval-inbox.js';
import type { AwayDigestResponse } from '../web/away-digest.js';

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** A non-2xx answer, or a `success:false` envelope. */
export class TuiApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly errorCode?: string
  ) {
    super(message);
    this.name = 'TuiApiError';
  }
}

export interface TuiServerInfo {
  /** Origin only, no trailing slash: `https://127.0.0.1:3000`. */
  baseUrl: string;
  version?: string;
  hostname?: string;
  /** `CODEMAN_INSTANCE`, empty string for the production layout. */
  instance: string;
  /** A server answered but rejected our credentials. */
  authRequired?: boolean;
  /**
   * Last-known plan usage, which rides `GET /api/status` rather than having a
   * route of its own. Null when the account reports none (no subscription
   * windows, or no statusline render yet this server process).
   */
  planUsage?: TuiPlanUsage | null;
}

/** What `resumeSession()` needs: where the conversation ran, and which one it was. */
export interface TuiResumeOptions {
  workingDir: string;
  /** The Claude conversation id (`claudeSessionId`, else the row's own id). */
  resumeSessionId: string;
  /** Kept from the row when it had one, so a resumed session does not lose its name. */
  sessionName?: string;
}

export interface TuiClientOptions {
  /** Skip discovery and talk to this origin. */
  baseUrl?: string;
  /** Loopback port to probe. Outranks `CODEMAN_API_URL`, so a caller that names a port cannot be redirected by the ambient environment. */
  port?: number | string;
  username?: string;
  password?: string;
  /** Where credentials come from when none are passed. Defaults to the instance's `.env`. */
  envFilePath?: string;
  /** Per-request timeout. Discovery probes use `probeTimeoutMs`. */
  timeoutMs?: number;
  probeTimeoutMs?: number;
  /** Injected for tests; the default shells out to `tmux` via execFile. */
  exec?: TuiExecFile;
  /** Read-only source of names/dirs in degraded mode. Defaults to the instance's. */
  statePath?: string;
  /** tmux socket name. Defaults to the instance's, which is what keeps a beta TUI off prod's sessions. */
  socket?: string;
}

/** Plan-usage snapshot as the server broadcasts it (telemetry plus its source). */
export type TuiPlanUsage = StatusTelemetry & { sessionId?: string };

export type TuiApprovalAnswer =
  | { action: 'approve' }
  | { action: 'deny' }
  | { action: 'option'; option: number }
  | { action: 'text'; text: string };

/**
 * Answering is a conversation with a live terminal, so refusal is a normal
 * outcome, not an exception: the server re-captures the pane first and 409s
 * when the dialog is gone (someone answered it in tmux a second ago).
 */
export type TuiAnswerResult =
  | { ok: true; id: string; sessionId: string; action: string }
  | { ok: false; reason: 'gone' | 'not-found' | 'rejected' | 'failed'; message: string };

export interface TuiQuickStartOptions {
  caseName: string;
  mode?: 'claude' | 'shell' | 'opencode' | 'codex' | 'gemini' | 'antigravity' | 'pi' | 'grok' | 'deepseek';
  sessionName?: string;
  /** The tab this spawn came from, for the lineage lines (cosmetic, dropped if unresolvable). */
  parentSessionId?: string;
}

export interface TuiQuickStartResult {
  sessionId: string;
  casePath?: string;
  caseName?: string;
}

/**
 * The live-only fields the unified list does not carry, per session id.
 *
 * `lastSubmitAt` is the one the dashboard cannot do without: it is the pane's
 * last Enter, which is what a WORKING row's elapsed column shows and what the
 * WORKING group is sorted by. Without it a running turn is dated by the
 * SESSION's creation instead, so a day-old session that started a turn a minute
 * ago outranks one that has been working for an hour.
 */
export interface TuiLiveSessionMetrics {
  sessionId: string;
  lastSubmitAt?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/** Init snapshot, narrowed to the two facts the dashboard header shows. */
export interface TuiInitState {
  version?: string;
  planUsage?: TuiPlanUsage | null;
}

export type TuiApprovalEvent =
  | { kind: 'pending'; item: ApprovalItem }
  | { kind: 'updated'; item: ApprovalItem }
  | { kind: 'resolved'; info: ApprovalResolvedInfo };

export type TuiSseStatus = 'connected' | 'reconnecting';

export interface TuiSseStatusDetail {
  /** Consecutive failed connects; 0 while connected. */
  attempt: number;
  /**
   * SSE has failed often enough that the app should poll
   * `fetchUnifiedSessions()` instead of waiting for events.
   */
  recommendPolling: boolean;
  message?: string;
}

export interface TuiEventHandlers {
  onInit?(state: TuiInitState): void;
  /** Something session-shaped changed; the argument is the event name. */
  onResync?(event: string): void;
  onApproval?(event: TuiApprovalEvent): void;
  onPlanUsage?(usage: TuiPlanUsage): void;
  onStatus?(status: TuiSseStatus, detail: TuiSseStatusDetail): void;
}

export interface TuiSubscribeOptions {
  /**
   * Sessions whose `session:terminal` frames this stream wants. The default is
   * a sentinel that matches no session id, which suppresses the terminal
   * stream (by far the bulk of the wire) without suppressing anything else:
   * the `?sessions=` filter applies to terminal frames ONLY, lifecycle and
   * hook events still reach every client. The preview pane pulls its own tail
   * over HTTP, so the TUI never needs those bytes.
   */
  sessionIds?: readonly string[];
  staleTimeoutMs?: number;
  /** How often the staleness watchdog fires. Defaults to a third of the timeout. */
  checkIntervalMs?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  /** Consecutive failed connects before `recommendPolling` flips on. */
  pollingAfterFailures?: number;
}

export interface TuiEventStream {
  close(): void;
  readonly status: TuiSseStatus;
  readonly recommendPolling: boolean;
}

export type TuiExecFile = (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;

/** One tmux session as degraded mode sees it. */
export interface TuiTmuxSession {
  muxName: string;
  /** The `codeman-<prefix>` fragment; mux names carry only the first 8 chars of the id. */
  sessionIdPrefix: string;
  /** Full id, when `state.json` had exactly one session starting with the prefix. */
  sessionId?: string;
  name?: string;
  workingDir?: string;
  mode?: string;
  attached: boolean;
  /** Epoch ms from tmux's `session_created` (which reports seconds). */
  createdAt?: number;
  windows?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Discovery + credentials (pure halves, exported for tests)
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_PORT = 3000;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_PROBE_TIMEOUT_MS = 1_500;
/** Ceiling on a single response body. A tail request asks for far less. */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Trim a trailing slash so `new URL(path, base)` never doubles it. */
function normalizeOrigin(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/**
 * Origins to probe, in preference order. `CODEMAN_API_URL` (the variable hooks
 * already get) wins outright; otherwise both schemes on loopback, https first
 * because a production install is HTTPS-only and a plain-http server rejects a
 * TLS handshake immediately rather than hanging.
 */
export function tuiServerCandidates(env: { apiUrl?: string; port?: string | number } = {}): string[] {
  if (env.apiUrl && env.apiUrl.trim()) return [normalizeOrigin(env.apiUrl)];
  const parsed = typeof env.port === 'number' ? env.port : Number.parseInt(String(env.port ?? ''), 10);
  const port = Number.isSafeInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT;
  return [`https://127.0.0.1:${port}`, `http://127.0.0.1:${port}`];
}

// One credential reader for every client of the API (attach, tui, agent).
export { parseEnvFile, readCodemanCredentials, basicAuthHeader };
export type TuiCredentials = CodemanCredentials;

// ─────────────────────────────────────────────────────────────────────────────
// Degraded mode
// ─────────────────────────────────────────────────────────────────────────────

const execFileAsync = promisify(execFileCb);

const defaultExecFile: TuiExecFile = async (file, args) => {
  const { stdout, stderr } = await execFileAsync(file, [...args], {
    timeout: EXEC_TIMEOUT_MS,
    encoding: 'utf-8',
    maxBuffer: 1024 * 1024,
  });
  return { stdout, stderr };
};

/**
 * Session names Codeman owns on this socket. Remote (`codeman-ssh-…`) and
 * docker (`codeman-dkr-…`) names deliberately fail this pattern (they live on
 * their own sockets and must never be adopted), and the letters they use are
 * outside `[a-f0-9-]`, so this is the same fence `tmux-manager.ts` draws.
 */
const MUX_NAME_PATTERN = /^(?:codeman|claudeman)-([a-f0-9-]+)$/;

/** Field separator for `list-sessions -F`. Session names cannot contain a tab. */
const TMUX_FIELD_SEPARATOR = '\t';

const TMUX_LIST_FORMAT = ['#{session_name}', '#{session_attached}', '#{session_created}', '#{session_windows}'].join(
  TMUX_FIELD_SEPARATOR
);

/** Names/dirs from `state.json`, keyed by full session id. Read-only, tolerant. */
function readStateSessions(statePath: string): Map<string, { name?: string; workingDir?: string; mode?: string }> {
  const sessions = new Map<string, { name?: string; workingDir?: string; mode?: string }>();
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8')) as {
      sessions?: Record<string, { name?: string; workingDir?: string; mode?: string }>;
    };
    for (const [id, value] of Object.entries(parsed.sessions ?? {})) {
      if (value && typeof value === 'object') sessions.set(id, value);
    }
  } catch {
    /* no state file, or mid-write garbage: degraded mode is best-effort */
  }
  return sessions;
}

/** Parse `list-sessions -F` output. Pure, so the format string is unit-testable. */
export function parseTmuxSessionList(stdout: string): TuiTmuxSession[] {
  const rows: TuiTmuxSession[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [muxName = '', attached = '', created = '', windows = ''] = line.split(TMUX_FIELD_SEPARATOR);
    const match = MUX_NAME_PATTERN.exec(muxName);
    if (!match) continue;
    const createdSeconds = Number.parseInt(created, 10);
    const windowCount = Number.parseInt(windows, 10);
    rows.push({
      muxName,
      sessionIdPrefix: match[1],
      attached: attached.trim() !== '' && attached.trim() !== '0',
      ...(Number.isSafeInteger(createdSeconds) && createdSeconds > 0 ? { createdAt: createdSeconds * 1000 } : {}),
      ...(Number.isSafeInteger(windowCount) && windowCount > 0 ? { windows: windowCount } : {}),
    });
  }
  return rows;
}

/**
 * How tmux is sizing a session's window, as `readWindowSizing()` found it.
 *
 * Codeman pins every window it owns to the size the BROWSER dictates
 * (`window-size manual` plus an explicit `resize-window`, see
 * `tmux-manager.ts`), which is what stops a stray attach from shrinking the web
 * terminal. The cost is paid by the terminal: a client of any other shape
 * attaches to a window that does not fill it, and tmux pads the difference with
 * dots. The attach path therefore brackets the handoff with `latest` and puts
 * this snapshot back afterwards.
 */
export interface TuiWindowSizing {
  cols: number;
  rows: number;
  /** tmux's `window-size` option: `manual`, `latest`, `largest` or `smallest`. */
  mode: string;
}

const TMUX_SIZING_FORMAT = ['#{window_width}', '#{window_height}', '#{window-size}'].join(TMUX_FIELD_SEPARATOR);

/** Parse the sizing format above. Pure, so the format string is unit-testable. */
export function parseWindowSizing(stdout: string): TuiWindowSizing | null {
  const [width = '', height = '', mode = ''] = stdout.trim().split(TMUX_FIELD_SEPARATOR);
  const cols = Number.parseInt(width, 10);
  const rows = Number.parseInt(height, 10);
  if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols <= 0 || rows <= 0) return null;
  const value = mode.trim();
  return { cols, rows, ...(value ? { mode: value } : { mode: 'manual' }) };
}

/**
 * Session-level tmux options, as `readSessionOptions()` found them. `null` is
 * "not set on this session", which restores by UNSETTING rather than by writing
 * a value back: writing tmux's inherited value would pin an option the session
 * never had, and Codeman's own `status off` is exactly such a session-level
 * option that must survive the round trip.
 */
export type TuiSessionOptions = Record<string, string | null>;

/**
 * Parse `show-options -t <session>` (session-level options only, one `key value`
 * per line) for the keys asked about. Values tmux quotes are unquoted here, so
 * what comes back can be handed straight to `set-option` as an argv element.
 */
export function parseSessionOptions(stdout: string, keys: readonly string[]): TuiSessionOptions {
  const found = new Map<string, string>();
  for (const line of stdout.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed) continue;
    const space = trimmed.indexOf(' ');
    const key = space === -1 ? trimmed : trimmed.slice(0, space);
    const raw = space === -1 ? '' : trimmed.slice(space + 1);
    found.set(key, unquoteTmuxValue(raw));
  }
  const options: TuiSessionOptions = {};
  for (const key of keys) {
    const base = arrayOptionBase(key);
    if (base === null) {
      options[key] = found.get(key) ?? null;
      continue;
    }
    // An array option is captured WHOLE: restoring `status-format[0]` alone
    // would silently drop a second status line the user configured.
    options[key] = found.get(key) ?? null;
    for (const [name, value] of found) {
      if (arrayOptionBase(name) === base) options[name] = value;
    }
  }
  return options;
}

/**
 * What `list-keys -T prefix` says a single key is bound to, or null when the
 * key appears nowhere in the table. The command is returned verbatim, so a
 * caller can insist on an exact match rather than a prefix of one.
 */
export function parsePrefixBinding(stdout: string, key: string, table: TuiKeyTable = 'prefix'): string | null {
  const pattern = new RegExp(`^bind-key\\s+(?:-\\S+\\s+)*?-T\\s+${table}\\s+(\\S+)\\s+(.+)$`);
  for (const line of stdout.split('\n')) {
    const match = pattern.exec(line.trim());
    if (!match) continue;
    if (unquoteTmuxValue(match[1] ?? '') !== key) continue;
    return (match[2] ?? '').trim();
  }
  return null;
}

/**
 * The phrase the attach status bar carries. It doubles as the marker that tells
 * OUR bar apart from a user's own when sweeping one that leaked, so
 * `buildAttachBanner()` composes its text from this constant rather than
 * repeating the words.
 */
export const ATTACH_BANNER_MARKER = 'back to the codeman dashboard';

/**
 * The tmux key tables an attach touches. `root` is the one without a prefix:
 * a key bound there is delivered on its own, which is what makes a one-key way
 * out possible at all.
 */
export type TuiKeyTable = 'prefix' | 'root';

/**
 * The key bound to a bare `detach-client` in `list-keys -T prefix` output, or
 * null when nothing there detaches.
 *
 * ⚠️ Read rather than assumed because the two candidates differ only by case:
 * tmux ships `d` as `detach-client` and `D` as `choose-client`, and advertising
 * the wrong one leaves a tester attached with the way out on screen. Bindings
 * that pass ARGUMENTS to `detach-client` (`-a`, `-P`) are skipped: those act on
 * other clients or kill the pane's process, which is not what the bar promises.
 * A single-character binding wins over a named key, since that is what a status
 * line can print literally.
 */
export function parseDetachKey(stdout: string): string | null {
  const candidates: string[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^bind-key\s+(?:-\S+\s+)*?-T\s+prefix\s+(\S+)\s+detach-client\s*$/.exec(line.trim());
    const key = match?.[1];
    if (key) candidates.push(unquoteTmuxValue(key));
  }
  return candidates.find((key) => key.length === 1) ?? candidates[0] ?? null;
}

/** `status-format[0]` → `status-format`; a plain option name → null. */
export function arrayOptionBase(key: string): string | null {
  const match = /^([^[\]]+)\[\d+\]$/.exec(key);
  return match ? (match[1] ?? null) : null;
}

/** tmux quotes a value only when it has to; `"a \"b\""` comes back as `a "b"`. */
function unquoteTmuxValue(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) return value;
  return value.slice(1, -1).replace(/\\(["\\])/g, '$1');
}

/**
 * List Codeman's tmux sessions without a server, decorating them with whatever
 * `state.json` remembers. Attach is all this supports: there are no states, no
 * approvals and no previews when nothing is running the classification.
 *
 * The tmux call is `execFile` with an argv array (never a shell string), and
 * the socket comes from the instance config, so a beta TUI sees only the beta
 * instance's sessions.
 */
export async function enumerateTmuxSessions(
  options: { exec?: TuiExecFile; socket?: string; statePath?: string } = {}
): Promise<TuiTmuxSession[]> {
  const exec = options.exec ?? defaultExecFile;
  const socket = options.socket ?? resolveTmuxSocketName();
  let stdout = '';
  try {
    ({ stdout } = await exec('tmux', ['-L', socket, 'list-sessions', '-F', TMUX_LIST_FORMAT]));
  } catch {
    // "no server running on ..." exits non-zero, which is simply an empty list.
    return [];
  }

  const rows = parseTmuxSessionList(stdout);
  if (rows.length === 0) return rows;

  const state = readStateSessions(options.statePath ?? dataPath('state.json'));
  for (const row of rows) {
    const matches = [...state.entries()].filter(([id]) => id.startsWith(row.sessionIdPrefix));
    // Ambiguity is meaningless here: two ids sharing an 8-char prefix cannot both
    // own one mux name, and guessing would put the wrong name on a row.
    if (matches.length !== 1) continue;
    const [id, entry] = matches[0];
    row.sessionId = id;
    if (entry.name) row.name = entry.name;
    if (entry.workingDir) row.workingDir = entry.workingDir;
    if (entry.mode) row.mode = entry.mode;
  }
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// The client
// ─────────────────────────────────────────────────────────────────────────────

interface RawResponse {
  status: number;
  body: string;
}

export class TuiClient {
  private base: string | null;
  private readonly credentials: TuiCredentials;
  private readonly timeoutMs: number;
  private readonly probeTimeoutMs: number;
  private readonly exec: TuiExecFile;
  private readonly statePath: string;
  private readonly socket: string;
  private readonly streams = new Set<SseStream>();
  private readonly clientId = `codeman-tui-${process.pid}`;
  private seq = 0;
  private server: TuiServerInfo | null = null;

  constructor(private readonly options: TuiClientOptions = {}) {
    this.base = options.baseUrl ? normalizeOrigin(options.baseUrl) : null;
    const credentials = readCodemanCredentials(options.envFilePath ?? dataPath('.env'));
    this.credentials = {
      username: options.username ?? credentials.username,
      ...((options.password ?? credentials.password) ? { password: options.password ?? credentials.password } : {}),
    };
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.exec = options.exec ?? defaultExecFile;
    this.statePath = options.statePath ?? dataPath('state.json');
    this.socket = options.socket ?? resolveTmuxSocketName();
  }

  /** The origin in use, or null before a successful `connect()`. */
  get baseUrl(): string | null {
    return this.base;
  }

  get serverInfo(): TuiServerInfo | null {
    return this.server;
  }

  /**
   * Find the server and read its identity. Returns null when nothing answers,
   * which is the app's cue to fall back to `enumerateTmuxSessions()`.
   */
  async connect(): Promise<TuiServerInfo | null> {
    // An explicit port outranks the ambient `CODEMAN_API_URL` (which every
    // Codeman-managed session exports): a caller that named a port must not be
    // silently redirected at whatever server happens to own this shell.
    const candidates = this.base
      ? [this.base]
      : this.options.port !== undefined
        ? tuiServerCandidates({ port: this.options.port })
        : tuiServerCandidates({ apiUrl: process.env.CODEMAN_API_URL, port: process.env.CODEMAN_PORT });

    const probes = await Promise.all(
      candidates.map((origin) => probeServer(`${origin}/api/status`, this.probeTimeoutMs))
    );
    const index = probes.findIndex((probe) => probe.up);
    if (index === -1) {
      this.server = null;
      return null;
    }

    this.base = candidates[index];
    const info: TuiServerInfo = {
      baseUrl: this.base,
      instance: CODEMAN_INSTANCE,
      hostname: this.resolveHostname(this.base),
    };
    if (probes[index].version) info.version = probes[index].version;

    // The probe is unauthenticated, so behind a password it learns nothing but
    // "something is there". Ask again with credentials for the version.
    try {
      const status = await this.requestData<{ version?: string; planUsage?: TuiPlanUsage | null }>(
        'GET',
        '/api/status'
      );
      if (status?.version) info.version = status.version;
      if (status?.planUsage) info.planUsage = status.planUsage;
    } catch (err) {
      if (err instanceof TuiApiError && (err.status === 401 || err.status === 403)) {
        info.authRequired = true;
      }
    }

    this.server = info;
    return info;
  }

  // ── API ────────────────────────────────────────────────────────────────────

  async fetchUnifiedSessions(limit?: number): Promise<UnifiedSessionItem[]> {
    const query = limit !== undefined ? `?limit=${encodeURIComponent(String(Math.max(1, Math.trunc(limit))))}` : '';
    const data = await this.requestData<{ sessions?: UnifiedSessionItem[] }>('GET', `/api/sessions/unified${query}`);
    return data?.sessions ?? [];
  }

  /**
   * The turn-start stamp and token counters for every LIVE session.
   *
   * `GET /api/sessions` is the light state (`getLightSessionsState()`, itself
   * cached server-side): no terminal buffers, so this is a ~10ms read next to
   * the unified list's transcript scan. Rows are narrowed to the three fields
   * the dashboard actually merges, and a row with no usable id is dropped
   * rather than folded in under an empty key.
   */
  async fetchLiveSessionMetrics(): Promise<TuiLiveSessionMetrics[]> {
    const data = await this.requestData<
      Array<{ id?: unknown; lastSubmitAt?: unknown; inputTokens?: unknown; outputTokens?: unknown }>
    >('GET', '/api/sessions');
    if (!Array.isArray(data)) return [];
    const rows: TuiLiveSessionMetrics[] = [];
    for (const entry of data) {
      if (!entry || typeof entry.id !== 'string' || entry.id === '') continue;
      rows.push({
        sessionId: entry.id,
        ...(typeof entry.lastSubmitAt === 'number' ? { lastSubmitAt: entry.lastSubmitAt } : {}),
        ...(typeof entry.inputTokens === 'number' ? { inputTokens: entry.inputTokens } : {}),
        ...(typeof entry.outputTokens === 'number' ? { outputTokens: entry.outputTokens } : {}),
      });
    }
    return rows;
  }

  async fetchApprovals(): Promise<ApprovalItem[]> {
    const data = await this.requestData<{ approvals?: ApprovalItem[] }>('GET', '/api/approvals');
    return data?.approvals ?? [];
  }

  /**
   * Answer a pending prompt. Every refusal the server can reasonably give
   * (dialog gone, item already resolved, digit not among the parsed options)
   * comes back as a typed result: a human answering a dialog that just closed
   * is normal operation, not an error condition.
   */
  async answerApproval(id: string, answer: TuiApprovalAnswer): Promise<TuiAnswerResult> {
    try {
      const data = await this.requestData<{ id: string; sessionId: string; action: string }>(
        'POST',
        `/api/approvals/${encodeURIComponent(id)}/answer`,
        answer
      );
      return { ok: true, id: data?.id ?? id, sessionId: data?.sessionId ?? '', action: data?.action ?? answer.action };
    } catch (err) {
      if (!(err instanceof TuiApiError)) throw err;
      return { ok: false, reason: answerFailureReason(err), message: err.message };
    }
  }

  /** Raw terminal bytes (ANSI intact) for the preview pane. */
  async fetchTerminalTail(sessionId: string, bytes: number): Promise<string> {
    const tail = Math.max(1, Math.trunc(bytes));
    const data = await this.requestData<{ terminalBuffer?: string }>(
      'GET',
      `/api/sessions/${encodeURIComponent(sessionId)}/terminal?tail=${tail}`
    );
    return data?.terminalBuffer ?? '';
  }

  /**
   * Type one line at a session's composer.
   *
   * Two hard rules from CLAUDE.md, both enforced here so no caller can get them
   * wrong: the payload must END with `\r` or the server never issues Enter and
   * the text sits unsubmitted, and embedded newlines are stripped rather than
   * sent (multi-line input breaks Ink, and the server would join the lines).
   * The `clientId`/`seq` pair makes delivery exactly-once, so a retry after a
   * dropped connection cannot type the prompt twice.
   */
  async sendInput(sessionId: string, text: string): Promise<void> {
    const line = text.replace(/[\r\n]+/g, ' ').trim();
    this.seq += 1;
    await this.requestData('POST', `/api/sessions/${encodeURIComponent(sessionId)}/input`, {
      input: `${line}\r`,
      useMux: true,
      clientId: this.clientId,
      seq: this.seq,
    });
  }

  /** Last `seq` sent. Monotonic per process; exposed for tests and diagnostics. */
  get lastInputSeq(): number {
    return this.seq;
  }

  /**
   * Start a session. Always `quick-start`, never `POST /api/sessions`: only
   * this route resolves a case NAME, and it is what routes remote/docker cases
   * to the right host instead of stat-ing the path locally.
   */
  async quickStart(options: TuiQuickStartOptions): Promise<TuiQuickStartResult> {
    const data = await this.requestData<TuiQuickStartResult>('POST', '/api/quick-start', {
      caseName: options.caseName,
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.sessionName ? { sessionName: options.sessionName } : {}),
      ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
    });
    if (!data?.sessionId) throw new TuiApiError('quick-start returned no session id', 502);
    return data;
  }

  /**
   * Resume a past Claude conversation as a NEW session, the way the web UI's
   * "Resume Conversation" list does: `POST /api/sessions` carrying
   * `resumeSessionId` (quick-start has no such field), then `/interactive` to
   * give it a pane. Returns the new session's id.
   */
  async resumeSession(options: TuiResumeOptions): Promise<string> {
    const data = await this.requestData<{ session?: { id?: string } }>('POST', '/api/sessions', {
      workingDir: options.workingDir,
      resumeSessionId: options.resumeSessionId,
      mode: 'claude',
      ...(options.sessionName ? { name: options.sessionName } : {}),
    });
    const sessionId = data?.session?.id;
    if (!sessionId) throw new TuiApiError('resuming returned no session id', 502);
    // Creating a session does not start one: without this it has no pane, and
    // the row would sit there unattachable.
    await this.requestData('POST', `/api/sessions/${encodeURIComponent(sessionId)}/interactive`, {});
    return sessionId;
  }

  async fetchCases(): Promise<CaseInfo[]> {
    const data = await this.requestData<CaseInfo[]>('GET', '/api/cases');
    return Array.isArray(data) ? data : [];
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.requestData('DELETE', `/api/sessions/${encodeURIComponent(sessionId)}`);
  }

  async search(query: string, limit?: number): Promise<SearchResponseData> {
    const params = new URLSearchParams({ q: query });
    if (limit !== undefined) params.set('limit', String(Math.max(1, Math.trunc(limit))));
    const data = await this.requestData<SearchResponseData>('GET', `/api/search?${params.toString()}`);
    return data ?? { query, groups: [], totalResults: 0, truncated: false };
  }

  /**
   * The away digest. This route predates the envelope and answers
   * `{success:true, digest}` with the payload at the TOP level, so it reads the
   * raw body rather than `data` (see CLAUDE.md, away-digest).
   */
  async fetchAwayDigest(range?: string): Promise<AwayDigestResponse> {
    const query = range ? `?range=${encodeURIComponent(range)}` : '';
    const body = await this.requestJson<{ digest?: AwayDigestResponse }>('GET', `/api/away-digest${query}`);
    const digest = body?.digest;
    if (!digest) throw new TuiApiError('away-digest returned no digest', 502);
    return digest;
  }

  /** Last-known plan-usage snapshot, or null when the account reports none. */
  async fetchPlanUsage(): Promise<TuiPlanUsage | null> {
    const data = await this.requestData<{ planUsage?: TuiPlanUsage | null }>('GET', '/api/status');
    return data?.planUsage ?? null;
  }

  // ── Degraded mode ──────────────────────────────────────────────────────────

  /** Sessions straight from tmux, for when no server answered. */
  enumerateTmuxSessions(): Promise<TuiTmuxSession[]> {
    return enumerateTmuxSessions({ exec: this.exec, socket: this.socket, statePath: this.statePath });
  }

  // ── Attach sizing ──────────────────────────────────────────────────────────────────

  /**
   * The window's current size and sizing mode, or null when the socket, the
   * session or tmux itself is not there. Best-effort by design: an attach that
   * cannot be measured still attaches.
   */
  async readWindowSizing(muxName: string): Promise<TuiWindowSizing | null> {
    if (!MUX_NAME_PATTERN.test(muxName)) return null;
    try {
      const { stdout } = await this.exec('tmux', [
        '-L',
        this.socket,
        'display-message',
        '-p',
        '-t',
        muxName,
        TMUX_SIZING_FORMAT,
      ]);
      return parseWindowSizing(stdout);
    } catch {
      return null;
    }
  }

  /**
   * Let the window follow whichever client is in front of it, for the length of
   * an attach. `latest` (rather than a one-off `resize-window` to our own size)
   * is what makes a terminal resized MID-attach follow along: tmux recomputes
   * on every SIGWINCH, and the TUI process is blocked in `spawnSync` and cannot.
   */
  async followAttachingClient(muxName: string): Promise<boolean> {
    if (!MUX_NAME_PATTERN.test(muxName)) return false;
    try {
      await this.exec('tmux', ['-L', this.socket, 'set-window-option', '-t', muxName, 'window-size', 'latest']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Size a window to the terminal that is about to look at it, NOW.
   *
   * ⚠️ `window-size latest` only resizes a window while a client is actually on
   * it. The sessions behind the tab strip have none until you switch, so the
   * resize happened AT the switch: tmux painted the newly-available area with
   * its dot fill, and an idle claude had no reason to redraw into it, leaving a
   * pane in the corner of a dotted screen (reported from the beta, with a
   * screenshot). Pre-sizing moves that repaint to attach time, while the user
   * is still looking at the first session.
   *
   * `resize-window` with an explicit size implies `window-size manual`, which
   * is what we want: the size is already right when the switch lands, so tmux
   * has nothing to change and nothing to repaint. The switch binding puts
   * `latest` back so a mid-attach terminal resize still follows.
   */
  async presizeWindow(muxName: string, cols: number, rows: number): Promise<boolean> {
    if (!MUX_NAME_PATTERN.test(muxName)) return false;
    if (!Number.isSafeInteger(cols) || !Number.isSafeInteger(rows) || cols <= 0 || rows <= 0) return false;
    try {
      await this.exec('tmux', [
        '-L',
        this.socket,
        'resize-window',
        '-t',
        muxName,
        '-x',
        String(cols),
        '-y',
        String(rows),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * tmux's prefix key for a session (`C-b` unless the user's config says
   * otherwise), or null when tmux cannot say. Session-level first, then global:
   * `show-options -v` resolves the chain on its own, and an empty answer simply
   * means "nothing set here".
   */
  async readPrefixKey(muxName: string): Promise<string | null> {
    if (!MUX_NAME_PATTERN.test(muxName)) return null;
    for (const args of [
      ['-L', this.socket, 'show-options', '-t', muxName, '-v', 'prefix'],
      ['-L', this.socket, 'show-options', '-gv', 'prefix'],
    ]) {
      try {
        const { stdout } = await this.exec('tmux', args);
        const value = stdout.trim();
        if (value) return value;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * The key that detaches, straight from tmux's own key table. Key tables are
   * server-global, so unlike the prefix this takes no session. A failure is
   * null and the caller falls back to tmux's stock `d`.
   */
  async readDetachKey(): Promise<string | null> {
    try {
      const { stdout } = await this.exec('tmux', ['-L', this.socket, 'list-keys', '-T', 'prefix']);
      return parseDetachKey(stdout);
    } catch {
      return null;
    }
  }

  /**
   * The command bound to a key in tmux's prefix table, or null when the key is
   * free. Used to check a key is unbound BEFORE claiming it, so the attach can
   * never shadow a binding the user relies on.
   */
  async readPrefixBinding(key: string, table: TuiKeyTable = 'prefix'): Promise<string | null> {
    try {
      const { stdout } = await this.exec('tmux', ['-L', this.socket, 'list-keys', '-T', table]);
      return parsePrefixBinding(stdout, key, table);
    } catch {
      return null;
    }
  }

  /**
   * Claim a key for `detach-client`. Best effort; a failure is not fatal to an
   * attach, and the caller advertises the key only if this returned true.
   *
   * The `root` table is the one that matters for a way OUT: a key bound there
   * needs no prefix at all, so leaving a session is one keypress rather than a
   * chord typed in the right order.
   */
  async bindDetachKey(key: string, table: TuiKeyTable = 'prefix'): Promise<boolean> {
    try {
      await this.exec('tmux', ['-L', this.socket, 'bind-key', '-T', table, key, 'detach-client']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Bind a prefix-less key to switch this client to another session, so the tab
   * strip on the attach bar is not just a picture: Alt+1..9 moves between
   * sessions from INSIDE a pane, the way it does in the web UI.
   *
   * `switch-client` rather than detach-then-attach: it keeps the terminal, so
   * the move is instant and the TUI stays blocked in its `spawnSync` exactly as
   * before, still holding the restore it owes.
   */
  async bindSwitchKey(key: string, target: string): Promise<boolean> {
    if (!MUX_NAME_PATTERN.test(target)) return false;
    try {
      // Two commands: go there, then let that window follow this terminal again.
      // It is already the right size (see presizeWindow), so `latest` changes
      // nothing on arrival and costs no repaint — it matters only if the
      // terminal is resized while sitting in that session.
      //
      // ⚠️ The separator MUST be an escaped `\;`. A bare `;` is a command
      // separator to tmux's own parser, so it ends the `bind-key` and RUNS
      // what follows immediately: the binding kept only `switch-client`, and
      // every session got `window-size latest` executed on it at attach time.
      // That is what left sessions on `latest` after a detach, since the
      // snapshot was then taken from already-corrupted state.
      await this.exec('tmux', [
        '-L',
        this.socket,
        'bind-key',
        '-T',
        'root',
        key,
        'switch-client',
        '-t',
        target,
        '\\;',
        'set-window-option',
        '-t',
        target,
        'window-size',
        'latest',
      ]);
      return true;
    } catch {
      return false;
    }
  }

  /** Give back a switch key, but only while it still points at a session. */
  async unbindSwitchKey(key: string): Promise<void> {
    const bound = await this.readPrefixBinding(key, 'root');
    if (!bound || !bound.startsWith('switch-client')) return;
    try {
      await this.exec('tmux', ['-L', this.socket, 'unbind-key', '-T', 'root', key]);
    } catch {
      /* a stray switch binding is harmless next to failing an attach */
    }
  }

  /**
   * Give a key back, but ONLY while it still means `detach-client`. Anything
   * else there is the user's, arrived after we bound ours, and must not be
   * removed.
   */
  async unbindDetachKey(key: string, table: TuiKeyTable = 'prefix'): Promise<void> {
    if ((await this.readPrefixBinding(key, table)) !== 'detach-client') return;
    try {
      await this.exec('tmux', ['-L', this.socket, 'unbind-key', '-T', table, key]);
    } catch {
      /* a key we cannot give back is a stray convenience binding, not a failure */
    }
  }

  /**
   * Is this session's active pane DEAD — the process it ran has exited and tmux
   * is holding the corpse on screen?
   *
   * Codeman sets `remain-on-exit on` for every pane it owns, so a session whose
   * agent exited does not disappear: it stays listed, the server still reports
   * it `idle`, and attaching hands the terminal to a pane that reads no input.
   * A beta tester hit exactly that and could not type or get out.
   *
   * Fails OPEN (`false`): a probe that cannot run must never block an attach to
   * a pane that is perfectly alive.
   */
  async isPaneDead(muxName: string): Promise<boolean> {
    if (!MUX_NAME_PATTERN.test(muxName)) return false;
    try {
      const { stdout } = await this.exec('tmux', [
        '-L',
        this.socket,
        'display-message',
        '-p',
        '-t',
        muxName,
        '#{pane_dead}',
      ]);
      return stdout.trim() === '1';
    } catch {
      return false;
    }
  }

  /** Snapshot the session-level options an attach is about to overwrite. */
  async readSessionOptions(muxName: string, keys: readonly string[]): Promise<TuiSessionOptions | null> {
    if (!MUX_NAME_PATTERN.test(muxName)) return null;
    try {
      const { stdout } = await this.exec('tmux', ['-L', this.socket, 'show-options', '-t', muxName]);
      return parseSessionOptions(stdout, keys);
    } catch {
      return null;
    }
  }

  /**
   * Write session options, one `set-option` per key. Sequential rather than a
   * single `;`-chained invocation on purpose: a value tmux rejects then costs
   * that one option instead of every option after it.
   */
  async applySessionOptions(muxName: string, values: Record<string, string>): Promise<void> {
    if (!MUX_NAME_PATTERN.test(muxName)) return;
    for (const [key, value] of Object.entries(values)) {
      try {
        await this.exec('tmux', ['-L', this.socket, 'set-option', '-t', muxName, key, value]);
      } catch {
        /* an option this tmux does not know is not worth failing an attach over */
      }
    }
  }

  /**
   * Put every snapshotted option back: a value writes, a `null` unsets.
   *
   * ⚠️ An ARRAY option (`status-format[0]`) cannot be restored element by
   * element: `set -u status-format[0]` leaves an EMPTY array rather than
   * falling back to the inherited default, which renders as a BLANK status bar
   * on a session that legitimately had one (measured). The whole array is
   * therefore dropped first, and any indices the snapshot captured are written
   * back on top.
   */
  async restoreSessionOptions(muxName: string, snapshot: TuiSessionOptions): Promise<void> {
    if (!MUX_NAME_PATTERN.test(muxName)) return;
    const arrays = new Set<string>();
    for (const key of Object.keys(snapshot)) {
      const base = arrayOptionBase(key);
      if (base) arrays.add(base);
    }
    for (const base of arrays) await this.setOption(['-u', '-t', muxName, base]);
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === null) {
        // Indexed nulls are already gone with the array drop above.
        if (arrayOptionBase(key) === null) await this.setOption(['-u', '-t', muxName, key]);
        continue;
      }
      await this.setOption(['-t', muxName, key, value]);
    }
  }

  /** One `set-option`, swallowing failure: the session may be gone by now. */
  /**
   * Drop attach status bars that a previous TUI never got to take down.
   *
   * `restore()` runs after `spawnSync` returns, which covers a detach and an
   * agent exiting inside the pane, but not the terminal DYING while attached:
   * a closed window or a dropped SSH kills the TUI where it stands, and the bar
   * it installed stays pinned on the session (observed on the beta, where the
   * tester closed the window instead of detaching and the next attach still
   * wore a stale bar naming the wrong session). One sweep at startup makes that
   * self-healing.
   *
   * Only a bar carrying our own marker is touched, and it is put back the way
   * Codeman creates its panes (`status off`), which is the only state this bar
   * is ever applied over.
   *
   * The held-Ctrl detach alias is deliberately NOT swept here. It is invisible,
   * harmless and arguably useful if it leaks, while sweeping it would rip the
   * key out from under a SECOND TUI that is mid-attach right now — key tables
   * are server-global, so this method cannot tell a leak from a live claim.
   */
  async clearLeakedAttachBanners(): Promise<number> {
    let names: string[];
    try {
      const { stdout } = await this.exec('tmux', ['-L', this.socket, 'list-sessions', '-F', '#{session_name}']);
      names = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => MUX_NAME_PATTERN.test(line));
    } catch {
      return 0;
    }
    let cleared = 0;
    for (const name of names) {
      let current = '';
      try {
        ({ stdout: current } = await this.exec('tmux', [
          '-L',
          this.socket,
          'show-options',
          '-t',
          name,
          '-v',
          'status-format[0]',
        ]));
      } catch {
        continue;
      }
      if (!current.includes(ATTACH_BANNER_MARKER)) continue;
      // The array WHOLE, for the same reason restoreSessionOptions() does it:
      // unsetting one index leaves an empty array, which renders as a blank bar.
      await this.setOption(['-u', '-t', name, 'status-format']);
      await this.setOption(['-u', '-t', name, 'status-style']);
      // ⚠️ `status-position` MUST be swept with the rest. It was missing here,
      // so a sweep cleaned the marker and left the position behind — and with
      // the marker gone the leftover no longer matched, which made it
      // permanently unsweepable. Every option the banner writes has to be
      // undone by the same pass that recognises it.
      await this.setOption(['-u', '-t', name, 'status-position']);
      await this.setOption(['-t', name, 'status', 'off']);
      cleared += 1;
    }
    return cleared;
  }

  private async setOption(args: readonly string[]): Promise<void> {
    try {
      await this.exec('tmux', ['-L', this.socket, 'set-option', ...args]);
    } catch {
      /* the user may have exited the agent from inside the attach */
    }
  }

  /**
   * Put a window back the way `readWindowSizing()` found it, so the web UI
   * keeps the authority it had before the attach. The resize goes last:
   * `resize-window` sets `window-size manual` on its own, so ordering it after
   * the option write would silently undo a restored `latest`.
   */
  async restoreWindowSizing(muxName: string, sizing: TuiWindowSizing): Promise<void> {
    if (!MUX_NAME_PATTERN.test(muxName)) return;
    try {
      if (sizing.mode === 'manual') {
        await this.exec('tmux', [
          '-L',
          this.socket,
          'resize-window',
          '-t',
          muxName,
          '-x',
          String(sizing.cols),
          '-y',
          String(sizing.rows),
        ]);
        return;
      }
      await this.exec('tmux', ['-L', this.socket, 'set-window-option', '-t', muxName, 'window-size', sizing.mode]);
    } catch {
      /* the pane may be gone (the user exited the agent from inside the attach) */
    }
  }

  // ── Live updates ───────────────────────────────────────────────────────────

  /**
   * Subscribe to `/api/events`. The returned stream owns its socket, its
   * watchdog and its backoff timer; `close()` (or the client's) releases all
   * three. Handlers are called synchronously as frames decode.
   */
  subscribeEvents(handlers: TuiEventHandlers, options: TuiSubscribeOptions = {}): TuiEventStream {
    if (!this.base) throw new Error('subscribeEvents() needs a connected client: call connect() first');
    const stream = new SseStream(this.base, this.authHeader(), handlers, options, () => this.streams.delete(stream));
    this.streams.add(stream);
    stream.start();
    return stream;
  }

  /** Tear down every stream this client opened. Safe to call twice. */
  close(): void {
    for (const stream of [...this.streams]) stream.close();
    this.streams.clear();
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private authHeader(): string | undefined {
    return basicAuthHeader(this.credentials);
  }

  /**
   * The header's hostname. No endpoint reports the server's own, so a loopback
   * origin means "this machine" and anything else is named by its URL.
   */
  private resolveHostname(origin: string): string {
    try {
      const host = new URL(origin).hostname;
      if (host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]') return osHostname();
      return host;
    } catch {
      return osHostname();
    }
  }

  /** Unwrap `{success:true,data}`; throw `TuiApiError` on `success:false`. */
  private async requestData<T>(method: string, path: string, body?: unknown): Promise<T | undefined> {
    const payload = await this.requestJson<{ success?: boolean; data?: T }>(method, path, body);
    if (payload && typeof payload === 'object' && payload.success === true) return payload.data;
    return payload as unknown as T;
  }

  /** The parsed response body, envelope and all. */
  private async requestJson<T>(method: string, path: string, body?: unknown): Promise<T | undefined> {
    const response = await this.raw(method, path, body);
    let parsed: unknown;
    if (response.body.trim()) {
      try {
        parsed = JSON.parse(response.body);
      } catch {
        if (response.status >= 400) {
          throw new TuiApiError(httpErrorMessage(response), response.status);
        }
        throw new TuiApiError(`${method} ${path} returned a non-JSON body`, response.status);
      }
    }

    const envelope = parsed as { success?: boolean; error?: string; errorCode?: string } | undefined;
    if (envelope && typeof envelope === 'object' && envelope.success === false) {
      throw new TuiApiError(envelope.error || 'request failed', response.status, envelope.errorCode);
    }
    if (response.status >= 400) {
      throw new TuiApiError(httpErrorMessage(response), response.status);
    }
    return parsed as T | undefined;
  }

  private raw(method: string, path: string, body?: unknown): Promise<RawResponse> {
    if (!this.base) throw new Error('the TUI client is not connected to a server');
    const url = new URL(path, `${this.base}/`);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const transport = url.protocol === 'https:' ? https : http;
    const auth = this.authHeader();

    return new Promise<RawResponse>((resolve, reject) => {
      const headers: Record<string, string | number> = { Accept: 'application/json' };
      if (payload !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      if (auth) headers.Authorization = auth;

      const req = transport.request(
        {
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          method,
          path: `${url.pathname}${url.search}`,
          // Loopback with the self-signed cert `--https` generates: verifying it
          // would fail every local request. Same call the CLI already makes.
          rejectUnauthorized: false,
          timeout: this.timeoutMs,
          headers,
        },
        (res) => {
          let text = '';
          let overflowed = false;
          res.setEncoding('utf-8');
          res.on('data', (chunk: string) => {
            if (overflowed) return;
            if (text.length + chunk.length > MAX_RESPONSE_BYTES) {
              overflowed = true;
              res.destroy();
              reject(new TuiApiError(`${method} ${path} response exceeded ${MAX_RESPONSE_BYTES} bytes`, 507));
              return;
            }
            text += chunk;
          });
          res.on('end', () => {
            if (!overflowed) resolve({ status: res.statusCode ?? 0, body: text });
          });
          res.on('error', (err) => reject(new TuiApiError(getErrorMessage(err), 0)));
        }
      );
      req.on('timeout', () => {
        req.destroy();
        reject(new TuiApiError(`${method} ${path} timed out after ${this.timeoutMs}ms`, 0));
      });
      req.on('error', (err) => reject(new TuiApiError(getErrorMessage(err), 0)));
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }
}

function httpErrorMessage(response: RawResponse): string {
  const detail = response.body.trim().slice(0, 200);
  return detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`;
}

/** Map an answer failure onto the outcomes the dashboard renders differently. */
function answerFailureReason(err: TuiApiError): 'gone' | 'not-found' | 'rejected' | 'failed' {
  if (err.errorCode === 'CONFLICT' || err.status === 409) return 'gone';
  if (err.errorCode === 'NOT_FOUND' || err.status === 404) return 'not-found';
  if (err.errorCode === 'INVALID_INPUT' || err.status === 400) return 'rejected';
  return 'failed';
}

// ─────────────────────────────────────────────────────────────────────────────
// SSE connection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A session id can never look like this, so passing it as the `?sessions=`
 * filter drops every `session:terminal` frame while leaving lifecycle, hook and
 * approval events untouched.
 */
const NO_TERMINAL_FILTER = 'tui-no-terminal';

const DEFAULT_POLLING_AFTER_FAILURES = 2;

class SseStream implements TuiEventStream {
  private req: http.ClientRequest | null = null;
  private res: http.IncomingMessage | null = null;
  private parser = new SseFrameParser();
  private watchdog: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private lastTraffic = 0;
  private attempt = 0;
  private closed = false;
  /** Bumped per connection so a late `error`/`close` cannot fail a newer socket. */
  private generation = 0;
  private _status: TuiSseStatus = 'reconnecting';
  private _recommendPolling = false;

  private readonly staleTimeoutMs: number;
  private readonly checkIntervalMs: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly pollingAfterFailures: number;
  private readonly sessionsParam: string;

  constructor(
    private readonly baseUrl: string,
    private readonly auth: string | undefined,
    private readonly handlers: TuiEventHandlers,
    options: TuiSubscribeOptions,
    private readonly onClosed: () => void
  ) {
    this.staleTimeoutMs = options.staleTimeoutMs ?? SSE_STALE_TIMEOUT_MS;
    this.checkIntervalMs = options.checkIntervalMs ?? Math.max(250, Math.floor(this.staleTimeoutMs / 3));
    this.baseBackoffMs = options.baseBackoffMs ?? SSE_BASE_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? SSE_MAX_BACKOFF_MS;
    this.pollingAfterFailures = options.pollingAfterFailures ?? DEFAULT_POLLING_AFTER_FAILURES;
    this.sessionsParam = options.sessionIds?.length ? options.sessionIds.join(',') : NO_TERMINAL_FILTER;
  }

  get status(): TuiSseStatus {
    return this._status;
  }

  get recommendPolling(): boolean {
    return this._recommendPolling;
  }

  start(): void {
    this.open();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.teardown();
    this.onClosed();
  }

  private open(): void {
    if (this.closed) return;
    const generation = ++this.generation;
    const url = new URL('/api/events', `${this.baseUrl}/`);
    url.searchParams.set('sessions', this.sessionsParam);
    const transport = url.protocol === 'https:' ? https : http;

    const headers: Record<string, string> = { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' };
    if (this.auth) headers.Authorization = this.auth;

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        method: 'GET',
        path: `${url.pathname}${url.search}`,
        rejectUnauthorized: false,
        headers,
      },
      (res) => {
        if (generation !== this.generation || this.closed) {
          res.destroy();
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          this.fail(generation, `event stream refused with HTTP ${res.statusCode ?? 0}`);
          return;
        }
        this.res = res;
        this.attempt = 0;
        this._recommendPolling = false;
        this._status = 'connected';
        this.touch();
        this.armWatchdog();
        this.handlers.onStatus?.('connected', { attempt: 0, recommendPolling: false });

        res.setEncoding('utf-8');
        res.on('data', (chunk: string) => {
          if (generation !== this.generation) return;
          // Any inbound bytes are liveness, comments and padding included.
          this.touch();
          for (const frame of this.parser.feed(chunk)) this.dispatch(frame.event, frame.data);
        });
        res.on('end', () => this.fail(generation, 'event stream ended'));
        res.on('close', () => this.fail(generation, 'event stream closed'));
        res.on('error', (err) => this.fail(generation, getErrorMessage(err)));
      }
    );
    req.on('error', (err) => this.fail(generation, getErrorMessage(err)));
    this.req = req;
    req.end();
  }

  private dispatch(event: string, data: string): void {
    switch (classifySseEvent(event)) {
      case 'heartbeat':
        return;
      case 'init': {
        const state = parseJson<{ version?: string; planUsage?: TuiPlanUsage | null }>(data);
        if (state) this.handlers.onInit?.({ version: state.version, planUsage: state.planUsage ?? null });
        return;
      }
      case 'approval': {
        const payload = parseJson<ApprovalItem & ApprovalResolvedInfo>(data);
        const kind = approvalEventKind(event);
        if (!payload || !kind) return;
        if (kind === 'resolved') {
          this.handlers.onApproval?.({ kind, info: payload as ApprovalResolvedInfo });
        } else {
          this.handlers.onApproval?.({ kind, item: payload as ApprovalItem });
        }
        // An approval landing or clearing also changes how its row is grouped.
        this.handlers.onResync?.(event);
        return;
      }
      case 'plan-usage': {
        const usage = parseJson<TuiPlanUsage>(data);
        if (usage) this.handlers.onPlanUsage?.(usage);
        return;
      }
      case 'resync':
        this.handlers.onResync?.(event);
        return;
      case 'ignore':
        return;
    }
  }

  private touch(): void {
    this.lastTraffic = Date.now();
  }

  private armWatchdog(): void {
    if (this.watchdog) return;
    this.watchdog = setInterval(() => {
      if (this.closed) return;
      if (Date.now() - this.lastTraffic <= this.staleTimeoutMs) return;
      // The socket never errored, it just went quiet: the server heartbeats
      // every 15s, so this is a dead stream that would otherwise freeze every
      // SSE-driven surface until the user restarted the TUI.
      this.fail(this.generation, `no traffic for ${this.staleTimeoutMs}ms`);
    }, this.checkIntervalMs);
  }

  private fail(generation: number, message: string): void {
    if (this.closed || generation !== this.generation) return;
    this.generation++;
    this.teardown();

    this.attempt++;
    this._status = 'reconnecting';
    this._recommendPolling = this.attempt >= this.pollingAfterFailures;
    this.handlers.onStatus?.('reconnecting', {
      attempt: this.attempt,
      recommendPolling: this._recommendPolling,
      message,
    });

    const delay = sseBackoffDelay(this.attempt, this.baseBackoffMs, this.maxBackoffMs);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }

  /** Drop the socket and both timers. Never touches `closed`, so `fail()` can reuse it. */
  private teardown(): void {
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    // The no-op error listeners are not decoration: destroying a socket can
    // emit ECONNRESET, and an `error` event with no listener is an uncaught
    // exception that would take the TUI down on a routine reconnect.
    if (this.res) {
      this.res.removeAllListeners();
      this.res.on('error', () => {});
      this.res.destroy();
      this.res = null;
    }
    if (this.req) {
      this.req.removeAllListeners();
      this.req.on('error', () => {});
      this.req.destroy();
      this.req = null;
    }
    this.parser.reset();
  }
}

function parseJson<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}
