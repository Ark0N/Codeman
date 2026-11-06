/**
 * @fileoverview Types of the hardware-aware local model recommendation: what the server sees of
 * this Mac, the catalogue of models and harnesses, and the answer of `GET /api/local-model`.
 *
 * This stage is read-only: Codeman looks at the Mac and recommends. It downloads nothing,
 * installs nothing and writes no file.
 *
 * Who produces what:
 *  - `HardwareFacts`: src/local-model/hardware.ts (one bounded `sysctl` spawn, never throws).
 *  - `LocalModelCatalog` and its rows: src/config/local-model-catalog.ts (a compiled constant).
 *  - `HarnessFact`: src/local-model/harness-facts.ts (server only, read from the CLI registry at
 *    call time; it holds a function, so it never goes over HTTP).
 *  - `Recommendation`, `Candidate`, `DeviceBudget`: src/local-model/recommend.ts (pure).
 *  - `LocalModelStatus`: src/web/routes/local-model-routes.ts (the `data` of the GET).
 *
 * Three rules every producer and consumer follows:
 *
 * 1. ONE unit for a size a person reads: decimal GB, computed from bytes by `formatGb()` in
 *    src/local-model/format.ts. Every such size travels twice, as bytes (`needBytes`) and as the
 *    text to show (`needGb`, a number without the unit, such as '25.5'). The browser prints the
 *    text and never divides bytes itself. GiB appears only inside the budget math.
 * 2. Every sentence or label the SERVER chooses comes from `LOCAL_MODEL_LABELS` below, so the
 *    browser can translate it (`codemanT(text, vars)`) and its i18n test can list every string.
 *    Numbers are never spliced into a sentence here: they travel in `vars` and fill the
 *    `{placeholder}` slots.
 * 3. A CLI id is DATA (`LocalHarnessEntry.cli`, `Candidate.cli`). No code compares one with a
 *    literal: what differs between harnesses is a catalogue field or a `HarnessFact`.
 */

// ---------- Hardware ----------

/**
 * How `HardwareFacts` was obtained.
 *  - `sysctl`: the spawn answered and `hw.memsize` parsed.
 *  - `os-fallback`: on macOS, but the spawn failed or timed out; memory, architecture and the chip
 *    string come from `node:os`, the rest is absent.
 *  - `not-probed`: not macOS, so `sysctl` was never spawned.
 */
export type HardwareProbeSource = 'sysctl' | 'os-fallback' | 'not-probed';

/**
 * What the server knows about the machine it runs on. Plain JSON (it is part of the GET payload),
 * and always an answer: a failed probe yields the `os-fallback` or `not-probed` shape, never an
 * exception.
 */
export interface HardwareFacts {
  /** `process.platform` of the server. Anything but `darwin` ends in verdict `none`, reason `not-macos`. */
  platform: string;
  /** `os.arch()` of the server process. `x64` on Apple silicon means Node runs under Rosetta. */
  arch: string;
  /** `hw.optional.arm64` is 1: the MACHINE is Apple silicon whatever `arch` says. Absent when the key was not read. */
  arm64?: boolean;
  /** `sysctl.proc_translated` is 1: this process runs under Rosetta. Absent when the key was not read (Intel Macs lack it). */
  translated?: boolean;
  /** Installed memory in bytes (`hw.memsize`, else `os.totalmem()`). The ONLY memory input of the budget math. */
  memBytes: number;
  /** `memBytes` as a person reads it: decimal GB from `formatGb()`, without the unit ('17.2' for a Mac sold as 16 GB). */
  memGb: string;
  /** The memory size the Mac is sold as: whole binary gigabytes (16, 32, 48). Tier rules and `TestedOn.memGb` use it. */
  memClassGb: number;
  /** `machdep.cpu.brand_string` ('Apple M4 Pro'), else `os.cpus()[0].model`. */
  chip?: string;
  /** `hw.model` ('Mac16,10'). */
  model?: string;
  /** `kern.osproductversion` ('27.2'). */
  macosVersion?: string;
  /** The leading number of `macosVersion` (27). */
  macosMajor?: number;
  /** `iogpu.wired_limit_mb` exactly as reported. 0 means "not set" (both test Macs report 0); only a value above 0 is a limit. */
  wiredLimitMb?: number;
  /** Free bytes on the filesystem of Codeman's data dir (`statfs`: `bavail * bsize`). */
  freeDiskBytes?: number;
  /** `freeDiskBytes` as a person reads it (decimal GB, no unit). Present exactly when `freeDiskBytes` is. */
  freeDiskGb?: string;
  source: HardwareProbeSource;
}

