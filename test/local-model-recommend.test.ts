/**
 * @fileoverview Tests for src/local-model/recommend.ts: the pure function that turns "what this
 * Mac is" into "which local model fits it".
 *
 * Laid out like the module:
 *
 * 1. The budget (`deviceBudget`) for every memory size Apple sells from 8 to 128 GB, and the
 *    need of a model at a context (`needBytes`).
 * 2. The two REAL Macs of the project, from their captured `sysctl` output through the real
 *    parser: the MacBook Pro (M5 Pro, 48 GB) and the Mac mini (M4, 16 GB). Each test states the
 *    expected answer and why.
 * 3. Every reason for verdict `none`, one fixture per reason, and their order.
 * 4. The `limited` verdict (a statement about the Mac, not about the pick), the notes that say
 *    what the headline cannot (a small pick, a model left out for disk space), the three-state
 *    speed in the ranking, harness rows (a gated one is never chosen), the `tested` flag that
 *    alone may turn on the word "Recommended", and the shape of the answer (labels from the
 *    fixed list, sizes in one unit).
 *
 * The stock catalogue is used wherever the answer for a real Mac is at stake. Small synthetic
 * catalogues (validated by the real schema) isolate one rule of the ranking at a time.
 *
 * Port: N/A (pure functions; the two hardware fixtures go through `readHardware` with every
 * piece of IO injected).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  getLocalModelCatalog,
  LocalModelCatalogSchema,
  STOCK_LOCAL_MODEL_CATALOG,
} from '../src/config/local-model-catalog.js';
import { formatGb, GB, GIB, memClassGb, MIB } from '../src/local-model/format.js';
import { readHardware, resetHardwareCache } from '../src/local-model/hardware.js';
import {
  deviceBudget,
  DISK_HEADROOM_BYTES,
  FIT_GOOD_MAX_SHARE,
  FIT_TIGHT_MAX_SHARE,
  LIMITED_BELOW_PARAMS_B,
  MAX_ALTERNATIVES,
  needBytes,
  recommend,
  SLOW_BELOW_TOKENS_PER_SECOND,
} from '../src/local-model/recommend.js';
import {
  LOCAL_MODEL_LABELS,
  type Candidate,
  type HardwareFacts,
  type HarnessFact,
  type LocalHarnessEntry,
  type LocalModelCatalog,
  type LocalModelEntry,
  type Recommendation,
} from '../src/types.js';

// ---------- Fixtures ----------

/** The real probe output of the MacBook Pro (Mac17,13), captured 2026-11-06, extra lines included. */
const MACBOOK_SYSCTL = `hw.memsize: 51539607552
machdep.cpu.brand_string: Apple M5 Pro
hw.optional.arm64: 1
sysctl.proc_translated: 0
iogpu.wired_limit_mb: 0
kern.osproductversion: 27.2
hw.model: Mac17,13
hw.perflevel0.physicalcpu: 6
hw.perflevel1.physicalcpu: 12
exit=0
/dev/disk3s5   971094180 54383564 890926084     6%  542146 8909260840    0%   /System/Volumes/Data
`;

/** The real probe output of the Mac mini (Mac16,10), captured 2026-11-06, extra lines included. */
const MACMINI_SYSCTL = `hw.memsize: 17179869184
machdep.cpu.brand_string: Apple M4
hw.optional.arm64: 1
sysctl.proc_translated: 0
iogpu.wired_limit_mb: 0
kern.osproductversion: 27.2
hw.model: Mac16,10
hw.perflevel0.physicalcpu: 4
hw.perflevel1.physicalcpu: 6
exit=0
/dev/disk3s5   239362496 172954124  41752848    81% 2353838 417528480    1%   /System/Volumes/Data
`;

/** The hardware facts of a real Mac: its captured output through the real parser, no IO. */
async function realMac(sysctlOutput: string, freeDiskKb: number): Promise<HardwareFacts> {
  resetHardwareCache();
  return readHardware({
    platform: 'darwin',
    arch: 'arm64',
    runSysctl: async () => sysctlOutput,
    freeDiskBytes: async () => freeDiskKb * 1024,
    totalMemBytes: () => 0,
    cpuModel: () => undefined,
    now: () => 0,
  });
}

/** An Apple silicon Mac with `soldGb` of memory, healthy in every other respect. */
function mac(soldGb: number, chip: string, overrides: Partial<HardwareFacts> = {}): HardwareFacts {
  const memBytes = soldGb * GIB;
  return {
    platform: 'darwin',
    arch: 'arm64',
    arm64: true,
    translated: false,
    memBytes,
    memGb: formatGb(memBytes),
    memClassGb: memClassGb(memBytes),
    chip,
    model: 'Mac0,0',
    macosVersion: '27.2',
    macosMajor: 27,
    wiredLimitMb: 0,
    freeDiskBytes: 500 * GB,
    freeDiskGb: '500',
    source: 'sysctl',
    ...overrides,
  };
}

/** A copy of `facts` without the given fields (an absent field, not an `undefined` one). */
function without(facts: HardwareFacts, ...fields: (keyof HardwareFacts)[]): HardwareFacts {
  const copy: Record<string, unknown> = { ...facts };
  for (const field of fields) delete copy[field];
  return copy as unknown as HardwareFacts;
}

/** Display labels of the stock harnesses, as the CLI registry would supply them. Data, not a branch. */
const HARNESS_LABELS: Record<string, string> = { opencode: 'OpenCode', claude: 'Claude Code', pi: 'Pi' };

/** What the server knows about one harness: installed and accepting every model id, unless overridden. */
function fact(cli: string, overrides: Partial<HarnessFact> = {}): HarnessFact {
  return {
    cli,
    label: HARNESS_LABELS[cli] ?? cli,
    installed: true,
    installable: false,
    acceptsModelId: () => true,
    ...overrides,
  };
}

const STOCK = getLocalModelCatalog();

/** Every stock harness installed, the gated one included. */
const ALL_INSTALLED: HarnessFact[] = STOCK.harnesses.map((row) => fact(row.cli));

/** The stock catalogue with a change applied, validated by the real schema. */
function stockWith(change: (catalog: LocalModelCatalog) => void): LocalModelCatalog {
  const catalog = structuredClone(STOCK_LOCAL_MODEL_CATALOG);
  change(catalog);
  return LocalModelCatalogSchema.parse(catalog);
}

/** A model row for a synthetic catalogue: 20 billion parameters, 10 GiB, one small context. */
function model(id: string, overrides: Partial<LocalModelEntry> = {}): LocalModelEntry {
  return {
    id,
    label: id,
    license: 'Apache-2.0',
    paramsB: 20,
    bytes: 10 * GIB,
    kvBytesPerToken: 1,
    contexts: [1024],
    rank: 1,
    tested: [],
    ...overrides,
  };
}

/**
 * A synthetic catalogue: no prompt cache, one harness `alpha` that works from 1024 tokens, and
 * one chip row ('M4 Max' at 400 GB/s, so tokens per second = `speedPer100Gbps` x 4).
 */
function catalogOf(models: LocalModelEntry[], harnesses?: LocalHarnessEntry[]): LocalModelCatalog {
  return LocalModelCatalogSchema.parse({
    schema: 1,
    updated: '2026-11-06',
    minMacosMajor: 14,
    promptCacheTiers: [{ minMemGb: 0, bytes: 0 }],
    models,
    harnesses: harnesses ?? [{ cli: 'alpha', minContext: 1024, rank: 1 }],
    chips: [{ match: 'M4 Max', gbps: 400 }],
  });
}

/** A Mac whose budget is exactly 100 GiB: a wired limit of 101 GiB on a 128 GB machine. */
const HUNDRED_GIB_MAC = mac(128, 'Apple M4 Max', { wiredLimitMb: 101 * 1024 });
const HUNDRED_GIB = 100 * GIB;

/** What a synthetic model needs beside its weights at its 1024-token context: 1 GiB plus the KV cache. */
const SYNTHETIC_OVERHEAD = GIB + 1024;

/** A model whose need is exactly `need` bytes in a synthetic catalogue. */
function modelNeeding(id: string, need: number, overrides: Partial<LocalModelEntry> = {}): LocalModelEntry {
  return model(id, { bytes: need - SYNTHETIC_OVERHEAD, ...overrides });
}

/** `id@context` of the pick and of each alternative, in order. */
function order(result: Recommendation): string[] {
  return [result.pick, ...result.alternatives]
    .filter((candidate): candidate is Candidate => candidate !== undefined)
    .map((candidate) => `${candidate.modelId}@${candidate.context}`);
}

/** Every string anywhere in a value. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringsIn);
  return [];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

/** The Macs the sweeps run over: every memory size, with a slow, a fast and an unknown chip. */
const SWEEP: HardwareFacts[] = [8, 16, 18, 24, 32, 36, 48, 64, 96, 128].flatMap((soldGb) =>
  ['Apple M4', 'Apple M4 Max', 'Apple M5 Ultra', 'Apple M6'].map((chip) => mac(soldGb, chip))
);

beforeEach(() => {
  resetHardwareCache();
});

// ---------- 1. Budget and need ----------

