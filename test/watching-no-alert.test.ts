// Port: none (pure classifiers + vm-loaded frontend modules — no browser, no server).
//
// The point of the watching signal is an alert that does NOT fire, so the test that
// matters is the negative one. A session that ended its turn because it armed a monitor
// or backgrounded a shell gets an idle prompt from Claude Code about a minute later, and
// that prompt must reach every surface as a card nobody has to look at rather than as an
// alert. The same session holding a permission dialog must still go red everywhere.
//
// Each surface is exercised through the code it really runs: the TUI classifier, the
// live SSE handler in settings-ui.js, the reload seed in approvals-ui.js, and the state
// classifier both home screens share.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, beforeEach } from 'vitest';
import { ApprovalInbox, type ApprovalItem } from '../src/web/approval-inbox.js';
import { buildRows, groupSessions } from '../src/tui/tui-model.js';
import type { TuiSessionRow } from '../src/tui/tui-types.js';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const SESSION = 'watcher-session';

/** A live unified row for the session under test, quiet at its composer. */
function row(overrides: Partial<TuiSessionRow> = {}): TuiSessionRow {
  return {
    sessionId: SESSION,
    sources: ['live'],
    name: 'watch-probe',
    mode: 'claude',
    status: 'idle',
    workingDir: '/home/dev/case',
    createdAt: 1_000,
    lastActivityAt: 2_000,
    ...overrides,
  };
}

/**
 * The item the server really produces for this case, built by the real inbox rather
 * than by hand, so a change to how `watching` is honoured breaks this file too.
 */
function itemFor(watching: string | null): ApprovalItem {
  const inbox = new ApprovalInbox();
  const item = inbox.notePrompt({ sessionId: SESSION, sessionName: 'watch-probe', kind: 'idle', watching });
  inbox.stop();
  return item;
}

/** Minimal fake DOM node, enough for the handlers these tests drive. */
function fakeElement(): Record<string, unknown> {
  const el: Record<string, unknown> = {
    className: '',
    textContent: '',
    title: '',
    dataset: {},
    style: {},
    children: [] as unknown[],
    hidden: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild(child: unknown) {
      (el.children as unknown[]).push(child);
      return child;
    },
  };
  return el;
}

interface FrontendApp {
  pendingHooks: Map<string, Set<string>>;
  notifications: string[];
  approvals: Map<string, ApprovalItem>;
  seeded: ApprovalItem[];
  setPendingHook(sessionId: string, hook: string): void;
  clearPendingHooks(sessionId: string, hook?: string): void;
  _onHookIdlePrompt(data: Record<string, unknown>): void;
  _onHookPermissionPrompt(data: Record<string, unknown>): void;
  seedApprovals(): Promise<void>;
  _mobileOverviewState(session: Record<string, unknown>, hooks?: Set<string>): string;
}

/**
 * The three frontend modules that decide whether a prompt becomes an alert, loaded into
 * one context the way the page loads them. Everything they call that belongs to app.js
 * is stubbed to record rather than to render.
 */
function loadFrontend(seed: ApprovalItem[] = []): FrontendApp {
  const CodemanApp = function CodemanApp(this: unknown) {} as unknown as { prototype: Record<string, unknown> };
  const context = vm.createContext({
    CodemanApp,
    console,
    window: {},
    CSS: { escape: (s: string) => s },
    document: {
      documentElement: { getAttribute: () => null, dataset: {} },
      getElementById: () => null,
      querySelector: () => null,
      createElement: () => fakeElement(),
      createElementNS: () => fakeElement(),
    },
    MobileDetection: { getDeviceType: () => 'desktop' },
  });
  for (const file of ['constants.js', 'mobile-overview.js', 'approvals-ui.js', 'settings-ui.js']) {
    vm.runInContext(readFileSync(resolve(PUBLIC, file), 'utf8'), context, { filename: file });
  }

  const app = Object.create(CodemanApp.prototype) as FrontendApp & Record<string, unknown>;
  app.pendingHooks = new Map();
  app.notifications = [];
  app.approvals = new Map();
  app.seeded = seed;
  app.setPendingHook = (sessionId: string, hook: string) => {
    if (!app.pendingHooks.has(sessionId)) app.pendingHooks.set(sessionId, new Set());
    app.pendingHooks.get(sessionId)!.add(hook);
  };
  app.clearPendingHooks = (sessionId: string, hook?: string) => {
    if (!hook) app.pendingHooks.delete(sessionId);
    else app.pendingHooks.get(sessionId)?.delete(hook);
  };
  Object.assign(app, {
    _notifySession: (_id: string, _level: string, kind: string) => app.notifications.push(kind),
    _apiJson: async () => ({ approvals: app.seeded }),
    approvalsInboxEnabled: () => true,
    renderApprovals: () => {},
    renderSessionTabs: () => {},
    loadAppSettingsFromStorage: () => ({}),
  });
  return app;
}

