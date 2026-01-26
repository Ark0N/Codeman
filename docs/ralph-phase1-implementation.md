# Ralph Tracker Phase 1 Implementation Plan

## Overview

This plan details how to enhance the existing RalphTracker with RALPH_STATUS block parsing, circuit breaker pattern, and dual-condition exit gate.

---

## 1. Current State Analysis

### What RalphTracker Already Does Well

- **Todo Detection**: Supports 5 formats (checkboxes, indicators, status in parentheses, native TodoWrite, checkmark-based)
- **Completion Phrases**: Detects `<promise>PHRASE</promise>` with occurrence-based logic (1st = store, 2nd = complete)
- **Loop State Tracking**: Tracks active/inactive, iteration counts, max iterations, elapsed hours, cycle counts
- **Auto-Enable**: Disabled by default, auto-enables when Ralph patterns detected
- **Event System**: Emits `loopUpdate`, `todoUpdate`, `completionDetected`, `enabled` events
- **SSE Integration**: Events forwarded via `session:ralphLoopUpdate`, `session:ralphTodoUpdate`, `session:ralphCompletionDetected`
- **Debouncing**: EVENT_DEBOUNCE_MS (50ms) for rapid updates to prevent UI jitter
- **Cleanup**: MAX_TODO_ITEMS (50), TODO_EXPIRY_MS (1 hour), throttled cleanup

### Current Limitations

| Feature | Status |
|---------|--------|
| RALPH_STATUS block parsing | Missing |
| Circuit breaker pattern | Missing |
| Priority-based todos (P0/P1/P2) | Missing |
| Dual-condition exit gate | Missing |
| Files modified tracking | Missing |
| Tests status tracking | Missing |
| Work type classification | Missing |

---

## 2. New Type Definitions (types.ts)

```typescript
// ========== RALPH_STATUS Block Types ==========

export type RalphStatusValue = 'IN_PROGRESS' | 'COMPLETE' | 'BLOCKED';
export type RalphTestsStatus = 'PASSING' | 'FAILING' | 'NOT_RUN';
export type RalphWorkType = 'IMPLEMENTATION' | 'TESTING' | 'DOCUMENTATION' | 'REFACTORING';

/**
 * Parsed RALPH_STATUS block from Claude output.
 */
export interface RalphStatusBlock {
  status: RalphStatusValue;
  tasksCompletedThisLoop: number;
  filesModified: number;
  testsStatus: RalphTestsStatus;
  workType: RalphWorkType;
  exitSignal: boolean;
  recommendation: string;
  parsedAt: number;
}

// ========== Circuit Breaker Types ==========

export type CircuitBreakerState = 'CLOSED' | 'HALF_OPEN' | 'OPEN';

export type CircuitBreakerReason =
  | 'normal_operation'
  | 'no_progress_warning'
  | 'no_progress_open'
  | 'same_error_repeated'
  | 'tests_failing_too_long'
  | 'progress_detected'
  | 'manual_reset';

export interface CircuitBreakerStatus {
  state: CircuitBreakerState;
  consecutiveNoProgress: number;
  consecutiveSameError: number;
  consecutiveTestsFailure: number;
  lastProgressIteration: number;
  reason: string;
  reasonCode: CircuitBreakerReason;
  lastTransitionAt: number;
  lastErrorMessage: string | null;
}

// ========== Priority Todo Types ==========

export type RalphTodoPriority = 'P0' | 'P1' | 'P2' | null;

// ========== Helper Functions ==========

export function createInitialCircuitBreakerStatus(): CircuitBreakerStatus {
  return {
    state: 'CLOSED',
    consecutiveNoProgress: 0,
    consecutiveSameError: 0,
    consecutiveTestsFailure: 0,
    lastProgressIteration: 0,
    reason: 'Initial state',
    reasonCode: 'normal_operation',
    lastTransitionAt: Date.now(),
    lastErrorMessage: null,
  };
}
```