describe('deviceBudget', () => {
  // Sold size, device limit L and budget B in GiB. L is 2/3 of memory below 36 GB and 3/4 from
  // 36 GB; B = min(L - 1, memory - reserve). Only at 8 GB is the reserve the smaller bound.
  const TIERS: [soldGb: number, limitGib: number, budgetGib: number][] = [
    [8, 16 / 3, 2],
    [16, 32 / 3, 29 / 3],
    [18, 12, 11],
    [24, 16, 15],
    [32, 64 / 3, 61 / 3],
    [36, 27, 26],
    [48, 36, 35],
    [64, 48, 47],
    [96, 72, 71],
    [128, 96, 95],
  ];

  it.each(TIERS)('gives a %i GB Mac a limit of %f GiB and a budget of %f GiB', (soldGb, limitGib, budgetGib) => {
    const budget = deviceBudget(mac(soldGb, 'Apple M4'));
    // Whole bytes: a third of a byte is rounded down.
    expect(Math.abs(budget.limitBytes - limitGib * GIB)).toBeLessThan(1);
    expect(Math.abs(budget.budgetBytes - budgetGib * GIB)).toBeLessThan(1);
    expect(Number.isInteger(budget.limitBytes)).toBe(true);
    expect(Number.isInteger(budget.budgetBytes)).toBe(true);
    expect(budget.source).toBe('estimated');
  });

  it('matches the rounded budgets of the design table', () => {
    const rounded = TIERS.map(([soldGb]) => [
      soldGb,
      (deviceBudget(mac(soldGb, 'Apple M4')).budgetBytes / GIB).toFixed(1),
    ]);
    expect(rounded).toEqual([
      [8, '2.0'],
      [16, '9.7'],
      [18, '11.0'],
      [24, '15.0'],
      [32, '20.3'],
      [36, '26.0'],
      [48, '35.0'],
      [64, '47.0'],
      [96, '71.0'],
      [128, '95.0'],
    ]);
  });

  it('keeps a reserve of 6 GiB up to 18 GB, 8 GiB up to 48 GB and 12 GiB from 64 GB', () => {
    // A wired limit far above the memory leaves "memory - reserve" as the only bound.
    const reserveOf = (soldGb: number): number => {
      const budget = deviceBudget(mac(soldGb, 'Apple M4', { wiredLimitMb: 1024 * 1024 }));
      return (soldGb * GIB - budget.budgetBytes) / GIB;
    };
    expect([8, 16, 18].map(reserveOf)).toEqual([6, 6, 6]);
    expect([24, 32, 36, 48].map(reserveOf)).toEqual([8, 8, 8, 8]);
    expect([64, 96, 128].map(reserveOf)).toEqual([12, 12, 12]);
  });

  it('uses the wired limit when it is above 0', () => {
    // 14000 MiB on the 16 GB Mac: L - 1 GiB is 12.67 GiB, memory - reserve is 10 GiB.
    expect(deviceBudget(mac(16, 'Apple M4', { wiredLimitMb: 14000 }))).toEqual({
      limitBytes: 14000 * MIB,
      budgetBytes: 10 * GIB,
      source: 'wired-limit',
    });
    // A limit BELOW the estimate is honoured too: 8192 MiB leaves 7 GiB.
    expect(deviceBudget(mac(16, 'Apple M4', { wiredLimitMb: 8192 }))).toEqual({
      limitBytes: 8 * GIB,
      budgetBytes: 7 * GIB,
      source: 'wired-limit',
    });
  });

  it('reads a wired limit of 0, or none at all, as "not set"', () => {
    const estimated = deviceBudget(mac(16, 'Apple M4'));
    expect(estimated.source).toBe('estimated');
    expect(deviceBudget(mac(16, 'Apple M4', { wiredLimitMb: 0 }))).toEqual(estimated);
    expect(deviceBudget(without(mac(16, 'Apple M4'), 'wiredLimitMb'))).toEqual(estimated);
  });

  it('never goes below 0', () => {
    expect(deviceBudget(mac(4, 'Apple M1')).budgetBytes).toBe(0);
    expect(deviceBudget(mac(16, 'Apple M4', { wiredLimitMb: 512 })).budgetBytes).toBe(0);
    expect(deviceBudget({ ...mac(16, 'Apple M4'), memBytes: 0, memClassGb: 0 })).toEqual({
      limitBytes: 0,
      budgetBytes: 0,
      source: 'estimated',
    });
  });
});

describe('needBytes', () => {
  const nineB = STOCK.models.find((m) => m.id === 'qwen3.5:9b') as LocalModelEntry;

  it('adds weights, the KV cache of the context, 1 GiB and the prompt cache', () => {
    // 6,550,825,373 + 32768 x 65536 + 1 GiB + 512 MiB on a Mac below 32 GB.
    expect(needBytes(nineB, 65536, STOCK, mac(16, 'Apple M4'))).toBe(6_550_825_373 + 2 * GIB + GIB + 512 * MIB);
    expect(needBytes(nineB, 65536, STOCK, mac(16, 'Apple M4'))).toBe(10_308_921_757);
    // Half the context, half the KV cache.
    expect(needBytes(nineB, 32768, STOCK, mac(16, 'Apple M4'))).toBe(6_550_825_373 + GIB + GIB + 512 * MIB);
  });

  it('counts a prompt cache of 512 MiB below 32 GB of memory and 2 GiB from 32 GB', () => {
    const base = 6_550_825_373 + 2 * GIB + GIB;
    for (const soldGb of [8, 16, 18, 24]) {
      expect(needBytes(nineB, 65536, STOCK, mac(soldGb, 'Apple M4')) - base, `${soldGb} GB`).toBe(512 * MIB);
    }
    for (const soldGb of [32, 36, 48, 64, 96, 128]) {
      expect(needBytes(nineB, 65536, STOCK, mac(soldGb, 'Apple M4')) - base, `${soldGb} GB`).toBe(2 * GIB);
    }
  });

  it('does not depend on the chip or the harness', () => {
    expect(needBytes(nineB, 65536, STOCK, mac(48, 'Apple M1'))).toBe(
      needBytes(nineB, 65536, STOCK, mac(48, 'Apple M5 Ultra'))
    );
  });
});

describe('the fit grade', () => {
  const pickOf = (need: number): Candidate | undefined =>
    recommend(HUNDRED_GIB_MAC, catalogOf([modelNeeding('probe:1', need)]), [fact('alpha')]).pick;

  it('has the budget this group assumes', () => {
    expect(deviceBudget(HUNDRED_GIB_MAC).budgetBytes).toBe(HUNDRED_GIB);
    expect(FIT_GOOD_MAX_SHARE).toBe(0.85);
    expect(FIT_TIGHT_MAX_SHARE).toBe(0.98);
  });

  it('is good up to 0.85 of the budget', () => {
    expect(pickOf(0.5 * HUNDRED_GIB)).toMatchObject({ fit: 'good', fitLabel: 'Good', budgetShare: 0.5 });
    expect(pickOf(0.85 * HUNDRED_GIB)).toMatchObject({ fit: 'good', budgetShare: 0.85 });
  });

  it('is tight above 0.85 and up to 0.98', () => {
    expect(pickOf(0.85 * HUNDRED_GIB + 1)).toMatchObject({ fit: 'tight', fitLabel: 'Tight' });
    expect(pickOf(0.9 * HUNDRED_GIB)).toMatchObject({ fit: 'tight', budgetShare: 0.9 });
    expect(pickOf(0.98 * HUNDRED_GIB)).toMatchObject({ fit: 'tight', budgetShare: 0.98 });
  });

  it('is out above 0.98: the model is not offered at all', () => {
    const result = recommend(HUNDRED_GIB_MAC, catalogOf([modelNeeding('probe:1', 0.98 * HUNDRED_GIB + 1)]), [
      fact('alpha'),
    ]);
    expect(result.verdict).toBe('none');
    expect(result.reason).toBe('memory');
    expect(result.pick).toBeUndefined();
  });
});

// ---------- 2. The two real Macs ----------

describe('the MacBook Pro (Mac17,13: Apple M5 Pro, 48 GB)', () => {
  /**
   * Expected: Qwen3.6 35B-A3B at 131,072 tokens with OpenCode, Good, about 42 tokens per second.
   *
   * Why. The budget is 35 GiB (3/4 of 48 GiB minus 1). Five models fit it as Good. The M5 Pro is
   * in the chips table (307 GB/s), so each model with a speed figure gets an estimate:
   * the dense 27B computes to 2.95 x 3.07 = 9.1 tokens per second, under the 10 that separate
   * slow from ok, while the 35B-A3B (3 billion parameters active per token) computes to 41.8.
   * Speed ranks before model rank, so the 35B-A3B wins although the 27B has the higher rank. The
   * 27B stays in the list, last, marked Slow. Both harnesses can run it; OpenCode has the
   * higher rank.
   */
  it('gets Qwen3.6 35B-A3B at 131072 tokens with OpenCode', async () => {
    const hw = await realMac(MACBOOK_SYSCTL, 890_926_084);
    expect(hw.chip).toBe('Apple M5 Pro');
    expect(hw.memClassGb).toBe(48);

    const result = recommend(hw, STOCK, ALL_INSTALLED);

    expect(result.verdict).toBe('ok');
    expect(result.reason).toBeUndefined();
    expect(result.budgetBytes).toBe(35 * GIB);
    expect(result.budgetGb).toBe('37.6');
    expect(result.budgetSource).toBe('estimated');
    expect(result.pick).toEqual({
      modelId: 'qwen3.6:35b-a3b',
      modelLabel: 'Qwen3.6 35B-A3B',
      license: 'Apache-2.0',
      paramsB: 35,
      context: 131072,
      cli: 'opencode',
      cliLabel: 'OpenCode',
      cliInstalled: true,
      // 22,621,314,161 + 20480 x 131072 + 1 GiB + 2 GiB.
      needBytes: 28_526_894_193,
      needGb: '28.5',
      downloadBytes: 22_621_314_161,
      downloadGb: '22.6',
      budgetShare: 0.759,
      fit: 'good',
      fitLabel: 'Good',
      speed: 'ok',
      tokensPerSecond: 41.8,
      tested: false,
    });
  });

  it('says "Best fit", not "Recommended", and that nobody tested it on such a Mac', async () => {
    const result = recommend(await realMac(MACBOOK_SYSCTL, 890_926_084), STOCK, ALL_INSTALLED);
    expect(result.headline).toEqual({ text: 'Best fit for this Mac' });
    expect(result.notes).toEqual([{ text: 'Not yet tested by us on a Mac like this.' }]);
    expect(stringsIn(result).join(' ')).not.toMatch(/recommended/i);
  });

  it('lists the other four models that fit: the fast ones, the one of unknown speed, the slow one', async () => {
    const result = recommend(await realMac(MACBOOK_SYSCTL, 890_926_084), STOCK, ALL_INSTALLED);
    expect(result.alternatives.map((c) => [c.modelId, c.context, c.fit, c.speed, c.tokensPerSecond ?? null])).toEqual([
      ['qwen3.5:9b-q8_0', 65536, 'good', 'ok', 17.8],
      ['qwen3.5:9b', 65536, 'good', 'ok', 28.6],
      ['gpt-oss:20b', 131072, 'good', 'unknown', null],
      ['qwen3.8:27b', 131072, 'good', 'slow', 9.1],
    ]);
    expect(result.alternatives[2].speedLabel).toBe('Speed unknown');
    expect(result.alternatives[3].speedLabel).toBe('Slow');
    // The two that do not fit 35 GiB at any context are not listed.
    expect(order(result)).not.toContain('qwen3.8:27b-q8_0@131072');
    expect(order(result).some((entry) => entry.startsWith('qwen3.5:122b'))).toBe(false);
  });

  it('would get the 27B instead if its chip were in no chips row', async () => {
    // The same Mac with the M5 Pro row removed: every speed is unknown, so model rank decides.
    const hw = await realMac(MACBOOK_SYSCTL, 890_926_084);
    const withoutChip = stockWith((catalog) => {
      catalog.chips = catalog.chips.filter((row) => row.match !== 'M5 Pro');
    });
    const result = recommend(hw, withoutChip, ALL_INSTALLED);
    expect(result.pick).toMatchObject({ modelId: 'qwen3.8:27b', context: 131072, speed: 'unknown' });
    expect(result.pick).not.toHaveProperty('tokensPerSecond');
  });
});

