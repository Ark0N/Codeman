/**
 * @fileoverview Tests for reading a remote session's scrollback from the remote
 * tmux (`src/remote-pane-history.ts`) and splicing it above the local frame.
 *
 * The remote script is also run by a real `/bin/sh`, with a stub `tmux` first on
 * PATH: the script IS the remote command, so `sh -c <script>` is what sshd runs on
 * the other end, and quoting mistakes show up there and nowhere else.
 *
 * Port: N/A (no HTTP server).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildRemoteScrollbackCommand,
  buildRemoteScrollbackScript,
  fetchRemoteScrollback,
  newScrollbackMarker,
  parseRemoteScrollbackOutput,
  remoteTailBytes,
  resetRemoteScrollbackBackoff,
} from '../src/remote-pane-history.js';
import {
  getActiveRemoteSshCount,
  getQueuedRemoteSshCount,
  getRemoteSshLimit,
  runWithRemoteSshLimit,
} from '../src/remote-ssh-limiter.js';
import { findFrameInScreen, joinScrollbackAndFrame, remoteTmuxLocation } from '../src/tmux-manager.js';
import type { SessionRemote } from '../src/types/session.js';

const SESSION_ID = '663e3eae-8da6-4c7f-9231-611eb2840641';
const remote: SessionRemote = {
  hostId: 'h1',
  label: 'proxx',
  host: 'proxx.lan',
  username: 'tim',
  port: 2222,
  remotePath: '/home/tim',
};

describe('remoteTmuxLocation', () => {
  it('an owned session is the launch command’s session on the private socket', () => {
    expect(remoteTmuxLocation(remote, SESSION_ID)).toEqual({
      socket: 'codeman-remote',
      sessionName: 'codeman-ssh-663e3eae',
    });
  });

  it('a discovered session is the one the attach command joined on -L codeman', () => {
    const discovered = { ...remote, owned: false, remoteSessionName: 'codeman-disco1' };
    expect(remoteTmuxLocation(discovered, SESSION_ID)).toEqual({ socket: 'codeman', sessionName: 'codeman-disco1' });
  });
});

const MARKER = 'codeman-history-0123456789abcdef';

describe('buildRemoteScrollbackCommand', () => {
  it('goes through the shared ssh options and reads the history rows, then the screen', () => {
    const command = buildRemoteScrollbackCommand(remote, SESSION_ID, 10000, 2048, MARKER);
    expect(command.startsWith('exec ssh -o BatchMode=yes')).toBe(true);
    expect(command).toContain('-p 2222');
    expect(command).toContain('tim@proxx.lan');
    // Socket and target are shellescaped inside the (itself shellescaped) script.
    expect(command).toContain('codeman-remote');
    expect(command).toContain('codeman-ssh-663e3eae');
    expect(command).toContain('capture-pane -p -e -J -S -10000 -E -1');
    expect(command).toContain('#{history_size}');
    expect(command).toContain(MARKER);
    expect(command).toContain('| tail -c 2048');
    expect(command.indexOf('-E -1')).toBeLessThan(command.lastIndexOf('capture-pane -p -e -J -t'));
  });

  it('a byte cap of 0 (unbounded) runs no tail', () => {
    expect(buildRemoteScrollbackCommand(remote, SESSION_ID, 10000, 0, MARKER)).not.toContain('tail -c');
  });
});

describe('remoteTailBytes', () => {
  it('adds room for the marker, size and screen to the cap, so a cut lands in the history', () => {
    expect(remoteTailBytes(2048)).toBe(2048 + 1024 * 1024);
  });

  it('keeps 0 (unbounded) unbounded', () => {
    expect(remoteTailBytes(0)).toBe(0);
  });
});

describe('newScrollbackMarker', () => {
  it('is a fresh marker of a fixed shape on every read', () => {
    const a = newScrollbackMarker();
    expect(a).toMatch(/^codeman-history-[0-9a-f]{16}$/);
    expect(newScrollbackMarker()).not.toBe(a);
  });
});

describe('parseRemoteScrollbackOutput', () => {
  const read = (tmuxOutput: string) => `\x00${tmuxOutput}\x00`;

  it('drops anything printed before the script (login banner, rc-file echo)', () => {
    expect(
      parseRemoteScrollbackOutput(
        `Welcome to proxx\n${read(`line a\nline b\n${MARKER}\n42\nscreen 1\nscreen 2\n`)}`,
        MARKER,
        0
      )
    ).toEqual({
      scrollback: 'line a\nline b\n',
      screen: 'screen 1\nscreen 2\n',
    });
  });

  it('an empty history is empty, not the first visible row tmux clamps -E -1 to', () => {
    expect(parseRemoteScrollbackOutput(read(`$ the prompt row\n${MARKER}\n0\n$ the prompt row\n`), MARKER, 0)).toEqual({
      scrollback: '',
      screen: '$ the prompt row\n',
    });
  });

  it('a history the byte cap cut loses its partial first row, and the screen is kept whole', () => {
    const output = `ow 1\nrow 2\n${MARKER}\n7\nscreen\n`;
    expect(parseRemoteScrollbackOutput(read(output), MARKER, Buffer.byteLength(output))).toEqual({
      scrollback: 'row 2\n',
      screen: 'screen\n',
    });
  });

  it('a history under the byte cap keeps every row', () => {
    const output = `row 1\nrow 2\n${MARKER}\n7\nscreen\n`;
    expect(parseRemoteScrollbackOutput(read(output), MARKER, Buffer.byteLength(output) + 1)).toEqual({
      scrollback: 'row 1\nrow 2\n',
      screen: 'screen\n',
    });
  });

  it('a cut that landed exactly on the marker row keeps it', () => {
    const output = `${MARKER}\n3\nscreen\n`;
    expect(parseRemoteScrollbackOutput(read(output), MARKER, Buffer.byteLength(output))).toEqual({
      scrollback: '',
      screen: 'screen\n',
    });
  });

  it('tmux before 3.2: a marker glued onto an unterminated wrapped row ends that row', () => {
    // No newline after `capture-pane -p` output before 3.2, and -J leaves the
    // history's last row unterminated when the screen starts mid-line.
    const output = `row 1\nfirst half of long row${MARKER}\n31\nsecond half\n$ `;
    expect(parseRemoteScrollbackOutput(read(output), MARKER, 0)).toEqual({
      scrollback: 'row 1\nfirst half of long row\n',
      screen: 'second half\n$ ',
    });
  });

  it('tmux before 3.2: a cut history with the glued marker drops only the partial first row', () => {
    const output = `ow 1\nrow 2${MARKER}\n7\nscreen\n`;
    expect(parseRemoteScrollbackOutput(read(output), MARKER, Buffer.byteLength(output))).toEqual({
      scrollback: 'row 2\n',
      screen: 'screen\n',
    });
    // No history: the clamped first visible row the marker is glued to is not kept.
    expect(parseRemoteScrollbackOutput(read(`$ prompt${MARKER}\n0\n$ prompt\n`), MARKER, 0)).toEqual({
      scrollback: '',
      screen: '$ prompt\n',
    });
    // The cut landed in the only history row, the one the marker is glued to.
    const single = `alf of long row${MARKER}\n7\nscreen\n`;
    expect(parseRemoteScrollbackOutput(read(single), MARKER, Buffer.byteLength(single))).toEqual({
      scrollback: '',
      screen: 'screen\n',
    });
  });

  it('rejects output that is not the script’s, or tmux output with nothing usable', () => {
    expect(parseRemoteScrollbackOutput('', MARKER, 0)).toBeNull();
    expect(parseRemoteScrollbackOutput('no markers at all', MARKER, 0)).toBeNull();
    // The closing NUL is missing: the connection dropped mid-read.
    expect(parseRemoteScrollbackOutput(`\x00rows\n${MARKER}\n2\nscreen\n`, MARKER, 0)).toBeNull();
    // Both NULs, nothing between: tmux found no such session.
    expect(parseRemoteScrollbackOutput('\x00\x00', MARKER, 0)).toBeNull();
    // Another read's marker.
    expect(
      parseRemoteScrollbackOutput(read('rows\ncodeman-history-ffffffffffffffff\n2\nscreen\n'), MARKER, 0)
    ).toBeNull();
    expect(parseRemoteScrollbackOutput(read(`rows\n${MARKER}\nnot a number\nscreen\n`), MARKER, 0)).toBeNull();
  });
});

describe('the remote script under a real shell', () => {
  let dir: string;
  let callsFile: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'remote-scrollback-'));
    callsFile = join(dir, 'calls');
    // Stub tmux: logs its argv (one per line) and runs a `;`-separated command
    // list in order, as tmux does: the history size, the marker it was given,
    // two history rows, one screen row. With PRE32 set it prints like tmux
    // before 3.2 with the screen starting mid-line: no newline after the history.
    writeFileSync(
      join(dir, 'tmux'),
      [
        '#!/bin/sh',
        `for a in "$@"; do printf '%s\\n' "$a"; done >> '${callsFile}'`,
        `printf -- '--\\n' >> '${callsFile}'`,
        'run() {',
        '  case " $1 " in',
        '    *" #{history_size} "*) echo 2 ;;',
        `    *" display-message "*) printf '%s\\n' "$2" ;;`,
        '    *" -E -1 "*) if [ -n "$PRE32" ]; then printf "older row\\nfirst half"; else printf "older row\\nnewer row\\n"; fi ;;',
        '    *" capture-pane "*) printf "screen row\\n" ;;',
        '  esac',
        '}',
        "cmd=''; last=''",
        `for a in "$@" ';'; do`,
        `  if [ "$a" = ';' ]; then run "$cmd" "$last"; cmd=''; else cmd="$cmd $a"; last="$a"; fi`,
        'done',
      ].join('\n')
    );
    chmodSync(join(dir, 'tmux'), 0o755);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints the markers and rows the parser expects, from ONE tmux command list', () => {
    // A bound that keeps "row\nnewer row\n" of the history: the cut lands in
    // "older row", which the parser then drops.
    const bound = Buffer.byteLength(`row\nnewer row\n${MARKER}\n2\nscreen row\n`);
    const script = buildRemoteScrollbackScript('codeman', "codeman-it's", 500, bound, MARKER);
    const stdout = execFileSync('/bin/sh', ['-c', script], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
    });
    expect(parseRemoteScrollbackOutput(stdout, MARKER, bound)).toEqual({
      scrollback: 'newer row\n',
      screen: 'screen row\n',
    });
    const calls = execFileSync('cat', [callsFile], { encoding: 'utf-8' }).split('--\n').filter(Boolean);
    // One tmux run: separate runs would let the pane scroll between the reads.
    expect(calls).toHaveLength(1);
    // One argv entry per line: the exact-match target with a quote in it arrived whole.
    expect(calls[0].split('\n').join('|')).toBe(
      [
        "-L|codeman|capture-pane|-p|-e|-J|-S|-500|-E|-1|-t|=codeman-it's:",
        `display-message|-p|-t|=codeman-it's:|${MARKER}`,
        "display-message|-p|-t|=codeman-it's:|#{history_size}",
        "capture-pane|-p|-e|-J|-t|=codeman-it's:|",
      ].join('|;|')
    );
  });

  it('tmux before 3.2: an unterminated last history row still parses, re-terminated', () => {
    const script = buildRemoteScrollbackScript('codeman', 'old-host', 500, 0, MARKER);
    const stdout = execFileSync('/bin/sh', ['-c', script], {
      encoding: 'utf-8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}`, PRE32: '1' },
    });
    expect(stdout).toContain(`first half${MARKER}\n`);
    expect(parseRemoteScrollbackOutput(stdout, MARKER, 0)).toEqual({
      scrollback: 'older row\nfirst half\n',
      screen: 'screen row\n',
    });
  });

  it('prints both NULs when tmux fails, so a missing session reads as the script having run', () => {
    const failing = mkdtempSync(join(tmpdir(), 'remote-scrollback-fail-'));
    try {
      writeFileSync(join(failing, 'tmux'), '#!/bin/sh\necho "can\'t find session" >&2\nexit 1\n');
      chmodSync(join(failing, 'tmux'), 0o755);
      const stdout = execFileSync('/bin/sh', ['-c', buildRemoteScrollbackScript('codeman', 'gone', 500, 0, MARKER)], {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, PATH: `${failing}:${process.env.PATH ?? ''}` },
      });
      expect(stdout).toBe('\x00\x00');
    } finally {
      rmSync(failing, { recursive: true, force: true });
    }
  });
});

describe('joinScrollbackAndFrame', () => {
  it('puts the scrollback rows above the frame in tmux’s own row shape', () => {
    expect(joinScrollbackAndFrame('old 1\nold 2\n', 'frame 1\nframe 2\n')).toBe(
      'old 1\nold 2\x1b[0m\nframe 1\nframe 2\n'
    );
    expect(joinScrollbackAndFrame('old 1', 'frame 1')).toBe('old 1\x1b[0m\nframe 1');
  });

  it('resets SGR at the seam, so the last history row cannot bleed into the frame', () => {
    // A remote history row that ends with a background still set (a diff row).
    expect(joinScrollbackAndFrame('\x1b[41mRED ROW\n', 'plain\n')).toBe('\x1b[41mRED ROW\x1b[0m\nplain\n');
  });

  it('no scrollback leaves the frame alone', () => {
    expect(joinScrollbackAndFrame(undefined, 'frame\n')).toBe('frame\n');
    expect(joinScrollbackAndFrame('', 'frame\n')).toBe('frame\n');
  });
});

// The remote screen is read right after the remote history, the local frame
// only once the round trip is back. Rows between the two are on that screen
// alone, so the screen rows above where the frame overlaps it are kept.
describe('joinScrollbackAndFrame with the remote screen', () => {
  const rows = (...r: string[]) => `${r.join('\n')}\n`;
  const captureRowsOf = (text: string) => text.replace(/\n$/, '').split('\n');
  const H = rows('h1', 'h2');
  // The rows above the frame end with an SGR reset: the frame is a separate capture.
  const reset = (block: string) => `${block.replace(/\n$/, '')}\x1b[0m\n`;

  it('nothing moved: the frame IS the screen, so no screen row is added', () => {
    const screen = rows('s1', 's2', 's3', '$ ', '', '');
    expect(joinScrollbackAndFrame(H, screen, screen)).toBe(`${reset(H)}${screen}`);
  });

  it('rows that scrolled off during the round trip are kept, once each', () => {
    const screen = rows('s1', 's2', 's3', 's4', 's5', 's6', 's7', '$ make');
    // Three more rows of output arrived: s1..s3 scrolled out of the frame.
    const frame = rows('s4', 's5', 's6', 's7', '$ make', 'out 1', 'out 2', 'out 3');
    expect(joinScrollbackAndFrame(H, frame, screen)).toBe(`${reset(H)}${reset(rows('s1', 's2', 's3'))}${frame}`);
  });

  it('the top of a remote screen taller than this pane is kept', () => {
    const screen = rows('t1', 't2', 's1', 's2', 's3', '$ ');
    const frame = rows('s1', 's2', 's3', '$ ');
    expect(joinScrollbackAndFrame(H, frame, screen)).toBe(`${reset(H)}${reset(rows('t1', 't2'))}${frame}`);
  });

  it('the last content row may have changed (output in flight) and still matches', () => {
    const screen = rows('s1', 's2', 's3', 's4', '$ par');
    const frame = rows('s2', 's3', 's4', '$ partial line done', 'next');
    expect(joinScrollbackAndFrame(H, frame, screen)).toBe(`${reset(H)}${reset(rows('s1'))}${frame}`);
  });

  it('compares text only: two tmuxes may encode the same attributes differently', () => {
    const screen = rows('\x1b[38;5;1ms1\x1b[39m', 's2  ', 's3', 's4', '$ ');
    const frame = rows('s2', '\x1b[1ms3\x1b[0m', 's4', '$ ', 'new');
    expect(joinScrollbackAndFrame(H, frame, screen)).toBe(
      `${reset(H)}${reset(rows('\x1b[38;5;1ms1\x1b[39m'))}${frame}`
    );
  });

  it('no overlap (more scrolled than the screen held) falls back to scrollback over frame', () => {
    const screen = rows('s1', 's2', '$ ');
    const frame = rows('x1', 'x2', 'x3');
    expect(joinScrollbackAndFrame(H, frame, screen)).toBe(`${reset(H)}${frame}`);
  });

  it('an overlap of blank rows alone is not a match', () => {
    const screen = rows('s1', '', '', '$ ');
    const frame = rows('', '', 'other', 'rows');
    expect(joinScrollbackAndFrame(H, frame, screen)).toBe(`${reset(H)}${frame}`);
  });

  it('the first (highest) match wins over a block that repeats lower down', () => {
    const screen = rows('a', 'b', 'a', 'b', '$ ');
    const frame = rows('a', 'b', 'a', 'b', '$ x');
    expect(joinScrollbackAndFrame(H, frame, screen)).toBe(`${reset(H)}${frame}`);
  });

  // A placement too LOW repeats rows, which is worse than the plain join's
  // loss: a row that changed between the reads (a spinner) fails the true
  // placement, and a row or two that happen to be equal further down must not
  // be taken instead.
  it('does not trust an overlap shorter than three rows, two of them with text', () => {
    const screen = rows('s1', 'spin |', 's3', '$', 'out', '$ ');
    const frame = rows('spin /', 's3', '$', 'out', '$ ', 'new');
    expect(findFrameInScreen(captureRowsOf(screen), captureRowsOf(frame))).toBe(-1);
    expect(joinScrollbackAndFrame(H, frame, screen)).toBe(`${reset(H)}${frame}`);
    // Three compared rows but only one with text: not trusted either.
    expect(findFrameInScreen(['a', 'x', '', '', 'z'], ['x', '', '', 'z', 'q'])).toBe(-1);
  });

  it('resets SGR where the history meets the screen rows kept above the frame', () => {
    // Two captures in the remote command list: the history's last row ends with a
    // background set, and the screen rows are encoded from the default state.
    const screen = rows('s1', 's2', 's3', 's4', '$ ');
    const frame = rows('s2', 's3', 's4', '$ ', 'new');
    expect(joinScrollbackAndFrame('old\n\x1b[41mRED\n', frame, screen)).toBe(
      `old\n\x1b[41mRED\x1b[0m\n${reset(rows('s1'))}${frame}`
    );
  });

  it('keeps a scrollback that is one blank row, as the plain join did', () => {
    expect(joinScrollbackAndFrame('\n', 'frame\n')).toBe('\x1b[0m\nframe\n');
  });

  it('places the frame among screen rows with findFrameInScreen', () => {
    expect(findFrameInScreen(['a', 'b', 'c', 'd', '$'], ['b', 'c', 'd', '$', 'e'])).toBe(1);
    expect(findFrameInScreen(['a', 'b', 'c', '$'], ['z'])).toBe(-1);
    expect(findFrameInScreen([], ['a'])).toBe(-1);
    expect(findFrameInScreen(['only row'], ['only row'])).toBe(-1);
  });
});

describe('fetchRemoteScrollback', () => {
  /** The marker a read put in its command line. */
  const markerIn = (command: string) => /codeman-history-[0-9a-f]{16}/.exec(command)?.[0] ?? 'no-marker';
  /** A successful read's stdout, answering with the marker the command carries. */
  const OK = async (command: string) => `\x00older row\nnewer row\n${markerIn(command)}\n2\nscreen row\n\x00`;
  const READ = { scrollback: 'older row\nnewer row\n', screen: 'screen row\n' };
  /** An exec-shaped rejection: `code` is the exit status, `killed` a timeout kill. */
  const execError = (fields: { code?: number | string; killed?: boolean }) =>
    Object.assign(new Error('Command failed'), fields);

  beforeEach(() => {
    resetRemoteScrollbackBackoff();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('never opens a connection under test without an injected runner', async () => {
    expect(await fetchRemoteScrollback(remote, SESSION_ID, 100, 1024)).toBeNull();
  });

  it('returns the remote rows, running the built command with the round-trip bounds', async () => {
    const run = vi.fn(OK);
    expect(await fetchRemoteScrollback(remote, SESSION_ID, 100, 1024, run)).toEqual(READ);
    const marker = markerIn(run.mock.calls[0][0]);
    const tailBytes = 1024 + 1024 * 1024;
    expect(run).toHaveBeenCalledWith(buildRemoteScrollbackCommand(remote, SESSION_ID, 100, tailBytes, marker), {
      timeout: 5000,
      // The tail bound covers the whole tmux output; the slack covers the NULs
      // and anything printed before the script.
      maxBuffer: tailBytes + 64 * 1024,
    });
  });

  it('backs the HOST off after a transport failure: ssh exit 255, a timeout, a spawn error, odd output', async () => {
    const failures: Array<() => Promise<string>> = [
      async () => Promise.reject(execError({ code: 255 })),
      async () => Promise.reject(execError({ killed: true, code: null as unknown as number })),
      async () => Promise.reject(execError({ code: 'ENOENT' })),
      async () => 'not the script output',
    ];
    for (const failure of failures) {
      resetRemoteScrollbackBackoff();
      expect(await fetchRemoteScrollback(remote, SESSION_ID, 100, 1024, vi.fn(failure))).toBeNull();
      // Another session on the same host is skipped without a round trip.
      const next = vi.fn(OK);
      expect(await fetchRemoteScrollback(remote, 'other-session', 100, 1024, next)).toBeNull();
      expect(next).not.toHaveBeenCalled();
    }
  });

  it('a remote command failure (tmux exit 1: the session is gone) is that session only, no back-off', async () => {
    const gone = vi.fn(async () => Promise.reject(execError({ code: 1 })));
    expect(await fetchRemoteScrollback(remote, SESSION_ID, 100, 1024, gone)).toBeNull();
    const next = vi.fn(OK);
    expect(await fetchRemoteScrollback(remote, 'other-session', 100, 1024, next)).toEqual(READ);
    expect(next).toHaveBeenCalledOnce();
  });

  // Found live against a real host: a missing session comes back as exit 0
  // (the script's closing `printf` hides tmux's status) with both NULs and
  // nothing between them. The script ran on the host; only this session is
  // gone, so the host must not be backed off.
  it('a missing session hidden behind the closing printf (exit 0, empty NULs) is that session only', async () => {
    const masked = vi.fn(async () => '\x00\x00');
    expect(await fetchRemoteScrollback(remote, SESSION_ID, 100, 1024, masked)).toBeNull();
    const next = vi.fn(OK);
    expect(await fetchRemoteScrollback(remote, 'other-session', 100, 1024, next)).toEqual(READ);
    expect(next).toHaveBeenCalledOnce();
  });

  it('the back-off ends after 30 s', async () => {
    vi.useFakeTimers();
    await fetchRemoteScrollback(remote, SESSION_ID, 100, 1024, async () => Promise.reject(execError({ code: 255 })));
    const next = vi.fn(OK);
    vi.advanceTimersByTime(29_999);
    expect(await fetchRemoteScrollback(remote, SESSION_ID, 100, 1024, next)).toBeNull();
    vi.advanceTimersByTime(1);
    expect(await fetchRemoteScrollback(remote, SESSION_ID, 100, 1024, next)).toEqual(READ);
  });

  it('gives up after 1.5 s queued behind a busy ssh pool: never runs, no slot leaked, no back-off', async () => {
    vi.useFakeTimers();
    const gates = Array.from({ length: getRemoteSshLimit() }, () => {
      let release!: () => void;
      const promise = new Promise<void>((r) => {
        release = r;
      });
      return { promise, release };
    });
    const holders = gates.map((gate) => runWithRemoteSshLimit(() => gate.promise));
    await Promise.resolve();

    const run = vi.fn(OK);
    const pending = fetchRemoteScrollback(remote, SESSION_ID, 100, 1024, run);
    await vi.advanceTimersByTimeAsync(1499);
    expect(getQueuedRemoteSshCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(getQueuedRemoteSshCount()).toBe(0);

    for (const gate of gates) gate.release();
    await Promise.all(holders);
    expect(getActiveRemoteSshCount()).toBe(0);
    // A busy pool said nothing about the host.
    expect(await fetchRemoteScrollback(remote, SESSION_ID, 100, 1024, run)).toEqual(READ);
  });
});
