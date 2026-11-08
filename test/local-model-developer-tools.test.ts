/**
 * @fileoverview Tests for src/local-model/developer-tools.ts: whether this Mac has the
 * developer tools a coding agent calls.
 *
 * Pinned: the ONLY command it ever runs is `/usr/bin/xcode-select -p` (never `git` or
 * `python3`, which open a system window on a Mac without the tools), with a timeout; exit 0
 * is `present`, any other exit is `missing`, no answer is `unknown`; off macOS nothing is run
 * at all; nothing it is given can make it throw; and an answer is reused for a minute, so a
 * window that polls once a second does not spawn once a second.
 *
 * Port: N/A (the runner is injected; nothing is spawned).
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  checkDeveloperTools,
  createDeveloperToolsCheck,
  DEVELOPER_TOOLS_TIMEOUT_MS,
  resetDeveloperToolsCache,
} from '../src/local-model/developer-tools.js';

type Run = (file: string, args: readonly string[], timeoutMs: number) => Promise<number | null>;

/** A runner that answers `code` and records how it was called. */
function runner(code: number | null): { run: Run; calls: [string, readonly string[], number][] } {
  const calls: [string, readonly string[], number][] = [];
  return {
    calls,
    run: async (file, args, timeoutMs) => {
      calls.push([file, args, timeoutMs]);
      return code;
    },
  };
}

afterEach(() => {
  resetDeveloperToolsCache();
  vi.restoreAllMocks();
});

describe('checkDeveloperTools', () => {
  it('runs exactly one command: /usr/bin/xcode-select -p, bounded', async () => {
    const { run, calls } = runner(0);
    expect(await checkDeveloperTools({ platform: 'darwin', run })).toBe('present');
    expect(calls).toEqual([['/usr/bin/xcode-select', ['-p'], DEVELOPER_TOOLS_TIMEOUT_MS]]);
    expect(DEVELOPER_TOOLS_TIMEOUT_MS).toBe(2_000);
  });

  it('never names git, python or xcrun, whatever the answer is', async () => {
    for (const code of [0, 1, 2, null]) {
      const { run, calls } = runner(code);
      await checkDeveloperTools({ platform: 'darwin', run });
      expect(calls).toHaveLength(1);
      expect(calls[0][0]).toBe('/usr/bin/xcode-select');
      expect(JSON.stringify(calls)).not.toMatch(/git|python|xcrun/);
    }
  });

  it('reads exit 0 as present and any other exit as missing', async () => {
    expect(await checkDeveloperTools({ platform: 'darwin', run: runner(0).run })).toBe('present');
    // A Mac without the tools: "unable to get active developer directory", exit 2.
    expect(await checkDeveloperTools({ platform: 'darwin', run: runner(2).run })).toBe('missing');
    expect(await checkDeveloperTools({ platform: 'darwin', run: runner(1).run })).toBe('missing');
    expect(await checkDeveloperTools({ platform: 'darwin', run: runner(127).run })).toBe('missing');
  });

  it('reads no answer as unknown: a timeout, a command that could not be started, a runner that throws', async () => {
    expect(await checkDeveloperTools({ platform: 'darwin', run: runner(null).run })).toBe('unknown');
    const throwing: Run = async () => {
      throw new Error('spawn EACCES');
    };
    expect(await checkDeveloperTools({ platform: 'darwin', run: throwing })).toBe('unknown');
    // An exit code that is no whole number is no answer either.
    expect(await checkDeveloperTools({ platform: 'darwin', run: runner(Number.NaN).run })).toBe('unknown');
  });

  it('runs nothing off macOS and answers unknown', async () => {
    for (const platform of ['linux', 'win32', 'freebsd']) {
      const { run, calls } = runner(0);
      expect(await checkDeveloperTools({ platform, run }), platform).toBe('unknown');
      expect(calls).toEqual([]);
    }
  });

  it('spawns nothing with the default runner under vitest', async () => {
    // The real `execFile` is never reached here: on a Mac this would otherwise run the command.
    expect(await checkDeveloperTools({ platform: 'darwin' })).toBe('unknown');
    // And with no argument at all it answers for this machine without throwing.
    expect(['present', 'missing', 'unknown']).toContain(await checkDeveloperTools());
  });
});

describe('the cached check', () => {
  it('reuses an answer for a minute, then asks again', async () => {
    const { run, calls } = runner(2);
    let clock = 1_000_000;
    const check = createDeveloperToolsCheck({ platform: 'darwin', run, now: () => clock });
    expect(await check()).toBe('missing');
    // A window that polls once a second for a minute.
    for (let second = 1; second < 60; second++) {
      clock += 1_000;
      expect(await check()).toBe('missing');
    }
    expect(calls).toHaveLength(1);
    clock += 1_000;
    expect(await check()).toBe('missing');
    expect(calls).toHaveLength(2);
  });

  it('shares one run among callers that ask at the same time', async () => {
    let release: (code: number) => void = () => undefined;
    let started = 0;
    const run: Run = () => {
      started += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const check = createDeveloperToolsCheck({ platform: 'darwin', run });
    const asked = [check(), check(), check()];
    await Promise.resolve();
    expect(started).toBe(1);
    release(0);
    expect(await Promise.all(asked)).toEqual(['present', 'present', 'present']);
  });

  it('does not remember "unknown": a check that did not work is tried again', async () => {
    let calls = 0;
    // No answer the first time, exit 0 from then on.
    const run: Run = async () => (calls++ === 0 ? null : 0);
    const check = createDeveloperToolsCheck({ platform: 'darwin', run, now: () => 5 });
    expect(await check()).toBe('unknown');
    expect(await check()).toBe('present');
    expect(await check()).toBe('present');
    expect(calls).toBe(2);
  });

  it('sees the tools once they were installed, after the minute', async () => {
    const answers = [2, 0];
    let calls = 0;
    let clock = 0;
    const check = createDeveloperToolsCheck({
      platform: 'darwin',
      run: async () => answers[calls++] ?? 0,
      now: () => clock,
    });
    expect(await check()).toBe('missing');
    clock = 59_999;
    expect(await check()).toBe('missing');
    clock = 60_000;
    expect(await check()).toBe('present');
  });
});
