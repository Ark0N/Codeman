/**
 * @fileoverview Blocking-wait registry backing the agent wait primitives.
 *
 * Codeman's only "tell me when" channel today is SSE, which an agent driving the
 * API from a shell tool cannot practically consume (it would have to hold a
 * streaming connection and parse events inline). This registry is the piece that
 * lets a request *block* until something happens instead, so an orchestrating
 * agent can `curl` and wait. Plan: `docs/agent-control-plan.md`.
 *
 * Two waiter kinds:
 * - **signal waiters** resolve on the first of a requested set of lifecycle
 *   signals (`idle`, `working`, `stop`, `blocked`, `exit`).
 * - **output waiters** resolve when a literal string appears in a session's
 *   ANSI-stripped output.
 *
 * ## What "ANSI-stripped output" means here
 *
 * `normalizeForMatch()` defines it, and it is a superset of `stripAnsi()`: that helper
 * knows three escape families and leaves the rest, which is enough for `ESC ( B` from a
 * stock bash prompt to break `match=tnode:` on a prompt that reads `tnode:`. Everything
 * downstream derives from one call to it, so the carry, the haystack and the snippet
 * window are all the same text. The returned `snippet` is then RENDERED from that window
 * (control bytes removed, blank runs collapsed) and so is not a byte-for-byte quotation
 * of what was matched — see `findMatch`.
 *
 * ## Signal provenance (why `stop` is the good one)
 *
 * `idle` / `working` / `exit` come from `Session`'s own events (heuristic: output
 * stabilization plus prompt detection), so `idle` can flap mid-turn when a spinner
 * pauses. `stop` and `blocked` come from Claude Code hooks (`POST /api/hook-event`)
 * and are definitive. Only `claude` mode installs those hooks, so `stop` and
 * `blocked` never fire for anything else: callers must be rejected up front rather
 * than left to hit the timeout. `hooksAvailableForMode()` keeps that rule in one
 * place, and it is keyed on the MODE rather than on `isExternalCliMode()` because
 * `shell` is not an external CLI yet installs no hooks either.
 *
 * ## Ordering contract for the wiring
 *
 * A session that exits must `notifySignal(id, 'exit')` BEFORE `cancelAll(id)`, so
 * a caller waiting on `exit` gets `signal: 'exit'` rather than `ended: true`.
 *
 * ## Lifetime discipline (24h sessions)
 *
 * Every waiter owns exactly one timer, cleared on resolve, and waiter sets are
 * deleted when they empty. Session teardown must call `cancelAll()` and shutdown
 * `stop()`: timers are deliberately NOT unref'd, because an unref'd timer can let
 * the process exit mid-wait and strand the HTTP response.
 *
 * Two things keep a slot from outliving its caller:
 * - `abortSignal`, so a client that hangs up frees its waiter immediately instead of
 *   holding one for the rest of its timeout. Routes wire it to `req.raw.on('close')`.
 * - the latched stopped flag, so a request that lands in the window between shutdown
 *   starting and the HTTP server actually closing cannot register a fresh waiter that
 *   nothing will ever cancel.
 *
 * This module holds no IO and no `Session` reference, which is what keeps it
 * unit-testable in isolation.
 */

import { stripAnsi } from '../utils/index.js';
import {
  MAX_WAITERS_PER_SESSION,
  MAX_WAITERS_PER_OWNER,
  MAX_WAITERS_TOTAL,
  MAX_SNIPPET_CONTEXT,
} from '../config/agent-wait.js';
import type { SessionMode, SessionStatus } from '../types.js';
import { getCli } from '../config/cli-registry/registry.js';

// ─── Signals ─────────────────────────────────────────────────────────────────

/** A lifecycle signal a caller can block on. */
export type WaitSignal = 'idle' | 'working' | 'stop' | 'blocked' | 'exit';

/** Every valid signal, in documentation order. */
export const WAIT_SIGNALS: readonly WaitSignal[] = ['idle', 'working', 'stop', 'blocked', 'exit'];

/**
 * Applied when a caller omits `until`. `stop` first because it is the definitive
 * end-of-turn signal, `idle` as the fallback for sessions that emit no hooks, and
 * `exit` so a worker that CRASHES resolves the wait promptly instead of burning
 * the caller's whole timeout on something that can no longer happen.
 */
export const DEFAULT_WAIT_SIGNALS: readonly WaitSignal[] = ['stop', 'idle', 'exit'];

const SIGNAL_SET = new Set<string>(WAIT_SIGNALS);

/** Result of parsing a caller-supplied `until` value. */
export interface ParsedWaitSignals {
  /** Valid signals, deduped, in the order given. */
  signals: WaitSignal[];
  /** Tokens that are not signals. Non-empty means the caller should get a 400. */
  invalid: string[];
}

/**
 * Parse an `until` query value: a comma-separated string, an array of strings, or
 * absent. Invalid tokens are REPORTED rather than dropped: silently falling back
 * to the default would leave an agent believing it is waiting for `stop` when a
 * typo means it is waiting for something else entirely.
 *
 * @param raw - `"stop,idle"`, `["stop","idle"]`, or undefined
 * @returns valid signals plus any unrecognized tokens
 */
export function parseWaitSignals(raw: unknown): ParsedWaitSignals {
  const tokens: string[] = [];
  if (typeof raw === 'string') {
    tokens.push(...raw.split(','));
  } else if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry === 'string') tokens.push(...entry.split(','));
    }
  }

  const signals: WaitSignal[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const value = token.trim().toLowerCase();
    if (!value) continue;
    if (!SIGNAL_SET.has(value)) {
      if (!invalid.includes(value)) invalid.push(value);
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    signals.push(value as WaitSignal);
  }
  return { signals, invalid };
}

