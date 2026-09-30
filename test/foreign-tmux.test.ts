/**
 * Foreign tmux adoption — the pure core.
 *
 * These pin the properties that were established by MEASUREMENT against a real
 * tmux (3.3a) while the feature was built, and that a plausible-looking refactor
 * would quietly undo. Each one has a comment naming what actually went wrong.
 */

import { describe, it, expect } from 'vitest';
import {
  buildForeignProbeScript,
  parseForeignProbeOutput,
  classifyForeignPaneMode,
  isCodemanOwnedPane,
  foreignSessionId,
  foreignViewSessionName,
  isAdoptableSessionName,
  isAdoptableSocketPath,
  buildForeignAttachCommand,
  buildForeignDockerAttachCommand,
  buildForeignRemoteAttachCommand,
  buildForeignTmuxInvocation,
} from '../src/foreign-tmux.js';

// A probe transcript in exactly the shape a real run produces. The pane rows use
// the LITERAL backslash-t that tmux's `-F` emits (verified on next-3.7 and 3.3a),
// while the socket line is space-separated because `sh`'s builtin `echo` expands
// a backslash-t to a real TAB — two different meanings for one escape, two lines
// apart, which is why the socket marker carries no separator at all.
const PROBE = [
  'CMFS /tmp/tmux-0/default',
  'CMFP\\t/tmp/tmux-0/default\\t631\\t0\\t1\\t1788092494\\t1\\t%0\\tclaude\\twork\\t/srv/app',
  'CMFP\\t/tmp/tmux-0/default\\t900\\t0\\t1\\t1788092500\\t0\\t%1\\tbash\\tscratch\\t/home/me',
  'CMFP\\t/tmp/tmux-0/default\\t950\\t0\\t2\\t1788092600\\t0\\t%2\\tnode\\tcodex-work\\t/srv/app',
  'CMFQ',
  '  631   630 -bash',
  ' 4056   631 claude --dangerously-skip-permissions',
  ' 4104  4056 /usr/local/bin/ortg --repo /ortg mcp',
  '  900   630 -bash',
  '  950   630 node /opt/homebrew/bin/codex',
].join('\n');

describe('buildForeignProbeScript', () => {
  it('contains no single quote — it is wrapped in one to cross ssh and docker exec', () => {
    // The script is embedded as `ssh host '<script>'` and `docker exec c sh -lc
    // '<script>'`. One single quote inside ends the wrapper early and the rest is
    // re-tokenized by the remote shell.
    expect(buildForeignProbeScript()).not.toContain("'");
  });

  it('does not disable globbing — the socket sweep IS a glob', () => {
    // A `set -f` here turned the whole loop into one literal non-match, and the
    // probe reported zero sessions on a machine that had three.
    expect(buildForeignProbeScript()).not.toMatch(/\bset -f\b/);
  });

  it('keeps the shell variables unexpanded for the INNER shell', () => {
    // Running this through anything that adds an outer shell (execSync spawns
    // `sh -c`) expands `$TMUX_TMPDIR`/`$U` too early. Callers must use an argv
    // array locally; the script's job is only to still contain them.
    const s = buildForeignProbeScript();
    expect(s).toContain('${TMUX_TMPDIR:-/tmp}');
    expect(s).toContain('$TD/tmux-$U/*');
  });
});

describe('parseForeignProbeOutput', () => {
  it('parses pane rows, the socket list and the process snapshot', () => {
    const out = parseForeignProbeOutput(PROBE);
    expect(out.sockets).toEqual(['/tmp/tmux-0/default']);
    expect(out.panes).toHaveLength(3);
    expect(out.panes[0]).toMatchObject({
      socketPath: '/tmp/tmux-0/default',
      sessionName: 'work',
      panePid: 631,
      paneCurrentCommand: 'claude',
      paneCurrentPath: '/srv/app',
      sessionAttached: true,
      windows: 1,
    });
    expect(out.argvByPid.get(4056)).toBe('claude --dangerously-skip-permissions');
    expect(out.byParent.get(631)).toEqual([4056]);
  });

  it('never throws on garbage and simply skips unusable rows', () => {
    const out = parseForeignProbeOutput('nonsense\nCMFP\\ttoo\\tfew\nCMFQ\nnot a proc row\n');
    expect(out.panes).toHaveLength(0);
    expect(out.argvByPid.size).toBe(0);
  });

  it('tolerates a real TAB, in case a tmux build expands the escape', () => {
    const withTabs = PROBE.split('\n')
      .map((l) => (l.startsWith('CMFP') ? l.replace(/\\t/g, '\t') : l))
      .join('\n');
    expect(parseForeignProbeOutput(withTabs).panes).toHaveLength(3);
  });

  it('keeps the pane path even when the SESSION NAME contains a separator', () => {
    // The two free-form fields sit last for exactly this: the path is taken from
    // the END and the name is whatever lies between the fixed prefix and it, so a
    // separator inside a user-chosen name cannot shift the path out of place.
    const row = 'CMFP\\t/s\\t1\\t0\\t1\\t100\\t0\\t%0\\tbash\\tmy\\tname\\t/srv/x';
    const out = parseForeignProbeOutput(`${row}\nCMFQ\n`);
    expect(out.panes[0].paneCurrentPath).toBe('/srv/x');
    expect(out.panes[0].sessionName).toBe('my\tname');
  });
});

