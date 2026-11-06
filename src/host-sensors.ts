/**
 * @fileoverview Optional host readings for the header stats: GPU load and memory, and the live CPU and GPU clock
 * speeds.
 *
 * Every reader is opt-in per request (the route only calls the ones the browser asks for, and the browser only
 * asks when the matching setting is on), answers `undefined` when the host has no such sensor, and never
 * throws. Reads are cached for a couple of seconds so several open tabs cost one read.
 *
 * Sources, with no extra dependency:
 *   - GPU: `nvidia-smi` (NVIDIA), else the amdgpu sysfs files (`gpu_busy_percent`, `mem_info_vram_*`,
 *     `pp_dpm_sclk`), else, inside WSL, the Windows performance counters through `typeperf.exe` (any vendor,
 *     Intel included: load and memory in use, but Windows publishes no GPU clock for them).
 *   - CPU clock: inside WSL the Windows `Processor Frequency` counter (WSL's own cpuinfo is a fixed number),
 *     else the mean of `scaling_cur_freq` across cores, else the `cpu MHz` lines of /proc/cpuinfo.
 *
 * The parsers are pure and exported so the tests need no hardware.
 *
 * @module host-sensors
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

export interface GpuReading {
  /** Core utilisation, 0 to 100. */
  percent: number;
  /** Graphics memory in use as a share of what is available, 0 to 100, when that is known. */
  memPercent?: number;
  memUsedMB?: number;
  memTotalMB?: number;
  /** Current graphics clock in MHz, when known. */
  mhz?: number;
}

export interface HostSensors {
  gpu?: GpuReading;
  cpuMhz?: number;
}

export interface SensorRequest {
  /** GPU load, graphics memory and clock. */
  gpu?: boolean;
  cpuMhz?: boolean;
}

const CACHE_MS = 2000;
/** A counter sample older than this (a few sampling intervals) is no longer a live reading. */
const FRESH_MS = 10000;
/** After a reader fails, leave it alone this long: nvidia-smi absent or timing out, PowerShell failing. */
const READER_BACKOFF_MS = 60000;
/** The GPU counters stay in the sampler this long after the last GPU read that needed them. */
const GPU_COUNTERS_HOLD_MS = 120000;
const EXEC_TIMEOUT_MS = 1500;
const SYS_DRM = '/sys/class/drm';
const SYS_CPU = '/sys/devices/system/cpu';
const TYPEPERF = '/mnt/c/Windows/System32/typeperf.exe';
const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const MB = 1048576;

const clampPercent = (n: number) => Math.min(100, Math.max(0, Math.round(n)));
const finite = (n: number) => (Number.isFinite(n) ? n : undefined);

/** Parse `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,clocks.gr --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(output: string): GpuReading | undefined {
  const line = output.split('\n').find((l) => l.trim());
  if (!line) return undefined;
  const [util, used, total, clock] = line.split(',').map((s) => finite(Number(s.trim())));
  if (util === undefined) return undefined;
  const reading: GpuReading = { percent: clampPercent(util) };
  if (used !== undefined && total !== undefined && total > 0) {
    reading.memUsedMB = Math.round(used);
    reading.memTotalMB = Math.round(total);
    reading.memPercent = clampPercent((used / total) * 100);
  }
  if (clock !== undefined && clock > 0) reading.mhz = Math.round(clock);
  return reading;
}

/** The active line of an amdgpu `pp_dpm_sclk` table (`1: 1800Mhz *`). */
export function parseDpmClock(text: string): number | undefined {
  const active = text.split('\n').find((l) => l.trim().endsWith('*'));
  const mhz = active ? /(\d+)\s*mhz/i.exec(active)?.[1] : undefined;
  return mhz ? Number(mhz) : undefined;
}

/** Mean of per-core `scaling_cur_freq` values (kHz) as MHz. */
export function meanKhzAsMhz(values: number[]): number | undefined {
  const good = values.filter((v) => Number.isFinite(v) && v > 0);
  if (!good.length) return undefined;
  return Math.round(good.reduce((a, b) => a + b, 0) / good.length / 1000);
}

/** Mean of the `cpu MHz : 3412.5` lines of /proc/cpuinfo. */
export function parseCpuInfoMhz(text: string): number | undefined {
  const values = [...text.matchAll(/^cpu MHz\s*:\s*([\d.]+)/gim)].map((m) => Number(m[1]));
  return meanKhzAsMhz(values.map((v) => v * 1000));
}

