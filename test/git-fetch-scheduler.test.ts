/**
 * @fileoverview The Git fetch interval scheduler (src/git-fetch-scheduler.ts): which cases a tick runs, and
 * which it must not. Every rule is checked by calling `tick(now)` with an explicit clock, so nothing here
 * depends on fake timers or on how long a real tick takes — the scheduler owns no timers itself.
 *
 * Port: N/A.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  GitFetchScheduler,
  effectiveGitFetch,
  type GitFetchPorts,
  type GitFetchSessionView,
} from '../src/git-fetch-scheduler.js';
import {
  FETCH_CONCURRENCY,
  type GitFetchReport,
  type GitFetchSettings,
  type GitFetchStatus,
} from '../src/git-fetch.js';
import { DEFAULT_GIT_TIMEOUT_MS, MAX_REPOS } from '../src/git-workspace-status.js';

const SETTINGS: GitFetchSettings = { enabled: true, intervalSeconds: 300 };
const VIEW = (id: string, extra: Partial<GitFetchSessionView> = {}): GitFetchSessionView => ({
  id,
  workingDir: `/w/${id}`,
  ...extra,
});

/** An empty report, in the shape a run produces. */
const report = (cwd: string, name: string): GitFetchReport => ({
  state: 'ok',
  repos: [{ name, path: '.', ok: true }],
  reposTruncated: false,
  fetchedAt: Date.now(),
});

type Harness = {
  scheduler: GitFetchScheduler;
  ports: GitFetchPorts;
  calls: Array<{ id: string; opts: unknown }>;
  published: Array<{ id: string; status: GitFetchStatus }>;
  settings: GitFetchSettings;
  dockerReads: number;
};