describe('the Mac mini (Mac16,10: Apple M4, 16 GB)', () => {
  /**
   * Expected: no recommendation, reason `memory`, in the sentence that names both numbers.
   *
   * Why. The budget is 9.67 GiB (2/3 of 16 GiB minus 1). The only model near it is the 9B. Both
   * harnesses that may be offered need 65,536 tokens of context, and there the 9B needs
   * 6.10 GiB of weights + 2 GiB of KV cache + 1 GiB + 0.5 GiB of prompt cache = 9.60 GiB, which
   * is 0.993 of the budget: above the 0.98 where "tight" ends. At 32,768 tokens it would fit
   * (0.890, tight), but the one harness that works at that context is gated.
   *
   * The miss is 1.3 points on an ESTIMATED budget, so the sentence is not "too little memory"
   * (what an 8 GB Mac is told): it says the budget (10.4 GB), the need (10.3 GB) and that
   * Codeman estimates.
   */
  it('gets no recommendation: nothing fits at the context a harness needs', async () => {
    const hw = await realMac(MACMINI_SYSCTL, 41_752_848);
    expect(hw.chip).toBe('Apple M4');
    expect(hw.memClassGb).toBe(16);

    const result = recommend(hw, STOCK, ALL_INSTALLED);

    expect(result).toEqual({
      verdict: 'none',
      reason: 'memory',
      headline: {
        text: 'Codeman estimates that this Mac can give a model about {budget} GB of memory. The smallest model a coding agent can work with needs about {need} GB. That leaves no safe margin, so Codeman recommends none here.',
        // floor(17,179,869,184 x 2/3) - 1 GiB, and the 9B at 65536 tokens: 10,308,921,757 bytes.
        vars: { budget: '10.4', need: '10.3' },
      },
      notes: [],
      alternatives: [],
      // floor(17,179,869,184 x 2/3) - 1 GiB.
      budgetBytes: 10_379_504_298,
      budgetGb: '10.4',
      budgetSource: 'estimated',
    });
  });

  it('misses by a hair at 65536 tokens and would fit at 32768', async () => {
    const hw = await realMac(MACMINI_SYSCTL, 41_752_848);
    const nineB = STOCK.models.find((m) => m.id === 'qwen3.5:9b') as LocalModelEntry;
    const budget = deviceBudget(hw).budgetBytes;
    const shareAt64k = needBytes(nineB, 65536, STOCK, hw) / budget;
    const shareAt32k = needBytes(nineB, 32768, STOCK, hw) / budget;
    expect(shareAt64k).toBeCloseTo(0.9932, 4);
    expect(shareAt64k).toBeGreaterThan(FIT_TIGHT_MAX_SHARE);
    expect(shareAt32k).toBeCloseTo(0.8898, 4);
    expect(shareAt32k).toBeLessThan(FIT_TIGHT_MAX_SHARE);
    // Every other model needs more than the whole budget at its smallest context.
    for (const other of STOCK.models.filter((m) => m.id !== 'qwen3.5:9b')) {
      const smallest = other.contexts[other.contexts.length - 1];
      expect(needBytes(other, smallest, STOCK, hw), other.id).toBeGreaterThan(budget);
    }
  });

  it('would get the 9B at 32768 tokens, as a limited answer, once the gated harness is opened', async () => {
    const hw = await realMac(MACMINI_SYSCTL, 41_752_848);
    const ungated = stockWith((catalog) => {
      catalog.harnesses = catalog.harnesses.map((row) => ({
        cli: row.cli,
        minContext: row.minContext,
        rank: row.rank,
      }));
    });
    const result = recommend(hw, ungated, ALL_INSTALLED);
    expect(result.verdict).toBe('limited');
    expect(result.pick).toMatchObject({
      modelId: 'qwen3.5:9b',
      context: 32768,
      cli: 'pi',
      fit: 'tight',
      budgetShare: 0.89,
      speed: 'ok',
      // 9.3 x 1.2.
      tokensPerSecond: 11.2,
    });
  });

  it('would get the 9B at 65536 tokens if a wired limit had been set on it', async () => {
    // iogpu.wired_limit_mb = 14000 lifts the budget to 10 GiB (memory minus the 6 GiB reserve).
    const hw = { ...(await realMac(MACMINI_SYSCTL, 41_752_848)), wiredLimitMb: 14000 };
    const result = recommend(hw, STOCK, ALL_INSTALLED);
    expect(result.verdict).toBe('limited');
    expect(result.budgetSource).toBe('wired-limit');
    expect(result.budgetBytes).toBe(10 * GIB);
    expect(result.pick).toMatchObject({ modelId: 'qwen3.5:9b', context: 65536, cli: 'opencode', fit: 'tight' });
  });
});

describe('every memory size, with the stock catalogue', () => {
  // What the rules compute today. A change of a catalogue figure or of a threshold that moves
  // one of these answers has to change this table on purpose.
  const EXPECTED: [soldGb: number, chip: string, answer: string][] = [
    [8, 'Apple M2', 'none memory'],
    [16, 'Apple M4', 'none memory'],
    // The 9B at 65536 tokens is 0.87 of 11 GiB.
    [18, 'Apple M3 Pro', 'limited qwen3.5:9b@65536 tight ok'],
    // gpt-oss:20b at 65536 tokens needs 15.8 GiB of the 15 GiB budget: out.
    [24, 'Apple M4', 'limited qwen3.5:9b@65536 good ok'],
    // gpt-oss:20b fits only as Tight here (0.853 at 65536 tokens, 0.927 at 131072), and Good
    // ranks before Tight. The Q8 9B is Good but slow on a base M4 (7 tokens per second). The
    // pick is a 9B, the verdict is `ok` all the same: a 20B fits this Mac.
    [32, 'Apple M4', 'ok qwen3.5:9b@65536 good ok'],
    [32, 'Apple M1 Max', 'ok qwen3.5:9b-q8_0@65536 good ok'],
    // The 27B (0.905) and the 35B-A3B (0.974) are Tight; gpt-oss:20b is Good but has no speed
    // figure, and a known speed ranks before an unknown one.
    [36, 'Apple M4 Max', 'ok qwen3.5:9b-q8_0@65536 good ok'],
    // On a Pro chip the dense 27B is slow (8.1 tokens per second), the 35B-A3B is not.
    [48, 'Apple M4 Pro', 'ok qwen3.6:35b-a3b@131072 good ok'],
    [48, 'Apple M4 Max', 'ok qwen3.8:27b@131072 good ok'],
    // The Q8 27B fits 47 GiB but computes to 7 tokens per second on this chip.
    [64, 'Apple M4 Max', 'ok qwen3.8:27b@131072 good ok'],
    [96, 'Apple M3 Ultra', 'ok qwen3.8:27b-q8_0@262144 good ok'],
    // The 122B fits 95 GiB only as Tight (0.861) and has no speed figure.
    [128, 'Apple M5 Ultra', 'ok qwen3.8:27b-q8_0@262144 good ok'],
  ];

  it.each(EXPECTED)('%i GB, %s: %s', (soldGb, chip, answer) => {
    const result = recommend(mac(soldGb, chip), STOCK, ALL_INSTALLED);
    const actual = result.pick
      ? `${result.verdict} ${result.pick.modelId}@${result.pick.context} ${result.pick.fit} ${result.pick.speed}`
      : `${result.verdict} ${result.reason}`;
    expect(actual).toBe(answer);
  });

  it('always pairs the pick with the top-ranked harness, OpenCode', () => {
    for (const hw of SWEEP) {
      const result = recommend(hw, STOCK, ALL_INSTALLED);
      if (result.pick) expect(result.pick.cli).toBe('opencode');
    }
  });
});

// ---------- 3. Verdict none ----------

