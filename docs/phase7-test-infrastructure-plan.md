# Phase 7 Implementation Plan: Test Infrastructure

**Source**: `docs/code-structure-findings.md` (Phase 7 — Test Infrastructure)
**Estimated effort**: 2–3 days
**Tasks**: 11 tasks with dependencies (see dependency graph below)

---

## Safety Constraints

Before starting ANY work, read and follow these rules:

1. **Never run `npx vitest run`** (full suite) — it kills tmux sessions. You are running inside a Codeman-managed tmux session.
2. **Run individual tests only**: `npx vitest run test/<file>.test.ts`
3. **Never test on port 3000** — the live dev server runs there. Tests use ports 3150+.
4. **After TypeScript changes**: Run `tsc --noEmit` to verify type checking passes.
5. **Before considering done**: Run `npm run lint` and `npm run format:check` to ensure CI passes.
6. **Never kill tmux sessions** — check `echo $CODEMAN_MUX` first.
7. **Port assignments for this phase**: New tests use ports 3220–3229 (see individual tasks for assignments).

---

## Goal

Eliminate duplicated test mocks, activate the unused `respawn-test-utils.ts` utilities, and add route-level test coverage for the server's 12 route modules — the single largest untested area in the codebase (162 route handlers, 0 dedicated tests).

**Non-goals**:
- Full end-to-end integration tests (those require real Claude CLI / tmux sessions)
- 100% route coverage in this phase — focus on the highest-value route modules first
- Refactoring test patterns in existing passing tests that don't use shared mocks
- Migrating `vi.mock()`-based module replacement mocks (different pattern, see Task 6/7)

---

## Current State

### Mock Duplication (Finding #9)

`MockSession` is defined **4 times** across test files with varying levels of completeness:

| File | Properties | Methods | EventEmitter | Notes |
|------|-----------|---------|-------------|-------|
| `test/respawn-test-utils.ts` | 6 | 20+ | Yes | **Most complete**. Includes terminal simulation, token count, ANSI output, plan mode prompts. **Never imported by any test.** |
| `test/respawn-controller.test.ts` | 6 | 9 | Yes | Subset of respawn-test-utils. Missing token simulation, ANSI helpers. |
| `test/respawn-team-awareness.test.ts` | ~6 | ~9 | Yes | Near-copy of respawn-controller.test.ts version. |
| `test/session-manager.test.ts` | 4 | 8 | Yes | **Inside `vi.mock()` factory** — replaces `../src/session.js` module. Different shape: `start()`/`stop()`/`toState()`/`sendInput()` for lifecycle testing. |

`MockStateStore` is defined **2 times** (both inside `vi.mock()` factories):

| File | Shape | Methods | Mock Pattern |
|------|-------|---------|-------------|
| `test/session-manager.test.ts` | `{ sessions, config }` | `getConfig`, `getSessions`, `getSession`, `setSession`, `removeSession` | `vi.mock('../src/state-store.js')` |
| `test/ralph-loop.test.ts` | `{ ralphLoop, tasks, config }` | `getConfig`, `getRalphLoopState`, `setRalphLoopState`, `getTasks`, `setTask`, `removeTask` | `vi.mock('../src/state-store.js')` |

### Important: Two distinct mocking patterns

The codebase uses two different mocking patterns that require different migration strategies:

1. **Direct instantiation** (respawn-controller, respawn-team-awareness): `MockSession` is defined at file scope and instantiated directly in tests. These can be migrated to shared mocks via simple import replacement.

2. **Module replacement** (session-manager, ralph-loop): Mocks are defined inside `vi.mock()` factories that replace entire modules (`../src/session.js`, `../src/state-store.js`). These factories run in an isolated scope and return `{ Session: MockClass }` or `{ getStore: vi.fn(() => instance) }`. Migrating these requires either `vi.hoisted()` or restructuring the test's module mocking — higher risk for limited benefit.

### Unused Test Utilities

`test/respawn-test-utils.ts` exports these utilities that **no test file imports**:

- `TimeController` / `createTimeController()` — abstraction over vitest fake timers
- `MockAiIdleChecker` / `MockAiPlanChecker` — fully mocked AI checkers with result queueing
- `createStateTracker()` / `createEventRecorder()` — state transition and event recording
- `FAST_TEST_CONFIG` / `AI_ENABLED_TEST_CONFIG` — pre-configured RespawnConfig objects
- `waitForState()` / `waitForEvent()` / `createDeferred()` — async test helpers
- `terminalOutputs` — factory object for common terminal output patterns

