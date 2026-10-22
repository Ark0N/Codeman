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
import { composerIsEmpty, plainFrame } from '../src/session-submit-verifier.js';
import { detectUsageLimitPause } from '../src/usage-limit-patterns.js';
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
    ['the cap after the last prompt', { budgetAnchorAt: NOW - 2 * HOUR }, 'window after the last prompt'],
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
    // Neither ends with a turn, so a stop here would leave an idle session with no trigger.
    ['respawn, Ralph or an agent is driving (a long-poll waiter included)', { automationActive: true }, 'driving'],
    ['one capture of the composer failed', { composerEmpty: null }, 'cannot read the composer'],
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

  /**
   * `capture-pane -p -e` of one Claude Code 2.1.300 pane, byte for byte apart from the
   * statusline row (dropped): the composer with its prompt suggestion, empty, holding a draft,
   * holding the same draft with the cursor moved home, and holding a pasted-text chip. The suggestion's first letter sits
   * in the reverse-video cursor cell and the rest is faint; a typed draft is neither.
   */
  const RULE = `\x1b[38;5;244m${'─'.repeat(120)}`;
  const FOOTER = '  \x1b[38;5;220m⏵⏵ auto mode on\x1b[38;5;246m (shift+tab to cycle)\x1b[39m';
  const frame = (composer: string) =>
    ['\x1b[38;5;246m✻ Cooked for 2s · done 6:56 PM\x1b[39m', '', RULE, composer, RULE, FOOTER].join('\n');
  const SUGGESTION = '\x1b[39m❯\u00a0\x1b[7mw\x1b[0;2m\x1b[39m\x1b[49mrite tests for add\x1b[0m\x1b[39m\x1b[49m';
  const EMPTY = '\x1b[39m❯\u00a0\x1b[7m \x1b[0m\x1b[39m\x1b[49m';
  const DRAFT = '\x1b[39m❯\u00a0half a draft\x1b[7m \x1b[0m\x1b[39m\x1b[49m';
  const DRAFT_CURSOR_HOME = '\x1b[39m❯\u00a0\x1b[7mh\x1b[0m\x1b[39m\x1b[49malf a draft';
  // A 40-line paste collapses to a chip, drawn plain like typed text.
  const PASTED_CHIP = '\x1b[39m❯\u00a0[Pasted text #1 +40 lines]\x1b[7m \x1b[0m\x1b[39m\x1b[49m';

  it("reads Claude Code's prompt suggestion as empty and a typed draft as text, from a real styled capture", () => {
    expect(composerIsEmpty(frame(SUGGESTION), glyph)).toBe(true);
    expect(composerIsEmpty(frame(EMPTY), glyph)).toBe(true);
    expect(composerIsEmpty(frame(DRAFT), glyph)).toBe(false);
    // The cursor cell holds the draft's first letter, but no faint text follows it.
    expect(composerIsEmpty(frame(DRAFT_CURSOR_HOME), glyph)).toBe(false);
    expect(composerIsEmpty(frame(PASTED_CHIP), glyph)).toBe(false);
  });

  it('reads a suggestion drawn without a cursor cell as empty, and a plain capture of it as text', () => {
    expect(composerIsEmpty(frame('❯\u00a0\x1b[2mwrite tests for add\x1b[0m'), glyph)).toBe(true);
    expect(composerIsEmpty(frame('❯\u00a0\x1b[2mwrite \x1b[22mtyped\x1b[0m'), glyph)).toBe(false);
    // Without the styles nothing tells the two apart, which is why the pane is read with -e.
    expect(composerIsEmpty(frame('❯\u00a0write tests for add'), glyph)).toBe(false);
  });

  it("reads text styled with tmux's colon sub-parameters, which stripAnsi leaves behind", () => {
    const limit = "You've hit your \x1b[4:3mlimit\x1b[0m · resets 1:40pm (UTC)";
    expect(detectUsageLimitPause(plainFrame(limit), NOW)).not.toBeNull();
    expect(composerIsEmpty(frame('\x1b[4:3m❯\x1b[0m\u00a0'), glyph)).toBe(true);
  });

  it("never takes an extended colour's arguments for the faint or reverse attributes", () => {
    expect(composerIsEmpty(frame('❯\u00a0\x1b[38;2;2;7;2mtyped in truecolour\x1b[0m'), glyph)).toBe(false);
    expect(composerIsEmpty(frame('❯\u00a0\x1b[38;5;2mtyped in a 256 colour\x1b[0m'), glyph)).toBe(false);
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

  /**
   * The window is a ceiling, not the turn's length: a slow keep-alive turn's idle prompt lands
   * about a minute after it ends, so the window closes on that prompt (the route calls
   * endKeepAliveTurn) or on any other submit, never by a short clock alone.
   */
  it('the keep-alive window survives the nudge and a bare Enter, and ends on any other submit', () => {
    const session = new Session({ workingDir: '/tmp' });
    session.beginKeepAliveTurn(KEEP_WARM_TURN_WINDOW_MS);
    session.write(`${KEEP_WARM_NUDGE}\r`);
    session.write('\r');
    expect(session.keepAliveTurnActive).toBe(true);
    session.write('/compact\r');
    expect(session.keepAliveTurnActive).toBe(false);

    session.beginKeepAliveTurn(KEEP_WARM_TURN_WINDOW_MS);
    session.write('typed but not sent');
    expect(session.keepAliveTurnActive).toBe(true);
    session.endKeepAliveTurn();
    expect(session.keepAliveTurnActive).toBe(false);
    expect(KEEP_WARM_TURN_WINDOW_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });

  it('persists the real-prompt clock and the choice, and restores both', () => {
    const session = new Session({ workingDir: '/tmp', lastRealPromptAt: NOW, keepWarmEnabled: true });
    expect(session.toState()).toMatchObject({ lastRealPromptAt: NOW, keepWarmEnabled: true });
    const fresh = new Session({ workingDir: '/tmp' });
    expect(fresh.lastRealPromptAt).toBe(0);
    expect(fresh.toState().lastRealPromptAt).toBeUndefined();
  });

  it('seeds the real-prompt clock from lastSubmitAt for a state.json written before it existed', () => {
    expect(new Session({ workingDir: '/tmp', lastSubmitAt: NOW - HOUR }).lastRealPromptAt).toBe(NOW - HOUR);
    const both = new Session({ workingDir: '/tmp', lastSubmitAt: NOW, lastRealPromptAt: NOW - HOUR });
    expect(both.lastRealPromptAt).toBe(NOW - HOUR);
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
  keepAliveWindowsEnded = 0;
  endKeepAliveTurn(): void {
    this.keepAliveWindowsEnded += 1;
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

  /**
   * A nudge only goes out inside the last five minutes before the expiry, so a retry armed a
   * whole lead time later would land past it and stop: the failed write ends the keep-alive
   * window (no turn is running) and retries a minute later, never past the last-chance line.
   */
  it('keeps a failed write out of the tally, ends the keep-alive window and retries a minute later', async () => {
    const session = new FakeSession();
    session.keepWarmEnabled = true;
    session.writeOk = false;
    session.promptCache = warmCache(NOW + KEEP_WARM_LEAD_MS - 1000);
    const { ports, last } = makePorts(session);
    const service = new PromptCacheKeepWarmService(ports);
    service.schedule(session.id);
    await settle();
    expect(session.writes).toHaveLength(1);
    expect(session.keepAliveWindowsEnded).toBe(1);
    expect(last()).toMatchObject({
      state: 'waiting',
      nudges: 0,
      nextCheckAt: NOW + KEEP_WARM_RETRY_MS,
      reason: expect.stringContaining('could not be written'),
    });

    session.writeOk = true;
    await vi.advanceTimersByTimeAsync(KEEP_WARM_RETRY_MS);
    await settle();
    expect(session.writes).toEqual([`${KEEP_WARM_NUDGE}\r`, `${KEEP_WARM_NUDGE}\r`]);
    expect(session.keepAliveWindowsEnded).toBe(1);
    expect(last()).toMatchObject({ state: 'nudged', nudges: 1 });
    service.stop();
  });

  it('never arms the retry after a failed write past the last-chance line', async () => {
    const session = new FakeSession();
    session.keepWarmEnabled = true;
    session.writeOk = false;
    // Due, with only 30 s left before the last-chance line.
    session.promptCache = warmCache(NOW + KEEP_WARM_LAST_CHANCE_MS + 30_000);
    const { ports, last } = makePorts(session);
    const service = new PromptCacheKeepWarmService(ports);
    await service.schedule(session.id);
    expect(last()).toMatchObject({ state: 'waiting', nextCheckAt: NOW + 30_000 });
    await vi.advanceTimersByTimeAsync(30_000);
    await settle();
    expect(session.writes).toHaveLength(1);
    expect(last()).toMatchObject({ state: 'stopped', reason: 'too close to expiry to land a turn' });
    expect(vi.getTimerCount()).toBe(0);
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
    // rescheduleAll() drops the kept settings, so this evaluation really waits in its read.
    service.rescheduleAll();
    await settle();
    releaseWrite(true);
    await first;
    releaseRead();
    await settle();
    expect(published).toEqual([expect.objectContaining({ state: 'armed' })]);
    service.stop();
  });

  /**
   * Every statusline report schedules an evaluation, so the settings are read once and kept
   * rather than read from disk on each report, the feature off included; the settings PUT calls
   * rescheduleAll() when either key changes, which is what makes the next read fresh.
   */
  it('reads the settings once, again after rescheduleAll(), and again after a failed read', async () => {
    const session = new FakeSession();
    session.promptCache = warmCache(NOW + HOUR);
    let reads = 0;
    let fail = false;
    const { ports } = makePorts(session, {
      readSettings: async () => {
        reads += 1;
        if (fail) throw new Error('unreadable');
        return { keepWarmDefault: false, maxHours: 2 };
      },
    });
    const service = new PromptCacheKeepWarmService(ports);
    await service.schedule(session.id);
    await service.schedule(session.id);
    expect(reads).toBe(1);
    fail = true;
    service.rescheduleAll();
    await settle();
    expect(reads).toBe(2);
    fail = false;
    await service.schedule(session.id);
    expect(reads).toBe(3);
    service.stop();
  });

  it('publishes no window while off, so a real prompt on a session with keep-warm off broadcasts nothing', async () => {
    const session = new FakeSession();
    session.keepWarmEnabled = false;
    session.promptCache = warmCache(NOW + HOUR);
    const { ports, published } = makePorts(session);
    const service = new PromptCacheKeepWarmService(ports);
    await service.schedule(session.id);
    session.lastRealPromptAt = NOW;
    await service.schedule(session.id);
    expect(published[0]).toMatchObject({ enabled: false, state: 'off' });
    expect(published[0]).not.toHaveProperty('budgetEndsAt');
    expect(published[0]).not.toHaveProperty('nextCheckAt');
    expect(JSON.stringify(published[1])).toBe(JSON.stringify(published[0]));
    service.stop();
  });

  it('retries a minute later when an evaluation throws, since an idle session has no other trigger', async () => {
    const session = new FakeSession();
    session.keepWarmEnabled = true;
    session.promptCache = warmCache(NOW + KEEP_WARM_LEAD_MS - 1000);
    let fail = true;
    const { ports, last } = makePorts(session, {
      readSettings: async () => {
        if (fail) throw new Error('settings.json mid-rewrite');
        return { keepWarmDefault: false, maxHours: 2 };
      },
    });
    const service = new PromptCacheKeepWarmService(ports);
    await service.schedule(session.id);
    expect(session.writes).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(1);
    fail = false;
    await vi.advanceTimersByTimeAsync(KEEP_WARM_RETRY_MS);
    await settle();
    expect(session.writes).toEqual([`${KEEP_WARM_NUDGE}\r`]);
    expect(last()).toMatchObject({ state: 'nudged' });
    service.stop();
  });

  /**
   * A settings.json left broken (a hand edit with a trailing comma) fails every read until it is
   * fixed. Only a session that could nudge retries on its own, and the failure is logged once
   * rather than once a minute per session.
   */
  it.each([
    { label: 'keep-warm off', set: (s: FakeSession) => (s.keepWarmEnabled = false) },
    { label: 'no exporter on this launch', set: (s: FakeSession) => (s.statusLineExporter = 'remote' as never) },
    { label: 'no cache report', set: (s: FakeSession) => (s.promptCache = null) },
    { label: 'a cold cache', set: (s: FakeSession) => (s.promptCache = { ...warmCache(NOW + HOUR), warm: false }) },
  ])('does not retry an unreadable settings file for a session that cannot nudge ($label)', async ({ set }) => {
    const session = new FakeSession();
    session.promptCache = warmCache(NOW + KEEP_WARM_LEAD_MS - 1000);
    set(session);
    let reads = 0;
    const logged: string[] = [];
    const { ports, published } = makePorts(session, {
      readSettings: async () => {
        reads += 1;
        throw new Error('Unexpected token } in JSON at position 812');
      },
      log: (m) => logged.push(m),
    });
    const service = new PromptCacheKeepWarmService(ports);
    await service.schedule(session.id);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(10 * KEEP_WARM_RETRY_MS);
    await settle();
    expect(reads).toBe(1);
    expect(logged).toEqual([expect.stringContaining('Unexpected token')]);
    expect(published).toHaveLength(0);
    service.stop();
  });

  it('retries an unreadable settings file every minute for a session that can nudge, logging it once', async () => {
    const session = new FakeSession();
    session.promptCache = warmCache(NOW + 30 * 60_000);
    let reads = 0;
    let fail = true;
    const logged: string[] = [];
    const { ports, last } = makePorts(session, {
      readSettings: async () => {
        reads += 1;
        if (fail) throw new Error('Unexpected token } in JSON at position 812');
        return { keepWarmDefault: true, maxHours: 2 };
      },
      log: (m) => logged.push(m),
    });
    const service = new PromptCacheKeepWarmService(ports);
    await service.schedule(session.id);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10 * KEEP_WARM_RETRY_MS);
    await settle();
    expect(reads).toBe(11);
    expect(logged).toEqual([expect.stringContaining('Unexpected token')]);

    // Fixed: the next retry reads it and the session is kept warm from there.
    fail = false;
    await vi.advanceTimersByTimeAsync(KEEP_WARM_RETRY_MS);
    await settle();
    expect(reads).toBe(12);
    expect(last()).toMatchObject({ enabled: true, state: 'armed' });

    // Broken again later: logged again, once.
    fail = true;
    service.rescheduleAll();
    await settle();
    await vi.advanceTimersByTimeAsync(3 * KEEP_WARM_RETRY_MS);
    await settle();
    expect(logged).toHaveLength(2);
    service.stop();
  });

  it('runs one follow-up for triggers that land during an evaluation, and resolves after it', async () => {
    const session = new FakeSession();
    session.keepWarmEnabled = true;
    session.promptCache = warmCache(NOW + KEEP_WARM_LEAD_MS - 1000);
    let releaseWrite!: (ok: boolean) => void;
    session.writeViaMux = async (data: string) => {
      session.writes.push(data);
      return new Promise<boolean>((r) => (releaseWrite = r));
    };
    const { ports, published } = makePorts(session);
    const service = new PromptCacheKeepWarmService(ports);
    const first = service.schedule(session.id);
    await settle();
    expect(session.writes).toHaveLength(1);
    // Switched off while the nudge is being written: the toggle's own evaluation must not be lost.
    session.keepWarmEnabled = false;
    const toggle = service.schedule(session.id);
    const settingsChange = service.schedule(session.id);
    expect(settingsChange).toBe(toggle);
    releaseWrite(true);
    await first;
    await toggle;
    expect(published.map((s) => s.state)).toEqual(['nudged', 'off']);
    service.stop();
  });

  it('remove() drops a follow-up queued behind an evaluation, and a failed read after it arms nothing', async () => {
    const session = new FakeSession();
    session.keepWarmEnabled = true;
    session.promptCache = warmCache(NOW + KEEP_WARM_LEAD_MS - 1000);
    let release!: () => void;
    let fail = false;
    const { ports, published } = makePorts(session, {
      readSettings: async () => {
        await new Promise<void>((r) => (release = r));
        if (fail) throw new Error('settings.json mid-rewrite');
        return { keepWarmDefault: false, maxHours: 2 };
      },
    });
    const service = new PromptCacheKeepWarmService(ports);
    // The session stays discoverable while it is being deleted, so only remove() can stop these.
    const first = service.schedule(session.id);
    const followUp = service.schedule(session.id);
    service.remove(session.id);
    release();
    await first;
    await followUp;
    await settle();
    expect(session.writes).toHaveLength(0);
    expect(published).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);

    // rescheduleAll() drops the kept settings, so this read really runs, and fails.
    fail = true;
    const logged: string[] = [];
    ports.log = (m) => logged.push(m);
    service.rescheduleAll();
    service.remove(session.id);
    release();
    await settle();
    expect(logged).toEqual([expect.stringContaining('mid-rewrite')]);
    expect(vi.getTimerCount()).toBe(0);
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
