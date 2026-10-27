/**
 * @fileoverview Git fetch on an interval: the sessions the user turned on, fetched by a tick the server owns
 * (`src/git-fetch-scheduler.ts`, wired in `src/web/server.ts`).
 *
 * The fetch module (src/git-fetch.ts) is the only git command the Git panel runs that writes, and on a timer
 * it is the only one that can run without being asked (cloning and worktree management write too, but those
 * happen when the user asks for them). Which is why the whole feature is off until the user turns it on, in
 * Settings → Bottom bar, per session in Session Options → Git.
 *
 * The scheduler holds no timers of its own. The server ticks it (`GIT_FETCH_TICK_INTERVAL_MS`) and every
 * tick reads the app setting FRESH, so a live toggle takes effect on the next tick instead of at boot, and
 * turning the feature off actually stops the fetching. A session can override both the switch and the
 * interval; a session with no override follows the app.
 *
 * Rules the code keeps and the tests pin:
 *   - Nothing runs when nothing is on: no repository set is read and nothing is spawned, so a quiet
 *     install costs one settings read per tick. A session that turned itself on still runs even while the
 *     app-wide switch is off: that is what a per-session switch has to mean.
 *   - Remote and Docker sessions are never fetched, exactly as the Git panel excludes them, and the Docker
 *     workspace roots are checked again every tick, so a session whose case became a Docker case stops
 *     fetching at the next tick. A Docker case list that cannot be read fails CLOSED: the tick fetches
 *     nothing (a fetch runs a repository's hooks, and without the list nothing tells which folders a
 *     container can write to), the folders it picked stay due for the next tick, and it is logged once
 *     until a read succeeds again.
 *   - A folder is fetched by at most one run at a time, and the run belongs to the FOLDER, not to one
 *     session: two sessions open on the same folder are the same clone, so they share one run and both get
 *     its result. State is keyed by `resolve(workingDir)`, deliberately not `realpath`, because `realpath`
 *     is itself one of the unbounded fs calls rule #516 bounds; the bounded probe below is the fs read.
 *     Every session open on a folder is remembered, so closing the one holding the override does not stop
 *     the folder's fetching while another session is still on it. A folder is due when ANY session open on it
 *     is due, and the tick decides that per folder in a second pass: the order the sessions were read cannot
 *     change which interval wins, so a 30 s session on a folder a 3600 s session last fetched ten minutes ago
 *     is fetched now. The folder is probed once, not once per session on it.
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
 *     own interval. A settings read that fails skips this tick only, rather than deciding from defaults.
 *     settings.json is replaced atomically, so such a failure is a file that does not parse (a hand edit) or
 *     a real read error, which lasts until someone fixes it: it is logged once, and again only after a read
 *     has succeeded in between, not every 15 s tick.
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
  type GitFetchRun,
  type GitFetchSettings,
  type GitFetchStatus,
  type GitFetchTrigger,
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

/** A session open on a folder, with the interval that makes IT due. One folder's sessions are a group. */
interface GroupMember {
  view: GitFetchSessionView;
  intervalSeconds: number;
}

