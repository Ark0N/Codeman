# Phase 3 Implementation Plan: server.ts Route Extraction

**Source**: `docs/code-structure-findings.md` (Phase 3 — server.ts Route Extraction)
**Estimated effort**: 3-4 days
**Tasks**: 8 tasks with dependencies (see dependency graph below)

---

## Safety Constraints

Before starting ANY work, read and follow these rules:

1. **Never run `npx vitest run`** (full suite) — it kills tmux sessions. You are running inside a Codeman-managed tmux session.
2. **Run individual tests only**: `npx vitest run test/<file>.test.ts`
3. **Never test on port 3000** — the live dev server runs there. Tests use ports 3150+.
4. **After TypeScript changes**: Run `tsc --noEmit` to verify type checking passes.
5. **Before considering done**: Run `npm run lint` and `npm run format:check` to ensure CI passes.
6. **Never kill tmux sessions** — check `echo $CODEMAN_MUX` first.
7. **Verify the dev server starts**: After each task, run `npx tsx src/index.ts web --port 3099 &` on a non-production port, confirm `curl -s http://localhost:3099/api/status | jq .status` returns `"ok"`, then kill the background process. This is essential — there are zero server.ts tests.

---

## Goal

Reduce `src/web/server.ts` from ~6,710 LOC to ~1,500 LOC by extracting route handlers into domain-specific route modules, auth logic into middleware, and SSE/batching into service modules. The WebServer class retains orchestration (start/stop, session lifecycle, listener wiring) but delegates all HTTP route definitions to separate files.

---

## Task Dependencies

```
Task 1 (RouteContext interface)
  ├──> Task 2 (Auth middleware)
  ├──> Task 3 (Session routes)
  ├──> Task 4 (Respawn routes)
  ├──> Task 5 (Subagent + mux + team routes)
  ├──> Task 6 (Plan + case + ralph routes)
  ├──> Task 7 (System + settings + push + misc routes)
  └──> Task 8 (Final cleanup — reduce server.ts)
```

**Task 1** must complete first — it defines the shared interface all route modules use to access server state.
**Tasks 2-7** are independent and can run in parallel.
**Task 8** depends on all prior tasks.

---

## Target Directory Structure

```
src/web/
├── server.ts                  (~1,500 LOC — orchestration, start/stop, listeners, SSE infra)
├── route-context.ts           (~80 LOC — RouteContext interface + helpers)
├── middleware/
│   └── auth.ts                (~120 LOC — Basic Auth + session cookies + rate limiting)
├── routes/
│   ├── session-routes.ts      (~800 LOC — CRUD, input, resize, terminal buffer, auto-ops)
│   ├── respawn-routes.ts      (~400 LOC — status, config, start/stop, enable, interactive)
│   ├── subagent-routes.ts     (~250 LOC — list, transcript, kill, cleanup, window states)
│   ├── plan-routes.ts         (~500 LOC — generate, detailed, cancel, tasks, checkpoint, rollback)
│   ├── case-routes.ts         (~400 LOC — CRUD, link, fix-plan, ralph wizard)
│   ├── ralph-routes.ts        (~450 LOC — config, status, circuit-breaker, fix-plan, prompts, loop start)
│   ├── system-routes.ts       (~350 LOC — status, stats, config, debug, lifecycle, settings, model)
│   ├── file-routes.ts         (~400 LOC — file tree, preview, raw, tail, screenshots)
│   ├── push-routes.ts         (~100 LOC — VAPID key, subscribe, update prefs, unsubscribe)
│   ├── mux-routes.ts          (~80 LOC — list, delete, reconcile, stats)
│   ├── team-routes.ts         (~50 LOC — list teams, team tasks)
│   └── scheduled-routes.ts    (~120 LOC — CRUD for scheduled runs, quick-start, quick-run)
└── schemas.ts                 (existing — unchanged)
```

---

## Key Design Decision: RouteContext Pattern

Routes need access to server state (sessions, respawn controllers, store, mux, etc.) without importing WebServer directly. We use a **context object pattern** where the WebServer exposes a `RouteContext` interface that route modules receive.

This avoids:
- Circular dependencies (routes importing server, server importing routes)
- Exposing all 40+ private WebServer fields
- Making route modules aware of server internals

Each route module exports a `register(app, ctx)` function that Fastify calls during setup.

### Why NOT Fastify plugins/decorators

Fastify plugins with `fastify.decorate()` would work but:
- Requires TypeScript module augmentation for type safety (brittle)
- Each decorator is on the Fastify instance, not a typed interface — easy to misspell
- The context pattern is simpler, standard in large Fastify apps, and plays well with `strictNullChecks`

---

## Task 1: Create RouteContext Interface

**Files to create**: `src/web/route-context.ts`
**Files to edit**: `src/web/server.ts`
**Time**: ~2 hours

### Problem

Route modules need access to server state (sessions, controllers, store) and helper methods (broadcast, persistSessionState, cleanupSession). A typed interface provides this without coupling routes to WebServer internals.

### Implementation

Create `src/web/route-context.ts` that defines the interface:

