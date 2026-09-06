/**
 * @fileoverview Session event listener wiring — creates, attaches, and detaches session listeners.
 *
 * Extracted from server.ts for modularity. Provides:
 * - `SessionListenerRefs` interface (named listener references for leak-free cleanup)
 * - `createSessionListeners()` — builds all session listener handlers via dependency injection
 * - `attachSessionListeners()` / `detachSessionListeners()` — symmetric attach/detach
 *
 * The detach function deduplicates a pattern that was previously copy-pasted 3 times
 * in server.ts (_doCleanupSession, exit handler, stop()).
 *
 * @dependencies session.ts (Session, event types), sse-events.ts, types.ts
 * @consumedby web/server.ts (WebServer delegates listener lifecycle here)
 *
 * @module web/session-listener-wiring
 */

import type {
  Session,
  ClaudeMessage,
  BackgroundTask,
  RalphTrackerState,
  RalphTodoItem,
  ActiveBashTool,
} from '../session.js';
import type { RalphStatusBlock, CircuitBreakerStatus } from '../types.js';
import { SseEvent } from './sse-events.js';
import { getLifecycleLog } from '../session-lifecycle-log.js';
import { fileStreamManager } from '../file-stream-manager.js';
import { sessionWaits } from './session-wait-registry.js';
import { approvalInbox } from './approval-inbox.js';
import { deriveAutoSessionName } from '../session-auto-name.js';

/** Stored listener references for session cleanup (prevents memory leaks) */
export interface SessionListenerRefs {
  terminal: (data: string) => void;
  clearTerminal: () => void;
  needsRefresh: () => void;
  message: (msg: ClaudeMessage) => void;
  error: (error: string) => void;
  completion: (result: string, cost: number) => void;
  exit: (code: number | null) => void;
  working: () => void;
  idle: () => void;
  taskCreated: (task: BackgroundTask) => void;
  taskUpdated: (task: BackgroundTask) => void;
  taskCompleted: (task: BackgroundTask) => void;
  taskFailed: (task: BackgroundTask, error: string) => void;
  autoClear: (data: { tokens: number; threshold: number }) => void;
  autoCompact: (data: { tokens: number; threshold: number; prompt?: string }) => void;
  limitPauseScheduled: (data: { resetAt: number; resumeAt: number; matched: string }) => void;
  limitResume: (data: { attempt: number }) => void;
  limitResumeCancelled: (data: { reason: string }) => void;
  respawnBreakerTripped: (data: { count: number }) => void;
  cliInfoUpdated: (data: { version?: string; model?: string; accountType?: string; latestVersion?: string }) => void;
  mouseTrackingChanged: (active: boolean) => void;
  ralphLoopUpdate: (state: RalphTrackerState) => void;
  ralphTodoUpdate: (todos: RalphTodoItem[]) => void;
  ralphCompletionDetected: (phrase: string) => void;
  ralphStatusBlockDetected: (block: RalphStatusBlock) => void;
  ralphCircuitBreakerUpdate: (status: CircuitBreakerStatus) => void;
  ralphExitGateMet: (data: { completionIndicators: number; exitSignal: boolean }) => void;
  bashToolStart: (tool: ActiveBashTool) => void;
  bashToolEnd: (tool: ActiveBashTool) => void;
  bashToolsUpdate: (tools: ActiveBashTool[]) => void;
  attachmentRequested: (event: { path: string; source: 'external' | 'codex-generated' }) => void;
  promptSubmitted: (prompt: string) => void;
}

/** Dependencies injected by WebServer — keeps listener creation decoupled from server internals. */
interface SessionListenerDeps {
  broadcast(event: string, data: unknown): void;
  batchTerminalData(sessionId: string, data: string): void;
  batchTaskUpdate(sessionId: string, task: BackgroundTask): void;
  broadcastSessionStateDebounced(sessionId: string): void;
  sendPushNotifications(event: string, data: Record<string, unknown>): void;
  persistSessionState(session: Session): void;
  getSessionStateWithRespawn(session: Session): unknown;
  getRunSummaryTracker(sessionId: string): import('../run-summary.js').RunSummaryTracker | undefined;
  stopTranscriptWatcher(sessionId: string): void;
  cleanupSessionBatches(sessionId: string): void;
  cancelPersistDebounce(sessionId: string): void;
  removeRunSummaryTracker(sessionId: string): void;
  removeSessionListenerRefs(sessionId: string): void;
  cleanupRespawnOnExit(sessionId: string): void;
  getStore(): import('../state-store.js').StateStore;
  registerAttachment(sessionId: string, filePath: string, source: 'external' | 'codex-generated'): Promise<void>;
  updateSessionName(sessionId: string, name: string): boolean;
}

