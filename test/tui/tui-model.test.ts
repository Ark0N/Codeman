/**
 * @fileoverview Unit tests for TUI classification, grouping and the cursor.
 *
 * Rows are built in the shape `GET /api/sessions/unified` really returns
 * (`UnifiedSessionItem`, `sources` and all), and approvals in the shape the
 * approvals inbox really emits, so a change to either surface breaks these
 * tests rather than the dashboard.
 */
import { describe, it, expect } from 'vitest';
import type { ApprovalItem } from '../../src/web/approval-inbox.js';
import type { SearchResultGroup } from '../../src/types/search.js';
import { createComposer } from '../../src/tui/tui-composer.js';
import {
  buildRows,
  buildSearchEntries,
  classifySession,
  createTuiModel,
  firstSearchIndex,
  flattenRows,
  groupSessions,
  mergeSessionRow,
  moveSearchIndex,
} from '../../src/tui/tui-model.js';
import type { TuiSessionRow } from '../../src/tui/tui-types.js';

const NOW = 1_700_000_000_000;

function session(overrides: Partial<TuiSessionRow> & { sessionId: string }): TuiSessionRow {
  return {
    sources: ['live'],
    name: overrides.sessionId,
    mode: 'claude',
    status: 'idle',
    workingDir: '/home/dev/case',
    createdAt: NOW - 60_000,
    lastActivityAt: NOW - 60_000,
    ...overrides,
  };
}

function approval(overrides: Partial<ApprovalItem> & { sessionId: string }): ApprovalItem {
  return {
    id: `${overrides.sessionId}:1`,
    sessionName: overrides.sessionId,
    kind: 'permission',
    createdAt: NOW - 30_000,
    ...overrides,
  };
}

function approvalMap(items: ApprovalItem[]): Map<string, ApprovalItem> {
  return new Map(items.map((item) => [item.sessionId, item]));
}

describe('classifySession', () => {
  it('classifies live sessions by status', () => {
    expect(classifySession(session({ sessionId: 'a', status: 'busy' }))).toBe('working');
    expect(classifySession(session({ sessionId: 'a', status: 'idle', isWorking: true }))).toBe('working');
    expect(classifySession(session({ sessionId: 'a', status: 'idle' }))).toBe('idle');
    expect(classifySession(session({ sessionId: 'a', status: 'stopped' }))).toBe('idle');
  });

  it('puts an errored session in the needs-you tier', () => {
    expect(classifySession(session({ sessionId: 'a', status: 'error' }))).toBe('waiting');
  });

  it('classifies by the pending prompt, which outranks a stale busy status', () => {
    const row = session({ sessionId: 'a', status: 'busy' });
    expect(classifySession(row, approval({ sessionId: 'a', kind: 'permission' }))).toBe('blocked-permission');
    expect(classifySession(row, approval({ sessionId: 'a', kind: 'question' }))).toBe('blocked-question');
    expect(classifySession(row, approval({ sessionId: 'a', kind: 'idle' }))).toBe('waiting');
  });

  it('stops an ACKNOWLEDGED prompt deciding the row', () => {
    // Acknowledgement means the alert this prompt armed has been spent, either because
    // a human opened the session elsewhere or because the inbox opened the item that way
    // for a session watching its own background work. The web has honoured that since
    // acknowledgement existed; this gate used to read past it, so an alert cleared on a
    // phone stayed lit here alone.
    const quiet = session({ sessionId: 'a', status: 'idle' });
    const seen = approval({ sessionId: 'a', kind: 'idle', acknowledgedAt: NOW - 1_000 });
    expect(classifySession(quiet, seen)).toBe('idle');
    expect(classifySession(session({ sessionId: 'a', status: 'busy' }), seen)).toBe('working');
  });

  it('keeps a blocking dialog lit whatever its acknowledgement says', () => {
    // `acknowledge()` is idle-only by construction, so this cannot happen through the
    // routes. It is pinned because the cost of the two being wired together later is a
    // permission dialog that stops asking.
    const row = session({ sessionId: 'a' });
    const at = NOW - 1_000;
    expect(classifySession(row, approval({ sessionId: 'a', kind: 'permission', acknowledgedAt: at }))).toBe(
      'blocked-permission'
    );
    expect(classifySession(row, approval({ sessionId: 'a', kind: 'question', acknowledgedAt: at }))).toBe(
      'blocked-question'
    );
  });

  it('classifies a row the server no longer has live as history', () => {
    expect(classifySession(session({ sessionId: 'a', sources: ['history'], status: 'busy' }))).toBe('recent');
    expect(classifySession(session({ sessionId: 'a', sources: ['persisted', 'lifecycle'] }))).toBe('recent');
    expect(classifySession(session({ sessionId: 'a', sources: ['history', 'live'] }))).toBe('idle');
  });
});

