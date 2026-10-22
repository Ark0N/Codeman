/**
 * @fileoverview Prompt-cache keep-warm: a one-line keep-alive turn shortly before an idle
 * claude session's prompt cache would expire, so the next real prompt reads the conversation
 * from cache instead of re-processing it at the cache-write rate.
 *
 * Why it exists: Claude Code gives a subscription's main conversation a one-hour cache and
 * lets it expire after an hour idle. Measured on real sessions, nearly every gap over an
 * hour went cold and the first turn back re-wrote the whole context at 2x; a keep-alive turn
 * costs a cache read plus a one-word reply, a small fraction of the miss it prevents, and the
 * payoff is concentrated in gaps of one to four hours, which is why there is a cap after the
 * last real prompt rather than an indefinite loop.
 *
 * Codeman owns the idle policy for these sessions (Discussion #554): a launch with keep-warm
 * on also carries `idleCompaction: false` in its one `--settings` JSON, so Claude Code's own
 * idle compaction (which fires at 90% of the TTL, a minute before the nudge) cannot replace
 * the conversation with a summary first. That is decided once per launch in
 * `TmuxManager._resolveIdleCompactionOptOut()` and recorded on the mux record; a session
 * switched on after launch is kept warm best-effort and says so.
 *
 * Where the facts come from: `Session.promptCache` (the statusline's `prompt_cache` object,
 * see usage-telemetry.ts) carries `expires_at`, the TTL and the tokens at stake, so nothing
 * here infers the lifetime from idle detection or the plan tier.
 *
 * Shape: `decideKeepWarm()` is the pure rulebook (every guard in one place, tested as a
 * table); `PromptCacheKeepWarmService` owns the per-session timer and the ports it needs
 * from the server. It never touches the session except through `beginKeepAliveTurn()` and
 * `writeViaMux()`: the window `beginKeepAliveTurn()` opens is what keeps the nudge off the
 * real-prompt clock and opens its stop hook and idle prompt pre-acknowledged
 * (hook-event-routes.ts). The nudge is still a submit, so it moves `lastSubmitAt`.
 *
 * @module prompt-cache-keepwarm
 */

import type { KeepWarmStatus, PromptCacheStatus, StatusLineExporter } from './types/index.js';

/** The nudge. Under 100 chars on purpose: a longer burst reads as a paste to Claude Code. */
export const KEEP_WARM_NUDGE = 'Codeman cache keep-alive: no action needed, reply with just "ok".';
/** Nudge this long before `expires_at`. The nudge's own request is what refreshes the timer. */
export const KEEP_WARM_LEAD_MS = 5 * 60_000;
/** Re-check cadence while a transient guard (working, dialog, draft in the composer) defers. */
export const KEEP_WARM_RETRY_MS = 60_000;
/** Give up this close to expiry: a turn takes seconds to land and the Enter may be re-pressed. */
export const KEEP_WARM_LAST_CHANCE_MS = 60_000;
/** Below this many tokens at stake a cold rewrite is cheap and a turn is not worth it. */
export const KEEP_WARM_MIN_TOKENS = 20_000;
/** A person typed this recently: they may be about to submit, which refreshes the cache for free. */
export const KEEP_WARM_RECENT_INPUT_MS = 3 * 60_000;
/**
 * Ceiling on the keep-alive window. The window normally closes on the turn's own idle prompt
 * (Claude Code sends it about a minute after the turn ends, so a slow turn must not outlast a
 * short fixed window) or earlier, at any other submit; the ceiling covers a turn whose idle
 * prompt never arrives, such as a workspace without Codeman's hooks.
 */
export const KEEP_WARM_TURN_WINDOW_MS = 10 * 60_000;
/** Default cap: hours after the last real prompt during which nudges are sent. */
export const DEFAULT_KEEP_WARM_MAX_HOURS = 2;
/** Longest delay `setTimeout` honours; Node fires anything longer after 1 ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Whether keep-warm is on for a session: its own choice, else the app-wide default. A session
 * an agent spawned (`parentSessionId`) does not inherit the default: a worker that finished
 * its task is idle exactly like one that will be prompted again, and most never are, so only
 * its own switch keeps it warm. One function because the launch (the `idleCompaction`
 * opt-out) and the service must agree.
 */
