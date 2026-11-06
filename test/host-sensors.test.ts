/**
 * @fileoverview The pure parsers behind the opt-in header readings (nvidia-smi, the amdgpu clock table,
 * cpufreq and /proc/cpuinfo, typeperf), readHostSensors reading nothing unless a reading is asked for, the
 * typeperf counter stream's life cycle (first sample, recycling, idle stop, back-off after a failed start,
 * no wait on a cold sampler by default, a late row from a replaced sampler), and the Windows sampler that
 * every browser shares. No hardware needed.
 */
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  createCounterStream,
  createWindowsSource,
  windowsCounterList,
  meanKhzAsMhz,
  parseCpuInfoMhz,
  parseDpmClock,
  parseNvidiaSmi,
  parseTypeperf,
  readHostSensors,
} from '../src/host-sensors.js';

describe('parseNvidiaSmi', () => {
  it('reads load, memory and clock from the first GPU', () => {
    expect(parseNvidiaSmi('37, 2048, 8192, 1815\n12, 1, 8192, 210\n')).toEqual({
      percent: 37,
      memUsedMB: 2048,
      memTotalMB: 8192,
      memPercent: 25,
      mhz: 1815,
    });
  });

  it('keeps the load when the driver reports no memory or clock, and refuses non-numbers', () => {
    expect(parseNvidiaSmi('5, [N/A], [N/A], [N/A]')).toEqual({ percent: 5 });
    expect(parseNvidiaSmi('[N/A], 1, 2, 3')).toBeUndefined();
    expect(parseNvidiaSmi('')).toBeUndefined();
  });

  it('clamps a load above 100', () => {
    expect(parseNvidiaSmi('140, 1, 2, 3')?.percent).toBe(100);
  });
});

describe('clock parsers', () => {
  it('takes the active line of an amdgpu pp_dpm_sclk table', () => {
    expect(parseDpmClock('0: 500Mhz\n1: 1200Mhz *\n2: 2100Mhz\n')).toBe(1200);
    expect(parseDpmClock('0: 500Mhz\n')).toBeUndefined();
  });

  it('averages per-core kHz readings into MHz and ignores gaps', () => {
    expect(meanKhzAsMhz([3000000, 4000000, Number.NaN, 0])).toBe(3500);
    expect(meanKhzAsMhz([])).toBeUndefined();
  });

  it('averages the cpu MHz lines of /proc/cpuinfo', () => {
    expect(parseCpuInfoMhz('processor : 0\ncpu MHz\t\t: 3000.500\nprocessor : 1\ncpu MHz\t\t: 4000.500\n')).toBe(3501);
    expect(parseCpuInfoMhz('model name : x\n')).toBeUndefined();
  });
});

describe('parseTypeperf', () => {
  const header = [
    '(PDH-CSV 4.0)',
    '\\\\DAEDALUS\\GPU Engine(pid_10728_luid_0x00000000_0x000139EC_phys_0_eng_0_engtype_3D)\\Utilization Percentage',
    '\\\\DAEDALUS\\GPU Engine(pid_2016_luid_0x00000000_0x000139EC_phys_0_eng_0_engtype_3D)\\Utilization Percentage',
    '\\\\DAEDALUS\\GPU Engine(pid_2016_luid_0x00000000_0x000139EC_phys_0_eng_1_engtype_VideoDecode)\\Utilization Percentage',
    '\\\\DAEDALUS\\GPU Engine(pid_9_luid_0x00000000_0x00013DF2_phys_0_eng_0_engtype_3D)\\Utilization Percentage',
    '\\\\DAEDALUS\\GPU Adapter Memory(luid_0x00000000_0x000139EC_phys_0)\\Shared Usage',
    '\\\\DAEDALUS\\GPU Adapter Memory(luid_0x00000000_0x000139EC_phys_0)\\Dedicated Usage',
    '\\\\DAEDALUS\\GPU Adapter Memory(luid_0x00000000_0x00013DF2_phys_0)\\Shared Usage',
    '\\\\DAEDALUS\\Processor Information(_Total)\\Processor Frequency',
  ];
  const sample = (values: string[]) =>
    `\r\n"${header.join('","')}"\r\n"${values.join('","')}"\r\nExiting, please wait...  The command completed successfully.\r\n`;

  it('takes the busiest engine type of the adapter holding the most memory, and the clock', () => {
    const out = parseTypeperf(
      sample(['10/23/2026 21:00:00.123', '12.5', '30', '3.5', '99', '1015808000', '0', '8192', '1640'])
    );
    // 3D engines sum to 42.5 (the video decode engine is lower), and the software adapter's 99 is ignored
    expect(out.gpu).toEqual({ percent: 43, memUsedMB: 969, dedicated: false });
    expect(out.cpuMhz).toBe(1640);
  });

  it('caps the load at 100 and marks an adapter with dedicated memory', () => {
    const out = parseTypeperf(sample(['t', '80', '70', '0', '0', '0', '2147483648', '0', '1000']));
    expect(out.gpu).toEqual({ percent: 100, memUsedMB: 2048, dedicated: true });
  });

  it('skips counters with no value and answers nothing for unusable output', () => {
    const out = parseTypeperf(sample(['t', ' ', ' ', ' ', ' ', ' ', ' ', ' ', ' ']));
    expect(out.cpuMhz).toBeUndefined();
    expect(parseTypeperf('')).toEqual({});
    expect(parseTypeperf('The specified counter could not be found.')).toEqual({});
  });
});

