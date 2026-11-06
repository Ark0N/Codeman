/**
 * @fileoverview The recommendation itself: which model, at which context, with which harness
 * fits this Mac. Pure: no IO, no clock, no CLI registry, no data dir.
 *
 * The math, in the order it runs:
 *  - `deviceBudget()`: L is the wired limit when it is above 0, else 2/3 of memory below 36 GB
 *    and 3/4 from 36 GB. B = min(L - 1 GiB, memory - reserve), with a reserve of 6 GiB up to
 *    18 GB, 8 GiB up to 48 GB and 12 GiB above.
 *  - `needBytes()`: F = weights + kvBytesPerToken * ctx + 1 GiB + the prompt cache tier of the
 *    catalogue for this Mac's memory.
 *  - Fit: F/B up to 0.85 is good, up to 0.98 is tight, above is out.
 *  - Speed: tokens per second = the model's `speedPer100Gbps` x the chip's bandwidth / 100.
 *    Below 10 is slow. A chip that is in no chips row, or a model without a speed figure, is
 *    UNKNOWN: a bandwidth is never guessed.
 *  - Candidates: (model, context, harness) with `ctx >= harness.minContext`, the harness not
 *    gated, installed or installable, and accepting the model id.
 *  - Ranking, lexicographic: good before tight; ok before unknown before slow; the higher model
 *    rank; the higher harness rank; the larger context. The pick is the first candidate, the
 *    alternatives are the next four MODELS, each at its own best context and harness.
 *
 * Verdict `none`, in this order (the first that applies is the reason):
 *  1. `not-macos`: the server does not run on macOS.
 *  2. `intel`: a Mac without Apple silicon.
 *  3. `macos`: macOS is older than the catalogue's minimum (an unknown version does not block).
 *  4. `memory`: no model fits the budget at any of its contexts, whatever the harness.
 *  5. `no-harness`: no harness row is usable (not gated, known to the caller, installed or
 *     installable).
 *  6. `memory`: models fit, but none at a context a usable harness needs.
 *  7. `no-harness`: models fit at such a context, but no usable harness accepts their id.
 *  8. `disk`: for every remaining model, free disk minus the download is below 10 GiB (an
 *     unknown free disk does not block).
 *
 * Rules:
 *  - Verdict `limited` when the pick's model has fewer than 12 billion parameters.
 *  - The word "Recommended" (`LOCAL_MODEL_LABELS.headlineTested`) only for verdict `ok` with a
 *    pick whose model has a `tested` entry for exactly this chip, this memory size and this
 *    harness. Otherwise `headlineOk` (or `headlineLimited`) plus `noteUntested`.
 *  - Every label in the result comes from `LOCAL_MODEL_LABELS`, every size text from
 *    `formatGb()`. No number is spliced into a sentence here.
 *  - No CLI id is ever compared with a literal: a harness is a catalogue row plus a
 *    `HarnessFact`.
 */

import {
  LOCAL_MODEL_LABELS,
  LOCAL_MODEL_NONE_LABELS,
  type Candidate,
  type DeviceBudget,
  type FitGrade,
  type HardwareFacts,
  type HarnessFact,
  type LocalHarnessEntry,
  type LocalModelCatalog,
  type LocalModelEntry,
  type NoneReason,
  type Recommendation,
  type SpeedGrade,
} from '../types.js';
import { chipBandwidthGbps } from '../config/local-model-catalog.js';
import { formatGb, GIB, MIB } from './format.js';

/** Need over budget up to this share is a `good` fit. */
export const FIT_GOOD_MAX_SHARE = 0.85;
/** Need over budget up to this share is a `tight` fit; above it the model is out. */
export const FIT_TIGHT_MAX_SHARE = 0.98;
/** An estimated speed below this many tokens per second is `slow`. */
export const SLOW_BELOW_TOKENS_PER_SECOND = 10;
/** A pick whose model has fewer than this many billion parameters makes the verdict `limited`. */
export const LIMITED_BELOW_PARAMS_B = 12;
/** What must stay free on the disk after the model download. */
export const DISK_HEADROOM_BYTES = 10 * GIB;
/** What the runtime needs beside the weights, the KV cache and the prompt cache (compute buffers). */
export const RUNTIME_OVERHEAD_BYTES = GIB;
/** How many other models are listed under the pick. */
export const MAX_ALTERNATIVES = 4;

/** A memory size of at least this many GB (as sold) gets 3/4 of its memory as device limit, below it 2/3. */
const LARGE_LIMIT_FROM_GB = 36;

/** The memory the system, Codeman, a browser and the agent keep for themselves, by the size the Mac is sold as. */
function reserveBytes(memClassGb: number): number {
  if (memClassGb <= 18) return 6 * GIB;
  if (memClassGb <= 48) return 8 * GIB;
  return 12 * GIB;
}

