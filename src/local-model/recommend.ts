/**
 * @fileoverview The recommendation itself: which model, at which context, with which harness
 * fits this Mac. Pure: no IO, no clock, no CLI registry, no data dir.
 *
 * The math, in the order it runs:
 *  - `deviceBudget()`. ESTIMATED (all there is before the runtime ran): L is the wired limit
 *    when it is above 0, else 2/3 of memory below 36 GB and 3/4 from 36 GB, and
 *    B = min(L - 1 GiB, memory - reserve), with a reserve of 6 GiB up to 18 GB, 8 GiB up to
 *    48 GB and 12 GiB above. MEASURED (`RecommendOptions.measuredTotalBytes`, the device total
 *    the runtime printed when it started): L is that total and B = min(L, memory - reserve),
 *    without the 1 GiB, because the figure is already what the runtime will really use.
 *  - `needBytes()`: the PEAK, `bytes + heldBytesPerToken * ctx + overheadBytes +
 *    peakExtraBytes` of the catalogue row: the weights, what stays held per token of context,
 *    what the runner holds beside both, and what it takes for a moment while a long prompt is
 *    processed. Measured for one model on one Mac; every other row's figures are computed from
 *    its own model's architecture for its runner and say `estimated` (see the catalogue
 *    header, MEMORY).
 *  - Fit: need over budget up to 0.85 is good, up to 0.98 is tight, above is out. The grade
 *    decides whether a model is offered at all and what its row says. It does NOT sort: the
 *    need is the worst moment at the full context, so a tight fit is a model that runs, and a
 *    Mac whose best model is tight should be offered that model, not a smaller one.
 *  - Speed: a candidate that matches a `tested` entry with a measured speed reports that
 *    speed. Every other one is estimated: the model's `speedPer100Gbps` x the chip's bandwidth
 *    / 100. Below 10 is slow, decided on the unrounded figure (9.96 is slow although it prints
 *    as 10). A chip that is in no chips row, or a model without a speed figure, is UNKNOWN: a
 *    bandwidth is never guessed.
 *  - Candidates: (model, context, harness) with `ctx >= harness.minContext`, the harness not
 *    gated, installed or installable, and accepting the model id.
 *  - Ranking, lexicographic: tested on a Mac like this before not tested (a measurement beats
 *    a formula); ok before unknown before slow; the higher model rank; the higher harness
 *    rank; the larger context. The pick is the first candidate, the alternatives are EVERY
 *    other model that fits (`MAX_ALTERNATIVES` is above what the catalogue holds), each at its
 *    own best context and harness, so a model is always offered at the largest context it
 *    fits at.
 *  - Disk: a model whose download would leave less than 10 GiB free is not offered. It is not
 *    dropped in silence: the best-ranked model left out that way is named in `noteDiskDropped`
 *    with what is missing.
 *
 * Verdict `none`, in this order (the first that applies is the reason):
 *  1. `not-macos`: the server does not run on macOS.
 *  2. `intel`: a Mac without Apple silicon.
 *  3. `macos`: macOS is older than the catalogue's minimum (an unknown version does not block).
 *  4. `memory`: no model fits the budget at any of its contexts, whatever the harness
 *     (`noneMemory`, or `noneMemoryUnknown` when the memory size could not be read).
 *  5. `no-harness`: no harness row is usable (not gated, known to the caller, installed or
 *     installable).
 *  6. `memory`: models fit, but none at a context a usable harness needs. Its own sentence
 *     (`noneMemoryContext`) with the budget and the smallest need at such a context, because
 *     "too little memory" would hide that a model does fit at a smaller context and that the
 *     answer rests on estimates.
 *  7. `no-harness`: models fit at such a context, but no usable harness accepts their id.
 *  8. `disk`: for every remaining model, free disk minus the download is below 10 GiB (an
 *     unknown free disk does not block).
 *
 * Rules:
 *  - Verdict `limited` when NO model with 12 billion parameters or more fits this Mac's memory
 *    at a context a usable harness works at. It is a statement about the Mac ("This Mac can run
 *    a small model"), so it is judged on everything that fits, BEFORE the disk filter and
 *    whatever the pick is: a 36 GB Mac whose pick is a 9B model while a 20B is listed under it
 *    is not a small-model Mac, and a 48 GB Mac does not become one because its disk is full. A
 *    small pick under verdict `ok` carries `noteSmallPick` instead.
 *  - The word "Recommended" (`LOCAL_MODEL_LABELS.headlineTested`) only for verdict `ok` with a
 *    pick whose model has a `tested` entry for exactly this chip, this memory size and this
 *    harness. Otherwise `headlineOk` (or `headlineLimited`) plus `noteUntested`.
 *  - Every row carries what the chooser needs and nothing the browser must work out: its one
 *    tag (`tagFor()`), every harness it can run with (`Candidate.harnesses`, the flat harness
 *    fields first), and the whole download of an install (`installBytes`: the model plus
 *    `RecommendOptions.runtimeDownloadBytes`).
 *  - Every label in the result comes from `LOCAL_MODEL_LABELS` or `LOCAL_MODEL_TAG_LABELS`,
 *    every computed size text from `formatGb()`. The one size that is not decimal GB is the
 *    installed memory in `noneMemory`: `HardwareFacts.memClassGb`, the size the Mac is sold
 *    as. No number is spliced into a sentence here.
 *  - No CLI id is ever compared with a literal: a harness is a catalogue row plus a
 *    `HarnessFact`.
 */

