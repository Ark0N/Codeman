/**
 * @fileoverview Tests for src/config/local-model-catalog.ts: the compiled catalogue of models,
 * harnesses and chips, its schema, and the chip lookup.
 *
 * Four things are pinned:
 *
 * 1. The stock constant PARSES. `getLocalModelCatalog()` validates it on first use and throws on
 *    a bad row, so this test is what keeps a bad row from ever reaching the route.
 * 2. The schema refuses what must never get in: a model id that could name another registry
 *    (a slash, a host), an unknown key (a `runtime` block with a download URL), and rows that
 *    break a rule across rows (a repeated id, contexts in the wrong order, a chip row that
 *    hides a more specific one).
 * 3. The chip lookup never guesses: a chip that no row names has no bandwidth, including one
 *    whose name merely contains a known name ('Apple M10', 'Apple M6 Pro').
 * 4. Which figures were MEASURED on a Mac and which were computed: one row says `measured`
 *    (it alone has a tested entry), every other row says `estimated`, and every estimated
 *    row's three memory figures are recomputed here from its OWN model's architecture (a
 *    table read from each model's config.json) for its runner and the runtime's settings. Two
 *    rows may share figures only when they share the architecture and the runner, so a row
 *    can never again carry another model's measurement without saying so.
 *
 * Port: N/A (pure data and functions).
 */

import { describe, expect, it } from 'vitest';
import {
  chipBandwidthGbps,
  chipNameMatches,
  getLocalModelCatalog,
  LOCAL_MODEL_ID_PATTERN,
  LocalModelCatalogSchema,
  STOCK_LOCAL_MODEL_CATALOG,
} from '../src/config/local-model-catalog.js';
import { MAX_ALTERNATIVES } from '../src/local-model/recommend.js';
import {
  RUNTIME_CTX_CHECKPOINTS,
  RUNTIME_HOST_PROMPT_CACHE_MIB,
  RUNTIME_KV_CACHE_TYPE,
  runtimeEnv,
} from '../src/local-model/runtime.js';
import type { LocalModelCatalog, LocalModelEntry } from '../src/types.js';

/** A deep copy of the stock catalogue that a test may break. */
function copy(): LocalModelCatalog {
  return structuredClone(STOCK_LOCAL_MODEL_CATALOG);
}

/** The message of every issue the schema raises for `catalog`, or an empty list when it parses. */
function issuesOf(catalog: unknown): string[] {
  const result = LocalModelCatalogSchema.safeParse(catalog);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
}

/** The stock catalogue with its first model changed. */
/** `url` and `kvBytesPerToken` are no fields of a model row: tests pass them to prove the schema refuses an unknown key. */
function withFirstModel(change: Partial<Record<keyof LocalModelEntry | 'url' | 'kvBytesPerToken', unknown>>): unknown {
  const catalog = copy();
  return { ...catalog, models: [{ ...catalog.models[0], ...change }, ...catalog.models.slice(1)] };
}

/** One MiB and one GiB, in bytes. */
const MIB = 1024 * 1024;
const GIB = 1024 * MIB;

/**
 * The architecture of every model the stock catalogue lists, read from its config.json on
 * Hugging Face (2026-11-08; Muse Glimmer on 2026-11-10): full-attention layers, their K/V heads
 * and head size, and the layers whose cache does not grow with the context (Gated DeltaNet
 * layers with their value and key heads, or sliding-window layers with their window).
 * Fine-tunes share their base's: the config.json of Ornith 1.0 9B (2026-11-10) is that of
 * Qwen3.5-9B in every field below, and the GGUF header of its build says the same.
 */
const ARCHITECTURES = {
  'Qwen3.5-9B': { attentionLayers: 8, kvHeads: 4, headDim: 256, linear: { layers: 24, vHeads: 32, kHeads: 16 } },
  'Qwen3.8-27B': { attentionLayers: 16, kvHeads: 4, headDim: 256, linear: { layers: 48, vHeads: 48, kHeads: 16 } },
  'Qwen3.6-35B-A3B': { attentionLayers: 10, kvHeads: 2, headDim: 256, linear: { layers: 30, vHeads: 32, kHeads: 16 } },
  'Qwen3.5-122B-A10B': {
    attentionLayers: 12,
    kvHeads: 2,
    headDim: 256,
    linear: { layers: 36, vHeads: 64, kHeads: 16 },
  },
  'North-Mini-Code-1.0': { attentionLayers: 13, kvHeads: 4, headDim: 128, sliding: { layers: 36, window: 4096 } },
  // 52 layers, three in four on a sliding window (the GGUF header's `sliding_window_pattern`).
  'Muse-Glimmer-30B': { attentionLayers: 13, kvHeads: 2, headDim: 128, sliding: { layers: 39, window: 2048 } },
} as const;

type ArchitectureName = keyof typeof ARCHITECTURES;
type Architecture = (typeof ARCHITECTURES)[ArchitectureName];

