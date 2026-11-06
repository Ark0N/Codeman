/**
 * @fileoverview Persistent JSON state storage for Codeman.
 *
 * Persists application state with debounced writes (500ms) to prevent excessive disk I/O.
 * State is split into two files:
 * - `~/.codeman/state.json` — main app state (sessions, tasks, config, global stats)
 * - `~/.codeman/state-inner.json` — Ralph loop state per session (changes rapidly)
 *
 * Key exports:
 * - `StateStore` class — singleton store with circuit breaker for save failures
 * - `getStore(filePath?)` — factory/singleton accessor
 *
 * Key methods: `getState()`, `getSessions()`, `setSession()`, `getConfig()`,
 * `setConfig()`, `getGlobalStats()`, `getAggregateStats()`, `getTokenStats()`,
 * `getDailyStats()`, `getRalphState()`, `setRalphState()`, `save()`, `saveNow()`
 *
 * Auto-migrates legacy `~/.claudeman/` → `~/.codeman/` on first load.
 *
 * @dependencies types (AppState, RalphSessionState, GlobalStats, TokenStats),
 *   utils (Debouncer, MAX_SESSION_TOKENS)
 * @consumedby session-manager, ralph-loop, web/server, respawn-controller,
 *   hooks-config, and most subsystems
 *
 * @module state-store
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, copyFileSync } from 'node:fs';
import { writeFile, rename, unlink, copyFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  AppState,
  createInitialState,
  RalphSessionState,
  createInitialRalphSessionState,
  GlobalStats,
  createInitialGlobalStats,
  TokenStats,
  TokenUsageEntry,
} from './types.js';
import { Debouncer, MAX_SESSION_TOKENS } from './utils/index.js';
import { dataPath, CODEMAN_INSTANCE } from './config/instance.js';
import { normalizeSessionOrder } from './session-order.js';
import { validateTabLayout, type TabLayout } from './tab-layout.js';

/** Debounce delay for batching state writes (ms) */
const SAVE_DEBOUNCE_MS = 500;

/**
 * Persistent JSON state storage with debounced writes.
 *
 * State is automatically loaded on construction and saved with 500ms
 * debouncing to batch rapid updates into single disk writes.
 *
 * @example
 * ```typescript
 * const store = new StateStore();
 *
 * // Read state
 * const sessions = store.getState().sessions;
 *
 * // Modify and save
 * store.getState().sessions[id] = sessionState;
 * store.save();  // Debounced - won't write immediately
 *
 * // Force immediate write
 * store.saveNow();
 * ```
 */
/** Maximum consecutive save failures before circuit breaker opens */
const MAX_CONSECUTIVE_FAILURES = 3;

export class StateStore {
  private state: AppState;
  private filePath: string;
  private saveDeb = new Debouncer(SAVE_DEBOUNCE_MS);
  private dirty: boolean = false;
  private dirtySessions = new Set<string>();
  private cachedSessionJsons = new Map<string, string>();

  // Inner state storage (separate from main state to reduce write frequency)
  private ralphStates: Map<string, RalphSessionState> = new Map();
  private ralphStatePath: string;
  private ralphStateSaveDeb = new Debouncer(SAVE_DEBOUNCE_MS);
  private ralphStateDirty: boolean = false;

  // Circuit breaker for save failures (prevents hammering disk on persistent errors)
  private consecutiveSaveFailures: number = 0;
  private circuitBreakerOpen: boolean = false;

  // Guard against concurrent saveNowAsync() calls (debounce can race with in-flight write)
  private _saveInFlight: Promise<void> | null = null;

  constructor(filePath?: string) {
    // Migrate legacy data directory (~/.claudeman → ~/.codeman). Default (prod)
    // instance only — a named instance (e.g. beta) must never touch the shared
    // ~/.codeman / ~/codeman-cases layout, preserving instance isolation.
    if (!filePath && !CODEMAN_INSTANCE) {
      const legacyDir = join(homedir(), '.claudeman');
      const newDir = join(homedir(), '.codeman');
      if (existsSync(legacyDir) && !existsSync(newDir)) {
        console.log(`[state-store] Migrating data directory: ${legacyDir} → ${newDir}`);
        renameSync(legacyDir, newDir);
      }
      const legacyCasesDir = join(homedir(), 'claudeman-cases');
      const newCasesDir = join(homedir(), 'codeman-cases');
      if (existsSync(legacyCasesDir) && !existsSync(newCasesDir)) {
        console.log(`[state-store] Migrating cases directory: ${legacyCasesDir} → ${newCasesDir}`);
        renameSync(legacyCasesDir, newCasesDir);
      }
    }

    this.filePath = filePath || dataPath('state.json');
    this.ralphStatePath = this.filePath.replace('.json', '-inner.json');
    this.state = this.load();
    this.state.config.stateFilePath = this.filePath;
    // Pre-populate session cache for loaded state
    for (const [id, session] of Object.entries(this.state.sessions)) {
      this.cachedSessionJsons.set(id, JSON.stringify(session));
    }
    this.loadRalphStates();
  }

