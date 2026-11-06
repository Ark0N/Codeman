/**
 * The order and the back-offs of readHostSensors, with `child_process` and the sysfs reads mocked so no
 * hardware is needed: native GPU readers go first (a machine with a working nvidia-smi never starts the
 * Windows GPU counters), a failing reader is left alone for a minute, neither a cold Windows sampler nor
 * the PowerShell RAM probe is waited for, and the GPU counters leave the sampler again once nothing needs them.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type ExecCall = { cmd: string; args: string[] };
const state = vi.hoisted(() => ({
  nvidia: '' as string | Error,
  powershell: '' as string | Error,
  /** When set, PowerShell does not answer until the test calls the callbacks kept here. */
  holdPowershell: false,
  heldPowershell: [] as Array<() => void>,
  /** When set, nvidia-smi never answers (a child stuck on a hung driver) until the test calls these. */
  holdNvidia: false,
  heldNvidia: [] as Array<() => void>,
  execCalls: [] as Array<{ cmd: string; args: string[] }>,
  spawnCalls: [] as Array<{ cmd: string; args: string[]; stdout: unknown }>,
}));

vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
    state.execCalls.push({ cmd, args });
    if (state.holdNvidia && cmd === 'nvidia-smi') {
      state.heldNvidia.push(() => cb(null, NVIDIA));
      return;
    }
    if (state.holdPowershell && cmd.endsWith('powershell.exe')) {
      state.heldPowershell.push(() => {
        const held = state.powershell;
        if (held instanceof Error) cb(held, '');
        else cb(null, held);
      });
      return;
    }
    const answer = cmd === 'nvidia-smi' ? state.nvidia : cmd.endsWith('powershell.exe') ? state.powershell : '';
    if (answer instanceof Error) cb(answer, '');
    else cb(null, answer);
  },
  spawn: (cmd: string, args: string[]) => {
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout, kill: () => true });
    state.spawnCalls.push({ cmd, args, stdout });
    return child;
  },
}));
vi.mock('node:fs/promises', () => ({
  readdir: async () => [],
  readFile: async () => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  },
}));

const NVIDIA = '37, 2048, 8192, 1815\n';
const HEADER =
  '"(PDH-CSV 4.0)",' +
  '"\\\\H\\GPU Engine(pid_1_luid_0x00000000_0x000139EC_phys_0_eng_0_engtype_3D)\\Utilization Percentage",' +
  '"\\\\H\\GPU Adapter Memory(luid_0x00000000_0x000139EC_phys_0)\\Shared Usage",' +
  '"\\\\H\\GPU Adapter Memory(luid_0x00000000_0x000139EC_phys_0)\\Dedicated Usage",' +
  '"\\\\H\\Processor Information(_Total)\\Processor Frequency"\r\n';
const ROW = '"t","20","1073741824","0","1650"\r\n';

async function load() {
  vi.resetModules();
  return import('../src/host-sensors.js');
}
const counted = (cmd: string) => state.execCalls.filter((c: ExecCall) => c.cmd.endsWith(cmd)).length;
const tick = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  state.nvidia = NVIDIA;
  state.powershell = new Error('powershell failed');
  state.holdPowershell = false;
  state.heldPowershell = [];
  state.holdNvidia = false;
  state.heldNvidia = [];
  state.execCalls = [];
  state.spawnCalls = [];
  process.env.WSL_INTEROP = '1';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-24T00:00:00Z'));
});
afterEach(() => {
  delete process.env.WSL_INTEROP;
  vi.useRealTimers();
});

describe('native readers first', () => {
  it('answers from nvidia-smi on WSL and never starts the Windows GPU counters', async () => {
    const { readHostSensors, stopHostSensors } = await load();
    const out = await readHostSensors({ gpu: true });
    expect(out.gpu).toMatchObject({ percent: 37, memUsedMB: 2048, memPercent: 25, mhz: 1815 });
    expect(state.spawnCalls).toEqual([]);
    stopHostSensors();
  });

  it('starts only the CPU clock counter for a CPU MHz request, and never waits for it', async () => {
    const { readHostSensors, stopHostSensors } = await load();
    const started = Date.now();
    const out = await readHostSensors({ cpuMhz: true });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(out).toEqual({});
    expect(state.spawnCalls).toHaveLength(1);
    expect(state.spawnCalls[0].args.join(' ')).toContain('Processor Frequency');
    expect(state.spawnCalls[0].args.join(' ')).not.toContain('GPU Engine');
    stopHostSensors();
  });

  it('falls back to the Windows counters, GPU ones included, when nvidia-smi gives nothing', async () => {
    state.nvidia = new Error('nvidia-smi: command not found');
    const { readHostSensors, stopHostSensors } = await load();
    await readHostSensors({ gpu: true });
    expect(state.spawnCalls).toHaveLength(1);
    expect(state.spawnCalls[0].args.join(' ')).toContain('GPU Engine');
    stopHostSensors();
  });
});

