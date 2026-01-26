/**
 * @fileoverview Run Summary Tracker for Claudeman sessions
 *
 * Tracks significant events during a session's lifetime to provide users
 * with a consolidated "what happened while I was away" view.
 *
 * Features:
 * - Event timeline with severity levels
 * - Aggregated statistics (respawn cycles, tokens, active time, etc.)
 * - State stuck detection (warning when state doesn't change for extended periods)
 * - Token milestone tracking (every 50k tokens)
 *
 * @module run-summary
 */

import { v4 as uuidv4 } from 'uuid';
import {
  RunSummary,
  RunSummaryEvent,
  RunSummaryEventType,
  RunSummaryEventSeverity,
  RunSummaryStats,
  createInitialRunSummaryStats,
} from './types.js';

/** Maximum events to keep per session (FIFO trimming) */
const MAX_EVENTS = 1000;

/** Trim to this many events when MAX_EVENTS exceeded */
const TRIM_TO_EVENTS = 800;

/** Token milestone interval (track every N tokens) */
const TOKEN_MILESTONE_INTERVAL = 50000;

/** State stuck warning threshold (ms) */
const STATE_STUCK_WARNING_MS = 10 * 60 * 1000; // 10 minutes

/** State stuck check interval (ms) */
const STATE_STUCK_CHECK_INTERVAL = 60 * 1000; // 1 minute

/**
 * Tracks events and statistics for a session's run summary.
 *
 * @example
 * ```typescript
 * const tracker = new RunSummaryTracker('session-123', 'My Session');
 *
 * // Record events
 * tracker.addEvent('session_started', 'info', 'Session started');
 * tracker.addEvent('idle_detected', 'success', 'Claude is idle');
 *
 * // Get the summary
 * const summary = tracker.getSummary();
 * ```
 */
export class RunSummaryTracker {
  private sessionId: string;
  private sessionName: string;
  private startedAt: number;
  private lastUpdatedAt: number;
  private events: RunSummaryEvent[] = [];
  private stats: RunSummaryStats;

  // State tracking for stuck detection
  private currentState: string | null = null;
  private stateEnteredAt: number | null = null;
  private stateStuckCheckTimer: NodeJS.Timeout | null = null;
  private stateStuckWarned: boolean = false;

  // Token tracking for milestones
  private lastTokenMilestone: number = 0;

  // Active/idle time tracking
  private isCurrentlyActive: boolean = false;
  private lastStatusChangeAt: number;

  // Respawn cycle tracking
  private inRespawnCycle: boolean = false;

  constructor(sessionId: string, sessionName: string = '') {
    this.sessionId = sessionId;
    this.sessionName = sessionName;
    this.startedAt = Date.now();
    this.lastUpdatedAt = this.startedAt;
    this.lastStatusChangeAt = this.startedAt;
    this.stats = createInitialRunSummaryStats();

    // Start state stuck detection
    this.startStateStuckDetection();
  }

  /**
   * Add an event to the timeline.
   */
  addEvent(
    type: RunSummaryEventType,
    severity: RunSummaryEventSeverity,
    title: string,
    details?: string,
    metadata?: Record<string, unknown>
  ): RunSummaryEvent {
    const event: RunSummaryEvent = {
      id: uuidv4(),
      timestamp: Date.now(),
      type,
      severity,
      title,
      details,
      metadata,
    };

    this.events.push(event);
    this.lastUpdatedAt = event.timestamp;

    // Update stats based on event type
    this.updateStatsFromEvent(event);

    // Trim if needed
    if (this.events.length > MAX_EVENTS) {
      this.events = this.events.slice(-TRIM_TO_EVENTS);
    }

    return event;
  }

