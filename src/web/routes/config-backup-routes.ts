/**
 * @fileoverview Config backups (src/config-backup.ts).
 *
 * GET  /api/config-backups              — settings in effect, the folder, and the snapshots in it.
 * POST /api/config-backups              — snapshot now (a manual request always makes one).
 * POST /api/config-backups/:id/restore  — put a snapshot's files back (after a `pre-restore` snapshot).
 * GET  /api/config-backups/diff?from=&to= — what differs between two snapshots, or a snapshot and the
 *                                           running config (`current`, the default for `to`).
 *
 * The files include credentials (`.env`, `users.json`, endpoint keys), so in multi-user mode all four
 * are admin only. Responses carry file NAMES and sizes, never file content, except the diff, which shows
 * changed values but never a credential's (`.env`, `users.json`, `push-keys.json`, `webhook.json`, `intents.json` and any key that looks
 * like a token/secret/password are reported as "changed" only). Restore replaces files the running server
 * may have cached: `restartRequired` says which ones only apply after a restart. A restore that could not
 * write every file answers 500 with the error envelope plus `data` (`restored`, `failed`, `untouched`,
 * `safetySnapshot`, `restartRequired`): the files it wrote stay restored and are reloaded like a full one.
 */

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiErrorCode, createErrorResponse, getErrorMessage, type ApiResponse } from '../../types.js';
import { getAuthUser, isAdmin, readJsonConfig, SETTINGS_PATH } from '../route-helpers.js';
import { appendAdminAudit } from '../admin-audit.js';
import { reloadCliRegistry } from '../../config/cli-registry/registry.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { getDataDir } from '../../config/instance.js';
import { intentStore } from '../../intent-store.js';
import { describeUnknownPath, probePathKind } from '../../utils/bounded-path-probe.js';
import { dirname } from 'node:path';
import {
  CONFIG_BACKUP_FILES,
  CONFIG_DIFF_CURRENT,
  ConfigBackupCorruptError,
  ConfigBackupNotFoundError,
  ConfigBackupPartialRestoreError,
  defaultConfigBackupDir,
  diffConfigBackups,
  listConfigBackups,
  readConfigBackupSettings,
  resolveConfigBackupDir,
  restoreConfigBackup,
  runConfigBackupPass,
  withRecordedRetention,
  readConfigBackupOrigin,
  type ConfigBackupResult,
  type ConfigBackupSettings,
  type ConfigBackupSummary,
  type ConfigDiff,
} from '../../config-backup.js';

// Only recorded in each manifest; a missing package.json just leaves it blank.
const APP_VERSION: string = (() => {
  try {
    return (createRequire(import.meta.url)('../../../package.json') as { version?: string }).version ?? '';
  } catch {
    return '';
  }
})();

/** Files whose running-process copy only reloads on restart (the rest are read per request; `users.json`
 * is re-read within a second, `clis.json` is reloaded below, `intents.json` by `reload()`). */
const RESTART_REQUIRED = new Set<string>(['.env', 'push-keys.json', 'settings.json']);

export interface ConfigBackupStatus {
  settings: ConfigBackupSettings;
  dir: string;
  defaultDir: string;
  tracked: readonly string[];
  backups: ConfigBackupSummary[];
}

/**
 * The settings in effect and the folder they name. A custom folder is probed (bounded, #516) BEFORE
 * the recorded-retention fallback reads it, so this throws `BackupDirUnavailableError` for a folder
 * that does not answer and never lists it; `present` is false for a custom folder that does not exist yet.
 */
export async function readEffectiveBackupSettings(): Promise<{
  settings: ConfigBackupSettings;
  dir: string;
  present: boolean;
}> {
  const raw = await readJsonConfig<Record<string, unknown>>(SETTINGS_PATH, 'settings.json', {});
  const base = readConfigBackupSettings(raw);
  const dir = resolveConfigBackupDir(base, getDataDir());
  const present = await probeBackupDir(base, dir);
  // The same fallback the timer pass uses, so the form never shows 20 / 30 while a pass keeps 100 / 0.
  const settings = present ? withRecordedRetention(base, raw, dir, readConfigBackupOrigin(getDataDir())) : base;
  return { settings, dir, present };
}

