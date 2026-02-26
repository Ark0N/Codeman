# Ralph Loop Plan Improvement Roadmap

> Research-backed improvements for rock-solid AI planning with auto-improvement capabilities.

**Created**: 2026-01-27
**Status**: Implementation in Progress

---

## Table of Contents

1. [Research Summary](#research-summary)
2. [Current State Analysis](#current-state-analysis)
3. [Proposed Improvements](#proposed-improvements)
4. [Implementation Plan](#implementation-plan)
5. [Sources](#sources)

---

## Research Summary

### Key Insights from Industry Best Practices

#### 1. Self-Verification is Critical
> "Claude performs dramatically better when it can verify its own work, like run tests, compare screenshots, and validate outputs. Without clear success criteria, it might produce something that looks right but actually doesn't work."
> — [Anthropic Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices)

#### 2. Iterative Refinement Patterns (AWS)
> "A generator agent produces output, an evaluator agent reviews using evaluation rubric, and based on feedback, an optimizer agent revises the output. Loop repeats until criteria met."
> — [AWS Agentic AI Patterns](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-patterns/evaluator-reflect-refine-loop-patterns.html)

#### 3. Dynamic Task Decomposition (TDAG Framework)
> "Dynamically decomposes complex tasks into smaller subtasks and assigns each to a specifically generated subagent, enhancing adaptability in diverse and unpredictable real-world tasks."
> — [TDAG Framework - arXiv](https://arxiv.org/abs/2402.10178)

#### 4. Multi-Stage Verification Workflow
> "o3: Generate plan → Sonnet: Verify and create task list → Sonnet: Execute → Sonnet: Verify against plan → o3: Final verification → Issues bake back into plan"
> — [Claude Code Best Practices Community](https://rosmur.github.io/claudecode-best-practices/)

#### 5. Self-Improving Agents
> "Through an iterative refinement process (analyze outcome → adjust approach → try again), the agent becomes more adept at handling tasks over time. It effectively builds a growing knowledge base of what strategies work best."
> — [Self-Improving Data Agents](https://powerdrill.ai/blog/self-improving-data-agents)

#### 6. Memory Architecture for Planning
> "Agents use three memory layers: working memory for short-lived calculations, episodic memory for step-by-step histories, and semantic memory for long-term knowledge."
> — [LLM Agent Research](https://www.promptingguide.ai/research/llm-agents)

---

## Current State Analysis

### What We Have

The current plan generation system (`/api/generate-plan` and `/api/generate-plan-detailed`):

1. **Standard Mode**: Single Opus 4.5 call with TDD-focused prompt
2. **Enhanced Mode**: 4 parallel subagents (Requirements, Architecture, Testing, Risks) + Verification

### Current Plan Item Structure

```json
{
  "content": "Implement login endpoint",
  "priority": "P0"
}
```

### Limitations

| Issue | Impact |
|-------|--------|
| No verification criteria | Can't automatically validate completion |
| No test pairing | TDD not enforced structurally |
| Static plans | No adaptation during execution |
| No dependencies | Can't track blocking relationships |
| No failure tracking | Same errors repeat |
| No checkpoints | Plans run until completion or failure |

---

## Proposed Improvements

### Enhanced Plan Item Structure

```typescript
interface EnhancedPlanItem {
  id: string;                          // Unique identifier (e.g., "P0-001")
  content: string;                     // Task description
  priority: 'P0' | 'P1' | 'P2';       // Criticality
  phase: 'setup' | 'test' | 'impl' | 'verify';  // Development phase

  // NEW: Verification
  verificationCriteria: string;        // How to know it's done
  testCommand?: string;                // Command to run for verification

  // NEW: Dependencies
  dependencies: string[];              // IDs of tasks that must complete first
  blockedBy?: string[];               // Runtime: tasks blocking this one

  // NEW: Execution tracking
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'blocked';
  attempts: number;                    // How many times attempted
  lastError?: string;                  // Most recent failure reason
  completedAt?: number;                // Timestamp of completion

  // NEW: Metadata
  estimatedComplexity: 'low' | 'medium' | 'high';
  rollbackStrategy?: string;           // How to undo if needed
  version: number;                     // Plan version this belongs to
}
```

### Runtime Plan Adaptation Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                    RUNTIME PLAN LOOP                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐    │
│  │ Execute  │──▶│ Verify   │──▶│ Success? │──▶│ Mark     │    │
│  │ Task     │   │ Output   │   │          │   │ Complete │    │
│  └──────────┘   └──────────┘   └────┬─────┘   └──────────┘    │
│                                     │ No                       │
│                                     ▼                          │
│                              ┌──────────┐                      │
│                              │ Analyze  │                      │
│                              │ Failure  │                      │
│                              └────┬─────┘                      │
│                                   │                            │
│                    ┌──────────────┼──────────────┐            │
│                    ▼              ▼              ▼            │
│             ┌──────────┐  ┌──────────┐  ┌──────────┐         │
│             │ Retry    │  │ Add Fix  │  │ Escalate │         │
│             │ (< 3x)   │  │ Sub-Task │  │ BLOCKED  │         │
│             └──────────┘  └──────────┘  └──────────┘         │
│                                                               │
└───────────────────────────────────────────────────────────────┘
```

### Checkpoint Review System

At iterations 5, 10, 20, 30, 50:
1. Pause execution
2. Summarize progress (completed/failed/pending)
3. Identify stuck items (3+ failures)
4. Generate alternative approaches for stuck items
5. Update plan with new strategies
6. Continue with refined plan

---

## Implementation Plan

### Phase 1: Quick Wins (Implementing Now)

#### 1.1 Add Verification Criteria to Plan Items
- Modify plan generation prompts to require `verificationCriteria`
- Update `PlanItem` interface in `types.ts`
- Update plan orchestrator prompts

#### 1.2 Pair Test/Implementation Steps
- Ensure every implementation step has a corresponding test step
- Group items: test → implement → verify
- Add phase field to track TDD cycle

#### 1.3 Checkpoint Review Prompts
- Add checkpoint logic to Ralph tracker
- At iterations 5, 10, 20: inject review prompt
- Generate progress summary and stuck item analysis

### Phase 2: Medium Effort (Implementing Now)

#### 2.1 Failure Tracking
- Track `attempts` and `lastError` per task
- After 3 failures, auto-generate debug sub-task
- Record failure patterns in plan history

#### 2.2 Plan Versioning
- Add `version` field to plans
- Keep history in `@fix_plan.md` with version markers
- Allow rollback to previous versions
- Track which version each task belongs to

#### 2.3 Dependency Tracking
- Add `dependencies` field to plan items
- Validate dependency graph (no cycles)
- Block tasks until dependencies complete
- Show dependency status in UI

### Phase 3: Future Enhancements

#### 3.1 Full Runtime Adaptation
- TDAG-style dynamic decomposition
- Auto-generate sub-tasks for complex items
- Learning from failure patterns

#### 3.2 Multi-Model Verification
- Haiku: Fast initial generation
- Sonnet: Verification and refinement
- Opus: Final quality check

#### 3.3 Plan Memory System
- Episodic memory: What worked/failed in this session
- Semantic memory: Patterns across projects
- Use for future plan generation

---

## File Changes Required

### New/Modified Files

| File | Changes |
|------|---------|
| `src/types.ts` | Add `EnhancedPlanItem` interface |
| `src/plan-orchestrator.ts` | Update prompts, add versioning |
| `src/ralph-tracker.ts` | Add checkpoint logic, failure tracking |
| `src/web/server.ts` | New endpoints for plan updates |
| `src/web/public/app.js` | UI for enhanced plan display |

### New Endpoints

| Method | Endpoint | Purpose |
|--------|----------|---------|
| PATCH | `/api/sessions/:id/plan/task/:taskId` | Update task status |
| POST | `/api/sessions/:id/plan/checkpoint` | Trigger checkpoint review |
| GET | `/api/sessions/:id/plan/history` | Get plan version history |
| POST | `/api/sessions/:id/plan/rollback/:version` | Rollback to version |

---

## Sources

- [Anthropic Claude Code Best Practices](https://www.anthropic.com/engineering/claude-code-best-practices)
- [AWS Agentic AI Patterns](https://docs.aws.amazon.com/prescriptive-guidance/latest/agentic-ai-patterns/evaluator-reflect-refine-loop-patterns.html)
- [TDAG: Multi-Agent Task Decomposition Framework](https://arxiv.org/abs/2402.10178)
- [Self-Improving Data Agents](https://powerdrill.ai/blog/self-improving-data-agents)
- [OpenAI Self-Evolving Agents Cookbook](https://cookbook.openai.com/examples/partners/self_evolving_agents/autonomous_agent_retraining)
- [Task Decomposition for Coding Agents](https://mgx.dev/insights/task-decomposition-for-coding-agents-architectures-advancements-and-future-directions/)
- [Claude Code Best Practices Community Guide](https://rosmur.github.io/claudecode-best-practices/)
- [LLM Agents Prompt Engineering Guide](https://www.promptingguide.ai/research/llm-agents)
- [Agentic AI Implementation Guide](https://www.sketchdev.io/blog/agentic-ai-implementation-guide)

---

*This document is part of the Codeman project. See [CLAUDE.md](../CLAUDE.md) for main documentation.*
