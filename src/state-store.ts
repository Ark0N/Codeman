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
 * The separation reduces write frequency since inner loop state changes rapidly
 * during Ralph Wiggum loops.
 *
 * @module state-store
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { AppState, createInitialState, InnerSessionState, createInitialInnerSessionState } from './types.js';

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
  private innerStates: Map<string, InnerSessionState> = new Map();
  private innerStatePath: string;
  private innerStateSaveTimeout: NodeJS.Timeout | null = null;
  private innerStateDirty: boolean = false;

  constructor(filePath?: string) {
    this.filePath = filePath || join(homedir(), '.claudeman', 'state.json');
    this.innerStatePath = this.filePath.replace('.json', '-inner.json');
    this.state = this.load();
    this.state.config.stateFilePath = this.filePath;
    this.loadInnerStates();
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
    this.innerStates.clear();
    this.saveNow(); // Immediate save for reset operations
    this.saveInnerStatesNow();
  }

  // ========== Inner State Methods (Ralph Loop tracking) ==========

  private loadInnerStates(): void {
    try {
      if (existsSync(this.innerStatePath)) {
        const data = readFileSync(this.innerStatePath, 'utf-8');
        const parsed = JSON.parse(data) as Record<string, InnerSessionState>;
        for (const [sessionId, state] of Object.entries(parsed)) {
          this.innerStates.set(sessionId, state);
        }
      }
    } catch (err) {
      console.error('Failed to load inner states:', err);
    }
  }

  // Debounced save for inner states
  private saveInnerStates(): void {
    this.innerStateDirty = true;
    if (this.innerStateSaveTimeout) {
      return; // Already scheduled
    }
    this.innerStateSaveTimeout = setTimeout(() => {
      this.saveInnerStatesNow();
    }, SAVE_DEBOUNCE_MS);
  }

  // Immediate save for inner states
  private saveInnerStatesNow(): void {
    if (this.innerStateSaveTimeout) {
      clearTimeout(this.innerStateSaveTimeout);
      this.innerStateSaveTimeout = null;
    }
    if (!this.innerStateDirty) {
      return;
    }
    this.innerStateDirty = false;
    this.ensureDir();
    const data: Record<string, InnerSessionState> = {};
    for (const [sessionId, state] of this.innerStates) {
      data[sessionId] = state;
    }
    writeFileSync(this.innerStatePath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /** Returns inner state for a session, or null if not found. */
  getInnerState(sessionId: string): InnerSessionState | null {
    return this.innerStates.get(sessionId) || null;
  }

  /** Sets inner state for a session and triggers a debounced save. */
  setInnerState(sessionId: string, state: InnerSessionState): void {
    this.innerStates.set(sessionId, state);
    this.saveInnerStates();
  }

  /**
   * Updates inner state for a session (partial merge).
   * Creates initial state if none exists.
   * @returns The updated inner state.
   */
  updateInnerState(sessionId: string, updates: Partial<InnerSessionState>): InnerSessionState {
    let state = this.innerStates.get(sessionId);
    if (!state) {
      state = createInitialInnerSessionState(sessionId);
    }
    state = { ...state, ...updates, lastUpdated: Date.now() };
    this.innerStates.set(sessionId, state);
    this.saveInnerStates();
    return state;
  }

  /** Removes inner state for a session and triggers a debounced save. */
  removeInnerState(sessionId: string): void {
    if (this.innerStates.has(sessionId)) {
      this.innerStates.delete(sessionId);
      this.saveInnerStates();
    }
  }

  /** Returns a copy of all inner states as a Map. */
  getAllInnerStates(): Map<string, InnerSessionState> {
    return new Map(this.innerStates);
  }

  /** Flushes all pending saves (main and inner state). Call before shutdown. */
  flushAll(): void {
    this.saveNow();
    this.saveInnerStatesNow();
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
