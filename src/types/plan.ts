/**
 * @fileoverview Plan orchestrator type definitions.
 *
 * Types for the 2-agent plan generation system (optional research agent → planner agent).
 *
 * Key exports:
 * - PlanItem — a single task with priority (P0/P1/P2), TDD phase, dependencies, verification criteria
 * - PlanTaskStatus — 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked'
 * - TddPhase / PlanPhase — 'setup' | 'test' | 'impl' | 'verify' | 'review'
 *
 * Used by PlanOrchestrator (`src/plan-orchestrator.ts`) and the plan API routes
 * (`src/web/routes/plan-routes.ts`). Served at `GET /api/sessions/:id/plan/tasks`.
 *
 * PlanItem was moved here from plan-orchestrator.ts to break a circular dependency.
 * No dependencies on other domain modules.
 */

/** Task execution status for plan tracking */
export type PlanTaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked';

/** TDD phase categories */
export type TddPhase = 'setup' | 'test' | 'impl' | 'verify' | 'review';

/** Development phase in TDD cycle (alias for TddPhase) */
export type PlanPhase = TddPhase;

/**
 * A single plan item for plan orchestration.
 * Moved here from plan-orchestrator.ts to break circular dependency.
 */
export interface PlanItem {
  id?: string;
  content: string;
  priority: 'P0' | 'P1' | 'P2' | null;
  source?: string;
  rationale?: string;
  verificationCriteria?: string;
  testCommand?: string;
  dependencies?: string[];
  status?: PlanTaskStatus;
  attempts?: number;
  lastError?: string;
  completedAt?: number;
  complexity?: 'low' | 'medium' | 'high';
  tddPhase?: PlanPhase;
  pairedWith?: string;
  reviewChecklist?: string[];
}
