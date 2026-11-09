/**
 * @fileoverview The local model catalogue: which models, harnesses and chips the recommendation
 * knows, as a compiled constant validated by a Zod schema.
 *
 * Rules:
 *  - There is NO override file and no runtime download data here: nothing in this file reads
 *    the data dir, and a data file can never decide what gets recommended. Which runtime build
 *    is downloaded is a compiled constant of its own (src/local-model/runtime.ts).
 *  - A model id is `name:tag` in lowercase with no slash (`LOCAL_MODEL_ID_PATTERN`), so it can
 *    only ever name a model of the default registry and namespace.
 *  - A model row names the `runner` a Mac uses for its tag, and its memory figures follow that
 *    runner's rule (MEMORY below). A row's figures are its OWN: measured on that model, or
 *    computed from that model's architecture. test/local-model-catalog.test.ts recomputes every
 *    computed figure from a table of architectures and refuses a row that is not in it, so a
 *    new row needs its model's config.json read, not a figure borrowed from a neighbour.
 *  - A harness is a ROW (`{ cli, minContext, rank, gated?, slowFirstTurn? }`). The `cli` is a CLI
 *    registry id as data: no code may compare it with a literal. Whether that CLI exists and can
 *    take a custom model is checked against the registry at call time, in
 *    src/local-model/harness-facts.ts, never here.
 *  - The schema checks more than fields. Across rows it requires: unique model ids and ranks,
 *    unique harness `cli`s and ranks, `contexts` largest first, a `tested` entry naming a harness
 *    row, and `chips` most specific first.
 *  - `getLocalModelCatalog()` parses the constant once, on first use and never at import, and
 *    throws on a bad row. test/local-model-catalog.test.ts pins that the stock constant parses,
 *    so a bad row fails the gate and never reaches the route.
 *
 * Where each figure of the stock rows comes from, and what was checked (2026-11-08). [V] read
 * at the source that day, [M] measured on a Mac, [C] computed from [V] inputs:
 *
 * | Figure               | Source                                                    | Checked                              |
 * |----------------------|-----------------------------------------------------------|--------------------------------------|
 * | `id`                 | the registry's tag. The GGUF tags in lowercase: the       | [V] every row: the registry answers  |
 * |                      | registry spells them `-q4_K_M`, and an id here is         | the lowercase id with the same       |
 * |                      | lowercase (`LOCAL_MODEL_ID_PATTERN`)                      | manifest. NOT checked: that the      |
 * |                      |                                                           | runtime lists the pulled model under |
 * |                      |                                                           | that name (Codeman compares exactly) |
 * | `runner`             | the build the runtime 0.40.15 pulls on Apple silicon: the | [V] every row                        |
 * |                      | MLX child of a manifest list, else the one manifest       |                                      |
 * |                      | (`runnerPreferences()`: mlx, then llamacpp)               |                                      |
 * | `bytes`              | every layer plus the config of that build: the `total`    | [V] every row. [M] for               |
 * |                      | a pull reports                                            | `qwen3.6:35b-a3b`, byte for byte     |
 * | `heldBytesPerToken`, | `qwen3.6:35b-a3b`: [M] on an Apple M5 Pro with 48 GB.     | the others: [C], never run on a Mac. |
 * | `overheadBytes`,     | Every other row: [C] from its model's config.json for its | `figures` says which row is which.   |
 * | `peakExtraBytes`     | runner, see MEMORY below. No row borrows another's        | test/local-model-catalog.test.ts     |
 * |                      | figures: two rows share figures only when they share the  | recomputes every one                 |
 * |                      | architecture and the runner                               |                                      |
 * | `license`, `paramsB` | the model card (`paramsB` is the TOTAL, not the active    | [V]                                  |
 * |                      | parameters)                                               |                                      |
 * | `rank`               | a judgement on the agentic coding results of the vendors' | no: vendor tables disagree with each |
 * |                      | cards (SWE-bench Verified, SWE-bench Pro, Terminal-Bench) | other by several points              |
 * | `contexts`           | up to the model's own window, and at least the 65536 a    | no                                   |
 * |                      | harness needs                                             |                                      |
 * | `speedPer100Gbps`    | one published run per model family on an M1 Max          | the run was read. It stands for less |
 * |                      | (400 GB/s): generation only, short prompt. A row that is  | than a session: no long prompt, no   |
 * |                      | not that run is SCALED from it, and says how              | thinking tokens. An MTP build is     |
 * |                      |                                                           | faster than the run without it       |
 * | `tested`             | our own run of the model with a harness on a real Mac     | one entry, with its measured speed   |
 * | `minMacosMajor`      | the runtime's documentation (macOS 14)                    | yes, by the facts review             |
 * | harness `minContext` | 65536: the runtime's documentation for OpenCode ("64k or  | 65536 yes. 32768 no, which is why    |
 * |                      | higher"), and OpenCode v1.19.5's own fixed prompt (about  | that row is gated                    |
 * |                      | 8,000 to 10,000 tokens) and compaction rule: at 32768 it  |                                      |
 * |                      | leaves 14,000 to 16,000 tokens, less than one default     |                                      |
 * |                      | 2,000-line file read                                      |                                      |
 * | `chips`              | the bandwidth column of                                   | yes, read at the source for this     |
 * |                      | https://github.com/ggml-org/llama.cpp/discussions/4167    | file                                 |
 *
 * MEMORY. The need is `bytes + heldBytesPerToken x context + overheadBytes + peakExtraBytes`
 * (src/local-model/recommend.ts). The two runners spend memory differently, so a row's three
 * figures are filled by the rule of its runner:
 *
 *  - `llamacpp` (llama-server on Metal; runtime v0.40.15 source, llm/llama_server.go, and the
 *    llama.cpp it bundles, b12111). It allocates the K/V cache for the WHOLE context when the
 *    model loads, in the cache type the runtime sets (`RUNTIME_KV_CACHE_TYPE` in
 *    src/local-model/runtime.ts, q8_0: 34 bytes per 32 values), and does not grow after that.
 *    "MTP" below is a GGUF with a multi-token-prediction layer (`nextn_predict_layers` 1 in
 *    its header, read on 2026-11-08 from the first bytes of each model layer: the two `-mtp`
 *    tags and `qwen3.8:27b-q8_0` have it, the two 9B tags and North Mini Code do not). For
 *    such a model the runtime always passes `--spec-type draft-mtp --spec-draft-n-max N`, N
 *    being the tag's own `draft_num_predict` (its params layer: 4 for
 *    `qwen3.8:27b-mtp-q4_k_m`, 2 for `qwen3.6:35b-a3b-mtp-q4_k_m`) or the runtime's default
 *    of 4 (`qwen3.8:27b-q8_0` sets none).
 *     - held = attention layers x K/V heads x head dim x 2 (K and V) x 34/32. An MTP model
 *       adds its prediction layer, whose cache llama-server keeps in a draft context of the
 *       same length in the draft's own cache type, f16 by default (2 bytes per value).
 *     - overhead = the fixed caches (the f32 recurrent state of the linear-attention layers,
 *       or the sliding-window cache of `n_swa + 512` cells), held 1 + N times for an MTP
 *       model (llama.cpp keeps one recurrent state per drafted token for rollback,
 *       `need_n_rs_seq()`), + the context checkpoints: `LLAMA_ARG_CTX_CHECKPOINTS` host copies
 *       (`RUNTIME_CTX_CHECKPOINTS`, 8) of the state that cannot be rolled back (the recurrent
 *       state, or the sliding-window cache), + 1.0 GB for the runner's own buffers (calibrated
 *       on a third-party table of a 27B model on llama.cpp: 8.4 GB at 4,096 tokens with
 *       7.15 GB of weights), + the 1024 MiB host prompt cache that `LLAMA_ARG_CACHE_RAM`
 *       allows (`RUNTIME_HOST_PROMPT_CACHE_MIB`). The checkpoints and the prompt cache are
 *       host memory, not Metal buffers; on a Mac both come out of the same memory, so they
 *       are counted like the rest.
 *     - peak = 0: its compute buffers are allocated at load and are inside the 1.0 GB.
 *    The one outside check of this rule: a third party measured 65,600 bytes per token of
 *    growth at f16 for a model of the Qwen3.8-27B architecture, where its config gives 65,536.
 *    The checkpoints and the rollback copies are read in the llama.cpp source
 *    (tools/server/server-context.cpp `create_checkpoint`, src/llama-memory-recurrent.cpp),
 *    not measured.
 *  - `mlx` (runtime v0.40.15 source, mlxrunner/). It grows the K/V cache in bf16 with the
 *    tokens used, keeps the recurrent state in f32 and a snapshot of it every 8,192 tokens,
 *    and keeps up to 8 GiB of paged-out prefix snapshots (prefix_cache.go `maxPagedOutBytes`,
 *    not configurable). Third-party OpenCode sessions show that growth (runtime issues 17924
 *    and 18131), and the runtime books an MLX model at its weights alone (issue 19417).
 *     - `qwen3.6:35b-a3b`: MEASURED. 36,000 to 38,000 bytes held per token after prompts of
 *       89,000 and 167,000 tokens, 2.5 to 3 GB beside the weights, about 5 GB more for a
 *       moment while a long prompt was processed. NOT covered by that measurement: a session
 *       of many requests, in which the prefix snapshots may add up to 8 GiB. Its figures stay
 *       the measured ones (with 8 GiB on top it would not be offered on the Mac it ran on),
 *       and a 30-request session on it is the first thing to measure next.
 *     - every other `mlx` row: held = the K/V cache in bf16 + one recurrent snapshot per
 *       8,192 tokens, computed from the config, x 37,000 / 28,340: the ratio of what the
 *       measured row really held to the same computation for it (same runner, same
 *       architecture family). Overhead = the measured row's 3 GB + the whole 8 GiB prefix
 *       budget. Peak = the measured row's 5 GB, NOT scaled: what makes it up was not
 *       measured.
 *
 * After the download the install checks that the runtime holds the whole model on the GPU.
 * For a `llamacpp` row both of the runtime's figures are the buffers llama-server reports
 * allocating (weights, K/V cache, compute; `MemorySize()` in llm/llama_server.go), so the
 * check proves the whole load is on the GPU, whatever the cache type; what grows after the
 * load in host memory (the context checkpoints and the prompt cache) is counted above, not
 * checked. For an `mlx` row it proves only the weights (issue 19417): the figures above are
 * all that stands between such a row and swap.
 *
 * Models set aside on purpose (a weekly review should look at them again):
 *  - `bonsai-2:27b`, `bonsai-2:9b` (ternary builds of Qwen3.8-27B and Qwen3.5-9B; the 27B
 *    would make a 24 GB Mac `ok`): the vendor reports no SWE-bench and no agent loop, and
 *    whether 2-bit weights keep tool calls reliable was never measured.
 *  - `ornith-1.5:9b`, `ornith-1.5:35b`, `ornith-1.5:397b` (GGUF only): strong cards, but their
 *    manifests name no renderer and no tool parser, so whether tool calls work through the
 *    runtime is unknown (runtime pull request 17965 is open). `ornith-1.5:122b` has both.
 *  - `gpt-oss:20b`: weak in agentic coding (SWE-bench Verified 52.4, Terminal-Bench 2.1 15.2
 *    in NVIDIA's table).
 *  - `flint:40b`: runtime issue 19191 breaks integer tool arguments after the first call.
 *  - `lfm2.5:24b-a2b`: its licence allows commercial use only below USD 10M of revenue.
 *  - `laguna-xs-2.1`: the runtime's own page names an open problem with it on macOS.
 *    `laguna-s-2.1`: open runtime issues 17602 and 17632.
 *  - `qwen3.8-flash-next:125b`: the Qwen Community License, not an open licence.
 *  - The plain tags `qwen3.5:9b`, `mimo-v2.6:9b` and `qwen3.8:27b`: a Mac pulls their MLX
 *    builds, whose 8 GiB of prefix snapshots do not fit the Macs a 9B or a 27B is for. Their
 *    GGUF builds are listed instead.
 *  - `qwen3.5:122b-a10b`: replaced by `ornith-1.5:122b`, a fine-tune of it (SWE-bench
 *    Verified 84.5 against 72.0) whose MLX build carries a renderer and a tool parser.
 *
 * `tested` has one entry: `qwen3.6:35b-a3b` with OpenCode on an Apple M5 Pro with 48 GB,
 * 2026-11-06, 67.7 tokens per second. Only a Mac of exactly that chip and memory size is told
 * "Recommended" and shown that speed in place of the estimate. Every other row was never run
 * on a Mac by us, and its row says `estimated` and "not run on a Mac like this yet".
 */

