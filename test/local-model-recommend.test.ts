/**
 * @fileoverview Tests for src/local-model/recommend.ts: the pure function that turns "what this
 * Mac is" into "which local model fits it".
 *
 * Laid out like the module:
 *
 * 1. The budget (`deviceBudget`) for every memory size Apple sells from 8 to 512 GB, estimated
 *    and measured, and the need of a model at a context (`needBytes`: the peak).
 * 2. The two REAL Macs of the project, from their captured `sysctl` output through the real
 *    parser: the MacBook Pro (M5 Pro, 48 GB) and the Mac mini (M4, 16 GB). Each test states the
 *    expected answer and why. The MacBook's answer is checked against what was MEASURED on it.
 *    Then what the stock catalogue answers for every memory size from 8 to 512 GB.
 * 3. Every reason for verdict `none`, one fixture per reason, and their order.
 * 4. The `limited` verdict (a statement about the Mac, not about the pick), the notes that say
 *    what the headline cannot (a small pick, a model left out for disk space), the ranking
 *    (tested, speed, model rank, harness rank, context: the fit grade filters and does not
 *    sort), harness rows (a gated one is never chosen), the `tested` flag that alone may turn
 *    on the word "Recommended", what each row of the chooser carries (its tag, its harnesses,
 *    the whole download of an install), and the shape of the answer.
 *
 * Three catalogues:
 *  - `STOCK`, the catalogue that ships, wherever the answer for a real Mac or a memory size is
 *    at stake (part 2, the sweeps that must hold for every Mac, and the end-to-end checks). A
 *    change of the stock catalogue changes these on purpose, and only these.
 *  - `RULES`, the catalogue as it shipped on 2026-11-06, frozen in
 *    test/fixtures/local-model-rules-catalog.ts: realistic rows for the rule tests of parts 3
 *    and 4, whose answers must not move every time a model is added (see that file).
 *  - Small synthetic catalogues (validated by the real schema) that isolate one rule of the
 *    ranking at a time.
 *
 * Port: N/A (pure functions; the two hardware fixtures go through `readHardware` with every
 * piece of IO injected).
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { getLocalModelCatalog, LocalModelCatalogSchema } from '../src/config/local-model-catalog.js';
import { formatGb, GB, GIB, memClassGb, MIB } from '../src/local-model/format.js';
import { readHardware, resetHardwareCache } from '../src/local-model/hardware.js';
import {
  deviceBudget,
  DISK_HEADROOM_BYTES,
  FIT_GOOD_MAX_SHARE,
  FIT_TIGHT_MAX_SHARE,
  LIMITED_BELOW_PARAMS_B,
  MAX_ALTERNATIVES,
  modelFitsBudget,
  needBytes,
  recommend,
  SLOW_BELOW_TOKENS_PER_SECOND,
} from '../src/local-model/recommend.js';
import {
  LOCAL_MODEL_LABELS,
  LOCAL_MODEL_TAG_LABELS,
  type Candidate,
  type HardwareFacts,
  type HarnessFact,
  type LocalHarnessEntry,
  type LocalModelCatalog,
  type LocalModelEntry,
  type Recommendation,
  type TestedOn,
} from '../src/types.js';
import { RULES_LOCAL_MODEL_CATALOG } from './fixtures/local-model-rules-catalog.js';

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

/**
 * What the runtime printed as the device total on each real Mac when it started: 37.4 GiB on
 * the MacBook, 11.8 GiB on the Mac mini (`parseInferenceComputeTotal()` of those two log lines).
 */
const MACBOOK_MEASURED_TOTAL = 40_157_944_217;
const MACMINI_MEASURED_TOTAL = 12_670_153_523;

/** The size of the pinned runtime archive: what an install adds to the download while the runtime is not installed. */
const RUNTIME_ARCHIVE_BYTES = 185_971_671;

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

const macbook = (): Promise<HardwareFacts> => realMac(MACBOOK_SYSCTL, 890_926_084);
const macMini = (): Promise<HardwareFacts> => realMac(MACMINI_SYSCTL, 41_752_848);

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
const HARNESS_LABELS: Record<string, string> = {
  opencode: 'OpenCode',
  claude: 'Claude Code',
  pi: 'Pi',
  deepseek: 'DeepSeek',
};

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

/** The catalogue that ships: for the answers a real Mac gets. */
const STOCK = getLocalModelCatalog();

/** The frozen catalogue of 2026-11-06: for the rule tests (see the file header). */
const RULES = LocalModelCatalogSchema.parse(RULES_LOCAL_MODEL_CATALOG);

/**
 * Every harness installed. The stock catalogue lists four and gates none; the rules catalogue
 * lists the first three of them and gates one, which is what the gate tests need.
 */
const ALL_INSTALLED: HarnessFact[] = STOCK.harnesses.map((row) => fact(row.cli));

/** A stock model row by id. */
function stockModel(id: string): LocalModelEntry {
  return STOCK.models.find((m) => m.id === id) as LocalModelEntry;
}

/** The stock catalogue with a change applied, validated by the real schema. */
function stockWith(change: (catalog: LocalModelCatalog) => void): LocalModelCatalog {
  const catalog = structuredClone(STOCK);
  change(catalog);
  return LocalModelCatalogSchema.parse(catalog);
}

/** A model row of the rules catalogue by id. */
function rulesModel(id: string): LocalModelEntry {
  return RULES.models.find((m) => m.id === id) as LocalModelEntry;
}

/** The rules catalogue with a change applied, validated by the real schema. */
function rulesWith(change: (catalog: LocalModelCatalog) => void): LocalModelCatalog {
  const catalog = structuredClone(RULES_LOCAL_MODEL_CATALOG);
  change(catalog);
  return LocalModelCatalogSchema.parse(catalog);
}

/** The stock catalogue as if nobody had tested a row: no `tested` entry anywhere. */
const STOCK_UNTESTED = stockWith((catalog) => {
  for (const row of catalog.models) row.tested = [];
});

/** The rules catalogue as it was before anybody tested a row: no `tested` entry anywhere. */
const UNTESTED = rulesWith((catalog) => {
  for (const row of catalog.models) row.tested = [];
});

/** Both real catalogues, for the sweeps whose rule must hold whatever the rows are. */
const BOTH: [name: string, catalog: LocalModelCatalog][] = [
  ['stock', STOCK],
  ['rules', RULES],
];

/**
 * A model row for a synthetic catalogue: 20 billion parameters, 10 GiB, one small context, one
 * byte held per token and nothing else on top, so its need is its weights plus its context.
 */
function model(id: string, overrides: Partial<LocalModelEntry> = {}): LocalModelEntry {
  return {
    id,
    label: id,
    license: 'Apache-2.0',
    paramsB: 20,
    runner: 'llamacpp',
    bytes: 10 * GIB,
    heldBytesPerToken: 1,
    overheadBytes: 0,
    peakExtraBytes: 0,
    figures: 'estimated',
    contexts: [1024],
    rank: 1,
    tested: [],
    ...overrides,
  };
}

/**
 * A synthetic catalogue: one harness `alpha` that works from 1024 tokens, and one chip row
 * ('M4 Max' at 400 GB/s, so tokens per second = `speedPer100Gbps` x 4).
 */
function catalogOf(models: LocalModelEntry[], harnesses?: LocalHarnessEntry[]): LocalModelCatalog {
  return LocalModelCatalogSchema.parse({
    schema: 1,
    updated: '2026-11-06',
    minMacosMajor: 14,
    models,
    harnesses: harnesses ?? [{ cli: 'alpha', minContext: 1024, rank: 1 }],
    chips: [{ match: 'M4 Max', gbps: 400 }],
  });
}

/** A Mac whose budget is exactly 100 GiB: a wired limit of 101 GiB on a 128 GB machine. */
const HUNDRED_GIB_MAC = mac(128, 'Apple M4 Max', { wiredLimitMb: 101 * 1024 });
const HUNDRED_GIB = 100 * GIB;

/** What a synthetic model needs beside its weights at its 1024-token context: one byte per token. */
const SYNTHETIC_OVERHEAD = 1024;

/** A model whose need is exactly `need` bytes in a synthetic catalogue. */
function modelNeeding(id: string, need: number, overrides: Partial<LocalModelEntry> = {}): LocalModelEntry {
  return model(id, { bytes: need - SYNTHETIC_OVERHEAD, ...overrides });
}

/** The pick and the alternatives, in order. */
function rows(result: Recommendation): Candidate[] {
  return [result.pick, ...result.alternatives].filter((candidate): candidate is Candidate => candidate !== undefined);
}

