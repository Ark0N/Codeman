/**
 * @fileoverview Pure logic for the remote-session auto-reconnect watcher (COD-108).
 *
 * COD-104 made remote tmux sessions durable + idempotently reattachable, but a
 * reconnect only fired at explicit trigger points. COD-108 adds a continuous
 * watcher (in `TmuxManager`) that detects a dead remote pane and emits
 * `remoteSessionDropped`; `SessionManager`/server then reassembles the respawn
 * options and reattaches (re-running the idempotent remote command).
 *
 * This module holds the SIDE-EFFECT-FREE pieces so they can be unit-tested
 * without real tmux:
 *  - the bounded exponential **backoff schedule** (attempt → delay, capped),
 *  - the per-session **reconnect state** shape,
 *  - the **eligibility decision** (`decideReconnect`) given a session + its
 *    reconnect state + the current time + the guard set.
 *
 * The watcher in `tmux-manager.ts` owns the live `isPaneDead` probe and the
 * timers; everything here is pure and deterministic (time is injected).
 *
 * @module remote-reconnect
 */

/**
 * Bounded exponential backoff delays (ms) between reconnect attempts.
 * Attempt N (1-based) waits `BACKOFF_SCHEDULE_MS[N-1]` from the previous emit
 * before the next emit is eligible. After the last entry the session is
 * considered `reconnect-exhausted` and the watcher stops emitting for it.
 *
 * 5s, 15s, 45s, 2m, 5m, 5m → ~6 attempts spanning ~13 minutes.
 */
export const BACKOFF_SCHEDULE_MS: readonly number[] = [5_000, 15_000, 45_000, 120_000, 300_000, 300_000];

/** Maximum number of reconnect attempts before exhaustion. */
export const MAX_RECONNECT_ATTEMPTS = BACKOFF_SCHEDULE_MS.length;

/**
 * Delay (ms) to wait AFTER emitting attempt `attempt` (1-based) before the next
 * attempt is eligible. `attempt <= 0` returns the first delay; an attempt at or
 * beyond the cap returns the last delay (callers should check exhaustion via
 * {@link isExhausted} rather than relying on this for the stop decision).
 *
 * Pure — no clock, no I/O.
 */
export function reconnectDelayForAttempt(attempt: number): number {
  if (!Number.isFinite(attempt) || attempt <= 1) return BACKOFF_SCHEDULE_MS[0];
  const idx = Math.min(Math.floor(attempt) - 1, BACKOFF_SCHEDULE_MS.length - 1);
  return BACKOFF_SCHEDULE_MS[idx];
}

/** Whether `attempts` reconnect emits have reached/exceeded the cap. Pure. */
export function isExhausted(attempts: number): boolean {
  return attempts >= MAX_RECONNECT_ATTEMPTS;
}

/**
 * Per-session reconnect bookkeeping held by the watcher. All time values are
 * epoch ms. `inFlight` guards against stacking respawns when a tick fires while
 * a previous reattach is still running. `exhaustedEmitted` ensures the
 * `remoteReconnectExhausted` event fires at most once per session.
 */
export interface RemoteReconnectState {
  /** Number of `remoteSessionDropped` emits so far (advances per emit). */
  attempts: number;
  /** Earliest time (epoch ms) the next emit is eligible. 0 = eligible now. */
  nextEligibleAt: number;
  /** A reattach triggered by a prior emit is currently running. */
  inFlight: boolean;
  /** Cap reached — stop auto-retrying for this session. */
  exhausted: boolean;
  /** The `remoteReconnectExhausted` SSE event has already been emitted. */
  exhaustedEmitted: boolean;
}

/** A fresh reconnect state (no attempts, immediately eligible). Pure. */
export function freshReconnectState(): RemoteReconnectState {
  return { attempts: 0, nextEligibleAt: 0, inFlight: false, exhausted: false, exhaustedEmitted: false };
}

/**
 * Advance the backoff after an emit at time `now`. Increments `attempts` and
 * schedules `nextEligibleAt = now + delay`. Returns a NEW state object (does
 * not mutate the input). Pure.
 *
 * NOTE: this does NOT set `exhausted`. Exhaustion is a decision the watcher
 * makes on the FOLLOWING tick (via {@link decideReconnect} → `exhaust`), so the
 * `remoteReconnectExhausted` event fires exactly once after the final attempt's
 * backoff window elapses — not pre-emptively on the last emit.
 */
export function advanceBackoff(state: RemoteReconnectState, now: number): RemoteReconnectState {
  const attempts = state.attempts + 1;
  const delay = reconnectDelayForAttempt(attempts);
  return {
    ...state,
    attempts,
    nextEligibleAt: now + delay,
  };
}