describe('readHostSensors', () => {
  it('reads nothing at all unless a reading is asked for', async () => {
    expect(await readHostSensors({})).toEqual({});
    expect(await readHostSensors({ gpu: false, cpuMhz: false })).toEqual({});
  });
});

describe('createCounterStream', () => {
  const ROW = (a: string) => `"t","${a}"\r\n`;
  const HEADER = '"(PDH-CSV 4.0)","\\\\H\\Processor Information(_Total)\\Processor Frequency"\r\n';

  function fake() {
    const children: Array<{ stdout: PassThrough; killed: boolean; emitter: EventEmitter }> = [];
    let clock = 1000;
    const stream = createCounterStream({
      start: () => {
        const stdout = new PassThrough();
        const emitter = new EventEmitter();
        const child = { stdout, killed: false, emitter };
        children.push(child);
        return {
          stdout,
          kill: () => {
            child.killed = true;
            return true;
          },
          once: (event: string, cb: () => void) => emitter.once(event, cb),
        } as never;
      },
      now: () => clock,
      firstSampleMs: 50,
      recycleMs: 30000,
      idleMs: 30000,
      backoffMs: 60000,
    });
    return { children, stream, advance: (ms: number) => (clock += ms) };
  }
  const counters = ['\\Processor Information(_Total)\\Processor Frequency'];

  it('waits for the first sample, then hands out the newest without starting another sampler', async () => {
    const { children, stream } = fake();
    const first = stream.read(counters);
    children[0].stdout.write('\r\n' + HEADER + ROW('1700'));
    expect(await first).toEqual({ cpuMhz: 1700 });
    children[0].stdout.write(ROW('1900'));
    await new Promise((r) => setImmediate(r));
    expect(await stream.read(counters)).toEqual({ cpuMhz: 1900 });
    expect(children).toHaveLength(1);
  });

  it('replaces an old sampler so new GPU processes are counted, and stops an idle one', async () => {
    const { children, stream, advance } = fake();
    const first = stream.read(counters);
    children[0].stdout.write(HEADER + ROW('1700'));
    await first;
    advance(31000);
    const again = stream.read(counters);
    expect(children).toHaveLength(2);
    expect(children[0].killed).toBe(true);
    children[1].stdout.write(HEADER + ROW('1800'));
    expect(await again).toEqual({ cpuMhz: 1800 });
    advance(31000);
    stream.sweep();
    expect(children[1].killed).toBe(true);
  });

  it('gives up quietly, and waits before trying again, when the sampler ends without a sample', async () => {
    const { children, stream, advance } = fake();
    const first = stream.read(counters);
    children[0].emitter.emit('exit');
    expect(await first).toBeUndefined();
    expect(await stream.read(counters)).toBeUndefined();
    expect(children).toHaveLength(1);
    advance(61000);
    void stream.read(counters);
    expect(children).toHaveLength(2);
  });

  it('does not wait at all by default: a cold sampler answers nothing and the next read has the sample', async () => {
    const children: PassThrough[] = [];
    const stream = createCounterStream({
      start: () => {
        const stdout = new PassThrough();
        children.push(stdout);
        return { stdout, kill: () => true, once: () => undefined } as never;
      },
    });
    const counters = ['\\Processor Information(_Total)\\Processor Frequency'];
    const header = '"(PDH-CSV 4.0)","\\\\H\\Processor Information(_Total)\\Processor Frequency"\r\n';
    const started = Date.now();
    expect(await stream.read(counters)).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(500);
    children[0].write(header + '"t","1700"\r\n');
    await new Promise((r) => setImmediate(r));
    expect(await stream.read(counters)).toEqual({ cpuMhz: 1700 });
    expect(children).toHaveLength(1);
  });

  it('answers nothing, within the wait, when no sample ever arrives', async () => {
    const { stream } = fake();
    expect(await stream.read(counters)).toBeUndefined();
  });
});

