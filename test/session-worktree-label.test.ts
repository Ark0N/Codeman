/**
 * @fileoverview Worktree/branch identity on session rows (#265, #266).
 *
 * Two behaviours are pinned here:
 *  - the unified merge carries gitBranch/worktreeName/worktreeRepo through from
 *    the history source, and filterAndPaginate can search them;
 *  - the client-side badge helper renders `⑂ name · branch`, and stays SILENT
 *    when only a branch is known (a branch is not a worktree — badging those
 *    would put `⑂ master` on every ordinary session).
 *
 * The transcript extractor itself lives inside a closure in session-routes.ts
 * and is covered by the route tests; what matters at this level is that the
 * fields survive the merge and reach a label.
 */

import { describe, it, expect } from 'vitest';
import {
  mergeUnifiedSessions,
  filterAndPaginate,
  type UnifiedSessionItem,
} from '../src/services/unified-session-service.js';

const historyRow = (over: Record<string, unknown> = {}) => ({
  sessionId: 's1',
  workingDir: '/repo/.claude/worktrees/autodev',
  sizeBytes: 9000,
  lastModified: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('worktree fields through the unified merge (#266)', () => {
  it('carries gitBranch / worktreeName / worktreeRepo from the history source', () => {
    const merged = mergeUnifiedSessions({
      history: [historyRow({ gitBranch: 'feat/CF-195', worktreeName: 'autodev', worktreeRepo: '/repo' })],
    });
    expect(merged).toHaveLength(1);
    expect(merged[0].worktreeName).toBe('autodev');
    expect(merged[0].gitBranch).toBe('feat/CF-195');
    expect(merged[0].worktreeRepo).toBe('/repo');
  });

  it('leaves the fields undefined for a non-worktree session rather than inventing them', () => {
    const merged = mergeUnifiedSessions({ history: [historyRow({ workingDir: '/plain/repo' })] });
    expect(merged[0].worktreeName).toBeUndefined();
    expect(merged[0].gitBranch).toBeUndefined();
  });

  it('names the worktree of a LIVE session from its folder layout (no transcript record yet)', () => {
    const merged = mergeUnifiedSessions({
      live: [{ id: 'live1', name: 'w1-fix-login', mode: 'codex', workingDir: '/repo/.claude/worktrees/fix-login' }],
    });
    expect(merged[0]).toMatchObject({ worktreeName: 'fix-login', worktreeRepo: '/repo' });
  });

  it('lets a transcript record win over the layout, and ignores a subfolder of a worktree', () => {
    const fromTranscript = mergeUnifiedSessions({
      history: [historyRow({ worktreeName: 'named-by-claude', worktreeRepo: '/elsewhere' })],
    });
    expect(fromTranscript[0]).toMatchObject({ worktreeName: 'named-by-claude', worktreeRepo: '/elsewhere' });
    const sub = mergeUnifiedSessions({
      live: [{ id: 'live2', name: 'x', workingDir: '/repo/.claude/worktrees/fix-login/src' }],
    });
    expect(sub[0].worktreeName).toBeUndefined();
  });

  it('finds a session by worktree name and by branch', () => {
    const items = [
      { sessionId: 'a', worktreeName: 'autodev', sources: ['history'] },
      { sessionId: 'b', gitBranch: 'feat/CF-195', sources: ['history'] },
      { sessionId: 'c', sources: ['history'] },
    ] as unknown as UnifiedSessionItem[];

    expect(filterAndPaginate(items, { q: 'autodev' }).sessions.map((s) => s.sessionId)).toEqual(['a']);
    expect(filterAndPaginate(items, { q: 'cf-195' }).sessions.map((s) => s.sessionId)).toEqual(['b']);
    expect(filterAndPaginate(items, { q: 'nothing' }).sessions).toHaveLength(0);
  });
});

/**
 * Mirrors `_worktreeLabel` in terminal-ui.js. The frontend is plain browser JS
 * with no module exports, so the logic is restated here; the rule it encodes —
 * never print a branch that merely restates the worktree name — is the part
 * worth pinning.
 */
function worktreeLabel(s: { worktreeName?: string; gitBranch?: string }): string {
  const name = s.worktreeName;
  if (!name) return '';
  let branch = s.gitBranch || '';
  if (branch === name || branch === `worktree-${name}`) branch = '';
  if (branch.length > 24) branch = branch.slice(0, 23) + '…';
  return '⑂ ' + [name, branch].filter(Boolean).join(' · ');
}

describe('worktree badge label', () => {
  it('renders name and branch together', () => {
    expect(worktreeLabel({ worktreeName: 'autodev', gitBranch: 'feat/CF-195' })).toBe('⑂ autodev · feat/CF-195');
  });

  it('renders NOTHING when only a branch is known — a branch is not a worktree', () => {
    // Every ordinary repo session carries gitBranch. Badging those would put
    // `⑂ master` on every row and bury the worktree rows this badge is for.
    expect(worktreeLabel({ gitBranch: 'master' })).toBe('');
    expect(worktreeLabel({ gitBranch: 'feat/CF-200' })).toBe('');
  });

  it('does not repeat the name when the branch just restates it', () => {
    expect(worktreeLabel({ worktreeName: 'autodev', gitBranch: 'autodev' })).toBe('⑂ autodev');
    expect(worktreeLabel({ worktreeName: 'autodev', gitBranch: 'worktree-autodev' })).toBe('⑂ autodev');
  });

  it('is empty for a session that is not on a worktree', () => {
    expect(worktreeLabel({})).toBe('');
  });

  it('truncates a long branch so the single-line badge row cannot blow out', () => {
    const label = worktreeLabel({ worktreeName: 'wt', gitBranch: 'feature/VERY-LONG-BRANCH-NAME-THAT-KEEPS-GOING' });
    expect(label.length).toBeLessThanOrEqual(2 + 2 + 3 + 24);
    expect(label.endsWith('…')).toBe(true);
  });
});