describe('a watching session raises no alert on any surface', () => {
  const watched = itemFor('1 monitor');

  it('the store opens the prompt acknowledged, which is what every surface reads', () => {
    expect(watched.acknowledgedAt).toEqual(expect.any(Number));
    expect(watched.acknowledgedReason).toBe('watching 1 monitor');
  });

  it('codeman tui leaves the row out of NEEDS YOU', () => {
    const groups = groupSessions(buildRows([row()], new Map([[SESSION, watched]])));
    const needsYou = groups.find((group) => group.key === 'needs-you')!;
    expect(needsYou.rows).toEqual([]);
  });

  it('a live page declines to arm the tab alert and raises no desktop notification', () => {
    const app = loadFrontend();
    app._onHookIdlePrompt({ sessionId: SESSION, acknowledgedReason: watched.acknowledgedReason });
    expect(app.pendingHooks.get(SESSION)).toBeUndefined();
    expect(app.notifications).toEqual([]);
  });

  it('a reloading page does not arm it either', async () => {
    const app = loadFrontend([watched]);
    await app.seedApprovals();
    expect(app.pendingHooks.get(SESSION)).toBeUndefined();
    // The card itself is still there to answer, which is the whole point of
    // acknowledging the prompt rather than never creating it.
    expect(app.approvals.get(watched.id)?.acknowledgedReason).toBe('watching 1 monitor');
  });

  it('the header bell does not count the card, matching codeman tui', () => {
    const app = loadFrontend() as FrontendApp & { pendingApprovalsCount(): number };
    app.approvals.set('watched', watched);
    app.approvals.set('plain', itemFor(null));
    expect(app.pendingApprovalsCount()).toBe(1);
  });

  it('so both home screens classify the session as plainly idle', () => {
    const app = loadFrontend();
    app._onHookIdlePrompt({ sessionId: SESSION, acknowledgedReason: watched.acknowledgedReason });
    const state = app._mobileOverviewState({ status: 'idle' }, app.pendingHooks.get(SESSION));
    expect(state).toBe('idle');
  });
});

describe('an ordinary idle prompt still alerts everywhere', () => {
  const plain = itemFor(null);

  it('the store leaves it unacknowledged', () => {
    expect(plain.acknowledgedAt).toBeUndefined();
  });

  it('codeman tui puts the row in NEEDS YOU', () => {
    const groups = groupSessions(buildRows([row()], new Map([[SESSION, plain]])));
    expect(groups[0].rows.map((r) => r.session.sessionId)).toEqual([SESSION]);
  });

  it('a live page arms the tab alert and notifies', () => {
    const app = loadFrontend();
    app._onHookIdlePrompt({ sessionId: SESSION, message: 'Claude is waiting for your input' });
    expect([...(app.pendingHooks.get(SESSION) ?? [])]).toEqual(['idle_prompt']);
    expect(app.notifications).toEqual(['hook-idle']);
  });

  it('a reloading page arms it from the seed', async () => {
    const app = loadFrontend([plain]);
    await app.seedApprovals();
    expect([...(app.pendingHooks.get(SESSION) ?? [])]).toEqual(['idle_prompt']);
  });

  it('so both home screens put the session in NEEDS YOU', () => {
    const app = loadFrontend();
    app._onHookIdlePrompt({ sessionId: SESSION });
    expect(app._mobileOverviewState({ status: 'idle' }, app.pendingHooks.get(SESSION))).toBe('waiting');
  });
});

describe('a dialog blocking the agent alerts even while it watches', () => {
  it('a live page arms and notifies whatever else the session started', () => {
    // A permission prompt never opens acknowledged (the inbox gates on kind), so the
    // handler never sees a reason and this is the ordinary path. Pinned because the two
    // handlers sit side by side and the guard belongs on exactly one of them.
    const app = loadFrontend();
    app._onHookPermissionPrompt({ sessionId: SESSION, tool: 'Bash' });
    expect([...(app.pendingHooks.get(SESSION) ?? [])]).toEqual(['permission_prompt']);
    expect(app.notifications).toEqual(['hook-permission']);
  });

  it('codeman tui shows it as blocked', () => {
    const inbox = new ApprovalInbox();
    const item = inbox.notePrompt({
      sessionId: SESSION,
      sessionName: 'watch-probe',
      kind: 'permission',
      watching: '1 monitor',
    });
    inbox.stop();
    const [built] = buildRows([row()], new Map([[SESSION, item]]));
    expect(built.state).toBe('blocked-permission');
  });
});
