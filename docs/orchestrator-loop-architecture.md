# Orchestrator Loop — Architecture & Data Flow

> Technical architecture document. Not for GitHub.

## System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                          CODEMAN WEB UI                             │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Orchestrator Dashboard                                       │  │
│  │  [Goal Input] [Plan View] [Phase Progress] [Agent Activity]  │  │
│  └───────────────────────────┬──────────────────────────────────┘  │
│                               │ SSE Events                         │
│                               ▼                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Orchestrator API Routes (/api/orchestrator/*)                │  │
│  └───────────────────────────┬──────────────────────────────────┘  │
└───────────────────────────────┼─────────────────────────────────────┘
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      ORCHESTRATOR LOOP                               │
│                                                                      │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────────┐  │
│  │ Orchestrator │    │ Orchestrator │    │ Orchestrator         │  │
│  │ Planner      │    │ Loop (state  │    │ Verifier             │  │
│  │              │    │ machine)     │    │                      │  │
│  │ • Research   │◄──►│ • Phase mgmt │◄──►│ • Test runner        │  │
│  │ • Plan gen   │    │ • Task queue │    │ • AI review          │  │
│  │ • Phasing    │    │ • Event loop │    │ • Output checks      │  │
│  └──────┬───────┘    └──────┬───────┘    └──────────┬───────────┘  │
│         │                   │                       │              │
│         ▼                   ▼                       ▼              │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │              EXISTING CODEMAN INFRASTRUCTURE                  │  │
│  │                                                               │  │
│  │  SessionManager ←→ Sessions ←→ PTY (Claude CLI)              │  │
│  │       ↑                ↑              ↑                       │  │
│  │       │                │              │                       │  │
│  │  TaskQueue      RalphTracker    RespawnController             │  │
│  │  StateStore     HooksConfig     TeamWatcher                   │  │
│  │  Auto-Ops       SubagentWatcher SSE Broadcast                 │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## Data Flow: Complete Lifecycle

### 1. User Submits Goal

```
User → POST /api/orchestrator/start { goal: "Build a REST API...", config: {...} }
  → OrchestratorLoop.start(goal)
    → state = PLANNING
    → emit('stateChanged', 'planning')
    → SSE: orchestrator:stateChanged
```

### 2. Planning Phase

```
OrchestratorPlanner.generatePlan(goal)
  → PlanOrchestrator.generateDetailedPlan(goal)
    → [Research Agent] → enriched task description
    → [Planner Agent] → PlanItem[]
  → groupIntoPhases(planItems)
    → topological sort by dependencies
    → group into layers
    → assign team strategies
  → OrchestratorPlan { phases: [...] }
  → state = APPROVAL
  → emit('planReady', plan)
  → SSE: orchestrator:planReady
```

### 3. User Approves Plan

```
User → POST /api/orchestrator/approve
  → OrchestratorLoop.approvePlan()
    → state = EXECUTING
    → executePhase(phases[0])
```

### 4. Phase Execution

```
executePhase(phase)
  → For each task in phase:
    → Convert to CreateTaskOptions
    → Add to TaskQueue with completion phrase "PHASE_{N}_TASK_{M}_DONE"
  → If phase.teamStrategy.type === 'team':
    → Start session with AGENT_TEAMS enabled
    → Send team orchestration prompt to lead
  → Else:
    → Assign tasks to available sessions (same as RalphLoop)

  → Listen for task completion events:
    → TaskQueue emits taskCompleted
    → Check: all phase tasks done?
      → Yes → state = VERIFYING → verifyPhase(phase)
      → No → wait for more completions
```

### 5. Verification

```
verifyPhase(phase)
  → OrchestratorVerifier.verify(phase, session)
    → Run test commands via session
    → Check file existence
    → AI review (optional)
  → If passed:
    → phase.status = 'passed'
    → emit('phaseCompleted', phase)
    → If more phases: executePhase(nextPhase)
    → If last phase: state = COMPLETED
  → If failed:
    → phase.attempts++
    → If attempts < maxAttempts:
      → state = REPLANNING
      → Generate recovery tasks
      → state = EXECUTING (retry)
    → Else:
      → state = FAILED
      → emit('phaseFailed', phase, reason)
```

### 6. Context Management Between Phases

```
After phase completion:
  → If config.compactBetweenPhases:
    → session.sendInput('/compact')
    → Wait for compact to complete
  → If config.respawnBetweenMilestones && phase is a milestone:
    → Save orchestrator state to StateStore
    → Respawn session (kill + recreate)
    → Send resume prompt with phase context
```

## File Layout

```
src/
├── orchestrator-loop.ts          # Main state machine (~400 lines)
├── orchestrator-planner.ts       # Plan generation + phase grouping (~300 lines)
├── orchestrator-verifier.ts      # Phase verification (~200 lines)
├── types/
│   └── orchestrator.ts           # All orchestrator types (~150 lines)
├── prompts/
│   └── orchestrator.ts           # Prompt templates (~200 lines)
├── web/
│   ├── routes/
│   │   └── orchestrator-routes.ts  # API endpoints (~250 lines)
│   └── public/
│       └── orchestrator-ui.js    # Frontend panel (~500 lines)
```

## Integration Points with Existing Code

### StateStore (`src/state-store.ts`)
```typescript
// Add to AppState interface
orchestrator?: OrchestratorPersistState;

// Add methods
getOrchestratorState(): OrchestratorPersistState;
setOrchestratorState(state: Partial<OrchestratorPersistState>): void;
```

### SSE Events (`src/web/sse-events.ts`)
```typescript
// Add ~8 new events
export const SseEvent = {
  // ... existing
  ORCHESTRATOR_STATE_CHANGED: 'orchestrator:stateChanged',
  ORCHESTRATOR_PLAN_READY: 'orchestrator:planReady',
  ORCHESTRATOR_PHASE_STARTED: 'orchestrator:phaseStarted',
  ORCHESTRATOR_PHASE_COMPLETED: 'orchestrator:phaseCompleted',
  ORCHESTRATOR_PHASE_FAILED: 'orchestrator:phaseFailed',
  ORCHESTRATOR_VERIFICATION: 'orchestrator:verificationResult',
  ORCHESTRATOR_COMPLETED: 'orchestrator:completed',
  ORCHESTRATOR_ERROR: 'orchestrator:error',
} as const;
```

### Frontend Constants (`src/web/public/constants.js`)
```javascript
// Mirror SSE events
SSE_EVENTS.ORCHESTRATOR_STATE_CHANGED = 'orchestrator:stateChanged';
// ... etc
```

### Route Registration (`src/web/routes/index.ts`)
```typescript
import { registerOrchestratorRoutes } from './orchestrator-routes.js';
// Add to barrel export
```

### Server (`src/web/server.ts`)
```typescript
// Initialize OrchestratorLoop alongside RalphLoop
const orchestratorLoop = new OrchestratorLoop(config);

// Register routes
registerOrchestratorRoutes(app, { ...ctx, orchestrator: orchestratorLoop });
```

### Port Interface (`src/web/ports/`)
```typescript
// New port
export interface OrchestratorPort {
  orchestrator: OrchestratorLoop;
}
```

## Prompt Flow Through System

The key insight is how prompts flow from Orchestrator → Session → Claude:

```
OrchestratorLoop decides to execute Phase 3, Task 2
  │
  ▼
Converts OrchestratorTask to CreateTaskOptions:
  {
    prompt: "Implement the rate limiter middleware. Read src/middleware/auth.ts
             for the pattern. Add to src/middleware/rate-limiter.ts. Must export
             a Fastify plugin. When done: <promise>PHASE_3_TASK_2_DONE</promise>",
    priority: 100,
    dependencies: ["phase-3-task-1"],  // Must finish auth middleware first
    completionPhrase: "PHASE_3_TASK_2_DONE",
    timeoutMs: 600000  // 10 minutes
  }
  │
  ▼
TaskQueue.addTask(options)
  │
  ▼
RalphLoop.tick() → assignTasks()  // OR OrchestratorLoop does its own assignment
  │
  ▼
session.sendInput(task.prompt)
  │
  ▼
writeViaMux() → tmux paste-buffer -p (prompt as one bracketed paste) + Enter
  │
  ▼
Claude CLI receives prompt, executes, outputs results
  │
  ▼
RalphTracker.processData() → detects "PHASE_3_TASK_2_DONE"
  │
  ▼
emit('completionDetected') → OrchestratorLoop.handleTaskCompleted()
  │
  ▼
Check: all tasks in Phase 3 done? → If yes → verifyPhase(phase3)
```

## Team Agent Flow (When Enabled)

```
Phase has teamStrategy.type === 'team'
  │
  ▼
OrchestratorLoop creates/reuses a session with:
  env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' }
  │
  ▼
Sends team orchestration prompt:
  "You're the team lead for Phase 3: Core Implementation.

   Your team should work on these tasks in parallel:
   1. Rate limiter middleware (teammate 1)
   2. Error handling middleware (teammate 2)
   3. Validation layer (teammate 3)

   Context files to read first: [...]
   Each teammate should output their task's completion phrase when done.
   When ALL tasks are complete, output: <promise>PHASE_3_COMPLETE</promise>"
  │
  ▼
Claude Code team-lead spawns teammates
  │
  ▼
TeamWatcher detects new team in ~/.claude/teams/
  → Matches to session via leadSessionId
  → Tracks teammate activity
  │
  ▼
Teammates work in parallel (in-process threads)
  │
  ▼
hook: teammate_idle → POST /api/hook-event
  → OrchestratorLoop notes teammate finished
  │
  ▼
hook: task_completed → POST /api/hook-event
  → Or: RalphTracker detects PHASE_3_COMPLETE
  → OrchestratorLoop → phase complete → verify
```

## Error Recovery Strategy

```
Task fails (timeout, error, session crash)
  │
  ├─ Task-level retry (up to 2 retries per task)
  │   → Reset task to pending
  │   → Re-queue with modified prompt: "Previous attempt failed: {error}. Try again..."
  │
  ├─ Phase-level retry (up to 3 retries per phase)
  │   → Respawn session (fresh context)
  │   → Re-execute entire phase with learnings from failure
  │   → Modified prompt includes what went wrong
  │
  └─ Orchestration-level failure
      → All retries exhausted
      → state = FAILED
      → Notify user with detailed failure report
      → User can: modify plan → retry, skip phase → continue, or stop
```

## Interaction with Ralph Loop

Ralph Loop and Orchestrator Loop are **mutually exclusive** on the same sessions:

```
if (orchestratorLoop.isRunning()) {
  // Orchestrator controls task assignment
  // Ralph Loop should not interfere
  // Respawn Controller uses 'orchestrator' preset
}

if (ralphLoop.isRunning()) {
  // Ralph controls task assignment
  // Orchestrator should not start
}
```

The Orchestrator can optionally USE the Ralph Loop internally for phase execution (delegate phase tasks to Ralph's queue), or manage task assignment directly. Decision: **manage directly** — gives more control over phase boundaries and verification timing.

## Summary of What Touches What

| Existing File | Change |
|---|---|
| `src/types/index.ts` | Export orchestrator types |
| `src/state-store.ts` | Add orchestrator state persistence |
| `src/web/sse-events.ts` | Add ~8 orchestrator events |
| `src/web/routes/index.ts` | Register orchestrator routes |
| `src/web/server.ts` | Initialize OrchestratorLoop |
| `src/web/public/constants.js` | Mirror SSE events |
| `src/web/public/app.js` | Add orchestrator event listeners, panel toggle |
| `src/web/route-helpers.ts` | Add 'orchestrator' respawn preset |

| New File | Purpose |
|---|---|
| `src/orchestrator-loop.ts` | Core state machine |
| `src/orchestrator-planner.ts` | Plan generation + phasing |
| `src/orchestrator-verifier.ts` | Phase verification |
| `src/types/orchestrator.ts` | Type definitions |
| `src/prompts/orchestrator.ts` | Prompt templates |
| `src/web/routes/orchestrator-routes.ts` | API endpoints |
| `src/web/public/orchestrator-ui.js` | Frontend panel |
| `src/web/ports/orchestrator-port.ts` | Port interface |
