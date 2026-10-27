/**
 * @fileoverview The Git fetch interval scheduler (src/git-fetch-scheduler.ts): which sessions a tick runs,
 * and which it must not. Every rule is checked by calling `tick(now)` with an explicit clock, so nothing here
 * depends on fake timers or on how long a real tick takes: the scheduler owns no timers itself.
 *
 * The run belongs to the FOLDER, so these tests put two sessions on one folder and expect one fetch that
 * both see, and they check the tick's two bounds separately: one shared bound for the fetches of the whole
 * tick, and the folders bounded by a bound that cannot be the same semaphore. A folder is due when ANY session
 * open on it is due, so the order the sessions were read cannot decide it, and that is checked in both orders.
 * A run carries the trigger that caused it, and what is published says the run's, not the tick's.
 *
 * Port: N/A.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  GitFetchScheduler,
  effectiveGitFetch,
  type GitFetchPorts,
  type GitFetchSessionView,
} from '../src/git-fetch-scheduler.js';
import {
  FETCH_CONCURRENCY,
  type GitFetchOptions,
  type GitFetchReport,
  type GitFetchRun,
  type GitFetchSettings,
  type GitFetchStatus,
  type GitFetchTrigger,
} from '../src/git-fetch.js';
import { DEFAULT_GIT_TIMEOUT_MS, MAX_REPOS } from '../src/git-workspace-status.js';
import type { PathProbeKind } from '../src/utils/bounded-path-probe.js';
import { readGitFetchSettings, readKeepWarmSettingsOrThrow } from '../src/hooks-config.js';
import { SETTINGS_PATH } from '../src/web/route-helpers.js';

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

/** A run: the report plus the trigger that caused it, which is what the published row has to name. */
const run = (cwd: string, name: string, trigger: GitFetchTrigger = 'interval'): GitFetchRun => ({
  report: report(cwd, name),
  trigger,
});

