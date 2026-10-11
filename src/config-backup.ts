/**
 * @fileoverview Config backups: timestamped snapshots of the files that hold what a user has
 * customized, kept in a default-but-configurable folder with configurable retention.
 *
 * Why it exists: those files are plain JSON in the data dir, rewritten by the server, the Settings UI,
 * the CLI and (once, by a mis-configured test run) by things that should never touch them, and there
 * was no copy to go back to. A snapshot is taken at startup and whenever the tracked files' content
 * changes, so the history is one entry per actual change rather than one per timer tick.
 *
 * Safety rules the code enforces rather than documents:
 * - The tracked file list is a fixed allowlist, never "everything in the data dir".
 * - Retention only ever deletes folders this module made (name pattern AND a parseable manifest), so
 *   pointing the backup folder at a directory that holds other things cannot delete them.
 * - The newest snapshot is never pruned, whatever the retention numbers say.
 * - A snapshot is built in a temp folder and renamed into place, so a crash leaves no half snapshot.
 * - Restore verifies each file against the manifest's SHA-256 and takes a `pre-restore` snapshot first.
 * - Snapshot folders are 0700 and their files 0600: some tracked files carry credentials.
 *
 * Pure of the server: every function takes the directories it works in.
 *
 * @module config-backup
 */

import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

/**
 * The files (relative to the data dir) a snapshot holds: what a user configured, not what the server
 * regenerates (session state, logs, the hook secret, docker seeds, caches).
 *
 * ⚠️ Not tracked: `state.json`. It also holds cron jobs and respawn presets, but it is rewritten with
 * every session event, so tracking it would make a snapshot per event and bury the real changes.
 *
 * ⚠️ `.env`, `users.json`, `custom-model-hosts.json` and `push-keys.json` carry credentials or keys.
 * They are already in the data dir with the same permissions; a snapshot folder is 0700 with 0600
 * files, so the default location widens nothing. A custom location is the user's own choice.
 */
export const CONFIG_BACKUP_FILES = [
  'settings.json',
  'clis.json',
  'custom-model-hosts.json',
  'webhook.json',
  'intents.json',
  'linked-cases.json',
  'remote-hosts.json',
  'docker-hosts.json',
  'docker-cases.json',
  'webviews.json',
  'push-keys.json',
  'users.json',
  '.env',
] as const;

export const CONFIG_BACKUP_DEFAULTS = { enabled: true, keepCount: 20, keepDays: 30 } as const;
export const CONFIG_BACKUP_MAX_KEEP_COUNT = 500;
export const CONFIG_BACKUP_MAX_KEEP_DAYS = 3650;

/** `cfg-YYYYMMDD-HHMMSS`, plus `-2`, `-3`… if two land in one second. */
const SNAPSHOT_ID_RE = /^cfg-\d{8}-\d{6}(?:-\d{1,3})?$/;
const MANIFEST = 'manifest.json';

export interface ConfigBackupSettings {
  enabled: boolean;
  /** Absolute folder, or null for the default (`<data dir>/backups/config`). */
  dir: string | null;
  /** Keep at most this many snapshots (newest first). 1–500. */
  keepCount: number;
  /** Also drop snapshots older than this many days; 0 = no age limit. */
  keepDays: number;
}

export interface ConfigBackupFile {
  name: string;
  bytes: number;
  sha256: string;
}

export interface ConfigBackupManifest {
  id: string;
  createdAt: number;
  reason: string;
  appVersion: string;
  /** Digest of the set of files, so an unchanged state is not snapshotted twice. */
  hash: string;
  files: ConfigBackupFile[];
}

export interface ConfigBackupSummary {
  id: string;
  createdAt: number;
  reason: string;
  appVersion: string;
  files: Array<{ name: string; bytes: number }>;
  bytes: number;
}

const intIn = (value: unknown, min: number, max: number, fallback: number): number => {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
};

/** `~`-expand and require an absolute path; anything else means "use the default". */
export function normalizeBackupDir(raw: unknown, home: string = homedir()): string | null {
  if (typeof raw !== 'string') return null;
  let value = raw.trim();
  if (!value || value.includes('\0')) return null;
  if (value === '~') value = home;
  else if (value.startsWith('~/')) value = join(home, value.slice(2));
  if (!isAbsolute(value)) return null;
  return resolve(value);
}

