/**
 * @fileoverview A `codeman tui` attach takes the window size back when you type
 * in it, after a browser tab re-pinned the window to its own size.
 *
 * Against a real tmux on a private socket (never Codeman's). Two attach clients
 * on ptys: one is the TUI's terminal, the other is what a browser tab is (one
 * `tmux attach-session` per session, sized by Codeman). The browser's resize is
 * what `Session.resize()` does: resize its client's pty, then
 * `TmuxManager.resizeWindow()`'s `resize-window -x -y`, which puts the window
 * on `manual`.
 *
 * Port: N/A (no server)
 */
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import * as pty from 'node-pty';
import { TUI_FOLLOW_HOOKS, TUI_FOLLOW_OWNER, TuiClient } from '../../src/tui/tui-client.js';

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

  it('follows whichever client was used last, the TUI terminal included', async () => {
    run(['new-session', '-d', '-s', alpha, '-x', '120', '-y', '40', 'cat']);
    run(['set-option', '-g', 'status', 'off']);
    run(['set-window-option', '-t', alpha, 'window-size', 'manual']);

    const tui = attach(200, 50);
    let tuiTty = '';
    expect(await waitFor(() => (tuiTty = ttyOf(tui)) !== '')).toBe(true);
    expect(await client.followAttachingClient(alpha)).toBe(true);
    expect(await client.armFollowTyping(alpha, tuiTty)).toBe(true);
    for (const name of Object.keys(TUI_FOLLOW_HOOKS)) expect(hooks()).toContain(name);
    expect(run(['show-options', '-t', alpha])).toContain(`${TUI_FOLLOW_OWNER} ${tuiTty}`);
    // Set on the session, not the server: no other session gets them.
    expect(run(['show-hooks', '-g'])).not.toContain('[91]');
    expect(await waitFor(() => windowSize() === '200x50 latest')).toBe(true);

    // A phone opens the session: Codeman's client attaches and is resized to it.
    const browser = attach(60, 30);
    expect(await waitFor(() => ttyOf(browser) !== '')).toBe(true);
    await browserResize(browser, 61, 30);
    expect(windowSize()).toBe('61x30 latest');

    // The bug: without the hooks the window stayed 61x30 manual here, and
    // typing in the terminal changed nothing for the rest of the attach.
    tui.write('a');
    expect(await waitFor(() => windowSize() === '200x50 latest')).toBe(true);

    // A browser opening a session sends a FORCED resize at its current size.
    // Its pty does not change, so tmux keeps the terminal as the latest client
    // and the window stays where the user is typing.
    await browserResize(browser, 61, 30);
    expect(windowSize()).toBe('200x50 latest');

    // Typing in the browser tab gives the window to the tab...
    browser.write('b');
    expect(await waitFor(() => windowSize() === '61x30 latest')).toBe(true);
    // ...and typing in the terminal takes it back.
    tui.write('a');
    expect(await waitFor(() => windowSize() === '200x50 latest')).toBe(true);

    // Codeman's own attach (`setManualWindowSize()`) sets manual with no resize.
    browser.write('b');
    expect(await waitFor(() => windowSize() === '61x30 latest')).toBe(true);
    run(['set-window-option', '-t', alpha, 'window-size', 'manual']);
    tui.write('a');
    expect(await waitFor(() => windowSize() === '200x50 latest')).toBe(true);

    // Resizing the terminal is using it too.
    browser.write('b');
    expect(await waitFor(() => windowSize() === '61x30 latest')).toBe(true);
    tui.resize(150, 45);
    expect(await waitFor(() => windowSize() === '150x45 latest')).toBe(true);
  });

  it('stops when disarmed, leaves a second TUI and the user alone', async () => {
    const [tui, browser] = clients;
    const tuiTty = ttyOf(tui);
    expect(tuiTty).not.toBe('');

    // Another tty's restore leaves this attach armed (pts/4 vs pts/41 included).
    await client.disarmFollowTyping(alpha, `${tuiTty}1`);
    expect(run(['show-options', '-t', alpha])).toContain(TUI_FOLLOW_OWNER);

    await client.disarmFollowTyping(alpha, tuiTty);
    expect(run(['show-options', '-t', alpha])).not.toContain(TUI_FOLLOW_OWNER);
    expect(hooks()).not.toContain('[91]');
    // Disarmed: Codeman's resize pins the window again, and typing changes nothing.
    await browserResize(browser, 64, 30);
    expect(windowSize()).toBe('64x30 manual');
    tui.write('a');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(windowSize()).toBe('64x30 manual');

    // Hooks left without an owner (a removal that failed) do nothing.
    for (const [name, command] of Object.entries(TUI_FOLLOW_HOOKS)) run(['set-hook', '-t', alpha, name, command]);
    await browserResize(browser, 65, 30);
    tui.write('a');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(windowSize()).toBe('65x30 manual');
    for (const name of Object.keys(TUI_FOLLOW_HOOKS)) run(['set-hook', '-u', '-t', alpha, name]);

    // A hook of the user's own at either index is never overwritten.
    run(['set-hook', '-t', alpha, 'after-resize-window[91]', 'display-message mine']);
    expect(await client.armFollowTyping(alpha, tuiTty)).toBe(false);
    expect(hooks()).toContain('display-message mine');
    expect(run(['show-options', '-t', alpha])).not.toContain(TUI_FOLLOW_OWNER);
    run(['set-hook', '-u', '-t', alpha, 'after-resize-window[91]']);

    // A leaked owner (a TUI killed mid-attach) is swept once its client is gone.
    expect(await client.armFollowTyping(alpha, '/dev/ttys999')).toBe(true);
    expect(await client.clearLeakedFollowTyping(null)).toBe(1);
    expect(run(['show-options', '-t', alpha])).not.toContain(TUI_FOLLOW_OWNER);
    expect(hooks()).not.toContain('[91]');
    // A live one is not.
    expect(await client.armFollowTyping(alpha, tuiTty)).toBe(true);
    expect(await client.clearLeakedFollowTyping(null)).toBe(0);
    expect(run(['show-options', '-t', alpha])).toContain(`${TUI_FOLLOW_OWNER} ${tuiTty}`);
  });
});