import { z } from 'zod';
import type { ChipEntry, LocalModelCatalog } from '../types.js';

/** A model id: lowercase name, one colon, a tag. No slash, so no registry host or namespace can ride along. */
export const LOCAL_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/;

/**
 * Whether `chip` (a `machdep.cpu.brand_string`, 'Apple M4 Pro') is the chip a `ChipEntry.match`
 * ('M4 Pro') names: the string must END with the match, and the match must start at the
 * beginning or after a space. Case is ignored.
 *
 * Stricter than "the match occurs in the string" on purpose. 'M4' is not the chip of
 * 'Apple M4 Pro', 'M1' is not the chip of 'Apple M10', and a variant this table has never heard
 * of ('Apple M6 Pro') matches no row instead of borrowing the bandwidth of its base chip.
 */
export function chipNameMatches(chip: string, match: string): boolean {
  const name = chip.trim().toLowerCase();
  const wanted = match.trim().toLowerCase();
  if (wanted === '' || !name.endsWith(wanted)) return false;
  const start = name.length - wanted.length;
  return start === 0 || name[start - 1] === ' ';
}

/**
 * The memory bandwidth (GB/s) of `chip`, from the first row that names it. `undefined` when the
 * chip string is absent or no row names it: the speed is then UNKNOWN, a bandwidth is never guessed.
 */