/** Read the four `configBackup*` settings out of a settings.json object, clamped and defaulted. */
export function readConfigBackupSettings(raw: Record<string, unknown> | null | undefined): ConfigBackupSettings {
  const s = raw ?? {};
  return {
    // Absent means ON: the feature protects against an event nobody schedules.
    enabled: s.configBackupEnabled !== false,
    dir: normalizeBackupDir(s.configBackupDir),
    keepCount: intIn(s.configBackupKeepCount, 1, CONFIG_BACKUP_MAX_KEEP_COUNT, CONFIG_BACKUP_DEFAULTS.keepCount),
    keepDays: intIn(s.configBackupKeepDays, 0, CONFIG_BACKUP_MAX_KEEP_DAYS, CONFIG_BACKUP_DEFAULTS.keepDays),
  };
}

export function defaultConfigBackupDir(dataDir: string): string {
  return join(dataDir, 'backups', 'config');
}

/**
 * The folder snapshots go to: the configured one, or the default. A custom folder that IS the data dir
 * falls back to the default, because snapshot folders and the live files must not share a directory.
 */
export function resolveConfigBackupDir(settings: ConfigBackupSettings, dataDir: string): string {
  const fallback = defaultConfigBackupDir(dataDir);
  const dir = settings.dir;
  if (!dir) return fallback;
  const data = resolve(dataDir);
  if (dir === data) return fallback;
  return dir;
}

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

