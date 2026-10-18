/**
 * Prompt-cache keep-warm (src/prompt-cache-keepwarm.ts): the rulebook as a table, the
 * effective opt-in shared with the launch, the composer-empty read it depends on, the two
 * submit clocks on a real Session, and the service's timer and nudge path with a fake
 * session and fake ports. Fake timers in the service block; nothing here touches tmux.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  decideKeepWarm,
  keepWarmOn,
  PromptCacheKeepWarmService,
  KEEP_WARM_NUDGE,
  KEEP_WARM_LEAD_MS,
  KEEP_WARM_RETRY_MS,
  KEEP_WARM_LAST_CHANCE_MS,
  KEEP_WARM_MIN_TOKENS,
  KEEP_WARM_RECENT_INPUT_MS,
  KEEP_WARM_TURN_WINDOW_MS,
  type KeepWarmFacts,
  type KeepWarmPorts,
  type KeepWarmSessionView,
} from '../src/prompt-cache-keepwarm.js';
import { composerIsEmpty } from '../src/session-submit-verifier.js';
import { isCapturablePrompt } from '../src/intent-store.js';
import { Session } from '../src/session.js';
import type { KeepWarmStatus, PromptCacheStatus } from '../src/types.js';

const NOW = Date.UTC(2026, 9, 6, 22, 0, 0);
const HOUR = 3_600_000;

function warmCache(expiresAt: number, extra: Partial<PromptCacheStatus> = {}): PromptCacheStatus {
  return { warm: true, ttl: '1h', expiresAt, recacheTokensIfCold: 110_000, misses: 0, ...extra };
}

/** Everything green and due: the one shape that nudges. */
function dueFacts(over: Partial<KeepWarmFacts> = {}): KeepWarmFacts {
  return {
    now: NOW,
    choice: true,
    appDefault: false,
    spawnedByAgent: false,
    statusLine: 'injected',
    cache: warmCache(NOW + KEEP_WARM_LEAD_MS - 1000),
    idle: true,
    paneAlive: true,
    limitPaused: false,
    automationActive: false,
    pendingApproval: false,
    composerEmpty: true,
    lastHumanInputAt: NOW - HOUR,
    budgetAnchorAt: NOW - HOUR,
    maxKeepWarmMs: 2 * HOUR,
    ...over,
  };
}