---

## 3. New Regex Patterns (ralph-tracker.ts)

```typescript
// ---------- RALPH_STATUS Block Patterns ----------

const RALPH_STATUS_START_PATTERN = /^---RALPH_STATUS---\s*$/;
const RALPH_STATUS_END_PATTERN = /^---END_RALPH_STATUS---\s*$/;
const RALPH_STATUS_FIELD_PATTERN = /^STATUS:\s*(IN_PROGRESS|COMPLETE|BLOCKED)\s*$/i;
const RALPH_TASKS_COMPLETED_PATTERN = /^TASKS_COMPLETED_THIS_LOOP:\s*(\d+)\s*$/i;
const RALPH_FILES_MODIFIED_PATTERN = /^FILES_MODIFIED:\s*(\d+)\s*$/i;
const RALPH_TESTS_STATUS_PATTERN = /^TESTS_STATUS:\s*(PASSING|FAILING|NOT_RUN)\s*$/i;
const RALPH_WORK_TYPE_PATTERN = /^WORK_TYPE:\s*(IMPLEMENTATION|TESTING|DOCUMENTATION|REFACTORING)\s*$/i;
const RALPH_EXIT_SIGNAL_PATTERN = /^EXIT_SIGNAL:\s*(true|false)\s*$/i;
const RALPH_RECOMMENDATION_PATTERN = /^RECOMMENDATION:\s*(.+)$/i;

// ---------- Completion Indicator Patterns ----------

const COMPLETION_INDICATOR_PATTERNS = [
  /all\s+(?:tasks?|items?|work)\s+(?:are\s+)?(?:completed?|done|finished)/i,
  /(?:completed?|finished)\s+all\s+(?:tasks?|items?|work)/i,
  /nothing\s+(?:left|remaining)\s+to\s+do/i,
  /no\s+more\s+(?:tasks?|items?|work)/i,
  /everything\s+(?:is\s+)?(?:completed?|done)/i,
];

// ---------- Priority Pattern ----------

const TODO_PRIORITY_PATTERN = /^\s*(?:\[.\])?\s*(?:Critical:|Blocker:|Feature:|Improvement:)?\s*\(?(P[012])\)?:?\s*/i;
```

---

## 4. New State Properties (ralph-tracker.ts)

```typescript
// Add to RalphTracker class

// Circuit breaker state tracking
private _circuitBreaker: CircuitBreakerStatus;

// RALPH_STATUS block parsing state
private _statusBlockBuffer: string[] = [];
private _inStatusBlock: boolean = false;
private _lastStatusBlock: RalphStatusBlock | null = null;

// Dual-condition exit tracking
private _completionIndicators: number = 0;
private _exitGateMet: boolean = false;

// Cumulative tracking
private _totalFilesModified: number = 0;
private _totalTasksCompleted: number = 0;
```

---

## 5. New Methods to Implement

### 5.1 RALPH_STATUS Block Parsing

```typescript
private processStatusBlockLine(line: string): void {
  const trimmed = line.trim();

  if (RALPH_STATUS_START_PATTERN.test(trimmed)) {
    this._inStatusBlock = true;
    this._statusBlockBuffer = [];
    return;
  }

  if (this._inStatusBlock && RALPH_STATUS_END_PATTERN.test(trimmed)) {
    this._inStatusBlock = false;
    this.parseStatusBlock(this._statusBlockBuffer);
    this._statusBlockBuffer = [];
    return;
  }

  if (this._inStatusBlock) {
    this._statusBlockBuffer.push(trimmed);
  }
}

private parseStatusBlock(lines: string[]): void {
  const block: Partial<RalphStatusBlock> = { parsedAt: Date.now() };

  for (const line of lines) {
    // Parse each field...
  }

  if (block.status !== undefined) {
    this._lastStatusBlock = fullBlock;
    this.handleStatusBlock(fullBlock);
  }
}

private handleStatusBlock(block: RalphStatusBlock): void {
  this._totalFilesModified += block.filesModified;
  this._totalTasksCompleted += block.tasksCompletedThisLoop;

  const hasProgress = block.filesModified > 0 || block.tasksCompletedThisLoop > 0;
  this.updateCircuitBreaker(hasProgress, block.testsStatus, block.status);

  if (block.status === 'COMPLETE') {
    this._completionIndicators++;
  }

  if (block.exitSignal && this._completionIndicators >= 2) {
    this._exitGateMet = true;
    this.emit('exitGateMet', { completionIndicators: this._completionIndicators, exitSignal: true });
  }

  this.emit('statusBlockDetected', block);
}
```