/** A user-chosen backup folder that is not safe to touch (bounded probe, as for case paths, #516). */
export class BackupDirUnavailableError extends Error {}

/**
 * Probe a custom backup folder without blocking the event loop on a dead mount. The default folder
 * needs no probe. Returns whether the folder exists; throws when it did not answer, or is not a
 * folder. A missing custom folder is only creatable when its parent is present.
 */
export async function probeBackupDir(settings: ConfigBackupSettings, dir: string): Promise<boolean> {
  if (!settings.dir || dir === defaultConfigBackupDir(getDataDir())) return true;
  const kind = await probePathKind(dir, { pastCap: true });
  if (kind === 'unknown')
    throw new BackupDirUnavailableError(describeUnknownPath('Backup folder', dir, { pastCap: true }));
  if (kind === 'file') throw new BackupDirUnavailableError(`Backup folder is a file, not a folder: ${dir}`);
  if (kind === 'directory') return true;
  const parent = await probePathKind(dirname(dir), { pastCap: true });
  if (parent === 'unknown') {
    throw new BackupDirUnavailableError(describeUnknownPath('Backup folder', dirname(dir), { pastCap: true }));
  }
  if (parent !== 'directory') throw new BackupDirUnavailableError(`Backup folder's parent is missing: ${dirname(dir)}`);
  return false;
}