```typescript
/**
 * @fileoverview Shared context interface for route modules.
 *
 * Route handlers receive a RouteContext to access server state and
 * helper methods without directly depending on the WebServer class.
 *
 * @module web/route-context
 */

import type { FastifyInstance } from 'fastify';
import type { Session } from '../session.js';
import type { RespawnController, RespawnConfig } from '../respawn-controller.js';
import type { TerminalMultiplexer } from '../mux-interface.js';
import type { StateStore } from '../state-store.js';
import type { PlanOrchestrator } from '../plan-orchestrator.js';
import type { RunSummaryTracker } from '../run-summary.js';
import type { TranscriptWatcher } from '../transcript-watcher.js';
import type { TeamWatcher } from '../team-watcher.js';
import type { TunnelManager } from '../tunnel-manager.js';
import type { PushSubscriptionStore } from '../push-store.js';
import type {
  ApiErrorCode,
  ApiResponse,
  PersistedRespawnConfig,
  NiceConfig,
} from '../types.js';

/**
 * Context object passed to route modules.
 * Provides access to server state and helper methods.
 */
export interface RouteContext {
  // === Core State ===
  readonly sessions: Map<string, Session>;
  readonly respawnControllers: Map<string, RespawnController>;
  readonly respawnTimers: Map<string, { timer: NodeJS.Timeout; endAt: number; startedAt: number }>;
  readonly runSummaryTrackers: Map<string, RunSummaryTracker>;
  readonly activePlanOrchestrators: Map<string, PlanOrchestrator>;
  readonly scheduledRuns: Map<string, ScheduledRun>; // Type imported from server.ts or moved
  readonly store: StateStore;
  readonly mux: TerminalMultiplexer;
  readonly teamWatcher: TeamWatcher;
  readonly tunnelManager: TunnelManager;
  readonly pushStore: PushSubscriptionStore;

  // === Config ===
  readonly port: number;
  readonly https: boolean;
  readonly testMode: boolean;
  readonly serverStartTime: number;

  // === Methods ===

  /** Broadcast an SSE event to all connected clients */
  broadcast(event: string, data: unknown): void;

  /** Debounced session state persistence */
  persistSessionState(session: Session): void;

  /** Immediate session state persistence */
  persistSessionStateNow(session: Session): void;

  /** Clean up all resources for a session */
  cleanupSession(sessionId: string, killMux?: boolean, reason?: string): Promise<void>;

  /** Set up event listeners for a session */
  setupSessionListeners(session: Session): void;

  /** Remove all event listeners for a session */
  removeSessionListeners(sessionId: string): void;

  /** Set up respawn controller event listeners */
  setupRespawnListeners(sessionId: string, controller: RespawnController): void;

  /** Set up a timed respawn duration */
  setupTimedRespawn(sessionId: string, durationMinutes: number): void;

  /** Restore a respawn controller from persisted config */
  restoreRespawnController(session: Session, config: PersistedRespawnConfig, source: string): void;

  /** Save respawn config to mux metadata */
  saveRespawnConfig(sessionId: string, config: RespawnConfig, durationMinutes?: number): void;

  /** Start transcript watcher for a session */
  startTranscriptWatcher(sessionId: string, transcriptPath: string): void;

  /** Stop transcript watcher for a session */
  stopTranscriptWatcher(sessionId: string): void;

  /** Get session state enriched with respawn info */
  getSessionStateWithRespawn(session: Session): unknown;

  /** Get default CLAUDE.md template path from settings */
  getDefaultClaudeMdPath(): Promise<string | undefined>;

  /** Batch terminal data for 60fps streaming */
  batchTerminalData(sessionId: string, data: string): void;

  /** Broadcast debounced session state update */
  broadcastSessionStateDebounced(sessionId: string): void;

  /** Batch a task update for SSE broadcasting */
  batchTaskUpdate(sessionId: string, task: unknown): void;

  // === Config Getters (used by session create, quick-start, ralph-loop, plan routes) ===

  /** Get global nice/ionice config from settings */
  getGlobalNiceConfig(): Promise<NiceConfig | undefined>;

  /** Get model config (defaultModel, etc.) from settings */
  getModelConfig(): Promise<{ defaultModel?: string } | undefined>;

  /** Get Claude mode config (claudeMode, allowedTools) from settings */
  getClaudeModeConfig(): Promise<{ claudeMode?: string; allowedTools?: string[] }>;

  // === Scheduling (used by scheduled-routes) ===

  /** Start a scheduled run (creates session, runs prompt, manages lifecycle) */
  startScheduledRun(prompt: string, workingDir: string, durationMinutes: number): Promise<ScheduledRun>;

  /** Stop a scheduled run by ID */
  stopScheduledRun(id: string): Promise<void>;

  // === Notifications (used by hook-event route) ===

  /** Send push notifications to all subscribed clients */
  sendPushNotifications(event: string, data: Record<string, unknown>): void;
}

/**
 * Signature for a route registration function.
 * Each route module exports a function with this signature.
 */
export type RegisterRoutes = (app: FastifyInstance, ctx: RouteContext) => void;
```

### Expose context from WebServer

In `server.ts`, add a private method that creates the context object. This is called once during `setupRoutes()` and passed to each route module:

```typescript
private createRouteContext(): RouteContext {
  return {
    sessions: this.sessions,
    respawnControllers: this.respawnControllers,
    respawnTimers: this.respawnTimers,
    runSummaryTrackers: this.runSummaryTrackers,
    activePlanOrchestrators: this.activePlanOrchestrators,
    scheduledRuns: this.scheduledRuns,
    store: this.store,
    mux: this.mux,
    teamWatcher: this.teamWatcher,
    tunnelManager: this.tunnelManager,
    pushStore: this.pushStore,
    port: this.port,
    https: this.https,
    testMode: this.testMode,
    serverStartTime: this.serverStartTime,
    broadcast: this.broadcast.bind(this),
    persistSessionState: this.persistSessionState.bind(this),
    persistSessionStateNow: this._persistSessionStateNow.bind(this),
    cleanupSession: this.cleanupSession.bind(this),
    setupSessionListeners: this.setupSessionListeners.bind(this),
    removeSessionListeners: this.removeSessionListeners.bind(this),
    setupRespawnListeners: this.setupRespawnListeners.bind(this),
    setupTimedRespawn: this.setupTimedRespawn.bind(this),
    restoreRespawnController: this.restoreRespawnController.bind(this),
    saveRespawnConfig: this.saveRespawnConfig.bind(this),
    startTranscriptWatcher: this.startTranscriptWatcher.bind(this),
    stopTranscriptWatcher: this.stopTranscriptWatcher.bind(this),
    getSessionStateWithRespawn: this.getSessionStateWithRespawn.bind(this),
    getDefaultClaudeMdPath: this.getDefaultClaudeMdPath.bind(this),
    batchTerminalData: this.batchTerminalData.bind(this),
    broadcastSessionStateDebounced: this.broadcastSessionStateDebounced.bind(this),
    batchTaskUpdate: this.batchTaskUpdate.bind(this),
    getGlobalNiceConfig: this.getGlobalNiceConfig.bind(this),
    getModelConfig: this.getModelConfig.bind(this),
    getClaudeModeConfig: this.getClaudeModeConfig.bind(this),
    startScheduledRun: this.startScheduledRun.bind(this),
    stopScheduledRun: this.stopScheduledRun.bind(this),
    sendPushNotifications: this.sendPushNotifications.bind(this),
  };
}
```

