/**
 * @fileoverview The tmux prefix table on Codeman's socket holds only
 * `<prefix> send-prefix`, so keys typed into a browser terminal cannot move its
 * attach client onto another session, without taking `codeman tui`'s way out away.
 *
 * Two layers here (the createSession wiring is in tmux-manager.test.ts):
 * - the decision (`prefixTableNeedsReset`) on real `list-keys` shapes,
 * - the effect against a REAL tmux server on a private throwaway socket (never
 *   Codeman's own), driven through a real attach client in a pty, the way a
 *   browser tab drives one.
 *
 * Port: N/A (no server)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import * as pty from 'node-pty';
import { prefixTableNeedsReset, restrictTmuxPrefixTable } from '../src/tmux-prefix-table.js';

/** A trimmed copy of tmux 3.4's stock prefix table, as `list-keys -T prefix` prints it. */
const STOCK = [
  'bind-key    -T prefix C-b                    send-prefix',
  'bind-key    -T prefix C-o                    rotate-window',
  'bind-key    -T prefix C-z                    suspend-client',
  'bind-key    -T prefix (                      switch-client -p',
  'bind-key    -T prefix )                      switch-client -n',
  'bind-key    -T prefix L                      switch-client -l',
  'bind-key    -T prefix d                      detach-client',
  'bind-key    -T prefix s                      choose-tree -Zs',
  'bind-key    -T prefix w                      choose-tree -Zw',
  'bind-key -r -T prefix Up                     select-pane -U',
].join('\n');

const RESTRICTED = 'bind-key    -T prefix C-b                    send-prefix\n';

describe('prefixTableNeedsReset', () => {
  it("resets tmux's stock table (switch-client, choose-tree, detach-client on d)", () => {
    expect(prefixTableNeedsReset(STOCK)).toBe(true);
  });

  it('leaves a table that holds only C-b send-prefix alone', () => {
    expect(prefixTableNeedsReset(RESTRICTED)).toBe(false);
  });

  it("leaves a codeman tui attach's held-Ctrl detach alias alone", () => {
    expect(prefixTableNeedsReset(`${RESTRICTED}bind-key    -T prefix C-d                    detach-client\n`)).toBe(
      false
    );
  });

  it('resets when a single foreign binding is back, or the stock detach key d', () => {
    expect(prefixTableNeedsReset(`${RESTRICTED}bind-key    -T prefix s                      choose-tree -Zs\n`)).toBe(
      true
    );
    expect(prefixTableNeedsReset(`${RESTRICTED}bind-key    -T prefix d                      detach-client\n`)).toBe(
      true
    );
  });

  it('resets an empty table or one without send-prefix, and output it cannot read', () => {
    expect(prefixTableNeedsReset('')).toBe(true);
    expect(prefixTableNeedsReset('bind-key    -T prefix C-d                    detach-client\n')).toBe(true);
    expect(prefixTableNeedsReset('something unexpected\n')).toBe(true);
  });

  it("follows the socket's configured prefix instead of assuming C-b", () => {
    const ctrlA = 'bind-key    -T prefix C-a                    send-prefix\n';
    expect(prefixTableNeedsReset(ctrlA, 'C-a')).toBe(false);
    // C-b send-prefix under a C-a prefix is a leftover, not the binding we want.
    expect(prefixTableNeedsReset(RESTRICTED, 'C-a')).toBe(true);
    expect(prefixTableNeedsReset('', 'None')).toBe(false);
  });

  it('reads a key tmux lists backslash-escaped as the key itself', () => {
    // `prefix C-\` is printed as is by show-options, but listed as `C-\\`.
    expect(prefixTableNeedsReset('bind-key    -T prefix C-\\\\                   send-prefix\n', 'C-\\')).toBe(false);
  });
});

