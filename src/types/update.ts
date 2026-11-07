/**
 * @fileoverview Types for the in-app self-updater.
 *
 * Codeman can update itself from the web UI (App Settings → Updates). The flow
 * is driven by a detached `scripts/self-update.sh` that outlives the service
 * restart it triggers, and a status file at `~/.codeman/update-status.json`
 * (see `dataPath('update-status.json')`) that the browser polls across the
 * restart boundary.
 *
 * The Docker Compose deployment updates in place too (same script, same status
 * file) — see `docs/docker-self-update.md` for how the container restarts itself
 * and what the environment gate refuses.
 *
 * Backend logic: `src/web/self-update.ts`. Routes: `src/web/routes/system-routes.ts`
 * (`/api/system/update/check`, `POST /api/system/update`, `/api/system/update/status`).
 *
 * @module types/update
 */

/**
 * Which init system supervises the running server (decides how we restart it).
 * `launchd-daemon` = a KeepAlive system-level LaunchDaemon (headless Macs, no GUI
 * login): restart works by killing the server and letting launchd respawn it.
 * `docker-compose` = the Compose deployment (`docker/docker-compose.yaml`): the
 * "restart" is the server exiting so the container's `restart: unless-stopped`
 * policy relaunches it on the freshly built `dist/`.
 */
export type SupervisorKind = 'systemd' | 'launchd' | 'launchd-daemon' | 'docker-compose' | 'none';

/**
 * How Codeman was installed. `git` and `docker-compose` can self-update in
 * place; `docker-compose` is a git checkout bind-mounted into the container, so
 * the pull/build happen on the host filesystem and survive container recreation.
 * `archive` is what `install.sh` leaves on a machine with no working git (its
 * no-admin route): the source unpacked from an archive, with nothing for the
 * in-app updater to pull into, so it updates by re-running the installer.
 */
export type InstallKind = 'git' | 'docker-compose' | 'npm' | 'archive' | 'unknown';

/**
 * Why an in-place container update is refused. Each is derived mechanically from
 * the target release's own files — nothing here depends on a human remembering
 * to declare something at release time.
 *
 * - `dockerfile-changed` / `compose-changed`: the release changes the ENVIRONMENT,
 *   which a self-restart cannot apply (a restart reuses the existing container's
 *   image and config). Needs a rebuild + recreate from the host.
 * - `env-keys-missing`: the release's `docker/.env.example` gained keys the user's
 *   `docker/.env` has no value for. Compose interpolates an unset `${VAR}` to the
 *   EMPTY STRING and starts anyway, so without this check a new required setting
 *   arrives as a silently blank env var.
 * - `no-auto-restart`: the container's restart policy would not bring it back
 *   after the server exits, so applying the update would take Codeman down.
 */
export type EnvironmentBlockerKind = 'dockerfile-changed' | 'compose-changed' | 'env-keys-missing' | 'no-auto-restart';

/** One reason an in-place container update is refused, with UI-ready text. */
export interface EnvironmentBlocker {
  kind: EnvironmentBlockerKind;
  /** One-line explanation shown in App Settings → Updates. */
  message: string;
  /** Optional specifics (e.g. the names of the missing env keys). */
  details?: string[];
}

/**
 * Result of the environment gate for a candidate release. `checked: false` means
 * the gate did not run (not a container install, or the target tag's files could
 * not be read) — callers must not treat that as "no blockers".
 */
export interface EnvironmentGate {
  checked: boolean;
  blockers: EnvironmentBlocker[];
  /** The host command that resolves every blocker. */
  hostCommand: string;
}

/**
 * Lifecycle of a single update run. `idle`/`completed`/`failed`/
 * `completed-needs-manual-restart` are terminal; the rest are in-flight.
 */
export type UpdatePhase =
  | 'idle'
  | 'queued'
  | 'preparing'
  | 'stashing'
  | 'fetching'
  | 'checkout'
  | 'installing'
  | 'building'
  | 'restarting'
  | 'completed'
  | 'completed-needs-manual-restart'
  | 'failed';