### Helper: findSessionOrFail

Add a shared helper to `route-context.ts` (replaces ~43 repetitions of the session-not-found pattern):

```typescript
import { createErrorResponse, ApiErrorCode } from '../types.js';

/**
 * Look up a session by ID, throwing a structured error if not found.
 * Route handlers call this to avoid ~43 repetitions of the NOT_FOUND pattern.
 */
export function findSessionOrFail(ctx: RouteContext, sessionId: string): Session {
  const session = ctx.sessions.get(sessionId);
  if (!session) {
    throw Object.assign(
      new Error('Session not found'),
      { statusCode: 404, response: createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found') }
    );
  }
  return session;
}
```

In each route module, use it as:
```typescript
const session = findSessionOrFail(ctx, sessionId);
// If we get here, session is guaranteed non-null
```

For Fastify error handling, register a global error handler in `setupRoutes()` that catches these structured errors:
```typescript
this.app.setErrorHandler((error, _req, reply) => {
  if ('response' in error && 'statusCode' in error) {
    return reply.code((error as any).statusCode).send((error as any).response);
  }
  reply.code(500).send(createErrorResponse(ApiErrorCode.INTERNAL_ERROR, error.message));
});
```

### Error Pattern Convention

**Use `findSessionOrFail` (throw) consistently for session lookups.** For other not-found patterns (scheduled runs, subagents, etc.), continue using the existing early-return pattern (`if (!x) return createErrorResponse(...)`). This avoids a full rewrite of all error handling while still eliminating the most common repetition.

Do NOT mix thrown and returned errors within the same route handler — pick one per handler. `findSessionOrFail` at the top of a handler (throw), then early-returns for everything else.

### Module-Level Singletons

Two singletons are imported at the module level in `server.ts` (not on `this`) and used directly by route handlers:

| Singleton | Import | Used By Routes |
|-----------|--------|---------------|
| `imageWatcher` | `import { imageWatcher } from '../image-watcher.js'` | POST /api/sessions/:id/image-watcher, PUT /api/settings |
| `fileStreamManager` | `import { fileStreamManager } from '../file-stream-manager.js'` | GET /api/sessions/:id/tail-file, DELETE /api/sessions/:id/tail-file/:streamId |

**Convention**: Route modules should import these singletons directly (not via RouteContext). They are already module-level singletons with no `this` binding, so direct import is simpler and consistent with their existing usage.

### ScheduledRun type

The `ScheduledRun` type is currently defined locally in `server.ts` (around line 131-143). Move it to `route-context.ts` or a shared types location since route modules need it.

### Verification

```bash
tsc --noEmit
npm run lint
npm run format:check
```

---

## Task 2: Extract Auth Middleware

**File to create**: `src/web/middleware/auth.ts`
**File to edit**: `src/web/server.ts`
**Time**: ~1 hour

### Problem

Auth logic (HTTP Basic Auth, session cookies, rate limiting) is inline in `setupRoutes()` at lines 659-780. This is ~120 LOC of self-contained logic that doesn't depend on any route handlers.

### Implementation

Extract the `onRequest` hook registration into a standalone function:

**New file**: `src/web/middleware/auth.ts`

```typescript
/**
 * @fileoverview HTTP Basic Auth middleware with session cookies and rate limiting.
 *
 * Extracted from server.ts setupRoutes() auth section.
 * Only active when CODEMAN_PASSWORD environment variable is set.
 *
 * @module web/middleware/auth
 */

import type { FastifyInstance } from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { StaleExpirationMap } from '../../utils/index.js';

// Auth configuration constants
const AUTH_SESSION_TTL_MS = 24 * 60 * 60 * 1000;  // 24 hours
const MAX_AUTH_SESSIONS = 100;
const AUTH_FAILURE_WINDOW_MS = 15 * 60 * 1000;     // 15 minutes
const AUTH_FAILURE_MAX = 10;
const AUTH_COOKIE_NAME = 'codeman_session';

/**
 * Register HTTP Basic Auth with session cookies and rate limiting.
 *
 * Does nothing if CODEMAN_PASSWORD is not set.
 * Exempts /api/hook-event from localhost (Claude Code hooks curl this).
 */
export function registerAuthMiddleware(app: FastifyInstance, https: boolean): {
  authSessions: StaleExpirationMap<string, string> | null;
  authFailures: StaleExpirationMap<string, number> | null;
} {
  const authPassword = process.env.CODEMAN_PASSWORD;
  if (!authPassword) {
    return { authSessions: null, authFailures: null };
  }

  const authUsername = process.env.CODEMAN_USERNAME || 'admin';
  const expectedHeader = 'Basic ' + Buffer.from(`${authUsername}:${authPassword}`).toString('base64');

  const authSessions = new StaleExpirationMap<string, string>({
    ttlMs: AUTH_SESSION_TTL_MS,
    refreshOnGet: true,
  });

  const authFailures = new StaleExpirationMap<string, number>({
    ttlMs: AUTH_FAILURE_WINDOW_MS,
    refreshOnGet: false,
  });

  app.addHook('onRequest', (req, reply, done) => {
    // Hook events from localhost bypass auth
    if (req.url === '/api/hook-event' && req.method === 'POST') {
      const ip = req.ip;
      if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1') {
        done();
        return;
      }
    }

    const clientIp = req.ip;

    // Rate limit check
    const failures = authFailures.get(clientIp) ?? 0;
    if (failures >= AUTH_FAILURE_MAX) {
      reply.code(429).send('Too Many Requests — try again later');
      return;
    }

    // Session cookie check
    const sessionToken = req.cookies[AUTH_COOKIE_NAME];
    if (sessionToken && authSessions.get(sessionToken) !== undefined) {
      done();
      return;
    }

    // Basic Auth header check (timing-safe)
    const auth = req.headers.authorization;
    const authBuf = Buffer.from(auth ?? '');
    const expectedBuf = Buffer.from(expectedHeader);
    if (authBuf.length === expectedBuf.length && timingSafeEqual(authBuf, expectedBuf)) {
      const token = randomBytes(32).toString('hex');
      if (authSessions.size >= MAX_AUTH_SESSIONS) {
        const oldestKey = authSessions.keys().next().value;
        if (oldestKey !== undefined) authSessions.delete(oldestKey);
      }
      authSessions.set(token, clientIp);
      authFailures.delete(clientIp);
      reply.setCookie(AUTH_COOKIE_NAME, token, {
        httpOnly: true,
        secure: https,
        sameSite: 'lax',
        maxAge: AUTH_SESSION_TTL_MS / 1000,
        path: '/',
      });
      done();
      return;
    }

    // Failed — track and reject
    authFailures.set(clientIp, failures + 1);
    reply.code(401).header('WWW-Authenticate', 'Basic realm="Codeman"').send('Unauthorized');
  });

  return { authSessions, authFailures };
}
```

