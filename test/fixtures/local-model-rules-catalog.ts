/**
 * @fileoverview A frozen model catalogue for the RULE tests of src/local-model/recommend.ts:
 * the stock catalogue exactly as it shipped on 2026-11-06 (seven rows that all carry the
 * figures measured on one model), with the `runner` field the schema gained since.
 *
 * Why a frozen copy and not the stock catalogue: the stock catalogue is meant to change every
 * week or so (new models, new measurements). The tests of a RULE (the ranking, the disk
 * filter, the tags, the `limited` line, the harness fallback) need realistic rows whose
 * answers do not move with it, or every catalogue update would rewrite a hundred rule tests
 * and hide the few answers that really changed. What the STOCK catalogue answers for each Mac
 * is pinned separately, in test/local-model-recommend.test.ts ("every memory size") and the
 * two real-Mac blocks, and that is the table a catalogue change must update on purpose.
 *
 * Its figures are NOT a statement about any model: the rows borrow the measured row's figures,
 * which is exactly why the stock catalogue replaced them. Validated by the real schema.
 */

import type { LocalModelCatalog } from '../../src/types.js';

const MEASURED_MEMORY = {
  /** 36,000 to 38,000 bytes stayed held per token of context after a prompt of 89,000 and one of 167,000 tokens. */
  heldBytesPerToken: 37_000,
  /** The runner held 2.5 to 3 GB beside the weights. */
  overheadBytes: 3_000_000_000,
  /** While a long prompt was processed the peak stood about 5 GB above what stayed held. */
  peakExtraBytes: 5_000_000_000,
} as const;

/**
 * The catalogue as it shipped on 2026-11-06, with the `runner` field added. Frozen: a fixture,
 * not the stock catalogue.
 */
