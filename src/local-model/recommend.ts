/**
 * @fileoverview The recommendation itself: which model, at which context, with which harness
 * fits this Mac. Pure: no IO, no clock, no CLI registry, no data dir.
 *
 * SKELETON: the exported signatures are final, the bodies are not written yet. This module
 * will hold:
 *  - `deviceBudget()`: L is the wired limit when it is above 0, else 2/3 of memory below 36 GB
 *    and 3/4 from 36 GB. B = min(L - 1 GiB, memory - reserve), with a reserve of 6 GiB up to
 *    18 GB, 8 GiB up to 48 GB and 12 GiB from 64 GB.
 *  - `needBytes()`: F = weights + kvBytesPerToken * ctx + 1 GiB + the prompt cache tier of the
 *    catalogue for this Mac's memory.
 *  - `recommend()`: the candidates (model, context, harness) with `ctx >= harness.minContext`,
 *    the harness installed or installable, accepting the model id and not gated; the fit (F/B up
 *    to 0.85 good, up to 0.98 tight, above out); the speed (ok, slow or unknown: a chip that is
 *    in no chips row is unknown, a bandwidth is never guessed); the ranking (good before tight,
 *    then ok before unknown before slow, then model rank, harness rank, larger context); and the
 *    verdict.
 *
 * Rules:
 *  - Verdict `limited` when the best candidate's model has fewer than 12 billion parameters.
 *  - The word "Recommended" (`LOCAL_MODEL_LABELS.headlineTested`) only for a pick whose model
 *    has a `tested` entry matching this Mac. Otherwise `headlineOk` plus `noteUntested`.
 *  - Reasons for `none`: not-macos, intel, memory, disk (free disk minus the download is below
 *    10 GiB for every fitting model), macos, no-harness.
 *  - Every label in the result comes from `LOCAL_MODEL_LABELS`, every size text from
 *    `formatGb()`. No number is spliced into a sentence here.
 *  - No CLI id is ever compared with a literal: a harness is a catalogue row plus a
 *    `HarnessFact`.
 */

import type {
  DeviceBudget,
  HardwareFacts,
  HarnessFact,
  LocalModelCatalog,
  LocalModelEntry,
  Recommendation,
} from '../types.js';

/** The memory a model may use on this Mac: the device limit L, the budget B and where L came from. */
export function deviceBudget(hw: HardwareFacts): DeviceBudget {
  void hw;
  throw new Error('not implemented: deviceBudget');
}

/** F: the bytes `model` needs in memory at a context of `ctx` tokens on this Mac. */
export function needBytes(model: LocalModelEntry, ctx: number, catalog: LocalModelCatalog, hw: HardwareFacts): number {
  void model;
  void ctx;
  void catalog;
  void hw;
  throw new Error('not implemented: needBytes');
}

/**
 * The recommendation for this Mac. `harnessFacts` holds one fact per catalogue harness the
 * caller could resolve; a catalogue harness without a fact is not offered.
 */
export function recommend(
  hw: HardwareFacts,
  catalog: LocalModelCatalog,
  harnessFacts: readonly HarnessFact[]
): Recommendation {
  void hw;
  void catalog;
  void harnessFacts;
  throw new Error('not implemented: recommend');
}