// ---------- Catalogue ----------

/** One Mac a model and harness pair was really run on by us. A model row with a matching entry may be called "Recommended". */
export interface TestedOn {
  /** The chip, as `machdep.cpu.brand_string` reports it ('Apple M4'). */
  chip: string;
  /** The Mac's memory as it is sold (`HardwareFacts.memClassGb`: 16, 32, 48). */
  memGb: number;
  /** The harness it was tested with: a CLI registry id, as data. */
  cli: string;
  /** ISO date of the test ('2026-11-06'). */
  date: string;
}

/** One model of the catalogue. */
export interface LocalModelEntry {
  /** `name:tag` exactly as the model registry lists it. Lowercase, one colon, no slash (`LOCAL_MODEL_ID_PATTERN`). */
  id: string;
  /** The name a person reads ('Qwen3.8 27B'). */
  label: string;
  /** SPDX id of the license ('Apache-2.0'). */
  license: string;
  /** Parameter count in billions. Under 12 the verdict is `limited`, never `ok`. */
  paramsB: number;
  /** Size of the weights in bytes: both the download and what they take in memory. */
  bytes: number;
  /** Bytes of KV cache one token of context costs. */
  kvBytesPerToken: number;
  /** Context lengths (tokens) the model may be run at, largest first. */
  contexts: number[];
  /** Preference among models that fit: the HIGHER rank wins. A judgement, not a measurement. */
  rank: number;
  /** Measured tokens per second per 100 GB/s of memory bandwidth. Absent: the speed of this model is unknown. */
  speedPer100Gbps?: number;
  /** Macs this model was really run on. Empty today for every row. */
  tested: TestedOn[];
}

/** One harness (coding agent CLI) that can be connected to a local model. All of it is data. */
export interface LocalHarnessEntry {
  /** A CLI registry id. Data only: never compared with a literal anywhere. */
  cli: string;
  /** The smallest context (tokens) at which this harness works. */
  minContext: number;
  /** Preference among harnesses: the HIGHER rank wins. */
  rank: number;
  /** True: listed in the catalogue but never offered yet (its use with a local model is unverified). */
  gated?: boolean;
  /** True: the first answer takes minutes, because the harness sends a very large fixed prompt. */
  slowFirstTurn?: boolean;
}

/**
 * Memory bandwidth of one chip family. `LocalModelCatalog.chips` is ordered most specific first
 * ('M4 Max' before 'M4') and the first row that names `HardwareFacts.chip` wins. A row names a
 * chip when the chip string ENDS with its `match`, starting at the beginning or after a space,
 * case ignored (`chipNameMatches()` in src/config/local-model-catalog.ts): 'M4' is not the chip
 * of 'Apple M4 Pro', and a variant the table has never heard of ('Apple M6 Pro') matches no row.
 * A chip that matches no row has an UNKNOWN speed: a bandwidth is never guessed.
 */
export interface ChipEntry {
  /** The chip name the chip string must end with ('M4 Max'). */
  match: string;
  /** Memory bandwidth in GB/s. */
  gbps: number;
}

/**
 * Host memory the runtime's prompt cache takes, by the size of the Mac. Tiers are ordered by
 * `minMemGb` ascending and the last tier with `minMemGb <= HardwareFacts.memClassGb` applies.
 */
export interface PromptCacheTier {
  /** Smallest memory size (as sold, binary gigabytes) this tier applies to. The first tier has 0. */
  minMemGb: number;
  bytes: number;
}

/** The catalogue: a compiled constant, validated by `LocalModelCatalogSchema`. No override file, no download data. */
export interface LocalModelCatalog {
  schema: 1;
  /** ISO date the rows were last checked ('2026-11-06'). Reported as `LocalModelStatus.catalogUpdated`. */
  updated: string;
  /** Oldest macOS major version a local model runs on. Below it: verdict `none`, reason `macos`. */
  minMacosMajor: number;
  promptCacheTiers: PromptCacheTier[];
  models: LocalModelEntry[];
  harnesses: LocalHarnessEntry[];
  chips: ChipEntry[];
}

// ---------- Harness facts (server only) ----------

/**
 * What the server knows about one catalogue harness on this machine. Built from the CLI registry
 * at call time, so `recommend()` names no CLI. NOT serializable (it holds a function): it never
 * leaves the server. `Candidate` carries the parts a browser needs.
 */
