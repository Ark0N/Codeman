/**
 * @fileoverview Git fetch on an interval: the cases the user turned on, fetched by a tick the server owns
 * (`src/git-fetch-scheduler.ts`, wired in `src/web/server.ts`).
 *
 * The fetch module (src/git-fetch.ts) is the only place Codeman runs a git command that writes, and on a
 * timer it is the only one that can run without being asked — which is why the whole feature is off until
 * the user turns it on, in Settings → Bottom bar, per session in Session Options → Git.
 *
 * The scheduler holds no timers of its own. The server ticks it (`GIT_FETCH_TICK_INTERVAL_MS`) and every
 * tick reads the app setting FRESH, so a live toggle takes effect on the next tick instead of at boot, and
 * turning the feature off actually stops the fetching. A session can override both the switch and the
 * interval; a session with no override follows the app.
 *
 * Rules the code keeps and the tests pin:
 *   - Nothing runs when nothing is on: no repository set is read and nothing is spawned, so a quiet
 *     install costs one settings read per tick. A session that turned itself on still runs even while the
 *     app-wide switch is off — that is what a per-session switch has to mean.
 *   - Remote and Docker sessions are never fetched, exactly as the Git panel excludes them, and the Docker
 *     workspace roots are checked again every tick, so a session whose case became a Docker case stops
 *     fetching at the next tick.
 *   - A folder is fetched by at most one run at a time, and the run belongs to the FOLDER, not to one
 *     session: two sessions open on the same folder are the same clone, so they share one run and both get
 *     its result. State is keyed by `resolve(workingDir)` — deliberately not `realpath`, because `realpath`
 *     is itself one of the unbounded fs calls rule #516 bounds; the bounded probe below is the fs read.
 *     Every session open on a folder is remembered, so closing the one holding the override does not stop
 *     the folder's fetching while another session is still on it.
 *   - Before anything is fetched, the folder is probed BOUNDED with the default options (rule #516): a case
 *     on a mount that stopped answering is skipped, never touched, and a probe that answers `unknown` is not
 *     read as "not a folder".
 *   - A schedule is stamped at SELECTION, when a session goes into `due`, not when its run starts, so a
 *     tick that is still running cannot pick the same folder again; and a tick is skipped while the previous
 *     one is still going, so the bound below is the bound for the whole tick, not per tick.
 *   - At most `FETCH_CONCURRENCY` git processes at a time across the whole tick, because each is a git
 *     process: ONE bound is shared by every run of the tick, so `FETCH_CONCURRENCY` is the tick's ceiling
 *     rather than each folder's own. The folders get their OWN bound (`mapLimited`), because one semaphore
 *     cannot serve both levels: a folder that holds a slot and then waits for one for its own fetch is
 *     waiting on itself, and the folders that fill the bound are exactly the ones blocking it.
 *   - The interval is timed from the START of a run, so a run that takes three minutes does not push the
 *     next one out by three minutes; it lands on the tick after its own interval elapses.
 *   - The per-repository limit and the git timeout stay the module's defaults (`MAX_REPOS`,
 *     `DEFAULT_GIT_TIMEOUT_MS`): both settings are per device and never reach the server, so the server
 *     cannot know what a device chose.
 *   - A failure is reported, not retried harder: the folder keeps its schedule and gets its next run at its
 *     own interval. A settings read that fails skips this tick only, because settings.json is rewritten in
 *     place and a kept fallback would hold the feature off until the next settings change.
 *
 * @module git-fetch-scheduler
 */

import { resolve } from 'node:path';
import { getErrorMessage } from './types.js';
import {
  FETCH_CONCURRENCY,
  MAX_GIT_FETCH_INTERVAL_SECONDS,
  MIN_GIT_FETCH_INTERVAL_SECONDS,
  gitFetchStatusFrom,
  type GitFetchOptions,
  type GitFetchReport,
  type GitFetchSettings,
  type GitFetchStatus,
} from './git-fetch.js';
import { clampInt, DEFAULT_GIT_TIMEOUT_MS, MAX_REPOS, createLimiter, mapLimited } from './git-workspace-status.js';
import type { PathProbeKind } from './utils/bounded-path-probe.js';

/** What the scheduler needs from a session: the facts a decision needs, and nothing else. */
export interface GitFetchSessionView {
  id: string;
  workingDir: string;
  /** `unknown`, not `boolean`: a session's remote/Docker markers are objects, and the only question here is whether either is set at all. */
  remote?: unknown;
  docker?: unknown;
  gitFetchEnabled?: boolean;
  gitFetchIntervalSeconds?: number;
}

export interface GitFetchPorts {
  sessionIds(): Iterable<string>;
  getSession(id: string): GitFetchSessionView | undefined;
  /** Read FRESH every tick; that is the whole point of the tick-driven shape. */
  readSettings(): Promise<GitFetchSettings>;
  dockerWorkspaces(): Promise<string[]>;
  /**
   * Bounded probe (rule #516), default options: a bulk scan keeps the stall cap, so this must not be called
   * with `pastCap`. Anything that is not `directory` — including `unknown`, which is never `absent` — is
   * skipped, not fetched.
   */
  probePath(path: string): Promise<PathProbeKind>;
  /** Called through `fetchWorkspaceOnce`, so a run already going for this folder is joined, not stacked. */
  fetch(cwd: string, opts: GitFetchOptions): Promise<GitFetchReport>;
  publish(id: string, status: GitFetchStatus): void;
  log?(message: string): void;
}

/**
 * What one session will actually do: its own override wins, otherwise the app-wide setting. The interval is
 * clamped again here because a persisted value can predate the schema's bounds.
 */