/** The memory a model may use on this Mac: the device limit L, the budget B and where L came from. */
export function deviceBudget(hw: HardwareFacts): DeviceBudget {
  const memBytes = Number.isFinite(hw.memBytes) && hw.memBytes > 0 ? hw.memBytes : 0;
  // 0 means "not set" (both test Macs report 0): only a value above 0 is a limit.
  const wired = hw.wiredLimitMb !== undefined && Number.isFinite(hw.wiredLimitMb) && hw.wiredLimitMb > 0;
  const limitBytes = wired
    ? Math.floor((hw.wiredLimitMb as number) * MIB)
    : Math.floor(memBytes * (hw.memClassGb < LARGE_LIMIT_FROM_GB ? 2 / 3 : 3 / 4));
  const budgetBytes = Math.max(0, Math.min(limitBytes - GIB, memBytes - reserveBytes(hw.memClassGb)));
  return { limitBytes, budgetBytes, source: wired ? 'wired-limit' : 'estimated' };
}

/** The prompt cache of the last tier whose minimum is not above this Mac's memory size. */
function promptCacheBytes(catalog: LocalModelCatalog, memClassGb: number): number {
  let bytes = 0;
  for (const tier of catalog.promptCacheTiers) {
    if (tier.minMemGb <= memClassGb) bytes = tier.bytes;
  }
  return bytes;
}

/** F: the bytes `model` needs in memory at a context of `ctx` tokens on this Mac. */
export function needBytes(model: LocalModelEntry, ctx: number, catalog: LocalModelCatalog, hw: HardwareFacts): number {
  return model.bytes + model.kvBytesPerToken * ctx + RUNTIME_OVERHEAD_BYTES + promptCacheBytes(catalog, hw.memClassGb);
}

function fitGrade(need: number, budgetBytes: number): FitGrade {
  if (budgetBytes <= 0) return 'out';
  const share = need / budgetBytes;
  if (share <= FIT_GOOD_MAX_SHARE) return 'good';
  if (share <= FIT_TIGHT_MAX_SHARE) return 'tight';
  return 'out';
}

/**
 * Whether the MACHINE is Apple silicon. `hw.optional.arm64` decides when it was read. Without
 * it: a process under Rosetta, an arm64 process or an Apple chip name each prove Apple silicon
 * (`arch` alone cannot say no, because Node under Rosetta reports x64).
 */
