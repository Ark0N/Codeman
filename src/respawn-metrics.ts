/**
 * @fileoverview Cycle metrics tracker for respawn controller.
 *
 * Extracted from respawn-controller.ts for modularity. Tracks per-cycle metrics
 * and maintains aggregate statistics across all tracked cycles.
 *
 * @module respawn-metrics
 */

import { assertNever } from './utils/index.js';
import type { RespawnCycleMetrics, RespawnAggregateMetrics, CycleOutcome } from './types.js';

/**
 * Maximum number of cycle metrics to keep in memory.
 */
const MAX_CYCLE_METRICS_IN_MEMORY = 100;

/**
 * Tracks respawn cycle metrics and maintains aggregate statistics.
 *
 * Each respawn cycle is tracked from start to completion, recording timing,
 * steps completed, and outcome. Aggregate metrics provide a rolling view
 * of system health across recent cycles.
 */
export class RespawnCycleMetricsTracker {
  /** Current cycle being tracked */
  private currentCycleMetrics: Partial<RespawnCycleMetrics> | null = null;

  /** Recent cycle metrics (rolling window for aggregate calculation) */
  private recentCycleMetrics: RespawnCycleMetrics[] = [];

  /** Aggregate metrics across all tracked cycles */
  private aggregateMetrics: RespawnAggregateMetrics = {
    totalCycles: 0,
    successfulCycles: 0,
    stuckRecoveryCycles: 0,
    blockedCycles: 0,
    errorCycles: 0,
    avgCycleDurationMs: 0,
    avgIdleDetectionMs: 0,
    p90CycleDurationMs: 0,
    successRate: 100,
    lastUpdatedAt: Date.now(),
  };

  /**
   * Start tracking metrics for a new cycle.
   * Called when a respawn cycle begins.
   *
   * @param sessionId - The session this cycle belongs to
   * @param cycleNumber - The cycle number within the session
   * @param idleReason - What triggered idle detection
   * @param idleDetectionStartTime - Timestamp when idle detection started
   * @param lastTokenCount - Token count at start of cycle
   * @param adaptiveCompletionConfirmMs - Completion confirm timeout used
   */
  startCycle(
    sessionId: string,
    cycleNumber: number,
    idleReason: string,
    idleDetectionStartTime: number,
    lastTokenCount: number,
    adaptiveCompletionConfirmMs: number
  ): void {
    const now = Date.now();
    this.currentCycleMetrics = {
      cycleId: `${sessionId}:${cycleNumber}`,
      sessionId,
      cycleNumber,
      startedAt: now,
      idleReason,
      idleDetectionMs: now - idleDetectionStartTime,
      stepsCompleted: [],
      clearSkipped: false,
      tokenCountAtStart: lastTokenCount,
      completionConfirmMsUsed: adaptiveCompletionConfirmMs,
    };
  }

  /**
   * Record a completed step in the current cycle.
   * @param step - Name of the step (e.g., 'update', 'clear', 'init')
   */
  recordStep(step: string): void {
    if (!this.currentCycleMetrics) return;
    this.currentCycleMetrics.stepsCompleted?.push(step);
  }

  /**
   * Mark that /clear was skipped in the current cycle.
   */
  markClearSkipped(): void {
    if (this.currentCycleMetrics) {
      this.currentCycleMetrics.clearSkipped = true;
    }
  }

  /**
   * Get the current in-progress cycle metrics (for external inspection).
   * @returns The current cycle metrics, or null if no cycle is in progress
   */
  getCurrentCycle(): Partial<RespawnCycleMetrics> | null {
    return this.currentCycleMetrics;
  }