export const RULES_LOCAL_MODEL_CATALOG: LocalModelCatalog = {
  schema: 1,
  updated: '2026-11-06',
  // The oldest macOS the model runtime supports.
  minMacosMajor: 14,
  // Ordered by rank. The higher rank wins among models that fit equally well and are equally
  // fast. `flint:40b` is left out on purpose: its plain tag is the slow build on a Mac and it
  // has an open bug with tool arguments.
  models: [
    {
      id: 'qwen3.5:9b',
      label: 'Qwen3.5 9B',
      license: 'Apache-2.0',
      paramsB: 9,
      runner: 'mlx',
      bytes: 6_550_825_373,
      ...MEASURED_MEMORY,
      figures: 'estimated',
      contexts: [65536, 32768],
      rank: 1,
      // 37.1 tokens per second measured on 400 GB/s.
      speedPer100Gbps: 9.3,
      tested: [],
    },
    {
      id: 'qwen3.5:9b-q8_0',
      label: 'Qwen3.5 9B (Q8)',
      license: 'Apache-2.0',
      paramsB: 9,
      runner: 'llamacpp',
      bytes: 10_449_217_949,
      ...MEASURED_MEMORY,
      figures: 'estimated',
      contexts: [65536, 32768],
      rank: 2,
      // Not measured: the 9.3 of the row above scaled by file size.
      speedPer100Gbps: 5.8,
      tested: [],
    },
    {
      id: 'gpt-oss:20b',
      label: 'GPT-OSS 20B',
      license: 'Apache-2.0',
      paramsB: 20,
      runner: 'llamacpp',
      bytes: 13_793_441_427,
      ...MEASURED_MEMORY,
      figures: 'estimated',
      contexts: [131072, 65536],
      rank: 3,
      // No speed figure: its speed is unknown on every chip.
      tested: [],
    },
    {
      id: 'qwen3.6:35b-a3b',
      label: 'Qwen3.6 35B-A3B',
      license: 'Apache-2.0',
      paramsB: 35,
      runner: 'mlx',
      // What a Mac really downloads: an MLX build, 2% above the 22,621,314,161 of the manifest.
      bytes: 23_105_798_956,
      ...MEASURED_MEMORY,
      figures: 'measured',
      contexts: [131072, 65536],
      rank: 4,
      // 54.5 tokens per second measured on 400 GB/s (3 billion parameters are active per token).
      // The MLX build ran faster than this figure predicts on the one Mac we tested (67.7
      // against 41.8), so on other chips the estimate is on the low side.
      speedPer100Gbps: 13.6,
      // Run by us with OpenCode on the MacBook Pro (Mac17,13): a four-step task with tool calls.
      tested: [{ chip: 'Apple M5 Pro', memGb: 48, cli: 'opencode', date: '2026-11-06', tokensPerSecond: 67.7 }],
    },
    {
      id: 'qwen3.8:27b',
      label: 'Qwen3.8 27B',
      license: 'Apache-2.0',
      paramsB: 27.8,
      runner: 'mlx',
      bytes: 17_741_871_939,
      ...MEASURED_MEMORY,
      figures: 'estimated',
      contexts: [131072, 65536, 32768],
      rank: 5,
      // 11.8 tokens per second measured on 400 GB/s.
      speedPer100Gbps: 2.95,
      tested: [],
    },
    {
      id: 'qwen3.8:27b-q8_0',
      label: 'Qwen3.8 27B (Q8)',
      license: 'Apache-2.0',
      paramsB: 27.8,
      runner: 'llamacpp',
      bytes: 29_978_241_837,
      ...MEASURED_MEMORY,
      figures: 'estimated',
      contexts: [262144, 131072],
      rank: 6,
      // Not measured: the 2.95 of the row above scaled by file size.
      speedPer100Gbps: 1.7,
      tested: [],
    },
    {
      id: 'qwen3.5:122b-a10b',
      label: 'Qwen3.5 122B-A10B',
      license: 'Apache-2.0',
      paramsB: 122,
      runner: 'llamacpp',
      bytes: 81_370_035_877,
      ...MEASURED_MEMORY,
      figures: 'estimated',
      contexts: [131072],
      rank: 7,
      // No speed figure: its speed is unknown on every chip.
      tested: [],
    },
  ],
  // The higher rank wins when a model can run with more than one harness.
  harnesses: [
    { cli: 'opencode', minContext: 65536, rank: 3 },
    // Sends a fixed prompt of about 36,000 tokens, so the first answer takes minutes.
    { cli: 'claude', minContext: 65536, rank: 2, slowFirstTurn: true },
    // Gated: neither its 32768 minimum nor its handling of a `name:tag` model id is verified.
    { cli: 'pi', minContext: 32768, rank: 1, gated: true },
  ],
  // Memory bandwidth in GB/s, most specific first. Only chips that shipped and are in the source
  // table are listed. Where one name covers two bandwidths (M3 Max 300 or 400, M4 Max 410 or 546,
  // M5 Max 460 or 614) the LOWER one stands, so a speed computed from it is a floor.
  chips: [
    { match: 'M5 Ultra', gbps: 1228 },
    { match: 'M3 Ultra', gbps: 800 },
    { match: 'M2 Ultra', gbps: 800 },
    { match: 'M1 Ultra', gbps: 800 },
    { match: 'M5 Max', gbps: 460 },
    { match: 'M4 Max', gbps: 410 },
    { match: 'M3 Max', gbps: 300 },
    { match: 'M2 Max', gbps: 400 },
    { match: 'M1 Max', gbps: 400 },
    { match: 'M5 Pro', gbps: 307 },
    { match: 'M4 Pro', gbps: 273 },
    { match: 'M3 Pro', gbps: 150 },
    { match: 'M2 Pro', gbps: 200 },
    { match: 'M1 Pro', gbps: 200 },
    { match: 'M5', gbps: 154 },
    { match: 'M4', gbps: 120 },
    { match: 'M3', gbps: 100 },
    { match: 'M2', gbps: 100 },
    { match: 'M1', gbps: 68 },
  ],
};
