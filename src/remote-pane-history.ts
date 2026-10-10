/**
 * @fileoverview Scrollback of a remote SSH session, read from the REMOTE tmux.
 *
 * A remote session's local pane runs `ssh -t … tmux new-session -A` (or `attach`),
 * so the local tmux only ever sees what the remote tmux CLIENT draws: full-screen
 * repaints, not scrolling output. The local pane therefore keeps a fraction of the
 * history (measured: 48 of 279 lines while output streamed, none after a reattach),
 * while the remote pane, where the shell really runs, keeps all of it. A full-history
 * load of a remote session reads the scrollback from there instead, and the caller
 * splices it above the LOCAL visible frame (`PaneCaptureOptions.scrollbackOverride`):
 * the local pane is what the live stream keeps drawing into, so its frame and caret
 * position are the ones the browser must end up with.
 *
 * ONE ssh round trip prints the remote pane's `#{history_size}` and its scrollback
 * rows (`capture-pane -S -<N> -E -1`). The size is load-bearing: with no history at
 * all, tmux clamps `-E -1` to the first VISIBLE row and would return it as history.
 *
 * Bounded and fail-soft. Any failure (unreachable host, auth, missing session, odd
 * output) returns null and the caller keeps the local capture, so a remote load is
 * never worse than before. A failure also starts a short per-host back-off, so a
 * host that is asleep costs one timeout, not one per tab switch. The child runs under
 * the shared remote-ssh limiter (`remote-ssh-limiter.ts`) like every other short-lived
 * remote ssh, but gives up on a slot it waited too long for, and the connection
 * options come from `buildSshConnectionArgs()`.
 *
 * How much history exists is the REMOTE tmux's `history-limit` (2000 lines unless
 * the remote user's tmux.conf raises it); the launch command does not set it.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { SessionRemote } from './types/session.js';
import { buildSshConnectionArgs, remoteSshTarget, shellescape } from './remote-hosts.js';
import { runWithRemoteSshLimit } from './remote-ssh-limiter.js';
import { remoteTmuxLocation } from './tmux-manager.js';

const execAsync = promisify(exec);

/**
 * Bound on the whole round trip. A full load waits on it, so it is far below the
 * 10 s `ConnectTimeout` the shared ssh options carry: past this the local capture
 * is the better answer.
 */
const REMOTE_HISTORY_TIMEOUT_MS = 5_000;

/**
 * Longest a load waits for a slot in the shared ssh pool, which file previews and
 * attachment probes (20 s each) also hold. Past it the local capture is used.
 */
const REMOTE_HISTORY_SLOT_WAIT_MS = 1_500;

/** After a failed read, skip that host for this long and use the local capture. */
const REMOTE_HISTORY_BACKOFF_MS = 30_000;

/** Headroom over the remote `tail -c` bound for the size line and markers. */
const REMOTE_HISTORY_SLACK_BYTES = 64 * 1024;

/** Read ceiling when the configured byte cap is 0 (unbounded) and no `tail -c` runs. */
const UNBOUNDED_READ_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Host id → time the back-off ends. Keyed by HOST, so a sleeping host with five
 * sessions costs one timeout, and the map is bounded by the configured hosts.
 */
const backoffUntil = new Map<string, number>();

/**
 * The remote shell script. Its first byte is a NUL so a login banner or an rc-file
 * `echo` printed before it runs is separated without guessing (the same marker
 * `buildRemoteProbeCommand` uses); a second NUL ends the history size.
 */
export function buildRemoteScrollbackScript(
  socket: string,
  sessionName: string,
  historyLines: number,
  maxBytes: number
): string {
  const tmux = `tmux -L ${shellescape(socket)}`;
  // `=name:` is an EXACT session match, then its active pane. A bare name is
  // read as a pane index or window name first, so a discovered session named
  // `0` would capture some other session's pane.
  const target = shellescape(`=${sessionName}:`);
  const lines = Math.max(1, Math.trunc(historyLines));
  // The newest rows are the ones worth keeping, so the byte bound is applied on
  // the remote side (`tail -c`) rather than by killing the read at maxBuffer.
  // A cap of 0 means unbounded, as in the route.
  const bound = maxBytes > 0 ? ` | tail -c ${Math.trunc(maxBytes)}` : '';
  return (
    `printf '\\0' && ${tmux} display-message -p -t ${target} '#{history_size}' && printf '\\0' && ` +
    `${tmux} capture-pane -p -e -J -S -${lines} -E -1 -t ${target}${bound}`
  );
}

