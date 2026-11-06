/**
 * @fileoverview Which linked git worktree a session's pane is in.
 *
 * Claude Code's worktree feature moves the running `claude` process into
 * `<repo>/.claude/worktrees/<name>` part way through a session. `Session.workingDir` is the
 * session's identity and stays on the main checkout, so the Files panel kept listing a tree the
 * agent had left (#765). `Session.paneCwd` does follow: tmux reads the process cwd, measured with
 * Claude Code 2.1.318 going into a worktree on EnterWorktree and back on ExitWorktree. It also
 * follows every `cd` in a shell session, so it cannot be the panel's root by itself. This module
 * answers the narrower question: is the pane inside a linked worktree, and which one.
 *
 * A linked worktree is recognised by its `.git` FILE (`gitdir: <repo>/.git/worktrees/<id>`) rather
 * than by running `git worktree list`: this runs from the pane watcher whenever a directory
 * changes, and a file read starts no process, no repository config and no filter.
 *
 * Only a folder strictly below `workingDir` is ever an answer: the file routes already serve
 * everything under it, so following a pane there widens nothing, and a planted `.git` file can
 * only move where the listing STARTS inside that same folder. A worktree outside it
 * (`git worktree add ../feature`) stays unfollowed, since listing it would need a second
 * confinement root.
 *
 * That answer is lexical and only as fresh as the last time the pane moved: a symlink can take the
 * folder's place afterwards without moving the pane. So nothing here is a confinement decision.
 * `GET /api/sessions/:id/files` resolves the folder on every request and walks it only while it
 * really lies inside `workingDir` (`canWalkLiveWorktree()` in file-routes.ts), and the routes keep
 * judging every path against `workingDir`.
 *
 * Probes are bounded (#516). The folder can sit on a mount that stopped answering, and an
 * `unknown` answer stops the walk rather than being read as "no `.git` here".
 *
 * @module live-worktree
 */

import { constants, promises as fs } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { probePathKind } from './utils/bounded-path-probe.js';

/** A linked worktree a session's pane is in. */
export interface LiveWorktree {
  /** The worktree folder's name, for display. */
  name: string;
  /** Absolute path, spelled like the session's `workingDir`. */
  path: string;
}

/** More than any real `.git` file. It is read only to recognise the first line. */
const MAX_DOT_GIT_FILE_BYTES = 4096;

/**
 * Whether the text of a `.git` file names a linked worktree's git dir
 * (`<common dir>/worktrees/<id>`), as opposed to a submodule's (`<common dir>/modules/<name>`).
 * The path may be relative: `git worktree add --relative-paths` writes it that way.
 */
export function isLinkedWorktreeGitFile(text: string): boolean {
  const gitDir = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(text)?.[1];
  if (!gitDir) return false;
  const segments = gitDir.split('/').filter(Boolean);
  return segments.length >= 2 && segments[segments.length - 2] === 'worktrees';
}

/** What `<dir>/.git` says: a linked worktree's root, a boundary the walk must stop at, or nothing. */
async function classifyDotGit(dir: string): Promise<'worktree' | 'stop' | 'none'> {
  const dotGit = join(dir, '.git');
  const kind = await probePathKind(dotGit);
  if (kind === 'absent') return 'none';
  // A `.git` directory is a repository of its own, and `unknown` is never read as absent.
  if (kind !== 'file') return 'stop';
  let handle: fs.FileHandle | undefined;
  try {
    // The probe follows symlinks and the file can change after it, so the open itself refuses:
    // O_NOFOLLOW a symlink, and O_NONBLOCK a FIFO, which would otherwise wait for a writer and
    // hold a threadpool worker for good. Whatever it did open is then judged on the handle.
    handle = await fs.open(dotGit, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) return 'stop';
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(MAX_DOT_GIT_FILE_BYTES), 0, MAX_DOT_GIT_FILE_BYTES, 0);
    return isLinkedWorktreeGitFile(buffer.toString('utf8', 0, bytesRead)) ? 'worktree' : 'stop';
  } catch {
    return 'stop';
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * The linked worktree strictly below `workingDir` that holds `cwd`, if any. Walks up from `cwd`
 * and stops at `workingDir`, at a repository or submodule of its own, or at anything it cannot
 * read. `workingDir` itself is never an answer: a session started in a worktree is already
 * listing it. Never throws.
 */
export async function findLiveWorktree(workingDir: string, cwd: string | undefined): Promise<LiveWorktree | undefined> {
  if (!cwd?.startsWith('/')) return undefined;
  const root = workingDir.length > 1 ? workingDir.replace(/\/+$/, '') : workingDir;
  const under = root === '/' ? '/' : `${root}/`;
  for (let dir = cwd; dir !== root && dir.startsWith(under); dir = dirname(dir)) {
    const found = await classifyDotGit(dir);
    if (found === 'worktree') return { name: basename(dir), path: dir };
    if (found === 'stop') return undefined;
  }
  return undefined;
}
