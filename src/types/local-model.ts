/**
 * @fileoverview Types of the hardware-aware local model recommendation: what the server sees of
 * this Mac, the catalogue of models and harnesses, and the recommendation part of the answer of
 * `GET /api/local-model`.
 *
 * Everything here is the READ side: Codeman looks at the Mac and recommends. The types of the
 * install (the job states, the progress, the `install` object of the GET, the request bodies,
 * the state file, the runtime pin) and `LocalModelStatus`, the whole `data` of the GET, are in
 * src/types/local-model-install.ts. Both files go out through the barrel (`../types.js`).
 *
 * Who produces what:
 *  - `HardwareFacts`: src/local-model/hardware.ts (one bounded `sysctl` spawn, never throws).
 *  - `LocalModelCatalog` and its rows: src/config/local-model-catalog.ts (a compiled constant).
 *  - `HarnessFact`: src/local-model/harness-facts.ts (server only, read from the CLI registry at
 *    call time; it holds a function, so it never goes over HTTP).
 *  - `Recommendation`, `Candidate`, `DeviceBudget`: src/local-model/recommend.ts (pure).
 *
 * A field that is optional here is optional by meaning, and its comment says when it is
 * absent (a tested entry without a measured speed, a harness that needs no install command, a
 * row without a tag). Everything else is always there, so the chooser window and the install
 * job may rely on it.
 *
 * Three rules every producer and consumer follows:
 *
 * 1. ONE unit for a computed size a person reads: decimal GB, computed from bytes by
 *    `formatGb()` in src/local-model/format.ts. Every such size travels twice, as bytes
 *    (`needBytes`) and as the text to show (`needGb`, a number without the unit, such as
 *    '25.5'). The browser prints the text and never divides bytes itself. GiB appears only
 *    inside the budget math. The one exception is the NAME of the installed memory: the card
 *    says `HardwareFacts.memClassGb` (48 for a Mac sold with 48 GB), see that field.
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
 *    string come from `node:os` and the free disk from `statfs`. What only sysctl knows (`arm64`,
 *    `translated`, `model`, `macosVersion`, `macosMajor`, `wiredLimitMb`) is absent.
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
  /**
   * `memBytes` in the unit of every computed size: decimal GB from `formatGb()`, without the unit
   * ('17.2' for a Mac sold as 16 GB). NOT what the card calls the installed memory: that is
   * `memClassGb`, see there.
   */
  memGb: string;
  /**
   * The memory size the Mac is sold as: whole binary gigabytes (16, 32, 48), 0 when the size is
   * unknown. Tier rules and `TestedOn.memGb` use it, and it is the ONE size a person reads that
   * is not decimal GB: the hardware line and the `memory` slot of `noneMemory` print it, because
   * it is the number on the box and in About This Mac ("48 GB"), and '51.5 GB memory' reads as a
   * different machine. Every computed size (need, budget, download, free disk) stays decimal GB.
   */
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

/**
 * One Mac a model and harness pair was really run on by us. A candidate that matches an entry
 * (the same chip string, the same memory size as sold, the same harness) is `tested`: it ranks
 * before every candidate that is not, and as the pick it may be called "Recommended".
 */
export interface TestedOn {
  /** The chip, as `machdep.cpu.brand_string` reports it ('Apple M4'). */
  chip: string;
  /** The Mac's memory as it is sold (`HardwareFacts.memClassGb`: 16, 32, 48). */
  memGb: number;
  /** The harness it was tested with: a CLI registry id, as data. */
  cli: string;
  /** ISO date of the test ('2026-11-06'). */
  date: string;
  /**
   * The generation speed measured in that test, in tokens per second (67.7 for the
   * 2026-11-06 run on an Apple M5 Pro with 48 GB). A candidate that matches this entry reports
   * this figure as `Candidate.tokensPerSecond` in place of the estimate from the chip's memory
   * bandwidth: a measurement on the same Mac beats a formula.
   */
  tokensPerSecond?: number;
}

/** The runner of the model runtime that runs a model on a Mac, by the registry's name for it. See `LocalModelEntry.runner`. */
export type LocalModelRunner = 'mlx' | 'llamacpp';

