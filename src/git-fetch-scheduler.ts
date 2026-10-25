/**
 * @fileoverview Git fetch on an interval: the cases the user turned on, fetched by a tick the server owns
 * (`src/git-fetch-scheduler.ts`, wired in `src/web/server.ts`).
 *
 * The fetch module (src/git-fetch.ts) is the only place Codeman runs a git command that writes, and on a
 * timer it is the only one that can run without being asked — which is why the whole feature is off until
 * the user turns it on, in Settings → Bottom bar, per case in Session Options → Git.
 *
 * The scheduler holds no timers of its own. The server ticks it (`GIT_FETCH_TICK_INTERVAL_MS`) and every
 * tick reads the app setting FRESH, so a live toggle takes effect on the next tick instead of at boot, and
 * turning the feature off actually stops the fetching. A case can override both the switch and the
 * interval; a case with no override follows the app.
 *
 * Rules the code keeps and the tests pin:
 *   - Nothing runs when nothing is on: no repository set is read and nothing is spawned, so a quiet
 *     install costs one settings read per tick. A case that turned itself on still runs even while the
 *     app-wide switch is off — that is what a per-case switch has to mean.
 *   - Remote and Docker cases are never fetched, exactly as the Git panel excludes them, and the Docker
 *     workspace roots are checked again every tick, so a case that became a Docker case stops fetching at
 *     the next tick.
 *   - One run per case at a time: a tick skips a case still being fetched rather than stacking runs on it.
 *   - At most `FETCH_CONCURRENCY` cases at a time across all of them, because each is a git process.
 *   - The interval is timed from the START of a run, so a run that takes three minutes does not push the
 *     next one out by three minutes; it lands on the tick after its own interval elapses.
 *   - The per-repository limit and the git timeout stay the module's defaults (`MAX_REPOS`,
 *     `DEFAULT_GIT_TIMEOUT_MS`): both settings are per device and never reach the server, so the server
 *     cannot know what a device chose.
 *   - A failure is reported, not retried harder: the case keeps its reason and gets its next run at its
 *     own interval. A settings read that fails skips this tick only, because settings.json is rewritten in
 *     place and a kept fallback would hold the feature off until the next settings change.
 *
 * @module git-fetch-scheduler
 */

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
import { clampInt, DEFAULT_GIT_TIMEOUT_MS, MAX_REPOS, mapLimited } from './git-workspace-status.js';

/** What the scheduler needs from a case: the facts a decision needs, and nothing else. */
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
  fetch(cwd: string, opts: GitFetchOptions): Promise<GitFetchReport>;
  publish(id: string, status: GitFetchStatus): void;
  log?(message: string): void;
}

/**
 * What one case will actually do: its own override wins, otherwise the app-wide setting. The interval is
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
  /** When each case last started a run; timed from the start, not the end. */
  private readonly lastRunAt = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private stopped = false;

  constructor(ports: GitFetchPorts) {
    this.ports = ports;
  }

  /** One tick: fetch every case that is on and due. Returns how many ran. */
  async tick(now = Date.now()): Promise<number> {
    if (this.stopped) return 0;

    let settings: GitFetchSettings;
    try {
      settings = await this.ports.readSettings();
    } catch (err) {
      // A read can land mid-write. Skipping this tick costs one interval; deciding from a fallback would
      // hold the feature off until the next settings change.
      this.ports.log?.(`git fetch: settings unreadable, tick skipped: ${getErrorMessage(err)}`);
      return 0;
    }

    const due: GitFetchSessionView[] = [];
    for (const id of this.ports.sessionIds()) {
      const view = this.ports.getSession(id);
      if (!view || view.remote || view.docker) continue;
      const effective = effectiveGitFetch(view, settings);
      if (!effective.enabled || this.inFlight.has(id)) continue;
      const started = this.lastRunAt.get(id);
      if (started !== undefined && now - started < effective.intervalSeconds * 1000) continue;
      due.push(view);
    }
    if (!due.length) return 0;

    // Only now, because nothing above needs it: a quiet tick does not read the Docker case list.
    const dockerWorkspaces = await this.ports.dockerWorkspaces();
    await mapLimited(due, FETCH_CONCURRENCY, async (view) => {
      this.inFlight.add(view.id);
      // The clock starts at the run, so a slow repository does not shift the case's own schedule.
      this.lastRunAt.set(view.id, now);
      try {
        const report = await this.ports.fetch(view.workingDir, {
          dockerWorkspaces,
          maxRepos: MAX_REPOS,
          timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
        });
        this.ports.publish(view.id, gitFetchStatusFrom(report, 'interval'));
      } catch (err) {
        // The run that failed keeps its reason in the panel's own row; here only the case-level failure is
        // worth a line, because nothing else would say a scheduled fetch could not run at all.
        this.ports.log?.(`git fetch: ${view.id} could not run: ${getErrorMessage(err)}`);
      } finally {
        this.inFlight.delete(view.id);
      }
    });
    return due.length;
  }

  /** A case that closed or was detached: its schedule and its in-flight flag go with it. */
  remove(id: string): void {
    this.lastRunAt.delete(id);
    this.inFlight.delete(id);
  }

  stop(): void {
    this.stopped = true;
    this.lastRunAt.clear();
    this.inFlight.clear();
  }

  /** Cases the scheduler still remembers a run for, so a test can see a `remove()` actually took. */
  tracked(): number {
    return new Set([...this.lastRunAt.keys(), ...this.inFlight]).size;
  }
}