### Route Test Coverage

Currently **zero** dedicated tests for the 12 route modules in `src/web/routes/`. The existing test files that touch API endpoints:

| Test File | What It Tests | Approach |
|-----------|--------------|----------|
| `test/api-responses.test.ts` | Response structure validation | Imports types, no HTTP calls |
| `test/api-generate-plan.test.ts` | Plan generation API | Mocks validation logic, Port 3191 declared |
| `test/auth-security.test.ts` | Auth middleware | Integration tests with WebServer, Ports 3160/3161 |
| `test/qr-auth.test.ts` | QR authentication | Integration + unit tests, Port 3162 |

None of these test the route handlers themselves with real HTTP requests against a running Fastify instance.

---

## Design Decisions

### Shared mocks: Superset strategy

Rather than creating a lowest-common-denominator mock, `MockSession` in `test/mocks/` will be the **superset** from `respawn-test-utils.ts` (the most complete version). Test files that need a simpler mock can just ignore the extra methods — having unused methods costs nothing, but missing methods forces local re-definition.

### vi.mock() tests: Don't migrate

The `session-manager.test.ts` and `ralph-loop.test.ts` tests define mocks inside `vi.mock()` factories. These use **module-level replacement** (replacing `../src/session.js` and `../src/state-store.js` entirely), which is fundamentally different from the direct-instantiation pattern. Migrating them would require `vi.hoisted()` or factory restructuring — high complexity for limited benefit since these mocks are already working. We leave these as-is and create the shared mocks for **new** tests and for the two direct-instantiation tests (Tasks 4–5).

### MockStateStore: Union of both shapes

The shared `MockStateStore` in `test/mocks/` will include methods from both existing definitions (session management + Ralph loop), so any **new** test can use it. Methods default to no-ops via `vi.fn()`. Existing `vi.mock()`-based tests are not migrated.

### Route testing strategy: Lightweight Fastify instances