describe('classifyForeignPaneMode', () => {
  const probe = parseForeignProbeOutput(PROBE);

  it('finds claude through the process tree, not the pane command', () => {
    // `#{pane_current_command}` is `node` for BOTH claude and codex, and the
    // pane's own pid is the SHELL. Only the descendant walk can tell them apart.
    const pane = probe.panes.find((p) => p.sessionName === 'work')!;
    expect(classifyForeignPaneMode(pane, probe).mode).toBe('claude');
  });

  it('finds codex the same way', () => {
    const pane = probe.panes.find((p) => p.sessionName === 'codex-work')!;
    expect(classifyForeignPaneMode(pane, probe).mode).toBe('codex');
  });

  it('calls a plain shell a shell — the case this feature exists for', () => {
    const pane = probe.panes.find((p) => p.sessionName === 'scratch')!;
    const c = classifyForeignPaneMode(pane, probe);
    expect(c.mode).toBe('shell');
    expect(c.command).toBe('-bash');
  });

  it("falls back to tmux's own answer when there is no process snapshot", () => {
    // A host whose `ps` refused both forms still gets a usable classification:
    // `pane_current_command` is the FOREGROUND process, so it names the agent
    // even though the pane pid names the shell.
    const empty = { byParent: new Map(), argvByPid: new Map() };
    expect(classifyForeignPaneMode({ panePid: 1, paneCurrentCommand: 'claude' }, empty).mode).toBe('claude');
    expect(classifyForeignPaneMode({ panePid: 1, paneCurrentCommand: 'zsh' }, empty).mode).toBe('shell');
  });
});

describe('isCodemanOwnedPane', () => {
  const pane = (socketPath: string, sessionName: string) => ({ socketPath, sessionName });

  it("excludes this instance's own socket", () => {
    expect(isCodemanOwnedPane(pane('/tmp/tmux-0/codeman-beta', 'x'), 'codeman-beta')).toBe(true);
  });

  it('excludes ANOTHER Codeman instance too', () => {
    // Otherwise a beta would offer to adopt prod's sessions, attaching a second
    // PTY to a live pane prod is already driving.
    expect(isCodemanOwnedPane(pane('/tmp/tmux-0/codeman', 'x'), 'codeman-beta')).toBe(true);
    expect(isCodemanOwnedPane(pane('/tmp/tmux-0/codeman-remote', 'x'), 'codeman-beta')).toBe(true);
  });

  it('excludes Codeman-minted session names on a foreign socket', () => {
    // Our own grouped view sessions live on the foreign server; without this a
    // second scan would offer to adopt our own view.
    expect(isCodemanOwnedPane(pane('/tmp/tmux-0/default', 'codeman-view-abc12345'), 'codeman')).toBe(true);
    expect(isCodemanOwnedPane(pane('/tmp/tmux-0/default', 'claudeman-abc'), 'codeman')).toBe(true);
  });

  it('admits an ordinary hand-made session', () => {
    expect(isCodemanOwnedPane(pane('/tmp/tmux-0/default', 'work'), 'codeman')).toBe(false);
  });
});

describe('adoptability gate (security)', () => {
  it('refuses a name carrying command substitution', () => {
    // The local launch chain ends at `bash -c ${JSON.stringify(cmd)}`, and the
    // OUTER shell expands `$(...)` and backticks inside its double quotes before
    // bash ever sees the inner single quotes. Measured: a launchCmd of
    // `: 'x$(touch A)`touch B`'` created BOTH files. A foreign session name is
    // chosen by someone else, so it must never reach that string.
    expect(isAdoptableSessionName('work;$(touch /tmp/PWNED)')).toBe(false);
    expect(isAdoptableSessionName('work`touch /tmp/PWNED`')).toBe(false);
    expect(isAdoptableSessionName('work$HOME')).toBe(false);
    expect(isAdoptableSessionName('a\\b')).toBe(false);
    expect(isAdoptableSessionName('a"b')).toBe(false);
    expect(isAdoptableSessionName("a'b")).toBe(false);
    expect(isAdoptableSessionName('a\nb')).toBe(false);
    expect(isAdoptableSessionName('')).toBe(false);
  });

  it('still admits the names people actually use', () => {
    // A refusal here is a session the user cannot open at all, so the allowlist
    // has to cover real life: spaces, CJK, punctuation.
    for (const n of ['work', 'my-project', 'feat/login', 'weird name', 'zh-会话', 'v1.2_build', 'a+b@c']) {
      expect(isAdoptableSessionName(n)).toBe(true);
    }
  });

  it('holds the socket path to the same rule, plus absoluteness', () => {
    // A socket is `tmux -L <name>` under a user-controlled directory, so its
    // path is attacker-influenceable in exactly the same way.
    expect(isAdoptableSocketPath('/tmp/tmux-0/default')).toBe(true);
    expect(isAdoptableSocketPath('/tmp/tmux-0/$(id)')).toBe(false);
    expect(isAdoptableSocketPath('relative/path')).toBe(false);
    expect(isAdoptableSocketPath('/tmp/../etc/x')).toBe(false);
  });
});

