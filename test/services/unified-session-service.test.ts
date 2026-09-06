/**
 * @fileoverview Unit tests for the pure unified-session merge/filter service (COD-121).
 *
 * Covers dedup across sources, source precedence, mux-stat merge + meaningfulness
 * floor, sort ordering, and filterAndPaginate (search + paging + clamps).
 * Node env only — no jsdom, no IO.
 */

import { describe, it, expect } from 'vitest';
import {
  mergeUnifiedSessions,
  filterAndPaginate,
  type UnifiedSessionItem,
} from '../../src/services/unified-session-service.js';

describe('mergeUnifiedSessions', () => {
  // A codex conversation showing twice is worse than cosmetic: the stale PAST row
  // still resumes, so clicking it starts a SECOND `codex resume` on a thread
  // already open in another pane. Both folds below are what prevent that.
  it('folds a RESUMED codex session into its own rollout row', () => {
    // Session sets claudeSessionId from codexConfig.resumeSessionId, so the live
    // row already names the thread the rollout is keyed by.
    const merged = mergeUnifiedSessions({
      live: [{ id: 'codeman-uuid', status: 'idle', mode: 'codex', claudeSessionId: 'codex-thread-id' }],
      history: [
        {
          sessionId: 'codex-thread-id',
          workingDir: '/w',
          sizeBytes: 4000,
          lastModified: '2026-09-02T00:00:00.000Z',
          mode: 'codex',
          resumeId: 'codex-thread-id',
        },
      ],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].sessionId).toBe('codeman-uuid');
    expect([...merged[0].sources].sort()).toEqual(['history', 'live']);
  });

  it('folds a FRESH codex session once its rollout has been matched by originator', () => {
    // A fresh pane knows no thread id, so gatherUnifiedInputs() stamps one onto
    // the live row from session_meta.originator (see codexThreadBySessionId).
    // This is that stamped row.
    const merged = mergeUnifiedSessions({
      live: [{ id: 'codeman-uuid', status: 'busy', mode: 'codex', claudeSessionId: 'fresh-thread-id' }],
      persisted: [{ id: 'codeman-uuid', status: 'idle', mode: 'codex', claudeSessionId: 'fresh-thread-id' }],
      history: [
        {
          sessionId: 'fresh-thread-id',
          workingDir: '/w',
          sizeBytes: 900,
          lastModified: '2026-09-02T00:00:00.000Z',
          mode: 'codex',
          resumeId: 'fresh-thread-id',
        },
      ],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].sessionId).toBe('codeman-uuid');
    expect(merged[0].status).toBe('busy');
  });

  it('leaves an unrelated codex rollout as its own row', () => {
    const merged = mergeUnifiedSessions({
      live: [{ id: 'codeman-uuid', status: 'idle', mode: 'codex', claudeSessionId: 'thread-one' }],
      history: [
        {
          sessionId: 'thread-two',
          workingDir: '/w',
          sizeBytes: 4000,
          lastModified: '2026-09-02T00:00:00.000Z',
          mode: 'codex',
          resumeId: 'thread-two',
        },
      ],
    });
    expect(merged.map((m) => m.sessionId).sort()).toEqual(['codeman-uuid', 'thread-two']);
  });

  it("carries a transcript row's own resume token, and stamps none on a live row", () => {
    // codex names a thread by an id in its rollout, not by Codeman's session id.
    // The scanner sets `resumeId`; a live session never does, which is what stops
    // a resume from asking codex for a thread whose id is really Codeman's uuid.
    const merged = mergeUnifiedSessions({
      live: [{ id: 'codeman-uuid', status: 'idle', mode: 'codex' }],
      history: [
        {
          sessionId: 'codex-thread-id',
          workingDir: '/w',
          sizeBytes: 4000,
          lastModified: '2026-09-02T00:00:00.000Z',
          mode: 'codex',
          resumeId: 'codex-thread-id',
        },
      ],
    });
    const fromTranscript = merged.find((m) => m.sessionId === 'codex-thread-id');
    const fromLive = merged.find((m) => m.sessionId === 'codeman-uuid');
    expect(fromTranscript?.resumeId).toBe('codex-thread-id');
    expect(fromTranscript?.mode).toBe('codex');
    expect(fromLive?.resumeId).toBeUndefined();
  });

  it('dedupes the same sessionId across live + persisted into one item', () => {
    const merged = mergeUnifiedSessions({
      live: [{ id: 's1', status: 'working', isWorking: true }],
      persisted: [{ id: 's1', status: 'idle' }],
      history: [{ sessionId: 's1', workingDir: '/w', sizeBytes: 5000, lastModified: '2026-01-01T00:00:00.000Z' }],
    });
    expect(merged).toHaveLength(1);
    const item = merged[0];
    expect(item.sessionId).toBe('s1');
    // sources accumulate from every contributing source (order-insensitive)
    expect([...item.sources].sort()).toEqual(['history', 'live', 'persisted']);
    // live wins for status
    expect(item.status).toBe('working');
    expect(item.isWorking).toBe(true);
  });

  it('folds a resumed session transcript (claudeSessionId != id) into ONE row', () => {
    const merged = mergeUnifiedSessions({
      live: [{ id: 'cm-1', status: 'working', claudeSessionId: 'uuid-resume' }],
      history: [
        {
          sessionId: 'uuid-resume', // transcript rows are keyed by the conversation UUID
          workingDir: '/w',
          sizeBytes: 7000,
          lastModified: '2026-01-03T00:00:00.000Z',
          firstPrompt: 'resumed prompt',
        },
      ],
    });
    expect(merged).toHaveLength(1);
    const item = merged[0];
    expect(item.sessionId).toBe('cm-1');
    expect([...item.sources].sort()).toEqual(['history', 'live']);
    expect(item.firstPrompt).toBe('resumed prompt');
    expect(item.sizeBytes).toBe(7000);
  });

  it('resolves history rows through a persisted claudeSessionId alias', () => {
    const merged = mergeUnifiedSessions({
      persisted: [{ id: 'cm-2', name: 'Resumed', claudeSessionId: 'uuid-p' }],
      history: [{ sessionId: 'uuid-p', workingDir: '/w', sizeBytes: 4200, lastModified: '2026-01-04T00:00:00.000Z' }],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].sessionId).toBe('cm-2');
    expect([...merged[0].sources].sort()).toEqual(['history', 'persisted']);
  });

  it('surfaces the NEWEST lifecycle name/mode (entries arrive newest-first)', () => {
    const merged = mergeUnifiedSessions({
      // query() returns newest-first: the rename must win over the original
      // name — an unconditional overwrite would leave the OLDEST standing.
      lifecycle: [
        { sessionId: 'del-1', name: 'Renamed', mode: 'claude', ts: 2000, event: 'deleted' },
        { sessionId: 'del-1', name: 'Original', mode: 'shell', ts: 1000, event: 'created' },
      ],
      history: [
        {
          sessionId: 'del-1',
          workingDir: '/w',
          sizeBytes: 5000,
          lastModified: '2026-01-01T00:00:00.000Z',
          firstPrompt: 'hello',
        },
      ],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].name).toBe('Renamed');
    expect(merged[0].mode).toBe('claude');
  });

  it('lets live status win over persisted (precedence)', () => {
    const merged = mergeUnifiedSessions({
      persisted: [{ id: 's1', status: 'idle', name: 'Persisted Name' }],
      live: [{ id: 's1', status: 'working' }],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].status).toBe('working');
    // persisted name survives because live did not provide one
    expect(merged[0].name).toBe('Persisted Name');
  });

  it('merges mux stats onto a live item but drops a mux-only entry with no name', () => {
    const merged = mergeUnifiedSessions({
      live: [{ id: 's1', status: 'working' }],
      mux: [
        { sessionId: 's1', stats: { memoryMB: 42, cpuPercent: 3.5 }, remote: true },
        { sessionId: 'noise', stats: { memoryMB: 10, cpuPercent: 1 } },
      ],
    });
    expect(merged).toHaveLength(1);
    const item = merged[0];
    expect(item.sessionId).toBe('s1');
    expect(item.stats).toEqual({ memoryMB: 42, cpuPercent: 3.5 });
    expect(item.remote).toBe(true);
  });

  it('drops a lifecycle-only entry with no name/firstPrompt but keeps a history item with firstPrompt', () => {
    const merged = mergeUnifiedSessions({
      lifecycle: [{ sessionId: 'bare', event: 'created', ts: 1000 }],
      history: [
        {
          sessionId: 'hist',
          workingDir: '/w',
          sizeBytes: 9000,
          lastModified: '2026-01-02T00:00:00.000Z',
          firstPrompt: 'do the thing',
        },
      ],
    });
    const ids = merged.map((m) => m.sessionId);
    expect(ids).toContain('hist');
    expect(ids).not.toContain('bare');
  });

  it('sorts by lastActivityAt desc with undefined last', () => {
    const merged = mergeUnifiedSessions({
      live: [
        { id: 'a', status: 'idle', lastActivityAt: 100 },
        { id: 'b', status: 'idle', lastActivityAt: 300 },
        { id: 'c', status: 'idle' }, // no lastActivityAt → sorts last
        { id: 'd', status: 'idle', lastActivityAt: 200 },
      ],
    });
    expect(merged.map((m) => m.sessionId)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('derives lastActivityAt from history lastModified when none better exists', () => {
    const merged = mergeUnifiedSessions({
      history: [{ sessionId: 'h', workingDir: '/w', sizeBytes: 5000, lastModified: '2026-01-01T00:00:00.000Z' }],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].lastActivityAt).toBe(new Date('2026-01-01T00:00:00.000Z').getTime());
  });

  it('surfaces projectKey from a history input onto the merged item', () => {
    const merged = mergeUnifiedSessions({
      history: [
        {
          sessionId: 'h',
          workingDir: '/w',
          sizeBytes: 5000,
          lastModified: '2026-01-01T00:00:00.000Z',
          projectKey: '-repo-alpha',
        },
      ],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].projectKey).toBe('-repo-alpha');
  });

  // COD-140: firstPrompt backfill — live sessions whose Codeman id does not match an
  // on-disk transcript UUID still surface a first prompt (by claudeSessionId join, then
  // by newest transcript in the same workingDir).
  it('backfills firstPrompt onto a live session by claudeSessionId join (uuid-join)', () => {
    const merged = mergeUnifiedSessions({
      live: [{ id: 'codeman-1', status: 'working', claudeSessionId: 'uuid-A', workingDir: '/w' }],
      history: [
        {
          sessionId: 'uuid-A',
          workingDir: '/w',
          sizeBytes: 5000,
          lastModified: '2026-01-01T00:00:00.000Z',
          firstPrompt: 'fix the bug',
        },
      ],
    });
    const live = merged.find((m) => m.sessionId === 'codeman-1');
    expect(live).toBeDefined();
    expect(live!.firstPrompt).toBe('fix the bug');
    // The upstream unified-service alias map (COD-160/161) folds a history row keyed
    // by the Claude conversation UUID into the owning live session (claudeSessionId
    // join), so it does NOT surface as a separate item — the firstPrompt reaches the
    // live row above rather than a duplicate uuid-A entry.
    const hist = merged.find((m) => m.sessionId === 'uuid-A');
    expect(hist).toBeUndefined();
  });

  it('falls back to the workingDir transcript when no uuid join exists (workingDir fallback)', () => {
    const merged = mergeUnifiedSessions({
      live: [{ id: 'codeman-2', status: 'working', claudeSessionId: 'uuid-missing', workingDir: '/w2' }],
      history: [
        {
          sessionId: 'uuid-other',
          workingDir: '/w2',
          sizeBytes: 5000,
          lastModified: '2026-01-01T00:00:00.000Z',
          firstPrompt: 'borrowed prompt',
        },
      ],
    });
    const live = merged.find((m) => m.sessionId === 'codeman-2');
    expect(live).toBeDefined();
    expect(live!.firstPrompt).toBe('borrowed prompt');
  });

  it('uses the newest transcript per workingDir for the fallback (newest-wins)', () => {
    const merged = mergeUnifiedSessions({
      live: [{ id: 'codeman-3', status: 'working', claudeSessionId: 'uuid-missing', workingDir: '/w3' }],
      history: [
        {
          sessionId: 'uuid-old',
          workingDir: '/w3',
          sizeBytes: 5000,
          lastModified: '2026-01-01T00:00:00.000Z',
          firstPrompt: 'older prompt',
        },
        {
          sessionId: 'uuid-new',
          workingDir: '/w3',
          sizeBytes: 6000,
          lastModified: '2026-02-01T00:00:00.000Z',
          firstPrompt: 'newer prompt',
        },
      ],
    });
    const live = merged.find((m) => m.sessionId === 'codeman-3');
    expect(live).toBeDefined();
    expect(live!.firstPrompt).toBe('newer prompt');
  });

  it('never overwrites a firstPrompt that already merged from the session own transcript (no overwrite)', () => {
    const merged = mergeUnifiedSessions({
      live: [{ id: 'self-uuid', status: 'working', claudeSessionId: 'self-uuid', workingDir: '/w4' }],
      history: [
        // the session's own transcript (keyed by its id) — provides the real prompt
        {
          sessionId: 'self-uuid',
          workingDir: '/w4',
          sizeBytes: 5000,
          lastModified: '2026-01-01T00:00:00.000Z',
          firstPrompt: 'own prompt',
        },
        // a newer sibling transcript in the same dir that must NOT clobber it
        {
          sessionId: 'sibling-uuid',
          workingDir: '/w4',
          sizeBytes: 6000,
          lastModified: '2026-03-01T00:00:00.000Z',
          firstPrompt: 'sibling prompt',
        },
      ],
    });
    const self = merged.find((m) => m.sessionId === 'self-uuid');
    expect(self).toBeDefined();
    expect(self!.firstPrompt).toBe('own prompt');
  });

  it('leaves firstPrompt undefined when there is no transcript at all (no transcript)', () => {
    const merged = mergeUnifiedSessions({
      live: [{ id: 'codeman-5', status: 'working', claudeSessionId: 'uuid-none', workingDir: '/empty' }],
    });
    const live = merged.find((m) => m.sessionId === 'codeman-5');
    expect(live).toBeDefined();
    expect(live!.firstPrompt).toBeUndefined();
  });

  it('does NOT borrow a sibling transcript for a history-only row whose own extraction failed (no cross-contamination)', () => {
    // A pure history row already got its own real scan (step 1 keys it under its
    // OWN sessionId) — if that extraction genuinely failed (oversized first
    // message, noise-filtered, etc.), the workingDir guess must not paper over
    // it with an unrelated session's opening line. Regression: an old session
    // in a shared workingDir was displaying TODAY's live session's firstPrompt
    // as its own, because the guess didn't check whether this row already had
    // its own (failed) attempt.
    const merged = mergeUnifiedSessions({
      history: [
        // This session's own transcript scan found no usable prompt.
        {
          sessionId: 'old-uuid',
          workingDir: '/shared',
          sizeBytes: 5000,
          lastModified: '2026-01-01T00:00:00.000Z',
          firstPrompt: undefined,
        },
        // A much newer, unrelated session in the same directory.
        {
          sessionId: 'newer-uuid',
          workingDir: '/shared',
          sizeBytes: 6000,
          lastModified: '2026-06-01T00:00:00.000Z',
          firstPrompt: "today's real prompt",
        },
      ],
    });
    const old = merged.find((m) => m.sessionId === 'old-uuid');
    expect(old).toBeDefined();
    expect(old!.firstPrompt).toBeUndefined();
  });

  it('leaves a RESUMED session blank rather than borrowing a sibling, once its own transcript is aliased in', () => {
    // The exact scenario COD-140's own comment lists first: a live/persisted row
    // whose claudeSessionId aliases to an on-disk transcript. Once that alias
    // successfully folds the transcript's own (failed) extraction into this row
    // (sources includes 'history'), it must NOT then fall through to the
    // workingDir guess and borrow an unrelated sibling's prompt -- same bug as
    // the plain history-only case above, but for the resumed-session path the
    // backfill mechanism was actually built for.
    const merged = mergeUnifiedSessions({
      live: [{ id: 'codeman-resumed', status: 'working', claudeSessionId: 'resumed-uuid', workingDir: '/shared' }],
      history: [
        // The resumed session's OWN transcript -- aliased in via claudeSessionId,
        // but its own extraction found nothing.
        {
          sessionId: 'resumed-uuid',
          workingDir: '/shared',
          sizeBytes: 5000,
          lastModified: '2026-01-01T00:00:00.000Z',
          firstPrompt: undefined,
        },
        // An unrelated, newer sibling in the same directory.
        {
          sessionId: 'sibling-uuid',
          workingDir: '/shared',
          sizeBytes: 6000,
          lastModified: '2026-06-01T00:00:00.000Z',
          firstPrompt: "unrelated sibling's prompt",
        },
      ],
    });
    const resumed = merged.find((m) => m.sessionId === 'codeman-resumed');
    expect(resumed).toBeDefined();
    expect([...resumed!.sources].sort()).toEqual(['history', 'live']);
    expect(resumed!.firstPrompt).toBeUndefined();
  });

  // COD-145: lastPrompt backfill — mirrors the COD-140 firstPrompt path so the
  // most-recent user prompt also reaches live rows whose id ≠ transcript UUID.
  it('backfills lastPrompt onto a live session by claudeSessionId join (uuid-join)', () => {
    const merged = mergeUnifiedSessions({
      live: [{ id: 'codeman-l1', status: 'working', claudeSessionId: 'uuid-LA', workingDir: '/wl' }],
      history: [
        {
          sessionId: 'uuid-LA',
          workingDir: '/wl',
          sizeBytes: 5000,
          lastModified: '2026-01-01T00:00:00.000Z',
          firstPrompt: 'fix the bug',
          lastPrompt: 'now ship it',
        },
      ],
    });
    const live = merged.find((m) => m.sessionId === 'codeman-l1');
    expect(live).toBeDefined();
    expect(live!.lastPrompt).toBe('now ship it');
    // The upstream unified-service alias map (COD-160/161) folds the UUID-keyed
    // history row into the owning live session, so lastPrompt reaches the live row
    // above rather than surfacing as a separate uuid-LA entry.
    const hist = merged.find((m) => m.sessionId === 'uuid-LA');
    expect(hist).toBeUndefined();
  });

  it('falls back to the workingDir transcript for lastPrompt when no uuid join exists (workingDir fallback)', () => {
    const merged = mergeUnifiedSessions({
      live: [{ id: 'codeman-l2', status: 'working', claudeSessionId: 'uuid-missing', workingDir: '/wl2' }],
      history: [
        {
          sessionId: 'uuid-other',
          workingDir: '/wl2',
          sizeBytes: 5000,
          lastModified: '2026-01-01T00:00:00.000Z',
          firstPrompt: 'borrowed first',
          lastPrompt: 'borrowed last',
        },
      ],
    });
    const live = merged.find((m) => m.sessionId === 'codeman-l2');
    expect(live).toBeDefined();
    expect(live!.lastPrompt).toBe('borrowed last');
  });

  it('uses the newest transcript per workingDir for the lastPrompt fallback (newest-wins)', () => {
    const merged = mergeUnifiedSessions({
      live: [{ id: 'codeman-l3', status: 'working', claudeSessionId: 'uuid-missing', workingDir: '/wl3' }],
      history: [
        {
          sessionId: 'uuid-old',
          workingDir: '/wl3',
          sizeBytes: 5000,
          lastModified: '2026-01-01T00:00:00.000Z',
          firstPrompt: 'older first',
          lastPrompt: 'older last',
        },
        {
          sessionId: 'uuid-new',
          workingDir: '/wl3',
          sizeBytes: 6000,
          lastModified: '2026-02-01T00:00:00.000Z',
          firstPrompt: 'newer first',
          lastPrompt: 'newer last',
        },
      ],
    });
    const live = merged.find((m) => m.sessionId === 'codeman-l3');
    expect(live).toBeDefined();
    expect(live!.lastPrompt).toBe('newer last');
  });

  it('never overwrites a lastPrompt that already merged from the session own transcript (no overwrite)', () => {
    const merged = mergeUnifiedSessions({
      live: [{ id: 'self-luuid', status: 'working', claudeSessionId: 'self-luuid', workingDir: '/wl4' }],
      history: [
        {
          sessionId: 'self-luuid',
          workingDir: '/wl4',
          sizeBytes: 5000,
          lastModified: '2026-01-01T00:00:00.000Z',
          firstPrompt: 'own first',
          lastPrompt: 'own last',
        },
        {
          sessionId: 'sibling-uuid',
          workingDir: '/wl4',
          sizeBytes: 6000,
          lastModified: '2026-03-01T00:00:00.000Z',
          firstPrompt: 'sibling first',
          lastPrompt: 'sibling last',
        },
      ],
    });
    const self = merged.find((m) => m.sessionId === 'self-luuid');
    expect(self).toBeDefined();
    expect(self!.lastPrompt).toBe('own last');
  });
});

describe('filterAndPaginate', () => {
  const items: UnifiedSessionItem[] = [
    { sessionId: 's1', name: 'Alpha build', sources: ['live'], workingDir: '/repo/alpha' },
    { sessionId: 's2', name: 'Beta', firstPrompt: 'fix the login bug', sources: ['history'], workingDir: '/repo/beta' },
    { sessionId: 's3', name: 'Gamma', sources: ['persisted'], workingDir: '/srv/gamma' },
    {
      sessionId: 's4',
      name: 'Delta',
      firstPrompt: 'start the migration',
      lastPrompt: 'roll back the migration',
      sources: ['history'],
      workingDir: '/repo/delta',
    },
  ];

  it('filters by name (case-insensitive)', () => {
    const r = filterAndPaginate(items, { q: 'alpha' });
    expect(r.total).toBe(1);
    expect(r.sessions[0].sessionId).toBe('s1');
  });

  it('filters by firstPrompt and workingDir', () => {
    expect(filterAndPaginate(items, { q: 'login bug' }).sessions[0].sessionId).toBe('s2');
    expect(filterAndPaginate(items, { q: '/srv/' }).sessions[0].sessionId).toBe('s3');
  });

  it('filters by lastPrompt (COD-145)', () => {
    const r = filterAndPaginate(items, { q: 'roll back' });
    expect(r.total).toBe(1);
    expect(r.sessions[0].sessionId).toBe('s4');
  });

  it('reports total as the pre-page filtered count', () => {
    const r = filterAndPaginate(items, { q: 'repo', limit: 1 });
    // s1, s2, and s4 all have /repo/ workingDir
    expect(r.total).toBe(3);
    expect(r.sessions).toHaveLength(1);
  });

  it('clamps limit to a max of 500', () => {
    const r = filterAndPaginate(items, { limit: 99999 });
    expect(r.sessions).toHaveLength(items.length);
    // clamp does not throw and returns all items (< 500)
    expect(r.total).toBe(items.length);
  });

  it('clamps limit to a min of 1', () => {
    const r = filterAndPaginate(items, { limit: 0 });
    expect(r.sessions).toHaveLength(1);
  });

  it('paginates with disjoint pages via offset', () => {
    const page1 = filterAndPaginate(items, { offset: 0, limit: 2 });
    const page2 = filterAndPaginate(items, { offset: 2, limit: 2 });
    expect(page1.sessions.map((s) => s.sessionId)).toEqual(['s1', 's2']);
    expect(page2.sessions.map((s) => s.sessionId)).toEqual(['s3', 's4']);
    const overlap = page1.sessions
      .map((s) => s.sessionId)
      .filter((id) => page2.sessions.map((s2) => s2.sessionId).includes(id));
    expect(overlap).toEqual([]);
  });
});
