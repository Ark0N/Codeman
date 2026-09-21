/**
 * @fileoverview Write side of the CLI registry (docs/cli-enable-disable-plan.md, Phases 3/5).
 *
 * Kept deliberately SEPARATE from `registry.ts`, which documents itself as read-only and
 * whose whole point is that importing it (which `schemas.ts` does, transitively) performs no
 * filesystem writes. Only `cli-registry-routes.ts` imports this module, so that property
 * still holds for every OTHER importer of the registry.
 *
 * Same tmp+rename+0600 shape as `custom-model-hosts.ts`: `~/.codeman/clis.json` can be
 * hand-edited, so a write must never leave it half-written, and 0600 is the mode
 * `registry.ts`'s own `isUnsafePermissions()` check requires on the next read.
 */

import { existsSync, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { registryFilePath } from './registry.js';
import type { CliRegistryFile } from './types.js';

/**
 * Best-effort read of the raw override file for mutation. Tolerant of "missing" and
 * "unparseable" alike — both start a fresh `{schemaVersion: 1, clis: {}}` rather than
 * failing the write, since the quarantine-on-corrupt-JSON behaviour belongs to the READ
 * path (`registry.ts`'s `readRegistryFile`) and a write here should not fight it over the
 * same file. A permissions problem is left to the read path to warn about on next load;
 * this writer always emits 0600 regardless of what it found.
 */
export async function readRegistryFileForWrite(): Promise<CliRegistryFile> {
  try {
    const raw = await fs.readFile(registryFilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { clis?: unknown }).clis === 'object' &&
      (parsed as { clis?: unknown }).clis !== null
    ) {
      return parsed as CliRegistryFile;
    }
  } catch {
    /* missing or invalid — start fresh, matching registry.ts's own tolerant defaults */
  }
  return { schemaVersion: 1, clis: {} };
}

export async function writeRegistryFile(file: CliRegistryFile): Promise<void> {
  const target = registryFilePath();
  const dir = dirname(target);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), { mode: 0o600 });
  await fs.rename(tmp, target);
}