describe('an acknowledged prompt on a watching session', () => {
  const sessions = [session({ sessionId: 'watcher', status: 'idle', lastActivityAt: NOW - 120_000 })];
  const approvals = approvalMap([
    approval({
      sessionId: 'watcher',
      kind: 'idle',
      createdAt: NOW - 30_000,
      acknowledgedAt: NOW - 30_000,
      acknowledgedReason: 'watching 1 monitor',
    }),
  ]);

  it('raises no alert: the row leaves NEEDS YOU entirely', () => {
    const groups = groupSessions(buildRows(sessions, approvals));
    const byKey = Object.fromEntries(groups.map((group) => [group.key, group.rows.map((r) => r.session.sessionId)]));
    expect(byKey['needs-you']).toEqual([]);
    expect(byKey['idle']).toEqual(['watcher']);
  });

  it('keeps the item on the row, because it is still pending and still answerable', () => {
    const [row] = buildRows(sessions, approvals);
    expect(row.approval?.acknowledgedReason).toBe('watching 1 monitor');
  });

  it('dates the row from the pane going quiet, not from the prompt', () => {
    // The prompt's age measures the state only while the prompt is what put the row in
    // it. Reading it here would report "idle 30s" for a session quiet for two minutes.
    const [row] = buildRows(sessions, approvals);
    expect(row.since).toBe(NOW - 120_000);
  });

  it('alerts again once the same session goes quiet for an ordinary reason', () => {
    // The inbox supersedes the acknowledged item and builds a fresh one, so this is the
    // next prompt rather than the same one changing its mind.
    const fresh = approvalMap([approval({ sessionId: 'watcher', kind: 'idle', createdAt: NOW - 1_000 })]);
    const groups = groupSessions(buildRows(sessions, fresh));
    expect(groups[0].rows.map((row) => row.session.sessionId)).toEqual(['watcher']);
  });
});

describe('groupSessions', () => {
  it('always returns the four groups in display order', () => {
    expect(groupSessions([]).map((group) => group.key)).toEqual(['needs-you', 'working', 'idle', 'recent']);
    expect(groupSessions([]).map((group) => group.label)).toEqual(['NEEDS YOU', 'WORKING', 'IDLE', 'RECENT']);
  });

  it('orders NEEDS YOU by how long each has been blocked, longest first', () => {
    const sessions = [session({ sessionId: 'fresh' }), session({ sessionId: 'old' }), session({ sessionId: 'middle' })];
    const approvals = approvalMap([
      approval({ sessionId: 'fresh', createdAt: NOW - 5_000 }),
      approval({ sessionId: 'old', createdAt: NOW - 900_000, kind: 'idle' }),
      approval({ sessionId: 'middle', createdAt: NOW - 60_000, kind: 'question' }),
    ]);
    const groups = groupSessions(buildRows(sessions, approvals));
    expect(groups[0].rows.map((row) => row.session.sessionId)).toEqual(['old', 'middle', 'fresh']);
  });

  it('orders WORKING by turn start, longest-running first', () => {
    const sessions = [
      session({ sessionId: 'short', status: 'busy', lastSubmitAt: NOW - 10_000, lastActivityAt: NOW }),
      session({ sessionId: 'long', status: 'busy', lastSubmitAt: NOW - 3_600_000, lastActivityAt: NOW }),
      session({ sessionId: 'nosubmit', status: 'busy', createdAt: NOW - 500, lastActivityAt: NOW }),
    ];
    const groups = groupSessions(buildRows(sessions));
    expect(groups[1].rows.map((row) => row.session.sessionId)).toEqual(['long', 'short', 'nosubmit']);
  });

  it('orders IDLE and RECENT newest first', () => {
    const sessions = [
      session({ sessionId: 'i-old', lastActivityAt: NOW - 900_000 }),
      session({ sessionId: 'i-new', lastActivityAt: NOW - 1_000 }),
      session({ sessionId: 'h-old', sources: ['history'], lastActivityAt: NOW - 86_400_000 }),
      session({ sessionId: 'h-new', sources: ['history'], lastActivityAt: NOW - 3_600_000 }),
    ];
    const groups = groupSessions(buildRows(sessions));
    expect(groups[2].rows.map((row) => row.session.sessionId)).toEqual(['i-new', 'i-old']);
    expect(groups[3].rows.map((row) => row.session.sessionId)).toEqual(['h-new', 'h-old']);
  });

  it('caps RECENT', () => {
    const sessions = Array.from({ length: 20 }, (_, i) =>
      session({ sessionId: `h${i}`, sources: ['history'], lastActivityAt: NOW - i * 1000 })
    );
    expect(groupSessions(buildRows(sessions))[3].rows).toHaveLength(8);
    expect(groupSessions(buildRows(sessions), { recentLimit: 3 })[3].rows.map((r) => r.session.sessionId)).toEqual([
      'h0',
      'h1',
      'h2',
    ]);
    expect(groupSessions(buildRows(sessions), { recentLimit: 0 })[3].rows).toEqual([]);
  });

  it('sorts deterministically when the anchors tie', () => {
    const sessions = [
      session({ sessionId: 'b', lastActivityAt: NOW }),
      session({ sessionId: 'a', lastActivityAt: NOW }),
    ];
    expect(groupSessions(buildRows(sessions))[2].rows.map((row) => row.session.sessionId)).toEqual(['a', 'b']);
  });

  it('sorts an unknown anchor last in both directions', () => {
    const withAnchor = session({ sessionId: 'known', lastActivityAt: NOW - 1000 });
    const without = session({ sessionId: 'unknown', lastActivityAt: undefined, createdAt: undefined });
    const idle = groupSessions(buildRows([without, withAnchor]))[2];
    expect(idle.rows.map((row) => row.session.sessionId)).toEqual(['known', 'unknown']);
  });
});