Each route test file will:
1. Create a minimal `Fastify` instance
2. Register **only** the route module under test
3. Provide a mock context object satisfying the port interfaces
4. Use `app.inject()` (Fastify's built-in test helper) — no real HTTP, no port needed

This avoids port conflicts entirely and runs fast. Only tests that need SSE or WebSocket behavior will use a real listening server with assigned ports.

### Port assignments (for tests needing real servers)

| Port | Test File | Purpose |
|------|-----------|---------|
| 3220 | `test/routes/session-routes.test.ts` | SSE integration (if needed) |
| 3221 | `test/routes/system-routes.test.ts` | Status/stats endpoints |
| 3222 | `test/routes/respawn-routes.test.ts` | Respawn API |
| 3223 | `test/routes/ralph-routes.test.ts` | Ralph API |
| 3224–3229 | Reserved | Future route tests |

Most tests should NOT need real ports — `app.inject()` is preferred. Verified: ports 3220–3229 are completely unused by existing tests (highest used port is 3211 in `opencode-resize.test.ts`).

---

## Task Dependencies

```
Task 1 (Consolidate MockSession)
Task 2 (Consolidate MockStateStore)
    └──> Task 3 (Create test/mocks/ barrel)
         ├──> Task 4 (Migrate respawn-controller.test.ts)
         ├──> Task 5 (Migrate respawn-team-awareness.test.ts)
         └──> Task 6 (Route test scaffold + helpers)
              ├──> Task 7 (Session routes tests)
              └──> Task 8 (System + respawn routes tests)

Task 9 (Slim down respawn-test-utils.ts) — depends on Tasks 4, 5
```

**Tasks 1–2** are independent and can run in parallel.
**Task 3** depends on Tasks 1–2.
**Tasks 4–6** depend on Task 3 and can run in parallel.
**Tasks 7–8** depend on Task 6 and can run in parallel.
**Task 9** depends on Tasks 4, 5 (must verify migrations work before removing duplicates from source).

---

## Task 1: Consolidate MockSession into `test/mocks/mock-session.ts`

**Estimated effort**: 2 hours
**Files created**: `test/mocks/mock-session.ts`
**Files modified**: None yet (consumers migrate in Tasks 4–5)

### Source

The canonical MockSession comes from `test/respawn-test-utils.ts` (lines 89–241). It is the most complete version with:

- All properties needed by `RespawnController`: `id`, `workingDir`, `status`, `writeBuffer`, `terminalBuffer`, `muxName`
- `write()` / `writeViaMux()` for input simulation
- Buffer inspection: `lastWrite`, `hasWritten(pattern)`, `clearWriteBuffer()`
- Terminal simulation: `simulateTerminalOutput()`, `simulatePrompt()`, `simulateReady()`, `simulateCompletionMessage()`, `simulateWorking()`, `simulateClearComplete()`, `simulateInitComplete()`, `simulatePlanModePrompt()`, `simulateElicitationDialog()`, `simulateTokenCount()`, `simulateAnsiOutput()`
- Lifecycle: `close()`

### Implementation

1. Create `test/mocks/` directory.
2. Create `test/mocks/mock-session.ts`:
   - Copy the `MockSession` class **exactly** from `test/respawn-test-utils.ts` (lines 89–241)
   - Copy `terminalOutputs` helper object (tightly coupled to mock)
   - Copy `createMockSession()` factory function
   - Export all three: `export { MockSession, createMockSession, terminalOutputs }`
   - Ensure all `vi` imports come from `vitest`

**CRITICAL**: Copy the source verbatim — do NOT rewrite the simulation methods. The respawn controller's detection logic matches specific output patterns (e.g., `'\u276f '` for prompt, `'\u273b Worked for'` for completion). Using different patterns would cause test failures.

### Template

```typescript
/**
 * Shared MockSession for tests that need terminal simulation.
 *
 * Copied from test/respawn-test-utils.ts (the canonical, most complete version).
 * Used by respawn, route, and subagent tests.
 */
import { EventEmitter } from 'node:events';

// Copy MockSession class exactly from test/respawn-test-utils.ts lines 89–241
export class MockSession extends EventEmitter {
  // ... (copy verbatim from respawn-test-utils.ts)
}

/**
 * Factory for common terminal output strings.
 * Must match the patterns used in MockSession's simulate* methods.
 */
export const terminalOutputs = {
  // ... (copy verbatim from respawn-test-utils.ts)
};

/**
 * Convenience factory.
 */
export function createMockSession(id?: string): MockSession {
  return new MockSession(id);
}
```

### Verification

```bash
tsc --noEmit  # Ensure file compiles
```

---

## Task 2: Consolidate MockStateStore into `test/mocks/mock-state-store.ts`

**Estimated effort**: 1 hour
**Files created**: `test/mocks/mock-state-store.ts`
**Files modified**: None (existing vi.mock()-based tests are NOT migrated; this is for new route tests)

### Source

Union of both existing definitions:

- From `test/session-manager.test.ts`: session CRUD methods (`getConfig`, `getSession`, `setSession`, `removeSession`, `getSessions`)
- From `test/ralph-loop.test.ts`: Ralph state methods (`getConfig`, `getRalphLoopState`, `setRalphLoopState`, `getTasks`, `setTask`, `removeTask`)

### Template

```typescript
/**
 * Shared MockStateStore for tests.
 *
 * Includes methods for both session management and Ralph loop testing.
 * All methods are vi.fn() spies — tests can override return values as needed.
 *
 * NOTE: This is for direct instantiation in new tests. Existing tests that
 * use vi.mock('../src/state-store.js') keep their inline definitions.
 */
import { vi } from 'vitest';

export class MockStateStore {
  state: Record<string, unknown> = {
    sessions: {} as Record<string, unknown>,
    config: { maxConcurrentSessions: 5 },
    ralphLoop: { status: 'stopped' },
    tasks: {} as Record<string, unknown>,
  };

  // Session methods
  getConfig = vi.fn(() => this.state.config);
  getSessions = vi.fn(() => this.state.sessions as Record<string, unknown>);
  getSession = vi.fn((id: string) => (this.state.sessions as Record<string, unknown>)[id]);
  setSession = vi.fn((id: string, state: unknown) => {
    (this.state.sessions as Record<string, unknown>)[id] = state;
  });
  removeSession = vi.fn((id: string) => {
    delete (this.state.sessions as Record<string, unknown>)[id];
  });

  // Ralph state methods
  getRalphLoopState = vi.fn(() => this.state.ralphLoop);
  setRalphLoopState = vi.fn((update: Record<string, unknown>) => {
    this.state.ralphLoop = { ...(this.state.ralphLoop as Record<string, unknown>), ...update };
  });

  // Task methods
  getTasks = vi.fn(() => this.state.tasks);
  setTask = vi.fn();
  removeTask = vi.fn();

  // Settings methods
  getSettings = vi.fn(() => ({}));
  setSettings = vi.fn();

  // Generic persistence
  save = vi.fn();
  load = vi.fn();

  /** Reset all state and mocks for clean test isolation */
  reset(): void {
    this.state = {
      sessions: {},
      config: { maxConcurrentSessions: 5 },
      ralphLoop: { status: 'stopped' },
      tasks: {},
    };
    vi.clearAllMocks();
  }
}
```

### Verification

```bash
tsc --noEmit
```

---

## Task 3: Create `test/mocks/index.ts` barrel export

**Estimated effort**: 30 minutes
**Depends on**: Tasks 1, 2
**Files created**: `test/mocks/index.ts`, `test/mocks/test-helpers.ts`
**Files modified**: None

### Implementation

1. Create `test/mocks/test-helpers.ts` with the async utilities from `respawn-test-utils.ts`:

```typescript
/**
 * Reusable async test helpers.
 * Extracted from respawn-test-utils.ts.
 */

/** Wait for an EventEmitter to emit a specific event, with timeout */
export function waitForEvent(
  emitter: { once: (event: string, listener: (...args: unknown[]) => void) => void },
  event: string,
  timeoutMs = 5000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for event "${event}" after ${timeoutMs}ms`)),
      timeoutMs,
    );
    emitter.once(event, (...args: unknown[]) => {
      clearTimeout(timer);
      resolve(args.length === 1 ? args[0] : args);
    });
  });
}

