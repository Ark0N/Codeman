/**
 * @fileoverview The one IO wrapper around `custom-model-injection.ts`'s pure
 * `ConfigDirInjection` output — deliberately split out so that file, the
 * discovery routes, and `scripts/test-local-llm-harnesses.ts` (via tsx) can
 * all share EXACTLY one "write these files, merge this env" implementation.
 * Before this existed, the route and the standalone script each carried
 * their own copy of this logic, which is exactly the kind of drift the CLI
 * registry's "declare once, consume everywhere" design exists to prevent —
 * see deployment_plan.md and the "dynamic to support cli-registry changes"
 * requirement it was written against.
 */

import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { ConfigDirInjection } from './custom-model-injection.js';

/**
 * Writes a `ConfigDirInjection`'s files under `baseDir` and returns the full
 * envOverrides object a caller should merge into the session/process env
 * (the dir-redirect var plus any `extraEnv` the config file references by
 * name). Never touches anything outside `baseDir` — the caller is
 * responsible for choosing an isolated directory (never the user's real
 * `~/.codex`, `~/.pi`, etc.).
 */
export function applyConfigDirInjection(baseDir: string, injection: ConfigDirInjection): Record<string, string> {
  for (const file of injection.files) {
    const filePath = join(baseDir, file.relPath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, file.content, 'utf8');
  }
  return { [injection.dirEnvVar]: baseDir, ...injection.extraEnv };
}

/** Best-effort recursive removal of a previously-written configDir. Never throws. */
export function removeConfigDir(dir: string | undefined): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup only
  }
}