describe('mergeSessionRow', () => {
  it('keeps fields the incoming row does not carry', () => {
    const existing = session({ sessionId: 'a', firstPrompt: 'hello', inputTokens: 10 });
    const merged = mergeSessionRow(existing, { sessionId: 'a', sources: ['live'], status: 'busy' });
    expect(merged.firstPrompt).toBe('hello');
    expect(merged.inputTokens).toBe(10);
    expect(merged.status).toBe('busy');
  });

  it('lets a session lose its live source when the server drops it', () => {
    const existing = session({ sessionId: 'a', sources: ['live', 'persisted'] });
    const merged = mergeSessionRow(existing, { sessionId: 'a', sources: ['history'] });
    expect(merged.sources).toEqual(['history']);
    expect(classifySession(merged)).toBe('recent');
  });
});

describe('the store', () => {
  it('selects the first row as soon as there is one', () => {
    const model = createTuiModel();
    expect(model.selectedSession()).toBeNull();
    model.replaceSessions([session({ sessionId: 'a' }), session({ sessionId: 'b' })]);
    expect(model.selectedId).toBe(model.rows()[0].session.sessionId);
  });

  it('moves the cursor over rows only, wrapping at both ends', () => {
    const model = createTuiModel();
    model.replaceSessions([
      session({ sessionId: 'needs' }),
      session({ sessionId: 'work', status: 'busy', lastSubmitAt: NOW - 1000 }),
      session({ sessionId: 'idle' }),
      session({ sessionId: 'past', sources: ['history'] }),
    ]);
    model.setApprovals([approval({ sessionId: 'needs' })]);
    // One row per group: the cursor must cross the group headers without stopping.
    expect(model.rows().map((row) => row.session.sessionId)).toEqual(['needs', 'work', 'idle', 'past']);

    model.select('needs');
    model.moveCursor(1);
    expect(model.selectedId).toBe('work');
    model.moveCursor(-1);
    expect(model.selectedId).toBe('needs');
    model.moveCursor(-1);
    expect(model.selectedId).toBe('past');
    model.moveCursor(1);
    expect(model.selectedId).toBe('needs');
  });

  it('jumps by 1-based index and refuses one that is off the list', () => {
    const model = createTuiModel();
    model.replaceSessions([
      session({ sessionId: 'a', lastActivityAt: NOW }),
      session({ sessionId: 'b', lastActivityAt: NOW - 1 }),
      session({ sessionId: 'c', lastActivityAt: NOW - 2 }),
    ]);
    expect(model.cursorToIndex(3)).toBe(true);
    expect(model.selectedId).toBe('c');
    expect(model.cursorToIndex(9)).toBe(false);
    expect(model.selectedId).toBe('c');
    expect(model.cursorToIndex(0)).toBe(false);
  });

  it('keeps the selection on its session when the rows re-sort under it', () => {
    const model = createTuiModel();
    model.replaceSessions([
      session({ sessionId: 'a', lastActivityAt: NOW }),
      session({ sessionId: 'b', lastActivityAt: NOW - 1000 }),
    ]);
    model.select('b');
    expect(model.rows()[1].session.sessionId).toBe('b');

    // b becomes blocked and jumps to the top of the list.
    model.setApprovals([approval({ sessionId: 'b' })]);
    expect(model.rows()[0].session.sessionId).toBe('b');
    expect(model.selectedId).toBe('b');
    expect(model.selectedSession()?.state).toBe('blocked-permission');
  });

  it('hands the cursor to whatever takes the place of a removed session', () => {
    const model = createTuiModel();
    model.replaceSessions([
      session({ sessionId: 'a', lastActivityAt: NOW }),
      session({ sessionId: 'b', lastActivityAt: NOW - 1 }),
      session({ sessionId: 'c', lastActivityAt: NOW - 2 }),
    ]);
    model.select('b');
    model.removeSession('b');
    expect(model.selectedId).toBe('c');
    model.replaceSessions([session({ sessionId: 'a', lastActivityAt: NOW })]);
    expect(model.selectedId).toBe('a');
    model.replaceSessions([]);
    expect(model.selectedId).toBeNull();
    expect(model.selectedSession()).toBeNull();
  });

  it('merges an SSE update into the row it already has', () => {
    const model = createTuiModel();
    model.replaceSessions([session({ sessionId: 'a', firstPrompt: 'first thing' })]);
    model.upsertSession({ sessionId: 'a', sources: ['live'], status: 'busy', inputTokens: 5 });
    const row = model.rows()[0];
    expect(row.state).toBe('working');
    expect(row.session.firstPrompt).toBe('first thing');
    expect(row.session.inputTokens).toBe(5);
  });

  it('counts only live sessions', () => {
    const model = createTuiModel();
    model.replaceSessions([
      session({ sessionId: 'a' }),
      session({ sessionId: 'b' }),
      session({ sessionId: 'h', sources: ['history'] }),
    ]);
    expect(model.sessionCount).toBe(2);
    expect(flattenRows(model.groups())).toHaveLength(3);
  });

  // Whether the typed text AUTHORIZES the kill is `confirmAccepts()` in
  // tui-app, tested there; the store only carries what was typed.
  it('tracks the confirm-kill overlay, keyed to the name it showed', () => {
    const model = createTuiModel();
    model.replaceSessions([session({ sessionId: 'a', name: 'w4-api' })]);
    model.beginConfirmKill(model.rows()[0], 'w4-api');
    expect(model.mode).toBe('confirm-kill');
    // The name is the whole payload: it is what the dialog shows so the user
    // knows WHICH session a `y` is about to destroy.
    expect(model.confirm).toEqual({ sessionId: 'a', name: 'w4-api' });

    // Regression: the label is supplied by the caller. Deriving it here with
    // `name ?? id` let an EMPTY name through, and the dialog read "Kill ?".
    model.replaceSessions([session({ sessionId: 'b', name: '' })]);
    model.beginConfirmKill(model.rows()[0], 'mirofish');
    expect(model.confirm?.name).toBe('mirofish');
    model.closeOverlay();
    expect(model.mode).toBe('list');
    expect(model.confirm).toBeNull();
  });

  it('drops a session approval along with the session, and never resurrects it', () => {
    const model = createTuiModel();
    model.replaceSessions([session({ sessionId: 'a' })]);
    model.setApprovals([approval({ sessionId: 'a' })]);
    expect(model.rows()[0].approval).toBeDefined();
    model.removeSession('a');
    expect(model.rows()).toHaveLength(0);
    // The same id coming back must not inherit the dead session's dialog.
    model.upsertSession(session({ sessionId: 'a' }));
    expect(model.rows()[0].approval).toBeUndefined();
    expect(model.rows()[0].state).toBe('idle');
  });
});

