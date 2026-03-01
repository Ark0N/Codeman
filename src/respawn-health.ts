/**
 * @fileoverview Pure health scoring functions for respawn controller.
 *
 * Extracted from respawn-controller.ts for modularity. All functions are pure
 * (no side effects, no state) and take a HealthInputs interface that decouples
 * them from direct access to Session, RalphTracker, or AiChecker instances.
 *
 * @module respawn-health
 */

import type { RespawnAggregateMetrics, RalphLoopHealthScore, HealthStatus, CircuitBreakerStatus } from './types.js';

/**
 * Input data for health score calculation.
 * Decouples the health calculation from direct access to controller internals.
 */
export interface HealthInputs {
  /** Aggregate cycle metrics */
  aggregateMetrics: RespawnAggregateMetrics;
  /** Current circuit breaker status */
  circuitBreakerStatus: CircuitBreakerStatus | null;
  /** Iteration stall metrics, or null if tracker unavailable */
  iterationStallMetrics: {
    stallDurationMs: number;
    warningThresholdMs: number;
    criticalThresholdMs: number;
  } | null;
  /** AI checker state summary */
  aiCheckerState: {
    status: string;
    consecutiveErrors: number;
  };
  /** Number of stuck-state recovery attempts */
  stuckRecoveryCount: number;
  /** Maximum allowed stuck recoveries */
  maxStuckRecoveries: number;
}

/**
 * Calculate a comprehensive health score for the Ralph Loop system.
 * Aggregates multiple health signals into a single score (0-100).
 *
 * @param inputs - Health calculation inputs
 * @returns Health score with component breakdown
 */
export function calculateHealthScore(inputs: HealthInputs): RalphLoopHealthScore {
  const now = Date.now();
  const components = {
    cycleSuccess: calculateCycleSuccessScore(inputs.aggregateMetrics),
    circuitBreaker: calculateCircuitBreakerScore(inputs.circuitBreakerStatus),
    iterationProgress: calculateIterationProgressScore(inputs.iterationStallMetrics),
    aiChecker: calculateAiCheckerScore(inputs.aiCheckerState),
    stuckRecovery: calculateStuckRecoveryScore(inputs.stuckRecoveryCount, inputs.maxStuckRecoveries),
  };

  // Weighted average (cycle success is most important)
  const weights = {
    cycleSuccess: 0.35,
    circuitBreaker: 0.2,
    iterationProgress: 0.2,
    aiChecker: 0.15,
    stuckRecovery: 0.1,
  };

  const score = Math.round(
    components.cycleSuccess * weights.cycleSuccess +
      components.circuitBreaker * weights.circuitBreaker +
      components.iterationProgress * weights.iterationProgress +
      components.aiChecker * weights.aiChecker +
      components.stuckRecovery * weights.stuckRecovery
  );

  // Determine status
  let status: HealthStatus;
  if (score >= 90) status = 'excellent';
  else if (score >= 70) status = 'good';
  else if (score >= 50) status = 'degraded';
  else status = 'critical';

  // Generate recommendations
  const recommendations = generateHealthRecommendations(components);

  // Generate summary
  const summary = generateHealthSummary(score, status, components);

  return {
    score,
    status,
    components,
    summary,
    recommendations,
    calculatedAt: now,
  };
}

/**
 * Determine whether to skip the /clear step based on current context usage.
 * Skips if token count is below the configured threshold percentage.
 *
 * @param lastTokenCount - Current token count from the session
 * @param skipClearThresholdPercent - Threshold percentage below which to skip /clear
 * @param maxContextTokens - Approximate max context window size
 * @returns True if /clear should be skipped
 */
export function shouldSkipClear(
  lastTokenCount: number,
  skipClearThresholdPercent: number,
  maxContextTokens: number
): boolean {
  if (lastTokenCount === 0) return false; // Can't determine, don't skip

  const usagePercent = (lastTokenCount / maxContextTokens) * 100;
  return usagePercent < skipClearThresholdPercent;
}