/** `id@context` of the pick and of each alternative, in order. */
function order(result: Recommendation): string[] {
  return rows(result).map((candidate) => `${candidate.modelId}@${candidate.context}`);
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

/** Every memory size Apple sells or sold an Apple silicon Mac with. */
const MEMORY_SIZES = [8, 16, 18, 24, 32, 36, 48, 64, 96, 128, 192, 256, 512];

/** The Macs the sweeps run over: every memory size, with a slow, a fast and an unknown chip. */
const SWEEP: HardwareFacts[] = MEMORY_SIZES.flatMap((soldGb) =>
  ['Apple M4', 'Apple M4 Max', 'Apple M5 Ultra', 'Apple M6'].map((chip) => mac(soldGb, chip))
);

/** Every Mac of the sweep with each of the two real catalogues. */
const SWEEP_BOTH: [HardwareFacts, LocalModelCatalog][] = BOTH.flatMap(([, catalog]) =>
  SWEEP.map((hw): [HardwareFacts, LocalModelCatalog] => [hw, catalog])
);

/** The same plus the tested MacBook, with each of the two real catalogues. */
const SWEEP_BOTH_AND_MACBOOK: [HardwareFacts, LocalModelCatalog][] = BOTH.flatMap(([, catalog]) =>
  [...SWEEP, mac(48, 'Apple M5 Pro')].map((hw): [HardwareFacts, LocalModelCatalog] => [hw, catalog])
);

beforeEach(() => {
  resetHardwareCache();
});

// ---------- 1. Budget and need ----------

describe('deviceBudget, estimated', () => {
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
    [192, 144, 143],
    [256, 192, 191],
    [512, 384, 383],
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
      [192, '143.0'],
      [256, '191.0'],
      [512, '383.0'],
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
    expect([64, 96, 128, 192, 256, 512].map(reserveOf)).toEqual([12, 12, 12, 12, 12, 12]);
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

describe('deviceBudget, measured', () => {
  it('takes what the runtime reported as the limit, without the 1 GiB of the estimate', () => {
    // The MacBook: 37.4 GiB reported, memory - reserve is 40 GiB, so the report is the budget.
    expect(deviceBudget(mac(48, 'Apple M5 Pro'), { measuredTotalBytes: MACBOOK_MEASURED_TOTAL })).toEqual({
      limitBytes: 40_157_944_217,
      budgetBytes: 40_157_944_217,
      source: 'measured',
    });
    // 1.4 GiB more than the estimate of 35 GiB, which was on the careful side.
    expect(40_157_944_217 - deviceBudget(mac(48, 'Apple M5 Pro')).budgetBytes).toBe(2_576_980_377);
  });

  it('is still bounded by the reserve', () => {
    // The Mac mini: 11.8 GiB reported, but 16 GiB minus the 6 GiB reserve is 10 GiB.
    expect(deviceBudget(mac(16, 'Apple M4'), { measuredTotalBytes: MACMINI_MEASURED_TOTAL })).toEqual({
      limitBytes: 12_670_153_523,
      budgetBytes: 10 * GIB,
      source: 'measured',
    });
  });

  it('beats a wired limit: the runtime read what it will really use', () => {
    const hw = mac(48, 'Apple M5 Pro', { wiredLimitMb: 20_000 });
    expect(deviceBudget(hw).source).toBe('wired-limit');
    expect(deviceBudget(hw, { measuredTotalBytes: MACBOOK_MEASURED_TOTAL })).toMatchObject({
      budgetBytes: MACBOOK_MEASURED_TOTAL,
      source: 'measured',
    });
  });

  it('ignores a figure that is no byte count and falls back to the estimate', () => {
    const estimated = deviceBudget(mac(48, 'Apple M5 Pro'));
    for (const measuredTotalBytes of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      expect(deviceBudget(mac(48, 'Apple M5 Pro'), { measuredTotalBytes }), String(measuredTotalBytes)).toEqual(
        estimated
      );
    }
    // A fraction of a byte is rounded down.
    expect(deviceBudget(mac(48, 'Apple M5 Pro'), { measuredTotalBytes: 40_157_944_217.6 }).limitBytes).toBe(
      40_157_944_217
    );
  });
});

describe('needBytes', () => {
  it('is the peak: weights, what stays held for the context, the runner, and the moment of a long prompt', () => {
    // The measured row: 23,105,798,956 + 37,000 x 131,072 + 3 GB + 5 GB.
    const moe = stockModel('qwen3.6:35b-a3b');
    expect(needBytes(moe, 131072)).toBe(23_105_798_956 + 37_000 * 131_072 + 3_000_000_000 + 5_000_000_000);
    expect(needBytes(moe, 131072)).toBe(35_955_462_956);
    // What was measured on the MacBook: about 30.5 GB held and 35 to 36 GB at the peak.
    expect(formatGb(needBytes(moe, 131072))).toBe('36.0');
    expect(formatGb(needBytes(moe, 131072) - moe.peakExtraBytes)).toBe('31.0');
  });

  it('grows with the context by what one token holds', () => {
    // A llama.cpp row: 6,550,811,033 + 17,408 x 65,536 + 2,547,960,320, and no peak.
    const nineB = stockModel('mimo-v2.6:9b-q4_k_m');
    expect(needBytes(nineB, 65536)).toBe(10_239_622_041);
    expect(needBytes(nineB, 131072)).toBe(11_380_472_729);
    // Twice the context, twice what the context holds: 17,408 x 65,536 more.
    expect(needBytes(nineB, 131072) - needBytes(nineB, 65536)).toBe(1_140_850_688);
  });

  it('reads every figure from the row it is given', () => {
    const row = model('probe:1', {
      bytes: 1000,
      heldBytesPerToken: 7,
      overheadBytes: 30,
      peakExtraBytes: 500,
      contexts: [10],
    });
    expect(needBytes(row, 10)).toBe(1000 + 70 + 30 + 500);
    expect(needBytes({ ...row, peakExtraBytes: 0 }, 10)).toBe(1100);
  });

  it('states the need of every stock row at its largest context', () => {
    expect(Object.fromEntries(STOCK.models.map((m) => [m.id, needBytes(m, m.contexts[0])]))).toEqual({
      'qwen3.5:9b-q4_k_m': 11_380_487_246,
      // 0.92 GB under the other two 9B builds: it has no vision projector.
      'ornith:9b-q4_k_m': 10_458_772_264,
      'mimo-v2.6:9b-q4_k_m': 11_380_472_729,
      'north-mini-code-1.0:q4_k_m': 25_999_848_864,
      // At its own window of 131072 tokens: 18.2 GB + 0.9 GB of K/V cache + 2.6 GB.
      'muse-glimmer:30b-q4_k_m': 21_646_509_900,
      'qwen3.6:35b-a3b-mtp-q4_k_m': 28_808_554_317,
      'qwen3.6:35b-a3b': 35_955_462_956,
      'qwen3.8:27b-q8_0': 44_292_142_594,
      'qwen3.8:27b-mtp-q4_k_m': 32_055_772_698,
      'ornith-1.5:122b': 104_808_538_800,
    });
  });

  it('states the need of every rules row at its largest context', () => {
    expect(Object.fromEntries(RULES.models.map((m) => [m.id, formatGb(needBytes(m, m.contexts[0]))]))).toEqual({
      'qwen3.5:9b': '17.0',
      'qwen3.5:9b-q8_0': '20.9',
      'gpt-oss:20b': '26.6',
      'qwen3.6:35b-a3b': '36.0',
      'qwen3.8:27b': '30.6',
      'qwen3.8:27b-q8_0': '47.7',
      'qwen3.5:122b-a10b': '94.2',
    });
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
  /** The same Mac without the probe: 48 GiB and the chip are all the fit and the speed depend on. */
  const hw48 = mac(48, 'Apple M5 Pro');

  /**
   * Expected: Qwen3.6 35B-A3B at 131,072 tokens with OpenCode, a TIGHT fit, 67.7 tokens per
   * second, "Recommended for this Mac".
   *
   * Why. This is the Mac the model was run on (2026-11-06), so its row has a `tested` entry for
   * exactly this chip, memory size and harness. A tested row ranks first, and it reports the
   * speed that was measured (67.7) in place of the estimate from the chip (16.9 x 3.07 = 51.9).
   *
   * The need is the peak at the full context: 23.1 GB of weights + 4.8 GB held for 131,072
   * tokens + 3 GB of runner + 5 GB for a moment while a long prompt is processed = 36.0 GB.
   * Before the runtime ran, the budget is the estimate, 35 GiB (37.6 GB): 0.957 of it, tight.
   * It is not stepped down to 65,536 tokens, where it would be 0.892: a model is offered at
   * the largest context it fits at.
   */
  it('gets Qwen3.6 35B-A3B at 131072 tokens with OpenCode, as a tight fit', async () => {
    const hw = await macbook();
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
      // 23,105,798,956 + 37,000 x 131,072 + 3,000,000,000 + 5,000,000,000.
      needBytes: 35_955_462_956,
      needGb: '36.0',
      memory: { modelBytes: 26_105_798_956, contextBytes: 4_849_664_000, peakBytes: 5_000_000_000 },
      // What a Mac really downloads (the MLX build), not the 22.6 GB of the GGUF build.
      downloadBytes: 23_105_798_956,
      downloadGb: '23.1',
      budgetShare: 0.957,
      fit: 'tight',
      fitLabel: 'Tight',
      speed: 'ok',
      // Measured on this Mac, not the 51.9 the chip's bandwidth predicts.
      tokensPerSecond: 67.7,
      tested: true,
      needSource: 'measured',
      tag: { kind: 'tested', label: 'Tested on a Mac like this' },
      // Every harness of the catalogue can run it, the pick's own first, then by rank.
      harnesses: [
        { cli: 'opencode', cliLabel: 'OpenCode', installed: true },
        { cli: 'claude', cliLabel: 'Claude Code', installed: true, slowFirstTurn: true },
        { cli: 'pi', cliLabel: 'Pi', installed: true },
        { cli: 'deepseek', cliLabel: 'DeepSeek', installed: true },
      ],
      // No runtime download was named, so an install downloads the model alone.
      installBytes: 23_105_798_956,
      installGb: '23.1',
    });
  });

  /**
   * Expected with the budget the runtime MEASURED on this Mac (37.4 GiB, 40.2 GB): the same
   * pick at the same context, 0.895 of the budget, still tight. That is what the measurement
   * notes say of it: "it FITS the measured 40.2 GB budget, and it is TIGHT, not Good".
   */
  it('keeps the pick under the measured budget: 36.0 of 40.2 GB, tight', async () => {
    const result = recommend(await macbook(), STOCK, ALL_INSTALLED, {
      measuredTotalBytes: MACBOOK_MEASURED_TOTAL,
      runtimeDownloadBytes: RUNTIME_ARCHIVE_BYTES,
    });
    expect(result.budgetBytes).toBe(40_157_944_217);
    expect(result.budgetGb).toBe('40.2');
    expect(result.budgetSource).toBe('measured');
    expect(result.pick).toMatchObject({
      modelId: 'qwen3.6:35b-a3b',
      context: 131072,
      needGb: '36.0',
      budgetShare: 0.895,
      fit: 'tight',
      tested: true,
      // The model plus the runtime archive: 23,105,798,956 + 185,971,671.
      installBytes: 23_291_770_627,
      installGb: '23.3',
    });
    // At 65536 tokens it would be a good fit (0.835), and it is still offered at the full context.
    const moe = stockModel('qwen3.6:35b-a3b');
    expect(needBytes(moe, 65536) / result.budgetBytes).toBeCloseTo(0.835, 3);
    expect(needBytes(moe, 65536) / result.budgetBytes).toBeLessThan(FIT_GOOD_MAX_SHARE);
  });

  it('says "Recommended", because the pick was run on exactly such a Mac', async () => {
    const result = recommend(await macbook(), STOCK, ALL_INSTALLED);
    expect(result.headline).toEqual({ text: 'Recommended for this Mac' });
    // The "not yet tested" note would be false.
    expect(result.notes).toEqual([]);
  });

  it('lists every other model that fits, each at the largest context it fits at, the fast ones first', async () => {
    const result = recommend(await macbook(), STOCK, ALL_INSTALLED);
    expect(
      result.alternatives.map((c) => [c.modelId, c.context, c.fit, c.speed, c.tokensPerSecond ?? null, c.tag?.kind])
    ).toEqual([
      // The same model as a GGUF build: its fixed footprint holds the full window, 28.8 GB.
      ['qwen3.6:35b-a3b-mtp-q4_k_m', 262144, 'good', 'ok', 41.8, undefined],
      ['north-mini-code-1.0:q4_k_m', 262144, 'good', 'ok', 41.8, undefined],
      ['mimo-v2.6:9b-q4_k_m', 131072, 'good', 'ok', 28.6, 'small'],
      ['ornith:9b-q4_k_m', 131072, 'good', 'ok', 28.6, 'small'],
      ['qwen3.5:9b-q4_k_m', 131072, 'good', 'ok', 28.6, 'small'],
      // The dense models compute to 2.95 x 3.07 = 9.1 tokens per second on this chip (5.2 in
      // 8 bits): slow, so they come after every fast model, in the order of their rank.
      ['qwen3.8:27b-mtp-q4_k_m', 262144, 'tight', 'slow', 9.1, 'tight'],
      ['qwen3.8:27b-q8_0', 65536, 'tight', 'slow', 5.2, 'tight'],
      ['muse-glimmer:30b-q4_k_m', 131072, 'good', 'slow', 9.1, 'slow'],
    ]);
    // Only the tested row rests on a measurement of that model.
    expect(new Set(result.alternatives.map((c) => c.needSource))).toEqual(new Set(['estimated']));
    // Every model of the catalogue that fits is on the list: nothing is cut off after four.
    const fitting = STOCK.models.filter((m) => m.contexts.some((ctx) => modelFitsBudget(hw48, STOCK, m.id, ctx)));
    expect(rows(result).map((c) => c.modelId).sort()).toEqual(fitting.map((m) => m.id).sort());
    // The 122B fits at no context.
    expect(order(result).some((entry) => entry.startsWith('ornith-1.5'))).toBe(false);
  });

  it('would get the same model as "Best fit", with the estimated speed, had nobody tested it', async () => {
    const result = recommend(await macbook(), STOCK_UNTESTED, ALL_INSTALLED);
    expect(result.pick).toMatchObject({
      modelId: 'qwen3.6:35b-a3b',
      context: 131072,
      fit: 'tight',
      tested: false,
      // 16.9 x 307 / 100.
      tokensPerSecond: 51.9,
      // It only just fits, and the tag says so.
      tag: { kind: 'best-tight', label: 'Best fit, tight' },
    });
    expect(result.headline).toEqual({ text: 'Best fit for this Mac' });
    expect(result.notes).toEqual([{ text: 'Codeman has not run this on a Mac like this yet.' }]);
    expect(stringsIn(result).join(' ')).not.toMatch(/recommended/i);
  });

  it('keeps its measured speed when its chip is in no chips row', async () => {
    // The same Mac with the M5 Pro row removed: every ESTIMATE is gone, the measurement is not.
    const withoutChip = stockWith((catalog) => {
      catalog.chips = catalog.chips.filter((row) => row.match !== 'M5 Pro');
    });
    const result = recommend(await macbook(), withoutChip, ALL_INSTALLED);
    expect(result.pick).toMatchObject({ modelId: 'qwen3.6:35b-a3b', speed: 'ok', tokensPerSecond: 67.7, tested: true });
    // The others have no speed, so the model rank orders them.
    expect(result.alternatives.map((c) => [c.modelId, c.speed])).toEqual([
      ['qwen3.8:27b-mtp-q4_k_m', 'unknown'],
      ['qwen3.8:27b-q8_0', 'unknown'],
      ['qwen3.6:35b-a3b-mtp-q4_k_m', 'unknown'],
      ['muse-glimmer:30b-q4_k_m', 'unknown'],
      ['north-mini-code-1.0:q4_k_m', 'unknown'],
      ['mimo-v2.6:9b-q4_k_m', 'unknown'],
      ['ornith:9b-q4_k_m', 'unknown'],
      ['qwen3.5:9b-q4_k_m', 'unknown'],
    ]);
  });
});

describe('the Mac mini (Mac16,10: Apple M4, 16 GB)', () => {
  /**
   * Expected: `limited` with Ornith 1.0 9B at 65,536 tokens, a TIGHT fit, on the estimated
   * budget, and MiMo V2.6 9B at 65,536 tokens, also tight, once the runtime measured its budget.
   *
   * Why. The estimated budget is 9.67 GiB (10.4 GB: 2/3 of 16 GiB minus 1). A 9B on llama.cpp
   * needs its weights + 1.14 GB for a q8_0 K/V cache of 65,536 tokens + 2.55 GB beside them (its
   * recurrent state live and in 8 context checkpoints, the runner, and the 1 GiB prompt cache
   * the runtime allows). MiMo and its base are 6.55 GB (a vision projector of 0.92 GB
   * included): 10.2 GB, 0.987 of the estimate, just past the 0.98 a tight fit may reach. The
   * Ornith build has no projector, 5.63 GB: 9.3 GB, 0.898 of the estimate. The runtime measured
   * 11.8 GiB on this Mac; the 6 GiB reserve leaves 10 GiB (10.7 GB) of it, which admits all
   * three, and the rank puts MiMo first.
   *
   * Every figure of these rows is computed from the model's architecture, none was measured
   * (`needSource: 'estimated'`), and no 9B was ever run on such a Mac by us.
   */
  it('gets Ornith 1.0 9B at 65536 tokens on the estimated budget, tight: the other 9B builds need 0.987 of it', async () => {
    const hw = await macMini();
    expect(hw.chip).toBe('Apple M4');
    expect(hw.memClassGb).toBe(16);

    const result = recommend(hw, STOCK, ALL_INSTALLED);

    expect(result).toMatchObject({ verdict: 'limited', budgetSource: 'estimated' });
    expect(result.headline).toEqual({ text: LOCAL_MODEL_LABELS.headlineLimited });
    expect(result.notes).toEqual([{ text: LOCAL_MODEL_LABELS.noteUntested }]);
    // floor(17,179,869,184 x 2/3) - 1 GiB.
    expect(result.budgetBytes).toBe(10_379_504_298);
    expect(result.budgetGb).toBe('10.4');
    expect(result.pick).toMatchObject({
      modelId: 'ornith:9b-q4_k_m',
      modelLabel: 'Ornith 1.0 9B',
      license: 'MIT',
      context: 65536,
      cli: 'opencode',
      // 5,629,110,568 + 17,408 x 65,536 + 2,547,960,320.
      needBytes: 9_317_921_576,
      needGb: '9.3',
      memory: { modelBytes: 8_177_070_888, contextBytes: 1_140_850_688, peakBytes: 0 },
      downloadGb: '5.6',
      budgetShare: 0.898,
      fit: 'tight',
      // 9.3 x 120 / 100.
      speed: 'ok',
      tokensPerSecond: 11.2,
      tested: false,
      needSource: 'estimated',
      tag: { kind: 'best-tight', label: 'Best fit, tight' },
    });
    // It is the only model that fits, and only at this context: at 131072 it needs 10.5 GB.
    expect(order(result)).toEqual(['ornith:9b-q4_k_m@65536']);
    expect(modelFitsBudget(hw, STOCK, 'ornith:9b-q4_k_m', 131072)).toBe(false);
    const nineB = stockModel('mimo-v2.6:9b-q4_k_m');
    // 6,550,811,033 + 17,408 x 65,536 + 2,547,960,320.
    expect(needBytes(nineB, 65536)).toBe(10_239_622_041);
    expect(needBytes(nineB, 65536) / result.budgetBytes).toBeGreaterThan(FIT_TIGHT_MAX_SHARE);
    expect(needBytes(nineB, 65536) / result.budgetBytes).toBeLessThan(0.99);
  });

  it('would need 11.4 GB for MiMo at 131072 tokens, more than the whole budget', async () => {
    const hw = await macMini();
    const nineB = stockModel('mimo-v2.6:9b-q4_k_m');
    const budget = deviceBudget(hw).budgetBytes;
    expect(formatGb(needBytes(nineB, 131072))).toBe('11.4');
    expect(needBytes(nineB, 131072) / budget).toBeGreaterThan(1);
    expect(modelFitsBudget(hw, STOCK, 'mimo-v2.6:9b-q4_k_m', 131072)).toBe(false);
    expect(modelFitsBudget(hw, STOCK, 'mimo-v2.6:9b-q4_k_m', 65536)).toBe(false);
  });

  it('gets MiMo with the budget its runtime measured: at 65536 tokens, tight', async () => {
    // The runtime reported 11.8 GiB here; the 6 GiB reserve leaves 10 GiB (10.7 GB) of it.
    const result = recommend(await macMini(), STOCK, ALL_INSTALLED, { measuredTotalBytes: MACMINI_MEASURED_TOTAL });
    expect(result).toMatchObject({
      verdict: 'limited',
      budgetBytes: 10 * GIB,
      budgetGb: '10.7',
      budgetSource: 'measured',
    });
    expect(result.headline).toEqual({ text: LOCAL_MODEL_LABELS.headlineLimited });
    expect(result.notes).toEqual([{ text: LOCAL_MODEL_LABELS.noteUntested }]);
    expect(result.pick).toMatchObject({
      modelId: 'mimo-v2.6:9b-q4_k_m',
      modelLabel: 'MiMo V2.6 9B',
      license: 'MIT',
      context: 65536,
      cli: 'opencode',
      needBytes: 10_239_622_041,
      needGb: '10.2',
      memory: { modelBytes: 9_098_771_353, contextBytes: 1_140_850_688, peakBytes: 0 },
      budgetShare: 0.954,
      fit: 'tight',
      // 9.3 x 120 / 100.
      speed: 'ok',
      tokensPerSecond: 11.2,
      tested: false,
      needSource: 'estimated',
      tag: { kind: 'best-tight', label: 'Best fit, tight' },
    });
    // The other two 9B builds follow by rank. The Ornith build is small enough for 131072
    // tokens here (10.5 GB, 0.974), and a model is listed at the largest context it fits at.
    expect(order(result)).toEqual([
      'mimo-v2.6:9b-q4_k_m@65536',
      'ornith:9b-q4_k_m@131072',
      'qwen3.5:9b-q4_k_m@65536',
    ]);
  });

  it('gets the same with Claude Code as its only coding agent, which also needs 65536 tokens', async () => {
    const hw = await macMini();
    const estimated = recommend(hw, STOCK, [fact('claude')]);
    expect(estimated.verdict).toBe('limited');
    expect(estimated.pick).toMatchObject({ modelId: 'ornith:9b-q4_k_m', context: 65536, cli: 'claude' });
    const measured = recommend(hw, STOCK, [fact('claude')], { measuredTotalBytes: MACMINI_MEASURED_TOTAL });
    expect(measured.verdict).toBe('limited');
    expect(measured.pick).toMatchObject({ modelId: 'mimo-v2.6:9b-q4_k_m', context: 65536, cli: 'claude' });
  });
});

describe('every memory size, with the stock catalogue', () => {
  // What the stock catalogue answers today, from 8 to 512 GB, on chips that ship with each
  // size. A change of a catalogue row or of a threshold that moves one of these answers has to
  // change this table on purpose. docs/local-models.md has the same table for people.
  const EXPECTED: [soldGb: number, chip: string, answer: string][] = [
    // The smallest need at 65536 tokens is 9.3 GB; the budget is 2.1 GB.
    [8, 'Apple M2', 'none memory'],
    // The 9B build without a vision projector needs 9.3 GB at 65536 tokens, 0.898 of the 10.4 GB
    // estimate. The other two need 10.2 GB, 0.987: just out, until a runtime measures what a
    // real 16 GB Mac measured (see the Mac mini above). On an M1 (68 GB/s) a 9B is slow: 6.3.
    [16, 'Apple M4', 'limited ornith:9b-q4_k_m@65536 tight ok'],
    [16, 'Apple M1', 'limited ornith:9b-q4_k_m@65536 tight slow'],
    // 11.4 GB at 131072 tokens, 0.964 of 11.8 GB, and nothing of 12 billion fits: `limited`.
    [18, 'Apple M3 Pro', 'limited mimo-v2.6:9b-q4_k_m@131072 tight ok'],
    // On a base chip with 100 GB/s the 9B computes to 9.3 tokens per second: slow.
    [24, 'Apple M3', 'limited mimo-v2.6:9b-q4_k_m@131072 good slow'],
    [24, 'Apple M4', 'limited mimo-v2.6:9b-q4_k_m@131072 good ok'],
    [24, 'Apple M4 Pro', 'limited mimo-v2.6:9b-q4_k_m@131072 good ok'],
    // Muse Glimmer 30B fits at 65536 tokens: 21.2 GB, 0.970 of the 21.8 GB estimate. So a 32 GB
    // Mac is no small-model Mac (`ok`). The model is dense: on a base chip it computes to 3.5
    // tokens per second and the fast 9B stays the pick, on a Max chip (11.8) it is the pick.
    // North Mini Code needs 23.2 GB at 65536 tokens, 1.06 of the estimate: a runtime that
    // measures about 3/4 of the memory admits it (see below).
    [32, 'Apple M4', 'ok mimo-v2.6:9b-q4_k_m@131072 good ok'],
    [32, 'Apple M1 Max', 'ok muse-glimmer:30b-q4_k_m@65536 tight ok'],
    // A Max chip runs the dense 27B fast enough (12.1); an M3 Max (300 GB/s) does not (8.9),
    // and takes the 35B-A3B as a GGUF build, whose memory does not grow after it loaded. Both
    // at 131072 tokens, 0.966 and 0.971 of the budget.
    [36, 'Apple M4 Max', 'ok qwen3.8:27b-mtp-q4_k_m@131072 tight ok'],
    [36, 'Apple M3 Max', 'ok qwen3.6:35b-a3b-mtp-q4_k_m@131072 tight ok'],
    // The tested pair on the tested Mac; on a Pro chip the 27B is slow (8.1), so the same pick.
    [48, 'Apple M5 Pro', 'ok qwen3.6:35b-a3b@131072 tight ok'],
    [48, 'Apple M4 Pro', 'ok qwen3.6:35b-a3b@131072 tight ok'],
    // On a Max chip the 27B has the higher rank and holds its full window, 32.1 GB: 0.853.
    [48, 'Apple M4 Max', 'ok qwen3.8:27b-mtp-q4_k_m@262144 tight ok'],
    [64, 'Apple M4 Pro', 'ok qwen3.6:35b-a3b@131072 good ok'],
    [64, 'Apple M4 Max', 'ok qwen3.8:27b-mtp-q4_k_m@262144 good ok'],
    [96, 'Apple M3 Ultra', 'ok qwen3.8:27b-mtp-q4_k_m@262144 good ok'],
    // The 122B needs 97.4 GB at 131072 tokens (8 GiB of MLX prefix snapshots included): tight.
    [128, 'Apple M4 Max', 'ok ornith-1.5:122b@131072 tight ok'],
    [128, 'Apple M1 Ultra', 'ok ornith-1.5:122b@131072 tight ok'],
    [192, 'Apple M2 Ultra', 'ok ornith-1.5:122b@262144 good ok'],
    [256, 'Apple M3 Ultra', 'ok ornith-1.5:122b@262144 good ok'],
    // Nothing better than the 122B is listed (see the catalogue header for the 397B).
    [512, 'Apple M3 Ultra', 'ok ornith-1.5:122b@262144 good ok'],
  ];

  it.each(EXPECTED)('%i GB, %s: %s', (soldGb, chip, answer) => {
    const result = recommend(mac(soldGb, chip), STOCK, ALL_INSTALLED);
    const actual = result.pick
      ? `${result.verdict} ${result.pick.modelId}@${result.pick.context} ${result.pick.fit} ${result.pick.speed}`
      : `${result.verdict} ${result.reason}`;
    expect(actual).toBe(answer);
  });

  it('covers every memory size', () => {
    expect([...new Set(EXPECTED.map(([soldGb]) => soldGb))]).toEqual(MEMORY_SIZES);
  });

  it('tells an 8 GB Mac why in the plain sentence, with its memory size', () => {
    const result = recommend(mac(8, 'Apple M2'), STOCK, ALL_INSTALLED);
    expect(result.headline).toEqual({ text: LOCAL_MODEL_LABELS.noneMemory, vars: { memory: '8' } });
    // The smallest model a harness can work with needs more than four times the budget.
    const smallest = Math.min(...STOCK.models.map((m) => needBytes(m, 65536)));
    expect(formatGb(smallest)).toBe('9.3');
    expect(smallest / result.budgetBytes).toBeGreaterThan(4);
  });

  it('gives no model to 8 GB, a small model to every Mac from 16 to 24 GB, and every Mac from 36 GB a model of 27 billion or more', () => {
    for (const hw of SWEEP) {
      const result = recommend(hw, STOCK, ALL_INSTALLED);
      const label = `${hw.memClassGb} GB ${hw.chip}`;
      if (hw.memClassGb <= 8) expect(result.reason, label).toBe('memory');
      else if (hw.memClassGb <= 24) {
        expect(result.verdict, label).toBe('limited');
        expect(result.pick?.paramsB, label).toBe(9);
      } else if (hw.memClassGb === 32) {
        // A model of 30 billion fits, so the Mac is not `limited`. It is dense: the pick only
        // where it is not slow (a chip this file knows is fast, or one it knows nothing about).
        expect(result.verdict, label).toBe('ok');
        expect(rows(result).map((c) => c.modelId), label).toContain('muse-glimmer:30b-q4_k_m');
        expect(result.pick?.paramsB, label).toBe(hw.chip === 'Apple M4' ? 9 : 29.6);
        if (hw.chip === 'Apple M4') expect(result.notes[0], label).toEqual({ text: LOCAL_MODEL_LABELS.noteSmallPick });
      } else {
        expect(result.verdict, label).toBe('ok');
        expect(result.pick?.paramsB, label).toBeGreaterThanOrEqual(27);
      }
    }
  });

  it('gives a 32 GB Mac a model of 30 billion once its runtime measures what other Macs measured', () => {
    // The 16 GB and the 48 GB Mac both measured about 3/4 of their memory, more than the 2/3
    // the estimate assumes below 36 GB. 0.74 x 32 GiB lifts the budget to 25.4 GB.
    const measured = { measuredTotalBytes: Math.floor(0.74 * 32 * GIB) };
    const base = recommend(mac(32, 'Apple M4'), STOCK, ALL_INSTALLED, measured);
    expect(base.verdict).toBe('ok');
    // 24.1 GB at 131072 tokens, 0.950 of it; at 262144 tokens 26.0 GB would not fit.
    expect(base.pick).toMatchObject({ modelId: 'north-mini-code-1.0:q4_k_m', context: 131072, fit: 'tight' });
    // On a Max chip the 27B is fast enough, and it is the higher rank: 24.4 GB at 65536 tokens.
    const max = recommend(mac(32, 'Apple M1 Max'), STOCK, ALL_INSTALLED, measured);
    expect(max.pick).toMatchObject({ modelId: 'qwen3.8:27b-mtp-q4_k_m', context: 65536, fit: 'tight' });
  });

  it('always pairs the pick with the top-ranked harness, OpenCode', () => {
    for (const hw of SWEEP) {
      const result = recommend(hw, STOCK, ALL_INSTALLED);
      if (result.pick) expect(result.pick.cli).toBe('opencode');
    }
  });

  it('never offers an MLX build below 48 GB: its prefix snapshots alone are 8 GiB', () => {
    const mlx = new Set(STOCK.models.filter((m) => m.runner === 'mlx').map((m) => m.id));
    for (const hw of SWEEP.filter((swept) => swept.memClassGb < 48)) {
      for (const candidate of rows(recommend(hw, STOCK, ALL_INSTALLED))) {
        expect(mlx.has(candidate.modelId), `${hw.memClassGb} GB ${candidate.modelId}`).toBe(false);
      }
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
      const result = recommend(linux, RULES, ALL_INSTALLED);
      expectNone(result, 'not-macos', LOCAL_MODEL_LABELS.noneNotMacos);
      expect(result.headline.vars).toBeUndefined();
      expect(result.budgetBytes).toBe(0);
      expect(result.budgetGb).toBe('0.0');
      expect(result.budgetSource).toBe('estimated');
    });

    it('comes before every other reason', () => {
      for (const platform of ['linux', 'win32', 'freebsd']) {
        const hw = mac(8, 'Intel(R) Core(TM) i7', { platform, arch: 'x64', arm64: false, macosMajor: 12 });
        expect(recommend(hw, RULES, []).reason, platform).toBe('not-macos');
      }
    });
  });

  describe('intel', () => {
    const intelChip = 'Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz';

    it('answers so for an Intel Mac, whose sysctl has no arm64 flag', () => {
      const hw = without(mac(32, intelChip, { arch: 'x64' }), 'arm64', 'translated', 'wiredLimitMb');
      const result = recommend(hw, RULES, ALL_INSTALLED);
      expectNone(result, 'intel', 'Local coding models need Apple silicon, and this Mac has an Intel processor.');
      expect(result.budgetBytes).toBe(0);
      expect(result.budgetGb).toBe('0.0');
    });

    it('answers so when the arm64 flag reads 0', () => {
      const hw = without(mac(32, intelChip, { arch: 'x64', arm64: false }), 'translated');
      expect(recommend(hw, RULES, ALL_INSTALLED).reason).toBe('intel');
    });

    it('comes before the macOS version and the memory', () => {
      const hw = without(mac(8, intelChip, { arch: 'x64', macosMajor: 12, macosVersion: '12.7' }), 'arm64');
      expect(recommend(hw, RULES, []).reason).toBe('intel');
    });

    it('does not mistake Node under Rosetta for an Intel Mac', () => {
      // An x64 process on Apple silicon: the machine flag says arm64, the process is translated.
      const rosetta = mac(48, 'Apple M4 Max', { arch: 'x64', translated: true });
      expect(recommend(rosetta, RULES, ALL_INSTALLED).verdict).toBe('ok');
      // The same when only the translation flag was read.
      expect(recommend(without(rosetta, 'arm64'), RULES, ALL_INSTALLED).verdict).toBe('ok');
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
      expect(recommend(fallback('arm64', 'Apple M4 Max'), RULES, ALL_INSTALLED).verdict).toBe('ok');
      // An x64 process with an Apple chip name is Rosetta.
      expect(recommend(fallback('x64', 'Apple M4 Max'), RULES, ALL_INSTALLED).verdict).toBe('ok');
      // An x64 process with any other chip name is taken for an Intel Mac.
      expect(recommend(fallback('x64', intelChip), RULES, ALL_INSTALLED).reason).toBe('intel');
      expect(recommend(without(fallback('x64', intelChip), 'chip'), RULES, ALL_INSTALLED).reason).toBe('intel');
    });
  });

  describe('macos', () => {
    it('answers so below the catalogue minimum, naming both versions', () => {
      const result = recommend(
        mac(48, 'Apple M1 Max', { macosVersion: '13.6.7', macosMajor: 13 }),
        RULES,
        ALL_INSTALLED
      );
      expectNone(result, 'macos', 'Local models need macOS {minimum} or newer, and this Mac runs macOS {version}.');
      expect(result.headline.vars).toEqual({ version: '13.6.7', minimum: '14' });
      // The budget is still reported: the Mac itself is able.
      expect(result.budgetBytes).toBe(35 * GIB);
    });

    it('accepts the minimum itself and anything newer', () => {
      for (const macosMajor of [14, 15, 26, 27]) {
        const hw = mac(48, 'Apple M4 Max', { macosMajor, macosVersion: `${macosMajor}.0` });
        expect(recommend(hw, RULES, ALL_INSTALLED).verdict, String(macosMajor)).toBe('ok');
      }
    });

    it('does not block on a version that could not be read', () => {
      const hw = without(mac(48, 'Apple M4 Max'), 'macosMajor', 'macosVersion');
      expect(recommend(hw, RULES, ALL_INSTALLED).verdict).toBe('ok');
    });

    it('comes before the memory', () => {
      const hw = mac(8, 'Apple M1', { macosVersion: '12.7', macosMajor: 12 });
      expect(recommend(hw, RULES, ALL_INSTALLED).reason).toBe('macos');
    });
  });

  describe('memory', () => {
    it('answers so at 8 GB, where nothing fits at any context', () => {
      const result = recommend(mac(8, 'Apple M2'), RULES, ALL_INSTALLED);
      expectNone(
        result,
        'memory',
        'With {memory} GB of memory, this Mac cannot run a model that can drive a coding agent.'
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
      // The 24 GB case, with harnesses that are all present: the 9B fits at 32768 tokens.
      const hw = mac(24, 'Apple M4');
      const nineB = rulesModel('qwen3.5:9b');
      expect(needBytes(nineB, 32768) / deviceBudget(hw).budgetBytes).toBeCloseTo(0.9787, 4);
      expect(needBytes(nineB, 65536) / deviceBudget(hw).budgetBytes).toBeCloseTo(1.054, 4);

      const result = recommend(hw, RULES, ALL_INSTALLED);
      expectNone(result, 'memory', LOCAL_MODEL_LABELS.noneMemoryContext);
      // The need is the smallest one at a context a usable harness works at (the 9B at 65536),
      // not the 9B at 32768, which fits and which only the gated harness could use.
      expect(result.headline.vars).toEqual({ budget: '16.1', need: '17.0' });
      // Both figures are said as estimates ("about"), in one sentence.
      expect(result.headline.text).toBe(
        'This Mac can give a model about {budget} GB of memory, and the smallest model a coding agent can work with needs about {need} GB.'
      );
      expect(result.headline.text).not.toContain('{memory}');
    });

    it('would give that Mac the 9B at 32768 tokens, as a limited answer, once the gated harness is opened', () => {
      const ungated = rulesWith((catalog) => {
        catalog.harnesses = catalog.harnesses.map((row) => ({
          cli: row.cli,
          minContext: row.minContext,
          rank: row.rank,
        }));
      });
      const result = recommend(mac(24, 'Apple M4'), ungated, ALL_INSTALLED);
      expect(result.verdict).toBe('limited');
      expect(result.pick).toMatchObject({
        modelId: 'qwen3.5:9b',
        context: 32768,
        cli: 'pi',
        fit: 'tight',
        budgetShare: 0.979,
        speed: 'ok',
        // 9.3 x 1.2.
        tokensPerSecond: 11.2,
      });
      // Only the harness that works at 32768 tokens can run it there.
      expect(result.pick?.harnesses.map((h) => h.cli)).toEqual(['pi']);
    });

    it('says the same two numbers when the need is far above the budget', () => {
      // One model: 2 GiB at 1024 tokens (fits 10 GiB), 30 GiB at the context the harness needs.
      const catalog = catalogOf(
        [model('probe:1', { bytes: 2 * GIB, heldBytesPerToken: 1024, contexts: [28 * 1024 * 1024, 1024] })],
        [{ cli: 'alpha', minContext: 4096, rank: 1 }]
      );
      const hw = mac(16, 'Apple M4', { wiredLimitMb: 14000 });
      const result = recommend(hw, catalog, [fact('alpha')]);
      expectNone(result, 'memory', LOCAL_MODEL_LABELS.noneMemoryContext);
      // 2 GiB + 28 GiB held for the context = 30 GiB; the budget is 10 GiB.
      expect(result.headline.vars).toEqual({ budget: formatGb(10 * GIB), need: formatGb(30 * GIB) });
      expect(result.budgetSource).toBe('wired-limit');
    });

    it('falls back to the plain sentence when no model has a context a harness could use', () => {
      const catalog = catalogOf([model('probe:1')], [{ cli: 'alpha', minContext: 4096, rank: 1 }]);
      const result = recommend(bigMac, catalog, [fact('alpha')]);
      expectNone(result, 'memory', LOCAL_MODEL_LABELS.noneMemory);
      expect(result.headline.vars).toEqual({ memory: '48' });
    });

    it('comes before no-harness when nothing fits at all', () => {
      expect(recommend(mac(8, 'Apple M2'), RULES, []).reason).toBe('memory');
    });

    it('answers so for an empty catalogue', () => {
      expect(recommend(bigMac, catalogOf([]), [fact('alpha')]).reason).toBe('memory');
    });

    it('answers so when the memory size is unknown, without stating a size', () => {
      const hw = { ...mac(48, 'Apple M4 Max'), memBytes: 0, memGb: '0.0', memClassGb: 0 };
      const result = recommend(hw, RULES, ALL_INSTALLED);
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
      const result = recommend(bigMac, RULES, []);
      expectNone(result, 'no-harness', headline);
      expect(result.headline.vars).toBeUndefined();
      expect(result.budgetBytes).toBe(35 * GIB);
    });

    it('answers so when no harness is installed or installable', () => {
      const facts = RULES.harnesses.map((row) => fact(row.cli, { installed: false, installable: false }));
      expect(recommend(bigMac, RULES, facts).reason).toBe('no-harness');
    });

    it('answers so when only the gated harness is on the machine', () => {
      const gatedRows = RULES.harnesses.filter((row) => row.gated);
      expect(gatedRows).toHaveLength(1);
      expect(
        recommend(
          bigMac,
          RULES,
          gatedRows.map((row) => fact(row.cli))
        ).reason
      ).toBe('no-harness');
    });

    it('answers so when a harness is there but accepts no model id', () => {
      const facts = ALL_INSTALLED.map((entry) => ({ ...entry, acceptsModelId: () => false }));
      expect(recommend(bigMac, RULES, facts).reason).toBe('no-harness');
    });

    it('ignores a fact for a CLI that is not a catalogue harness', () => {
      expect(recommend(bigMac, RULES, [fact('codex'), fact('some-other-cli')]).reason).toBe('no-harness');
    });
  });

  describe('disk', () => {
    it('answers so when every fitting model would leave under 10 GiB free', () => {
      // 12 GiB free: even the smallest download (6.55 GB) leaves 5.9 GiB.
      const hw = mac(48, 'Apple M4 Max', { freeDiskBytes: 12 * GIB, freeDiskGb: formatGb(12 * GIB) });
      const result = recommend(hw, RULES, ALL_INSTALLED);
      // One sentence with the one number that says what to do.
      expectNone(
        result,
        'disk',
        'Free up about {missing} GB of disk space to install the smallest model that fits this Mac.'
      );
      // download + 10 GiB - free = 6,550,825,373 + 10,737,418,240 - 12,884,901,888 bytes.
      expect(result.headline.vars).toEqual({ missing: '4.4' });
      expect(result.budgetBytes).toBe(35 * GIB);
    });

    it('says what to free, counting the reserve: download + 10 GiB - free', () => {
      // 12 GB free is more than the 6.6 GB download: what is missing is the reserve on top of it.
      const hw = mac(32, 'Apple M4', { freeDiskBytes: 12 * GB, freeDiskGb: formatGb(12 * GB) });
      const vars = recommend(hw, RULES, ALL_INSTALLED).headline.vars as Record<string, string>;
      // 6,550,825,373 + 10,737,418,240 - 12,000,000,000 bytes.
      expect(vars).toEqual({ missing: '5.3' });
      expect(Number(vars.missing)).toBeCloseTo((6_550_825_373 + DISK_HEADROOM_BYTES - 12 * GB) / GB, 1);
    });

    it('names the smallest model that fits the MEMORY, not the smallest of the catalogue', () => {
      // On a 48 GB Mac whose harness refuses both 9B ids, the smallest candidate is gpt-oss:20b.
      const facts = ALL_INSTALLED.map((entry) => ({
        ...entry,
        acceptsModelId: (id: string) => !id.startsWith('qwen3.5:9b'),
      }));
      const hw = mac(48, 'Apple M4 Max', { freeDiskBytes: 12 * GIB, freeDiskGb: formatGb(12 * GIB) });
      const result = recommend(hw, RULES, facts);
      expect(result.reason).toBe('disk');
      // 13,793,441,427 + 10 GiB - 12 GiB: the 20B's download, not the 9B's.
      expect(result.headline.vars).toEqual({ missing: '11.6' });
    });

    it('drops only the models that do not leave 10 GiB, picks among the rest, and says what was left out', () => {
      // 20 GiB free: the 9B downloads (6.1 and 9.7 GiB) leave 10 GiB or more, the others do not.
      const hw = mac(48, 'Apple M4 Max', { freeDiskBytes: 20 * GIB, freeDiskGb: formatGb(20 * GIB) });
      const result = recommend(hw, RULES, ALL_INSTALLED);
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
        { text: 'Codeman has not run this on a Mac like this yet.' },
      ]);
    });

    it('turns on 0.8 GB of disk on the real MacBook without calling it a small-model Mac', async () => {
      // The cut for the 35B-A3B: its real download of 23,105,798,956 + 10 GiB = 33,843,217,196 bytes free.
      const hw = await macbook();
      const withFree = (bytes: number): HardwareFacts => ({
        ...hw,
        freeDiskBytes: bytes,
        freeDiskGb: formatGb(bytes),
      });

      const enough = recommend(withFree(34 * GB), RULES, ALL_INSTALLED);
      expect(enough.verdict).toBe('ok');
      expect(enough.pick?.modelId).toBe('qwen3.6:35b-a3b');
      expect(enough.notes).toEqual([]);

      const short = recommend(withFree(33 * GB), RULES, ALL_INSTALLED);
      expect(short.verdict).toBe('ok');
      // The tested model has no room, so nothing here is "Recommended".
      expect(short.headline.text).toBe(LOCAL_MODEL_LABELS.headlineOk);
      expect(short.pick?.modelId).toBe('qwen3.5:9b-q8_0');
      expect(order(short)).not.toContain('qwen3.6:35b-a3b@131072');
      expect(short.notes).toEqual([
        { text: LOCAL_MODEL_LABELS.noteSmallPick },
        { text: LOCAL_MODEL_LABELS.noteDiskDropped, vars: { model: 'Qwen3.6 35B-A3B', missing: '0.8' } },
        { text: LOCAL_MODEL_LABELS.noteUntested },
      ]);
      // The exact cut: one byte decides, and the note appears with the first missing byte.
      const cut = 23_105_798_956 + DISK_HEADROOM_BYTES;
      expect(cut).toBe(33_843_217_196);
      expect(recommend(withFree(cut), RULES, ALL_INSTALLED).pick?.modelId).toBe('qwen3.6:35b-a3b');
      expect(recommend(withFree(cut - 1), RULES, ALL_INSTALLED).pick?.modelId).toBe('qwen3.5:9b-q8_0');
    });

    it('on the real MacBook with the stock catalogue, falls back to the same model as a GGUF build', async () => {
      const hw = await macbook();
      const withFree = (bytes: number): HardwareFacts => ({ ...hw, freeDiskBytes: bytes, freeDiskGb: formatGb(bytes) });
      // Enough for the tested pair; the Q8 27B (30.0 GB) fits the memory and not the disk, and says so.
      const enough = recommend(withFree(34 * GB), STOCK, ALL_INSTALLED);
      expect(enough.pick).toMatchObject({ modelId: 'qwen3.6:35b-a3b', tested: true });
      expect(enough.notes).toEqual([
        { text: LOCAL_MODEL_LABELS.noteDiskDropped, vars: { model: 'Qwen3.8 27B (Q8)', missing: '6.7' } },
      ]);
      // One byte short of the tested pair: its GGUF build (22.6 GB) still has room.
      const cut = 23_105_798_956 + DISK_HEADROOM_BYTES;
      expect(recommend(withFree(cut), STOCK, ALL_INSTALLED).pick?.modelId).toBe('qwen3.6:35b-a3b');
      const oneShort = recommend(withFree(cut - 1), STOCK, ALL_INSTALLED);
      expect(oneShort.pick?.modelId).toBe('qwen3.6:35b-a3b-mtp-q4_k_m');
      expect(oneShort.headline.text).toBe(LOCAL_MODEL_LABELS.headlineOk);
      // At 33 GB neither 35B-A3B build has room: North Mini Code, and the tested pair is named.
      const short = recommend(withFree(33 * GB), STOCK, ALL_INSTALLED);
      expect(short.verdict).toBe('ok');
      expect(short.pick?.modelId).toBe('north-mini-code-1.0:q4_k_m');
      expect(short.notes).toEqual([
        { text: LOCAL_MODEL_LABELS.noteDiskDropped, vars: { model: 'Qwen3.6 35B-A3B', missing: '0.8' } },
        { text: LOCAL_MODEL_LABELS.noteUntested },
      ]);
    });

    it('names the best-ranked model left out, also when the pick is not affected', () => {
      // 64 GB, M4 Max, 35 GB free: only the Q8 27B (30 GB) has no room. The pick stays the 27B.
      const hw = mac(64, 'Apple M4 Max', { freeDiskBytes: 35 * GB, freeDiskGb: '35.0' });
      const result = recommend(hw, RULES, ALL_INSTALLED);
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
        const texts = recommend(hw, RULES, ALL_INSTALLED).notes.map((note) => note.text);
        expect(texts).not.toContain(LOCAL_MODEL_LABELS.noteDiskDropped);
      }
    });

    it('allows a download that leaves exactly 10 GiB', () => {
      const exact = RULES.models[0].bytes + DISK_HEADROOM_BYTES;
      expect(DISK_HEADROOM_BYTES).toBe(10 * GIB);
      const fits = recommend(mac(32, 'Apple M4', { freeDiskBytes: exact }), RULES, ALL_INSTALLED);
      expect(fits.pick?.modelId).toBe('qwen3.5:9b');
      const short = recommend(mac(32, 'Apple M4', { freeDiskBytes: exact - 1 }), RULES, ALL_INSTALLED);
      expect(short.reason).toBe('disk');
    });

    it('does not block when the free disk is unknown', () => {
      const hw = without(mac(48, 'Apple M4 Max'), 'freeDiskBytes', 'freeDiskGb');
      expect(recommend(hw, RULES, ALL_INSTALLED).verdict).toBe('ok');
    });

    it('needs only the bytes of the free disk, not its text', () => {
      const hw = without(mac(48, 'Apple M4 Max', { freeDiskBytes: 3 * GB }), 'freeDiskGb');
      // 6,550,825,373 + 10 GiB - 3 GB.
      expect(recommend(hw, RULES, ALL_INSTALLED).headline.vars).toEqual({ missing: '14.3' });
    });

    it('comes after the memory and the harness', () => {
      const fullDisk = { freeDiskBytes: 0, freeDiskGb: '0.0' };
      expect(recommend(mac(16, 'Apple M4', fullDisk), RULES, ALL_INSTALLED).reason).toBe('memory');
      expect(recommend(mac(48, 'Apple M4 Max', fullDisk), RULES, []).reason).toBe('no-harness');
      expect(recommend(mac(48, 'Apple M4 Max', fullDisk), RULES, ALL_INSTALLED).reason).toBe('disk');
    });
  });
});