describe('a failing reader is left alone for a minute', () => {
  it('does not run nvidia-smi on every poll of a host without one, and tries again after the back-off', async () => {
    state.nvidia = new Error('nvidia-smi: command not found');
    const { readHostSensors, stopHostSensors } = await load();
    for (let i = 0; i < 5; i++) {
      await readHostSensors({ gpu: true });
      vi.setSystemTime(Date.now() + 2500); // past the 2 s cache each time
    }
    expect(counted('nvidia-smi')).toBe(1);
    vi.setSystemTime(Date.now() + 61_000);
    await readHostSensors({ gpu: true });
    expect(counted('nvidia-smi')).toBe(2);
    stopHostSensors();
  });

  it('does not retry a failing PowerShell on every GPU poll', async () => {
    state.nvidia = new Error('no nvidia');
    const { readHostSensors, stopHostSensors } = await load();
    await readHostSensors({ gpu: true }); // starts the sampler
    (state.spawnCalls[0].stdout as PassThrough).write(HEADER + ROW);
    await tick();
    for (let i = 0; i < 4; i++) {
      vi.setSystemTime(Date.now() + 2500);
      // the real sampler emits a row every 2 s
      (state.spawnCalls[0].stdout as PassThrough).write(ROW);
      await tick();
      const out = await readHostSensors({ gpu: true });
      expect(out.gpu).toMatchObject({ percent: 20, memUsedMB: 1024 });
      expect(out.gpu?.memPercent).toBeUndefined(); // no RAM total without PowerShell
    }
    expect(counted('powershell.exe')).toBe(1);
    vi.setSystemTime(Date.now() + 61_000);
    (state.spawnCalls[0].stdout as PassThrough).write(ROW);
    await tick();
    await readHostSensors({ gpu: true });
    expect(counted('powershell.exe')).toBe(2);
    stopHostSensors();
  });
});

describe('a hung nvidia-smi', () => {
  it('answers at its own deadline instead of waiting for a child that never exits, then backs off', async () => {
    state.holdNvidia = true;
    const { readHostSensors, stopHostSensors } = await load();
    const started = performance.now();
    // execFile's timeout only signals the child; one that never exits never calls back
    const first = await Promise.race([
      readHostSensors({ gpu: true }),
      new Promise<'hung'>((r) => setTimeout(() => r('hung'), 4000)),
    ]);
    expect(first).not.toBe('hung');
    expect(performance.now() - started).toBeLessThan(3500);
    expect((first as { gpu?: object }).gpu).toBeUndefined();
    expect(counted('nvidia-smi')).toBe(1);
    // the reader that timed out is left alone like a failing one: the next poll does not start a second
    vi.setSystemTime(Date.now() + 2500);
    await readHostSensors({ gpu: true });
    expect(counted('nvidia-smi')).toBe(1);
    // the child finally exiting changes nothing
    state.heldNvidia.forEach((answer) => answer());
    await tick();
    expect(counted('nvidia-smi')).toBe(1);
    stopHostSensors();
  });
});

describe('the PowerShell RAM probe', () => {
  it('is never waited for: the memory in use shows at once, and the total once Windows has answered', async () => {
    state.nvidia = new Error('no nvidia');
    state.holdPowershell = true;
    const { readHostSensors, stopHostSensors } = await load();
    await readHostSensors({ gpu: true }); // starts the sampler
    (state.spawnCalls[0].stdout as PassThrough).write(HEADER + ROW);
    await tick();
    vi.setSystemTime(Date.now() + 2500);
    // PowerShell has not answered (and never will unless the test lets it): the read must not wait for it
    const first = await Promise.race([
      readHostSensors({ gpu: true }),
      new Promise<'waited'>((r) => setTimeout(() => r('waited'), 1000)),
    ]);
    expect(first).not.toBe('waited');
    expect((first as { gpu?: object }).gpu).toEqual({ percent: 20, memUsedMB: 1024 });
    expect(counted('powershell.exe')).toBe(1);
    // a poll while the probe is still running starts no second PowerShell
    vi.setSystemTime(Date.now() + 2500);
    (state.spawnCalls[0].stdout as PassThrough).write(ROW);
    await tick();
    expect((await readHostSensors({ gpu: true })).gpu?.memTotalMB).toBeUndefined();
    expect(counted('powershell.exe')).toBe(1);
    // Windows answers 16 GiB: an integrated GPU may use half of it
    state.powershell = '17179869184\r\n';
    state.heldPowershell.forEach((answer) => answer());
    await tick();
    for (let i = 0; i < 2; i++) {
      vi.setSystemTime(Date.now() + 2500);
      (state.spawnCalls[0].stdout as PassThrough).write(ROW);
      await tick();
      const out = await readHostSensors({ gpu: true });
      expect(out.gpu).toEqual({ percent: 20, memUsedMB: 1024, memTotalMB: 8192, memPercent: 13 });
    }
    // the answer is kept: PowerShell is not asked again
    expect(counted('powershell.exe')).toBe(1);
    stopHostSensors();
  });
});

describe('the GPU counters do not stay in the sampler for good', () => {
  it('holds them for a while after the last read that needed them, then drops them', async () => {
    const { createWindowsSource, windowsCounterList } = await load();
    let clock = 1_000;
    const started: string[][] = [];
    const stream = {
      read: async (counters: string[]) => {
        started.push(counters);
        return undefined;
      },
      stop: () => undefined,
    };
    const source = createWindowsSource(stream, () => clock);
    await source.read();
    source.needGpuCounters();
    clock += 60_000;
    await source.read(); // still inside the hold
    clock += 61_000; // 121 s after the last need
    await source.read();
    expect(started).toEqual([windowsCounterList(false), windowsCounterList(true), windowsCounterList(false)]);
  });
});
