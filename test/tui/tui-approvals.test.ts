/**
 * @fileoverview Unit tests for reading an approvals-inbox item.
 *
 * The key matrix is the part worth pinning: a digit the server did not parse
 * off the pane must NOT produce an answer (it would be typed at a dialog that
 * has no such option), and an idle prompt must produce none at all, since there
 * is no dialog on screen and every keystroke would land in the composer.
 */
import { describe, it, expect } from 'vitest';
import {
  approvalAnswerForKey,
  approvalCard,
  approvalDenyOption,
  approvalTone,
  newApprovalIds,
} from '../../src/tui/tui-approvals.js';
import type { ApprovalItem } from '../../src/web/approval-inbox.js';

const NOW = 1_700_000_000_000;

function item(overrides: Partial<ApprovalItem> = {}): ApprovalItem {
  return {
    id: 'sess:1',
    sessionId: 'sess',
    sessionName: 'w4-api',
    kind: 'permission',
    createdAt: NOW,
    toolName: 'Bash',
    toolSummary: 'Bash(git push origin main)',
    options: [
      { n: 1, label: 'Yes' },
      { n: 2, label: "Yes, don't ask again" },
      { n: 3, label: 'No, tell Claude what to do (esc)' },
    ],
    ...overrides,
  };
}

describe('approvalCard', () => {
  it('leads a permission prompt with the tool it wants to run', () => {
    const card = approvalCard(item());
    expect(card.tone).toBe('err');
    expect(card.title).toContain('Bash(git push origin main)');
    expect(card.options).toHaveLength(3);
    expect(card.hint).toContain('y approve');
    expect(card.hint).toContain('digit');
  });

  it('leads a question with its message', () => {
    const card = approvalCard(item({ kind: 'question', message: 'Which color?', toolSummary: undefined }));
    expect(card.title).toBe('Which color?');
    expect(card.tone).toBe('err');
  });

  it('says an idle prompt is answered by typing, not by approving', () => {
    const card = approvalCard(item({ kind: 'idle', message: 'waiting for input', options: undefined }));
    expect(card.tone).toBe('warn');
    expect(card.options).toEqual([]);
    expect(card.hint).toBe('p to reply');
  });

  it('says why an acknowledged idle prompt is quiet, in the drawer own words', () => {
    // The session is watching work it started itself. Asking for a reply would be the
    // same false alarm the acknowledgement exists to remove, so the card states the
    // reason and drops out of the warning vocabulary — while staying answerable.
    const card = approvalCard(
      item({
        kind: 'idle',
        message: 'Claude is waiting for your input',
        options: undefined,
        acknowledgedAt: 1_700_000_000_000,
        acknowledgedReason: 'watching 1 monitor',
      })
    );
    expect(card.tone).toBe('info');
    expect(card.title).toBe('quiet, watching 1 monitor');
    expect(card.hint).toBe('p to reply');
  });

  it('drops the approve/deny-only hint when the frame did not parse', () => {
    const card = approvalCard(item({ options: undefined }));
    expect(card.options).toEqual([]);
    expect(card.hint).toBe('y approve · n deny');
  });

  it('keeps the message as detail when it says more than the tool line', () => {
    expect(approvalCard(item({ message: 'about to force-push' })).detail).toEqual(['about to force-push']);
    expect(approvalCard(item({ message: 'Bash(git push origin main)' })).detail).toEqual([]);
  });

  it('collapses whitespace so a wrapped hook field cannot break the card', () => {
    expect(approvalCard(item({ toolSummary: 'Bash(git\n  push)' })).title).toBe('requests: Bash(git push)');
  });
});

describe('approvalTone', () => {
  it('is red for a dialog and yellow for a waiting prompt', () => {
    expect(approvalTone(item())).toBe('err');
    expect(approvalTone(item({ kind: 'question' }))).toBe('err');
    expect(approvalTone(item({ kind: 'idle' }))).toBe('warn');
  });

  it('is neither for a prompt that opened acknowledged', () => {
    expect(approvalTone(item({ kind: 'idle', acknowledgedReason: 'watching 2 shells' }))).toBe('info');
    // A dialog stays red whatever else the session started.
    expect(approvalTone(item({ kind: 'permission', acknowledgedReason: 'watching 2 shells' }))).toBe('err');
  });
});

describe('approvalAnswerForKey', () => {
  it('approves with y', () => {
    expect(approvalAnswerForKey(item(), 'y')).toEqual({ action: 'approve' });
  });

  it('denies with the parsed No option when there is one', () => {
    expect(approvalDenyOption(item())).toBe(3);
    expect(approvalAnswerForKey(item(), 'n')).toEqual({ action: 'option', option: 3 });
  });

  it('falls back to Esc semantics when no No option parsed', () => {
    expect(approvalDenyOption(item({ options: undefined }))).toBeNull();
    expect(approvalAnswerForKey(item({ options: undefined }), 'n')).toEqual({ action: 'deny' });
    expect(
      approvalAnswerForKey(
        item({
          options: [
            { n: 1, label: 'Red' },
            { n: 2, label: 'Blue' },
          ],
        }),
        'n'
      )
    ).toEqual({
      action: 'deny',
    });
  });

  it('answers with a digit only when the server parsed that option', () => {
    expect(approvalAnswerForKey(item(), '2')).toEqual({ action: 'option', option: 2 });
    expect(approvalAnswerForKey(item(), '4')).toBeNull();
    expect(approvalAnswerForKey(item({ options: undefined }), '1')).toBeNull();
  });

  it('makes no key an answer for an idle prompt', () => {
    const idle = item({ kind: 'idle', options: undefined });
    for (const key of ['y', 'n', '1', '2', '9']) expect(approvalAnswerForKey(idle, key)).toBeNull();
  });

  it('leaves every other key to the list', () => {
    for (const key of ['j', 'k', 'q', 'x', 'p', '/', 'g', '0']) {
      expect(approvalAnswerForKey(item(), key)).toBeNull();
    }
  });
});

describe('newApprovalIds', () => {
  it('reports only ids the set has not seen', () => {
    const seen = new Set(['sess:1']);
    expect(newApprovalIds(seen, [item(), item({ id: 'other:7', sessionId: 'other' })])).toEqual(['other:7']);
    expect(newApprovalIds(seen, [item()])).toEqual([]);
    expect(newApprovalIds(new Set(), [])).toEqual([]);
  });

  it('reports one id once even when it arrives twice', () => {
    expect(newApprovalIds(new Set(), [item(), item()])).toEqual(['sess:1']);
  });
});