/**
 * Creates all session listener handlers, capturing dependencies via closure.
 * Call `attachSessionListeners()` after to wire them to the session.
 */
export function createSessionListeners(session: Session, deps: SessionListenerDeps): SessionListenerRefs {
  return {
    // ─── Terminal Output ─────────────────────────────────────

    /** Batches PTY output → broadcasts `session:terminal` at 16-50ms intervals */
    terminal: (data) => {
      // Feeds `GET /api/sessions/:id/wait-output`. No-ops with a single Map lookup
      // when nothing is waiting, which is the case on virtually every chunk.
      sessionWaits.notifyOutput(session.id, data);
      deps.batchTerminalData(session.id, data);
    },

    /** Broadcasts `session:clearTerminal` — tells clients to wipe their xterm buffer (after mux attach) */
    clearTerminal: () => {
      deps.broadcast(SseEvent.SessionClearTerminal, { id: session.id });
    },

    /** Broadcasts `session:needsRefresh` — tells clients to reload buffer */
    needsRefresh: () => {
      deps.broadcast(SseEvent.SessionNeedsRefresh, { id: session.id });
    },

    // ─── Session Messages & Errors ──────────────────────────

    /** Broadcasts `session:message` — structured Claude JSON messages (assistant, tool_use, etc.) */
    message: (msg: ClaudeMessage) => {
      deps.broadcast(SseEvent.SessionMessage, { id: session.id, message: msg });
    },

    /** Broadcasts `session:error` + sends push notification */
    error: (error) => {
      deps.broadcast(SseEvent.SessionError, { id: session.id, error });
      deps.sendPushNotifications(SseEvent.SessionError, {
        sessionId: session.id,
        sessionName: session.name,
        error: String(error),
      });
      const tracker = deps.getRunSummaryTracker(session.id);
      if (tracker) tracker.recordError('Session error', String(error));
    },

    /** Broadcasts `session:completion` + `session:updated` — prompt finished, persists state */
    completion: (result, cost) => {
      deps.broadcast(SseEvent.SessionCompletion, { id: session.id, result, cost });
      deps.broadcast(SseEvent.SessionUpdated, deps.getSessionStateWithRespawn(session));
      deps.persistSessionState(session);
      const tracker = deps.getRunSummaryTracker(session.id);
      if (tracker) tracker.recordTokens(session.inputTokens, session.outputTokens);
    },

    // ─── Session Lifecycle ──────────────────────────────────

    /** Broadcasts `session:exit` + `session:updated` — PTY process exited; cleans up respawn, timers, listeners */
    exit: (code) => {
      // Before anything that can throw: a caller blocked on this session must learn
      // the process died rather than sit until its timeout.
      //
      // Both halves are required, in this order — the same pair `_doCleanupSession`
      // uses on the delete path, for the same reason. `notifySignal` resolves ONLY
      // waiters that asked for `exit`; everyone else (`until=working`, `until=stop`,
      // every wait-output) would keep a slot in the process-wide pool until their
      // timeout, on a session whose feeds this very handler is about to tear down:
      // `removeSessionListenerRefs` below detaches the `terminal` listener that is
      // the only input to `notifyOutput`, and the `idle`/`working` listeners with it.
      // Nothing can reach those waiters afterwards, so holding them is a guaranteed
      // ten-minute lie. `cancelAll` answers them `ended: true`, which the plan's §3.6
      // specifies for exactly this case ("Never hang").
      //
      // Safe against the respawn cycle: a respawn writes `/clear` + a kickstart
      // prompt through the mux and never restarts the PTY, so it emits no `exit` and
      // cannot cancel an orchestrating agent's wait. And for an agent driving a
      // worker this is the right trade even when the PTY exit was only a tmux
      // DETACH: `ended` means "re-check and re-issue", one extra round trip, versus
      // burning the caller's entire timeout learning nothing.
      sessionWaits.notifySignal(session.id, 'exit');
      sessionWaits.cancelAll(session.id);
      approvalInbox.resolveForSession(session.id, 'session_ended');
      getLifecycleLog().log({
        event: 'exit',
        sessionId: session.id,
        name: session.name,
        exitCode: code,
      });
      // Wrap in try/catch to ensure cleanup always happens
      try {
        deps.broadcast(SseEvent.SessionExit, { id: session.id, code });
        deps.broadcast(SseEvent.SessionUpdated, deps.getSessionStateWithRespawn(session));
        deps.persistSessionState(session);
      } catch (err) {
        console.error(`[Server] Error broadcasting session exit for ${session.id}:`, err);
      }

      // Always clean up respawn controller, even if broadcast failed
      try {
        deps.cleanupRespawnOnExit(session.id);
      } catch (err) {
        console.error(`[Server] Error cleaning up respawn controller for ${session.id}:`, err);
      }

      // Clean up per-session resources that are stale after PTY exit.
      try {
        // Transcript watcher is tied to the specific PTY run
        deps.stopTranscriptWatcher(session.id);

        // Finalize run summary tracker
        deps.removeRunSummaryTracker(session.id);

        // Flush/clear terminal batching state (no more output coming)
        deps.cleanupSessionBatches(session.id);

        // Clear pending persist-debounce timer
        deps.cancelPersistDebounce(session.id);

        // Close any active file streams
        fileStreamManager.closeSessionStreams(session.id);

        // Remove stored listener refs to break closure references (prevents memory leak).
        deps.removeSessionListenerRefs(session.id);
      } catch (err) {
        console.error(`[Server] Error cleaning up session resources on exit for ${session.id}:`, err);
      }
    },

    // ─── Activity State ─────────────────────────────────────

    /** Broadcasts `session:working` — Claude started processing */
    working: () => {
      sessionWaits.notifySignal(session.id, 'working');
      // An idle-prompt inbox item means "composer is waiting"; any working
      // transition means input arrived, so the item is moot. ONLY the idle
      // kind: `working` is heuristic and can flap mid-turn, so clearing a
      // pending permission/question dialog on the signal ALONE would
      // false-clear real approvals.
      approvalInbox.resolveForSession(session.id, 'resolved_in_terminal', ['idle']);
      // A permission/question dialog gets the pane-VERIFIED variant instead:
      // the signal only decides when to look, `verifyStillAnswerable` re-reads
      // the screen and resolves only when the dialog is really gone. Without
      // this, answering a dialog in the terminal left its red "needs you" alert
      // armed for the rest of the turn, because the only other staleness check
      // lives in `GET /api/approvals` and nothing calls that while a page is
      // open. `stop` was the first thing to clear it, which on a long turn is
      // minutes away.
      approvalInbox.resolveIfDialogGone(session.id);
      deps.broadcast(SseEvent.SessionWorking, { id: session.id });
      // Full state ride-along: the home screens sort the running group on
      // lastSubmitAt, and without this the browser keeps the stamp it loaded
      // with (a turn started after page load ranks by the PREVIOUS turn's
      // Enter). Debounced, so working-signal flaps cost one broadcast.
      deps.broadcastSessionStateDebounced(session.id);
      const tracker = deps.getRunSummaryTracker(session.id);
      if (tracker) {
        tracker.recordWorking();
        tracker.recordTokens(session.inputTokens, session.outputTokens);
      }
    },

    /** Broadcasts `session:idle` — Claude finished processing, waiting for input */
    idle: () => {
      sessionWaits.notifySignal(session.id, 'idle');
      deps.broadcast(SseEvent.SessionIdle, { id: session.id });
      deps.broadcastSessionStateDebounced(session.id);
      const tracker = deps.getRunSummaryTracker(session.id);
      if (tracker) {
        tracker.recordIdle();
        tracker.recordTokens(session.inputTokens, session.outputTokens);
      }
    },

    // ─── Background Task Events ──────────────────────────────

    /** Broadcasts `task:created` — new background task discovered */
    taskCreated: (task: BackgroundTask) => {
      deps.broadcast(SseEvent.TaskCreated, { sessionId: session.id, task });
      deps.broadcastSessionStateDebounced(session.id);
    },

    /** Batched broadcast of `task:updated` — high-frequency progress updates */
    taskUpdated: (task: BackgroundTask) => {
      deps.batchTaskUpdate(session.id, task);
    },

    /** Broadcasts `task:completed` — background task finished successfully */
    taskCompleted: (task: BackgroundTask) => {
      deps.broadcast(SseEvent.TaskCompleted, { sessionId: session.id, task });
      deps.broadcastSessionStateDebounced(session.id);
    },

    /** Broadcasts `task:failed` — background task errored */
    taskFailed: (task: BackgroundTask, error: string) => {
      deps.broadcast(SseEvent.TaskFailed, { sessionId: session.id, task, error });
      deps.broadcastSessionStateDebounced(session.id);
    },

    // ─── Auto-Operations ────────────────────────────────────

    /** Broadcasts `session:autoClear` — context window auto-cleared at token threshold */
    autoClear: (data: { tokens: number; threshold: number }) => {
      deps.broadcast(SseEvent.SessionAutoClear, { sessionId: session.id, ...data });
      deps.broadcastSessionStateDebounced(session.id);
      const tracker = deps.getRunSummaryTracker(session.id);
      if (tracker) tracker.recordAutoClear(data.tokens, data.threshold);
    },

    /** Broadcasts `session:autoCompact` — context window auto-compacted at token threshold */
    autoCompact: (data: { tokens: number; threshold: number; prompt?: string }) => {
      deps.broadcast(SseEvent.SessionAutoCompact, { sessionId: session.id, ...data });
      deps.broadcastSessionStateDebounced(session.id);
      const tracker = deps.getRunSummaryTracker(session.id);
      if (tracker) tracker.recordAutoCompact(data.tokens, data.threshold);
    },

    /** Broadcasts `session:limitPauseScheduled` — usage-limit pause detected, auto-resume armed.
     *  Persisted so a pending schedule survives a Codeman restart. */
    limitPauseScheduled: (data: { resetAt: number; resumeAt: number; matched: string }) => {
      deps.broadcast(SseEvent.SessionLimitPauseScheduled, { sessionId: session.id, ...data });
      deps.broadcastSessionStateDebounced(session.id);
      deps.persistSessionState(session);
    },

    /** Broadcasts `session:limitResume` — auto-resume prompt sent after limit reset */
    limitResume: (data: { attempt: number }) => {
      deps.broadcast(SseEvent.SessionLimitResume, { sessionId: session.id, ...data });
      deps.broadcastSessionStateDebounced(session.id);
      deps.persistSessionState(session);
    },

    /** Broadcasts `session:limitResumeCancelled` — pending auto-resume no longer needed */
    limitResumeCancelled: (data: { reason: string }) => {
      deps.broadcast(SseEvent.SessionLimitResumeCancelled, { sessionId: session.id, ...data });
      deps.broadcastSessionStateDebounced(session.id);
      deps.persistSessionState(session);
    },

    /**
     * Broadcasts `session:respawnBreakerTripped` (COD-118) — repeated non-zero PTY exits
     * tripped the circuit breaker; the session is now errored and respawn is blocked.
     * Also pushes the errored state (`session:updated`) so the tab renders the error,
     * persists it, and notifies for diagnostic visibility.
     */
    respawnBreakerTripped: (data: { count: number }) => {
      deps.broadcast(SseEvent.SessionRespawnBreakerTripped, { sessionId: session.id, ...data });
      deps.broadcast(SseEvent.SessionUpdated, deps.getSessionStateWithRespawn(session));
      deps.persistSessionState(session);
      deps.sendPushNotifications(SseEvent.SessionRespawnBreakerTripped, {
        sessionId: session.id,
        sessionName: session.name,
        count: data.count,
      });
      const tracker = deps.getRunSummaryTracker(session.id);
      if (tracker) {
        tracker.recordError('Respawn circuit breaker tripped', `${data.count} non-zero PTY exits within window`);
      }
    },

    // ─── CLI Info ────────────────────────────────────────────

    /** Broadcasts `session:cliInfo` — Claude Code version, model, account type parsed from terminal */
    cliInfoUpdated: (data: { version?: string; model?: string; accountType?: string; latestVersion?: string }) => {
      deps.broadcast(SseEvent.SessionCliInfo, { sessionId: session.id, ...data });
      deps.broadcastSessionStateDebounced(session.id);
    },

    /**
     * The CLI turned mouse tracking on or off (observed while stripping the
     * DECSETs out of the stream). Rides the full session state so the browser
     * learns it through the session object it already merges, with no new SSE
     * event to keep in sync across the two registries.
     *
     * Broadcast IMMEDIATELY, not debounced: this flips when a dialog opens, and
     * a user can click that dialog inside the 500ms debounce window, which is
     * exactly the click that has to be reported.
     */
    mouseTrackingChanged: () => {
      deps.broadcast(SseEvent.SessionUpdated, { session: deps.getSessionStateWithRespawn(session) });
    },

    // ─── Ralph Tracking Events ──────────────────────────────

    /** Broadcasts `session:ralphLoopUpdate` — Ralph tracker loop state changed (iteration, phase) */
    ralphLoopUpdate: (state: RalphTrackerState) => {
      deps.broadcast(SseEvent.SessionRalphLoopUpdate, { sessionId: session.id, state });
      deps.getStore().updateRalphState(session.id, { loop: state });
    },

    /** Broadcasts `session:ralphTodoUpdate` — todo items added, completed, or modified */
    ralphTodoUpdate: (todos: RalphTodoItem[]) => {
      deps.broadcast(SseEvent.SessionRalphTodoUpdate, { sessionId: session.id, todos });
      deps.getStore().updateRalphState(session.id, { todos });
    },

    /** Broadcasts `session:ralphCompletionDetected` + push notification — completion phrase matched */
    ralphCompletionDetected: (phrase: string) => {
      deps.broadcast(SseEvent.SessionRalphCompletionDetected, { sessionId: session.id, phrase });
      deps.sendPushNotifications(SseEvent.SessionRalphCompletionDetected, {
        sessionId: session.id,
        sessionName: session.name,
        phrase,
      });
      const tracker = deps.getRunSummaryTracker(session.id);
      if (tracker) tracker.recordRalphCompletion(phrase);
    },

    /** Broadcasts `session:ralphStatusUpdate` — RALPH_STATUS block parsed from output */
    ralphStatusBlockDetected: (block: RalphStatusBlock) => {
      deps.broadcast(SseEvent.SessionRalphStatusUpdate, { sessionId: session.id, block });
      const tracker = deps.getRunSummaryTracker(session.id);
      if (tracker) {
        tracker.addEvent(
          block.status === 'BLOCKED' ? 'warning' : 'idle_detected',
          block.status === 'BLOCKED' ? 'warning' : 'info',
          `Ralph Status: ${block.status}`,
          `Tasks: ${block.tasksCompletedThisLoop}, Files: ${block.filesModified}, Tests: ${block.testsStatus}`
        );
      }
    },

    /** Broadcasts `session:circuitBreakerUpdate` — circuit breaker state changed (CLOSED/HALF_OPEN/OPEN) */
    ralphCircuitBreakerUpdate: (status: CircuitBreakerStatus) => {
      deps.broadcast(SseEvent.SessionCircuitBreakerUpdate, { sessionId: session.id, status });
      const tracker = deps.getRunSummaryTracker(session.id);
      if (tracker && status.state === 'OPEN') {
        tracker.addEvent('warning', 'warning', 'Circuit Breaker Opened', status.reason);
      }
    },

    /** Broadcasts `session:exitGateMet` — all completion indicators met, ready to exit */
    ralphExitGateMet: (data: { completionIndicators: number; exitSignal: boolean }) => {
      deps.broadcast(SseEvent.SessionExitGateMet, { sessionId: session.id, ...data });
      const tracker = deps.getRunSummaryTracker(session.id);
      if (tracker) {
        tracker.addEvent(
          'ralph_completion',
          'success',
          'Exit Gate Met',
          `Indicators: ${data.completionIndicators}, EXIT_SIGNAL: ${data.exitSignal}`
        );
      }
    },

    // ─── Bash Tool Tracking ────────────────────────────────

    /** Broadcasts `session:bashToolStart` — bash tool invocation started */
    bashToolStart: (tool: ActiveBashTool) => {
      deps.broadcast(SseEvent.SessionBashToolStart, { sessionId: session.id, tool });
    },

    /** Broadcasts `session:bashToolEnd` — bash tool invocation completed */
    bashToolEnd: (tool: ActiveBashTool) => {
      deps.broadcast(SseEvent.SessionBashToolEnd, { sessionId: session.id, tool });
    },

    /** Broadcasts `session:bashToolsUpdate` — full active bash tools list refreshed */
    bashToolsUpdate: (tools: ActiveBashTool[]) => {
      deps.broadcast(SseEvent.SessionBashToolsUpdate, { sessionId: session.id, tools });
    },

    /** Registers an explicit attachment card requested by terminal magic text. */
    attachmentRequested: (event: { path: string; source: 'external' | 'codex-generated' }) => {
      deps.registerAttachment(session.id, event.path, event.source).catch((err) => {
        console.error(`[Attachment] Failed to register ${event.path} for ${session.id}:`, err);
      });
    },

    /** Assigns a bounded local title from the first real task prompt. */
    promptSubmitted: (prompt: string) => {
      const name = deriveAutoSessionName(prompt);
      if (!name || !session.applyAutoName(name)) return;
      deps.updateSessionName(session.id, session.name);
      deps.persistSessionState(session);
      deps.broadcast(SseEvent.SessionUpdated, deps.getSessionStateWithRespawn(session));
    },
  };
}

