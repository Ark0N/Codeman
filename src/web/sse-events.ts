/**
 * @fileoverview Centralized SSE event type registry.
 *
 * Single source of truth for all Server-Sent Event type strings used across
 * the backend (broadcast calls) and referenced by the frontend (SSE_EVENTS in constants.js).
 *
 * Usage:
 *   import { SseEvent } from './sse-events.js';
 *   ctx.broadcast(SseEvent.SessionCreated, { id: session.id });
 *
 * When adding a new event:
 * 1. Add the constant here with JSDoc
 * 2. Add the matching entry in `src/web/public/constants.js` SSE_EVENTS object
 * 3. Add the frontend listener in the appropriate `addListener()` call
 */

// ─── Core ────────────────────────────────────────────────────────────────────

/** Sent to each SSE client on initial connection with full app state. */
export const Init = 'init' as const;

// ─── Session Lifecycle ───────────────────────────────────────────────────────

/** New session spawned. */
export const SessionCreated = 'session:created' as const;
/** Session state changed (status, config, tokens, etc.). */
export const SessionUpdated = 'session:updated' as const;
/** Session permanently removed. */
export const SessionDeleted = 'session:deleted' as const;
/** Raw PTY terminal output chunk. */
export const SessionTerminal = 'session:terminal' as const;
/** Client should re-fetch the full terminal buffer (e.g. after reconnect). */
export const SessionNeedsRefresh = 'session:needsRefresh' as const;
/** Terminal buffer cleared (e.g. /clear command). */
export const SessionClearTerminal = 'session:clearTerminal' as const;
/** Claude finished a prompt — includes result and cost. */
export const SessionCompletion = 'session:completion' as const;
/** Session-level error. */
export const SessionError = 'session:error' as const;
/** Claude CLI process exited. */
export const SessionExit = 'session:exit' as const;
/** Session transitioned to idle (waiting for input). */
export const SessionIdle = 'session:idle' as const;
/** Session transitioned to working (Claude is processing). */
export const SessionWorking = 'session:working' as const;
/** Auto-clear triggered for the session. */
export const SessionAutoClear = 'session:autoClear' as const;
/** Auto-compact triggered for the session. */
export const SessionAutoCompact = 'session:autoCompact' as const;
/** CLI version/model info detected from session output. */
export const SessionCliInfo = 'session:cliInfo' as const;
/** General session message (e.g. status text). */
export const SessionMessage = 'session:message' as const;
/** Session entered interactive mode (claude or shell). */
export const SessionInteractive = 'session:interactive' as const;
/** Prompt sent to session for execution. */
export const SessionRunning = 'session:running' as const;

// ─── Session: Ralph ──────────────────────────────────────────────────────────

/** Ralph loop state changed (enabled/disabled, iteration count). */
export const SessionRalphLoopUpdate = 'session:ralphLoopUpdate' as const;
/** Ralph todo items updated. */
export const SessionRalphTodoUpdate = 'session:ralphTodoUpdate' as const;
/** Ralph completion phrase detected in output. */
export const SessionRalphCompletionDetected = 'session:ralphCompletionDetected' as const;
/** Ralph status block parsed from output. */
export const SessionRalphStatusUpdate = 'session:ralphStatusUpdate' as const;
/** Circuit breaker state changed (CLOSED/HALF_OPEN/OPEN). */
export const SessionCircuitBreakerUpdate = 'session:circuitBreakerUpdate' as const;
/** Exit gate condition met (e.g. completion phrase found). */
export const SessionExitGateMet = 'session:exitGateMet' as const;

// ─── Session: Bash Tools ─────────────────────────────────────────────────────

/** Bash tool invocation started. */
export const SessionBashToolStart = 'session:bashToolStart' as const;
/** Bash tool invocation completed. */
export const SessionBashToolEnd = 'session:bashToolEnd' as const;
/** Active bash tools list changed. */
export const SessionBashToolsUpdate = 'session:bashToolsUpdate' as const;

// ─── Session: Plan ───────────────────────────────────────────────────────────