export function chipBandwidthGbps(chips: readonly ChipEntry[], chip: string | undefined): number | undefined {
  if (!chip) return undefined;
  return chips.find((row) => chipNameMatches(chip, row.match))?.gbps;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be an ISO date (YYYY-MM-DD)');
const positiveInt = z.number().int().positive();

const TestedOnSchema = z
  .object({
    chip: z.string().min(1).max(80),
    memGb: positiveInt,
    cli: z.string().min(1).max(24),
    date: isoDate,
    tokensPerSecond: z.number().positive().optional(),
  })
  .strict();

const LocalModelEntrySchema = z
  .object({
    id: z.string().max(100).regex(LOCAL_MODEL_ID_PATTERN, 'must be name:tag in lowercase, without a slash'),
    label: z.string().min(1).max(80),
    license: z.string().min(1).max(40),
    paramsB: z.number().positive(),
    runner: z.enum(['mlx', 'llamacpp']),
    bytes: positiveInt,
    heldBytesPerToken: positiveInt,
    overheadBytes: z.number().int().nonnegative(),
    peakExtraBytes: z.number().int().nonnegative(),
    figures: z.enum(['measured', 'estimated']),
    contexts: z.array(positiveInt).min(1),
    rank: z.number().int(),
    speedPer100Gbps: z.number().positive().optional(),
    tested: z.array(TestedOnSchema),
  })
  .strict();

const LocalHarnessEntrySchema = z
  .object({
    cli: z.string().min(1).max(24),
    minContext: positiveInt,
    rank: z.number().int(),
    gated: z.boolean().optional(),
    slowFirstTurn: z.boolean().optional(),
  })
  .strict();

const ChipEntrySchema = z
  .object({
    match: z.string().min(1).max(40),
    gbps: z.number().positive(),
  })
  .strict();

/** The index of the first value that already occurred earlier in the list, or -1. */
function firstRepeat<T>(values: readonly T[]): number {
  const seen = new Set<T>();
  for (let i = 0; i < values.length; i++) {
    if (seen.has(values[i])) return i;
    seen.add(values[i]);
  }
  return -1;
}

/**
 * Validates a whole catalogue: every field, then the rules that hold across rows (see the file
 * header). Typed against `LocalModelCatalog`, so the two cannot drift apart.
 */
export const LocalModelCatalogSchema: z.ZodType<LocalModelCatalog> = z
  .object({
    schema: z.literal(1),
    updated: isoDate,
    minMacosMajor: positiveInt,
    models: z.array(LocalModelEntrySchema),
    harnesses: z.array(LocalHarnessEntrySchema),
    chips: z.array(ChipEntrySchema),
  })
  .strict()
  .superRefine((catalog, ctx) => {
    const issue = (path: (string | number)[], message: string): void => {
      ctx.addIssue({ code: 'custom', path, message });
    };

    // A repeated id would make "the model" ambiguous, a repeated rank would make the order of
    // two models depend on where they sit in the array.
    const repeatedId = firstRepeat(catalog.models.map((m) => m.id));
    if (repeatedId >= 0) issue(['models', repeatedId, 'id'], 'model ids must be unique');
    const repeatedRank = firstRepeat(catalog.models.map((m) => m.rank));
    if (repeatedRank >= 0) issue(['models', repeatedRank, 'rank'], 'model ranks must be unique');

    const harnessClis = catalog.harnesses.map((h) => h.cli);
    const repeatedCli = firstRepeat(harnessClis);
    if (repeatedCli >= 0) issue(['harnesses', repeatedCli, 'cli'], 'a harness may be listed only once');
    const repeatedHarnessRank = firstRepeat(catalog.harnesses.map((h) => h.rank));
    if (repeatedHarnessRank >= 0) issue(['harnesses', repeatedHarnessRank, 'rank'], 'harness ranks must be unique');

    catalog.models.forEach((model, m) => {
      for (let i = 1; i < model.contexts.length; i++) {
        if (model.contexts[i] >= model.contexts[i - 1]) {
          issue(['models', m, 'contexts', i], 'contexts must be listed largest first, without repeats');
          break;
        }
      }
      // An entry for a harness the catalogue does not list could never match a candidate: a typo.
      model.tested.forEach((entry, t) => {
        if (!harnessClis.includes(entry.cli)) {
          issue(['models', m, 'tested', t, 'cli'], 'a tested entry must name a harness of this catalogue');
        }
      });
    });

    // Most specific first ('M4 Max' before 'M4'): a row whose text sits inside a LATER row's text
    // is the less specific of the two, so it is in the wrong place. A repeated match is the same
    // mistake.
    for (let later = 1; later < catalog.chips.length; later++) {
      const laterMatch = catalog.chips[later].match.toLowerCase();
      const shadowing = catalog.chips.slice(0, later).find((row) => laterMatch.includes(row.match.toLowerCase()));
      if (shadowing) {
        issue(
          ['chips', later, 'match'],
          `chips must be listed most specific first: '${shadowing.match}' comes before '${catalog.chips[later].match}'`
        );
        break;
      }
    }
  });

/**
 * The memory figures measured for `qwen3.6:35b-a3b` on an Apple M5 Pro with 48 GB (2026-11-06,
 * the MLX runner), in decimal bytes. Only that row carries them; see the file header (MEMORY)
 * for what they do not cover.
 */
const MEASURED_MEMORY = {
  /** 36,000 to 38,000 bytes stayed held per token of context after a prompt of 89,000 and one of 167,000 tokens. */
  heldBytesPerToken: 37_000,
  /** The runner held 2.5 to 3 GB beside the weights. */
  overheadBytes: 3_000_000_000,
  /** While a long prompt was processed the peak stood about 5 GB above what stayed held. */
  peakExtraBytes: 5_000_000_000,
} as const;

/** The llama.cpp runner's own buffers, compute buffers included (file header, MEMORY). */
const LLAMACPP_RUNNER_BYTES = 1_000_000_000;
/** The host prompt cache llama-server may keep: `LLAMA_ARG_CACHE_RAM`, 1024 MiB (`RUNTIME_HOST_PROMPT_CACHE_MIB`). */
const LLAMACPP_PROMPT_CACHE_BYTES = 1024 * 1024 * 1024;
/** The context checkpoints llama-server may keep: `LLAMA_ARG_CTX_CHECKPOINTS`, 8 (`RUNTIME_CTX_CHECKPOINTS`). */
const LLAMACPP_CTX_CHECKPOINTS = 8;
/** The tokens the runtime drafts per step for an MTP model whose tag sets no `draft_num_predict`, 4: so many rollback states. */
const LLAMACPP_DEFAULT_DRAFT_TOKENS = 4;
/** The prefix snapshots the MLX runner may keep: `maxPagedOutBytes`, 8 GiB. */
const MLX_PREFIX_CACHE_BYTES = 8 * 1024 * 1024 * 1024;

/**
 * The catalogue that ships with Codeman. Never read directly outside this file and its test:
 * callers use `getLocalModelCatalog()`, which validates it first.
 */
export const STOCK_LOCAL_MODEL_CATALOG: LocalModelCatalog = {
  schema: 1,
  updated: '2026-11-08',
  // The oldest macOS the model runtime supports.
  minMacosMajor: 14,
  // Ordered by rank. The higher rank wins among models that fit and whose speed is graded
  // alike (recommend.ts ranks the speed grade first). See the file header for the models
  // that are left out and why.
  models: [
    {
      // Small Macs (16 to 32 GB, `limited`): the base model of the row below.
      id: 'qwen3.5:9b-q4_k_m',
      label: 'Qwen3.5 9B',
      license: 'Apache-2.0',
      paramsB: 9,
      runner: 'llamacpp',
      bytes: 6_550_825_550,
      // 8 attention layers x 4 K/V heads x 256 x 2 x 34/32.
      heldBytesPerToken: 17_408,
      // 24 linear-attention layers hold 52,690,944 bytes of f32 state: once live, and once in
      // each context checkpoint.
      overheadBytes: 52_690_944 * (1 + LLAMACPP_CTX_CHECKPOINTS) + LLAMACPP_RUNNER_BYTES + LLAMACPP_PROMPT_CACHE_BYTES,
      peakExtraBytes: 0,
      figures: 'estimated',
      contexts: [131072, 65536],
      rank: 1,
      // Measured: 37.1 tokens per second on 400 GB/s (this Q4_K_M build, llama.cpp).
      speedPer100Gbps: 9.3,
      tested: [],
    },
    {
      // Small Macs (16 to 32 GB, `limited`). MiMo-V2.6-Distill-Qwen-9B, a fine-tune of
      // Qwen3.5-9B for code and agents: SWE-bench Verified 61.1 and SWE-bench Pro 44.6,
      // against 60.0 and 32.0 for its base (Xiaomi's card). Requires exactly the pinned
      // runtime, 0.40.15.
      id: 'mimo-v2.6:9b-q4_k_m',
      label: 'MiMo V2.6 9B',
      license: 'MIT',
      paramsB: 9,
      runner: 'llamacpp',
      bytes: 6_550_811_033,
      // The architecture and the quantization of the row above, so its figures.
      heldBytesPerToken: 17_408,
      overheadBytes: 52_690_944 * (1 + LLAMACPP_CTX_CHECKPOINTS) + LLAMACPP_RUNNER_BYTES + LLAMACPP_PROMPT_CACHE_BYTES,
      peakExtraBytes: 0,
      figures: 'estimated',
      contexts: [131072, 65536],
      rank: 2,
      // Not measured: the 9.3 of the row above, the same architecture and file size.
      speedPer100Gbps: 9.3,
      tested: [],
    },
    {
      // Cohere's model for agentic software engineering, 3 billion parameters active:
      // SWE-bench Verified 67.6 (vendor). Its card asks OpenCode for interleaved reasoning,
      // which Codeman's OpenCode settings do not set.
      id: 'north-mini-code-1.0:q4_k_m',
      label: 'North Mini Code 1.0',
      license: 'Apache-2.0',
      paramsB: 30,
      runner: 'llamacpp',
      bytes: 18_593_967_008,
      // 13 full-attention layers x 4 K/V heads x 128 x 2 x 34/32.
      heldBytesPerToken: 14_144,
      // 36 sliding-window layers: (4,096 + 512) cells x 4 x 128 x 2 x 34/32 = 180,486,144, live
      // and in each context checkpoint.
      overheadBytes: 180_486_144 * (1 + LLAMACPP_CTX_CHECKPOINTS) + LLAMACPP_RUNNER_BYTES + LLAMACPP_PROMPT_CACHE_BYTES,
      peakExtraBytes: 0,
      figures: 'estimated',
      contexts: [262144, 131072, 65536],
      rank: 3,
      // Not measured: the 13.6 measured for Qwen3.6 35B-A3B on llama.cpp, which has the same
      // 3 billion active parameters.
      speedPer100Gbps: 13.6,
      tested: [],
    },
    {
      // Macs of 36 GB on a slower chip: the model of the tested pair, as a GGUF build whose
      // memory does not grow after it loaded. With its multi-token-prediction layer.
      id: 'qwen3.6:35b-a3b-mtp-q4_k_m',
      label: 'Qwen3.6 35B-A3B (GGUF)',
      license: 'Apache-2.0',
      paramsB: 35,
      runner: 'llamacpp',
      bytes: 22_621_314_381,
      // 10 attention layers x 2 K/V heads x 256 x 2 x 34/32 = 10,880, + the prediction layer in
      // f16: 2 x 256 x 2 x 2 = 2,048.
      heldBytesPerToken: 12_928,
      // 30 linear-attention layers hold 65,863,680 bytes of f32 state: live, in the 2 rollback
      // copies of prediction (this tag drafts 2 tokens, `draft_num_predict` 2), and in each
      // context checkpoint.
      overheadBytes:
        65_863_680 * (1 + 2 + LLAMACPP_CTX_CHECKPOINTS) + LLAMACPP_RUNNER_BYTES + LLAMACPP_PROMPT_CACHE_BYTES,
      peakExtraBytes: 0,
      figures: 'estimated',
      contexts: [262144, 131072, 65536],
      rank: 4,
      // Measured: 54.5 tokens per second on 400 GB/s (llama.cpp, without prediction).
      speedPer100Gbps: 13.6,
      tested: [],
    },
    {
      // 48 GB: the tested pair. SWE-bench Verified 73.4, SWE-bench Pro 49.5 (Qwen's card).
      id: 'qwen3.6:35b-a3b',
      label: 'Qwen3.6 35B-A3B',
      license: 'Apache-2.0',
      paramsB: 35,
      // The plain tag is a manifest list; a Mac takes its MLX child.
      runner: 'mlx',
      // What a Mac really downloads: the MLX build, 2% above the GGUF build of the row above.
      bytes: 23_105_798_956,
      ...MEASURED_MEMORY,
      figures: 'measured',
      contexts: [131072, 65536],
      rank: 5,
      // Measured: 67.8 tokens per second on 400 GB/s with MLX. The one Mac we tested ran it at
      // 67.7 on 307 GB/s, so on other chips the estimate is on the low side.
      speedPer100Gbps: 16.9,
      // Run by us with OpenCode on the MacBook Pro (Mac17,13): a four-step task with tool calls.
      tested: [{ chip: 'Apple M5 Pro', memGb: 48, cli: 'opencode', date: '2026-11-06', tokensPerSecond: 67.7 }],
    },
    {
      // Large Macs that want 8-bit weights: the row below in Q8_0, half as fast.
      id: 'qwen3.8:27b-q8_0',
      label: 'Qwen3.8 27B (Q8)',
      license: 'Apache-2.0',
      paramsB: 27.8,
      runner: 'llamacpp',
      bytes: 29_978_242_050,
      // The architecture of the row below, prediction layer included (its GGUF has one), and the
      // runtime's 4 drafted tokens (the tag sets none), so its figures.
      heldBytesPerToken: 38_912,
      overheadBytes:
        156_893_184 * (1 + LLAMACPP_DEFAULT_DRAFT_TOKENS + LLAMACPP_CTX_CHECKPOINTS) +
        LLAMACPP_RUNNER_BYTES +
        LLAMACPP_PROMPT_CACHE_BYTES,
      peakExtraBytes: 0,
      figures: 'estimated',
      contexts: [262144, 131072, 65536],
      rank: 6,
      // Not measured: the 2.95 of the row below scaled by file size.
      speedPer100Gbps: 1.7,
      tested: [],
    },
    {
      // 36 to 96 GB on a fast chip: the strongest model of this size. Terminal-Bench 2.1 73.0,
      // SWE-bench Pro 61.7 (Qwen's card). Dense, so it is slow on a Pro chip.
      id: 'qwen3.8:27b-mtp-q4_k_m',
      label: 'Qwen3.8 27B',
      license: 'Apache-2.0',
      paramsB: 27.8,
      runner: 'llamacpp',
      bytes: 17_741_872_154,
      // 16 attention layers x 4 K/V heads x 256 x 2 x 34/32 = 34,816, + the prediction layer in
      // f16: 4 x 256 x 2 x 2 = 4,096.
      heldBytesPerToken: 38_912,
      // 48 linear-attention layers hold 156,893,184 bytes of f32 state: live, in the 4 rollback
      // copies of prediction (`draft_num_predict` 4), and in each context checkpoint.
      overheadBytes:
        156_893_184 * (1 + 4 + LLAMACPP_CTX_CHECKPOINTS) + LLAMACPP_RUNNER_BYTES + LLAMACPP_PROMPT_CACHE_BYTES,
      peakExtraBytes: 0,
      figures: 'estimated',
      contexts: [262144, 131072, 65536],
      rank: 7,
      // Measured: 11.8 tokens per second on 400 GB/s (llama.cpp, Q4_K_M, without prediction).
      // This build predicts several tokens at a time, so it is faster than this figure says.
      speedPer100Gbps: 2.95,
      tested: [],
    },
    {
      // 128 GB and more. A fine-tune of Qwen3.5-122B-A10B, 10 billion parameters active:
      // Terminal-Bench 2.1 81.2, SWE-bench Verified 84.5, SWE-bench Pro 76.9 (Ornith's card).
      id: 'ornith-1.5:122b',
      label: 'Ornith 1.5 122B-A10B',
      license: 'MIT',
      paramsB: 122,
      // The plain tag is a manifest list; a Mac takes its MLX child (with a renderer and a
      // tool parser, which the GGUF builds of this family lack).
      runner: 'mlx',
      bytes: 73_388_069_552,
      // 12 attention layers x 2 K/V heads x 256 x 2 x 2 bytes = 24,576, + a 153,649,152-byte
      // recurrent snapshot per 8,192 tokens = 18,756: 43,332, x 37,000 / 28,340.
      heldBytesPerToken: 56_574,
      overheadBytes: MEASURED_MEMORY.overheadBytes + MLX_PREFIX_CACHE_BYTES,
      peakExtraBytes: MEASURED_MEMORY.peakExtraBytes,
      figures: 'estimated',
      contexts: [262144, 131072],
      rank: 8,
      // Not measured: the 16.9 of Qwen3.6 35B-A3B on MLX x 3/10, its active parameters
      // against these, rounded down.
      speedPer100Gbps: 5,
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

let validated: LocalModelCatalog | undefined;

/**
 * The catalogue in force: the stock constant, validated once on first use. Callers go through
 * this function, so a later stage can change where the catalogue comes from without touching
 * them. Throws when the constant breaks its own schema, which the catalogue test rules out.
 */
export function getLocalModelCatalog(): LocalModelCatalog {
  validated ??= LocalModelCatalogSchema.parse(STOCK_LOCAL_MODEL_CATALOG);
  return validated;
}