import {
  LOCAL_MODEL_LABELS,
  LOCAL_MODEL_NONE_LABELS,
  LOCAL_MODEL_TAG_LABELS,
  type Candidate,
  type CandidateHarness,
  type CandidateTag,
  type CandidateTagKind,
  type DeviceBudget,
  type FitGrade,
  type HardwareFacts,
  type HarnessFact,
  type LocalHarnessEntry,
  type LocalModelCatalog,
  type LocalModelEntry,
  type LocalModelLabel,
  type LocalModelMessage,
  type NoneReason,
  type Recommendation,
  type RecommendOptions,
  type SpeedGrade,
  type TestedOn,
} from '../types.js';
import { chipBandwidthGbps } from '../config/local-model-catalog.js';
import { formatGb, GIB, MIB } from './format.js';

/** Need over budget up to this share is a `good` fit. */
export const FIT_GOOD_MAX_SHARE = 0.85;
/** Need over budget up to this share is a `tight` fit; above it the model is out. */
export const FIT_TIGHT_MAX_SHARE = 0.98;
/** A speed below this many tokens per second is `slow`. */
export const SLOW_BELOW_TOKENS_PER_SECOND = 10;
/** When no model that fits has at least this many billion parameters, the verdict is `limited`. A pick below it is a "small model". */
export const LIMITED_BELOW_PARAMS_B = 12;
/** What must stay free on the disk after the model download. */
export const DISK_HEADROOM_BYTES = 10 * GIB;
/**
 * How many other models are listed under the pick, at most. Above what the stock catalogue
 * holds (10 models: 9 beside the pick), so a Mac is shown every model that fits it and the
 * install accepts every one of them. Still a bound: test/local-model-catalog.test.ts fails for
 * a catalogue that outgrows it, so nothing drops out of the list unseen.
 */
export const MAX_ALTERNATIVES = 11;

/** A memory size of at least this many GB (as sold) gets 3/4 of its memory as device limit, below it 2/3. */
const LARGE_LIMIT_FROM_GB = 36;

/** The memory the system, Codeman, a browser and the agent keep for themselves, by the size the Mac is sold as. */
function reserveBytes(memClassGb: number): number {
  if (memClassGb <= 18) return 6 * GIB;
  if (memClassGb <= 48) return 8 * GIB;
  return 12 * GIB;
}