// ---------- 4. Verdicts, ranking, harnesses, tested, rows ----------

describe('verdict limited', () => {
  it('is the answer when no model that fits has 12 billion parameters or more', () => {
    expect(LIMITED_BELOW_PARAMS_B).toBe(12);
    const result = recommend(mac(32, 'Apple M4'), RULES, ALL_INSTALLED);
    expect(result.verdict).toBe('limited');
    expect(result.reason).toBeUndefined();
    expect(result.pick).toMatchObject({ modelId: 'qwen3.5:9b', paramsB: 9, context: 65536, fit: 'good' });
    expect(result.headline).toEqual({
      text: 'This Mac can run a small model. It handles small edits and questions. It does not replace a cloud model.',
    });
    expect(result.notes).toEqual([{ text: 'Codeman has not run this on a Mac like this yet.' }]);
  });

  it('holds when the pick is a tight fit too (32 GB with a fast chip)', () => {
    const result = recommend(mac(32, 'Apple M1 Max'), RULES, ALL_INSTALLED);
    expect(result.verdict).toBe('limited');
    expect(result.pick).toMatchObject({
      modelId: 'qwen3.5:9b-q8_0',
      fit: 'tight',
      fitLabel: 'Tight',
      budgetShare: 0.956,
    });
    expect(result.alternatives.map((c) => c.modelId)).toEqual(['qwen3.5:9b']);
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
    // 36 GB: the 20B fits as Tight and has no speed figure, so a 9B is the pick. The Mac can
    // still run a 20B, so "This Mac can run a small model" would be false of it.
    const result = recommend(mac(36, 'Apple M4 Max'), RULES, ALL_INSTALLED);
    expect(result.pick).toMatchObject({ modelId: 'qwen3.5:9b-q8_0', paramsB: 9, fit: 'good', speed: 'ok' });
    expect(result.alternatives.map((c) => [c.modelId, c.fit, c.speed])).toEqual([
      ['qwen3.5:9b', 'good', 'ok'],
      ['gpt-oss:20b', 'tight', 'unknown'],
    ]);
    expect(result.verdict).toBe('ok');
    expect(result.headline).toEqual({ text: 'Best fit for this Mac' });
    // The pick is still called what it is.
    expect(result.notes).toEqual([
      {
        text: 'The best fit is a small model. It handles small edits and questions. It does not replace a cloud model.',
      },
      { text: 'Codeman has not run this on a Mac like this yet.' },
    ]);
  });

  it('does not depend on whether the chip is in the chips table', () => {
    // Knowing the chip must not change the verdict: it is about what fits, not about speed.
    const verdicts = [32, 36].map((soldGb) => [
      recommend(mac(soldGb, 'Apple M4 Max'), RULES, ALL_INSTALLED).verdict,
      recommend(mac(soldGb, 'Apple M6'), RULES, ALL_INSTALLED).verdict,
    ]);
    expect(verdicts).toEqual([
      ['limited', 'limited'],
      ['ok', 'ok'],
    ]);
  });

  it('is limited exactly when nothing with 12 billion parameters fits, on every Mac of the sweep', () => {
    for (const [name, catalog] of BOTH) {
      for (const hw of SWEEP) {
        const result = recommend(hw, catalog, ALL_INSTALLED);
        if (result.verdict === 'none') continue;
        const budget = deviceBudget(hw).budgetBytes;
        const largeFits = catalog.models.some(
          (m) =>
            m.paramsB >= LIMITED_BELOW_PARAMS_B &&
            m.contexts.some((ctx) => ctx >= 65536 && needBytes(m, ctx) / budget <= FIT_TIGHT_MAX_SHARE)
        );
        expect([name, hw.memClassGb, hw.chip, result.verdict]).toEqual([
          name,
          hw.memClassGb,
          hw.chip,
          largeFits ? 'ok' : 'limited',
        ]);
        // The small-pick note: under `ok` only, and exactly when the pick is small.
        const small = result.notes.some((note) => note.text === LOCAL_MODEL_LABELS.noteSmallPick);
        expect(small).toBe(result.verdict === 'ok' && (result.pick as Candidate).paramsB < LIMITED_BELOW_PARAMS_B);
      }
    }
  });

  it('counts only a large model a harness can really run', () => {
    // 48 GB, but the harnesses refuse every id but the two 9B ones: nothing large can be offered.
    const facts = ALL_INSTALLED.map((entry) => ({
      ...entry,
      acceptsModelId: (id: string) => id.startsWith('qwen3.5:9b'),
    }));
    const result = recommend(mac(48, 'Apple M4 Max'), RULES, facts);
    expect(result.verdict).toBe('limited');
    expect(result.headline.text).toBe(LOCAL_MODEL_LABELS.headlineLimited);
    // The headline says it, so the note does not repeat it.
    expect(result.notes).toEqual([{ text: LOCAL_MODEL_LABELS.noteUntested }]);
  });

  it('never says "Recommended", for any Mac', () => {
    for (const [, catalog] of BOTH) {
      for (const hw of SWEEP) {
        const result = recommend(hw, catalog, ALL_INSTALLED);
        if (result.verdict === 'limited') {
          expect(result.headline.text).toBe(LOCAL_MODEL_LABELS.headlineLimited);
          expect(stringsIn(result).join(' ')).not.toMatch(/recommended/i);
        }
      }
    }
  });
});

