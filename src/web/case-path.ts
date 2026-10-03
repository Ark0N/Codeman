/**
 * @fileoverview Validation for "create a new case in a custom folder" (`POST /api/cases` with a
 * `path`). Creating a case writes a scaffold (`CLAUDE.md`, `src/`, `.claude/settings.local.json`)
 * and registers the folder in the shared, ownerless linked-cases registry, so the target has to be
 * judged before anything is created:
 *
 *   - it must be an absolute path (a leading `~` is expanded) with no traversal and none of the shell
 *     metacharacters a session's working directory is later rejected for (`isValidWorkingDir`), so
 *     a case this accepts is one a session can actually start in;
 *   - it must not be a system directory, the home directory itself, Codeman's own data directory, or
 *     a credential/config tree (`~/.ssh`, `~/.aws`, `~/.claude`, ...). Judged on the path as typed AND on
 *     its symlink-resolved form, so a link into `/etc` is not a way around it;
 *   - its parent must already exist (one folder is created, never a whole chain), and the folder
 *     itself must not exist or must be an EMPTY directory (a folder with contents is Link Existing's
 *     job, and silently scaffolding into someone's project is the one thing this must never do);
 *   - it must not be a symlink.
 *
 * Pure except for the filesystem reads in `prepareNewCasePath`; the policy lives in `blockedReason`
 * so it can be tested without a disk.
 *
 * @module web/case-path
 */

import { promises as fs } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { isValidWorkingDir } from './schemas.js';

/** System trees nobody creates a project in; creating one here is a mistake or an attack. */
const BLOCKED_SYSTEM_ROOTS = [
  '/bin',
  '/boot',
  '/dev',
  '/etc',
  '/lib',
  '/lib32',
  '/lib64',
  '/proc',
  '/run',
  '/sbin',
  '/sys',
  '/usr',
];

/** Home-relative trees that hold credentials or other tools' own configuration. */
const BLOCKED_HOME_DIRS = ['.ssh', '.gnupg', '.aws', '.kube', '.docker', '.claude', '.codex', '.gemini'];

export interface NewCasePathContext {
  home: string;
  /** Codeman's own state directory (`getDataDir()`), which must never become a case. */
  dataDir: string;
}

export type NewCasePathResult =
  | { ok: true; path: string; existedEmpty: boolean }
  | { ok: false; code: 'INVALID' | 'BLOCKED' | 'NOT_FOUND' | 'EXISTS'; reason: string };

const isWithin = (child: string, root: string): boolean =>
  child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);

/** `~` and `~/x` to the home directory; anything else is returned unchanged. */
export function expandHome(raw: string, home: string): string {
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return join(home, raw.slice(2));
  return raw;
}

/** Why a case may not live at this (already absolute and normalised) path, or null. */
export function blockedReason(absPath: string, ctx: NewCasePathContext): string | null {
  if (absPath === sep) return 'The filesystem root cannot be a case';
  for (const root of BLOCKED_SYSTEM_ROOTS) {
    if (isWithin(absPath, root)) return `${root} is a system directory`;
  }
  if (absPath === ctx.home) return 'The home folder itself cannot be a case; pick a folder inside it';
  for (const dir of BLOCKED_HOME_DIRS) {
    if (isWithin(absPath, join(ctx.home, dir))) return `~/${dir} holds credentials or another tool's configuration`;
  }
  if (isWithin(absPath, ctx.dataDir)) return "Codeman's own data folder cannot be a case";
  // Any Codeman instance's data dir under the home folder (~/.codeman, ~/.codeman-beta, ...), not only
  // the one this process uses.
  if (absPath.startsWith(ctx.home + sep)) {
    const firstSegment = absPath.slice(ctx.home.length + 1).split(sep)[0];
    if (/^\.codeman/.test(firstSegment)) return "Codeman's own data folder cannot be a case";
  }
  return null;
}

/**
 * Judge `raw` as the folder for a new case and, if it is acceptable, say what to create.
 * Never creates anything.
 */
export async function prepareNewCasePath(raw: string, ctx: NewCasePathContext): Promise<NewCasePathResult> {
  const typed = raw.trim();
  if (!typed) return { ok: false, code: 'INVALID', reason: 'Enter a folder path' };
  const expanded = expandHome(typed, ctx.home);
  if (!isValidWorkingDir(expanded)) {
    return {
      ok: false,
      code: 'INVALID',
      reason: 'Use an absolute path with letters, numbers, spaces, - _ . only (no .., no shell characters)',
    };
  }

  const target = resolve(expanded);
  const typedBlock = blockedReason(target, ctx);
  if (typedBlock) return { ok: false, code: 'BLOCKED', reason: typedBlock };

  // Resolve the parent's symlinks, then judge again: a link into a blocked tree must not pass.
  let realParent: string;
  try {
    realParent = await fs.realpath(dirname(target));
    if (!(await fs.stat(realParent)).isDirectory()) {
      return { ok: false, code: 'INVALID', reason: `${dirname(target)} is not a folder` };
    }
  } catch {
    return { ok: false, code: 'NOT_FOUND', reason: `The parent folder ${dirname(target)} does not exist` };
  }
  const real = join(realParent, basename(target));
  const realBlock = blockedReason(real, ctx);
  if (realBlock) return { ok: false, code: 'BLOCKED', reason: realBlock };

  try {
    const st = await fs.lstat(real);
    if (st.isSymbolicLink()) return { ok: false, code: 'INVALID', reason: `${target} is a symbolic link` };
    if (!st.isDirectory()) return { ok: false, code: 'INVALID', reason: `${target} exists and is not a folder` };
    if ((await fs.readdir(real)).length > 0) {
      return {
        ok: false,
        code: 'EXISTS',
        reason: `${target} already has files in it. Use "Link Existing" for a project that already exists`,
      };
    }
    return { ok: true, path: real, existedEmpty: true };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, path: real, existedEmpty: false };
    return { ok: false, code: 'INVALID', reason: `Cannot read ${target}: ${(err as Error).message}` };
  }
}