/** A run the test decides when to let finish, so a slow repository can be held open across ticks. */
function deferred<T>(value: T) {
  let resolve = (v: T) => {};
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * A scheduler over an injected set of ports: nothing here touches a settings file, a repository or the
 * server, so what is being pinned is the scheduler's own decisions.
 */
function harness(
  sessions: GitFetchSessionView[],
  opts: { settings?: GitFetchSettings; fetch?: (id: string) => Promise<GitFetchReport> } = {}
): Harness {
  const customFetch = opts.fetch;
  const settings = opts.settings ?? { ...SETTINGS };
  const h: Harness = {
    scheduler: undefined as unknown as GitFetchScheduler,
    ports: undefined as unknown as GitFetchPorts,
    calls: [],
    published: [],
    settings,
    dockerReads: 0,
  };
  h.ports = {
    sessionIds: () => sessions.map((s) => s.id),
    getSession: (id) => sessions.find((s) => s.id === id),
    readSettings: async () => {
      if (h.settings === null) throw new Error('settings.json is mid-write');
      return h.settings;
    },
    dockerWorkspaces: async () => {
      h.dockerReads++;
      return [];
    },
    fetch: async (cwd, portOpts) => {
      const id = cwd.slice(3); // the '/w/<id>' the view was built with
      h.calls.push({ id, opts: portOpts });
      return customFetch ? customFetch(id) : report(cwd, id);
    },
    publish: (id, status) => h.published.push({ id, status }),
  };
  h.scheduler = new GitFetchScheduler(h.ports);
  return h;
}

describe('a quiet tick', () => {
  it('costs one settings read and nothing else, because nothing is on', async () => {
    const h = harness([VIEW('a'), VIEW('b')], { settings: { enabled: false, intervalSeconds: 300 } });
    expect(await h.scheduler.tick(1000)).toBe(0);
    expect(h.calls).toEqual([]);
    // The Docker case list is only worth reading once something is actually due.
    expect(h.dockerReads).toBe(0);
  });

  it('reads settings FRESH every tick, so a live toggle takes effect on the next tick and not at boot', async () => {
    const h = harness([VIEW('a')], { settings: { enabled: false, intervalSeconds: 30 } });
    await h.scheduler.tick(0);
    expect(h.calls.length).toBe(0);

    h.settings = { enabled: true, intervalSeconds: 30 };
    await h.scheduler.tick(1000);
    expect(h.calls.length).toBe(1);

    // Turning it off has to stop the fetching, not just stop it starting again later.
    h.settings = { enabled: false, intervalSeconds: 30 };
    await h.scheduler.tick(2000);
    expect(h.calls.length).toBe(1);
  });

  it('skips this tick only when a settings read fails, because settings.json is rewritten in place', async () => {
    const h = harness([VIEW('a')]);
    h.settings = null as unknown as GitFetchSettings;
    const logged = vi.fn();
    h.ports.log = logged;
    expect(await h.scheduler.tick(0)).toBe(0);
    expect(h.calls).toEqual([]);
    expect(logged).toHaveBeenCalled();

    h.settings = SETTINGS;
    // Nothing was recorded for the failed tick, so the case is still due at once.
    expect(await h.scheduler.tick(1000)).toBe(1);
  });
});

describe('who runs', () => {
  it('runs every case the app setting covers, once per interval', async () => {
    const h = harness([VIEW('a'), VIEW('b')], { settings: { enabled: true, intervalSeconds: 60 } });
    await h.scheduler.tick(0);
    expect(h.calls.map((c) => c.id).sort()).toEqual(['a', 'b']);

    await h.scheduler.tick(30_000); // not due yet
    expect(h.calls.length).toBe(2);

    await h.scheduler.tick(60_000);
    expect(h.calls.length).toBe(4);
  });

  it('runs a case that turned itself on even while the app-wide switch is off — that is what a per-case switch has to mean', async () => {
    const h = harness([VIEW('plain'), VIEW('own', { gitFetchEnabled: true, gitFetchIntervalSeconds: 30 })], {
      settings: { enabled: false, intervalSeconds: 300 },
    });
    await h.scheduler.tick(0);
    expect(h.calls.map((c) => c.id)).toEqual(['own']);

    // Its own interval, not the app's: due at 30 s, not at 300.
    await h.scheduler.tick(30_000);
    expect(h.calls.length).toBe(2);
  });

  it('never fetches a remote or Docker case, exactly as the Git panel excludes them', async () => {
    const h = harness([
      VIEW('ssh', { remote: { host: 'x' } }),
      VIEW('docker', { docker: { container: 'c' } }),
      VIEW('local'),
    ]);
    await h.scheduler.tick(0);
    expect(h.calls.map((c) => c.id)).toEqual(['local']);
  });

  it('re-checks the Docker rule every tick, so a case that became a Docker case stops fetching', async () => {
    const sessions = [VIEW('a')];
    const h = harness(sessions);
    await h.scheduler.tick(0);
    expect(h.calls.length).toBe(1);

    sessions[0] = { ...sessions[0], docker: { container: 'c' } };
    await h.scheduler.tick(400_000);
    expect(h.calls.length).toBe(1);
  });

  it('uses the module defaults for the limit and the timeout, because those settings are per device and never reach the server', async () => {
    const h = harness([VIEW('a')]);
    await h.scheduler.tick(0);
    expect(h.calls[0].opts).toMatchObject({ maxRepos: MAX_REPOS, timeoutMs: DEFAULT_GIT_TIMEOUT_MS });
  });
});

describe('one run at a time', () => {
  it('skips a case still being fetched instead of stacking runs on it', async () => {
    const gate = deferred<GitFetchReport>(report('/w/a', 'a'));
    const h = harness([VIEW('a')], { settings: { enabled: true, intervalSeconds: 30 }, fetch: () => gate.promise });
    const running = h.scheduler.tick(0);
    await new Promise((resolve) => setImmediate(resolve)); // the run has started, and is still held open
    expect(await h.scheduler.tick(15_000)).toBe(0);
    expect(h.calls.length).toBe(1);
    gate.resolve(report('/w/a', 'a'));
    await running;
  });

  it('times the interval from the START of a run, so a slow repository does not push the next one out', async () => {
    const slow = deferred<GitFetchReport>(report('/w/a', 'a'));
    const h = harness([VIEW('a')], { settings: { enabled: true, intervalSeconds: 30 }, fetch: () => slow.promise });

    const first = h.scheduler.tick(0);
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.calls.length).toBe(1);

    // The run takes 200 s, longer than its own interval. Once it lands, the case is already past due: the
    // next tick runs it again instead of waiting another 30 s from when the slow one finished.
    slow.resolve(report('/w/a', 'a'));
    await first;
    expect(await h.scheduler.tick(200_000)).toBe(1);
    expect(h.calls.length).toBe(2);
  });

  it('runs at most FETCH_CONCURRENCY cases at a time, because each one is a git process', async () => {
    const ids = Array.from({ length: FETCH_CONCURRENCY + 3 }, (_, i) => `s${i}`);
    let live = 0;
    let peak = 0;
    const h = harness(
      ids.map((id) => VIEW(id)),
      {
        fetch: async () => {
          live++;
          peak = Math.max(peak, live);
          await new Promise((resolve) => setImmediate(resolve));
          live--;
          return report('/w/x', 'x');
        },
      }
    );
    await h.scheduler.tick(0);
    expect(peak).toBe(FETCH_CONCURRENCY);
    expect(h.calls.length).toBe(ids.length);
  });
});