/** Plan task status updated. */
export const SessionPlanTaskUpdate = 'session:planTaskUpdate' as const;
/** Plan checkpoint created. */
export const SessionPlanCheckpoint = 'session:planCheckpoint' as const;
/** Plan rolled back to a previous version. */
export const SessionPlanRollback = 'session:planRollback' as const;
/** New task added to plan. */
export const SessionPlanTaskAdded = 'session:planTaskAdded' as const;

// ─── Tasks ───────────────────────────────────────────────────────────────────

/** Background task created. */
export const TaskCreated = 'task:created' as const;
/** Background task completed successfully. */
export const TaskCompleted = 'task:completed' as const;
/** Background task failed. */
export const TaskFailed = 'task:failed' as const;
/** Background task state updated. */
export const TaskUpdated = 'task:updated' as const;

// ─── Mux (tmux) ──────────────────────────────────────────────────────────────

/** tmux session created. */
export const MuxCreated = 'mux:created' as const;
/** tmux session killed. */
export const MuxKilled = 'mux:killed' as const;
/** tmux session died unexpectedly. */
export const MuxDied = 'mux:died' as const;
/** tmux session stats refreshed. */
export const MuxStatsUpdated = 'mux:statsUpdated' as const;

// ─── Respawn ─────────────────────────────────────────────────────────────────

/** Respawn loop started for a session. */
export const RespawnStarted = 'respawn:started' as const;
/** Respawn loop stopped. */
export const RespawnStopped = 'respawn:stopped' as const;
/** Respawn state machine transitioned. */
export const RespawnStateChanged = 'respawn:stateChanged' as const;
/** New respawn cycle started. */
export const RespawnCycleStarted = 'respawn:cycleStarted' as const;
/** Respawn cycle completed. */
export const RespawnCycleCompleted = 'respawn:cycleCompleted' as const;
/** Respawn blocked (e.g. by circuit breaker or active teammates). */
export const RespawnBlocked = 'respawn:blocked' as const;
/** Respawn step sent to session (update prompt, clear, kickstart). */
export const RespawnStepSent = 'respawn:stepSent' as const;
/** Respawn step completed. */
export const RespawnStepCompleted = 'respawn:stepCompleted' as const;
/** Idle/completion detection status updated. */
export const RespawnDetectionUpdate = 'respawn:detectionUpdate' as const;
/** Auto-accept sent for permission prompt. */
export const RespawnAutoAcceptSent = 'respawn:autoAcceptSent' as const;
/** AI idle check started. */
export const RespawnAiCheckStarted = 'respawn:aiCheckStarted' as const;
/** AI idle check completed with result. */
export const RespawnAiCheckCompleted = 'respawn:aiCheckCompleted' as const;
/** AI idle check failed. */
export const RespawnAiCheckFailed = 'respawn:aiCheckFailed' as const;
/** AI check cooldown state changed. */
export const RespawnAiCheckCooldown = 'respawn:aiCheckCooldown' as const;
/** Plan completion check started. */
export const RespawnPlanCheckStarted = 'respawn:planCheckStarted' as const;
/** Plan completion check completed with result. */
export const RespawnPlanCheckCompleted = 'respawn:planCheckCompleted' as const;
/** Plan completion check failed. */
export const RespawnPlanCheckFailed = 'respawn:planCheckFailed' as const;
/** Respawn timer started (idle, duration, etc.). */
export const RespawnTimerStarted = 'respawn:timerStarted' as const;
/** Respawn timer cancelled. */
export const RespawnTimerCancelled = 'respawn:timerCancelled' as const;
/** Respawn timer completed. */
export const RespawnTimerCompleted = 'respawn:timerCompleted' as const;
/** Respawn action logged (for monitor UI). */
export const RespawnActionLog = 'respawn:actionLog' as const;
/** Respawn debug log message. */
export const RespawnLog = 'respawn:log' as const;
/** Respawn error occurred. */
export const RespawnError = 'respawn:error' as const;
/** Respawn configuration updated. */
export const RespawnConfigUpdated = 'respawn:configUpdated' as const;

// ─── Subagents ───────────────────────────────────────────────────────────────

