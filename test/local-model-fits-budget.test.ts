/**
 * @fileoverview Tests for `modelFitsBudget()` of src/local-model/recommend.ts: the judgement
 * the install job makes before it downloads a model.
 *
 * Pinned: it agrees with what `recommend()` offers (a model that is the pick or listed fits,
 * a model that is in neither and is not left out for its rank does not), it does not depend
 * on the ranking, and a model the catalogue does not have never fits.
 *
 * Port: N/A (pure functions).
 */

import { describe, expect, it } from 'vitest';
import { getLocalModelCatalog } from '../src/config/local-model-catalog.js';
import { formatGb, memClassGb } from '../src/local-model/format.js';
import { modelFitsBudget, recommend } from '../src/local-model/recommend.js';
import type { HardwareFacts, HarnessFact } from '../src/types.js';

/** A Mac with Apple silicon and `gb` GB of memory as sold. */
function mac(gb: number, chip = 'Apple M5 Pro'): HardwareFacts {
  const memBytes = gb * 1024 ** 3;
  return {
    platform: 'darwin',
    arch: 'arm64',
    arm64: true,
    translated: false,
    memBytes,
    memGb: formatGb(memBytes),
    memClassGb: memClassGb(memBytes),
    chip,
    macosMajor: 27,
    macosVersion: '27.2',
    wiredLimitMb: 0,
    source: 'sysctl',
  };
}

/** Every harness of the catalogue, installed and accepting every model id. */
function harnessFacts(): HarnessFact[] {
  return getLocalModelCatalog().harnesses.map((row) => ({
    cli: row.cli,
    label: row.cli,
    installed: true,
    installable: false,
    acceptsModelId: () => true,
  }));
}

describe('modelFitsBudget', () => {
  const catalog = getLocalModelCatalog();

  it('agrees with the recommendation on every model and context of the catalogue', () => {
    for (const gb of [8, 16, 24, 32, 48, 64, 128]) {
      const hw = mac(gb);
      const offered = recommend(hw, catalog, harnessFacts());
      const rows = [offered.pick, ...offered.alternatives].filter((row) => row !== undefined);
      // Whatever the recommendation offers fits at the context it offers it at.
      for (const row of rows) {
        expect(modelFitsBudget(hw, catalog, row.modelId, row.context), `${gb} GB ${row.modelId}`).toBe(true);
      }
      // A Mac that gets no recommendation for lack of memory has no model that fits at a
      // context a harness works at.
      if (offered.verdict === 'none') {
        const smallestHarnessContext = Math.min(...catalog.harnesses.filter((h) => !h.gated).map((h) => h.minContext));
        for (const model of catalog.models) {
          for (const context of model.contexts.filter((ctx) => ctx >= smallestHarnessContext)) {
            expect(modelFitsBudget(hw, catalog, model.id, context), `${gb} GB ${model.id}`).toBe(false);
          }
        }
      }
    }
  });

  it('does not depend on the ranking: a model that fits and is listed nowhere still fits', () => {
    // On a 128 GB Mac more models fit than the recommendation lists.
    const hw = mac(128, 'Apple M5 Max');
    const offered = recommend(hw, catalog, harnessFacts());
    const listed = new Set([offered.pick, ...offered.alternatives].map((row) => row?.modelId));
    const unlisted = catalog.models.filter((model) => !listed.has(model.id));
    expect(unlisted.length).toBeGreaterThan(0);
    for (const model of unlisted) {
      expect(modelFitsBudget(hw, catalog, model.id, model.contexts.at(-1) as number), model.id).toBe(true);
    }
  });

  it('rules out a model that is too large, and one the catalogue does not have', () => {
    expect(modelFitsBudget(mac(48), catalog, 'qwen3.5:122b-a10b', 131072)).toBe(false);
    expect(modelFitsBudget(mac(48), catalog, 'no-such:1b', 65536)).toBe(false);
    expect(modelFitsBudget(mac(48), catalog, 'qwen3.6:35b-a3b', 131072)).toBe(true);
  });
});
