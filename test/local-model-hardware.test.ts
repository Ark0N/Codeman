/**
 * @fileoverview Tests for src/local-model/hardware.ts: the probe that tells the recommendation
 * what this Mac is.
 *
 * Two halves, mirroring the module:
 *
 * 1. `parseSysctl()`, pure. Fed the REAL output of the probe command on the two test Macs (a
 *    MacBook Pro with an M5 Pro and 48 GB, a Mac mini with an M4 and 16 GB), copied here
 *    character for character with the extra lines the capture holds, plus an Intel-shaped
 *    output (three of the seven keys do not exist there) and outputs cut off mid-line.
 * 2. `readHardware()`, with every piece of IO injected: nothing is spawned and no real disk is
 *    read. What is pinned: a failed spawn is an ANSWER (the `os-fallback` shape), nothing is
 *    spawned off macOS, the result is cached for 60 s and concurrent callers share one probe.
 *
 * The IO itself is tested apart, against things this suite controls:
 *
 * 3. `spawnSysctl()` runs a small shell script of the test in place of sysctl. That proves what
 *    a fake cannot: the arguments are the seven keys and nothing else, the output of a program
 *    that exits 1 is still read (an Intel Mac lacks three keys, so sysctl exits 1 there), a
 *    program that hangs is given up on, and the server's environment is not handed over.
 * 4. `dataDirFreeBytes()` with injected probes: a folder that does not exist yet, a mount that
 *    does not answer, and a `statfs` that never comes back, which must not be started twice.
 *
 * One test at the end runs the real defaults once (the real spawn and the real `statfs`), to
 * prove they cannot reject on whatever machine runs the suite. On Linux `sysctl` knows none of
 * the keys, so that run ends in the fallback; on a Mac it ends in a real answer. Both are fine.
 *
 * Port: N/A (no server).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  dataDirFreeBytes,
  FREE_DISK_TIMEOUT_MS,
  freeDiskBytesOf,
  HARDWARE_CACHE_TTL_MS,
  parseSysctl,
  readHardware,
  resetHardwareCache,
  spawnSysctl,
  SYSCTL_KEYS,
  SYSCTL_PATH,
  SYSCTL_TIMEOUT_MS,
  type HardwareProbeDeps,
} from '../src/local-model/hardware.js';

/**
 * The capture of the MacBook Pro (Mac17,13), 2026-11-06. The last four lines are not part of
 * the probe: two extra keys the capture asked for, the shell's exit status and a `df -k` line.
 */
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

/** The capture of the Mac mini (Mac16,10), 2026-11-06, with the same four extra lines. */
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

/** Free disk of the two Macs: the "available" column of their `df -k` lines, in bytes. */
const MACBOOK_FREE_DISK = 890_926_084 * 1024;
const MACMINI_FREE_DISK = 41_752_848 * 1024;

/**
 * What an Intel Mac prints: `hw.optional.arm64`, `sysctl.proc_translated` and
 * `iogpu.wired_limit_mb` do not exist there, so sysctl leaves their lines out (and exits 1).
 * NOT a capture: no Intel Mac was available, the shape is recalled.
 */
const INTEL_SYSCTL = `hw.memsize: 17179869184
machdep.cpu.brand_string: Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz
kern.osproductversion: 13.6.7
hw.model: MacBookPro15,1
`;

/** Deps that spawn nothing and read no disk. A test overrides what it is about. */
function deps(overrides: HardwareProbeDeps = {}): HardwareProbeDeps {
  return {
    platform: 'darwin',
    arch: 'arm64',
    runSysctl: async () => MACMINI_SYSCTL,
    freeDiskBytes: async () => MACMINI_FREE_DISK,
    totalMemBytes: () => 8 * 1024 ** 3,
    cpuModel: () => 'Fallback CPU',
    now: () => 1_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  resetHardwareCache();
});

afterEach(() => {
  resetHardwareCache();
});