describe('verdict none', () => {
  const bigMac = mac(48, 'Apple M4 Max');

  /** A `none` answer has no pick, no alternatives, no notes, and the reason's sentence as headline. */
  function expectNone(result: Recommendation, reason: Recommendation['reason'], headline: string): void {
    expect(result.verdict).toBe('none');
    expect(result.reason).toBe(reason);
    expect(result.headline.text).toBe(headline);
    expect(result.pick).toBeUndefined();
    expect(result.alternatives).toEqual([]);
    expect(result.notes).toEqual([]);
  }

  describe('not-macos', () => {
    it('answers so on Linux, with no budget at all', () => {
      const linux: HardwareFacts = {
        platform: 'linux',
        arch: 'x64',
        memBytes: 64 * GIB,
        memGb: formatGb(64 * GIB),
        memClassGb: 64,
        source: 'not-probed',
      };
      const result = recommend(linux, STOCK, ALL_INSTALLED);
      expectNone(result, 'not-macos', LOCAL_MODEL_LABELS.noneNotMacos);
      expect(result.headline.vars).toBeUndefined();
      expect(result.budgetBytes).toBe(0);
      expect(result.budgetGb).toBe('0.0');
      expect(result.budgetSource).toBe('estimated');
    });

    it('comes before every other reason', () => {
      for (const platform of ['linux', 'win32', 'freebsd']) {
        const hw = mac(8, 'Intel(R) Core(TM) i7', { platform, arch: 'x64', arm64: false, macosMajor: 12 });
        expect(recommend(hw, STOCK, []).reason, platform).toBe('not-macos');
      }
    });
  });

  describe('intel', () => {
    const intelChip = 'Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz';

    it('answers so for an Intel Mac, whose sysctl has no arm64 flag', () => {
      const hw = without(mac(32, intelChip, { arch: 'x64' }), 'arm64', 'translated', 'wiredLimitMb');
      const result = recommend(hw, STOCK, ALL_INSTALLED);
      expectNone(result, 'intel', 'This Mac has an Intel processor. Local coding models need Apple silicon.');
      expect(result.budgetBytes).toBe(0);
      expect(result.budgetGb).toBe('0.0');
    });

    it('answers so when the arm64 flag reads 0', () => {
      const hw = without(mac(32, intelChip, { arch: 'x64', arm64: false }), 'translated');
      expect(recommend(hw, STOCK, ALL_INSTALLED).reason).toBe('intel');
    });

    it('comes before the macOS version and the memory', () => {
      const hw = without(mac(8, intelChip, { arch: 'x64', macosMajor: 12, macosVersion: '12.7' }), 'arm64');
      expect(recommend(hw, STOCK, []).reason).toBe('intel');
    });

    it('does not mistake Node under Rosetta for an Intel Mac', () => {
      // An x64 process on Apple silicon: the machine flag says arm64, the process is translated.
      const rosetta = mac(48, 'Apple M4 Max', { arch: 'x64', translated: true });
      expect(recommend(rosetta, STOCK, ALL_INSTALLED).verdict).toBe('ok');
      // The same when only the translation flag was read.
      expect(recommend(without(rosetta, 'arm64'), STOCK, ALL_INSTALLED).verdict).toBe('ok');
    });

    it('decides from node:os alone when the probe failed', () => {
      const fallback = (arch: string, chip: string): HardwareFacts => ({
        platform: 'darwin',
        arch,
        memBytes: 48 * GIB,
        memGb: formatGb(48 * GIB),
        memClassGb: 48,
        chip,
        source: 'os-fallback',
      });
      // An arm64 process can only run on Apple silicon.
      expect(recommend(fallback('arm64', 'Apple M4 Max'), STOCK, ALL_INSTALLED).verdict).toBe('ok');
      // An x64 process with an Apple chip name is Rosetta.
      expect(recommend(fallback('x64', 'Apple M4 Max'), STOCK, ALL_INSTALLED).verdict).toBe('ok');
      // An x64 process with any other chip name is taken for an Intel Mac.
      expect(recommend(fallback('x64', intelChip), STOCK, ALL_INSTALLED).reason).toBe('intel');
      expect(recommend(without(fallback('x64', intelChip), 'chip'), STOCK, ALL_INSTALLED).reason).toBe('intel');
    });
  });

  describe('macos', () => {
    it('answers so below the catalogue minimum, naming both versions', () => {
      const result = recommend(
        mac(48, 'Apple M1 Max', { macosVersion: '13.6.7', macosMajor: 13 }),
        STOCK,
        ALL_INSTALLED
      );
      expectNone(result, 'macos', 'This Mac runs macOS {version}. Local models need macOS {minimum} or newer.');
      expect(result.headline.vars).toEqual({ version: '13.6.7', minimum: '14' });
      // The budget is still reported: the Mac itself is able.
      expect(result.budgetBytes).toBe(35 * GIB);
    });

    it('accepts the minimum itself and anything newer', () => {
      for (const macosMajor of [14, 15, 26, 27]) {
        const hw = mac(48, 'Apple M4 Max', { macosMajor, macosVersion: `${macosMajor}.0` });
        expect(recommend(hw, STOCK, ALL_INSTALLED).verdict, String(macosMajor)).toBe('ok');
      }
    });

    it('does not block on a version that could not be read', () => {
      const hw = without(mac(48, 'Apple M4 Max'), 'macosMajor', 'macosVersion');
      expect(recommend(hw, STOCK, ALL_INSTALLED).verdict).toBe('ok');
    });

    it('comes before the memory', () => {
      const hw = mac(8, 'Apple M1', { macosVersion: '12.7', macosMajor: 12 });
      expect(recommend(hw, STOCK, ALL_INSTALLED).reason).toBe('macos');
    });
  });

  describe('memory', () => {
    it('answers so at 8 GB, where nothing fits at any context', () => {
      const result = recommend(mac(8, 'Apple M2'), STOCK, ALL_INSTALLED);
      expectNone(
        result,
        'memory',
        'This Mac has {memory} GB of memory. That is too little to run a model that can drive a coding agent, so Codeman recommends none here.'
      );
      expect(result.headline.text).toBe(LOCAL_MODEL_LABELS.noneMemory);
      // The size the Mac is sold as (what About This Mac shows), not 8 x 2^30 bytes as 8.6 decimal GB.
      expect(result.headline.vars).toEqual({ memory: '8' });
      expect(result.budgetBytes).toBe(2 * GIB);
      // Every computed size stays decimal GB.
      expect(result.budgetGb).toBe('2.1');
    });

    it('names the installed memory as the Mac is sold, for every size', () => {
      // An empty catalogue: nothing fits whatever the size, so the sentence is the plain one.
      for (const soldGb of [8, 16, 18, 24, 32, 36, 48, 64, 96, 128]) {
        const result = recommend(mac(soldGb, 'Apple M4'), catalogOf([]), [fact('alpha')]);
        expect(result.headline, `${soldGb} GB`).toEqual({
          text: LOCAL_MODEL_LABELS.noneMemory,
          vars: { memory: String(soldGb) },
        });
      }
    });

    it('says both numbers when models fit, but only below the context a harness needs', () => {
      // The 16 GB case of the Mac mini, with harnesses that are all present.
      const result = recommend(mac(16, 'Apple M4'), STOCK, ALL_INSTALLED);
      expectNone(result, 'memory', LOCAL_MODEL_LABELS.noneMemoryContext);
      // The need is the smallest one at a context a usable harness works at (the 9B at 65536),
      // not the 9B at 32768, which fits and which only the gated harness could use.
      expect(result.headline.vars).toEqual({ budget: '10.4', need: '10.3' });
      expect(result.headline.text).toMatch(/^Codeman estimates/);
      expect(result.headline.text).not.toContain('{memory}');
    });

    it('says the same two numbers when the need is far above the budget', () => {
      // One model: 3 GiB at 1024 tokens (fits 10 GiB), 30 GiB at the context the harness needs.
      const catalog = catalogOf(
        [model('probe:1', { bytes: 2 * GIB, kvBytesPerToken: 1024, contexts: [28 * 1024 * 1024, 1024] })],
        [{ cli: 'alpha', minContext: 4096, rank: 1 }]
      );
      const hw = mac(16, 'Apple M4', { wiredLimitMb: 14000 });
      const result = recommend(hw, catalog, [fact('alpha')]);
      expectNone(result, 'memory', LOCAL_MODEL_LABELS.noneMemoryContext);
      // 2 GiB + 28 GiB of KV cache + 1 GiB = 31 GiB; the budget is 10 GiB.
      expect(result.headline.vars).toEqual({ budget: formatGb(10 * GIB), need: formatGb(31 * GIB) });
      expect(result.budgetSource).toBe('wired-limit');
    });

    it('falls back to the plain sentence when no model has a context a harness could use', () => {
      const catalog = catalogOf([model('probe:1')], [{ cli: 'alpha', minContext: 4096, rank: 1 }]);
      const result = recommend(bigMac, catalog, [fact('alpha')]);
      expectNone(result, 'memory', LOCAL_MODEL_LABELS.noneMemory);
      expect(result.headline.vars).toEqual({ memory: '48' });
    });

    it('comes before no-harness when nothing fits at all', () => {
      expect(recommend(mac(8, 'Apple M2'), STOCK, []).reason).toBe('memory');
    });

    it('answers so for an empty catalogue', () => {
      expect(recommend(bigMac, catalogOf([]), [fact('alpha')]).reason).toBe('memory');
    });

    it('answers so when the memory size is unknown, without stating a size', () => {
      const hw = { ...mac(48, 'Apple M4 Max'), memBytes: 0, memGb: '0.0', memClassGb: 0 };
      const result = recommend(hw, STOCK, ALL_INSTALLED);
      expectNone(
        result,
        'memory',
        'Codeman could not read how much memory this Mac has, so it recommends no model here.'
      );
      // No "0 GB of memory": a size that was never read is not a size.
      expect(result.headline.vars).toBeUndefined();
      expect(stringsIn(result.headline).join(' ')).not.toMatch(/\d/);
      expect(result.budgetBytes).toBe(0);
    });
  });

  describe('no-harness', () => {
    const headline = 'No coding agent that Codeman can connect to a local model is available on this Mac.';

    it('answers so when the caller knows no catalogue harness', () => {
      const result = recommend(bigMac, STOCK, []);
      expectNone(result, 'no-harness', headline);
      expect(result.headline.vars).toBeUndefined();
      expect(result.budgetBytes).toBe(35 * GIB);
    });

    it('answers so when no harness is installed or installable', () => {
      const facts = STOCK.harnesses.map((row) => fact(row.cli, { installed: false, installable: false }));
      expect(recommend(bigMac, STOCK, facts).reason).toBe('no-harness');
    });

    it('answers so when only the gated harness is on the machine', () => {
      const gatedRows = STOCK.harnesses.filter((row) => row.gated);
      expect(gatedRows).toHaveLength(1);
      expect(
        recommend(
          bigMac,
          STOCK,
          gatedRows.map((row) => fact(row.cli))
        ).reason
      ).toBe('no-harness');
    });

    it('answers so when a harness is there but accepts no model id', () => {
      const facts = ALL_INSTALLED.map((entry) => ({ ...entry, acceptsModelId: () => false }));
      expect(recommend(bigMac, STOCK, facts).reason).toBe('no-harness');
    });

    it('ignores a fact for a CLI that is not a catalogue harness', () => {
      expect(recommend(bigMac, STOCK, [fact('codex'), fact('some-other-cli')]).reason).toBe('no-harness');
    });
  });

  describe('disk', () => {
    it('answers so when every fitting model would leave under 10 GiB free', () => {
      // 12 GiB free: even the smallest download (6.55 GB) leaves 5.9 GiB.
      const hw = mac(48, 'Apple M4 Max', { freeDiskBytes: 12 * GIB, freeDiskGb: formatGb(12 * GIB) });
      const result = recommend(hw, STOCK, ALL_INSTALLED);
      expectNone(
        result,
        'disk',
        'Not enough free disk space. The smallest model that fits this Mac is a {download} GB download, and {reserve} GB must stay free after it. {free} GB is free now. Free up about {missing} GB.'
      );
      // download + 10 GiB - free = 6,550,825,373 + 10,737,418,240 - 12,884,901,888 bytes.
      expect(result.headline.vars).toEqual({ download: '6.6', reserve: '10.7', free: '12.9', missing: '4.4' });
      expect(result.budgetBytes).toBe(35 * GIB);
    });

    it('gives the reader every number of the sum: download + reserve - free = missing', () => {
      // 12 GB free is more than the 6.6 GB download, so without the reserve "not enough" reads false.
      const hw = mac(24, 'Apple M4', { freeDiskBytes: 12 * GB, freeDiskGb: formatGb(12 * GB) });
      const vars = recommend(hw, STOCK, ALL_INSTALLED).headline.vars as Record<string, string>;
      expect(vars).toEqual({ download: '6.6', reserve: '10.7', free: '12.0', missing: '5.3' });
      expect(vars.reserve).toBe(formatGb(DISK_HEADROOM_BYTES));
      // Within the rounding of four one-decimal figures.
      expect(Number(vars.download) + Number(vars.reserve) - Number(vars.free)).toBeCloseTo(Number(vars.missing), 0);
    });

    it('names the smallest model that fits the MEMORY, not the smallest of the catalogue', () => {
      // On a 48 GB Mac whose harness refuses both 9B ids, the smallest candidate is gpt-oss:20b.
      const facts = ALL_INSTALLED.map((entry) => ({
        ...entry,
        acceptsModelId: (id: string) => !id.startsWith('qwen3.5:9b'),
      }));
      const hw = mac(48, 'Apple M4 Max', { freeDiskBytes: 12 * GIB, freeDiskGb: formatGb(12 * GIB) });
      const result = recommend(hw, STOCK, facts);
      expect(result.reason).toBe('disk');
      expect(result.headline.vars?.download).toBe('13.8');
    });

    it('drops only the models that do not leave 10 GiB, picks among the rest, and says what was left out', () => {
      // 20 GiB free: the 9B downloads (6.1 and 9.7 GiB) leave 10 GiB or more, the others do not.
      const hw = mac(48, 'Apple M4 Max', { freeDiskBytes: 20 * GIB, freeDiskGb: formatGb(20 * GIB) });
      const result = recommend(hw, STOCK, ALL_INSTALLED);
      expect(order(result)).toEqual(['qwen3.5:9b-q8_0@65536', 'qwen3.5:9b@65536']);
      // A 48 GB Mac is not a small-model Mac because its disk is full: the verdict stays `ok`,
      // the pick is called small in a note, and the model it would have been is named with
      // what is missing: 17,741,871,939 + 10 GiB - 20 GiB = 7.0 GB.
      expect(result.verdict).toBe('ok');
      expect(result.headline).toEqual({ text: 'Best fit for this Mac' });
      expect(result.notes).toEqual([
        {
          text: 'The best fit is a small model. It handles small edits and questions. It does not replace a cloud model.',
        },
        {
          text: '{model} fits the memory of this Mac too, but its download needs about {missing} GB more free disk space.',
          vars: { model: 'Qwen3.8 27B', missing: '7.0' },
        },
        { text: 'Not yet tested by us on a Mac like this.' },
      ]);
    });

    it('turns on 0.4 GB of disk on the real MacBook without calling it a small-model Mac', async () => {
      // The cut for the 35B-A3B: 22,621,314,161 + 10 GiB = 33,358,732,401 bytes free.
      const macbook = await realMac(MACBOOK_SYSCTL, 890_926_084);
      const withFree = (bytes: number): HardwareFacts => ({
        ...macbook,
        freeDiskBytes: bytes,
        freeDiskGb: formatGb(bytes),
      });

      const enough = recommend(withFree(34 * GB), STOCK, ALL_INSTALLED);
      expect(enough.verdict).toBe('ok');
      expect(enough.pick?.modelId).toBe('qwen3.6:35b-a3b');
      expect(enough.notes).toEqual([{ text: LOCAL_MODEL_LABELS.noteUntested }]);

      const short = recommend(withFree(33 * GB), STOCK, ALL_INSTALLED);
      expect(short.verdict).toBe('ok');
      expect(short.headline.text).toBe(LOCAL_MODEL_LABELS.headlineOk);
      expect(short.pick?.modelId).toBe('qwen3.5:9b-q8_0');
      expect(order(short)).not.toContain('qwen3.6:35b-a3b@131072');
      expect(short.notes).toEqual([
        { text: LOCAL_MODEL_LABELS.noteSmallPick },
        { text: LOCAL_MODEL_LABELS.noteDiskDropped, vars: { model: 'Qwen3.6 35B-A3B', missing: '0.4' } },
        { text: LOCAL_MODEL_LABELS.noteUntested },
      ]);
      // The exact cut: one byte decides, and the note appears with the first missing byte.
      const cut = 22_621_314_161 + DISK_HEADROOM_BYTES;
      expect(recommend(withFree(cut), STOCK, ALL_INSTALLED).pick?.modelId).toBe('qwen3.6:35b-a3b');
      expect(recommend(withFree(cut - 1), STOCK, ALL_INSTALLED).pick?.modelId).toBe('qwen3.5:9b-q8_0');
    });

    it('names the best-ranked model left out, also when the pick is not affected', () => {
      // 64 GB, M4 Max, 35 GB free: only the Q8 27B (30 GB) has no room. The pick stays the 27B.
      const hw = mac(64, 'Apple M4 Max', { freeDiskBytes: 35 * GB, freeDiskGb: '35.0' });
      const result = recommend(hw, STOCK, ALL_INSTALLED);
      expect(result.pick?.modelId).toBe('qwen3.8:27b');
      expect(order(result).some((entry) => entry.startsWith('qwen3.8:27b-q8_0'))).toBe(false);
      // 29,978,241,837 + 10 GiB - 35 GB.
      expect(result.notes).toEqual([
        { text: LOCAL_MODEL_LABELS.noteDiskDropped, vars: { model: 'Qwen3.8 27B (Q8)', missing: '5.7' } },
        { text: LOCAL_MODEL_LABELS.noteUntested },
      ]);
    });

    it('adds no disk note when every model that fits has room, or the free disk is unknown', () => {
      for (const hw of [mac(64, 'Apple M4 Max'), without(mac(64, 'Apple M4 Max'), 'freeDiskBytes', 'freeDiskGb')]) {
        const texts = recommend(hw, STOCK, ALL_INSTALLED).notes.map((note) => note.text);
        expect(texts).not.toContain(LOCAL_MODEL_LABELS.noteDiskDropped);
      }
    });

    it('allows a download that leaves exactly 10 GiB', () => {
      const exact = STOCK.models[0].bytes + DISK_HEADROOM_BYTES;
      expect(DISK_HEADROOM_BYTES).toBe(10 * GIB);
      const fits = recommend(mac(24, 'Apple M4', { freeDiskBytes: exact }), STOCK, ALL_INSTALLED);
      expect(fits.pick?.modelId).toBe('qwen3.5:9b');
      const short = recommend(mac(24, 'Apple M4', { freeDiskBytes: exact - 1 }), STOCK, ALL_INSTALLED);
      expect(short.reason).toBe('disk');
    });

    it('does not block when the free disk is unknown', () => {
      const hw = without(mac(48, 'Apple M4 Max'), 'freeDiskBytes', 'freeDiskGb');
      expect(recommend(hw, STOCK, ALL_INSTALLED).verdict).toBe('ok');
    });

    it('formats the free size itself when the hardware carries only the bytes', () => {
      const hw = without(mac(48, 'Apple M4 Max', { freeDiskBytes: 3 * GB }), 'freeDiskGb');
      expect(recommend(hw, STOCK, ALL_INSTALLED).headline.vars?.free).toBe('3.0');
    });

    it('comes after the memory and the harness', () => {
      const fullDisk = { freeDiskBytes: 0, freeDiskGb: '0.0' };
      expect(recommend(mac(16, 'Apple M4', fullDisk), STOCK, ALL_INSTALLED).reason).toBe('memory');
      expect(recommend(mac(48, 'Apple M4 Max', fullDisk), STOCK, []).reason).toBe('no-harness');
      expect(recommend(mac(48, 'Apple M4 Max', fullDisk), STOCK, ALL_INSTALLED).reason).toBe('disk');
    });
  });
});