### 5.2 Circuit Breaker Logic

```typescript
private updateCircuitBreaker(
  hasProgress: boolean,
  testsStatus: RalphTestsStatus,
  status: RalphStatusValue
): void {
  const prevState = this._circuitBreaker.state;

  if (hasProgress) {
    this._circuitBreaker.consecutiveNoProgress = 0;
    this._circuitBreaker.lastProgressIteration = this._loopState.cycleCount;

    if (this._circuitBreaker.state === 'HALF_OPEN') {
      this._circuitBreaker.state = 'CLOSED';
      this._circuitBreaker.reasonCode = 'progress_detected';
    }
  } else {
    this._circuitBreaker.consecutiveNoProgress++;

    if (this._circuitBreaker.state === 'CLOSED') {
      if (this._circuitBreaker.consecutiveNoProgress >= 3) {
        this._circuitBreaker.state = 'OPEN';
        this._circuitBreaker.reasonCode = 'no_progress_open';
      } else if (this._circuitBreaker.consecutiveNoProgress >= 2) {
        this._circuitBreaker.state = 'HALF_OPEN';
        this._circuitBreaker.reasonCode = 'no_progress_warning';
      }
    }
  }

  if (prevState !== this._circuitBreaker.state) {
    this._circuitBreaker.lastTransitionAt = Date.now();
    this.emit('circuitBreakerUpdate', { ...this._circuitBreaker });
  }
}

resetCircuitBreaker(): void {
  this._circuitBreaker = createInitialCircuitBreakerStatus();
  this._circuitBreaker.reasonCode = 'manual_reset';
  this.emit('circuitBreakerUpdate', { ...this._circuitBreaker });
}
```

### 5.3 Update processLine Method

```typescript
private processLine(line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  // NEW: Check for RALPH_STATUS block
  this.processStatusBlockLine(trimmed);

  // NEW: Check for completion indicators
  this.detectCompletionIndicators(trimmed);

  // EXISTING: Rest of the detection methods...
  this.detectCompletionPhrase(trimmed);
  this.detectAllTasksComplete(trimmed);
  this.detectTaskCompletion(trimmed);
  this.detectLoopStatus(trimmed);
  this.detectTodoItems(trimmed);
}
```

---

## 6. New Events to Add

```typescript
export interface RalphTrackerEvents {
  // Existing events
  loopUpdate: (state: RalphTrackerState) => void;
  todoUpdate: (todos: RalphTodoItem[]) => void;
  completionDetected: (phrase: string) => void;
  enabled: () => void;

  // New events
  statusBlockDetected: (block: RalphStatusBlock) => void;
  circuitBreakerUpdate: (status: CircuitBreakerStatus) => void;
  exitGateMet: (data: { completionIndicators: number; exitSignal: boolean }) => void;
}
```

---

## 7. Server Integration (server.ts)