describe('the Windows sampler shared by every browser', () => {
  const HEADER = '"(PDH-CSV 4.0)","\\\\H\\Processor Information(_Total)\\Processor Frequency"\r\n';

  function rig() {
    const children: Array<{ stdout: PassThrough; killed: boolean; counters: string[] }> = [];
    const stream = createCounterStream({
      start: (counters) => {
        const stdout = new PassThrough();
        const child = { stdout, killed: false, counters };
        children.push(child);
        return {
          stdout,
          kill: () => {
            child.killed = true;
            return true;
          },
          once: () => undefined,
        } as never;
      },
      firstSampleMs: 20,
    });
    return { children, source: createWindowsSource(stream) };
  }

  it('samples the same counters whatever a browser asked for, so two browsers share one process', async () => {
    const { children, source } = rig();
    // browser A (GPU Stats) and browser B (GPU Stats and CPU MHz) read the same sampler in turn
    for (let i = 0; i < 8; i++) {
      const read = source.read();
      if (i === 0) children[0].stdout.write(HEADER + '"t","1700"\r\n');
      await read;
    }
    expect(children).toHaveLength(1);
    expect(children[0].killed).toBe(false);
  });

  it('adds the GPU counters with one restart on a machine with no native GPU reader, and keeps them while needed', async () => {
    const { children, source } = rig();
    void source.read();
    expect(children[0].counters).toEqual(windowsCounterList(false));
    expect(children[0].counters.some((c) => c.includes('GPU Engine'))).toBe(false);
    source.needGpuCounters();
    void source.read();
    expect(children).toHaveLength(2);
    expect(children[0].killed).toBe(true);
    expect(children[1].counters).toEqual(windowsCounterList(true));
    source.needGpuCounters();
    void source.read();
    void source.read();
    expect(children).toHaveLength(2);
  });
});

describe('a late row from a replaced sampler', () => {
  it("is ignored, so it can never become the new sampler's header", async () => {
    const children: PassThrough[] = [];
    let clock = 1000;
    const stream = createCounterStream({
      start: () => {
        const stdout = new PassThrough();
        children.push(stdout);
        return { stdout, kill: () => true, once: () => undefined } as never;
      },
      now: () => clock,
      firstSampleMs: 20,
      recycleMs: 30000,
    });
    const counters = ['\\Processor Information(_Total)\\Processor Frequency'];
    const header = '"(PDH-CSV 4.0)","\\\\H\\Processor Information(_Total)\\Processor Frequency"\r\n';
    const first = stream.read(counters);
    children[0].write(header + '"t","1700"\r\n');
    await first;
    clock += 31000;
    const second = stream.read(counters); // replaces the sampler
    expect(children).toHaveLength(2);
    // the killed process still had a data row in its pipe: it arrives after the replacement began
    children[0].write('"t","999"\r\n');
    await new Promise((r) => setImmediate(r));
    // the stale row is not a sample: with nothing from the new process yet there is still nothing to hand out
    expect(await stream.read(counters)).toBeUndefined();
    children[1].write(header + '"t","1800"\r\n');
    await second;
    await new Promise((r) => setImmediate(r));
    expect(await stream.read(counters)).toEqual({ cpuMhz: 1800 });
  });
});