/** One model of the catalogue. */
export interface LocalModelEntry {
  /** `name:tag` exactly as the model registry lists it. Lowercase, one colon, no slash (`LOCAL_MODEL_ID_PATTERN`). */
  id: string;
  /** The name a person reads ('Qwen3.8 27B'). */
  label: string;
  /** SPDX id of the license ('Apache-2.0'). */
  license: string;
  /** Parameter count in billions. When no model that fits has 12 or more, the verdict is `limited`, never `ok`. */
  paramsB: number;
  /**
   * The runner the runtime uses for this tag ON A MAC, as the registry names it: `mlx` (a
   * safetensors build, or a manifest list with an MLX child, which a Mac always takes) or
   * `llamacpp` (a GGUF build, run by llama-server on Metal). The two spend memory in different
   * ways, so a row's memory figures are only meaningful together with its runner: llama.cpp
   * allocates the whole K/V cache for the context when the model loads (in the runtime's
   * `OLLAMA_KV_CACHE_TYPE`), MLX grows it with the tokens actually used and keeps snapshots of
   * it besides.
   */
  runner: LocalModelRunner;
  /**
   * Size of the weights in bytes: both the download and what they take in memory.
   *
   * It is the size of the build the runtime really downloads ON A MAC: the build of `runner`,
   * every layer of its manifest plus its config, which is the `total` a real pull reports.
   * That is not always the first manifest the registry answers with: `qwen3.6:35b-a3b` is an
   * MLX build of 23,105,798,956 bytes on Apple silicon, 2% more than its GGUF build of
   * 22,621,314,381.
   */
  bytes: number;
  /**
   * Bytes that stay HELD in memory per token of context. For a `llamacpp` row: the K/V cache
   * of its attention layers in the runtime's cache type, which llama.cpp allocates for the
   * whole context at load (a multi-token-prediction layer's in f16). For an `mlx` row: the K/V cache in bf16 plus the snapshots of the
   * recurrent state the runner keeps every 8,192 tokens, which it grows with use. Measured
   * on one row (36,000 to 38,000 on the MLX runner, so about 37,000); computed from the
   * model's config for the others, see `figures` and the catalogue header.
   */
  heldBytesPerToken: number;
  /**
   * What the runner holds beside the weights and the context, whatever the context: its own
   * buffers, the live recurrent or sliding-window caches, and the caches it keeps of earlier
   * prompts (for `llamacpp` the 1024 MiB host prompt cache `LLAMA_ARG_CACHE_RAM` allows and
   * the copies of the recurrent or sliding-window state in its `LLAMA_ARG_CTX_CHECKPOINTS`
   * context checkpoints, for an estimated `mlx` row the 8 GiB of prefix snapshots the runner
   * may keep). Measured on one row (about 3 GB); see the catalogue header for the others.
   */
  overheadBytes: number;
  /**
   * The TRANSIENT extra the runner takes while it processes a long prompt, on top of
   * what stays held (measured on the MLX runner: about 5 GB; 0 for `llamacpp`, which
   * allocates its buffers at load). The fit is judged on the peak:
   * `bytes + heldBytesPerToken * context + overheadBytes + peakExtraBytes`. For
   * `qwen3.6:35b-a3b` at 131072 tokens that is about 36 GB, which is tight on a 48 GB Mac.
   */
  peakExtraBytes: number;
  /**
   * Where the three memory figures above come from: `measured` on a Mac by us, or
   * `estimated` (computed from the model's architecture for its runner, see the catalogue
   * header). `bytes` is the registry's size of the build a Mac pulls in both cases.
   */
  figures: 'measured' | 'estimated';
  /** Context lengths (tokens) the model may be run at, largest first. */
  contexts: number[];
  /** Preference among models that fit: the HIGHER rank wins. A judgement, not a measurement. */
  rank: number;
  /** Measured tokens per second per 100 GB/s of memory bandwidth. Absent: the speed of this model is unknown. */
  speedPer100Gbps?: number;
  /** Macs this model was really run on. Empty for every row but one. */
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
  /**
   * A literal with no white space that this harness's composer draws once it takes input, and
   * nothing before it does: what a script waits for before it sends the first prompt
   * (`GET /api/sessions/:id/wait-output`). Only a mark that was MEASURED on a session started
   * on a custom model goes here. Absent: the CLI registry's own
   * `capabilities.composerReadyMark` is used when it declares one, and a harness with neither
   * has no mark.
   */
  readyMark?: string;
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

/** The catalogue: a compiled constant, validated by `LocalModelCatalogSchema`. No override file, no download data. */
export interface LocalModelCatalog {
  schema: 1;
  /** ISO date the rows were last checked ('2026-11-06'). Reported as `LocalModelStatus.catalogUpdated`. */
  updated: string;
  /** Oldest macOS major version a local model runs on. Below it: verdict `none`, reason `macos`. */
  minMacosMajor: number;
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
  /**
   * The CLI can be started on this machine: the same answer the Run menu gets. For a launcher
   * that starts nothing by itself (`discovery.launcherProfile` in the CLI registry) that is its
   * binary AND something for it to launch.
   */
  installed: boolean;
  /**
   * Not installed, but ONE command makes it startable: the registry has an install command for
   * this platform that needs no administrator rights, and the CLI is not a launcher. A launcher
   * needs a second install the command does not make (a profile, which is third-party code
   * with a consent of its own), so it is never installable from here.
   */
  installable: boolean;
  /**
   * The literal install command the install job would run for this CLI: the STOCK
   * command of the CLI registry for this platform, never one a `clis.json` override supplies.
   * Present exactly when `installable` is true. The consent screen prints it
   * (`CandidateHarness.installCommand`).
   */
  installCommand?: string;
  /** The registry's `capabilities.composerReadyMark`, when the CLI declares one and it holds no white space. */
  readyMark?: string;
  /** Whether this CLI can be launched with that model id (its command-line pattern accepts it). */
  acceptsModelId: (modelId: string) => boolean;
}

// ---------- Recommendation ----------

/**
 * Need over budget: up to 0.85 is `good`, up to 0.98 is `tight`, above is `out`. The need is
 * the PEAK, so the grade says how much room is left at the worst moment. It decides whether a
 * model is offered at all (`out` never is) and what its row says (`tight`). It does not sort
 * the list.
 */
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
 *  - `memory`: no model fits the memory budget at a context a usable harness needs. Three
 *    headlines share this reason: `noneMemory` (nothing fits at any context), `noneMemoryContext`
 *    (a model fits, but only below the context a harness needs: the sentence carries the budget
 *    and the need) and `noneMemoryUnknown` (the memory size could not be read).
 *  - `disk`: models fit the memory, but for every one of them free disk minus the download is below 10 GiB.
 *  - `macos`: macOS is older than `LocalModelCatalog.minMacosMajor`.
 *  - `no-harness`: no catalogue harness is installed or installable and accepts a model.
 */
export type NoneReason = 'not-macos' | 'intel' | 'memory' | 'disk' | 'macos' | 'no-harness';

/**
 * Where the device budget came from.
 *  - `estimated`: a formula over the installed memory. All there is before the runtime ran.
 *  - `wired-limit`: `iogpu.wired_limit_mb` above 0.
 *  - `measured`: the device total the runtime itself printed when it started
 *    (`RecommendOptions.measuredTotalBytes`). The chooser says "estimated" next to the memory
 *    bar for the first value only.
 */
export type BudgetSource = 'estimated' | 'wired-limit' | 'measured';

/** The memory a model may use on this Mac. */
export interface DeviceBudget {
  /**
   * L: the measured device total when there is one, else the wired limit when above 0, else
   * 2/3 of memory below 36 GB and 3/4 from 36 GB.
   */
  limitBytes: number;
  /**
   * What `Candidate.budgetShare` is measured against. Estimated or from the wired limit:
   * B = min(L - 1 GiB, memory - reserve). Measured: B = min(L, memory - reserve), without the
   * 1 GiB, because the runtime's figure is already what it will really use (37.4 GiB on the
   * 48 GB test Mac, which reads '40.2').
   */
  budgetBytes: number;
  source: BudgetSource;
}

/**
 * What the caller of `recommend()` knows beyond the hardware probe. Both members are optional:
 * an empty object means the budget is the estimate and an install downloads the model alone.
 */
export interface RecommendOptions {
  /**
   * The device total the runtime reported in its log line "inference compute"
   * (`total="37.4 GiB"`), in bytes: `parseInferenceComputeTotal()` in
   * src/local-model/runtime.ts. Present: the budget is `measured`. The install job passes it
   * right after the runtime started, before the model is downloaded, and the GET passes the
   * stored figure from then on.
   */
  measuredTotalBytes?: number;
  /**
   * What an install adds to every candidate's download beside the model: the size of the
   * pinned runtime archive while the runtime is not installed, 0 once it is. It is the
   * difference between `Candidate.installBytes` and `Candidate.downloadBytes`. Default 0.
   */
  runtimeDownloadBytes?: number;
}

/**
 * Every sentence and label the server may put into the payload, in English (the i18n source
 * language). The zh-CN dictionary in src/web/public/i18n.js has one entry per value, keyed by
 * this exact text, and test/local-model-i18n.test.ts imports this constant to list them. Adding
 * a key is fine; changing a text means changing its zh-CN key too.
 *
 * `{placeholder}` slots are filled by the browser from `LocalModelMessage.vars`. `{name}` is
 * taken (the translator fills it with the display name), so no slot here is called `name`.
 *
 * | Key                 | Slots (all text; sizes are decimal GB without the unit)                   |
 * |---------------------|---------------------------------------------------------------------------|
 * | `noteDiskDropped`   | `model`: label of the best model left out for disk space; `missing`: its  |
 * |                     | download + the disk reserve - free                                        |
 * | `noneMemory`        | `memory`: `HardwareFacts.memClassGb`, the size the Mac is sold as         |
 * | `noneMemoryContext` | `budget`: `Recommendation.budgetGb`; `need`: the smallest need of any     |
 * |                     | model at a context a usable harness works at                              |
 * | `noneDisk`          | `download`: smallest download among the models that fit the memory;       |
 * |                     | `reserve`: what must stay free after it (10 GiB, as decimal GB); `free`:  |
 * |                     | `HardwareFacts.freeDiskGb`; `missing`: download + reserve - free          |
 * | `noneMacos`         | `version`: `HardwareFacts.macosVersion`; `minimum`: the catalogue minimum |
 *
 * The word "Recommended" exists only in `headlineTested`, which may be used only when the
 * pick's `tested` is true: one catalogue row has a tested entry (`qwen3.6:35b-a3b` on an Apple
 * M5 Pro with 48 GB), so one kind of Mac is told so.
 */
export const LOCAL_MODEL_LABELS = {
  /** Verdict `ok`, pick not tested by us on a Mac like this one. */
  headlineOk: 'Best fit for this Mac',
  /** Verdict `ok`, pick tested by us on a Mac like this one. */
  headlineTested: 'Recommended for this Mac',
  /** Verdict `limited`: no model with 12 billion parameters or more fits this Mac. */
  headlineLimited:
    'This Mac can run a small model. It handles small edits and questions. It does not replace a cloud model.',
  /** A note under an `ok` or `limited` pick whose `tested` is false. */
  noteUntested: 'Codeman has not run this on a Mac like this yet.',
  /** A note under an `ok` pick that is itself a small model: larger ones fit this Mac, but rank lower or have no room on the disk. */
  noteSmallPick:
    'The best fit is a small model. It handles small edits and questions. It does not replace a cloud model.',
  /** A note when a model that fits the memory was left out because its download would not leave the disk reserve. */
  noteDiskDropped:
    '{model} fits the memory of this Mac too, but its download needs about {missing} GB more free disk space.',
  fitGood: 'Good',
  fitTight: 'Tight',
  speedSlow: 'Slow',
  speedUnknown: 'Speed unknown',
  noneNotMacos: 'Codeman recommends a local model only on a Mac with Apple silicon.',
  noneIntel: 'Local coding models need Apple silicon, and this Mac has an Intel processor.',
  /** Reason `memory`: nothing fits at any context. */
  noneMemory: 'With {memory} GB of memory, this Mac cannot run a model that can drive a coding agent.',
  /** Reason `memory`: a model fits, but only below the context a harness needs. Says both numbers, and ("about") that they are estimates. */
  noneMemoryContext:
    'This Mac can give a model about {budget} GB of memory, and the smallest model a coding agent can work with needs about {need} GB.',
  /** Reason `memory`: the memory size could not be read, so no size is stated. */
  noneMemoryUnknown: 'Codeman could not read how much memory this Mac has, so it recommends no model here.',
  /** Reason `disk`. One number: what to do. The other sizes travel in `vars` for a client that wants them. */
  noneDisk: 'Free up about {missing} GB of disk space to install the smallest model that fits this Mac.',
  noneMacos: 'Local models need macOS {minimum} or newer, and this Mac runs macOS {version}.',
  noneNoHarness: 'No coding agent that Codeman can connect to a local model is available on this Mac.',
} as const;

/** One of the texts in `LOCAL_MODEL_LABELS`. The payload's label fields are typed with it, so an off-list string does not compile. */
export type LocalModelLabel = (typeof LOCAL_MODEL_LABELS)[keyof typeof LOCAL_MODEL_LABELS];

/** The headline of each `none` reason. `memory` has two more (`noneMemoryContext`, `noneMemoryUnknown`), see `NoneReason`. */
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

/**
 * The one tag a model row of the chooser carries, by what it says.
 *  - `tested`: `Candidate.tested` is true. Replaces every other tag.
 *  - `best-tight`: the pick, when its `fit` is `tight`. The words must not say less than the
 *    memory bar beside them, which is nearly full for such a row.
 *  - `best`: the pick.
 *  - `tight`: `Candidate.fit` is `tight`.
 *  - `slow`: `Candidate.speed` is `slow`.
 *  - `small`: the model has fewer than 12 billion parameters.
 * A row gets the FIRST kind of this list that applies and no tag when none does. `tested`,
 * `best` and `best-tight` are the tags of the row the window opens on, drawn in the accent
 * colour.
 */
export type CandidateTagKind = 'tested' | 'best-tight' | 'best' | 'tight' | 'slow' | 'small';

/**
 * The text of each tag, in English (the i18n source language), like `LOCAL_MODEL_LABELS`. A
 * constant of its own so that a consumer can list the tag texts apart from the sentences.
 */
export const LOCAL_MODEL_TAG_LABELS = {
  tested: 'Tested on a Mac like this',
  'best-tight': 'Best fit, tight',
  best: 'Best fit',
  tight: 'Tight',
  slow: 'Slow',
  small: 'Small model',
} as const satisfies Record<CandidateTagKind, string>;

/** One of the texts in `LOCAL_MODEL_TAG_LABELS`. */
export type LocalModelTagLabel = (typeof LOCAL_MODEL_TAG_LABELS)[CandidateTagKind];

/** The tag of a model row: what kind it is (for the styling) and the text to print. */
export interface CandidateTag {
  kind: CandidateTagKind;
  /** `LOCAL_MODEL_TAG_LABELS[kind]`. */
  label: LocalModelTagLabel;
}

/**
 * One coding agent a candidate's model can be run with on this Mac, for the "Runs
 * with" select of the chooser. Everything a browser needs is here, so it compares no CLI id.
 */
export interface CandidateHarness {
  /** The CLI registry id, as data: what `POST /api/local-model/install` is sent as `cli`. */
  cli: string;
  /** The registry's display label ('OpenCode'). */
  cliLabel: string;
  /** False: the install job installs it first (it is installable, or it would not be listed). */
  installed: boolean;
  /**
   * The literal command the install job would run to install it (`HarnessFact.installCommand`).
   * Present exactly when `installed` is false. The consent screen prints it as it is.
   */
  installCommand?: string;
  /** The harness row's `slowFirstTurn`. */
  slowFirstTurn?: boolean;
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
  /**
   * What the model needs in memory at this context: the PEAK, `bytes + heldBytesPerToken *
   * context + overheadBytes + peakExtraBytes` of the catalogue row. The memory bar of the
   * chooser is filled to `budgetShare`, which is this over the budget.
   */
  needBytes: number;
  /** `needBytes` as decimal GB text, no unit. */
  needGb: string;
  /**
   * What `needBytes` is made of, for the chooser's memory map: the model (`bytes +
   * overheadBytes`), its context in use (`heldBytesPerToken * context`) and the brief peaks
   * (`peakExtraBytes`). The three add up to `needBytes`.
   */
  memory?: { modelBytes: number; contextBytes: number; peakBytes: number };
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
  /**
   * Generation speed in tokens per second, rounded to one decimal. Present exactly when `speed`
   * is not `unknown`; `speed` is decided on the unrounded figure. An estimate from the chip's
   * memory bandwidth, except for a candidate that is `tested`, which reports the
   * speed measured in that test (`TestedOn.tokensPerSecond`).
   */
  tokensPerSecond?: number;
  /**
   * A `TestedOn` entry of the model matches this Mac (same chip, same `memClassGb`) and this
   * harness. Such a candidate ranks first, and its `tag` says so in place of any other tag.
   */
  tested: boolean;
  /** `LocalModelEntry.figures` of the model: whether `needBytes` rests on a measurement of this model. */
  needSource: 'measured' | 'estimated';
  /** The row's one tag, see `CandidateTagKind`. Absent when no kind applies. */
  tag?: CandidateTag;
  /**
   * Every coding agent this model can be run with at `context` on this Mac, best
   * first. The first entry is the one the flat fields above name (`cli`, `cliLabel`,
   * `cliInstalled`, `slowFirstTurn`). Never empty.
   */
  harnesses: CandidateHarness[];
  /**
   * The whole download a click on Install starts for this row: `downloadBytes` plus
   * `RecommendOptions.runtimeDownloadBytes`. It is the server's own total, and exactly the
   * number `POST /api/local-model/install` must be sent as `acknowledgedBytes`.
   */
  installBytes: number;
  /** `installBytes` as decimal GB text, no unit. */
  installGb: string;
  /**
   * Set by the route, never by `recommend()`: this model at this context is a checked model of
   * the library on this Mac (`LocalModelInstallView.library`). `active`: it is the model in
   * use. `ready`: `POST /api/local-model/use` switches to it, and nothing is downloaded.
   */
  library?: 'active' | 'ready';
}

/**
 * The answer of `recommend()`.
 *  - `ok`: `pick` is the best candidate, and at least one model with 12 billion parameters or
 *    more fits this Mac's memory at a context a usable harness works at. The pick itself can be
 *    smaller (a larger model may fit only tightly, have no speed figure, or have no room on the
 *    disk): `notes` then carries `noteSmallPick`.
 *  - `limited`: `pick` is the best candidate, and NO model with 12 billion parameters or more
 *    fits. The card says so and never says "Recommended".
 *  - `none`: no pick; `reason` says why.
 */
export interface Recommendation {
  verdict: 'ok' | 'limited' | 'none';
  /** Present exactly when `verdict` is `none`. */
  reason?: NoneReason;
  /** What the card says first: `headlineOk`, `headlineTested`, `headlineLimited` or a `none` sentence. */
  headline: LocalModelMessage;
  /** Further sentences under the pick, in this order: `noteSmallPick`, `noteDiskDropped`, `noteUntested`. May be empty. */
  notes: LocalModelMessage[];
  /** Present exactly when `verdict` is `ok` or `limited`. */
  pick?: Candidate;
  /**
   * Every other model that fits and has room on the disk (`MAX_ALTERNATIVES` is above what the
   * catalogue holds), best first: tested before not tested, then ok before unknown before
   * slow speed, then the higher model rank. Each is at the largest context it fits at, with
   * the best harness that can run it there. Empty when `verdict` is `none`.
   */
  alternatives: Candidate[];
  /** `DeviceBudget.budgetBytes`. 0 when no budget is computed: not macOS, or a Mac without Apple silicon. */
  budgetBytes: number;
  /** `budgetBytes` as decimal GB text, no unit. */
  budgetGb: string;
  budgetSource: BudgetSource;
}

// `LocalModelStatus`, the `data` of `GET /api/local-model`, is in src/types/local-model-install.ts.