describe('identity', () => {
  it('is stable across scans and distinct per target', () => {
    const a = foreignSessionId('local', 'local', '/tmp/tmux-0/default', 'work');
    expect(foreignSessionId('local', 'local', '/tmp/tmux-0/default', 'work')).toBe(a);
    expect(foreignSessionId('local', 'local', '/tmp/tmux-0/default', 'other')).not.toBe(a);
    expect(foreignSessionId('remote', 'h1', '/tmp/tmux-0/default', 'work')).not.toBe(a);
  });

  it('names the view session after the Codeman session', () => {
    expect(foreignViewSessionName('a10674f9-abce-4551')).toBe('codeman-view-a10674f9');
  });
});

describe('attach command builders', () => {
  const target = { socketPath: '/tmp/tmux-0/default', targetSession: 'work', viewSession: 'codeman-view-abc12345' };

  it('creates the view session ATTACHED, never with -d', () => {
    // tmux's `server_check_unattached()` runs every server loop, so a DETACHED
    // session carrying `destroy-unattached on` is destroyed almost immediately.
    const cmd = buildForeignTmuxInvocation(target);
    expect(cmd).toContain('new-session -t');
    expect(cmd).not.toMatch(/new-session\s+-d/);
  });

  it('sets destroy-unattached so the view dies with our pane', () => {
    expect(buildForeignTmuxInvocation(target)).toContain('destroy-unattached on');
  });

  it('never sets window-size on the shared window', () => {
    // Measured: `window-size largest` is the only setting that protects an
    // actively-used session's size, but it is a WINDOW option on a SHARED window
    // and SURVIVES our detach — it would permanently rewrite the owner's config.
    expect(buildForeignTmuxInvocation(target)).not.toContain('window-size');
  });

  it('falls back to a READ-ONLY attach, never a writable bare one', () => {
    // A writable bare attach is precisely the thing that resizes the owner's
    // terminal, so the degraded path must be the harmless one.
    const cmd = buildForeignTmuxInvocation(target);
    expect(cmd).toMatch(/\|\|\s*exec tmux -S .* attach-session -r -t/);
  });

  it('stays on ONE line — it crosses `bash -c "..."` where a newline dies', () => {
    expect(buildForeignAttachCommand(target)).not.toContain('\n');
  });

  it('uses no command substitution — the outer shell would evaluate it first', () => {
    // Same rule the docker launch chain states, and the same trap that emptied
    // `$TMUX_TMPDIR` during development.
    expect(buildForeignAttachCommand(target)).not.toContain('$(');
  });

  it('shell-quotes every caller-supplied value', () => {
    const nasty = buildForeignAttachCommand({
      socketPath: '/tmp/a b',
      targetSession: 'ev;il`x`',
      viewSession: 'codeman-view-1',
    });
    expect(nasty).toContain("'/tmp/a b'");
    // The metacharacters survive only INSIDE quotes, never as shell syntax.
    expect(nasty).not.toMatch(/[^']ev;il/);
  });

  describe('docker', () => {
    const cmd = buildForeignDockerAttachCommand({
      ...target,
      dockerBase: 'docker --context ci',
      containerName: 'my-box',
    });

    it('looks, then execs — never create, never start', () => {
      // An adopted container belongs to the user. Mirrors the adopted branch of
      // buildDockerLaunchCommand, which fails closed rather than mutating it.
      expect(cmd).toContain('inspect');
      expect(cmd).toContain('exec -it');
      expect(cmd).not.toMatch(/\bdocker[^;]*\bstart\b/);
      expect(cmd).not.toMatch(/\bdocker[^;]*\bcreate\b/);
      expect(cmd).not.toMatch(/\bdocker[^;]*\brun\b/);
    });

    it('refuses a stopped container with a message instead of starting it', () => {
      expect(cmd).toContain('State.Running');
      expect(cmd).toMatch(/not running/);
    });

    it('carries the engine flags it was given', () => {
      expect(cmd).toContain('docker --context ci');
    });
  });

  describe('remote', () => {
    const cmd = buildForeignRemoteAttachCommand({
      ...target,
      sshArgs: ['ssh', '-o BatchMode=yes', '-o ConnectTimeout=10', '-p 2222'],
      sshTarget: 'me@host',
    });

    it('requests a PTY right after BatchMode, like buildRemoteAttachCommand', () => {
      // Interactive tmux needs a TTY; the position matches the existing remote
      // attach builder so the two connect on identical terms.
      expect(cmd.startsWith('ssh -o BatchMode=yes -t ')).toBe(true);
    });

    it('keeps every connection option it was handed', () => {
      expect(cmd).toContain('-p 2222');
      expect(cmd).toContain('me@host');
    });

    it('single-quotes the whole remote invocation', () => {
      expect(cmd).toMatch(/me@host '.*tmux -S .*'$/);
    });
  });
});