// ---------- 4. Verdicts, ranking, harnesses, tested ----------

describe('verdict limited', () => {
  it('is the answer when no model that fits has 12 billion parameters or more', () => {
    expect(LIMITED_BELOW_PARAMS_B).toBe(12);
    const result = recommend(mac(24, 'Apple M4'), STOCK, ALL_INSTALLED);
    expect(result.verdict).toBe('limited');
    expect(result.reason).toBeUndefined();
    expect(result.pick).toMatchObject({ modelId: 'qwen3.5:9b', paramsB: 9, context: 65536, fit: 'good' });
    expect(result.headline).toEqual({
      text: 'This Mac can run a small model. It handles small edits and questions. It does not replace a cloud model.',
    });
    expect(result.notes).toEqual([{ text: 'Not yet tested by us on a Mac like this.' }]);
  });

  it('holds for a tight fit too (18 GB)', () => {
    const result = recommend(mac(18, 'Apple M3 Pro'), STOCK, ALL_INSTALLED);
    expect(result.verdict).toBe('limited');
    expect(result.pick).toMatchObject({ modelId: 'qwen3.5:9b', fit: 'tight', fitLabel: 'Tight', budgetShare: 0.873 });
    expect(result.alternatives).toEqual([]);
  });

  it('draws the line at 12 billion: 11.9 is limited, 12 is ok', () => {
    const verdictFor = (paramsB: number): string =>
      recommend(HUNDRED_GIB_MAC, catalogOf([model('probe:1', { paramsB })]), [fact('alpha')]).verdict;
    expect(verdictFor(11.9)).toBe('limited');
    expect(verdictFor(12)).toBe('ok');
    expect(verdictFor(9)).toBe('limited');
    expect(verdictFor(27.8)).toBe('ok');
  });

  it('is about the MAC, not the pick: a larger model further down the list lifts it', () => {
    // 32 GB: the 20B fits only as Tight, so a 9B is the pick. The Mac can still run a 20B, so
    // "This Mac can run a small model" would be false of it.
    const result = recommend(mac(32, 'Apple M4'), STOCK, ALL_INSTALLED);
    expect(result.pick).toMatchObject({ modelId: 'qwen3.5:9b', paramsB: 9 });
    expect(result.alternatives.map((c) => [c.modelId, c.fit])).toContainEqual(['gpt-oss:20b', 'tight']);
    expect(result.verdict).toBe('ok');
    expect(result.headline).toEqual({ text: 'Best fit for this Mac' });
    // The pick is still called what it is.
    expect(result.notes).toEqual([
      {
        text: 'The best fit is a small model. It handles small edits and questions. It does not replace a cloud model.',
      },
      { text: 'Not yet tested by us on a Mac like this.' },
    ]);
  });

  it('does not tell a 36 GB Mac it is a small-model Mac above a list of 20B, 27B and 35B models', () => {
    const result = recommend(mac(36, 'Apple M4 Max'), STOCK, ALL_INSTALLED);
    expect(result.pick).toMatchObject({ modelId: 'qwen3.5:9b-q8_0', fit: 'good', speed: 'ok' });
    expect(result.alternatives.map((c) => [c.modelId, c.fit, c.speed])).toEqual([
      ['qwen3.5:9b', 'good', 'ok'],
      ['gpt-oss:20b', 'good', 'unknown'],
      // Both Tight and fast enough: the higher model rank first.
      ['qwen3.8:27b', 'tight', 'ok'],
      ['qwen3.6:35b-a3b', 'tight', 'ok'],
    ]);
    expect(result.verdict).toBe('ok');
    expect(result.headline.text).not.toBe(LOCAL_MODEL_LABELS.headlineLimited);
    expect(result.notes[0]).toEqual({ text: LOCAL_MODEL_LABELS.noteSmallPick });
  });

  it('does not depend on whether the chip is in the chips table', () => {
    // Knowing the chip must not lower the verdict: before, a known chip made the 9B win on
    // speed and the answer limited, while an unknown chip got `ok` with the 20B.
    for (const soldGb of [32, 36]) {
      const known = recommend(mac(soldGb, 'Apple M4 Max'), STOCK, ALL_INSTALLED);
      const unknown = recommend(mac(soldGb, 'Apple M6'), STOCK, ALL_INSTALLED);
      expect([soldGb, known.verdict]).toEqual([soldGb, unknown.verdict]);
      expect(known.verdict).toBe('ok');
    }
  });

  it('is limited exactly when nothing with 12 billion parameters fits, on every Mac of the sweep', () => {
    for (const hw of SWEEP) {
      const result = recommend(hw, STOCK, ALL_INSTALLED);
      if (result.verdict === 'none') continue;
      const budget = deviceBudget(hw).budgetBytes;
      const largeFits = STOCK.models.some(
        (m) =>
          m.paramsB >= LIMITED_BELOW_PARAMS_B &&
          m.contexts.some((ctx) => ctx >= 65536 && needBytes(m, ctx, STOCK, hw) / budget <= FIT_TIGHT_MAX_SHARE)
      );
      expect([hw.memClassGb, hw.chip, result.verdict]).toEqual([hw.memClassGb, hw.chip, largeFits ? 'ok' : 'limited']);
      // The small-pick note: under `ok` only, and exactly when the pick is small.
      const small = result.notes.some((note) => note.text === LOCAL_MODEL_LABELS.noteSmallPick);
      expect(small).toBe(result.verdict === 'ok' && (result.pick as Candidate).paramsB < LIMITED_BELOW_PARAMS_B);
    }
  });

  it('counts only a large model a harness can really run', () => {
    // 48 GB, but the harnesses refuse every id but the two 9B ones: nothing large can be offered.
    const facts = ALL_INSTALLED.map((entry) => ({
      ...entry,
      acceptsModelId: (id: string) => id.startsWith('qwen3.5:9b'),
    }));
    const result = recommend(mac(48, 'Apple M4 Max'), STOCK, facts);
    expect(result.verdict).toBe('limited');
    expect(result.headline.text).toBe(LOCAL_MODEL_LABELS.headlineLimited);
    // The headline says it, so the note does not repeat it.
    expect(result.notes).toEqual([{ text: LOCAL_MODEL_LABELS.noteUntested }]);
  });

  it('never says "Recommended", for any Mac', () => {
    for (const hw of SWEEP) {
      const result = recommend(hw, STOCK, ALL_INSTALLED);
      if (result.verdict === 'limited') {
        expect(result.headline.text).toBe(LOCAL_MODEL_LABELS.headlineLimited);
        expect(stringsIn(result).join(' ')).not.toMatch(/recommended/i);
      }
    }
  });
});