/** Create a deferred promise with external resolve/reject */
export function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
```

2. Create `test/mocks/index.ts` barrel:

```typescript
/**
 * Shared test mocks — import from here instead of defining inline.
 *
 * @example
 * import { MockSession, MockStateStore, terminalOutputs } from './mocks/index.js';
 */

export { MockSession, createMockSession, terminalOutputs } from './mock-session.js';
export { MockStateStore } from './mock-state-store.js';
export { waitForEvent, createDeferred } from './test-helpers.js';
```

### Verification

```bash
tsc --noEmit
```

---

## Task 4: Migrate `respawn-controller.test.ts` to shared mocks

**Estimated effort**: 30 minutes
**Depends on**: Task 3
**Files modified**: `test/respawn-controller.test.ts`

### Steps

1. Remove the local `MockSession` class definition (approx. 50 lines).
2. Add: `import { MockSession } from './mocks/index.js';`
3. Verify all test methods still exist on the shared mock. The shared mock is a superset, so all existing usage should work.
4. If the local mock had any test-specific customizations (e.g., extra properties added in `beforeEach`), keep those in the test file as inline assignments on the shared instance.
5. Run the test to confirm it passes.

### Potential issues

- The local mock's `simulateCompletionMessage()` may have a slightly different output format than the shared mock's (from respawn-test-utils.ts). Verify the respawn controller's completion detection regex matches the shared mock's output pattern (`'\u273b Worked for ...'`).
- If the local mock adds `pid` or `isWorking` properties that the shared mock doesn't have, add inline assignments in `beforeEach`.

### Verification

```bash
npx vitest run test/respawn-controller.test.ts
```

---

## Task 5: Migrate `respawn-team-awareness.test.ts` to shared mocks

**Estimated effort**: 30 minutes
**Depends on**: Task 3
**Files modified**: `test/respawn-team-awareness.test.ts`

### Steps

1. Remove the local `MockSession` class definition.
2. Add: `import { MockSession } from './mocks/index.js';`
3. Keep `MockTeamWatcher` in this file — it's test-specific and extends the real `TeamWatcher`, not a general-purpose mock.
4. Run the test to confirm it passes.

### Verification

```bash
npx vitest run test/respawn-team-awareness.test.ts
```

---

## Task 6: Create route test scaffold and helpers

**Estimated effort**: 2 hours
**Depends on**: Task 3
**Files created**: `test/mocks/mock-route-context.ts`, `test/routes/` directory, `test/routes/_route-test-utils.ts`

### Problem

The 12 route modules in `src/web/routes/` have zero dedicated test coverage. Each route module takes `(app: FastifyInstance, ctx: PortIntersection)` — we need a reusable way to create mock context objects that satisfy the port interfaces.

### Design

Create a `MockRouteContext` factory that builds a mock object satisfying all port interfaces. Each port's methods are `vi.fn()` stubs. Tests can override specific methods as needed.

### Route registration signatures (verified)

Each route module requires a specific port intersection. The mock must satisfy all of them:

| Route Module | Required Ports |
|-------------|----------------|
| `registerSessionRoutes` | `SessionPort & EventPort & ConfigPort & InfraPort & AuthPort` |
| `registerSystemRoutes` | `SessionPort & EventPort & ConfigPort & InfraPort & AuthPort` |
| `registerRespawnRoutes` | `SessionPort & EventPort & RespawnPort & ConfigPort & InfraPort` |
| `registerRalphRoutes` | `SessionPort & EventPort & RespawnPort & ConfigPort & InfraPort` |
| `registerPlanRoutes` | `SessionPort & EventPort & ConfigPort & InfraPort` |
| `registerCaseRoutes` | `EventPort & ConfigPort` |
| `registerScheduledRoutes` | `SessionPort & EventPort & InfraPort` |
| `registerFileRoutes` | `SessionPort` |
| `registerMuxRoutes` | `InfraPort` |
| `registerPushRoutes` | `InfraPort` |
| `registerTeamRoutes` | `InfraPort` |
| `registerHookEventRoutes` | `EventPort & AuthPort` |

### Implementation

1. Create `test/mocks/mock-route-context.ts`:

```typescript
/**
 * Mock context for route handler testing.
 *
 * Satisfies ALL port interfaces (SessionPort, EventPort, RespawnPort,
 * ConfigPort, InfraPort, AuthPort) so any route module can be tested.
 * Override specific methods in individual tests as needed.
 *
 * Verified against actual port interfaces in src/web/ports/:
 * - SessionPort: 6 methods (sessions, addSession, cleanupSession,
 *   setupSessionListeners, persistSessionState, persistSessionStateNow,
 *   getSessionStateWithRespawn)
 * - EventPort: 5 methods (broadcast, sendPushNotifications, batchTerminalData,
 *   broadcastSessionStateDebounced, batchTaskUpdate)
 * - RespawnPort: 2 maps + 4 methods
 * - ConfigPort: 5 readonly + 7 methods (incl getDefaultClaudeMdPath,
 *   getLightState, getLightSessionsState, stopTranscriptWatcher)
 * - InfraPort: 7 readonly + 2 methods (startScheduledRun, stopScheduledRun)
 * - AuthPort: 3 readonly (authSessions, qrAuthFailures, https)
 */
