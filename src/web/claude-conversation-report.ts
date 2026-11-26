/**
 * @fileoverview A Claude pane's report of its live conversation: the conversation id and the
 * transcript path that Claude Code hands to every hook and to the statusline command.
 *
 * Two routes receive the report. `POST /api/hook-event` gets it from every hook Codeman
 * installs. `POST /api/status-telemetry` gets it from the statusline exporter, and Claude Code
 * runs the statusline command again about a second after a `/clear` (measured on 2.1.332), so
 * the server learns of the new conversation before the next prompt without a hook of its own.
 *
 * Both reports are first-hand: they come from the CLI process in the pane, addressed by the
 * pane's own `$CODEMAN_SESSION_ID`, so no cwd or timestamp guess is involved.
 *
 * @dependency web/schemas.ts (isValidWorkingDir), docker-hosts.ts (the Docker resume seed and the
 *   container's Claude folder)
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONTAINER_CLAUDE_DIR, persistDockerCaseClaudeSessionId } from '../docker-hosts.js';
import { getDataDir } from '../config/instance.js';
import { isValidWorkingDir } from './schemas.js';
import type { Session } from '../session.js';
import type { ConfigPort, SessionPort } from './ports/index.js';

/**
 * The host path of a transcript a pane reported. Claude in a Docker case runs with
 * `HOME=/home/agent`, so it reports `/home/agent/.claude/projects/...`, a path that does not exist
 * on the host. The case mounts the host's `~/.claude/projects` at that folder
 * (resolveDockerClaudeArtifacts in docker-hosts.ts), so the same file is under the host's folder.
 * Every other path is returned as reported.
 */
export function hostTranscriptPath(session: Pick<Session, 'docker'> | undefined, reported: string): string {
  if (!session?.docker) return reported;
  const containerProjects = `${CONTAINER_CLAUDE_DIR}/projects/`;
  if (!reported.startsWith(containerProjects)) return reported;
  const rest = reported.slice(containerProjects.length);
  // A `..` segment would leave the projects folder; such a path is left as reported.
  if (rest.split('/').some((part) => part === '..' || part === '')) return reported;
  return join(homedir(), '.claude', 'projects', rest);
}

/** The two fields of a hook or statusline payload that name the conversation. */
export interface ClaudeConversationReport {
  session_id?: unknown;
  transcript_path?: unknown;
}

/**
 * How long after a session's last accepted move a statusline report may not move it back to an
 * earlier conversation. The exporter's POST is bounded by `curl --max-time 5` (hooks-config.ts),
 * so a report sent before the newest move lands within this window.
 */
const STATUSLINE_REORDER_WINDOW_MS = 10_000;

/**
 * Sessions whose conversation moved since their last `prompt_submitted` hook. The statusline can
 * adopt a `/clear` successor before the next prompt's hook arrives, so that hook would see no
 * change in its own report; it asks {@link takeConversationMove} instead.
 */
const conversationMoves = new WeakSet<Session>();

/** When each session last moved to another conversation, for {@link STATUSLINE_REORDER_WINDOW_MS}. */
const lastConversationMoveAt = new WeakMap<Session, number>();

/**
 * Report whether the session's conversation moved since the last call for it, and forget the move.
 * The hook route calls it for each `prompt_submitted`, to record a `/clear` successor's first prompt.
 */
export function takeConversationMove(session: Session | undefined): boolean {
  return !!session && conversationMoves.delete(session);
}

/**
 * Follow the conversation a Claude pane reports: point the session's transcript watcher at the
 * reported file, adopt the reported conversation id, and persist the session when the id moved.
 * Returns true when the conversation changed.
 *
 * `forwardOnly` refuses a report that names an earlier conversation of the session's chain while
 * the session's last move is less than {@link STATUSLINE_REORDER_WINDOW_MS} old.
 */
export function noteClaudeConversationReport(
  ctx: SessionPort & Pick<ConfigPort, 'startTranscriptWatcher'>,
  sessionId: string,
  report: ClaudeConversationReport | null | undefined,
  options: { forwardOnly?: boolean } = {}
): boolean {
  if (!report) return false;

  // The statusline exporter can post out of order, because it backgrounds the POST when it wraps
  // the user's own statusline. So a statusline report moves the session back to an earlier
  // conversation, as a `/resume` makes, only when the last move is more than the window old.
  // Inside the window the move waits for the next hook or the next statusline report after it.
  if (options.forwardOnly && typeof report.session_id === 'string' && report.session_id) {
    const reported = ctx.sessions.get(sessionId);
    const chain = reported?.claudeSessionChain;
    if (
      reported &&
      chain &&
      chain.includes(report.session_id) &&
      chain[chain.length - 1] !== report.session_id &&
      Date.now() - (lastConversationMoveAt.get(reported) ?? 0) < STATUSLINE_REORDER_WINDOW_MS
    ) {
      return false;
    }
  }

  // Watch the reported transcript when its path is safe. The watcher ignores a path it already watches.
  if (typeof report.transcript_path === 'string') {
    const transcriptPath = hostTranscriptPath(ctx.sessions.get(sessionId), report.transcript_path);
    if (isValidWorkingDir(transcriptPath)) ctx.startTranscriptWatcher(sessionId, transcriptPath);
  }

  // Sync Claude's current conversation id. Interactive PTY mode never emits `session_id` on
  // stdout, so these reports are the only reliable way to learn that the user ran `/clear`,
  // which starts a new conversation file.
  if (typeof report.session_id !== 'string' || !report.session_id) return false;
  const session = ctx.sessions.get(sessionId);
  if (!session) return false;
  const prevClaudeSessionId = session.claudeSessionId;
  const prevChainLength = session.claudeSessionChain.length;
  // FIRST-HAND, so the response viewer can stop guessing (see resolveActiveClaudeSessionIdFromHistory).
  session.adoptClaudeSessionId(report.session_id, { firstHand: true });
  if (session.claudeSessionId === prevClaudeSessionId && session.claudeSessionChain.length === prevChainLength) {
    return false;
  }
  // Persist when the conversation actually moved: `/clear` emits no completion event, so without
  // this the successor id is lost on restart and recovery falls back to the launch conversation.
  ctx.persistSessionState(session);
  conversationMoves.add(session);
  lastConversationMoveAt.set(session, Date.now());
  // Docker sessions: keep the case's resume seed following the LIVE conversation, so a container
  // stop or reboot relaunch resumes the right transcript.
  if (session.docker && session.claudeSessionId && session.claudeSessionId !== prevClaudeSessionId) {
    void persistDockerCaseClaudeSessionId(getDataDir(), session.docker.containerName, session.claudeSessionId).catch(
      () => {}
    );
  }
  return true;
}