async function readSettingsForBackup(): Promise<Record<string, unknown> | 'unreadable'> {
  try {
    const parsed: unknown = JSON.parse(await readFile(SETTINGS_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : 'unreadable';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? {} : 'unreadable';
  }
}

/** Snapshot (when changed) and apply retention; shared by the timer and the manual route. */
export async function runConfigBackup(
  reason: string,
  opts: { force?: boolean } = {}
): Promise<{ result: ConfigBackupResult; removed: string[] } | null> {
  // Read settings.json directly: readJsonConfig answers {} for ANY failure, so a syntax error or a read
  // that lands inside PUT /api/settings's non-atomic write used to prune with the defaults (20 / 30
  // days) and drop the longer history the user asked to keep.
  const raw = await readSettingsForBackup();
  const unreadable = raw === 'unreadable';
  const fromFile = readConfigBackupSettings(unreadable ? {} : raw);
  if (!fromFile.enabled && !opts.force) return null;
  const dir = resolveConfigBackupDir(fromFile, getDataDir());
  await probeBackupDir(fromFile, dir);
  return runConfigBackupPass({
    dataDir: getDataDir(),
    backupDir: dir,
    reason,
    appVersion: APP_VERSION,
    force: opts.force,
    settings: fromFile,
    raw: unreadable ? {} : raw,
    // An unreadable settings.json still gets its snapshot, but no pass deletes anything on its say-so.
    prune: !unreadable,
  });
}

export function registerConfigBackupRoutes(app: FastifyInstance): void {
  const deny = (req: FastifyRequest, reply: FastifyReply): ApiResponse<never> | null => {
    if (isMultiUserMode() && !isAdmin(req)) {
      reply.code(403);
      return createErrorResponse(ApiErrorCode.FORBIDDEN, 'Admin only in multi-user mode');
    }
    return null;
  };

  app.get('/api/config-backups', async (req, reply): Promise<ApiResponse<ConfigBackupStatus>> => {
    const denied = deny(req, reply);
    if (denied) return denied;
    let eff: Awaited<ReturnType<typeof readEffectiveBackupSettings>>;
    try {
      eff = await readEffectiveBackupSettings();
    } catch (err) {
      reply.code(503);
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
    }
    const { settings, dir, present } = eff;
    // Read-only: a listing must not create config-backup-id, and without one nothing can be ours.
    const origin = readConfigBackupOrigin(getDataDir());
    return {
      success: true,
      data: {
        settings,
        dir,
        defaultDir: defaultConfigBackupDir(getDataDir()),
        tracked: CONFIG_BACKUP_FILES,
        backups: present && origin ? listConfigBackups(dir, origin) : [],
      },
    };
  });

  app.post('/api/config-backups', async (req, reply) => {
    const denied = deny(req, reply);
    if (denied) return denied;
    try {
      const out = await runConfigBackup('manual', { force: true });
      return { success: true, data: { ...out!.result, removed: out!.removed } };
    } catch (err) {
      reply.code(err instanceof BackupDirUnavailableError ? 503 : 500);
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Backup failed: ${getErrorMessage(err)}`);
    }
  });

  app.get('/api/config-backups/diff', async (req, reply): Promise<ApiResponse<ConfigDiff>> => {
    const denied = deny(req, reply);
    if (denied) return denied;
    const q = req.query as { from?: string; to?: string };
    if (typeof q.from !== 'string' || !q.from) {
      reply.code(400);
      return createErrorResponse(ApiErrorCode.INVALID_INPUT, '`from` is required (a backup id or "current")');
    }
    try {
      const { dir } = await readEffectiveBackupSettings();
      const data = diffConfigBackups({
        dataDir: getDataDir(),
        backupDir: dir,
        from: q.from,
        to: typeof q.to === 'string' && q.to ? q.to : CONFIG_DIFF_CURRENT,
      });
      return { success: true, data };
    } catch (err) {
      if (err instanceof ConfigBackupNotFoundError) {
        reply.code(404);
        return createErrorResponse(ApiErrorCode.NOT_FOUND, err.message);
      }
      if (err instanceof ConfigBackupCorruptError) {
        reply.code(409);
        return createErrorResponse(ApiErrorCode.CONFLICT, err.message);
      }
      reply.code(err instanceof BackupDirUnavailableError ? 503 : 500);
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Diff failed: ${getErrorMessage(err)}`);
    }
  });

  /**
   * What a restore that wrote files must do, whether or not every file made it: reload what the running
   * server caches, audit it, and name the files that only apply after a restart.
   */
  const afterRestore = (req: FastifyRequest, id: string, restored: string[], failed: string[] = []): string[] => {
    // IntentStore caches the file and rewrites it whole on the next prompt, which would undo the restore.
    if (restored.includes('intents.json')) intentStore.reload();
    // restoreConfigBackup writes clis.json directly (the one writer besides mutateRegistryFile).
    if (restored.includes('clis.json')) reloadCliRegistry();
    // A restore of users.json replaces accounts, password hashes, roles and bypass grants.
    if (isMultiUserMode()) {
      void appendAdminAudit({
        admin: getAuthUser(req).username,
        action: 'config_backup_restore',
        target: id,
        ip: req.ip,
        detail: { restored, ...(failed.length > 0 && { failed }) },
      });
    }
    return restored.filter((n) => RESTART_REQUIRED.has(n));
  };

  app.post('/api/config-backups/:id/restore', async (req, reply) => {
    const denied = deny(req, reply);
    if (denied) return denied;
    const { id } = req.params as { id: string };
    try {
      const { dir } = await readEffectiveBackupSettings();
      const out = restoreConfigBackup({ dataDir: getDataDir(), backupDir: dir, id, appVersion: APP_VERSION });
      return {
        success: true,
        data: {
          restored: out.restored,
          untouched: out.untouched,
          safetySnapshot: out.safetySnapshot,
          restartRequired: afterRestore(req, id, out.restored),
        },
      };
    } catch (err) {
      if (err instanceof ConfigBackupNotFoundError) {
        reply.code(404);
        return createErrorResponse(ApiErrorCode.NOT_FOUND, err.message);
      }
      if (err instanceof ConfigBackupCorruptError) {
        reply.code(409);
        return createErrorResponse(ApiErrorCode.CONFLICT, `${err.message}. Nothing was changed.`);
      }
      if (err instanceof ConfigBackupPartialRestoreError) {
        // Some files are the backup's now: the client must learn which (Settings re-reads a restored
        // settings.json, or its next Save writes the old values back) and where the undo copy is.
        const failedNames = err.failed.map((f) => f.name);
        const restartRequired = afterRestore(req, id, err.restored, failedNames);
        reply.code(500);
        return {
          ...createErrorResponse(ApiErrorCode.OPERATION_FAILED, err.message),
          data: {
            restored: err.restored,
            failed: err.failed,
            untouched: err.untouched,
            safetySnapshot: err.safetySnapshot,
            restartRequired,
          },
        };
      }
      reply.code(err instanceof BackupDirUnavailableError ? 503 : 500);
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Restore failed: ${getErrorMessage(err)}`);
    }
  });
}