/**
 * The signal a session is *already* emitting, given its status, so a wait can
 * resolve immediately instead of hanging until something changes.
 *
 * ⚠️ **What this CANNOT tell you: whether the session is alive.** It sees only the
 * four-value `SessionStatus` enum, and that enum does not distinguish a finished
 * worker from a dead one. Both PTY `onExit` handlers in `session.ts` (Claude
 * interactive and shell) park the session at `'idle'`, and a PTY exit does not remove
 * the session from the map, so a crashed worker reports `'idle'` indefinitely and this
 * function will answer `'idle'` for it forever. `'stopped'` is set only on a spawn
 * failure and by `stop(killMux:true)` (which deletes the session moments later), so in
 * practice the `'stopped' → 'exit'` arm almost never fires for a session that merely
 * died.
 *
 * Read the return value as "what state is it in", never as "is it still running". A
 * caller that must tell a completed turn from a corpse has to consult liveness itself
 * (`session.pid`, which is null after a PTY exit) and cannot get it from here. The
 * live `exit` signal is still delivered by `notifySignal(id, 'exit')` at the moment
 * the PTY dies; this function is only about the state a LATER caller finds.
 *
 * `stopped` and `error` both map to `exit` because both mean "not running", so a
 * caller that does catch one of them does not block. `blocked` is deliberately
 * underivable here, it exists only as a hook event until it becomes a real
 * `SessionStatus` (see the deferred Part 3 in the plan).
 */
export function signalForStatus(status: SessionStatus): WaitSignal | null {
  switch (status) {
    case 'idle':
      return 'idle';
    case 'busy':
      return 'working';
    case 'stopped':
    case 'error':
      return 'exit';
    default:
      return null;
  }
}

/** Signals that arrive only via Claude Code hooks, so only `claude` mode can emit them. */
const HOOK_ONLY_SIGNALS: readonly WaitSignal[] = ['stop', 'blocked'];

/** Per-session facts that can turn a mode's hook capability OFF for one session. */
export interface HookCapabilityOptions {
  /**
   * `deepSeekConfig.statusReporting`, verbatim (so `undefined` means "not sent",
   * i.e. ON). `false` is the per-session opt-out that stops `_configureCliEnv()`
   * exporting the `HERDR_*` triple, which is the ONLY thing that makes a dsh
   * session emit hook events at all.
   */
  deepSeekStatusReporting?: boolean;
  /**
   * True when the pane's harness runs somewhere the status bridge cannot reach:
   * a docker case (`docker exec` does not carry the local tmux env into the
   * container, and the loopback-bound API is unreachable from it) or a
   * remote-SSH case (the `HERDR_*` triple is set on the LOCAL ssh process, not
   * the remote shell). Such a session never posts a hook event however the
   * statusReporting flag is set, so `until=stop` on it would burn its whole
   * timeout on every turn.
   */
  deepSeekBridgeUnreachable?: boolean;
  /**
   * True when the session is a WRAPPER around a tmux session a human started
   * outside Codeman.
   *
   * This one overrides the mode entirely, and it has to: an adopted session can
   * be `mode: 'claude'` and still have no hooks, because hooks are installed into
   * a WORKSPACE at session-create time (`applyWorkspaceHooks`) and we never
   * created this one. Answering from the mode there would promise `stop` and
   * `blocked` for a process that can never post either — the exact
   * infinite-wait-dressed-as-a-timeout this predicate exists to prevent.
   */
  adopted?: boolean;
}

/**
 * Whether this session ever POSTs Codeman hook events, and therefore whether
 * `stop` / `blocked` can ever fire for it.
 *
 * `claude` always (Claude Code fires the hooks itself), `deepseek` when its
 * status bridge is armed, nothing else. The tempting predicate is
 * `!isExternalCliMode(mode)`, and it is WRONG: that helper covers only
 * opencode/codex/gemini/antigravity, so `shell` falls through it — and a shell session
 * is a plain bash PTY with no Claude Code and no hooks installed. `until=stop` on one
 * was accepted and then blocked for the caller's whole timeout, which is precisely the
 * infinite-wait-dressed-as-a-timeout this guard exists to prevent.
 *
 * ⚠️ `deepseek` is a per-SESSION answer, not a per-mode one, which is why the
 * options argument exists: `deepSeekConfig.statusReporting: false` disarms the
 * bridge for one session, and answering from the mode alone re-creates the exact
 * infinite-wait this guard is for. Every call site therefore passes the session's
 * own flag; the default stays permissive so a forgotten one degrades to the old
 * behavior rather than 400ing a session that works.
 *
 * ⚠️ It is also the LIMIT of what can be known at request time. Whether the
 * installed profile actually implements the supervisor contract is only
 * observable once it reports, and `resolveDefaultDeepSeekProfile()` deliberately
 * treats an unrecognized profile as launchable, so a dsh session running a
 * non-conforming TUI still answers true here and still times out on an explicit
 * `until=stop`. The default signal set keeps `idle`/`exit` for exactly that case.
 *
 * ⚠️ NOT a stand-in for "is this a claude session". It reads like one and it was
 * used as one (Read My Mind, intent capture) until `deepseek` joined and silently
 * widened both. Those sites compare `mode === 'claude'` directly now; ask this
 * function only about hook SIGNALS.
 */
export function hooksAvailableForMode(mode: SessionMode, options: HookCapabilityOptions = {}): boolean {
  // Checked BEFORE the mode: adoption is about who launched the process, and no
  // mode can vouch for a workspace Codeman never touched. See `adopted` above.
  if (options.adopted) return false;
  // A TRI-state capability, not a boolean, because the three answers are genuinely
  // different questions — see CliCapabilities.hooks.
  switch (getCli(mode)?.capabilities.hooks) {
    case 'always':
      // The CLI installs Codeman's own hooks block into its workspace (claude), so the
      // signals are unconditional.
      return true;
    case 'supervised':
      // The CLI REPORTS its own state to a supervisor and Codeman is that supervisor
      // (deepseek, via deepseek-status-shim.ts) — definitive signals rather than inferred
      // ones, which is what earns it a yes. But the user can disarm the bridge, and a
      // docker/remote session cannot reach it at all; in either case nothing on the box
      // will ever post one, so the answer has to come from the SESSION, not the mode.
      return options.deepSeekStatusReporting !== false && options.deepSeekBridgeUnreachable !== true;
    default:
      // 'none', and an unregistered mode. Every other CLI's idle is output-stabilization
      // guesswork, and must keep failing the ask rather than promising a signal that never
      // arrives.
      return false;
  }
}

/**
 * Lift the per-session hook facts off a live session.
 *
 * Structurally typed on purpose: this module is pure and deliberately imports no
 * `Session` (importing it would drag node-pty and the session layer into every
 * consumer). One helper rather than an inline object literal at each of the four
 * call sites, so a future per-session fact is added in one place instead of
 * being forgotten at three of them.
 */
