/**
 * @fileoverview What the server knows about each catalogue harness on this machine, for the
 * local model recommendation. Server side: this is the one module of src/local-model/ that
 * reads the CLI registry, so `recommend()` can stay pure and name no CLI.
 *
 * SKELETON: the exported signature is final, the body is not written yet. `buildHarnessFacts()`
 * will, for every `LocalHarnessEntry` of the catalogue:
 *  - resolve its `cli` in the CLI registry AT CALL TIME (never in a module-level constant), and
 *    leave out a row whose CLI is unknown, disabled, or has no custom model mechanism
 *    (`capabilities.customModelInjection.kind` is `unsupported`);
 *  - report `label` from the registry entry and `installed` from the same probe the other
 *    routes use;
 *  - report `installable` only for a CLI that is not installed and whose install command for
 *    this platform needs no administrator rights (not one that starts with `brew` or `sudo`);
 *  - supply `acceptsModelId`, the same test a custom model launch applies to the model id
 *    before anything is written (the launch spec's model pattern).
 *
 * Rules:
 *  - No CLI id is compared with a literal here or anywhere: the id comes from the catalogue row
 *    and everything else from the registry entry it resolves to.
 *  - Read-only: nothing is installed, written or spawned beyond the existing availability probe.
 */

import type { HarnessFact, LocalModelCatalog } from '../types.js';

/** One fact per catalogue harness that resolves in the CLI registry, in catalogue order. */
export async function buildHarnessFacts(catalog: LocalModelCatalog): Promise<HarnessFact[]> {
  void catalog;
  throw new Error('not implemented: buildHarnessFacts');
}