import { vi } from 'vitest';
import { MockSession, createMockSession } from './mock-session.js';

/**
 * Creates a mock context that satisfies all port interfaces.
 * Pre-populated with one session for convenience.
 */
export function createMockRouteContext(options?: { sessionId?: string }) {
  const sessionId = options?.sessionId ?? 'test-session-1';
  const session = createMockSession(sessionId);
  const sessions = new Map<string, MockSession>();
  sessions.set(sessionId, session);

  return {
    // -- SessionPort --
    sessions,
    addSession: vi.fn(),
    cleanupSession: vi.fn(),
    setupSessionListeners: vi.fn(),
    persistSessionState: vi.fn(),
    persistSessionStateNow: vi.fn(),
    getSessionStateWithRespawn: vi.fn((s: unknown) => s),

    // -- EventPort --
    broadcast: vi.fn(),
    sendPushNotifications: vi.fn(),
    batchTerminalData: vi.fn(),
    broadcastSessionStateDebounced: vi.fn(),
    batchTaskUpdate: vi.fn(),

    // -- RespawnPort --
    respawnControllers: new Map(),
    respawnTimers: new Map(),
    setupRespawnListeners: vi.fn(),
    setupTimedRespawn: vi.fn(),
    restoreRespawnController: vi.fn(),
    saveRespawnConfig: vi.fn(),

    // -- ConfigPort --
    store: {
      getConfig: vi.fn(() => ({})),
      getSessions: vi.fn(() => ({})),
      getSession: vi.fn(),
      setSession: vi.fn(),
      removeSession: vi.fn(),
      getSettings: vi.fn(() => ({})),
      setSettings: vi.fn(),
      getRalphLoopState: vi.fn(() => ({})),
      setRalphLoopState: vi.fn(),
      getTasks: vi.fn(() => ({})),
      save: vi.fn(),
      load: vi.fn(),
    },
    port: 3000,
    https: false,
    testMode: true,
    serverStartTime: Date.now(),
    getGlobalNiceConfig: vi.fn(async () => undefined),
    getModelConfig: vi.fn(async () => null),
    getClaudeModeConfig: vi.fn(async () => ({})),
    getDefaultClaudeMdPath: vi.fn(async () => undefined),
    getLightState: vi.fn(() => ({ sessions: [], status: 'ok' })),
    getLightSessionsState: vi.fn(() => []),
    startTranscriptWatcher: vi.fn(),
    stopTranscriptWatcher: vi.fn(),

    // -- InfraPort --
    mux: {
      createSession: vi.fn(),
      killSession: vi.fn(),
      listSessions: vi.fn(() => []),
      getStats: vi.fn(() => ({})),
    },
    runSummaryTrackers: new Map(),
    activePlanOrchestrators: new Map(),
    scheduledRuns: new Map(),
    teamWatcher: { getTeams: vi.fn(() => []), hasActiveTeammates: vi.fn(() => false) },
    tunnelManager: null,
    pushStore: null,
    startScheduledRun: vi.fn(),
    stopScheduledRun: vi.fn(),

    // -- AuthPort --
    authSessions: null,
    qrAuthFailures: null,
    // https already declared above in ConfigPort (shared property)

    // Convenience accessors (not part of any port interface)
    _session: session,
    _sessionId: sessionId,
  };
}

