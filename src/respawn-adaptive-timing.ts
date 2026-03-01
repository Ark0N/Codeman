/**
 * @fileoverview Adaptive timing controller for respawn idle detection.
 *
 * Extracted from respawn-controller.ts for modularity. Tracks historical timing
 * data and adjusts the completion confirm timeout dynamically based on the 75th
 * percentile of recent idle detection durations.
 *
 * @module respawn-adaptive-timing
 */

import type { TimingHistory } from './types.js';

/**
 * Configuration for adaptive timing bounds.
 */
export interface AdaptiveTimingConfig {
  /** Minimum adaptive completion confirm timeout (ms) */
  adaptiveMinConfirmMs: number;
  /** Maximum adaptive completion confirm timeout (ms) */
  adaptiveMaxConfirmMs: number;
}

/**
 * Manages adaptive timing for respawn idle detection.
 *
 * Uses historical idle detection durations to calculate an optimal completion
 * confirm timeout. The timeout is based on the 75th percentile of recent
 * durations with a 20% safety buffer, clamped to configured bounds.
 */
export class RespawnAdaptiveTiming {
  private timingHistory: TimingHistory;

  constructor(private config: AdaptiveTimingConfig) {
    this.timingHistory = {
      recentIdleDetectionMs: [],
      recentCycleDurationMs: [],
      adaptiveCompletionConfirmMs: 10000, // Start with default
      sampleCount: 0,
      maxSamples: 20, // Keep last 20 samples for rolling average
      lastUpdatedAt: Date.now(),
    };
  }

  /**
   * Record timing data from a completed cycle for adaptive adjustments.
   *
   * @param idleDetectionMs - Time spent detecting idle
   * @param cycleDurationMs - Total cycle duration
   */
  recordTimingData(idleDetectionMs: number, cycleDurationMs: number): void {
    const history = this.timingHistory;

    // Add to rolling windows
    history.recentIdleDetectionMs.push(idleDetectionMs);
    history.recentCycleDurationMs.push(cycleDurationMs);

    // Trim to max samples
    if (history.recentIdleDetectionMs.length > history.maxSamples) {
      history.recentIdleDetectionMs.shift();
    }
    if (history.recentCycleDurationMs.length > history.maxSamples) {
      history.recentCycleDurationMs.shift();
    }

    history.sampleCount = history.recentIdleDetectionMs.length;
    history.lastUpdatedAt = Date.now();

    // Recalculate adaptive timing
    this.updateAdaptiveTiming();
  }

  /**
   * Get the current adaptive completion confirm timeout.
   * Returns the calculated value, or the default if not enough samples.
   *
   * @returns Completion confirm timeout in milliseconds
   */
  getAdaptiveCompletionConfirmMs(): number {
    // Need at least 5 samples before adjusting
    if (this.timingHistory.sampleCount < 5) {
      return this.timingHistory.adaptiveCompletionConfirmMs;
    }

    return this.timingHistory.adaptiveCompletionConfirmMs;
  }

  /**
   * Get the current timing history for monitoring.
   * @returns Copy of timing history
   */
  getTimingHistory(): TimingHistory {
    return { ...this.timingHistory };
  }

  /**
   * Reset all timing history.
   */
  reset(): void {
    this.timingHistory = {
      recentIdleDetectionMs: [],
      recentCycleDurationMs: [],
      adaptiveCompletionConfirmMs: 10000,
      sampleCount: 0,
      maxSamples: 20,
      lastUpdatedAt: Date.now(),
    };
  }

  /**
   * Recalculate the adaptive completion confirm timeout based on historical data.
   * Uses the 75th percentile of recent idle detection times as the new timeout,
   * with a 20% buffer for safety.
   */
  private updateAdaptiveTiming(): void {
    const history = this.timingHistory;
    const minMs = this.config.adaptiveMinConfirmMs;
    const maxMs = this.config.adaptiveMaxConfirmMs;

    if (history.recentIdleDetectionMs.length < 5) return;

    // Sort for percentile calculation
    const sorted = [...history.recentIdleDetectionMs].sort((a, b) => a - b);

    // Use 75th percentile with 20% buffer
    const p75Index = Math.floor(sorted.length * 0.75);
    const p75Value = sorted[p75Index];
    const withBuffer = Math.round(p75Value * 1.2);

    // Clamp to configured bounds
    const clamped = Math.max(minMs, Math.min(maxMs, withBuffer));

    history.adaptiveCompletionConfirmMs = clamped;
  }
}
