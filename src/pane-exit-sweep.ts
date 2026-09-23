/**
 * @fileoverview The exited-agent sweep's decision rule (Ark0N/Codeman#446).
 *
 * Codeman creates every tmux pane with `remain-on-exit on`, so `/exit` ends the
 * CLI while the pane, the tmux session and the `tmux attach-session` process
 * all live on. Part 1 of #446 records that as `SessionState.paneExit`. This
 * module decides when such a session is closed, the way the X button closes
 * it, so finished sessions stop piling up on the board.
 *
 * The rule closes a session only on a POSITIVE observation of a clean exit:
 *
 * - The exit status must be an explicit numeric 0 with no signal. An absent
 *   status is UNKNOWN, never 0: on tmux 3.2a a SIGKILLed pane reports neither a
 *   status nor a signal, so reading absence as clean would sweep an agent the
 *   OOM killer took. A non-zero status or any signal keeps the row, marked with
 *   the exit, as the crash evidence #210 was filed to keep.
 * - At least {@link CLEAN_EXIT_CONFIRMING_READS} authoritative pane reads must
 *   have agreed on that exit. A failed, empty or skipped read counts for
 *   nothing, because unknown never closes anything.
 * - No start, attach or relaunch may be in flight for the session. The
 *   dead-pane branch of `Session._setupOrAttachMuxSession()` respawns an exited
 *   pane on purpose, and for a few seconds that pane still reads as dead.
 *
 * Scoping to local mux-backed sessions happens before this rule runs:
 * `Session.setPaneExit()` forces the field to UNKNOWN for direct-PTY, remote,
 * docker and discovered sessions, so their `paneExit` never reaches here.
 *
 * Pure, so the rule is unit-tested without a server (test/pane-exit-sweep.test.ts).
 */
import type { PaneExit } from './types/index.js';

/**
 * How many authoritative pane reads must agree on a clean exit before the
 * session is closed. At the watcher's 2 s cadence two reads mean a finished
 * session disappears within about four seconds of its agent exiting.
 */
export const CLEAN_EXIT_CONFIRMING_READS = 2;

/** The lifecycle-log reason recorded when the sweep closes a session. */
export const CLEAN_EXIT_CLOSE_REASON = 'agent exited cleanly (status 0)';

/**
 * Is this exit a clean one? True only for an explicit numeric status of 0 with
 * no signal reported.
 *
 * ⚠ Never widen this to `(exit.status ?? 0) === 0` or to "no signal, so it was
 * clean". An absent status is how a signal death presents on tmux 3.2a, and
 * that shortcut would close crashed agents with nothing failing to warn you.
 */
export function isCleanPaneExit(exit: PaneExit | undefined): boolean {
  if (!exit) return false;
  if (exit.signal !== undefined) return false;
  return exit.status === 0;
}

/** Everything the sweep needs to know about one session. */
export interface CleanExitSweepCandidate {
  /** The session's published exit, already scoped by `Session.setPaneExit()`. */
  paneExit: PaneExit | undefined;
  /** Authoritative pane reads that agreed on that exit (`getPaneExitReadCount()`). */
  confirmingReads: number;
  /** A start, attach or relaunch is running for this session's pane. */
  paneLifecycleInFlight: boolean;
  /** The session is already being closed or detached. */
  closing: boolean;
}

/** Should the sweep close this session now? See the file overview for the rule. */
export function shouldCloseCleanlyExitedSession(candidate: CleanExitSweepCandidate): boolean {
  if (candidate.closing) return false;
  if (candidate.paneLifecycleInFlight) return false;
  if (!isCleanPaneExit(candidate.paneExit)) return false;
  return candidate.confirmingReads >= CLEAN_EXIT_CONFIRMING_READS;
}
