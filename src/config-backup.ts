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

import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
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
  'remote-cases.json',
  'docker-hosts.json',
  'docker-cases.json',
  'webviews.json',
  'push-keys.json',
  'users.json',
  '.env',
] as const;

export const CONFIG_BACKUP_DEFAULTS = { enabled: true, keepCount: 20, keepDays: 30 } as const;
/** 1 would delete the state before every change, so a bad write could never be undone. */
export const CONFIG_BACKUP_MIN_KEEP_COUNT = 2;
export const CONFIG_BACKUP_MAX_KEEP_COUNT = 500;
export const CONFIG_BACKUP_MAX_KEEP_DAYS = 3650;

/** `cfg-YYYYMMDD-HHMMSS`, plus `-2`, `-3`… if two land in one second. */
const SNAPSHOT_ID_RE = /^cfg-\d{8}-\d{6}(?:-\d{1,3})?$/;
const MANIFEST = 'manifest.json';

export interface ConfigBackupSettings {
  enabled: boolean;
  /** Absolute folder, or null for the default (`<data dir>/backups/config`). */
  dir: string | null;
  /** Keep at most this many snapshots (newest first). 2–500. */
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
  /** Id of the data dir that made it (see {@link configBackupOrigin}), so instances sharing one folder keep to their own snapshots. */
  origin?: string;
  /**
   * The retention in force when it was made. If `settings.json` later fails to parse or is reset,
   * the next pass prunes with these instead of the defaults, so one bad write cannot shorten a
   * history the user asked to keep.
   */
  keepCount?: number;
  keepDays?: number;
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
    keepCount: intIn(
      s.configBackupKeepCount,
      CONFIG_BACKUP_MIN_KEEP_COUNT,
      CONFIG_BACKUP_MAX_KEEP_COUNT,
      CONFIG_BACKUP_DEFAULTS.keepCount
    ),
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

const ORIGIN_FILE = 'config-backup-id';
const ORIGIN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Who owns a snapshot: a random id made once and kept in the data dir. A hostname would not do (a
 * Docker container gets a new one on every recreate, which orphaned every earlier snapshot), nor
 * would the path alone (two machines can share a `$HOME` path). It is a file of its own, not the
 * hook secret, and is not tracked or restored. If it cannot be written the id is not persisted, so
 * snapshots made meanwhile are not listed later; the data dir being unwritable breaks far more.
 */
export function configBackupOrigin(dataDir: string): string {
  const path = join(dataDir, ORIGIN_FILE);
  try {
    const existing = readFileSync(path, 'utf8').trim();
    if (ORIGIN_RE.test(existing)) return existing;
  } catch {
    /* missing: made below */
  }
  const id = randomUUID();
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(path, id + '\n', { mode: 0o600 });
  } catch {
    /* see above */
  }
  return id;
}

/** The id already made for this data dir, or null. Read-only: listing must not write a file. */
export function readConfigBackupOrigin(dataDir: string): string | null {
  try {
    const existing = readFileSync(join(dataDir, ORIGIN_FILE), 'utf8').trim();
    return ORIGIN_RE.test(existing) ? existing : null;
  } catch {
    return null;
  }
}

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

/**
 * Keys a tracked file rewrites on its own schedule, with no change to anything the user set, so
 * they must not make a snapshot look different. `custom-model-hosts.json` carries a
 * `lastDiscoveredAt` per host that the model-discovery poll refreshes every 5 minutes: before this,
 * the change check never matched and the snapshot folder filled with copies that differed by one
 * timestamp, evicting every older snapshot within about 100 minutes at the default keep count.
 * The snapshot itself still stores the file exactly as it was, and restore still verifies against
 * the file's own digest; only the "has anything changed?" comparison looks through these keys.
 */
const VOLATILE_KEYS: Readonly<Record<string, readonly string[]>> = {
  'custom-model-hosts.json': ['lastDiscoveredAt'],
  // Rewritten by activity, not by anything the user set: a Basic-auth login (at most once a minute
  // per user), a session started in another case, every captured prompt, and a Docker case's
  // conversation id after a /clear, and a web tab being opened.
  'users.json': ['lastLoginAt'],
  'settings.json': ['lastUsedCase'],
  'intents.json': ['recentPrompts', 'updatedAt'],
  'docker-cases.json': ['lastClaudeSessionId'],
  'webviews.json': ['lastOpenedAt'],
};

