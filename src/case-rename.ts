/**
 * @fileoverview Renaming a case (its name and its folder) without losing what points at the folder.
 *
 * A case folder is held in more places than an open file. A running agent has it as its working
 * directory and its tmux pane was started `cd`-ed into it; Claude Code keys its conversation history
 * by the folder's path (`<config>/projects/<path with every non-alphanumeric as "-">`), so a moved
 * folder silently orphans every conversation; on Windows, SMB and some FUSE mounts a directory with an
 * open handle simply cannot be renamed (EBUSY / EPERM / EACCES). This module owns the three parts of
 * that which are not route logic:
 *
 * - the in-process lock (`withCaseLock` / `isCasePathLocked`) that keeps a session from starting in a
 *   folder while it is being moved, and two renames from overlapping;
 * - the record of sessions constructed but not yet registered (`isCaseSessionStarting`), which a
 *   rename refuses to move a folder under, since it can neither list nor stop them;
 * - the move itself, retried a few times for a transient lock and turned into a message that says
 *   what to do when it is a real one;
 * - carrying Claude Code's history for the folder over to the new path.
 *
 * Pure of the server: every function takes the paths it works on.
 *
 * @module case-rename
 */

import fs from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { claudeProjectsDir } from './utils/claude-transcript.js';

export type CaseRenameErrorCode =
  | 'INVALID' // a name that is not allowed, or the same name
  | 'EXISTS' // the new name or folder is already taken
  | 'BUSY' // another rename (or a session being stopped) holds the folder
  | 'LOCKED' // the OS refused the move: something still has the folder open
  | 'CROSS_DEVICE' // the move would cross filesystems
  | 'UNSUPPORTED'; // remote and Docker cases

export class CaseRenameError extends Error {
  constructor(
    readonly code: CaseRenameErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'CaseRenameError';
  }
}

const locked = new Set<string>();

const within = (child: string, parent: string): boolean => child === parent || child.startsWith(parent + sep);

/** True when `path` is, or is inside, a folder that is being renamed right now. */
export function isCasePathLocked(path: string): boolean {
  const target = resolve(path);
  for (const held of locked) {
    if (within(target, held)) return true;
  }
  return false;
}

/**
 * Sessions constructed but not yet in the server's session map, where the rename route looks for the
 * sessions it must list or stop. A create awaits a few things between `new Session` and that map (the
 * owner's layout lock, a settings read), and a rename that ran in that gap neither saw nor stopped the
 * session, moved the folder, and left it to start in a path that no longer existed.
 */
const starting = new Map<object, { path: string; until: number }>();
/** A session that never reaches the map (a create that failed, a one-shot prompt) stops counting after this. */
const STARTING_TTL_MS = 30000;

const dropExpiredStarts = (now: number): void => {
  for (const [session, entry] of starting) {
    if (entry.until <= now) starting.delete(session);
  }
};

/** `session` (any object standing for it) is being created with `workingDir`; `Session`'s constructor calls this. */
export function noteCaseSessionStarting(session: object, workingDir: string, now = Date.now()): void {
  dropExpiredStarts(now);
  starting.set(session, { path: resolve(workingDir), until: now + STARTING_TTL_MS });
}

/** `session` is in the server's session map (or was stopped): the rename route sees it from here on. */
export function caseSessionSettled(session: object): void {
  starting.delete(session);
}

/** True when a session is being created at or inside `path`, so a rename of it must wait. */
export function isCaseSessionStarting(path: string, now = Date.now()): boolean {
  dropExpiredStarts(now);
  const root = resolve(path);
  for (const entry of starting.values()) {
    if (within(entry.path, root)) return true;
  }
  return false;
}

/**
 * Hold `from` and `to` for the length of `fn`. A second caller touching either (or anything inside
 * them) gets `BUSY` instead of racing the move; `Session`'s constructor refuses a working directory
 * inside a held folder, so nothing starts in a case that is half-moved.
 */