describe('the probe command', () => {
  it('is an absolute path and asks for exactly the seven keys, never with -n', () => {
    expect(isAbsolute(SYSCTL_PATH)).toBe(true);
    expect(SYSCTL_PATH).toBe('/usr/sbin/sysctl');
    expect([...SYSCTL_KEYS]).toEqual([
      'hw.memsize',
      'machdep.cpu.brand_string',
      'hw.optional.arm64',
      'sysctl.proc_translated',
      'iogpu.wired_limit_mb',
      'kern.osproductversion',
      'hw.model',
    ]);
    // Every argument is a key name. `-n` would print bare values, and a key missing on a
    // machine would then shift every value after it onto the wrong key.
    for (const key of SYSCTL_KEYS) expect(key).toMatch(/^[a-z][a-z0-9_.]*$/);
  });

  it('is bounded, and its result is reused for 60 seconds', () => {
    expect(SYSCTL_TIMEOUT_MS).toBe(2000);
    expect(HARDWARE_CACHE_TTL_MS).toBe(60_000);
  });
});

describe('parseSysctl on the two real Macs', () => {
  it('reads the MacBook Pro: M5 Pro, 48 GB, macOS 27.2, no wired limit set', () => {
    expect(parseSysctl(MACBOOK_SYSCTL)).toEqual({
      memBytes: 51_539_607_552,
      chip: 'Apple M5 Pro',
      arm64: true,
      translated: false,
      wiredLimitMb: 0,
      macosVersion: '27.2',
      macosMajor: 27,
      model: 'Mac17,13',
    });
  });

  it('reads the Mac mini: M4, 16 GB, macOS 27.2, no wired limit set', () => {
    expect(parseSysctl(MACMINI_SYSCTL)).toEqual({
      memBytes: 17_179_869_184,
      chip: 'Apple M4',
      arm64: true,
      translated: false,
      wiredLimitMb: 0,
      macosVersion: '27.2',
      macosMajor: 27,
      model: 'Mac16,10',
    });
  });

  it('skips the lines it does not know: other keys, the exit status, the df line', () => {
    const facts = parseSysctl(MACMINI_SYSCTL);
    expect(Object.keys(facts).sort()).toEqual(
      ['arm64', 'chip', 'macosMajor', 'macosVersion', 'memBytes', 'model', 'translated', 'wiredLimitMb'].sort()
    );
  });

  it('reports a wired limit of 0 as 0 (not set), and a set one as its number', () => {
    expect(parseSysctl(MACMINI_SYSCTL).wiredLimitMb).toBe(0);
    expect(parseSysctl('iogpu.wired_limit_mb: 14000\n').wiredLimitMb).toBe(14000);
  });
});

