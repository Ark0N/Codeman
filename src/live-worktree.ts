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
 * A folder strictly below `workingDir` is the plain answer: the file routes already serve
 * everything under it, so following a pane there widens nothing, and a planted `.git` file can
 * only move where the listing STARTS inside that same folder.
 *
 * A worktree OUTSIDE `workingDir` (`git worktree add ../feature`, or an EnterWorktree that a
 * `WorktreeCreate` hook places beside the repository) is a second confinement root, so it is
 * answered only when the caller passes {@link OutsideWorktreeOptions}, and only when the session's
 * own repository vouches for it ({@link findOutsideWorktree}). The answer then carries
 * `outside: true`, and the file routes serve absolute paths inside it.
 *
 * For a worktree inside `workingDir` the answer is lexical and only as fresh as the last time the
 * pane moved: a symlink can take the folder's place afterwards without moving the pane. So
 * nothing there is a confinement decision. `GET /api/sessions/:id/files` resolves the folder on
 * every request and walks it only while it really lies inside `workingDir`
 * (`canWalkLiveWorktree()` in file-routes.ts), and the routes keep judging every path against
 * `workingDir`.
 *
 * For an outside worktree {@link findOutsideWorktree} IS the confinement decision for the second
 * root. Its vouching, home and Docker rules, and the multi-user half of `allowRoot`, run only when
 * the pane moves. The routes re-check two things on each request: that the folder still realpaths
 * to the recorded path (`outsideWorktreeRootFor()`, `canWalkOutsideWorktree()`), and the attachment
 * guard half of `allowRoot` (workspace confinement, blocked and sensitive trees:
 * `isOutsideWorktreeRootRefused()` through `withGuardedOutsideWorktree()` in file-routes.ts), so a
 * guard setting changed later applies at once.
 *
 * Probes are bounded (#516). The folder can sit on a mount that stopped answering, and an
 * `unknown` answer stops the walk rather than being read as "no `.git` here".
 *
 * @module live-worktree
 */

import { constants, promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { probePathKind } from './utils/bounded-path-probe.js';

/** A linked worktree a session's pane is in. */
export interface LiveWorktree {
  /** The worktree folder's name, for display. */
  name: string;
  /**
   * Absolute path. Spelled like the session's `workingDir` for a worktree inside it; the real
   * path (no symlink in any component) for one outside it.
   */
  path: string;
  /**
   * The worktree lies outside `workingDir`, so it is a second root the file routes serve
   * ABSOLUTE paths from. Absent for a worktree inside `workingDir`.
   */
  outside?: true;
}

/** What {@link findLiveWorktree} needs to answer a worktree outside `workingDir`. */
export interface OutsideWorktreeOptions {
  /** Overrides `os.homedir()` (tests). */
  home?: string;
  /** Host paths of every Docker case workspace: a container can write there, so none is followed. */
  dockerWorkspaces?: () => Promise<string[]>;
  /**
   * The caller's last word on which worktree may be followed. The server passes its attachment
   * guard rules (workspace confinement, blocked trees, sensitive folders) in every mode, plus the
   * owner's folder rule (`folderAllowedForUser`) in multi-user mode, so a regular user's session
   * cannot list another user's checkout. A rejection counts as a refusal.
   */
  allowRoot?: (root: string) => boolean | Promise<boolean>;
}

/** The text after `gitdir:` in a `.git` file, as written (possibly relative). */
function rawGitDir(text: string): string | undefined {
  return /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(text)?.[1];
}

/** More than any real `.git` file. It is read only to recognise the first line. */
const MAX_DOT_GIT_FILE_BYTES = 4096;

/**
 * Whether the text of a `.git` file names a linked worktree's git dir
 * (`<common dir>/worktrees/<id>`), as opposed to a submodule's (`<common dir>/modules/<name>`).
 * The path may be relative: `git worktree add --relative-paths` writes it that way.
 */
export function isLinkedWorktreeGitFile(text: string): boolean {
  const gitDir = rawGitDir(text);
  if (!gitDir) return false;
  const segments = gitDir.split('/').filter(Boolean);
  return segments.length >= 2 && segments[segments.length - 2] === 'worktrees';
}

/**
 * The text of a small file, opened so that nothing blocks or escapes. The probe a caller ran
 * follows symlinks and the file can change after it, so the open itself refuses: O_NOFOLLOW a
 * symlink, and O_NONBLOCK a FIFO, which would otherwise wait for a writer and hold a threadpool
 * worker for good. Whatever it did open is then judged on the handle. Null for anything but a
 * regular file it could read.
 */
async function readOpenedSmallFile(path: string): Promise<string | null> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await handle.stat()).isFile()) return null;
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(MAX_DOT_GIT_FILE_BYTES), 0, MAX_DOT_GIT_FILE_BYTES, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** What `<dir>/.git` says: a linked worktree's root, a boundary the walk must stop at, or nothing. */
async function classifyDotGit(dir: string): Promise<'worktree' | 'stop' | 'none'> {
  const dotGit = join(dir, '.git');
  const kind = await probePathKind(dotGit);
  if (kind === 'absent') return 'none';
  // A `.git` directory is a repository of its own, and `unknown` is never read as absent.
  if (kind !== 'file') return 'stop';
  // `null` is a symlink, a FIFO, a non-regular file or an unreadable one: all stop the walk.
  const text = await readOpenedSmallFile(dotGit);
  return text !== null && isLinkedWorktreeGitFile(text) ? 'worktree' : 'stop';
}

