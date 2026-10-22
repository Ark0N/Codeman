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
 * ONE ssh round trip reads the remote pane's scrollback rows (`capture-pane -S -<N>
 * -E -1`), its `#{history_size}` and its screen. The size is load-bearing: with no
 * history at all, tmux clamps `-E -1` to the first VISIBLE row and would return it
 * as history. The screen closes the seam between the remote read and the local
 * frame, which is read only after the round trip: rows that scrolled in between,
 * and the top of a remote screen taller than the local pane, are on that screen
 * alone, and the caller keeps the screen rows above where the local frame overlaps
 * it (`joinScrollbackAndFrame`).
 *
 * ⚠️ The three reads are ONE tmux command list (`a \; b \; c`), not three tmux
 * runs. tmux runs a client's command list back to back without reading pane output
 * in between, so the history ends exactly where the screen begins. As separate runs
 * the shell kept writing between them, and the rows that scrolled in those
 * milliseconds were in neither capture (measured on a busy pane: every read lost
 * rows). This rests on how tmux's command queue behaves, not on a documented
 * guarantee. tmux output cannot carry the NUL markers, so a random marker line
 * printed by `display-message` separates the history from the size and screen.
 * tmux before 3.2 prints no newline after `capture-pane -p`, so the marker can be
 * glued onto an unterminated last history row; the parser accepts it there too.
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
import { randomBytes } from 'node:crypto';
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
 * Headroom over the remote `tail -c` bound for what it does not cover: the two NUL
 * markers and anything a login banner or rc file prints before the script.
 */
const REMOTE_HISTORY_SLACK_BYTES = 64 * 1024;

/**
 * Added to the configured byte cap for the remote `tail -c` bound. That bound
 * covers the whole tmux output, and the marker, the size and the screen come last
 * (a wide, tall screen of colored rows runs to a few hundred KB); without this, a
 * small cap would cut into the screen and lose the read. The route trims what it
 * returns to the configured cap anyway, keeping the newest bytes.
 */
const REMOTE_SCREEN_ALLOWANCE_BYTES = 1024 * 1024;

/** The remote `tail -c` bound for a configured byte cap; 0 (unbounded) stays 0. */
export function remoteTailBytes(maxBytes: number): number {
  return maxBytes > 0 ? Math.trunc(maxBytes) + REMOTE_SCREEN_ALLOWANCE_BYTES : 0;
}

/** Read ceiling when the configured byte cap is 0 (unbounded) and no `tail -c` runs. */
const UNBOUNDED_READ_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Host id → time the back-off ends. Keyed by HOST, so a sleeping host with five
 * sessions costs one timeout, and the map is bounded by the configured hosts.
 */
const backoffUntil = new Map<string, number>();

/**
 * A fresh marker line for one read. Random, so no row the pane really holds can be
 * taken for it.
 */
export function newScrollbackMarker(): string {
  return `codeman-history-${randomBytes(8).toString('hex')}`;
}

/**
 * The remote shell script. It prints a NUL, the tmux output, then a second NUL:
 * the first separates a login banner or an rc-file `echo` printed before the
 * script runs without guessing (the same marker `buildRemoteProbeCommand` uses),
 * and both are printed whether or not tmux succeeds, so their presence says the
 * script ran on the host. The tmux output is the history rows, `marker`, the
 * history size, then the screen rows.
 */
export function buildRemoteScrollbackScript(
  socket: string,
  sessionName: string,
  historyLines: number,
  tailBytes: number,
  marker: string
): string {
  // `=name:` is an EXACT session match, then its active pane. A bare name is
  // read as a pane index or window name first, so a discovered session named
  // `0` would capture some other session's pane.
  const target = shellescape(`=${sessionName}:`);
  const lines = Math.max(1, Math.trunc(historyLines));
  // The newest rows are the ones worth keeping, so the byte bound is applied on
  // the remote side (`tail -c`) rather than by killing the read at maxBuffer.
  // It covers the whole tmux output, history first, so with the screen
  // allowance in `remoteTailBytes()` a cut lands in the history. 0 means
  // unbounded, as in the route.
  const bound = tailBytes > 0 ? ` | tail -c ${Math.trunc(tailBytes)}` : '';
  // ONE tmux command list, so no pane output is read between the history and
  // the screen (see the @fileoverview). `\;` reaches tmux as a lone `;`.
  return (
    `printf '\\0'; tmux -L ${shellescape(socket)} ` +
    `capture-pane -p -e -J -S -${lines} -E -1 -t ${target} \\; ` +
    `display-message -p -t ${target} ${shellescape(marker)} \\; ` +
    `display-message -p -t ${target} '#{history_size}' \\; ` +
    `capture-pane -p -e -J -t ${target}${bound}; printf '\\0'`
  );
}