/** Attach all listeners to a session. */
export function attachSessionListeners(session: Session, refs: SessionListenerRefs): void {
  session.on('terminal', refs.terminal);
  session.on('clearTerminal', refs.clearTerminal);
  session.on('needsRefresh', refs.needsRefresh);
  session.on('message', refs.message);
  session.on('error', refs.error);
  session.on('completion', refs.completion);
  session.on('exit', refs.exit);
  session.on('working', refs.working);
  session.on('idle', refs.idle);
  session.on('taskCreated', refs.taskCreated);
  session.on('taskUpdated', refs.taskUpdated);
  session.on('taskCompleted', refs.taskCompleted);
  session.on('taskFailed', refs.taskFailed);
  session.on('autoClear', refs.autoClear);
  session.on('autoCompact', refs.autoCompact);
  session.on('limitPauseScheduled', refs.limitPauseScheduled);
  session.on('limitResume', refs.limitResume);
  session.on('limitResumeCancelled', refs.limitResumeCancelled);
  session.on('respawnBreakerTripped', refs.respawnBreakerTripped);
  session.on('cliInfoUpdated', refs.cliInfoUpdated);
  session.on('mouseTrackingChanged', refs.mouseTrackingChanged);
  session.on('ralphLoopUpdate', refs.ralphLoopUpdate);
  session.on('ralphTodoUpdate', refs.ralphTodoUpdate);
  session.on('ralphCompletionDetected', refs.ralphCompletionDetected);
  session.on('ralphStatusBlockDetected', refs.ralphStatusBlockDetected);
  session.on('ralphCircuitBreakerUpdate', refs.ralphCircuitBreakerUpdate);
  session.on('ralphExitGateMet', refs.ralphExitGateMet);
  session.on('bashToolStart', refs.bashToolStart);
  session.on('bashToolEnd', refs.bashToolEnd);
  session.on('bashToolsUpdate', refs.bashToolsUpdate);
  session.on('attachmentRequested', refs.attachmentRequested);
  session.on('promptSubmitted', refs.promptSubmitted);
}