/** New subagent (background agent) discovered. */
export const SubagentDiscovered = 'subagent:discovered' as const;
/** Subagent state updated. */
export const SubagentUpdated = 'subagent:updated' as const;
/** Subagent tool call detected. */
export const SubagentToolCall = 'subagent:tool_call' as const;
/** Subagent tool result received. */
export const SubagentToolResult = 'subagent:tool_result' as const;
/** Subagent progress update. */
export const SubagentProgress = 'subagent:progress' as const;
/** Subagent message (assistant text). */
export const SubagentMessage = 'subagent:message' as const;
/** Subagent finished. */
export const SubagentCompleted = 'subagent:completed' as const;

// ─── Scheduled Runs ──────────────────────────────────────────────────────────

/** Scheduled run created. */
export const ScheduledCreated = 'scheduled:created' as const;
/** Scheduled run state updated. */
export const ScheduledUpdated = 'scheduled:updated' as const;
/** Scheduled run completed. */
export const ScheduledCompleted = 'scheduled:completed' as const;
/** Scheduled run stopped. */
export const ScheduledStopped = 'scheduled:stopped' as const;
/** Scheduled run log entry added. */
export const ScheduledLog = 'scheduled:log' as const;
/** Scheduled run deleted. */
export const ScheduledDeleted = 'scheduled:deleted' as const;

// ─── Teams ───────────────────────────────────────────────────────────────────

/** Agent team created. */
export const TeamCreated = 'team:created' as const;
/** Agent team config updated (e.g. new member joined). */
export const TeamUpdated = 'team:updated' as const;
/** Agent team removed. */
export const TeamRemoved = 'team:removed' as const;
/** Agent team task updated. */
export const TeamTaskUpdated = 'team:taskUpdated' as const;

// ─── Transcript ──────────────────────────────────────────────────────────────

/** Transcript complete event detected. */
export const TranscriptComplete = 'transcript:complete' as const;
/** Plan mode detected in transcript. */
export const TranscriptPlanMode = 'transcript:plan_mode' as const;
/** Tool invocation started in transcript. */
export const TranscriptToolStart = 'transcript:tool_start' as const;
/** Tool invocation ended in transcript. */
export const TranscriptToolEnd = 'transcript:tool_end' as const;

// ─── Plan Orchestration ──────────────────────────────────────────────────────

/** Plan generation started. */
export const PlanStarted = 'plan:started' as const;
/** Plan generation progress update. */
export const PlanProgress = 'plan:progress' as const;
/** Plan subagent event (research or planner agent). */
export const PlanSubagent = 'plan:subagent' as const;
/** Plan generation completed. */
export const PlanCompleted = 'plan:completed' as const;
/** Plan generation cancelled. */
export const PlanCancelled = 'plan:cancelled' as const;

// ─── Tunnel ──────────────────────────────────────────────────────────────────

/** Cloudflare tunnel started. */
export const TunnelStarted = 'tunnel:started' as const;
/** Cloudflare tunnel stopped. */
export const TunnelStopped = 'tunnel:stopped' as const;
/** Tunnel startup progress. */
export const TunnelProgress = 'tunnel:progress' as const;
/** Tunnel error. */
export const TunnelError = 'tunnel:error' as const;
/** QR code rotated (new token generated). */
export const TunnelQrRotated = 'tunnel:qrRotated' as const;
/** QR code force-regenerated. */
export const TunnelQrRegenerated = 'tunnel:qrRegenerated' as const;
/** QR auth token consumed by a client. */
export const TunnelQrAuthUsed = 'tunnel:qrAuthUsed' as const;

// ─── Image ───────────────────────────────────────────────────────────────────

/** New image file detected (e.g. screenshot upload). */
export const ImageDetected = 'image:detected' as const;

// ─── Hooks ───────────────────────────────────────────────────────────────────

/** Claude Code hook: session idle, waiting for input. */
export const HookIdlePrompt = 'hook:idle_prompt' as const;
/** Claude Code hook: tool requesting permission. */
export const HookPermissionPrompt = 'hook:permission_prompt' as const;
/** Claude Code hook: elicitation dialog (Claude asking a question). */
export const HookElicitationDialog = 'hook:elicitation_dialog' as const;
/** Claude Code hook: response complete. */
export const HookStop = 'hook:stop' as const;
/** Claude Code hook: teammate went idle. */
export const HookTeammateIdle = 'hook:teammate_idle' as const;
/** Claude Code hook: teammate task completed. */
export const HookTaskCompleted = 'hook:task_completed' as const;

