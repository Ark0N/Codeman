/**
 * @fileoverview The hardware probe of the local model recommendation: what this Mac is.
 *
 * SKELETON: the exported signatures are final, the bodies are not written yet. This module
 * will hold:
 *  - `parseSysctl()`: a pure parser of `key: value` lines. The command runs WITHOUT `-n`, so a
 *    key that is missing on a machine (`sysctl.proc_translated` on Intel) cannot shift the
 *    others, and a line it does not know is ignored.
 *  - `readHardware()`: ONE bounded async spawn of `SYSCTL_PATH` with `SYSCTL_KEYS`, the free disk
 *    of the data dir through `fs.promises.statfs`, fallbacks from `node:os` when the spawn
 *    fails, and a 60 s cache.
 *
 * Rules:
 *  - Never throws and never rejects: a failed probe is an answer (`source: 'os-fallback'`), and
 *    off macOS nothing is spawned (`source: 'not-probed'`).
 *  - Never `system_profiler` (tens of milliseconds and a parse of free text), never a second
 *    spawn, never a synchronous exec on the server's event loop.
 *  - A non-zero exit is tolerated once `hw.memsize` parsed (a missing key makes sysctl exit 1).
 *  - `iogpu.wired_limit_mb` of 0 means "not set": it is reported as 0 and only a value above 0
 *    is ever used as a limit.
 *  - `memGb`, `memClassGb` and `freeDiskGb` are filled here through src/local-model/format.ts,
 *    the one place a size is formatted.
 */

import type { HardwareFacts } from '../types.js';

/** Absolute path, so the server's PATH (minimal under a service manager) cannot change what runs. */
export const SYSCTL_PATH = '/usr/sbin/sysctl';

/** The keys of the one spawn, in the order they are passed. */
export const SYSCTL_KEYS = [
  'hw.memsize',
  'machdep.cpu.brand_string',
  'hw.optional.arm64',
  'sysctl.proc_translated',
  'iogpu.wired_limit_mb',
  'kern.osproductversion',
  'hw.model',
] as const;

/** Upper bound of the spawn (it answers in about 2 ms on a real Mac). */
export const SYSCTL_TIMEOUT_MS = 2000;

/** How long one probe result is reused. */
export const HARDWARE_CACHE_TTL_MS = 60_000;

/** What `parseSysctl()` read. Every field is absent when its key was missing or its value did not parse. */
export interface SysctlFacts {
  /** `hw.memsize`. */
  memBytes?: number;
  /** `machdep.cpu.brand_string`. */
  chip?: string;
  /** `hw.optional.arm64` is 1. */
  arm64?: boolean;
  /** `sysctl.proc_translated` is 1. */
  translated?: boolean;
  /** `iogpu.wired_limit_mb`, as reported (0 stays 0). */
  wiredLimitMb?: number;
  /** `kern.osproductversion`. */
  macosVersion?: string;
  /** The leading number of `macosVersion`. */
  macosMajor?: number;
  /** `hw.model`. */
  model?: string;
}

/** The IO of `readHardware()`, injectable so a test spawns nothing and reads no real disk. Each member defaults to the real thing. */
export interface HardwareProbeDeps {
  /** Default `process.platform`. */
  platform?: string;
  /** Default `os.arch()`. */
  arch?: string;
  /** Runs the one spawn. Resolves its stdout, also after a non-zero exit, or `undefined` when it could not run or timed out. Never rejects. */
  runSysctl?: () => Promise<string | undefined>;
  /** Free bytes on the data dir's filesystem, or `undefined` when unknown. Never rejects. */
  freeDiskBytes?: () => Promise<number | undefined>;
  /** Default `os.totalmem()`. */
  totalMemBytes?: () => number;
  /** Default `os.cpus()[0]?.model`. */
  cpuModel?: () => string | undefined;
  /** Default `Date.now`. The clock of the cache. */
  now?: () => number;
}

/**
 * Parse the output of `sysctl <keys>` (no `-n`): one `key: value` line per key it knows.
 * Pure. Unknown lines, blank lines and error lines are skipped.
 */
export function parseSysctl(text: string): SysctlFacts {
  void text;
  throw new Error('not implemented: parseSysctl');
}

/**
 * What this machine is. Cached for `HARDWARE_CACHE_TTL_MS`; concurrent callers share one probe.
 * Never rejects.
 */
export async function readHardware(deps?: HardwareProbeDeps): Promise<HardwareFacts> {
  void deps;
  throw new Error('not implemented: readHardware');
}

/** Drop the cached probe result (tests, and nothing else). */
export function resetHardwareCache(): void {
  throw new Error('not implemented: resetHardwareCache');
}