describe('parseSysctl on other shapes', () => {
  it('reads an Intel Mac, whose output lacks three of the keys, without shifting a value', () => {
    expect(parseSysctl(INTEL_SYSCTL)).toEqual({
      memBytes: 17_179_869_184,
      chip: 'Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz',
      macosVersion: '13.6.7',
      macosMajor: 13,
      model: 'MacBookPro15,1',
    });
  });

  it('reads an Intel Mac that does print the arm64 flag, as 0', () => {
    const facts = parseSysctl(`hw.optional.arm64: 0\n${INTEL_SYSCTL}`);
    expect(facts.arm64).toBe(false);
    expect(facts.translated).toBeUndefined();
  });

  it('reads a process under Rosetta: the machine is arm64 and the process is translated', () => {
    const facts = parseSysctl(MACMINI_SYSCTL.replace('sysctl.proc_translated: 0', 'sysctl.proc_translated: 1'));
    expect(facts.arm64).toBe(true);
    expect(facts.translated).toBe(true);
  });

  it('drops a line that was cut off: a truncated output never yields half a value', () => {
    // Cut in the middle of the chip name. The memory line before it is whole.
    const cutInChip = 'hw.memsize: 17179869184\nmachdep.cpu.brand_string: Apple M';
    expect(parseSysctl(cutInChip)).toEqual({ memBytes: 17_179_869_184 });

    // Cut in the middle of the memory figure: '1717' would be a valid, wrong number.
    expect(parseSysctl('hw.memsize: 1717')).toEqual({});

    // Cut right after a whole line: everything up to there counts.
    const cutAfterLine = MACMINI_SYSCTL.slice(0, MACMINI_SYSCTL.indexOf('hw.optional.arm64'));
    expect(parseSysctl(cutAfterLine)).toEqual({ memBytes: 17_179_869_184, chip: 'Apple M4' });
  });

  it('reads nothing from an empty output or from error text', () => {
    expect(parseSysctl('')).toEqual({});
    expect(parseSysctl('\n\n')).toEqual({});
    expect(
      parseSysctl("sysctl: unknown oid 'hw.memsize'\nsysctl: cannot stat /proc/sys/hw/memsize: No such file\n")
    ).toEqual({});
  });

  it('leaves out a value that does not parse instead of guessing', () => {
    const facts = parseSysctl(
      [
        'hw.memsize: lots',
        'machdep.cpu.brand_string: ',
        'hw.optional.arm64: yes',
        'sysctl.proc_translated: 2',
        'iogpu.wired_limit_mb: -1',
        'kern.osproductversion: Sequoia',
        `hw.model: ${'x'.repeat(200)}`,
        '',
      ].join('\n')
    );
    expect(facts).toEqual({});
  });

  it('refuses a memory size of 0 or one too large to be a number of bytes', () => {
    expect(parseSysctl('hw.memsize: 0\n').memBytes).toBeUndefined();
    expect(parseSysctl('hw.memsize: 99999999999999999999999\n').memBytes).toBeUndefined();
  });

  it('accepts Windows line ends and padding, and the first line of a key wins', () => {
    const facts = parseSysctl('hw.memsize:   17179869184  \r\nhw.model: Mac16,10\r\nhw.model: Other9,9\r\n');
    expect(facts).toEqual({ memBytes: 17_179_869_184, model: 'Mac16,10' });
  });

  it('reads the macOS major version from one, two or three numbers', () => {
    expect(parseSysctl('kern.osproductversion: 14\n')).toMatchObject({ macosVersion: '14', macosMajor: 14 });
    expect(parseSysctl('kern.osproductversion: 15.7\n')).toMatchObject({ macosVersion: '15.7', macosMajor: 15 });
    expect(parseSysctl('kern.osproductversion: 13.6.7\n')).toMatchObject({ macosVersion: '13.6.7', macosMajor: 13 });
  });
});

describe('readHardware on the two real Macs', () => {
  it('describes the MacBook Pro', async () => {
    const hw = await readHardware(
      deps({ runSysctl: async () => MACBOOK_SYSCTL, freeDiskBytes: async () => MACBOOK_FREE_DISK })
    );
    expect(hw).toEqual({
      platform: 'darwin',
      arch: 'arm64',
      arm64: true,
      translated: false,
      memBytes: 51_539_607_552,
      memGb: '51.5',
      memClassGb: 48,
      chip: 'Apple M5 Pro',
      model: 'Mac17,13',
      macosVersion: '27.2',
      macosMajor: 27,
      wiredLimitMb: 0,
      freeDiskBytes: MACBOOK_FREE_DISK,
      freeDiskGb: '912',
      source: 'sysctl',
    });
  });

  it('describes the Mac mini', async () => {
    const hw = await readHardware(deps());
    expect(hw).toEqual({
      platform: 'darwin',
      arch: 'arm64',
      arm64: true,
      translated: false,
      memBytes: 17_179_869_184,
      memGb: '17.2',
      memClassGb: 16,
      chip: 'Apple M4',
      model: 'Mac16,10',
      macosVersion: '27.2',
      macosMajor: 27,
      wiredLimitMb: 0,
      freeDiskBytes: MACMINI_FREE_DISK,
      freeDiskGb: '42.8',
      source: 'sysctl',
    });
  });

  it('is plain JSON: it survives a round trip unchanged', async () => {
    const hw = await readHardware(deps());
    expect(JSON.parse(JSON.stringify(hw))).toEqual(hw);
  });

  it('describes an Intel Mac from its shorter output: no arm64 flag, an x64 process', async () => {
    const hw = await readHardware(deps({ arch: 'x64', runSysctl: async () => INTEL_SYSCTL }));
    expect(hw.source).toBe('sysctl');
    expect(hw.arch).toBe('x64');
    expect(hw.chip).toBe('Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz');
    expect(hw.macosMajor).toBe(13);
    expect(hw).not.toHaveProperty('arm64');
    expect(hw).not.toHaveProperty('translated');
    expect(hw).not.toHaveProperty('wiredLimitMb');
  });

  it('takes the chip name from node:os when sysctl printed everything but that', async () => {
    const hw = await readHardware(
      deps({ runSysctl: async () => MACMINI_SYSCTL.replace('machdep.cpu.brand_string: Apple M4\n', '') })
    );
    expect(hw.source).toBe('sysctl');
    expect(hw.chip).toBe('Fallback CPU');
  });
});

