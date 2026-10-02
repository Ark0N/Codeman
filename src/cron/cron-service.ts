/**
 * @fileoverview Cron service: CRUD for cron jobs, manual Run Now,
 * the background due-job tick, and run-history recording.
 *
 * It does NOT own session/tmux logic — it reuses Codeman's existing session
 * layer (create → addSession → setupSessionListeners → startInteractive/Shell →
 * send prompt via writeViaMux/write), mirroring the "quick start" route flow.
 */

import { v4 as uuidv4 } from 'uuid';
import { readFile } from 'node:fs/promises';
import { statSync, realpathSync } from 'node:fs';
import { getCli } from '../config/cli-registry/registry.js';
import { resolveCliLaunchError } from '../utils/cli-launcher.js';
import { Session } from '../session.js';
import { applyWorkspaceHooks } from '../hooks-config.js';
import { SseEvent } from '../web/sse-events.js';
import { CronJobSchema } from '../web/schemas.js';
import { getErrorMessage, createErrorResponse, ApiErrorCode } from '../types/api.js';
import { MAX_CONCURRENT_SESSIONS, MAX_CRON_JOBS, MAX_CRON_RUN_HISTORY } from '../config/map-limits.js';
import { canUsernameRunPrivilegedCommands, resolveClaudeModeForUsername } from '../user-store.js';
import { sessionCapacityState, isWorkingDirAllowedForUsername } from '../web/route-helpers.js';
import { CRON_PASTE_ENTER_DELAY_MS, CRON_READY_MAX_ATTEMPTS, CRON_READY_SETTLE_MS } from '../config/server-timing.js';
import {
  DEFAULT_BLOCKED_TREES,
  isBlockedAttachmentPath,
  loadAttachmentGuardConfig,
} from '../config/attachment-guard.js';
import { validateSessionFilePath } from '../web/route-helpers.js';
import { computeNextRunAt, dueKeyFor } from './cron-time.js';
import type { SessionPort, EventPort, ConfigPort, InfraPort } from '../web/ports/index.js';
import type { CronJob, CronJobRun, CronJobRunStatus, TriggerType } from '../types/cron.js';
import type { GeminiConfig, PiConfig, SessionMode } from '../types/session.js';
import type { CronJobInput } from './cron-input.js';

/** The subset of the route context the cron depends on. */
export type CronDeps = SessionPort & EventPort & ConfigPort & InfraPort;

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Section 6.3 clamp for a cron-launched external CLI, mirroring
 * `clampExternalCliBypassForOwner()` in session-routes.ts.
 *
 * A cron job carries NO per-CLI config, so what a non-granted owner actually gets is
 * each CLI's SPAWN DEFAULT, and for two of them that default is itself unsafe:
 *  - gemini: `buildGeminiCommand(undefined)` emits `--approval-mode yolo` (classifier-free),
 *    so `auto_edit` is materialized.
 *  - pi: pi's own `defaultProjectTrust` is an interactive prompt the session user can simply
 *    answer "yes" to, which then loads and EXECUTES repo-local `.pi/extensions` TypeScript,
 *    so `approveProjectTrust: false` (`--no-approve`) is materialized. Omitting `--approve`
 *    is NOT a clamp.
 * Codex, antigravity, grok and deepseek need nothing here: their absent config already spawns safe
 * (grok's bare spawn is its own ask-mode default and deepseek's omits DSH_PERMISSION_MODE
 * entirely, leaving the harness on workspace-write, which asks; both switches are only ever sent).
 * Granted/admin/single-user get undefined for both, i.e. upstream defaults untouched.
 */
