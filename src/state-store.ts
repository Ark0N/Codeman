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

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AppState, createInitialState, RalphSessionState, createInitialRalphSessionState, GlobalStats, createInitialGlobalStats, TokenStats, TokenUsageEntry } from './types.js';

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
      mkdirSync(dir, { recursive: true });
    }
  }

  private load(): AppState {
    try {
      if (existsSync(this.filePath)) {
        const data = readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(data) as Partial<AppState>;
        // Merge with initial state to ensure all fields exist
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
    } catch (err) {
      console.error('Failed to load state, using initial state:', err);
    }
    return createInitialState();
  }

  /**
   * Schedules a debounced save.
   * Multiple calls within 500ms are batched into a single disk write.
   */
  save(): void {
    this.dirty = true;
    if (this.saveTimeout) {
      return; // Already scheduled
    }
    this.saveTimeout = setTimeout(() => {
      this.saveNow();
    }, SAVE_DEBOUNCE_MS);
  }

  /**
   * Immediately writes state to disk.
   * Use when guaranteed persistence is required (e.g., before shutdown).
   */
  saveNow(): void {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    if (!this.dirty) {
      return;
    }
    this.dirty = false;
    this.ensureDir();
    writeFileSync(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8');
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
    return this.state.sessions[id] || null;
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

  /** Returns all task states keyed by task ID. */
  getTasks() {
    return this.state.tasks;
  }

  /** Returns a task state by ID, or null if not found. */
  getTask(id: string) {
    return this.state.tasks[id] || null;
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
    const state = this.state as AppState & { tokenStats?: TokenStats };
    if (!state.tokenStats) {
      state.tokenStats = {
        daily: [],
        lastUpdated: Date.now(),
      };
    }
    return state.tokenStats;
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

  /**
   * Record token usage for today.
   * Accumulates tokens to today's entry, creating it if needed.
   * @param inputTokens Input tokens to add
   * @param outputTokens Output tokens to add
   */
  recordDailyUsage(inputTokens: number, outputTokens: number): void {
    if (inputTokens <= 0 && outputTokens <= 0) return;

    const stats = this.getTokenStats();
    const today = this.getTodayDateString();

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
    todayEntry.sessions += 1;

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

  // Immediate save for inner states
  private saveRalphStatesNow(): void {
    if (this.ralphStateSaveTimeout) {
      clearTimeout(this.ralphStateSaveTimeout);
      this.ralphStateSaveTimeout = null;
    }
    if (!this.ralphStateDirty) {
      return;
    }
    this.ralphStateDirty = false;
    this.ensureDir();
    const data: Record<string, RalphSessionState> = {};
    for (const [sessionId, state] of this.ralphStates) {
      data[sessionId] = state;
    }
    writeFileSync(this.ralphStatePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /** Returns inner state for a session, or null if not found. */
  getRalphState(sessionId: string): RalphSessionState | null {
    return this.ralphStates.get(sessionId) || null;
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
    this.saveNow();
    this.saveRalphStatesNow();
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