export function sessionHookOptions(session: {
  deepSeekStatusReporting?: boolean;
  docker?: unknown;
  remote?: unknown;
  adopt?: unknown;
}): HookCapabilityOptions {
  return {
    deepSeekStatusReporting: session.deepSeekStatusReporting,
    deepSeekBridgeUnreachable: Boolean(session.docker || session.remote),
    adopted: Boolean(session.adopt),
  };
}

/** Outcome of resolving a caller-supplied wait target against a session's mode. */
export interface ResolvedWaitSignals {
  /** Signals to actually wait on. Empty when `error` is set. */
  until: WaitSignal[];
  /** Caller-facing 400 message, or null when the request is usable. */
  error: string | null;
}

/**
 * Turn a raw `until` / `wait` value into the set to wait on, applying both rules
 * every wait endpoint shares:
 *
 * 1. An unknown token is an ERROR, never a silent fallback to the default.
 * 2. Hook-only signals are rejected when asked for EXPLICITLY on a mode that emits
 *    no hooks, but merely dropped from the DEFAULT set: omitting the parameter must
 *    never 400.
 *
 * Shared by `GET .../wait` and the `wait` field on `POST .../input` so the two can
 * not drift; the second-guessing that produces is worse than the duplication.
 *
 * @param raw - the caller's value (comma string, array, `true` for "the default")
 * @param options - `mode` plus the per-session facts `hooksAvailableForMode()` needs
 *                  (a dsh session with its status bridge disarmed emits no hooks even
 *                  though the mode can). The mode also names itself in the error
 *                  message so the caller can see why.
 */
export function resolveWaitSignals(
  raw: unknown,
  options: { mode: SessionMode } & HookCapabilityOptions
): ResolvedWaitSignals {
  const parsed = parseWaitSignals(raw);
  if (parsed.invalid.length > 0) {
    return {
      until: [],
      error: `Unknown wait signal(s): ${parsed.invalid.join(', ')}. Valid: ${WAIT_SIGNALS.join(', ')}`,
    };
  }

  const unsupported = new Set<WaitSignal>(hooksAvailableForMode(options.mode, options) ? [] : HOOK_ONLY_SIGNALS);

  if (parsed.signals.length === 0) {
    return { until: DEFAULT_WAIT_SIGNALS.filter((signal) => !unsupported.has(signal)), error: null };
  }

  const rejected = parsed.signals.filter((signal) => unsupported.has(signal));
  if (rejected.length > 0) {
    return {
      until: [],
      // A dsh session is the one case where the mode is capable and THIS session
      // is not, so saying "never fire for deepseek sessions" would send the
      // caller looking for a bug that is really a setting they chose.
      error:
        options.mode === 'deepseek'
          ? options.deepSeekBridgeUnreachable
            ? `Signal(s) ${rejected.join(', ')} never fire for this deepseek session: it runs in a container or on ` +
              `a remote host, where the local status bridge cannot reach the harness. Use idle or exit.`
            : `Signal(s) ${rejected.join(', ')} never fire for this deepseek session: its status bridge is off ` +
              `(deepSeekConfig.statusReporting: false), so nothing posts hook events. Use idle or exit.`
          : `Signal(s) ${rejected.join(', ')} never fire for ${options.mode} sessions (no Claude Code hooks). Use idle or exit.`,
    };
  }
  return { until: parsed.signals, error: null };
}

// ─── Results ─────────────────────────────────────────────────────────────────

/** Fields every wait result carries, whichever kind it is. */
interface WaitResultBase {
  /** True when the wait hit its timeout. */
  timedOut: boolean;
  /** True when the answer came from state already present at call time. */
  immediate: boolean;
  /** True when the session went away (deleted / torn down) before the wait resolved. */
  ended: boolean;
  /**
   * True when the caller's `abortSignal` fired: the client hung up, so nobody is
   * reading this result. `ended` is set alongside it, since the wait did end without
   * an answer. False on every other path.
   */
  aborted: boolean;
  /** Wall-clock ms spent waiting (0 for an immediate resolve). */
  waitedMs: number;
  /**
   * The timeout actually applied, after clamping. Echoed because a caller that asked
   * for 30 minutes and silently got 600s otherwise reads the timeout as a stalled
   * worker and kills a session that was working fine.
   */
  timeoutMs: number;
}

/** Outcome of a signal wait. A timeout is a normal outcome, never an error. */
export interface SignalWaitResult extends WaitResultBase {
  /** The signal that fired, or null if the wait ended without one. */
  signal: WaitSignal | null;
}

/** Outcome of an output wait. */
export interface OutputWaitResult extends WaitResultBase {
  matched: boolean;
  /** Bounded window of output around the match, or null if nothing matched. */
  snippet: string | null;
}

/**
 * Thrown when a waiter would exceed a configured cap.
 *
 * `scope` is what the route needs to answer honestly: `'session'` is the caller's own
 * session being oversubscribed (409 SESSION_BUSY), while `'owner'` and `'total'` are
 * caps the caller may have no part in and cannot fix by switching sessions, so those
 * map to 429 RATE_LIMITED. Reporting a process-wide cap as SESSION_BUSY tells the
 * caller the wrong session is at fault.
 */
export class WaitCapacityError extends Error {
  override readonly name = 'WaitCapacityError';
  constructor(
    message: string,
    /** Which cap was hit, so the route can say something useful. */
    readonly scope: 'session' | 'owner' | 'total'
  ) {
    super(message);
  }
}

// ─── Options ─────────────────────────────────────────────────────────────────

/** Options shared by both wait kinds. */
interface WaitOptionsBase {
  /** Timeout in ms. Callers pass the CLAMPED value; it is echoed back in the result. */
  timeoutMs: number;
  /**
   * Owner to charge this waiter to (multi-user mode). Omit in single-user mode: the
   * per-owner cap applies only when this is set, so leaving it undefined behaves
   * exactly as if the cap did not exist.
   */
  owner?: string;
  /**
   * Fires when the caller goes away (routes wire this to `req.raw.on('close')`).
   * The waiter is removed and its timer cleared at once, resolving `ended: true,
   * aborted: true`. Freeing the slot is the entire point: the response can no longer
   * be sent, so holding one for the rest of the timeout only denies the pool to
   * someone else. An already-aborted signal registers no waiter at all.
   */
  abortSignal?: AbortSignal;
}

