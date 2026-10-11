/**
 * Session.setPromptCache's compaction detection and the restore of the last report.
 *
 * The statusline never reports WHEN the context was compacted, so the session stamps it.
 * Claude Code's tracker (2.1.294-2.1.296) opens a window at a compaction or a tool-result
 * clearing in which `recacheTokensIfCold` reads null, and closes it on the next request,
 * which is also the one that counts as an expected rebuild. So `expectedRebuilds` never rises
 * inside the window, and the stamp fires on ENTERING it: a warm null report after one that
 * carried a value. It is carried through idle re-reports, dropped at the next request, and a
 * first report already inside the window never invents one. The fixtures follow that real
 * order. The last report is restored through the constructor (keeping an old stamp, never
 * re-stamping at restart time), and a conversation switch drops it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import type { PromptCacheStatus } from '../src/types.js';

function claudeSession(extra: Record<string, unknown> = {}): Session {
  return new Session({ workingDir: '/tmp', mode: 'claude', ...extra } as ConstructorParameters<typeof Session>[0]);
}

describe('Session.setPromptCache compaction detection', () => {
  afterEach(() => vi.useRealTimers());

  it('stamps when /compact finishes, keeps the stamp through idle re-reports, drops it at the next request', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T22:05:00Z'));
    const s = claudeSession();
    const expiresAt = Date.now() + 3600_000;

    // 1. Warm, 500k at stake.
    s.setPromptCache({ warm: true, ttl: '1h', expiresAt, expectedRebuilds: 0, recacheTokensIfCold: 500000 });
    expect(s.promptCache?.compactedAt).toBeUndefined();

    // 2. `/compact` finishes: recache null (absent after parsing), expected_rebuilds unchanged.
    vi.setSystemTime(new Date('2026-10-06T22:31:00Z'));
    s.setPromptCache({ warm: true, ttl: '1h', expiresAt, expectedRebuilds: 0 });
    expect(s.promptCache?.compactedAt).toBe(Date.parse('2026-10-06T22:31:00Z'));

    // An idle re-report inside the same window: the stamp is carried, not re-stamped.
    vi.setSystemTime(new Date('2026-10-06T22:45:00Z'));
    s.setPromptCache({ warm: true, ttl: '1h', expiresAt, expectedRebuilds: 0 });
    expect(s.promptCache?.compactedAt).toBe(Date.parse('2026-10-06T22:31:00Z'));

    // 3. The next request closes the window: expected_rebuilds 1, recache 40k.
    s.setPromptCache({ warm: true, ttl: '1h', expiresAt, expectedRebuilds: 1, recacheTokensIfCold: 40000 });
    expect(s.promptCache?.compactedAt).toBeUndefined();
  });

  it('never stamps a first report that is already inside the window', () => {
    // The first report Codeman sees (a restart mid-window) has no prior value to leave.
    const s = claudeSession();
    s.setPromptCache({ warm: true, expiresAt: Date.now() + 3600_000, expectedRebuilds: 4 });
    expect(s.promptCache?.compactedAt).toBeUndefined();
    // Nor does a later report in the same window: the stamp needs a known value before it.
    s.setPromptCache({ warm: true, expiresAt: Date.now() + 3600_000, expectedRebuilds: 4 });
    expect(s.promptCache?.compactedAt).toBeUndefined();
  });

  it('never stamps a cold report or a report that still carries the stake', () => {
    const s = claudeSession();
    s.setPromptCache({ warm: true, expiresAt: Date.now() + 3600_000, recacheTokensIfCold: 60000 });
    // Cold with no stake: an expired cache, not a compaction.
    s.setPromptCache({ warm: false, expectedRebuilds: 0 });
    expect(s.promptCache?.compactedAt).toBeUndefined();
    // A rebuild count that rose with the stake present is the request after a window, not one.
    s.setPromptCache({ warm: true, expiresAt: Date.now() + 3600_000, expectedRebuilds: 2, recacheTokensIfCold: 60000 });
    expect(s.promptCache?.compactedAt).toBeUndefined();
  });

  it('reports changed only when the stored object differs', () => {
    const s = claudeSession();
    const pc: PromptCacheStatus = { warm: true, ttl: '1h', expiresAt: 1, recacheTokensIfCold: 10 };
    expect(s.setPromptCache({ ...pc })).toBe(true);
    expect(s.setPromptCache({ ...pc })).toBe(false);
    expect(s.setPromptCache({ ...pc, warm: false })).toBe(true);
  });
});

describe('prompt-cache report survives a restart', () => {
  it('restores the constructor value onto the session and toState, and a new report replaces it', () => {
    const restored: PromptCacheStatus = { warm: true, ttl: '1h', expiresAt: 1, recacheTokensIfCold: 25000, misses: 1 };
    const s = claudeSession({ promptCache: restored });
    expect(s.promptCache).toEqual(restored);
    expect(s.toState().promptCache).toEqual(restored);
    s.setPromptCache({ warm: false });
    expect(s.toState().promptCache).toEqual({ warm: false });
  });

  it('is absent, not null, when nothing was restored', () => {
    const s = claudeSession();
    expect(s.promptCache).toBeNull();
    expect(s.toState().promptCache).toBeUndefined();
  });

  it('restores a post-compaction value WITHOUT re-stamping it at restart time', () => {
    // A direct restore, not a setPromptCache call: a report from inside the window (recache
    // absent, an OLD compactedAt) must keep its original timestamp through construction,
    // never be re-stamped with "now" as a fresh compaction.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T23:59:00Z'));
    const oldStamp = Date.parse('2026-10-06T22:31:00Z');
    const s = claudeSession({
      promptCache: {
        warm: true,
        ttl: '1h',
        expiresAt: Date.now() + 600_000,
        expectedRebuilds: 3,
        compactedAt: oldStamp,
      },
    });
    expect(s.promptCache?.compactedAt).toBe(oldStamp);
    vi.useRealTimers();
  });
});

describe('a conversation switch drops the prompt-cache report', () => {
  it('clears it when the Claude conversation id changes, keeps it on a same-id reattach', () => {
    const s = claudeSession();
    s.adoptClaudeSessionId('conv-a', { firstHand: true }); // establish the current conversation
    s.setPromptCache({ warm: true, ttl: '1h', expiresAt: Date.now() + 600_000, expectedRebuilds: 0 });
    // A hook reports the SAME conversation (a reattach): the report must survive.
    s.adoptClaudeSessionId('conv-a', { firstHand: true });
    expect(s.promptCache).not.toBeNull();
    // A post-/clear switch to a NEW conversation: the old prefix's state is gone.
    s.adoptClaudeSessionId('conv-b', { firstHand: true });
    expect(s.promptCache).toBeNull();
    expect(s.toState().promptCache).toBeUndefined();
  });
});
