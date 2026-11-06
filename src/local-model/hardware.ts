/**
 * @fileoverview The hardware probe of the local model recommendation: what this Mac is.
 *
 *  - `parseSysctl()`: a pure parser of `key: value` lines. The command runs WITHOUT `-n`, so a
 *    key that is missing on a machine (`sysctl.proc_translated` on Intel) cannot shift the
 *    others, and a line it does not know is ignored.
 *  - `readHardware()`: ONE bounded async spawn of `SYSCTL_PATH` with `SYSCTL_KEYS`, the free disk
 *    of the data dir through `fs.promises.statfs`, fallbacks from `node:os` when the spawn
 *    fails, and a 60 s cache.
 *
 * Rules:
 *  - Never throws and never rejects: a failed probe is an answer (`source: 'os-fallback'`), and
 *    off macOS nothing is spawned and no disk is read (`source: 'not-probed'`).
 *  - Never `system_profiler` (tens of milliseconds and a parse of free text), never a second
 *    spawn, never a synchronous exec on the server's event loop.
 *  - A non-zero exit is tolerated once `hw.memsize` parsed (a missing key makes sysctl exit 1).
 *    Without `hw.memsize` nothing else of that output is trusted: the answer is the fallback.
 *  - Only a line that ends in a newline counts. A cut-off tail is not a value: half of
 *    `hw.memsize` would read as a smaller, valid number.
 *  - `iogpu.wired_limit_mb` of 0 means "not set": it is reported as 0 and only a value above 0
 *    is ever used as a limit.
 *  - The data dir can sit on a network mount that stopped answering, so the disk read is
 *    bounded too: the folder is probed with the bounded path probe first, the `statfs` is raced
 *    against a timeout, and a `statfs` that never came back is not started a second time.
 *  - `memGb`, `memClassGb` and `freeDiskGb` are filled here through src/local-model/format.ts,
 *    the one place a size is formatted.
 */

import { execFile } from 'node:child_process';
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import { dirname } from 'node:path';
import type { HardwareFacts } from '../types.js';
import { getDataDir } from '../config/instance.js';
import { probePathKind, type PathProbeKind } from '../utils/bounded-path-probe.js';
import { formatGb, memClassGb } from './format.js';

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

/** Upper bound of the wait for the free disk figure. */
export const FREE_DISK_TIMEOUT_MS = 2000;

/** Seven short lines are well under this. A larger output is not sysctl's. */
const SYSCTL_MAX_OUTPUT_BYTES = 64 * 1024;

/** Longest text value kept (a chip name, a model identifier, a version). */
const MAX_TEXT_VALUE_LENGTH = 100;

/** How many parent folders are tried when the data dir does not exist yet. */
const FREE_DISK_MAX_PARENT_STEPS = 6;

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

/** A whole number without sign, as sysctl prints one. */
function parseCount(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/** sysctl prints a flag as 0 or 1. Anything else is not a flag. */
function parseFlag(value: string): boolean | undefined {
  if (value === '1') return true;
  if (value === '0') return false;
  return undefined;
}

function parseText(value: string): string | undefined {
  return value !== '' && value.length <= MAX_TEXT_VALUE_LENGTH ? value : undefined;
}

/**
 * Parse the output of `sysctl <keys>` (no `-n`): one `key: value` line per key it knows.
 * Pure. Unknown lines, blank lines and error lines are skipped, and so is a last line that does
 * not end in a newline. The first line of a key wins.
 */
export function parseSysctl(text: string): SysctlFacts {
  const facts: SysctlFacts = {};
  const lines = text.split('\n');
  // What follows the last newline is either empty or a cut-off line.
  lines.pop();
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '');
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    switch (key) {
      case 'hw.memsize': {
        const bytes = parseCount(value);
        if (bytes !== undefined && bytes > 0) facts.memBytes ??= bytes;
        break;
      }
      case 'machdep.cpu.brand_string':
        facts.chip ??= parseText(value);
        break;
      case 'hw.optional.arm64':
        facts.arm64 ??= parseFlag(value);
        break;
      case 'sysctl.proc_translated':
        facts.translated ??= parseFlag(value);
        break;
      case 'iogpu.wired_limit_mb':
        facts.wiredLimitMb ??= parseCount(value);
        break;
      case 'kern.osproductversion': {
        const version = /^(\d+)(?:\.\d+)*$/.exec(value);
        if (version && value.length <= MAX_TEXT_VALUE_LENGTH && facts.macosVersion === undefined) {
          facts.macosVersion = value;
          facts.macosMajor = Number(version[1]);
        }
        break;
      }
      case 'hw.model':
        facts.model ??= parseText(value);
        break;
      default:
        break;
    }
  }
  return facts;
}