type Harness = {
  scheduler: GitFetchScheduler;
  ports: GitFetchPorts;
  /** The folders the tick actually ran, in the order they were picked, with the trigger the tick passed. */
  calls: Array<{ cwd: string; opts: GitFetchOptions; trigger: GitFetchTrigger }>;
  published: Array<{ id: string; status: GitFetchStatus }>;
  /** Every path the tick probed, in order: the probe has to happen before anything is fetched. */
  probed: string[];
  settings: GitFetchSettings;
  dockerReads: number;
  /**
   * A session that closed: the server calls `remove()` when the session is gone, so this takes it out of the
   * ports as well as out of the scheduler. Otherwise a test that removes a session still sees it on the next
   * tick, and the folder it was on looks still open.
   */
  remove(id: string): void;
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
  opts: {
    settings?: GitFetchSettings;
    fetch?: (cwd: string, portOpts: GitFetchOptions, trigger: GitFetchTrigger) => Promise<GitFetchRun>;
    /** Default: every path answers as a folder, so a test that does not care about the probe stays quiet. */
    probe?: (path: string) => Promise<PathProbeKind>;
  } = {}
): Harness {
  const customFetch = opts.fetch;
  const settings = opts.settings ?? { ...SETTINGS };
  const gone = new Set<string>();
  const h: Harness = {
    scheduler: undefined as unknown as GitFetchScheduler,
    ports: undefined as unknown as GitFetchPorts,
    calls: [],
    published: [],
    probed: [],
    settings,
    dockerReads: 0,
    remove: (id) => {
      gone.add(id);
      h.scheduler.remove(id);
    },
  };
  h.ports = {
    sessionIds: () => sessions.filter((s) => !gone.has(s.id)).map((s) => s.id),
    getSession: (id) => (gone.has(id) ? undefined : sessions.find((s) => s.id === id)),
    readSettings: async () => {
      if (h.settings === null) throw new Error('settings.json is not valid JSON');
      return h.settings;
    },
    dockerWorkspaces: async () => {
      h.dockerReads++;
      return [];
    },
    probePath: async (path) => {
      h.probed.push(path);
      return opts.probe ? await opts.probe(path) : 'directory';
    },
    fetch: async (cwd, portOpts, trigger) => {
      h.calls.push({ cwd, opts: portOpts, trigger });
      return customFetch ? customFetch(cwd, portOpts, trigger) : run(cwd, cwd.slice(3), trigger);
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
    // The probe and the Docker case list are only worth reading once something is actually due.
    expect(h.probed).toEqual([]);
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

  it('skips this tick only when a settings read fails, rather than deciding from defaults', async () => {
    const h = harness([VIEW('a')]);
    h.settings = null as unknown as GitFetchSettings;
    const logged = vi.fn();
    h.ports.log = logged;
    expect(await h.scheduler.tick(0)).toBe(0);
    expect(h.calls).toEqual([]);
    expect(logged).toHaveBeenCalled();

    h.settings = SETTINGS;
    // Nothing was recorded for the failed tick, so the folder is still due at once.
    expect(await h.scheduler.tick(1000)).toBe(1);
  });

  /**
   * The tick runs every 15 s whether or not the feature is on, so an unreadable settings.json would be logged
   * every 15 s, and V8's parse message quotes the text around the fault: a hand edit with single quotes put
   * the API key it held into the log on every tick.
   */
  it('logs an unreadable settings.json once until it reads again, and never with the text of the file', async () => {
    const secret = 'sk-leak42';
    const broken = `{"voiceSettings":{"apiKey":'${secret}'}}`;
    await mkdir(dirname(SETTINGS_PATH), { recursive: true });
    await writeFile(SETTINGS_PATH, broken);
    try {
      // The real readers: what they reject with is what gets logged.
      await expect(readGitFetchSettings()).rejects.toThrow(/not valid JSON/);
      await expect(readGitFetchSettings()).rejects.not.toThrow(secret);
      await expect(readKeepWarmSettingsOrThrow()).rejects.not.toThrow(secret);

      const h = harness([VIEW('a')]);
      h.ports.readSettings = readGitFetchSettings;
      const logged = vi.fn();
      h.ports.log = logged;
      for (const now of [0, 15_000, 30_000]) expect(await h.scheduler.tick(now)).toBe(0);
      expect(h.calls).toEqual([]);
      expect(logged).toHaveBeenCalledTimes(1);

      // A read that succeeds in between re-arms the warning for the next failure.
      await writeFile(SETTINGS_PATH, JSON.stringify({ gitFetchEnabled: true }));
      expect(await h.scheduler.tick(45_000)).toBe(1);
      await writeFile(SETTINGS_PATH, broken);
      expect(await h.scheduler.tick(400_000)).toBe(0);
      expect(await h.scheduler.tick(415_000)).toBe(0);
      expect(logged).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(logged.mock.calls)).not.toContain(secret);
    } finally {
      await rm(SETTINGS_PATH, { force: true });
    }
  });
});

describe('the bounded probe', () => {
  it('probes the folder before fetching it, and skips anything that is not a directory', async () => {
    const kinds = new Map<string, PathProbeKind>([
      ['/w/file', 'file'],
      ['/w/unknown', 'unknown'],
      ['/w/absent', 'absent'],
    ]);
    const h = harness([VIEW('file'), VIEW('unknown'), VIEW('absent'), VIEW('ok')], {
      probe: async (path) => kinds.get(path) ?? 'directory',
    });
    const logged = vi.fn();
    h.ports.log = logged;
    expect(await h.scheduler.tick(0)).toBe(1);
    expect(h.calls.map((c) => c.cwd)).toEqual(['/w/ok']);
    // The folders that answered badly were probed and left alone, never fetched.
    expect(h.probed).toEqual(['/w/file', '/w/unknown', '/w/absent', '/w/ok']);
    expect(logged).toHaveBeenCalledTimes(3);
    // `unknown` is never read as `absent`: the log says what it answered rather than what it was assumed.
    expect(logged.mock.calls.join(' ')).toContain('unknown');
  });
});

