/**
 * @fileoverview The local model catalogue: which models, harnesses and chips the recommendation
 * knows, as a compiled constant validated by a Zod schema.
 *
 * Rules:
 *  - There is NO override file and no runtime download data in this stage: nothing here reads
 *    the data dir, and a data file can never decide what gets recommended.
 *  - A model id is `name:tag` in lowercase with no slash (`LOCAL_MODEL_ID_PATTERN`), so it can
 *    only ever name a model of the default registry and namespace.
 *  - A harness is a ROW (`{ cli, minContext, rank, gated?, slowFirstTurn? }`). The `cli` is a CLI
 *    registry id as data: no code may compare it with a literal. Whether that CLI exists and can
 *    take a custom model is checked against the registry at call time, in
 *    src/local-model/harness-facts.ts, never here.
 *  - The schema checks more than fields. Across rows it requires: unique model ids and ranks,
 *    unique harness `cli`s and ranks, `contexts` largest first, a `tested` entry naming a harness
 *    row, `chips` most specific first, and `promptCacheTiers` ascending from 0.
 *  - `getLocalModelCatalog()` parses the constant once, on first use and never at import, and
 *    throws on a bad row. test/local-model-catalog.test.ts pins that the stock constant parses,
 *    so a bad row fails the gate and never reaches the route.
 *
 * Where each figure of the stock rows comes from, and what was checked (2026-11-06):
 *
 * | Figure               | Source                                                    | Checked                              |
 * |----------------------|-----------------------------------------------------------|--------------------------------------|
 * | `id`, `bytes`        | registry manifest of the tag, sum of its layer sizes      | yes, to the byte, by the facts review |
 * | `license`            | the model card (all Apache-2.0)                           | read by the research, not re-checked |
 * | `paramsB`            | 27.8 from the model card; the others are the count in the | no. Only the 12 billion line reads   |
 * |                      | model's name                                              | it, and no row is near that line     |
 * | `kvBytesPerToken`    | COMPUTED from each model's config: 2 x full-attention     | no. Not measured in a running        |
 * |                      | layers x KV heads x head size x 2 bytes                   | runtime. The review called the       |
 * |                      |                                                           | gpt-oss figure plausible, no more    |
 * | `contexts`, `rank`   | a judgement of the design                                 | no                                   |
 * | `speedPer100Gbps`    | one published run on an M1 Max (400 GB/s): generation     | the run was read. It stands for less |
 * |                      | only, short prompt. The two q8_0 rows are SCALED by file  | than a session: no long prompt, no   |
 * |                      | size, not measured                                        | thinking tokens                      |
 * | `minMacosMajor`      | the runtime's documentation (macOS 14)                    | yes, by the facts review             |
 * | `promptCacheTiers`   | a decision of the design, not a measurement               | no                                   |
 * | harness `minContext` | 65536: the runtime's documentation for both harnesses.    | 65536 yes. 32768 no, which is why    |
 * |                      | 32768: recalled                                           | that row is gated                    |
 * | `chips`              | the bandwidth column of                                   | yes, read at the source for this     |
 * |                      | https://github.com/ggml-org/llama.cpp/discussions/4167    | file                                 |
 *
 * `tested` is empty on every row: nobody has run any of these models with a harness on a Mac
 * yet. Until a row has an entry, the recommendation never says "Recommended".
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
  })
  .strict();

const LocalModelEntrySchema = z
  .object({
    id: z.string().max(100).regex(LOCAL_MODEL_ID_PATTERN, 'must be name:tag in lowercase, without a slash'),
    label: z.string().min(1).max(80),
    license: z.string().min(1).max(40),
    paramsB: z.number().positive(),
    bytes: positiveInt,
    kvBytesPerToken: positiveInt,
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

const PromptCacheTierSchema = z
  .object({
    minMemGb: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
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
    promptCacheTiers: z.array(PromptCacheTierSchema).min(1),
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

    // The tiers are read as "the last one whose minimum is not above this Mac's memory", so they
    // must start at 0 (every Mac has a tier) and ascend.
    if (catalog.promptCacheTiers[0].minMemGb !== 0) {
      issue(['promptCacheTiers', 0, 'minMemGb'], 'the first prompt cache tier must start at 0');
    }
    for (let i = 1; i < catalog.promptCacheTiers.length; i++) {
      if (catalog.promptCacheTiers[i].minMemGb <= catalog.promptCacheTiers[i - 1].minMemGb) {
        issue(['promptCacheTiers', i, 'minMemGb'], 'prompt cache tiers must ascend by minMemGb');
        break;
      }
    }
  });

const KIB = 1024;
const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

/**
 * The catalogue that ships with Codeman. Never read directly outside this file and its test:
 * callers use `getLocalModelCatalog()`, which validates it first.
 */
export const STOCK_LOCAL_MODEL_CATALOG: LocalModelCatalog = {
  schema: 1,
  updated: '2026-11-06',
  // The oldest macOS the model runtime supports.
  minMacosMajor: 14,
  // Host memory the runtime's prompt cache may take beside the model: 512 MiB on a Mac below
  // 32 GB, 2 GiB from 32 GB. Part of the need of every candidate.
  promptCacheTiers: [
    { minMemGb: 0, bytes: 512 * MIB },
    { minMemGb: 32, bytes: 2 * GIB },
  ],
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
      kvBytesPerToken: 32 * KIB,
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
      kvBytesPerToken: 32 * KIB,
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
      kvBytesPerToken: 24 * KIB,
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
      bytes: 22_621_314_161,
      kvBytesPerToken: 20 * KIB,
      contexts: [131072, 65536],
      rank: 4,
      // 54.5 tokens per second measured on 400 GB/s (3 billion parameters are active per token).
      speedPer100Gbps: 13.6,
      tested: [],
    },
    {
      id: 'qwen3.8:27b',
      label: 'Qwen3.8 27B',
      license: 'Apache-2.0',
      paramsB: 27.8,
      bytes: 17_741_871_939,
      kvBytesPerToken: 64 * KIB,
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
      kvBytesPerToken: 64 * KIB,
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
      kvBytesPerToken: 24 * KIB,
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
