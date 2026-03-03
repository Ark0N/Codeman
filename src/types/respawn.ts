/**
 * @fileoverview Respawn controller type definitions.
 *
 * Covers the autonomous session cycling system: configuration, presets,
 * per-cycle metrics, aggregate health scoring, and adaptive timing.
 *
 * Key exports:
 * - RespawnConfig — full respawn settings (idle timeout, AI checks, adaptive timing, skip-clear)
 * - PersistedRespawnConfig — subset saved to disk for mux session recovery
 * - RespawnPreset — named preset for quick setup (solo-work, team-lead, overnight-autonomous, etc.)
 * - RespawnCycleMetrics — per-cycle outcome tracking (duration, idle reason, steps, tokens)
 * - RespawnAggregateMetrics — aggregate stats across cycles (success rate, p90 duration)
 * - RalphLoopHealthScore — composite 0-100 health score with 5 component scores
 * - HealthStatus — 'excellent' | 'good' | 'degraded' | 'critical'
 * - TimingHistory — rolling window of timing data for adaptive adjustments
 * - CycleOutcome — 'success' | 'stuck_recovery' | 'blocked' | 'error' | 'cancelled'
 *
 * Cross-domain relationships:
 * - RespawnConfig is embedded in AppConfig.respawn (app-state) and SessionState.respawnConfig (session)
 * - RalphLoopHealthScore.components.circuitBreaker derives from CircuitBreakerStatus (ralph domain)
 * - RespawnCycleMetrics.sessionId links to SessionState.id (session domain)
 *
 * Served at `GET /api/sessions/:id/respawn` (config + state).
 */

/**
 * Configuration for the Respawn Controller
 *
 * The respawn controller keeps interactive sessions productive by
 * automatically cycling through update prompts when Claude goes idle.
 */
export interface RespawnConfig {
  /** How long to wait after seeing prompt before considering truly idle (ms) */
  idleTimeoutMs: number;
  /** The prompt to send for updating docs */
  updatePrompt: string;
  /** Delay between sending steps (ms) */
  interStepDelayMs: number;
  /** Whether to enable respawn loop */
  enabled: boolean;
  /** Whether to send /clear after update prompt */
  sendClear: boolean;
  /** Whether to send /init after /clear */
  sendInit: boolean;
  /** Optional prompt to send if /init doesn't trigger work */
  kickstartPrompt?: string;
  /** Time to wait after completion message before confirming idle (ms) */
  completionConfirmMs?: number;
  /** Fallback timeout when no output received at all (ms) */
  noOutputTimeoutMs?: number;
  /** Whether to auto-accept plan mode prompts by pressing Enter (not questions) */
  autoAcceptPrompts?: boolean;
  /** Delay before auto-accepting plan mode prompts when no output and no completion message (ms) */
  autoAcceptDelayMs?: number;
  /** Whether AI idle check is enabled */
  aiIdleCheckEnabled?: boolean;
  /** Model to use for AI idle check */
  aiIdleCheckModel?: string;
  /** Maximum characters of terminal buffer for AI check */
  aiIdleCheckMaxContext?: number;
  /** Timeout for AI check in ms */
  aiIdleCheckTimeoutMs?: number;
  /** Cooldown after WORKING verdict in ms */
  aiIdleCheckCooldownMs?: number;
  /** Whether AI plan mode check is enabled for auto-accept */
  aiPlanCheckEnabled?: boolean;
  /** Model to use for AI plan mode check */
  aiPlanCheckModel?: string;
  /** Maximum characters of terminal buffer for plan check */
  aiPlanCheckMaxContext?: number;
  /** Timeout for AI plan check in ms */
  aiPlanCheckTimeoutMs?: number;
  /** Cooldown after NOT_PLAN_MODE verdict in ms */
  aiPlanCheckCooldownMs?: number;

  // ========== P2-001: Adaptive Timing ==========

  /** Whether to use adaptive timing based on historical patterns */
  adaptiveTimingEnabled?: boolean;
  /** Minimum value for adaptive completion confirm (ms) */
  adaptiveMinConfirmMs?: number;
  /** Maximum value for adaptive completion confirm (ms) */
  adaptiveMaxConfirmMs?: number;

  // ========== P2-002: Skip-Clear Optimization ==========

  /** Whether to skip /clear when context is below threshold */
  skipClearWhenLowContext?: boolean;
  /** Token percentage threshold below which /clear is skipped (0-100) */
  skipClearThresholdPercent?: number;

  // ========== P2-004: Cycle Metrics ==========

  /** Whether to track and persist cycle metrics */
  trackCycleMetrics?: boolean;
}

// ========== P2-004: Respawn Cycle Metrics ==========

/**
 * Outcome of a respawn cycle
 */
export type CycleOutcome =
  | 'success' // Cycle completed normally
  | 'stuck_recovery' // Stuck-state recovery triggered
  | 'blocked' // Blocked by circuit breaker or exit signal
  | 'error' // Error during cycle
  | 'cancelled'; // Cancelled (e.g., controller stopped)

/**
 * Metrics for a single respawn cycle.
 * Persisted for post-mortem analysis of long-running loops.
 */
export interface RespawnCycleMetrics {
  /** Unique cycle ID (session-id:cycle-number) */
  cycleId: string;
  /** Session ID this cycle belongs to */
  sessionId: string;
  /** Cycle number within the session */
  cycleNumber: number;
  /** Timestamp when cycle started */
  startedAt: number;
  /** Timestamp when cycle completed */
  completedAt: number;
  /** Total duration of cycle (ms) */
  durationMs: number;
  /** What triggered idle detection */
  idleReason: string;
  /** Time spent detecting idle (from start of watching to idle confirmed) */
  idleDetectionMs: number;
  /** Steps completed in this cycle */
  stepsCompleted: string[];
  /** Whether /clear was skipped (P2-002) */
  clearSkipped: boolean;
  /** Outcome of the cycle */
  outcome: CycleOutcome;
  /** Error message if outcome is 'error' */
  errorMessage?: string;
  /** Token count at start of cycle */
  tokenCountAtStart?: number;
  /** Token count at end of cycle */
  tokenCountAtEnd?: number;
  /** Completion confirm time used (may be adaptive) */
  completionConfirmMsUsed: number;
}

