/**
 * @fileoverview Periodic GC for paste-image files.
 *
 * Without cleanup, /api/sessions/:id/paste-image accumulates files indefinitely
 * under {workingDir}/.claude-images/. The route only triggers cleanup on
 * killMux=true session deletion, so long-lived sessions can fill disk under
 * heavy pasting. This sweeper bounds disk use by deleting `paste-*` files
 * older than MAX_AGE_MS from each live session's image dir on an interval.
 *
 * Conservative defaults — only files matching the `paste-` prefix are
 * considered, and we lstat (not stat) so a planted symlink cannot escape the
 * image dir.
 */
import fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SessionPort } from './ports/index.js';

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const INITIAL_DELAY_MS = 30 * 1000; // 30s after startup

export async function sweepPasteImagesOnce(
  ctx: Pick<SessionPort, 'sessions'>,
  now: number = Date.now()
): Promise<{ scanned: number; deleted: number }> {
  const cutoff = now - MAX_AGE_MS;
  let scanned = 0;
  let deleted = 0;
  for (const session of ctx.sessions.values()) {
    const dir = join(session.workingDir, '.claude-images');
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue; // dir absent — nothing to do
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
  return { scanned, deleted };
}

/**
 * Does another live session still use this working directory's paste-image
 * dir? Deleting a session removes `{workingDir}/.claude-images` recursively,
 * and several sessions routinely share one case directory, so without this
 * check closing one session deletes the pasted images a sibling in the same
 * case still refers to.
 *
 * A session that is itself being cleaned up does not count as live. Without
 * that exemption, closing two sessions of one case concurrently (a bulk
 * delete, or the exited-agent sweep closing two panes on one tick) would have
 * each defer to the other, and neither would remove the dir.
 *
 * Paths are compared after `resolve()`, which normalises a trailing slash and
 * `..` segments. Symlinks are not resolved: a sibling that reaches the same
 * directory through a symlink only costs a missed deletion here, and the
 * periodic sweep above still ages those files out.
 */
export function pasteImageDirInUseByOtherSession(
  sessions: Iterable<{ id: string; workingDir: string }>,
  closingId: string,
  workingDir: string,
  closing: ReadonlySet<string>
): boolean {
  const target = resolve(workingDir);
  for (const session of sessions) {
    if (session.id === closingId || closing.has(session.id)) continue;
    if (!session.workingDir) continue;
    if (resolve(session.workingDir) === target) return true;
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
