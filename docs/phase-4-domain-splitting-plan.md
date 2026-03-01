# Phase 4: Domain File Splitting — Implementation Plan

**Date**: 2026-03-01
**Prerequisites**: Phase 1-3 complete (utils cleanup, CleanupManager/Debouncer migration, route extraction)
**Goal**: Split 4 god files into focused modules with barrel exports for transparent migration.

---

## Table of Contents

1. [Split types.ts into types/ directory](#1-split-typests-into-types-directory)
2. [Split ralph-tracker.ts into focused modules](#2-split-ralph-trackerts-into-focused-modules)
3. [Split respawn-controller.ts into focused modules](#3-split-respawn-controllerts-into-focused-modules)
4. [Split session.ts into focused modules](#4-split-sessionts-into-focused-modules)
5. [Execution Order & Dependencies](#5-execution-order--dependencies)
6. [Validation Checklist](#6-validation-checklist)

---

## 1. Split types.ts into types/ directory

**Current**: 1,443 lines, 71 exports, imported by 36 files.
**Risk**: LOW — pure type refactor, no runtime behavior change.

### Target Structure

```
src/types/
├── index.ts              (barrel re-export — transparent migration)
├── common.ts             (Disposable, BufferConfig, CleanupResourceType, CleanupRegistration)
├── session.ts            (SessionStatus, SessionMode, ClaudeMode, SessionConfig, SessionColor,
│                          SessionState, OpenCodeConfig, SessionOutput)
├── task.ts               (TaskStatus, TaskDefinition, TaskState)
├── app-state.ts          (AppState, AppConfig, GlobalStats, TokenUsageEntry, TokenStats,
│                          DEFAULT_CONFIG, createInitialState, createInitialGlobalStats)
├── respawn.ts            (RespawnConfig, PersistedRespawnConfig, CycleOutcome,
│                          RespawnCycleMetrics, RespawnAggregateMetrics, HealthStatus,
│                          RalphLoopHealthScore, TimingHistory, RespawnPreset)
├── ralph.ts              (RalphLoopStatus, RalphLoopState, RalphTodoStatus, RalphTodoPriority,
│                          RalphTodoItem, RalphTodoProgress, RalphSessionState,
│                          RalphStatusValue, RalphTestsStatus, RalphWorkType, RalphStatusBlock,
│                          CompletionConfidence, RalphTrackerState,
│                          CircuitBreakerState, CircuitBreakerReason, CircuitBreakerStatus,
│                          createInitialCircuitBreakerStatus, createInitialRalphTrackerState,
│                          createInitialRalphSessionState)
├── api.ts                (ApiErrorCode, ApiResponse, HookEventType, QuickStartResponse,
│                          CaseInfo, createErrorResponse, isError, getErrorMessage)
├── lifecycle.ts          (LifecycleEventType, LifecycleEntry)
├── run-summary.ts        (RunSummaryEventType, RunSummaryEventSeverity, RunSummaryEvent,
│                          RunSummaryStats, RunSummary, createInitialRunSummaryStats)
├── tools.ts              (ActiveBashToolStatus, ActiveBashTool, ImageDetectedEvent)
├── teams.ts              (TeamConfig, TeamMember, TeamTask, InboxMessage, PaneInfo)
├── push.ts               (PushSubscriptionRecord, VapidKeys)
└── plan.ts               (PlanTaskStatus, TddPhase, PlanItem re-export, NiceConfig,
                            DEFAULT_NICE_CONFIG, ProcessStats)
```

### Steps

1. **Create `src/types/` directory** and each domain file above.

2. **Move types** from `src/types.ts` into their domain files. Preserve all JSDoc comments. Each file should import from siblings as needed (e.g., `ralph.ts` imports `CircuitBreakerState` within itself — no cross-file deps needed since they're in the same file).

3. **Create barrel `src/types/index.ts`** that re-exports everything:
   ```typescript
   export * from './common.js';
   export * from './session.js';
   export * from './task.js';
   export * from './app-state.js';
   export * from './respawn.js';
   export * from './ralph.js';
   export * from './api.js';
   export * from './lifecycle.js';
   export * from './run-summary.js';
   export * from './tools.js';
   export * from './teams.js';
   export * from './push.js';
   export * from './plan.js';
   ```

4. **Delete old `src/types.ts`** and replace with a single-line re-export barrel:
   ```typescript
   export * from './types/index.js';
   ```
   This ensures `import { ... } from './types.js'` continues to work everywhere — zero changes to 36 import sites.

5. **Verify**: `tsc --noEmit` and `npm run lint` must pass. No runtime changes.

### Internal Dependencies Between Domain Files

Some types reference others across domains. Handle with imports:

| File | Imports From |
|------|-------------|
| `app-state.ts` | `session.ts` (SessionState), `task.ts` (TaskState), `ralph.ts` (RalphLoopState, RalphSessionState) |
| `respawn.ts` | None (self-contained) |
| `ralph.ts` | None (self-contained) |
| `run-summary.ts` | None (self-contained) |
| `api.ts` | None (self-contained) |
| `session.ts` | `respawn.ts` (RespawnConfig), `ralph.ts` (RalphTrackerState, RalphTodoItem, CircuitBreakerStatus, RalphSessionState, RunSummaryEvent) |

Wait — `SessionState` references `RespawnConfig`, `RalphTrackerState`, `CircuitBreakerStatus`, and `RunSummaryEvent`. This creates imports from `session.ts` → `respawn.ts`, `ralph.ts`, `run-summary.ts`. This is fine (one-way deps, no cycles).

---

## 2. Split ralph-tracker.ts into focused modules

**Current**: 3,868 lines, single `RalphTracker` class with 5 responsibilities.
**Risk**: MEDIUM — class has shared mutable state, but extractable modules are well-isolated.

### Coupling Analysis Summary

| Module | Coupling | Extractability |
|--------|----------|----------------|
| Plan task tracking | LOW | HIGH — only reads `cycleCount` |
| Fix-plan file watching | LOW | HIGH — callback-based todo replacement |
| Iteration stall detection | LOW | HIGH — notification-based |
| RALPH_STATUS block parsing + circuit breaker | MEDIUM | MEDIUM — callback for circuit breaker updates |
| Todo parsing, loop detection, completion | HIGH | LOW — deeply entangled shared state |

### Target Structure

```
src/
├── ralph-tracker.ts              (~1,800 LOC — core: output parsing, loop state,
│                                   todo management, completion detection)
├── ralph-plan-tracker.ts         (~600 LOC — plan tasks, checkpoints, history, rollback)
├── ralph-status-parser.ts        (~300 LOC — RALPH_STATUS block parsing, circuit breaker)
├── ralph-fix-plan-watcher.ts     (~150 LOC — @fix_plan.md file watching)
└── ralph-stall-detector.ts       (~80 LOC — iteration stall detection)
```

### Step 2a: Extract `RalphPlanTracker` (~600 LOC)

**Why first**: Lowest coupling. Only dependency is `cycleCount` for checkpoint detection.

**Extract these from `RalphTracker`**:

Types to export:
- `EnhancedPlanTask` (interface, currently lines 56-87)
- `CheckpointReview` (interface, currently lines 90-139)

Properties to move:
- `_planVersion: number`
- `_planHistory: Array<{version, timestamp, tasks, summary}>`
- `_planTasks: Map<string, EnhancedPlanTask>`
- `_checkpointIterations: number[]`
- `_lastCheckpointIteration: number`

Methods to move:
- `initializePlanTasks(items)`
- `updatePlanTask(taskId, update)`
- `addPlanTask(params)`
- `getPlanTasks()`
- `generateCheckpointReview()`
- `getPlanHistory()`
- `rollbackToVersion(version)`
- `isCheckpointDue()`
- `planVersion` getter
- `_savePlanToHistory()` (private)
- `_unblockDependentTasks()` (private)
- `_checkForCheckpoint()` (private)

Events emitted (define in new class):
- `planInitialized`
- `planTaskUpdate`
- `taskBlocked`
- `taskUnblocked`
- `planCheckpoint`

**Interface with parent**:
```typescript
export class RalphPlanTracker extends EventEmitter {
  constructor() { ... }

  // Parent calls this when iteration changes (for checkpoint detection)
  notifyCycleCount(cycleCount: number): void { ... }

  // Full public API moves here unchanged
  initializePlanTasks(items: PlanItem[]): void { ... }
  updatePlanTask(taskId: string, update: { ... }): { ... } | null { ... }
  // ...etc
}
```

**In `RalphTracker`**: Replace plan methods with delegation:
```typescript
readonly planTracker = new RalphPlanTracker();

// Forward plan events
this.planTracker.on('planInitialized', (...args) => this.emit('planInitialized', ...args));
// ...etc

// In detectLoopStatus(), when cycleCount changes:
this.planTracker.notifyCycleCount(this._loopState.cycleCount);
```

### Step 2b: Extract `RalphFixPlanWatcher` (~150 LOC)

**Extract these**:

Properties:
- `_workingDir: string | null`
- `_fixPlanPath: string | null`
- `_fixPlanWatcher: FSWatcher | null`
- `_fixPlanWatcherErrorHandler`
- `_fixPlanReloadDeb`

Methods:
- `setWorkingDir(workingDir)`
- `loadFixPlanFromDisk()`
- `startWatchingFixPlan()`
- `stopWatchingFixPlan()`
- `handleFixPlanChange()`
- `isFileAuthoritative` getter

**Interface with parent**:
```typescript
export class RalphFixPlanWatcher extends EventEmitter {
  get isFileAuthoritative(): boolean { ... }

  setWorkingDir(workingDir: string): void { ... }
  stop(): void { ... }
}

// Events:
// 'todosLoaded' → (todos: Array<{id, content, status, priority}>) — parent replaces _todos
```

**In `RalphTracker`**:
```typescript
readonly fixPlanWatcher = new RalphFixPlanWatcher();

constructor() {
  this.fixPlanWatcher.on('todosLoaded', (items) => {
    // Replace _todos with file-based items
    this._todos.clear();
    for (const item of items) {
      this.addOrUpdateTodo(item.id, item.content, item.status, item.priority);
    }
  });
}

// Delegate isFileAuthoritative
get isFileAuthoritative(): boolean {
  return this.fixPlanWatcher.isFileAuthoritative;
}
```

### Step 2c: Extract `RalphStallDetector` (~80 LOC)

**Extract these**:

Properties:
- `_lastIterationChangeTime`
- `_lastObservedIteration`
- `_iterationStallTimerId`
- `_iterationStallWarningMs`
- `_iterationStallCriticalMs`
- `_iterationStallWarned`

Methods:
- `startIterationStallDetection()`
- `stopIterationStallDetection()`
- `checkIterationStall()`
- `getIterationStallMetrics()`
- `configureIterationStallThresholds(warningMs, criticalMs)`

**Interface with parent**:
```typescript
export class RalphStallDetector extends EventEmitter {
  constructor(private cleanup: CleanupManager) { ... }

  start(): void { ... }
  stop(): void { ... }

  // Parent calls when iteration changes
  notifyIterationChanged(iteration: number): void {
    this._lastIterationChangeTime = Date.now();
    this._lastObservedIteration = iteration;
    this._iterationStallWarned = false;
  }

  // Parent calls to check if loop is active
  setLoopActive(active: boolean): void { ... }

  getIterationStallMetrics(): { ... } { ... }
}

// Events: 'iterationStallWarning', 'iterationStallCritical'
```

### Step 2d: Extract `RalphStatusParser` (~300 LOC)

**Extract these**:

Properties:
- `_circuitBreaker: CircuitBreakerStatus`
- `_statusBlockBuffer: string[]`
- `_inStatusBlock: boolean`
- `_lastStatusBlock: RalphStatusBlock | null`
- `_completionIndicators: number`
- `_exitGateMet: boolean`
- `_totalFilesModified: number`
- `_totalTasksCompleted: number`

Methods:
- `processStatusBlockLine(line)`
- `parseStatusBlock(lines)`
- `detectCompletionIndicators(line)`
- `updateCircuitBreaker(hasProgress, testsStatus, status)`
- `resetCircuitBreaker()`
- `circuitBreakerStatus` getter
- `lastStatusBlock` getter
- `cumulativeStats` getter
- `exitGateMet` getter

Regex patterns to move:
- `RALPH_STATUS_START_PATTERN` through `RALPH_RECOMMENDATION_PATTERN`
- `COMPLETION_INDICATOR_PATTERNS`

**Interface with parent**:
```typescript
export class RalphStatusParser extends EventEmitter {
  processLine(line: string): void { ... }  // calls processStatusBlockLine + detectCompletionIndicators

  get circuitBreakerStatus(): CircuitBreakerStatus { ... }
  get lastStatusBlock(): RalphStatusBlock | null { ... }
  get exitGateMet(): boolean { ... }
  get cumulativeStats(): { ... } { ... }

  resetCircuitBreaker(): void { ... }
  reset(): void { ... }
}

// Events: 'statusBlockDetected', 'circuitBreakerUpdate', 'exitGateMet'
```

**In `RalphTracker.processLine()`**:
```typescript
// Replace inline status block handling with delegation
this.statusParser.processLine(line);
```

### Step 2e: Keep in `ralph-tracker.ts` (~1,800 LOC)

The core remains tightly coupled and stays together:
- Output parsing pipeline (`processTerminalData`, `processCleanData`, `processLine`)
- Loop state management (`_loopState`, `detectLoopStatus`, `enable/disable/startLoop/stopLoop`)
- Todo management (`_todos`, `detectTodoItems`, `addOrUpdateTodo`, `updateTodoStatus`, `getTodoStats`)
- Completion detection (`detectCompletionPhrase`, `handleCompletionPhrase`, `calculateCompletionConfidence`)
- All-tasks-complete detection (`detectAllTasksComplete`)
- Auto-enable logic (`shouldAutoEnable`)
- Lifecycle (`reset`, `fullReset`, `clear`, `restoreState`, `destroy`)
- Event debouncing and buffering

The class coordinates the extracted modules via composition:
```typescript
export class RalphTracker extends EventEmitter {
  readonly planTracker = new RalphPlanTracker();
  readonly fixPlanWatcher = new RalphFixPlanWatcher();
  readonly stallDetector: RalphStallDetector;
  readonly statusParser = new RalphStatusParser();

  constructor() {
    super();
    this.stallDetector = new RalphStallDetector(this.cleanup);
    this._wireSubModuleEvents();
  }

  private _wireSubModuleEvents(): void {
    // Forward all sub-module events through RalphTracker
    // so external consumers don't need to know about the split
    for (const event of ['planInitialized', 'planTaskUpdate', ...]) {
      this.planTracker.on(event, (...args) => this.emit(event, ...args));
    }
    // ...same for statusParser, stallDetector, fixPlanWatcher
  }
}
```

### Migration Safety

- All events continue to be emitted from `RalphTracker` (forwarded from sub-modules)
- All public methods stay on `RalphTracker` (delegated to sub-modules)
- External consumers (`session.ts`, `case-routes.ts`) see zero API changes
- New sub-modules are exposed as `readonly` properties for direct access where needed

---

## 3. Split respawn-controller.ts into focused modules

**Current**: 3,611 lines, single `RespawnController` class with 6 responsibilities.
**Risk**: MEDIUM — health scoring and metrics are cleanly decoupled; detection is tightly coupled.

### Coupling Analysis Summary

| Module | Coupling | Extractability |
|--------|----------|----------------|
| Health scoring | NONE | HIGH — pure calculations from metrics |
| Cycle metrics | LOW | HIGH — standalone tracking |
| Adaptive timing | LOW | HIGH — standalone timing adjustments |
| Stuck-state detection | LOW | MEDIUM — needs state + config refs |
| Pattern detection utilities | NONE | HIGH — pure functions |
| State machine + idle detection + AI checkers | HIGH | LOW — deeply entangled |

### Target Structure

```
src/
├── respawn-controller.ts             (~2,200 LOC — state machine, idle detection,
│                                       AI checkers, terminal handling, hook signals,
│                                       auto-accept, step execution)
├── respawn-health.ts                 (~250 LOC — health scoring + recommendations)
├── respawn-metrics.ts                (~200 LOC — cycle metrics + aggregate stats)
├── respawn-adaptive-timing.ts        (~100 LOC — adaptive timing with percentile calc)
└── respawn-patterns.ts               (~50 LOC — terminal pattern detection utilities)
```

### Step 3a: Extract `RespawnPatterns` (~50 LOC)

**Pure utility functions, zero coupling**.

Move:
- `isCompletionMessage(data): boolean`
- `hasWorkingPattern(data, window): boolean`
- `extractTokenCount(data): number | null`
- `PROMPT_PATTERNS` array
- `WORKING_PATTERNS` array

```typescript
// src/respawn-patterns.ts
import { TOKEN_PATTERN, SPINNER_PATTERN } from './utils/index.js';

export const PROMPT_PATTERNS = ['❯', '>', '$', '%', '#'];

export const WORKING_PATTERNS = [/* 70+ patterns */];

export function isCompletionMessage(data: string): boolean { ... }
export function hasWorkingPattern(data: string, window: string): boolean { ... }
export function extractTokenCount(data: string): number | null { ... }
```

**In `RespawnController`**: Import and call:
```typescript
import { isCompletionMessage, hasWorkingPattern, extractTokenCount } from './respawn-patterns.js';
```

### Step 3b: Extract `RespawnAdaptiveTiming` (~100 LOC)

**Self-contained timing controller**.

Move properties:
- `timingHistory: TimingHistory`

Move methods:
- `recordTimingData(idleDetectionMs, cycleDurationMs)`
- `updateAdaptiveTiming()`
- `getTimingHistory()`
- `getAdaptiveCompletionConfirmMs()`

```typescript
export class RespawnAdaptiveTiming {
  private timingHistory: TimingHistory;

  constructor(private config: { adaptiveMinConfirmMs: number; adaptiveMaxConfirmMs: number }) {
    this.timingHistory = { recentIdleDetectionMs: [], recentCycleDurationMs: [], ... };
  }

  recordTimingData(idleDetectionMs: number, cycleDurationMs: number): void { ... }
  getAdaptiveCompletionConfirmMs(): number { ... }
  getTimingHistory(): TimingHistory { ... }
  reset(): void { ... }
}
```

### Step 3c: Extract `RespawnCycleMetrics` (~200 LOC)

**Standalone metrics tracker**.

Move properties:
- `currentCycleMetrics`
- `recentCycleMetrics[]`
- `aggregateMetrics`
- `MAX_CYCLE_METRICS_IN_MEMORY`

Move methods:
- `startCycleMetrics(idleReason)`
- `recordCycleStep(step)`
- `completeCycleMetrics(outcome, errorMessage?)`
- `updateAggregateMetrics(metrics)`
- `getAggregateMetrics()`
- `getRecentCycleMetrics(limit?)`

```typescript
export class RespawnCycleMetricsTracker {
  private currentCycleMetrics: Partial<RespawnCycleMetrics> | null = null;
  private recentCycleMetrics: RespawnCycleMetrics[] = [];
  private aggregateMetrics: RespawnAggregateMetrics;

  startCycle(sessionId: string, cycleNumber: number, idleReason: string): void { ... }
  recordStep(step: string): void { ... }
  completeCycle(outcome: CycleOutcome, errorMessage?: string): RespawnCycleMetrics | null { ... }
  getAggregate(): RespawnAggregateMetrics { ... }
  getRecent(limit?: number): RespawnCycleMetrics[] { ... }
  reset(): void { ... }
}
```

**Callback**: `completeCycle()` returns the completed metrics so the controller can pass them to `adaptiveTiming.recordTimingData()`.

### Step 3d: Extract `RespawnHealthCalculator` (~250 LOC)

**Pure calculation — no state of its own**.

Move methods:
- `calculateHealthScore()`
- `calculateCycleSuccessScore()`
- `calculateCircuitBreakerScore()`
- `calculateIterationProgressScore()`
- `calculateAiCheckerScore()`
- `calculateStuckRecoveryScore()`
- `generateHealthRecommendations(components)`
- `generateHealthSummary(score, status, components)`
- `shouldSkipClear()` (belongs here since it's a pure calculation on token/config)

```typescript
export interface HealthInputs {
  aggregateMetrics: RespawnAggregateMetrics;
  circuitBreakerStatus: CircuitBreakerStatus;
  iterationStallMetrics: { stallDurationMs: number; warningMs: number; criticalMs: number } | null;
  aiCheckerState: { disabled: boolean; inCooldown: boolean; hasErrors: boolean };
  stuckRecoveryCount: number;
  maxStuckRecoveries: number;
}

export function calculateHealthScore(inputs: HealthInputs): RalphLoopHealthScore { ... }

export function shouldSkipClear(
  lastTokenCount: number,
  skipClearThresholdPercent: number,
  maxContextTokens: number
): boolean { ... }
```

**Made as pure functions** (not a class) since they hold no state.

### Step 3e: Keep in `respawn-controller.ts` (~2,200 LOC)

The core state machine, idle detection, and AI checker integration stays:
- State machine transitions (`setState`, `start`, `stop`, `pause`, `resume`)
- Terminal data handling (`handleTerminalData`)
- All 5 idle detection layers + hook signals
- AI checker integration (`tryStartAiCheck`, `startAiCheck`, `startPlanCheck`)
- Auto-accept logic
- Step execution (`sendUpdateDocs`, `sendClear`, `sendInit`, `sendKickstart`)
- Timer management (`startTrackedTimer`, `cancelTrackedTimer`)
- Stuck-state detection and recovery
- Action logging

The class composes extracted modules:
```typescript
import { RespawnAdaptiveTiming } from './respawn-adaptive-timing.js';
import { RespawnCycleMetricsTracker } from './respawn-metrics.js';
import { calculateHealthScore, shouldSkipClear } from './respawn-health.js';
import { isCompletionMessage, hasWorkingPattern, extractTokenCount } from './respawn-patterns.js';

export class RespawnController extends EventEmitter {
  private adaptiveTiming: RespawnAdaptiveTiming;
  private cycleMetrics: RespawnCycleMetricsTracker;

  calculateHealthScore(): RalphLoopHealthScore {
    return calculateHealthScore({
      aggregateMetrics: this.cycleMetrics.getAggregate(),
      circuitBreakerStatus: this.session.ralphTracker.circuitBreakerStatus,
      iterationStallMetrics: this.session.ralphTracker.getIterationStallMetrics(),
      aiCheckerState: { ... },
      stuckRecoveryCount: this.stuckRecoveryCount,
      maxStuckRecoveries: this.config.maxStuckRecoveries ?? 3,
    });
  }
}
```

---

## 4. Split session.ts into focused modules

**Current**: 2,418 lines, single `Session` class.
**Risk**: LOW-MEDIUM — extractable pieces are utility-like with clear boundaries.

### Coupling Analysis Summary

| Module | Coupling | Extractability |
|--------|----------|----------------|
| CLI arg builder | NONE | HIGH — pure functions used at spawn time |
| Auto-compact/clear | LOW | HIGH — self-contained automation with config |
| Token tracking | LOW | MEDIUM — reads PTY output, writes state |
| Task description cache | LOW | HIGH — separate LRU cache |
| PTY + mux lifecycle | HIGH | KEEP — core of the class |
| Tracker integration | HIGH | KEEP — event forwarding plumbing |

### Target Structure

```
src/
├── session.ts                    (~1,600 LOC — PTY lifecycle, terminal I/O,
│                                   tracker integration, output processing,
│                                   token tracking, state management)
├── session-cli-builder.ts        (~250 LOC — Claude/OpenCode CLI arg construction)
├── session-auto-ops.ts           (~300 LOC — auto-compact, auto-clear automation)
└── session-task-cache.ts         (~100 LOC — task description LRU cache)
```

### Step 4a: Extract `SessionCliBuilder` (~250 LOC)

**Pure functions — zero coupling to Session instance**.

Move:
- `buildClaudeArgs()` logic (currently inlined in `startInteractive` and `runPrompt`)
- `buildOpenCodeArgs()` logic
- Model mapping constants
- Claude mode to flag mapping
- Environment variable construction

```typescript
// src/session-cli-builder.ts
export interface CliBuilderConfig {
  claudeMode: ClaudeMode;
  model?: string;
  workingDir: string;
  sessionId: string;
  niceConfig?: NiceConfig;
  isOpenCode?: boolean;
  openCodeConfig?: OpenCodeConfig;
}

export function buildInteractiveArgs(config: CliBuilderConfig): string[] { ... }
export function buildPromptArgs(config: CliBuilderConfig, prompt: string): string[] { ... }
export function buildShellArgs(shell?: string): string[] { ... }
export function buildClaudeEnv(config: CliBuilderConfig): Record<string, string> { ... }
```

### Step 4b: Extract `SessionAutoOps` (~300 LOC)

**Self-contained automation with config-based thresholds**.

Move properties:
- `_autoCompactThreshold`
- `_autoClearThreshold`
- `_isAutoCompacting`
- `_isAutoClearing`
- `_autoCompactCount`
- `_autoClearCount`
- `_lastAutoCompactTime`
- `_lastAutoClearTime`

Move methods:
- `checkAutoCompact(tokenCount)`
- `performAutoCompact()`
- `checkAutoClear(tokenCount)`
- `performAutoClear()`
- Auto-compact/clear threshold configuration

```typescript
export class SessionAutoOps extends EventEmitter {
  constructor(
    private writeCommand: (command: string) => Promise<void>,
    private getTokenCount: () => number,
    config: { compactThreshold: number; clearThreshold: number }
  ) { ... }

  /** Called after token count updates. Checks thresholds and triggers if needed. */
  checkThresholds(tokenCount: number): void { ... }

  updateConfig(config: { compactThreshold?: number; clearThreshold?: number }): void { ... }
  getStats(): { autoCompactCount: number; autoClearCount: number; ... } { ... }
}

// Events: 'autoCompact', 'autoClear'
```

**In `Session`**: Compose and wire:
```typescript
private autoOps = new SessionAutoOps(
  (cmd) => this.writeViaMux(cmd),
  () => this._state.tokenCount,
  { compactThreshold: 110_000, clearThreshold: 140_000 }
);
```

### Step 4c: Extract `SessionTaskCache` (~100 LOC)

**Isolated LRU cache for task descriptions**.

Move:
- `_taskDescriptionCache: LRUMap<number, { description: string; timestamp: number }>`
- `_taskDescriptionMaxAge`
- `findTaskDescriptionNear(lineNumber)`
- `cacheTaskDescription(lineNumber, description)`

```typescript
export class SessionTaskCache {
  private cache: LRUMap<number, { description: string; timestamp: number }>;
  private maxAgeMs: number;

  constructor(maxSize: number = 50, maxAgeMs: number = 30_000) { ... }

  find(lineNumber: number, searchRadius: number = 50): string | null { ... }
  add(lineNumber: number, description: string): void { ... }
  clear(): void { ... }
}
```

### Step 4d: Keep in `session.ts` (~1,600 LOC)

The core stays together:
- PTY process management (`spawn`, `kill`, `resize`, `writeViaMux`)
- Data streaming pipeline (PTY → buffer → ANSI strip → JSON parse → events)
- Tracker initialization and event forwarding (RalphTracker, BashToolParser, TaskTracker)
- Output processing (message extraction, completion detection)
- Token tracking (status line parsing)
- State management (`toState()`, `updateState()`)
- Session lifecycle (`startInteractive`, `startShell`, `runPrompt`)
- CLI info detection (version, model, account)

---

## 5. Execution Order & Dependencies

Execute in this order to minimize risk. Each step is independently deployable.

```
Step 1: types.ts split
  ↓  (no runtime change, just file reorganization)
Step 2a: RalphPlanTracker extraction
  ↓  (independent of types split)
Step 2b: RalphFixPlanWatcher extraction
Step 2c: RalphStallDetector extraction
Step 2d: RalphStatusParser extraction
  ↓  (ralph-tracker.ts now ~1,800 LOC)
Step 3a: RespawnPatterns extraction
Step 3b: RespawnAdaptiveTiming extraction
Step 3c: RespawnCycleMetrics extraction
Step 3d: RespawnHealthCalculator extraction
  ↓  (respawn-controller.ts now ~2,200 LOC)
Step 4a: SessionCliBuilder extraction
Step 4b: SessionAutoOps extraction
Step 4c: SessionTaskCache extraction
  ↓  (session.ts now ~1,600 LOC)
```

**Parallelization**: Steps 1, 2a-2d, 3a-3d, and 4a-4c can be done by separate agents in parallel since they touch different files. However, within each group, sequential execution is safer.

### Risk Mitigation

- **Barrel exports**: Every split uses delegation + barrel re-export so external consumers see zero API changes
- **Event forwarding**: Sub-modules emit events, parent class forwards them — no event contract changes
- **Incremental**: Each step can be verified independently with `tsc --noEmit` + `npm run lint`
- **No test changes needed**: External API stays identical; existing tests continue to pass

---

## 6. Validation Checklist

After each step, verify:

- [ ] `tsc --noEmit` passes (no type errors)
- [ ] `npm run lint` passes (no unused imports, etc.)
- [ ] `npm run format:check` passes
- [ ] `npx vitest run test/respawn-controller.test.ts` passes (for respawn splits)
- [ ] `npx vitest run test/ralph-tracker.test.ts` passes (for ralph splits)
- [ ] `npx vitest run test/session-manager.test.ts` passes (for session splits)
- [ ] Dev server starts: `npx tsx src/index.ts web`
- [ ] Existing sessions work (create, interact, delete)
- [ ] Respawn cycle works (enable respawn, verify idle detection fires)
- [ ] No new circular dependencies: `npx madge --circular src/`

### Size Targets

| File | Before | After |
|------|--------|-------|
| `src/types.ts` | 1,443 LOC | 1 LOC (re-export barrel) |
| `src/ralph-tracker.ts` | 3,868 LOC | ~1,800 LOC |
| `src/respawn-controller.ts` | 3,611 LOC | ~2,200 LOC |
| `src/session.ts` | 2,418 LOC | ~1,600 LOC |
| **Total new files** | — | 12 files |
| **Net LOC change** | — | ~0 (refactor only) |