/**
 * The linked worktree that holds `cwd`, if any. Walks up from `cwd` and stops at `workingDir`,
 * at a repository or submodule of its own, or at anything it cannot read. `workingDir` itself is
 * never an answer: a session started in a worktree is already listing it. When `cwd` lies outside
 * `workingDir` and `outside` is given, {@link findOutsideWorktree} answers instead. Never throws.
 */
export async function findLiveWorktree(
  workingDir: string,
  cwd: string | undefined,
  outside?: OutsideWorktreeOptions
): Promise<LiveWorktree | undefined> {
  if (!cwd?.startsWith('/')) return undefined;
  const root = workingDir.length > 1 ? workingDir.replace(/\/+$/, '') : workingDir;
  const under = root === '/' ? '/' : `${root}/`;
  if (cwd !== root && !cwd.startsWith(under)) {
    return outside ? findOutsideWorktree(root, cwd, outside).catch(() => undefined) : undefined;
  }
  for (let dir = cwd; dir !== root && dir.startsWith(under); dir = dirname(dir)) {
    const found = await classifyDotGit(dir);
    if (found === 'worktree') return { name: basename(dir), path: dir };
    if (found === 'stop') return undefined;
  }
  return undefined;
}

/** True when `child` is `parent` or lies below it. Both must already be real paths. */
const isSameOrUnder = (child: string, parent: string): boolean =>
  child === parent || child.startsWith(parent === sep ? parent : parent + sep);