export function clampCronExternalCliConfigs(
  mode: SessionMode,
  ownerGranted: boolean
): { geminiConfig: GeminiConfig | undefined; piConfig: PiConfig | undefined } {
  if (ownerGranted) return { geminiConfig: undefined, piConfig: undefined };

  // A cron job carries no per-CLI config at all, so ONLY the materialize-when-absent params
  // can apply here — an only-if-sent clamp has nothing to clamp. Reading them off the
  // registry rather than naming gemini and pi means a future CLI whose bare spawn is unsafe
  // is covered the moment its entry says so, instead of silently missing this path.
  const entry = getCli(mode);
  const aliases = entry?.launch.legacyConfigAliases ?? {};
  const materialized: Record<string, unknown> = {};
  for (const { param, clampTo, materializeWhenAbsent } of entry?.capabilities.privilegedParams ?? []) {
    // Same registry-param → legacy-wire-field hop the HTTP clamp makes. Neither gemini's
    // `approvalMode` nor pi's `approveProjectTrust` is aliased today, so this changes nothing
    // now — but the two are DIFFERENT namespaces, and writing the raw param here would make
    // this path stop clamping the moment one of them gained an alias, silently.
    if (materializeWhenAbsent) materialized[aliases[param] ?? param] = clampTo;
  }
  const has = Object.keys(materialized).length > 0;
  const field = entry?.launch.legacyConfigField;
  return {
    geminiConfig: has && field === 'geminiConfig' ? (materialized as GeminiConfig) : undefined,
    piConfig: has && field === 'piConfig' ? (materialized as PiConfig) : undefined,
  };
}

/** Hard ceiling on a prompt-file read (defends against unbounded-read DoS). */
const MAX_PROMPT_FILE_BYTES = 1024 * 1024;

/**
 * Pseudo-filesystem trees a cron job may never touch, ON TOP of the shared
 * attachment blocklist. `/proc` in particular defeats the workingDir
 * confinement trick (`workingDir: '/proc'` + `promptFilePath:
 * '/proc/self/environ'` would read the SERVER's own environment).
 */
const CRON_PSEUDO_FS_TREES: readonly string[] = ['/proc', '/sys', '/dev'];

/** Sync blocklist for the create/update workingDir gate (no settings extras). */
const CRON_WORKING_DIR_BLOCKED_TREES: readonly string[] = [...DEFAULT_BLOCKED_TREES, ...CRON_PSEUDO_FS_TREES];

/** Prompt delivery is single-line only (writeViaMux/Ink constraint). */
const HAS_NEWLINE = /[\r\n]/;

/** The three session calls prompt delivery needs, so it can be tested without a PTY. */
type CronPromptTarget = Pick<Session, 'write' | 'writeViaMux' | 'verifySubmitted'>;

/**
 * Send a cron job's (single-line) prompt into its session and press Enter.
 *
 * `typed` goes through the mux: the text is typed, Enter is its own key, and the
 * session re-presses it while the prompt is still on the composer.
 *
 * `paste` writes the text straight into the PTY, and must send its Enter as a
 * SEPARATE write. It used to send `<text>\r` in one piece, and Claude Code (measured
 * on 2.1.283) takes a burst of about a hundred characters as a paste, so the `\r`
 * landed as a newline and the prompt sat unsent while the run reported
 * `prompt_sent`. The Enter goes down the same PTY as the text, so it cannot overtake
 * it, and the same composer check then covers a CLI that was not taking Enter yet.
 *
 * @returns false when the session had no PTY or mux to write to
 */
export async function deliverCronPrompt(
  target: CronPromptTarget,
  prompt: string,
  inputMode: CronJob['inputMode'],
  wait: (ms: number) => Promise<void> = delay
): Promise<boolean> {
  if (inputMode !== 'paste') {
    return target.writeViaMux(prompt.endsWith('\r') ? prompt : `${prompt}\r`);
  }
  const text = prompt.replace(/[\r\n]+$/, '');
  if (!target.write(text)) return false;
  await wait(CRON_PASTE_ENTER_DELAY_MS);
  if (!target.write('\r')) return false;
  target.verifySubmitted(text);
  return true;
}