export async function withCaseLock<T>(from: string, to: string, fn: () => Promise<T>): Promise<T> {
  const held = [resolve(from), resolve(to)];
  for (const p of held) {
    for (const other of locked) {
      if (within(p, other) || within(other, p)) {
        throw new CaseRenameError('BUSY', 'Another rename is already working on this case. Try again in a moment.');
      }
    }
  }
  for (const p of held) locked.add(p);
  try {
    return await fn();
  } finally {
    for (const p of held) locked.delete(p);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

/**
 * `rename(from, to)` for a folder that must not already exist at `to`. A lock error is retried (a
 * handle another process is closing, an antivirus scan) before it is reported as locked.
 * `fs.rename` onto an EMPTY existing directory replaces it on POSIX, so the target is checked first.
 */
export async function moveCaseFolder(from: string, to: string, attempts = 4, delayMs = 150): Promise<void> {
  if (
    await fs.lstat(to).then(
      () => true,
      () => false
    )
  ) {
    throw new CaseRenameError('EXISTS', `A folder named ${to} already exists.`);
  }
  for (let i = 0; ; i++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (code === 'EXDEV') {
        throw new CaseRenameError(
          'CROSS_DEVICE',
          'The new folder would be on a different drive or mount; it is not moved.'
        );
      }
      if (LOCK_CODES.has(code)) {
        if (i < attempts - 1) {
          await sleep(delayMs * (i + 1));
          continue;
        }
        throw new CaseRenameError(
          'LOCKED',
          `The folder is in use by another program (${code}), so it could not be renamed. Close anything that has it open ` +
            '(an editor, a file browser or a sync client) and try again.'
        );
      }
      if (code === 'ENOTEMPTY' || code === 'EEXIST') {
        throw new CaseRenameError('EXISTS', `A folder named ${to} already exists.`);
      }
      throw err;
    }
  }
}

/** The directory name Claude Code uses for a project path: every non-alphanumeric becomes `-`. */
export function claudeProjectDirName(path: string): string {
  return resolve(path).replace(/[^a-zA-Z0-9]/g, '-');
}

/**
 * Move Claude Code's history for the old folder to the new one, so `--resume` and the past-sessions list
 * still find the conversations. Returns whether anything moved.
 *
 * The new path can already have history: Claude Code never removes a project directory, and deleting a
 * case does not either, so a case deleted earlier under the new name leaves one behind. The old history is
 * then merged into it entry by entry (conversations are UUID-named, so they do not collide), never
 * overwriting: an entry both directories have (a `memory/` folder, say) stays at the old path. A merge
 * only goes between two real directories, never through a symlink.
 */
export async function moveClaudeHistory(oldPath: string, newPath: string, configDir?: string): Promise<boolean> {
  const projects = claudeProjectsDir(configDir);
  const from = join(projects, claudeProjectDirName(oldPath));
  const to = join(projects, claudeProjectDirName(newPath));
  if (from === to) return false;
  const fromStat = await fs.lstat(from).catch(() => null);
  if (!fromStat) return false;
  const toStat = await fs.lstat(to).catch(() => null);
  if (!toStat) {
    try {
      await fs.rename(from, to);
      return true;
    } catch {
      return false; // history is a convenience; the folder move already succeeded
    }
  }
  if (!fromStat.isDirectory() || !toStat.isDirectory()) return false;
  let moved = false;
  for (const entry of await fs.readdir(from).catch(() => [] as string[])) {
    const target = join(to, entry);
    if (
      await fs.lstat(target).then(
        () => true,
        () => false
      )
    )
      continue;
    try {
      await fs.rename(join(from, entry), target);
      moved = true;
    } catch {
      /* left at the old path, like an entry both have */
    }
  }
  await fs.rmdir(from).catch(() => {}); // succeeds only once nothing was left behind
  return moved;
}

/** Replace `from` by `to` in a list, keeping its position (the case order). */
export function renameInOrder(order: unknown, from: string, to: string): string[] | null {
  if (!Array.isArray(order) || !order.includes(from)) return null;
  return order.map((n) => (n === from ? to : n)) as string[];
}

/** The folder a linked case moves to: its own parent, the new name. */
export const siblingPath = (path: string, newName: string): string => join(dirname(path), newName);