describe('the phase-2 overlays', () => {
  it('gives one overlay the keyboard at a time and clears them together', () => {
    const model = createTuiModel();
    model.setPrompt({ sessionId: 'a', label: 'w4-api', composer: createComposer('hi') });
    expect(model.mode).toBe('prompt');
    model.setSearch({ composer: createComposer(), query: '', entries: [], index: -1, status: 'idle' });
    expect(model.mode).toBe('search');
    model.setDigest({ title: 'Away digest', lines: ['a', 'b'], offset: 0 });
    expect(model.mode).toBe('digest');
    model.closeOverlay();
    expect(model.mode).toBe('list');
    expect([model.prompt, model.search, model.digest]).toEqual([null, null, null]);
  });

  it('keeps the composer pointed at its session while the text changes', () => {
    const model = createTuiModel();
    model.setPrompt({ sessionId: 'a', label: 'w4-api', composer: createComposer() });
    const revision = model.revision;
    model.updatePrompt(createComposer('deploy'));
    expect(model.prompt?.sessionId).toBe('a');
    expect(model.revision).toBeGreaterThan(revision);
  });

  it('scrolls the digest without running off either end', () => {
    const model = createTuiModel();
    model.setDigest({ title: 'Away digest', lines: Array.from({ length: 10 }, (_, i) => `line ${i}`), offset: 0 });
    model.scrollDigest(3, 4);
    expect(model.digest?.offset).toBe(3);
    model.scrollDigest(100, 4);
    expect(model.digest?.offset).toBe(6);
    model.scrollDigest(-100, 4);
    expect(model.digest?.offset).toBe(0);
  });
});

