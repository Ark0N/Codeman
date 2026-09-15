/**
 * @fileoverview Centralized SSE event type registry — single source of truth.
 *
 * All Server-Sent Event type strings used by the backend (`broadcast()` calls)
 * and referenced by the frontend (`SSE_EVENTS` in `constants.js`).
 * Both files MUST be kept in sync.
 *
 * 158 event constants organized by category:
 * - **Core** (1): init
 * - **Transport** (1): sse:heartbeat
 * - **Session lifecycle** (23): created, updated, deleted, terminal, idle, working, ...
 * - **Session: Ralph** (6): ralphLoopUpdate, todoUpdate, completionDetected, ...
 * - **Session: Bash tools** (3): bashToolStart, bashToolEnd, bashToolsUpdate
 * - **Session: Plan** (4): planTaskUpdate, planCheckpoint, planRollback, planTaskAdded
 * - **Tasks** (4): created, completed, failed, updated
 * - **Mux** (4): created, killed, died, statsUpdated
 * - **Remote auto-reconnect** (3): sessionDropped, sessionReconnected, reconnectExhausted
 * - **Respawn** (24): stateChanged, cycleStarted/Completed, step*, aiCheck*, planCheck*, timer*, log, ...
 * - **Subagents** (7): discovered, updated, tool_call, tool_result, progress, message, completed
 * - **Workflow runs** (3): run_discovered, run_updated, run_removed (ultracode / Workflow tool)
 * - **Scheduled** (6): created, updated, completed, stopped, log, deleted
 * - **Cron jobs** (4): jobsChanged, jobDeleted, runCreated, runUpdated
 * - **Teams** (4): created, updated, removed, taskUpdated
 * - **Transcript** (4): complete, plan_mode, tool_start, tool_end
 * - **Plan orchestration** (5): started, progress, subagent, completed, cancelled
 * - **Tunnel** (7): started, stopped, progress, error, qrRotated, qrRegenerated, qrAuthUsed
 * - **Image / attachments** (2): image:detected, attachment:detected
 * - **Hooks** (10): idle_prompt, permission_prompt, elicitation_dialog, elicitation_complete, elicitation_response, stop, agent_working, teammate_idle, task_completed, prompt_submitted
 *   (agent_working is the odd one out: reported by the DeepSeek Harness status bridge, not by a Claude Code hook)
 * - **Approvals** (3): pending, updated, resolved (cross-session Approvals Inbox)
 * - **Orchestrator** (12): stateChanged, planProgress, planReady, phase*, verification, task*, completed, error
 * - **Clipboard** (1): write
 * - **Cases** (4): created, linked, deleted, order-changed
 * - **Docker cases** (8): exportComplete/Failed, importComplete, imageBuild*, containerRecreated
 * - **Multi-user** (3): admin:usersChanged, auth:passwordChangeRequired, session:orderChanged
 * - **Web tabs** (2): webview:changed, tab:layoutChanged
 *
 * Naming convention: `domain:action` (e.g., `session:created`, `respawn:stateChanged`)
 *
 * Key export: `SseEvent` namespace object — import for destructured access.
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

// ─── Transport ───────────────────────────────────────────────────────────────

/**
 * Liveness frame written to every SSE client every `SSE_HEARTBEAT_INTERVAL`.
 * Payload: `{ t: <epoch ms> }`.
 *
 * Carries no application data; its only job is to be *observable*. This was a
 * `:keepalive` SSE **comment**, and comments are invisible to `EventSource` by
 * spec, so a stream that stopped delivering without erroring (a proxy that
 * idle-closed it, a laptop resumed from sleep, a tailnet reconnect) was
 * undetectable to the client: `onerror` never fires and the UI freezes until a
 * reload. A named event reaches a listener, which is what lets the client's
 * staleness watchdog notice the silence and force a reconnect.
 */