### Security headers

Also extract the security headers hook (CSP, X-Frame-Options, X-Content-Type-Options, HSTS) from `setupRoutes()` into `auth.ts` as a separate function `registerSecurityHeaders(app, https)`, since it's closely related to the auth/security concern.

### Edit server.ts

In `setupRoutes()`, replace the inline auth block (~lines 659-780) with:

```typescript
import { registerAuthMiddleware, registerSecurityHeaders } from './middleware/auth.js';

// In setupRoutes():
const { authSessions, authFailures } = registerAuthMiddleware(this.app, this.https);
this.authSessions = authSessions;
this.authFailures = authFailures;
registerSecurityHeaders(this.app, this.https);
```

Move the auth constants (`AUTH_SESSION_TTL_MS`, `MAX_AUTH_SESSIONS`, `AUTH_FAILURE_WINDOW_MS`, `AUTH_FAILURE_MAX`, `AUTH_COOKIE_NAME`) from server.ts to the middleware file.

### Verification

```bash
tsc --noEmit
npm run lint
# Start server and verify auth still works:
CODEMAN_PASSWORD=test npx tsx src/index.ts web --port 3099 &
sleep 3
# Should get 401 without credentials:
curl -s -o /dev/null -w "%{http_code}" http://localhost:3099/api/status
# Should get 200 with credentials:
curl -s -u admin:test http://localhost:3099/api/status | jq .status
kill %1
```

---

## Task 3: Extract Session Routes

**File to create**: `src/web/routes/session-routes.ts`
**File to edit**: `src/web/server.ts`
**Time**: ~3 hours (largest route group)

### Problem

Session routes are the largest group (~30 handlers, ~800 LOC) covering CRUD, input, resize, terminal buffer access, auto-clear/compact, and image watcher toggling.

### Routes to Extract

| Method | Path | Current Line | Purpose |
|--------|------|-------------|---------|
| GET | `/api/sessions` | 1015 | List all sessions (cached) |
| POST | `/api/sessions` | 1017 | Create session |
| PUT | `/api/sessions/:id/name` | 1094 | Rename session |
| PUT | `/api/sessions/:id/color` | 1117 | Change session color |
| DELETE | `/api/sessions/:id` | 1141 | Delete single session |
| DELETE | `/api/sessions` | 1155 | Kill all sessions |
| GET | `/api/sessions/:id` | 1169 | Get session details |
| GET | `/api/sessions/:id/output` | 1182 | Get session output text |
| GET | `/api/sessions/:id/ralph-state` | 1201 | Get Ralph tracker state |
| GET | `/api/sessions/:id/run-summary` | 1220 | Get run summary timeline |
| GET | `/api/sessions/:id/active-tools` | 1243 | Get active bash tools |
| POST | `/api/sessions/:id/run` | 1915 | Run a prompt |
| POST | `/api/sessions/:id/interactive` | 1942 | Start interactive mode |
| POST | `/api/sessions/:id/shell` | 1985 | Start shell mode |
| POST | `/api/sessions/:id/input` | 2015 | Send input to session |
| POST | `/api/sessions/:id/resize` | 2059 | Resize terminal |
| GET | `/api/sessions/:id/terminal` | 2087 | Get terminal buffer |
| POST | `/api/sessions/:id/auto-clear` | 2444 | Toggle auto-clear |
| POST | `/api/sessions/:id/auto-compact` | 2473 | Toggle auto-compact |
| POST | `/api/sessions/:id/image-watcher` | 2503 | Toggle image watcher |
| POST | `/api/sessions/:id/flicker-filter` | 2535 | Toggle flicker filter |
| GET | `/api/sessions/:id/cpu-limit` | 4120 | Get CPU limit |
| POST | `/api/sessions/:id/cpu-limit` | 4134 | Set CPU limit |

### Implementation Pattern

```typescript
// src/web/routes/session-routes.ts
import type { FastifyInstance } from 'fastify';
import type { RouteContext } from '../route-context.js';
import { findSessionOrFail } from '../route-context.js';
import { CreateSessionSchema, RunPromptSchema, /* ... */ } from '../schemas.js';
import { createErrorResponse, ApiErrorCode } from '../../types.js';
import { Session } from '../../session.js';

export function registerSessionRoutes(app: FastifyInstance, ctx: RouteContext): void {
  app.get('/api/sessions', async () => /* moved from server.ts */);

  app.post('/api/sessions', async (req) => {
    const data = CreateSessionSchema.parse(req.body);
    // ... handler body moved verbatim from server.ts
    // Replace `this.sessions` with `ctx.sessions`
    // Replace `this.broadcast(...)` with `ctx.broadcast(...)`
    // Replace `this.persistSessionState(...)` with `ctx.persistSessionState(...)`
  });

  // ... remaining routes
}
```

### Migration Strategy for Each Route

1. **Copy** the route handler body from server.ts to the new file
2. **Replace** all `this.xxx` references with `ctx.xxx` equivalents
3. **Replace** inline session lookups with `findSessionOrFail(ctx, id)` where applicable
4. **Import** schemas, types, and utilities used by the handler
5. **Delete** the route from server.ts
6. **Verify** with `tsc --noEmit` after each batch of routes

### State Access Patterns in Session Routes

These routes access WebServer state that must be exposed via RouteContext:

