/**
 * @fileoverview Bounded existence probe for user-chosen paths.
 *
 * A linked case can live on a network mount (NFS, SMB, sshfs). When that mount
 * goes unreachable, a hard mount makes `stat()` wait forever. A synchronous
 * probe (`existsSync`) on such a path blocks the event loop and freezes the
 * whole web server; even an async `stat()` never settles and permanently holds
 * one of libuv's few threadpool workers, which every other `fs`, `dns.lookup`
 * and `crypto` call in the process shares.
 *
 * The probe therefore answers one of THREE things, never two:
 * - `'present'` / `'absent'`: the filesystem answered (ENOENT and ENOTDIR are
 *   the only errors that mean absent);
 * - `'unknown'`: it did not answer in `PATH_PROBE_TIMEOUT_MS`, it answered with
 *   some other error (EIO from a soft mount that gave up, EACCES), or the probe
 *   was refused (below). "Unknown" is NOT "absent": a caller that would create,
 *   scaffold or 404 on absence must not do so on unknown.
 *
 * And it keeps a dead mount from draining the threadpool:
 * - one in-flight probe per path, shared by concurrent callers;
 * - a path whose probe timed out is "stalled" until that stat finally settles.
 *   Paths NEAR a stalled one are answered "unknown" without a new stat, so one
 *   dead mount costs one worker, not one per case and file on it. "Near" means on
 *   the same mount when that mount is a network or FUSE filesystem (NFS, SMB,
 *   sshfs and the like): under the deepest mount point holding the stalled path,
 *   with its type, read from `/proc/self/mounts` (procfs, which never waits on the
 *   dead filesystem). Otherwise it narrows to the stalled path and everything under
 *   it: when the deepest mount is local (a path typed under a local `/home` can
 *   reach a NAS through a symlink, and must not take the rest of `/home` with it),
 *   is `/`, or the table is unavailable (not Linux). Unrelated paths are probed
 *   normally;
 * - once `MAX_STALLED_PATH_PROBES` stalled stats are pending, new probes are
 *   refused process-wide (answered "unknown"), since each would risk another
 *   worker. Probes merely in flight do not count, so concurrent healthy probes
 *   never get refused. A caller acting on ONE path at a user's explicit request
 *   (opening a case, starting a session in it) may pass `{ pastCap: true }`: its
 *   probe is still bounded and still recorded as stalled if it hangs (so a dead
 *   path costs at most one worker however often it is retried), but it is not
 *   refused just because unrelated mounts are dead. Bulk scans (the case list)
 *   and per-spawn helpers keep the cap. `pastCap` still stops at
 *   `PATH_PROBE_STALL_CEILING` (the threadpool size minus one), so explicit
 *   requests against several dead paths can never take the last worker.
 *
 * Both events are logged once (`console.warn`): a path's first stall, and the
 * cap engaging, so "my case vanished" and "hooks stopped firing" leave a trace.
 *
 * Writers should not use this at all: a writer that must tell "missing" apart
 * from "unreachable" wants an ENOENT-aware async `lstat` (see
 * `pathExistsForWrite` in hooks-config.ts).
 *
 * @module utils/bounded-path-probe
 */

import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { MAX_STALLED_PATH_PROBES, PATH_PROBE_STALL_CEILING, PATH_PROBE_TIMEOUT_MS } from '../config/path-probe.js';

/** What a probe could establish about a path. */
export type PathProbeState = 'present' | 'absent' | 'unknown';
/** Like {@link PathProbeState}, with "present" split by whether it is a directory. */
export type PathProbeKind = 'directory' | 'file' | 'absent' | 'unknown';

const inFlight = new Map<string, Promise<PathProbeKind>>();
/** Stalled path -> the directory whose subtree is answered "unknown" while it stays stalled. */
const stalled = new Map<string, string>();
let capWarned = false;

async function statKind(path: string): Promise<PathProbeKind> {
  try {
    return (await fs.stat(path)).isDirectory() ? 'directory' : 'file';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unknown';
  }
}

function isWithin(path: string, root: string): boolean {
  if (path === root) return true;
  return path.startsWith(root.endsWith(sep) ? root : root + sep);
}

/** Filesystem types whose stall means the whole mount is gone (network and FUSE). */
const REMOTE_FS_TYPES = new Set([
  'nfs',
  'nfs4',
  'cifs',
  'smb3',
  'smbfs',
  '9p',
  'ceph',
  'glusterfs',
  'afs',
  'lustre',
  'davfs',
]);

