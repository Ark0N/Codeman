/**
 * @fileoverview Attachment path-guard configuration (COD-53).
 *
 * Governs which host files may be registered as cross-workspace attachments
 * and served to the browser. Two operator-facing knobs, both with safe
 * defaults:
 *
 *  1. **Blocked-path blocklist (DEFAULT, configurable).** Pre-populated with the
 *     shared secret-location blocklist (`isSensitivePath`) PLUS the directory
 *     trees `/root` and `/etc` (anything under them is blocked). The operator
 *     EXTENDS — never shrinks — this set with additional absolute directory
 *     trees via the settings key `attachmentBlockedPaths: string[]` and/or the
 *     env var `CODEMAN_ATTACHMENT_BLOCKED_PATHS` (comma-separated).
 *
 *  2. **Workspace confinement (OPTIONAL, default OFF).** When enabled, an
 *     attachment must resolve INSIDE the registering session's workingDir
 *     (reusing `validateSessionFilePath` containment semantics). This is
 *     strictly more restrictive than the blocklist and breaks intentional
 *     cross-workspace attachment (codeman-publish, the ~/.codeman review-card
 *     loop), so it is OFF by default. Toggle via settings
 *     `attachmentConfineToWorkspace: boolean` and/or env
 *     `CODEMAN_ATTACHMENT_CONFINE` (`1`/`true`).
 *
 * All paths passed to the predicates here MUST be absolute and symlink-resolved
 * (realpath) by the caller, mirroring `isSensitivePath`'s contract.
 *
 * @module config/attachment-guard
 */

import { join, sep } from 'node:path';
import { isSensitivePath } from '../web/sensitive-path.js';
import { readJsonConfig, SETTINGS_PATH } from '../web/route-helpers.js';

/**
 * Directory trees blocked by default, IN ADDITION to the secret-location
 * blocklist in `isSensitivePath`. Anything resolving under one of these trees
 * is rejected. Pre-populated with the root account home and the system config
 * tree (which already partially overlaps `isSensitivePath`'s `/etc/shadow`
 * etc., but here we block the WHOLE tree).
 */
export const DEFAULT_BLOCKED_TREES: readonly string[] = ['/root', '/etc'];

/** Settings key carrying extra blocked directory trees (extends the defaults). */
export const ATTACHMENT_BLOCKED_PATHS_SETTING = 'attachmentBlockedPaths';

/** Settings key carrying the workspace-confinement toggle. */
export const ATTACHMENT_CONFINE_SETTING = 'attachmentConfineToWorkspace';

/** Resolved attachment-guard configuration. */
export interface AttachmentGuardConfig {
  /** Pre-populated default trees PLUS any operator extras. */
  blockedTrees: string[];
  /** Whether attachments must resolve inside the session workspace. */
  confineToWorkspace: boolean;
}

/** Normalizes a tree prefix: trim, drop trailing separators (but keep root). */
function normalizeTree(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // Strip trailing slashes so '/etc/' and '/etc' behave the same; never reduce
  // a bare separator to empty.
  const stripped = trimmed.replace(/[/\\]+$/, '');
  return stripped || trimmed[0];
}

/**
 * Returns true if `absPath` (absolute, symlink-resolved) is the tree itself or
 * lives under it. Uses path-separator-aware matching so `/etc` does NOT block
 * an unrelated `/etcetera/notes.md`.
 */
export function isUnderTree(absPath: string, tree: string): boolean {
  const t = normalizeTree(tree);
  if (!t) return false;
  if (absPath === t) return true;
  return absPath.startsWith(t.endsWith(sep) ? t : t + sep);
}

/** Parses the comma-separated env override into a list of normalized trees. */
function parseEnvBlockedTrees(): string[] {
  const raw = process.env.CODEMAN_ATTACHMENT_BLOCKED_PATHS;
  if (!raw) return [];
  return raw
    .split(',')
    .map(normalizeTree)
    .filter((t) => t.length > 0);
}

/** Parses the env confinement toggle (`1`/`true`/`yes`/`on`, case-insensitive). */
function parseEnvConfine(): boolean | undefined {
  const raw = process.env.CODEMAN_ATTACHMENT_CONFINE;
  if (raw === undefined) return undefined;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

/**
 * Loads the effective attachment-guard config by merging the pre-populated
 * defaults with settings.json and env overrides. Env wins over settings for the
 * confinement toggle; blocked-tree extras from BOTH sources are unioned on top
 * of the defaults (operators can only EXTEND, never shrink, the blocked set).
 */
export async function loadAttachmentGuardConfig(): Promise<AttachmentGuardConfig> {
  const settings = await readJsonConfig<Record<string, unknown>>(SETTINGS_PATH, 'settings.json', {});

  const settingsTrees = Array.isArray(settings[ATTACHMENT_BLOCKED_PATHS_SETTING])
    ? (settings[ATTACHMENT_BLOCKED_PATHS_SETTING] as unknown[])
        .filter((v): v is string => typeof v === 'string')
        .map(normalizeTree)
        .filter((t) => t.length > 0)
    : [];

  const blockedTrees = Array.from(new Set([...DEFAULT_BLOCKED_TREES, ...settingsTrees, ...parseEnvBlockedTrees()]));

  const envConfine = parseEnvConfine();
  const settingsConfine = settings[ATTACHMENT_CONFINE_SETTING] === true;
  const confineToWorkspace = envConfine ?? settingsConfine;

  return { blockedTrees, confineToWorkspace };
}

/**
 * Attachment-specific blocklist check. Builds on the shared `isSensitivePath`
 * base (secret locations, shared with `/api/download`) and ADDS the configured
 * directory trees (`/root`, `/etc`, plus operator extras). `absPath` must be
 * absolute and symlink-resolved.
 *
 * NOTE: this is intentionally a SUPERSET of `isSensitivePath` so `/api/download`
 * behavior is NOT changed — only attachment registration/serving uses this.
 * `opts` passes through to `isSensitivePath` (the File Viewer editor's
 * `allowDotenv`).
 */
export function isBlockedAttachmentPath(
  absPath: string,
  blockedTrees: readonly string[],
  opts: { allowDotenv?: boolean } = {}
): boolean {
  if (isSensitivePath(absPath, opts)) return true;
  return blockedTrees.some((tree) => isUnderTree(absPath, tree));
}

/**
 * Like `isBlockedAttachmentPath`, for a directory. The sensitive patterns describe file locations
 * such as ~/.ssh/<key>, so a child probe is what refuses a folder like ~/.ssh itself.
 */
export function isBlockedAttachmentDirectory(dir: string, blockedTrees: readonly string[]): boolean {
  return (
    isBlockedAttachmentPath(dir, blockedTrees) ||
    isBlockedAttachmentPath(join(dir, '__codeman_blocked_dir_probe__'), blockedTrees)
  );
}

/**
 * True when the attachment guard refuses `root` as the root of a worktree outside the session
 * folder: workspace confinement is on, the folder is blocked or sensitive, or it surrounds a
 * blocked tree. `root` must be absolute and symlink-resolved.
 */
export function isOutsideWorktreeRootRefused(root: string, guard: AttachmentGuardConfig): boolean {
  if (guard.confineToWorkspace) return true;
  if (isBlockedAttachmentDirectory(root, guard.blockedTrees)) return true;
  return guard.blockedTrees.some((tree) => isUnderTree(tree, root));
}
