/**
 * Workspace-trust dialog auto-accept.
 *
 * The bug this pins: `data.includes('trust this folder')` could never match,
 * because tmux repaints a row with cursor-forward escapes instead of spaces, so
 * the wire carries `I\x1b[Ctrust\x1b[Cthis\x1b[Cfolder`. Every session on a fresh
 * directory sat on the dialog until a human pressed Enter.
 *
 * RAW_DIALOG_CHUNK below is a verbatim slice of the PTY stream from a live
 * session parked on that dialog (Claude Code 2.1.220).
 *
 * The second bug this pins: Claude Code 2.1.252 dropped the option numbers, put
 * "No, exit" first and highlights IT, so the blind Enter that answered the old
 * layout selects *exit* and the pane dies seconds after the session starts.
 * RENDERED_DIALOG_2_1_252 is a verbatim `capture-pane -p` of that screen.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { Session } from '../src/session.js';

// The restart case below starts a real direct-PTY session; the real `claude` must never
// run from a test, so pty.spawn runs a harmless stand-in instead.
vi.mock('node-pty', async (importOriginal) => {
  const real = await importOriginal<typeof import('node-pty')>();
  return {
    ...real,
    spawn: (_file: string, _args: string[] | string, options: import('node-pty').IPtyForkOptions) =>
      real.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], options),
  };
});
import {
  isTrustDialogScreen,
  compactScreenText,
  trustDialogNextKey,
  TRUST_KEY_CONFIRM,
  TRUST_KEY_DOWN,
  TRUST_KEY_UP,
  TRUST_DIALOG_MAX_ATTEMPTS,
} from '../src/session-trust-dialog.js';

/** Verbatim from the wire: note the `\x1b[C` where every space should be. */
const RAW_DIALOG_CHUNK =
  '\x1b[C\x1b[38;5;246m1.\x1b[C\x1b[38;5;153mYes,\x1b[CI\x1b[Ctrust\x1b[Cthis\x1b[Cfolder\x1b[15;4H' +
  '\x1b[38;5;246m2.\x1b[C\x1b[39mNo,\x1b[Cexit\x1b[17;2H\x1b[38;5;246mEnter\x1b[Cto\x1b[Cconfirm\x1b[C·\x1b[CEsc\x1b[Cto\x1b[Ccancel';