function isRemoteFsType(fsType: string): boolean {
  return REMOTE_FS_TYPES.has(fsType) || fsType.startsWith('fuse.');
}

/** Deepest mount holding `abs`, from the kernel's mount table; undefined when unreadable. */
function mountOf(abs: string): { mountPoint: string; fsType: string } | undefined {
  let table: string;
  try {
    table = readFileSync('/proc/self/mounts', 'utf-8');
  } catch {
    return undefined;
  }
  let best: { mountPoint: string; fsType: string } | undefined;
  for (const line of table.split('\n')) {
    const [, field, fsType] = line.split(' ');
    if (!field || !fsType) continue;
    // The table octal-escapes space, tab, newline and backslash in mount points.
    const mountPoint = field.replace(/\\([0-7]{3})/g, (_m, oct: string) => String.fromCharCode(parseInt(oct, 8)));
    if (isWithin(abs, mountPoint) && (!best || mountPoint.length > best.mountPoint.length)) {
      best = { mountPoint, fsType };
    }
  }
  return best;
}

/**
 * The subtree a stalled path takes down with it (see the module comment): its
 * mount when that is a network or FUSE filesystem, else just the path itself.
 */
function stallScope(abs: string): string {
  const mount = mountOf(abs);
  return mount && mount.mountPoint !== '/' && isRemoteFsType(mount.fsType) ? mount.mountPoint : abs;
}

/**
 * Whether `path` is near a path whose probe is still stalled (see the module
 * comment), i.e. whether the probe would answer "unknown" for it without a stat.
 * Lets a caller tell "this workspace sits on the dead mount" apart from "the
 * probe was refused for capacity".
 */
export function isNearStalledPath(path: string): boolean {
  const abs = resolve(path);
  for (const scope of stalled.values()) {
    if (isWithin(abs, scope)) return true;
  }
  return false;
}

/** Options for {@link probePathKind} / {@link probePath}. */
export interface PathProbeOptions {
  /** Probe even while the stall cap is engaged (see the module comment). */
  pastCap?: boolean;
}

/**
 * Probe `path` without letting an unresponsive filesystem block the caller for
 * longer than `PATH_PROBE_TIMEOUT_MS`. Follows symlinks, like `stat()`.
 */
export async function probePathKind(path: string, options: PathProbeOptions = {}): Promise<PathProbeKind> {
  const abs = resolve(path);
  if (isNearStalledPath(abs)) return 'unknown';

  let probe = inFlight.get(abs);
  if (!probe) {
    // pastCap lifts the bulk cap, never the ceiling that keeps one worker free.
    if (stalled.size >= (options.pastCap ? PATH_PROBE_STALL_CEILING : MAX_STALLED_PATH_PROBES)) {
      if (!capWarned) {
        capWarned = true;
        console.warn(
          `[path-probe] ${stalled.size} path probes are stalled on unresponsive filesystems; ` +
            'not starting new ones until one answers (paths read as unknown meanwhile)'
        );
      }
      return 'unknown';
    }
    probe = statKind(abs);
    const started = probe;
    inFlight.set(abs, started);
    void started.finally(() => {
      inFlight.delete(abs);
      stalled.delete(abs);
      if (stalled.size < MAX_STALLED_PATH_PROBES) capWarned = false;
    });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      probe,
      new Promise<PathProbeKind>((resolveTimeout) => {
        timer = setTimeout(() => {
          if (inFlight.get(abs) === probe && !stalled.has(abs)) {
            stalled.set(abs, stallScope(abs));
            console.warn(
              `[path-probe] ${abs} did not answer within ${PATH_PROBE_TIMEOUT_MS} ms ` +
                '(unreachable mount?); treating it and its neighbours as unknown until it does'
            );
          }
          resolveTimeout('unknown');
        }, PATH_PROBE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Tri-state probe of `path`; see the module comment for what "unknown" means. */
export async function probePath(path: string, options: PathProbeOptions = {}): Promise<PathProbeState> {
  const kind = await probePathKind(path, options);
  return kind === 'directory' || kind === 'file' ? 'present' : kind;
}

/**
 * `true` only when `path` is known to exist. For DISPLAY decisions only (does a
 * case have a CLAUDE.md): it folds "unknown" into `false`, so never use it to
 * decide that something is absent and may be created, scaffolded or reported
 * missing; use {@link probePath} for that.
 */
export async function boundedPathExists(path: string): Promise<boolean> {
  return (await probePath(path)) === 'present';
}