describe('readHardware when the probe fails', () => {
  it('answers from node:os when the spawn could not run or timed out', async () => {
    const hw = await readHardware(
      deps({
        runSysctl: async () => undefined,
        totalMemBytes: () => 34_359_738_368,
        cpuModel: () => 'Apple M2 Max',
      })
    );
    expect(hw).toEqual({
      platform: 'darwin',
      arch: 'arm64',
      memBytes: 34_359_738_368,
      memGb: '34.4',
      memClassGb: 32,
      chip: 'Apple M2 Max',
      freeDiskBytes: MACMINI_FREE_DISK,
      freeDiskGb: '42.8',
      source: 'os-fallback',
    });
  });

  it('never rejects when a dependency throws or rejects', async () => {
    const hw = await readHardware(
      deps({
        runSysctl: () => Promise.reject(new Error('spawn EACCES')),
        freeDiskBytes: () => {
          throw new Error('statfs failed');
        },
        cpuModel: () => {
          throw new Error('no cpus');
        },
      })
    );
    expect(hw.source).toBe('os-fallback');
    expect(hw.memBytes).toBe(8 * 1024 ** 3);
    expect(hw).not.toHaveProperty('chip');
    expect(hw).not.toHaveProperty('freeDiskBytes');
    expect(hw).not.toHaveProperty('freeDiskGb');
  });

  it('still answers when even the memory size cannot be read', async () => {
    const hw = await readHardware(
      deps({
        runSysctl: async () => undefined,
        totalMemBytes: () => {
          throw new Error('no memory figure');
        },
      })
    );
    expect(hw).toMatchObject({ source: 'os-fallback', memBytes: 0, memGb: '0.0', memClassGb: 0 });
  });

  it('trusts nothing of an output that has no memory size', async () => {
    // A truncated or foreign output: the chip and version lines are whole, hw.memsize is not there.
    const withoutMemory = MACMINI_SYSCTL.replace('hw.memsize: 17179869184\n', '');
    const hw = await readHardware(deps({ runSysctl: async () => withoutMemory }));
    expect(hw.source).toBe('os-fallback');
    expect(hw.memBytes).toBe(8 * 1024 ** 3);
    expect(hw.chip).toBe('Fallback CPU');
    expect(hw).not.toHaveProperty('macosVersion');
    expect(hw).not.toHaveProperty('macosMajor');
    expect(hw).not.toHaveProperty('model');
    expect(hw).not.toHaveProperty('wiredLimitMb');
    expect(hw).not.toHaveProperty('arm64');
  });

  it('falls back when the output was cut off inside the memory figure', async () => {
    const hw = await readHardware(deps({ runSysctl: async () => 'hw.memsize: 1717' }));
    expect(hw.source).toBe('os-fallback');
    expect(hw.memBytes).toBe(8 * 1024 ** 3);
  });

  it('leaves the free disk out when it is unknown, and keeps the rest', async () => {
    const hw = await readHardware(deps({ freeDiskBytes: async () => undefined }));
    expect(hw.source).toBe('sysctl');
    expect(hw).not.toHaveProperty('freeDiskBytes');
    expect(hw).not.toHaveProperty('freeDiskGb');
  });

  it('reports a full disk as 0 bytes free, which is a figure and not "unknown"', async () => {
    const hw = await readHardware(deps({ freeDiskBytes: async () => 0 }));
    expect(hw.freeDiskBytes).toBe(0);
    expect(hw.freeDiskGb).toBe('0.0');
  });
});