/**
 * Which architecture each stock row runs, and how many tokens the runtime drafts per step with
 * its multi-token-prediction layer: 0 when the GGUF has none (`nextn_predict_layers` in the GGUF
 * header, read on 2026-11-08 from the first bytes of each model layer; on 2026-11-10 for the
 * Ornith 1.0 and Muse Glimmer rows), else the tag's own
 * `draft_num_predict` (its params layer) or the runtime's default of 4 when the tag sets none.
 * Prediction costs a cache for that layer and one rollback copy of the recurrent state per
 * drafted token (see the catalogue header). A row the catalogue gains must be added here, or the
 * test below fails: its figures cannot be checked without it.
 */
const ROW_ARCHITECTURE: Record<string, { architecture: ArchitectureName; draftTokens: number }> = {
  'qwen3.5:9b-q4_k_m': { architecture: 'Qwen3.5-9B', draftTokens: 0 },
  // A fine-tune of Qwen3.5-9B; its GGUF has 32 blocks and no prediction layer.
  'ornith:9b-q4_k_m': { architecture: 'Qwen3.5-9B', draftTokens: 0 },
  'mimo-v2.6:9b-q4_k_m': { architecture: 'Qwen3.5-9B', draftTokens: 0 },
  'north-mini-code-1.0:q4_k_m': { architecture: 'North-Mini-Code-1.0', draftTokens: 0 },
  // No prediction layer; the tags with a separate draft model (`-dflash`) are not listed.
  'muse-glimmer:30b-q4_k_m': { architecture: 'Muse-Glimmer-30B', draftTokens: 0 },
  // Its params layer sets `draft_num_predict` 2.
  'qwen3.6:35b-a3b-mtp-q4_k_m': { architecture: 'Qwen3.6-35B-A3B', draftTokens: 2 },
  'qwen3.6:35b-a3b': { architecture: 'Qwen3.6-35B-A3B', draftTokens: 0 },
  // A prediction layer, and no `draft_num_predict`: the runtime's 4.
  'qwen3.8:27b-q8_0': { architecture: 'Qwen3.8-27B', draftTokens: 4 },
  // Its params layer sets `draft_num_predict` 4.
  'qwen3.8:27b-mtp-q4_k_m': { architecture: 'Qwen3.8-27B', draftTokens: 4 },
  'ornith-1.5:122b': { architecture: 'Qwen3.5-122B-A10B', draftTokens: 0 },
};

/** Bytes per cached value in each K/V cache type of llama.cpp: q8_0 keeps 32 values in 34 bytes. */
const KV_BYTES_PER_VALUE: Record<string, number> = { f16: 2, q8_0: 34 / 32 };
/**
 * The cache type of llama-server's draft context, which holds the prediction layer's cache: its
 * default, because the runtime sets only the main context's (`--cache-type-k`).
 */
const DRAFT_KV_CACHE_TYPE = 'f16';
/** The sliding-window cache holds the window plus one batch of 512 tokens (`n_swa + n_ubatch`). */
const SLIDING_EXTRA_CELLS = 512;
/** The head size of a Gated DeltaNet layer's keys and values, and its convolution kernel, in every model above. */
const LINEAR_HEAD_DIM = 128;
const LINEAR_CONV_KERNEL = 4;

/** The recurrent state of the linear-attention layers in bytes: the convolution tail and the delta state. */
function recurrentStateBytes(arch: Architecture, convBytes: number): number {
  if (!('linear' in arch)) return 0;
  const { layers, vHeads, kHeads } = arch.linear;
  const convDim = vHeads * LINEAR_HEAD_DIM + 2 * kHeads * LINEAR_HEAD_DIM;
  const conv = (LINEAR_CONV_KERNEL - 1) * convDim * convBytes;
  const delta = vHeads * LINEAR_HEAD_DIM * LINEAR_HEAD_DIM * 4;
  return layers * (conv + delta);
}

/** What a `llamacpp` row's three figures must be, from its architecture and the runtime's settings. */
function llamaCppFigures(arch: Architecture, draftTokens: number): [number, number, number] {
  const predictionLayer = draftTokens > 0;
  const perValue = KV_BYTES_PER_VALUE[RUNTIME_KV_CACHE_TYPE];
  const perLayer = arch.kvHeads * arch.headDim * 2;
  // The prediction layer's cache sits in the draft context, in the draft's cache type.
  const held =
    arch.attentionLayers * perLayer * perValue +
    (predictionLayer ? perLayer * KV_BYTES_PER_VALUE[DRAFT_KV_CACHE_TYPE] : 0);
  // llama.cpp keeps the recurrent state in f32 (both parts), the sliding window in the cache type.
  const recurrent = recurrentStateBytes(arch, 4);
  const sliding =
    'sliding' in arch ? arch.sliding.layers * (arch.sliding.window + SLIDING_EXTRA_CELLS) * perLayer * perValue : 0;
  // Live: the sliding window, and the recurrent state with one rollback copy per drafted token
  // (`--spec-draft-n-max`, which `need_n_rs_seq()` turns into that many copies).
  const live = sliding + recurrent * (1 + draftTokens);
  // A context checkpoint is a copy of what cannot be rolled back: the recurrent state or the window.
  const checkpoints = RUNTIME_CTX_CHECKPOINTS * (recurrent + sliding);
  return [held, live + checkpoints + 1_000_000_000 + RUNTIME_HOST_PROMPT_CACHE_MIB * MIB, 0];
}