/**
 * Aggregate metrics across multiple cycles for health scoring.
 */
export interface RespawnAggregateMetrics {
  /** Total cycles tracked */
  totalCycles: number;
  /** Successful cycles */
  successfulCycles: number;
  /** Cycles that required stuck-state recovery */
  stuckRecoveryCycles: number;
  /** Blocked cycles */
  blockedCycles: number;
  /** Error cycles */
  errorCycles: number;
  /** Average cycle duration (ms) */
  avgCycleDurationMs: number;
  /** Average idle detection time (ms) */
  avgIdleDetectionMs: number;
  /** 90th percentile cycle duration (ms) */
  p90CycleDurationMs: number;
  /** Success rate (0-100) */
  successRate: number;
  /** Last updated timestamp */
  lastUpdatedAt: number;
}

// ========== P2-005: Ralph Loop Health Score ==========

/**
 * Health status levels for the Ralph Loop system.
 */
export type HealthStatus = 'excellent' | 'good' | 'degraded' | 'critical';

/**
 * Comprehensive health score for a Ralph Loop session.
 * Aggregates multiple health signals into a single score.
 */
export interface RalphLoopHealthScore {
  /** Overall health score (0-100) */
  score: number;
  /** Health status based on score thresholds */
  status: HealthStatus;
  /** Individual component scores (0-100 each) */
  components: {
    /** Based on recent cycle success rate */
    cycleSuccess: number;
    /** Based on circuit breaker state */
    circuitBreaker: number;
    /** Based on iteration stall metrics */
    iterationProgress: number;
    /** Based on AI checker error rate */
    aiChecker: number;
    /** Based on stuck-state recovery count */
    stuckRecovery: number;
  };
  /** Human-readable summary of health */
  summary: string;
  /** Recommendations for improvement */
  recommendations: string[];
  /** Timestamp when score was calculated */
  calculatedAt: number;
}

// ========== Timing History for Adaptive Timing ==========

/**
 * Historical timing data for adaptive adjustments.
 */
export interface TimingHistory {
  /** Rolling window of recent idle detection durations (ms) */
  recentIdleDetectionMs: number[];
  /** Rolling window of recent cycle durations (ms) */
  recentCycleDurationMs: number[];
  /** Calculated adaptive completion confirm value (ms) */
  adaptiveCompletionConfirmMs: number;
  /** Number of samples in rolling windows */
  sampleCount: number;
  /** Maximum samples to keep */
  maxSamples: number;
  /** Last updated timestamp */
  lastUpdatedAt: number;
}

/**
 * Named respawn configuration preset for quick setup
 */
export interface RespawnPreset {
  /** Unique preset identifier */
  id: string;
  /** User-friendly preset name */
  name: string;
  /** Description of when to use this preset */
  description?: string;
  /** The respawn configuration (without enabled flag) */
  config: Omit<RespawnConfig, 'enabled'>;
  /** Duration in minutes (optional default) */
  durationMinutes?: number;
  /** Whether this is a built-in preset */
  builtIn?: boolean;
  /** Timestamp when created */
  createdAt: number;
}

/**
 * Persisted respawn configuration for mux sessions.
 * Subset of RespawnConfig that gets saved to disk.
 */
export interface PersistedRespawnConfig {
  /** Whether respawn was enabled */
  enabled: boolean;
  /** How long to wait after seeing prompt before considering truly idle (ms) */
  idleTimeoutMs: number;
  /** The prompt to send for updating docs */
  updatePrompt: string;
  /** Delay between sending steps (ms) */
  interStepDelayMs: number;
  /** Whether to send /clear after update prompt */
  sendClear: boolean;
  /** Whether to send /init after /clear */
  sendInit: boolean;
  /** Optional prompt to send if /init doesn't trigger work */
  kickstartPrompt?: string;
  /** Whether to auto-accept plan mode prompts by pressing Enter (not questions) */
  autoAcceptPrompts?: boolean;
  /** Delay before auto-accepting prompts (ms) */
  autoAcceptDelayMs?: number;
  /** Time to wait after completion message before confirming idle (ms) */
  completionConfirmMs?: number;
  /** Fallback timeout when no output received at all (ms) */
  noOutputTimeoutMs?: number;
  /** Whether AI idle check is enabled */
  aiIdleCheckEnabled?: boolean;
  /** Model to use for AI idle check */
  aiIdleCheckModel?: string;
  /** Maximum characters of terminal buffer for AI check */
  aiIdleCheckMaxContext?: number;
  /** Timeout for AI check in ms */
  aiIdleCheckTimeoutMs?: number;
  /** Cooldown after WORKING verdict in ms */
  aiIdleCheckCooldownMs?: number;
  /** Whether AI plan mode check is enabled for auto-accept */
  aiPlanCheckEnabled?: boolean;
  /** Model to use for AI plan mode check */
  aiPlanCheckModel?: string;
  /** Maximum characters of terminal buffer for plan check */
  aiPlanCheckMaxContext?: number;
  /** Timeout for AI plan check in ms */
  aiPlanCheckTimeoutMs?: number;
  /** Cooldown after NOT_PLAN_MODE verdict in ms */
  aiPlanCheckCooldownMs?: number;
  /** Duration in minutes if timed respawn was set */
  durationMinutes?: number;
}
