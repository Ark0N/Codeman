/**
 * @fileoverview Remote Claude transcript history — a per-host local cache of
 * `~/.claude/projects` pulled over the host's own ssh settings.
 *
 * WHY
 * ---
 * Everything Codeman knows about past conversations (the history list, the
 * response viewer, sub-agent windows) is read from the local
 * `~/.claude/projects` tree. A remote case runs the CLI on another machine, so
 * its transcripts live there and none of those views can see them: the host
 * shows up with a terminal and nothing else.
 *
 * Rather than teach every scanner to read over ssh (one round trip per file,
 * and the sub-agent watcher relies on `fs.watch`), this module keeps a local
 * mirror per remote host under `<data dir>/remote-claude/<hostId>/projects/`,
 * refreshed with one `rsync` per host per cycle. The scanners then treat each
 * mirror as one more "projects root" — see `listClaudeProjectRoots()` — and
 * stamp rows with the host they came from. The mirror also outlives the host:
 * a halted VM's conversations stay readable.
 *
 * DISCIPLINE (shared with the other remote modules)
 * - Transport is `buildSshConnectionArgs()`, so identity/jump/proxy/extra
 *   options are exactly those of the launch command. Nothing to configure twice.
 * - One `runWithRemoteSshLimit()` slot per host per cycle — the limiter is not
 *   re-entrant, and rsync is a single ssh connection anyway.
 * - Read-only: `rsync` is pointed FROM the host TO the cache. The cache never
 *   flows back.
 * - `process.env.VITEST` → no ssh, ever. Tests exercise the root listing with
 *   real directories and the cycle with an injected runner.
 * - Opt-in: `settings.json` → `remoteHistory.enabled` (default off). A feature
 *   that opens connections on a timer must not surprise an upgrade.
 */