export interface SignalWaitOptions extends WaitOptionsBase {
  /** Signals to wait for; the first to fire wins. An empty set can only time out. */
  until: readonly WaitSignal[];
  /**
   * When true, ignore `currentSignal` and require an actual transition. This is
   * the `fresh=1` behavior: "tell me about the NEXT one", not "is it already so".
   */
  requireTransition?: boolean;
  /** The session's current signal (from `signalForStatus`), if known. */
  currentSignal?: WaitSignal | null;
}

export interface OutputWaitOptions extends WaitOptionsBase {
  /** Literal substring to look for. No regex: see the note on `waitForOutput`. */
  match: string;
  /** Case-insensitive compare. */
  nocase?: boolean;
  /**
   * Existing buffered output to scan before waiting (the `from=buffer` mode).
   * Callers should pass a BOUNDED slice: a session's text buffer can be tens of
   * megabytes and this is scanned synchronously. `assertCapacity()` runs BEFORE this
   * is touched, so a request that cannot get a slot never pays for the scan.
   */
  initialText?: string;
}

export interface SessionWaitRegistryOptions {
  maxWaitersPerSession?: number;
  maxWaitersPerOwner?: number;
  maxWaitersTotal?: number;
}

// ─── Internal waiter records ─────────────────────────────────────────────────

/** Bookkeeping every waiter carries, whichever kind it is. */
interface WaiterBase {
  startedAt: number;
  timer: NodeJS.Timeout;
  /** Effective timeout, echoed back in the result. */
  timeoutMs: number;
  /** Owner this waiter is charged to, if any. */
  owner?: string;
  /** Detaches the abort listener; called on every removal path. */
  detachAbort?: () => void;
}

interface SignalWaiter extends WaiterBase {
  until: Set<WaitSignal>;
  settle: (result: SignalWaitResult) => void;
}

interface OutputWaiter extends WaiterBase {
  /** Original-case needle, kept for reporting. */
  needle: string;
  /** Comparison form of the needle (lowercased when nocase). */
  needleCmp: string;
  nocase: boolean;
  /** Tail of previously scanned text, so a match can straddle two chunks. */
  carry: string;
  settle: (result: OutputWaitResult) => void;
}

// ─── Registry ────────────────────────────────────────────────────────────────

/**
 * Holds pending waiters keyed by session id.
 *
 * One instance is shared process-wide (`sessionWaits` below); tests construct
 * their own so no state leaks between cases.
 */
export class SessionWaitRegistry {
  private readonly signalWaiters = new Map<string, Set<SignalWaiter>>();
  private readonly outputWaiters = new Map<string, Set<OutputWaiter>>();
  /**
   * Live waiter count per owner. A derived count would mean walking every waiter in
   * the process on each registration, so it is maintained incrementally instead:
   * incremented once at registration, decremented once in the remove* helpers, which
   * are the only paths that take a waiter out of a set.
   */
  private readonly ownerCounts = new Map<string, number>();
  /**
   * Trailing bytes of a PTY chunk that look like the START of an ANSI sequence whose
   * terminator has not arrived yet, held back until the next chunk completes it. Keyed
   * by session because every output waiter on a session sees the same stream, which
   * keeps `notifyOutput` at ONE `stripAnsi` per chunk rather than one per waiter.
   * Deleted with the session's waiter set.
   */
  private readonly pendingAnsi = new Map<string, string>();
  private readonly maxPerSession: number;
  private readonly maxPerOwner: number;
  private readonly maxTotal: number;
  /** Latched by `stop()` / `cancelEverything()`. Never cleared: shutdown is one-way. */
  private stopped = false;

  constructor(options: SessionWaitRegistryOptions = {}) {
    this.maxPerSession = options.maxWaitersPerSession ?? MAX_WAITERS_PER_SESSION;
    this.maxPerOwner = options.maxWaitersPerOwner ?? MAX_WAITERS_PER_OWNER;
    this.maxTotal = options.maxWaitersTotal ?? MAX_WAITERS_TOTAL;
  }

  // ── Counts (also the cap accounting) ──

  /** Pending signal waiters for a session. */
  signalWaiterCount(sessionId: string): number {
    return this.signalWaiters.get(sessionId)?.size ?? 0;
  }

  /** Pending output waiters for a session. */
  outputWaiterCount(sessionId: string): number {
    return this.outputWaiters.get(sessionId)?.size ?? 0;
  }

  /** Pending waiters of both kinds for a session. */
  waiterCount(sessionId: string): number {
    return this.signalWaiterCount(sessionId) + this.outputWaiterCount(sessionId);
  }

  /** Pending waiters of both kinds across every session. */
  totalWaiterCount(): number {
    let total = 0;
    for (const set of this.signalWaiters.values()) total += set.size;
    for (const set of this.outputWaiters.values()) total += set.size;
    return total;
  }

  /** Pending waiters of both kinds charged to one owner. */
  ownerWaiterCount(owner: string): number {
    return this.ownerCounts.get(owner) ?? 0;
  }

  /** True once `stop()` / `cancelEverything()` has run: no new waiter can register. */
  get isStopped(): boolean {
    return this.stopped;
  }

  /**
   * Throw if registering one more waiter would exceed a cap.
   *
   * PUBLIC so a route can check BEFORE doing expensive setup work. `/wait-output`'s
   * `from=buffer` mode is the case that matters: reading `session.terminalBuffer`
   * joins the whole 32MB accumulator, and paying that for a request that is about to
   * be refused turns the cap into an amplifier instead of a protection. Both
   * `waitForSignal` and `waitForOutput` call it themselves too, so a caller that skips
   * the pre-check is still bounded.
   *
   * @throws {WaitCapacityError} naming the cap that was hit in `scope`.
   */
  assertCapacity(sessionId: string, owner?: string): void {
    if (this.totalWaiterCount() >= this.maxTotal) {
      throw new WaitCapacityError(`Too many concurrent waits (scope: total, max ${this.maxTotal})`, 'total');
    }
    if (owner !== undefined && this.ownerWaiterCount(owner) >= this.maxPerOwner) {
      throw new WaitCapacityError(
        `Too many concurrent waits for this user (scope: owner, max ${this.maxPerOwner})`,
        'owner'
      );
    }
    if (this.waiterCount(sessionId) >= this.maxPerSession) {
      throw new WaitCapacityError(
        `Too many concurrent waits on this session (scope: session, max ${this.maxPerSession})`,
        'session'
      );
    }
  }