describe('restrictTmuxPrefixTable (recorded commands)', () => {
  /** A runner that answers from `replies` (a thrown Error stands for a failing command) and records every call. */
  function fakeTmux(replies: Record<string, string | Error>): { run: (cmd: string) => string; calls: string[] } {
    const calls: string[] = [];
    const run = (cmd: string): string => {
      calls.push(cmd);
      const sub = cmd.replace(/^tmux -L 'codeman' /, '');
      const reply = replies[sub] ?? '';
      if (reply instanceof Error) throw reply;
      return reply;
    };
    return { run, calls };
  }

  it('still binds send-prefix when the table is empty and unbind-key -a fails on it', () => {
    // tmux 3.4 on an empty prefix table: both commands exit 1 with "table prefix doesn't exist".
    const missing = new Error("table prefix doesn't exist");
    const tmux = fakeTmux({
      'show-options -gv prefix': 'C-b\n',
      'list-keys -T prefix': missing,
      'unbind-key -a -T prefix': missing,
    });
    expect(restrictTmuxPrefixTable(`tmux -L 'codeman'`, tmux.run)).toBe(true);
    expect(tmux.calls).toContain(`tmux -L 'codeman' bind-key -T prefix 'C-b' send-prefix`);
  });

  it('does not reset again when the listed prefix is only escaped differently', () => {
    const tmux = fakeTmux({
      'show-options -gv prefix': 'C-\\\n',
      'list-keys -T prefix': 'bind-key    -T prefix C-\\\\                   send-prefix\n',
    });
    expect(restrictTmuxPrefixTable(`tmux -L 'codeman'`, tmux.run)).toBe(false);
    expect(tmux.calls.filter((c) => c.includes('bind-key'))).toEqual([]);
  });
});