/** Reset after a successful reattach — back to a fresh, eligible state. Pure. */
export function resetReconnectState(): RemoteReconnectState {
  return freshReconnectState();
}

/** Minimal session view the decision needs (avoids importing MuxSession here). */
export interface ReconnectSessionView {
  sessionId: string;
  /** Truthy when this is a remote (SSH-wrapped) session. */
  isRemote: boolean;
  /** Result of `isPaneDead(muxName)` for this session. */
  paneDead: boolean;
  /**
   * Whether the DURABLE remote tmux session is still alive on the remote host.
   * Tri-state: `true` = transport drop with the agent still running (safe to
   * reattach); `false` = the remote session is gone (the agent exited cleanly
   * via ctrl-c/ctrl-d/exit and the remote tmux tore down); `undefined` =
   * unknown/unresolvable. The watcher must NOT revive when the remote session
   * is gone or unknown — a clean exit must never auto-relaunch the agent.
   */
  remoteAlive: boolean | undefined;
}

/**
 * Decision outcomes for a single watcher tick on one session.
 *  - `emit`     → emit `remoteSessionDropped { sessionId, attempt }`, then
 *                 advance backoff (attempt = the returned `attempt`).
 *  - `exhaust`  → cap reached this tick; emit `remoteReconnectExhausted` once.
 *  - `skip`     → do nothing (not remote / pane alive / guarded / in-flight /
 *                 not yet due / already exhausted).
 */
export type ReconnectAction =
  | { kind: 'emit'; attempt: number }
  | { kind: 'exhaust' }
  | { kind: 'skip'; reason: ReconnectSkipReason };

export type ReconnectSkipReason =
  | 'not-remote'
  | 'pane-alive'
  | 'guarded'
  | 'in-flight'
  | 'not-due'
  | 'exhausted'
  | 'disabled'
  | 'remote-gone';

export interface DecideReconnectInput {
  session: ReconnectSessionView;
  state: RemoteReconnectState | undefined;
  /** Session is in the intentional-teardown guard set (killed/detached/stopping). */
  guarded: boolean;
  /** Kill-switch: `remoteAutoReconnect` setting. When false, never reconnect. */
  enabled: boolean;
  now: number;
}

/**
 * PURE eligibility decision for one session on one tick. No clock, no I/O — all
 * inputs are passed in. The watcher translates the result into emits + state
 * transitions.
 *
 * Order of guards (most-decisive first):
 *  1. kill-switch off            → skip:disabled
 *  2. not a remote session       → skip:not-remote
 *  3. pane is alive              → skip:pane-alive
 *  4. intentional teardown guard → skip:guarded   (NEVER revive a killed tab)
 *  5. a reattach already running → skip:in-flight (no stacked respawns)
 *  6. already exhausted          → skip:exhausted (one exhaust emit, then quiet)
 *  7. cap reached this tick      → exhaust
 *  8. not yet due (backoff)      → skip:not-due
 *  9. otherwise                  → emit (attempt = attempts + 1)
 */
export function decideReconnect(input: DecideReconnectInput): ReconnectAction {
  const { session, state, guarded, enabled, now } = input;

  if (!enabled) return { kind: 'skip', reason: 'disabled' };
  if (!session.isRemote) return { kind: 'skip', reason: 'not-remote' };
  if (!session.paneDead) return { kind: 'skip', reason: 'pane-alive' };
  // Intentional kill / detach must NEVER be auto-revived.
  if (guarded) return { kind: 'skip', reason: 'guarded' };
  // A clean exit tears down the durable remote tmux (the session's only pane
  // exiting destroys it). Reviving is ONLY correct for a transport drop: the
  // agent is still running on the remote, so the durable session must still
  // exist. When it is gone (or status is unknown — probe failed/unreachable),
  // the agent exited intentionally and must not be auto-relaunched (found
  // live 2026-08-29: remote omp/opencode ctrl-c/ctrl-d auto-respawned fresh
  // sessions; only claude's `|| --resume` accidentally masked it).
  if (session.remoteAlive !== true) return { kind: 'skip', reason: 'remote-gone' };

  const s = state ?? freshReconnectState();

  // Only one reconnect in flight per session — don't stack respawns.
  if (s.inFlight) return { kind: 'skip', reason: 'in-flight' };

  if (s.exhausted) return { kind: 'skip', reason: 'exhausted' };

  // Cap reached: surface exhaustion once, then go quiet.
  if (isExhausted(s.attempts)) return { kind: 'exhaust' };

  // Backoff gate — only emit when due.
  if (now < s.nextEligibleAt) return { kind: 'skip', reason: 'not-due' };

  return { kind: 'emit', attempt: s.attempts + 1 };
}
