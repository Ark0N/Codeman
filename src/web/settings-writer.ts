/**
 * @fileoverview The writer of the server's `settings.json` (`SETTINGS_PATH`).
 *
 * Every read-modify-write of that file goes through `mutateSettingsFile()`, the same shape as
 * `mutateRegistryFile()` (config/cli-registry/registry-writer.ts). The one direct writer is
 * config-backup restore (`restoreConfigBackup()`, as for `clis.json`): it must work on a file that
 * does not parse, which this writer refuses.
 *
 * - **Serialized.** Mutations run one at a time on a single promise chain, each one reading,
 *   changing and writing before the next starts. The writers used to run unserialized with a
 *   plain truncate-then-write `fs.writeFile`, and quick-start did not even await its
 *   `lastUsedCase` write, so a quick-start followed by a settings save could tear the file (one
 *   write's bytes over the tail of a longer one) or drop the other writer's key.
 * - **Atomic.** Each write goes to its own temp file beside the target and is renamed over it,
 *   so a reader never sees a half-written file.
 * - **Refuses a file it must not trust.** Only a missing (or empty) file starts from `{}`. A file
 *   that cannot be read or does not parse is left alone and the write throws
 *   `SettingsWriteRefusedError`: the writers used to read such a file as `{}` and write back only
 *   their own keys, which erased every other setting.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { ApiErrorCode, createErrorResponse, getErrorMessage, type ApiResponse } from '../types.js';
import { SETTINGS_PATH } from './route-helpers.js';

export type SettingsFile = Record<string, unknown>;

/** A write refused because the existing `settings.json` must not be overwritten. The message is user-facing. */
export class SettingsWriteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SettingsWriteRefusedError';
  }
}

async function readSettingsForWrite(path: string): Promise<SettingsFile> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new SettingsWriteRefusedError(
      `Cannot read ${path} (${(err as Error).message}), so this change was not saved.`
    );
  }
  // An empty file holds no settings to lose.
  if (raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  // The parser's own message is not repeated: it can quote the file, which may hold an API key.
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SettingsWriteRefusedError(
      `${path} is not a valid JSON object, so this change was not saved (saving would have replaced every other setting in it). Fix or delete the file, or restore it from a config backup, then try again.`
    );
  }
  return parsed as SettingsFile;
}

async function writeSettingsFile(path: string, settings: SettingsFile): Promise<void> {
  // Through a symlink, as the plain writeFile this replaces did: the rename lands on the real file.
  const target = await fs.realpath(path).catch(() => path);
  await fs.mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(settings, null, 2), { mode: 0o600 });
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

let mutationChain: Promise<unknown> = Promise.resolve();

/**
 * Run one change to `settings.json`. `fn` receives the current settings and returns the settings
 * to write, or `undefined` to write nothing. Resolves with the settings before and after the
 * change (`after` is `undefined` when nothing was written). A refused or failed mutation rejects
 * its own caller only; the chain keeps going.
 */
export function mutateSettingsFile(
  fn: (current: SettingsFile) => SettingsFile | undefined
): Promise<{ before: SettingsFile; after: SettingsFile | undefined }> {
  const run = mutationChain.then(async () => {
    const before = await readSettingsForWrite(SETTINGS_PATH).catch((err: unknown) => {
      console.warn(`[settings] write refused: ${getErrorMessage(err)}`);
      throw err;
    });
    const after = fn({ ...before });
    if (after) await writeSettingsFile(SETTINGS_PATH, after);
    return { before, after };
  });
  mutationChain = run.catch(() => {});
  return run;
}

/**
 * Rejects with `SettingsWriteRefusedError` when `mutateSettingsFile()` would refuse a write right
 * now: the writer's own read-for-write rule, run on its own. For a route that does something it
 * cannot take back (case rename ends sessions) before its settings write. A check only, outside
 * the chain (writes are atomic, so it never reads a half-written file); the file can still change
 * before the write.
 */
export async function assertSettingsWritable(): Promise<void> {
  await readSettingsForWrite(SETTINGS_PATH);
}

/** A refused write answers 409 CONFLICT with the fix; any other failure stays OPERATION_FAILED. */
export function settingsWriteErrorResponse(err: unknown): ApiResponse<never> {
  if (err instanceof SettingsWriteRefusedError) return createErrorResponse(ApiErrorCode.CONFLICT, err.message);
  return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
}
