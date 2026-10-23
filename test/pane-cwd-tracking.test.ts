/**
 * @fileoverview A relative path printed in the terminal resolves against the
 * directory the pane is actually in, not only the session's `workingDir`.
 *
 * `workingDir` is recorded once at create time and never follows a `cd`, so in
 * a shell session that moved to a subdirectory or a sibling repo every relative
 * path resolved against the wrong root, and the preview reported "File not
 * found" for a file sitting right there.
 *
 * Pinned here:
 *  1. Parsing: the pane-exit watcher's batched `list-panes -a` read already
 *     carries `#{pane_current_path}`; `derivePaneCurrentPaths()` turns it into
 *     one directory per session (single-pane sessions only, absolute paths
 *     only).
 *  2. The manager keeps the last authoritative answer, so a failed read never
 *     blanks a known directory.
 *  3. Scoping: remote and Docker sessions never carry one (their local pane
 *     runs the ssh / docker-exec CLIENT), and neither does a direct-PTY or a
 *     rediscovered session.
 *  4. Wiring: the reading reaches `toState()` through the existing
 *     `paneExitsUpdated` event, with no new tmux call and no new SSE event.
 *  5. Resolution order in the browser: live cwd, then `workingDir`. The
 *     resolved path still goes through the same preview routing, so a target
 *     outside the workspace takes the attachment route like any other.
 *
 * Port: ephemeral
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import { WebServer } from '../src/web/server.js';
import type { SessionDocker, SessionRemote } from '../src/types.js';
import type { MuxSession, TerminalMultiplexer } from '../src/mux-interface.js';
import { TmuxManager, derivePaneCurrentPaths, parsePaneRows, type PaneRow } from '../src/tmux-manager.js';

const remote: SessionRemote = { hostId: 'h1', label: 'box', host: 'box', user: 'dev' } as SessionRemote;
const docker: SessionDocker = { hostId: 'd1', label: 'ctr', containerName: 'ctr' } as SessionDocker;

describe('derivePaneCurrentPaths', () => {
  it("maps each single-pane session to its pane's directory", () => {
    const rows = parsePaneRows(['codeman-a|100|0|||/work/proj/sub', 'codeman-b|200|0|||/srv/app'].join('\n'));
    const paths = derivePaneCurrentPaths(rows);
    expect(paths.get('codeman-a')).toBe('/work/proj/sub');
    expect(paths.get('codeman-b')).toBe('/srv/app');
    expect(paths.size).toBe(2);
  });

  it('keeps a separator that belongs to the directory name', () => {
    const paths = derivePaneCurrentPaths(parsePaneRows('codeman-a|100|0|||/home/u/weird|dir/sub'));
    expect(paths.get('codeman-a')).toBe('/home/u/weird|dir/sub');
  });

  it('answers nothing for a session split into several panes', () => {
    // Codeman creates one pane per session; which of a hand-split session's
    // panes "the" directory belongs to is a guess, so none is made.
    const rows = parsePaneRows(['codeman-a|100|0|||/one', 'codeman-a|101|0|||/two'].join('\n'));
    expect(derivePaneCurrentPaths(rows).has('codeman-a')).toBe(false);
  });

  it('drops a missing or relative directory', () => {
    const rows = parsePaneRows(['codeman-a|100|0|||', 'codeman-b|200|0|||rel/ative'].join('\n'));
    expect(derivePaneCurrentPaths(rows).size).toBe(0);
  });
});

describe('TmuxManager pane directory bookkeeping', () => {
  class TestManager extends TmuxManager {
    rows: PaneRow[] = [];
    protected override async readPaneRows(): Promise<PaneRow[]> {
      return this.rows;
    }
  }

  const localSession = (sessionId: string): MuxSession =>
    ({
      sessionId,
      muxName: `codeman-${sessionId}`,
      pid: 100,
      createdAt: 0,
      workingDir: '/work/proj',
      mode: 'shell',
      attached: true,
    }) as MuxSession;

  it('records the directory from the same read the pane-exit watcher makes', async () => {
    const manager = new TestManager();
    manager.registerSession(localSession('s1'));
    manager.rows = parsePaneRows('codeman-s1|100|0|||/work/proj/sub');
    await manager.refreshPaneExits();
    expect(manager.getPaneCurrentPath('codeman-s1')).toBe('/work/proj/sub');
  });

  it('keeps the last known directory when a read comes back empty', async () => {
    const manager = new TestManager();
    manager.registerSession(localSession('s1'));
    manager.rows = parsePaneRows('codeman-s1|100|0|||/work/proj/sub');
    await manager.refreshPaneExits();
    manager.rows = [];
    await manager.refreshPaneExits();
    expect(manager.getPaneCurrentPath('codeman-s1')).toBe('/work/proj/sub');
  });

  it('records the directory even when a respawn races the read', async () => {
    // A respawn bumps the generation and discards the read's EXIT observation;
    // the directory the pane was in at read time is still the best answer.
    class RacingManager extends TestManager {
      protected override async readPaneRows(): Promise<PaneRow[]> {
        this.clearPaneExit('codeman-s1');
        return this.rows;
      }
    }
    const manager = new RacingManager();
    manager.registerSession(localSession('s1'));
    manager.rows = parsePaneRows('codeman-s1|100|1|0||/work/proj/sub');
    await manager.refreshPaneExits();
    expect(manager.getPaneCurrentPath('codeman-s1')).toBe('/work/proj/sub');
    expect(manager.getPaneExit('codeman-s1')).toBeUndefined();
  });

  it('makes no read, and keeps no directory, when only remote or docker sessions exist', async () => {
    const manager = new TestManager();
    const read = vi.spyOn(manager as unknown as { readPaneRows: () => Promise<PaneRow[]> }, 'readPaneRows');
    manager.registerSession({ ...localSession('s1'), remote } as MuxSession);
    manager.registerSession({ ...localSession('s2'), docker } as MuxSession);
    manager.rows = parsePaneRows('codeman-s1|100|0|||/tmp');
    await manager.refreshPaneExits();
    expect(read).not.toHaveBeenCalled();
    expect(manager.getPaneCurrentPath('codeman-s1')).toBeUndefined();
  });

  it('forgets a session that an authoritative read no longer lists', async () => {
    const manager = new TestManager();
    manager.registerSession(localSession('s1'));
    manager.rows = parsePaneRows('codeman-s1|100|0|||/work/proj/sub');
    await manager.refreshPaneExits();
    manager.rows = parsePaneRows('codeman-other|300|0|||/elsewhere');
    await manager.refreshPaneExits();
    expect(manager.getPaneCurrentPath('codeman-s1')).toBeUndefined();
  });
});

const stubMux = () => ({ isAvailable: () => true }) as unknown as TerminalMultiplexer;
const stubMuxSession = (muxName = 'codeman-aaaa') => ({ muxName, sessionId: 'aaaa' }) as unknown as MuxSession;

function localMuxSession(extra: Record<string, unknown> = {}) {
  return new Session({
    workingDir: '/work/proj',
    mode: 'shell',
    useMux: true,
    mux: stubMux(),
    muxSession: stubMuxSession(),
    ...extra,
  });
}

describe('Session.setCwd scoping', () => {
  it('records an absolute directory for a local pane and reports the change once', () => {
    const session = localMuxSession();
    expect(session.setCwd('/work/proj/sub')).toBe(true);
    expect(session.cwd).toBe('/work/proj/sub');
    expect(session.setCwd('/work/proj/sub')).toBe(false);
    expect(session.toState().cwd).toBe('/work/proj/sub');
  });

  it('clears the directory when the reading goes away', () => {
    const session = localMuxSession();
    session.setCwd('/work/proj/sub');
    expect(session.setCwd(undefined)).toBe(true);
    expect(session.cwd).toBeUndefined();
  });

  it('refuses a relative directory', () => {
    const session = localMuxSession();
    expect(session.setCwd('rel/ative')).toBe(false);
    expect(session.cwd).toBeUndefined();
  });

  it('refuses a directory for a remote session, whose local pane runs the ssh client', () => {
    const session = localMuxSession({ remote });
    expect(session.setCwd('/home/dev')).toBe(false);
    expect(session.toState().cwd).toBeUndefined();
  });

  it('refuses a directory for a docker case, whose local pane runs docker exec', () => {
    const session = localMuxSession({ docker });
    expect(session.setCwd('/work/proj')).toBe(false);
    expect(session.toState().cwd).toBeUndefined();
  });

  it('refuses a directory for a direct-PTY session and a rediscovered one', () => {
    const direct = new Session({ workingDir: '/work/proj', mode: 'shell', useMux: false });
    expect(direct.setCwd('/work/proj/sub')).toBe(false);
    const discovered = localMuxSession({ discoveredMuxSession: true });
    expect(discovered.setCwd('/work/proj/sub')).toBe(false);
  });
});

describe('a pane read reaching the session record', () => {
  let server: WebServer | null = null;

  afterEach(async () => {
    await server?.stop?.();
    server = null;
  });

  const build = () => {
    const web = new WebServer(0, false, true);
    server = web;
    const mux = (web as unknown as { mux: Record<string, unknown> & { emit: (e: string) => void } }).mux;
    const sessions = (web as unknown as { sessions: Map<string, Session> }).sessions;
    return { mux, sessions };
  };

  it("publishes the pane's directory on the existing paneExitsUpdated tick", () => {
    const { mux, sessions } = build();
    const session = localMuxSession();
    sessions.set(session.id, session);
    mux.getPaneExit = () => undefined;
    mux.getPaneCurrentPath = (muxName: string) => (muxName === 'codeman-aaaa' ? '/work/proj/sub' : undefined);
    mux.emit('paneExitsUpdated');

    expect(session.toState().cwd).toBe('/work/proj/sub');
    // A resolution base only: the confinement root is untouched.
    expect(session.toState().workingDir).toBe('/work/proj');
  });

  it('broadcasts a directory change once, and nothing on an unchanged tick', () => {
    const { mux, sessions } = build();
    const session = localMuxSession();
    sessions.set(session.id, session);
    const broadcast = vi.fn();
    (server as unknown as { broadcastSessionStateDebounced: (id: string) => void }).broadcastSessionStateDebounced =
      broadcast;
    const persist = vi.fn();
    (server as unknown as { persistSessionState: (s: Session) => void }).persistSessionState = persist;
    let dir = '/work/proj/sub';
    mux.getPaneExit = () => undefined;
    mux.getPaneCurrentPath = () => dir;

    mux.emit('paneExitsUpdated');
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledWith(session.id);
    mux.emit('paneExitsUpdated');
    expect(broadcast).toHaveBeenCalledTimes(1);
    dir = '/work/proj/other';
    mux.emit('paneExitsUpdated');
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(session.toState().cwd).toBe('/work/proj/other');
    // Runtime-only: a directory change alone is never written to state.json.
    expect(persist).not.toHaveBeenCalled();
  });

  it('keeps the last directory when the read has no answer for the session', () => {
    const { mux, sessions } = build();
    const session = localMuxSession();
    sessions.set(session.id, session);
    mux.getPaneExit = () => undefined;
    let dir: string | undefined = '/work/proj/sub';
    mux.getPaneCurrentPath = () => dir;
    mux.emit('paneExitsUpdated');
    dir = undefined;
    mux.emit('paneExitsUpdated');
    expect(session.toState().cwd).toBe('/work/proj/sub');
  });

  it('publishes nothing for a docker case', () => {
    const { mux, sessions } = build();
    const session = localMuxSession({ docker });
    sessions.set(session.id, session);
    mux.getPaneExit = () => undefined;
    mux.getPaneCurrentPath = () => '/work/proj';
    mux.emit('paneExitsUpdated');

    expect(session.toState().cwd).toBeUndefined();
  });

  it('publishes nothing for a remote session', () => {
    const { mux, sessions } = build();
    const session = localMuxSession({ remote });
    sessions.set(session.id, session);
    mux.getPaneExit = () => undefined;
    mux.getPaneCurrentPath = () => '/home/dev';
    mux.emit('paneExitsUpdated');

    expect(session.toState().cwd).toBeUndefined();
  });
});

describe('browser resolution order: live cwd, then workingDir', () => {
  const read = (name: string) => readFileSync(resolve(import.meta.dirname, '../src/web/public', name), 'utf8');

  const loadProto = () => {
    const context = vm.createContext({
      console,
      CodemanApp: class CodemanApp {},
      document: { addEventListener: vi.fn() },
      window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    vm.runInContext(
      `${read('constants.js')}\n${read('terminal-ui.js')}\nglobalThis.__proto = CodemanApp.prototype;`,
      context
    );
    return (context as unknown as { __proto: { _resolveLinkedFilePath: (p: string, id: string) => string } }).__proto;
  };

  const resolveFor = (session: Record<string, unknown>, filePath: string) => {
    const proto = loadProto();
    return proto._resolveLinkedFilePath.call({ sessions: new Map([['s1', session]]) }, filePath, 's1');
  };

  it("resolves against the pane's live directory after a cd into a subdirectory", () => {
    expect(resolveFor({ workingDir: '/work/proj', cwd: '/work/proj/sub' }, 'note.md')).toBe('/work/proj/sub/note.md');
  });

  it('resolves outside the workspace when the pane cd-ed to a sibling repo', () => {
    // Routing is unchanged: an absolute target outside the workspace is what
    // `_isExternalPreviewPath` already sends through the attachment routes.
    expect(resolveFor({ workingDir: '/work/proj', cwd: '/work/other' }, 'src/a.js')).toBe('/work/other/src/a.js');
  });

  it('falls back to workingDir when no live directory is known', () => {
    expect(resolveFor({ workingDir: '/work/proj' }, 'note.md')).toBe('/work/proj/note.md');
  });

  it('ignores a live directory on a remote or docker session', () => {
    expect(resolveFor({ workingDir: '/work/proj', cwd: '/tmp/x', remote: {} }, 'note.md')).toBe('/work/proj/note.md');
    expect(resolveFor({ workingDir: '/work/proj', cwd: '/tmp/x', docker: {} }, 'note.md')).toBe('/work/proj/note.md');
  });

  it('ignores a relative live directory', () => {
    expect(resolveFor({ workingDir: '/work/proj', cwd: 'sub' }, 'note.md')).toBe('/work/proj/note.md');
  });

  it('leaves absolute and home paths alone', () => {
    const session = { workingDir: '/work/proj', cwd: '/work/proj/sub' };
    expect(resolveFor(session, '/etc/hosts.md')).toBe('/etc/hosts.md');
    expect(resolveFor(session, '~/x.md')).toBe('~/x.md');
  });
});

describe('confinement is unchanged by the live cwd', () => {
  // The live cwd only picks the base. Whether the preview reads a path through
  // the workspace-confined file routes or registers it through the attachment
  // routes is still decided against `workingDir` by `_isExternalPreviewPath`.
  const read = (name: string) => readFileSync(resolve(import.meta.dirname, '../src/web/public', name), 'utf8');

  const loadApp = (session: Record<string, unknown>) => {
    const context = vm.createContext({
      console,
      CodemanApp: class CodemanApp {},
      document: { addEventListener: vi.fn(), getElementById: () => null },
      window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    });
    vm.runInContext(
      `${read('constants.js')}\n${read('terminal-ui.js')}\n${read('panels-ui.js')}\nglobalThis.__proto = CodemanApp.prototype;`,
      context
    );
    const proto = (
      context as unknown as {
        __proto: {
          _resolveLinkedFilePath: (p: string, id: string) => string;
          _isExternalPreviewPath: (p: string, id: string) => boolean;
        };
      }
    ).__proto;
    const app = { sessions: new Map([['s1', session]]) };
    return {
      target: (p: string) => proto._resolveLinkedFilePath.call(app, p, 's1'),
      external: (p: string) => proto._isExternalPreviewPath.call(app, p, 's1'),
    };
  };

  it('keeps a target inside the workspace on the workspace route', () => {
    const app = loadApp({ workingDir: '/work/proj', cwd: '/work/proj/sub' });
    expect(app.external(app.target('note.md'))).toBe(false);
  });

  it('sends a target outside the workspace through the attachment route', () => {
    const app = loadApp({ workingDir: '/work/proj', cwd: '/work/other' });
    expect(app.target('src/a.js')).toBe('/work/other/src/a.js');
    expect(app.external(app.target('src/a.js'))).toBe(true);
  });
});
