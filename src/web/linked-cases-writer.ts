/**
 * @fileoverview The writer of the linked-cases registry (`linked-cases.json` in the data dir): case
 * name to the absolute folder it stands for.
 *
 * Every read-modify-write of that file goes through `mutateLinkedCases()`, the same shape as
 * `mutateSettingsFile()` (settings-writer.ts). The one direct writer is config-backup restore
 * (`restoreConfigBackup()`), which must work on a file that does not parse. Readers keep reading the
 * file directly; a write is atomic, so they never see half of one.
 *
 * - **Serialized.** Mutations run one at a time on a single promise chain, each one reading, changing
 *   and writing before the next starts. Link, unlink, rename, a create in a custom folder and a clone
 *   into one each used to read the file, check it and write it back on their own. Two clones that
 *   claimed one name and finished together both passed the check, both answered success, and the
 *   later write replaced the earlier one's entry. Any two writers could lose an entry the same way.
 *   A check that must hold when the entry is written belongs inside `fn`: throwing there rejects that
 *   caller only, and nothing is written.
 * - **Atomic.** Each write goes to its own temp file beside the target and is renamed over it, so a
 *   reader never sees a half-written file (quick-start would read one as an empty registry and resolve
 *   a linked case to the cases dir instead), and a failed write leaves the previous file in place.
 * - **Refuses a file it must not trust.** Only a missing (or empty) file starts from `{}`. A file that
 *   cannot be read or is not a JSON object is left alone and the write throws
 *   `LinkedCasesWriteRefusedError`: read as `{}`, the next link would write back its own entry alone
 *   and unlink every other case.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { dataPath } from '../config/instance.js';
import { getErrorMessage } from '../types.js';

export type LinkedCases = Record<string, string>;

/** Resolved at call time, like every other `dataPath()` caller that tests point at a temp HOME. */
export function linkedCasesPath(): string {
  return dataPath('linked-cases.json');
}

/** A write refused because the existing registry must not be overwritten. The message is user-facing. */
export class LinkedCasesWriteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LinkedCasesWriteRefusedError';
  }
}

async function readLinkedCasesForWrite(path: string): Promise<LinkedCases> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw new LinkedCasesWriteRefusedError(
      `Cannot read ${path} (${(err as Error).message}), so the linked cases were not changed.`
    );
  }
  if (raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LinkedCasesWriteRefusedError(
      `${path} is not a valid JSON object, so the linked cases were not changed (saving would have unlinked every other case). Fix or delete the file, or restore it from a config backup, then try again.`
    );
  }
  return parsed as LinkedCases;
}

async function writeLinkedCasesFile(path: string, linked: LinkedCases): Promise<void> {
  // Through a symlink, as the plain writeFile this replaces did: the rename lands on the real file.
  const target = await fs.realpath(path).catch(() => path);
  await fs.mkdir(dirname(target), { recursive: true });
  // A plain writeFile kept the file's permissions; a rename would not, so the temp file takes them.
  const mode = await fs.stat(target).then(
    (s) => s.mode & 0o777,
    () => undefined
  );
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(linked, null, 2), mode === undefined ? undefined : { mode });
    // The creation mode is masked by the umask; the existing file's bits are put back as they were.
    if (mode !== undefined) await fs.chmod(tmp, mode);
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

let mutationChain: Promise<unknown> = Promise.resolve();

/**
 * Run one change to the linked-cases registry. `fn` receives a copy of the current registry and
 * returns the registry to write, or `undefined` to write nothing; it may throw to refuse the change
 * (its error rejects this call as thrown). Resolves with the registry before and after the change
 * (`after` is `undefined` when nothing was written). A refused or failed mutation rejects its own
 * caller only; the chain keeps going.
 */
export function mutateLinkedCases(
  fn: (current: LinkedCases) => LinkedCases | undefined
): Promise<{ before: LinkedCases; after: LinkedCases | undefined }> {
  const run = mutationChain.then(async () => {
    const path = linkedCasesPath();
    const before = await readLinkedCasesForWrite(path).catch((err: unknown) => {
      console.warn(`[linked-cases] write refused: ${getErrorMessage(err)}`);
      throw err;
    });
    const after = fn({ ...before });
    if (after) await writeLinkedCasesFile(path, after);
    return { before, after };
  });
  mutationChain = run.catch(() => {});
  return run;
}
