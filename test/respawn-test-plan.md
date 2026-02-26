# Respawn Controller Test Plan

This document describes the testing environment, architecture, and strategies for testing the RespawnController and related AI checker components.

## Table of Contents

1. [Test Environment Architecture](#test-environment-architecture)
2. [Component Interaction Diagram](#component-interaction-diagram)
3. [Mock Components](#mock-components)
4. [Port Allocation](#port-allocation)
5. [Test Isolation Strategy](#test-isolation-strategy)
6. [Cleanup Procedures](#cleanup-procedures)
7. [Test Categories](#test-categories)
8. [Usage Examples](#usage-examples)

---

## Test Environment Architecture

The RespawnController testing environment uses a layered approach to isolate components and enable deterministic testing without spawning real Claude CLI processes.

```
+------------------------------------------+
|            Test Runner (Vitest)          |
+------------------------------------------+
         |                    |
         v                    v
+------------------+  +------------------+
|   Unit Tests     |  | Integration Tests|
| (No real I/O)    |  | (Uses ports)     |
+------------------+  +------------------+
         |                    |
         v                    v
+------------------------------------------+
|           Test Utilities Layer           |
|  - MockSession                           |
|  - MockAiIdleChecker                     |
|  - MockAiPlanChecker                     |
|  - TimeController                        |
|  - State/Event Recorders                 |
+------------------------------------------+
         |
         v
+------------------------------------------+
|        Real Components Under Test        |
|  - RespawnController                     |
|  - RespawnConfig types                   |
|  - State machine logic                   |
+------------------------------------------+
```

### Key Principles

1. **No Real Claude CLI**: Tests use MockAiIdleChecker and MockAiPlanChecker instead of spawning real Claude processes
2. **No Real Screens**: MockSession simulates terminal I/O without GNU screen
3. **Deterministic Timing**: Tests can use real timers (short timeouts) or fake timers for precise control
4. **Isolated State**: Each test gets fresh instances with no shared state

---

## Component Interaction Diagram

```
                    RespawnController
                          |
        +-----------------+-----------------+
        |                 |                 |
        v                 v                 v
    Session           AiIdleChecker    AiPlanChecker
  (MockSession)     (MockAiIdleChecker) (MockAiPlanChecker)
        |                 |                 |
        v                 |                 |
  Terminal Events        AI Check          AI Check
  (simulateXxx)          Verdicts          Verdicts
        |                 |                 |
        +--------+--------+---------+-------+
                 |
                 v
           State Machine
        (watching -> ... -> stopped)
                 |
                 v
           Event Emission
      (stateChanged, stepSent, etc.)
```

### Data Flow

1. **Terminal Output Flow**:
   - `MockSession.simulateTerminalOutput(data)` -> `session.emit('terminal', data)`
   - RespawnController receives terminal event in `handleTerminalData()`
   - Pattern detection (completion, working, prompt)
   - Timer management (start/reset/cancel)

2. **AI Check Flow**:
   - Pre-filter conditions met -> `tryStartAiCheck()`
   - MockAiIdleChecker returns queued or default verdict
   - Controller processes verdict (IDLE -> start cycle, WORKING -> cooldown)

3. **State Transition Flow**:
   - Internal state changes via `setState()`
   - Events emitted for external monitoring
   - Timers started/cancelled based on state

---

## Mock Components

### MockSession

Enhanced session mock that simulates Claude Code terminal behavior.

**Key Methods**:
- `simulateTerminalOutput(data)` - Raw terminal output
- `simulateCompletionMessage(duration?)` - "Worked for Xm Xs" pattern
- `simulateWorking(text?)` - Spinner/activity indicators
- `simulatePlanModePrompt()` - Numbered selection menu
- `simulateElicitationDialog()` - AskUserQuestion prompt
- `writeBuffer` - Captures all writes for assertions

**Usage**:
```typescript
const session = createMockSession();
session.simulateCompletionMessage();
await waitForState(controller, 'confirming_idle');
```

### MockAiIdleChecker

Mock for AI idle detection that returns configurable verdicts.

**Key Features**:
- Queue-based result system (FIFO)
- Default verdict when queue empty
- Cooldown simulation
- Error/disabled state simulation

**Usage**:
```typescript
const checker = new MockAiIdleChecker('session-id');
checker.setNextIdle('Task completed');
// or
checker.queueResults(
  { verdict: 'WORKING', reasoning: 'Still active', durationMs: 100 },
  { verdict: 'IDLE', reasoning: 'Now idle', durationMs: 150 }
);
```

### MockAiPlanChecker

Mock for AI plan mode detection.

**Key Features**:
- Same queue/default pattern as MockAiIdleChecker
- PLAN_MODE/NOT_PLAN_MODE verdicts
- Cooldown after NOT_PLAN_MODE

**Usage**:
```typescript
const checker = new MockAiPlanChecker('session-id');
checker.setNextPlanMode('Approval prompt detected');
```

### TimeController

Wrapper around Vitest's fake timers for deterministic timing tests.

**Usage**:
```typescript
const time = createTimeController();
// In test:
await time.advanceBy(1000); // Advance 1 second
await time.runAllTimers();  // Run all pending
// In afterEach:
time.useRealTimers();
```

---

## Port Allocation

Integration tests that spawn web servers use unique ports to avoid conflicts.

| Port  | Test File                    | Notes                           |
|-------|------------------------------|----------------------------------|
| 3099  | quick-start.test.ts          | Basic startup tests             |
| 3102  | session.test.ts              | Session lifecycle tests         |
| 3105  | scheduled-runs.test.ts       | Scheduled task tests            |
| 3107  | sse-events.test.ts           | Server-Sent Events tests        |
| 3110  | edge-cases.test.ts           | Edge case handling              |
| 3115  | integration-flows.test.ts    | End-to-end flows                |
| 3120  | session-cleanup.test.ts      | Session cleanup tests           |
| 3125  | ralph-integration.test.ts    | Ralph loop integration          |
| 3127  | *Available*                  | Next integration test           |
| 3128  | *Available*                  | Reserved for respawn integration|
| 3129+ | *Available*                  | Future tests                    |

### Port Usage Guidelines

1. **Unit Tests**: No port needed (MockSession, no real server)
2. **Integration Tests**: Pick next available port (3127+)
3. **Parallel Safety**: `fileParallelism: false` ensures sequential execution

---

## Test Isolation Strategy

### Per-Test Isolation

1. **Fresh Instances**: Each test creates new MockSession, MockAiIdleChecker, RespawnController
2. **No Shared State**: No global variables between tests
3. **Timer Cleanup**: Real timers have short timeouts; fake timers reset between tests

### Per-File Isolation

1. **beforeEach**: Create fresh instances
2. **afterEach**:
   - Call `controller.stop()` to clear timers
   - Reset time controller if using fake timers
   - Clear mock queues

### Cross-File Isolation

1. **Sequential Execution**: `fileParallelism: false` in vitest.config.ts
2. **Screen Session Limits**: Max 10 concurrent (enforced by setup.ts)
3. **Orphan Cleanup**: `afterAll` cleans up any leaked screens

---

## Cleanup Procedures

### During Test Execution

```typescript
afterEach(() => {
  controller.stop();           // Clear all timers
  session.removeAllListeners(); // Remove event handlers
  mockChecker.reset();         // Clear queued results
});
```

### After Test Suite

The global `test/setup.ts` handles:

1. **Screen Cleanup**: Kills any orphaned `codeman-*` screens created during tests
2. **Process Cleanup**: Kills any Claude processes spawned by tests
3. **Pre-existing Protection**: Never kills screens that existed before tests started

### Emergency Cleanup

```typescript
import { forceCleanupAllTestResources } from './setup.js';

// Call if tests fail catastrophically
forceCleanupAllTestResources();
```

---

## Test Categories

### 1. Unit Tests (MockSession-based)

Test the RespawnController state machine without real I/O.

**File**: `test/respawn-controller.test.ts`

**What to Test**:
- State transitions (watching -> confirming_idle -> ai_checking -> ...)
- Timer behavior (completion confirm, no-output fallback)
- Pattern detection (completion message, working patterns)
- Configuration handling
- Event emission

**Example**:
```typescript
it('should transition to ai_checking when pre-filter met', async () => {
  const session = createMockSession();
  const controller = new RespawnController(session, {
    ...FAST_TEST_CONFIG,
    aiIdleCheckEnabled: true,
  });

  controller.start();
  session.simulateCompletionMessage();
  await new Promise(r => setTimeout(r, 100));

  expect(controller.state).toBe('ai_checking');
});
```

### 2. AI Checker Unit Tests

Test MockAiIdleChecker and MockAiPlanChecker behavior.

**File**: `test/ai-idle-checker.test.ts`, `test/ai-plan-checker.test.ts`

**What to Test**:
- Verdict queuing
- Cooldown behavior
- Error handling
- Disabled state

### 3. State Machine Tests

Comprehensive state transition testing.

**File**: `test/respawn-controller.test.ts` (State Machine section)

**What to Test**:
- All state transitions in the diagram
- Skip paths (sendClear: false, sendInit: false)
- Kickstart path
- Interruption handling (working patterns during transitions)

### 4. Integration Tests (if needed)

Full stack tests with real server but mocked Claude CLI.

**Port**: 3128 (reserved)

**What to Test**:
- API endpoints for respawn control
- SSE event broadcasting
- State persistence

---

## Usage Examples

### Basic Test Setup

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { RespawnController } from '../src/respawn-controller.js';
import {
  createMockSession,
  MockAiIdleChecker,
  FAST_TEST_CONFIG,
  createStateTracker,
} from './respawn-test-utils.js';

describe('RespawnController Example', () => {
  let session: MockSession;
  let controller: RespawnController;
  let stateTracker: ReturnType<typeof createStateTracker>;

  beforeEach(() => {
    session = createMockSession();
    controller = new RespawnController(session, FAST_TEST_CONFIG);
    stateTracker = createStateTracker();
    controller.on('stateChanged', stateTracker.record);
  });

  afterEach(() => {
    controller.stop();
  });

  it('should start in watching state', () => {
    controller.start();
    expect(controller.state).toBe('watching');
  });
});
```

### Testing with Mock AI Checker

```typescript
// Note: Currently the RespawnController creates its own AI checkers internally.
// To inject mocks, you would need to modify the controller to accept them,
// or test the mock checkers independently and test the controller with
// aiIdleCheckEnabled: false.

describe('RespawnController with AI Check Disabled', () => {
  it('should fall back to direct idle on completion', async () => {
    const session = createMockSession();
    const controller = new RespawnController(session, {
      ...FAST_TEST_CONFIG,
      aiIdleCheckEnabled: false, // Falls back to timer-based
    });

    let cycleStarted = false;
    controller.on('respawnCycleStarted', () => { cycleStarted = true; });

    controller.start();
    session.simulateCompletionMessage();

    await new Promise(r => setTimeout(r, 200));

    expect(cycleStarted).toBe(true);
  });
});
```

### Testing State Transitions

```typescript
describe('State Transitions', () => {
  it('should track full respawn cycle', async () => {
    const session = createMockSession();
    const controller = new RespawnController(session, {
      ...FAST_TEST_CONFIG,
      sendClear: true,
      sendInit: true,
    });
    const tracker = createStateTracker();
    controller.on('stateChanged', tracker.record);

    controller.start();
    session.simulateCompletionMessage();

    // Wait for full cycle
    await new Promise(r => setTimeout(r, 500));

    expect(tracker.hasVisited('watching')).toBe(true);
    expect(tracker.hasVisited('confirming_idle')).toBe(true);
    expect(tracker.hasVisited('sending_update')).toBe(true);
    expect(tracker.hasVisited('waiting_update')).toBe(true);
  });
});
```

### Testing Event Emission

```typescript
describe('Event Emission', () => {
  it('should emit all lifecycle events', async () => {
    const session = createMockSession();
    const controller = new RespawnController(session, FAST_TEST_CONFIG);
    const recorder = createEventRecorder();

    controller.on('stateChanged', recorder.handler('stateChanged'));
    controller.on('respawnCycleStarted', recorder.handler('respawnCycleStarted'));
    controller.on('stepSent', recorder.handler('stepSent'));

    controller.start();
    session.simulateCompletionMessage();

    await new Promise(r => setTimeout(r, 200));

    expect(recorder.hasEvent('respawnCycleStarted')).toBe(true);
    expect(recorder.hasEvent('stepSent')).toBe(true);
  });
});
```

---

## Future Considerations

### Dependency Injection for AI Checkers

To enable true mock injection, consider modifying RespawnController to accept optional AI checker instances in the constructor:

```typescript
constructor(
  session: Session,
  config: Partial<RespawnConfig> = {},
  aiChecker?: AiIdleChecker,
  planChecker?: AiPlanChecker
) {
  // Use provided checkers or create defaults
  this.aiChecker = aiChecker || new AiIdleChecker(session.id, { ... });
  this.planChecker = planChecker || new AiPlanChecker(session.id, { ... });
}
```

This would allow tests to inject MockAiIdleChecker/MockAiPlanChecker directly.

### Real AI Checker Tests

For testing the real AiIdleChecker and AiPlanChecker (which spawn Claude CLI), create a separate test file with:
- Longer timeouts
- Skip conditions for CI without Claude CLI
- Actual screen session usage

```typescript
describe.skipIf(!process.env.CLAUDE_CLI_AVAILABLE)('Real AI Checkers', () => {
  // Tests that spawn real Claude CLI
});
```