describe('speed', () => {
  it('is the model figure times the chip bandwidth, rounded to one decimal', () => {
    const result = recommend(mac(48, 'Apple M4 Max'), STOCK, ALL_INSTALLED);
    // 2.95 x 410 / 100.
    expect(result.pick).toMatchObject({ modelId: 'qwen3.8:27b', speed: 'ok', tokensPerSecond: 12.1 });
    expect(result.pick).not.toHaveProperty('speedLabel');
  });

  it('is slow below 10 tokens per second, and says so', () => {
    expect(SLOW_BELOW_TOKENS_PER_SECOND).toBe(10);
    const speedOf = (speedPer100Gbps: number): Candidate | undefined =>
      recommend(HUNDRED_GIB_MAC, catalogOf([model('probe:1', { speedPer100Gbps })]), [fact('alpha')]).pick;
    // The synthetic chip has 400 GB/s: 2.5 is 10.0 tokens per second, 2.475 is 9.9.
    expect(speedOf(2.5)).toMatchObject({ speed: 'ok', tokensPerSecond: 10 });
    expect(speedOf(2.475)).toMatchObject({ speed: 'slow', tokensPerSecond: 9.9, speedLabel: 'Slow' });
    expect(speedOf(0.5)).toMatchObject({ speed: 'slow', tokensPerSecond: 2, speedLabel: 'Slow' });
  });

  it('grades the unrounded figure: 9.95 to 9.9996 tokens per second print as 10 and are still slow', () => {
    const speedOf = (speedPer100Gbps: number): Candidate | undefined =>
      recommend(HUNDRED_GIB_MAC, catalogOf([model('probe:1', { speedPer100Gbps })]), [fact('alpha')]).pick;
    // 2.4875 x 4 = 9.95, 2.49 x 4 = 9.96, 2.4999 x 4 = 9.9996: all under 10, all rounding to 10.0.
    for (const figure of [2.4875, 2.49, 2.4999]) {
      expect(speedOf(figure), String(figure)).toMatchObject({ speed: 'slow', speedLabel: 'Slow', tokensPerSecond: 10 });
    }
    // And the first figure that is not under 10.
    expect(speedOf(2.5)).not.toHaveProperty('speedLabel');
  });

  it('is unknown for a model without a figure, on any chip', () => {
    // 48 GB: five models fit, so all of them are listed and gpt-oss:20b is among them.
    for (const chip of ['Apple M1', 'Apple M4 Max', 'Apple M5 Ultra']) {
      const result = recommend(mac(48, chip), STOCK, ALL_INSTALLED);
      const gptOss = [result.pick, ...result.alternatives].find((c) => c?.modelId === 'gpt-oss:20b');
      expect(gptOss, chip).toMatchObject({ speed: 'unknown', speedLabel: 'Speed unknown' });
      expect(gptOss).not.toHaveProperty('tokensPerSecond');
    }
  });

  it('is unknown for every model on a chip that is in no chips row: no bandwidth is guessed', () => {
    for (const chip of ['Apple M6', 'Apple M6 Pro', 'Apple M10', 'Some Future Chip']) {
      const result = recommend(mac(64, chip), STOCK, ALL_INSTALLED);
      for (const candidate of [result.pick, ...result.alternatives]) {
        expect(candidate, chip).toMatchObject({ speed: 'unknown', speedLabel: 'Speed unknown' });
        expect(candidate).not.toHaveProperty('tokensPerSecond');
      }
    }
    // And when the chip name itself is missing.
    const result = recommend(without(mac(64, 'x'), 'chip'), STOCK, ALL_INSTALLED);
    expect(result.pick?.speed).toBe('unknown');
  });
});