export function keepWarmOn(choice: boolean | undefined, appDefault: boolean, spawnedByAgent: boolean): boolean {
  return choice ?? (appDefault && !spawnedByAgent);
}

export interface KeepWarmFacts {
  now: number;
  /** The session's own choice; undefined = the app-wide default applies. */
  choice: boolean | undefined;
  appDefault: boolean;
  /** Spawned by another session (`parentSessionId`); see `keepWarmOn`. */
  spawnedByAgent: boolean;
  /** Whether this launch carries the statusLine exporter; undefined when unknown. */
  statusLine?: StatusLineExporter;
  cache: PromptCacheStatus | null | undefined;
  /** Idle by Codeman's own probe and not mid-turn. */
  idle: boolean;
  /** A pid and no recorded agent exit (`paneExit`: an exited agent's pane keeps its pid). */
  paneAlive: boolean;
  /** Auto-resume's pause, or a usage-limit message on screen whose reset is still ahead. */
  limitPaused: boolean;
  /** Respawn running, a Ralph loop active, a task assigned, or an agent long-polling the session. */
  automationActive: boolean;
  /** A permission, question or elicitation dialog is open (never the idle item). */
  pendingApproval: boolean;
  /** The composer line holds no text; null when the pane could not be read. */
  composerEmpty: boolean | null;
  /** Last keystroke a person sent, epoch ms; 0 when none seen. */
  lastHumanInputAt: number;
  /** Start of the keep-warm window: the last real (non-keep-alive) prompt, else the session start. */
  budgetAnchorAt: number;
  maxKeepWarmMs: number;
}

export type KeepWarmDecision =
  | { action: 'nudge' }
  | { action: 'wait'; until: number; reason: string }
  | { action: 'stop'; reason: string };

const stop = (reason: string): KeepWarmDecision => ({ action: 'stop', reason });
const wait = (until: number, reason: string): KeepWarmDecision => ({ action: 'wait', until, reason });

/**
 * The rulebook. Hard stops first (nothing to do until the next cache report or a flag
 * change), then the schedule, then the transient guards that defer by `KEEP_WARM_RETRY_MS`
 * and never past the last-chance line. Pure: `now` is passed in.
 */
export function decideKeepWarm(f: KeepWarmFacts): KeepWarmDecision {
  if (!keepWarmOn(f.choice, f.appDefault, f.spawnedByAgent)) {
    return stop(
      f.choice === undefined && f.appDefault
        ? 'an agent-spawned session follows the app-wide default only when switched on for itself'
        : 'off'
    );
  }
  // Only a launch that carries the exporter ever reports `prompt_cache`; the readout names the
  // cause from `statusLineExporter`. This is also what stops a CLI without cache telemetry.
  if (f.statusLine !== 'injected') return stop(`no cache reports on this launch (${f.statusLine ?? 'unknown'})`);
  const c = f.cache;
  if (!c) return stop('no cache report yet');
  if (!c.warm || !c.expiresAt) return stop('cache is cold; the next prompt rebuilds it');
  // Compacted this gap (`/compact`, or Claude Code's own idle compaction on a launch without
  // the opt-out): the full context is already gone, so keeping the summary warm buys little.
  // The stamp is dropped at the next request, which re-opens the next gap.
  if (c.compactedAt != null) return stop('the context was compacted; resumes after the next prompt');
  if (c.ttl === '5m') {
    return stop('5-minute cache lifetime; a nudge every four minutes costs more than the miss it prevents');
  }
  if ((c.recacheTokensIfCold ?? 0) < KEEP_WARM_MIN_TOKENS) return stop('context too small to be worth a turn');
  if (!f.paneAlive) return stop('no live pane');
  if (f.limitPaused) return stop('usage-limit pause');
  if (f.now >= f.budgetAnchorAt + f.maxKeepWarmMs) return stop('keep-warm window after the last prompt has passed');
  const dueAt = c.expiresAt - KEEP_WARM_LEAD_MS;
  if (f.now < dueAt) return wait(dueAt, 'not due yet');
  const lastChance = c.expiresAt - KEEP_WARM_LAST_CHANCE_MS;
  if (f.now >= lastChance) return stop('too close to expiry to land a turn');
  const retryAt = Math.min(f.now + KEEP_WARM_RETRY_MS, lastChance);
  if (!f.idle) return wait(retryAt, 'session is working');
  if (f.pendingApproval) return wait(retryAt, 'a dialog is open');
  // Transient, and nothing else re-triggers an idle session: an agent's long-poll waiter ends
  // without a turn, and so does a capture that failed once.
  if (f.automationActive) return wait(retryAt, 'respawn, Ralph or an agent is driving the session');
  if (f.composerEmpty === null) return wait(retryAt, 'cannot read the composer');
  if (!f.composerEmpty) return wait(retryAt, 'the composer holds text');
  if (f.lastHumanInputAt && f.now - f.lastHumanInputAt < KEEP_WARM_RECENT_INPUT_MS) {
    return wait(retryAt, 'someone typed a moment ago');
  }
  return { action: 'nudge' };
}