describe('what a run reports', () => {
  it("publishes the run as the interval's own, so the panel can say the number was not asked for", async () => {
    const h = harness([VIEW('a')]);
    await h.scheduler.tick(0);
    expect(h.published).toEqual([
      {
        id: 'a',
        status: { ranAt: expect.any(Number), trigger: 'interval', state: 'ok', repos: 1, failed: 0 },
      },
    ]);
  });

  it("reports a failure instead of retrying harder, and keeps the case's own next run at its own interval", async () => {
    const h = harness([VIEW('a')], {
      settings: { enabled: true, intervalSeconds: 30 },
      fetch: () => Promise.reject(new Error('spawn git ENOENT')),
    });
    const logged = vi.fn();
    h.ports.log = logged;
    await h.scheduler.tick(0);
    expect(logged).toHaveBeenCalled();
    expect(h.published).toEqual([]);
    // Still remembered, so the next run is on schedule rather than immediate.
    expect(h.scheduler.tracked()).toBe(1);
  });
});

describe('the effective choice', () => {
  it("a case's own override wins over the app setting", () => {
    const settings = { enabled: false, intervalSeconds: 600 };
    expect(effectiveGitFetch(VIEW('a', { gitFetchEnabled: true, gitFetchIntervalSeconds: 45 }), settings)).toEqual({
      enabled: true,
      intervalSeconds: 45,
    });
    // Half a choice still follows the app for the other half.
    expect(effectiveGitFetch(VIEW('b', { gitFetchEnabled: true }), settings)).toEqual({
      enabled: true,
      intervalSeconds: 600,
    });
  });

  it('re-clamps a persisted interval that can predate the schema bounds', () => {
    expect(effectiveGitFetch(VIEW('a', { gitFetchIntervalSeconds: 5 }), SETTINGS)).toEqual({
      enabled: true,
      intervalSeconds: 30,
    });
    expect(effectiveGitFetch(VIEW('b', { gitFetchIntervalSeconds: 9000 }), SETTINGS)).toEqual({
      enabled: true,
      intervalSeconds: 3600,
    });
  });
});

describe('a case that goes away', () => {
  it('takes its schedule with it, so a reopened case starts on its own clock', async () => {
    const h = harness([VIEW('a')]);
    await h.scheduler.tick(0);
    expect(h.scheduler.tracked()).toBe(1);

    h.scheduler.remove('a');
    expect(h.scheduler.tracked()).toBe(0);
    await h.scheduler.tick(1000);
    expect(h.calls.length).toBe(2); // remembered again, from now
  });

  it('stops everything after stop(), including a case that was already due', async () => {
    const h = harness([VIEW('a')]);
    h.scheduler.stop();
    expect(await h.scheduler.tick(0)).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.scheduler.tracked()).toBe(0);
  });
});