/** A byte count a caller supplied, when it is one: finite and above 0. */
function positiveBytes(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

/**
 * The memory a model may use on this Mac: the device limit L, the budget B and where L came
 * from. With `options.measuredTotalBytes` the limit is what the runtime itself reported and
 * the 1 GiB the estimate keeps back is not subtracted; the reserve bounds both.
 */
export function deviceBudget(hw: HardwareFacts, options: RecommendOptions = {}): DeviceBudget {
  const memBytes = Number.isFinite(hw.memBytes) && hw.memBytes > 0 ? hw.memBytes : 0;
  const afterReserve = memBytes - reserveBytes(hw.memClassGb);
  const measured = positiveBytes(options.measuredTotalBytes);
  if (measured !== undefined) {
    return { limitBytes: measured, budgetBytes: Math.max(0, Math.min(measured, afterReserve)), source: 'measured' };
  }
  // 0 means "not set" (both test Macs report 0): only a value above 0 is a limit.
  const wired = hw.wiredLimitMb !== undefined && Number.isFinite(hw.wiredLimitMb) && hw.wiredLimitMb > 0;
  const limitBytes = wired
    ? Math.floor((hw.wiredLimitMb as number) * MIB)
    : Math.floor(memBytes * (hw.memClassGb < LARGE_LIMIT_FROM_GB ? 2 / 3 : 3 / 4));
  const budgetBytes = Math.max(0, Math.min(limitBytes - GIB, afterReserve));
  return { limitBytes, budgetBytes, source: wired ? 'wired-limit' : 'estimated' };
}

/**
 * The bytes `model` needs in memory at a context of `ctx` tokens, at its PEAK: the weights,
 * what stays held for the context, what the runner holds beside them, and what it takes for a
 * moment while a long prompt is processed. It does not depend on the Mac.
 */
export function needBytes(model: LocalModelEntry, ctx: number): number {
  return model.bytes + model.heldBytesPerToken * ctx + model.overheadBytes + model.peakExtraBytes;
}

function fitGrade(need: number, budgetBytes: number): FitGrade {
  if (budgetBytes <= 0) return 'out';
  const share = need / budgetBytes;
  if (share <= FIT_GOOD_MAX_SHARE) return 'good';
  if (share <= FIT_TIGHT_MAX_SHARE) return 'tight';
  return 'out';
}

/**
 * Whether the catalogue model `modelId` at `context` tokens fits this Mac's budget (a `good`
 * or a `tight` fit). The install job asks this right after the runtime started, with the
 * budget the runtime measured (`options.measuredTotalBytes`), BEFORE it downloads the model: a
 * `false` ends the job with `does-not-fit`. It is the same judgement `recommend()` makes for a
 * candidate, without the ranking, so a model that fits is never ruled out for being listed
 * sixth. False for a model the catalogue does not have.
 */
export function modelFitsBudget(
  hw: HardwareFacts,
  catalog: LocalModelCatalog,
  modelId: string,
  context: number,
  options: RecommendOptions = {}
): boolean {
  const model = catalog.models.find((entry) => entry.id === modelId);
  if (!model || !Number.isFinite(context) || context <= 0) return false;
  return fitGrade(needBytes(model, context), deviceBudget(hw, options).budgetBytes) !== 'out';
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

/** A candidate plus its catalogue row and the two ranks the ordering needs, none of which is part of the payload. */
interface Ranked {
  candidate: Candidate;
  model: LocalModelEntry;
  modelRank: number;
  harnessRank: number;
}

/** A catalogue harness row with the caller's fact about it. */
interface UsableHarness {
  row: LocalHarnessEntry;
  fact: HarnessFact;
}

const SPEED_ORDER: Record<SpeedGrade, number> = { ok: 0, unknown: 1, slow: 2 };

/** Best first. The fit grade is not a key: every candidate here fits, see the file header. */
function compareRanked(a: Ranked, b: Ranked): number {
  return (
    Number(b.candidate.tested) - Number(a.candidate.tested) ||
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

/** What the chooser's "Runs with" select needs to know about one harness. */
function candidateHarness(harness: UsableHarness): CandidateHarness {
  const { row, fact } = harness;
  return {
    cli: row.cli,
    cliLabel: fact.label,
    installed: fact.installed,
    // Only a harness that still has to be installed has a command to show.
    ...(!fact.installed && fact.installCommand ? { installCommand: fact.installCommand } : {}),
    ...(row.slowFirstTurn ? { slowFirstTurn: true } : {}),
  };
}

/**
 * The entry that makes this model "tested on a Mac like this": exactly the same chip string,
 * the same memory size as sold, the same harness.
 */
function testedEntry(model: LocalModelEntry, hw: HardwareFacts, cli: string): TestedOn | undefined {
  return model.tested.find((entry) => entry.chip === hw.chip && entry.memGb === hw.memClassGb && entry.cli === cli);
}

function buildCandidate(
  model: LocalModelEntry,
  ctx: number,
  harness: UsableHarness,
  /** Every usable harness that can run this model at this context, `harness` among them. */
  runsWith: readonly UsableHarness[],
  need: number,
  fit: Candidate['fit'],
  hw: HardwareFacts,
  catalog: LocalModelCatalog,
  budgetBytes: number,
  runtimeDownloadBytes: number
): Candidate {
  const testedOn = testedEntry(model, hw, harness.row.cli);
  const gbps = chipBandwidthGbps(catalog.chips, hw.chip);
  // A speed measured on a Mac like this one beats the estimate from the chip's bandwidth.
  const rawSpeed =
    testedOn?.tokensPerSecond ??
    (gbps !== undefined && model.speedPer100Gbps !== undefined ? (model.speedPer100Gbps * gbps) / 100 : undefined);
  // Graded on the unrounded figure: 9.96 rounds to 10.0 for the payload and is still slow.
  const speed: SpeedGrade =
    rawSpeed === undefined ? 'unknown' : rawSpeed < SLOW_BELOW_TOKENS_PER_SECOND ? 'slow' : 'ok';
  const tokensPerSecond = rawSpeed === undefined ? undefined : round(rawSpeed, 1);
  // The harness of the flat fields first, then the others, best first.
  const others = runsWith.filter((other) => other !== harness).sort((a, b) => b.row.rank - a.row.rank);
  const installBytes = model.bytes + runtimeDownloadBytes;
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
    memory: {
      modelBytes: model.bytes + model.overheadBytes,
      contextBytes: model.heldBytesPerToken * ctx,
      peakBytes: model.peakExtraBytes,
    },
    downloadBytes: model.bytes,
    downloadGb: formatGb(model.bytes),
    budgetShare: round(need / budgetBytes, 3),
    fit,
    fitLabel: fit === 'good' ? LOCAL_MODEL_LABELS.fitGood : LOCAL_MODEL_LABELS.fitTight,
    speed,
    ...(speed === 'slow' ? { speedLabel: LOCAL_MODEL_LABELS.speedSlow } : {}),
    ...(speed === 'unknown' ? { speedLabel: LOCAL_MODEL_LABELS.speedUnknown } : {}),
    ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
    tested: testedOn !== undefined,
    needSource: model.figures,
    harnesses: [harness, ...others].map(candidateHarness),
    installBytes,
    installGb: formatGb(installBytes),
  };
}

/**
 * The one tag of a row: the first kind that applies, in the order tested, the pick (which
 * says so when it only just fits), tight, slow, small. `undefined` when none does.
 */
function tagFor(candidate: Candidate, isPick: boolean): CandidateTag | undefined {
  const kind: CandidateTagKind | undefined = candidate.tested
    ? 'tested'
    : isPick
      ? candidate.fit === 'tight'
        ? 'best-tight'
        : 'best'
      : candidate.fit === 'tight'
        ? 'tight'
        : candidate.speed === 'slow'
          ? 'slow'
          : candidate.paramsB < LIMITED_BELOW_PARAMS_B
            ? 'small'
            : undefined;
  return kind === undefined ? undefined : { kind, label: LOCAL_MODEL_TAG_LABELS[kind] };
}

/** `candidate` with its tag, when it has one. */
function withTag(candidate: Candidate, isPick: boolean): Candidate {
  const tag = tagFor(candidate, isPick);
  return tag ? { ...candidate, tag } : candidate;
}

/** A `none` answer. `text` replaces the reason's default sentence (the `memory` reason has three). */
function none(
  reason: NoneReason,
  budget: DeviceBudget,
  vars?: Record<string, string>,
  text: LocalModelLabel = LOCAL_MODEL_NONE_LABELS[reason]
): Recommendation {
  return {
    verdict: 'none',
    reason,
    headline: { text, ...(vars ? { vars } : {}) },
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
 *
 * `options` is what the caller knows beyond the probe: the budget the runtime measured (the
 * answer then says `budgetSource: 'measured'`), and the runtime download an install still
 * needs (it is added to every row's `installBytes`).
 */
export function recommend(
  hw: HardwareFacts,
  catalog: LocalModelCatalog,
  harnessFacts: readonly HarnessFact[],
  options: RecommendOptions = {}
): Recommendation {
  // Off macOS and on an Intel Mac there is no budget to compute: a model has no memory to run in.
  const noBudget: DeviceBudget = { limitBytes: 0, budgetBytes: 0, source: 'estimated' };
  if (hw.platform !== 'darwin') return none('not-macos', noBudget);
  if (!isAppleSilicon(hw)) return none('intel', noBudget);

  const budget = deviceBudget(hw, options);
  const runtimeDownloadBytes = positiveBytes(options.runtimeDownloadBytes) ?? 0;
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
      const need = needBytes(model, ctx);
      const fit = fitGrade(need, budget.budgetBytes);
      if (fit !== 'out') fitting.push({ model, ctx, need, fit });
    }
  }
  // Nothing fits at any context. The installed memory is named by the size the Mac is sold
  // as; a size that could not be read is not stated at all (never "0 GB of memory").
  const tooLittleMemory = (): Recommendation =>
    Number.isFinite(hw.memClassGb) && hw.memClassGb > 0
      ? none('memory', budget, { memory: String(hw.memClassGb) })
      : none('memory', budget, undefined, LOCAL_MODEL_LABELS.noneMemoryUnknown);
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
  if (atHarnessContext.length === 0) {
    // Models fit, but only below the context a harness needs. Say both numbers: the reader
    // sees how far apart they are, and that both are estimates.
    const smallestContext = Math.min(...usable.map((harness) => harness.row.minContext));
    let smallestNeed: number | undefined;
    for (const model of catalog.models) {
      for (const ctx of model.contexts) {
        if (ctx < smallestContext) continue;
        const need = needBytes(model, ctx);
        if (smallestNeed === undefined || need < smallestNeed) smallestNeed = need;
      }
    }
    if (smallestNeed === undefined) return tooLittleMemory();
    return none(
      'memory',
      budget,
      { budget: formatGb(budget.budgetBytes), need: formatGb(smallestNeed) },
      LOCAL_MODEL_LABELS.noneMemoryContext
    );
  }

  const accepted = atHarnessContext.filter((entry) => accepts(entry.harness.fact, entry.model.id));
  if (accepted.length === 0) return none('no-harness', budget);

  // The download must leave headroom on the disk. An unknown free disk does not block.
  const free = hw.freeDiskBytes;
  const hasRoom = (model: LocalModelEntry): boolean => free === undefined || free - model.bytes >= DISK_HEADROOM_BYTES;
  if (free !== undefined && !accepted.some((entry) => hasRoom(entry.model))) {
    const smallest = Math.min(...accepted.map((entry) => entry.model.bytes));
    // One number, the one that says what to do: what must be freed for the smallest model.
    return none('disk', budget, { missing: formatGb(smallest + DISK_HEADROOM_BYTES - free) });
  }

  // Everything that fits is ranked, the models without room on the disk included: the best of
  // those is named in a note, so a full disk never removes a model without a word.
  const ranked: Ranked[] = accepted
    .map((entry) => ({
      candidate: buildCandidate(
        entry.model,
        entry.ctx,
        entry.harness,
        accepted
          .filter((other) => other.model === entry.model && other.ctx === entry.ctx)
          .map((other) => other.harness),
        entry.need,
        entry.fit,
        hw,
        catalog,
        budget.budgetBytes,
        runtimeDownloadBytes
      ),
      model: entry.model,
      modelRank: entry.model.rank,
      harnessRank: entry.harness.row.rank,
    }))
    .sort(compareRanked);

  // The first candidate of each model is that model at its best context and harness.
  const bestPerModel: Ranked[] = [];
  for (const entry of ranked) {
    if (!bestPerModel.some((kept) => kept.model.id === entry.model.id)) bestPerModel.push(entry);
  }
  const offered = bestPerModel.filter((entry) => hasRoom(entry.model)).map((entry) => entry.candidate);
  const leftOutForDisk = bestPerModel.find((entry) => !hasRoom(entry.model));
  const pick = withTag(offered[0], true);
  const alternatives = offered.slice(1, 1 + MAX_ALTERNATIVES).map((candidate) => withTag(candidate, false));

  // About the Mac, not the pick, and judged before the disk filter (see the file header).
  const limited = !accepted.some((entry) => entry.model.paramsB >= LIMITED_BELOW_PARAMS_B);
  const headline = limited
    ? LOCAL_MODEL_LABELS.headlineLimited
    : pick.tested
      ? LOCAL_MODEL_LABELS.headlineTested
      : LOCAL_MODEL_LABELS.headlineOk;

  const notes: LocalModelMessage[] = [];
  // The limited headline already says it. Under `ok` a small pick must still be called small.
  if (!limited && pick.paramsB < LIMITED_BELOW_PARAMS_B) notes.push({ text: LOCAL_MODEL_LABELS.noteSmallPick });
  if (leftOutForDisk && free !== undefined) {
    notes.push({
      text: LOCAL_MODEL_LABELS.noteDiskDropped,
      vars: {
        model: leftOutForDisk.model.label,
        missing: formatGb(leftOutForDisk.model.bytes + DISK_HEADROOM_BYTES - free),
      },
    });
  }
  if (!pick.tested) notes.push({ text: LOCAL_MODEL_LABELS.noteUntested });

  return {
    verdict: limited ? 'limited' : 'ok',
    headline: { text: headline },
    notes,
    pick,
    alternatives,
    budgetBytes: budget.budgetBytes,
    budgetGb: formatGb(budget.budgetBytes),
    budgetSource: budget.source,
  };
}