function stamp(now: number): string {
  const d = new Date(now);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function readManifest(dir: string, id: string): ConfigBackupManifest | null {
  if (!SNAPSHOT_ID_RE.test(id)) return null;
  try {
    const m = JSON.parse(readFileSync(join(dir, id, MANIFEST), 'utf8')) as ConfigBackupManifest;
    if (!m || m.id !== id || !Array.isArray(m.files) || typeof m.createdAt !== 'number' || typeof m.hash !== 'string') {
      return null;
    }
    return m;
  } catch {
    return null;
  }
}

/** Snapshots this module made in `dir`, newest first. Foreign folders and files are ignored. */
export function listConfigBackups(dir: string): ConfigBackupSummary[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: ConfigBackupSummary[] = [];
  for (const id of names) {
    const m = readManifest(dir, id);
    if (!m) continue;
    const files = m.files.map((f) => ({ name: f.name, bytes: f.bytes }));
    out.push({
      id,
      createdAt: m.createdAt,
      reason: m.reason,
      appVersion: m.appVersion,
      files,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
    });
  }
  return out.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
}

export type ConfigBackupResult =
  | { status: 'created'; id: string; files: number; bytes: number }
  | { status: 'unchanged'; id: string }
  | { status: 'empty' };

export interface CreateConfigBackupOptions {
  dataDir: string;
  backupDir: string;
  reason: string;
  appVersion?: string;
  /** Snapshot even if nothing changed (a manual request, a pre-restore safety copy). */
  force?: boolean;
  now?: number;
}

/** Snapshot the tracked files that exist, unless the latest snapshot already holds exactly this state. */
export function createConfigBackup(opts: CreateConfigBackupOptions): ConfigBackupResult {
  const now = opts.now ?? Date.now();
  const present: Array<{ name: string; data: Buffer; sha: string }> = [];
  for (const name of CONFIG_BACKUP_FILES) {
    try {
      const path = join(opts.dataDir, name);
      if (!statSync(path).isFile()) continue;
      const data = readFileSync(path);
      present.push({ name, data, sha: sha256(data) });
    } catch {
      /* absent or unreadable: simply not part of this snapshot */
    }
  }
  if (present.length === 0) return { status: 'empty' };

  const hash = sha256(present.map((f) => `${f.name}\0${f.sha}`).join('\n'));
  const existing = listConfigBackups(opts.backupDir);
  if (!opts.force && existing[0]) {
    const latest = readManifest(opts.backupDir, existing[0].id);
    if (latest && latest.hash === hash) return { status: 'unchanged', id: latest.id };
  }

  mkdirSync(opts.backupDir, { recursive: true, mode: 0o700 });
  const base = `cfg-${stamp(now)}`;
  let id = base;
  for (let n = 2; existsSync(join(opts.backupDir, id)); n++) id = `${base}-${n}`;

  const tmp = join(opts.backupDir, `.tmp-${id}-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { mode: 0o700 });
  try {
    const manifest: ConfigBackupManifest = {
      id,
      createdAt: now,
      reason: opts.reason,
      appVersion: opts.appVersion ?? '',
      hash,
      files: present.map((f) => ({ name: f.name, bytes: f.data.length, sha256: f.sha })),
    };
    for (const f of present) writeFileSync(join(tmp, f.name), f.data, { mode: 0o600 });
    writeFileSync(join(tmp, MANIFEST), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, join(opts.backupDir, id));
    try {
      chmodSync(join(opts.backupDir, id), 0o700);
    } catch {
      /* best effort on filesystems without modes */
    }
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  return { status: 'created', id, files: present.length, bytes: present.reduce((n, f) => n + f.data.length, 0) };
}

export interface PruneOptions {
  keepCount: number;
  keepDays: number;
  now?: number;
}

/**
 * Apply retention: keep the newest `keepCount`, and (when `keepDays` > 0) drop anything older than
 * that. The newest snapshot always survives. Returns the ids removed.
 */
export function pruneConfigBackups(dir: string, opts: PruneOptions): string[] {
  const now = opts.now ?? Date.now();
  const all = listConfigBackups(dir);
  const cutoff = opts.keepDays > 0 ? now - opts.keepDays * 86_400_000 : null;
  const removed: string[] = [];
  all.forEach((b, index) => {
    if (index === 0) return;
    const tooMany = index >= Math.max(1, opts.keepCount);
    const tooOld = cutoff !== null && b.createdAt < cutoff;
    if (!tooMany && !tooOld) return;
    // listConfigBackups already proved this is one of ours (name pattern + manifest).
    const target = join(dir, b.id);
    if (!target.startsWith(resolve(dir) + sep)) return;
    try {
      rmSync(target, { recursive: true, force: true });
      removed.push(b.id);
    } catch {
      /* leave it; the next pass retries */
    }
  });
  return removed;
}

export class ConfigBackupNotFoundError extends Error {}
export class ConfigBackupCorruptError extends Error {}

export interface RestoreResult {
  restored: string[];
  /** The snapshot taken of the live files before they were overwritten. */
  safetySnapshot: string | null;
}

/**
 * Put a snapshot's files back into the data dir. Every file is checked against the manifest's digest
 * BEFORE anything is written, a `pre-restore` snapshot of the live files is taken first, and each
 * file is replaced atomically (temp + rename) with mode 0600.
 */
export function restoreConfigBackup(opts: {
  dataDir: string;
  backupDir: string;
  id: string;
  appVersion?: string;
  now?: number;
}): RestoreResult {
  const manifest = readManifest(opts.backupDir, opts.id);
  if (!manifest) throw new ConfigBackupNotFoundError(`No config backup named ${opts.id}`);

  const allowed = new Set<string>(CONFIG_BACKUP_FILES);
  const loaded: Array<{ name: string; data: Buffer }> = [];
  for (const f of manifest.files) {
    if (!allowed.has(f.name)) continue;
    let data: Buffer;
    try {
      data = readFileSync(join(opts.backupDir, opts.id, f.name));
    } catch {
      throw new ConfigBackupCorruptError(`${f.name} is missing from ${opts.id}`);
    }
    if (sha256(data) !== f.sha256)
      throw new ConfigBackupCorruptError(`${f.name} in ${opts.id} does not match its checksum`);
    loaded.push({ name: f.name, data });
  }
  if (loaded.length === 0) throw new ConfigBackupCorruptError(`${opts.id} holds no restorable files`);

  const safety = createConfigBackup({
    dataDir: opts.dataDir,
    backupDir: opts.backupDir,
    reason: 'pre-restore',
    appVersion: opts.appVersion,
    force: true,
    now: opts.now,
  });

  mkdirSync(opts.dataDir, { recursive: true });
  const restored: string[] = [];
  for (const f of loaded) {
    const target = join(opts.dataDir, f.name);
    const tmp = `${target}.restore-${process.pid}`;
    writeFileSync(tmp, f.data, { mode: 0o600 });
    renameSync(tmp, target);
    restored.push(f.name);
  }
  return { restored, safetySnapshot: safety.status === 'created' ? safety.id : null };
}