describe('speed', () => {
  it('is the model figure times the chip bandwidth, rounded to one decimal', () => {
    const result = recommend(mac(48, 'Apple M4 Max'), RULES, ALL_INSTALLED);
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
      const result = recommend(mac(48, chip), RULES, ALL_INSTALLED);
      const gptOss = rows(result).find((c) => c.modelId === 'gpt-oss:20b');
      expect(gptOss, chip).toMatchObject({ speed: 'unknown', speedLabel: 'Speed unknown' });
      expect(gptOss).not.toHaveProperty('tokensPerSecond');
    }
  });

  it('is unknown for every model on a chip that is in no chips row: no bandwidth is guessed', () => {
    for (const chip of ['Apple M6', 'Apple M6 Pro', 'Apple M10', 'Some Future Chip']) {
      const result = recommend(mac(64, chip), RULES, ALL_INSTALLED);
      for (const candidate of rows(result)) {
        expect(candidate, chip).toMatchObject({ speed: 'unknown', speedLabel: 'Speed unknown' });
        expect(candidate).not.toHaveProperty('tokensPerSecond');
      }
    }
    // And when the chip name itself is missing.
    const result = recommend(without(mac(64, 'x'), 'chip'), RULES, ALL_INSTALLED);
    expect(result.pick?.speed).toBe('unknown');
  });

  it('is the speed that was measured, for a row tested on a Mac like this', () => {
    const entry = (tokensPerSecond?: number): TestedOn => ({
      chip: 'Apple M4 Max',
      memGb: 128,
      cli: 'alpha',
      date: '2026-11-06',
      ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
    });
    const pickOf = (tested: TestedOn[]): Candidate | undefined =>
      recommend(HUNDRED_GIB_MAC, catalogOf([model('probe:1', { speedPer100Gbps: 5, tested })]), [fact('alpha')]).pick;
    // The estimate: 5 x 4.
    expect(pickOf([])).toMatchObject({ tested: false, tokensPerSecond: 20 });
    // The measurement replaces it, and is graded like any speed.
    expect(pickOf([entry(33.33)])).toMatchObject({ tested: true, speed: 'ok', tokensPerSecond: 33.3 });
    expect(pickOf([entry(4)])).toMatchObject({ tested: true, speed: 'slow', speedLabel: 'Slow', tokensPerSecond: 4 });
    // A tested entry without a speed keeps the estimate.
    expect(pickOf([entry()])).toMatchObject({ tested: true, tokensPerSecond: 20 });
    // An entry for another Mac changes nothing.
    expect(pickOf([{ ...entry(99), memGb: 64 }])).toMatchObject({ tested: false, tokensPerSecond: 20 });
  });
});