describe('search results', () => {
  const groups: SearchResultGroup[] = [
    {
      type: 'session',
      results: [
        {
          type: 'session',
          sessionId: 'live-1',
          sessionName: 'w1-alpha',
          timestamp: NOW,
          snippet: 'w1-alpha — /tmp/alpha',
          exactMatch: true,
          jumpTo: { kind: 'session', sessionId: 'live-1' },
        },
        {
          type: 'session',
          sessionId: 'past-1',
          sessionName: 'w9-old',
          timestamp: NOW - 1000,
          snippet: '/tmp/old',
          exactMatch: false,
          jumpTo: { kind: 'resume-session', sessionId: 'past-1' },
        },
      ],
    },
    {
      type: 'file',
      results: [
        {
          type: 'file',
          sessionId: 'live-1',
          sessionName: 'w1-alpha',
          timestamp: NOW,
          snippet: 'notes.md',
          exactMatch: false,
          jumpTo: { kind: 'file-preview', sessionId: 'live-1', relativePath: 'docs/notes.md' },
        },
      ],
    },
  ];

  it('flattens the typed groups into headers and rows', () => {
    const entries = buildSearchEntries(groups, (id) => id === 'live-1');
    expect(entries.map((entry) => entry.kind)).toEqual(['header', 'result', 'result', 'header', 'result']);
    expect(entries[0].text).toBe('SESSIONS');
    expect(entries[1]).toMatchObject({ text: 'w1-alpha', sessionId: 'live-1', live: true });
    // The snippet opens with the session name, which the row already shows.
    expect(entries[1].detail).toBe('/tmp/alpha');
    // A session that is not on the list cannot be selected into.
    expect(entries[2]).toMatchObject({ text: 'w9-old', live: false });
    expect(entries[4]).toMatchObject({ text: 'docs/notes.md', live: false });
  });

  it('drops an empty group instead of printing a header with nothing under it', () => {
    expect(buildSearchEntries([{ type: 'event', results: [] }], () => false)).toEqual([]);
  });

  it('starts on the first result and never lands on a header', () => {
    const entries = buildSearchEntries(groups, () => true);
    expect(firstSearchIndex(entries)).toBe(1);
    expect(moveSearchIndex(entries, 1, 1)).toBe(2);
    expect(moveSearchIndex(entries, 2, 1)).toBe(4);
    // Both ends stop rather than wrap: a result list is read, not cycled.
    expect(moveSearchIndex(entries, 4, 1)).toBe(4);
    expect(moveSearchIndex(entries, 1, -1)).toBe(1);
    expect(firstSearchIndex([])).toBe(-1);
  });
});