// ─── Cases ───────────────────────────────────────────────────────────────────

/** New case directory created. */
export const CaseCreated = 'case:created' as const;
/** Existing directory linked as a case. */
export const CaseLinked = 'case:linked' as const;

// ─── Namespace Re-export ─────────────────────────────────────────────────────

/**
 * All SSE event types as a namespace object.
 * Convenient for destructured imports or passing as a group.
 */
export const SseEvent = {
  // Core
  Init,

  // Session lifecycle
  SessionCreated,
  SessionUpdated,
  SessionDeleted,
  SessionTerminal,
  SessionNeedsRefresh,
  SessionClearTerminal,
  SessionCompletion,
  SessionError,
  SessionExit,
  SessionIdle,
  SessionWorking,
  SessionAutoClear,
  SessionAutoCompact,
  SessionCliInfo,
  SessionMessage,
  SessionInteractive,
  SessionRunning,

  // Session: Ralph
  SessionRalphLoopUpdate,
  SessionRalphTodoUpdate,
  SessionRalphCompletionDetected,
  SessionRalphStatusUpdate,
  SessionCircuitBreakerUpdate,
  SessionExitGateMet,

  // Session: Bash tools
  SessionBashToolStart,
  SessionBashToolEnd,
  SessionBashToolsUpdate,

  // Session: Plan
  SessionPlanTaskUpdate,
  SessionPlanCheckpoint,
  SessionPlanRollback,
  SessionPlanTaskAdded,

  // Tasks
  TaskCreated,
  TaskCompleted,
  TaskFailed,
  TaskUpdated,

  // Mux
  MuxCreated,
  MuxKilled,
  MuxDied,
  MuxStatsUpdated,

  // Respawn
  RespawnStarted,
  RespawnStopped,
  RespawnStateChanged,
  RespawnCycleStarted,
  RespawnCycleCompleted,
  RespawnBlocked,
  RespawnStepSent,
  RespawnStepCompleted,
  RespawnDetectionUpdate,
  RespawnAutoAcceptSent,
  RespawnAiCheckStarted,
  RespawnAiCheckCompleted,
  RespawnAiCheckFailed,
  RespawnAiCheckCooldown,
  RespawnPlanCheckStarted,
  RespawnPlanCheckCompleted,
  RespawnPlanCheckFailed,
  RespawnTimerStarted,
  RespawnTimerCancelled,
  RespawnTimerCompleted,
  RespawnActionLog,
  RespawnLog,
  RespawnError,
  RespawnConfigUpdated,

  // Subagents
  SubagentDiscovered,
  SubagentUpdated,
  SubagentToolCall,
  SubagentToolResult,
  SubagentProgress,
  SubagentMessage,
  SubagentCompleted,

  // Scheduled runs
  ScheduledCreated,
  ScheduledUpdated,
  ScheduledCompleted,
  ScheduledStopped,
  ScheduledLog,
  ScheduledDeleted,

  // Teams
  TeamCreated,
  TeamUpdated,
  TeamRemoved,
  TeamTaskUpdated,

  // Transcript
  TranscriptComplete,
  TranscriptPlanMode,
  TranscriptToolStart,
  TranscriptToolEnd,

  // Plan orchestration
  PlanStarted,
  PlanProgress,
  PlanSubagent,
  PlanCompleted,
  PlanCancelled,

  // Tunnel
  TunnelStarted,
  TunnelStopped,
  TunnelProgress,
  TunnelError,
  TunnelQrRotated,
  TunnelQrRegenerated,
  TunnelQrAuthUsed,

  // Image
  ImageDetected,

  // Hooks
  HookIdlePrompt,
  HookPermissionPrompt,
  HookElicitationDialog,
  HookStop,
  HookTeammateIdle,
  HookTaskCompleted,

  // Cases
  CaseCreated,
  CaseLinked,
} as const;