/**
 * Whether a session could be nudged once the settings are known: its own switch is not off, its
 * launch reports the cache, and the last report is warm. Only such a session has anything to
 * lose while the settings cannot be read, so only it retries on its own.
 */
function couldNudge(s: KeepWarmSessionView): boolean {
  return (
    s.keepWarmEnabled !== false &&
    s.statusLineExporter === 'injected' &&
    !!s.promptCache?.warm &&
    !!s.promptCache.expiresAt
  );
}

/** What the service needs from a session; `Session` satisfies it structurally. */
export interface KeepWarmSessionView {
  readonly id: string;
  readonly createdAt: number;
  readonly pid: number | null;
  /** Set when the agent exited in a pane that stays open (`remain-on-exit`); the pid stays. */
  readonly paneExit?: unknown;
  readonly parentSessionId?: string;
  readonly promptCache: PromptCacheStatus | null;
  readonly statusLineExporter?: StatusLineExporter;
  /** Whether this launch carries `idleCompaction: false` (`MuxSession.idleCompactionOff`). */
  readonly idleCompactionOptOut: boolean;
  readonly keepWarmEnabled: boolean | undefined;
  readonly isWorking: boolean;
  readonly isLimitPaused: boolean;
  readonly lastHumanInputAt: number;
  /** Last submit that was not the keep-alive's own (persisted): the cap's clock. */
  readonly lastRealPromptAt: number;
  isIdle(): boolean;
  beginKeepAliveTurn(windowMs: number): void;
  /** Close the window `beginKeepAliveTurn()` opened, when the nudge never went out. */
  endKeepAliveTurn(): void;
  writeViaMux(data: string): Promise<boolean>;
}

export interface KeepWarmSettings {
  /** App-wide default for sessions that have not chosen (`promptCacheKeepWarm`). */
  keepWarmDefault: boolean;
  /** Cap in hours after the last real prompt (`promptCacheKeepWarmMaxHours`). */
  maxHours: number;
}

export interface KeepWarmPorts {
  getSession(id: string): KeepWarmSessionView | undefined;
  sessionIds(): Iterable<string>;
  readSettings(): Promise<KeepWarmSettings>;
  isAutomationActive(id: string): boolean;
  hasPendingApproval(id: string): boolean;
  /**
   * Read the pane once a nudge is otherwise due: whether the composer is empty (null when it
   * cannot be read), and whether a usage-limit message with a reset still ahead is on screen
   * (auto-resume's own pause tracking only runs while auto-resume is on).
   */
  readPane(session: KeepWarmSessionView): { composerEmpty: boolean | null; limitShown: boolean };
  /** Store and broadcast the status (the server dedupes against the session's last one). */
  publish(id: string, status: KeepWarmStatus): void;
  log?(message: string): void;
}

/** The scheduler the routes see: one method per trigger, nothing else. */
export interface KeepWarmScheduler {
  /** Re-evaluate a session: after a cache report, a flag change, or a settings change. Resolves once the status is published. */
  schedule(sessionId: string): Promise<void>;
  /** Re-read the app-wide default and cap, then re-evaluate every session (either one changed). */
  rescheduleAll(): void;
  /** The session is gone. */
  remove(sessionId: string): void;
}

