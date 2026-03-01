/**
 * @fileoverview RalphStallDetector - Iteration stall detection
 *
 * Monitors iteration progress and emits warnings when the loop
 * appears to be stalled (no iteration changes for extended periods).
 *
 * Extracted from ralph-tracker.ts as part of domain splitting.
 *
 * @module ralph-stall-detector
 */

import { EventEmitter } from 'node:events';

/**
 * RalphStallDetector - Detects iteration stalls in the Ralph loop.
 *
 * Events emitted:
 * - `iterationStallWarning` - When iteration hasn't changed for warning threshold
 * - `iterationStallCritical` - When iteration hasn't changed for critical threshold
 */
export class RalphStallDetector extends EventEmitter {
  /** Timestamp when iteration count last changed */
  private _lastIterationChangeTime: number = 0;

  /** Last observed iteration count for stall detection */
  private _lastObservedIteration: number = 0;

  /** Timer for iteration stall detection */
  private _iterationStallTimer: NodeJS.Timeout | null = null;

  /** Iteration stall warning threshold (ms) - default 10 minutes */
  private _iterationStallWarningMs: number = 10 * 60 * 1000;

  /** Iteration stall critical threshold (ms) - default 20 minutes */
  private _iterationStallCriticalMs: number = 20 * 60 * 1000;

  /** Whether stall warning has been emitted */
  private _iterationStallWarned: boolean = false;

  /** Whether the loop is currently active */
  private _loopActive: boolean = false;

  constructor() {
    super();
    this._lastIterationChangeTime = Date.now();
  }

  /**
   * Start iteration stall detection timer.
   * Should be called when the loop becomes active.
   */
  startIterationStallDetection(): void {
    this.stopIterationStallDetection();
    this._lastIterationChangeTime = Date.now();
    this._iterationStallWarned = false;

    // Check every minute
    this._iterationStallTimer = setInterval(() => {
      this.checkIterationStall();
    }, 60 * 1000);
  }

  /**
   * Stop iteration stall detection timer.
   */
  stopIterationStallDetection(): void {
    if (this._iterationStallTimer) {
      clearInterval(this._iterationStallTimer);
      this._iterationStallTimer = null;
    }
  }

  /**
   * Notify the detector that the iteration has changed.
   * Resets stall tracking state.
   */
  notifyIterationChanged(iteration: number): void {
    this._lastIterationChangeTime = Date.now();
    this._lastObservedIteration = iteration;
    this._iterationStallWarned = false;
  }

  /**
   * Set whether the loop is currently active.
   * Stall detection only fires when loop is active.
   */
  setLoopActive(active: boolean): void {
    this._loopActive = active;
  }

  /**
   * Check for iteration stall and emit appropriate events.
   */
  private checkIterationStall(): void {
    if (!this._loopActive) return;

    const stallDurationMs = Date.now() - this._lastIterationChangeTime;

    // Critical stall (longer duration)
    if (stallDurationMs >= this._iterationStallCriticalMs) {
      this.emit('iterationStallCritical', {
        iteration: this._lastObservedIteration,
        stallDurationMs,
      });
      return;
    }

    // Warning stall
    if (stallDurationMs >= this._iterationStallWarningMs && !this._iterationStallWarned) {
      this._iterationStallWarned = true;
      this.emit('iterationStallWarning', {
        iteration: this._lastObservedIteration,
        stallDurationMs,
      });
    }
  }

  /**
   * Get iteration stall metrics for monitoring.
   */
  getIterationStallMetrics(): {
    lastIterationChangeTime: number;
    stallDurationMs: number;
    warningThresholdMs: number;
    criticalThresholdMs: number;
    isWarned: boolean;
    currentIteration: number;
  } {
    return {
      lastIterationChangeTime: this._lastIterationChangeTime,
      stallDurationMs: Date.now() - this._lastIterationChangeTime,
      warningThresholdMs: this._iterationStallWarningMs,
      criticalThresholdMs: this._iterationStallCriticalMs,
      isWarned: this._iterationStallWarned,
      currentIteration: this._lastObservedIteration,
    };
  }

  /**
   * Configure iteration stall thresholds.
   * @param warningMs - Warning threshold in milliseconds
   * @param criticalMs - Critical threshold in milliseconds
   */
  configureIterationStallThresholds(warningMs: number, criticalMs: number): void {
    this._iterationStallWarningMs = warningMs;
    this._iterationStallCriticalMs = criticalMs;
  }

  /**
   * Reset stall detector state.
   */
  reset(): void {
    this._lastIterationChangeTime = Date.now();
    this._lastObservedIteration = 0;
    this._iterationStallWarned = false;
    this._loopActive = false;
  }

  /**
   * Clean up all resources.
   */
  destroy(): void {
    this.stopIterationStallDetection();
    this.removeAllListeners();
  }
}
