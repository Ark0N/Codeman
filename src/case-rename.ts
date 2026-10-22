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
 * still find the conversations. Leaves it alone when the new path already has history (nothing is merged
 * or overwritten) or when there is none. Returns whether anything moved.
 */
export async function moveClaudeHistory(oldPath: string, newPath: string, configDir?: string): Promise<boolean> {
  const projects = claudeProjectsDir(configDir);
  const from = join(projects, claudeProjectDirName(oldPath));
  const to = join(projects, claudeProjectDirName(newPath));
  if (from === to) return false;
  if (
    !(await fs.lstat(from).then(
      () => true,
      () => false
    ))
  )
    return false;
  if (
    await fs.lstat(to).then(
      () => true,
      () => false
    )
  )
    return false;
  try {
    await fs.rename(from, to);
    return true;
  } catch {
    return false; // history is a convenience; the folder move already succeeded
  }
}

/** Replace `from` by `to` in a list, keeping its position (the case order). */
export function renameInOrder(order: unknown, from: string, to: string): string[] | null {
  if (!Array.isArray(order) || !order.includes(from)) return null;
  return order.map((n) => (n === from ? to : n)) as string[];
}

/** The folder a linked case moves to: its own parent, the new name. */
export const siblingPath = (path: string, newName: string): string => join(dirname(path), newName);