  private _mergeWithInitialState(parsed: Partial<AppState>): AppState {
    const initial = createInitialState();
    return {
      ...initial,
      ...parsed,
      sessions: { ...parsed.sessions },
      tasks: { ...parsed.tasks },
      ralphLoop: { ...initial.ralphLoop, ...parsed.ralphLoop },
      config: { ...initial.config, ...parsed.config },
    };
  }

  private _resetCircuitBreaker(): void {
    this.consecutiveSaveFailures = 0;
    if (this.circuitBreakerOpen) {
      console.log('[StateStore] Circuit breaker CLOSED - save succeeded');
      this.circuitBreakerOpen = false;
    }
  }

  private ensureDir(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      // Use restrictive permissions (0o700) - owner only can read/write/traverse
      // State files may contain sensitive session data
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  private load(): AppState {
    // Try main file first, then .bak fallback
    for (const path of [this.filePath, this.filePath + '.bak']) {
      try {
        if (existsSync(path)) {
          const data = readFileSync(path, 'utf-8');
          const parsed = JSON.parse(data) as Partial<AppState>;
          const result = this._mergeWithInitialState(parsed);
          if (path !== this.filePath) {
            console.warn(`[StateStore] Recovered state from backup: ${path}`);
          }
          return result;
        }
      } catch (err) {
        console.error(`Failed to load state from ${path}:`, err);
      }
    }
    return createInitialState();
  }

  /**
   * Schedules a debounced save.
   * Multiple calls within 500ms are batched into a single disk write.
   * Uses async I/O to avoid blocking the event loop.
   */
  save(): void {
    this.dirty = true;
    if (this.saveDeb.isPending) return; // Already scheduled
    this.saveDeb.schedule(() => {
      this.saveNowAsync().catch((err) => {
        console.error('[StateStore] Async save failed:', err);
      });
    });
  }

  /**
   * Async version of saveNow — used by the debounced save() path.
   * Uses non-blocking fs.promises to avoid blocking the event loop during
   * the debounced write cycle. For synchronous shutdown flush, use saveNow().
   *
   * Guards against concurrent execution: if a save is already in flight,
   * waits for it to complete then re-checks dirty flag before starting another.
   */
  async saveNowAsync(): Promise<void> {
    if (this._saveInFlight) {
      await this._saveInFlight;
      // After waiting, re-check if still dirty (the previous save may have handled it)
      if (!this.dirty) return;
    }
    this._saveInFlight = this._doSaveAsync();
    try {
      await this._saveInFlight;
    } finally {
      this._saveInFlight = null;
    }
  }

  /**
   * Assemble JSON string with incremental per-session caching.
   * Only dirty sessions are re-serialized; clean sessions use cached JSON fragments.
   */
  private assembleStateJson(): string {
    this.updateDirtySessionCache();

    // Build sessions object from cached fragments
    const sessionParts: string[] = [];
    for (const [id, session] of Object.entries(this.state.sessions)) {
      let json = this.cachedSessionJsons.get(id);
      if (!json) {
        // Session not in cache (loaded from disk or set via direct state mutation)
        json = JSON.stringify(session);
        this.cachedSessionJsons.set(id, json);
      }
      sessionParts.push(`${JSON.stringify(id)}:${json}`);
    }

    this.pruneStaleCacheEntries();

    return this.buildPartialJson(sessionParts);
  }

  private updateDirtySessionCache(): void {
    // Re-serialize dirty sessions and update cache
    for (const id of this.dirtySessions) {
      const session = this.state.sessions[id];
      if (session) {
        this.cachedSessionJsons.set(id, JSON.stringify(session));
      } else {
        this.cachedSessionJsons.delete(id);
      }
    }
    this.dirtySessions.clear();
  }

  private pruneStaleCacheEntries(): void {
    // Prune stale cache entries (sessions removed via direct state mutation)
    if (this.cachedSessionJsons.size > Object.keys(this.state.sessions).length) {
      for (const cachedId of this.cachedSessionJsons.keys()) {
        if (!(cachedId in this.state.sessions)) {
          this.cachedSessionJsons.delete(cachedId);
        }
      }
    }
  }

  private buildPartialJson(sessionParts: string[]): string {
    // Build final JSON: sessions from cache, everything else re-serialized (tiny)
    const sessionsJson = `{${sessionParts.join(',')}}`;

    // Serialize non-session fields individually (they're small)
    const parts: string[] = [
      `"sessions":${sessionsJson}`,
      `"tasks":${JSON.stringify(this.state.tasks)}`,
      `"ralphLoop":${JSON.stringify(this.state.ralphLoop)}`,
      `"config":${JSON.stringify(this.state.config)}`,
    ];

    // Optional fields
    if (this.state.globalStats) {
      parts.push(`"globalStats":${JSON.stringify(this.state.globalStats)}`);
    }
    if (this.state.tokenStats) {
      parts.push(`"tokenStats":${JSON.stringify(this.state.tokenStats)}`);
    }
    if (this.state.cronJobs) {
      parts.push(`"cronJobs":${JSON.stringify(this.state.cronJobs)}`);
    }
    if (this.state.cronJobRuns) {
      parts.push(`"cronJobRuns":${JSON.stringify(this.state.cronJobRuns)}`);
    }
    if (this.state.sessionOrder) {
      parts.push(`"sessionOrder":${JSON.stringify(this.state.sessionOrder)}`);
    }
    if (this.state.tabLayouts !== undefined) {
      parts.push(`"tabLayouts":${JSON.stringify(this.state.tabLayouts)}`);
    }
    if (this.state.caseDefaultGroups !== undefined) {
      parts.push(`"caseDefaultGroups":${JSON.stringify(this.state.caseDefaultGroups)}`);
    }

    return `{${parts.join(',')}}`;
  }

  private serializeState(): string | null {
    try {
      return this.assembleStateJson();
    } catch (assembleErr) {
      // Fallback to full serialization if incremental assembly fails
      console.warn('[StateStore] assembleStateJson failed, falling back to full serialize:', assembleErr);
      this.cachedSessionJsons.clear();
      this.dirtySessions.clear();
      try {
        return JSON.stringify(this.state);
      } catch (err) {
        console.error('[StateStore] Failed to serialize state (circular reference or invalid data):', err);
        this.consecutiveSaveFailures++;
        if (this.consecutiveSaveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error('[StateStore] Circuit breaker OPEN - serialization failing repeatedly');
          this.circuitBreakerOpen = true;
        }
        return null;
      }
    }
  }

  private async _doSaveAsync(): Promise<void> {
    this.saveDeb.cancel();
    if (!this.dirty) {
      return;
    }

    // Circuit breaker: stop attempting writes after too many failures
    if (this.circuitBreakerOpen) {
      console.warn('[StateStore] Circuit breaker open - skipping save (too many consecutive failures)');
      return;
    }

    this.ensureDir();

    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    const backupPath = this.filePath + '.bak';

    // Step 1: Serialize state (validates it's JSON-safe)
    const json = this.serializeState();
    if (json === null) return;

    // Clear dirty flag BEFORE async I/O so mutations during write re-set it.
    // The state snapshot is already captured in `json` above.
    this.dirty = false;

    // Step 2: Create backup via file copy (async, no read+parse+write)
    try {
      await access(this.filePath);
      await copyFile(this.filePath, backupPath);
    } catch {
      // Backup failed or file doesn't exist yet - continue with write
    }

    // Step 3: Atomic write: write to temp file, then rename (async)
    try {
      await writeFile(tempPath, json, 'utf-8');
      await rename(tempPath, this.filePath);

      this._resetCircuitBreaker();
    } catch (err) {
      console.error('[StateStore] Failed to write state file:', err);
      // Re-mark dirty so the data is retried on the next save cycle
      this.dirty = true;
      this.consecutiveSaveFailures++;

      // Try to clean up temp file on error
      try {
        await unlink(tempPath);
      } catch {
        // Temp file may not exist
      }

      // Check circuit breaker threshold
      if (this.consecutiveSaveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error('[StateStore] Circuit breaker OPEN - writes failing repeatedly');
        this.circuitBreakerOpen = true;
      }
    }
  }

  /**
   * Synchronous immediate write to disk using atomic write pattern.
   * Used by flushAll() during shutdown when async is not appropriate.
   * Prefer saveNowAsync() for normal operation.
   */
  saveNow(): void {
    this.saveDeb.cancel();
    if (!this.dirty) {
      return;
    }

    if (this.circuitBreakerOpen) {
      console.warn('[StateStore] Circuit breaker open - skipping save (too many consecutive failures)');
      return;
    }

    this.ensureDir();

    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    const backupPath = this.filePath + '.bak';

    const json = this.serializeState();
    if (json === null) return;

    // Backup via atomic copy (avoids reading entire file into memory)
    try {
      if (existsSync(this.filePath)) {
        copyFileSync(this.filePath, backupPath);
      }
    } catch {
      // Backup failed - continue with write
    }

    try {
      writeFileSync(tempPath, json, 'utf-8');
      renameSync(tempPath, this.filePath);
      // Clear dirty flag only AFTER successful write
      this.dirty = false;
      this._resetCircuitBreaker();
    } catch (err) {
      console.error('[StateStore] Failed to write state file:', err);
      this.consecutiveSaveFailures++;
      try {
        if (existsSync(tempPath)) unlinkSync(tempPath);
      } catch {
        /* ignore */
      }
      if (this.consecutiveSaveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error('[StateStore] Circuit breaker OPEN - writes failing repeatedly');
        this.circuitBreakerOpen = true;
      }
    }
  }

  /**
   * Attempt to recover state from backup file.
   * Call this if main state file is corrupt.
   */
  recoverFromBackup(): boolean {
    const backupPath = this.filePath + '.bak';
    try {
      if (existsSync(backupPath)) {
        const backupContent = readFileSync(backupPath, 'utf-8');
        const parsed = JSON.parse(backupContent) as Partial<AppState>;
        this.state = this._mergeWithInitialState(parsed);
        console.log('[StateStore] Successfully recovered state from backup');
        // Reset circuit breaker after successful recovery
        this.circuitBreakerOpen = false;
        this.consecutiveSaveFailures = 0;
        return true;
      }
    } catch (err) {
      console.error('[StateStore] Failed to recover from backup:', err);
    }
    return false;
  }

  /**
   * Reset the circuit breaker (for manual intervention).
   */
  resetCircuitBreaker(): void {
    this.circuitBreakerOpen = false;
    this.consecutiveSaveFailures = 0;
    console.log('[StateStore] Circuit breaker manually reset');
  }

  /** Flushes any pending main state save. Call before shutdown. */
  flush(): void {
    this.saveNow();
  }

  /** Returns the full application state object. */
  getState(): AppState {
    return this.state;
  }

  /** Returns all session states keyed by session ID. */
  getSessions() {
    return this.state.sessions;
  }

  /** Returns a session state by ID, or null if not found. */
  getSession(id: string) {
    return this.state.sessions[id] ?? null;
  }

  /** Sets a session state and triggers a debounced save. */
  setSession(id: string, session: AppState['sessions'][string]) {
    this.state.sessions[id] = session;
    this.dirtySessions.add(id);
    this.save();
  }

  /** Removes a session state and triggers a debounced save. */
  removeSession(id: string) {
    delete this.state.sessions[id];
    this.cachedSessionJsons.delete(id);
    this.dirtySessions.delete(id);
    this.save();
  }

  /**
   * COD-142: Remove a session's persisted record on kill UNLESS it is pinned.
   * A pinned session is demoted to a lightweight `stopped` record (pin retained)
   * so it stays visible in the session-manager pinned group and survives restart.
   * Unpinned sessions are fully removed (unchanged behavior).
   * @returns 'preserved' if demoted to stopped+pinned, 'removed' if deleted, 'absent' if no record existed.
   */
  demoteOrRemoveSession(id: string): 'preserved' | 'removed' | 'absent' {
    const existing = this.state.sessions[id];
    if (!existing) return 'absent';
    if (existing.pinned === true) {
      // Demote in place: keep identity/resume fields + pin, mark stopped, clear live runtime.
      this.setSession(id, { ...existing, status: 'stopped', pid: null });
      return 'preserved';
    }
    this.removeSession(id);
    return 'removed';
  }

  /**
   * Cleans up stale sessions from state that don't have corresponding active sessions.
   * @param activeSessionIds - Set of currently active session IDs
   * @returns Number of sessions cleaned up
   */
  cleanupStaleSessions(activeSessionIds: Set<string>): {
    count: number;
    cleaned: Array<{ id: string; name?: string; owner?: string }>;
  } {
    const staleIds = new Set(Object.keys(this.state.sessions).filter((sessionId) => !activeSessionIds.has(sessionId)));
    return this.cleanupSessionsByIds(staleIds);
  }

  /** Deletes only confirmed stale session IDs, retaining records pinned after confirmation. */
  cleanupSessionsByIds(sessionIds: ReadonlySet<string>): {
    count: number;
    cleaned: Array<{ id: string; name?: string; owner?: string }>;
  } {
    const cleaned: Array<{ id: string; name?: string; owner?: string }> = [];

    for (const sessionId of sessionIds) {
      const session = this.state.sessions[sessionId];
      if (!session || session.pinned === true) continue; // COD-142: pinned records persist even with no live session
      cleaned.push({ id: sessionId, name: session.name, owner: session.owner });
      delete this.state.sessions[sessionId];
      this.cachedSessionJsons.delete(sessionId);
      this.dirtySessions.delete(sessionId);
      // Also clean up Ralph state for this session
      this.ralphStates.delete(sessionId);
    }

    if (cleaned.length > 0) {
      console.log(`[StateStore] Cleaned up ${cleaned.length} stale session(s) from state`);
      this.save();
    }

    return { count: cleaned.length, cleaned };
  }

  /** Returns all task states keyed by task ID. */
  getTasks() {
    return this.state.tasks;
  }

  /** Returns a task state by ID, or null if not found. */
  getTask(id: string) {
    return this.state.tasks[id] ?? null;
  }

  /** Sets a task state and triggers a debounced save. */
  setTask(id: string, task: AppState['tasks'][string]) {
    this.state.tasks[id] = task;
    this.save();
  }

  /** Removes a task state and triggers a debounced save. */
  removeTask(id: string) {
    delete this.state.tasks[id];
    this.save();
  }

  /** Returns the Ralph Loop state. */
  getRalphLoopState() {
    return this.state.ralphLoop;
  }

  /** Updates Ralph Loop state (partial merge) and triggers a debounced save. */
  setRalphLoopState(ralphLoop: Partial<AppState['ralphLoop']>) {
    this.state.ralphLoop = { ...this.state.ralphLoop, ...ralphLoop };
    this.save();
  }

  // ========== Orchestrator Loop State Methods ==========

  /** Returns the orchestrator loop state, or null if never initialized. */
  getOrchestratorState() {
    return this.state.orchestrator ?? null;
  }

  /** Updates orchestrator loop state (partial merge) and triggers a debounced save. */
  setOrchestratorState(orchestrator: Partial<NonNullable<AppState['orchestrator']>>) {
    if (this.state.orchestrator) {
      this.state.orchestrator = { ...this.state.orchestrator, ...orchestrator };
    } else {
      // First initialization — caller must provide full state
      this.state.orchestrator = orchestrator as NonNullable<AppState['orchestrator']>;
    }
    this.save();
  }

  /** Clears orchestrator state and triggers a debounced save. */
  clearOrchestratorState() {
    this.state.orchestrator = undefined;
    this.save();
  }

  // ========== Cron Job Methods ==========

  /** Returns all scheduled jobs keyed by job ID. */
  getCronJobs(): Record<string, import('./types/cron.js').CronJob> {
    if (!this.state.cronJobs) this.state.cronJobs = {};
    return this.state.cronJobs;
  }

  /** Returns a scheduled job by ID, or null if not found. */
  getCronJob(id: string): import('./types/cron.js').CronJob | null {
    return this.state.cronJobs?.[id] ?? null;
  }

  /** Sets a scheduled job and triggers a debounced save. */
  setCronJob(id: string, job: import('./types/cron.js').CronJob): void {
    if (!this.state.cronJobs) this.state.cronJobs = {};
    this.state.cronJobs[id] = job;
    this.save();
  }

  /** Removes a scheduled job and triggers a debounced save. */
  removeCronJob(id: string): void {
    if (this.state.cronJobs) delete this.state.cronJobs[id];
    this.save();
  }

  /** Returns all scheduled job runs keyed by run ID. */
  getCronJobRuns(): Record<string, import('./types/cron.js').CronJobRun> {
    if (!this.state.cronJobRuns) this.state.cronJobRuns = {};
    return this.state.cronJobRuns;
  }

  /** Sets a scheduled job run (history record) and triggers a debounced save. */
  setCronJobRun(id: string, run: import('./types/cron.js').CronJobRun): void {
    if (!this.state.cronJobRuns) this.state.cronJobRuns = {};
    this.state.cronJobRuns[id] = run;
    this.save();
  }

  /** Removes a scheduled job run and triggers a debounced save. */
  removeCronJobRun(id: string): void {
    if (this.state.cronJobRuns) delete this.state.cronJobRuns[id];
    this.save();
  }

  /** Returns the application configuration. */
  getConfig() {
    return this.state.config;
  }

  /** Updates configuration (partial merge) and triggers a debounced save. */
  setConfig(config: Partial<AppState['config']>) {
    this.state.config = { ...this.state.config, ...config };
    this.save();
  }

  /** Returns the global tab order (ordered sessionIds), [] if unset. COD-131. */
  getSessionOrder(): string[] {
    return this.state.sessionOrder ?? [];
  }

  /** Persists the global tab order (ordered sessionIds) and triggers a debounced save. COD-131. */
  setSessionOrder(order: string[]): void {
    this.state.sessionOrder = order;
    this.save();
  }

  /** Returns an owner layout, or null before that owner has been migrated. */
  getTabLayout(owner: string): TabLayout | null {
    const layouts = this.state.tabLayouts;
    return layouts && Object.hasOwn(layouts, owner) ? layouts[owner] : null;
  }

  /** Returns a defensive snapshot of every stored owner layout. */
  getTabLayouts(): Record<string, TabLayout> {
    return structuredClone(this.state.tabLayouts ?? {});
  }

  /** Validates and atomically persists one owner layout. */
  setTabLayout(owner: string, layout: TabLayout): void {
    const validated = validateTabLayout(layout);
    this.state.tabLayouts = { ...(this.state.tabLayouts ?? {}), [owner]: validated };
    this.save();
  }

  /** Atomically publishes validated owner layouts and their latest global compatibility projection. */
  commitTabLayoutProjection(
    layouts: Readonly<Record<string, TabLayout>>,
    projectOrder: (latest: readonly string[]) => readonly string[]
  ): { layouts: Record<string, TabLayout>; sessionOrder: string[] } {
    const validated = Object.fromEntries(
      Object.entries(layouts).map(([owner, layout]) => [owner, validateTabLayout(layout)])
    );
    const sessionOrder = normalizeSessionOrder(projectOrder([...(this.state.sessionOrder ?? [])]));
    const nextLayouts = { ...(this.state.tabLayouts ?? {}), ...validated };

    this.state.tabLayouts = nextLayouts;
    this.state.sessionOrder = sessionOrder;
    this.save();
    return { layouts: structuredClone(validated), sessionOrder: [...sessionOrder] };
  }

  /**
   * An owner's default session group for a case: a group id, `null` for an
   * intentional Ungrouped choice, or `undefined` when unset. state.json is read
   * unvalidated, so anything but a string or null reads as unset.
   */
  getCaseDefaultGroup(owner: string, caseName: string): string | null | undefined {
    const all = this.state.caseDefaultGroups;
    if (!all || typeof all !== 'object' || !Object.hasOwn(all, owner)) return undefined;
    const forOwner = all[owner];
    if (!forOwner || typeof forOwner !== 'object' || !Object.hasOwn(forOwner, caseName)) return undefined;
    const value = forOwner[caseName];
    return typeof value === 'string' || value === null ? value : undefined;
  }

  /** Persist an owner's default session group for a case (`null` = Ungrouped). */
  setCaseDefaultGroup(owner: string, caseName: string, groupId: string | null): void {
    const all = this.state.caseDefaultGroups ?? {};
    const forOwner = Object.hasOwn(all, owner) ? all[owner] : {};
    this.state.caseDefaultGroups = { ...all, [owner]: { ...forOwner, [caseName]: groupId } };
    this.save();
  }

  /** Forget an owner's default session group for a case (unset, not Ungrouped). */
  deleteCaseDefaultGroup(owner: string, caseName: string): void {
    if (this.getCaseDefaultGroup(owner, caseName) === undefined) return;
    const all = this.state.caseDefaultGroups ?? {};
    const forOwner = { ...all[owner] };
    delete forOwner[caseName];
    this.state.caseDefaultGroups = { ...all, [owner]: forOwner };
    this.save();
  }

  /** Resets all state to initial values and saves immediately. */
  reset(): void {
    this.state = createInitialState();
    this.state.config.stateFilePath = this.filePath;
    this.ralphStates.clear();
    this.cachedSessionJsons.clear();
    this.dirtySessions.clear();
    this.saveNow(); // Immediate save for reset operations
    this.saveRalphStatesNow();
  }

  // ========== Global Stats Methods ==========

  /** Returns global stats, creating initial stats if needed. */
  getGlobalStats(): GlobalStats {
    if (!this.state.globalStats) {
      this.state.globalStats = createInitialGlobalStats();
    }
    return this.state.globalStats;
  }

  /**
   * Adds tokens and cost to global stats.
   * Call when a session is deleted to preserve its usage in lifetime stats.
   */
  addToGlobalStats(inputTokens: number, outputTokens: number, cost: number): void {
    // Sanity check: reject absurdly large values
    if (inputTokens > MAX_SESSION_TOKENS || outputTokens > MAX_SESSION_TOKENS) {
      console.warn(`[StateStore] Rejected absurd global stats: input=${inputTokens}, output=${outputTokens}`);
      return;
    }
    // Reject negative values
    if (inputTokens < 0 || outputTokens < 0 || cost < 0) {
      console.warn(
        `[StateStore] Rejected negative global stats: input=${inputTokens}, output=${outputTokens}, cost=${cost}`
      );
      return;
    }

    const stats = this.getGlobalStats();
    stats.totalInputTokens += inputTokens;
    stats.totalOutputTokens += outputTokens;
    stats.totalCost += cost;
    stats.lastUpdatedAt = Date.now();
    this.save();
  }

  /** Increments the total sessions created counter. */
  incrementSessionsCreated(): void {
    const stats = this.getGlobalStats();
    stats.totalSessionsCreated += 1;
    stats.lastUpdatedAt = Date.now();
    this.save();
  }

  /**
   * Returns aggregate stats combining global (deleted sessions) + active sessions.
   * @param activeSessions Map of active session states
   */
  getAggregateStats(
    activeSessions: Record<string, { inputTokens?: number; outputTokens?: number; totalCost?: number }>
  ): {
    totalInputTokens: number;
    totalOutputTokens: number;
    totalCost: number;
    totalSessionsCreated: number;
    activeSessionsCount: number;
  } {
    const global = this.getGlobalStats();
    let activeInput = 0;
    let activeOutput = 0;
    let activeCost = 0;
    let activeCount = 0;

    for (const session of Object.values(activeSessions)) {
      activeInput += session.inputTokens ?? 0;
      activeOutput += session.outputTokens ?? 0;
      activeCost += session.totalCost ?? 0;
      activeCount++;
    }

    return {
      totalInputTokens: global.totalInputTokens + activeInput,
      totalOutputTokens: global.totalOutputTokens + activeOutput,
      totalCost: global.totalCost + activeCost,
      totalSessionsCreated: global.totalSessionsCreated,
      activeSessionsCount: activeCount,
    };
  }

  // ========== Token Stats Methods (Daily Tracking) ==========

  /** Maximum days to keep in daily history */
  private static readonly MAX_DAILY_HISTORY = 30;

  /**
   * Get or initialize token stats from state.
   */
  getTokenStats(): TokenStats {
    if (!this.state.tokenStats) {
      this.state.tokenStats = {
        daily: [],
        lastUpdated: Date.now(),
      };
    }
    return this.state.tokenStats;
  }

  /**
   * Get today's date string in YYYY-MM-DD format.
   */
  private getTodayDateString(): string {
    const now = new Date();
    return now.toISOString().split('T')[0];
  }

  /**
   * Calculate estimated cost from tokens using Claude Opus pricing.
   * Input: $15/M tokens, Output: $75/M tokens
   */
  private calculateEstimatedCost(inputTokens: number, outputTokens: number): number {
    const inputCost = (inputTokens / 1000000) * 15;
    const outputCost = (outputTokens / 1000000) * 75;
    return inputCost + outputCost;
  }

  // Track unique sessions per day for accurate session count
  private dailySessionIds: Set<string> = new Set();
  private dailySessionDate: string = '';

  /**
   * Record token usage for today.
   * Accumulates tokens to today's entry, creating it if needed.
   * @param inputTokens Input tokens to add
   * @param outputTokens Output tokens to add
   * @param sessionId Optional session ID for unique session counting
   */
  recordDailyUsage(inputTokens: number, outputTokens: number, sessionId?: string): void {
    if (inputTokens <= 0 && outputTokens <= 0) return;

    // Sanity check: reject absurdly large values (max 1M tokens per recording)
    // Claude's context window is ~200k, so 1M per recording is already very generous
    const MAX_TOKENS_PER_RECORDING = 1_000_000;
    if (inputTokens > MAX_TOKENS_PER_RECORDING || outputTokens > MAX_TOKENS_PER_RECORDING) {
      console.warn(`[StateStore] Rejected absurd token values: input=${inputTokens}, output=${outputTokens}`);
      return;
    }

    const stats = this.getTokenStats();
    const today = this.getTodayDateString();

    // Reset daily session tracking on date change
    if (this.dailySessionDate !== today) {
      this.dailySessionIds.clear();
      this.dailySessionDate = today;
    }

    // Find or create today's entry
    let todayEntry = stats.daily.find((e) => e.date === today);
    if (!todayEntry) {
      todayEntry = {
        date: today,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCost: 0,
        sessions: 0,
      };
      stats.daily.unshift(todayEntry); // Add to front (most recent first)
    }

    // Accumulate tokens
    todayEntry.inputTokens += inputTokens;
    todayEntry.outputTokens += outputTokens;
    todayEntry.estimatedCost = this.calculateEstimatedCost(todayEntry.inputTokens, todayEntry.outputTokens);

    // Only increment session count for unique sessions
    if (sessionId && !this.dailySessionIds.has(sessionId)) {
      this.dailySessionIds.add(sessionId);
      todayEntry.sessions = this.dailySessionIds.size;
    }

    // Prune old entries (keep last 30 days)
    if (stats.daily.length > StateStore.MAX_DAILY_HISTORY) {
      stats.daily = stats.daily.slice(0, StateStore.MAX_DAILY_HISTORY);
    }

    stats.lastUpdated = Date.now();
    this.save();
  }

  /**
   * Get daily stats for display.
   * @param days Number of days to return (default: 30)
   * @returns Array of daily entries, most recent first
   */
  getDailyStats(days: number = 30): TokenUsageEntry[] {
    const stats = this.getTokenStats();
    return stats.daily.slice(0, days);
  }

  // ========== Inner State Methods (Ralph Loop tracking) ==========

  private loadRalphStates(): void {
    try {
      if (existsSync(this.ralphStatePath)) {
        const data = readFileSync(this.ralphStatePath, 'utf-8');
        const parsed = JSON.parse(data) as Record<string, RalphSessionState>;
        for (const [sessionId, state] of Object.entries(parsed)) {
          this.ralphStates.set(sessionId, state);
        }
      }
    } catch (err) {
      console.error('Failed to load inner states:', err);
    }
  }

  // Debounced save for inner states
  private saveRalphStates(): void {
    this.ralphStateDirty = true;
    if (this.ralphStateSaveDeb.isPending) return; // Already scheduled
    this.ralphStateSaveDeb.schedule(() => {
      this.saveRalphStatesNow();
    });
  }

  /**
   * Immediate save for inner states using atomic write pattern.
   * Writes to temp file first, then renames to prevent corruption on crash.
   */
  private saveRalphStatesNow(): void {
    this.ralphStateSaveDeb.cancel();
    if (!this.ralphStateDirty) {
      return;
    }
    // Clear dirty flag only on success to enable retry on failure
    this.ensureDir();
    const data = Object.fromEntries(this.ralphStates);
    // Atomic write: write to temp file, then rename (atomic on POSIX)
    const tempPath = this.ralphStatePath + '.tmp';
    let json: string;
    try {
      json = JSON.stringify(data);
    } catch (err) {
      console.error('[StateStore] Failed to serialize Ralph state (circular reference or invalid data):', err);
      // Keep dirty flag true for retry - don't throw, let caller continue
      return;
    }
    try {
      writeFileSync(tempPath, json, 'utf-8');
      renameSync(tempPath, this.ralphStatePath);
      // Success - clear dirty flag
      this.ralphStateDirty = false;
    } catch (err) {
      console.error('[StateStore] Failed to write Ralph state file:', err);
      // Keep dirty flag true for retry on next save
      // Try to clean up temp file on error
      try {
        if (existsSync(tempPath)) {
          unlinkSync(tempPath);
        }
      } catch (cleanupErr) {
        console.warn('[StateStore] Failed to cleanup temp file during Ralph state save error:', cleanupErr);
      }
      // Don't throw - let caller continue, retry on next save
    }
  }

  /** Returns inner state for a session, or null if not found. */
  getRalphState(sessionId: string): RalphSessionState | null {
    return this.ralphStates.get(sessionId) ?? null;
  }

  /** Sets inner state for a session and triggers a debounced save. */
  setRalphState(sessionId: string, state: RalphSessionState): void {
    this.ralphStates.set(sessionId, state);
    this.saveRalphStates();
  }

  /**
   * Updates inner state for a session (partial merge).
   * Creates initial state if none exists.
   * @returns The updated inner state.
   */
  updateRalphState(sessionId: string, updates: Partial<RalphSessionState>): RalphSessionState {
    let state = this.ralphStates.get(sessionId);
    if (!state) {
      state = createInitialRalphSessionState(sessionId);
    }
    state = { ...state, ...updates, lastUpdated: Date.now() };
    this.ralphStates.set(sessionId, state);
    this.saveRalphStates();
    return state;
  }

  /** Removes inner state for a session and triggers a debounced save. */
  removeRalphState(sessionId: string): void {
    if (this.ralphStates.has(sessionId)) {
      this.ralphStates.delete(sessionId);
      this.saveRalphStates();
    }
  }

  /** Returns a copy of all inner states as a Map. */
  getAllRalphStates(): Map<string, RalphSessionState> {
    return new Map(this.ralphStates);
  }

  /** Flushes all pending saves (main and inner state). Call before shutdown. */
  flushAll(): void {
    // Save both states, catching errors to ensure both are attempted
    let mainError: unknown = null;
    let ralphError: unknown = null;

    try {
      this.saveNow();
    } catch (err) {
      mainError = err;
      console.error('[StateStore] Error flushing main state:', err);
    }

    try {
      this.saveRalphStatesNow();
    } catch (err) {
      ralphError = err;
      console.error('[StateStore] Error flushing Ralph state:', err);
    }

    // Log summary if any errors occurred
    if (mainError || ralphError) {
      console.warn('[StateStore] flushAll completed with errors - some state may not be persisted');
    }
  }
}

// Singleton instance
let storeInstance: StateStore | null = null;

/**
 * Gets or creates the singleton StateStore instance.
 * @param filePath Optional custom file path (only used on first call).
 */
export function getStore(filePath?: string): StateStore {
  if (!storeInstance) {
    storeInstance = new StateStore(filePath);
  }
  return storeInstance;
}