describe('readHardware off macOS', () => {
  it('spawns nothing and reads no disk', async () => {
    let spawned = 0;
    let diskRead = 0;
    const hw = await readHardware(
      deps({
        platform: 'linux',
        arch: 'x64',
        runSysctl: async () => {
          spawned++;
          return MACMINI_SYSCTL;
        },
        freeDiskBytes: async () => {
          diskRead++;
          return 1;
        },
        totalMemBytes: () => 67_430_023_168,
      })
    );
    expect(spawned).toBe(0);
    expect(diskRead).toBe(0);
    expect(hw).toEqual({
      platform: 'linux',
      arch: 'x64',
      memBytes: 67_430_023_168,
      memGb: '67.4',
      memClassGb: 63,
      source: 'not-probed',
    });
  });
});

describe('the cache of readHardware', () => {
  it('reuses one result for 60 seconds, then probes again', async () => {
    let clock = 5_000_000;
    let spawned = 0;
    const counting = deps({
      now: () => clock,
      runSysctl: async () => {
        spawned++;
        return spawned === 1 ? MACMINI_SYSCTL : MACBOOK_SYSCTL;
      },
    });

    const first = await readHardware(counting);
    clock += HARDWARE_CACHE_TTL_MS - 1;
    const second = await readHardware(counting);
    expect(spawned).toBe(1);
    expect(second).toBe(first);

    clock += 1;
    const third = await readHardware(counting);
    expect(spawned).toBe(2);
    expect(third.chip).toBe('Apple M5 Pro');
  });

  it('caches a failed probe too: a broken sysctl is not spawned on every request', async () => {
    let spawned = 0;
    const failing = deps({
      runSysctl: async () => {
        spawned++;
        return undefined;
      },
    });
    expect((await readHardware(failing)).source).toBe('os-fallback');
    expect((await readHardware(failing)).source).toBe('os-fallback');
    expect(spawned).toBe(1);
  });

  it('lets concurrent callers share one probe', async () => {
    let spawned = 0;
    let release: (text: string) => void = () => {};
    const slow = deps({
      runSysctl: () => {
        spawned++;
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      },
    });
    const callers = [readHardware(slow), readHardware(slow), readHardware(slow)];
    // Let the three calls reach the spawn before it answers.
    await new Promise((resolve) => setImmediate(resolve));
    release(MACMINI_SYSCTL);
    const results = await Promise.all(callers);
    expect(spawned).toBe(1);
    expect(results[1]).toBe(results[0]);
    expect(results[2]).toBe(results[0]);
  });

  it('probes again after a reset, and does not trust a clock that ran backwards', async () => {
    let clock = 9_000_000;
    let spawned = 0;
    const counting = deps({
      now: () => clock,
      runSysctl: async () => {
        spawned++;
        return MACMINI_SYSCTL;
      },
    });
    await readHardware(counting);
    resetHardwareCache();
    await readHardware(counting);
    expect(spawned).toBe(2);

    clock -= 10_000;
    await readHardware(counting);
    expect(spawned).toBe(3);
  });
});

