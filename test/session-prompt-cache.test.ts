/**
 * Session.setPromptCache's compaction detection and the restore of the last report.
 *
 * The statusline never reports WHEN Claude Code's own idle compaction happened, so the
 * session stamps it: `recacheTokensIfCold` null (the transient post-compaction window the
 * CC statusline docs describe) while `expectedRebuilds` rose above the last report. The
 * stamp drives the "compacted at HH:MM" readout; it is never an alert. A rise is only a rise
 * against a KNOWN prior counter, so a first high report never invents one. The last report is
 * restored through the constructor (keeping an old compaction stamp, never re-stamping at
 * restart time), and a conversation switch drops it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session } from '../src/session.js';
import type { PromptCacheStatus } from '../src/types.js';

function claudeSession(extra: Record<string, unknown> = {}): Session {
  return new Session({ workingDir: '/tmp', mode: 'claude', ...extra } as ConstructorParameters<typeof Session>[0]);
}

describe('Session.setPromptCache compaction detection', () => {
  afterEach(() => vi.useRealTimers());

  it('stamps compactedAt only when recache went null and expected_rebuilds rose', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T22:05:00Z'));
    const s = claudeSession();

    // A normal warm report establishes the rebuild baseline (known 0): recache known, no
    // compaction yet. Claude reports expected_rebuilds from the first response, so a real
    // baseline always carries it.
    s.setPromptCache({
      warm: true,
      ttl: '1h',
      expiresAt: Date.now() + 3600_000,
      expectedRebuilds: 0,
      recacheTokensIfCold: 50000,
    });
    expect(s.promptCache?.compactedAt).toBeUndefined();

    // Claude Code compacts: recache goes null (absent after parsing), expected_rebuilds rises,
    // the prefix stays warm. This is the one transition that stamps.
    vi.setSystemTime(new Date('2026-10-06T22:31:00Z'));
    s.setPromptCache({ warm: true, ttl: '1h', expiresAt: Date.now() + 3600_000, expectedRebuilds: 1 });
    expect(s.promptCache?.compactedAt).toBe(Date.parse('2026-10-06T22:31:00Z'));
  });

  it('carries the stamp forward through the transient window, drops it once a real request re-caches', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T22:30:00Z'));
    const s = claudeSession();
    // Baseline (known rebuild count) then the compaction, so the rise is against a known prior.
    s.setPromptCache({ warm: true, expiresAt: Date.now() + 3600_000, expectedRebuilds: 0, recacheTokensIfCold: 70000 });
    vi.setSystemTime(new Date('2026-10-06T22:31:00Z'));
    s.setPromptCache({ warm: true, expiresAt: Date.now() + 3600_000, expectedRebuilds: 1 });
    const stampedAt = s.promptCache?.compactedAt;
    expect(stampedAt).toBe(Date.parse('2026-10-06T22:31:00Z'));

    // A later idle report, still no request since the compaction: same rebuild count, recache
    // still null. The stamp is kept (not re-stamped), so the clock in the readout does not move.
    vi.setSystemTime(new Date('2026-10-06T22:45:00Z'));
    s.setPromptCache({ warm: true, expiresAt: Date.now() + 3600_000, expectedRebuilds: 1 });
    expect(s.promptCache?.compactedAt).toBe(stampedAt);

    // The next real request records the rewritten size (recache non-null): the window is over.
    s.setPromptCache({ warm: true, expiresAt: Date.now() + 3600_000, expectedRebuilds: 1, recacheTokensIfCold: 42000 });
    expect(s.promptCache?.compactedAt).toBeUndefined();
  });

  it('never stamps a plain miss (recache present) or an unchanged rebuild count', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T22:31:00Z'));
    const s = claudeSession();
    // expected_rebuilds rose but recache is present: the transient window was already missed.
    s.setPromptCache({ warm: true, expiresAt: Date.now() + 3600_000, expectedRebuilds: 2, recacheTokensIfCold: 60000 });
    expect(s.promptCache?.compactedAt).toBeUndefined();
    // recache null but the rebuild count did not rise: not a fresh compaction.
    s.setPromptCache({ warm: true, expiresAt: Date.now() + 3600_000, expectedRebuilds: 2 });
    expect(s.promptCache?.compactedAt).toBeUndefined();
  });

  it('never invents a stamp without a KNOWN prior rebuild count (a rise needs two known reports)', () => {
    // The very first report Codeman sees already carries a high count with recache null (a
    // restart mid-session). Treating an absent prior as 0 would fabricate "compacted now".
    const s1 = claudeSession();
    s1.setPromptCache({ warm: true, expiresAt: Date.now() + 3600_000, expectedRebuilds: 4 });
    expect(s1.promptCache?.compactedAt).toBeUndefined();

    // `4 -> omitted -> 4`: a report that drops the counter clears the known prior, so the next
    // report carrying 4 again is not a provable rise.
    const s2 = claudeSession();
    s2.setPromptCache({ warm: true, expiresAt: Date.now() + 3600_000, expectedRebuilds: 4, recacheTokensIfCold: 10 });
    s2.setPromptCache({ warm: true, expiresAt: Date.now() + 3600_000 }); // counter omitted
    s2.setPromptCache({ warm: true, expiresAt: Date.now() + 3600_000, expectedRebuilds: 4 });
    expect(s2.promptCache?.compactedAt).toBeUndefined();
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
    // A direct restore, not a setPromptCache call: an already-compacted report (recache absent,
    // expectedRebuilds > 0, an OLD compactedAt) must keep its original timestamp through
    // construction, never be re-stamped with "now" as a fresh compaction.
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