/** What `tmux capture-pane -p` shows for the same moment. */
const RENDERED_DIALOG = [
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
  ' project, or work from your team). If not, take a moment to review what is in this folder first.',
  '',
  ' ❯ 1. Yes, I trust this folder',
  '   2. No, exit',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');

/**
 * Verbatim `capture-pane -p` from Claude Code 2.1.252 on a fresh case: no
 * numbers, the options reversed, and the cursor parked on the one that quits.
 */
const RENDERED_DIALOG_2_1_252 = [
  ' Accessing workspace:',
  ' /home/arkon/codeman-cases/trustprobe1',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
  " project, or work from your team). If not, take a moment to review what's in this folder first.",
  " Claude Code'll be able to read, edit, and execute files here.",
  ' Security guide',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  ' Enter to confirm · Esc to cancel',
].join('\n');

/** The same screen after one arrow press: the cursor has moved onto "yes". */
const RENDERED_DIALOG_2_1_252_ON_YES = RENDERED_DIALOG_2_1_252.replace(' ❯ No, exit\n   Yes,', '   No, exit\n ❯ Yes,');

/** An ordinary working session: no dialog anywhere. */
const RENDERED_MAIN_UI = [
  '✻ Actualizing… (13m 23s · ↓ 47.5k tokens)',
  '────────────────────────────────',
  '❯ ',
  '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents',
].join('\n');

describe('isTrustDialogScreen', () => {
  it('sees the dialog in the raw space-less repaint', () => {
    // The whole point: the literal phrase is NOT in this chunk.
    expect(RAW_DIALOG_CHUNK.includes('trust this folder')).toBe(false);
    expect(isTrustDialogScreen(RAW_DIALOG_CHUNK)).toBe(true);
  });

  it('sees the dialog in the rendered screen', () => {
    expect(isTrustDialogScreen(RENDERED_DIALOG)).toBe(true);
  });

  it('does not fire on a normal session screen', () => {
    expect(isTrustDialogScreen(RENDERED_MAIN_UI)).toBe(false);
    expect(isTrustDialogScreen('')).toBe(false);
  });

  it('does not fire on text that merely quotes the dialog', () => {
    // An agent reading or writing about this feature (this file, for one) must
    // not cause an Enter press. The confirm affordance is what separates the
    // widget from prose about it.
    expect(isTrustDialogScreen('the installer asks you to trust this folder before it runs')).toBe(false);
    expect(isTrustDialogScreen('press Enter to confirm the release')).toBe(false);
  });

  it('sees the 2.1.252 dialog, whose options lost their numbers', () => {
    // '2.no,exit' is gone from this layout, so the confirm affordance is now the
    // only thing carrying the match.
    expect(isTrustDialogScreen(RENDERED_DIALOG_2_1_252)).toBe(true);
  });

  it('compacts away both real spaces and the escapes tmux sends instead', () => {
    expect(compactScreenText('I\x1b[Ctrust\x1b[Cthis\x1b[Cfolder')).toBe('itrustthisfolder');
    expect(compactScreenText('I trust this folder')).toBe('itrustthisfolder');
  });
});

describe('trustDialogNextKey', () => {
  it('confirms straight away when the trust option is already highlighted', () => {
    expect(trustDialogNextKey(RENDERED_DIALOG)).toBe(TRUST_KEY_CONFIRM);
    expect(trustDialogNextKey(RENDERED_DIALOG_2_1_252_ON_YES)).toBe(TRUST_KEY_CONFIRM);
  });

  it('moves DOWN instead of confirming when 2.1.252 parks the cursor on "No, exit"', () => {
    // The regression in one line: Enter here answers *exit* and kills the pane.
    expect(trustDialogNextKey(RENDERED_DIALOG_2_1_252)).toBe(TRUST_KEY_DOWN);
  });

  it('moves UP when the trust option is the one above, as in the numbered layout', () => {
    const numberedOnNo = RENDERED_DIALOG.replace(' ❯ 1. Yes,', '   1. Yes,').replace(
      '   2. No, exit',
      ' ❯ 2. No, exit'
    );
    expect(trustDialogNextKey(numberedOnNo)).toBe(TRUST_KEY_UP);
  });

  it('reads the LAST frame in an append-only buffer, not the first', () => {
    // The direct-PTY fallback has no pane to capture, so it reads a buffer that
    // still holds every repaint since launch. The freshest frame is the truth.
    const buffer = `${RENDERED_DIALOG_2_1_252}\n${RENDERED_DIALOG_2_1_252_ON_YES}`;
    expect(trustDialogNextKey(buffer)).toBe(TRUST_KEY_CONFIRM);
  });

  it('presses nothing when the screen does not say which option is selected', () => {
    // A layout this cannot read is a dialog for the human, not a coin flip: the
    // wrong guess exits Claude.
    const noMarker = RENDERED_DIALOG_2_1_252.replace(' ❯ No, exit', '   No, exit');
    expect(trustDialogNextKey(noMarker)).toBe(null);
    expect(trustDialogNextKey(RENDERED_MAIN_UI)).toBe(null);
    expect(trustDialogNextKey('')).toBe(null);
  });
});

describe('Session trust-dialog auto-accept', () => {
  afterEach(() => vi.useRealTimers());

  /** A session whose pane renders `screen`, recording everything written to it. */
  function sessionShowing(screen: () => string) {
    const writes: string[] = [];
    const mux = {
      isAvailable: () => true,
      capturePaneText: () => screen(),
      sendInput: (_id: string, data: string) => {
        writes.push(data);
        return Promise.resolve(true);
      },
    };
    const session = new Session({
      workingDir: '/tmp',
      mode: 'claude',
      mux,
      muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: Date.now() },
    } as ConstructorParameters<typeof Session>[0]);
    const internals = session as unknown as {
      _maybeAcceptTrustDialog(): void;
      _interactiveStartedAt: number;
    };
    internals._interactiveStartedAt = Date.now();
    return { session, writes, tick: () => internals._maybeAcceptTrustDialog() };
  }

  it('presses Enter when the dialog is on screen', () => {
    vi.useFakeTimers();
    const { writes, tick } = sessionShowing(() => RENDERED_DIALOG);
    tick();
    expect(writes).toEqual(['\r']);
  });

  it('walks the 2.1.252 dialog onto the trust option before it confirms', () => {
    vi.useFakeTimers();
    // The whole point: no Enter goes out while "No, exit" is highlighted.
    let screen = RENDERED_DIALOG_2_1_252;
    const { writes, tick } = sessionShowing(() => screen);
    tick();
    expect(writes).toEqual([TRUST_KEY_DOWN]);

    screen = RENDERED_DIALOG_2_1_252_ON_YES;
    vi.advanceTimersByTime(2000);
    tick();
    expect(writes).toEqual([TRUST_KEY_DOWN, TRUST_KEY_CONFIRM]);
  });

  it('never presses Enter while the cursor sits on "No, exit"', () => {
    vi.useFakeTimers();
    // A dialog that never moves (a dropped arrow, a wedged pane) must run out of
    // attempts pressing arrows, not answer *exit* on the way.
    const { writes, tick } = sessionShowing(() => RENDERED_DIALOG_2_1_252);
    for (let i = 0; i < 20; i++) {
      tick();
      vi.advanceTimersByTime(2000);
    }
    expect(writes).toEqual(Array(TRUST_DIALOG_MAX_ATTEMPTS).fill(TRUST_KEY_DOWN));
  });

  it('retries a dropped keystroke, then gives up rather than typing forever', () => {
    vi.useFakeTimers();
    // Ink can drop a keystroke while it is still mounting the widget, so one
    // press is not always enough; a stuck dialog must not become an Enter loop.
    const { writes, tick } = sessionShowing(() => RENDERED_DIALOG);
    for (let i = 0; i < 20; i++) {
      tick();
      vi.advanceTimersByTime(2000);
    }
    expect(writes.length).toBe(TRUST_DIALOG_MAX_ATTEMPTS);
  });

  it('stops once the dialog is answered', () => {
    vi.useFakeTimers();
    let screen = RENDERED_DIALOG;
    const { writes, tick } = sessionShowing(() => screen);
    tick();
    expect(writes).toEqual(['\r']);

    screen = RENDERED_MAIN_UI;
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(2000);
      tick();
    }
    expect(writes).toEqual(['\r']);
  });

  it('never answers a dialog-looking screen outside the startup window', () => {
    vi.useFakeTimers();
    // A live agent can print this text hours in; only a launching pane can be
    // showing the real widget.
    const { writes, tick } = sessionShowing(() => RENDERED_DIALOG);
    vi.advanceTimersByTime(10 * 60_000);
    tick();
    expect(writes).toEqual([]);
  });

  it('reads the dialog that painted inside the throttle of the read before it', () => {
    vi.useFakeTimers();
    // Measured on 2.1.294: one read at +156 ms saw a blank pane, the dialog painted
    // within the throttle, and a quiet dialog sends no further output to read on.
    let screen = '';
    const { writes, tick } = sessionShowing(() => screen);
    tick();
    vi.advanceTimersByTime(500);
    screen = RENDERED_DIALOG_2_1_252;
    tick(); // the dialog's own paint: throttled, and the last output the pane produces
    vi.advanceTimersByTime(5000);
    expect(writes[0]).toBe(TRUST_KEY_DOWN);
  });

  it('cancels a deferred read when the session is stopped', async () => {
    vi.useFakeTimers();
    // DELETE goes through stop(), and a read deferred just before it must not outlive it.
    let screen = '';
    const { session, tick } = sessionShowing(() => screen);
    tick();
    screen = RENDERED_DIALOG_2_1_252;
    const before = vi.getTimerCount();
    tick(); // throttled, so a read is deferred
    expect(vi.getTimerCount()).toBe(before + 1);
    await session.stop(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('neither scans nor arms a timer once the session is stopped', async () => {
    vi.useFakeTimers();
    // Killing the pane produces output of its own, and the buffer tail still shows the
    // dialog, so a deleted session went on "answering" it on a timer for several seconds.
    const { session, tick } = sessionShowing(() => RENDERED_DIALOG_2_1_252);
    await session.stop(false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    tick();
    tick(); // inside the throttle of the first
    expect(vi.getTimerCount()).toBe(0);
    expect(log.mock.calls.some(([line]) => String(line).includes('trust dialog'))).toBe(false);
    log.mockRestore();
  });

  it('does not press Enter on a normal screen', () => {
    vi.useFakeTimers();
    const { writes, tick } = sessionShowing(() => RENDERED_MAIN_UI);
    for (let i = 0; i < 5; i++) {
      tick();
      vi.advanceTimersByTime(2000);
    }
    expect(writes).toEqual([]);
  });
});

describe('Session idle detection while the trust dialog is up', () => {
  afterEach(() => vi.useRealTimers());

  /** A just-launched pane (busy, inside the startup window) rendering `screen` (null: capture failed). */
  function launchingSession(screen: () => string | null) {
    const mux = { isAvailable: () => true, capturePaneText: () => screen() };
    const session = new Session({
      workingDir: '/tmp',
      mode: 'claude',
      mux,
      muxSession: { muxName: 'codeman-test', sessionId: 'test', createdAt: Date.now() },
    } as unknown as ConstructorParameters<typeof Session>[0]);
    const internals = session as unknown as {
      _detectInteractiveActivity(data: string): void;
      _markActivity(): void;
      _interactiveStartedAt: number;
      _status: string;
    };
    internals._interactiveStartedAt = Date.now();
    internals._status = 'busy'; // what startInteractive() leaves a new pane at
    let idles = 0;
    session.on('idle', () => idles++);
    /** One repaint carrying a `❯`, which is what arms the idle confirmation. */
    const paint = (chunk: string) => {
      internals._markActivity();
      internals._detectInteractiveActivity(chunk);
    };
    return { session, paint, idles: () => idles };
  }

  it('does not call the dialog idle, although its own ❯ arms the check', () => {
    vi.useFakeTimers();
    const { session, paint, idles } = launchingSession(() => RENDERED_DIALOG_2_1_252);
    paint(RENDERED_DIALOG_2_1_252);
    vi.advanceTimersByTime(30_000);
    expect(session.status).toBe('busy');
    expect(idles()).toBe(0);
  });

  it('goes idle once the dialog has been answered and the composer is up', () => {
    vi.useFakeTimers();
    let screen = RENDERED_DIALOG_2_1_252;
    const { session, paint, idles } = launchingSession(() => screen);
    paint(RENDERED_DIALOG_2_1_252);
    vi.advanceTimersByTime(10_000);
    expect(session.status).toBe('busy');

    // No new output needed: the check keeps re-reading the screen on its own.
    screen = RENDERED_MAIN_UI.replace('✻ Actualizing… (13m 23s · ↓ 47.5k tokens)', '');
    vi.advanceTimersByTime(10_000);
    expect(session.status).toBe('idle');
    expect(idles()).toBe(1);
  });

  it('keeps holding when a capture fails after the dialog was seen', () => {
    vi.useFakeTimers();
    // A failed capture says nothing about whether the dialog went away.
    let screen: string | null = RENDERED_DIALOG_2_1_252;
    const { session, paint, idles } = launchingSession(() => screen);
    paint(RENDERED_DIALOG_2_1_252);
    vi.advanceTimersByTime(5000);
    screen = null;
    vi.advanceTimersByTime(20_000);
    expect(session.status).toBe('busy');
    expect(idles()).toBe(0);
  });

  it("does not carry the last pane's dialog verdict into a restarted pane", async () => {
    // The session saw the dialog on its last pane, then restarted where no capture can
    // replace that verdict (here the direct-PTY fallback, which has no pane to read; a
    // failed capture keeps it the same way). The new pane must still be able to go idle.
    const session = new Session({ workingDir: '/tmp', mode: 'claude', useMux: false });
    (session as unknown as { _lastPaneProbeTrustDialog: boolean })._lastPaneProbeTrustDialog = true;
    try {
      await session.startInteractive();
      vi.useFakeTimers();
      const internals = session as unknown as {
        _detectInteractiveActivity(data: string): void;
        _markActivity(): void;
      };
      internals._markActivity();
      internals._detectInteractiveActivity('❯ ');
      vi.advanceTimersByTime(30_000);
      expect(session.status).toBe('idle');
    } finally {
      vi.useRealTimers();
      await session.stop();
    }
  });

  it('lets a dialog-looking screen go idle outside the startup window', () => {
    vi.useFakeTimers();
    // A live agent can print the dialog's words hours in, and must not be held busy.
    const { session, paint } = launchingSession(() => RENDERED_DIALOG_2_1_252);
    vi.advanceTimersByTime(10 * 60_000);
    paint(RENDERED_DIALOG_2_1_252);
    vi.advanceTimersByTime(30_000);
    expect(session.status).toBe('idle');
  });
});