describe('the ranking', () => {
  it('puts ok before unknown before slow, ahead of the model rank', () => {
    // Three models that fit equally well. The ranks run AGAINST the speed.
    const catalog = catalogOf([
      model('slow-top:1', { rank: 3, speedPer100Gbps: 1 }),
      model('unknown-mid:1', { rank: 2 }),
      model('ok-low:1', { rank: 1, speedPer100Gbps: 5 }),
    ]);
    const result = recommend(HUNDRED_GIB_MAC, catalog, [fact('alpha')]);
    expect(order(result)).toEqual(['ok-low:1@1024', 'unknown-mid:1@1024', 'slow-top:1@1024']);
    expect([result.pick, ...result.alternatives].map((c) => c?.speed)).toEqual(['ok', 'unknown', 'slow']);
  });

  it('ranks by model rank alone when every speed is unknown', () => {
    // 'Apple M6' is in no chips row.
    const result = recommend(mac(48, 'Apple M6'), STOCK, ALL_INSTALLED);
    expect(order(result)).toEqual([
      'qwen3.8:27b@131072',
      'qwen3.6:35b-a3b@131072',
      'gpt-oss:20b@131072',
      'qwen3.5:9b-q8_0@65536',
      'qwen3.5:9b@65536',
    ]);
  });

  it('ranks an unknown speed below a known ok one and above a slow one, on a real tier', () => {
    // 48 GB, M4 Pro: three ok models, then gpt-oss:20b (unknown), then the 27B (slow).
    const result = recommend(mac(48, 'Apple M4 Pro'), STOCK, ALL_INSTALLED);
    expect([result.pick, ...result.alternatives].map((c) => [c?.modelId, c?.speed])).toEqual([
      ['qwen3.6:35b-a3b', 'ok'],
      ['qwen3.5:9b-q8_0', 'ok'],
      ['qwen3.5:9b', 'ok'],
      ['gpt-oss:20b', 'unknown'],
      ['qwen3.8:27b', 'slow'],
    ]);
  });

  it('puts a good fit before a tight one, ahead of speed and rank', () => {
    const catalog = catalogOf([
      modelNeeding('tight-fast-top:1', 0.9 * HUNDRED_GIB, { rank: 9, speedPer100Gbps: 20 }),
      modelNeeding('good-slow-low:1', 0.5 * HUNDRED_GIB, { rank: 1, speedPer100Gbps: 1 }),
    ]);
    const result = recommend(HUNDRED_GIB_MAC, catalog, [fact('alpha')]);
    expect(order(result)).toEqual(['good-slow-low:1@1024', 'tight-fast-top:1@1024']);
  });

  it('takes the higher model rank among equals', () => {
    const catalog = catalogOf([model('low:1', { rank: 1 }), model('high:1', { rank: 5 }), model('mid:1', { rank: 3 })]);
    expect(order(recommend(HUNDRED_GIB_MAC, catalog, [fact('alpha')]))).toEqual([
      'high:1@1024',
      'mid:1@1024',
      'low:1@1024',
    ]);
  });

  it('takes the larger context of one model when both fit equally well', () => {
    // 1 KiB per token: 4 GiB of KV cache at 4,194,304 tokens, still a good fit.
    const catalog = catalogOf([model('probe:1', { kvBytesPerToken: 1024, contexts: [4_194_304, 1024] })]);
    const result = recommend(HUNDRED_GIB_MAC, catalog, [fact('alpha')]);
    expect(result.pick?.context).toBe(4_194_304);
    expect(result.alternatives).toEqual([]);
  });

  it('steps a model down to the context at which it fits well', () => {
    // Good at the small context, tight at the large one: the good one is that model's entry.
    const catalog = catalogOf([
      model('probe:1', { bytes: 80 * GIB, kvBytesPerToken: 1024, contexts: [8_388_608, 1024] }),
    ]);
    const result = recommend(HUNDRED_GIB_MAC, catalog, [fact('alpha')]);
    expect(result.pick).toMatchObject({ context: 1024, fit: 'good' });
  });

  it('lists each model once, never the pick again, and at most four alternatives', () => {
    expect(MAX_ALTERNATIVES).toBe(4);
    // Six models fit a 128 GB Mac; the pick plus four are shown.
    const result = recommend(mac(128, 'Apple M5 Ultra'), STOCK, ALL_INSTALLED);
    expect(result.alternatives).toHaveLength(4);
    const ids = [result.pick, ...result.alternatives].map((c) => c?.modelId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const hw of SWEEP) {
      const swept = recommend(hw, STOCK, ALL_INSTALLED);
      const sweptIds = [swept.pick, ...swept.alternatives].filter(Boolean).map((c) => c?.modelId);
      expect(new Set(sweptIds).size).toBe(sweptIds.length);
      expect(swept.alternatives.length).toBeLessThanOrEqual(MAX_ALTERNATIVES);
    }
  });
});

describe('harnesses', () => {
  const hw = mac(48, 'Apple M4 Max');

  it('never chooses a gated harness, even when it is the only one that could run a model', () => {
    const gated = STOCK.harnesses.filter((row) => row.gated).map((row) => row.cli);
    expect(gated).toEqual(['pi']);
    for (const swept of SWEEP) {
      const result = recommend(swept, STOCK, ALL_INSTALLED);
      for (const candidate of [result.pick, ...result.alternatives]) {
        if (candidate) expect(gated).not.toContain(candidate.cli);
      }
    }
    // 16 GB: the gated harness alone works at 32768 tokens, where the 9B would fit. Still none.
    expect(recommend(mac(16, 'Apple M4'), STOCK, ALL_INSTALLED).verdict).toBe('none');
  });

  it('never offers a context below the minimum of the harness', () => {
    for (const swept of SWEEP) {
      const result = recommend(swept, STOCK, ALL_INSTALLED);
      for (const candidate of [result.pick, ...result.alternatives]) {
        if (!candidate) continue;
        const row = STOCK.harnesses.find((harness) => harness.cli === candidate.cli);
        expect(candidate.context).toBeGreaterThanOrEqual(row?.minContext ?? Number.POSITIVE_INFINITY);
      }
    }
  });

  it('takes the higher-ranked harness and reports its label and that it is installed', () => {
    const result = recommend(hw, STOCK, ALL_INSTALLED);
    expect(result.pick).toMatchObject({ cli: 'opencode', cliLabel: 'OpenCode', cliInstalled: true });
    expect(result.pick).not.toHaveProperty('slowFirstTurn');
  });

  it('falls back to the next harness when the first is not on the machine, and flags its slow first turn', () => {
    const facts = [fact('opencode', { installed: false, installable: false }), fact('claude'), fact('pi')];
    const result = recommend(hw, STOCK, facts);
    expect(result.pick).toMatchObject({
      modelId: 'qwen3.8:27b',
      cli: 'claude',
      cliLabel: 'Claude Code',
      cliInstalled: true,
      slowFirstTurn: true,
    });
    // The same when the caller has no fact for it at all.
    expect(recommend(hw, STOCK, [fact('claude')]).pick?.cli).toBe('claude');
  });

  it('offers a harness that is not installed but can be, and says it is not installed', () => {
    const facts = [fact('opencode', { installed: false, installable: true }), fact('claude')];
    const result = recommend(hw, STOCK, facts);
    expect(result.pick).toMatchObject({ cli: 'opencode', cliInstalled: false });
  });

  it('pairs a model only with a harness that accepts its id', () => {
    const refusing27b = (id: string): boolean => id !== 'qwen3.8:27b';
    // OpenCode refuses the 27B: it goes with the next harness.
    const one = recommend(hw, STOCK, [fact('opencode', { acceptsModelId: refusing27b }), fact('claude')]);
    expect(one.pick).toMatchObject({ modelId: 'qwen3.8:27b', cli: 'claude' });
    expect(one.alternatives[0]).toMatchObject({ modelId: 'qwen3.6:35b-a3b', cli: 'opencode' });
    // Both refuse it: the model is not offered.
    const both = recommend(hw, STOCK, [
      fact('opencode', { acceptsModelId: refusing27b }),
      fact('claude', { acceptsModelId: refusing27b }),
    ]);
    expect(both.pick?.modelId).toBe('qwen3.6:35b-a3b');
    expect(order(both)).not.toContain('qwen3.8:27b@131072');
  });

  it('treats a harness check that throws as a refusal, and still answers', () => {
    const throwing = fact('opencode', {
      acceptsModelId: () => {
        throw new Error('registry not loaded');
      },
    });
    const result = recommend(hw, STOCK, [throwing, fact('claude')]);
    expect(result.verdict).toBe('ok');
    expect(result.pick?.cli).toBe('claude');
    expect(recommend(hw, STOCK, [throwing]).reason).toBe('no-harness');
  });

  it('puts the fit and the model before the harness rank', () => {
    // `big` needs a large context and is the higher-ranked harness; `small` works from 1024.
    const harnesses: LocalHarnessEntry[] = [
      { cli: 'big', minContext: 8_388_608, rank: 2 },
      { cli: 'small', minContext: 1024, rank: 1 },
    ];
    const tightAtLarge = catalogOf(
      [model('probe:1', { bytes: 80 * GIB, kvBytesPerToken: 1024, contexts: [8_388_608, 1024] })],
      harnesses
    );
    // Tight at the context `big` needs, good at the small one: the good fit with `small` wins.
    expect(recommend(HUNDRED_GIB_MAC, tightAtLarge, [fact('big'), fact('small')]).pick).toMatchObject({
      cli: 'small',
      context: 1024,
      fit: 'good',
    });
    // Good at both: the higher-ranked harness wins, at the context it needs.
    const goodAtBoth = catalogOf(
      [model('probe:1', { bytes: 10 * GIB, kvBytesPerToken: 1024, contexts: [8_388_608, 1024] })],
      harnesses
    );
    expect(recommend(HUNDRED_GIB_MAC, goodAtBoth, [fact('big'), fact('small')]).pick).toMatchObject({
      cli: 'big',
      context: 8_388_608,
    });
  });
});