/** The full ssh command line for {@link buildRemoteScrollbackScript}. */
export function buildRemoteScrollbackCommand(
  remote: SessionRemote,
  sessionId: string,
  historyLines: number,
  maxBytes: number
): string {
  const { socket, sessionName } = remoteTmuxLocation(remote, sessionId);
  const script = buildRemoteScrollbackScript(socket, sessionName, historyLines, maxBytes);
  // `exec` so a timeout kill reaches ssh itself, not only the local `sh -c`.
  return ['exec', ...buildSshConnectionArgs(remote), remoteSshTarget(remote), shellescape(script)].join(' ');
}

/**
 * A `tail -c` cut lands mid-row (possibly mid-escape) whenever it bit, so the
 * first, partial row is dropped. Under the bound, the rows are whole.
 */
export function dropPartialFirstRow(scrollback: string, maxBytes: number): string {
  if (maxBytes <= 0 || Buffer.byteLength(scrollback, 'utf-8') < maxBytes) return scrollback;
  const newline = scrollback.indexOf('\n');
  return newline === -1 ? '' : scrollback.slice(newline + 1);
}

/**
 * The scrollback rows from the script's stdout, '' when the pane has no history,
 * or null when the output is not the script's.
 */
export function parseRemoteScrollbackOutput(stdout: string): string | null {
  const start = stdout.indexOf('\0');
  if (start === -1) return null;
  const sizeEnd = stdout.indexOf('\0', start + 1);
  if (sizeEnd === -1) return null;
  const sizeText = stdout.slice(start + 1, sizeEnd).trim();
  if (!/^\d+$/.test(sizeText)) return null;
  if (Number(sizeText) === 0) return '';
  return stdout.slice(sizeEnd + 1);
}

/**
 * Read a remote session's scrollback from the remote tmux, or null to keep the
 * local capture. Never throws.
 */
export async function fetchRemoteScrollback(
  remote: SessionRemote,
  sessionId: string,
  historyLines: number,
  maxBytes: number
): Promise<string | null> {
  // No real ssh under test (mirrors remote-files.ts / remote-hosts.ts).
  if (process.env.VITEST) return null;
  const queuedAt = Date.now();
  const until = backoffUntil.get(remote.hostId);
  if (until !== undefined) {
    if (queuedAt < until) return null;
    backoffUntil.delete(remote.hostId);
  }
  const command = buildRemoteScrollbackCommand(remote, sessionId, historyLines, maxBytes);
  try {
    const stdout = await runWithRemoteSshLimit(async () => {
      // The pool was busy past what a load should wait: give the slot back.
      if (Date.now() - queuedAt > REMOTE_HISTORY_SLOT_WAIT_MS) return null;
      const result = await execAsync(command, {
        encoding: 'utf-8',
        timeout: REMOTE_HISTORY_TIMEOUT_MS,
        maxBuffer: (maxBytes > 0 ? maxBytes : UNBOUNDED_READ_MAX_BYTES) + REMOTE_HISTORY_SLACK_BYTES,
      });
      return result.stdout;
    });
    if (stdout === null) return null;
    const scrollback = parseRemoteScrollbackOutput(stdout);
    if (scrollback === null) {
      backoffUntil.set(remote.hostId, Date.now() + REMOTE_HISTORY_BACKOFF_MS);
      console.warn(`[remote-history] ${remote.label}: unexpected output; using the local capture`);
      return null;
    }
    return dropPartialFirstRow(scrollback, maxBytes);
  } catch (err) {
    backoffUntil.set(remote.hostId, Date.now() + REMOTE_HISTORY_BACKOFF_MS);
    const e = err as { killed?: boolean; code?: unknown };
    const reason = e.killed ? 'timed out' : typeof e.code === 'number' ? `exit ${e.code}` : 'failed';
    console.warn(`[remote-history] ${remote.label}: remote scrollback read ${reason}; using the local capture`);
    return null;
  }
}

/** Test hook: forget every host back-off. */
export function resetRemoteScrollbackBackoff(): void {
  backoffUntil.clear();
}