const hasTmux = (() => {
  try {
    execSync('tmux -V', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasTmux)('restrictTmuxPrefixTable against a real tmux (private socket)', () => {
  // Throwaway server, never Codeman's socket; -f /dev/null keeps the user's config out.
  const socket = `codeman-prefix-test-${process.pid}`;
  const tmux = `tmux -L ${socket} -f /dev/null`;
  const run = (cmd: string): string => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  const keys = (table: string) => run(`${tmux} list-keys -T ${table}`);
  let client: pty.IPty | null = null;

  /** The session the attach client is looking at right now. */
  const clientSession = () => run(`${tmux} list-clients -F '#{client_session}'`).trim();

  async function waitFor(check: () => boolean, ms = 3000): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return check();
  }

  /** Types keys into the attach client, then gives tmux time to act on them. */
  async function type(keysToSend: string): Promise<void> {
    for (const ch of keysToSend) {
      client!.write(ch);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  beforeAll(async () => {
    // `cat -v` prints a received Ctrl+B as ^B, which is how send-prefix shows up.
    run(`${tmux} new-session -d -s alpha -x 80 -y 24 'cat -v'`);
    run(`${tmux} new-session -d -s beta -x 80 -y 24 'cat -v'`);
    const env = { ...process.env } as Record<string, string>;
    delete env.TMUX; // the suite may itself run inside tmux
    // What a browser tab is: a pty running `tmux attach-session` (tmux-manager getAttachArgs).
    client = pty.spawn('tmux', ['-L', socket, 'attach-session', '-t', 'alpha'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      env,
    });
    expect(await waitFor(() => clientSession() === 'alpha')).toBe(true);
  });

  afterAll(() => {
    client?.kill();
    let socketPath = '';
    try {
      socketPath = run(`${tmux} display-message -p '#{socket_path}'`).trim();
      run(`${tmux} kill-server`); // our own throwaway socket only
    } catch {
      /* already gone */
    }
    // tmux leaves the socket file behind; remove ours (and only ours).
    if (socketPath.endsWith(`/${socket}`)) rmSync(socketPath, { force: true });
  });

  it("with tmux's stock table, Ctrl+B ) moves the attach client onto another session", async () => {
    // The bug, reproduced so the next test means something.
    await type('\x02)');
    expect(await waitFor(() => clientSession() === 'beta')).toBe(true);
    run(`${tmux} switch-client -c $(${tmux} list-clients -F '#{client_name}') -t alpha`);
    expect(await waitFor(() => clientSession() === 'alpha')).toBe(true);
  });

  it('after the reset, Ctrl+B ) and Ctrl+B s leave the client where it is, Ctrl+B Ctrl+B reaches the pane', async () => {
    const rootBefore = keys('root');

    expect(restrictTmuxPrefixTable(tmux, run)).toBe(true);

    const prefix = keys('prefix')
      .split('\n')
      .filter((l) => l.trim());
    expect(prefix).toHaveLength(1);
    expect(prefix[0]).toMatch(/-T prefix C-b\s+send-prefix$/);
    expect(keys('root')).toBe(rootBefore);
    expect(run(`${tmux} show-options -gv prefix`).trim()).toBe('C-b');

    await type('\x02)');
    await type('\x02s');
    expect(clientSession()).toBe('alpha');
    expect(run(`${tmux} display-message -p -t alpha '#{pane_in_mode}'`).trim()).toBe('0');

    await type('\x02\x02');
    expect(await waitFor(() => run(`${tmux} capture-pane -p -t alpha`).includes('^B'))).toBe(true);
  });

  it("keeps a codeman tui attach's way out when another session is created mid-attach", () => {
    // What beginAttachHandoff claims: C-d in the prefix table, F1 and M-1 in root.
    run(`${tmux} bind-key -T prefix C-d detach-client`);
    run(`${tmux} bind-key -T root F1 detach-client`);
    run(`${tmux} bind-key -T root M-1 switch-client -t alpha`);

    expect(restrictTmuxPrefixTable(tmux, run)).toBe(false);

    expect(keys('prefix')).toMatch(/-T prefix C-d\s+detach-client/);
    expect(keys('root')).toMatch(/-T root F1\s+detach-client/);
    expect(keys('root')).toMatch(/-T root M-1\s+switch-client -t alpha/);
  });

  it("gives a running attach's held-Ctrl way out back when the reset clears a stock table", () => {
    // A tmux server whose table is still stock while a codeman tui attach holds C-d:
    // `unbind-key -a` takes C-d along with the rest.
    try {
      run(`${tmux} bind-key -T prefix d detach-client`);
      run(`${tmux} bind-key -T prefix ')' switch-client -n`);
      run(`${tmux} bind-key -T prefix C-d detach-client`);
      expect(restrictTmuxPrefixTable(tmux, run)).toBe(true);
      const prefix = keys('prefix')
        .split('\n')
        .filter((l) => l.trim());
      expect(prefix).toHaveLength(2);
      expect(keys('prefix')).toMatch(/-T prefix C-b\s+send-prefix/);
      expect(keys('prefix')).toMatch(/-T prefix C-d\s+detach-client/);
    } finally {
      run(`${tmux} unbind-key -T prefix C-d`);
    }
  });

  it('binds send-prefix to the configured prefix when the socket uses another one', () => {
    run(`${tmux} set-option -g prefix C-a`);
    try {
      expect(restrictTmuxPrefixTable(tmux, run)).toBe(true);
      const prefix = keys('prefix')
        .split('\n')
        .filter((l) => l.trim());
      expect(prefix).toEqual([expect.stringMatching(/-T prefix C-a\s+send-prefix$/)]);
    } finally {
      run(`${tmux} set-option -g prefix C-b`);
    }
  });

  it('binds send-prefix on a server whose prefix table is empty', () => {
    // On an empty table tmux fails both `list-keys -T prefix` and `unbind-key -a -T prefix`.
    run(`${tmux} unbind-key -a -T prefix`);
    expect(() => run(`${tmux} unbind-key -a -T prefix`)).toThrow();

    expect(restrictTmuxPrefixTable(tmux, run)).toBe(true);
    const prefix = keys('prefix')
      .split('\n')
      .filter((l) => l.trim());
    expect(prefix).toEqual([expect.stringMatching(/-T prefix C-b\s+send-prefix$/)]);
  });

  it('resets once, not on every call, for a prefix tmux lists escaped (C-\\)', () => {
    run(`${tmux} set-option -g prefix 'C-\\'`);
    try {
      expect(restrictTmuxPrefixTable(tmux, run)).toBe(true);
      expect(keys('prefix')).toMatch(/-T prefix C-\\\\\s+send-prefix/);
      expect(restrictTmuxPrefixTable(tmux, run)).toBe(false);
    } finally {
      run(`${tmux} set-option -g prefix C-b`);
    }
  });
});