describe('decideKeepWarm', () => {
  it('nudges only when every guard holds', () => {
    expect(decideKeepWarm(dueFacts())).toEqual({ action: 'nudge' });
  });

  it('nudges on the app default, and for an agent-spawned session switched on for itself', () => {
    expect(decideKeepWarm(dueFacts({ choice: undefined, appDefault: true }))).toEqual({ action: 'nudge' });
    expect(decideKeepWarm(dueFacts({ choice: true, spawnedByAgent: true }))).toEqual({ action: 'nudge' });
  });

  it.each<[string, Partial<KeepWarmFacts>, string]>([
    ['switched off for the session', { choice: false, appDefault: true }, 'off'],
    ['no choice and the app default off', { choice: undefined }, 'off'],
    [
      'an agent-spawned session on the app default',
      { choice: undefined, appDefault: true, spawnedByAgent: true },
      'agent-spawned',
    ],
    ['Plan Usage off at launch', { statusLine: 'collection-off' }, '(collection-off)'],
    ["the workspace's own statusLine", { statusLine: 'workspace-statusline' }, '(workspace-statusline)'],
    ['a remote or Docker launch', { statusLine: 'remote' }, '(remote)'],
    ['a launch nobody recorded (a CLI without the exporter, a direct PTY)', { statusLine: undefined }, '(unknown)'],
    ['no report yet', { cache: null }, 'no cache report yet'],
    ['a cold cache', { cache: { warm: false } }, 'cold'],
    [
      'a context compacted this gap (the shape Session.setPromptCache stamps: no re-cache size)',
      { cache: warmCache(NOW + 60_000, { recacheTokensIfCold: undefined, compactedAt: NOW - 60_000 }) },
      'compacted',
    ],
    ['warm but no expiry to schedule on', { cache: { warm: true, recacheTokensIfCold: 110_000 } }, 'cold'],
    ['the five-minute lifetime', { cache: warmCache(NOW + 4 * 60_000, { ttl: '5m' }) }, '5-minute'],
    [
      'a small context',
      { cache: warmCache(NOW + 60_000, { recacheTokensIfCold: KEEP_WARM_MIN_TOKENS - 1 }) },
      'too small',
    ],
    ['a dead pane', { paneAlive: false }, 'no live pane'],
    ['a usage-limit pause', { limitPaused: true }, 'usage-limit'],
    ['respawn, Ralph or an agent driving', { automationActive: true }, 'driving the session'],
    ['the cap after the last prompt', { budgetAnchorAt: NOW - 2 * HOUR }, 'window after the last prompt'],
    ['an unreadable composer', { composerEmpty: null }, 'cannot read the composer'],
  ])('stops for %s', (_label, over, reason) => {
    const d = decideKeepWarm(dueFacts(over));
    expect(d.action).toBe('stop');
    expect(d.action === 'stop' && d.reason).toContain(reason);
  });

  it('waits for the due time, five minutes before the expiry, when it is not due yet', () => {
    const expiresAt = NOW + HOUR;
    expect(decideKeepWarm(dueFacts({ cache: warmCache(expiresAt) }))).toEqual({
      action: 'wait',
      until: expiresAt - KEEP_WARM_LEAD_MS,
      reason: 'not due yet',
    });
  });

  it('gives up inside the last-chance minute rather than race the expiry', () => {
    const d = decideKeepWarm(dueFacts({ cache: warmCache(NOW + KEEP_WARM_LAST_CHANCE_MS - 1) }));
    expect(d).toMatchObject({ action: 'stop', reason: expect.stringContaining('too close') });
  });

  it.each<[string, Partial<KeepWarmFacts>, string]>([
    ['the session is working', { idle: false }, 'working'],
    ['a dialog is open', { pendingApproval: true }, 'dialog'],
    ['the composer holds a draft', { composerEmpty: false }, 'composer holds text'],
    ['someone typed a moment ago', { lastHumanInputAt: NOW - KEEP_WARM_RECENT_INPUT_MS + 1 }, 'typed'],
  ])('defers by a minute while %s', (_label, over, reason) => {
    const d = decideKeepWarm(dueFacts(over));
    expect(d).toMatchObject({
      action: 'wait',
      until: NOW + KEEP_WARM_RETRY_MS,
      reason: expect.stringContaining(reason),
    });
  });

  it('clamps a deferral to the last-chance line so a retry never lands on an expired cache', () => {
    const expiresAt = NOW + KEEP_WARM_LAST_CHANCE_MS + 30_000; // due, 90 s left
    const d = decideKeepWarm(dueFacts({ cache: warmCache(expiresAt), idle: false }));
    expect(d).toMatchObject({ action: 'wait', until: expiresAt - KEEP_WARM_LAST_CHANCE_MS });
  });

  it('checks the cap before the schedule, so a session past its window never arms a timer', () => {
    const d = decideKeepWarm(dueFacts({ cache: warmCache(NOW + HOUR), budgetAnchorAt: NOW - 4 * HOUR }));
    expect(d.action).toBe('stop');
  });
});

describe('keepWarmOn', () => {
  it('is the session choice, else the app default, which an agent-spawned session does not inherit', () => {
    expect(keepWarmOn(true, false, false)).toBe(true);
    expect(keepWarmOn(false, true, false)).toBe(false);
    expect(keepWarmOn(undefined, true, false)).toBe(true);
    expect(keepWarmOn(undefined, false, false)).toBe(false);
    expect(keepWarmOn(undefined, true, true)).toBe(false);
    expect(keepWarmOn(true, false, true)).toBe(true);
  });
});