  private chargeOwner(owner: string | undefined): void {
    if (owner === undefined) return;
    this.ownerCounts.set(owner, (this.ownerCounts.get(owner) ?? 0) + 1);
  }

  private releaseOwner(owner: string | undefined): void {
    if (owner === undefined) return;
    const next = (this.ownerCounts.get(owner) ?? 0) - 1;
    if (next > 0) this.ownerCounts.set(owner, next);
    else this.ownerCounts.delete(owner);
  }

  /**
   * Wire a caller's abort signal to `onAbort`, returning the detach function.
   * Detaching matters even though request signals are short-lived: without it a
   * caller reusing one controller across several waits accumulates listeners on it.
   */
  private attachAbort(signal: AbortSignal | undefined, onAbort: () => void): (() => void) | undefined {
    if (!signal) return undefined;
    signal.addEventListener('abort', onAbort, { once: true });
    return () => signal.removeEventListener('abort', onAbort);
  }

  // ── Signal waits ──

  /**
   * Block until one of `until` fires, the timeout elapses, or the session ends.
   *
   * Resolves immediately (`immediate: true`) when the session's `currentSignal` is
   * already in `until` and `requireTransition` is not set.
   *
   * @throws {WaitCapacityError} when a waiter cap is already reached.
   */
  waitForSignal(sessionId: string, options: SignalWaitOptions): Promise<SignalWaitResult> {
    const until = new Set(options.until);
    const base = { signal: null, timedOut: false, immediate: false, waitedMs: 0, timeoutMs: options.timeoutMs };

    // Nobody is listening / nothing can ever resolve: answer without taking a slot,
    // and without a capacity throw the caller could not act on either way.
    if (options.abortSignal?.aborted) return Promise.resolve({ ...base, ended: true, aborted: true });
    if (this.stopped) return Promise.resolve({ ...base, ended: true, aborted: false });

    if (!options.requireTransition && options.currentSignal && until.has(options.currentSignal)) {
      return Promise.resolve({
        signal: options.currentSignal,
        timedOut: false,
        immediate: true,
        ended: false,
        aborted: false,
        waitedMs: 0,
        timeoutMs: options.timeoutMs,
      });
    }

    this.assertCapacity(sessionId, options.owner);

    return new Promise<SignalWaitResult>((resolve) => {
      let set = this.signalWaiters.get(sessionId);
      if (!set) {
        set = new Set<SignalWaiter>();
        this.signalWaiters.set(sessionId, set);
      }

      const waiter: SignalWaiter = {
        until,
        startedAt: Date.now(),
        timeoutMs: options.timeoutMs,
        owner: options.owner,
        timer: setTimeout(() => {
          this.removeSignalWaiter(sessionId, waiter);
          resolve({
            signal: null,
            timedOut: true,
            immediate: false,
            ended: false,
            aborted: false,
            waitedMs: Date.now() - waiter.startedAt,
            timeoutMs: waiter.timeoutMs,
          });
        }, options.timeoutMs),
        settle: resolve,
      };
      set.add(waiter);
      this.chargeOwner(options.owner);
      waiter.detachAbort = this.attachAbort(options.abortSignal, () => {
        this.removeSignalWaiter(sessionId, waiter);
        resolve({
          signal: null,
          timedOut: false,
          immediate: false,
          ended: true,
          aborted: true,
          waitedMs: Date.now() - waiter.startedAt,
          timeoutMs: waiter.timeoutMs,
        });
      });
    });
  }

  /**
   * Deliver a lifecycle signal. Every waiter for this session that asked for it
   * resolves; the rest keep waiting.
   *
   * @returns how many waiters were resolved (0 is the overwhelmingly common case,
   *          which is why this is safe to call from the session event hot path).
   */
  notifySignal(sessionId: string, signal: WaitSignal): number {
    const set = this.signalWaiters.get(sessionId);
    if (!set || set.size === 0) return 0;

    // Snapshot: settling mutates the set.
    let resolved = 0;
    for (const waiter of [...set]) {
      if (!waiter.until.has(signal)) continue;
      this.removeSignalWaiter(sessionId, waiter);
      waiter.settle({
        signal,
        timedOut: false,
        immediate: false,
        ended: false,
        aborted: false,
        waitedMs: Date.now() - waiter.startedAt,
        timeoutMs: waiter.timeoutMs,
      });
      resolved++;
    }
    return resolved;
  }

  private removeSignalWaiter(sessionId: string, waiter: SignalWaiter): void {
    clearTimeout(waiter.timer);
    waiter.detachAbort?.();
    const set = this.signalWaiters.get(sessionId);
    if (!set) return;
    // Guard on the delete: a second removal (abort racing a resolve) must not
    // decrement the owner count twice and hand out a slot that is still in use.
    if (!set.delete(waiter)) return;
    this.releaseOwner(waiter.owner);
    if (set.size === 0) this.signalWaiters.delete(sessionId);
  }

  // ── Output waits ──