export interface WindowsCounters {
  gpu?: { percent: number; memUsedMB: number; dedicated: boolean };
  cpuMhz?: number;
}

const ENGINE =
  /GPU Engine\(.*?_luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_\d+_eng_\d+_engtype_([^)]*)\)\\Utilization Percentage/i;
const ADAPTER_MEMORY = /GPU Adapter Memory\(luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_\d+\)\\(Shared|Dedicated) Usage/i;
const CPU_FREQUENCY = /Processor Information\(_Total\)\\Processor Frequency/i;

/**
 * Parse one `typeperf.exe -sc 1 ...` sample: a quoted CSV header of counter paths and one row of values.
 * Task Manager's GPU figure is its busiest engine, so per adapter the load is the largest per-engine-type sum
 * (3D, copy, video decode...), capped at 100. The adapter that holds the most graphics memory is the real one
 * (Windows also lists software adapters that hold a few kilobytes). A `Shared Usage` only means an integrated
 * GPU, whose memory is carved out of system RAM.
 */
export function parseTypeperf(output: string): WindowsCounters {
  const rows = output
    .split(/\r?\n/)
    .filter((l) => l.startsWith('"'))
    .map((l) => l.slice(1, l.lastIndexOf('"')).split('","'));
  if (rows.length < 2) return {};
  const [names, values] = rows;
  const engines = new Map<string, Map<string, number>>();
  const memory = new Map<string, { shared: number; dedicated: number }>();
  let cpuMhz: number | undefined;
  names.forEach((name, i) => {
    const value = finite(Number(values[i]));
    if (value === undefined || values[i].trim() === '') return;
    const engine = ENGINE.exec(name);
    if (engine) {
      const byType = engines.get(engine[1].toLowerCase()) ?? new Map<string, number>();
      byType.set(engine[2], (byType.get(engine[2]) ?? 0) + value);
      engines.set(engine[1].toLowerCase(), byType);
      return;
    }
    const mem = ADAPTER_MEMORY.exec(name);
    if (mem) {
      const luid = mem[1].toLowerCase();
      const entry = memory.get(luid) ?? { shared: 0, dedicated: 0 };
      if (mem[2].toLowerCase() === 'shared') entry.shared = value;
      else entry.dedicated = value;
      memory.set(luid, entry);
      return;
    }
    if (CPU_FREQUENCY.test(name) && value > 0) cpuMhz = Math.round(value);
  });
  const result: WindowsCounters = {};
  if (cpuMhz) result.cpuMhz = cpuMhz;
  const luids = new Set([...engines.keys(), ...memory.keys()]);
  let best: { luid: string; bytes: number; load: number } | undefined;
  for (const luid of luids) {
    const m = memory.get(luid);
    const bytes = (m?.shared ?? 0) + (m?.dedicated ?? 0);
    const load = Math.max(0, ...(engines.get(luid)?.values() ?? []));
    if (!best || bytes > best.bytes || (bytes === best.bytes && load > best.load)) best = { luid, bytes, load };
  }
  if (best && (engines.size > 0 || memory.size > 0)) {
    result.gpu = {
      percent: clampPercent(best.load),
      memUsedMB: Math.round(best.bytes / MB),
      dedicated: (memory.get(best.luid)?.dedicated ?? 0) > 0,
    };
  }
  return result;
}

/**
 * Run a reader, answering undefined on failure or once `timeout` has passed. execFile's own `timeout` only
 * sends the child a signal, and its callback waits for the child to exit: an nvidia-smi stuck on a hung
 * driver (uninterruptible sleep) never does, and every stats request would wait on it with CPU and MEM. So
 * the deadline here answers by itself; the child is left to the signal.
 */
const run = (cmd: string, args: string[], timeout = EXEC_TIMEOUT_MS) =>
  new Promise<string | undefined>((resolve) => {
    const deadline = setTimeout(() => resolve(undefined), timeout);
    deadline.unref();
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * MB }, (err, stdout) => {
      clearTimeout(deadline);
      resolve(err ? undefined : stdout);
    });
  });

const readText = (path: string) =>
  readFile(path, 'utf8').then(
    (t) => t.trim(),
    () => undefined
  );
const readNumber = async (path: string) => {
  const text = await readText(path);
  return text === undefined ? undefined : finite(Number(text));
};