/** The per-token figure of the MLX runner computed from an architecture: K/V in bf16, a recurrent snapshot per 8,192 tokens. */
function mlxComputedPerToken(arch: Architecture): number {
  return arch.attentionLayers * arch.kvHeads * arch.headDim * 2 * 2 + recurrentStateBytes(arch, 2) / 8192;
}

/** The figures measured for `qwen3.6:35b-a3b` on the MacBook Pro. */
const MEASURED: [number, number, number] = [37_000, 3_000_000_000, 5_000_000_000];

/** What an estimated `mlx` row's three figures must be: computed, scaled by what the measured row showed. */
function mlxFigures(arch: Architecture): [number, number, number] {
  const ratio = MEASURED[0] / mlxComputedPerToken(ARCHITECTURES['Qwen3.6-35B-A3B']);
  return [Math.ceil(mlxComputedPerToken(arch) * ratio), MEASURED[1] + 8 * GIB, MEASURED[2]];
}

/** A row's three memory figures. */
function figuresOf(model: LocalModelEntry): [number, number, number] {
  return [model.heldBytesPerToken, model.overheadBytes, model.peakExtraBytes];
}

describe('the stock catalogue', () => {
  const models = STOCK_LOCAL_MODEL_CATALOG.models;

  it('passes its own schema', () => {
    expect(issuesOf(STOCK_LOCAL_MODEL_CATALOG)).toEqual([]);
  });

  it('is what the getter returns, validated once', () => {
    const first = getLocalModelCatalog();
    expect(first).toEqual(STOCK_LOCAL_MODEL_CATALOG);
    // Parsed on first use, then reused: the same object, not a new parse per request.
    expect(getLocalModelCatalog()).toBe(first);
  });

  it('lists ten models, by rank, and none of those set aside in the header', () => {
    expect(models.map((m) => m.id)).toEqual([
      'qwen3.5:9b-q4_k_m',
      'ornith:9b-q4_k_m',
      'mimo-v2.6:9b-q4_k_m',
      'north-mini-code-1.0:q4_k_m',
      'muse-glimmer:30b-q4_k_m',
      'qwen3.6:35b-a3b-mtp-q4_k_m',
      'qwen3.6:35b-a3b',
      'qwen3.8:27b-q8_0',
      'qwen3.8:27b-mtp-q4_k_m',
      'ornith-1.5:122b',
    ]);
    expect(models.map((m) => m.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const setAside =
      /^(bonsai-2|gpt-oss|flint|lfm2\.5|laguna|qwen3\.8-flash-next|qwen3\.5:(122b|4b)|ripple-preview|nemotron-3\.5-super|qwen3-coder-next)|^ornith-1\.5:(9b|35b|397b)|^ornith:35b|^muse-glimmer:.*(mlx|dflash)/;
    expect(models.filter((m) => setAside.test(m.id)).map((m) => m.id)).toEqual([]);
    // The plain 9B and 27B tags are MLX builds on a Mac: their GGUF builds are listed instead.
    for (const plain of ['qwen3.5:9b', 'mimo-v2.6:9b', 'qwen3.8:27b']) {
      expect(models.some((m) => m.id === plain)).toBe(false);
    }
  });

  it('names the runner a Mac uses for each tag', () => {
    expect(Object.fromEntries(models.map((m) => [m.id, m.runner]))).toEqual({
      'qwen3.5:9b-q4_k_m': 'llamacpp',
      'ornith:9b-q4_k_m': 'llamacpp',
      'mimo-v2.6:9b-q4_k_m': 'llamacpp',
      'north-mini-code-1.0:q4_k_m': 'llamacpp',
      'muse-glimmer:30b-q4_k_m': 'llamacpp',
      'qwen3.6:35b-a3b-mtp-q4_k_m': 'llamacpp',
      // Manifest lists: a Mac takes the MLX child.
      'qwen3.6:35b-a3b': 'mlx',
      'qwen3.8:27b-q8_0': 'llamacpp',
      'qwen3.8:27b-mtp-q4_k_m': 'llamacpp',
      'ornith-1.5:122b': 'mlx',
    });
  });

  it('carries the size of the build a Mac pulls: every layer plus the config', () => {
    expect(Object.fromEntries(models.map((m) => [m.id, m.bytes]))).toEqual({
      // The registry's manifests as fetched on 2026-11-08, in lowercase.
      'qwen3.5:9b-q4_k_m': 6_550_825_550,
      // Fetched on 2026-11-10. No vision projector: the weights, a system prompt, the licence.
      'ornith:9b-q4_k_m': 5_629_110_568,
      'mimo-v2.6:9b-q4_k_m': 6_550_811_033,
      'north-mini-code-1.0:q4_k_m': 18_593_967_008,
      // Fetched on 2026-11-10: 16.76 GB of weights and a 1.40 GB projector.
      'muse-glimmer:30b-q4_k_m': 18_157_010_252,
      'qwen3.6:35b-a3b-mtp-q4_k_m': 22_621_314_381,
      // The MLX child of the list, and the total of a real pull on a Mac, byte for byte.
      'qwen3.6:35b-a3b': 23_105_798_956,
      'qwen3.8:27b-q8_0': 29_978_242_050,
      'qwen3.8:27b-mtp-q4_k_m': 17_741_872_154,
      // The MLX child of the list (its GGUF child is 76,756,174,997).
      'ornith-1.5:122b': 73_388_069_552,
    });
  });

  it('says which row was measured on a Mac: one, and every other row is an estimate', () => {
    expect(models.filter((m) => m.figures === 'measured').map((m) => m.id)).toEqual(['qwen3.6:35b-a3b']);
    expect(figuresOf(models.find((m) => m.id === 'qwen3.6:35b-a3b') as LocalModelEntry)).toEqual(MEASURED);
  });

  it('has one tested entry: the 35B-A3B with OpenCode on the MacBook Pro, with its measured speed', () => {
    expect(Object.fromEntries(models.filter((m) => m.tested.length > 0).map((m) => [m.id, m.tested]))).toEqual({
      'qwen3.6:35b-a3b': [
        { chip: 'Apple M5 Pro', memGb: 48, cli: 'opencode', date: '2026-11-06', tokensPerSecond: 67.7 },
      ],
    });
    // A row may claim a test only when its figures were measured.
    for (const model of models) {
      if (model.tested.length > 0) expect(model.figures, model.id).toBe('measured');
    }
  });

  it('gives every model a parameter count, an id of the default registry and a license', () => {
    expect(Object.fromEntries(models.map((m) => [m.id, [m.paramsB, m.license]]))).toEqual({
      'qwen3.5:9b-q4_k_m': [9, 'Apache-2.0'],
      'ornith:9b-q4_k_m': [9, 'MIT'],
      'mimo-v2.6:9b-q4_k_m': [9, 'MIT'],
      'north-mini-code-1.0:q4_k_m': [30, 'Apache-2.0'],
      // The card's total: a 27.9B language model and a vision encoder.
      'muse-glimmer:30b-q4_k_m': [29.6, 'Apache-2.0'],
      'qwen3.6:35b-a3b-mtp-q4_k_m': [35, 'Apache-2.0'],
      'qwen3.6:35b-a3b': [35, 'Apache-2.0'],
      'qwen3.8:27b-q8_0': [27.8, 'Apache-2.0'],
      'qwen3.8:27b-mtp-q4_k_m': [27.8, 'Apache-2.0'],
      'ornith-1.5:122b': [122, 'MIT'],
    });
    for (const model of models) expect(model.id).toMatch(LOCAL_MODEL_ID_PATTERN);
    // The three 9B rows are the ones under the 12 billion line of the `limited` verdict.
    expect(models.filter((m) => m.paramsB < 12).map((m) => m.id)).toEqual([
      'qwen3.5:9b-q4_k_m',
      'ornith:9b-q4_k_m',
      'mimo-v2.6:9b-q4_k_m',
    ]);
  });

  it('offers no model below the 65536 tokens a harness needs, nor beyond its own window', () => {
    for (const model of models) {
      expect(Math.min(...model.contexts), model.id).toBeGreaterThanOrEqual(65536);
      expect(model.contexts[0], model.id).toBeLessThanOrEqual(262144);
    }
  });

  it('has a speed figure only where one was measured or scaled from a measurement', () => {
    expect(Object.fromEntries(models.map((m) => [m.id, m.speedPer100Gbps ?? null]))).toEqual({
      // 37.1 tokens per second on 400 GB/s, and the same for the two fine-tunes of the same size.
      'qwen3.5:9b-q4_k_m': 9.3,
      'ornith:9b-q4_k_m': 9.3,
      'mimo-v2.6:9b-q4_k_m': 9.3,
      // The 35B-A3B's llama.cpp figure: both have 3 billion active parameters.
      'north-mini-code-1.0:q4_k_m': 13.6,
      // The dense 27B's figure: the weights of the two are the same size.
      'muse-glimmer:30b-q4_k_m': 2.95,
      // 54.5 on 400 GB/s with llama.cpp.
      'qwen3.6:35b-a3b-mtp-q4_k_m': 13.6,
      // 67.8 on 400 GB/s with MLX.
      'qwen3.6:35b-a3b': 16.9,
      // 2.95 scaled by file size.
      'qwen3.8:27b-q8_0': 1.7,
      // 11.8 on 400 GB/s with llama.cpp, without prediction.
      'qwen3.8:27b-mtp-q4_k_m': 2.95,
      // 16.9 x 3/10 active parameters, rounded down.
      'ornith-1.5:122b': 5,
    });
  });

  it('lists its harnesses as data rows: four, none gated, none below the smallest context a model offers', () => {
    expect(STOCK_LOCAL_MODEL_CATALOG.harnesses).toEqual([
      { cli: 'opencode', minContext: 65536, rank: 4, readyMark: '┃' },
      { cli: 'claude', minContext: 65536, rank: 3, slowFirstTurn: true },
      { cli: 'pi', minContext: 65536, rank: 2 },
      { cli: 'deepseek', minContext: 65536, rank: 1 },
    ]);
    // No harness asks for less than a model can be offered at: nothing below 65536 was run.
    const smallest = Math.min(...STOCK_LOCAL_MODEL_CATALOG.models.flatMap((model) => model.contexts));
    for (const harness of STOCK_LOCAL_MODEL_CATALOG.harnesses) {
      expect(harness.minContext).toBeGreaterThanOrEqual(smallest);
    }
  });

  it('a readiness mark is one literal without white space', () => {
    const spaced = copy();
    spaced.harnesses[0] = { ...spaced.harnesses[0], readyMark: '/ commands' };
    expect(issuesOf(spaced)).toHaveLength(1);
    expect(issuesOf(spaced)[0]).toMatch(/^harnesses\.0\.readyMark: /);
    const empty = copy();
    empty.harnesses[0] = { ...empty.harnesses[0], readyMark: '' };
    expect(issuesOf(empty)[0]).toMatch(/^harnesses\.0\.readyMark: /);
  });

  it('holds no more models than one window lists: the pick and MAX_ALTERNATIVES others', () => {
    // recommend() cuts the list at MAX_ALTERNATIVES. While the catalogue stays under it, a Mac
    // is shown every model that fits and the install accepts every one of them. A catalogue
    // that outgrows the bound must fail here, so the bound is raised (or kept) on purpose.
    expect(models.length - 1).toBeLessThanOrEqual(MAX_ALTERNATIVES);
  });

  it('names the oldest macOS and its schema version', () => {
    expect(STOCK_LOCAL_MODEL_CATALOG.minMacosMajor).toBe(14);
    expect(STOCK_LOCAL_MODEL_CATALOG.schema).toBe(1);
  });

  it('holds no download data: no URL, no digest, no runtime block', () => {
    const text = JSON.stringify(STOCK_LOCAL_MODEL_CATALOG);
    expect(text).not.toMatch(/https?:/);
    expect(text).not.toMatch(/sha256/i);
    expect(Object.keys(STOCK_LOCAL_MODEL_CATALOG).sort()).toEqual(
      ['chips', 'harnesses', 'minMacosMajor', 'models', 'schema', 'updated'].sort()
    );
  });
});

describe('the memory figures of the stock rows: each row has its own', () => {
  const models = STOCK_LOCAL_MODEL_CATALOG.models;

  it('knows the architecture of every row, and every row of that table is in the catalogue', () => {
    expect(models.map((m) => m.id).sort()).toEqual(Object.keys(ROW_ARCHITECTURE).sort());
  });

  it('computes the llamacpp rows for the K/V cache type and the prompt cache the runtime really sets', () => {
    // The figures below assume these; runtimeEnv() is what the runtime gets.
    const env = runtimeEnv({ source: {}, home: '/h', modelsDir: '/m', port: 11435, contextLength: 65536 });
    expect(env.OLLAMA_KV_CACHE_TYPE).toBe(RUNTIME_KV_CACHE_TYPE);
    expect(env.LLAMA_ARG_CACHE_RAM).toBe(String(RUNTIME_HOST_PROMPT_CACHE_MIB));
    expect(env.LLAMA_ARG_CTX_CHECKPOINTS).toBe(String(RUNTIME_CTX_CHECKPOINTS));
    expect(KV_BYTES_PER_VALUE[RUNTIME_KV_CACHE_TYPE]).toBeDefined();
    // The runtime sets no cache type for the draft context, so the prediction layer's stays f16.
    expect(Object.keys(env).filter((name) => /DRAFT|SPEC/.test(name))).toEqual([]);
  });

  it("recomputes every estimated row's figures from its own model's architecture and runner", () => {
    for (const model of models.filter((m) => m.figures === 'estimated')) {
      const { architecture, draftTokens } = ROW_ARCHITECTURE[model.id];
      const arch = ARCHITECTURES[architecture];
      const expected = model.runner === 'llamacpp' ? llamaCppFigures(arch, draftTokens) : mlxFigures(arch);
      expect(figuresOf(model), `${model.id} (${architecture}, ${model.runner})`).toEqual(expected);
    }
  });

  it('states the numbers the header and the row comments name', () => {
    expect(Object.fromEntries(models.map((m) => [m.id, figuresOf(m)]))).toEqual({
      // State x (1 live + 8 checkpoints) + 1.0 GB + 1 GiB.
      'qwen3.5:9b-q4_k_m': [17_408, 2_547_960_320, 0],
      'ornith:9b-q4_k_m': [17_408, 2_547_960_320, 0],
      'mimo-v2.6:9b-q4_k_m': [17_408, 2_547_960_320, 0],
      // The sliding window x (1 live + 8 checkpoints) + 1.0 GB + 1 GiB.
      'north-mini-code-1.0:q4_k_m': [14_144, 3_698_117_120, 0],
      // The same rule: 39 layers x 2,560 cells x 544 bytes = 54,312,960 per copy.
      'muse-glimmer:30b-q4_k_m': [7_072, 2_562_558_464, 0],
      // State x (1 live + 2 rollback copies + 8 checkpoints) + 1.0 GB + 1 GiB; the prediction
      // layer's cache in f16 per token. The 27B rows below draft 4 tokens: 4 rollback copies.
      'qwen3.6:35b-a3b-mtp-q4_k_m': [12_928, 2_798_242_304, 0],
      'qwen3.6:35b-a3b': [37_000, 3_000_000_000, 5_000_000_000],
      'qwen3.8:27b-q8_0': [38_912, 4_113_353_216, 0],
      'qwen3.8:27b-mtp-q4_k_m': [38_912, 4_113_353_216, 0],
      'ornith-1.5:122b': [56_574, 11_589_934_592, 5_000_000_000],
    });
    // The two parts of a llamacpp overhead that are not computed from the architecture.
    expect(RUNTIME_CTX_CHECKPOINTS).toBe(8);
    expect(RUNTIME_HOST_PROMPT_CACHE_MIB).toBe(1024);
    // The MLX calibration: 37,000 held against 28,340 computed for the measured row.
    expect(mlxComputedPerToken(ARCHITECTURES['Qwen3.6-35B-A3B'])).toBe(28_340);
    expect(mlxComputedPerToken(ARCHITECTURES['Qwen3.5-122B-A10B'])).toBe(43_332);
  });

  it('lets two rows share figures only when they share the architecture, the drafted tokens and the runner', () => {
    const byFigures = new Map<string, LocalModelEntry[]>();
    for (const model of models) {
      const key = figuresOf(model).join('/');
      byFigures.set(key, [...(byFigures.get(key) ?? []), model]);
    }
    const shared = [...byFigures.values()].filter((group) => group.length > 1);
    // The three 9B rows (a base and two fine-tunes of it) and the two 27B rows (two quantizations of one model).
    expect(shared.map((group) => group.map((m) => m.id))).toEqual([
      ['qwen3.5:9b-q4_k_m', 'ornith:9b-q4_k_m', 'mimo-v2.6:9b-q4_k_m'],
      ['qwen3.8:27b-q8_0', 'qwen3.8:27b-mtp-q4_k_m'],
    ]);
    for (const group of shared) {
      const identity = (m: LocalModelEntry): string => JSON.stringify([ROW_ARCHITECTURE[m.id], m.runner, m.figures]);
      expect(new Set(group.map(identity)).size, group.map((m) => m.id).join(', ')).toBe(1);
    }
  });

  it("gives no estimated row the measured row's per-token or overhead figure", () => {
    for (const model of models.filter((m) => m.figures === 'estimated')) {
      expect(model.heldBytesPerToken, model.id).not.toBe(MEASURED[0]);
      expect(model.overheadBytes, model.id).not.toBe(MEASURED[1]);
      expect(figuresOf(model), model.id).not.toEqual(MEASURED);
    }
  });

  it('gives a llamacpp row no peak (its buffers are allocated at load) and an estimated mlx row the whole prefix budget', () => {
    for (const model of models) {
      if (model.runner === 'llamacpp') expect(model.peakExtraBytes, model.id).toBe(0);
      if (model.runner === 'mlx' && model.figures === 'estimated') {
        expect(model.overheadBytes - MEASURED[1], model.id).toBe(8 * GIB);
      }
    }
  });
});

describe('the model id rule', () => {
  it('accepts name:tag in lowercase', () => {
    for (const id of ['qwen3.5:9b', 'gpt-oss:20b', 'qwen3.8:27b-q8_0', 'a:b', 'x_y.z-1:2.3_4']) {
      expect(LOCAL_MODEL_ID_PATTERN.test(id), id).toBe(true);
    }
  });

  it('refuses anything that could name another registry, namespace or no tag at all', () => {
    const bad = [
      'evil.example/x/y:z',
      'library/qwen3.5:9b',
      'registry.ollama.ai/library/qwen3.5:9b',
      'Qwen3.5:9b',
      'qwen3.5:9B',
      'qwen3.5',
      'qwen3.5:',
      ':9b',
      'qwen3.5:9b:extra',
      'qwen 3.5:9b',
      '-qwen:9b',
      'qwen:-9b',
      'qwen3.5:9b\n',
      '',
    ];
    for (const id of bad) expect(LOCAL_MODEL_ID_PATTERN.test(id), JSON.stringify(id)).toBe(false);
  });

  it('makes the schema reject a catalogue with such an id', () => {
    for (const id of ['evil.example/x/y:z', 'Qwen3.5:9b', 'qwen3.5', 'qwen3.5:9b ']) {
      const issues = issuesOf(withFirstModel({ id }));
      expect(issues, id).toHaveLength(1);
      expect(issues[0]).toContain('models.0.id');
    }
  });
});

describe('the schema, field by field', () => {
  it('refuses a key it does not know, at the top and inside a row', () => {
    // The whole point of having no `runtime` block: a data row can never carry a download URL.
    expect(issuesOf({ ...copy(), runtime: { url: 'https://example.com/x.tgz', sha256: 'abc' } })).not.toEqual([]);
    expect(issuesOf(withFirstModel({ url: 'https://example.com/model' }))).not.toEqual([]);
    const catalog = copy();
    expect(issuesOf({ ...catalog, harnesses: [{ ...catalog.harnesses[0], dialect: 'openai' }] })).not.toEqual([]);
    expect(issuesOf({ ...catalog, chips: [{ match: 'M4', gbps: 120, cores: 10 }] })).not.toEqual([]);
    // The two figures the need was once computed from are gone, and a row that still has one is refused.
    expect(issuesOf(withFirstModel({ kvBytesPerToken: 32768 }))).not.toEqual([]);
    expect(issuesOf({ ...catalog, promptCacheTiers: [{ minMemGb: 0, bytes: 1 }] })).not.toEqual([]);
  });

  it('requires the memory figures and where they come from on every model row', () => {
    for (const field of ['heldBytesPerToken', 'overheadBytes', 'peakExtraBytes', 'figures'] as const) {
      const row: Record<string, unknown> = { ...copy().models[0] };
      delete row[field];
      const issues = issuesOf({ ...copy(), models: [row] });
      expect(issues, field).toHaveLength(1);
      expect(issues[0]).toContain(`models.0.${field}`);
    }
    expect(issuesOf(withFirstModel({ figures: 'guessed' }))).not.toEqual([]);
    // What stays held per token must be a positive whole number of bytes; the other two may be 0.
    expect(issuesOf(withFirstModel({ heldBytesPerToken: 0 }))).not.toEqual([]);
    expect(issuesOf(withFirstModel({ heldBytesPerToken: 36.5 }))).not.toEqual([]);
    expect(issuesOf(withFirstModel({ overheadBytes: 0, peakExtraBytes: 0 }))).toEqual([]);
    expect(issuesOf(withFirstModel({ overheadBytes: -1 }))).not.toEqual([]);
    expect(issuesOf(withFirstModel({ peakExtraBytes: 1.5 }))).not.toEqual([]);
  });

  it('requires the runner on every model row, and knows two', () => {
    const row: Record<string, unknown> = { ...copy().models[0] };
    delete row.runner;
    const issues = issuesOf({ ...copy(), models: [row] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('models.0.runner');
    expect(issuesOf(withFirstModel({ runner: 'mlx' }))).toEqual([]);
    expect(issuesOf(withFirstModel({ runner: 'llamacpp' }))).toEqual([]);
    for (const runner of ['ggml', 'MLX', 'llama.cpp', '']) {
      expect(issuesOf(withFirstModel({ runner })), runner).not.toEqual([]);
    }
  });

  it('requires paramsB and tested on every model row', () => {
    for (const field of ['paramsB', 'tested'] as const) {
      const row: Record<string, unknown> = { ...copy().models[0] };
      delete row[field];
      const issues = issuesOf({ ...copy(), models: [row] });
      expect(issues, field).toHaveLength(1);
      expect(issues[0]).toContain(`models.0.${field}`);
    }
  });

  it('refuses sizes and counts that are not positive whole numbers', () => {
    expect(issuesOf(withFirstModel({ bytes: 0 }))).not.toEqual([]);
    expect(issuesOf(withFirstModel({ bytes: 1.5 }))).not.toEqual([]);
    expect(issuesOf(withFirstModel({ contexts: [] }))).not.toEqual([]);
    expect(issuesOf(withFirstModel({ paramsB: 0 }))).not.toEqual([]);
    expect(issuesOf(withFirstModel({ speedPer100Gbps: 0 }))).not.toEqual([]);
  });

  it('accepts a tested entry and checks its shape', () => {
    const good = { chip: 'Apple M4', memGb: 16, cli: 'opencode', date: '2026-11-06' };
    expect(issuesOf(withFirstModel({ tested: [good] }))).toEqual([]);
    expect(issuesOf(withFirstModel({ tested: [{ ...good, date: '6 November 2026' }] }))).not.toEqual([]);
    expect(issuesOf(withFirstModel({ tested: [{ ...good, memGb: 0 }] }))).not.toEqual([]);
    expect(issuesOf(withFirstModel({ tested: [{ ...good, result: 'pass' }] }))).not.toEqual([]);
    // The speed measured in that test is optional, and a speed is above 0.
    expect(issuesOf(withFirstModel({ tested: [{ ...good, tokensPerSecond: 67.7 }] }))).toEqual([]);
    expect(issuesOf(withFirstModel({ tested: [{ ...good, tokensPerSecond: 0 }] }))).not.toEqual([]);
    expect(issuesOf(withFirstModel({ tested: [{ ...good, tokensPerSecond: '67.7' }] }))).not.toEqual([]);
  });

  it('refuses another schema version and a date that is not ISO', () => {
    expect(issuesOf({ ...copy(), schema: 2 })).not.toEqual([]);
    expect(issuesOf({ ...copy(), updated: 'today' })).not.toEqual([]);
  });
});

describe('the schema, across rows', () => {
  it('refuses a repeated model id', () => {
    const catalog = copy();
    catalog.models[1] = { ...catalog.models[1], id: catalog.models[0].id };
    expect(issuesOf(catalog)).toEqual(['models.1.id: model ids must be unique']);
  });

  it('refuses a repeated model rank, which would leave the order of two models to chance', () => {
    const catalog = copy();
    catalog.models[1] = { ...catalog.models[1], rank: catalog.models[0].rank };
    expect(issuesOf(catalog)).toEqual(['models.1.rank: model ranks must be unique']);
  });

  it('refuses a harness listed twice and a repeated harness rank', () => {
    const twice = copy();
    twice.harnesses.push({ cli: twice.harnesses[0].cli, minContext: 32768, rank: 9 });
    expect(issuesOf(twice)).toEqual(['harnesses.4.cli: a harness may be listed only once']);

    const sameRank = copy();
    sameRank.harnesses[1] = { ...sameRank.harnesses[1], rank: sameRank.harnesses[0].rank };
    expect(issuesOf(sameRank)).toEqual(['harnesses.1.rank: harness ranks must be unique']);
  });

  it('refuses contexts that are not listed largest first, or that repeat', () => {
    expect(issuesOf(withFirstModel({ contexts: [32768, 65536] }))).toEqual([
      'models.0.contexts.1: contexts must be listed largest first, without repeats',
    ]);
    expect(issuesOf(withFirstModel({ contexts: [65536, 65536] }))).toEqual([
      'models.0.contexts.1: contexts must be listed largest first, without repeats',
    ]);
  });

  it('refuses a tested entry for a harness the catalogue does not list', () => {
    const entry = { chip: 'Apple M4', memGb: 16, cli: 'not-a-harness', date: '2026-11-06' };
    expect(issuesOf(withFirstModel({ tested: [entry] }))).toEqual([
      'models.0.tested.0.cli: a tested entry must name a harness of this catalogue',
    ]);
  });

  it('refuses chips that are not listed most specific first', () => {
    const catalog = copy();
    catalog.chips = [
      { match: 'M4', gbps: 120 },
      { match: 'M4 Max', gbps: 410 },
    ];
    expect(issuesOf(catalog)).toEqual([
      "chips.1.match: chips must be listed most specific first: 'M4' comes before 'M4 Max'",
    ]);

    const repeated = copy();
    repeated.chips = [
      { match: 'M4', gbps: 120 },
      { match: 'm4', gbps: 130 },
    ];
    expect(issuesOf(repeated)).toHaveLength(1);
  });
});

describe('the chips table', () => {
  const chips = STOCK_LOCAL_MODEL_CATALOG.chips;

  it('holds every chip of the source table that shipped', () => {
    // Bandwidth column of https://github.com/ggml-org/llama.cpp/discussions/4167, read on
    // 2026-11-06. A name that covers two bandwidths has the lower one.
    expect(Object.fromEntries(chips.map((row) => [row.match, row.gbps]))).toEqual({
      'M5 Ultra': 1228,
      'M3 Ultra': 800,
      'M2 Ultra': 800,
      'M1 Ultra': 800,
      'M5 Max': 460,
      'M4 Max': 410,
      'M3 Max': 300,
      'M2 Max': 400,
      'M1 Max': 400,
      'M5 Pro': 307,
      'M4 Pro': 273,
      'M3 Pro': 150,
      'M2 Pro': 200,
      'M1 Pro': 200,
      M5: 154,
      M4: 120,
      M3: 100,
      M2: 100,
      M1: 68,
    });
  });

  it('finds each row under the name macOS reports for that chip', () => {
    // No row is hidden by an earlier one: 'Apple M4 Max' is 410, not the 120 of 'M4'.
    for (const row of chips) {
      expect(chipBandwidthGbps(chips, `Apple ${row.match}`), row.match).toBe(row.gbps);
    }
  });

  it('knows the chips of the two test Macs', () => {
    expect(chipBandwidthGbps(chips, 'Apple M4')).toBe(120);
    expect(chipBandwidthGbps(chips, 'Apple M5 Pro')).toBe(307);
  });

  it('never guesses: a chip that no row names has no bandwidth', () => {
    const unknown = [
      // A base chip that is not in the table.
      'Apple M6',
      // A variant the table has never heard of must not borrow the figure of its base chip.
      'Apple M6 Pro',
      'Apple M4 Ultra',
      'Apple M5 Extreme',
      // A name that merely contains a known name.
      'Apple M10',
      'Apple M12 Pro',
      'Apple M1 Max (Virtual)',
      'Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz',
      'VirtualApple @ 2.50GHz processor',
      'Max',
      '',
    ];
    for (const chip of unknown) expect(chipBandwidthGbps(chips, chip), chip).toBeUndefined();
    expect(chipBandwidthGbps(chips, undefined)).toBeUndefined();
    expect(chipBandwidthGbps([], 'Apple M4')).toBeUndefined();
  });
});

describe('chipNameMatches', () => {
  it('matches the whole chip name at the end of the string, ignoring case and padding', () => {
    expect(chipNameMatches('Apple M4 Pro', 'M4 Pro')).toBe(true);
    expect(chipNameMatches('Apple M4', 'M4')).toBe(true);
    expect(chipNameMatches('M4', 'M4')).toBe(true);
    expect(chipNameMatches('  apple m4 pro ', 'M4 PRO')).toBe(true);
  });

  it('does not match a part of a longer name', () => {
    expect(chipNameMatches('Apple M4 Pro', 'M4')).toBe(false);
    expect(chipNameMatches('Apple M14', 'M4')).toBe(false);
    expect(chipNameMatches('Apple M10', 'M1')).toBe(false);
    expect(chipNameMatches('Apple XM4', 'M4')).toBe(false);
    expect(chipNameMatches('Apple M4', '')).toBe(false);
    expect(chipNameMatches('', 'M4')).toBe(false);
  });
});