/** Order-insensitive equality for the weekly-days arrays. */
function sameDays(a: number[] | undefined, b: number[] | undefined): boolean {
  const x = [...(a ?? [])].sort((p, q) => p - q);
  const y = [...(b ?? [])].sort((p, q) => p - q);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

export class CronService {
  constructor(private readonly deps: CronDeps) {}

  private get store() {
    return this.deps.store;
  }

  // ───────────────────────────── Reads ─────────────────────────────

  listJobs(): CronJob[] {
    return Object.values(this.store.getCronJobs());
  }

  getJob(id: string): CronJob | null {
    return this.store.getCronJob(id);
  }

  listRuns(jobId?: string): CronJobRun[] {
    const all = Object.values(this.store.getCronJobRuns());
    const filtered = jobId ? all.filter((r) => r.cronJobId === jobId) : all;
    return filtered.sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * Number of LIVE sessions of a given agent type (for the multi-session
   * warning and the skip_if_same_agent_running policy). Sessions whose CLI has
   * exited (`stopped`/`error` — the tab is still open but nothing is running)
   * don't count. When `excludeJobId` is given, sessions created by that job's
   * own runs are also excluded — otherwise a recurring job with the skip
   * policy would deadlock on its own previous (never-closed) session and fire
   * exactly once, forever skipping after that.
   */
  countActiveAgents(agentType: string, excludeJobId?: string): number {
    const ownSessionIds = excludeJobId
      ? new Set(
          this.listRuns(excludeJobId)
            .map((r) => r.sessionId)
            .filter((id): id is string => id !== null)
        )
      : null;
    let n = 0;
    for (const [id, s] of this.deps.sessions.entries()) {
      if (s.mode !== agentType) continue;
      if (s.status === 'stopped' || s.status === 'error') continue;
      if (ownSessionIds?.has(id)) continue;
      n++;
    }
    return n;
  }

  // ──────────────────────────── Mutations ───────────────────────────

  createJob(input: CronJobInput, owner?: string): CronJob {
    if (Object.keys(this.store.getCronJobs()).length >= MAX_CRON_JOBS) {
      throw this.badRequest(`Maximum number of cron jobs (${MAX_CRON_JOBS}) reached`);
    }
    this.assertValidWorkingDir(input.workingDir);
    const now = Date.now();
    const job: CronJob = {
      id: uuidv4(),
      name: input.name,
      owner,
      agentType: input.agentType,
      workingDir: input.workingDir,
      launchCommand: input.launchCommand,
      promptMode: input.promptMode,
      promptText: input.promptText,
      promptFilePath: input.promptFilePath,
      inputMode: input.inputMode,
      scheduleType: input.scheduleType,
      runAt: input.runAt,
      intervalMinutes: input.intervalMinutes,
      dailyTime: input.dailyTime,
      weeklyDays: input.weeklyDays,
      weeklyTime: input.weeklyTime,
      enabled: input.enabled,
      notes: input.notes,
      concurrencyPolicy: input.concurrencyPolicy,
      autoClosePreviousSession: input.autoClosePreviousSession ?? true,
      createdAt: now,
      updatedAt: now,
      lastRunAt: null,
      nextRunAt: null,
      lastStatus: null,
      lastDueKey: null,
    };
    job.nextRunAt = job.enabled ? computeNextRunAt(job, now) : null;
    this.store.setCronJob(job.id, job);
    this.broadcastListChanged();
    return job;
  }

  updateJob(id: string, patch: Partial<CronJobInput>): CronJob | null {
    const existing = this.getJob(id);
    if (!existing) return null;
    const now = Date.now();

    // A completed one-time job is only re-armed when the SCHEDULE actually
    // CHANGES — otherwise a cosmetic edit would silently resurrect a job that
    // already fired. We compare VALUES, not field-presence: the edit form
    // round-trips the full job (incl. unchanged scheduleType/runAt) on every
    // save, so a presence check would always re-arm. Only a real schedule
    // change re-arms.
    const changed = <T>(next: T | undefined, prev: T): boolean => next !== undefined && next !== prev;
    const scheduleChanged =
      changed(patch.scheduleType, existing.scheduleType) ||
      changed(patch.runAt, existing.runAt) ||
      changed(patch.intervalMinutes, existing.intervalMinutes) ||
      changed(patch.dailyTime, existing.dailyTime) ||
      changed(patch.weeklyTime, existing.weeklyTime) ||
      (patch.weeklyDays !== undefined && !sameDays(patch.weeklyDays, existing.weeklyDays));
    const reArm = existing.scheduleType !== 'once' || !existing.completedOnce || scheduleChanged;

    const updated: CronJob = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: now,
      completedOnce: reArm ? false : existing.completedOnce,
      lastDueKey: null,
    };

    // The PUT schema is `.partial()`, so its cross-field rules don't run on a
    // partial body. Re-validate the MERGED job against the full schema so a
    // partial edit can't leave an enabled job with an inconsistent schedule
    // (e.g. switching to `once` without a `runAt` → a dead `nextRunAt:null`).
    const check = CronJobSchema.safeParse(updated);
    if (!check.success) {
      throw this.badRequest(check.error.issues[0]?.message ?? 'Invalid cron job update');
    }
    if (patch.workingDir !== undefined) this.assertValidWorkingDir(patch.workingDir);

    updated.nextRunAt = updated.enabled ? computeNextRunAt(updated, now) : null;
    this.store.setCronJob(updated.id, updated);
    this.broadcastListChanged();
    return updated;
  }

  setEnabled(id: string, enabled: boolean): CronJob | null {
    const existing = this.getJob(id);
    if (!existing) return null;
    const now = Date.now();
    existing.enabled = enabled;
    existing.updatedAt = now;
    existing.nextRunAt = enabled ? computeNextRunAt(existing, now) : null;
    this.store.setCronJob(existing.id, existing);
    this.broadcastListChanged();
    return existing;
  }

  deleteJob(id: string): boolean {
    if (!this.getJob(id)) return false;
    this.store.removeCronJob(id);
    for (const run of this.listRuns(id)) this.store.removeCronJobRun(run.id);
    this.deps.broadcast(SseEvent.CronJobDeleted, { id });
    this.broadcastListChanged();
    return true;
  }

  // ──────────────────────────── Execution ───────────────────────────

  /** Manual Run Now — always launches regardless of schedule/enabled state. */
  async runNow(id: string): Promise<CronJobRun | null> {
    const job = this.getJob(id);
    if (!job) return null;
    return this.launch(job, 'manual_run_now');
  }

  /**
   * Background tick: launch every enabled job whose next run is due. Advances
   * each job's schedule and guards against double-launching the same due time.
   */
  async tickDueJobs(now: number = Date.now()): Promise<void> {
    for (const job of this.listJobs()) {
      if (!job.enabled || job.nextRunAt == null || job.nextRunAt > now) continue;

      const key = dueKeyFor(job.id, job.nextRunAt);
      if (job.lastDueKey === key) {
        // This due time was already consumed (overlap/restart) — just advance.
        this.advanceAfterFire(job, now);
        continue;
      }

      // Optional concurrency policy for AUTOMATIC runs. Only LIVE sessions
      // block, and this job's own previous sessions never do (see
      // countActiveAgents) — otherwise a recurring job would deadlock on the
      // session it created last time.
      if (job.concurrencyPolicy === 'skip_if_same_agent_running' && this.countActiveAgents(job.agentType, job.id) > 0) {
        // Record the skip so the job's run history isn't silently empty when it
        // keeps getting skipped (otherwise it looks like the job never ran).
        this.recordSkippedRun(job);
        if (job.scheduleType === 'once') {
          // A skipped one-time job is NOT consumed: leave nextRunAt armed (and
          // the due key unconsumed) so the next tick retries once the blocking
          // session goes away.
          continue;
        }
        job.lastDueKey = key;
        this.advanceAfterFire(job, now);
        continue;
      }

      job.lastDueKey = key;
      // Advance the schedule BEFORE launching so a slow launch can't be
      // re-triggered by the next tick.
      this.advanceAfterFire(job, now);
      this.launch(job, 'scheduled').catch((err) =>
        console.error(`[cron] launch failed for job ${job.id}:`, getErrorMessage(err))
      );
    }
  }

  /** Recompute nextRunAt for loaded jobs on boot (e.g. after a restart). */
  init(): void {
    const now = Date.now();
    for (const job of this.listJobs()) {
      const isDeadOnce = job.scheduleType === 'once' && job.completedOnce;
      if (job.enabled && job.nextRunAt == null && !isDeadOnce) {
        job.nextRunAt = computeNextRunAt(job, now);
        this.store.setCronJob(job.id, job);
      }
    }
  }

  // ──────────────────────────── Internals ───────────────────────────

  private advanceAfterFire(job: CronJob, now: number): void {
    if (job.scheduleType === 'once') {
      job.completedOnce = true;
      job.enabled = false;
      job.nextRunAt = null;
    } else {
      job.nextRunAt = computeNextRunAt(job, now);
    }
    job.updatedAt = now;
    this.store.setCronJob(job.id, job);
    this.broadcastListChanged();
  }

  private async launch(job: CronJob, trigger: TriggerType): Promise<CronJobRun> {
    const run: CronJobRun = {
      id: uuidv4(),
      cronJobId: job.id,
      sessionId: null,
      sessionName: null,
      startedAt: Date.now(),
      finishedAt: null,
      status: 'created',
      triggerType: trigger,
      createdSessionUrl: null,
    };
    this.store.setCronJobRun(run.id, run);
    this.pruneRunHistory();
    this.deps.broadcast(SseEvent.CronRunCreated, run);

    // Resolve the prompt.
    let prompt: string;
    try {
      prompt = await this.resolvePrompt(job);
    } catch (err) {
      return this.failRun(job, run, `Prompt error: ${getErrorMessage(err)}`);
    }

    // Validate working directory.
    try {
      if (!statSync(job.workingDir).isDirectory()) {
        return this.failRun(job, run, 'workingDir is not a directory');
      }
    } catch {
      return this.failRun(job, run, 'workingDir does not exist');
    }

    // Section 6.3: defense-in-depth workingDir confinement re-check at FIRE time against the
    // owner's CURRENT space (complements the create/update gate). No-op in single-user / unset owner.
    if (!(await isWorkingDirAllowedForUsername(job.owner, job.workingDir))) {
      return this.failRun(job, run, 'workingDir is outside the owner workspace');
    }

    // Recurring jobs: close the still-open session created by this job's
    // previous run before launching the next (default ON, opt-out via
    // autoClosePreviousSession:false) — otherwise an unattended interval/daily
    // job accumulates a new tab per fire until the global session cap.
    if (job.scheduleType !== 'once' && job.autoClosePreviousSession !== false) {
      await this.closePreviousRunSessions(job, run.id);
    }

    // Respect the global cap AND the owner's per-user cap (multi-user).
    const cap = sessionCapacityState(this.deps.sessions, job.owner);
    if (cap.atGlobalCap) {
      return this.failRun(job, run, `Maximum concurrent sessions (${MAX_CONCURRENT_SESSIONS}) reached`);
    }
    if (cap.atUserCap) {
      return this.failRun(job, run, `Owner's per-user session limit reached`);
    }

    // Section 6.3: re-resolve the owner's grant at FIRE time (it may have been revoked
    // since create). Gates shell/launchCommand AND clamps the external-CLI bypass below.
    const ownerGranted = await canUsernameRunPrivilegedCommands(job.owner);
    if ((getCli(job.agentType)?.capabilities.privilegedCommandGate || job.launchCommand) && !ownerGranted) {
      return this.failRun(job, run, 'Owner lacks the can-bypass-permissions grant for shell/launchCommand jobs');
    }

    // Create + start the session (mirrors the quick-start route flow).
    let session: Session;
    try {
      const mode = job.agentType;
      // A LAUNCHER CLI's binary is not its agent, so "installed" is not "runnable": without
      // this, a job on a box carrying only dsh's stock web/headless profiles spawns a bare
      // `dsh` that boots a profile unable to drive a pane, and the prompt is typed into a
      // logging server or a dead pane instead of failing the run with an actionable message.
      //
      // ⚠️ Scoped to `discovery.launcherProfile`, which is byte-identical to the
      // `mode === 'deepseek'` check this replaces (dsh is the only launcher today) and
      // generalises to the next one. Deliberately NOT every CLI: cron has never pre-flighted
      // a merely-missing binary, and doing so replaces tmux-manager's own not-found throw
      // ("Session launch failed") with a different message for claude and shell. An earlier
      // draft of this line was unscoped and did exactly that — three cron tests caught it.
      if (getCli(mode)?.discovery.launcherProfile !== undefined) {
        const cronLaunchError = await resolveCliLaunchError(mode);
        if (cronLaunchError) return this.failRun(job, run, cronLaunchError);
      }
      const globalNice = await this.deps.getGlobalNiceConfig();
      const modelConfig = await this.deps.getModelConfig();
      const claudeModeConfig = await this.deps.getClaudeModeConfig();
      const effectiveClaudeMode = await resolveClaudeModeForUsername(claudeModeConfig.claudeMode, job.owner);
      // Cron carries no per-CLI config object, so the only model it can supply is the global
      // default — and only to a CLI that takes a model at all.
      //
      // ⚠️ `!== 'none'` is the faithful reading of the `mode !== 'shell' && mode !== 'deepseek'`
      // ladder this replaces: those two are exactly the entries declaring `model.source: 'none'`
      // (shell has no model; deepseek's is a profile composition entry, not a session flag).
      // NOT `=== 'claude-settings-file'`, which is the HTTP route's question — there, every
      // external CLI reads its model from its own config object earlier in the chain, so only
      // claude reaches the global default. Cron has no such config, so the same expression
      // means something different here.
      const model =
        getCli(mode)?.capabilities.model.source !== 'none' ? modelConfig?.defaultModel || undefined : undefined;
      // Section 6.3: materialize the safe default for a non-granted owner (see
      // clampCronExternalCliConfigs — cron sends no per-CLI config, so the CLI's own
      // spawn default is what would otherwise apply).
      const { geminiConfig, piConfig } = clampCronExternalCliConfigs(mode, ownerGranted);
      // Workspace hooks (see applyWorkspaceHooks in hooks-config): cron jobs are
      // always local (workingDir was stat-validated above) but used to bypass the
      // shared install-vs-refresh decision, so a job firing in a linked case that
      // never had an interactive session ran hook-blind — no `stop` for the
      // completion detection, no tab alert on a blocking dialog. Claude mode only
      // (nothing else reads `.claude` hooks); best-effort inside the helper.
      if (mode === 'claude') {
        await applyWorkspaceHooks(job.workingDir);
      }
      session = new Session({
        workingDir: job.workingDir,
        mode,
        name: job.name,
        mux: this.deps.mux,
        useMux: true,
        niceConfig: globalNice,
        model,
        claudeMode: effectiveClaudeMode,
        allowedTools: claudeModeConfig.allowedTools,
        geminiConfig,
        piConfig,
        owner: job.owner,
      });
      await this.deps.addSession(session);
      this.store.incrementSessionsCreated();
      this.deps.persistSessionState(session);
      await this.deps.setupSessionListeners(session);
      this.deps.broadcast(SseEvent.SessionCreated, this.deps.getSessionStateWithRespawn(session));
      if (mode === 'shell') {
        await session.startShell();
      } else {
        await session.startInteractive();
      }
      this.deps.broadcast(SseEvent.SessionInteractive, { id: session.id, mode });
    } catch (err) {
      return this.failRun(job, run, `Session launch failed: ${getErrorMessage(err)}`);
    }

    run.sessionId = session.id;
    run.sessionName = session.name;
    run.createdSessionUrl = `/?session=${session.id}`;
    run.status = 'session_started';
    this.store.setCronJobRun(run.id, run);
    this.deps.broadcast(SseEvent.CronRunUpdated, run);
    this.updateJobLastStatus(job.id, 'session_started');

    // Send the prompt once the CLI is ready (async; does not block the caller).
    this.sendPromptWhenReady(session.id, prompt, job, run);
    return run;
  }

  /**
   * Resolves the prompt text and enforces the single-line constraint: prompt
   * delivery rides writeViaMux/PTY writes where a newline is Enter, so a
   * multi-line prompt would be silently corrupted (typed mode fuses lines,
   * paste mode submits the first line and dribbles the rest in as separate
   * messages). Rather than mangle an unattended agent's instructions, fail the
   * run with a clear error. A prompt FILE may end with trailing newline(s)
   * (every editor writes one) — those are stripped before the check.
   */
  private async resolvePrompt(job: CronJob): Promise<string> {
    if (job.promptMode === 'prompt_file_path') {
      if (!job.promptFilePath) throw new Error('prompt file path is empty');
      const safePath = await this.resolveSafePromptPath(job.promptFilePath, job.workingDir);
      const content = (await readFile(safePath, 'utf-8')).replace(/[\r\n]+$/, '');
      if (HAS_NEWLINE.test(content)) {
        throw new Error('prompt file must contain a single line — multi-line prompts are not supported');
      }
      return content;
    }
    const text = job.promptText ?? '';
    if (HAS_NEWLINE.test(text)) {
      // Schema-rejected since this check was added; guards legacy persisted jobs.
      throw new Error('promptText must be a single line — multi-line prompts are not supported');
    }
    return text;
  }

  /**
   * Guards a prompt-file path before it is read. The path is user-supplied via
   * the API and its contents are injected into an agent session (an exfil sink
   * over SSE/terminal), so an unconfined read would let a hostile job config
   * pull arbitrary host files — including the SERVER PROCESS'S OWN secrets via
   * `/proc/self/environ` — into the session.
   *
   * A denylist is the wrong posture for an exfil sink (it kept missing `/proc`,
   * `/dev`, other users' `~/.ssh`, modern cloud creds…). So the PRIMARY gate is
   * an allowlist: the prompt file must resolve INSIDE the job's working
   * directory. A symlink escaping the workspace fails this because we check the
   * realpath-resolved target. We additionally require a regular file (rejects
   * directories, FIFOs, and `/dev/*` character devices that would hang or OOM
   * the unbounded read) within a sane size cap, and keep the shared blocklist as
   * cheap defense-in-depth. Returns the symlink-resolved path to read.
   */
  private async resolveSafePromptPath(rawPath: string, workingDir: string): Promise<string> {
    let resolved: string;
    try {
      resolved = realpathSync(rawPath);
    } catch {
      throw new Error('prompt file path could not be resolved');
    }

    // workingDir is USER-CONTROLLED, so it is not a trust boundary by itself:
    // realpath-resolve it (a symlinked workspace must not defeat containment)
    // and reject blocked/pseudo-fs trees — otherwise workingDir '/proc' would
    // make '/proc/self/environ' pass the containment check below.
    let realWorkingDir: string;
    try {
      realWorkingDir = realpathSync(workingDir);
    } catch {
      throw new Error('job working directory could not be resolved');
    }
    const guard = await loadAttachmentGuardConfig();
    const blockedTrees = [...guard.blockedTrees, ...CRON_PSEUDO_FS_TREES];
    if (realWorkingDir === '/' || isBlockedAttachmentPath(realWorkingDir, blockedTrees)) {
      throw new Error('job working directory is blocked');
    }

    // Defense-in-depth blocklist (secret locations, /etc, /root, pseudo-fs).
    if (isBlockedAttachmentPath(resolved, blockedTrees)) {
      throw new Error('prompt file path is blocked');
    }

    // Primary gate: the prompt file must live inside the job's workspace.
    if (!validateSessionFilePath(realWorkingDir, resolved)) {
      throw new Error('prompt file path must be inside the job working directory');
    }

    // Reject non-regular files and oversized files (DoS via unbounded read).
    let info;
    try {
      info = statSync(resolved);
    } catch {
      throw new Error('prompt file path could not be resolved');
    }
    if (!info.isFile()) throw new Error('prompt file path is not a regular file');
    if (info.size > MAX_PROMPT_FILE_BYTES) throw new Error('prompt file is too large');

    return resolved;
  }

  private sendPromptWhenReady(sessionId: string, prompt: string, job: CronJob, run: CronJobRun): void {
    setImmediate(() => {
      const poll = async (): Promise<void> => {
        // A shell pane is ready the moment it exists; an agent CLI has a TUI to paint
        // first. That is the `kind` the registry already records, not a fact about shell.
        if (getCli(job.agentType)?.kind !== 'shell') {
          for (let attempt = 0; attempt < CRON_READY_MAX_ATTEMPTS; attempt++) {
            await delay(500);
            const s = this.deps.sessions.get(sessionId);
            if (!s) return; // session was removed
            const buf = s.getTerminalBuffer().slice(-2048);
            if (buf.includes('❯') || buf.includes('tokens')) break;
          }
          await delay(CRON_READY_SETTLE_MS);
        } else {
          await delay(1000);
          // Shell mode: deliver the optional custom launch command as the
          // first input line (single-line, schema-enforced), then give it a
          // moment to start before the prompt follows.
          if (job.launchCommand) {
            const shell = this.deps.sessions.get(sessionId);
            if (!shell) return;
            const sent = await shell.writeViaMux(`${job.launchCommand}\r`);
            if (!sent) {
              this.failRun(job, run, 'Failed to send launch command: mux write failed');
              return;
            }
            await delay(1000);
          }
        }
        const s = this.deps.sessions.get(sessionId);
        if (!s) return;
        try {
          const delivered = await deliverCronPrompt(s, prompt, job.inputMode);
          if (!delivered) {
            this.failRun(job, run, 'Failed to send prompt: the session could not be written to');
            return;
          }
          run.status = 'prompt_sent';
          run.finishedAt = Date.now();
          this.store.setCronJobRun(run.id, run);
          this.deps.broadcast(SseEvent.CronRunUpdated, run);
          this.updateJobLastStatus(job.id, 'prompt_sent');
        } catch (err) {
          this.failRun(job, run, `Failed to send prompt: ${getErrorMessage(err)}`);
        }
      };
      poll().catch((err) => console.error('[cron] sendPromptWhenReady error:', getErrorMessage(err)));
    });
  }

  /** 400-shaped error for route handlers (mirrors parseBody's error contract). */
  private badRequest(msg: string): Error {
    return Object.assign(new Error(msg), {
      statusCode: 400,
      body: createErrorResponse(ApiErrorCode.INVALID_INPUT, msg),
    });
  }

  /**
   * Create/update gate for a job's workingDir: must exist, be a directory, and
   * not resolve into a blocked or pseudo-filesystem tree (nor the fs root).
   * The user-supplied workingDir doubles as the prompt-file confinement root,
   * so an unrestricted value would defeat that boundary (e.g. '/proc').
   */
  private assertValidWorkingDir(workingDir: string): void {
    let real: string;
    try {
      real = realpathSync(workingDir);
    } catch {
      throw this.badRequest('workingDir does not exist');
    }
    if (!statSync(real).isDirectory()) throw this.badRequest('workingDir is not a directory');
    if (real === '/' || isBlockedAttachmentPath(real, CRON_WORKING_DIR_BLOCKED_TREES)) {
      throw this.badRequest('workingDir is not allowed (blocked or pseudo-filesystem tree)');
    }
  }

  /** Close still-open sessions created by this job's previous runs (normal cleanup path). */
  private async closePreviousRunSessions(job: CronJob, currentRunId: string): Promise<void> {
    for (const prev of this.listRuns(job.id)) {
      if (prev.id === currentRunId || !prev.sessionId) continue;
      if (!this.deps.sessions.has(prev.sessionId)) continue;
      try {
        await this.deps.cleanupSession(prev.sessionId, true, 'cron: superseded by the next run of this job');
      } catch (err) {
        console.error(`[cron] failed to auto-close previous session ${prev.sessionId}:`, getErrorMessage(err));
      }
    }
  }

  private failRun(job: CronJob, run: CronJobRun, message: string): CronJobRun {
    run.status = 'failed';
    run.errorMessage = message;
    run.finishedAt = Date.now();
    this.store.setCronJobRun(run.id, run);
    this.deps.broadcast(SseEvent.CronRunUpdated, run);
    this.updateJobLastStatus(job.id, 'failed');
    return run;
  }

  private recordSkippedRun(job: CronJob): void {
    // Coalesce consecutive skips: if the job is already in a skip streak, don't
    // record again — a perpetually-skipped interval job would otherwise write a
    // run every tick forever and bloat state.json.
    if (this.listRuns(job.id)[0]?.status === 'skipped') return;

    const now = Date.now();
    const run: CronJobRun = {
      id: uuidv4(),
      cronJobId: job.id,
      sessionId: null,
      sessionName: null,
      startedAt: now,
      finishedAt: now,
      status: 'skipped',
      errorMessage: `Skipped: a ${job.agentType} agent is already running (concurrency policy)`,
      triggerType: 'scheduled',
      createdSessionUrl: null,
    };
    this.store.setCronJobRun(run.id, run);
    this.pruneRunHistory();
    this.deps.broadcast(SseEvent.CronRunCreated, run);
    // A skip is NOT a run: surface it as the lastStatus, but do NOT advance
    // lastRunAt (no session was created).
    this.updateJobLastStatus(job.id, 'skipped', { touchLastRun: false });
  }

  /** Prune the oldest run records (by startedAt) once the global cap is exceeded. */
  private pruneRunHistory(): void {
    const runs = Object.values(this.store.getCronJobRuns());
    if (runs.length <= MAX_CRON_RUN_HISTORY) return;
    runs.sort((a, b) => a.startedAt - b.startedAt);
    for (const run of runs.slice(0, runs.length - MAX_CRON_RUN_HISTORY)) {
      this.store.removeCronJobRun(run.id);
    }
  }

  private updateJobLastStatus(jobId: string, status: CronJobRunStatus, opts: { touchLastRun?: boolean } = {}): void {
    const fresh = this.store.getCronJob(jobId);
    if (!fresh) return;
    const now = Date.now();
    fresh.lastStatus = status;
    if (opts.touchLastRun !== false) fresh.lastRunAt = now;
    fresh.updatedAt = now;
    this.store.setCronJob(fresh.id, fresh);
    this.broadcastListChanged();
  }

  private broadcastListChanged(): void {
    this.deps.broadcast(SseEvent.CronJobsChanged, { jobs: this.listJobs() });
  }
}