  /**
   * Complete the current cycle metrics with outcome.
   * Adds to recent metrics and updates aggregates.
   *
   * @param outcome - Outcome of the cycle
   * @param lastTokenCount - Token count at end of cycle
   * @param errorMessage - Optional error message if outcome is 'error'
   * @returns The completed cycle metrics, or null if no cycle was in progress
   */
  completeCycle(outcome: CycleOutcome, lastTokenCount: number, errorMessage?: string): RespawnCycleMetrics | null {
    if (!this.currentCycleMetrics) return null;

    const now = Date.now();
    const metrics: RespawnCycleMetrics = {
      ...(this.currentCycleMetrics as RespawnCycleMetrics),
      completedAt: now,
      durationMs: now - (this.currentCycleMetrics.startedAt ?? now),
      outcome,
      errorMessage,
      tokenCountAtEnd: lastTokenCount,
    };

    // Add to recent metrics
    this.recentCycleMetrics.push(metrics);
    if (this.recentCycleMetrics.length > MAX_CYCLE_METRICS_IN_MEMORY) {
      this.recentCycleMetrics.shift();
    }

    // Update aggregate metrics
    this.updateAggregateMetrics(metrics);

    // Clear current cycle
    this.currentCycleMetrics = null;

    return metrics;
  }

  /**
   * Get aggregate metrics for monitoring.
   * @returns Copy of aggregate metrics
   */
  getAggregate(): RespawnAggregateMetrics {
    return { ...this.aggregateMetrics };
  }

  /**
   * Get recent cycle metrics for analysis.
   * @param limit - Maximum number of metrics to return (default: 20)
   * @returns Recent cycle metrics, newest first
   */
  getRecent(limit: number = 20): RespawnCycleMetrics[] {
    return this.recentCycleMetrics.slice(-limit).reverse();
  }

  /**
   * Reset all metrics state.
   */
  reset(): void {
    this.currentCycleMetrics = null;
    this.recentCycleMetrics = [];
    this.aggregateMetrics = {
      totalCycles: 0,
      successfulCycles: 0,
      stuckRecoveryCycles: 0,
      blockedCycles: 0,
      errorCycles: 0,
      avgCycleDurationMs: 0,
      avgIdleDetectionMs: 0,
      p90CycleDurationMs: 0,
      successRate: 100,
      lastUpdatedAt: Date.now(),
    };
  }

  /**
   * Update aggregate metrics with a new cycle's data.
   * @param metrics - The completed cycle metrics
   */
  private updateAggregateMetrics(metrics: RespawnCycleMetrics): void {
    const agg = this.aggregateMetrics;

    agg.totalCycles++;

    switch (metrics.outcome) {
      case 'success':
        agg.successfulCycles++;
        break;
      case 'stuck_recovery':
        agg.stuckRecoveryCycles++;
        break;
      case 'blocked':
        agg.blockedCycles++;
        break;
      case 'error':
        agg.errorCycles++;
        break;
      case 'cancelled':
        // Cancelled cycles don't count towards any specific category
        // but are still counted in totalCycles
        break;
      default:
        assertNever(metrics.outcome, `Unhandled CycleOutcome: ${metrics.outcome}`);
    }

    // Recalculate averages using all recent metrics
    const durations = this.recentCycleMetrics.map((m) => m.durationMs);
    const idleTimes = this.recentCycleMetrics.map((m) => m.idleDetectionMs);

    if (durations.length > 0) {
      agg.avgCycleDurationMs = Math.round(durations.reduce((a, b) => a + b, 0) / durations.length);
      agg.avgIdleDetectionMs = Math.round(idleTimes.reduce((a, b) => a + b, 0) / idleTimes.length);

      // Calculate P90
      const sortedDurations = [...durations].sort((a, b) => a - b);
      const p90Index = Math.floor(sortedDurations.length * 0.9);
      agg.p90CycleDurationMs = sortedDurations[p90Index];
    }

    // Calculate success rate
    agg.successRate = agg.totalCycles > 0 ? Math.round((agg.successfulCycles / agg.totalCycles) * 100) : 100;

    agg.lastUpdatedAt = Date.now();
  }
}