```typescript
// Add new SSE event handlers in setupSessionListeners()

session.on('ralphStatusBlockDetected', (block: RalphStatusBlock) => {
  this.broadcast('session:ralphStatusUpdate', { sessionId: session.id, block });
});

session.on('ralphCircuitBreakerUpdate', (status: CircuitBreakerStatus) => {
  this.broadcast('session:circuitBreakerUpdate', { sessionId: session.id, status });
});

session.on('ralphExitGateMet', (data) => {
  this.broadcast('session:exitGateMet', { sessionId: session.id, ...data });
});

// Add API endpoint for circuit breaker reset
this.app.post('/api/sessions/:id/ralph-circuit-breaker/reset', async (req) => {
  const session = this.sessions.get(req.params.id);
  if (!session) return { success: false, error: 'Session not found' };

  session.ralphTracker?.resetCircuitBreaker();
  return { success: true };
});
```

---

## 8. Frontend Changes (app.js)

### New SSE Event Listeners

```javascript
this.eventSource.addEventListener('session:ralphStatusUpdate', (e) => {
  const data = JSON.parse(e.data);
  this.updateRalphStatusBlock(data.sessionId, data.block);
});

this.eventSource.addEventListener('session:circuitBreakerUpdate', (e) => {
  const data = JSON.parse(e.data);
  this.updateCircuitBreaker(data.sessionId, data.status);
});
```

### New Rendering Methods

```javascript
updateRalphStatusBlock(sessionId, block) {
  // Store and render status block
}

renderRalphStatusBlock(block) {
  // Render STATUS, WORK_TYPE, TESTS_STATUS, RECOMMENDATION
}

updateCircuitBreaker(sessionId, status) {
  // Store and render circuit breaker state
}

renderCircuitBreaker(status) {
  // Render badge: green (CLOSED), yellow (HALF_OPEN), red (OPEN)
}
```

---

## 9. Implementation Order

| Step | Task | Time |
|------|------|------|
| 1 | Add type definitions to `types.ts` | 30 min |
| 2 | Add regex patterns to `ralph-tracker.ts` | 30 min |
| 3 | Add state properties to RalphTracker class | 15 min |
| 4 | Implement RALPH_STATUS parsing methods | 1.5 hr |
| 5 | Implement circuit breaker logic | 1 hr |
| 6 | Implement completion indicators | 30 min |
| 7 | Update events interface | 15 min |
| 8 | Add server SSE handlers and API endpoint | 45 min |
| 9 | Add frontend event listeners and rendering | 1 hr |
| 10 | Add CSS styles | 30 min |
| 11 | Update HTML structure | 15 min |
| 12 | Write unit tests | 1.5 hr |

**Total: ~8 hours**

---

## 10. Files to Modify

| File | Changes |
|------|---------|
| `src/types.ts` | Add RalphStatusBlock, CircuitBreakerStatus, helper functions |
| `src/ralph-tracker.ts` | Add patterns, state, parsing methods, circuit breaker |
| `src/web/server.ts` | Add SSE handlers, circuit breaker reset endpoint |
| `src/web/public/app.js` | Add event listeners, rendering methods |
| `src/web/public/styles.css` | Add status block and circuit breaker styles |
| `src/web/public/index.html` | Add UI elements to Ralph panel |
| `test/ralph-tracker.test.ts` | Add tests for new functionality |

---

## 11. Test Cases to Add

1. **RALPH_STATUS Parsing**
   - Parse valid status block with all fields
   - Parse block with missing optional fields
   - Ignore malformed blocks
   - Handle multiple blocks in sequence

2. **Circuit Breaker State Transitions**
   - CLOSED → HALF_OPEN on 2 no-progress
   - HALF_OPEN → OPEN on 3 no-progress
   - HALF_OPEN → CLOSED on progress
   - Manual reset from OPEN

3. **Dual-Condition Exit Gate**
   - Exit when indicators >= 2 AND exitSignal = true
   - No exit when indicators >= 2 but exitSignal = false
   - No exit when exitSignal = true but indicators < 2

4. **Integration Tests**
   - SSE events broadcast correctly
   - UI updates on status block detection
   - Circuit breaker badge updates
