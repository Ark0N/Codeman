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
 * ONE ssh round trip prints the remote pane's `#{history_size}`, its scrollback
 * rows (`capture-pane -S -<N> -E -1`) and then its screen. The size is load-bearing:
 * with no history at all, tmux clamps `-E -1` to the first VISIBLE row and would
 * return it as history. The screen closes the seam between the two captures: the
 * local frame is read only after the round trip, so rows that scrolled in between,
 * and the top of a remote screen taller than the local pane, are on that screen
 * alone, and the caller keeps the screen rows above where the local frame overlaps
 * it (`joinScrollbackAndFrame`).
 *
 * Bounded and fail-soft. Any failure (unreachable host, auth, missing session, odd
 * output) returns null and the caller keeps the local capture, so a remote load is
 * never worse than before. A transport failure also starts a short per-host back-off,
 * so a host that is asleep costs one timeout, not one per tab switch. The child runs
 * under the shared remote-ssh limiter (`remote-ssh-limiter.ts`) like every other
 * short-lived remote ssh, but gives up on a slot it waited too long for (`maxWaitMs`,
 * enforced in the queue), and the connection options come from
 * `buildSshConnectionArgs()`.
 *
 * How much history exists is the REMOTE tmux's `history-limit` (2000 lines unless
 * the remote user's tmux.conf raises it); the launch command does not set it.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { SessionRemote } from './types/session.js';
import { buildSshConnectionArgs, classifyRemoteAliveExit, remoteSshTarget, shellescape } from './remote-hosts.js';
import { RemoteSshSlotTimeoutError, runWithRemoteSshLimit } from './remote-ssh-limiter.js';
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

/**
 * Headroom over the remote `tail -c` bound for the size line, the markers and
 * the screen capture, which the bound does not cover (a wide, tall screen of
 * colored rows runs to a few hundred KB).
 */
const REMOTE_HISTORY_SLACK_BYTES = 1024 * 1024;

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
  // The screen comes right after the history, in the same round trip: the
  // local frame is captured only once this returns, so rows that scroll off
  // in between are on this screen and nowhere else (joinScrollbackAndFrame).
  return (
    `printf '\\0' && ${tmux} display-message -p -t ${target} '#{history_size}' && printf '\\0' && ` +
    `${tmux} capture-pane -p -e -J -S -${lines} -E -1 -t ${target}${bound} && printf '\\0' && ` +
    `${tmux} capture-pane -p -e -J -t ${target}`
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

/** What one round trip read from the remote pane: its scrollback rows, then its screen. */
export interface RemoteScrollback {
  /** History rows above the screen, oldest first; '' when the pane has none. */
  scrollback: string;
  /** The screen's rows, read right after the scrollback. */
  screen: string;
}

/**
 * The scrollback and screen rows from the script's stdout, or null when the
 * output is not the script's.
 */
export function parseRemoteScrollbackOutput(stdout: string): RemoteScrollback | null {
  const start = stdout.indexOf('\0');
  if (start === -1) return null;
  const sizeEnd = stdout.indexOf('\0', start + 1);
  if (sizeEnd === -1) return null;
  const historyEnd = stdout.indexOf('\0', sizeEnd + 1);
  if (historyEnd === -1) return null;
  const sizeText = stdout.slice(start + 1, sizeEnd).trim();
  if (!/^\d+$/.test(sizeText)) return null;
  const screen = stdout.slice(historyEnd + 1);
  // With no history at all, tmux clamps `-E -1` to the first visible row.
  if (Number(sizeText) === 0) return { scrollback: '', screen };
  return { scrollback: stdout.slice(sizeEnd + 1, historyEnd), screen };
}

/** Runs the ssh command line and resolves its stdout; rejects like `exec` does. */
export type RemoteScrollbackRunner = (command: string, opts: { timeout: number; maxBuffer: number }) => Promise<string>;

const execRunner: RemoteScrollbackRunner = async (command, opts) =>
  (await execAsync(command, { encoding: 'utf-8', ...opts })).stdout;

/**
 * Read a remote session's scrollback from the remote tmux, or null to keep the
 * local capture. Never throws.
 *
 * Only a TRANSPORT failure backs the host off (ssh's own exit 255, a timeout, a
 * spawn error, output that is not the script's): those say the host is
 * unreachable for every session on it. A remote command failing (a session
 * that is gone: tmux exits 1, or answers nothing between the markers when the
 * `| tail -c` pipe hides its status) is about this session only, so it returns
 * null and the next session on that host still tries. Same split as
 * `classifyRemoteAliveExit()`.
 *
 * `run` is a test seam: without it nothing runs under vitest, as in
 * remote-files.ts / remote-hosts.ts.
 */
export async function fetchRemoteScrollback(
  remote: SessionRemote,
  sessionId: string,
  historyLines: number,
  maxBytes: number,
  run?: RemoteScrollbackRunner
): Promise<RemoteScrollback | null> {
  if (!run && process.env.VITEST) return null;
  const runner = run ?? execRunner;
  const until = backoffUntil.get(remote.hostId);
  if (until !== undefined) {
    if (Date.now() < until) return null;
    backoffUntil.delete(remote.hostId);
  }
  const command = buildRemoteScrollbackCommand(remote, sessionId, historyLines, maxBytes);
  try {
    const stdout = await runWithRemoteSshLimit(
      () =>
        runner(command, {
          timeout: REMOTE_HISTORY_TIMEOUT_MS,
          maxBuffer: (maxBytes > 0 ? maxBytes : UNBOUNDED_READ_MAX_BYTES) + REMOTE_HISTORY_SLACK_BYTES,
        }),
      // The pool is shared with 20 s file probes; past this the local capture
      // is the better answer than waiting behind them.
      { maxWaitMs: REMOTE_HISTORY_SLOT_WAIT_MS }
    );
    const parsed = parseRemoteScrollbackOutput(stdout);
    if (parsed === null) {
      // Both markers arrived, so the script ran on the host and only tmux had
      // nothing to say: no such session. The `| tail -c` pipe hides tmux's
      // exit status, so this comes back as exit 0 rather than exit 1, and it
      // is about this session alone. Output without the markers is not the
      // script's at all, which says the host is not answering as expected.
      const ranOnHost = stdout.split('\0').length >= 3;
      if (!ranOnHost) backoffUntil.set(remote.hostId, Date.now() + REMOTE_HISTORY_BACKOFF_MS);
      const what = ranOnHost ? 'no such remote tmux session' : 'unexpected output';
      console.warn(`[remote-history] ${remote.label}: ${what}; using the local capture`);
      return null;
    }
    return { scrollback: dropPartialFirstRow(parsed.scrollback, maxBytes), screen: parsed.screen };
  } catch (err) {
    // A busy pool says nothing about the host.
    if (err instanceof RemoteSshSlotTimeoutError) return null;
    const e = err as { killed?: boolean; code?: unknown };
    const code = typeof e.code === 'number' ? e.code : null;
    const transport = classifyRemoteAliveExit(code, e.killed === true) === undefined;
    if (transport) backoffUntil.set(remote.hostId, Date.now() + REMOTE_HISTORY_BACKOFF_MS);
    const reason = e.killed ? 'timed out' : code !== null ? `exit ${code}` : 'failed';
    console.warn(`[remote-history] ${remote.label}: remote scrollback read ${reason}; using the local capture`);
    return null;
  }
}

/** Test hook: forget every host back-off. */
export function resetRemoteScrollbackBackoff(): void {
  backoffUntil.clear();
}