export const Heartbeat = 'sse:heartbeat' as const;

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
/** Usage-limit pause detected; auto-resume scheduled. */
export const SessionLimitPauseScheduled = 'session:limitPauseScheduled' as const;
/** Auto-resume prompt sent after a usage-limit reset. */
export const SessionLimitResume = 'session:limitResume' as const;
/** Pending usage-limit auto-resume cancelled (session resumed or feature disabled). */
export const SessionLimitResumeCancelled = 'session:limitResumeCancelled' as const;
/** Interactive-PTY exit circuit breaker tripped (COD-118): repeated non-zero exits; respawn blocked, session errored. */
export const SessionRespawnBreakerTripped = 'session:respawnBreakerTripped' as const;
/** CLI version/model info detected from session output. */
export const SessionCliInfo = 'session:cliInfo' as const;
/** Session pin state changed (COD-139): pinned/unpinned in the session manager list. */
export const SessionPinned = 'session:pinned' as const;
/** General session message (e.g. status text). */
export const SessionMessage = 'session:message' as const;
/** Session entered interactive mode (claude or shell). */
export const SessionInteractive = 'session:interactive' as const;
/** Prompt sent to session for execution. */
export const SessionRunning = 'session:running' as const;
/** Combined Claude and main Codex plan-usage telemetry for the shared header chip. */
export const SessionStatusTelemetry = 'session:statusTelemetry' as const;

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

// ─── Remote auto-reconnect (COD-108) ─────────────────────────────────────────

/** A remote session's local ssh pane died; an auto-reconnect attempt is starting. */
export const RemoteSessionDropped = 'remote:sessionDropped' as const;
/** A dropped remote session was successfully re-established (reattached). */
export const RemoteSessionReconnected = 'remote:sessionReconnected' as const;
/** Auto-reconnect gave up after the bounded backoff cap — manual reconnect needed. */
export const RemoteReconnectExhausted = 'remote:reconnectExhausted' as const;
/**
 * User input arrived for a session whose host is unreachable, so a Wake-on-LAN
 * command was started (see `remote-wake.ts`). Input sent meanwhile is buffered.
 */
export const RemoteHostWaking = 'remote:hostWaking' as const;
/** The host did not come back within the wake timeout — buffered input is still held. */
export const RemoteHostWakeFailed = 'remote:hostWakeFailed' as const;

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

// ─── Workflow Runs (ultracode / Workflow tool) ───────────────────────────────

/** A workflow run was discovered (first time seen). Payload: WorkflowRunInfo. */
export const WorkflowRunDiscovered = 'workflow:run_discovered' as const;
/** A workflow run changed (agent state/token tick). Payload: WorkflowRunInfo. */
export const WorkflowRunUpdated = 'workflow:run_updated' as const;
/** A workflow run's file disappeared. Payload: { runId: string }. */
export const WorkflowRunRemoved = 'workflow:run_removed' as const;

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

// ─── Cron Jobs ───────────────────────────────────

/** The scheduled-jobs list changed (created/updated/enabled/run-status). Payload: { jobs }. */
export const CronJobsChanged = 'cron:jobsChanged' as const;
/** A scheduled job was deleted. Payload: { id }. */
export const CronJobDeleted = 'cron:jobDeleted' as const;
/** A scheduled-job run (history record) was created. Payload: CronJobRun. */
export const CronRunCreated = 'cron:runCreated' as const;
/** A scheduled-job run (history record) was updated. Payload: CronJobRun. */
export const CronRunUpdated = 'cron:runUpdated' as const;

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
/** New document/image attachment detected in a session working directory. */
export const AttachmentDetected = 'attachment:detected' as const;

// ─── Hooks ───────────────────────────────────────────────────────────────────

/** Claude Code hook: session idle, waiting for input. */
export const HookIdlePrompt = 'hook:idle_prompt' as const;
/** Claude Code hook: tool requesting permission. */
export const HookPermissionPrompt = 'hook:permission_prompt' as const;
/** Claude Code hook: elicitation dialog (Claude asking a question). */
export const HookElicitationDialog = 'hook:elicitation_dialog' as const;
/** Claude Code hook: elicitation dialog closed (question answered in the terminal). */
export const HookElicitationComplete = 'hook:elicitation_complete' as const;
/** Claude Code hook: elicitation answer submitted. */
export const HookElicitationResponse = 'hook:elicitation_response' as const;
/** Claude Code hook: response complete. */
export const HookStop = 'hook:stop' as const;
/**
 * Agent started a turn. NOT a Claude Code hook: this one is reported by the
 * DeepSeek Harness status bridge, which is why the name is agent-generic. It
 * exists so a dialog answered in the terminal clears its alert immediately
 * instead of waiting for the turn to end.
 */
