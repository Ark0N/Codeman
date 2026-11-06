/**
 * @fileoverview The local model catalogue: which models, harnesses and chips the recommendation
 * knows, as a compiled constant validated by a Zod schema.
 *
 * SKELETON: the schema below is the shape of the contract (it mirrors `LocalModelCatalog` in
 * src/types/local-model.ts) and the stock constant is EMPTY. Still to come here:
 *  - the model rows (ids and byte sizes from the registry manifests, `paramsB`, an empty
 *    `tested` array each; `flint:40b` stays out), the harness rows and the chips table;
 *  - the cross-row rules the schema cannot say field by field: unique model ids, unique harness
 *    `cli`s, `contexts` largest first, `chips` most specific first, `promptCacheTiers` ascending
 *    and starting at 0;
 *  - `getLocalModelCatalog()` parsing the constant once, on first use, never at import.
 *
 * Rules that hold from the start:
 *  - There is NO override file and no runtime download data in this stage: nothing here reads
 *    the data dir, and a data file can never decide what gets recommended.
 *  - A model id is `name:tag` in lowercase with no slash (`LOCAL_MODEL_ID_PATTERN`), so it can
 *    only ever name a model of the default registry and namespace.
 *  - A harness is a ROW (`{ cli, minContext, rank, gated?, slowFirstTurn? }`). The `cli` is a CLI
 *    registry id as data: no code may compare it with a literal. Whether that CLI exists and can
 *    take a custom model is checked against the registry at call time, in
 *    src/local-model/harness-facts.ts, never here.
 */

import { z } from 'zod';
import type { LocalModelCatalog } from '../types.js';

/** A model id: lowercase name, one colon, a tag. No slash, so no registry host or namespace can ride along. */
export const LOCAL_MODEL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/;

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

/** Validates a whole catalogue. Typed against `LocalModelCatalog`, so the two cannot drift apart. */
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
  .strict();

/**
 * The catalogue that ships with Codeman. EMPTY for now (no model, harness or chip rows), but
 * valid: with it `recommend()` can only answer verdict `none`.
 *
 * The two constants that are already decided are filled in: macOS 14 is the oldest version the
 * runtime supports, and the prompt cache is 512 MiB on a Mac below 32 GB and 2 GiB from 32 GB.
 */
export const STOCK_LOCAL_MODEL_CATALOG: LocalModelCatalog = {
  schema: 1,
  updated: '2026-11-06',
  minMacosMajor: 14,
  promptCacheTiers: [
    { minMemGb: 0, bytes: 512 * 1024 ** 2 },
    { minMemGb: 32, bytes: 2 * 1024 ** 3 },
  ],
  models: [],
  harnesses: [],
  chips: [],
};

/**
 * The catalogue in force. There is no override in this stage, so this is the stock constant;
 * callers go through this function anyway, so a later stage can change where it comes from
 * without touching them.
 */
export function getLocalModelCatalog(): LocalModelCatalog {
  return STOCK_LOCAL_MODEL_CATALOG;
}