export function effectiveGitFetch(
  view: GitFetchSessionView,
  settings: GitFetchSettings
): { enabled: boolean; intervalSeconds: number } {
  return {
    enabled: view.gitFetchEnabled ?? settings.enabled,
    intervalSeconds: clampInt(
      view.gitFetchIntervalSeconds ?? settings.intervalSeconds,
      MIN_GIT_FETCH_INTERVAL_SECONDS,
      MAX_GIT_FETCH_INTERVAL_SECONDS,
      MIN_GIT_FETCH_INTERVAL_SECONDS
    ),
  };
}

export class GitFetchScheduler {
  private readonly ports: GitFetchPorts;
  /** When each FOLDER last started a run; timed from the start, not the end. */
  private readonly lastRunAt = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  /** Session → folder, so `remove()` can keep the folder's schedule while other sessions are still on it. */
  private readonly folderOf = new Map<string, string>();
  private running = false;
  private stopped = false;

  constructor(ports: GitFetchPorts) {
    this.ports = ports;
  }

  /** One tick: fetch every folder whose sessions are on and due. Returns how many folders ran. */
  async tick(now = Date.now()): Promise<number> {
    if (this.stopped || this.running) return 0;
    this.running = true;
    try {
      let settings: GitFetchSettings;
      try {
        settings = await this.ports.readSettings();
      } catch (err) {
        // A read can land mid-write. Skipping this tick costs one interval; deciding from a fallback would
        // hold the feature off until the next settings change.
        this.ports.log?.(`git fetch: settings unreadable, tick skipped: ${getErrorMessage(err)}`);
        return 0;
      }

      // One entry per folder, holding every session open on it. Stamped here, at selection: a tick that is
      // still running must not pick the same folder again, and a folder already being fetched is not picked
      // at all.
      const due = new Map<string, GitFetchSessionView[]>();
      for (const id of this.ports.sessionIds()) {
        const view = this.ports.getSession(id);
        if (!view || view.remote || view.docker) continue;
        const effective = effectiveGitFetch(view, settings);
        if (!effective.enabled) continue;
        const folder = resolve(view.workingDir);
        // Recorded for EVERY session on the folder, not just the one that got picked, so `remove()` can still
        // see who is open on it when the session holding the override is the one that closes.
        this.folderOf.set(id, folder);
        // A session on a folder this tick already picked is the same clone: it joins that folder's run rather
        // than starting its own. Two fetches in one clone collide on git's ref lock, so one run has to serve
        // every session open on the folder.
        const group = due.get(folder);
        if (group) {
          group.push(view);
          continue;
        }
        if (this.inFlight.has(folder)) continue;
        const started = this.lastRunAt.get(folder);
        if (started !== undefined && now - started < effective.intervalSeconds * 1000) continue;
        const kind = await this.ports.probePath(view.workingDir);
        if (kind !== 'directory') {
          this.ports.log?.(`git fetch: ${view.id} skipped, folder answered ${kind}`);
          continue;
        }
        this.inFlight.add(folder);
        // The clock starts at the selection, so a slow folder does not shift its own schedule.
        this.lastRunAt.set(folder, now);
        due.set(folder, [view]);
      }
      if (!due.size) return 0;

      // Only now, because nothing above needs it: a quiet tick does not read the Docker case list.
      const dockerWorkspaces = await this.ports.dockerWorkspaces();
      // ONE bound for the git processes of the whole tick, handed to every run so no folder gets its own:
      // each fetch is one git process, and a folder can hold up to `MAX_REPOS_LIMIT` of them, so a bound per
      // run would let `FETCH_CONCURRENCY` folders × `MAX_REPOS_LIMIT` processes run at once.
      const fetches = createLimiter(FETCH_CONCURRENCY);
      // The folders get their OWN bound, because the same semaphore cannot serve both levels: a folder that
      // holds a slot and then waits for a slot for its own fetch is waiting on itself — once
      // `FETCH_CONCURRENCY` folders fill the bound, the ones holding slots are exactly the ones that can
      // never get one back. Both bounds are `FETCH_CONCURRENCY`, so the tick still never runs more git
      // processes than the module's ceiling.
      await mapLimited([...due.entries()], FETCH_CONCURRENCY, async ([folder, group]) => {
        try {
          const report = await this.ports.fetch(folder, {
            dockerWorkspaces,
            maxRepos: MAX_REPOS,
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
            limiter: fetches,
          });
          for (const view of group) this.ports.publish(view.id, gitFetchStatusFrom(report, 'interval'));
        } catch (err) {
          // The run that failed keeps its reason in the panel's own row; here only the folder-level failure is
          // worth a line, because nothing else would say a scheduled fetch could not run at all.
          this.ports.log?.(`git fetch: ${folder} could not run: ${getErrorMessage(err)}`);
        } finally {
          this.inFlight.delete(folder);
        }
      });
      return due.size;
    } finally {
      this.running = false;
    }
  }

  /**
   * A session that closed or was detached: its schedule goes with it, but the FOLDER's stays while another
   * session is still open on it — the run belongs to the clone, not to the session that asked for it.
   */
  remove(id: string): void {
    const folder = this.folderOf.get(id);
    this.folderOf.delete(id);
    if (!folder) return;
    const stillOpen = [...this.folderOf.values()].includes(folder);
    if (!stillOpen) {
      this.lastRunAt.delete(folder);
      this.inFlight.delete(folder);
    }
  }

  stop(): void {
    this.stopped = true;
    this.lastRunAt.clear();
    this.inFlight.clear();
    this.folderOf.clear();
  }

  /** Folders the scheduler still remembers a run for, so a test can see a `remove()` actually took. */
  tracked(): number {
    return new Set([...this.lastRunAt.keys(), ...this.inFlight]).size;
  }
}
