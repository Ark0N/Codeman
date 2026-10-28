/**
 * The Ralph tracker's `@fix_plan.md` watcher must never be pointed at a REMOTE
 * session's working directory.
 *
 * A remote-SSH session's `workingDir` is a path on the remote host. The watcher
 * reads and `fs.watch`es it on the LOCAL disk, where it usually does not exist,
 * so every server start logged
 * `[RalphFixPlanWatcher] Could not watch @fix_plan.md: Error: ENOENT ...` once per
 * remote session (and where a same-named local directory did exist, it watched
 * the wrong tree). Setting the path also made the tracker treat the unreadable
 * file as authoritative (`isFileAuthoritative`), which switched off its
 * output-based todo completion for every remote session.
 * `setupSessionListeners()` already skips external CLI modes (the tracker is
 * not supported there); a remote location is the other case with no local
 * file to watch.
 *
 * Drives the real `WebServer.setupSessionListeners()`, like
 * discard-partially-built-session.test.ts.
 */
import { mkdirSync } from 'node:fs';
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
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await internals.registerSessionWithLayout(session);
    await internals.setupSessionListeners(session);

    expect(setWorkingDir).not.toHaveBeenCalled();
    expect(log.mock.calls.some((args) => String(args[0]).includes('Could not watch @fix_plan.md'))).toBe(false);
    // A fix-plan path that can never be read must not make the file "authoritative":
    // that turns off the tracker's output-based todo completion for the session.
    expect(session.ralphTracker.isFileAuthoritative).toBe(false);
  });

  it('still watches a local session working directory', async () => {
    const session = buildSession(false);
    const setWorkingDir = vi.spyOn(session.ralphTracker, 'setWorkingDir');

    await internals.registerSessionWithLayout(session);
    await internals.setupSessionListeners(session);

    expect(setWorkingDir).toHaveBeenCalledWith(WORKSPACE);
  });
});