| State | Used By |
|-------|---------|
| `this.sessions` | All session routes |
| `this.store` | Create, delete, settings |
| `this.mux` | Create (spawn tmux), delete (kill) |
| `this.broadcast()` | Most routes (SSE events) |
| `this.persistSessionState()` | Name, color, auto-ops, cpu-limit |
| `this.cleanupSession()` | Delete |
| `this.setupSessionListeners()` | Create, interactive, shell |
| `this.getSessionStateWithRespawn()` | Get session details |
| `this.batchTerminalData()` | (Indirectly via session listeners) |
| `this.runSummaryTrackers` | Run summary GET |
| `this.getGlobalNiceConfig()` | Create session (nice/ionice config) |
| `this.getModelConfig()` | Create session (default model) |
| `this.getClaudeModeConfig()` | Create session (claude mode, allowed tools) |
| `imageWatcher` | Image watcher toggle (import directly, not via ctx) |

### Session Creation Helper

The `POST /api/sessions` handler at line 1017 is ~75 LOC and does complex work (spawn PTY, setup listeners, persist state, broadcast). It uses several internal methods. Consider extracting the create logic into a `createSession()` method on the RouteContext rather than inlining all of it in the route module.

### Verification

```bash
tsc --noEmit
npm run lint
# Verify session CRUD works:
npx tsx src/index.ts web --port 3099 &
sleep 3
# Create session:
curl -s -X POST http://localhost:3099/api/sessions -H 'Content-Type: application/json' \
  -d '{"mode":"shell"}' | jq .id
# List sessions:
curl -s http://localhost:3099/api/sessions | jq length
# Delete session (use ID from create):
curl -s -X DELETE http://localhost:3099/api/sessions/<id> | jq .success
kill %1
```

---

## Task 4: Extract Respawn Routes

**File to create**: `src/web/routes/respawn-routes.ts`
**File to edit**: `src/web/server.ts`
**Time**: ~1.5 hours

### Routes to Extract

| Method | Path | Current Line | Purpose |
|--------|------|-------------|---------|
| GET | `/api/sessions/:id/respawn` | 2142 | Get respawn status |
| GET | `/api/sessions/:id/respawn/config` | 2157 | Get respawn config |
| POST | `/api/sessions/:id/respawn/start` | 2175 | Start respawn |
| POST | `/api/sessions/:id/respawn/stop` | 2221 | Stop respawn |
| PUT | `/api/sessions/:id/respawn/config` | 2256 | Update respawn config |
| POST | `/api/sessions/:id/interactive-respawn` | 2313 | Start interactive respawn |
| POST | `/api/sessions/:id/respawn/enable` | 2388 | Enable/disable respawn |

### Key Dependencies

These routes heavily use:
- `ctx.respawnControllers` — get/create/delete controllers
- `ctx.respawnTimers` — timed respawn duration management
- `ctx.setupRespawnListeners()` — wire events for new controllers
- `ctx.setupTimedRespawn()` — set duration timer
- `ctx.saveRespawnConfig()` — persist to mux metadata
- `ctx.persistSessionState()` — update state.json
- `ctx.broadcast()` — SSE events
- `RespawnController` constructor — instantiated in start/interactive-respawn routes

### Respawn Start Route Complexity

The `POST /api/sessions/:id/respawn/start` handler (line 2175, ~45 LOC) creates a new `RespawnController`, calls `setupRespawnListeners`, starts it, and optionally sets up timed respawn. This is complex but self-contained — it can move to the route module as-is, with `ctx.setupRespawnListeners()` and `ctx.setupTimedRespawn()` as the bridge back to server.ts.

### Interactive Respawn Complexity

`POST /api/sessions/:id/interactive-respawn` (line 2313, ~75 LOC) is the most complex respawn route. It stops existing controllers, creates a new one with different config, and handles the "sendInit" flow. All logic can move to the route module since it only needs `ctx` methods.

### Verification

```bash
tsc --noEmit
npm run lint
npx vitest run test/respawn-controller.test.ts  # Ensure respawn logic still works
```

---

## Task 5: Extract Subagent, Mux, and Team Routes

**File to create**: `src/web/routes/subagent-routes.ts`, `src/web/routes/mux-routes.ts`, `src/web/routes/team-routes.ts`
**File to edit**: `src/web/server.ts`
**Time**: ~2 hours

### Subagent Routes

| Method | Path | Line | Purpose |
|--------|------|------|---------|
| GET | `/api/subagents` | 4271 | List all subagents |
| GET | `/api/sessions/:id/subagents` | 4280 | List session subagents |
| GET | `/api/subagents/:agentId` | 4291 | Get single subagent |
| GET | `/api/subagents/:agentId/transcript` | 4301 | Get transcript |
| DELETE | `/api/subagents/:agentId` | 4316 | Kill subagent |
| POST | `/api/subagents/cleanup` | 4331 | Cleanup completed |
| DELETE | `/api/subagents` | 4337 | Kill all subagents |
| GET | `/api/subagent-window-states` | 4162 | Get window positions |
| PUT | `/api/subagent-window-states` | 4174 | Save window positions |
| GET | `/api/subagent-parents` | 4197 | Get parent map |
| PUT | `/api/subagent-parents` | 4209 | Save parent map |

These routes primarily use the `subagentWatcher` singleton (imported directly, not via ctx) and `ctx.store` for window state persistence.

### Mux Routes

| Method | Path | Line | Purpose |
|--------|------|------|---------|
| GET | `/api/mux-sessions` | 4230 | List tmux sessions |
| DELETE | `/api/mux-sessions/:sessionId` | 4239 | Kill tmux session |
| POST | `/api/mux-sessions/reconcile` | 4246 | Reconcile sessions |
| POST | `/api/mux-sessions/stats/start` | 4252 | Start stats polling |
| POST | `/api/mux-sessions/stats/stop` | 4258 | Stop stats polling |
| GET | `/api/system/stats` | 4264 | System CPU/memory |

These routes only need `ctx.mux` and `getSystemStats()` (move the helper to the route module or route-context).

### Team Routes

| Method | Path | Line | Purpose |
|--------|------|------|---------|
| GET | `/api/teams` | 4345 | List teams |
| GET | `/api/teams/:name/tasks` | 4350 | Get team tasks |

These routes only need `ctx.teamWatcher`.