export type MockRouteContext = ReturnType<typeof createMockRouteContext>;
```

2. Add to `test/mocks/index.ts` barrel:

```typescript
export { createMockRouteContext, type MockRouteContext } from './mock-route-context.js';
```

3. Create `test/routes/` directory for route test files.

4. Create `test/routes/_route-test-utils.ts` with Fastify test helpers:

```typescript
/**
 * Shared utilities for route testing.
 *
 * Creates minimal Fastify instances with just the route module under test
 * and a mock context. Uses app.inject() for HTTP testing without real ports.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';

export interface RouteTestHarness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

/**
 * Creates a Fastify instance with a route module registered against a mock context.
 *
 * @param registerFn - The route registration function (e.g., registerSessionRoutes).
 *   Uses `any` for ctx parameter because route functions expect typed port intersections
 *   that MockRouteContext satisfies structurally but not nominally.
 * @param ctxOptions - Optional overrides for the mock context
 */
export async function createRouteTestHarness(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerFn: (app: FastifyInstance, ctx: any) => void,
  ctxOptions?: { sessionId?: string },
): Promise<RouteTestHarness> {
  const app = Fastify({ logger: false });
  const ctx = createMockRouteContext(ctxOptions);

  registerFn(app, ctx);
  await app.ready();

  return { app, ctx };
}
```

### Why `ctx: any` in the harness

Route registration functions like `registerSessionRoutes(app, ctx: SessionPort & EventPort & ConfigPort & InfraPort & AuthPort)` expect specific port intersection types. TypeScript won't accept `unknown` here because it's not assignable to the port types. The `MockRouteContext` satisfies the interfaces structurally (it has all the required properties and methods), but since it's not declared as implementing them, we need `any` at the call site. This is the standard pattern for test mocks in TypeScript.

### Verification

```bash
tsc --noEmit
```

---

## Task 7: Add session routes tests

**Estimated effort**: 4 hours
**Depends on**: Task 6
**Files created**: `test/routes/session-routes.test.ts`
**Port**: 3220 (only if SSE tests needed; prefer `app.inject()`)

### Coverage targets

`src/web/routes/session-routes.ts` is the largest route module (43 handlers). Focus on the most critical endpoints first:

#### Priority 1: Session CRUD (must test)

| Method | Path | What to test |
|--------|------|-------------|
| `GET` | `/api/sessions` | Returns session list; empty when no sessions |
| `GET` | `/api/sessions/:id` | Returns session state; 404 for unknown ID |
| `POST` | `/api/sessions` | Creates session; validates workingDir; rejects invalid paths |
| `DELETE` | `/api/sessions/:id` | Calls cleanupSession; 404 for unknown ID |

#### Priority 2: Session I/O

| Method | Path | What to test |
|--------|------|-------------|
| `POST` | `/api/sessions/:id/input` | Sends input to session; validates input length; 404 for unknown |
| `POST` | `/api/sessions/:id/resize` | Validates cols/rows bounds; 404 for unknown |
| `GET` | `/api/sessions/:id/buffer` | Returns terminal buffer; 404 for unknown |

#### Priority 3: Session actions

| Method | Path | What to test |
|--------|------|-------------|
| `POST` | `/api/sessions/:id/run` | Runs prompt on session |
| `POST` | `/api/sessions/:id/clear` | Clears session |
| `POST` | `/api/sessions/:id/compact` | Compacts session |
| `POST` | `/api/sessions/:id/interactive` | Starts interactive mode |
| `POST` | `/api/sessions/:id/quick-start` | Quick start flow |

### Test pattern

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';

describe('session-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerSessionRoutes);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  describe('GET /api/sessions', () => {
    it('returns empty array when no sessions', async () => {
      harness.ctx.sessions.clear();
      const res = await harness.app.inject({ method: 'GET', url: '/api/sessions' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual([]);
    });

    it('returns session list with one session', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/sessions' });
      expect(res.statusCode).toBe(200);
      const sessions = JSON.parse(res.body);
      expect(sessions).toHaveLength(1);
    });
  });

  describe('GET /api/sessions/:id', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent',
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/sessions/:id/input', () => {
    it('rejects input exceeding max length', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/input`,
        payload: { input: 'x'.repeat(65537) },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('POST /api/sessions/:id/resize', () => {
    it('rejects cols exceeding max', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 501, rows: 24 },
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
```

### Key assertions to include

- **404 for unknown sessions**: Every `:id` endpoint must return 404 for nonexistent IDs
- **Input validation**: Bad paths, oversized inputs, invalid resize dimensions
- **Side effects**: Verify `ctx.broadcast()` was called with correct event type after mutations
- **Response shape**: Verify response bodies match expected API types

### Verification

```bash
npx vitest run test/routes/session-routes.test.ts
```

---

## Task 8: Add system + respawn routes tests

**Estimated effort**: 4 hours
**Depends on**: Task 6
**Files created**: `test/routes/system-routes.test.ts`, `test/routes/respawn-routes.test.ts`

### System routes (`src/web/routes/system-routes.ts`)

Focus on status and configuration endpoints:

| Method | Path | What to test |
|--------|------|-------------|
| `GET` | `/api/status` | Returns server status with uptime, session count |
| `GET` | `/api/stats` | Returns mux stats |
| `GET` | `/api/config` | Returns current config |
| `PUT` | `/api/config` | Updates config; validates input |
| `GET` | `/api/settings` | Returns user settings |
| `PUT` | `/api/settings` | Updates settings; validates input |
| `GET` | `/api/subagents` | Returns subagent list |
| `GET` | `/api/screenshots` | Returns screenshot list |

### Respawn routes (`src/web/routes/respawn-routes.ts`)

| Method | Path | What to test |
|--------|------|-------------|
| `GET` | `/api/sessions/:id/respawn` | Returns respawn status; null when not configured |
| `POST` | `/api/sessions/:id/respawn/start` | Starts respawn; 404 for unknown session |
| `POST` | `/api/sessions/:id/respawn/stop` | Stops respawn; 404 for unknown session |
| `PUT` | `/api/sessions/:id/respawn/config` | Updates respawn config; validates |
| `POST` | `/api/sessions/:id/respawn/enable` | Enables respawn loop |
| `POST` | `/api/sessions/:id/respawn/disable` | Disables respawn loop |

### Test patterns

Same pattern as Task 7 — `createRouteTestHarness` with `registerSystemRoutes` / `registerRespawnRoutes`.

For respawn tests, pre-populate `ctx.respawnControllers` with a mock controller in `beforeEach`:

```typescript
beforeEach(async () => {
  harness = await createRouteTestHarness(registerRespawnRoutes);
  // Add a mock respawn controller for the default session
  harness.ctx.respawnControllers.set(harness.ctx._sessionId, {
    getState: vi.fn(() => 'idle'),
    getConfig: vi.fn(() => ({})),
    getStatus: vi.fn(() => ({ state: 'idle', health: 100 })),
    start: vi.fn(),
    stop: vi.fn(),
    updateConfig: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
  });
});
```

### Verification

```bash
npx vitest run test/routes/system-routes.test.ts
npx vitest run test/routes/respawn-routes.test.ts
```

---

## Task 9: Slim down `respawn-test-utils.ts`

**Estimated effort**: 30 minutes
**Depends on**: Tasks 4, 5
**Files modified**: `test/respawn-test-utils.ts`

After Tasks 4–5 are verified passing with shared mocks, slim down `respawn-test-utils.ts` to remove duplicates.

### Steps

1. **Remove** from `respawn-test-utils.ts` what has been moved to shared mocks:
   - `MockSession` class → now in `test/mocks/mock-session.ts`
   - `createMockSession()` → now in `test/mocks/mock-session.ts`
   - `terminalOutputs` → now in `test/mocks/mock-session.ts`
   - `waitForEvent()` / `createDeferred()` → now in `test/mocks/test-helpers.ts`

2. **Keep** respawn-specific utilities that don't belong in the general mocks:
   - `TimeController` / `createTimeController()` — respawn-specific timer control
   - `MockAiIdleChecker` / `MockAiPlanChecker` — respawn-specific AI mocks
   - `createStateTracker()` / `createEventRecorder()` — respawn state tracking
   - `FAST_TEST_CONFIG` / `AI_ENABLED_TEST_CONFIG` — respawn config presets
   - `waitForState()` — respawn state machine waiter

3. **Update imports** in `respawn-test-utils.ts` to re-use shared mocks:
   ```typescript
   import { MockSession, createMockSession, terminalOutputs } from './mocks/index.js';
   import { waitForEvent, createDeferred } from './mocks/index.js';
   export { MockSession, createMockSession, terminalOutputs, waitForEvent, createDeferred };
   ```

This preserves backward compatibility for any future tests that import from `respawn-test-utils.ts` directly while eliminating the duplication.

### Verification

```bash
tsc --noEmit
npx vitest run test/respawn-controller.test.ts
npx vitest run test/respawn-team-awareness.test.ts
```

---

## What is NOT in scope (and why)

### Migrating `session-manager.test.ts` and `ralph-loop.test.ts` mocks

Both files define mocks inside `vi.mock()` factories that replace entire modules:

```typescript
// session-manager.test.ts — mock replaces ../src/session.js
vi.mock('../src/session.js', () => {
  class MockSession extends EventEmitter { ... }
  return { Session: MockSession };
});

// ralph-loop.test.ts — mock replaces ../src/state-store.js
vi.mock('../src/state-store.js', () => {
  class MockStateStore { ... }
  return { getStore: vi.fn(() => instance), StateStore: MockStateStore };
});
```

These are fundamentally different from the direct-instantiation pattern:
- The `vi.mock()` factory runs in an isolated scope — outer imports are not available
- The mock class must be returned with the exact export names (`Session`, `getStore`, `StateStore`)
- The `session-manager.test.ts` MockSession auto-registers into a shared `mockState.sessions` Map (tight coupling with test setup)

Migrating would require `vi.hoisted()` to share the class between factory and test scope, plus restructuring the test's module-mocking setup. This is high-complexity, high-risk refactoring with limited benefit since these tests already work. The shared `MockStateStore` in `test/mocks/` is available for **new** tests (like route tests) that use direct instantiation instead.

### Full integration tests with real Fastify server

Route tests use `app.inject()` which simulates HTTP without opening ports. Full integration tests that spin up `WebServer`, create real sessions, and stream SSE would be valuable but are a separate effort requiring:
- A test WebServer factory
- Session lifecycle management in tests
- SSE client test utilities
- Significantly more setup/teardown complexity

### Testing auth middleware in route tests

Route tests bypass authentication (no auth middleware registered on the test Fastify instance). Auth middleware has its own dedicated tests in `auth-security.test.ts` and `qr-auth.test.ts`. Testing auth + routes together is a future integration test concern.

### Testing SSE event streaming

SSE integration requires a running server with `EventSource` client. This is significantly more complex than `app.inject()` tests and is deferred. The existing `sse-events.test.ts` covers SSE patterns.

### Complete route coverage for all 12 modules

This phase covers the 3 highest-value route modules (session, system, respawn — 98 of 162 handlers). The remaining 9 modules (ralph, plan, push, team, mux, file, scheduled, hook-event, case) should be added incrementally in follow-up work.

---

## Summary

| Metric | Before | After |
|--------|--------|-------|
| MockSession definitions | 4 (across 4 files) | 1 shared (2 vi.mock() copies remain, intentionally) |
| MockStateStore definitions | 2 (across 2 files) | 1 shared (2 vi.mock() copies remain, intentionally) |
| Files importing from `respawn-test-utils.ts` | 0 | Utilities split into `test/mocks/` |
| Route test files | 0 | 3 (session, system, respawn) |
| Route handlers with dedicated tests | 0 | ~30 (highest-priority endpoints) |
| Shared mock directory | None | `test/mocks/` with 5 files + barrel |

### Final verification checklist

```bash
# Type checking
tsc --noEmit

# Linting
npm run lint

# Formatting
npm run format:check

# Run all affected tests individually
npx vitest run test/respawn-controller.test.ts
npx vitest run test/respawn-team-awareness.test.ts
npx vitest run test/routes/session-routes.test.ts
npx vitest run test/routes/system-routes.test.ts
npx vitest run test/routes/respawn-routes.test.ts

# Verify unchanged tests still pass
npx vitest run test/session-manager.test.ts
npx vitest run test/ralph-loop.test.ts

# Dev server still starts
npx tsx src/index.ts web --port 3099 &
curl -s http://localhost:3099/api/status | jq .status  # "ok"
kill %1
```
