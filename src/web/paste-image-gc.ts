/**
 * @fileoverview Periodic GC for prompt-upload files, and the one place that
 * names the directories they live in.
 *
 * Without cleanup, /api/sessions/:id/paste-image accumulates files indefinitely
 * under {workingDir}/.codeman-uploads/. The route only triggers cleanup on
 * killMux=true session deletion, so long-lived sessions can fill disk under
 * heavy pasting. This sweeper bounds disk use by deleting `paste-*` files
 * older than MAX_AGE_MS from each live session's upload dirs on an interval.
 *
 * Conservative defaults — only files matching the `paste-` prefix are
 * considered, and we lstat (not stat) so a planted symlink cannot escape the
 * upload dir.
 */
import fs from 'node:fs/promises';
import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { getDataDir } from '../config/instance.js';
import type { SessionPort } from './ports/index.js';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const INITIAL_DELAY_MS = 30 * 1000; // 30s after startup

/**
 * Where a prompt upload is written, relative to the session's working
 * directory. IN the workspace, because that is the only path that resolves
 * identically for a local agent and a container (only the workspace is
 * bind-mounted, at the same absolute path); hidden, so it stays out of
 * `git status` and the agent's view of the repository; FLAT, because a nested
 * `<workspace>/.codeman/` is Codeman's own data dir when the workspace is the
 * home directory; and self-ignoring, through a `.gitignore` of `*` the route
 * writes once.
 */
export const UPLOADS_DIR = '.codeman-uploads';
/** Where uploads landed before the move: written to by nothing, readable for one release. */
export const LEGACY_UPLOADS_DIR = '.claude-images';
/** Every upload dir name, current first. Retiring the legacy one here retires it for every reader. */
export const UPLOAD_DIR_NAMES = [UPLOADS_DIR, LEGACY_UPLOADS_DIR];

/**
 * Every directory a session's uploads sit in, current first. Both consumers
 * act on what this returns, the hourly sweep and the recursive delete in
 * cleanupSession(), so it lists only REAL directories (a link planted by a
 * workspace script, `.codeman-uploads -> /other-case/.codeman-uploads`, is
 * not one; readdir follows a link to a directory), none that is, contains or
 * sits inside this instance's data dir (a home workspace reaches it under a
 * contrived instance name, `CODEMAN_INSTANCE=uploads`, and `CODEMAN_DATA_DIR`
 * can point inside one), and nothing for a remote (SSH) session, whose
 * workingDir is the remote path and would name a same-named LOCAL directory
 * here. The check is made when listing: a same-user process that swaps a
 * listed directory for a link afterwards is accepted, since it already writes
 * anywhere this process can.
 */
export function uploadDirs(session: { workingDir: string; remote?: unknown }): string[] {
  if (session.remote) return [];
  const dataDir = canonicalDir(getDataDir());
  return UPLOAD_DIR_NAMES.map((name) => join(session.workingDir, name)).filter((dir) => {
    if (!isRealDir(dir)) return false;
    const real = canonicalDir(dir);
    return real !== dataDir && !real.startsWith(dataDir + sep) && !dataDir.startsWith(real + sep);
  });
}

/** lstat, so a symlink is not a directory, whatever it points at. */
function isRealDir(p: string): boolean {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

export async function sweepPasteImagesOnce(
  ctx: Pick<SessionPort, 'sessions'>,
  now: number = Date.now()
): Promise<{ scanned: number; deleted: number }> {
  const cutoff = now - MAX_AGE_MS;
  let scanned = 0;
  let deleted = 0;
  for (const session of ctx.sessions.values()) {
    for (const dir of uploadDirs(session)) {
      let entries: string[];
      try {
        entries = await fs.readdir(dir);
      } catch {
        continue; // gone since listed — nothing to do
      }
      for (const name of entries) {
        if (!name.startsWith('paste-')) continue;
        const p = join(dir, name);
        scanned += 1;
        try {
          const st = await fs.lstat(p);
          if (!st.isFile()) continue;
          if (st.mtimeMs < cutoff) {
            await fs.unlink(p);
            deleted += 1;
          }
        } catch {
          // best-effort: skip permission/race errors silently
        }
      }
    }
  }
  return { scanned, deleted };
}

/**
 * The path two sessions must share to share an upload dir: the canonical
 * path when it can be resolved, so a sibling that reaches the same directory
 * through a symlink matches, and the normalised path otherwise (a directory
 * that no longer exists has nothing left to protect).
 */
function canonicalDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return resolve(dir);
  }
}

/** One session the upload-dir guard weighs: its id, directory and, for a persisted record, its status. */
export interface PasteImageDirUser {
  id: string;
  workingDir: string;
  status?: string;
}

/**
 * Does another live session still use this working directory's upload dirs?
 * Deleting a session removes them (`uploadDirs()`) recursively, and several
 * sessions routinely share one case directory, so without this check closing
 * one session deletes the pasted images a sibling in the same case still
 * refers to.
 *
 * Two kinds of sibling count as live:
 *
 * - a session in the server's map, unless it is itself being killed;
 * - a persisted record whose status is not `stopped`. That covers a session
 *   detached with `killMux=false`, which leaves the server's map while its
 *   tmux pane keeps running, and a session whose detach is still in progress.
 *
 * A session being KILLED does not count. Without that exemption, killing two
 * sessions of one case concurrently (a bulk delete, or the exited-agent sweep
 * closing two panes on one tick) would have each defer to the other, and
 * neither would remove the dir.
 *
 * Erring toward "in use" only costs a missed deletion, which the periodic
 * sweep above ages out. A pinned record whose tmux session is gone keeps its
 * status through boot pruning, so it holds the dir this way until unpinned.
 */
export function pasteImageDirInUseByOtherSession(input: {
  live: Iterable<PasteImageDirUser>;
  persisted: Iterable<PasteImageDirUser>;
  closingId: string;
  workingDir: string;
  killing: ReadonlySet<string>;
}): boolean {
  const target = canonicalDir(input.workingDir);
  const matches = (user: PasteImageDirUser): boolean =>
    user.id !== input.closingId &&
    !input.killing.has(user.id) &&
    !!user.workingDir &&
    canonicalDir(user.workingDir) === target;
  for (const user of input.live) {
    if (matches(user)) return true;
  }
  for (const user of input.persisted) {
    if (user.status === 'stopped') continue;
    if (matches(user)) return true;
  }
  return false;
}

export function startPasteImageGc(ctx: Pick<SessionPort, 'sessions'>): () => void {
  const initial = setTimeout(() => {
    void sweepPasteImagesOnce(ctx);
  }, INITIAL_DELAY_MS);
  const interval = setInterval(() => {
    void sweepPasteImagesOnce(ctx);
  }, SWEEP_INTERVAL_MS);
  if (typeof initial.unref === 'function') initial.unref();
  if (typeof interval.unref === 'function') interval.unref();
  return (): void => {
    clearTimeout(initial);
    clearInterval(interval);
  };
}