function isAppleSilicon(hw: HardwareFacts): boolean {
  if (hw.arm64 !== undefined) return hw.arm64;
  if (hw.translated === true || hw.arch === 'arm64') return true;
  return /^Apple\b/i.test(hw.chip ?? '');
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** A candidate plus the two ranks the ordering needs, which are not part of the payload. */
interface Ranked {
  candidate: Candidate;
  modelRank: number;
  harnessRank: number;
}

/** A catalogue harness row with the caller's fact about it. */
interface UsableHarness {
  row: LocalHarnessEntry;
  fact: HarnessFact;
}

const FIT_ORDER: Record<Candidate['fit'], number> = { good: 0, tight: 1 };
const SPEED_ORDER: Record<SpeedGrade, number> = { ok: 0, unknown: 1, slow: 2 };

/** Best first. */
function compareRanked(a: Ranked, b: Ranked): number {
  return (
    FIT_ORDER[a.candidate.fit] - FIT_ORDER[b.candidate.fit] ||
    SPEED_ORDER[a.candidate.speed] - SPEED_ORDER[b.candidate.speed] ||
    b.modelRank - a.modelRank ||
    b.harnessRank - a.harnessRank ||
    b.candidate.context - a.candidate.context
  );
}

/** A function supplied by the caller must not be able to break a pure answer. */
function accepts(fact: HarnessFact, modelId: string): boolean {
  try {
    return fact.acceptsModelId(modelId) === true;
  } catch {
    return false;
  }
}

function buildCandidate(
  model: LocalModelEntry,
  ctx: number,
  harness: UsableHarness,
  need: number,
  fit: Candidate['fit'],
  hw: HardwareFacts,
  catalog: LocalModelCatalog,
  budgetBytes: number
): Candidate {
  const gbps = chipBandwidthGbps(catalog.chips, hw.chip);
  const tokensPerSecond =
    gbps !== undefined && model.speedPer100Gbps !== undefined
      ? round((model.speedPer100Gbps * gbps) / 100, 1)
      : undefined;
  const speed: SpeedGrade =
    tokensPerSecond === undefined ? 'unknown' : tokensPerSecond < SLOW_BELOW_TOKENS_PER_SECOND ? 'slow' : 'ok';
  // "A Mac like this" is exact: the same chip string, the same memory size as sold, the same harness.
  const tested = model.tested.some(
    (entry) => entry.chip === hw.chip && entry.memGb === hw.memClassGb && entry.cli === harness.row.cli
  );
  return {
    modelId: model.id,
    modelLabel: model.label,
    license: model.license,
    paramsB: model.paramsB,
    context: ctx,
    cli: harness.row.cli,
    cliLabel: harness.fact.label,
    cliInstalled: harness.fact.installed,
    ...(harness.row.slowFirstTurn ? { slowFirstTurn: true } : {}),
    needBytes: need,
    needGb: formatGb(need),
    downloadBytes: model.bytes,
    downloadGb: formatGb(model.bytes),
    budgetShare: round(need / budgetBytes, 3),
    fit,
    fitLabel: fit === 'good' ? LOCAL_MODEL_LABELS.fitGood : LOCAL_MODEL_LABELS.fitTight,
    speed,
    ...(speed === 'slow' ? { speedLabel: LOCAL_MODEL_LABELS.speedSlow } : {}),
    ...(speed === 'unknown' ? { speedLabel: LOCAL_MODEL_LABELS.speedUnknown } : {}),
    ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
    tested,
  };
}

function none(reason: NoneReason, budget: DeviceBudget, vars?: Record<string, string>): Recommendation {
  return {
    verdict: 'none',
    reason,
    headline: { text: LOCAL_MODEL_NONE_LABELS[reason], ...(vars ? { vars } : {}) },
    notes: [],
    alternatives: [],
    budgetBytes: budget.budgetBytes,
    budgetGb: formatGb(budget.budgetBytes),
    budgetSource: budget.source,
  };
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
  // Off macOS and on an Intel Mac there is no budget to compute: a model has no memory to run in.
  const noBudget: DeviceBudget = { limitBytes: 0, budgetBytes: 0, source: 'estimated' };
  if (hw.platform !== 'darwin') return none('not-macos', noBudget);
  if (!isAppleSilicon(hw)) return none('intel', noBudget);

  const budget = deviceBudget(hw);
  if (hw.macosMajor !== undefined && hw.macosMajor < catalog.minMacosMajor) {
    return none('macos', budget, {
      version: hw.macosVersion ?? String(hw.macosMajor),
      minimum: String(catalog.minMacosMajor),
    });
  }

  // Every (model, context) that fits the budget, before any harness is looked at.
  const fitting: { model: LocalModelEntry; ctx: number; need: number; fit: Candidate['fit'] }[] = [];
  for (const model of catalog.models) {
    for (const ctx of model.contexts) {
      const need = needBytes(model, ctx, catalog, hw);
      const fit = fitGrade(need, budget.budgetBytes);
      if (fit !== 'out') fitting.push({ model, ctx, need, fit });
    }
  }
  const tooLittleMemory = (): Recommendation => none('memory', budget, { memory: hw.memGb });
  if (fitting.length === 0) return tooLittleMemory();

  // A gated row is never offered, whatever the caller knows about its CLI.
  const usable: UsableHarness[] = [];
  for (const row of catalog.harnesses) {
    if (row.gated) continue;
    const fact = harnessFacts.find((candidate) => candidate.cli === row.cli);
    if (fact && (fact.installed || fact.installable)) usable.push({ row, fact });
  }
  if (usable.length === 0) return none('no-harness', budget);

  const atHarnessContext = fitting.flatMap((entry) =>
    usable.filter((harness) => entry.ctx >= harness.row.minContext).map((harness) => ({ ...entry, harness }))
  );
  if (atHarnessContext.length === 0) return tooLittleMemory();

  const accepted = atHarnessContext.filter((entry) => accepts(entry.harness.fact, entry.model.id));
  if (accepted.length === 0) return none('no-harness', budget);

  // The download must leave headroom on the disk. An unknown free disk does not block.
  const free = hw.freeDiskBytes;
  const downloadable =
    free === undefined ? accepted : accepted.filter((entry) => free - entry.model.bytes >= DISK_HEADROOM_BYTES);
  if (free !== undefined && downloadable.length === 0) {
    const smallest = Math.min(...accepted.map((entry) => entry.model.bytes));
    return none('disk', budget, {
      download: formatGb(smallest),
      free: hw.freeDiskGb ?? formatGb(free),
      missing: formatGb(smallest + DISK_HEADROOM_BYTES - free),
    });
  }

  const ranked: Ranked[] = downloadable
    .map((entry) => ({
      candidate: buildCandidate(
        entry.model,
        entry.ctx,
        entry.harness,
        entry.need,
        entry.fit,
        hw,
        catalog,
        budget.budgetBytes
      ),
      modelRank: entry.model.rank,
      harnessRank: entry.harness.row.rank,
    }))
    .sort(compareRanked);

  // The first candidate of each model is that model at its best context and harness.
  const bestPerModel: Candidate[] = [];
  for (const { candidate } of ranked) {
    if (!bestPerModel.some((kept) => kept.modelId === candidate.modelId)) bestPerModel.push(candidate);
  }
  const [pick, ...others] = bestPerModel;

  const limited = pick.paramsB < LIMITED_BELOW_PARAMS_B;
  const headline = limited
    ? LOCAL_MODEL_LABELS.headlineLimited
    : pick.tested
      ? LOCAL_MODEL_LABELS.headlineTested
      : LOCAL_MODEL_LABELS.headlineOk;
  return {
    verdict: limited ? 'limited' : 'ok',
    headline: { text: headline },
    notes: pick.tested ? [] : [{ text: LOCAL_MODEL_LABELS.noteUntested }],
    pick,
    alternatives: others.slice(0, MAX_ALTERNATIVES),
    budgetBytes: budget.budgetBytes,
    budgetGb: formatGb(budget.budgetBytes),
    budgetSource: budget.source,
  };
}