/** The real path of `p` once a bounded probe has answered for it, else null. */
async function realPathBounded(p: string): Promise<string | null> {
  const kind = await probePathKind(p);
  if (kind !== 'directory' && kind !== 'file') return null;
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

/** The text of a small regular file that a bounded probe found, via {@link readOpenedSmallFile}. */
async function readSmallFile(path: string): Promise<string | null> {
  return (await probePathKind(path)) === 'file' ? readOpenedSmallFile(path) : null;
}

/** The `gitdir:` value of a `.git` file's text, resolved against the folder that holds it. */
function gitDirOf(text: string, dir: string): string | null {
  const raw = rawGitDir(text);
  return raw ? resolve(dir, raw) : null;
}

/**
 * The real path of the git common dir of the repository whose top level is `workingDir`: its
 * `.git` folder, or, for a linked worktree, the folder its `commondir` file names. Null when
 * `workingDir` is not the top level of a repository or worktree: a session in a subfolder
 * follows no worktree outside it.
 */
async function sessionCommonDir(workingDir: string): Promise<string | null> {
  const dotGit = join(workingDir, '.git');
  const kind = await probePathKind(dotGit);
  if (kind === 'directory') return realPathBounded(dotGit);
  if (kind !== 'file') return null;
  const text = await readSmallFile(dotGit);
  const gitDir = text ? gitDirOf(text, workingDir) : null;
  if (!gitDir) return null;
  // A linked worktree's git dir names the common dir in `commondir`; a submodule's git dir
  // has none and is its own common dir.
  const commonDir = await readSmallFile(join(gitDir, 'commondir'));
  return realPathBounded(commonDir ? resolve(gitDir, commonDir.trim()) : gitDir);
}

/**
 * The worktree outside `workingDir` that holds `cwd`, when the session's own repository vouches
 * for it. `cwd` comes from the pane, which a prompt-injected agent controls, so every rule below
 * keeps it from widening what the file routes serve beyond a worktree of the session's repository:
 *
 *   - The walk up from `cwd` stops at the first `.git`. That folder is a candidate only when its
 *     `.git` FILE names `<common dir>/worktrees/<id>` of the session's repository AND that
 *     entry's own `gitdir` file names the candidate back. A `.git` FOLDER is a candidate only when
 *     it IS the session's common dir (the main worktree, for a session started in a linked one).
 *     These are the files `git worktree list` reads, read here without starting git: this runs
 *     from the pane watcher on every directory change.
 *   - `/`, the home folder and anything above it, and any folder holding `workingDir` are
 *     refused, as is a folder at, inside or around a Docker case workspace.
 *   - `allowRoot`, when given, has the last word (the server's attachment-guard and multi-user rules).
 *
 * Never rejects: an `allowRoot` that rejects refuses the worktree.
 *
 * Every path is compared as a real path, and the answer is the real path. The file routes check
 * on each request that the folder still resolves to itself, so a symlink swapped in later is
 * refused there. A forged registry entry needs write access to the session's own `.git`, which
 * an agent running as this user already has, along with read access to everything it could list.
 */
export async function findOutsideWorktree(
  workingDir: string,
  cwd: string,
  opts: OutsideWorktreeOptions
): Promise<LiveWorktree | undefined> {
  // The nearest folder at or above `cwd` that holds a `.git`, and what that `.git` is.
  let dir = cwd;
  let kind: 'directory' | 'file';
  for (;;) {
    const probed = await probePathKind(join(dir, '.git'));
    if (probed === 'unknown') return undefined;
    if (probed === 'directory' || probed === 'file') {
      kind = probed;
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }

  const commonDir = await sessionCommonDir(workingDir);
  if (!commonDir) return undefined;
  const real = await realPathBounded(dir);
  if (!real) return undefined;

  if (kind === 'directory') {
    // The main worktree: its `.git` folder is the session's common dir itself. The folder must
    // really hold it: a `.git` symlink resolves elsewhere, so it fails this comparison.
    if (join(real, '.git') !== commonDir) return undefined;
  } else {
    const text = await readSmallFile(join(dir, '.git'));
    const gitDir = text && isLinkedWorktreeGitFile(text) ? gitDirOf(text, dir) : null;
    const realGitDir = gitDir ? await realPathBounded(gitDir) : null;
    if (!realGitDir || dirname(realGitDir) !== join(commonDir, 'worktrees')) return undefined;
    // The registry entry must name this folder back, as `git worktree list` would report it.
    const back = await readSmallFile(join(realGitDir, 'gitdir'));
    const backDir = back ? await realPathBounded(dirname(resolve(realGitDir, back.trim()))) : null;
    if (backDir !== real) return undefined;
  }

  const realWorkingDir = await realPathBounded(workingDir);
  if (!realWorkingDir || isSameOrUnder(realWorkingDir, real) || isSameOrUnder(real, realWorkingDir)) return undefined;
  const home = (await realPathBounded(opts.home ?? homedir())) ?? resolve(opts.home ?? homedir());
  if (real === sep || isSameOrUnder(home, real)) return undefined;
  if (opts.dockerWorkspaces) {
    const workspaces = await opts.dockerWorkspaces().catch(() => null);
    // An unreadable list could hide a container's workspace, so it fails closed.
    if (!workspaces) return undefined;
    for (const workspace of workspaces) {
      const realWorkspace = (await realPathBounded(workspace)) ?? resolve(workspace);
      if (isSameOrUnder(real, realWorkspace) || isSameOrUnder(realWorkspace, real)) return undefined;
    }
  }
  if (opts.allowRoot) {
    let allowed = false;
    try {
      allowed = await opts.allowRoot(real);
    } catch {
      // A callback that throws or rejects refuses the worktree.
    }
    if (!allowed) return undefined;
  }
  return { name: basename(real), path: real, outside: true };
}