  /**
   * Block until `match` appears in the session's output.
   *
   * **Literal matching only, deliberately.** `search-service.ts` avoids regex so
   * there is no ReDoS surface, and this endpoint is more exposed still: the
   * pattern is caller-supplied and the input is a live stream. herdr can offer
   * `--regex` because Rust's regex crate is linear-time with no backtracking;
   * JavaScript's `RegExp` backtracks.
   *
   * ⚠️ "New output" is not the same as "output produced after you asked". tmux
   * REPAINTS the visible screen (on attach, resize, or a TUI redraw), and a repaint
   * arrives as ordinary `terminal` data, so text that was already on screen can
   * match a `from=now` wait. Observed live: a marker echoed a minute earlier matched
   * instantly on a fresh wait. Callers must use a marker unique to the call
   * (`echo DONE_$RANDOM`), not a generic one like `BUILD OK`.
   *
   * @throws {WaitCapacityError} when a waiter cap is already reached.
   */
  waitForOutput(sessionId: string, options: OutputWaitOptions): Promise<OutputWaitResult> {
    const nocase = options.nocase === true;
    const needle = options.match;
    const needleCmp = nocase ? needle.toLowerCase() : needle;
    const base = {
      matched: false,
      timedOut: false,
      immediate: false,
      snippet: null,
      waitedMs: 0,
      timeoutMs: options.timeoutMs,
    };

    if (options.abortSignal?.aborted) return Promise.resolve({ ...base, ended: true, aborted: true });
    if (this.stopped) return Promise.resolve({ ...base, ended: true, aborted: false });

    // Capacity FIRST, deliberately: the `from=buffer` scan below strips ANSI over (and
    // for nocase lowercases again) up to MAX_BUFFER_SCAN_BYTES, and the route has
    // already joined the session's whole terminal buffer to produce it. Doing that for
    // a request that is about to be refused is unbounded work at request rate with the
    // caps providing no backpressure at all.
    this.assertCapacity(sessionId, options.owner);

    // `from=buffer`: scan what is already there before blocking.
    let carry = '';
    if (options.initialText) {
      const text = normalizeForMatch(options.initialText);
      const hit = findMatch(text, needleCmp, nocase);
      if (hit) {
        return Promise.resolve({
          matched: true,
          timedOut: false,
          immediate: true,
          ended: false,
          aborted: false,
          snippet: hit,
          waitedMs: 0,
          timeoutMs: options.timeoutMs,
        });
      }
      carry = tailFor(text, needleCmp.length);
    }

    return new Promise<OutputWaitResult>((resolve) => {
      let set = this.outputWaiters.get(sessionId);
      if (!set) {
        set = new Set<OutputWaiter>();
        this.outputWaiters.set(sessionId, set);
      }

      const waiter: OutputWaiter = {
        needle,
        needleCmp,
        nocase,
        carry,
        startedAt: Date.now(),
        timeoutMs: options.timeoutMs,
        owner: options.owner,
        timer: setTimeout(() => {
          this.removeOutputWaiter(sessionId, waiter);
          resolve({
            matched: false,
            timedOut: true,
            immediate: false,
            ended: false,
            aborted: false,
            snippet: null,
            waitedMs: Date.now() - waiter.startedAt,
            timeoutMs: waiter.timeoutMs,
          });
        }, options.timeoutMs),
        settle: resolve,
      };
      set.add(waiter);
      this.chargeOwner(options.owner);
      waiter.detachAbort = this.attachAbort(options.abortSignal, () => {
        this.removeOutputWaiter(sessionId, waiter);
        resolve({
          matched: false,
          timedOut: false,
          immediate: false,
          ended: true,
          aborted: true,
          snippet: null,
          waitedMs: Date.now() - waiter.startedAt,
          timeoutMs: waiter.timeoutMs,
        });
      });
    });
  }

  /**
   * Feed a raw PTY chunk to this session's output waiters.
   *
   * Called from the always-attached `terminal` listener, so it sits on the PTY hot
   * path: it must stay a single Map lookup when nobody is waiting, which is why the
   * no-waiter check comes before the ANSI strip.
   *
   * ⚠️ A PTY read boundary can fall INSIDE an escape sequence, which is routine under
   * tmux (it emits SGR runs constantly). `stripAnsi` needs a complete sequence, so a
   * split one used to survive the strip, land in the carry, and split the needle: the
   * same text matched or not depending on where the kernel happened to cut the read.
   * The incomplete tail is therefore held back in `pendingAnsi` and stripped together
   * with the next chunk. That is the same class of bug the carry buffer exists to
   * solve, one level down.
   *
   * @returns how many waiters matched.
   */
  notifyOutput(sessionId: string, chunk: string): number {
    const set = this.outputWaiters.get(sessionId);
    if (!set || set.size === 0) return 0;

    const pending = this.pendingAnsi.get(sessionId);
    const split = splitTrailingEscape(pending ? pending + chunk : chunk);
    if (split.pending) this.pendingAnsi.set(sessionId, split.pending);
    else if (pending !== undefined) this.pendingAnsi.delete(sessionId);

    const text = normalizeForMatch(split.text);
    if (!text) return 0;

    let resolved = 0;
    for (const waiter of [...set]) {
      // Prepend the tail of what this waiter already scanned so a match spanning
      // two chunks is still found. Re-scanning the carry cannot double-fire: a
      // needle wholly inside the carry would have matched on the previous pass.
      const hay = waiter.carry + text;
      const hit = findMatch(hay, waiter.needleCmp, waiter.nocase);
      if (hit) {
        this.removeOutputWaiter(sessionId, waiter);
        waiter.settle({
          matched: true,
          timedOut: false,
          immediate: false,
          ended: false,
          aborted: false,
          snippet: hit,
          waitedMs: Date.now() - waiter.startedAt,
          timeoutMs: waiter.timeoutMs,
        });
        resolved++;
        continue;
      }
      waiter.carry = tailFor(hay, waiter.needleCmp.length);
    }
    return resolved;
  }

  private removeOutputWaiter(sessionId: string, waiter: OutputWaiter): void {
    clearTimeout(waiter.timer);
    waiter.detachAbort?.();
    const set = this.outputWaiters.get(sessionId);
    if (!set) return;
    if (!set.delete(waiter)) return;
    this.releaseOwner(waiter.owner);
    if (set.size === 0) {
      this.outputWaiters.delete(sessionId);
      // The held-back escape tail belongs to the waiter set; with nobody watching it
      // would be a per-session string kept alive for the life of the process.
      this.pendingAnsi.delete(sessionId);
    }
  }

  // ── Teardown ──

