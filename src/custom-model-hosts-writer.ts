/**
 * @fileoverview The serialized writer of `custom-model-hosts.json`, the store of the saved
 * custom model endpoints (src/custom-model-hosts.ts).
 *
 * Why it exists: `writeCustomModelHosts()` writes through ONE temp file name per process and
 * has no queue, and `readCustomModelHosts()` reads a file that does not parse as an empty
 * list. Two overlapping writers (an endpoint route and the 5-minute discovery sweep) can
 * leave one body over the tail of a longer one, and the next writer then saves a file that
 * holds only its own record: every other endpoint and its API key is gone. The same fault
 * `mutateSettingsFile()` ended for `settings.json`.
 *
 * The shape of `mutateSettingsFile()` (src/web/settings-writer.ts):
 *  - Serialized: mutations run one at a time on one promise chain. The check a route makes
 *    (the id is free, the record still exists) runs INSIDE `fn`, in the same step as the write.
 *  - Atomic: each write goes to a temp file with a random name beside the target and is
 *    renamed over it. The file is mode 0600 (it holds API keys).
 *  - Refuses a file it must not trust: only a missing or empty file starts from an empty
 *    list. A file that cannot be read, does not parse or is not an array is left alone and
 *    the write rejects with `CustomModelHostsWriteRefusedError`. The message never repeats
 *    the parser's own text, which can quote an API key.
 *
 * EVERY writer goes through it: the four endpoint routes of
 * src/web/routes/custom-model-routes.ts (create, update, delete, discover-models), the
 * discovery sweep `refreshAllCustomModelHosts()`, and the local model's connect step. The one
 * direct writer left is config-backup restore, which must work on a file that does not parse.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { getDataDir } from './config/instance.js';
import { customModelHostsPath, type CustomModelHost } from './custom-model-hosts.js';
import { ApiErrorCode, createErrorResponse, getErrorMessage, type ApiResponse } from './types.js';

/** A write refused because the existing `custom-model-hosts.json` must not be overwritten. The message is user-facing. */
export class CustomModelHostsWriteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomModelHostsWriteRefusedError';
  }
}

/** The list a write starts from. Only a missing or empty file is an empty list; anything else that is not an array is refused. */
async function readHostsForWrite(path: string): Promise<CustomModelHost[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new CustomModelHostsWriteRefusedError(
      `Cannot read ${path} (${(err as Error).message}), so this change was not saved.`
    );
  }
  // An empty file holds no endpoint to lose.
  if (raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed)) {
    throw new CustomModelHostsWriteRefusedError(
      `${path} is not a valid JSON list, so this change was not saved (saving would have replaced every other model endpoint in it, with its API key). Fix or delete the file, or restore it from a config backup, then try again.`
    );
  }
  return parsed as CustomModelHost[];
}

async function writeHostsFile(path: string, hosts: CustomModelHost[]): Promise<void> {
  // Through a symlink: the rename lands on the real file.
  const target = await fs.realpath(path).catch(() => path);
  await fs.mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(hosts, null, 2), { mode: 0o600 });
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

let mutationChain: Promise<unknown> = Promise.resolve();

/** What a mutation returns: the list to write (absent: write nothing) and what the caller gets back. */
export interface CustomModelHostsMutation<T> {
  /** The whole list to store. Absent: the file is left as it is. */
  hosts?: CustomModelHost[];
  /** Handed back to the caller of `mutateCustomModelHosts()`. */
  result: T;
}

/**
 * Runs one change to the endpoint store. `fn` receives the current list (a copy it may change)
 * and returns what to write and what to hand back. Resolves with `result`. A refused or failed
 * mutation rejects its own caller only; the chain keeps going.
 *
 * `configDir` is the folder of the file, as for `readCustomModelHosts()`. Default: the data dir.
 */
export function mutateCustomModelHosts<T>(
  fn: (hosts: CustomModelHost[]) => CustomModelHostsMutation<T>,
  configDir?: string
): Promise<T> {
  const run = mutationChain.then(async () => {
    // Resolved inside the chain: the data dir is read when the mutation runs, like the file.
    const path = customModelHostsPath(configDir ?? getDataDir());
    const current = await readHostsForWrite(path).catch((err: unknown) => {
      console.warn(`[custom-model] write refused: ${getErrorMessage(err)}`);
      throw err;
    });
    const mutation = fn(current);
    if (mutation.hosts) await writeHostsFile(path, mutation.hosts);
    return mutation.result;
  });
  mutationChain = run.catch(() => {});
  return run;
}

/** A refused write answers 409 CONFLICT with the fix; any other failure stays OPERATION_FAILED. Like `settingsWriteErrorResponse()`. */
export function customModelHostsWriteErrorResponse(err: unknown): ApiResponse<never> {
  if (err instanceof CustomModelHostsWriteRefusedError) return createErrorResponse(ApiErrorCode.CONFLICT, err.message);
  return createErrorResponse(ApiErrorCode.OPERATION_FAILED, getErrorMessage(err));
}