function withoutKeys(value: unknown, drop: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((v) => withoutKeys(v, drop));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!drop.has(k)) out[k] = withoutKeys(v, drop);
    }
    return out;
  }
  return value;
}

/** Digest used only to decide whether two states are the same: the file's own, minus its volatile keys. */
function changeDigest(name: string, data: Buffer, rawSha: string): string {
  const volatile = VOLATILE_KEYS[name];
  if (!volatile) return rawSha;
  try {
    return sha256(JSON.stringify(withoutKeys(JSON.parse(data.toString('utf8')), new Set(volatile))));
  } catch {
    return rawSha; // not JSON (or unreadable as such): compare the bytes, as for any other file
  }
}

function stamp(now: number): string {
  const d = new Date(now);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function readManifest(dir: string, id: string, origin?: string): ConfigBackupManifest | null {
  if (!SNAPSHOT_ID_RE.test(id)) return null;
  try {
    const m = JSON.parse(readFileSync(join(dir, id, MANIFEST), 'utf8')) as ConfigBackupManifest;
    if (!m || m.id !== id || !Array.isArray(m.files) || typeof m.createdAt !== 'number' || typeof m.hash !== 'string') {
      return null;
    }
    if (origin !== undefined && m.origin !== origin) return null;
    return m;
  } catch {
    return null;
  }
}

/** A folder's entry names; none when it cannot be read (absent, or not a folder). */
function folderEntries(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/**
 * The manifests of the snapshots this module made among `names` in `dir`, newest first. Foreign
 * folders and files are ignored, and so are other instances' snapshots when `origin` is given (see
 * {@link configBackupOrigin}). Each one is a file read, so a pass does this once and passes the
 * result on (see {@link runConfigBackupPass}).
 */
function manifestsIn(dir: string, names: readonly string[], origin?: string): ConfigBackupManifest[] {
  const out: ConfigBackupManifest[] = [];
  for (const id of names) {
    const m = readManifest(dir, id, origin);
    if (m) out.push(m);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? 1 : -1));
}

/**
 * Snapshots this module made in `dir`, newest first. Foreign folders and files are ignored, and so
 * are other instances' snapshots when `origin` is given (see {@link configBackupOrigin}).
 */
export function listConfigBackups(dir: string, origin?: string): ConfigBackupSummary[] {
  return manifestsIn(dir, folderEntries(dir), origin).map((m) => {
    const files = m.files.map((f) => ({ name: f.name, bytes: f.bytes }));
    return {
      id: m.id,
      createdAt: m.createdAt,
      reason: m.reason,
      appVersion: m.appVersion,
      files,
      bytes: files.reduce((n, f) => n + f.bytes, 0),
    };
  });
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
  /** Recorded in the manifest, see {@link ConfigBackupManifest.keepCount}. */
  keepCount?: number;
  keepDays?: number;
  now?: number;
}

/** Snapshot the tracked files that exist, unless the latest snapshot already holds exactly this state. */
export function createConfigBackup(opts: CreateConfigBackupOptions): ConfigBackupResult {
  return snapshotConfig(opts).result;
}

/**
 * {@link createConfigBackup}, also returning the manifest it wrote, over this instance's snapshots
 * when the caller has already listed them (`listed`, newest first): one walk of the folder per pass.
 */
function snapshotConfig(
  opts: CreateConfigBackupOptions,
  listed?: { origin: string; existing: ConfigBackupManifest[] }
): { result: ConfigBackupResult; manifest: ConfigBackupManifest | null } {
  const now = opts.now ?? Date.now();
  const present: Array<{ name: string; data: Buffer; sha: string; change: string }> = [];
  for (const name of CONFIG_BACKUP_FILES) {
    try {
      const path = join(opts.dataDir, name);
      if (!statSync(path).isFile()) continue;
      const data = readFileSync(path);
      const sha = sha256(data);
      present.push({ name, data, sha, change: changeDigest(name, data, sha) });
    } catch {
      /* absent or unreadable: simply not part of this snapshot */
    }
  }
  if (present.length === 0) return { result: { status: 'empty' }, manifest: null };

  const hash = sha256(present.map((f) => `${f.name}\0${f.change}`).join('\n'));
  const origin = listed?.origin ?? configBackupOrigin(opts.dataDir);
  const existing = listed?.existing ?? manifestsIn(opts.backupDir, folderEntries(opts.backupDir), origin);
  if (!opts.force && existing[0] && existing[0].hash === hash) {
    return { result: { status: 'unchanged', id: existing[0].id }, manifest: null };
  }

  // Never dated earlier than this instance's newest snapshot. One written while the clock read ahead
  // (a dual-boot machine, a VM resumed with a stale clock) would otherwise stay newest after the
  // correction, differ from every later pass, and have each one write a copy until real time caught up.
  const createdAt = existing[0] ? Math.max(now, existing[0].createdAt + 1) : now;
  mkdirSync(opts.backupDir, { recursive: true, mode: 0o700 });
  const base = `cfg-${stamp(createdAt)}`;
  let id = base;
  for (let n = 2; existsSync(join(opts.backupDir, id)); n++) id = `${base}-${n}`;

  const tmp = join(opts.backupDir, `.tmp-${id}-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { mode: 0o700 });
  const manifest: ConfigBackupManifest = {
    id,
    createdAt,
    reason: opts.reason,
    appVersion: opts.appVersion ?? '',
    hash,
    origin,
    ...(opts.keepCount !== undefined && { keepCount: opts.keepCount }),
    ...(opts.keepDays !== undefined && { keepDays: opts.keepDays }),
    files: present.map((f) => ({ name: f.name, bytes: f.data.length, sha256: f.sha })),
  };
  try {
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
  const bytes = present.reduce((n, f) => n + f.data.length, 0);
  return { result: { status: 'created', id, files: present.length, bytes }, manifest };
}

/** Remove `.tmp-cfg-*` build folders a crashed snapshot left behind (older than an hour, so a live one on a shared folder is safe). */
export function sweepConfigBackupTemps(dir: string, now: number = Date.now()): void {
  sweepTemps(dir, folderEntries(dir), now);
}

function sweepTemps(dir: string, names: readonly string[], now: number): void {
  for (const n of names) {
    if (!/^\.tmp-cfg-\d{8}-\d{6}(?:-\d{1,3})?-\d+$/.test(n)) continue;
    const st = lstatSync(join(dir, n), { throwIfNoEntry: false });
    if (st && now - st.mtimeMs > 3_600_000) rmSync(join(dir, n), { recursive: true, force: true });
  }
}

/**
 * The retention recorded in this instance's newest snapshot, or null when it recorded none. `listed`
 * is this instance's manifests in `dir`, newest first, when the caller already read them.
 */
export function latestBackupRetention(
  dir: string,
  origin: string,
  listed?: readonly ConfigBackupManifest[]
): { keepCount: number; keepDays: number } | null {
  // The newest manifest that recorded one: a snapshot from before this field existed must not hide it.
  for (const m of listed ?? manifestsIn(dir, folderEntries(dir), origin)) {
    if (typeof m.keepCount === 'number' && typeof m.keepDays === 'number') {
      return { keepCount: m.keepCount, keepDays: m.keepDays };
    }
  }
  return null;
}

/**
 * The settings in effect, with each retention key that `raw` (the parsed settings.json) lacks, as
 * after a reset, taken from what the newest backup recorded in `dir` instead of the defaults. It
 * looks at the retention keys only (not the folder), so re-entering a custom folder after a reset
 * finds that folder's own manifests. One place for the timer pass and for what the GET route
 * reports, so they cannot disagree.
 */
export function withRecordedRetention(
  settings: ConfigBackupSettings,
  raw: Record<string, unknown>,
  dir: string,
  origin: string | null,
  listed?: readonly ConfigBackupManifest[]
): ConfigBackupSettings {
  const lacksCount = !('configBackupKeepCount' in raw);
  const lacksDays = !('configBackupKeepDays' in raw);
  if ((!lacksCount && !lacksDays) || !origin) return settings;
  const kept = latestBackupRetention(dir, origin, listed);
  if (!kept) return settings;
  return {
    ...settings,
    ...(lacksCount && { keepCount: kept.keepCount }),
    ...(lacksDays && { keepDays: kept.keepDays }),
  };
}

export interface PruneOptions {
  keepCount: number;
  keepDays: number;
  /** Only this instance's snapshots are pruned; omitted = every snapshot in the folder. */
  origin?: string;
  now?: number;
}

/**
 * Apply retention: keep the newest `keepCount`, and (when `keepDays` > 0) drop anything older than
 * that. The newest snapshot always survives. Returns the ids removed.
 */
export function pruneConfigBackups(dir: string, opts: PruneOptions): string[] {
  return pruneListed(dir, manifestsIn(dir, folderEntries(dir), opts.origin), opts);
}

/** {@link pruneConfigBackups} over a listing already made (`all`, newest first). */
function pruneListed(dir: string, all: ReadonlyArray<{ id: string; createdAt: number }>, opts: PruneOptions): string[] {
  const now = opts.now ?? Date.now();
  const cutoff = opts.keepDays > 0 ? now - opts.keepDays * 86_400_000 : null;
  const removed: string[] = [];
  all.forEach((b, index) => {
    if (index === 0) return;
    const tooMany = index >= Math.max(1, opts.keepCount);
    // A snapshot's state was live until the next one was made: age it from then. Aging by its own
    // createdAt deleted the last good copy on the first change after a quiet month.
    const tooOld = cutoff !== null && all[index - 1].createdAt < cutoff;
    if (!tooMany && !tooOld) return;
    // The listing already proved this is one of ours (name pattern + manifest).
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

export interface ConfigBackupPassOptions {
  dataDir: string;
  backupDir: string;
  reason: string;
  appVersion?: string;
  /** Snapshot even if nothing changed (Back up now). */
  force?: boolean;
  /** As read from settings.json ({@link readConfigBackupSettings}), before the recorded-retention fallback. */
  settings: ConfigBackupSettings;
  /** The parsed settings.json (`{}` when it did not parse): the fallback tells an absent key from a set one. */
  raw: Record<string, unknown>;
  /** False when settings.json did not parse: the pass still snapshots, but deletes nothing on its say-so. */
  prune: boolean;
  now?: number;
}

/**
 * One pass of the timer or of Back up now: sweep stale temp folders, snapshot when the state changed,
 * apply retention. The folder is read and each manifest parsed ONCE, and that listing feeds the
 * recorded-retention fallback, the change check and the prune. It used to be listed for each of the
 * three, which on a network folder is every manifest read three times every five minutes.
 */
export function runConfigBackupPass(opts: ConfigBackupPassOptions): {
  result: ConfigBackupResult;
  removed: string[];
} {
  const names = folderEntries(opts.backupDir);
  sweepTemps(opts.backupDir, names, Date.now());
  const origin = configBackupOrigin(opts.dataDir);
  const existing = manifestsIn(opts.backupDir, names, origin);
  // No retention in the file (reset, or unreadable): keep what the newest snapshot recorded.
  const { keepCount, keepDays } = withRecordedRetention(opts.settings, opts.raw, opts.backupDir, origin, existing);
  const { result, manifest } = snapshotConfig(
    {
      dataDir: opts.dataDir,
      backupDir: opts.backupDir,
      reason: opts.reason,
      appVersion: opts.appVersion,
      force: opts.force,
      keepCount,
      keepDays,
      now: opts.now,
    },
    { origin, existing }
  );
  if (!opts.prune) return { result, removed: [] };
  // A snapshot made now is dated after existing[0], so it heads the listing retention counts.
  const all = manifest ? [manifest, ...existing] : existing;
  return { result, removed: pruneListed(opts.backupDir, all, { keepCount, keepDays, now: opts.now }) };
}

export class ConfigBackupNotFoundError extends Error {}
export class ConfigBackupCorruptError extends Error {}

/**
 * A restore that wrote some files and could not write others (a full disk, a directory where a file
 * should be). Every file passed verification first, so the ones written are the backup's: the caller
 * still has to reload what they feed and tell the user which files are which.
 */
export class ConfigBackupPartialRestoreError extends Error {
  constructor(
    readonly restored: string[],
    readonly failed: Array<{ name: string; error: string }>,
    readonly untouched: string[],
    readonly safetySnapshot: string | null
  ) {
    const done = restored.length ? `${restored.join(', ')} restored` : 'nothing was restored';
    const undo = safetySnapshot ? `; the files from before the restore are in backup ${safetySnapshot}` : '';
    super(
      `Restore incomplete: could not write ${failed.map((f) => f.name).join(', ')} (${failed[0]?.error}); ${done}${undo}`
    );
  }
}

/**
 * Restore refuses what this module never writes. Snapshots are 0700/0600 real files, and a restore
 * writes the file as 0600: a symlink, or a file with a group/world bit, was planted or loosened
 * after the snapshot, and rewriting it as 0600 would turn it into trusted config (`clis.json`
 * selects the binaries Codeman spawns; `isUnsafePermissions` refuses the same bits there).
 * POSIX only, like `isUnsafePermissions`. The mode test is skipped (the symlink test is not) on a
 * filesystem that does not keep modes, see {@link folderKeepsModes}.
 */
function assertTrustedSnapshotEntry(path: string, label: string, checkMode: boolean): void {
  if (process.platform === 'win32') return;
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) return; // missing is reported by the read that follows
  if (st.isSymbolicLink()) throw new ConfigBackupCorruptError(`${label} is a symlink, so it is not used`);
  if (checkMode && (st.mode & 0o077) !== 0) {
    throw new ConfigBackupCorruptError(`${label} is readable or writable by group or others, so it is not used`);
  }
}

/**
 * Whether the backup folder's filesystem keeps a file's mode: vfat/exFAT, CIFS shares and WSL's
 * `/mnt/d` report 0755 or 0777 for everything, so the group/world test would refuse every backup
 * there even though snapshots succeed (`createConfigBackup` already expects mode-less filesystems).
 * Probed with a 0600 temp file made with `wx` under a random name; if the probe cannot run, the
 * strict test stays on.
 */
function folderKeepsModes(dir: string): boolean {
  if (process.platform === 'win32') return false;
  // A random name and 'wx' (fail if anything is there): a planted symlink or directory with a
  // guessable name must neither be written through nor break the probe. Only a file this call
  // created is removed.
  const probe = join(dir, `.mode-probe-${randomUUID()}`);
  let created = false;
  try {
    writeFileSync(probe, '', { mode: 0o600, flag: 'wx' });
    created = true;
    chmodSync(probe, 0o600);
    return (lstatSync(probe).mode & 0o777 & 0o077) === 0;
  } catch {
    return true;
  } finally {
    if (created) rmSync(probe, { force: true });
  }
}

/** The folder's own backup settings stay as they are now: restoring an old `configBackupDir` hides the `pre-restore` copy. */
const BACKUP_SETTING_KEYS = ['configBackupEnabled', 'configBackupDir', 'configBackupKeepCount', 'configBackupKeepDays'];

function keepCurrentBackupSettings(snapshot: Buffer, livePath: string): Buffer {
  try {
    const restored = JSON.parse(snapshot.toString('utf8')) as Record<string, unknown>;
    const live = JSON.parse(readFileSync(livePath, 'utf8')) as Record<string, unknown>;
    if (!restored || typeof restored !== 'object' || !live || typeof live !== 'object') return snapshot;
    let changed = false;
    // A reset live file lacks the retention keys. Taking "absent" for them would bring the defaults
    // back (20 copies, 30 days) on the next pass, so the backup's own retention stays.
    for (const key of BACKUP_SETTING_KEYS) {
      if (!(key in live) && (key === 'configBackupKeepCount' || key === 'configBackupKeepDays')) continue;
      if (JSON.stringify(restored[key]) === JSON.stringify(live[key])) continue;
      changed = true;
      if (key in live) restored[key] = live[key];
      else delete restored[key];
    }
    if (!changed) return snapshot; // byte-identical to the snapshot when the folder settings did not move
    return Buffer.from(JSON.stringify(restored, null, 2) + '\n');
  } catch {
    return snapshot; // not JSON, or no live file to take the values from
  }
}

export interface RestoreResult {
  restored: string[];
  /** Tracked files present now that the snapshot did not hold; a restore leaves them as they are. */
  untouched: string[];
  /**
   * The snapshot holding the live files as they were before the restore: the `pre-restore` copy, or the
   * newest backup when it already held exactly that state. Null only when no tracked file existed.
   */
  safetySnapshot: string | null;
}

/**
 * Put a snapshot's files back into the data dir. Every file is checked against the manifest's digest
 * BEFORE anything is written, a `pre-restore` snapshot of the live files is taken first (unless the
 * newest backup already holds that state, which is then reported instead), and each file is replaced
 * atomically (temp + rename) with mode 0600. A file that cannot be written does not stop the others;
 * it throws {@link ConfigBackupPartialRestoreError} at the end, naming both lists.
 */
export function restoreConfigBackup(opts: {
  dataDir: string;
  backupDir: string;
  id: string;
  appVersion?: string;
  now?: number;
  /** Override the probe of whether the backup folder keeps file modes (tests; a mode-less filesystem). */
  keepsModes?: boolean;
}): RestoreResult {
  const origin = readConfigBackupOrigin(opts.dataDir);
  const manifest = origin ? readManifest(opts.backupDir, opts.id, origin) : null;
  if (!manifest || !origin) throw new ConfigBackupNotFoundError(`No config backup named ${opts.id}`);

  const allowed = new Set<string>(CONFIG_BACKUP_FILES);
  const loaded: Array<{ name: string; data: Buffer }> = [];
  const checkMode = opts.keepsModes ?? folderKeepsModes(opts.backupDir);
  assertTrustedSnapshotEntry(join(opts.backupDir, opts.id), `Backup ${opts.id}`, checkMode);
  for (const f of manifest.files) {
    if (!allowed.has(f.name)) continue;
    let data: Buffer;
    assertTrustedSnapshotEntry(join(opts.backupDir, opts.id, f.name), `${f.name} in ${opts.id}`, checkMode);
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

  // One walk of the folder serves both the recorded retention and the snapshot below.
  const existing = manifestsIn(opts.backupDir, folderEntries(opts.backupDir), origin);
  const { result: safety } = snapshotConfig(
    {
      dataDir: opts.dataDir,
      backupDir: opts.backupDir,
      reason: 'pre-restore',
      appVersion: opts.appVersion,
      // Not forced: when the live files equal the newest backup, that backup already is the undo copy,
      // and a forced duplicate would spend a retention slot on nothing.
      now: opts.now,
      // The retention in force, so this newest snapshot does not hide it from the next pass.
      ...(latestBackupRetention(opts.backupDir, origin, existing) ?? {}),
    },
    { origin, existing }
  );

  mkdirSync(opts.dataDir, { recursive: true });
  const restored: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];
  for (const f of loaded) {
    const target = join(opts.dataDir, f.name);
    const tmp = `${target}.restore-${process.pid}`;
    try {
      writeFileSync(tmp, f.name === 'settings.json' ? keepCurrentBackupSettings(f.data, target) : f.data, {
        mode: 0o600,
      });
      renameSync(tmp, target);
      restored.push(f.name);
    } catch (err) {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* the temp is a leftover at worst; the failure below is what matters */
      }
      // Keep going: each file is replaced on its own, and the files written before this one are the
      // backup's already. Stopping here used to answer a bare 500 that named neither list.
      failed.push({ name: f.name, error: err instanceof Error ? err.message : String(err) });
    }
  }
  // A restore never deletes: tracked files the snapshot did not hold stay as they are.
  const untouched = CONFIG_BACKUP_FILES.filter(
    (n) =>
      !restored.includes(n) &&
      !failed.some((x) => x.name === n) &&
      lstatSync(join(opts.dataDir, n), { throwIfNoEntry: false })?.isFile()
  );
  const safetySnapshot = safety.status === 'empty' ? null : safety.id;
  if (failed.length) throw new ConfigBackupPartialRestoreError(restored, failed, untouched, safetySnapshot);
  return { restored, untouched, safetySnapshot };
}

/** The live files in the data dir, as a side of a diff. */
export const CONFIG_DIFF_CURRENT = 'current';

export interface ConfigDiffChange {
  /** Dotted path inside the file (`a.b[0].c`), or the variable name for `.env`. */
  path: string;
  kind: 'added' | 'removed' | 'changed';
  /** JSON text of the value; absent when it did not exist on that side or `redacted` is set. */
  before?: string;
  after?: string;
  /** The value is a credential, so only the fact that it differs is reported. */
  redacted?: boolean;
}

export interface ConfigDiffFile {
  name: string;
  /** `added` = only in `to`, `removed` = only in `from`. */
  status: 'added' | 'removed' | 'changed' | 'unchanged';
  changes: ConfigDiffChange[];
  /** More changes than `MAX_DIFF_CHANGES`; the rest are not listed. */
  truncated: boolean;
  /** `keys` = per-key changes; `bytes` = the file is not JSON/env, so only "differs" is known. */
  detail: 'keys' | 'bytes';
}

export interface ConfigDiff {
  from: string;
  to: string;
  files: ConfigDiffFile[];
  /** Files whose status is not `unchanged`. */
  changed: number;
}

const MAX_DIFF_CHANGES = 200;
const MAX_DIFF_VALUE_CHARS = 200;

/** Files whose every value is a credential or key: only names are ever shown. */
const REDACT_ALL_FILES: ReadonlySet<string> = new Set([
  '.env',
  'users.json',
  'push-keys.json',
  'webhook.json',
  'intents.json',
]);
/** Elsewhere a value is hidden when its own key looks like a credential. */
const SECRET_KEY_RE = /(token|secret|passw|credential|auth|key$)/i;

type Leaves = Map<string, string>;

function flattenJson(value: unknown, path: string, out: Leaves): void {
  if (Array.isArray(value) && value.length > 0) {
    value.forEach((v, i) => flattenJson(v, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object' && Object.keys(value).length > 0) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      flattenJson(v, path ? `${path}.${k}` : k, out);
    }
  } else {
    out.set(path || '(root)', JSON.stringify(value) ?? 'null');
  }
}

function parseEnv(text: string): Leaves {
  const out: Leaves = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=(.*)$/.exec(line);
    if (m) out.set(m[1], m[2].trim());
  }
  return out;
}

/** Per-key view of a tracked file, or null when it is not JSON/env text. */
function leavesOf(name: string, data: Buffer): Leaves | null {
  const text = data.toString('utf8');
  if (name === '.env') return parseEnv(text);
  try {
    const parsed = JSON.parse(text) as unknown;
    const volatile = VOLATILE_KEYS[name];
    const out: Leaves = new Map();
    flattenJson(volatile ? withoutKeys(parsed, new Set(volatile)) : parsed, '', out);
    return out;
  } catch {
    return null;
  }
}

/** A URL value loses its userinfo, query and fragment: they carry passwords and tokens. */
function scrubUrl(jsonText: string): string {
  try {
    const v = JSON.parse(jsonText) as unknown;
    if (typeof v !== 'string' || !/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return jsonText;
    const u = new URL(v);
    if (!u.username && !u.password && !u.search && !u.hash) return jsonText;
    return JSON.stringify(`${u.protocol}//${u.host}${u.pathname}`);
  } catch {
    return jsonText;
  }
}

const clip = (s: string): string => (s.length > MAX_DIFF_VALUE_CHARS ? `${s.slice(0, MAX_DIFF_VALUE_CHARS)}…` : s);

function diffLeaves(name: string, a: Leaves, b: Leaves): { changes: ConfigDiffChange[]; truncated: boolean } {
  const all = REDACT_ALL_FILES.has(name);
  const changes: ConfigDiffChange[] = [];
  for (const path of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const before = a.get(path);
    const after = b.get(path);
    if (before === after) continue;
    const kind = before === undefined ? 'added' : after === undefined ? 'removed' : 'changed';
    if (all || SECRET_KEY_RE.test(path.split('.').pop() ?? '')) {
      changes.push({ path, kind, redacted: true });
    } else {
      changes.push({
        path,
        kind,
        ...(before !== undefined && { before: clip(scrubUrl(before)) }),
        ...(after !== undefined && { after: clip(scrubUrl(after)) }),
      });
    }
  }
  return { changes: changes.slice(0, MAX_DIFF_CHANGES), truncated: changes.length > MAX_DIFF_CHANGES };
}

/** The tracked files of one side, verified: a snapshot's against its manifest, the live ones as they are. */
function loadDiffSide(side: string, dataDir: string, backupDir: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (side === CONFIG_DIFF_CURRENT) {
    for (const name of CONFIG_BACKUP_FILES) {
      try {
        const path = join(dataDir, name);
        if (statSync(path).isFile()) out.set(name, readFileSync(path));
      } catch {
        /* absent or unreadable: not part of this side */
      }
    }
    return out;
  }
  const origin = readConfigBackupOrigin(dataDir);
  const manifest = origin ? readManifest(backupDir, side, origin) : null;
  if (!manifest) throw new ConfigBackupNotFoundError(`No config backup named ${side}`);
  const allowed = new Set<string>(CONFIG_BACKUP_FILES);
  const checkMode = folderKeepsModes(backupDir);
  assertTrustedSnapshotEntry(join(backupDir, side), `Backup ${side}`, checkMode);
  for (const f of manifest.files) {
    if (!allowed.has(f.name)) continue;
    let data: Buffer;
    assertTrustedSnapshotEntry(join(backupDir, side, f.name), `${f.name} in ${side}`, checkMode);
    try {
      data = readFileSync(join(backupDir, side, f.name));
    } catch {
      throw new ConfigBackupCorruptError(`${f.name} is missing from ${side}`);
    }
    if (sha256(data) !== f.sha256)
      throw new ConfigBackupCorruptError(`${f.name} in ${side} does not match its checksum`);
    out.set(f.name, data);
  }
  return out;
}

/**
 * What differs between two states of the tracked files; a state is a snapshot id or `current`
 * (the live files). Never returns the value of a credential: see REDACT_ALL_FILES and SECRET_KEY_RE.
 */
export function diffConfigBackups(opts: { dataDir: string; backupDir: string; from: string; to: string }): ConfigDiff {
  const a = loadDiffSide(opts.from, opts.dataDir, opts.backupDir);
  const b = loadDiffSide(opts.to, opts.dataDir, opts.backupDir);
  const files: ConfigDiffFile[] = [];
  for (const name of CONFIG_BACKUP_FILES) {
    const before = a.get(name);
    const after = b.get(name);
    if (!before && !after) continue;
    const base = { name, changes: [] as ConfigDiffChange[], truncated: false };
    if (before && after && sha256(before) === sha256(after)) {
      files.push({ ...base, status: 'unchanged', detail: 'keys' });
      continue;
    }
    const la = before ? leavesOf(name, before) : new Map<string, string>();
    const lb = after ? leavesOf(name, after) : new Map<string, string>();
    const status = !before ? 'added' : !after ? 'removed' : 'changed';
    if (!la || !lb) {
      files.push({ ...base, status, detail: 'bytes' });
      continue;
    }
    const { changes, truncated } = diffLeaves(name, la, lb);
    // Only volatile keys differed (a discovery timestamp): the same state as far as the user is concerned.
    files.push({
      name,
      status: changes.length || status !== 'changed' ? status : 'unchanged',
      changes,
      truncated,
      detail: 'keys',
    });
  }
  return { from: opts.from, to: opts.to, files, changed: files.filter((f) => f.status !== 'unchanged').length };
}
