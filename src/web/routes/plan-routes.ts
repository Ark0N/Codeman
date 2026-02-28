/**
 * @fileoverview Plan generation and management routes.
 * Covers AI-powered plan generation (simple + detailed orchestration),
 * plan task CRUD, checkpoints, version history, and rollback.
 */

import { FastifyInstance } from 'fastify';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { Session } from '../../session.js';
import { ApiErrorCode, createErrorResponse, getErrorMessage, type ApiResponse } from '../../types.js';
import { PlanOrchestrator, type PlanItem, type DetailedPlanResult } from '../../plan-orchestrator.js';
import {
  GeneratePlanSchema,
  GeneratePlanDetailedSchema,
  CancelPlanSchema,
  PlanTaskUpdateSchema,
  PlanTaskAddSchema,
} from '../schemas.js';
import { findSessionOrFail } from '../route-helpers.js';
import type { SessionPort, EventPort, ConfigPort, InfraPort } from '../ports/index.js';

export function registerPlanRoutes(app: FastifyInstance, ctx: SessionPort & EventPort & ConfigPort & InfraPort): void {
  // ============ Plan Generation Endpoints ============

  app.post('/api/generate-plan', async (req): Promise<ApiResponse> => {
    const gpResult = GeneratePlanSchema.safeParse(req.body);
    if (!gpResult.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body');
    }
    const { taskDescription, detailLevel = 'standard' } = gpResult.data;

    // Build sophisticated prompt based on Ralph Wiggum methodology
    const detailConfig = {
      brief: { style: 'high-level milestones', testDepth: 'basic' },
      standard: { style: 'balanced implementation steps', testDepth: 'thorough' },
      detailed: {
        style: 'granular sub-tasks with full TDD coverage',
        testDepth: 'comprehensive',
      },
    };
    const levelConfig = detailConfig[detailLevel] || detailConfig.standard;

    const prompt = `You are an expert software architect breaking down a task into a thorough implementation plan.

## TASK TO IMPLEMENT
${taskDescription}

## YOUR MISSION
Create a detailed, actionable implementation plan following Test-Driven Development (TDD) methodology.
Think deeply about:
- What are ALL the components, modules, and features needed?
- What could go wrong? Add defensive steps for error handling.
- How will we verify each part works? Tests before implementation.
- What edge cases need handling?
- What's the logical order of dependencies?

## DETAIL LEVEL: ${detailLevel.toUpperCase()}
Style: ${levelConfig.style}
Generate as many steps as needed to properly cover the task - don't artificially limit yourself.
For complex projects, this could be 30, 50, or even 100+ steps. Quality over brevity.

## PLAN STRUCTURE

Your plan MUST include these phases in order:

### Phase 1: Foundation & Setup
- Project structure, dependencies, configuration
- Database schemas, type definitions, interfaces

### Phase 2: Core Implementation (TDD Cycle)
For EACH feature:
1. Write failing tests first (unit tests)
2. Implement the feature
3. Run tests, debug until passing
4. Refactor if needed

### Phase 3: Integration & Edge Cases
- Integration tests for feature interactions
- Edge case handling (errors, boundaries, invalid input)
- Error messages and user feedback

### Phase 4: Verification & Hardening
- Run full test suite
- Fix any failing tests
- Add missing test coverage
- Final verification that ALL requirements are met

## OUTPUT FORMAT
Return ONLY a JSON array. Each item MUST have:
- id: unique identifier (e.g., "P0-001", "P1-002")
- content: specific action (verb phrase, 15-120 chars, be descriptive!)
- priority: "P0" (critical/blocking), "P1" (required), "P2" (enhancement)
- verificationCriteria: HOW to verify this step is complete (required!)
- tddPhase: "setup" | "test" | "impl" | "verify"
- dependencies: array of task IDs this depends on (empty if none)

## EXAMPLE OUTPUT
[
  {"id": "P0-001", "content": "Create project structure with src/, tests/, and config directories", "priority": "P0", "verificationCriteria": "Directories exist, package.json initialized", "tddPhase": "setup", "dependencies": []},
  {"id": "P0-002", "content": "Define TypeScript interfaces for User, Session, and AuthToken types", "priority": "P0", "verificationCriteria": "Types compile without errors, exported from types.ts", "tddPhase": "setup", "dependencies": ["P0-001"]},
  {"id": "P0-003", "content": "Write failing unit tests for password hashing (valid password, empty, too short)", "priority": "P0", "verificationCriteria": "Tests exist, fail with 'not implemented'", "tddPhase": "test", "dependencies": ["P0-002"]},
  {"id": "P0-004", "content": "Implement password hashing with bcrypt, configurable salt rounds", "priority": "P0", "verificationCriteria": "npm test -- --grep='password' passes", "tddPhase": "impl", "dependencies": ["P0-003"]},
  {"id": "P0-005", "content": "Write failing tests for JWT token generation and validation", "priority": "P0", "verificationCriteria": "Tests exist, fail with 'not implemented'", "tddPhase": "test", "dependencies": ["P0-004"]},
  {"id": "P0-006", "content": "Implement JWT service with access/refresh token support", "priority": "P0", "verificationCriteria": "npm test -- --grep='JWT' passes", "tddPhase": "impl", "dependencies": ["P0-005"]},
  {"id": "P1-001", "content": "Write integration tests for login flow (valid creds, invalid, locked account)", "priority": "P1", "verificationCriteria": "Integration tests exist, fail until endpoint implemented", "tddPhase": "test", "dependencies": ["P0-006"]},
  {"id": "P1-002", "content": "Implement login endpoint with rate limiting and audit logging", "priority": "P1", "verificationCriteria": "All login tests pass, endpoint returns 200/401 correctly", "tddPhase": "impl", "dependencies": ["P1-001"]},
  {"id": "P1-003", "content": "Run full test suite and verify all tests pass", "priority": "P1", "verificationCriteria": "npm test exits with code 0, coverage > 80%", "tddPhase": "verify", "dependencies": ["P1-002"]}
]

## CRITICAL RULES
1. EVERY task MUST have verificationCriteria - this is non-negotiable!
2. EVERY implementation step should have a corresponding test step BEFORE it
3. Use tddPhase: "test" for writing tests, "impl" for implementation
4. Dependencies must form a valid DAG - no cycles
5. Be SPECIFIC - not "Add tests" but "Write tests for X covering Y and Z"
6. End with verification that ALL original requirements are met
7. Use P0 for foundation and core features, P1 for required work, P2 for nice-to-have

NOW: Generate the implementation plan for the task above. Think step by step.`;

    // Create temporary session for the AI call using Opus 4.5 for deep reasoning
    const session = new Session({
      workingDir: process.cwd(),
      mux: ctx.mux,
      useMux: false, // No mux needed for one-shot
      mode: 'claude',
    });

    // Use configured model for plan generation, falling back to opus
    const planModelConfig = await ctx.getModelConfig();
    const modelToUse = planModelConfig?.agentTypeOverrides?.implement || planModelConfig?.defaultModel || 'opus';

    try {
      const { result, cost } = await session.runPrompt(prompt, { model: modelToUse });

      // Parse JSON from result
      const jsonMatch = result.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Failed to parse plan - no JSON array found');
      }

      let items: PlanItem[];
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(parsed)) {
          return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Invalid response - expected array');
        }

        // Validate and normalize items with enhanced fields
        items = parsed.map((item: unknown, idx: number) => {
          if (typeof item !== 'object' || item === null) {
            return {
              id: `task-${idx}`,
              content: `Step ${idx + 1}`,
              priority: null,
              verificationCriteria: 'Task completed successfully',
              status: 'pending' as const,
              attempts: 0,
              version: 1,
            };
          }
          const obj = item as Record<string, unknown>;
          const content = typeof obj.content === 'string' ? obj.content.slice(0, 200) : `Step ${idx + 1}`;
          let priority: 'P0' | 'P1' | 'P2' | null = null;
          if (obj.priority === 'P0' || obj.priority === 'P1' || obj.priority === 'P2') {
            priority = obj.priority;
          }

          // Parse tddPhase
          let tddPhase: 'setup' | 'test' | 'impl' | 'verify' | undefined;
          if (
            obj.tddPhase === 'setup' ||
            obj.tddPhase === 'test' ||
            obj.tddPhase === 'impl' ||
            obj.tddPhase === 'verify'
          ) {
            tddPhase = obj.tddPhase;
          }

          return {
            id: obj.id ? String(obj.id) : `task-${idx}`,
            content,
            priority,
            verificationCriteria:
              typeof obj.verificationCriteria === 'string' ? obj.verificationCriteria : 'Task completed successfully',
            tddPhase,
            dependencies: Array.isArray(obj.dependencies) ? obj.dependencies.map(String) : [],
            status: 'pending' as const,
            attempts: 0,
            version: 1,
          };
        });
        // No artificial limit - let Claude generate what's needed
      } catch (parseErr) {
        return createErrorResponse(
          ApiErrorCode.OPERATION_FAILED,
          'Failed to parse plan JSON: ' + getErrorMessage(parseErr)
        );
      }

      return {
        success: true,
        data: { items, costUsd: cost },
      };
    } catch (err) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Plan generation failed: ' + getErrorMessage(err));
    } finally {
      // Clean up the temporary session
      try {
        await session.stop();
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  // Generate detailed implementation plan using subagent orchestration
  // This spawns multiple specialist subagents in parallel for thorough analysis
  app.post('/api/generate-plan-detailed', async (req): Promise<ApiResponse> => {
    const gpdResult = GeneratePlanDetailedSchema.safeParse(req.body);
    if (!gpdResult.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body');
    }
    const { taskDescription, caseName } = gpdResult.data;

    // Determine output directory for saving wizard results
    let outputDir: string | undefined;
    if (caseName) {
      const casesDir = join(homedir(), 'codeman-cases');
      const casePath = join(casesDir, caseName);
      // Security: Path traversal protection - use relative path check
      const resolvedCase = resolve(casePath);
      const resolvedBase = resolve(casesDir);
      const relPath = relative(resolvedBase, resolvedCase);
      if (!relPath.startsWith('..') && !isAbsolute(relPath) && existsSync(casePath)) {
        outputDir = join(casePath, 'ralph-wizard');

        // Clear old ralph-wizard directory to ensure fresh prompts for each generation
        // This prevents stale prompts from previous runs being shown when clicking on agents
        if (existsSync(outputDir)) {
          try {
            rmSync(outputDir, { recursive: true, force: true });
            console.log(`[API] Cleared old ralph-wizard directory: ${outputDir}`);
          } catch (err) {
            console.warn(`[API] Failed to clear ralph-wizard directory:`, err);
          }
        }
      }
    }

    const detailedModelConfig = await ctx.getModelConfig();
    const orchestrator = new PlanOrchestrator(ctx.mux, process.cwd(), outputDir, detailedModelConfig ?? undefined);

    // Store orchestrator for potential cancellation via API (not on disconnect)
    // Plan generation continues even if browser disconnects - only explicit cancel stops it
    const orchestratorId = `plan-${Date.now()}`;
    ctx.activePlanOrchestrators.set(orchestratorId, orchestrator);

    // Broadcast the orchestrator ID so frontend can cancel if needed
    ctx.broadcast('plan:started', { orchestratorId });

    // Track progress for SSE updates
    const progressUpdates: Array<{ phase: string; detail: string; timestamp: number }> = [];
    const onProgress = (phase: string, detail: string) => {
      const update = { phase, detail, timestamp: Date.now() };
      progressUpdates.push(update);
      // Broadcast progress to connected clients
      ctx.broadcast('plan:progress', update);
    };

    // Broadcast plan subagent events for UI visibility
    const onSubagent = (event: {
      type: string;
      agentId: string;
      agentType: string;
      model: string;
      status: string;
      detail?: string;
      itemCount?: number;
      durationMs?: number;
      error?: string;
    }) => {
      ctx.broadcast('plan:subagent', event);
    };

    try {
      const result: DetailedPlanResult = await orchestrator.generateDetailedPlan(
        taskDescription,
        onProgress,
        onSubagent
      );

      // Clean up orchestrator from active map
      ctx.activePlanOrchestrators.delete(orchestratorId);
      ctx.broadcast('plan:completed', { orchestratorId, success: result.success });

      if (!result.success) {
        return createErrorResponse(ApiErrorCode.OPERATION_FAILED, result.error || 'Plan generation failed');
      }

      return {
        success: true,
        data: {
          items: result.items,
          costUsd: result.costUsd,
          metadata: result.metadata,
          progressLog: progressUpdates,
          orchestratorId,
        },
      };
    } catch (err) {
      // Clean up on error too
      ctx.activePlanOrchestrators.delete(orchestratorId);
      ctx.broadcast('plan:completed', {
        orchestratorId,
        success: false,
        error: getErrorMessage(err),
      });
      return createErrorResponse(
        ApiErrorCode.OPERATION_FAILED,
        'Detailed plan generation failed: ' + getErrorMessage(err)
      );
    }
  });

  // Cancel active plan generation
  app.post('/api/cancel-plan-generation', async (req): Promise<ApiResponse> => {
    const cpResult = CancelPlanSchema.safeParse(req.body);
    if (!cpResult.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body');
    }
    const { orchestratorId } = cpResult.data;

    // If specific orchestrator ID provided, cancel just that one
    if (orchestratorId) {
      const orchestrator = ctx.activePlanOrchestrators.get(orchestratorId);
      if (!orchestrator) {
        return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Plan generation not found or already completed');
      }
      console.log(`[API] Cancelling plan generation ${orchestratorId}`);
      await orchestrator.cancel();
      ctx.activePlanOrchestrators.delete(orchestratorId);
      ctx.broadcast('plan:cancelled', { orchestratorId });
      return { success: true, data: { cancelled: orchestratorId } };
    }

    // Otherwise cancel all active plan generations
    const cancelled: string[] = [];
    for (const [id, orchestrator] of ctx.activePlanOrchestrators) {
      console.log(`[API] Cancelling plan generation ${id}`);
      await orchestrator.cancel();
      cancelled.push(id);
      ctx.broadcast('plan:cancelled', { orchestratorId: id });
    }
    ctx.activePlanOrchestrators.clear();

    return { success: true, data: { cancelled } };
  });

  // ============ Plan Management Endpoints ============
  // These endpoints support runtime plan adaptation with checkpoints, failure tracking, and versioning

  // Update a specific plan task (status, attempts, errors)
  app.patch('/api/sessions/:id/plan/task/:taskId', async (req) => {
    const { id, taskId } = req.params as { id: string; taskId: string };
    const session = findSessionOrFail(ctx, id);

    const tracker = session.ralphTracker;
    if (!tracker) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Ralph tracker not available');
    }

    const ptuResult = PlanTaskUpdateSchema.safeParse(req.body);
    if (!ptuResult.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body');
    }
    const update = ptuResult.data as {
      status?: 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked';
      error?: string;
      incrementAttempts?: boolean;
    };

    const result = tracker.updatePlanTask(taskId, update);
    if (!result.success) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, result.error || 'Task not found');
    }

    ctx.broadcast('session:planTaskUpdate', { sessionId: id, taskId, update: result.task });
    return { success: true, data: result.task };
  });

  // Trigger a checkpoint review (at iterations 5, 10, 20, etc.)
  app.post('/api/sessions/:id/plan/checkpoint', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);

    const tracker = session.ralphTracker;
    if (!tracker) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Ralph tracker not available');
    }

    const checkpoint = tracker.generateCheckpointReview();
    ctx.broadcast('session:planCheckpoint', { sessionId: id, checkpoint });
    return { success: true, data: checkpoint };
  });

  // Get plan version history
  app.get('/api/sessions/:id/plan/history', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);

    const tracker = session.ralphTracker;
    if (!tracker) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Ralph tracker not available');
    }

    return { success: true, data: tracker.getPlanHistory() };
  });

  // Rollback to a previous plan version
  app.post('/api/sessions/:id/plan/rollback/:version', async (req) => {
    const { id, version } = req.params as { id: string; version: string };
    const session = findSessionOrFail(ctx, id);

    const tracker = session.ralphTracker;
    if (!tracker) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Ralph tracker not available');
    }

    const result = tracker.rollbackToVersion(parseInt(version, 10));
    if (!result.success) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, result.error || 'Version not found');
    }

    ctx.broadcast('session:planRollback', { sessionId: id, version: parseInt(version, 10) });
    return { success: true, data: result.plan };
  });

  // Add a new task to the plan (for runtime adaptation)
  app.post('/api/sessions/:id/plan/task', async (req) => {
    const { id } = req.params as { id: string };
    const session = findSessionOrFail(ctx, id);

    const tracker = session.ralphTracker;
    if (!tracker) {
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, 'Ralph tracker not available');
    }

    const ptaResult = PlanTaskAddSchema.safeParse(req.body);
    if (!ptaResult.success) {
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, 'Invalid request body');
    }
    const task = ptaResult.data;

    const result = tracker.addPlanTask(task);
    ctx.broadcast('session:planTaskAdded', { sessionId: id, task: result.task });
    return { success: true, data: result.task };
  });
}
