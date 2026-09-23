/**
 * @fileoverview Write side of the CLI registry (docs/cli-enable-disable-plan.md, Phases 3/5).
 *
 * Kept deliberately SEPARATE from `registry.ts`, whose reading path does no writes on import
 * (`schemas.ts` imports it, transitively). Only `cli-registry-routes.ts` imports this module,
 * so that property still holds for every OTHER importer of the registry.
 *
 * Every mutation goes through `mutateRegistryFile()`, which does three things the #476 review
 * found missing:
 *
 * - **Serialized.** Mutations run one at a time on a single promise chain, and each one
 *   reads, changes, writes and reloads before the next starts. Unserialized read-modify-write
 *   lost toggles when three `PUT /api/clis/:id` calls ran in parallel.
 * - **Refuses a file it must not trust.** The reader ignores a `clis.json` with any
 *   group/world permission bit and quarantines one that does not parse. The writer used to
 *   treat both as "start fresh", so one Settings click replaced a hand-edited file with a
 *   one-key file, or rewrote a refused file as 0600 and so trusted it. It now starts fresh
 *   ONLY on ENOENT and otherwise throws `RegistryWriteRefusedError`, leaving the file alone.
 * - **Unique temp file.** Every write gets its own tmp name before the rename, so two writes
 *   can never rename each other's temp file away (the ENOENT-on-rename 500s).
 *
 * Same tmp+rename+0600 shape as `custom-model-hosts.ts`. The file is hand-editable, so a
 * write must never leave it half-written, and 0600 is the mode `isUnsafePermissions()`
 * requires on the next read.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { isUnsafePermissions, registryFilePath, reloadCliRegistry } from './registry.js';
import type { CliRegistryFile } from './types.js';

/** A write refused because the existing `clis.json` must not be overwritten. The message is user-facing. */
export class RegistryWriteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistryWriteRefusedError';
  }
}

/**
 * Read the raw override file for mutation. Only a MISSING file starts fresh. A file with
 * unsafe permissions, one that cannot be read, or one that does not parse is refused rather
 * than overwritten, because the user's hand-edit is worth more than one toggle.
 */
export async function readRegistryFileForWrite(): Promise<CliRegistryFile> {
  const path = registryFilePath();
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, clis: {} };
    throw new RegistryWriteRefusedError(`Cannot read ${path} (${(err as Error).message}); not changing it.`);
  }
  if (isUnsafePermissions(path)) {
    throw new RegistryWriteRefusedError(
      `${path} has group/world permission bits, so Codeman ignores it. Run \`chmod 600 ${path}\` and check its contents before changing CLIs here.`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RegistryWriteRefusedError(
      `${path} is not valid JSON (${(err as Error).message}). Fix or remove it before changing CLIs here.`
    );
  }
  const clis = (parsed as { clis?: unknown } | null)?.clis;
  if (typeof parsed !== 'object' || parsed === null || typeof clis !== 'object' || clis === null) {
    throw new RegistryWriteRefusedError(`${path} has no "clis" object. Fix or remove it before changing CLIs here.`);
  }
  return parsed as CliRegistryFile;
}

export async function writeRegistryFile(file: CliRegistryFile): Promise<void> {
  const target = registryFilePath();
  const dir = dirname(target);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

let mutationChain: Promise<unknown> = Promise.resolve();

/**
 * Run one registry mutation. The chain holds exactly one at a time: `fn` receives the
 * current file and returns `{ file, result }`. If `file` is set it is written and the
 * registry reloaded before the next mutation starts; if not, nothing is written, which is
 * how a validation failure returns early. Checks made inside `fn` (does this id exist,
 * is it a duplicate) therefore see every earlier mutation's result.
 *
 * A failed mutation rejects its own caller only. The chain keeps going.
 */
export function mutateRegistryFile<T>(
  fn: (file: CliRegistryFile) => Promise<{ file?: CliRegistryFile; result: T }> | { file?: CliRegistryFile; result: T }
): Promise<T> {
  const run = mutationChain.then(async () => {
    const current = await readRegistryFileForWrite();
    const { file, result } = await fn(current);
    if (file) {
      await writeRegistryFile(file);
      reloadCliRegistry();
    }
    return result;
  });
  mutationChain = run.catch(() => {});
  return run;
}
