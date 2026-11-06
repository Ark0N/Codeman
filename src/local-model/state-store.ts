/**
 * @fileoverview The ONE reader and writer of `local-model.json`, the state file of the local
 * model install (`LocalModelStateFile`).
 *
 * CONTRACT STAGE: `IDLE_LOCAL_MODEL_STATE` is final. Every function below has its final
 * signature and a body that throws; the bodies are written next.
 *
 * Why one module: the install job writes the state, the step and the digest, and the caller
 * of the runtime supervisor writes the pid and the port. Two writers with their own temp file
 * and rename would lose each other's change, which is the fault `mutateCustomModelHosts()`
 * exists to end for the endpoint store. So every write goes through `mutateLocalModelState()`.
 *
 * The shape of `mutateSettingsFile()` (src/web/settings-writer.ts):
 *  - Serialized: mutations run one at a time on one promise chain.
 *  - Atomic: each write goes to a temp file with a random name beside the target and is
 *    renamed over it. The file is mode 0600.
 *  - Reading is TOTAL, unlike the settings writer: the file holds no setting of the user, only
 *    what this feature recorded, so a missing file, one that does not parse or one with
 *    another `schema` reads as `IDLE_LOCAL_MODEL_STATE` and the next write replaces it.
 *  - The path is `localModelPaths().stateFile`. The file itself holds no path.
 */

import type { LocalModelStateFile } from '../types.js';

/** Marks a body the contract stage left unwritten. */
function notImplemented(what: string, ..._args: unknown[]): never {
  throw new Error(`${what} is not implemented yet`);
}

/** The state when nothing was ever installed. What an unreadable file reads as. */
export const IDLE_LOCAL_MODEL_STATE: LocalModelStateFile = Object.freeze({ schema: 1, state: 'idle' });

/**
 * The state a file's text stands for. Pure and total: text that is not a JSON object of
 * `schema: 1` with a known `state` is `IDLE_LOCAL_MODEL_STATE`. Members it does not know are
 * dropped, and a member of the wrong type is dropped rather than trusted.
 */
export function parseLocalModelState(raw: string): LocalModelStateFile {
  return notImplemented('parseLocalModelState', raw);
}

/** The stored state. Never throws: a file that cannot be read is `IDLE_LOCAL_MODEL_STATE`. */
export async function readLocalModelState(): Promise<LocalModelStateFile> {
  return notImplemented('readLocalModelState');
}

/**
 * Runs one change to the state file. `fn` receives the current state and returns the state to
 * write, or `undefined` to write nothing. Resolves with the state before and after the change
 * (`after` is `undefined` when nothing was written). `updatedAt` is stamped here. A failed
 * write rejects its own caller only; the chain keeps going.
 */
export function mutateLocalModelState(
  fn: (current: LocalModelStateFile) => LocalModelStateFile | undefined
): Promise<{ before: LocalModelStateFile; after: LocalModelStateFile | undefined }> {
  return notImplemented('mutateLocalModelState', fn);
}