describe('the ranking', () => {
  it('puts ok before unknown before slow, ahead of the model rank', () => {
    // Three models that fit. The ranks run AGAINST the speed.
    const catalog = catalogOf([
      model('slow-top:1', { rank: 3, speedPer100Gbps: 1 }),
      model('unknown-mid:1', { rank: 2 }),
      model('ok-low:1', { rank: 1, speedPer100Gbps: 5 }),
    ]);
    const result = recommend(HUNDRED_GIB_MAC, catalog, [fact('alpha')]);
    expect(order(result)).toEqual(['ok-low:1@1024', 'unknown-mid:1@1024', 'slow-top:1@1024']);
    expect(rows(result).map((c) => c.speed)).toEqual(['ok', 'unknown', 'slow']);
  });

  it('ranks by model rank alone when every speed is unknown', () => {
    // 'Apple M6' is in no chips row.
    const result = recommend(mac(48, 'Apple M6'), RULES, ALL_INSTALLED);
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
    const result = recommend(mac(48, 'Apple M4 Pro'), RULES, ALL_INSTALLED);
    expect(rows(result).map((c) => [c.modelId, c.speed])).toEqual([
      ['qwen3.6:35b-a3b', 'ok'],
      ['qwen3.5:9b-q8_0', 'ok'],
      ['qwen3.5:9b', 'ok'],
      ['gpt-oss:20b', 'unknown'],
      ['qwen3.8:27b', 'slow'],
    ]);
  });

  it('does not sort by the fit grade: a tight model of the higher rank stays above a good one', () => {
    // The need is the peak at the full context, so a tight fit is a model that runs. Both are
    // equally fast here; the rank decides, and the row says Tight.
    const catalog = catalogOf([
      modelNeeding('tight-top:1', 0.9 * HUNDRED_GIB, { rank: 9, speedPer100Gbps: 5 }),
      modelNeeding('good-low:1', 0.5 * HUNDRED_GIB, { rank: 1, speedPer100Gbps: 5 }),
    ]);
    const result = recommend(HUNDRED_GIB_MAC, catalog, [fact('alpha')]);
    expect(order(result)).toEqual(['tight-top:1@1024', 'good-low:1@1024']);
    expect(rows(result).map((c) => c.fit)).toEqual(['tight', 'good']);
  });

  it('still puts the speed first: a good and fast model beats a tight and slow one of the higher rank', () => {
    const catalog = catalogOf([
      modelNeeding('tight-slow-top:1', 0.9 * HUNDRED_GIB, { rank: 9, speedPer100Gbps: 1 }),
      modelNeeding('good-fast-low:1', 0.5 * HUNDRED_GIB, { rank: 1, speedPer100Gbps: 5 }),
    ]);
    expect(order(recommend(HUNDRED_GIB_MAC, catalog, [fact('alpha')]))).toEqual([
      'good-fast-low:1@1024',
      'tight-slow-top:1@1024',
    ]);
  });

  it('takes the higher model rank among equals', () => {
    const catalog = catalogOf([model('low:1', { rank: 1 }), model('high:1', { rank: 5 }), model('mid:1', { rank: 3 })]);
    expect(order(recommend(HUNDRED_GIB_MAC, catalog, [fact('alpha')]))).toEqual([
      'high:1@1024',
      'mid:1@1024',
      'low:1@1024',
    ]);
  });

  it('takes the larger context of one model when both fit', () => {
    // 1 KiB held per token: 4 GiB at 4,194,304 tokens, still a good fit.
    const catalog = catalogOf([model('probe:1', { heldBytesPerToken: 1024, contexts: [4_194_304, 1024] })]);
    const result = recommend(HUNDRED_GIB_MAC, catalog, [fact('alpha')]);
    expect(result.pick?.context).toBe(4_194_304);
    expect(result.alternatives).toEqual([]);
  });

  it('offers a model at the largest context it fits at, also when that fit is tight', () => {
    // Good at the small context (0.8), tight at the large one (80 + 8 GiB = 0.88): the large one.
    const catalog = catalogOf([
      model('probe:1', { bytes: 80 * GIB, heldBytesPerToken: 1024, contexts: [8_388_608, 1024] }),
    ]);
    const result = recommend(HUNDRED_GIB_MAC, catalog, [fact('alpha')]);
    expect(result.pick).toMatchObject({ context: 8_388_608, fit: 'tight', budgetShare: 0.88 });
  });

  it('steps a model down only when the larger context does not fit at all', () => {
    // 92 + 8 GiB is the whole budget (out); at 1024 tokens it is 0.92.
    const catalog = catalogOf([
      model('probe:1', { bytes: 92 * GIB, heldBytesPerToken: 1024, contexts: [8_388_608, 1024] }),
    ]);
    const result = recommend(HUNDRED_GIB_MAC, catalog, [fact('alpha')]);
    expect(result.pick).toMatchObject({ context: 1024, fit: 'tight', budgetShare: 0.92 });
  });

  it('lists each model once, never the pick again, and every model that fits', () => {
    // The bound is above what either catalogue holds, so nothing that fits is cut off.
    expect(MAX_ALTERNATIVES).toBe(11);
    for (const [, catalog] of BOTH) expect(catalog.models.length - 1).toBeLessThanOrEqual(MAX_ALTERNATIVES);
    // Seven models fit a 128 GB Mac: the pick and all six others are shown.
    const result = recommend(mac(128, 'Apple M5 Ultra'), RULES, ALL_INSTALLED);
    expect(result.alternatives).toHaveLength(6);
    const ids = rows(result).map((c) => c.modelId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const [, catalog] of BOTH) {
      for (const hw of SWEEP) {
        const swept = recommend(hw, catalog, ALL_INSTALLED);
        const sweptIds = rows(swept).map((c) => c.modelId);
        expect(new Set(sweptIds).size).toBe(sweptIds.length);
        expect(swept.alternatives.length).toBeLessThanOrEqual(MAX_ALTERNATIVES);
        // Every model that fits at a context a harness works at is on the list (the sweep's
        // Macs have 500 GB of free disk, so none is left out for room).
        const fitting = catalog.models.filter((m) =>
          m.contexts.some((ctx) => ctx >= 65536 && modelFitsBudget(hw, catalog, m.id, ctx))
        );
        expect([...sweptIds].sort(), `${hw.memClassGb} GB ${hw.chip}`).toEqual(fitting.map((m) => m.id).sort());
      }
    }
  });

  it('still cuts a list longer than the bound, and the install can only take what is listed', () => {
    // Fourteen models that all fit: the pick and MAX_ALTERNATIVES others, best rank first.
    const many = catalogOf(
      Array.from({ length: 14 }, (_, index) => modelNeeding(`m${index + 1}:x`, GIB, { rank: index + 1 }))
    );
    const result = recommend(HUNDRED_GIB_MAC, many, [fact('alpha')]);
    expect(rows(result)).toHaveLength(1 + MAX_ALTERNATIVES);
    expect(rows(result)[0].modelId).toBe('m14:x');
    expect(rows(result).at(-1)?.modelId).toBe('m3:x');
  });
});