/** Linux running under WSL: Windows programs can be started, and the GPU belongs to Windows. */
let wsl: boolean | undefined;
function inWsl(): boolean {
  wsl ??=
    process.platform === 'linux' &&
    (Boolean(process.env.WSL_INTEROP) ||
      existsSync('/proc/sys/fs/binfmt_misc/WSLInterop') ||
      existsSync('/proc/sys/fs/binfmt_misc/WSLInterop-late'));
  return wsl;
}

let windowsRamMB: number | undefined;
let ramProbe: Promise<void> | undefined;
let ramRetryAt = 0;

/**
 * Windows' installed RAM in MB once PowerShell has answered, else undefined. The probe (about a second, 8 s
 * timeout) is started here but never awaited: the stats route answers CPU and MEM only after the sensors, so
 * the GPU reading carries the memory in use alone until the answer lands, and the total from then on. A
 * failure is not retried on every GPU poll: it waits READER_BACKOFF_MS first.
 */
function windowsRamMBIfKnown(): number | undefined {
  if (windowsRamMB !== undefined || ramProbe || Date.now() < ramRetryAt) return windowsRamMB;
  ramProbe = run(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory'],
    8000
  ).then((out) => {
    const bytes = out ? finite(Number(out.trim())) : undefined;
    if (bytes && bytes > 0) windowsRamMB = Math.round(bytes / MB);
    else ramRetryAt = Date.now() + READER_BACKOFF_MS;
    ramProbe = undefined;
  });
  return undefined;
}

/** What the sampler needs from a child process; `ChildProcess` fits, and tests pass a fake. */
export type SamplerChild = Pick<ChildProcess, 'stdout' | 'kill' | 'once'>;

export interface CounterStreamOptions {
  start: (counters: string[]) => SamplerChild;
  now?: () => number;
  /**
   * How long a read waits for a sample when it has none fresh (0, the default, never waits: the read
   * answers undefined and the next poll shows the reading). The stats route awaits the sensors before it
   * answers CPU and MEM, so a cold sampler must not hold it up.
   */
  firstSampleMs?: number;
  /** A sampler older than this is replaced, so counters of processes that started since are picked up. */
  recycleMs?: number;
  /** A sampler nobody has read for this long is stopped. */
  idleMs?: number;
  /** After the sampler fails to start or exits at once, do not try again for this long. */
  backoffMs?: number;
}

/**
 * One long-running `typeperf.exe -si 2` instead of a process per read: every `typeperf` sample takes over a
 * second (rate counters need two collections), which would keep one running back to back. The newest row is kept
 * and handed out; the process is replaced every `recycleMs` (its wildcard counters are expanded once, at
 * start) and stopped after `idleMs` without a read, so nothing runs while the settings are off.
 */
export function createCounterStream(options: CounterStreamOptions) {
  const now = options.now ?? Date.now;
  const firstSampleMs = options.firstSampleMs ?? 0;
  const recycleMs = options.recycleMs ?? 30000;
  const idleMs = options.idleMs ?? 30000;
  const backoffMs = options.backoffMs ?? 60000;
  let child: SamplerChild | undefined;
  let key = '';
  let startedAt = 0;
  let lastRead = 0;
  let blockedUntil = 0;
  let latest: { at: number; value: WindowsCounters } | undefined;
  let waiting: Array<() => void> = [];

  const stop = () => {
    const old = child;
    child = undefined;
    if (old) {
      try {
        old.kill();
      } catch {
        /* already gone */
      }
    }
  };

  const begin = (counters: string[]) => {
    stop();
    const nextKey = counters.join('\n');
    // A sample of other counters is no answer; one from an older sampler of the same counters still is.
    if (nextKey !== key) latest = undefined;
    key = nextKey;
    startedAt = now();
    // The header row and the partial line belong to this process alone: a late row from a replaced sampler
    // must never become the next one's header.
    let header: string | undefined;
    let buffer = '';
    let sampled = false;
    let started: SamplerChild;
    try {
      started = options.start(counters);
    } catch {
      blockedUntil = now() + backoffMs;
      return;
    }
    child = started;
    started.stdout?.on('data', (chunk: Buffer | string) => {
      if (child !== started) return;
      buffer += chunk.toString();
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at).replace(/\r$/, '');
        buffer = buffer.slice(at + 1);
        if (!line.startsWith('"')) continue;
        if (!header) {
          header = line;
          continue;
        }
        sampled = true;
        latest = { at: now(), value: parseTypeperf(`${header}\n${line}`) };
        const release = waiting;
        waiting = [];
        release.forEach((fn) => fn());
      }
    });
    const ended = () => {
      if (child !== started) return;
      child = undefined;
      // It ended without a sample (typeperf missing, counters unknown): leave it alone for a while.
      if (!sampled) blockedUntil = now() + backoffMs;
      const release = waiting;
      waiting = [];
      release.forEach((fn) => fn());
    };
    started.once('exit', ended);
    started.once('error', ended);
  };

  return {
    /** The newest fresh sample for these counters, or undefined (a cold sampler is not waited for unless `firstSampleMs` says so). */
    async read(counters: string[]): Promise<WindowsCounters | undefined> {
      lastRead = now();
      if (now() < blockedUntil) return undefined;
      const wanted = counters.join('\n');
      if (!child || key !== wanted || now() - startedAt > recycleMs) begin(counters);
      if (!latest || key !== wanted || now() - latest.at >= FRESH_MS) {
        if (!child) return undefined;
        if (firstSampleMs > 0) {
          await new Promise<void>((resolve) => {
            waiting.push(resolve);
            setTimeout(resolve, firstSampleMs).unref();
          });
        }
      }
      return latest && now() - latest.at < FRESH_MS ? latest.value : undefined;
    },
    /** Stop the sampler when nobody has read it lately. */
    sweep() {
      if (child && now() - lastRead > idleMs) {
        stop();
        latest = undefined;
      }
    },
    stop,
  };
}

