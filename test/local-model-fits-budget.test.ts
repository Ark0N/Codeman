/**
 * @fileoverview Tests for `modelFitsBudget()` of src/local-model/recommend.ts: the judgement
 * the install job makes before it downloads a model.
 *
 * Pinned: it agrees with what `recommend()` offers (a model that is the pick or listed fits,
 * a model that is in neither and is not left out for its rank does not), it does not depend
 * on the ranking, a model the catalogue does not have never fits, and it judges against the
 * budget the runtime measured when the caller passes one (the whole point of asking again
 * after the runtime started).
 *
 * Port: N/A (pure functions).
 */

import { describe, expect, it } from 'vitest';
import { getLocalModelCatalog, LocalModelCatalogSchema } from '../src/config/local-model-catalog.js';
import { formatGb, memClassGb } from '../src/local-model/format.js';
import { MAX_ALTERNATIVES, modelFitsBudget, recommend } from '../src/local-model/recommend.js';
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
    for (const gb of [8, 16, 18, 24, 32, 36, 48, 64, 96, 128, 192, 256, 512]) {
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

  it('does not depend on what the recommendation lists: a model left out for disk space still fits', () => {
    // The recommendation lists every model that fits the memory, unless its download would
    // leave under 10 GiB on the disk. With 40 GB free on a 128 GB Mac that leaves out the two
    // largest downloads, which fit the memory all the same.
    const hw = { ...mac(128, 'Apple M5 Max'), freeDiskBytes: 40_000_000_000 };
    const offered = recommend(hw, catalog, harnessFacts());
    const listed = new Set([offered.pick, ...offered.alternatives].map((row) => row?.modelId));
    const unlisted = catalog.models.filter((model) => !listed.has(model.id));
    expect(unlisted.map((model) => model.id)).toEqual(['qwen3.8:27b-q8_0', 'ornith-1.5:122b']);
    for (const model of unlisted) {
      expect(modelFitsBudget(hw, catalog, model.id, model.contexts.at(-1) as number), model.id).toBe(true);
    }
  });

  it('does not depend on the ranking: a model cut off by the length of the list still fits', () => {
    // A catalogue longer than the list: the stock rows plus six more copies of its smallest.
    const smallest = catalog.models[0];
    const long = LocalModelCatalogSchema.parse({
      ...structuredClone(catalog),
      models: [
        ...structuredClone(catalog.models),
        ...Array.from({ length: 6 }, (_, index) => ({
          ...structuredClone(smallest),
          id: `extra-${index + 1}:9b`,
          rank: -1 - index,
        })),
      ],
    });
    expect(long.models.length).toBeGreaterThan(1 + MAX_ALTERNATIVES);
    const hw = mac(512, 'Apple M5 Max');
    const offered = recommend(hw, long, harnessFacts());
    const listed = new Set([offered.pick, ...offered.alternatives].map((row) => row?.modelId));
    expect(listed.size).toBe(1 + MAX_ALTERNATIVES);
    const unlisted = long.models.filter((model) => !listed.has(model.id));
    expect(unlisted.length).toBe(long.models.length - 1 - MAX_ALTERNATIVES);
    for (const model of unlisted) {
      expect(modelFitsBudget(hw, long, model.id, model.contexts.at(-1) as number), model.id).toBe(true);
    }
  });

  it('rules out a model that is too large, and one the catalogue does not have', () => {
    expect(modelFitsBudget(mac(48), catalog, 'ornith-1.5:122b', 131072)).toBe(false);
    expect(modelFitsBudget(mac(48), catalog, 'no-such:1b', 65536)).toBe(false);
    expect(modelFitsBudget(mac(48), catalog, 'qwen3.6:35b-a3b', 131072)).toBe(true);
  });

  it('judges against the budget the runtime measured, when it is given one', () => {
    const id = 'qwen3.6:35b-a3b';
    // The MacBook: the runtime reported 37.4 GiB, and the model needs 36.0 of those 40.2 GB.
    expect(modelFitsBudget(mac(48), catalog, id, 131072, { measuredTotalBytes: 40_157_944_217 })).toBe(true);
    // A runtime that reports less than the estimate rules out what the estimate allowed.
    expect(modelFitsBudget(mac(48), catalog, id, 131072, { measuredTotalBytes: 33 * 1024 ** 3 })).toBe(false);
    // And one that reports more admits what the estimate ruled out: on a 36 GB Mac the GGUF
    // 35B-A3B at its full window needs 28.8 GB, 1.032 of the 27.9 GB estimate and 0.958 of 28 GiB.
    const moeGguf = 'qwen3.6:35b-a3b-mtp-q4_k_m';
    expect(modelFitsBudget(mac(36), catalog, moeGguf, 262144)).toBe(false);
    expect(modelFitsBudget(mac(36), catalog, moeGguf, 262144, { measuredTotalBytes: 28 * 1024 ** 3 })).toBe(true);
    // The reserve still bounds it: 100 GiB "measured" on a 48 GB Mac is 40 GiB (42.9 GB) of
    // budget, so the 122B with its 97.4 GB stays out although 100 GiB would hold it.
    const huge = { measuredTotalBytes: 100 * 1024 ** 3 };
    expect(modelFitsBudget(mac(48), catalog, 'ornith-1.5:122b', 131072, huge)).toBe(false);
    expect(modelFitsBudget(mac(128), catalog, 'ornith-1.5:122b', 131072, huge)).toBe(true);
  });

  it('agrees with the recommendation under a measured budget too', () => {
    for (const [gb, measuredGib] of [
      [16, 11.8],
      [32, 20],
      [48, 37.4],
      [48, 30],
      [64, 50],
    ]) {
      const hw = mac(gb);
      const options = { measuredTotalBytes: Math.floor(measuredGib * 1024 ** 3) };
      const offered = recommend(hw, catalog, harnessFacts(), options);
      expect(offered.verdict === 'none' || offered.budgetSource === 'measured').toBe(true);
      for (const row of [offered.pick, ...offered.alternatives].filter((entry) => entry !== undefined)) {
        expect(modelFitsBudget(hw, catalog, row.modelId, row.context, options), `${gb} GB ${row.modelId}`).toBe(true);
        // The next larger context of the same model does not fit, or the row would be at it.
        const model = catalog.models.find((entry) => entry.id === row.modelId);
        const larger = model?.contexts.filter((ctx) => ctx > row.context) ?? [];
        for (const ctx of larger) expect(modelFitsBudget(hw, catalog, row.modelId, ctx, options)).toBe(false);
      }
    }
  });

  it('is false for a context that is no token count', () => {
    for (const context of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(modelFitsBudget(mac(128), catalog, 'qwen3.5:9b-q4_k_m', context), String(context)).toBe(false);
    }
  });
});