describe('the tested flag and the word "Recommended"', () => {
  const testedOn = (chip: string, memGb: number, cli: string) => ({ chip, memGb, cli, date: '2026-11-06' });
  const with27bTested = (chip: string, memGb: number, cli: string): LocalModelCatalog =>
    stockWith((catalog) => {
      const row = catalog.models.find((m) => m.id === 'qwen3.8:27b') as LocalModelEntry;
      row.tested = [testedOn(chip, memGb, cli)];
    });

  it('is off for every model of the stock catalogue, so "Recommended" is never said today', () => {
    for (const hw of SWEEP) {
      const result = recommend(hw, STOCK, ALL_INSTALLED);
      for (const candidate of [result.pick, ...result.alternatives]) {
        if (candidate) expect(candidate.tested).toBe(false);
      }
      expect(stringsIn(result).join(' ')).not.toMatch(/recommended/i);
      if (result.verdict !== 'none') {
        // Always the last note; a small pick under `ok` has one more before it.
        expect(result.notes[result.notes.length - 1]).toEqual({ text: LOCAL_MODEL_LABELS.noteUntested });
      }
    }
  });

  it('turns on "Recommended for this Mac" when the pick was tested on exactly such a Mac', () => {
    const result = recommend(mac(48, 'Apple M4 Max'), with27bTested('Apple M4 Max', 48, 'opencode'), ALL_INSTALLED);
    expect(result.verdict).toBe('ok');
    expect(result.pick).toMatchObject({ modelId: 'qwen3.8:27b', cli: 'opencode', tested: true });
    expect(result.headline).toEqual({ text: 'Recommended for this Mac' });
    // The "not yet tested" note goes away with it.
    expect(result.notes).toEqual([]);
  });

  it('stays off when the chip, the memory size or the harness differs', () => {
    const hw = mac(48, 'Apple M4 Max');
    const cases: LocalModelCatalog[] = [
      with27bTested('Apple M4 Pro', 48, 'opencode'),
      with27bTested('Apple M4', 48, 'opencode'),
      with27bTested('Apple M4 Max', 64, 'opencode'),
      with27bTested('Apple M4 Max', 48, 'claude'),
    ];
    for (const catalog of cases) {
      const result = recommend(hw, catalog, ALL_INSTALLED);
      expect(result.pick).toMatchObject({ modelId: 'qwen3.8:27b', cli: 'opencode', tested: false });
      expect(result.headline).toEqual({ text: 'Best fit for this Mac' });
      expect(result.notes).toEqual([{ text: 'Not yet tested by us on a Mac like this.' }]);
    }
  });

  it('follows the harness: tested with the second harness counts when that one is the pick', () => {
    const catalog = with27bTested('Apple M4 Max', 48, 'claude');
    const result = recommend(mac(48, 'Apple M4 Max'), catalog, [fact('claude')]);
    expect(result.pick).toMatchObject({ cli: 'claude', tested: true });
    expect(result.headline.text).toBe('Recommended for this Mac');
  });

  it('does not change the ranking: a tested model further down stays an alternative', () => {
    // On the M4 Pro the pick is the 35B-A3B. A tested 27B is flagged in the list, no more.
    const result = recommend(mac(48, 'Apple M4 Pro'), with27bTested('Apple M4 Pro', 48, 'opencode'), ALL_INSTALLED);
    expect(result.pick).toMatchObject({ modelId: 'qwen3.6:35b-a3b', tested: false });
    expect(result.headline.text).toBe('Best fit for this Mac');
    expect(result.notes).toEqual([{ text: LOCAL_MODEL_LABELS.noteUntested }]);
    expect(result.alternatives.find((c) => c.modelId === 'qwen3.8:27b')?.tested).toBe(true);
  });

  it('never says "Recommended" for a limited answer, tested or not', () => {
    const catalog = stockWith((stock) => {
      const row = stock.models.find((m) => m.id === 'qwen3.5:9b') as LocalModelEntry;
      row.tested = [testedOn('Apple M4', 24, 'opencode')];
    });
    const result = recommend(mac(24, 'Apple M4'), catalog, ALL_INSTALLED);
    expect(result.verdict).toBe('limited');
    expect(result.pick?.tested).toBe(true);
    expect(result.headline.text).toBe(LOCAL_MODEL_LABELS.headlineLimited);
    expect(stringsIn(result).join(' ')).not.toMatch(/recommended/i);
    // It WAS tested, so the "not yet tested" note would be false.
    expect(result.notes).toEqual([]);
  });
});

describe('the shape of the answer', () => {
  const labels = new Set<string>(Object.values(LOCAL_MODEL_LABELS));

  it('takes every sentence and label from the fixed list', () => {
    for (const hw of SWEEP) {
      const result = recommend(hw, STOCK, ALL_INSTALLED);
      expect(labels.has(result.headline.text)).toBe(true);
      for (const note of result.notes) expect(labels.has(note.text)).toBe(true);
      for (const candidate of [result.pick, ...result.alternatives]) {
        if (!candidate) continue;
        expect(labels.has(candidate.fitLabel)).toBe(true);
        if (candidate.speedLabel !== undefined) expect(labels.has(candidate.speedLabel)).toBe(true);
        expect(candidate.speedLabel === undefined).toBe(candidate.speed === 'ok');
        expect(candidate.tokensPerSecond === undefined).toBe(candidate.speed === 'unknown');
      }
    }
  });

  it('fills every placeholder of a headline and nothing else', () => {
    const answers = [
      recommend(mac(8, 'Apple M2'), STOCK, ALL_INSTALLED),
      recommend(mac(48, 'Apple M4', { macosMajor: 13, macosVersion: '13.0' }), STOCK, ALL_INSTALLED),
      recommend(mac(48, 'Apple M4', { freeDiskBytes: GB, freeDiskGb: '1.0' }), STOCK, ALL_INSTALLED),
      recommend(mac(48, 'Apple M4'), STOCK, []),
      recommend(mac(48, 'Apple M4'), STOCK, ALL_INSTALLED),
    ];
    expect(answers.map((answer) => answer.reason ?? answer.verdict)).toEqual([
      'memory',
      'macos',
      'disk',
      'no-harness',
      'ok',
    ]);
    // The two other sentences of the `memory` reason, and an answer with every kind of note.
    answers.push(
      recommend(mac(16, 'Apple M4'), STOCK, ALL_INSTALLED),
      recommend({ ...mac(48, 'Apple M4'), memBytes: 0, memGb: '0.0', memClassGb: 0 }, STOCK, ALL_INSTALLED),
      recommend(mac(48, 'Apple M4', { freeDiskBytes: 20 * GIB, freeDiskGb: '21.5' }), STOCK, ALL_INSTALLED)
    );
    expect(answers.slice(5).map((answer) => answer.headline.text)).toEqual([
      LOCAL_MODEL_LABELS.noneMemoryContext,
      LOCAL_MODEL_LABELS.noneMemoryUnknown,
      LOCAL_MODEL_LABELS.headlineOk,
    ]);
    expect(answers[7].notes.map((note) => note.text)).toEqual([
      LOCAL_MODEL_LABELS.noteSmallPick,
      LOCAL_MODEL_LABELS.noteDiskDropped,
      LOCAL_MODEL_LABELS.noteUntested,
    ]);
    for (const answer of answers) {
      for (const message of [answer.headline, ...answer.notes]) {
        const slots = [...message.text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
        expect(Object.keys(message.vars ?? {}).sort()).toEqual(slots);
        // `{name}` belongs to the browser's translator.
        expect(slots).not.toContain('name');
        for (const value of Object.values(message.vars ?? {})) expect(typeof value).toBe('string');
      }
    }
  });

  it('prints every size in one unit: decimal GB from the one formatter, never GiB', () => {
    for (const hw of SWEEP) {
      const result = recommend(hw, STOCK, ALL_INSTALLED);
      expect(result.budgetGb).toBe(formatGb(result.budgetBytes));
      for (const candidate of [result.pick, ...result.alternatives]) {
        if (!candidate) continue;
        expect(candidate.needGb).toBe(formatGb(candidate.needBytes));
        expect(candidate.downloadGb).toBe(formatGb(candidate.downloadBytes));
        expect(candidate.budgetShare).toBeCloseTo(candidate.needBytes / result.budgetBytes, 3);
      }
      expect(JSON.stringify(result)).not.toMatch(/GiB|MiB/);
    }
  });

  it('adds up for a person: download, plus what the context and the runtime take, is the need', () => {
    const result = recommend(mac(48, 'Apple M4 Max'), STOCK, ALL_INSTALLED);
    const pick = result.pick as Candidate;
    // 17.7 GB of weights + 8 GiB of KV cache + 1 GiB + 2 GiB of prompt cache, all in decimal GB.
    expect(pick.downloadGb).toBe('17.7');
    expect(pick.needGb).toBe('29.6');
    expect(formatGb(pick.needBytes - pick.downloadBytes)).toBe('11.8');
    expect(result.budgetGb).toBe('37.6');
    expect(pick.needBytes).toBeLessThan(result.budgetBytes);
  });

  it('is plain JSON and has exactly the fields of its verdict', () => {
    const ok = recommend(mac(48, 'Apple M4 Max'), STOCK, ALL_INSTALLED);
    expect(JSON.parse(JSON.stringify(ok))).toEqual(ok);
    expect(Object.keys(ok).sort()).toEqual(
      ['alternatives', 'budgetBytes', 'budgetGb', 'budgetSource', 'headline', 'notes', 'pick', 'verdict'].sort()
    );
    const none = recommend(mac(8, 'Apple M2'), STOCK, ALL_INSTALLED);
    expect(JSON.parse(JSON.stringify(none))).toEqual(none);
    expect(Object.keys(none).sort()).toEqual(
      ['alternatives', 'budgetBytes', 'budgetGb', 'budgetSource', 'headline', 'notes', 'reason', 'verdict'].sort()
    );
  });

  it('is pure: frozen inputs are enough, and the same inputs give the same answer', () => {
    const hw = deepFreeze(mac(48, 'Apple M4 Pro'));
    const catalog = deepFreeze(structuredClone(STOCK_LOCAL_MODEL_CATALOG));
    const facts = deepFreeze(ALL_INSTALLED.map((entry) => ({ ...entry })));
    const first = recommend(hw, catalog, facts);
    const second = recommend(hw, catalog, facts);
    expect(second).toEqual(first);
    expect(first.verdict).toBe('ok');
  });
});