/**
 * The one spawn: `command` with `SYSCTL_KEYS` as its arguments and nothing else (no `-n`).
 * Resolves stdout when the program ran, also after a non-zero exit (a key this machine lacks
 * makes sysctl exit 1 while the other keys are printed). Resolves `undefined` when it could not
 * be started, was killed (the timeout) or printed too much. Never rejects.
 *
 * The two parameters exist for the test, which runs a script of its own in place of sysctl.
 */
export function spawnSysctl(
  command: string = SYSCTL_PATH,
  timeoutMs: number = SYSCTL_TIMEOUT_MS
): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        [...SYSCTL_KEYS],
        {
          timeout: timeoutMs,
          maxBuffer: SYSCTL_MAX_OUTPUT_BYTES,
          encoding: 'utf8',
          windowsHide: true,
          // sysctl needs nothing from the server's environment, which can hold a password.
          env: { LC_ALL: 'C' },
        },
        (error, stdout) => {
          if (!error) return resolve(stdout);
          // A numeric code is an exit status: the program ran. A string code (ENOENT, EACCES,
          // the buffer limit) or a signal means it did not run to its end.
          const ranToEnd = typeof error.code === 'number' && !error.killed && !error.signal;
          resolve(ranToEnd ? stdout : undefined);
        }
      );
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * Free bytes on the filesystem that holds `path` (`bavail * bsize`: what an unprivileged
 * process can use), or `undefined` when the filesystem does not say. Not bounded by itself: see
 * `dataDirFreeBytes()`.
 */
export async function freeDiskBytesOf(path: string): Promise<number | undefined> {
  try {
    const stat = await statfs(path);
    const free = Number(stat.bavail) * Number(stat.bsize);
    return Number.isFinite(free) && free >= 0 ? free : undefined;
  } catch {
    return undefined;
  }
}

/** The one `statfs` that may be pending. While it is, no second one is started. */
let pendingStatfs: Promise<number | undefined> | undefined;