const GPU_COUNTERS = [
  '\\GPU Engine(*)\\Utilization Percentage',
  '\\GPU Adapter Memory(*)\\Shared Usage',
  '\\GPU Adapter Memory(*)\\Dedicated Usage',
];
const CPU_COUNTERS = ['\\Processor Information(_Total)\\Processor Frequency'];

/**
 * The counters one sampler reads. They do not depend on which reading a browser asked for (those are per
 * device, so two browsers can differ): the CPU clock is always sampled, and the GPU counters are added on a
 * machine with no native GPU reader (and dropped again once nothing has needed them for a while). A request then only picks its fields from the sample.
 */
export function windowsCounterList(needGpu: boolean): string[] {
  return needGpu ? [...GPU_COUNTERS, ...CPU_COUNTERS] : [...CPU_COUNTERS];
}

export function createWindowsSource(
  stream: Pick<ReturnType<typeof createCounterStream>, 'read' | 'stop'>,
  now: () => number = Date.now
) {
  let gpuUntil = 0;
  return {
    /**
     * A GPU reading is wanted and no native reader answered: sample the GPU counters too, for
     * GPU_COUNTERS_HOLD_MS after the last such read. A single failed nvidia-smi therefore costs a sampler
     * restart, not a GPU sampler for the life of the server.
     */
    needGpuCounters() {
      gpuUntil = now() + GPU_COUNTERS_HOLD_MS;
    },
    read: () => stream.read(windowsCounterList(now() < gpuUntil)),
    stop: () => stream.stop(),
  };
}

const windowsCounters = createCounterStream({
  // Spawn the Windows program directly: if it is missing, the error lands in the stream's back-off.
  start: (counters) =>
    spawn(TYPEPERF, ['-si', '2', ...counters], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }),
});
const windowsSource = createWindowsSource(windowsCounters);
let sweepTimer: ReturnType<typeof setInterval> | undefined;

/** Stop the background sampler and its idle sweep (the server calls this on shutdown). */
export function stopHostSensors(): void {
  if (sweepTimer) clearInterval(sweepTimer);
  sweepTimer = undefined;
  windowsSource.stop();
}

async function readAmdGpu(): Promise<GpuReading | undefined> {
  const cards = (await readdir(SYS_DRM).catch(() => [] as string[])).filter((n) => /^card\d+$/.test(n)).sort();
  for (const card of cards) {
    const dev = join(SYS_DRM, card, 'device');
    const busy = await readNumber(join(dev, 'gpu_busy_percent'));
    if (busy === undefined) continue;
    const reading: GpuReading = { percent: clampPercent(busy) };
    const used = await readNumber(join(dev, 'mem_info_vram_used'));
    const total = await readNumber(join(dev, 'mem_info_vram_total'));
    if (used !== undefined && total !== undefined && total > 0) {
      reading.memUsedMB = Math.round(used / MB);
      reading.memTotalMB = Math.round(total / MB);
      reading.memPercent = clampPercent((used / total) * 100);
    }
    const sclk = await readText(join(dev, 'pp_dpm_sclk'));
    const mhz = sclk ? parseDpmClock(sclk) : undefined;
    if (mhz) reading.mhz = mhz;
    return reading;
  }
  return undefined;
}

