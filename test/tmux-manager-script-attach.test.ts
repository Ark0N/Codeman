/**
 * @fileoverview scripts/tmux-manager.sh attaches with a way back out.
 *
 * Codeman keeps the prefix table on its socket down to `send-prefix`
 * (src/tmux-prefix-table.ts), so tmux's `Ctrl+B d` no longer detaches there. The
 * script's attach claims F1 in the root table for the length of the attach instead,
 * and leaves a binding the user owns alone.
 *
 * Runs the real script against a REAL tmux server on a private throwaway socket
 * (never Codeman's own) with a throwaway HOME, through a pty like a terminal would.
 *
 * Port: N/A (no server)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as pty from 'node-pty';

const hasTools = (() => {
  try {
    execSync('tmux -V && jq --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasTools)('scripts/tmux-manager.sh attach (real tmux, private socket)', () => {
  const socket = `codeman-script-test-${process.pid}`;
  const tmux = `tmux -L ${socket} -f /dev/null`;
  const run = (cmd: string): string => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const rootKeys = () => run(`${tmux} list-keys -T root`);
  const clients = () => run(`${tmux} list-clients -F '#{client_session}'`).trim();
  let home = '';

  async function waitFor(check: () => boolean, ms = 4000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return check();
  }

  /** `tmux-manager.sh attach 1` in a pty; resolves its output once it exits. */
  function attach(): { script: pty.IPty; exited: Promise<string> } {
    const env = { ...process.env, HOME: home, CODEMAN_TMUX_SOCKET: socket } as Record<string, string>;
    delete env.TMUX; // the suite may itself run inside tmux
    const script = pty.spawn('bash', ['scripts/tmux-manager.sh', 'attach', '1'], {
      name: 'xterm-256color',
      cols: 100,
      rows: 24,
      cwd: process.cwd(),
      env,
    });
    let output = '';
    script.onData((data) => (output += data));
    const exited = new Promise<string>((resolve) => script.onExit(() => resolve(output)));
    return { script, exited };
  }

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'codeman-script-home-'));
    mkdirSync(join(home, '.codeman'));
    writeFileSync(join(home, '.codeman', 'mux-sessions.json'), JSON.stringify([{ name: 'alpha', muxName: 'alpha' }]));
    run(`${tmux} new-session -d -s alpha -x 80 -y 24 'cat'`);
    // What Codeman leaves on its socket: nothing but send-prefix in the prefix table.
    run(`${tmux} unbind-key -a -T prefix`);
    run(`${tmux} bind-key -T prefix C-b send-prefix`);
  });

  afterAll(() => {
    let socketPath = '';
    try {
      socketPath = run(`${tmux} display-message -p '#{socket_path}'`).trim();
      run(`${tmux} kill-server`); // our own throwaway socket only
    } catch {
      /* already gone */
    }
    if (socketPath.endsWith(`/${socket}`)) rmSync(socketPath, { force: true });
    if (home) rmSync(home, { recursive: true, force: true });
  });

  it('F1 detaches back out of the attach, and the claim is given back afterwards', async () => {
    expect(rootKeys()).not.toMatch(/-T root F1\s/);
    const { script, exited } = attach();
    try {
      expect(await waitFor(() => clients() === 'alpha')).toBe(true);
      expect(rootKeys()).toMatch(/-T root F1\s+detach-client/);

      script.write('\x1bOP'); // F1
      const output = await exited;

      expect(output).toContain('F1 to detach');
      expect(clients()).toBe('');
      expect(rootKeys()).not.toMatch(/-T root F1\s/);
      expect(run(`${tmux} has-session -t alpha && echo alive`).trim()).toBe('alive');
    } finally {
      script.kill();
    }
  });

  it("leaves an F1 binding of the user's own alone and says how to detach instead", async () => {
    run(`${tmux} bind-key -T root F1 display-message mine`);
    const { script, exited } = attach();
    try {
      expect(await waitFor(() => clients() === 'alpha')).toBe(true);
      expect(rootKeys()).toMatch(/-T root F1\s+display-message mine/);

      run(`${tmux} detach-client -s alpha`);
      const output = await exited;

      expect(output).toContain('detach-client -s alpha');
      expect(output).not.toContain('F1 to detach');
      expect(rootKeys()).toMatch(/-T root F1\s+display-message mine/);
    } finally {
      script.kill();
      run(`${tmux} unbind-key -T root F1`);
    }
  });
});