/** The full ssh command line for {@link buildRemoteScrollbackScript}. */
export function buildRemoteScrollbackCommand(
  remote: SessionRemote,
  sessionId: string,
  historyLines: number,
  tailBytes: number,
  marker: string
): string {
  const { socket, sessionName } = remoteTmuxLocation(remote, sessionId);
  const script = buildRemoteScrollbackScript(socket, sessionName, historyLines, tailBytes, marker);
  // `exec` so a timeout kill reaches ssh itself, not only the local `sh -c`.
  return ['exec', ...buildSshConnectionArgs(remote), remoteSshTarget(remote), shellescape(script)].join(' ');
}

/** What one round trip read from the remote pane: its scrollback rows, then its screen. */
export interface RemoteScrollback {
  /** History rows above the screen, oldest first; '' when the pane has none. */
  scrollback: string;
  /** The screen's rows, read in the same tmux command list, so they begin where the scrollback ends. */
  screen: string;
}

/**
 * The scrollback and screen rows from the script's stdout, or null when the
 * output is not the script's or tmux printed nothing usable (no such session,
 * or a byte cap so small it cut into the screen). The marker may end an
 * unterminated history row (tmux before 3.2); when the output reached
 * `tailBytes`, the history's partial first row is dropped.
 */
export function parseRemoteScrollbackOutput(
  stdout: string,
  marker: string,
  tailBytes: number
): RemoteScrollback | null {
  const start = stdout.indexOf('\0');
  if (start === -1) return null;
  const end = stdout.indexOf('\0', start + 1);
  if (end === -1) return null;
  // The marker ends a row, after the history's last row. Usually it is a row of
  // its own, but tmux before 3.2 prints no newline after `capture-pane -p`, so
  // when the history ends inside a wrapped line (`-J` leaves it unterminated)
  // the marker is glued onto that row. It is random per read, so no row the
  // pane really holds ends with it.
  const markerRow = `${marker}\n`;
  const raw = stdout.slice(start + 1, end);
  const at = raw.indexOf(markerRow);
  if (at === -1) return null;
  const sizeStart = at + markerRow.length;
  const sizeEnd = raw.indexOf('\n', sizeStart);
  if (sizeEnd === -1) return null;
  const sizeText = raw.slice(sizeStart, sizeEnd).trim();
  if (!/^\d+$/.test(sizeText)) return null;
  const screen = raw.slice(sizeEnd + 1);
  // With no history at all, tmux clamps `-E -1` to the first visible row.
  if (Number(sizeText) === 0) return { scrollback: '', screen };
  // A tail -c cut lands in the history (the bound leaves room for the rest),
  // mid-row and possibly mid-escape, so the first, partial row is dropped. A
  // cut exactly on the marker row leaves no history at all.
  let scrollback = raw.slice(0, at);
  if (tailBytes > 0 && Buffer.byteLength(raw, 'utf-8') >= tailBytes) {
    const newline = scrollback.indexOf('\n');
    scrollback = newline === -1 ? '' : scrollback.slice(newline + 1);
  }
  if (scrollback !== '' && !scrollback.endsWith('\n')) scrollback += '\n';
  return { scrollback, screen };
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
 * that is gone: tmux answers nothing between the NULs, and the closing `printf`
 * hides its exit status) is about this session only, so it returns
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
  const marker = newScrollbackMarker();
  const tailBytes = remoteTailBytes(maxBytes);
  const command = buildRemoteScrollbackCommand(remote, sessionId, historyLines, tailBytes, marker);
  try {
    const stdout = await runWithRemoteSshLimit(
      () =>
        runner(command, {
          timeout: REMOTE_HISTORY_TIMEOUT_MS,
          maxBuffer: (tailBytes > 0 ? tailBytes : UNBOUNDED_READ_MAX_BYTES) + REMOTE_HISTORY_SLACK_BYTES,
        }),
      // The pool is shared with 20 s file probes; past this the local capture
      // is the better answer than waiting behind them.
      { maxWaitMs: REMOTE_HISTORY_SLOT_WAIT_MS }
    );
    const parsed = parseRemoteScrollbackOutput(stdout, marker, tailBytes);
    if (parsed === null) {
      // Both NULs arrived, so the script ran on the host and only tmux had
      // nothing to say: no such session. The script's last command is the
      // closing `printf`, so this comes back as exit 0 rather than tmux's
      // exit 1, and it is about this session alone. Output without the NULs
      // is not the script's at all, which says the host is not answering as
      // expected.
      const parts = stdout.split('\0');
      const ranOnHost = parts.length >= 3;
      if (!ranOnHost) backoffUntil.set(remote.hostId, Date.now() + REMOTE_HISTORY_BACKOFF_MS);
      // tmux printed something, but not the marker, size and screen in order.
      const unreadable = ranOnHost && parts[1] !== '';
      const what = !ranOnHost
        ? 'unexpected output'
        : unreadable
          ? 'unreadable remote tmux output'
          : 'no such remote tmux session';
      console.warn(`[remote-history] ${remote.label}: ${what}; using the local capture`);
      return null;
    }
    return parsed;
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