describe('composerIsEmpty', () => {
  const glyph = '\u276f';
  const rule = '─'.repeat(20);
  it('reads the last composer down to its bottom rule: empty, a draft, or nothing to read', () => {
    expect(composerIsEmpty(`transcript\n${glyph}\u00a0\n${rule}\n  bypass permissions on`, glyph)).toBe(true);
    expect(composerIsEmpty(`${glyph} old prompt\n● ok\n${glyph} half a draft\n${rule}`, glyph)).toBe(false);
    expect(composerIsEmpty('Accessing workspace:\n  Yes, I trust this folder', glyph)).toBeUndefined();
    expect(composerIsEmpty(`${glyph} anything\n${rule}`, '')).toBeUndefined();
  });

  it('sees a draft that opens with a newline, on the continuation lines under a blank glyph line', () => {
    expect(composerIsEmpty(`${glyph} \n  unfinished draft\n${rule}\n  bypass permissions on`, glyph)).toBe(false);
  });

  it('never takes an indented draft line holding the glyph or a rule for the composer edges', () => {
    expect(composerIsEmpty(`${glyph} explain this terminal prompt:\n  ${glyph}\n${rule}`, glyph)).toBe(false);
    expect(composerIsEmpty(`${glyph} \n  ${rule} under the line\n${rule}\n  bypass permissions on`, glyph)).toBe(false);
  });

  it('gives no verdict without the bottom rule that bounds the composer', () => {
    expect(composerIsEmpty(`${glyph} \n  unfinished draft`, glyph)).toBeUndefined();
  });
});

describe('Read My Mind ignores the nudge', () => {
  it('drops the exact keep-alive line and nothing else', () => {
    expect(isCapturablePrompt(KEEP_WARM_NUDGE)).toBe(false);
    expect(isCapturablePrompt(`${KEEP_WARM_NUDGE}\n`)).toBe(false);
    expect(isCapturablePrompt(`why did "${KEEP_WARM_NUDGE}" show up in my session?`)).toBe(true);
    expect(isCapturablePrompt('fix the login bug')).toBe(true);
  });
});

