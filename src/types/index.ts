/**
 * @fileoverview Barrel re-export for all Codeman type definitions.
 *
 * The type system is split into 13 domain modules for maintainability.
 * Import from `'./types'` (or `'./types/index.js'`) to access any type:
 *
 * ```ts
 * import type { SessionState, AppState, RespawnConfig } from './types';
 * import { createErrorResponse, ApiErrorCode } from './types';
 * ```
 *
 * ## Domain modules
 *
 * | Module       | Key exports                                                           | Persistence / API                              |
 * |--------------|-----------------------------------------------------------------------|-------------------------------------------------|
 * | common       | Disposable, BufferConfig, CleanupRegistration, NiceConfig, ProcessStats | In-memory only                                 |
 * | session      | SessionState, SessionConfig, SessionStatus, SessionMode, ClaudeMode, OpenCodeConfig | `~/.codeman/state.json` → `GET /api/sessions`  |
 * | task         | TaskDefinition, TaskState, TaskStatus                                 | `~/.codeman/state.json` → `GET /api/tasks`     |
 * | app-state    | AppState, AppConfig, GlobalStats, TokenStats, DEFAULT_CONFIG          | `~/.codeman/state.json` → `GET /api/status`    |
 * | respawn      | RespawnConfig, RespawnPreset, RespawnCycleMetrics, RalphLoopHealthScore, TimingHistory | Per-session in state.json → `GET /api/sessions/:id/respawn` |
 * | ralph        | RalphTrackerState, RalphTodoItem, CircuitBreakerStatus, RalphStatusBlock, RalphSessionState | Per-session → `GET /api/sessions/:id/ralph-state` |
 * | api          | ApiResponse, ApiErrorCode, HookEventType, CaseInfo, createErrorResponse, getErrorMessage | Used by all route handlers                     |
 * | lifecycle    | LifecycleEntry, LifecycleEventType                                    | `~/.codeman/session-lifecycle.jsonl` (append-only) |
 * | run-summary  | RunSummary, RunSummaryEvent, RunSummaryStats                          | In-memory → `GET /api/sessions/:id/run-summary` |
 * | tools        | ActiveBashTool, ImageDetectedEvent                                    | In-memory, broadcast via SSE                   |
 * | teams        | TeamConfig, TeamMember, TeamTask, InboxMessage, PaneInfo              | `~/.claude/teams/`, `~/.claude/tasks/` → `GET /api/teams` |
 * | push         | PushSubscriptionRecord, VapidKeys                                     | `~/.codeman/push-keys.json`, `~/.codeman/push-subscriptions.json` |
 * | plan         | PlanItem, PlanTaskStatus, TddPhase                                    | In-memory → `GET /api/sessions/:id/plan/tasks` |
 *
 * ## Cross-domain relationship map
 *
 * ```
 * AppState (app-state)
 * ├── sessions: Record<id, SessionState>        ← session domain
 * │   ├── respawnConfig?: RespawnConfig          ← respawn domain (per-session settings)
 * │   ├── ralphEnabled?: boolean                 ← toggles ralph tracking
 * │   └── id ← referenced by:
 * │       ├── RalphSessionState.sessionId        ← ralph domain
 * │       ├── RunSummary.sessionId               ← run-summary domain
 * │       ├── ActiveBashTool.sessionId            ← tools domain
 * │       ├── RespawnCycleMetrics.sessionId       ← respawn domain
 * │       └── TeamConfig.leadSessionId            ← teams domain
 * ├── tasks: Record<id, TaskState>              ← task domain
 * │   └── assignedSessionId → SessionState.id
 * ├── ralphLoop: RalphLoopState                 ← ralph domain (global loop state)
 * └── config: AppConfig
 *     └── respawn: RespawnConfig                ← respawn domain (global defaults)
 *
 * RalphLoopHealthScore (respawn)
 * └── components.circuitBreaker ← derived from CircuitBreakerStatus (ralph)
 * ```
 */

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
