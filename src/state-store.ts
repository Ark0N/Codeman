/**
 * @fileoverview Persistent JSON state storage for Claudeman.
 *
 * This module provides the StateStore class which persists application state
 * to `~/.claudeman/state.json` with debounced writes to prevent excessive disk I/O.
 *
 * State is split into two files:
 * - `state.json`: Main app state (sessions, tasks, config)
 * - `state-inner.json`: Inner loop state (todos, Ralph loop state per session)
 *
 * The separation reduces write frequency since Ralph state changes rapidly
 * during Ralph Wiggum loops.
 *
 * @module state-store
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, unlinkSync, copyFileSync } from 'node:fs';
import { writeFile, rename, unlink, copyFile, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AppState, createInitialState, RalphSessionState, createInitialRalphSessionState, GlobalStats, createInitialGlobalStats, TokenStats, TokenUsageEntry } from './types.js';
import { MAX_SESSION_TOKENS } from './utils/index.js';

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
  private saveTimeout: NodeJS.Timeout | null = null;
  private dirty: boolean = false;

  // Inner state storage (separate from main state to reduce write frequency)
  private ralphStates: Map<string, RalphSessionState> = new Map();
  private ralphStatePath: string;
  private ralphStateSaveTimeout: NodeJS.Timeout | null = null;
  private ralphStateDirty: boolean = false;

  // Circuit breaker for save failures (prevents hammering disk on persistent errors)
  private consecutiveSaveFailures: number = 0;
  private circuitBreakerOpen: boolean = false;

  constructor(filePath?: string) {
    this.filePath = filePath || join(homedir(), '.claudeman', 'state.json');
    this.ralphStatePath = this.filePath.replace('.json', '-inner.json');
    this.state = this.load();
    this.state.config.stateFilePath = this.filePath;
    this.loadRalphStates();
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
          const initial = createInitialState();
          const result = {
            ...initial,
            ...parsed,
            sessions: { ...parsed.sessions },
            tasks: { ...parsed.tasks },
            ralphLoop: { ...initial.ralphLoop, ...parsed.ralphLoop },
            config: { ...initial.config, ...parsed.config },
          };
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
    if (this.saveTimeout) {
      return; // Already scheduled
    }
    this.saveTimeout = setTimeout(() => {
      this.saveNowAsync().catch((err) => {
        console.error('[StateStore] Async save failed:', err);
      });
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Async version of saveNow — used by the debounced save() path.
   * Uses non-blocking fs.promises to avoid blocking the event loop during
   * the debounced write cycle. For synchronous shutdown flush, use saveNow().
   */
  async saveNowAsync(): Promise<void> {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    if (!this.dirty) {
      return;
    }

    // Circuit breaker: stop attempting writes after too many failures
    if (this.circuitBreakerOpen) {
      console.warn('[StateStore] Circuit breaker open - skipping save (too many consecutive failures)');
      return;
    }

    this.ensureDir();

    const tempPath = this.filePath + '.tmp';
    const backupPath = this.filePath + '.bak';
    let json: string;

    // Step 1: Serialize state (validates it's JSON-safe)
    try {
      json = JSON.stringify(this.state);
    } catch (err) {
      console.error('[StateStore] Failed to serialize state (circular reference or invalid data):', err);
      this.consecutiveSaveFailures++;
      if (this.consecutiveSaveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error('[StateStore] Circuit breaker OPEN - serialization failing repeatedly');
        this.circuitBreakerOpen = true;
      }
      return;
    }

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

      // Success! Clear dirty flag AFTER write completes
      this.dirty = false;
      this.consecutiveSaveFailures = 0;
      if (this.circuitBreakerOpen) {
        console.log('[StateStore] Circuit breaker CLOSED - save succeeded');
        this.circuitBreakerOpen = false;
      }
    } catch (err) {
      console.error('[StateStore] Failed to write state file:', err);
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
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    if (!this.dirty) {
      return;
    }

    if (this.circuitBreakerOpen) {
      console.warn('[StateStore] Circuit breaker open - skipping save (too many consecutive failures)');
      return;
    }

    this.dirty = false;
    this.ensureDir();

    const tempPath = this.filePath + '.tmp';
    const backupPath = this.filePath + '.bak';
    let json: string;

    try {
      json = JSON.stringify(this.state);
    } catch (err) {
      console.error('[StateStore] Failed to serialize state (circular reference or invalid data):', err);
      this.consecutiveSaveFailures++;
      if (this.consecutiveSaveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error('[StateStore] Circuit breaker OPEN - serialization failing repeatedly');
        this.circuitBreakerOpen = true;
      }
      this.dirty = true;
      return;
    }

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
      this.consecutiveSaveFailures = 0;
      if (this.circuitBreakerOpen) {
        console.log('[StateStore] Circuit breaker CLOSED - save succeeded');
        this.circuitBreakerOpen = false;
      }
    } catch (err) {
      console.error('[StateStore] Failed to write state file:', err);
      this.consecutiveSaveFailures++;
      try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch { /* ignore */ }
      if (this.consecutiveSaveFailures >= MAX_CONSECUTIVE_FAILURES) {
        console.error('[StateStore] Circuit breaker OPEN - writes failing repeatedly');
        this.circuitBreakerOpen = true;
      }
      this.dirty = true;
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
        const initial = createInitialState();
        this.state = {
          ...initial,
          ...parsed,
          sessions: { ...parsed.sessions },
          tasks: { ...parsed.tasks },
          ralphLoop: { ...initial.ralphLoop, ...parsed.ralphLoop },
          config: { ...initial.config, ...parsed.config },
        };
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
    this.save();
  }

  /** Removes a session state and triggers a debounced save. */
  removeSession(id: string) {
    delete this.state.sessions[id];
    this.save();
  }

  /**
   * Cleans up stale sessions from state that don't have corresponding active sessions.
   * @param activeSessionIds - Set of currently active session IDs
   * @returns Number of sessions cleaned up
   */
  cleanupStaleSessions(activeSessionIds: Set<string>): number {
    const allSessionIds = Object.keys(this.state.sessions);
    let cleanedCount = 0;

    for (const sessionId of allSessionIds) {
      if (!activeSessionIds.has(sessionId)) {
        delete this.state.sessions[sessionId];
        // Also clean up Ralph state for this session
        this.ralphStates.delete(sessionId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      console.log(`[StateStore] Cleaned up ${cleanedCount} stale session(s) from state`);
      this.save();
    }

    return cleanedCount;
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

  /** Returns the application configuration. */
  getConfig() {
    return this.state.config;
  }

  /** Updates configuration (partial merge) and triggers a debounced save. */
  setConfig(config: Partial<AppState['config']>) {
    this.state.config = { ...this.state.config, ...config };
    this.save();
  }

  /** Resets all state to initial values and saves immediately. */
  reset(): void {
    this.state = createInitialState();
    this.state.config.stateFilePath = this.filePath;
    this.ralphStates.clear();
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
      console.warn(`[StateStore] Rejected negative global stats: input=${inputTokens}, output=${outputTokens}, cost=${cost}`);
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
  getAggregateStats(activeSessions: Record<string, { inputTokens?: number; outputTokens?: number; totalCost?: number }>): {
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
    let todayEntry = stats.daily.find(e => e.date === today);
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
    todayEntry.estimatedCost = this.calculateEstimatedCost(
      todayEntry.inputTokens,
      todayEntry.outputTokens
    );

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
    if (this.ralphStateSaveTimeout) {
      return; // Already scheduled
    }
    this.ralphStateSaveTimeout = setTimeout(() => {
      this.saveRalphStatesNow();
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Immediate save for inner states using atomic write pattern.
   * Writes to temp file first, then renames to prevent corruption on crash.
   */
  private saveRalphStatesNow(): void {
    if (this.ralphStateSaveTimeout) {
      clearTimeout(this.ralphStateSaveTimeout);
      this.ralphStateSaveTimeout = null;
    }
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
      json = JSON.stringify(data, null, 2);
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
