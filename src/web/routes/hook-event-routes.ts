/**
 * @fileoverview Hook event route.
 * Receives Claude Code hook events and broadcasts to SSE clients.
 * This endpoint bypasses auth (Claude Code hooks curl from localhost).
 * Prompt events (permission_prompt / elicitation_dialog / idle_prompt) also
 * open Approvals Inbox items; stop and the elicitation-closed events clear
 * them (see web/approval-inbox.ts and docs/approvals-inbox-plan.md).
 */

import { FastifyInstance } from 'fastify';
import { ApiErrorCode, createErrorResponse } from '../../types.js';
import { HookEventSchema, isValidWorkingDir } from '../schemas.js';
import { sanitizeHookData, parseBody } from '../route-helpers.js';
import { persistDockerCaseClaudeSessionId } from '../../docker-hosts.js';
import { getDataDir } from '../../config/instance.js';
import { sessionWaits, hooksAvailableForMode, sessionHookOptions } from '../session-wait-registry.js';
import { approvalInbox, type ApprovalKind } from '../approval-inbox.js';
import type { SessionPort, EventPort, RespawnPort, ConfigPort, InfraPort } from '../ports/index.js';

/** Hook events that open an Approvals Inbox item. */
const APPROVAL_KIND_BY_EVENT: Record<string, ApprovalKind> = {
  permission_prompt: 'permission',
  elicitation_dialog: 'question',
  idle_prompt: 'idle',
};

/**
 * Hook events that close a session's pending item without an inbox answer.
 *
 * `agent_working` is here because it is the DeepSeek status bridge's report that
 * a turn STARTED, and a harness turn cannot be running while one of its own
 * modal approvals is on screen — so the agent moving means the dialog was
 * answered, in the terminal, by the user. That is the same conclusion the claude
 * path reaches through pane capture, which cannot help here because its frame
 * parser is Claude-dialog-shaped.
 */
const APPROVAL_RESOLVING_EVENTS = new Set(['stop', 'elicitation_complete', 'elicitation_response', 'agent_working']);

/**
 * Last DeepSeek status-bridge sequence number seen per session.
 *
 * The Herdr contract the dsh TUI speaks stamps every report with `--seq <n>`
 * and RETRIES failed deliveries with backoff — so a stale report can land
 * AFTER a newer one, and applying it in arrival order resolves an approval
 * with a retried `working` while the harness sits blocked, or releases a wait
 * with a retried `idle` mid-turn. A report whose seq is not newer than the
 * last accepted one is dropped, but only inside a short window: the TUI's
 * retry backoff is seconds, so a LOWER seq arriving after the window is a
 * restarted TUI's fresh numbering (same pane, new generation), not a stale
 * retry, and must be accepted. Insertion-order eviction bounds the map.
 */
const dshSeqBySession = new Map<string, { seq: number; at: number }>();
const DSH_SEQ_STALE_WINDOW_MS = 60_000;
const DSH_SEQ_MAX_SESSIONS = 500;