  /**
   * Resolve every waiter for a session with `ended: true`.
   *
   * Call on session deletion and PTY teardown. A session that EXITS should
   * `notifySignal(id, 'exit')` first, so an `until=exit` caller sees the signal
   * rather than a bare `ended`.
   *
   * @returns how many waiters were resolved.
   */
  cancelAll(sessionId: string): number {
    let resolved = 0;

    const signals = this.signalWaiters.get(sessionId);
    if (signals) {
      for (const waiter of [...signals]) {
        this.removeSignalWaiter(sessionId, waiter);
        waiter.settle({
          signal: null,
          timedOut: false,
          immediate: false,
          ended: true,
          aborted: false,
          waitedMs: Date.now() - waiter.startedAt,
          timeoutMs: waiter.timeoutMs,
        });
        resolved++;
      }
    }

    const outputs = this.outputWaiters.get(sessionId);
    if (outputs) {
      for (const waiter of [...outputs]) {
        this.removeOutputWaiter(sessionId, waiter);
        waiter.settle({
          matched: false,
          timedOut: false,
          immediate: false,
          ended: true,
          aborted: false,
          snippet: null,
          waitedMs: Date.now() - waiter.startedAt,
          timeoutMs: waiter.timeoutMs,
        });
        resolved++;
      }
    }

    this.pendingAnsi.delete(sessionId);
    return resolved;
  }

  /**
   * Resolve every waiter in the process and refuse every later one.
   *
   * Shutdown must call this: waiter timers are not unref'd, so a pending 10-minute
   * wait would otherwise hold the event loop open and strand its HTTP response.
   *
   * ⚠️ The latch is the point, not just the sweep. `server.stop()` cancels waiters
   * well before `app.close()`, with several awaits in between (orchestrator teardown,
   * scheduled-run stops that each await a session stop and a tmux kill), and the
   * listener is still accepting requests throughout. A `GET .../wait?timeout=600000`
   * landing in that window used to register a fresh waiter that nothing would ever
   * cancel, stalling shutdown for up to `MAX_WAIT_MS` — exactly the outcome cancelling
   * was meant to prevent. Once latched, a wait resolves at once with `ended: true`.
   */
  stop(): number {
    this.stopped = true;
    return this.cancelEverything();
  }