// The scripts below are POSIX shell. Codeman's server does not run on Windows.
describe.skipIf(process.platform === 'win32')('spawnSysctl, against a script of the test', () => {
  let folder: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'codeman-local-model-spawn-'));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  /** An executable shell script standing in for sysctl. */
  function script(body: string, mode = 0o755): string {
    const path = join(folder, 'fake-sysctl');
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode });
    return path;
  }

  it('passes the seven keys as arguments and nothing else: no -n, no shell', async () => {
    // printf, not echo: echo would swallow a `-n` argument, the very thing this test looks for.
    const output = await spawnSysctl(script('printf \'%s\\n\' "$@"'));
    expect(output?.trimEnd().split('\n')).toEqual([...SYSCTL_KEYS]);
  });

  it('reads the output of a program that exits 1, as sysctl does on an Intel Mac', async () => {
    // Three keys are unknown there: their errors go to stderr, the other four lines to stdout.
    const output = await spawnSysctl(
      script(
        [
          "echo 'hw.memsize: 17179869184'",
          "echo 'machdep.cpu.brand_string: Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz'",
          `echo "sysctl: unknown oid 'hw.optional.arm64'" >&2`,
          `echo "sysctl: unknown oid 'sysctl.proc_translated'" >&2`,
          `echo "sysctl: unknown oid 'iogpu.wired_limit_mb'" >&2`,
          "echo 'kern.osproductversion: 13.6.7'",
          "echo 'hw.model: MacBookPro15,1'",
          'exit 1',
        ].join('\n')
      )
    );
    expect(output).toBeDefined();
    expect(output).not.toContain('unknown oid');
    expect(parseSysctl(output as string)).toEqual({
      memBytes: 17_179_869_184,
      chip: 'Intel(R) Core(TM) i7-9750H CPU @ 2.60GHz',
      macosVersion: '13.6.7',
      macosMajor: 13,
      model: 'MacBookPro15,1',
    });
  });

  it('answers undefined for a program that does not exist or may not be run', async () => {
    expect(await spawnSysctl(join(folder, 'no-such-program'))).toBeUndefined();
    expect(await spawnSysctl(script('echo "hw.memsize: 1"', 0o644))).toBeUndefined();
  });

  it('gives up on a program that hangs, and does not hand over half an output', async () => {
    const started = Date.now();
    // `exec` so the signal reaches the sleeper itself and nothing is left behind.
    const output = await spawnSysctl(script("echo 'hw.memsize: 17179869184'\nexec sleep 20"), 200);
    expect(output).toBeUndefined();
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it('answers undefined for an output far larger than seven lines', async () => {
    expect(await spawnSysctl(script("head -c 200000 /dev/zero | tr '\\0' 'x'"))).toBeUndefined();
  });

  it("does not pass the server's environment to the program", async () => {
    const name = 'CODEMAN_LOCAL_MODEL_TEST_SECRET';
    process.env[name] = 'hunter2';
    try {
      const output = await spawnSysctl(script(`echo "secret=\${${name}:-unset}"`));
      expect(output?.trim()).toBe('secret=unset');
    } finally {
      delete process.env[name];
    }
  });
});