export function registerHookEventRoutes(
  app: FastifyInstance,
  ctx: SessionPort & EventPort & RespawnPort & ConfigPort & InfraPort
): void {
  app.post('/api/hook-event', async (req) => {
    const { event, sessionId, data } = parseBody(HookEventSchema, req.body);
    if (!ctx.sessions.has(sessionId)) {
      return createErrorResponse(ApiErrorCode.NOT_FOUND, 'Session not found');
    }

    // DeepSeek status-bridge ordering: drop a stale retried report (see
    // dshSeqBySession above). Success rather than an error, so the shim exits 0
    // and the TUI does not keep retrying a report that will stay stale.
    if (data && data.source === 'dsh-status-shim' && typeof data.seq === 'number') {
      const last = dshSeqBySession.get(sessionId);
      const now = Date.now();
      if (last && data.seq <= last.seq && now - last.at < DSH_SEQ_STALE_WINDOW_MS) {
        return {};
      }
      if (!dshSeqBySession.has(sessionId) && dshSeqBySession.size >= DSH_SEQ_MAX_SESSIONS) {
        const oldest = dshSeqBySession.keys().next().value;
        if (oldest !== undefined) dshSeqBySession.delete(oldest);
      }
      dshSeqBySession.set(sessionId, { seq: data.seq, at: now });
    }

    // Wake anything blocked on `GET /api/sessions/:id/wait`. Hooks are the only
    // DEFINITIVE signals Codeman gets (`idle` is inferred from output stabilization
    // and can flap mid-turn), so these two are what an orchestrating agent should
    // wait on.
    //
    // Gated on the session's MODE, matching `resolveWaitSignals` on the read side.
    // Without it the guard is one-sided: a caller cannot ASK for `stop` on a shell or
    // codex session, but this endpoint would happily deliver one for it. Hook events
    // carry no identity beyond a per-instance secret shared by every case, so this is
    // also the cheap half of the forgery surface — a `stop` claimed for a session that
    // could never legitimately emit one is now dropped instead of steering another
    // agent's control flow.
    const waitSession = ctx.sessions.get(sessionId);
    if (waitSession && hooksAvailableForMode(waitSession.mode, sessionHookOptions(waitSession))) {
      if (event === 'stop') {
        sessionWaits.notifySignal(sessionId, 'stop');
      } else if (event === 'permission_prompt' || event === 'elicitation_dialog') {
        sessionWaits.notifySignal(sessionId, 'blocked');
      }
    }

    // Signal the respawn controller based on hook event type
    const controller = ctx.respawnControllers.get(sessionId);
    if (controller) {
      if (event === 'elicitation_dialog') {
        // Block auto-accept for question prompts
        controller.signalElicitation();
      } else if (event === 'stop') {
        // DEFINITIVE idle signal - Claude finished responding
        controller.signalStopHook();
      } else if (event === 'idle_prompt') {
        // DEFINITIVE idle signal - Claude has been idle for 60+ seconds
        controller.signalIdlePrompt();
      }
    }

    // Start transcript watching if transcript_path is provided and safe
    if (data && 'transcript_path' in data) {
      const transcriptPath = String(data.transcript_path);
      if (transcriptPath && isValidWorkingDir(transcriptPath)) {
        ctx.startTranscriptWatcher(sessionId, transcriptPath);
      }
    }

    // Sync Claude's current conversation id. Interactive PTY mode never emits
    // `session_id` on stdout, so hooks are the only reliable way to learn that
    // the user ran `/clear` (which spins up a new conversation jsonl).
    let conversationChanged = false;
    if (data && typeof data.session_id === 'string' && data.session_id) {
      const session = ctx.sessions.get(sessionId);
      const prevClaudeSessionId = session?.claudeSessionId;
      const prevChainLength = session?.claudeSessionChain.length ?? 0;
      // FIRST-HAND: this payload came from the CLI process itself and reached us
      // because the pane's own $CODEMAN_SESSION_ID addressed it. No cwd, no
      // timestamp, nothing a sibling pane on the same folder could win — so the
      // response viewer can stop guessing entirely (see
      // resolveActiveClaudeSessionIdFromHistory).
      session?.adoptClaudeSessionId(data.session_id, { firstHand: true });
      if (event === 'prompt_submitted') {
        // Repairs `lastSubmitAt` for a pane driven straight from tmux: it was
        // bumped only by input that flowed through Codeman's own write path, so
        // it read 0 forever for those panes and every consumer of "when did this
        // pane last submit" silently degraded.
        session?.markPromptSubmitted();
      }
      // Persist when the conversation actually moved: `/clear` emits no
      // completion event, so without this the successor id is lost on restart
      // and recovery falls back to the launch conversation.
      if (
        session &&
        (session.claudeSessionId !== prevClaudeSessionId || session.claudeSessionChain.length !== prevChainLength)
      ) {
        conversationChanged = true;
        ctx.persistSessionState(session);
      }
      // Docker sessions: keep the case's resume seed following the LIVE
      // conversation (post-/clear id switches), so a container stop/reboot
      // relaunch resumes the right transcript.
      if (session?.docker && session.claudeSessionId && session.claudeSessionId !== prevClaudeSessionId) {
        void persistDockerCaseClaudeSessionId(
          getDataDir(),
          session.docker.containerName,
          session.claudeSessionId
        ).catch(() => {});
      }
    }

    // Sanitize forwarded data: only include known safe fields, limit size
    const safeData = sanitizeHookData(data);
    const session = ctx.sessions.get(sessionId);
    const sessionName = session?.name ?? sessionId.slice(0, 8);

    // Approvals Inbox: prompt events open an item, dialog-closed/stop events
    // clear it. Mode-gated like the wait signals above (hook events carry no
    // identity beyond the shared per-instance secret, so a prompt claimed for a
    // session that can never show one must not create an answerable item).
    let approvalId: string | undefined;
    // Set when the item opened ALREADY acknowledged, which today means the session is
    // watching work it started itself. It rides the broadcast so a live page declines to
    // arm the alert (a reloading page learns the same thing from `acknowledgedAt` when it
    // seeds from /api/approvals), and it suppresses the push: an alert nobody can answer
    // is worth even less on a phone than in a tab.
    let acknowledgedReason: string | undefined;
    const approvalKind = APPROVAL_KIND_BY_EVENT[event];
    if (session && hooksAvailableForMode(session.mode, sessionHookOptions(session))) {
      if (approvalKind) {
        const toolInput =
          safeData.tool_input && typeof safeData.tool_input === 'object'
            ? (safeData.tool_input as Record<string, unknown>)
            : undefined;
        const toolSummary = toolInput
          ? [toolInput.command, toolInput.file_path, toolInput.description].find((v) => typeof v === 'string')
          : undefined;
        const item = approvalInbox.notePrompt({
          sessionId,
          sessionName,
          kind: approvalKind,
          toolName: typeof safeData.tool_name === 'string' ? safeData.tool_name : undefined,
          toolSummary: typeof toolSummary === 'string' ? toolSummary : undefined,
          message: typeof safeData.message === 'string' ? safeData.message : undefined,
          cwd: typeof safeData.cwd === 'string' ? safeData.cwd : undefined,
          // What the pane says is still running in the background. An idle prompt from a
          // session that is watching its own work opens acknowledged, so it never arms an
          // alert nobody can answer; notePrompt() carries the whole reasoning.
          watching: session.watching,
          // Visible tmux frame first (it IS the dialog); raw byte-buffer tail as
          // the fallback for direct-PTY sessions and the no-op test mux.
          capture: () => {
            const muxName = session.muxName;
            const frame = muxName ? (ctx.mux.capturePaneBuffer?.(muxName) ?? null) : null;
            return frame ?? session.terminalBuffer.slice(-8192) ?? null;
          },
        });
        approvalId = item.id;
        acknowledgedReason = item.acknowledgedReason;
      } else if (APPROVAL_RESOLVING_EVENTS.has(event)) {
        approvalInbox.resolveForSession(sessionId, 'resolved_in_terminal');
      }
    }

    ctx.broadcast(`hook:${event}`, {
      sessionId,
      timestamp: Date.now(),
      ...safeData,
      ...(approvalId && { approvalId }),
      ...(acknowledgedReason && { acknowledgedReason }),
    });
    // Full state ride-along, same shape as the working/idle handlers: the home
    // screens rank the blocked group on lastActivityAt, and without this a
    // permission prompt raised after page load kept ranking by whatever stamp
    // the browser loaded with. Debounced, so a hook burst costs one broadcast.
    ctx.broadcastSessionStateDebounced(sessionId);

    // Send push notifications for hook events. Push Approve/Deny actions ride
    // on approvalId, and the answer route refuses keystrokes for dsh dialogs
    // (third-party TUI, unmeasured contract) — so a dsh push stays a plain
    // notification instead of offering buttons whose answer would be refused.
    // Nothing to push for a prompt that opened acknowledged: the agent is waiting for its
    // own monitor or backgrounded shell, and a phone buzzing about it is the same false
    // alarm as the tab alert, delivered where it is hardest to ignore.
    if (!acknowledgedReason) {
      ctx.sendPushNotifications(`hook:${event}`, {
        sessionId,
        sessionName,
        ...safeData,
        ...(approvalId && session?.mode !== 'deepseek' && { approvalId }),
      });
    }

    // Track in run summary. `prompt_submitted` fires on EVERY prompt of every
    // Claude pane; only the ones where the conversation actually moved (a /clear
    // successor) carry information, and recording the rest would push a row into
    // the Summary timeline and /api/search per turn and evict useful rows from
    // the 1000-event FIFO (#367 merge-time fix).
    const summaryTracker = ctx.runSummaryTrackers.get(sessionId);
    if (summaryTracker && (event !== 'prompt_submitted' || conversationChanged)) {
      summaryTracker.recordHookEvent(event, safeData);
    }

    return {};
  });
}