export interface HarnessFact {
  /** The CLI registry id. */
  cli: string;
  /** The registry's display label ('OpenCode'). */
  label: string;
  /** The CLI's binary was found on this machine. */
  installed: boolean;
  /** Not installed, but the registry has an install command for this platform that needs no administrator rights. */
  installable: boolean;
  /** Whether this CLI can be launched with that model id (its command-line pattern accepts it). */
  acceptsModelId: (modelId: string) => boolean;
}

// ---------- Recommendation ----------

/** Need over budget: up to 0.85 is `good`, up to 0.98 is `tight`, above is `out`. */
export type FitGrade = 'good' | 'tight' | 'out';

/**
 * Expected generation speed. `unknown` when the chip is in no `ChipEntry` or the model has no
 * `speedPer100Gbps`. In the ranking `unknown` sits between `ok` and `slow`.
 */
export type SpeedGrade = 'ok' | 'slow' | 'unknown';

/**
 * Why the verdict is `none`.
 *  - `not-macos`: the server does not run on macOS (the card is hidden).
 *  - `intel`: a Mac without Apple silicon.
 *  - `memory`: no model fits the memory budget with any harness.
 *  - `disk`: models fit the memory, but for every one of them free disk minus the download is below 10 GiB.
 *  - `macos`: macOS is older than `LocalModelCatalog.minMacosMajor`.
 *  - `no-harness`: no catalogue harness is installed or installable and accepts a model.
 */
export type NoneReason = 'not-macos' | 'intel' | 'memory' | 'disk' | 'macos' | 'no-harness';

/** Where the device budget came from: a formula (`estimated`) or `iogpu.wired_limit_mb` above 0 (`wired-limit`). */
export type BudgetSource = 'estimated' | 'wired-limit';

/** The memory a model may use on this Mac. */
export interface DeviceBudget {
  /** L: the wired limit when above 0, else 2/3 of memory below 36 GB and 3/4 from 36 GB. */
  limitBytes: number;
  /** B = min(L - 1 GiB, memory - reserve). What `Candidate.budgetShare` is measured against. */
  budgetBytes: number;
  source: BudgetSource;
}

/**
 * Every sentence and label the server may put into the payload, in English (the i18n source
 * language). Frozen for the parallel build: the zh-CN dictionary in src/web/public/i18n.js has
 * one entry per value, keyed by this exact text, and the browser's i18n test imports this
 * constant to list them. Adding a key is fine; changing a text means changing its zh-CN key too.
 *
 * `{placeholder}` slots are filled by the browser from `LocalModelMessage.vars`. `{name}` is
 * taken (the translator fills it with the display name), so no slot here is called `name`.
 *
 * | Key           | Slots (all text; sizes are decimal GB without the unit)                         |
 * |---------------|---------------------------------------------------------------------------------|
 * | `noneMemory`  | `memory`: `HardwareFacts.memGb`                                                 |
 * | `noneDisk`    | `download`: smallest download among the models that fit the memory; `free`:     |
 * |               | `HardwareFacts.freeDiskGb`; `missing`: download + 10 GiB - free                 |
 * | `noneMacos`   | `version`: `HardwareFacts.macosVersion`; `minimum`: the catalogue's minimum     |
 *
 * The word "Recommended" exists only in `headlineTested`, which may be used only when the
 * pick's `tested` is true. No catalogue row has a tested entry today, so it is never sent.
 */
export const LOCAL_MODEL_LABELS = {
  /** Verdict `ok`, pick not tested by us on a Mac like this one. */
  headlineOk: 'Best fit for this Mac',
  /** Verdict `ok`, pick tested by us on a Mac like this one. */
  headlineTested: 'Recommended for this Mac',
  /** Verdict `limited`. */
  headlineLimited:
    'This Mac can run a small model. It handles small edits and questions. It does not replace a cloud model.',
  /** A note under an `ok` or `limited` pick whose `tested` is false. */
  noteUntested: 'Not yet tested by us on a Mac like this.',
  fitGood: 'Good',
  fitTight: 'Tight',
  speedSlow: 'Slow',
  speedUnknown: 'Speed unknown',
  noneNotMacos: 'Codeman recommends a local model only on a Mac with Apple silicon.',
  noneIntel: 'This Mac has an Intel processor. Local coding models need Apple silicon.',
  noneMemory:
    'This Mac has {memory} GB of memory. That is too little to run a model that can drive a coding agent, so Codeman recommends none here.',
  noneDisk:
    'Not enough free disk space. The smallest model that fits this Mac is a {download} GB download and {free} GB is free. Free up about {missing} GB.',
  noneMacos: 'This Mac runs macOS {version}. Local models need macOS {minimum} or newer.',
  noneNoHarness: 'No coding agent that Codeman can connect to a local model is available on this Mac.',
} as const;

