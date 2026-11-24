/**
 * @fileoverview A `codeman tui` attach takes the window size back when you type
 * in it, after a browser tab re-pinned the window to its own size.
 *
 * Against a real tmux on a private socket (never Codeman's). Two attach clients
 * on ptys: one is the TUI's terminal, the other is what a browser tab is (one
 * `tmux attach-session` per session, sized by Codeman). The browser's resize is
 * what `TmuxManager.resizeWindow()` runs: `resize-window -x -y`, which puts the
 * window on `manual`.
 *
 * Port: N/A (no server)
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import * as pty from 'node-pty';
import { TUI_FOLLOW_TYPING_HOOK, TuiClient } from '../../src/tui/tui-client.js';

const hasTmux = (() => {
  try {
    execSync('tmux -V', { stdio: 'ignore' });
  } catch {
    return false;
  }
  // `client-active` exists from tmux 3.3. An older tmux refuses the hook, and
  // armFollowTyping() answers false there, which the unit tests cover.
  const version = /tmux (?:next-)?([0-9]+)\.([0-9]+)/.exec(execSync('tmux -V', { encoding: 'utf8' }));
  if (!version) return false;
  const major = Number(version[1]);
  const minor = Number(version[2]);
  return major > 3 || (major === 3 && minor >= 3);
})();

describe.skipIf(!hasTmux)('TUI attach follows the terminal you type in', () => {
  const socket = `codeman-tui-follow-${process.pid}`;
  const alpha = 'codeman-aaaa3333';
  const run = (args: readonly string[]): string =>
    execFileSync('tmux', ['-L', socket, '-f', '/dev/null', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const client = new TuiClient({ socket });
  const clients: pty.IPty[] = [];

  function attach(cols: number, rows: number): pty.IPty {
    const env = { ...process.env } as Record<string, string>;
    delete env.TMUX;
    const term = pty.spawn('tmux', ['-L', socket, '-f', '/dev/null', 'attach-session', '-t', alpha], {
      name: 'xterm-256color',
      cols,
      rows,
      env,
    });
    term.onData(() => {
      /* drain, so tmux never blocks on a full pty */
    });
    clients.push(term);
    return term;
  }

  /** The tty tmux reports for a client, found by its pid (portable: macOS has no /proc). */
  function ttyOf(term: pty.IPty): string {
    for (const line of run(['list-clients', '-F', '#{client_pid}\t#{client_tty}']).split('\n')) {
      const [pid, tty] = line.trim().split('\t');
      if (pid === String(term.pid) && tty) return tty;
    }
    return '';
  }

  function windowSize(): string {
    return run(['display-message', '-p', '-t', alpha, '#{window_width}x#{window_height} #{window-size}']).trim();
  }

  function hooks(): string {
    return run(['show-hooks', '-t', alpha]);
  }

  async function waitFor(check: () => boolean, ms = 4000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    return check();
  }

  /**
   * Codeman's web resize, as `Session.resize()` does it: the tab's attach
   * client's pty, then `TmuxManager.resizeWindow()`'s `resize-window`.
   */
  async function browserResize(term: pty.IPty, cols: number, rows: number): Promise<void> {
    term.resize(cols, rows);
    await new Promise((resolve) => setTimeout(resolve, 150));
    run(['resize-window', '-t', alpha, '-x', String(cols), '-y', String(rows)]);
  }

  afterAll(() => {
    for (const term of clients) term.kill();
    let socketPath = '';
    try {
      socketPath = run(['display-message', '-p', '#{socket_path}']).trim();
      run(['kill-server']);
    } catch {
      /* already gone */
    }
    if (socketPath.endsWith(`/${socket}`)) rmSync(socketPath, { force: true });
  });

  it('gives the window back to the TUI terminal on its next keystroke, and only to that terminal', async () => {
    run(['new-session', '-d', '-s', alpha, '-x', '120', '-y', '40', 'cat']);
    run(['set-option', '-g', 'status', 'off']);
    run(['set-window-option', '-t', alpha, 'window-size', 'manual']);

    const tui = attach(200, 50);
    let tuiTty = '';
    expect(await waitFor(() => (tuiTty = ttyOf(tui)) !== '')).toBe(true);
    expect(await client.followAttachingClient(alpha)).toBe(true);
    expect(await client.armFollowTyping(alpha, tuiTty)).toBe(true);
    expect(hooks()).toContain(TUI_FOLLOW_TYPING_HOOK);
    // The closed form, which disarm and re-arm match on.
    expect(hooks()).toContain(`#{client_tty},${tuiTty}}`);
    // Set on the session, not the server: no other session gets it.
    expect(run(['show-hooks', '-g'])).not.toContain(TUI_FOLLOW_TYPING_HOOK);
    expect(await waitFor(() => windowSize() === '200x50 latest')).toBe(true);

    // A phone opens the session: its client attaches and Codeman pins the window.
    const browser = attach(60, 30);
    expect(await waitFor(() => ttyOf(browser) !== '')).toBe(true);
    run(['resize-window', '-t', alpha, '-x', '60', '-y', '30']);
    expect(windowSize()).toBe('60x30 manual');

    // Typing in the browser tab is Codeman's business, not the hook's.
    browser.write('b');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(windowSize()).toBe('60x30 manual');

    // Typing in the TUI terminal takes it back. This is the bug: without the
    // hook the window stayed 60x30 manual here for the rest of the attach.
    tui.write('a');
    expect(await waitFor(() => windowSize() === '200x50 latest')).toBe(true);

    // Resizing the TUI terminal is using it too: tmux makes the resized client
    // the latest one, so the hook fires without a keystroke (measured on 3.8).
    await browserResize(browser, 62, 30);
    expect(windowSize()).toBe('62x30 manual');
    tui.resize(150, 45);
    expect(await waitFor(() => windowSize() === '150x45 latest')).toBe(true);

    // The browser resizing its client makes THAT client the latest one, so
    // the TUI's next keystroke is a change of client and fires the hook again.
    await browserResize(browser, 62, 31);
    expect(windowSize()).toBe('62x31 manual');
    tui.write('a');
    expect(await waitFor(() => windowSize() === '150x45 latest')).toBe(true);
  });

  it('disarms only its own hook, and never replaces one of the user', async () => {
    const tuiTty = ttyOf(clients[0]);
    expect(tuiTty).not.toBe('');

    // Another tty's restore leaves this attach's hook alone (pts/4 vs pts/41 included).
    await client.disarmFollowTyping(alpha, `${tuiTty}1`);
    expect(hooks()).toContain(TUI_FOLLOW_TYPING_HOOK);

    await client.disarmFollowTyping(alpha, tuiTty);
    expect(hooks()).not.toContain(TUI_FOLLOW_TYPING_HOOK);
    // Disarmed means the next keystroke changes nothing.
    await browserResize(clients[1], 64, 30);
    clients[0].write('a');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(windowSize()).toBe('64x30 manual');

    // A hook of the user's own at that index is never overwritten.
    run(['set-hook', '-t', alpha, TUI_FOLLOW_TYPING_HOOK, 'display-message mine']);
    expect(await client.armFollowTyping(alpha, tuiTty)).toBe(false);
    expect(hooks()).toContain('display-message mine');
    await client.disarmFollowTyping(alpha, tuiTty);
    expect(hooks()).toContain('display-message mine');
    run(['set-hook', '-u', '-t', alpha, TUI_FOLLOW_TYPING_HOOK]);

    // One of ours for a stale tty (a TUI killed before its restore) is taken over.
    expect(await client.armFollowTyping(alpha, `${tuiTty}1`)).toBe(true);
    expect(await client.armFollowTyping(alpha, tuiTty)).toBe(true);
    expect(hooks()).toContain(`#{client_tty},${tuiTty}}`);
    expect(hooks()).not.toContain(`#{client_tty},${tuiTty}1}`);
  });
});