describe('who runs', () => {
  it('runs every session the app setting covers, once per interval', async () => {
    const h = harness([VIEW('a'), VIEW('b')], { settings: { enabled: true, intervalSeconds: 60 } });
    await h.scheduler.tick(0);
    expect(h.calls.map((c) => c.cwd).sort()).toEqual(['/w/a', '/w/b']);

    await h.scheduler.tick(30_000); // not due yet
    expect(h.calls.length).toBe(2);

    await h.scheduler.tick(60_000);
    expect(h.calls.length).toBe(4);
  });

  it('runs a session that turned itself on even while the app-wide switch is off: that is what a per-session switch has to mean', async () => {
    const h = harness([VIEW('plain'), VIEW('own', { gitFetchEnabled: true, gitFetchIntervalSeconds: 30 })], {
      settings: { enabled: false, intervalSeconds: 300 },
    });
    await h.scheduler.tick(0);
    expect(h.calls.map((c) => c.cwd)).toEqual(['/w/own']);

    // Its own interval, not the app's: due at 30 s, not at 300.
    await h.scheduler.tick(30_000);
    expect(h.calls.length).toBe(2);
  });

  it('never fetches a remote or Docker session, exactly as the Git panel excludes them', async () => {
    const h = harness([
      VIEW('ssh', { remote: { host: 'x' } }),
      VIEW('docker', { docker: { container: 'c' } }),
      VIEW('local'),
    ]);
    await h.scheduler.tick(0);
    expect(h.calls.map((c) => c.cwd)).toEqual(['/w/local']);
  });

  it('re-checks the Docker rule every tick, so a session whose case became a Docker case stops fetching', async () => {
    const sessions = [VIEW('a')];
    const h = harness(sessions);
    await h.scheduler.tick(0);
    expect(h.calls.length).toBe(1);

    sessions[0] = { ...sessions[0], docker: { container: 'c' } };
    await h.scheduler.tick(400_000);
    expect(h.calls.length).toBe(1);
  });

  /**
   * The Docker case list is rewritten in place, so a read can land on a half-written file. Read as "no Docker
   * workspaces", a tick would run git (and the repository's hooks) inside a folder a container can write to.
   */
  it('fetches nothing when the Docker case list cannot be read, keeps the folders due, and logs it once', async () => {
    const h = harness([VIEW('a'), VIEW('b')]);
    let unreadable = true;
    h.ports.dockerWorkspaces = async () => {
      h.dockerReads++;
      if (unreadable) throw new Error('docker-cases.json is not a valid JSON array');
      return [];
    };
    const logged = vi.fn();
    h.ports.log = logged;
    expect(await h.scheduler.tick(0)).toBe(0);
    expect(await h.scheduler.tick(15_000)).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.dockerReads).toBe(2); // the picks were undone, so the next tick picked them again
    expect(logged).toHaveBeenCalledTimes(1);
    expect(h.scheduler.tracked()).toBe(0); // nothing left in flight or stamped

    // The list reads again: both folders run at once, not an interval after the failed ticks.
    unreadable = false;
    expect(await h.scheduler.tick(30_000)).toBe(2);
    expect(h.calls.map((c) => c.cwd).sort()).toEqual(['/w/a', '/w/b']);
    // And their interval is timed from that run.
    expect(await h.scheduler.tick(30_000 + 299_000)).toBe(0);
    expect(await h.scheduler.tick(30_000 + 300_000)).toBe(2);
  });

  it('is wired to the strict Docker reader the Fetch button uses', () => {
    const server = readFileSync(resolve(import.meta.dirname, '../src/web/server.ts'), 'utf8');
    const block = server.slice(server.indexOf('new GitFetchScheduler('));
    // defaultDockerWorkspaces is the strict one: test/routes/git-status-routes.test.ts pins that it rejects.
    expect(block.slice(0, block.indexOf('});'))).toContain('dockerWorkspaces: defaultDockerWorkspaces,');
  });

  it('uses the module defaults for the limit and the timeout, because those settings are per device and never reach the server', async () => {
    const h = harness([VIEW('a')]);
    await h.scheduler.tick(0);
    expect(h.calls[0].opts).toMatchObject({ maxRepos: MAX_REPOS, timeoutMs: DEFAULT_GIT_TIMEOUT_MS });
  });
});