export class PromptCacheKeepWarmService implements KeepWarmScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly tallies = new Map<string, { nudges: number; lastNudgeAt?: number }>();
  /** One evaluation per session; `remove()` and `stop()` cancel it at its next await. */
  private readonly inFlight = new Map<string, symbol>();
  /** The evaluation running per session, and the one follow-up queued behind it. */
  private readonly running = new Map<string, Promise<void>>();
  private readonly followUps = new Map<string, Promise<void>>();
  /**
   * The default and cap, read once and kept: every statusline report schedules an evaluation,
   * and reading settings.json on each would cost every install, the feature off included.
   * `rescheduleAll()` drops it, and the settings PUT calls that whenever either key changes.
   */
  private settings: Promise<KeepWarmSettings> | undefined;
  /** The last settings read failure logged, so one that persists is logged once; cleared by a good read. */
  private settingsFailure: string | undefined;
  private stopped = false;

  constructor(private readonly ports: KeepWarmPorts) {}

  schedule(sessionId: string): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const running = this.running.get(sessionId);
    if (running) {
      // A trigger landing mid-evaluation (a toggle while the nudge is written, a settings change)
      // carries what that evaluation read too early, so one follow-up runs after it, shared by
      // every trigger that arrives meanwhile.
      let next = this.followUps.get(sessionId);
      if (!next) {
        next = running.then(() => {
          // `remove()` drops the queued follow-up: a deleted session gets no evaluation.
          if (this.followUps.get(sessionId) !== next) return;
          this.followUps.delete(sessionId);
          return this.schedule(sessionId);
        });
        this.followUps.set(sessionId, next);
      }
      return next;
    }
    const run = this.evaluate(sessionId)
      .catch((err) => {
        this.ports.log?.(`[KeepWarm] ${sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
        // A failed write or pane read is transient, and an idle session gets no other trigger
        // until its next turn. (A failed settings read is handled in evaluate().)
        // Not after `remove()`, which drops this run: the session is being deleted.
        if (!this.stopped && this.running.get(sessionId) === run) this.arm(sessionId, Date.now() + KEEP_WARM_RETRY_MS);
      })
      .finally(() => {
        if (this.running.get(sessionId) === run) this.running.delete(sessionId);
      });
    this.running.set(sessionId, run);
    return run;
  }

  rescheduleAll(): void {
    this.settings = undefined;
    for (const id of this.ports.sessionIds()) void this.schedule(id);
  }

  remove(sessionId: string): void {
    this.clearTimer(sessionId);
    this.tallies.delete(sessionId);
    this.inFlight.delete(sessionId);
    this.running.delete(sessionId);
    this.followUps.delete(sessionId);
  }

  stop(): void {
    this.stopped = true;
    for (const id of [...this.timers.keys()]) this.clearTimer(id);
  }

  private readSettings(): Promise<KeepWarmSettings> {
    if (!this.settings) {
      const read = this.ports.readSettings();
      this.settings = read;
      // A failed read is not kept: the next evaluation tries again.
      read.catch(() => {
        if (this.settings === read) this.settings = undefined;
      });
    }
    return this.settings;
  }

  private clearTimer(id: string): void {
    const t = this.timers.get(id);
    if (t) clearTimeout(t);
    this.timers.delete(id);
  }

  private arm(id: string, at: number): void {
    this.clearTimer(id);
    const t = setTimeout(() => void this.schedule(id), Math.min(Math.max(0, at - Date.now()), MAX_TIMER_MS));
    t.unref?.();
    this.timers.set(id, t);
  }

  private async evaluate(id: string): Promise<void> {
    if (this.stopped || this.inFlight.has(id)) return;
    const token = Symbol(id);
    this.inFlight.set(id, token);
    // A session removed (or the service stopped) during an await gets nothing after it: no
    // nudge, no tally, no timer, no status.
    const cancelled = () => this.stopped || this.inFlight.get(id) !== token;
    try {
      this.clearTimer(id);
      const session = this.ports.getSession(id);
      if (!session) return;
      let settings: KeepWarmSettings;
      try {
        settings = await this.readSettings();
      } catch (err) {
        // A read that lands mid-write is retried. A settings.json that stays broken (a hand edit
        // with a trailing comma) fails every read until it is fixed, so it is logged once rather
        // than once a minute per session, and only a session that could nudge retries.
        const message = err instanceof Error ? err.message : String(err);
        if (message !== this.settingsFailure) {
          this.settingsFailure = message;
          this.ports.log?.(`[KeepWarm] ${id.slice(0, 8)}: cannot read the settings: ${message}`);
        }
        if (!cancelled() && couldNudge(session)) this.arm(id, Date.now() + KEEP_WARM_RETRY_MS);
        return;
      }
      this.settingsFailure = undefined;
      if (cancelled()) return;
      const tally = this.tallies.get(id) ?? { nudges: 0 };
      const facts: KeepWarmFacts = {
        now: Date.now(),
        choice: session.keepWarmEnabled,
        appDefault: settings.keepWarmDefault,
        spawnedByAgent: !!session.parentSessionId,
        statusLine: session.statusLineExporter,
        cache: session.promptCache,
        idle: session.isIdle() && !session.isWorking,
        paneAlive: session.pid !== null && !session.paneExit,
        limitPaused: session.isLimitPaused,
        automationActive: this.ports.isAutomationActive(id),
        pendingApproval: this.ports.hasPendingApproval(id),
        // Optimistic until everything else says "due": the pane read is the one costly fact.
        composerEmpty: true,
        lastHumanInputAt: session.lastHumanInputAt,
        budgetAnchorAt: session.lastRealPromptAt || session.createdAt,
        maxKeepWarmMs: settings.maxHours * 3_600_000,
      };
      let decision = decideKeepWarm(facts);
      if (decision.action === 'nudge') {
        const pane = this.ports.readPane(session);
        decision = decideKeepWarm({
          ...facts,
          composerEmpty: pane.composerEmpty,
          limitPaused: facts.limitPaused || pane.limitShown,
        });
      }
      const enabled = keepWarmOn(facts.choice, facts.appDefault, facts.spawnedByAgent);
      const base = {
        enabled,
        idleCompactionOff: session.idleCompactionOptOut,
        nudges: tally.nudges,
        lastNudgeAt: tally.lastNudgeAt,
        // Off, the window means nothing, and it moves with every real prompt: carrying it would
        // broadcast a change on every turn of every session.
        ...(enabled && { budgetEndsAt: facts.budgetAnchorAt + facts.maxKeepWarmMs }),
      };
      if (decision.action === 'nudge') {
        session.beginKeepAliveTurn(KEEP_WARM_TURN_WINDOW_MS);
        const ok = await session.writeViaMux(`${KEEP_WARM_NUDGE}\r`);
        if (cancelled()) return;
        if (ok) {
          tally.nudges += 1;
          tally.lastNudgeAt = Date.now();
          this.tallies.set(id, tally);
        }
        this.ports.log?.(
          `[KeepWarm] ${ok ? 'nudged' : 'failed to nudge'} ${id.slice(0, 8)} with ${facts.cache?.recacheTokensIfCold ?? '?'} tokens at stake (nudge ${tally.nudges})`
        );
        // Sent: the nudge's own cache report re-schedules, and this timer is the fallback if none
        // arrives. Not sent: no turn is running, so the window closes now rather than at its
        // ceiling, and the retry lands inside the last minutes before the expiry, where a nudge
        // can still go out (a lead time later would be past it).
        let nextCheckAt = Date.now() + KEEP_WARM_LEAD_MS;
        if (!ok) {
          session.endKeepAliveTurn();
          const expiresAt = facts.cache?.expiresAt ?? 0;
          nextCheckAt = Math.min(Date.now() + KEEP_WARM_RETRY_MS, expiresAt - KEEP_WARM_LAST_CHANCE_MS);
        }
        this.arm(id, nextCheckAt);
        this.ports.publish(id, {
          ...base,
          nudges: tally.nudges,
          lastNudgeAt: tally.lastNudgeAt,
          state: ok ? 'nudged' : 'waiting',
          nextCheckAt,
          reason: ok ? undefined : 'the keep-alive could not be written',
        });
      } else if (decision.action === 'wait') {
        this.arm(id, decision.until);
        this.ports.publish(id, {
          ...base,
          state: decision.reason === 'not due yet' ? 'armed' : 'waiting',
          nextCheckAt: decision.until,
          reason: decision.reason === 'not due yet' ? undefined : decision.reason,
        });
      } else {
        this.ports.publish(id, { ...base, state: enabled ? 'stopped' : 'off', reason: decision.reason });
      }
    } finally {
      if (this.inFlight.get(id) === token) this.inFlight.delete(id);
    }
  }
}