describe('the two submit clocks on a Session', () => {
  it('a nudge moves lastSubmitAt but not lastRealPromptAt, from the write and from the hook', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(NOW);
      const session = new Session({ workingDir: '/tmp' });
      session.write('real prompt\r', { fromUser: true });
      expect(session.lastRealPromptAt).toBe(NOW);

      vi.setSystemTime(NOW + HOUR);
      session.beginKeepAliveTurn(KEEP_WARM_TURN_WINDOW_MS);
      session.write(`${KEEP_WARM_NUDGE}\r`);
      session.markPromptSubmitted(); // its UserPromptSubmit hook
      expect(session.lastSubmitAt).toBe(NOW + HOUR);
      expect(session.lastRealPromptAt).toBe(NOW);

      // A person's prompt ends the keep-alive window at once and counts again.
      vi.setSystemTime(NOW + HOUR + 1000);
      session.write('next real prompt\r', { fromUser: true });
      expect(session.keepAliveTurnActive).toBe(false);
      expect(session.lastRealPromptAt).toBe(NOW + HOUR + 1000);

      // A prompt typed in an attached tmux client reaches Codeman only through the hook.
      vi.setSystemTime(NOW + 2 * HOUR);
      session.markPromptSubmitted();
      expect(session.lastRealPromptAt).toBe(NOW + 2 * HOUR);

      // ... even inside a keep-alive window: its hook carries the prompt text, and anything but
      // the nudge's own ends the window, so it counts and its stop hook alerts normally.
      vi.setSystemTime(NOW + 3 * HOUR);
      session.beginKeepAliveTurn(KEEP_WARM_TURN_WINDOW_MS);
      session.markPromptSubmitted(KEEP_WARM_NUDGE);
      expect(session.keepAliveTurnActive).toBe(true);
      expect(session.lastRealPromptAt).toBe(NOW + 2 * HOUR);
      vi.setSystemTime(NOW + 3 * HOUR + 5000);
      session.markPromptSubmitted('fix the login bug');
      expect(session.keepAliveTurnActive).toBe(false);
      expect(session.lastRealPromptAt).toBe(NOW + 3 * HOUR + 5000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('persists the real-prompt clock and the choice, and restores both', () => {
    const session = new Session({ workingDir: '/tmp', lastRealPromptAt: NOW, keepWarmEnabled: true });
    expect(session.toState()).toMatchObject({ lastRealPromptAt: NOW, keepWarmEnabled: true });
    const fresh = new Session({ workingDir: '/tmp' });
    expect(fresh.lastRealPromptAt).toBe(0);
    expect(fresh.toState().lastRealPromptAt).toBeUndefined();
  });
});

// ─── Service ─────────────────────────────────────────────────────────────────

class FakeSession implements KeepWarmSessionView {
  id = 'sess-1';
  createdAt = NOW - HOUR;
  pid: number | null = 4242;
  paneExit: unknown = undefined;
  parentSessionId: string | undefined = undefined;
  promptCache: PromptCacheStatus | null = null;
  statusLineExporter = 'injected' as const;
  idleCompactionOptOut = true;
  keepWarmEnabled: boolean | undefined = undefined;
  isWorking = false;
  isLimitPaused = false;
  lastHumanInputAt = NOW - HOUR;
  lastRealPromptAt = NOW - HOUR;
  idle = true;
  writes: string[] = [];
  keepAliveWindows: number[] = [];
  writeOk = true;
  isIdle(): boolean {
    return this.idle;
  }
  beginKeepAliveTurn(windowMs: number): void {
    this.keepAliveWindows.push(windowMs);
  }
  async writeViaMux(data: string): Promise<boolean> {
    this.writes.push(data);
    return this.writeOk;
  }
}

function makePorts(session: FakeSession, over: Partial<KeepWarmPorts> = {}) {
  const published: KeepWarmStatus[] = [];
  const ports: KeepWarmPorts = {
    getSession: (id) => (id === session.id ? session : undefined),
    sessionIds: () => [session.id],
    readSettings: async () => ({ keepWarmDefault: false, maxHours: 2 }),
    isAutomationActive: () => false,
    hasPendingApproval: () => false,
    readPane: () => ({ composerEmpty: true, limitShown: false }),
    publish: (_id, status) => {
      published.push(status);
    },
    ...over,
  };
  return { ports, published, last: () => published[published.length - 1] };
}

/** Let the service's awaited settings read and write settle. */
const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('PromptCacheKeepWarmService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('arms on the cache report, nudges at the due time, and reports what it did', async () => {
    const session = new FakeSession();
    session.keepWarmEnabled = true;
    session.promptCache = warmCache(NOW + HOUR);
    const { ports, last } = makePorts(session);
    const service = new PromptCacheKeepWarmService(ports);

    service.schedule(session.id);
    await settle();
    expect(last()).toMatchObject({
      enabled: true,
      idleCompactionOff: true,
      state: 'armed',
      nextCheckAt: NOW + HOUR - KEEP_WARM_LEAD_MS,
      nudges: 0,
    });
    expect(session.writes).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(HOUR - KEEP_WARM_LEAD_MS);
    await settle();
    expect(session.writes).toEqual([`${KEEP_WARM_NUDGE}\r`]);
    expect(session.keepAliveWindows).toEqual([KEEP_WARM_TURN_WINDOW_MS]);
    expect(last()).toMatchObject({ state: 'nudged', nudges: 1, lastNudgeAt: NOW + HOUR - KEEP_WARM_LEAD_MS });

    // The nudge's own report moves the expiry out; the next evaluation arms on it.
    session.promptCache = warmCache(NOW + 2 * HOUR - KEEP_WARM_LEAD_MS);
    service.schedule(session.id);
    await settle();
    expect(last()).toMatchObject({ state: 'armed', nudges: 1 });
    service.stop();
  });

  it('reads the composer only when otherwise due, and retries while it holds a draft', async () => {
    const session = new FakeSession();
    session.keepWarmEnabled = true;
    session.promptCache = warmCache(NOW + KEEP_WARM_LEAD_MS - 1000);
    let draft = true;
    const reads: number[] = [];
    const { ports, last } = makePorts(session, {
      readPane: () => {
        reads.push(Date.now());
        return { composerEmpty: !draft, limitShown: false };
      },
    });
    const service = new PromptCacheKeepWarmService(ports);

    service.schedule(session.id);
    await settle();
    expect(reads).toHaveLength(1);
    expect(last()).toMatchObject({
      state: 'waiting',
      reason: 'the composer holds text',
      nextCheckAt: NOW + KEEP_WARM_RETRY_MS,
    });
    expect(session.writes).toHaveLength(0);

    draft = false;
    await vi.advanceTimersByTimeAsync(KEEP_WARM_RETRY_MS);
    await settle();
    expect(reads).toHaveLength(2);
    expect(session.writes).toHaveLength(1);
    expect(last()).toMatchObject({ state: 'nudged', nudges: 1 });
    service.stop();
  });

  it('follows the app-wide default when the session has not chosen, and publishes the effective flag', async () => {
    const session = new FakeSession();
    session.promptCache = warmCache(NOW + HOUR);
    const { ports, last } = makePorts(session, { readSettings: async () => ({ keepWarmDefault: true, maxHours: 2 }) });
    const service = new PromptCacheKeepWarmService(ports);
    service.schedule(session.id);
    await settle();
    expect(last()).toMatchObject({ enabled: true, state: 'armed' });

    session.keepWarmEnabled = false;
    service.schedule(session.id);
    await settle();
    expect(last()).toMatchObject({ enabled: false, state: 'off' });
    expect(vi.getTimerCount()).toBe(0);
    service.stop();
  });

  it('applies the cap from settings and never arms past it', async () => {
    const session = new FakeSession();
    session.keepWarmEnabled = true;
    session.lastRealPromptAt = NOW - 2.5 * HOUR;
    session.promptCache = warmCache(NOW + HOUR);
    const { ports, last } = makePorts(session, { readSettings: async () => ({ keepWarmDefault: false, maxHours: 2 }) });
    const service = new PromptCacheKeepWarmService(ports);
    service.schedule(session.id);
    await settle();
    expect(last()).toMatchObject({
      state: 'stopped',
      reason: expect.stringContaining('window'),
      budgetEndsAt: NOW - 0.5 * HOUR,
    });
    expect(vi.getTimerCount()).toBe(0);
    service.stop();
  });

  it('keeps a failed write out of the tally and retries after the lead time', async () => {
    const session = new FakeSession();
    session.keepWarmEnabled = true;
    session.writeOk = false;
    session.promptCache = warmCache(NOW + KEEP_WARM_LEAD_MS - 1000);
    const { ports, last } = makePorts(session);
    const service = new PromptCacheKeepWarmService(ports);
    service.schedule(session.id);
    await settle();
    expect(session.writes).toHaveLength(1);
    expect(last()).toMatchObject({
      state: 'waiting',
      nudges: 0,
      reason: expect.stringContaining('could not be written'),
    });
    service.stop();
  });

  it('does not nudge a session whose screen shows a usage limit, with auto-resume off', async () => {
    const session = new FakeSession();
    session.keepWarmEnabled = true;
    session.promptCache = warmCache(NOW + KEEP_WARM_LEAD_MS - 1000);
    const { ports, last } = makePorts(session, { readPane: () => ({ composerEmpty: true, limitShown: true }) });
    const service = new PromptCacheKeepWarmService(ports);
    await service.schedule(session.id);
    expect(session.writes).toHaveLength(0);
    expect(last()).toMatchObject({ state: 'stopped', reason: 'usage-limit pause' });
    service.stop();
  });

  it('does not nudge an agent that exited in a pane that kept its pid', async () => {
    const session = new FakeSession();
    session.keepWarmEnabled = true;
    session.paneExit = { status: 137 };
    session.promptCache = warmCache(NOW + KEEP_WARM_LEAD_MS - 1000);
    const { ports, last } = makePorts(session);
    const service = new PromptCacheKeepWarmService(ports);
    await service.schedule(session.id);
    expect(session.writes).toHaveLength(0);
    expect(last()).toMatchObject({ state: 'stopped', reason: 'no live pane' });
    service.stop();
  });

  it('never arms a timer past what setTimeout honours, however far off the expiry', async () => {
    const session = new FakeSession();
    session.keepWarmEnabled = true;
    session.promptCache = warmCache(NOW + 30 * 24 * HOUR);
    const { ports } = makePorts(session, {
      readSettings: async () => ({ keepWarmDefault: false, maxHours: 24 * 60 }),
    });
    const spy = vi.spyOn(globalThis, 'setTimeout');
    const service = new PromptCacheKeepWarmService(ports);
    await service.schedule(session.id);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe(2 ** 31 - 1);
    spy.mockRestore();
    service.stop();
  });

  it('stop() during the settings read sends nothing, arms nothing and publishes nothing', async () => {
    const session = new FakeSession();
    session.keepWarmEnabled = true;
    session.promptCache = warmCache(NOW + KEEP_WARM_LEAD_MS - 1000);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { ports, published } = makePorts(session, {
      readSettings: async () => {
        await gate;
        return { keepWarmDefault: false, maxHours: 2 };
      },
    });
    const service = new PromptCacheKeepWarmService(ports);
    const run = service.schedule(session.id);
    service.stop();
    release();
    await run;
    expect(session.writes).toHaveLength(0);
    expect(published).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('remove() while the nudge is being written leaves no timer, tally or status behind', async () => {
    const session = new FakeSession();
    session.keepWarmEnabled = true;
    session.promptCache = warmCache(NOW + KEEP_WARM_LEAD_MS - 1000);
    let release!: (ok: boolean) => void;
    session.writeViaMux = async (data: string) => {
      session.writes.push(data);
      return new Promise<boolean>((r) => (release = r));
    };
    const { ports, published } = makePorts(session);
    const service = new PromptCacheKeepWarmService(ports);
    const run = service.schedule(session.id);
    await settle();
    expect(session.writes).toHaveLength(1);
    service.remove(session.id);
    release(true);
    await run;
    expect(published).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
    service.stop();
  });

  it('a cancelled evaluation finishing late does not cancel the one that replaced it', async () => {
    const session = new FakeSession();
    session.keepWarmEnabled = true;
    session.promptCache = warmCache(NOW + HOUR);
    let releaseWrite!: (ok: boolean) => void;
    let releaseRead: (() => void) | undefined;
    const { ports, published } = makePorts(session, {
      readSettings: async () => {
        if (releaseRead === undefined) return { keepWarmDefault: false, maxHours: 2 };
        await new Promise<void>((r) => (releaseRead = r));
        return { keepWarmDefault: false, maxHours: 2 };
      },
    });
    const service = new PromptCacheKeepWarmService(ports);
    // First evaluation: due, held in its write.
    session.promptCache = warmCache(NOW + KEEP_WARM_LEAD_MS - 1000);
    session.writeViaMux = async (data: string) => {
      session.writes.push(data);
      return new Promise<boolean>((r) => (releaseWrite = r));
    };
    const first = service.schedule(session.id);
    await settle();
    service.remove(session.id);
    // Second evaluation: not due, held in its settings read.
    session.promptCache = warmCache(NOW + HOUR);
    releaseRead = () => {};
    const second = service.schedule(session.id);
    await settle();
    releaseWrite(true);
    await first;
    releaseRead();
    await second;
    expect(published).toEqual([expect.objectContaining({ state: 'armed' })]);
    service.stop();
  });

  it('remove() forgets the nudge count, so an id seen again starts from zero', async () => {
    const session = new FakeSession();
    session.keepWarmEnabled = true;
    session.promptCache = warmCache(NOW + KEEP_WARM_LEAD_MS - 1000);
    const { ports, last } = makePorts(session);
    const service = new PromptCacheKeepWarmService(ports);
    await service.schedule(session.id);
    expect(last()).toMatchObject({ state: 'nudged', nudges: 1 });
    service.remove(session.id);
    session.promptCache = warmCache(NOW + HOUR);
    await service.schedule(session.id);
    expect(last()).toMatchObject({ state: 'armed', nudges: 0 });
    service.stop();
  });

  it('remove() drops the timer so a deleted session never gets a nudge', async () => {
    const session = new FakeSession();
    session.keepWarmEnabled = true;
    session.promptCache = warmCache(NOW + HOUR);
    const { ports } = makePorts(session);
    const service = new PromptCacheKeepWarmService(ports);
    service.schedule(session.id);
    await settle();
    expect(vi.getTimerCount()).toBe(1);
    service.remove(session.id);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * HOUR);
    expect(session.writes).toHaveLength(0);
  });
});
