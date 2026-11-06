/**
 * @fileoverview The serialized writer of `custom-model-hosts.json`, the store of the saved
 * custom model endpoints (src/custom-model-hosts.ts).
 *
 * CONTRACT STAGE: the function below has its final signature and a body that throws; the body
 * is written next, and every writer of the file is moved onto it then.
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

import type { CustomModelHost } from './custom-model-hosts.js';
import type { ApiResponse } from './types.js';

/** Marks a body the contract stage left unwritten. */
function notImplemented(what: string, ..._args: unknown[]): never {
  throw new Error(`${what} is not implemented yet`);
}

/** A write refused because the existing `custom-model-hosts.json` must not be overwritten. The message is user-facing. */
export class CustomModelHostsWriteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CustomModelHostsWriteRefusedError';
  }
}

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
  return notImplemented('mutateCustomModelHosts', fn, configDir);
}

/** A refused write answers 409 CONFLICT with the fix; any other failure stays OPERATION_FAILED. Like `settingsWriteErrorResponse()`. */
export function customModelHostsWriteErrorResponse(err: unknown): ApiResponse<never> {
  return notImplemented('customModelHostsWriteErrorResponse', err);
}