  /**
   * Record a state change (for respawn controller states).
   */
  recordStateChange(newState: string, details?: string): void {
    const oldState = this.currentState;

    // Check if entering or leaving a respawn cycle
    if (newState === 'sending_update' && !this.inRespawnCycle) {
      this.inRespawnCycle = true;
      this.addEvent('respawn_cycle_started', 'info', 'Respawn cycle started', details);
    } else if (newState === 'watching' && this.inRespawnCycle && oldState !== 'watching') {
      this.inRespawnCycle = false;
      this.stats.totalRespawnCycles++;
      this.addEvent('respawn_cycle_completed', 'success', 'Respawn cycle completed', details);
    }

    // Record state transition
    if (oldState && oldState !== newState) {
      this.stats.stateTransitions++;
      this.addEvent(
        'respawn_state_change',
        'info',
        `State: ${oldState} → ${newState}`,
        details,
        { from: oldState, to: newState }
      );
    }

    // Update state tracking
    this.currentState = newState;
    this.stateEnteredAt = Date.now();
    this.stateStuckWarned = false;
  }

  /**
   * Record when Claude becomes idle.
   */
  recordIdle(): void {
    const now = Date.now();

    // Update active time if was previously active
    if (this.isCurrentlyActive) {
      this.stats.totalTimeActiveMs += now - this.lastStatusChangeAt;
    }

    this.isCurrentlyActive = false;
    this.lastStatusChangeAt = now;
    this.stats.lastIdleAt = now;

    this.addEvent('idle_detected', 'success', 'Claude is idle', undefined, {
      activeTimeMs: this.stats.totalTimeActiveMs,
    });
  }

  /**
   * Record when Claude starts working.
   */
  recordWorking(): void {
    const now = Date.now();

    // Update idle time if was previously idle
    // Note: We count the initial idle period (from session start to first working state)
    // even if lastIdleAt hasn't been set yet
    if (!this.isCurrentlyActive) {
      this.stats.totalTimeIdleMs += now - this.lastStatusChangeAt;
    }

    this.isCurrentlyActive = true;
    this.lastStatusChangeAt = now;
    this.stats.lastWorkingAt = now;

    this.addEvent('working_detected', 'info', 'Claude is working');
  }

  /**
   * Record token usage update.
   */
  recordTokens(inputTokens: number, outputTokens: number): void {
    const total = inputTokens + outputTokens;
    this.stats.totalTokensUsed = total;

    if (total > this.stats.peakTokens) {
      this.stats.peakTokens = total;
    }

    // Check for milestone
    const currentMilestone = Math.floor(total / TOKEN_MILESTONE_INTERVAL) * TOKEN_MILESTONE_INTERVAL;
    if (currentMilestone > this.lastTokenMilestone && currentMilestone > 0) {
      this.lastTokenMilestone = currentMilestone;
      this.addEvent(
        'token_milestone',
        'info',
        `Token milestone: ${this.formatTokens(currentMilestone)}`,
        `Input: ${this.formatTokens(inputTokens)}, Output: ${this.formatTokens(outputTokens)}`,
        { total, input: inputTokens, output: outputTokens }
      );
    }
  }

  /**
   * Record an AI idle check result.
   */
  recordAiCheckResult(verdict: string, confidence?: number): void {
    this.stats.aiCheckCount++;
    const isIdle = verdict === 'IDLE';
    this.addEvent(
      'ai_check_result',
      isIdle ? 'success' : 'info',
      `AI check: ${verdict}`,
      confidence !== undefined ? `Confidence: ${confidence}%` : undefined,
      { verdict, confidence }
    );
  }

  /**
   * Record an auto-compact event.
   */
  recordAutoCompact(tokens: number, threshold: number): void {
    this.addEvent(
      'auto_compact',
      'warning',
      'Auto-compact triggered',
      `Tokens: ${this.formatTokens(tokens)} / Threshold: ${this.formatTokens(threshold)}`,
      { tokens, threshold }
    );
  }

  /**
   * Record an auto-clear event.
   */
  recordAutoClear(tokens: number, threshold: number): void {
    this.addEvent(
      'auto_clear',
      'warning',
      'Auto-clear triggered',
      `Tokens: ${this.formatTokens(tokens)} / Threshold: ${this.formatTokens(threshold)}`,
      { tokens, threshold }
    );
  }

  /**
   * Record a Ralph completion detection.
   */
  recordRalphCompletion(phrase: string): void {
    this.addEvent(
      'ralph_completion',
      'success',
      'Ralph completion detected',
      `Phrase: ${phrase}`,
      { phrase }
    );
  }