describe('harnesses', () => {
  const hw = mac(48, 'Apple M4 Max');

  it('never chooses a gated harness, even when it is the only one that could run a model', () => {
    // The rule is tested on the rules catalogue, which gates one harness. The stock catalogue
    // gates none since 2026-11-10; the sweep still runs on it, so a row gated again is covered.
    expect(RULES.harnesses.filter((row) => row.gated).map((row) => row.cli)).toEqual(['pi']);
    expect(STOCK.harnesses.filter((row) => row.gated)).toEqual([]);
    for (const [, catalog] of BOTH) {
      const gated = catalog.harnesses.filter((row) => row.gated).map((row) => row.cli);
      for (const swept of SWEEP) {
        const result = recommend(swept, catalog, ALL_INSTALLED);
        for (const candidate of rows(result)) {
          expect(gated).not.toContain(candidate.cli);
          expect(candidate.harnesses.map((h) => h.cli).some((cli) => gated.includes(cli))).toBe(false);
        }
      }
    }
    // 24 GB: the gated harness alone works at 32768 tokens, where the 9B would fit. Still none.
    expect(recommend(mac(24, 'Apple M4'), RULES, ALL_INSTALLED).verdict).toBe('none');
  });

  it('never offers a context below the minimum of the harness', () => {
    for (const [, catalog] of BOTH) {
      for (const swept of SWEEP) {
        const result = recommend(swept, catalog, ALL_INSTALLED);
        for (const candidate of rows(result)) {
          for (const harness of candidate.harnesses) {
            const row = catalog.harnesses.find((entry) => entry.cli === harness.cli);
            expect(candidate.context).toBeGreaterThanOrEqual(row?.minContext ?? Number.POSITIVE_INFINITY);
          }
        }
      }
    }
  });

  it('takes the higher-ranked harness and reports its label and that it is installed', () => {
    const result = recommend(hw, RULES, ALL_INSTALLED);
    expect(result.pick).toMatchObject({ cli: 'opencode', cliLabel: 'OpenCode', cliInstalled: true });
    expect(result.pick).not.toHaveProperty('slowFirstTurn');
  });

  it('falls back to the next harness when the first is not on the machine, and flags its slow first turn', () => {
    const facts = [fact('opencode', { installed: false, installable: false }), fact('claude'), fact('pi')];
    const result = recommend(hw, RULES, facts);
    expect(result.pick).toMatchObject({
      modelId: 'qwen3.8:27b',
      cli: 'claude',
      cliLabel: 'Claude Code',
      cliInstalled: true,
      slowFirstTurn: true,
    });
    // The same when the caller has no fact for it at all.
    expect(recommend(hw, RULES, [fact('claude')]).pick?.cli).toBe('claude');
  });

  it('offers a harness that is not installed but can be, and says it is not installed', () => {
    const facts = [fact('opencode', { installed: false, installable: true }), fact('claude')];
    const result = recommend(hw, RULES, facts);
    expect(result.pick).toMatchObject({ cli: 'opencode', cliInstalled: false });
  });

  it('pairs a model only with a harness that accepts its id', () => {
    const refusing27b = (id: string): boolean => id !== 'qwen3.8:27b';
    // OpenCode refuses the 27B: it goes with the next harness.
    const one = recommend(hw, RULES, [fact('opencode', { acceptsModelId: refusing27b }), fact('claude')]);
    expect(one.pick).toMatchObject({ modelId: 'qwen3.8:27b', cli: 'claude' });
    expect(one.pick?.harnesses.map((h) => h.cli)).toEqual(['claude']);
    expect(one.alternatives[0]).toMatchObject({ modelId: 'qwen3.6:35b-a3b', cli: 'opencode' });
    // Both refuse it: the model is not offered.
    const both = recommend(hw, RULES, [
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
    const result = recommend(hw, RULES, [throwing, fact('claude')]);
    expect(result.verdict).toBe('ok');
    expect(result.pick?.cli).toBe('claude');
    expect(recommend(hw, RULES, [throwing]).reason).toBe('no-harness');
  });

  it('puts the model before the harness rank, and pairs it with the best harness that can run it', () => {
    // `big` needs a large context and is the higher-ranked harness; `small` works from 1024.
    const harnesses: LocalHarnessEntry[] = [
      { cli: 'big', minContext: 8_388_608, rank: 2 },
      { cli: 'small', minContext: 1024, rank: 1 },
    ];
    // Fits at both contexts (tight at the large one): the higher-ranked harness, at the
    // context it needs. Both harnesses can run it there.
    const fitsAtLarge = catalogOf(
      [model('probe:1', { bytes: 80 * GIB, heldBytesPerToken: 1024, contexts: [8_388_608, 1024] })],
      harnesses
    );
    const large = recommend(HUNDRED_GIB_MAC, fitsAtLarge, [fact('big'), fact('small')]).pick;
    expect(large).toMatchObject({ cli: 'big', context: 8_388_608, fit: 'tight' });
    expect(large?.harnesses.map((h) => h.cli)).toEqual(['big', 'small']);
    // Does not fit at the large context: only `small` can run it, at the small one.
    const onlyAtSmall = catalogOf(
      [model('probe:1', { bytes: 92 * GIB, heldBytesPerToken: 1024, contexts: [8_388_608, 1024] })],
      harnesses
    );
    const small = recommend(HUNDRED_GIB_MAC, onlyAtSmall, [fact('big'), fact('small')]).pick;
    expect(small).toMatchObject({ cli: 'small', context: 1024 });
    expect(small?.harnesses.map((h) => h.cli)).toEqual(['small']);
    // A higher-ranked MODEL with the lower-ranked harness still comes before a lower-ranked
    // model with the higher-ranked harness.
    const twoModels = catalogOf(
      [
        model('top:1', { rank: 2, contexts: [1024] }),
        model('low:1', { rank: 1, heldBytesPerToken: 1024, contexts: [8_388_608] }),
      ],
      harnesses
    );
    expect(
      rows(recommend(HUNDRED_GIB_MAC, twoModels, [fact('big'), fact('small')])).map((c) => [c.modelId, c.cli])
    ).toEqual([
      ['top:1', 'small'],
      ['low:1', 'big'],
    ]);
  });
});

describe('the tested flag and the word "Recommended"', () => {
  const testedOn = (chip: string, memGb: number, cli: string): TestedOn => ({ chip, memGb, cli, date: '2026-11-06' });
  /** The untested catalogue with one tested entry on the dense 27B. */
  const with27bTested = (chip: string, memGb: number, cli: string): LocalModelCatalog =>
    rulesWith((catalog) => {
      for (const row of catalog.models) row.tested = [];
      (catalog.models.find((m) => m.id === 'qwen3.8:27b') as LocalModelEntry).tested = [testedOn(chip, memGb, cli)];
    });

  it('is on for exactly one kind of Mac in the stock catalogue: an Apple M5 Pro with 48 GB', () => {
    expect(STOCK.models.flatMap((m) => m.tested.map((entry) => [m.id, entry.chip, entry.memGb, entry.cli]))).toEqual([
      ['qwen3.6:35b-a3b', 'Apple M5 Pro', 48, 'opencode'],
    ]);

    const tested = recommend(mac(48, 'Apple M5 Pro'), STOCK, ALL_INSTALLED);
    expect(tested.pick).toMatchObject({ modelId: 'qwen3.6:35b-a3b', cli: 'opencode', tested: true });
    expect(tested.headline.text).toBe('Recommended for this Mac');

    // The same chip with another memory size, and the same memory size with another chip.
    const others = [
      ...SWEEP,
      mac(24, 'Apple M5 Pro'),
      mac(64, 'Apple M5 Pro'),
      mac(48, 'Apple M4 Pro'),
      mac(48, 'Apple M5 Max'),
      mac(48, 'Apple M5'),
    ];
    for (const hw of others) {
      const result = recommend(hw, STOCK, ALL_INSTALLED);
      for (const candidate of rows(result)) expect(candidate.tested, `${hw.memClassGb} ${hw.chip}`).toBe(false);
      expect(stringsIn(result).join(' ')).not.toMatch(/recommended/i);
      if (result.verdict !== 'none') {
        // Always the last note; a small pick under `ok` has one more before it.
        expect(result.notes[result.notes.length - 1]).toEqual({ text: LOCAL_MODEL_LABELS.noteUntested });
      }
    }
  });

  it('is off for the tested Mac when its harness is not the tested one', () => {
    // The MacBook without OpenCode: the model is the same, the pair was not run by us.
    const result = recommend(mac(48, 'Apple M5 Pro'), RULES, [fact('claude')]);
    expect(result.pick).toMatchObject({ modelId: 'qwen3.6:35b-a3b', cli: 'claude', tested: false });
    // So the speed is the estimate again, and nothing says "Recommended".
    expect(result.pick?.tokensPerSecond).toBe(41.8);
    expect(result.headline.text).toBe('Best fit for this Mac');
    expect(result.notes).toEqual([{ text: LOCAL_MODEL_LABELS.noteUntested }]);
  });

  it('turns on "Recommended for this Mac" when the pick was tested on exactly such a Mac', () => {
    const result = recommend(mac(48, 'Apple M4 Max'), with27bTested('Apple M4 Max', 48, 'opencode'), ALL_INSTALLED);
    expect(result.verdict).toBe('ok');
    expect(result.pick).toMatchObject({ modelId: 'qwen3.8:27b', cli: 'opencode', tested: true });
    expect(result.headline).toEqual({ text: 'Recommended for this Mac' });
    // The "not yet tested" note goes away with it.
    expect(result.notes).toEqual([]);
  });

  it('stays off when the chip or the memory size differs', () => {
    const hw = mac(48, 'Apple M4 Max');
    const cases: LocalModelCatalog[] = [
      with27bTested('Apple M4 Pro', 48, 'opencode'),
      with27bTested('Apple M4', 48, 'opencode'),
      with27bTested('Apple M4 Max', 64, 'opencode'),
    ];
    for (const catalog of cases) {
      const result = recommend(hw, catalog, ALL_INSTALLED);
      expect(result.pick).toMatchObject({ modelId: 'qwen3.8:27b', cli: 'opencode', tested: false });
      expect(result.headline).toEqual({ text: 'Best fit for this Mac' });
      expect(result.notes).toEqual([{ text: 'Codeman has not run this on a Mac like this yet.' }]);
    }
  });

  it('follows the tested harness: the pair that was run comes first, also against a higher-ranked harness', () => {
    // Tested with the second harness. Both are installed: the tested pair is the pick, and
    // the other harness stays selectable.
    const catalog = with27bTested('Apple M4 Max', 48, 'claude');
    const result = recommend(mac(48, 'Apple M4 Max'), catalog, ALL_INSTALLED);
    expect(result.pick).toMatchObject({ modelId: 'qwen3.8:27b', cli: 'claude', tested: true });
    expect(result.pick?.harnesses.map((h) => h.cli)).toEqual(['claude', 'opencode']);
    expect(result.headline.text).toBe('Recommended for this Mac');
    // Without the tested harness on the machine the pair is another one, and untested.
    expect(recommend(mac(48, 'Apple M4 Max'), catalog, [fact('opencode')]).pick).toMatchObject({
      cli: 'opencode',
      tested: false,
    });
  });

  it('ranks a tested model first: a measurement on this Mac beats the estimates of the others', () => {
    // On the M4 Pro the untested pick is the 35B-A3B, because the 27B is estimated as slow.
    const hw = mac(48, 'Apple M4 Pro');
    expect(recommend(hw, UNTESTED, ALL_INSTALLED).pick?.modelId).toBe('qwen3.6:35b-a3b');
    // Once the 27B was run on such a Mac, it is the pick, and the 35B-A3B is the first alternative.
    const result = recommend(hw, with27bTested('Apple M4 Pro', 48, 'opencode'), ALL_INSTALLED);
    expect(result.pick).toMatchObject({ modelId: 'qwen3.8:27b', tested: true, speed: 'slow' });
    expect(result.headline.text).toBe('Recommended for this Mac');
    expect(result.notes).toEqual([]);
    expect(result.alternatives[0]).toMatchObject({ modelId: 'qwen3.6:35b-a3b', tested: false });
  });

  it('never says "Recommended" for a limited answer, tested or not', () => {
    const catalog = rulesWith((stock) => {
      const row = stock.models.find((m) => m.id === 'qwen3.5:9b') as LocalModelEntry;
      row.tested = [testedOn('Apple M4', 32, 'opencode')];
    });
    const result = recommend(mac(32, 'Apple M4'), catalog, ALL_INSTALLED);
    expect(result.verdict).toBe('limited');
    expect(result.pick?.tested).toBe(true);
    expect(result.headline.text).toBe(LOCAL_MODEL_LABELS.headlineLimited);
    expect(stringsIn(result.headline).join(' ')).not.toMatch(/recommended/i);
    // It WAS tested, so the "not yet tested" note would be false.
    expect(result.notes).toEqual([]);
  });
});

describe('what each row of the chooser carries', () => {
  describe('the tag', () => {
    it('is "Best fit" on an untested pick and the first kind that applies on the others', () => {
      // 48 GB, M4 Max: the 27B is the pick; the 35B-A3B is tight; the two 9B rows are small;
      // gpt-oss:20b is none of these and has no tag.
      const result = recommend(mac(48, 'Apple M4 Max'), RULES, ALL_INSTALLED);
      expect(rows(result).map((c) => [c.modelId, c.tag ?? null])).toEqual([
        ['qwen3.8:27b', { kind: 'best', label: 'Best fit' }],
        ['qwen3.6:35b-a3b', { kind: 'tight', label: 'Tight' }],
        ['qwen3.5:9b-q8_0', { kind: 'small', label: 'Small model' }],
        ['qwen3.5:9b', { kind: 'small', label: 'Small model' }],
        ['gpt-oss:20b', null],
      ]);
      expect(result.alternatives[3]).not.toHaveProperty('tag');
    });

    it('says "Best fit, tight" on a pick that only just fits: the words must not say less than the bar', () => {
      const result = recommend(mac(48, 'Apple M4 Pro'), RULES, ALL_INSTALLED);
      expect(result.pick).toMatchObject({ fit: 'tight', tag: { kind: 'best-tight', label: 'Best fit, tight' } });
      // A pick with room says "Best fit" and nothing more.
      const roomy = recommend(mac(64, 'Apple M4 Max'), RULES, ALL_INSTALLED);
      expect(roomy.pick).toMatchObject({ fit: 'good', tag: { kind: 'best', label: 'Best fit' } });
    });

    it('says "Tested on a Mac like this" in place of every other tag', () => {
      // The MacBook's pick is tight and the pick, and says neither.
      expect(recommend(mac(48, 'Apple M5 Pro'), RULES, ALL_INSTALLED).pick?.tag).toEqual({
        kind: 'tested',
        label: 'Tested on a Mac like this',
      });
      // Two tested rows: the second is an alternative and says so too.
      const entry: TestedOn = { chip: 'Apple M4 Max', memGb: 128, cli: 'alpha', date: '2026-11-06' };
      const catalog = catalogOf([
        model('first:1', { rank: 2, tested: [entry] }),
        modelNeeding('second:1', 0.9 * HUNDRED_GIB, { rank: 1, paramsB: 9, speedPer100Gbps: 1, tested: [entry] }),
      ]);
      expect(rows(recommend(HUNDRED_GIB_MAC, catalog, [fact('alpha')])).map((c) => c.tag?.kind)).toEqual([
        'tested',
        'tested',
      ]);
    });

    it('orders the kinds: tight before slow before small', () => {
      const tagOfSecond = (overrides: Partial<LocalModelEntry>, need = 0.5 * HUNDRED_GIB): string | undefined => {
        const catalog = catalogOf([
          model('pick:1', { rank: 2, speedPer100Gbps: 5 }),
          modelNeeding('second:1', need, { rank: 1, speedPer100Gbps: 5, ...overrides }),
        ]);
        return recommend(HUNDRED_GIB_MAC, catalog, [fact('alpha')]).alternatives[0].tag?.kind;
      };
      // Tight, slow and small at once.
      expect(tagOfSecond({ speedPer100Gbps: 1, paramsB: 9 }, 0.9 * HUNDRED_GIB)).toBe('tight');
      // Slow and small.
      expect(tagOfSecond({ speedPer100Gbps: 1, paramsB: 9 })).toBe('slow');
      // Small only.
      expect(tagOfSecond({ paramsB: 9 })).toBe('small');
      expect(tagOfSecond({ paramsB: 11.9 })).toBe('small');
      // None of them: no tag. An unknown speed is not a tag either.
      expect(tagOfSecond({})).toBeUndefined();
      expect(tagOfSecond({ speedPer100Gbps: undefined })).toBeUndefined();
    });

    it('takes every tag text from the fixed list', () => {
      const texts = new Set<string>(Object.values(LOCAL_MODEL_TAG_LABELS));
      for (const [hw, catalog] of SWEEP_BOTH_AND_MACBOOK) {
        for (const candidate of rows(recommend(hw, catalog, ALL_INSTALLED))) {
          if (!candidate.tag) continue;
          expect(texts.has(candidate.tag.label)).toBe(true);
          expect(candidate.tag.label).toBe(LOCAL_MODEL_TAG_LABELS[candidate.tag.kind]);
        }
      }
    });

    it('gives exactly one row the pick tag, and it is the first', () => {
      for (const [hw, catalog] of SWEEP_BOTH) {
        const result = recommend(hw, catalog, ALL_INSTALLED);
        if (!result.pick) continue;
        // The pick's tag is the pick's alone: "Best fit", with ", tight" when it only just fits.
        expect(result.pick.tag?.kind).toBe(result.pick.fit === 'tight' ? 'best-tight' : 'best');
        expect(result.alternatives.some((c) => c.tag?.kind === 'best' || c.tag?.kind === 'best-tight')).toBe(false);
      }
    });
  });

  describe('the harnesses', () => {
    const hw = mac(48, 'Apple M4 Max');

    it('lists every harness that can run the model at its context, best first, the flat one first', () => {
      const result = recommend(hw, RULES, ALL_INSTALLED);
      for (const candidate of rows(result)) {
        expect(candidate.harnesses).toEqual([
          { cli: 'opencode', cliLabel: 'OpenCode', installed: true },
          { cli: 'claude', cliLabel: 'Claude Code', installed: true, slowFirstTurn: true },
        ]);
        expect(candidate.harnesses[0]).toMatchObject({
          cli: candidate.cli,
          cliLabel: candidate.cliLabel,
          installed: candidate.cliInstalled,
        });
      }
    });

    it('prints the install command of a harness that is not installed, and only of such a one', () => {
      const command = 'curl -fsSL https://example.com/install | bash';
      const facts = [
        fact('opencode', { installed: false, installable: true, installCommand: command }),
        // Installed: a command the caller knows is not shown.
        fact('claude', { installCommand: 'npm install -g something' }),
      ];
      expect(recommend(hw, RULES, facts).pick?.harnesses).toEqual([
        { cli: 'opencode', cliLabel: 'OpenCode', installed: false, installCommand: command },
        { cli: 'claude', cliLabel: 'Claude Code', installed: true, slowFirstTurn: true },
      ]);
      // Installable without a command the caller could name: listed, without the field.
      const bare = recommend(hw, RULES, [fact('opencode', { installed: false, installable: true })]);
      expect(bare.pick?.harnesses).toEqual([{ cli: 'opencode', cliLabel: 'OpenCode', installed: false }]);
    });

    it('leaves out a harness that refuses the model id or is not on the machine', () => {
      const facts = [
        fact('opencode', { acceptsModelId: (id: string) => id !== 'qwen3.8:27b' }),
        fact('claude', { installed: false, installable: false }),
      ];
      const result = recommend(hw, RULES, facts);
      for (const candidate of rows(result)) expect(candidate.harnesses.map((h) => h.cli)).toEqual(['opencode']);
      expect(order(result)).not.toContain('qwen3.8:27b@131072');
    });

    it('is never empty', () => {
      for (const [swept, catalog] of SWEEP_BOTH_AND_MACBOOK) {
        for (const candidate of rows(recommend(swept, catalog, ALL_INSTALLED))) {
          expect(candidate.harnesses.length).toBeGreaterThan(0);
          expect(new Set(candidate.harnesses.map((h) => h.cli)).size).toBe(candidate.harnesses.length);
        }
      }
    });
  });

  describe('the download of an install', () => {
    const hw = mac(48, 'Apple M4 Max');

    it('is the model alone once the runtime is installed', () => {
      for (const candidate of rows(recommend(hw, RULES, ALL_INSTALLED))) {
        expect(candidate.installBytes).toBe(candidate.downloadBytes);
        expect(candidate.installGb).toBe(candidate.downloadGb);
      }
    });

    it('adds the runtime archive to every row while the runtime is not installed', () => {
      const result = recommend(hw, RULES, ALL_INSTALLED, { runtimeDownloadBytes: RUNTIME_ARCHIVE_BYTES });
      for (const candidate of rows(result)) {
        expect(candidate.installBytes).toBe(candidate.downloadBytes + 185_971_671);
        expect(candidate.installGb).toBe(formatGb(candidate.installBytes));
      }
      // 17,741,871,939 + 185,971,671: reads 17.9 where the model alone reads 17.7.
      expect(result.pick).toMatchObject({ downloadGb: '17.7', installBytes: 17_927_843_610, installGb: '17.9' });
    });

    it('does not let it change which model is the pick, what fits, or the need', () => {
      const plain = recommend(hw, RULES, ALL_INSTALLED);
      const withRuntime = recommend(hw, RULES, ALL_INSTALLED, { runtimeDownloadBytes: RUNTIME_ARCHIVE_BYTES });
      const strip = (candidate: Candidate): Omit<Candidate, 'installBytes' | 'installGb'> => {
        const { installBytes: _bytes, installGb: _gb, ...rest } = candidate;
        return rest;
      };
      expect(rows(withRuntime).map(strip)).toEqual(rows(plain).map(strip));
    });

    it('ignores a runtime size that is no byte count', () => {
      for (const runtimeDownloadBytes of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
        const pick = recommend(hw, RULES, ALL_INSTALLED, { runtimeDownloadBytes }).pick as Candidate;
        expect(pick.installBytes, String(runtimeDownloadBytes)).toBe(pick.downloadBytes);
      }
    });
  });

  it('says whether the need of a row rests on a measurement of that model', () => {
    const result = recommend(mac(64, 'Apple M4 Max'), RULES, ALL_INSTALLED);
    expect(Object.fromEntries(rows(result).map((c) => [c.modelId, c.needSource]))).toEqual({
      'qwen3.8:27b': 'estimated',
      'qwen3.6:35b-a3b': 'measured',
      'qwen3.5:9b-q8_0': 'estimated',
      'qwen3.5:9b': 'estimated',
      'gpt-oss:20b': 'estimated',
      // Slow on this chip, so it was the sixth row: listed since the list holds every model.
      'qwen3.8:27b-q8_0': 'estimated',
    });
  });
});

describe('the measured budget, end to end', () => {
  it('re-runs the recommendation against what the runtime reported', async () => {
    const hw = await macbook();
    const estimated = recommend(hw, STOCK, ALL_INSTALLED);
    const measured = recommend(hw, STOCK, ALL_INSTALLED, { measuredTotalBytes: MACBOOK_MEASURED_TOTAL });
    expect([estimated.budgetSource, estimated.budgetGb]).toEqual(['estimated', '37.6']);
    expect([measured.budgetSource, measured.budgetGb]).toEqual(['measured', '40.2']);
    // The same models in the same order. The share of each changes, and one model steps up a
    // context: the 27B in 8 bits fits 65536 tokens under the estimate (0.975) and 131072 under
    // what the runtime reported (0.976).
    expect(rows(measured).map((c) => c.modelId)).toEqual(rows(estimated).map((c) => c.modelId));
    const stepped = order(estimated).filter((entry, index) => order(measured)[index] !== entry);
    expect(stepped).toEqual(['qwen3.8:27b-q8_0@65536']);
    expect(order(measured)).toContain('qwen3.8:27b-q8_0@131072');
    expect(rows(estimated).map((c) => c.budgetShare)).toEqual([
      0.957, 0.767, 0.692, 0.303, 0.278, 0.303, 0.853, 0.975, 0.576,
    ]);
    expect(rows(measured).map((c) => c.budgetShare)).toEqual([
      0.895, 0.717, 0.647, 0.283, 0.26, 0.283, 0.798, 0.976, 0.539,
    ]);
    for (const candidate of rows(measured)) {
      expect(candidate.budgetShare).toBeCloseTo(candidate.needBytes / MACBOOK_MEASURED_TOTAL, 3);
    }
  });

  it('can rule a model out that the estimate offered, and offer one the estimate ruled out', () => {
    const hw = mac(48, 'Apple M4 Pro');
    // The estimate (35 GiB) offers the 35B-A3B at 131072 tokens (0.957).
    expect(order(recommend(hw, RULES, ALL_INSTALLED))[0]).toBe('qwen3.6:35b-a3b@131072');
    expect(modelFitsBudget(hw, RULES, 'qwen3.6:35b-a3b', 131072)).toBe(true);
    // A runtime that reports only 33 GiB rules that context out (1.015), so the install job
    // stops before the download, and the recommendation steps the model down to 65536 (0.946).
    const lower = { measuredTotalBytes: 33 * GIB };
    expect(modelFitsBudget(hw, RULES, 'qwen3.6:35b-a3b', 131072, lower)).toBe(false);
    expect(modelFitsBudget(hw, RULES, 'qwen3.6:35b-a3b', 65536, lower)).toBe(true);
    expect(recommend(hw, RULES, ALL_INSTALLED, lower).pick).toMatchObject({
      modelId: 'qwen3.6:35b-a3b',
      context: 65536,
      budgetShare: 0.946,
    });
    // At 31 GiB it fits at no context and is not listed at all.
    const lowest = { measuredTotalBytes: 31 * GIB };
    expect(modelFitsBudget(hw, RULES, 'qwen3.6:35b-a3b', 65536, lowest)).toBe(false);
    expect(order(recommend(hw, RULES, ALL_INSTALLED, lowest)).some((entry) => entry.startsWith('qwen3.6'))).toBe(false);
    // On a 36 GB Mac the estimate (26 GiB) rules the 27B out at 65536 tokens; 27 GiB admits it.
    const small = mac(36, 'Apple M4 Max');
    expect(modelFitsBudget(small, RULES, 'qwen3.8:27b', 65536)).toBe(false);
    expect(modelFitsBudget(small, RULES, 'qwen3.8:27b', 65536, { measuredTotalBytes: 27 * GIB })).toBe(true);
  });
});

describe('the shape of the answer', () => {
  const labels = new Set<string>(Object.values(LOCAL_MODEL_LABELS));

  it('takes every sentence and label from the fixed list', () => {
    for (const [hw, catalog] of SWEEP_BOTH_AND_MACBOOK) {
      const result = recommend(hw, catalog, ALL_INSTALLED);
      expect(labels.has(result.headline.text)).toBe(true);
      for (const note of result.notes) expect(labels.has(note.text)).toBe(true);
      for (const candidate of rows(result)) {
        expect(labels.has(candidate.fitLabel)).toBe(true);
        if (candidate.speedLabel !== undefined) expect(labels.has(candidate.speedLabel)).toBe(true);
        expect(candidate.speedLabel === undefined).toBe(candidate.speed === 'ok');
        expect(candidate.tokensPerSecond === undefined).toBe(candidate.speed === 'unknown');
      }
    }
  });

  it('fills every placeholder of a headline and nothing else', () => {
    const answers = [
      recommend(mac(8, 'Apple M2'), RULES, ALL_INSTALLED),
      recommend(mac(48, 'Apple M4', { macosMajor: 13, macosVersion: '13.0' }), RULES, ALL_INSTALLED),
      recommend(mac(48, 'Apple M4', { freeDiskBytes: GB, freeDiskGb: '1.0' }), RULES, ALL_INSTALLED),
      recommend(mac(48, 'Apple M4'), RULES, []),
      recommend(mac(48, 'Apple M4'), RULES, ALL_INSTALLED),
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
      recommend(mac(24, 'Apple M4'), RULES, ALL_INSTALLED),
      recommend({ ...mac(48, 'Apple M4'), memBytes: 0, memGb: '0.0', memClassGb: 0 }, RULES, ALL_INSTALLED),
      recommend(mac(48, 'Apple M4', { freeDiskBytes: 20 * GIB, freeDiskGb: '21.5' }), RULES, ALL_INSTALLED)
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
    for (const [hw, catalog] of SWEEP_BOTH_AND_MACBOOK) {
      const result = recommend(hw, catalog, ALL_INSTALLED, { runtimeDownloadBytes: RUNTIME_ARCHIVE_BYTES });
      expect(result.budgetGb).toBe(formatGb(result.budgetBytes));
      for (const candidate of rows(result)) {
        expect(candidate.needGb).toBe(formatGb(candidate.needBytes));
        expect(candidate.downloadGb).toBe(formatGb(candidate.downloadBytes));
        expect(candidate.installGb).toBe(formatGb(candidate.installBytes));
        expect(candidate.budgetShare).toBeCloseTo(candidate.needBytes / result.budgetBytes, 3);
      }
      expect(JSON.stringify(result)).not.toMatch(/GiB|MiB/);
    }
  });

  it('adds up for a person: download, plus what the context and the runner take, is the need', () => {
    const result = recommend(mac(48, 'Apple M4 Max'), RULES, ALL_INSTALLED);
    const pick = result.pick as Candidate;
    // 17.7 GB of weights + 4.8 GB held for 131,072 tokens + 3 GB + 5 GB, all in decimal GB.
    expect(pick.downloadGb).toBe('17.7');
    expect(pick.needGb).toBe('30.6');
    expect(formatGb(pick.needBytes - pick.downloadBytes)).toBe('12.8');
    expect(result.budgetGb).toBe('37.6');
    expect(pick.needBytes).toBeLessThan(result.budgetBytes);
  });

  it('is plain JSON and has exactly the fields of its verdict', () => {
    const ok = recommend(mac(48, 'Apple M4 Max'), RULES, ALL_INSTALLED);
    expect(JSON.parse(JSON.stringify(ok))).toEqual(ok);
    expect(Object.keys(ok).sort()).toEqual(
      ['alternatives', 'budgetBytes', 'budgetGb', 'budgetSource', 'headline', 'notes', 'pick', 'verdict'].sort()
    );
    const none = recommend(mac(8, 'Apple M2'), RULES, ALL_INSTALLED);
    expect(JSON.parse(JSON.stringify(none))).toEqual(none);
    expect(Object.keys(none).sort()).toEqual(
      ['alternatives', 'budgetBytes', 'budgetGb', 'budgetSource', 'headline', 'notes', 'reason', 'verdict'].sort()
    );
  });

  it('gives every row the same fields, plus the ones that say something only sometimes', () => {
    const always = [
      'budgetShare',
      'cli',
      'cliInstalled',
      'cliLabel',
      'context',
      'downloadBytes',
      'downloadGb',
      'fit',
      'fitLabel',
      'harnesses',
      'installBytes',
      'installGb',
      'license',
      'memory',
      'modelId',
      'modelLabel',
      'needBytes',
      'needGb',
      'needSource',
      'paramsB',
      'speed',
      'tested',
    ];
    const sometimes = ['slowFirstTurn', 'speedLabel', 'tag', 'tokensPerSecond'];
    for (const [hw, catalog] of SWEEP_BOTH_AND_MACBOOK) {
      for (const candidate of rows(recommend(hw, catalog, ALL_INSTALLED))) {
        const keys = Object.keys(candidate);
        expect(keys.filter((key) => !sometimes.includes(key)).sort()).toEqual(always);
        for (const key of keys) expect((candidate as unknown as Record<string, unknown>)[key]).not.toBeUndefined();
      }
    }
  });

  it('is pure: frozen inputs are enough, and the same inputs give the same answer', () => {
    const hw = deepFreeze(mac(48, 'Apple M4 Pro'));
    const catalog = deepFreeze(structuredClone(RULES_LOCAL_MODEL_CATALOG));
    const facts = deepFreeze(ALL_INSTALLED.map((entry) => ({ ...entry })));
    const options = deepFreeze({ measuredTotalBytes: MACBOOK_MEASURED_TOTAL, runtimeDownloadBytes: 1 });
    const first = recommend(hw, catalog, facts, options);
    const second = recommend(hw, catalog, facts, options);
    expect(second).toEqual(first);
    expect(first.verdict).toBe('ok');
  });
});
