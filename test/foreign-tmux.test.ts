/**
 * Foreign tmux adoption: the pure core.
 *
 * These pin the properties that were established by MEASUREMENT against a real
 * tmux (3.3a) while the feature was built, and that a plausible-looking refactor
 * would quietly undo. Each one has a comment naming what actually went wrong.
 */

import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
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
  buildForeignDockerViewKillCommand,
  buildForeignTmuxInvocation,
  foreignCliSignatures,
} from '../src/foreign-tmux.js';
import {
  candidatesFrom,
  foreignDockerProbeArgv,
  foreignRemoteProbeCommand,
  runForeignProbe,
} from '../src/foreign-tmux-discovery.js';
import { bashCArg, buildAdoptSessionCommand } from '../src/tmux-manager.js';
import type { RemoteHost, SessionAdopt } from '../src/types/session.js';
import { PROC_WALK_MAX_NODES } from '../src/proc-tree.js';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';
import {
  FOREIGN_MAX_ARGV_CHARS,
  FOREIGN_MAX_PANES,
  FOREIGN_MAX_PROCS,
  FOREIGN_PROBE_MAX_BYTES,
} from '../src/config/foreign-tmux.js';
import { hooksAvailableForMode, sessionHookOptions } from '../src/web/session-wait-registry.js';