### Verification

```bash
tsc --noEmit
npm run lint
# Verify subagent listing works:
curl -s http://localhost:3099/api/subagents | jq length
```

---

## Task 6: Extract Plan, Case, and Ralph Routes

**File to create**: `src/web/routes/plan-routes.ts`, `src/web/routes/case-routes.ts`, `src/web/routes/ralph-routes.ts`
**File to edit**: `src/web/server.ts`
**Time**: ~3 hours

### Plan Routes

| Method | Path | Line | Purpose |
|--------|------|------|---------|
| POST | `/api/generate-plan` | 3380 | Generate plan |
| POST | `/api/generate-plan-detailed` | 3574 | Generate detailed plan |
| POST | `/api/cancel-plan-generation` | 3682 | Cancel plan generation |
| PATCH | `/api/sessions/:id/plan/task/:taskId` | 3877 | Update plan task |
| POST | `/api/sessions/:id/plan/checkpoint` | 3909 | Create plan checkpoint |
| GET | `/api/sessions/:id/plan/history` | 3927 | Get plan history |
| POST | `/api/sessions/:id/plan/rollback/:version` | 3943 | Rollback plan |
| POST | `/api/sessions/:id/plan/task` | 3965 | Add plan task |

These routes use `ctx.activePlanOrchestrators`, `PlanOrchestrator` constructor, and `ctx.broadcast()`. The generate-plan handlers are the most complex (~200 LOC each) because they set up orchestrator event listeners and manage the async plan generation lifecycle.

### Case Routes

| Method | Path | Line | Purpose |
|--------|------|------|---------|
| GET | `/api/cases` | 2676 | List cases |
| POST | `/api/cases` | 2718 | Create case |
| POST | `/api/cases/link` | 2760 | Link existing dir as case |
| GET | `/api/cases/:name` | 2818 | Get case details |
| GET | `/api/cases/:name/fix-plan` | 2853 | Get case fix plan |
| GET | `/api/cases/:caseName/ralph-wizard/files` | 3716 | Wizard file listing |
| GET | `/api/cases/:caseName/ralph-wizard/file/:filePath` | 3777 | Wizard file content |

Case routes use filesystem operations (`existsSync`, `mkdirSync`, `readFileSync`, `writeFileSync`) and the `generateClaudeMd` template function. They're self-contained — the only ctx dependency is `ctx.store` for the cases directory path.

### Ralph Routes

| Method | Path | Line | Purpose |
|--------|------|------|---------|
| POST | `/api/sessions/:id/ralph-config` | 1653 | Update Ralph config |
| POST | `/api/sessions/:id/ralph-circuit-breaker/reset` | 1733 | Reset circuit breaker |
| GET | `/api/sessions/:id/ralph-status` | 1746 | Get Ralph status |
| GET | `/api/sessions/:id/fix-plan` | 1766 | Get fix plan |
| POST | `/api/sessions/:id/fix-plan/import` | 1785 | Import fix plan |
| POST | `/api/sessions/:id/fix-plan/write` | 1811 | Write fix plan tasks |
| POST | `/api/sessions/:id/fix-plan/read` | 1842 | Trigger fix plan re-read |
| POST | `/api/sessions/:id/ralph-prompt/write` | 1880 | Write Ralph prompt file |
| POST | `/api/ralph-loop/start` | 3128 | Start Ralph Loop |

Ralph routes access `session.ralphTracker` methods and `ctx.respawnControllers` for circuit breaker operations. The Ralph Loop start route (line 3128, ~250 LOC) is the most complex — it creates sessions, sets up Ralph Loop mode, and configures respawn.

### Verification

```bash
tsc --noEmit
npm run lint
# Verify cases endpoint:
curl -s http://localhost:3099/api/cases | jq length
```

---

## Task 7: Extract System, Settings, Push, File, and Scheduled Routes

**Files to create**: `src/web/routes/system-routes.ts`, `src/web/routes/file-routes.ts`, `src/web/routes/push-routes.ts`, `src/web/routes/scheduled-routes.ts`
**File to edit**: `src/web/server.ts`
**Time**: ~3 hours

### System Routes

| Method | Path | Line | Purpose |
|--------|------|------|---------|
| GET | `/api/status` | 842 | Full app status (cached) |
| GET | `/api/tunnel/status` | 844 | Tunnel status |
| GET | `/api/tunnel/qr` | 846 | Tunnel QR code |
| GET | `/api/opencode/status` | 862 | OpenCode CLI check |
| POST | `/api/cleanup-state` | 871 | Clean stale sessions from state |
| GET | `/api/session-lifecycle` | 877 | Lifecycle audit log |
| GET | `/api/stats` | 895 | App statistics |
| GET | `/api/token-stats` | 913 | Token usage stats |
| GET | `/api/config` | 931 | Get app config |
| PUT | `/api/config` | 935 | Update app config |
| GET | `/api/debug/memory` | 947 | Debug memory usage |
| POST | `/api/logout` | 833 | Clear auth cookie |
| GET | `/api/settings` | 3991 | Get global settings |
| PUT | `/api/settings` | 4003 | Update global settings |
| GET | `/api/execution/model-config` | 4074 | Get model config |
| PUT | `/api/execution/model-config` | 4087 | Update model config |

The `getLightState()` and `getLightSessionsState()` cached methods remain in server.ts (they access the cache fields) and are exposed via RouteContext. The system routes just call them.

The `getSystemStats()` helper (lines 4710-4753) moves to `system-routes.ts` since it has no server state dependencies (only `os` module calls).

### File Routes

| Method | Path | Line | Purpose |
|--------|------|------|---------|
| GET | `/api/sessions/:id/files` | 1260 | File tree browser |
| GET | `/api/sessions/:id/file-content` | 1388 | File content preview |
| GET | `/api/sessions/:id/file-raw` | 1498 | Raw file download |
| GET | `/api/sessions/:id/tail-file` | 1575 | Live file tail (SSE) |
| DELETE | `/api/sessions/:id/tail-file/:streamId` | 1640 | Stop file tail |
| POST | `/api/screenshots` | 4455 | Upload screenshot |
| GET | `/api/screenshots` | 4542 | List screenshots |
| GET | `/api/screenshots/:name` | 4556 | Serve screenshot |