describe('dataDirFreeBytes', () => {
  let folder: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'codeman-local-model-disk-'));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it('reads the free bytes of the data dir with the real probe and the real statfs', async () => {
    const free = await dataDirFreeBytes({ dataDir: () => folder });
    expect(typeof free).toBe('number');
    expect(free).toBeGreaterThanOrEqual(0);
  });

  it('uses the nearest existing parent when the data dir does not exist yet', async () => {
    const asked: string[] = [];
    const free = await dataDirFreeBytes({
      dataDir: () => join(folder, 'not', 'yet', 'there'),
      freeBytesOf: async (path) => {
        asked.push(path);
        return 123;
      },
    });
    expect(free).toBe(123);
    expect(asked).toEqual([folder]);
  });

  it('does not touch a folder whose mount does not answer, or a path that is a file', async () => {
    for (const kind of ['unknown', 'file'] as const) {
      let touched = 0;
      const free = await dataDirFreeBytes({
        dataDir: () => folder,
        probeKind: async () => kind,
        freeBytesOf: async () => {
          touched++;
          return 1;
        },
      });
      expect(free, kind).toBeUndefined();
      expect(touched, kind).toBe(0);
    }
  });

  it('stops walking up after a few parents', async () => {
    let probes = 0;
    const free = await dataDirFreeBytes({
      dataDir: () => '/a/b/c/d/e/f/g/h/i/j/k/l',
      probeKind: async () => {
        probes++;
        return 'absent';
      },
      freeBytesOf: async () => 1,
    });
    expect(free).toBeUndefined();
    expect(probes).toBe(7);
  });

  it('gives up on a statfs that does not come back, and never starts a second one meanwhile', async () => {
    let started = 0;
    let finish: (bytes: number) => void = () => {};
    const hanging = {
      dataDir: () => folder,
      freeBytesOf: () => {
        started++;
        return new Promise<number>((resolve) => {
          finish = resolve;
        });
      },
      timeoutMs: 20,
    };

    // The first read waits its timeout and answers "unknown".
    expect(await dataDirFreeBytes(hanging)).toBeUndefined();
    expect(started).toBe(1);

    // While that statfs is still out, later reads answer at once and start nothing.
    const before = Date.now();
    expect(await dataDirFreeBytes(hanging)).toBeUndefined();
    expect(await dataDirFreeBytes({ ...hanging, timeoutMs: 60_000 })).toBeUndefined();
    expect(Date.now() - before).toBeLessThan(1000);
    expect(started).toBe(1);

    // Once it finally answers, the next read works again.
    finish(5);
    await new Promise((resolve) => setImmediate(resolve));
    expect(await dataDirFreeBytes({ ...hanging, freeBytesOf: async () => 42 })).toBe(42);
  });

  it('never rejects when one of its reads does', async () => {
    const failing = async (): Promise<never> => {
      throw new Error('EIO');
    };
    expect(await dataDirFreeBytes({ dataDir: () => folder, freeBytesOf: failing })).toBeUndefined();
    expect(await dataDirFreeBytes({ dataDir: () => folder, probeKind: failing })).toBeUndefined();
    expect(
      await dataDirFreeBytes({
        dataDir: () => {
          throw new Error('no home');
        },
      })
    ).toBeUndefined();
  });

  it('is bounded by default', () => {
    expect(FREE_DISK_TIMEOUT_MS).toBe(2000);
  });
});

describe('the real defaults', () => {
  let folder: string;

  beforeEach(() => {
    folder = mkdtempSync(join(tmpdir(), 'codeman-local-model-hw-'));
  });

  afterEach(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  it('reads the free bytes of a real folder, and undefined for one that does not exist', async () => {
    const free = await freeDiskBytesOf(folder);
    expect(typeof free).toBe('number');
    expect(free).toBeGreaterThanOrEqual(0);
    expect(await freeDiskBytesOf(join(folder, 'missing', 'deeper'))).toBeUndefined();
  });

  it('never rejects with the real spawn and the real disk read, whatever machine this is', async () => {
    // Pretend to be a Mac so the spawn and the disk read really run. On Linux /usr/sbin/sysctl
    // either does not exist or knows none of the keys: the answer is then the fallback.
    const hw = await readHardware({ platform: 'darwin' });
    expect(['sysctl', 'os-fallback']).toContain(hw.source);
    expect(hw.memBytes).toBeGreaterThan(0);
    expect(hw.memGb).toMatch(/^\d+(\.\d)?$/);
    if (hw.freeDiskBytes !== undefined) {
      expect(hw.freeDiskBytes).toBeGreaterThanOrEqual(0);
      expect(hw.freeDiskGb).toMatch(/^\d+(\.\d)?$/);
    }
  });
});