  /**
   * Record a hook event from Claude Code.
   */
  recordHookEvent(eventType: string, data?: Record<string, unknown>): void {
    const severity: RunSummaryEventSeverity =
      eventType === 'stop' ? 'warning' :
      eventType === 'permission_prompt' ? 'info' :
      'info';

    this.addEvent(
      'hook_event',
      severity,
      `Hook: ${eventType}`,
      data?.tool_name ? `Tool: ${data.tool_name}` : undefined,
      { eventType, ...data }
    );
  }

  /**
   * Record an error.
   */
  recordError(title: string, details?: string, metadata?: Record<string, unknown>): void {
    this.stats.errorCount++;
    this.addEvent('error', 'error', title, details, metadata);
  }

  /**
   * Record a warning.
   */
  recordWarning(title: string, details?: string, metadata?: Record<string, unknown>): void {
    this.stats.warningCount++;
    this.addEvent('warning', 'warning', title, details, metadata);
  }

  /**
   * Record session started.
   */
  recordSessionStarted(mode: string, workingDir: string): void {
    this.addEvent(
      'session_started',
      'success',
      'Session started',
      `Mode: ${mode}, Dir: ${workingDir}`,
      { mode, workingDir }
    );
  }

  /**
   * Record session stopped.
   */
  recordSessionStopped(): void {
    // Finalize active/idle time
    const now = Date.now();
    if (this.isCurrentlyActive) {
      this.stats.totalTimeActiveMs += now - this.lastStatusChangeAt;
    } else {
      this.stats.totalTimeIdleMs += now - this.lastStatusChangeAt;
    }

    this.addEvent(
      'session_stopped',
      'info',
      'Session stopped',
      `Duration: ${this.formatDuration(now - this.startedAt)}`
    );
  }

  /**
   * Get the complete run summary.
   */
  getSummary(): RunSummary {
    // Update times before returning
    const now = Date.now();
    const stats = { ...this.stats };

    // Add current active/idle period
    if (this.isCurrentlyActive) {
      stats.totalTimeActiveMs += now - this.lastStatusChangeAt;
    } else {
      stats.totalTimeIdleMs += now - this.lastStatusChangeAt;
    }

    return {
      sessionId: this.sessionId,
      sessionName: this.sessionName,
      startedAt: this.startedAt,
      lastUpdatedAt: this.lastUpdatedAt,
      events: [...this.events],
      stats,
    };
  }

  /**
   * Get recent events (for SSE updates).
   */
  getRecentEvents(count: number = 10): RunSummaryEvent[] {
    return this.events.slice(-count);
  }

  /**
   * Update session name.
   */
  setSessionName(name: string): void {
    this.sessionName = name;
  }

  /**
   * Stop tracking and clean up.
   */
  stop(): void {
    if (this.stateStuckCheckTimer) {
      clearInterval(this.stateStuckCheckTimer);
      this.stateStuckCheckTimer = null;
    }
  }

  // ========== Private Methods ==========

  private updateStatsFromEvent(_event: RunSummaryEvent): void {
    // Most stats are updated in the specific record* methods
    // This is for any additional cross-cutting concerns
  }

  private startStateStuckDetection(): void {
    this.stateStuckCheckTimer = setInterval(() => {
      if (!this.currentState || !this.stateEnteredAt || this.stateStuckWarned) {
        return;
      }

      const timeInState = Date.now() - this.stateEnteredAt;
      if (timeInState >= STATE_STUCK_WARNING_MS) {
        this.stateStuckWarned = true;
        const minutes = Math.floor(timeInState / 60000);
        this.stats.warningCount++;
        this.addEvent(
          'state_stuck',
          'warning',
          `State stuck: ${this.currentState}`,
          `In state for ${minutes}+ minutes`,
          { state: this.currentState, durationMs: timeInState }
        );
      }
    }, STATE_STUCK_CHECK_INTERVAL);
  }

  private formatTokens(tokens: number): string {
    if (tokens >= 1000000) {
      return `${(tokens / 1000000).toFixed(1)}M`;
    }
    if (tokens >= 1000) {
      return `${(tokens / 1000).toFixed(1)}k`;
    }
    return String(tokens);
  }

  private formatDuration(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);

    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  }
}