describe('one folder, one run', () => {
  it('fetches a shared folder once and publishes the result to every session open on it', async () => {
    const h = harness([VIEW('a'), { ...VIEW('b'), workingDir: '/w/a' }]);
    expect(await h.scheduler.tick(0)).toBe(1); // one folder, not two runs
    expect(h.calls.length).toBe(1);
    expect(h.published.map((p) => p.id).sort()).toEqual(['a', 'b']);
    // Both see the same run, so the panel's row says the same thing in both tabs.
    expect(new Set(h.published.map((p) => p.status.failed)).size).toBe(1);
  });

  it('is due when ANY session open on the folder is due, in either read order, because the clock belongs to the folder and not to whichever session was read first', async () => {
    const short = { ...VIEW('short'), workingDir: '/w/shared', gitFetchIntervalSeconds: 30 };
    const long = { ...VIEW('long'), workingDir: '/w/shared', gitFetchIntervalSeconds: 300 };

    for (const order of [
      [short, long],
      [long, short],
    ]) {
      const h = harness(order);

      // Nothing has run yet, so both are due and both are published from the one run. The folder is probed
      // once, not once per session open on it.
      expect(await h.scheduler.tick(0)).toBe(1);
      expect(h.probed).toEqual(['/w/shared']);
      expect(h.published.map((p) => p.id).sort()).toEqual(['long', 'short']);

      // Before the short interval elapses neither is due, and the order they were read in cannot change that.
      h.published.length = 0;
      expect(await h.scheduler.tick(15_000)).toBe(0);
      expect(h.published).toEqual([]);

      // The short session is past its own interval, so the folder is fetched (once, for both). The run that
      // happens covers the long session's interval too, and both still get it because both are open on the
      // folder: publishing only the session that made the folder due would leave the other tab on a stale row.
      h.published.length = 0;
      expect(await h.scheduler.tick(30_000)).toBe(1);
      expect(h.calls.length).toBe(2);
      expect(h.published.map((p) => p.id).sort()).toEqual(['long', 'short']);

      // The long one's own interval comes round, so the folder is due again.
      h.published.length = 0;
      expect(await h.scheduler.tick(300_000)).toBe(1);
      expect(h.published.map((p) => p.id).sort()).toEqual(['long', 'short']);
    }
  });

  it('does not pick a folder again while its run is going, and does not run a second tick over the same selection', async () => {
    const ids = Array.from({ length: FETCH_CONCURRENCY + 2 }, (_, i) => `s${i}`);
    const gate = deferred<GitFetchRun>(run('/w/first', 'first'));
    const h = harness(
      ids.map((id) => VIEW(id)),
      {
        settings: { enabled: true, intervalSeconds: 30 },
        fetch: () => gate.promise,
      }
    );

    const first = h.scheduler.tick(0);
    await new Promise((resolve) => setImmediate(resolve)); // the first runs are going, the rest are queued
    const picked = h.calls.length;
    expect(picked).toBe(FETCH_CONCURRENCY);

    // The server fires the next tick without waiting. The schedule was stamped at selection, so the folders
    // already picked are not picked again, and this tick is skipped while the previous one is still going.
    expect(await h.scheduler.tick(15_000)).toBe(0);
    expect(h.calls.length).toBe(picked);

    gate.resolve(run('/w/first', 'first'));
    await first;
    // Every folder ran exactly once, and no folder ran twice.
    expect(h.calls.length).toBe(ids.length);
    expect(new Set(h.calls.map((c) => c.cwd)).size).toBe(ids.length);
  });

  it('shares one bound across the whole tick instead of giving each folder its own, and bounds the folders with a bound of its own', async () => {
    const ids = Array.from({ length: FETCH_CONCURRENCY + 1 }, (_, i) => `s${i}`);
    let fetchesLive = 0;
    let fetchesPeak = 0;
    let foldersLive = 0;
    let foldersPeak = 0;
    const hold = () => new Promise((resolve) => setImmediate(resolve));
    const h = harness(
      ids.map((id) => VIEW(id)),
      {
        // Every folder is handed the SAME limiter for its work, so that work cannot get its own bound: a
        // per-call bound would let 5 folders × 6 items run at once. The folders themselves are bounded by a
        // DIFFERENT bound, because one semaphore cannot serve both levels: a folder holding a slot and then
        // waiting for one for its own fetch is waiting on itself, and the folders that fill the bound are
        // exactly the ones blocking it. If the tick used one semaphore for both, this test would hang and fail
        // as a timeout rather than as an assertion.
        fetch: async (cwd, opts) => {
          foldersLive++;
          foldersPeak = Math.max(foldersPeak, foldersLive);
          await opts.limiter?.([0, 1, 2, 3, 4, 5], async () => {
            fetchesLive++;
            fetchesPeak = Math.max(fetchesPeak, fetchesLive);
            await hold();
            fetchesLive--;
          });
          foldersLive--;
          return run(cwd, cwd.slice(3));
        },
      }
    );
    await h.scheduler.tick(0);
    expect(fetchesPeak).toBe(FETCH_CONCURRENCY); // the tick's ceiling, not each folder's own
    expect(foldersPeak).toBe(FETCH_CONCURRENCY);
    expect(h.calls.length).toBe(ids.length); // every folder ran, none was left waiting forever
  });

  it('times the interval from the START of a run, so a slow repository does not push the next one out', async () => {
    const slow = deferred<GitFetchRun>(run('/w/a', 'a'));
    const h = harness([VIEW('a')], { settings: { enabled: true, intervalSeconds: 30 }, fetch: () => slow.promise });

    const first = h.scheduler.tick(0);
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.calls.length).toBe(1);

    // The run takes 200 s, longer than its own interval. Once it lands, the folder is already past due: the
    // next tick runs it again instead of waiting another 30 s from when the slow one finished.
    slow.resolve(run('/w/a', 'a'));
    await first;
    expect(await h.scheduler.tick(200_000)).toBe(1);
    expect(h.calls.length).toBe(2);
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

  it('publishes the trigger of the run that actually happened rather than the trigger the tick asked for, because a tick that joined a click did not fetch anything', async () => {
    const h = harness([VIEW('a')], {
      // The port is `fetchWorkspaceOnce`, so it can hand back a run a click had already started for this
      // folder. The tick asked for its own; the row has to name the run.
      fetch: (cwd, _opts, trigger) => {
        expect(trigger).toBe('interval');
        return Promise.resolve({ report: report(cwd, 'a'), trigger: 'click' });
      },
    });
    await h.scheduler.tick(0);
    expect(h.published[0].status.trigger).toBe('click');
  });

  it("reports a failure instead of retrying harder, and keeps the folder's next run at its own interval", async () => {
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
  it("a session's own override wins over the app setting", () => {
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

describe('a session that goes away', () => {
  it('takes its own choice with it, but keeps the folder while another session is still open on it', async () => {
    const sessions = [VIEW('a'), { ...VIEW('b'), workingDir: '/w/a' }];
    const h = harness(sessions);
    await h.scheduler.tick(0);
    expect(h.scheduler.tracked()).toBe(1);

    h.remove('a');
    // The run belongs to the clone, so 'b' keeps the folder's schedule and its next run is still on time:
    // the choice that got the folder going was 'a's, but the folder is not 'a's.
    expect(h.scheduler.tracked()).toBe(1);
    await h.scheduler.tick(1000); // not due yet, and 'b' is still open on the folder
    expect(h.calls.length).toBe(1);

    // The last session open on the folder goes, so the folder is forgotten: a session coming back on it is due
    // at once rather than on the schedule the closed one left behind.
    h.remove('b');
    expect(h.scheduler.tracked()).toBe(0);
    sessions.push({ ...VIEW('c'), workingDir: '/w/a' });
    await h.scheduler.tick(2000);
    expect(h.calls.length).toBe(2); // remembered again, from now
  });

  it('stops everything after stop(), including a folder that was already due', async () => {
    const h = harness([VIEW('a')]);
    h.scheduler.stop();
    expect(await h.scheduler.tick(0)).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.scheduler.tracked()).toBe(0);
  });
});