File routes are the most self-contained group — they use `fs` operations, path validation, and `fileStreamManager`. The only ctx dependencies are `ctx.sessions` (to verify session exists and get working dir) and `ctx.broadcast()` (for screenshot upload notification).

**Module-level singletons**: `fileStreamManager` is imported directly from `'../file-stream-manager.js'` — import it directly in `file-routes.ts`, not via RouteContext. Similarly, the image watcher toggle route in session-routes uses `imageWatcher` from `'../image-watcher.js'` — import directly.

**TOCTOU security**: The file-raw route has a critical `realpathSync()` double-check for symlink TOCTOU protection. Preserve this exactly when moving.

### Push Routes

| Method | Path | Line | Purpose |
|--------|------|------|---------|
| GET | `/api/push/vapid-key` | 4410 | Get VAPID public key |
| POST | `/api/push/subscribe` | 4414 | Register push subscription |
| PUT | `/api/push/subscribe/:id` | 4431 | Update subscription prefs |
| DELETE | `/api/push/subscribe/:id` | 4444 | Unsubscribe |

Push routes only need `ctx.pushStore`. Very self-contained.

### Scheduled Routes

| Method | Path | Line | Purpose |
|--------|------|------|---------|
| POST | `/api/run` | 2561 | Quick run (create + run prompt) |
| GET | `/api/scheduled` | 2620 | List scheduled runs |
| POST | `/api/scheduled` | 2624 | Create scheduled run |
| DELETE | `/api/scheduled/:id` | 2650 | Cancel scheduled run |
| GET | `/api/scheduled/:id` | 2662 | Get scheduled run |
| POST | `/api/quick-start` | 2965 | Quick start (case + session + hooks) |

Quick-start (line 2965, ~160 LOC) is complex: it creates a case directory, writes CLAUDE.md, configures hooks, creates a session, and starts respawn. It uses many ctx methods. Consider keeping it intact as a single large handler in the route module.

### Hook Event Route

| Method | Path | Line | Purpose |
|--------|------|------|---------|
| POST | `/api/hook-event` | 4357 | Receive Claude Code hook events |

This route is special: it's exempt from auth (localhost-only), validates with `HookEventSchema`, and broadcasts `hook:{eventName}` events. It also handles Web Push notifications via `ctx.sendPushNotifications()`. Place it in `system-routes.ts` or its own `hook-routes.ts`.

### SSE Route

| Method | Path | Line | Purpose |
|--------|------|------|---------|
| GET | `/api/events` | 803 | SSE connection endpoint |

The SSE endpoint (line 803, ~30 LOC) sets up headers, adds the client to `sseClients`, sends initial state, and handles cleanup. This can stay in server.ts since it directly manages the SSE client set, or move to system-routes with `sseClients` exposed via RouteContext.

**Recommendation**: Keep the SSE endpoint in server.ts — it's tightly coupled to the broadcast infrastructure and only ~30 LOC.

### Verification

```bash
tsc --noEmit
npm run lint
npm run format:check
# Comprehensive verification:
npx tsx src/index.ts web --port 3099 &
sleep 3
curl -s http://localhost:3099/api/status | jq .status
curl -s http://localhost:3099/api/settings | jq 'keys'
curl -s http://localhost:3099/api/push/vapid-key | jq .publicKey
kill %1
```

---

## Task 8: Final Cleanup — Reduce server.ts

**File to edit**: `src/web/server.ts`
**Time**: ~2 hours

### What Remains in server.ts

After Tasks 2-7, server.ts should contain only:

1. **Class fields** (~60 LOC) — Maps, timers, config
2. **Constructor** (~50 LOC) — Fastify init, mux creation, watcher setup
3. **`setupRoutes()`** (~50 LOC) — Plugin registration + route module imports:
   ```typescript
   private async setupRoutes(): Promise<void> {
     // Plugins
     await this.app.register(fastifyCompress, { threshold: 1024 });
     await this.app.register(fastifyCookie);
     this.app.addContentTypeParser('multipart/form-data', (_req, _payload, done) => done(null));

     // Auth
     const { authSessions, authFailures } = registerAuthMiddleware(this.app, this.https);
     this.authSessions = authSessions;
     this.authFailures = authFailures;
     registerSecurityHeaders(this.app, this.https);

     // Error handler
     this.app.setErrorHandler((error, _req, reply) => { /* ... */ });

     // Static files
     await this.app.register(fastifyStatic, { /* ... */ });

     // Route modules
     const ctx = this.createRouteContext();
     registerSessionRoutes(this.app, ctx);
     registerRespawnRoutes(this.app, ctx);
     registerSubagentRoutes(this.app, ctx);
     registerMuxRoutes(this.app, ctx);
     registerTeamRoutes(this.app, ctx);
     registerPlanRoutes(this.app, ctx);
     registerCaseRoutes(this.app, ctx);
     registerRalphRoutes(this.app, ctx);
     registerSystemRoutes(this.app, ctx);
     registerFileRoutes(this.app, ctx);
     registerPushRoutes(this.app, ctx);
     registerScheduledRoutes(this.app, ctx);

     // SSE endpoint (kept here — tightly coupled to broadcast infra)
     this.app.get('/api/events', (req, reply) => { /* ... */ });

     // Service worker route (kept here — 20 LOC)
     this.app.get('/sw.js', async (_req, reply) => { /* ... */ });
   }
   ```
4. **`createRouteContext()`** (~40 LOC) — Build context object
5. **`start()`** (~90 LOC) — Server startup, session restoration
6. **`stop()`** (~170 LOC) — Graceful shutdown
7. **Session listener setup/teardown** (~200 LOC) — `setupSessionListeners`, `removeSessionListeners`
8. **Respawn lifecycle** (~200 LOC) — `setupRespawnListeners`, `setupTimedRespawn`, `restoreRespawnController`, `saveRespawnConfig`
9. **Watcher setup** (~100 LOC) — `setupSubagentWatcherListeners`, `setupImageWatcherListeners`, `setupTeamWatcherListeners`
10. **SSE infrastructure** (~100 LOC) — `broadcast`, `sendSSE`, `sendSSEPreformatted`
11. **Terminal batching** (~80 LOC) — `batchTerminalData`, `flushSessionTerminalBatch`
12. **Task/state update batching** (~60 LOC) — `batchTaskUpdate`, `broadcastSessionStateDebounced`
13. **State persistence** (~60 LOC) — `persistSessionState`, `_persistSessionStateNow`
14. **Session cleanup** (~120 LOC) — `cleanupSession`, `_doCleanupSession`
15. **Transcript watchers** (~50 LOC) — `startTranscriptWatcher`, `stopTranscriptWatcher`
16. **State caching** (~60 LOC) — `getLightState`, `getLightSessionsState`