import { execFile } from 'node:child_process';
import { mkdir, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { claudeProjectsDir } from './utils/claude-transcript.js';
import { buildSshConnectionArgs, readRemoteHosts, remoteSshTarget } from './remote-hosts.js';
import { runWithRemoteSshLimit } from './remote-ssh-limiter.js';
import type { RemoteHost } from './types/session.js';

const execFileAsync = promisify(execFile);

/** Default refresh cadence. A transcript is append-only, so rsync deltas are cheap. */
export const DEFAULT_SYNC_INTERVAL_SEC = 60;
export const MIN_SYNC_INTERVAL_SEC = 15;
export const MAX_SYNC_INTERVAL_SEC = 3600;
/** Hard cap on one rsync run (the first pull of a large tree can take a minute). */
const RSYNC_TIMEOUT_MS = 10 * 60 * 1000;
/** rsync's own idle timeout, so a host that vanishes mid-transfer frees the slot. */
const RSYNC_IO_TIMEOUT_SEC = 60;

/** One scanning root: the local tree, or a host's mirror. */
export type ClaudeProjectRoot = {
  projectsDir: string;
  /** Set for a remote host's mirror; absent for the local tree. */
  hostId?: string;
  hostLabel?: string;
};

export type RemoteClaudeSyncStatus = {
  hostId: string;
  hostLabel: string;
  running: boolean;
  lastStartedAt?: number;
  lastOkAt?: number;
  lastDurationMs?: number;
  lastError?: string;
  consecutiveFailures: number;
};

export function remoteClaudeCacheDir(dataDir: string, hostId: string): string {
  return join(dataDir, 'remote-claude', hostId);
}

export function remoteClaudeProjectsDir(dataDir: string, hostId: string): string {
  return join(remoteClaudeCacheDir(dataDir, hostId), 'projects');
}

/**
 * The local projects tree first, then one root per remote host whose mirror
 * exists on disk. A host with no mirror yet (sync off, or never reached) is
 * simply absent, so callers never scan an empty directory or invent a host.
 */
export async function listClaudeProjectRoots(dataDir: string): Promise<ClaudeProjectRoot[]> {
  const roots: ClaudeProjectRoot[] = [{ projectsDir: claudeProjectsDir() }];
  const hosts = await readRemoteHosts(dataDir);
  for (const host of hosts) {
    const projectsDir = remoteClaudeProjectsDir(dataDir, host.id);
    try {
      if (!(await stat(projectsDir)).isDirectory()) continue;
    } catch {
      continue;
    }
    roots.push({ projectsDir, hostId: host.id, hostLabel: host.label || host.id });
  }
  return roots;
}

/** The root a given host id maps to, or undefined when it has no mirror. */
export async function claudeProjectRootForHost(
  dataDir: string,
  hostId: string
): Promise<ClaudeProjectRoot | undefined> {
  const roots = await listClaudeProjectRoots(dataDir);
  return roots.find((r) => r.hostId === hostId);
}

/**
 * The rsync argv for one host. Exported for tests and for `codeman doctor`-style
 * inspection; it carries the shellescaped ssh line in `-e`, which rsync hands to
 * `/bin/sh -c`, so the escaping discipline of `buildSshConnectionArgs()` is what
 * keeps a path with spaces (identity file, jump host) one token.
 */
export function buildRsyncArgs(host: RemoteHost, cacheProjectsDir: string): string[] {
  const ssh = buildSshConnectionArgs(host).join(' ');
  return [
    '-az',
    '--delete',
    '--delete-excluded',
    '--partial',
    `--timeout=${RSYNC_IO_TIMEOUT_SEC}`,
    // Only the transcripts and their sidecars. Everything else under ~/.claude
    // (credentials, caches, shell snapshots) must never leave the host.
    '--include=*/',
    '--include=*.jsonl',
    '--include=*.json',
    '--exclude=*',
    '-e',
    ssh,
    `${remoteSshTarget(host)}:.claude/projects/`,
    `${cacheProjectsDir}/`,
  ];
}

export type RsyncRunner = (args: string[]) => Promise<void>;

const defaultRunner: RsyncRunner = async (args) => {
  await execFileAsync('rsync', args, { timeout: RSYNC_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 });
};

/**
 * Pull every configured host's transcripts on a timer. Hosts are read fresh each
 * cycle, so one added through the UI is picked up without a restart.
 */
export class RemoteClaudeSync {
  private timer: NodeJS.Timeout | undefined;
  private cycleRunning = false;
  private readonly status = new Map<string, RemoteClaudeSyncStatus>();

  constructor(
    private readonly dataDir: string,
    private readonly opts: {
      isEnabled: () => boolean;
      intervalSec: () => number;
      runner?: RsyncRunner;
      log?: (msg: string) => void;
    }
  ) {}

  start(): void {
    if (this.timer) return;
    const tick = () => {
      void this.runCycle();
      const sec = Math.min(MAX_SYNC_INTERVAL_SEC, Math.max(MIN_SYNC_INTERVAL_SEC, this.opts.intervalSec()));
      this.timer = setTimeout(tick, sec * 1000);
      this.timer.unref?.();
    };
    tick();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  getStatus(): RemoteClaudeSyncStatus[] {
    return Array.from(this.status.values());
  }

  /** One pass over every host. Serialised: a slow host never stacks cycles. */
  async runCycle(): Promise<void> {
    if (this.cycleRunning) return;
    if (process.env.VITEST && !this.opts.runner) return;
    if (!this.opts.isEnabled()) return;
    this.cycleRunning = true;
    try {
      const hosts = await readRemoteHosts(this.dataDir);
      for (const host of hosts) {
        await this.syncHost(host);
      }
    } finally {
      this.cycleRunning = false;
    }
  }

  async syncHost(host: RemoteHost): Promise<void> {
    const st: RemoteClaudeSyncStatus = this.status.get(host.id) ?? {
      hostId: host.id,
      hostLabel: host.label || host.id,
      running: false,
      consecutiveFailures: 0,
    };
    st.hostLabel = host.label || host.id;
    this.status.set(host.id, st);
    if (st.running) return;

    const cacheProjectsDir = remoteClaudeProjectsDir(this.dataDir, host.id);
    st.running = true;
    st.lastStartedAt = Date.now();
    const run = this.opts.runner ?? defaultRunner;
    try {
      await mkdir(cacheProjectsDir, { recursive: true });
      await runWithRemoteSshLimit(() => run(buildRsyncArgs(host, cacheProjectsDir)));
      st.lastOkAt = Date.now();
      st.lastDurationMs = st.lastOkAt - st.lastStartedAt;
      st.lastError = undefined;
      st.consecutiveFailures = 0;
    } catch (err) {
      st.consecutiveFailures += 1;
      st.lastError = summariseError(err);
      // Log the first failure and then every tenth: an unreachable host (asleep,
      // halted) is normal and must not fill the log every minute.
      if (st.consecutiveFailures === 1 || st.consecutiveFailures % 10 === 0) {
        this.opts.log?.(
          `[RemoteClaudeSync] ${host.label || host.id}: ${st.lastError} (${st.consecutiveFailures} in a row)`
        );
      }
    } finally {
      st.running = false;
    }
  }
}

function summariseError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { code?: string | number; killed?: boolean; stderr?: string; message?: string };
    if (e.code === 'ENOENT') return 'rsync is not installed on this machine';
    if (e.killed) return 'rsync timed out';
    const stderr = (e.stderr ?? '').toString().trim().split('\n').filter(Boolean).pop();
    if (stderr) return stderr;
    if (e.message) return e.message.split('\n')[0];
  }
  return String(err);
}

/** Number of mirrored project directories for a host — a cheap "is there anything" probe. */
export async function countMirroredProjects(dataDir: string, hostId: string): Promise<number> {
  try {
    return (await readdir(remoteClaudeProjectsDir(dataDir, hostId))).length;
  } catch {
    return 0;
  }
}
