/**
 * The Ralph tracker's `@fix_plan.md` watcher must never be pointed at a REMOTE
 * session's working directory.
 *
 * A remote-SSH session's `workingDir` is a path on the remote host. The watcher
 * reads and `fs.watch`es it on the LOCAL disk, where it usually does not exist,
 * so every server start logged
 * `[RalphFixPlanWatcher] Could not watch @fix_plan.md: Error: ENOENT ...` once per
 * remote session (and where a same-named local directory did exist, it watched
 * the wrong tree). A remote session therefore only RECORDS the path
 * (`setRemoteWorkingDir`): nothing is read or watched locally, and the fix
 * plan stays authoritative (`isFileAuthoritative`) exactly as for a local
 * session, so the tracker's output-based completion guessers stay off. They
 * are off for every session with a working directory; turning them on for
 * remote sessions alone would let a prose line such as "All tasks completed"
 * mark every todo done and end the loop there and nowhere else.
 *
 * Drives the real `WebServer.setupSessionListeners()`, like
 * discard-partially-built-session.test.ts.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { safeRmHomeTree } from './mocks/test-helpers.js';

import { WebServer } from '../src/web/server.js';
import { Session } from '../src/session.js';
import { TmuxManager } from '../src/tmux-manager.js';

interface ServerInternals {
  registerSessionWithLayout(session: Session): Promise<void>;
  setupSessionListeners(session: Session): Promise<void>;
  discardPartiallyBuiltSession(sessionId: string): Promise<void>;
}

const WORKSPACE = join(homedir(), '.codeman-test-ralph-remote');
// A path on the remote host: nothing exists there locally.
const REMOTE_PATH = '/nonexistent-remote-host-path/homelab-infrastructure';
const SESSION_ID = 'f0e1d2c3b4a59687';

let server: WebServer;
let internals: ServerInternals;
let mux: TmuxManager;

function buildSession(remote: boolean): Session {
  return new Session({
    id: SESSION_ID,
    workingDir: remote ? REMOTE_PATH : WORKSPACE,
    mode: 'claude',
    name: remote ? 'remote session' : 'local session',
    mux,
    useMux: true,
    ...(remote
      ? {
          remote: {
            hostId: 'proxx',
            label: 'proxx',
            host: 'proxx.example.lan',
            username: 'user',
            remotePath: REMOTE_PATH,
            owned: true,
          },
        }
      : {}),
  });
}

beforeAll(() => {
  mkdirSync(WORKSPACE, { recursive: true });
  server = new WebServer(0, false, true);
  internals = server as unknown as ServerInternals;
  mux = new TmuxManager();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await internals.discardPartiallyBuiltSession(SESSION_ID).catch(() => {});
});

afterAll(async () => {
  await server.stop().catch(() => {});
  safeRmHomeTree(WORKSPACE);
});

describe('Ralph @fix_plan.md watcher and the session location', () => {
  it('does not watch a remote session working directory on the local disk', async () => {
    const session = buildSession(true);
    const setWorkingDir = vi.spyOn(session.ralphTracker, 'setWorkingDir');
    const setRemoteWorkingDir = vi.spyOn(session.ralphTracker, 'setRemoteWorkingDir');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await internals.registerSessionWithLayout(session);
    await internals.setupSessionListeners(session);

    expect(setWorkingDir).not.toHaveBeenCalled();
    expect(setRemoteWorkingDir).toHaveBeenCalledWith(REMOTE_PATH);
    expect(log.mock.calls.some((args) => String(args[0]).includes('Could not watch @fix_plan.md'))).toBe(false);
    // Same authority as a local session: the output-based completion guessers stay off.
    expect(session.ralphTracker.isFileAuthoritative).toBe(true);
  });

  it('never reads a same-named local file for a remote session', async () => {
    // The remote path exists locally too (an sshfs mount, a leftover checkout) and holds a plan.
    writeFileSync(join(WORKSPACE, '@fix_plan.md'), '- [ ] a local task the remote session never had\n');
    try {
      const session = new Session({
        id: SESSION_ID,
        workingDir: WORKSPACE,
        mode: 'claude',
        name: 'remote session over a local twin',
        mux,
        useMux: true,
        remote: {
          hostId: 'proxx',
          label: 'proxx',
          host: 'proxx.example.lan',
          username: 'user',
          remotePath: WORKSPACE,
          owned: true,
        },
      });
      vi.spyOn(console, 'log').mockImplementation(() => {});

      await internals.registerSessionWithLayout(session);
      await internals.setupSessionListeners(session);

      expect(await session.ralphTracker.loadFixPlanFromDisk()).toBe(0);
      expect(session.ralphTracker.todos).toEqual([]);
    } finally {
      rmSync(join(WORKSPACE, '@fix_plan.md'), { force: true });
    }
  });

  it('keeps a remote session todo list out of the prose completion guessers', async () => {
    const session = buildSession(true);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await internals.registerSessionWithLayout(session);
    await internals.setupSessionListeners(session);

    const tracker = session.ralphTracker;
    tracker.enable();
    tracker.startLoop('ALLDONE');
    const completions: string[] = [];
    tracker.on('completionDetected', (phrase: string) => completions.push(phrase));
    tracker.processTerminalData('- [ ] Write the parser\n- [ ] Add tests\n');
    const pending = () => tracker.todos.filter((t) => t.status !== 'completed').length;
    expect(pending()).toBe(2);

    // Prose, not the configured completion phrase: it must not end the loop.
    tracker.processTerminalData('All tasks completed\n');

    expect(pending()).toBe(2);
    expect(tracker.loopState.active).toBe(true);
    expect(completions).toEqual([]);
  });

  it('still watches a local session working directory', async () => {
    const session = buildSession(false);
    const setWorkingDir = vi.spyOn(session.ralphTracker, 'setWorkingDir');

    await internals.registerSessionWithLayout(session);
    await internals.setupSessionListeners(session);

    expect(setWorkingDir).toHaveBeenCalledWith(WORKSPACE);
  });
});