/** Detach all listeners from a session (prevents memory leaks from closure references). */
export function detachSessionListeners(session: Session, refs: SessionListenerRefs): void {
  session.off('terminal', refs.terminal);
  session.off('clearTerminal', refs.clearTerminal);
  session.off('needsRefresh', refs.needsRefresh);
  session.off('message', refs.message);
  session.off('error', refs.error);
  session.off('completion', refs.completion);
  session.off('exit', refs.exit);
  session.off('working', refs.working);
  session.off('idle', refs.idle);
  session.off('taskCreated', refs.taskCreated);
  session.off('taskUpdated', refs.taskUpdated);
  session.off('taskCompleted', refs.taskCompleted);
  session.off('taskFailed', refs.taskFailed);
  session.off('autoClear', refs.autoClear);
  session.off('autoCompact', refs.autoCompact);
  session.off('limitPauseScheduled', refs.limitPauseScheduled);
  session.off('limitResume', refs.limitResume);
  session.off('limitResumeCancelled', refs.limitResumeCancelled);
  session.off('respawnBreakerTripped', refs.respawnBreakerTripped);
  session.off('cliInfoUpdated', refs.cliInfoUpdated);
  session.off('mouseTrackingChanged', refs.mouseTrackingChanged);
  session.off('ralphLoopUpdate', refs.ralphLoopUpdate);
  session.off('ralphTodoUpdate', refs.ralphTodoUpdate);
  session.off('ralphCompletionDetected', refs.ralphCompletionDetected);
  session.off('ralphStatusBlockDetected', refs.ralphStatusBlockDetected);
  session.off('ralphCircuitBreakerUpdate', refs.ralphCircuitBreakerUpdate);
  session.off('ralphExitGateMet', refs.ralphExitGateMet);
  session.off('bashToolStart', refs.bashToolStart);
  session.off('bashToolEnd', refs.bashToolEnd);
  session.off('bashToolsUpdate', refs.bashToolsUpdate);
  session.off('attachmentRequested', refs.attachmentRequested);
  session.off('promptSubmitted', refs.promptSubmitted);
}
