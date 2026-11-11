/**
 * The auto-compact and auto-clear trigger: which number it reads, and what it does after a
 * command went out. `decideAutoThreshold` is pure, so its cases need no session. The class tests
 * run the real SessionAutoOps on fake timers to pin the part the function cannot see: when the
 * values it compares against are taken. The last block pins the wiring from a statusline report
 * to the checks on a real Session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SessionAutoOps,
  decideAutoThreshold,
  type AutoThresholdInput,
  type ContextReport,
} from '../src/session-auto-ops.js';
import { Session } from '../src/session.js';

const input = (over: Partial<AutoThresholdInput>): AutoThresholdInput => ({
  threshold: 100_000,
  report: null,
  reportTokensAtCommand: null,
  counterTokens: 0,
  counterBaseline: 0,
  ...over,
});

describe('decideAutoThreshold', () => {
  describe('with a statusline report', () => {
    it('fires at the threshold and not below it', () => {
      expect(decideAutoThreshold(input({ report: { tokens: 100_000 } }))).toEqual({
        trigger: true,
        tokens: 100_000,
        source: 'statusline',
      });
      expect(decideAutoThreshold(input({ report: { tokens: 99_999 } })).trigger).toBe(false);
    });

    it('wins over the counter in both directions', () => {
      // The real case: the counter misses the cached context.
      expect(decideAutoThreshold(input({ report: { tokens: 243_000 }, counterTokens: 81_000 })).trigger).toBe(true);
      expect(decideAutoThreshold(input({ report: { tokens: 50_000 }, counterTokens: 200_000 })).trigger).toBe(false);
    });

    it('treats a report of 0 as a report, not as a missing one', () => {
      const decision = decideAutoThreshold(input({ report: { tokens: 0 }, counterTokens: 200_000 }));
      expect(decision).toMatchObject({ trigger: false, source: 'statusline' });
    });
  });

  describe('without a report', () => {
    it('falls back to the counter', () => {
      expect(decideAutoThreshold(input({ counterTokens: 100_000 }))).toEqual({
        trigger: true,
        tokens: 100_000,
        source: 'counter',
      });
      expect(decideAutoThreshold(input({ counterTokens: 99_999 })).trigger).toBe(false);
    });

    it('counts from the value at the last compact, since the counter never drops', () => {
      const after = { counterBaseline: 150_000 };
      expect(decideAutoThreshold(input({ ...after, counterTokens: 150_000 })).trigger).toBe(false);
      expect(decideAutoThreshold(input({ ...after, counterTokens: 249_999 })).trigger).toBe(false);
      expect(decideAutoThreshold(input({ ...after, counterTokens: 250_000 }))).toMatchObject({
        trigger: true,
        tokens: 100_000,
      });
    });

    it('never goes negative when the counter was reset below the baseline', () => {
      expect(decideAutoThreshold(input({ counterBaseline: 150_000, counterTokens: 10 })).tokens).toBe(0);
    });
  });

  describe('after a command went out', () => {
    it('ignores the report from before the command, however long it stays the newest', () => {
      const decision = decideAutoThreshold(input({ report: { tokens: 600_000 }, reportTokensAtCommand: 600_000 }));
      expect(decision.trigger).toBe(false);
    });

    it('does not fire on the lower report the compact leaves behind', () => {
      const decision = decideAutoThreshold(input({ report: { tokens: 9_000 }, reportTokensAtCommand: 600_000 }));
      expect(decision.trigger).toBe(false);
    });

    it('fires again on a higher report, so a swallowed /compact cannot lock it off', () => {
      const decision = decideAutoThreshold(input({ report: { tokens: 601_000 }, reportTokensAtCommand: 600_000 }));
      expect(decision.trigger).toBe(true);
    });

    it('still ignores an out-of-order post of the old number after the lower report', () => {
      const lower = decideAutoThreshold(input({ report: { tokens: 9_000 }, reportTokensAtCommand: 600_000 }));
      const late = decideAutoThreshold(input({ report: { tokens: 600_000 }, reportTokensAtCommand: 600_000 }));
      expect([lower.trigger, late.trigger]).toEqual([false, false]);
    });
  });
});

describe('SessionAutoOps thresholds', () => {
  let report: ContextReport | null;
  let counter: number;
  let writes: string[];
  let ops: SessionAutoOps;

  const settle = () => vi.advanceTimersByTimeAsync(60_000);

  beforeEach(() => {
    vi.useFakeTimers();
    report = null;
    counter = 0;
    writes = [];
    ops = new SessionAutoOps({
      writeCommand: async (cmd) => {
        writes.push(cmd);
        return true;
      },
      isWorking: () => false,
      isStopped: () => false,
      getTotalTokens: () => counter,
      getContextReport: () => report,
      getSessionId: () => 'test',
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    ops.destroy();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('compacts once on a report, and not again while that report stays the newest', async () => {
    ops.setAutoCompact(true, 100_000);
    report = { tokens: 600_000 };
    ops.checkAutoCompact();
    await settle();
    expect(writes).toEqual(['/compact\r']);

    // Past the cooldown, as a compact of this size is: the old number is re-posted on a render.
    ops.checkAutoCompact();
    await settle();
    expect(writes).toEqual(['/compact\r']);
  });

  it('takes the number from the moment the command goes out, not from the trigger', async () => {
    let working = true;
    ops = new SessionAutoOps({
      writeCommand: async (cmd) => {
        writes.push(cmd);
        return true;
      },
      isWorking: () => working,
      isStopped: () => false,
      getTotalTokens: () => counter,
      getContextReport: () => report,
      getSessionId: () => 'test',
    });
    ops.setAutoCompact(true, 100_000);
    report = { tokens: 600_000 };
    ops.checkAutoCompact();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(writes).toEqual([]);

    report = { tokens: 650_000 }; // the turn it waited for finished and reported
    working = false;
    await settle();
    expect(writes).toEqual(['/compact\r']);

    ops.checkAutoCompact();
    await settle();
    expect(writes).toEqual(['/compact\r']);
  });

  it('compacts again when the number moves on, so a swallowed /compact heals itself', async () => {
    ops.setAutoCompact(true, 100_000);
    report = { tokens: 600_000 };
    ops.checkAutoCompact();
    await settle();

    report = { tokens: 601_000 };
    ops.checkAutoCompact();
    await settle();
    expect(writes).toEqual(['/compact\r', '/compact\r']);
  });

  it('does not let the stale report trigger an auto-clear after a compact', async () => {
    ops.setAutoCompact(true, 100_000);
    ops.setAutoClear(true, 140_000);
    report = { tokens: 600_000 };
    ops.checkAutoCompact();
    await settle();

    ops.checkAutoClear();
    await settle();
    expect(writes).toEqual(['/compact\r']);
  });

  it('clears once on a report, and not again while that report stays the newest', async () => {
    ops.setAutoClear(true, 140_000);
    report = { tokens: 600_000 };
    ops.checkAutoClear();
    await settle();
    ops.checkAutoClear();
    await settle();
    expect(writes).toEqual(['/clear\r']);
  });

  it('on the summed counter, does not compact again until it has grown by the threshold', async () => {
    ops.setAutoCompact(true, 100_000);
    counter = 100_000;
    ops.checkAutoCompact();
    await settle();

    counter = 150_000;
    ops.checkAutoCompact();
    await settle();
    expect(writes).toEqual(['/compact\r']);

    counter = 200_000;
    ops.checkAutoCompact();
    await settle();
    expect(writes).toEqual(['/compact\r', '/compact\r']);
  });

  it('on the pane counter, compacts again as soon as the number passes its last high', async () => {
    ops.setAutoCompact(true, 150_000);
    counter = 150_000;
    ops.noteAbsoluteCounter();
    ops.checkAutoCompact();
    await settle();

    counter = 150_001; // the pane fell after the compact, and only this move reaches the check
    ops.noteAbsoluteCounter();
    ops.checkAutoCompact();
    await settle();
    expect(writes).toEqual(['/compact\r', '/compact\r']);
  });

  it('on the counter, restarts from 0 after a clear', async () => {
    ops.setAutoCompact(true, 100_000);
    ops.setAutoClear(true, 140_000);
    counter = 100_000;
    ops.checkAutoCompact();
    await settle();

    counter = 240_000;
    ops.checkAutoClear();
    await settle();
    expect(writes).toEqual(['/compact\r', '/clear\r']);

    counter = 100_000; // the session zeroed it on 'autoClear' and it grew back
    ops.checkAutoCompact();
    await settle();
    expect(writes).toEqual(['/compact\r', '/clear\r', '/compact\r']);
  });

  describe('threshold cap', () => {
    it('allows up to 1M while the window is unknown', () => {
      ops.setAutoCompact(true, 1_000_000);
      ops.setAutoClear(true, 1_000_000);
      expect(ops.autoCompactThreshold).toBe(1_000_000);
      expect(ops.autoClearThreshold).toBe(1_000_000);
    });

    it('stops at 1M while the window is unknown', () => {
      ops.setAutoCompact(true, 1_000_001);
      expect(ops.autoCompactThreshold).toBe(1_000_000);
    });

    it('falls to the default below the minimum', () => {
      ops.setAutoCompact(true, 1);
      ops.setAutoClear(true, 1);
      expect(ops.autoCompactThreshold).toBe(110_000);
      expect(ops.autoClearThreshold).toBe(140_000);
    });

    it('follows the reported window', () => {
      report = { tokens: 1, windowSize: 200_000 };
      ops.setAutoCompact(true, 200_000);
      expect(ops.autoCompactThreshold).toBe(200_000);
      ops.setAutoCompact(true, 200_001);
      expect(ops.autoCompactThreshold).toBe(200_000);
      ops.setAutoClear(true, 200_001);
      expect(ops.autoClearThreshold).toBe(200_000);
    });
  });
});

describe('Session.noteContextReport', () => {
  const session = () => new Session({ workingDir: '/tmp', mode: 'claude' } as ConstructorParameters<typeof Session>[0]);

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('runs the checks on the report, the counter being far below it', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const s = session();
    const write = vi.spyOn(s, 'writeViaMux').mockResolvedValue(true);
    s.setAutoCompact(true, 100_000);

    s.noteContextReport({ tokens: 243_000, windowSize: 1_000_000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(write).toHaveBeenCalledWith('/compact\r');
    expect(s.toState().contextWindowSize).toBe(1_000_000);
    s.setAutoCompact(false);
  });
});

describe('the pane token parser under the raised cap', () => {
  type Parser = { parseTokensFromStatusLine(text: string): void };
  const total = (s: Session) => s.toState().inputTokens + s.toState().outputTokens;

  it('takes an M value up to the cap, so the counter can reach a threshold above 500k', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = new Session({ workingDir: '/tmp', mode: 'claude' } as ConstructorParameters<typeof Session>[0]);
    const parse = (text: string) => (s as never as Parser).parseTokensFromStatusLine(text);
    for (const k of [100, 200, 300, 400, 500]) parse(`${k}k tokens`);

    parse('0.6M tokens');
    expect(total(s)).toBe(600_000);

    parse('1.1M tokens');
    expect(total(s)).toBe(600_000);
    vi.restoreAllMocks();
  });

  it('marks the counter absolute only when the number moves', () => {
    const s = new Session({ workingDir: '/tmp', mode: 'claude' } as ConstructorParameters<typeof Session>[0]);
    const parse = (text: string) => (s as never as Parser).parseTokensFromStatusLine(text);
    const ops = (s as never as { _autoOps: SessionAutoOps })._autoOps;
    const note = vi.spyOn(ops, 'noteAbsoluteCounter');

    parse('50k tokens');
    expect(note).toHaveBeenCalledTimes(1);

    parse('20k tokens'); // the pane after a compact: the counter stays, so nothing runs
    expect(note).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
});