/** Persisted update progress, written atomically by the updater + boot reconcile. */
export interface UpdateStatus {
  /** Nonce identifying this run; guards boot-reconcile against stale/foreign status. */
  updateId: string;
  phase: UpdatePhase;
  /** Human-readable one-liner for the UI. */
  message: string;
  /** Version the server was on when the update started. */
  fromVersion: string;
  /** Target version (parsed from the release tag). */
  toVersion?: string;
  /** Target git tag, e.g. `codeman@0.9.4`. */
  toTag?: string;
  /** Commit the repo was on before the update, for rollback. */
  prevSha?: string;
  /** Name of the stash holding local changes (when the tree was dirty), else null. */
  stashRef?: string | null;
  supervisor?: SupervisorKind;
  /** epoch ms — update start (freshness guard for boot reconcile). */
  startedAt: number;
  /** epoch ms — last write. */
  updatedAt: number;
  /** Populated on failure. */
  error?: string;
  /** Shown for the `none` supervisor — the command the user must run by hand. */
  manualRestartCommand?: string;
}

/** Describes the running install — drives whether/how the Updates UI is shown. */
export interface InstallInfo {
  installKind: InstallKind;
  installDir: string;
  /** Current git branch, or `HEAD` when detached (e.g. pinned to a release tag). */
  branch?: string;
  /** Uncommitted local changes present (true → updater will auto-stash). */
  dirty: boolean;
  supervisor: SupervisorKind;
  currentVersion: string;
  /** False when `CODEMAN_DISABLE_SELF_UPDATE=1`. */
  selfUpdateEnabled: boolean;
}

/** Result of "check for updates" — current vs. latest release. */
export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string | null;
  latestTag: string | null;
  updateAvailable: boolean;
  /** Release notes (markdown) when available from the GitHub API. */
  notes?: string | null;
  /** Link to the release page. */
  htmlUrl?: string | null;
  /** epoch ms of the check. */
  checkedAt: number;
  source: 'github-api' | 'git-ls-remote' | 'none';
  /** Environment gate for THIS candidate release (container installs only). */
  environment?: EnvironmentGate;
  error?: string;
}

/**
 * Role of a remote in the repository-status view.
 * - `tracking`: the current branch's `@{upstream}` remote (where `git pull` goes).
 * - `upstream`: the canonical project (a remote named `origin`/`upstream` that is
 *   not the tracking remote).
 * - `other`: anything else explicitly requested via `CODEMAN_UPDATE_REMOTES`.
 */
export type RepoRemoteRole = 'tracking' | 'upstream' | 'other';

/** A single incoming commit — present on the remote ref but not in local HEAD. */
export interface RepoIncomingCommit {
  /** Abbreviated SHA. */
  sha: string;
  /** Commit subject (first line). */
  subject: string;
}

/** Ahead/behind + incoming summary for local HEAD vs one remote's compare ref. */
export interface RepoRemoteStatus {
  /** Remote name, e.g. `origin`, `bitbucket`. */
  name: string;
  /** Remote URL (best-effort; empty if unresolved). */
  url: string;
  role: RepoRemoteRole;
  /** Ref HEAD is compared against, e.g. `origin/master`, `bitbucket/local`. */
  compareRef: string;
  /** Commits in local HEAD not on the remote ref (local-only / unpushed). */
  ahead: number;
  /** Commits on the remote ref not in local HEAD (incoming). */
  behind: number;
  /** Up to N most recent incoming commits (newest first). */
  incoming: RepoIncomingCommit[];
  /** Set when this remote could not be fetched/compared. */
  error?: string;
}

/** Result of the repository-status check across the configured remotes. */
export interface RepositoryStatusResult {
  /** epoch ms of the check. */
  checkedAt: number;
  /** False when this is not a git install (then `remotes` is empty + `error` set). */
  isGit: boolean;
  /** Current running version, for display. */
  currentVersion: string;
  remotes: RepoRemoteStatus[];
  /** Top-level error (e.g. not a git install, or no remotes resolved). */
  error?: string;
}