/** The IO of `dataDirFreeBytes()`. Each member defaults to the real thing; a test passes its own. */
export interface FreeDiskDeps {
  /** Default `getDataDir()`. */
  dataDir?: () => string;
  /** Default the bounded path probe (`probePathKind`). */
  probeKind?: (path: string) => Promise<PathProbeKind>;
  /** Default `freeDiskBytesOf`. */
  freeBytesOf?: (path: string) => Promise<number | undefined>;
  /** Default `FREE_DISK_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * Free bytes on the data dir's filesystem, bounded. The folder (or, when it does not exist yet,
 * its nearest existing parent) is found with the bounded path probe, which never waits on a
 * dead mount twice; the `statfs` itself is raced against a timeout. `undefined` when the
 * filesystem does not answer in time, or is not known to be a folder.
 */
export async function dataDirFreeBytes(deps: FreeDiskDeps = {}): Promise<number | undefined> {
  // Concurrent probes share one promise in `readHardware()`, so a `statfs` that is still pending
  // here was started by an EARLIER probe and has outlived its timeout: a dead mount. It holds
  // one threadpool worker, and that is the most this module may ever hold.
  if (pendingStatfs) return undefined;

  const probeKind = deps.probeKind ?? probePathKind;
  let folder: string;
  try {
    folder = (deps.dataDir ?? getDataDir)();
    let kind = await probeKind(folder);
    for (let step = 0; kind === 'absent' && step < FREE_DISK_MAX_PARENT_STEPS; step++) {
      const parent = dirname(folder);
      if (parent === folder) break;
      folder = parent;
      kind = await probeKind(folder);
    }
    // 'unknown' is a mount that does not answer (or an unreadable path): do not touch it.
    if (kind !== 'directory') return undefined;
  } catch {
    return undefined;
  }

  const started = (deps.freeBytesOf ?? freeDiskBytesOf)(folder).catch(() => undefined);
  pendingStatfs = started;
  const forget = (): void => {
    if (pendingStatfs === started) pendingStatfs = undefined;
  };
  started.then(forget, forget);

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      started,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), deps.timeoutMs ?? FREE_DISK_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function defaultCpuModel(): string | undefined {
  return os.cpus()[0]?.model;
}

/** A dependency that must never break the probe: its value, or `undefined` when it threw or rejected. */
async function attempt<T>(read: () => T | Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

/** Memory and the three fields derived from it. */
function memoryFields(memBytes: number | undefined): Pick<HardwareFacts, 'memBytes' | 'memGb' | 'memClassGb'> {
  const bytes = memBytes !== undefined && Number.isFinite(memBytes) && memBytes > 0 ? memBytes : 0;
  return { memBytes: bytes, memGb: formatGb(bytes), memClassGb: memClassGb(bytes) };
}

async function probeHardware(deps: HardwareProbeDeps): Promise<HardwareFacts> {
  const platform = deps.platform ?? process.platform;
  const arch = deps.arch ?? os.arch();
  const totalMemBytes = deps.totalMemBytes ?? os.totalmem;
  const cpuModel = deps.cpuModel ?? defaultCpuModel;

  if (platform !== 'darwin') {
    return { platform, arch, ...memoryFields(await attempt(totalMemBytes)), source: 'not-probed' };
  }

  const [stdout, freeDisk] = await Promise.all([
    attempt(deps.runSysctl ?? (() => spawnSysctl())),
    attempt(deps.freeDiskBytes ?? (() => dataDirFreeBytes())),
  ]);
  const disk: Pick<HardwareFacts, 'freeDiskBytes' | 'freeDiskGb'> =
    freeDisk !== undefined && Number.isFinite(freeDisk) && freeDisk >= 0
      ? { freeDiskBytes: freeDisk, freeDiskGb: formatGb(freeDisk) }
      : {};

  const facts = typeof stdout === 'string' ? parseSysctl(stdout) : {};
  if (facts.memBytes === undefined) {
    const chip = await attempt(cpuModel);
    return {
      platform,
      arch,
      ...memoryFields(await attempt(totalMemBytes)),
      ...(chip ? { chip } : {}),
      ...disk,
      source: 'os-fallback',
    };
  }

  const chip = facts.chip ?? (await attempt(cpuModel));
  return {
    platform,
    arch,
    ...(facts.arm64 !== undefined ? { arm64: facts.arm64 } : {}),
    ...(facts.translated !== undefined ? { translated: facts.translated } : {}),
    ...memoryFields(facts.memBytes),
    ...(chip ? { chip } : {}),
    ...(facts.model !== undefined ? { model: facts.model } : {}),
    ...(facts.macosVersion !== undefined ? { macosVersion: facts.macosVersion } : {}),
    ...(facts.macosMajor !== undefined ? { macosMajor: facts.macosMajor } : {}),
    ...(facts.wiredLimitMb !== undefined ? { wiredLimitMb: facts.wiredLimitMb } : {}),
    ...disk,
    source: 'sysctl',
  };
}

let cached: { at: number; facts: HardwareFacts } | undefined;
let inFlight: Promise<HardwareFacts> | undefined;

/**
 * What this machine is. Cached for `HARDWARE_CACHE_TTL_MS`; concurrent callers share one probe.
 * Never rejects.
 *
 * The cache is one per process and does not look at `deps`: within the 60 s a second call
 * returns the first call's answer whatever it injects. A test resets it first.
 */
export async function readHardware(deps: HardwareProbeDeps = {}): Promise<HardwareFacts> {
  const now = deps.now ?? Date.now;
  if (cached) {
    const age = now() - cached.at;
    if (age >= 0 && age < HARDWARE_CACHE_TTL_MS) return cached.facts;
  }
  if (inFlight) return inFlight;

  const probe = probeHardware(deps)
    .catch(
      // Unreachable by design (every read above is guarded), and still an answer if it is reached.
      (): HardwareFacts => ({
        platform: deps.platform ?? process.platform,
        arch: deps.arch ?? os.arch(),
        ...memoryFields(undefined),
        source: (deps.platform ?? process.platform) === 'darwin' ? 'os-fallback' : 'not-probed',
      })
    )
    .then((facts) => {
      cached = { at: now(), facts };
      return facts;
    })
    .finally(() => {
      if (inFlight === probe) inFlight = undefined;
    });
  inFlight = probe;
  return probe;
}

/** Drop the cached probe result and the memory of a pending disk read (tests, and nothing else). */
export function resetHardwareCache(): void {
  cached = undefined;
  inFlight = undefined;
  pendingStatfs = undefined;
}