export interface GitFetchPorts {
  sessionIds(): Iterable<string>;
  getSession(id: string): GitFetchSessionView | undefined;
  /** Read FRESH every tick; that is the whole point of the tick-driven shape. */
  readSettings(): Promise<GitFetchSettings>;
  /**
   * Host paths of every Docker case workspace. REJECTS when the list exists but cannot be read or parsed; the
   * tick then fetches nothing and the folders it picked are due again on the next tick.
   */
  dockerWorkspaces(): Promise<string[]>;
  /**
   * Bounded probe (rule #516), default options: a bulk scan keeps the stall cap, so this must not be called
   * with `pastCap`. Anything that is not `directory` (including `unknown`, which is never `absent`) is
   * skipped, not fetched.
   */
  probePath(path: string): Promise<PathProbeKind>;
  /** Called through `fetchWorkspaceOnce`, so a run already going for this folder is joined, not stacked. */
  fetch(cwd: string, opts: GitFetchOptions, trigger: GitFetchTrigger): Promise<GitFetchRun>;
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
  /** The last settings read failed and was logged; cleared by the next read that succeeds. */
  private settingsUnreadable = false;
  /** The same for the Docker case list. */
  private dockerCasesUnreadable = false;

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
        // Writes are atomic, so this is a real read error or a file that does not parse (a hand edit), and it
        // stays that way until it is fixed: logged once, not on every tick. The reader never puts the file's
        // text in its error (readGitFetchSettings), since settings.json can hold an API key.
        if (!this.settingsUnreadable) {
          this.settingsUnreadable = true;
          this.ports.log?.(
            `git fetch: settings unreadable, ticks skipped until it reads again: ${getErrorMessage(err)}`
          );
        }
        return 0;
      }
      this.settingsUnreadable = false;

      // Pass 1: who is on what, before anything is decided. Every session open on a folder is recorded here,
      // not only the one that would get picked, so `remove()` can still see who is open on it when the session
      // holding the override is the one that closes.
      const groups = new Map<string, GroupMember[]>();
      for (const id of this.ports.sessionIds()) {
        const view = this.ports.getSession(id);
        if (!view || view.remote || view.docker) continue;
        const effective = effectiveGitFetch(view, settings);
        if (!effective.enabled) continue;
        const folder = resolve(view.workingDir);
        this.folderOf.set(id, folder);
        const group = groups.get(folder);
        const member = { view, intervalSeconds: effective.intervalSeconds };
        if (group) group.push(member);
        else groups.set(folder, [member]);
      }

      // Pass 2: the folder's turn, decided from the whole group rather than from whichever session happened to
      // be read first. A folder is due when ANY session open on it is due: a session on a 30 s interval on a
      // folder a 3600 s session last fetched ten minutes ago has to be fetched now, because that same run
      // satisfies the long interval too. Deciding in one pass means the session read first owns the clock: a
      // group ordered [short, long] and a group ordered [long, short] would have behaved differently, and the
      // run belongs to the folder, so no session in the group should.
      const due = new Map<string, GroupMember[]>();
      // What each picked folder's clock said before this tick stamped it, so a tick that ends up fetching
      // nothing (an unreadable Docker case list, below) can leave the folders due again.
      const stampedOver = new Map<string, number | undefined>();
      for (const [folder, group] of groups) {
        if (this.inFlight.has(folder)) continue;
        const started = this.lastRunAt.get(folder);
        const isDue = started === undefined || group.some((m) => now - started >= m.intervalSeconds * 1000);
        if (!isDue) continue;
        // Bounded probe (rule #516), once per folder rather than once per session on it.
        const kind = await this.ports.probePath(folder);
        if (kind !== 'directory') {
          this.ports.log?.(`git fetch: ${folder} skipped, answered ${kind}`);
          continue;
        }
        this.inFlight.add(folder);
        // The clock starts at the selection, so a slow folder does not shift its own schedule.
        stampedOver.set(folder, started);
        this.lastRunAt.set(folder, now);
        due.set(folder, group);
      }
      if (!due.size) return 0;

      // Only now, because nothing above needs it: a quiet tick does not read the Docker case list.
      let dockerWorkspaces: string[];
      try {
        dockerWorkspaces = await this.ports.dockerWorkspaces();
      } catch (err) {
        // Fail CLOSED: a fetch runs the repository's hooks, and without the list nothing tells which folders a
        // container can write to. Nothing ran, so the picks are undone (a stamp a `remove()` already cleared
        // stays cleared) and the folders are due again on the next tick instead of after their interval.
        for (const [folder, started] of stampedOver) {
          this.inFlight.delete(folder);
          if (this.lastRunAt.get(folder) !== now) continue;
          if (started === undefined) this.lastRunAt.delete(folder);
          else this.lastRunAt.set(folder, started);
        }
        if (!this.dockerCasesUnreadable) {
          this.dockerCasesUnreadable = true;
          this.ports.log?.(
            `git fetch: Docker case list unreadable, nothing fetched until it reads again: ${getErrorMessage(err)}`
          );
        }
        return 0;
      }
      this.dockerCasesUnreadable = false;
      // ONE bound for the git processes of the whole tick, handed to every run so no folder gets its own:
      // each fetch is one git process, and a folder can hold up to `MAX_REPOS_LIMIT` of them, so a bound per
      // run would let `FETCH_CONCURRENCY` folders × `MAX_REPOS_LIMIT` processes run at once.
      const fetches = createLimiter(FETCH_CONCURRENCY);
      // The folders get their OWN bound, because the same semaphore cannot serve both levels: a folder that
      // holds a slot and then waits for a slot for its own fetch is waiting on itself: once
      // `FETCH_CONCURRENCY` folders fill the bound, the ones holding slots are exactly the ones that can
      // never get one back. Both bounds are `FETCH_CONCURRENCY`, so the tick still never runs more git
      // processes than the module's ceiling.
      await mapLimited([...due.entries()], FETCH_CONCURRENCY, async ([folder, group]) => {
        try {
          const run = await this.ports.fetch(
            folder,
            {
              dockerWorkspaces,
              maxRepos: MAX_REPOS,
              timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
              limiter: fetches,
            },
            'interval'
          );
          // Every session on the folder gets the SAME run, with the trigger of the run that actually happened:
          // if this tick joined a run a click had already started, the row has to say it was a click, because
          // that is what fetched it.
          for (const member of group) this.ports.publish(member.view.id, gitFetchStatusFrom(run.report, run.trigger));
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
   * session is still open on it: the run belongs to the clone, not to the session that asked for it.
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