export const HookAgentWorking = 'hook:agent_working' as const;
/** Claude Code hook: teammate went idle. */
export const HookTeammateIdle = 'hook:teammate_idle' as const;
/** Claude Code hook: teammate task completed. */
export const HookTaskCompleted = 'hook:task_completed' as const;
/** UserPromptSubmit fired in a Claude pane (#367): the pane learned its live conversation id first-hand. */
export const HookPromptSubmitted = 'hook:prompt_submitted' as const;

// ─── Approvals Inbox ─────────────────────────────────────────────────────────

/** A prompt is waiting on a human (permission dialog, question, idle prompt). */
export const ApprovalPending = 'approval:pending' as const;
/** A pending approval's captured context/options were refreshed. */
export const ApprovalUpdated = 'approval:updated' as const;
/** A pending approval left the inbox (answered, superseded, expired, ...). */
export const ApprovalResolved = 'approval:resolved' as const;

// ─── Orchestrator ────────────────────────────────────────────────────────────

/** Orchestrator state machine transitioned. */
export const OrchestratorStateChanged = 'orchestrator:stateChanged' as const;
/** Orchestrator plan generation progress update. */
export const OrchestratorPlanProgress = 'orchestrator:planProgress' as const;
/** Orchestrator plan generated and ready for approval. */
export const OrchestratorPlanReady = 'orchestrator:planReady' as const;
/** Orchestrator phase started executing. */
export const OrchestratorPhaseStarted = 'orchestrator:phaseStarted' as const;
/** Orchestrator phase completed successfully. */
export const OrchestratorPhaseCompleted = 'orchestrator:phaseCompleted' as const;
/** Orchestrator phase failed. */
export const OrchestratorPhaseFailed = 'orchestrator:phaseFailed' as const;
/** Orchestrator verification result for a phase. */
export const OrchestratorVerification = 'orchestrator:verification' as const;
/** Orchestrator task assigned to session. */
export const OrchestratorTaskAssigned = 'orchestrator:taskAssigned' as const;
/** Orchestrator task completed. */
export const OrchestratorTaskCompleted = 'orchestrator:taskCompleted' as const;
/** Orchestrator task failed. */
export const OrchestratorTaskFailed = 'orchestrator:taskFailed' as const;
/** All orchestrator phases completed successfully. */
export const OrchestratorCompleted = 'orchestrator:completed' as const;
/** Orchestrator error. */
export const OrchestratorError = 'orchestrator:error' as const;

// ─── Clipboard ──────────────────────────────────────────────────────────────

/** Clipboard content pushed to browser. */
export const ClipboardWrite = 'clipboard:write' as const;

// ─── Cases ───────────────────────────────────────────────────────────────────

/** New case directory created. */
export const CaseCreated = 'case:created' as const;
/** Existing directory linked as a case. */
export const CaseLinked = 'case:linked' as const;
/** Case deleted or unlinked. */
export const CaseDeleted = 'case:deleted' as const;
/** Case ordering changed. */
export const CaseOrderChanged = 'case:order-changed' as const;

// ─── Docker cases ────────────────────────────────────────────────────────────
/** A docker case export bundle finished writing. */
export const DockerExportComplete = 'docker:exportComplete' as const;
/** A docker case export failed. */
export const DockerExportFailed = 'docker:exportFailed' as const;
/** A docker bundle was imported into a new case. */
export const DockerImportComplete = 'docker:importComplete' as const;
/** The agent base image started building (first Docker case; auto-build on first use). */
export const DockerImageBuildStarted = 'docker:imageBuildStarted' as const;
/** A line of agent base-image build output (progress surfacing). */
export const DockerImageBuildProgress = 'docker:imageBuildProgress' as const;
/** The agent base image finished building successfully. */
export const DockerImageBuildComplete = 'docker:imageBuildComplete' as const;
/** The agent base image build failed. */
export const DockerImageBuildFailed = 'docker:imageBuildFailed' as const;
/** A case container was removed after a config-drift confirm (recreated with the new config on next launch). */
export const DockerContainerRecreated = 'docker:containerRecreated' as const;