// A probe transcript in exactly the shape a real run produces. The pane rows use
// the LITERAL backslash-t that tmux's `-F` emits (verified on next-3.7 and 3.3a),
// while the socket line is space-separated because `sh`'s builtin `echo` expands
// a backslash-t to a real TAB: two different meanings for one escape, two lines
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
  it('contains no single quote: it is wrapped in one to cross ssh and docker exec', () => {
    // The script is embedded as `ssh host '<script>'` and `docker exec c sh -lc
    // '<script>'`. One single quote inside ends the wrapper early and the rest is
    // re-tokenized by the remote shell.
    expect(buildForeignProbeScript()).not.toContain("'");
  });

  it('does not disable globbing: the socket sweep IS a glob', () => {
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

  it('asks tmux for UTF-8, so a POSIX locale cannot rewrite a name into underscores', () => {
    // Measured in a POSIX-locale container: without `-u` a session called `会话` was
    // listed as `____`, the guard then looked for `____`, and the tab opened dead.
    expect(buildForeignProbeScript()).toContain('tmux -u -S "$S" list-panes');
  });

  it('pings each server with stdout at /dev/null before it gets the real one', () => {
    // A client hands dups of its stdout to the server, so a stopped server holds our
    // pipe open after the client dies and no reader of that pipe can ever finish.
    const s = buildForeignProbeScript();
    expect(s).toContain('tmux -S "$S" has-session >/dev/null 2>&1 &');
    expect(s.indexOf('has-session')).toBeLessThan(s.indexOf('list-panes'));
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

  it('lists every socket it swept, however many there are', () => {
    // There used to be a cap here that only trimmed this list while the loop went on
    // to every socket anyway. A real cap in glob order would be worse: `codeman*`
    // sorts before `default`, so a box with many instances would never reach it.
    const lines = Array.from({ length: 40 }, (_, i) => `CMFS /tmp/tmux-0/s${i}`);
    expect(parseForeignProbeOutput(lines.join('\n')).sockets).toHaveLength(40);
  });

  it('records a server that did not answer', () => {
    const out = parseForeignProbeOutput(`CMFS /tmp/tmux-0/hung\nCMFH /tmp/tmux-0/hung\nCMFQ\n`);
    expect(out.hungSockets).toEqual(['/tmp/tmux-0/hung']);
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

  it('calls a plain shell a shell, the case this feature exists for', () => {
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
    // The attach line reaches `bash -c` single-quoted now (`bashCArg()`), but it used
    // to end at `bash -c ${JSON.stringify(cmd)}`, where the OUTER shell expanded
    // `$(...)` and backticks inside its double quotes before bash ever saw the inner
    // single quotes. Measured: a launchCmd of `: 'x$(touch A)`touch B`'` created BOTH
    // files. A foreign session name is chosen by someone else and more shells parse it
    // after that one, so it must never reach that string whatever the quoting of the day.
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

  it('refuses a name tmux reads as target syntax rather than as a name', () => {
    // `has-session -t '=<name>'` finds these by name, but `new-session -t <name>` does
    // not. Measured on tmux 3.4: `@1` and `%1` joined the session holding that window or
    // pane, so input typed in the tab reached someone else's pane, and `=eq`, `=`, `@zz`,
    // `%zz` and `~` made a new group with a fresh shell on the foreign server.
    for (const n of ['@1', '%1', '@zz', '%zz', '=eq', '=', '~']) expect(isAdoptableSessionName(n)).toBe(false);
  });

  it('keeps the names that only look like target syntax', () => {
    // Each of these joined its own windows on tmux 3.4. `! + - ^` are window tokens, and
    // a `-t` of the session type never reads them as such.
    for (const n of ['!', '+', '-', '^', '^x', '+x', '-dash', '!bang', '~foo', 'a~b', 'a@b', 'x=y', 'x%y', '40']) {
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

  it('checks the target exists BEFORE new-session, because new-session invents one', () => {
    // ⚠️ `new-session -t` does not fail on a missing target. Measured on tmux 3.3a
    // with only `work-prod` present: `new-session -t work` succeeded and joined our
    // view into `work-prod`'s group, someone else's session. On a socket with no
    // server it starts one. The wrapper pane re-runs this on every respawn, and boot
    // recovery respawns every dead pane, so without this guard the owner exiting
    // their session leaves Codeman creating shells on their machine.
    const cmd = buildForeignTmuxInvocation(target);
    const guard = cmd.indexOf('has-session');
    const create = cmd.indexOf('new-session');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(create);
    expect(cmd).toMatch(/has-session -t '=work'/);
    // Fails closed with a message rather than falling through to new-session.
    expect(cmd).toMatch(/has-session[^;]*\|\|\s*\{\s*echo[^;]*;\s*exit 1;\s*\}/);
  });

  it('uses the exact-match = only where a session is looked UP, never on new-session -t', () => {
    // Measured: tmux reads the `=` on `new-session -t` as part of the name and
    // creates a group literally called `=work`, so the guard has to be separate.
    // Without `=`, `has-session -t work` matches `work-prod` (verified on 3.3a).
    const cmd = buildForeignTmuxInvocation(target);
    expect(cmd).toContain("new-session -t 'work'");
    expect(cmd).not.toContain("new-session -t '=work'");
    // The two commands that LOOK a session up both take `=`.
    expect(cmd).toContain("has-session -t '=work'");
    expect(cmd).toContain("kill-session -t '=codeman-view-abc12345'");
  });

  it('keeps the guard on all three locations, not just the local one', () => {
    // The guard lives in the one shared invocation builder, so docker and remote
    // inherit it. A future split into per-location strings must keep that true:
    // the ssh and container paths are exactly where a stray session costs most.
    expect(buildForeignDockerAttachCommand({ ...target, dockerBase: 'docker', containerName: 'box' })).toContain(
      'has-session'
    );
    expect(
      buildForeignRemoteAttachCommand({
        ...target,
        sshArgs: ['ssh', '-o BatchMode=yes'],
        sshTarget: 'u@h',
      })
    ).toContain('has-session');
  });

  it('attaches as a UTF-8 client whatever the locale says', () => {
    // Measured in a POSIX-locale container: without `-u` the tab read `_ hello qqq ____`
    // for `❯ hello ─── 你好`, with `client_utf8=0`.
    expect(buildForeignTmuxInvocation(target)).toContain("exec tmux -u -S '/tmp/tmux-0/default' new-session -t");
  });

  it('says tmux is missing instead of calling a live session gone', () => {
    // `has-session ... 2>/dev/null ||` fires for any failure, exit 127 included, so an
    // ssh host where tmux is off the PATH used to print that the session was gone.
    const emptyBin = mkdtempSync(join(tmpdir(), 'foreign-no-tmux-'));
    try {
      const run = spawnSync('/bin/sh', ['-c', buildForeignTmuxInvocation(target)], {
        encoding: 'utf-8',
        env: { PATH: emptyBin },
      });
      expect(run.status).toBe(127);
      expect(run.stdout).toMatch(/tmux was not found/);
      expect(run.stdout).not.toMatch(/is gone/);
    } finally {
      rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  it('sets destroy-unattached so the view dies with our pane', () => {
    expect(buildForeignTmuxInvocation(target)).toContain('destroy-unattached on');
  });

  it('never sets window-size on the shared window', () => {
    // Measured: `window-size largest` is the only setting that protects an
    // actively-used session's size, but it is a WINDOW option on a SHARED window
    // and SURVIVES our detach: it would permanently rewrite the owner's config.
    expect(buildForeignTmuxInvocation(target)).not.toContain('window-size');
  });

  it('leaves NO degraded fallback: it either groups or fails with a message', () => {
    // A read-only `attach-session -r` used to hang off `||`, nominally for a tmux
    // too old to group. But `||` fires on ANY new-session failure, and the one that
    // happens is a leftover view with the same name: measured, new-session answers
    // `duplicate session: …` and the fallback then handed the user a read-only
    // client where typed input is dropped while the API reported success.
    const cmd = buildForeignTmuxInvocation(target);
    expect(cmd).not.toContain('attach-session');
    expect(cmd).not.toMatch(/new-session[^;]*\|\|/);
  });

  it('clears OUR OWN stale view before creating it, and only ours', () => {
    // The view name is derived from Codeman's own session id, so a session with
    // that name can only ever be ours. `=` keeps the match exact, and killing a
    // session in a group removes only that session (measured: the owner's `work`
    // survived its grouped view being killed).
    const cmd = buildForeignTmuxInvocation(target);
    expect(cmd).toContain("kill-session -t '=codeman-view-abc12345'");
    expect(cmd).not.toContain("kill-session -t '=work'");
    const kill = cmd.indexOf('kill-session');
    expect(kill).toBeGreaterThan(cmd.indexOf('has-session'));
    expect(kill).toBeLessThan(cmd.indexOf('new-session'));
    // A missing stale view is the normal case, never a reason to abort.
    expect(cmd).toMatch(/kill-session[^;]*2>\/dev\/null \|\| true/);
  });

  it('stays on ONE line', () => {
    expect(buildForeignAttachCommand(target)).not.toContain('\n');
  });

  it('uses no command substitution, the rule of every launch chain here', () => {
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
    // The metacharacters survive only INSIDE quotes, never as shell syntax. Checked
    // by stripping every single-quoted span and looking at what is left, rather than
    // by what character precedes the name: the "session is gone" message quotes the
    // name too, with a space in front of it, and a lookbehind assertion reads that
    // as an escape when it is not one.
    const outsideQuotes = nasty
      .split("'")
      .filter((_, i) => i % 2 === 0)
      .join(' ');
    expect(outsideQuotes).not.toContain('ev;il');
    expect(outsideQuotes).not.toContain('`');
  });

  describe('docker', () => {
    const cmd = buildForeignDockerAttachCommand({
      ...target,
      dockerBase: 'docker --context ci',
      containerName: 'my-box',
    });

    it('looks, then execs: never create, never start', () => {
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

    it('gives the client the same terminal an owned container gets', () => {
      // `docker exec -it` defaults to TERM=xterm, which held the tab to 8 colours.
      expect(cmd).toContain("exec -it -e TERM=xterm-256color -e COLORTERM=truecolor 'my-box' sh -lc");
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

describe('the docker and ssh transports', () => {
  const host: RemoteHost = {
    id: 'h1',
    label: 'Build box',
    host: 'build.example',
    username: 'me',
  } as RemoteHost;
  const dockerTarget = {
    hostId: 'd1',
    label: 'ci',
    containerName: 'box',
    base: { engine: 'docker' as const, context: 'my ctx', daemonHost: 'tcp://10.0.0.1:2375' },
  };

  it('hands execFile a docker argv with no shell quoting in it', () => {
    // `docker --context "'my ctx'"` is what the shell-quoted builder gave execFile:
    // "context not found", so every container behind a context read as unreachable.
    const argv = foreignDockerProbeArgv(dockerTarget);
    expect(argv.slice(0, 5)).toEqual(['docker', '--context', 'my ctx', '-H', 'tcp://10.0.0.1:2375']);
    expect(argv.slice(5, 9)).toEqual(['exec', 'box', 'sh', '-lc']);
    for (const token of argv) expect(token).not.toContain("'");
  });

  it('runs the ssh probe in sh with the remote tmux PATH, so a timeout reaches ssh', () => {
    const cmd = foreignRemoteProbeCommand(host);
    expect(cmd.startsWith('exec ssh ')).toBe(true);
    expect(cmd).toContain('me@build.example');
    expect(cmd).toContain('/opt/homebrew/bin');
    expect(cmd).toContain('exec sh -c');
    expect(cmd).toContain('list-panes');
  });

  it('puts the same PATH and sh on the ssh attach', () => {
    const cmd = buildForeignRemoteAttachCommand({
      socketPath: '/tmp/tmux-1000/default',
      targetSession: 'work',
      viewSession: 'codeman-view-abc12345',
      sshArgs: ['ssh', '-o BatchMode=yes'],
      sshTarget: 'me@host',
    });
    expect(cmd).toContain('/opt/homebrew/bin');
    expect(cmd).toContain('exec sh -c');
  });

  it('kills the in-container view by exact name', () => {
    // Without `=` tmux prefix-matches, and the view is grouped with the owner's work.
    expect(
      buildForeignDockerViewKillCommand({
        dockerBase: 'docker',
        containerName: 'box',
        socketPath: '/tmp/tmux-0/default',
        viewSession: 'codeman-view-abc12345',
      })
    ).toContain("kill-session -t '=codeman-view-abc12345'");
  });

  describe('buildAdoptSessionCommand', () => {
    const adopt: SessionAdopt = {
      location: 'local',
      socketPath: '/tmp/tmux-1000/default',
      targetSession: 'work',
      viewSession: '',
    };

    it('attaches in place for a local target, and names the view after our session', () => {
      const cmd = buildAdoptSessionCommand(adopt, 'abc12345-rest');
      expect(cmd).toContain("has-session -t '=work'");
      expect(cmd).toContain("-s 'codeman-view-abc12345'");
      expect(cmd).not.toMatch(/\b(ssh|docker)\b/);
    });

    it('goes through the saved engine for a container, shell-quoted for the launch string', () => {
      const cmd = buildAdoptSessionCommand(
        {
          ...adopt,
          location: 'docker',
          docker: { hostId: 'd1', label: 'ci', engine: 'podman', containerName: 'box', context: 'my ctx' },
        },
        'abc12345'
      );
      expect(cmd).toContain("podman --context 'my ctx' exec -it ");
      expect(cmd).toContain("'box' sh -lc");
    });

    it('goes through the saved connection for an ssh host', () => {
      const cmd = buildAdoptSessionCommand(
        {
          ...adopt,
          location: 'remote',
          remote: { hostId: 'h1', label: 'b', host: 'h.example', username: 'me', port: 2222 },
        },
        'abc12345'
      );
      expect(cmd.startsWith('ssh -o BatchMode=yes -t ')).toBe(true);
      expect(cmd).toContain('me@h.example');
      expect(cmd).toContain('2222');
    });
  });

  describe('the ssh attach survives every shell on its way', () => {
    // bash -c '<line>' at respawn-pane, the single quotes around the remote command,
    // the remote login shell, then sh -c. Stand-ins for ssh and tmux at the two ends
    // show what a real tmux would receive, which no substring check can.
    let home: string;
    let bin: string;

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'foreign-ssh-'));
      // $HOME/bin, because the remote PATH line puts it ahead of a real tmux.
      bin = join(home, 'bin');
      mkdirSync(bin);
      // The real thing hands its LAST argument to the remote login shell.
      writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n', { mode: 0o755 });
      writeFileSync(join(bin, 'tmux'), '#!/bin/sh\nfor a; do printf "<%s>" "$a"; done\nprintf "\\n"\n', {
        mode: 0o755,
      });
    });

    afterEach(() => {
      rmSync(home, { recursive: true, force: true });
    });

    it('delivers a spaced name as one argument to each tmux command', () => {
      const launch = buildForeignRemoteAttachCommand({
        socketPath: '/tmp/tmux-1000/my sock',
        targetSession: 'my work',
        viewSession: 'codeman-view-abc12345',
        sshArgs: ['ssh', '-o BatchMode=yes'],
        sshTarget: 'me@host',
      });
      const out = execSync(`bash -c ${bashCArg(launch, true)}`, {
        encoding: 'utf-8',
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
      });
      expect(out).toContain('<-S></tmp/tmux-1000/my sock><has-session><-t><=my work>');
      expect(out).toContain('<new-session><-t><my work><-s><codeman-view-abc12345><;><set-option>');
    });

    it('leaves the PATH line for the far end to expand', () => {
      // In double quotes on execSync's `sh -c`, single quotes protect nothing, so `$HOME`
      // and `$PATH` used to become THIS host's values and a tmux in the remote
      // `~/.local/bin` was found by discovery and missed here.
      writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nfor last; do :; done\nprintf "%s\\n" "$last"\n', { mode: 0o755 });
      const launch = buildForeignRemoteAttachCommand({
        socketPath: '/tmp/tmux-1000/default',
        targetSession: 'work',
        viewSession: 'codeman-view-abc12345',
        sshArgs: ['ssh', '-o BatchMode=yes'],
        sshTarget: 'me@host',
      });
      const out = execSync(`bash -c ${bashCArg(launch, true)}`, {
        encoding: 'utf-8',
        env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
      });
      expect(out).toContain('$HOME/.local/bin');
      expect(out).toContain(':$PATH"');
      expect(out).not.toContain(home);
    });
  });

  describe('the attach line as the argument of bash -c', () => {
    const echoed = (text: string) => execSync(`printf '%s' ${bashCArg(text, true)}`, { encoding: 'utf-8' });

    it('hands the text through one sh parse untouched', () => {
      const text = 'echo $HOME `id` "q" \\ and \\$x';
      expect(echoed(text)).toBe(text);
    });

    it('keeps a single quote and a real newline', () => {
      // Double quotes with JSON escaping left a newline as the two characters `\n`.
      const text = "it's\n'\\''$PATH";
      expect(echoed(text)).toBe(text);
    });

    it('is what both launch sites use', () => {
      // Create and respawn build the same string. Fixing only one would leave a wrapper
      // whose first attach works and whose re-attach after a restart does not. What each
      // one hands bash is measured in tmux-manager.test.ts.
      const src = readFileSync(join(import.meta.dirname, '../src/tmux-manager.ts'), 'utf-8');
      expect(src.match(/bashCArg\(launchCmd, !!\(remote \|\| docker \|\| adopt\)\)/g)).toHaveLength(2);
      expect(src.match(/bash -c \$\{JSON\.stringify\(launchCmd\)\}/g)).toBeNull();
    });
  });
});

describe('a tmux server that stops answering', () => {
  // A real server SIGSTOPped on a scratch socket cost 12 s, every row on the machine and
  // a stuck client per scan. The stand-in tmux below hangs the same way for one socket.
  // /tmp rather than tmpdir(): a unix socket path has to fit in about 100 bytes.
  let root: string;
  let bin: string;
  let servers: Server[];

  const listen = (path: string) =>
    new Promise<Server>((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(path, () => resolve(server));
    });

  beforeEach(async () => {
    root = mkdtempSync('/tmp/cmfp-');
    bin = join(root, 'bin');
    const sockets = join(root, `tmux-${process.getuid?.() ?? 0}`);
    mkdirSync(bin);
    mkdirSync(sockets);
    servers = await Promise.all(['a', 'hung', 'z'].map((name) => listen(join(sockets, name))));
    writeFileSync(
      join(bin, 'tmux'),
      [
        '#!/bin/sh',
        `echo "$*" >> ${root}/calls`,
        'case "$*" in *"/hung "*) exec sleep 30 ;; esac',
        'case "$*" in *has-session*) exit 0 ;; esac',
        'for a; do case "$a" in */tmux-*) S=$a ;; esac; done',
        `printf 'CMFP\\t%s\\t7\\t0\\t1\\t100\\t0\\t%%%%0\\tbash\\twork\\t/srv\\n' "$S"`,
      ].join('\n'),
      { mode: 0o755 }
    );
  });

  afterEach(async () => {
    await Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve))));
    rmSync(root, { recursive: true, force: true });
  });

  const probe = (script: string) =>
    runForeignProbe(['env', `TMUX_TMPDIR=${root}`, `PATH=${bin}:${process.env.PATH}`, 'sh', '-c', script]);

  it('costs only its own rows, and the scan still finishes', async () => {
    const startedAt = Date.now();
    const run = await probe(buildForeignProbeScript());
    expect(Date.now() - startedAt).toBeLessThan(6000);
    expect(run.ok).toBe(true);
    const out = parseForeignProbeOutput(run.stdout);
    expect(out.panes.map((p) => p.socketPath.split('/').pop())).toEqual(['a', 'z']);
    expect(out.hungSockets.map((s) => s.split('/').pop())).toEqual(['hung']);
    // The script ran on past the hung socket to the marker that ends the sweep.
    expect(run.stdout).toContain('CMFQ');
    // ⚠️ The point of the ping: a server that missed it never receives our stdout.
    const calls = readFileSync(join(root, 'calls'), 'utf-8');
    expect(calls).toMatch(/\/hung has-session/);
    expect(calls).not.toMatch(/\/hung list-panes/);
  });

  it('never lists, let alone starts, a server on a stale socket', async () => {
    writeFileSync(
      join(bin, 'tmux'),
      `#!/bin/sh\necho "$*" >> ${root}/calls\ncase "$*" in *has-session*) exit 1 ;; esac\n`,
      { mode: 0o755 }
    );
    await probe(buildForeignProbeScript());
    const calls = readFileSync(join(root, 'calls'), 'utf-8');
    expect(calls).toMatch(/has-session/);
    expect(calls).not.toMatch(/list-panes|new-session|start-server/);
  });

  it('says so in a note, and keeps the rows it did read', () => {
    const stdout = [
      'CMFS /tmp/tmux-0/default',
      'CMFP\\t/tmp/tmux-0/default\\t900\\t0\\t1\\t1788092500\\t0\\t%1\\tbash\\tscratch\\t/home/me',
      'CMFH /tmp/tmux-0/stopped',
      'CMFH /tmp/tmux-0/codeman-other',
      'CMFQ',
    ].join('\n');
    const notes: string[] = [];
    const rows = candidatesFrom(stdout, 'local', 'local', {}, 'local', notes);
    expect(rows.map((r) => r.sessionName)).toEqual(['scratch']);
    // Another Codeman's socket is not a session this list would ever show.
    expect(notes).toEqual(['local: 1 tmux server(s) did not answer, sessions on them are not listed']);
    // The adopt route reads a note with `skipped` in it as a refusal rather than as a
    // location it could not reach, and this one is the second kind.
    expect(notes[0]).not.toMatch(/skipped/);
  });
});

describe.skipIf(spawnSync('tmux', ['-V']).status !== 0)('a real stopped tmux server', () => {
  it('costs a scan the ping and nothing more, though it holds stdout past its client', async () => {
    // The stand-in above cannot show this. Only a real server takes a dup of the client's
    // stdout, and that is what kept a scan waiting after the client was dead.
    const root = mkdtempSync('/tmp/cmfr-');
    const sockets = join(root, `tmux-${process.getuid?.() ?? 0}`);
    mkdirSync(sockets);
    const stopped = join(sockets, 'stopped');
    const env = { ...process.env, TMUX: '' };
    const tmux = (...args: string[]) => spawnSync('tmux', ['-S', stopped, ...args], { encoding: 'utf-8', env });
    let serverPid = 0;
    try {
      expect(tmux('-f', '/dev/null', 'new-session', '-d', '-s', 'held', 'sleep 60').status).toBe(0);
      serverPid = Number(tmux('display-message', '-p', '#{pid}').stdout);
      expect(serverPid).toBeGreaterThan(0);
      process.kill(serverPid, 'SIGSTOP');

      const startedAt = Date.now();
      const run = await runForeignProbe(['env', `TMUX_TMPDIR=${root}`, 'sh', '-c', buildForeignProbeScript()]);

      expect(Date.now() - startedAt).toBeLessThan(6000);
      expect(run.ok).toBe(true);
      const out = parseForeignProbeOutput(run.stdout);
      expect(out.hungSockets).toEqual([stopped]);
      expect(out.panes).toEqual([]);
    } finally {
      if (serverPid > 0) process.kill(serverPid, 'SIGCONT');
      tmux('kill-server');
      rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
});

describe('runForeignProbe', () => {
  const alive = (pid: number) =>
    spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf-8' }).stdout.trim();

  it('reaches the whole process group at the deadline and keeps what was read', async () => {
    // A timeout that signals only `sh` left its tmux child stuck on the hung server, one
    // more per scan, for as long as the home screen stayed open.
    const run = await runForeignProbe(['sh', '-c', 'echo first; sleep 60 & echo $!; wait'], { timeoutMs: 400 });
    expect(run.ok).toBe(false);
    const [first, pid] = run.stdout.trim().split('\n');
    expect(first).toBe('first');
    await vi.waitFor(() => expect(alive(Number(pid))).toMatch(/^(Z.*)?$/), { timeout: 2000 });
  });

  it('answers at the deadline even when something outside the group holds the pipe', async () => {
    // What a stopped tmux server does. `setsid` is the stand-in for it: out of the group,
    // so the kill misses it, and it keeps the write end of stdout open.
    if (spawnSync('sh', ['-c', 'command -v setsid']).status !== 0) return;
    const startedAt = Date.now();
    const run = await runForeignProbe(['sh', '-c', 'echo first; setsid sleep 3 & exit 0'], { timeoutMs: 300 });
    expect(Date.now() - startedAt).toBeLessThan(2000);
    expect(run).toEqual({ stdout: 'first\n', ok: false });
  });

  it('stops a probe that floods instead of holding it in memory', async () => {
    const run = await runForeignProbe(['sh', '-c', 'while :; do echo aaaaaaaa; done'], {
      maxBytes: 4096,
      timeoutMs: 5000,
    });
    expect(run.ok).toBe(false);
    expect(run.stdout.length).toBeLessThanOrEqual(4096);
  });

  it('keeps the output of a command that failed', async () => {
    expect(await runForeignProbe(['sh', '-c', 'echo partial; exit 3'])).toEqual({ stdout: 'partial\n', ok: false });
  });

  it('answers rather than throws when the command cannot start', async () => {
    expect(await runForeignProbe(['/nonexistent/probe'])).toEqual({ stdout: '', ok: false });
  });
});

describe('foreignCliSignatures', () => {
  it('covers every stock CLI that declares a binary, including the one the hand-written table missed', () => {
    // The table this replaced listed eight CLI ids by hand and had already gone
    // stale: `omp` shipped without a signature, so a hand-started omp pane was
    // classified `shell`. Deriving from `discovery.binaries` makes that class of
    // drift impossible rather than merely fixed once.
    const covered = new Set(foreignCliSignatures().map((sig) => sig.mode));
    const expected = STOCK_CLIS.filter((e) => e.discovery.binaries.length > 0).map((e) => e.id as string);
    expect(expected).toContain('omp');
    for (const id of expected) expect(covered).toContain(id);
  });

  it('leaves shell out: it declares no binary and is the FALLBACK answer', () => {
    expect(foreignCliSignatures().some((sig) => sig.mode === 'shell')).toBe(false);
  });

  it('orders longest binary name first, so a two-letter name cannot win early', () => {
    // `pi` matches `(^|/)pi(\s|$)`, which is the loosest rule in the table. If it
    // were tried before `opencode`'s, nothing would break on these two names, but
    // the ordering is the only thing standing between a future one-letter binary
    // and every pane on the machine.
    const names = foreignCliSignatures().map((sig) => sig.mode);
    expect(names.indexOf('pi')).toBeGreaterThan(names.indexOf('opencode'));
  });

  it('classifies an omp pane as omp rather than shell', () => {
    const empty = { byParent: new Map(), argvByPid: new Map() };
    expect(classifyForeignPaneMode({ panePid: 1, paneCurrentCommand: 'omp' }, empty).mode).toBe('omp');
  });

  it('still finds claude under its own dot-directory node launcher', () => {
    // The derived "node launcher" shape has to reproduce what claude's hand-written
    // `[/\\]\.?claude[/\\][^\s]*cli\.js` rule covered, or every claude installed
    // the normal way (a `node ~/.claude/local/.../cli.js` argv) silently reads as shell.
    const argv = 'node /home/u/.claude/local/node_modules/@anthropic-ai/claude-code/cli.js';
    const probe = { byParent: new Map([[7, [8]]]), argvByPid: new Map([[8, argv]]) };
    expect(classifyForeignPaneMode({ panePid: 7, paneCurrentCommand: 'node' }, probe).mode).toBe('claude');
  });

  it('does not let a binary name match inside a longer command', () => {
    const empty = { byParent: new Map(), argvByPid: new Map() };
    expect(classifyForeignPaneMode({ panePid: 1, paneCurrentCommand: '/usr/bin/pip install x' }, empty).mode).toBe(
      'shell'
    );
  });
});

describe('classifyForeignPaneMode truncation reporting', () => {
  it('reports a truncated descendant walk instead of silently answering shell', () => {
    // A capped walk returns "nothing matched", which is byte-identical to the
    // answer for a real shell. Without the warning there is nothing anywhere to
    // tell a wide process tree apart from a plain bash pane.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const byParent = new Map<number, number[]>();
      byParent.set(
        1,
        Array.from({ length: PROC_WALK_MAX_NODES + 10 }, (_, i) => i + 100)
      );
      const result = classifyForeignPaneMode(
        { panePid: 1, paneCurrentCommand: 'bash' },
        { byParent, argvByPid: new Map() }
      );
      expect(result.mode).toBe('shell');
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0]?.[0])).toMatch(/nodes cap|-nodes/);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('hooksAvailableForMode for an adopted session', () => {
  it('refuses claude when the process was adopted', () => {
    // Adoption asks who STARTED the process. Codeman never installed its hooks
    // block in that workspace, so answering by mode would dress an infinite wait
    // up as a timeout.
    expect(hooksAvailableForMode('claude')).toBe(true);
    expect(hooksAvailableForMode('claude', { adopted: true })).toBe(false);
  });

  it('derives `adopted` from the session, so every call site inherits it', () => {
    expect(sessionHookOptions({ adopt: { targetSession: 'work' } }).adopted).toBe(true);
    expect(sessionHookOptions({}).adopted).toBe(false);
  });
});

/**
 * Parsing and classifying runs synchronously on the server's event loop, over text that
 * a process in someone's pane, a container or an ssh host wrote. Each budget below is
 * 100 times what the fixed code needs and a small fraction of what the unfixed code took.
 */
describe('a probe someone else wrote cannot stall the server', () => {
  const SEC = 1000;
  const elapsed = (work: () => void) => {
    const startedAt = performance.now();
    work();
    return performance.now() - startedAt;
  };

  it('keeps a bounded piece of an endless argv and of an endless pane command', () => {
    const long = 'x'.repeat(FOREIGN_MAX_ARGV_CHARS * 4);
    const pane = `CMFP\\t/tmp/tmux-0/s\\t7\\t0\\t1\\t0\\t0\\t%0\\t${long}\\twork\\t/srv`;
    const out = parseForeignProbeOutput(`${pane}\nCMFQ\n 7 1 ${long}\n`);
    expect(out.argvByPid.get(7)).toHaveLength(FOREIGN_MAX_ARGV_CHARS);
    expect(out.panes[0]?.paneCurrentCommand).toHaveLength(FOREIGN_MAX_ARGV_CHARS);
  });

  it('classifies an argv of repeated `/pi/` tokens in linear time', () => {
    // Unfixed, the `cli.js` tail was retried from every token: 4.6 s for this input.
    const argv = '/pi/'.repeat(32 * 1024);
    const probe = { byParent: new Map(), argvByPid: new Map([[7, argv]]) };
    expect(elapsed(() => classifyForeignPaneMode({ panePid: 7, paneCurrentCommand: 'x' }, probe))).toBeLessThan(SEC);
  });

  it('still needs the `cli.js` to come after the CLI directory, inside one word', () => {
    const empty = new Map<number, number[]>();
    const classify = (argv: string) =>
      classifyForeignPaneMode(
        { panePid: 7, paneCurrentCommand: 'node' },
        { byParent: empty, argvByPid: new Map([[7, argv]]) }
      ).mode;
    expect(classify('node /opt/.pi/lib/cli.js')).toBe('pi');
    expect(classify('node /opt/pi/cli.js --flag')).toBe('pi');
    expect(classify('node /opt/.pi/lib/cli.json')).toBe('pi');
    expect(classify('node cli.js/.pi/lib')).toBe('shell');
    expect(classify('node /opt/.pi/lib tool/cli.js')).toBe('shell');
  });

  it('dedupes socket rows in linear time', () => {
    // Unfixed: 7 s for this many, and 65 s for the 2 MiB a probe may carry.
    const lines = Array.from({ length: 20_000 }, (_, i) => `CMFS /tmp/tmux-0/s${i}`);
    let sockets: string[] = [];
    expect(elapsed(() => (sockets = parseForeignProbeOutput(lines.join('\n')).sockets))).toBeLessThan(SEC);
    expect(sockets).toHaveLength(20_000);
    expect(parseForeignProbeOutput('CMFS /a\nCMFS /a\n').sockets).toEqual(['/a']);
  });

  it('parses a process row whose argv holds a line terminator in linear time', () => {
    // `.` stops at a bare CR, so `$` used to fail and `\s+` gave its spaces back one at a
    // time: 4 s for this row, and about an hour for a row at the 2 MiB cap. `ps` escapes
    // control characters here, a hostile container or ssh host has no such manners.
    let out = parseForeignProbeOutput('');
    const row = `CMFQ\n 7 1 ${' '.repeat(64 * 1024)}x\ry\n`;
    expect(elapsed(() => (out = parseForeignProbeOutput(row)))).toBeLessThan(SEC);
    expect(out.argvByPid.has(7)).toBe(true);
  });

  it('survives the worst scan the caps allow', () => {
    // Every pane may claim one process tree, so a walk per pane repeats the same rows:
    // FOREIGN_MAX_PANES walks over the longest argv rows the byte cap leaves room for,
    // none of them matching, so no walk ends early. Only a hostile host can say that.
    const panes = Array.from(
      { length: FOREIGN_MAX_PANES },
      (_, i) => `CMFP\\t/tmp/tmux-0/s\\t7\\t0\\t1\\t0\\t0\\t%${i}\\tnode\\tw${i}\\t/srv`
    );
    const argv = `cli.js${'/pi/'.repeat(Math.floor((FOREIGN_MAX_ARGV_CHARS - 16) / 4))}`;
    const rows: string[] = [];
    let bytes = panes.join('\n').length;
    for (let pid = 1000; rows.length < FOREIGN_MAX_PROCS; pid += 1) {
      const row = `${pid} 7 ${argv}${pid}`;
      if (bytes + row.length + 1 > FOREIGN_PROBE_MAX_BYTES) break;
      bytes += row.length + 1;
      rows.push(row);
    }
    const stdout = `${panes.join('\n')}\nCMFQ\n${rows.join('\n')}\n`;
    let found: { mode: string }[] = [];
    const took = elapsed(() => (found = candidatesFrom(stdout, 'remote', 'h', {}, 'remote h', [])));
    expect(found).toHaveLength(FOREIGN_MAX_PANES);
    expect(found.every((session) => session.mode === 'shell')).toBe(true);
    expect(took).toBeLessThan(SEC);
  });
});