  /**
   * Resolve every waiter in the process. Latches the stopped flag, so this is
   * shutdown-shaped; `stop()` is the same call under the name that says so.
   */
  cancelEverything(): number {
    this.stopped = true;
    let resolved = 0;
    const ids = new Set([...this.signalWaiters.keys(), ...this.outputWaiters.keys()]);
    for (const id of ids) resolved += this.cancelAll(id);
    return resolved;
  }
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Escape sequences `stripAnsi` leaves behind, removed so the text this module MATCHES
 * against is what the pane visually shows.
 *
 * `ANSI_ESCAPE_PATTERN_FULL` covers three families — `ESC [ … letter`,
 * `ESC ] … (BEL|ST)`, and `ESC =` / `ESC >` — and nothing else. The gap is not
 * theoretical: a stock bash prompt emits `arkon@tnode\x1b(B\x1b[m:`, the CSI is removed
 * and the charset-select `ESC ( B` is not, so `match=tnode:` **fails on a prompt that
 * plainly reads `tnode:`** while `match=(B` succeeds. That is the single most likely
 * thing an orchestrating agent tries, and the failure is silent (a full-length timeout).
 *
 * Two branches, in order:
 * - `ESC P|X|^|_ … (BEL|ST)` — DCS / SOS / PM / APC string sequences. The terminator is
 *   REQUIRED, exactly as `stripAnsi`'s OSC branch requires one: matching an unterminated
 *   string type with a greedy run would delete every byte after it to the end of the
 *   window, which is real output an agent is waiting for.
 * - `ESC <0x20-0x2f>* <0x30-0x7e>` — the ECMA-48 escape-sequence grammar (zero or more
 *   intermediate bytes then a final byte). This is what covers `ESC ( B`, `ESC ) 0`,
 *   `ESC c`, `ESC 7` / `ESC 8`, `ESC # 8` and a stray `ESC \`.
 *
 * Linear-time by the same argument that holds for `stripAnsi`: every starred class is
 * disjoint from what follows it, and `ESC` is excluded from all of them, so two
 * candidate runs can never overlap and there is no backtracking to exploit.
 *
 * ⚠️ This duplicates ANSI knowledge that would be better held once in
 * `src/utils/regex-patterns.ts`. It lives here deliberately: `stripAnsi` has many
 * consumers (respawn and usage-limit pattern matching, the terminal buffer, search) and
 * widening it changes all of them at once, which is not a change to make as a side
 * effect of fixing this endpoint. See the follow-up note in
 * `tmp/agent-wait-review/report-fix-registry.md`.
 */
// eslint-disable-next-line no-control-regex -- matching raw terminal control bytes is the point
const ANSI_ESCAPE_RESIDUE = /\x1b(?:[PX^_][^\x07\x1b]*(?:\x07|\x1b\\)|[\x20-\x2f]*[\x30-\x7e])/g;

/**
 * The text this module matches against: ANSI-stripped, then residue-stripped.
 *
 * Everything downstream (the carry, the haystack, the snippet window) is derived from
 * the output of this function, so there is exactly one definition of "the matched
 * stream" and `findMatch` never sees an escape byte.
 */
function normalizeForMatch(raw: string): string {
  return stripAnsi(raw).replace(ANSI_ESCAPE_RESIDUE, '');
}

/**
 * C0 controls, DEL and the C1 block, minus tab / newline / carriage return. Removed
 * from the snippet so no byte that can reprogram the reading agent's terminal, or
 * begin a sequence that does, survives into the JSON response.
 *
 * Still needed after `normalizeForMatch`, which removes escape SEQUENCES: a bare BEL,
 * NUL or backspace carries no ESC and reaches the haystack intact.
 */
// eslint-disable-next-line no-control-regex -- removing raw terminal control bytes is the point
const SNIPPET_CONTROL_BYTES = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g;

/**
 * Find `needleCmp` in `hay` and return a bounded window of surrounding text,
 * or null when absent. The snippet comes from the ORIGINAL-case text even in
 * nocase mode, so callers see what the terminal actually printed.
 *
 * ## Two texts, and they are not the same string
 *
 * Precision here matters, because an agent that cannot match something reaches for the
 * snippet to work out why:
 *
 * - **Matched**: `hay`, which is `normalizeForMatch()` output — ANSI-stripped and
 *   residue-stripped, with nothing else touched. `matched` is decided against exactly
 *   this, so it is byte-for-byte what a needle must appear in.
 * - **Returned**: a bounded window of that same text, then RENDERED for a human or an
 *   LLM to read: leftover control bytes removed, blank runs collapsed, trimmed.
 *
 * So the snippet is a rendering of the matched window, not a quotation of it. The
 * remaining differences cannot change whether a printable needle matched, but they are
 * real: a needle containing `\n\n` or a raw control byte is matchable and would not
 * appear verbatim in the snippet.
 *
 * Blank runs are collapsed for READABILITY ONLY. A real pane pads with dozens of `\r\n`
 * between the prompt and the match, which would otherwise fill the whole context window
 * with nothing and make the snippet useless to the agent reading it.
 *
 * Control bytes are dropped because, unlike `GET .../terminal`, this field is documented
 * as stripped and its consumer is an agent piping it through `jq` into its OWN terminal
 * pane, so a worker printing attacker-influenced bytes could otherwise reset or garble
 * the orchestrator's display. Whitespace is preserved; every other C0/C1 control and DEL
 * is removed.
 */
function findMatch(hay: string, needleCmp: string, nocase: boolean): string | null {
  const cmp = nocase ? hay.toLowerCase() : hay;
  const idx = cmp.indexOf(needleCmp);
  if (idx === -1) return null;

  // ⚠️ `idx` indexes `cmp`, and the snippet is sliced out of `hay`. Those agree only
  // while lowercasing preserves length, which it usually but not always does:
  // 'İ' (U+0130) lowercases to TWO code units, so terminal output containing Turkish
  // text, a filename or a git author line shifts every later index and the window
  // slides off the match entirely. A length compare detects it for the cost of one
  // integer read, so the common path stays exactly one `indexOf` and no allocation.
  const drift = cmp.length - hay.length;
  const start = drift === 0 ? idx : originalIndex(hay, idx, drift);
  const matchEnd = drift === 0 ? idx + needleCmp.length : originalIndex(hay, idx + needleCmp.length, drift);

  return hay
    .slice(Math.max(0, start - MAX_SNIPPET_CONTEXT), Math.min(hay.length, matchEnd + MAX_SNIPPET_CONTEXT))
    .replace(SNIPPET_CONTROL_BYTES, '')
    .replace(/[\r\n]{2,}/g, '\n')
    .trim();
}

/**
 * Map an index in `hay.toLowerCase()` back to the equivalent index in `hay`, for the
 * rare case where the two differ in length by `drift`.
 *
 * `f(i) = hay.slice(0, i).toLowerCase().length` is non-decreasing and satisfies
 * `i <= f(i) <= i + drift` (no lowercase mapping ever shortens a string), which bounds
 * the answer to `[cmpIdx - drift, cmpIdx]` and lets a binary search find it in
 * `log2(drift)` steps rather than walking the string. Ties break low, so an index that
 * lands mid-expansion resolves to the character that expanded, which keeps the window
 * around the match rather than past it.
 */
function originalIndex(hay: string, cmpIdx: number, drift: number): number {
  let lo = Math.max(0, cmpIdx - drift);
  let hi = Math.min(hay.length, cmpIdx);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (hay.slice(0, mid).toLowerCase().length <= cmpIdx) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * Tail of `text` to carry into the next chunk. Long enough to complete a straddling
 * match and to give a later snippet some leading context.
 *
 * Callers pass the COMPARISON needle's length, not the original's: under `nocase` the
 * text that matches can be longer than the needle as typed (a needle of `İ` compares
 * as two code units, so two code units of pane output can satisfy one needle
 * character), and a carry sized from the shorter one drops a straddling match.
 */
function tailFor(text: string, needleLength: number): string {
  const keep = Math.max(needleLength - 1, MAX_SNIPPET_CONTEXT);
  return keep >= text.length ? text : text.slice(text.length - keep);
}

/**
 * Longest tail held back as a possibly-incomplete escape sequence.
 *
 * Generous enough for a real OSC title (`ESC ] 0 ; <path> BEL`) to survive a chunk
 * split, small enough that an unterminated sequence cannot withhold meaningful output:
 * past this the tail is treated as ordinary text and released, so a malformed stream
 * degrades to the old behavior instead of stalling every match on the session.
 */
const MAX_PENDING_ESCAPE = 512;

/**
 * A tail that is a strict PREFIX of a sequence `normalizeForMatch` would remove: a lone
 * ESC, an unterminated `ESC [ …`, an unterminated string type (`ESC ] P X ^ _ …`), or
 * intermediate bytes still waiting for their final byte (`ESC (` before its `B`).
 * Anything else is either complete or not an escape at all, and both are safe to strip
 * now.
 *
 * ⚠️ The third branch must stay in lockstep with `ANSI_ESCAPE_RESIDUE`'s second one.
 * When the residue pass learned about `ESC ( B`, a chunk cut between the `(` and the `B`
 * became a NEW way to smuggle an escape into the haystack, since neither half is a
 * complete sequence on its own — the same bug one level down, which is what this
 * function exists to prevent.
 *
 * Deliberately without the `g` flag: a global pattern would carry `lastIndex` between
 * calls (see the repo-wide global-regex hazard) and this runs once per PTY chunk.
 */
// eslint-disable-next-line no-control-regex -- matching raw terminal control bytes is the point
const INCOMPLETE_ANSI_TAIL = /^\x1b(?:\[[0-9;?]*|[\]PX^_][^\x07\x1b]*|[\x20-\x2f]*)$/;

/**
 * Split a raw chunk into the part that is safe to ANSI-strip now and a trailing
 * fragment to hold for the next chunk.
 *
 * Only the LAST `ESC` can be incomplete: anything before it is followed by an escape
 * introducer, so `stripAnsi` will consume or reject it on this pass either way.
 */
function splitTrailingEscape(raw: string): { text: string; pending: string } {
  const esc = raw.lastIndexOf('\x1b');
  if (esc === -1) return { text: raw, pending: '' };

  const tail = raw.slice(esc);
  if (tail.length > MAX_PENDING_ESCAPE || !INCOMPLETE_ANSI_TAIL.test(tail)) {
    return { text: raw, pending: '' };
  }
  return { text: raw.slice(0, esc), pending: tail };
}

/**
 * Process-wide registry used by the routes and the session/hook wiring.
 * Tests should construct their own `SessionWaitRegistry` instead of touching this.
 */
export const sessionWaits = new SessionWaitRegistry();