// ─── Multi-user (admin-only / targeted) ──────────────────────────────────────

/** The user roster changed (admin-only); the Users panel re-fetches. */
export const AdminUsersChanged = 'admin:usersChanged' as const;
/** A user must change their password (targeted); the frontend shows the modal. */
export const AuthPasswordChangeRequired = 'auth:passwordChangeRequired' as const;

/** Global session tab order changed (synced across devices). COD-131. */
export const SessionOrderChanged = 'session:orderChanged' as const;

/** A saved web tab (dashboard URL) was created, updated or deleted.
 *  Payload: `{ action: 'created' | 'updated' | 'deleted', id }`. The client
 *  re-fetches the list rather than patching from the payload. */
export const WebviewChanged = 'webview:changed' as const;
/** Owner-scoped layout invalidation. Payload contains only `{ owner, version }`. */
export const TabLayoutChanged = 'tab:layoutChanged' as const;

// ─── Namespace Re-export ─────────────────────────────────────────────────────

/**
 * All SSE event types as a namespace object.
 * Convenient for destructured imports or passing as a group.
 */
export const SseEvent = {
  // Core
  Init,

  // Transport
  Heartbeat,

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
  SessionLimitPauseScheduled,
  SessionLimitResume,
  SessionLimitResumeCancelled,
  SessionRespawnBreakerTripped,
  SessionCliInfo,
  SessionPinned,
  SessionMessage,
  SessionInteractive,
  SessionRunning,
  SessionStatusTelemetry,

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

  // Remote auto-reconnect (COD-108)
  RemoteSessionDropped,
  RemoteSessionReconnected,
  RemoteReconnectExhausted,
  RemoteHostWaking,
  RemoteHostWakeFailed,

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

  // Workflow runs (ultracode)
  WorkflowRunDiscovered,
  WorkflowRunUpdated,
  WorkflowRunRemoved,

  // Scheduled runs
  ScheduledCreated,
  ScheduledUpdated,
  ScheduledCompleted,
  ScheduledStopped,
  ScheduledLog,
  ScheduledDeleted,

  // Cron jobs
  CronJobsChanged,
  CronJobDeleted,
  CronRunCreated,
  CronRunUpdated,

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
  AttachmentDetected,

  // Hooks
  HookIdlePrompt,
  HookPermissionPrompt,
  HookElicitationDialog,
  HookElicitationComplete,
  HookElicitationResponse,
  HookStop,
  HookAgentWorking,
  HookTeammateIdle,
  HookTaskCompleted,

  // Approvals Inbox
  ApprovalPending,
  ApprovalUpdated,
  ApprovalResolved,

  // Orchestrator
  OrchestratorStateChanged,
  OrchestratorPlanProgress,
  OrchestratorPlanReady,
  OrchestratorPhaseStarted,
  OrchestratorPhaseCompleted,
  OrchestratorPhaseFailed,
  OrchestratorVerification,
  OrchestratorTaskAssigned,
  OrchestratorTaskCompleted,
  OrchestratorTaskFailed,
  OrchestratorCompleted,
  OrchestratorError,

  // Clipboard
  ClipboardWrite,

  // Cases
  CaseCreated,
  CaseLinked,
  CaseDeleted,
  CaseOrderChanged,

  // Docker cases
  DockerExportComplete,
  DockerExportFailed,
  DockerImportComplete,
  DockerImageBuildStarted,
  DockerImageBuildProgress,
  DockerImageBuildComplete,
  DockerImageBuildFailed,
  AdminUsersChanged,
  AuthPasswordChangeRequired,
  DockerContainerRecreated,

  // Session order (global tab order sync)
  SessionOrderChanged,

  // Web tabs (dashboard URLs)
  WebviewChanged,
  TabLayoutChanged,
} as const;