/** One of the texts in `LOCAL_MODEL_LABELS`. The payload's label fields are typed with it, so an off-list string does not compile. */
export type LocalModelLabel = (typeof LOCAL_MODEL_LABELS)[keyof typeof LOCAL_MODEL_LABELS];

/** The headline of each `none` reason. */
export const LOCAL_MODEL_NONE_LABELS: Record<NoneReason, LocalModelLabel> = {
  'not-macos': LOCAL_MODEL_LABELS.noneNotMacos,
  intel: LOCAL_MODEL_LABELS.noneIntel,
  memory: LOCAL_MODEL_LABELS.noneMemory,
  disk: LOCAL_MODEL_LABELS.noneDisk,
  macos: LOCAL_MODEL_LABELS.noneMacos,
  'no-harness': LOCAL_MODEL_LABELS.noneNoHarness,
};

/** A sentence for the card: a text from `LOCAL_MODEL_LABELS` plus the values of its `{placeholder}` slots. */
export interface LocalModelMessage {
  text: LocalModelLabel;
  /** Slot values, already formatted as text. Absent when the text has no slot. */
  vars?: Record<string, string>;
}

/** One model at one context with one harness, measured against this Mac. Plain JSON. */
export interface Candidate {
  /** `LocalModelEntry.id`. */
  modelId: string;
  /** `LocalModelEntry.label`. */
  modelLabel: string;
  license: string;
  paramsB: number;
  /** Context length in tokens. */
  context: number;
  /** The harness: a CLI registry id, as data. */
  cli: string;
  /** The harness's display label, from the CLI registry. */
  cliLabel: string;
  /** False: the harness is not on this machine yet (it is installable, or it would not be a candidate). */
  cliInstalled: boolean;
  /** The harness row's `slowFirstTurn`. */
  slowFirstTurn?: boolean;
  /** F = weights + kvBytesPerToken * context + 1 GiB + prompt cache. */
  needBytes: number;
  /** `needBytes` as decimal GB text, no unit. */
  needGb: string;
  /** The model download in bytes (`LocalModelEntry.bytes`). */
  downloadBytes: number;
  /** `downloadBytes` as decimal GB text, no unit. */
  downloadGb: string;
  /** `needBytes / Recommendation.budgetBytes`, rounded to three decimals (0.83). The fit grade is decided on the unrounded ratio. */
  budgetShare: number;
  /** A candidate in a `Recommendation` is never `out`. */
  fit: Exclude<FitGrade, 'out'>;
  /** `fitGood` or `fitTight`. */
  fitLabel: LocalModelLabel;
  speed: SpeedGrade;
  /** `speedSlow` or `speedUnknown`. Absent when `speed` is `ok`. */
  speedLabel?: LocalModelLabel;
  /** Estimated generation speed. Present exactly when `speed` is not `unknown`. */
  tokensPerSecond?: number;
  /** A `TestedOn` entry of the model matches this Mac (same chip, same `memClassGb`) and this harness. */
  tested: boolean;
}

/**
 * The answer of `recommend()`.
 *  - `ok`: `pick` is the best candidate and its model has at least 12 billion parameters.
 *  - `limited`: `pick` is the best candidate, but its model has fewer than 12 billion parameters.
 *    The card says so and never says "Recommended".
 *  - `none`: no pick; `reason` says why.
 */
export interface Recommendation {
  verdict: 'ok' | 'limited' | 'none';
  /** Present exactly when `verdict` is `none`. */
  reason?: NoneReason;
  /** What the card says first: `headlineOk`, `headlineTested`, `headlineLimited` or the `none` reason's sentence. */
  headline: LocalModelMessage;
  /** Further sentences under the headline (`noteUntested` today). May be empty. */
  notes: LocalModelMessage[];
  /** Present exactly when `verdict` is `ok` or `limited`. */
  pick?: Candidate;
  /** The next models that fit (at most four, each at its best context and harness), best first. Empty when `verdict` is `none`. */
  alternatives: Candidate[];
  /** `DeviceBudget.budgetBytes`. 0 when no budget is computed: not macOS, or a Mac without Apple silicon. */
  budgetBytes: number;
  /** `budgetBytes` as decimal GB text, no unit. */
  budgetGb: string;
  budgetSource: BudgetSource;
}

// ---------- API ----------

/** The `data` of `GET /api/local-model`. Read-only; admin only in multi-user mode. */
export interface LocalModelStatus {
  hardware: HardwareFacts;
  recommendation: Recommendation;
  /** `LocalModelCatalog.updated`. */
  catalogUpdated: string;
}