**Estimated total**: ~1,300-1,500 LOC

### Cleanup Steps

1. **Remove all extracted route handlers** from `setupRoutes()` — after all route modules are imported and registered, the remaining inline routes should be zero (except SSE and sw.js).
2. **Remove unused imports** — many imports at the top of server.ts were only used by route handlers (e.g., `generateClaudeMd`, `parseRalphLoopConfig`). Delete them.
3. **Move constants** that only route modules use to the route modules. Constants used by server core (batching intervals, cache TTLs) stay.
4. **Remove the `ScheduledRun` type** from server.ts if it was moved to route-context.ts in Task 1.
5. **Verify no dead code** remains — run `tsc --noEmit` with strict unused-variable checking.

### Verification (Comprehensive)

```bash
# 1. TypeScript
tsc --noEmit

# 2. Lint + format
npm run lint
npm run format:check

# 3. Line count verification
wc -l src/web/server.ts
# Should be ~1,300-1,500 LOC

# 4. Route count verification (should match original ~110)
grep -c "app\.\(get\|post\|put\|patch\|delete\)(" src/web/routes/*.ts src/web/server.ts

# 5. Integration test — start server, verify key endpoints
npx tsx src/index.ts web --port 3099 &
sleep 3

# System
curl -s http://localhost:3099/api/status | jq .status
curl -s http://localhost:3099/api/config | jq .version

# Sessions
SESS=$(curl -s -X POST http://localhost:3099/api/sessions -H 'Content-Type: application/json' \
  -d '{"mode":"shell"}' | jq -r .id)
curl -s http://localhost:3099/api/sessions | jq length
curl -s http://localhost:3099/api/sessions/$SESS | jq .id

# Subagents
curl -s http://localhost:3099/api/subagents | jq length

# Cases
curl -s http://localhost:3099/api/cases | jq length

# Settings
curl -s http://localhost:3099/api/settings | jq 'keys'

# Push
curl -s http://localhost:3099/api/push/vapid-key | jq .publicKey

# Mux
curl -s http://localhost:3099/api/mux-sessions | jq length

# Cleanup
curl -s -X DELETE http://localhost:3099/api/sessions/$SESS | jq .success
kill %1

# 6. Run any existing tests
npx vitest run test/respawn-controller.test.ts
npx vitest run test/session-manager.test.ts
```

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `this` binding lost when methods passed via RouteContext | Medium | High (runtime crash) | Use `.bind(this)` in `createRouteContext()` for all methods |
| Circular dependency between server.ts and route modules | Low | High (import crash) | Route modules only import `route-context.ts`, never `server.ts` |
| Route handler accesses private field not in RouteContext | High | Medium (compile error) | Audit each route's `this.xxx` usage before moving; add to RouteContext as needed |
| Auth middleware ordering changes | Low | High (security) | Keep `addHook('onRequest')` registration before all routes |
| SSE endpoint moved loses access to sseClients | Low | Medium | Keep SSE endpoint in server.ts |
| Forgotten import after extraction | Medium | Low (compile error) | `tsc --noEmit` catches immediately |
| Performance regression from context indirection | Very Low | Low | Context is a plain object; zero overhead vs `this.xxx` |

---

## What NOT to Touch

- **`app.js`** (frontend monolith) — that's Phase 5
- **`schemas.ts`** — validation schemas stay as-is
- **Terminal batching internals** — `batchTerminalData`, `flushSessionTerminalBatch` stay in server.ts
- **SSE infrastructure** — `broadcast`, `sendSSE`, `sendSSEPreformatted` stay in server.ts
- **Session listener wiring** — complex event handler setup stays in server.ts
- **Respawn lifecycle methods** — `setupRespawnListeners`, `restoreRespawnController` stay in server.ts
- **Session cleanup** — `cleanupSession`, `_doCleanupSession` stay in server.ts (complex cross-cutting logic)
- **State caching** — `getLightState`, `getLightSessionsState` stay in server.ts

The goal is to extract **route definitions** (HTTP handler logic), not **orchestration** (lifecycle, events, batching).

---

## Summary of Changes

| Task | Files Created | Key Change |
|------|-------------|------------|
| 1. RouteContext | `src/web/route-context.ts` | Shared interface + `findSessionOrFail` helper |
| 2. Auth middleware | `src/web/middleware/auth.ts` | Auth hooks + security headers extracted |
| 3. Session routes | `src/web/routes/session-routes.ts` | ~23 routes, ~800 LOC extracted |
| 4. Respawn routes | `src/web/routes/respawn-routes.ts` | ~7 routes, ~400 LOC extracted |
| 5. Subagent/mux/team | `src/web/routes/subagent-routes.ts`, `mux-routes.ts`, `team-routes.ts` | ~18 routes, ~380 LOC extracted |
| 6. Plan/case/ralph | `src/web/routes/plan-routes.ts`, `case-routes.ts`, `ralph-routes.ts` | ~24 routes, ~1350 LOC extracted |
| 7. System/file/push/sched | `src/web/routes/system-routes.ts`, `file-routes.ts`, `push-routes.ts`, `scheduled-routes.ts` | ~28 routes, ~1500 LOC extracted |
| 8. Final cleanup | `src/web/server.ts` reduced | ~5,200 LOC removed from server.ts |

**Total files created**: 14 (1 interface + 1 middleware + 12 route modules)
**Total files modified**: 1 (server.ts)
**Net LOC change**: ~0 (moved, not deleted — but server.ts drops from ~6,710 to ~1,500)
**Route count preserved**: ~110 routes (verified by grep after extraction)
