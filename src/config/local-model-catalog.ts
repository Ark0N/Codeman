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
 * Where each figure of the stock rows comes from, and what was checked (2026-11-06):
 *
 * | Figure               | Source                                                    | Checked                              |
 * |----------------------|-----------------------------------------------------------|--------------------------------------|
 * | `id`                 | the registry's tag                                        | yes, by the facts review             |
 * | `bytes`              | `qwen3.6:35b-a3b`: the total of a real pull on a Mac      | that row: measured. It is an MLX     |
 * |                      | (23,105,798,956). Every other row: the sum of the layer   | build on a Mac, 2% above its         |
 * |                      | sizes of the tag's registry manifest                      | manifest. The others: not on a Mac   |
 * | `heldBytesPerToken`, | measured for `qwen3.6:35b-a3b` on an Apple M5 Pro with    | that row: measured. The others carry |
 * | `overheadBytes`,     | 48 GB: 36,000 to 38,000 bytes held per token of context,  | the SAME three figures, not their    |
 * | `peakExtraBytes`     | 2.5 to 3 GB beside the weights, and about 5 GB more for a | own: nobody ran them. `figures` says |
 * |                      | moment while a long prompt is processed                   | which row is which                   |
 * | `license`            | the model card (all Apache-2.0)                           | read by the research, not re-checked |
 * | `paramsB`            | 27.8 from the model card; the others are the count in the | no. Only the 12 billion line reads   |
 * |                      | model's name                                              | it, and no row is near that line     |
 * | `contexts`, `rank`   | a judgement of the design                                 | no                                   |
 * | `speedPer100Gbps`    | one published run on an M1 Max (400 GB/s): generation     | the run was read. It stands for less |
 * |                      | only, short prompt. The two q8_0 rows are SCALED by file  | than a session: no long prompt, no   |
 * |                      | size, not measured                                        | thinking tokens                      |
 * | `tested`             | our own run of the model with a harness on a real Mac     | one entry, with its measured speed   |
 * | `minMacosMajor`      | the runtime's documentation (macOS 14)                    | yes, by the facts review             |
 * | harness `minContext` | 65536: the runtime's documentation for both harnesses.    | 65536 yes. 32768 no, which is why    |
 * |                      | 32768: recalled                                           | that row is gated                    |
 * | `chips`              | the bandwidth column of                                   | yes, read at the source for this     |
 * |                      | https://github.com/ggml-org/llama.cpp/discussions/4167    | file                                 |
 *
 * The memory figures decide a lot and rest on ONE measured model, so for every other row they
 * can be wrong in either direction:
 *  - For the 9B rows they may be too HIGH (the 5 GB for a moment was seen with a prompt of
 *    89,000 tokens on the 35B model). That errs on the careful side: a small Mac is told
 *    "none" before it is told to download something that may not fit.
 *  - For the two dense `qwen3.8:27b` rows the per-token figure may be too LOW: computed from
 *    its config alone that model holds 64 KiB per token, more than the 37,000 bytes measured
 *    on the 35B (whose own computed figure was 20 KiB). Their need at a large context is
 *    therefore the least certain figure of the catalogue.
 * A row gets its own figures when somebody measures it. Until then the check after the
 * download (the runtime must report the whole model on the GPU) is what catches a row that
 * was judged too kindly.
 *
 * `tested` has one entry: `qwen3.6:35b-a3b` with OpenCode on an Apple M5 Pro with 48 GB,
 * 2026-11-06, 67.7 tokens per second. Only a Mac of exactly that chip and memory size is told
 * "Recommended" and shown that speed in place of the estimate.
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
 * the MLX runner), in decimal bytes. That row carries them as `measured`; every other row
 * carries the same three as `estimated`, see the file header.
 */
const MEASURED_MEMORY = {
  /** 36,000 to 38,000 bytes stayed held per token of context after a prompt of 89,000 and one of 167,000 tokens. */
  heldBytesPerToken: 37_000,
  /** The runner held 2.5 to 3 GB beside the weights. */
  overheadBytes: 3_000_000_000,
  /** While a long prompt was processed the peak stood about 5 GB above what stayed held. */
  peakExtraBytes: 5_000_000_000,
} as const;

/**
 * The catalogue that ships with Codeman. Never read directly outside this file and its test:
 * callers use `getLocalModelCatalog()`, which validates it first.
 */
export const STOCK_LOCAL_MODEL_CATALOG: LocalModelCatalog = {
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