/** nvidia-smi is not run again before this time: it failed or timed out, and waits READER_BACKOFF_MS. */
let nvidiaSkipUntil = 0;

/** NVIDIA, then AMD. A host without a working nvidia-smi is not asked again on every poll. */
async function readNativeGpu(): Promise<GpuReading | undefined> {
  if (Date.now() >= nvidiaSkipUntil) {
    const out = await run('nvidia-smi', [
      '--query-gpu=utilization.gpu,memory.used,memory.total,clocks.gr',
      '--format=csv,noheader,nounits',
    ]);
    const reading = out ? parseNvidiaSmi(out) : undefined;
    if (reading) return reading;
    nvidiaSkipUntil = Date.now() + READER_BACKOFF_MS;
  }
  return readAmdGpu();
}

/** A GPU reading from the Windows counters (WSL only): load and memory in use, but no clock. */
function gpuFromWindows(windows: WindowsCounters | undefined): GpuReading | undefined {
  if (!windows?.gpu) return undefined;
  const { percent, memUsedMB, dedicated } = windows.gpu;
  const reading: GpuReading = { percent, memUsedMB };
  // An integrated GPU draws its memory from system RAM, and Windows lets it use up to half of it. Until
  // Windows has said how much RAM it has, the reading is the memory in use alone (the header shows no ring).
  const ram = dedicated ? undefined : windowsRamMBIfKnown();
  if (ram) {
    reading.memTotalMB = Math.round(ram / 2);
    reading.memPercent = clampPercent((memUsedMB / reading.memTotalMB) * 100);
  }
  return reading;
}

async function readCpuMhz(windows: WindowsCounters | undefined): Promise<number | undefined> {
  // Under WSL the Linux side only has a fixed figure, so until Windows answers there is no reading.
  if (windows) return windows.cpuMhz;
  const cores = (await readdir(SYS_CPU).catch(() => [] as string[])).filter((n) => /^cpu\d+$/.test(n));
  const khz = await Promise.all(cores.map((c) => readNumber(join(SYS_CPU, c, 'cpufreq', 'scaling_cur_freq'))));
  const fromSysfs = meanKhzAsMhz(khz.filter((v): v is number => v !== undefined));
  if (fromSysfs) return fromSysfs;
  const info = await readText('/proc/cpuinfo');
  return info ? parseCpuInfoMhz(info) : undefined;
}

const cache = new Map<string, { at: number; value: HostSensors }>();
const inFlight = new Map<string, Promise<HostSensors>>();

/** Read only what was asked for. Missing sensors are simply absent from the result. */
export async function readHostSensors(request: SensorRequest): Promise<HostSensors> {
  const key = `${request.gpu ? 'g' : ''}${request.cpuMhz ? 'c' : ''}`;
  if (!key) return {};
  sweepTimer ??= setInterval(() => windowsCounters.sweep(), 10000).unref();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const running = inFlight.get(key);
  if (running) return running;
  const promise = (async () => {
    // Native GPU readers first: a machine with a working nvidia-smi never starts the GPU counters.
    const nativeGpu = request.gpu ? await readNativeGpu() : undefined;
    const wsl = inWsl();
    const windowsGpu = wsl && request.gpu && !nativeGpu;
    if (windowsGpu) windowsSource.needGpuCounters();
    const windows = wsl && (request.cpuMhz || windowsGpu) ? await windowsSource.read() : undefined;
    const [gpu, cpuMhz] = await Promise.all([
      request.gpu ? (nativeGpu ?? gpuFromWindows(windows)) : undefined,
      request.cpuMhz ? readCpuMhz(wsl ? (windows ?? {}) : undefined) : undefined,
    ]);
    const value: HostSensors = {};
    if (gpu) value.gpu = gpu;
    if (cpuMhz) value.cpuMhz = cpuMhz;
    cache.set(key, { at: Date.now(), value });
    return value;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, promise);
  return promise;
}
