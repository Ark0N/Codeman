/**
 * @fileoverview Config backups (src/config-backup.ts).
 *
 * GET  /api/config-backups              — settings in effect, the folder, and the snapshots in it.
 * POST /api/config-backups              — snapshot now (a manual request always makes one).
 * POST /api/config-backups/:id/restore  — put a snapshot's files back (after a `pre-restore` snapshot).
 * GET  /api/config-backups/diff?from=&to= — what differs between two snapshots, or a snapshot and the
 *                                           running config (`current`, the default for `to`).
 *
 * The files include credentials (`.env`, `users.json`, endpoint keys), so in multi-user mode all three
 * are admin only. Responses carry file NAMES and sizes, never file content, except the diff, which shows
 * changed values but never a credential's (`.env`, `users.json`, `push-keys.json` and any key that looks
 * like a token/secret/password are reported as "changed" only). Restore replaces files the running server
 * may have cached: `restartRequired` says which ones only apply after a restart.
 */

import { createRequire } from 'node:module';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { ApiErrorCode, createErrorResponse, getErrorMessage, type ApiResponse } from '../../types.js';
import { isAdmin, readJsonConfig, SETTINGS_PATH } from '../route-helpers.js';
import { isMultiUserMode } from '../../config/multiuser.js';
import { getDataDir } from '../../config/instance.js';
import {
  CONFIG_BACKUP_FILES,
  CONFIG_DIFF_CURRENT,
  ConfigBackupCorruptError,
  ConfigBackupNotFoundError,
  createConfigBackup,
  defaultConfigBackupDir,
  diffConfigBackups,
  listConfigBackups,
  pruneConfigBackups,
  readConfigBackupSettings,
  resolveConfigBackupDir,
  restoreConfigBackup,
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

/** Files whose running-process copy only reloads on restart (the rest are read per request). */
const RESTART_REQUIRED = new Set<string>(['clis.json', 'users.json', '.env', 'push-keys.json']);

export interface ConfigBackupStatus {
  settings: ConfigBackupSettings;
  dir: string;
  defaultDir: string;
  tracked: readonly string[];
  backups: ConfigBackupSummary[];
}

export async function readEffectiveBackupSettings(): Promise<{ settings: ConfigBackupSettings; dir: string }> {
  const raw = await readJsonConfig<Record<string, unknown>>(SETTINGS_PATH, 'settings.json', {});
  const settings = readConfigBackupSettings(raw);
  return { settings, dir: resolveConfigBackupDir(settings, getDataDir()) };
}

/** Snapshot (when changed) and apply retention; shared by the timer and the manual route. */
export async function runConfigBackup(
  reason: string,
  opts: { force?: boolean } = {}
): Promise<{ result: ConfigBackupResult; removed: string[] } | null> {
  const { settings, dir } = await readEffectiveBackupSettings();
  if (!settings.enabled && !opts.force) return null;
  const result = createConfigBackup({
    dataDir: getDataDir(),
    backupDir: dir,
    reason,
    appVersion: APP_VERSION,
    force: opts.force,
  });
  const removed = pruneConfigBackups(dir, { keepCount: settings.keepCount, keepDays: settings.keepDays });
  return { result, removed };
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
    const { settings, dir } = await readEffectiveBackupSettings();
    return {
      success: true,
      data: {
        settings,
        dir,
        defaultDir: defaultConfigBackupDir(getDataDir()),
        tracked: CONFIG_BACKUP_FILES,
        backups: listConfigBackups(dir),
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
      reply.code(500);
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
      reply.code(500);
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Diff failed: ${getErrorMessage(err)}`);
    }
  });

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
          safetySnapshot: out.safetySnapshot,
          restartRequired: out.restored.filter((n) => RESTART_REQUIRED.has(n)),
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
      reply.code(500);
      return createErrorResponse(ApiErrorCode.OPERATION_FAILED, `Restore failed: ${getErrorMessage(err)}`);
    }
  });
}