/**
 * Calculate score based on recent cycle success rate.
 */
function calculateCycleSuccessScore(aggregateMetrics: RespawnAggregateMetrics): number {
  if (aggregateMetrics.totalCycles === 0) return 100; // No data = assume healthy
  return aggregateMetrics.successRate;
}

/**
 * Calculate score based on circuit breaker state.
 */
function calculateCircuitBreakerScore(circuitBreakerStatus: CircuitBreakerStatus | null): number {
  if (!circuitBreakerStatus) return 100;

  switch (circuitBreakerStatus.state) {
    case 'CLOSED':
      return 100;
    case 'HALF_OPEN':
      return 50;
    case 'OPEN':
      return 0;
    default:
      return 100;
  }
}

/**
 * Calculate score based on iteration progress.
 */
function calculateIterationProgressScore(
  stallMetrics: { stallDurationMs: number; warningThresholdMs: number; criticalThresholdMs: number } | null
): number {
  if (!stallMetrics) return 100;

  const { stallDurationMs, warningThresholdMs, criticalThresholdMs } = stallMetrics;

  if (stallDurationMs >= criticalThresholdMs) return 0;
  if (stallDurationMs >= warningThresholdMs) return 30;
  if (stallDurationMs >= warningThresholdMs / 2) return 70;
  return 100;
}

/**
 * Calculate score based on AI checker health.
 */
function calculateAiCheckerScore(aiCheckerState: { status: string; consecutiveErrors: number }): number {
  if (aiCheckerState.status === 'disabled') return 30;
  if (aiCheckerState.status === 'cooldown') return 70;
  if (aiCheckerState.consecutiveErrors > 0) return 50;
  return 100;
}

/**
 * Calculate score based on stuck-state recovery count.
 */
function calculateStuckRecoveryScore(stuckRecoveryCount: number, maxStuckRecoveries: number): number {
  if (stuckRecoveryCount === 0) return 100;
  if (stuckRecoveryCount >= maxStuckRecoveries) return 0;
  return Math.round(100 - (stuckRecoveryCount / maxStuckRecoveries) * 100);
}

/**
 * Generate health recommendations based on component scores.
 */
function generateHealthRecommendations(components: RalphLoopHealthScore['components']): string[] {
  const recommendations: string[] = [];

  if (components.cycleSuccess < 70) {
    recommendations.push('Cycle success rate is low. Check for recurring errors or stuck states.');
  }
  if (components.circuitBreaker < 50) {
    recommendations.push('Circuit breaker is open or half-open. Review recent errors and consider manual reset.');
  }
  if (components.iterationProgress < 50) {
    recommendations.push('Iteration progress has stalled. Check if Claude is stuck on a task.');
  }
  if (components.aiChecker < 50) {
    recommendations.push('AI idle checker has errors. May need to check Claude CLI availability.');
  }
  if (components.stuckRecovery < 50) {
    recommendations.push('Multiple stuck-state recoveries occurred. Consider increasing timeouts.');
  }

  if (recommendations.length === 0) {
    recommendations.push('System is healthy. No action needed.');
  }

  return recommendations;
}

/**
 * Generate a human-readable health summary.
 */
function generateHealthSummary(
  score: number,
  status: HealthStatus,
  components: RalphLoopHealthScore['components']
): string {
  const lowest = Object.entries(components).reduce((min, [key, val]) => (val < min.val ? { key, val } : min), {
    key: '',
    val: 100,
  });

  if (status === 'excellent') {
    return `Ralph Loop is operating excellently (${score}/100). All systems healthy.`;
  }
  if (status === 'good') {
    return `Ralph Loop is operating well (${score}/100). Minor issues in ${lowest.key}.`;
  }
  if (status === 'degraded') {
    return `Ralph Loop is degraded (${score}/100). Primary issue: ${lowest.key} (${lowest.val}/100).`;
  }
  return `Ralph Loop is in critical state (${score}/100). Immediate attention needed: ${lowest.key}.`;
}
