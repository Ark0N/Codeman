// test/split-pane-auto-collapse-unit.test.ts
// Port: N/A (no server/browser — loaded via `vm`, like session-close-fallback.test.ts).
//
// Fast, CI-visible unit coverage for the `_onSessionDeleted` prototype patch in
// terminal-split.js (whole-branch review finding I6). The "Pane B ends" branch
// already has real-Chromium coverage in test/split-pane-auto-collapse.browser.test.ts,
// but that suite is excluded from `npm test` (see Testing in CLAUDE.md), and the
// "Pane A ends, Pane B gets promoted" branch had NO coverage anywhere — it is the
// one whose correctness depends on exact ordering: `_splitSessionId` must be
// captured BEFORE `closeSplitPane()` runs (which nulls it), or the promoted
// session id is lost. This file pins that ordering plus the sibling branches
// (Pane B ends, unrelated session ends) so a regression fails in the normal CI
// gate rather than only in the browser suite nobody runs by default.
//
// The same vm harness also pins two merge-time fixes from the final review of
// #453 that no browser test reaches: closeSplitPane() tearing down a divider
// drag that is still in progress (the body-level `split-pane-resizing` lock
// otherwise outlived the split), and openSplitPane() re-applying the picker's
// own exclusions for a row that went stale while the menu sat open.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A class-list stub backed by a Set, enough for add/remove/contains. */
function fakeClassList() {
  const classes = new Set<string>();
  return {
    add: (c: string) => void classes.add(c),
    remove: (c: string) => void classes.delete(c),
    contains: (c: string) => classes.has(c),
  };
}

/**
 * The only `document` surface the methods under test touch: `body.classList`
 * (the drag's cursor/selection lock) and `querySelector` (the split container
 * and the header button, both absent here, which is the "already collapsed /
 * no button rendered" path every early-return in closeSplitPane() takes).
 * `querySelector` is reassignable per test so a test can plant a sentinel.
 */
const fakeDocument = {
  body: { classList: fakeClassList() },
  querySelector: (_selector: string): unknown => null,
  getElementById: (_id: string): unknown => null,
};

const rafCalls: Array<() => void> = [];
const cancelledRafs: number[] = [];

function loadCodemanAppClass() {
  const dir = resolve(import.meta.dirname, '../src/web/public');
  const terminalSplitSrc = readFileSync(resolve(dir, 'terminal-split.js'), 'utf8');
  const context = vm.createContext({
    console: { ...console, log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    // innerWidth clears the desktop-only gate so openSplitPane() reaches the
    // exclusions under test; SPLIT_PANE_MIN_WIDTH is the bare global
    // constants.js would otherwise define.
    window: { innerWidth: 1600 },
    SPLIT_PANE_MIN_WIDTH: 1180,
    document: fakeDocument,
    requestAnimationFrame: (fn: () => void) => rafCalls.push(fn),
    cancelAnimationFrame: (id: number) => cancelledRafs.push(id),
  });
  // A minimal fake CodemanApp — terminal-split.js only needs `_onSessionDeleted`
  // and `selectSession` to already exist on the prototype (it wraps both), and
  // neither wrapped body executes at module-load time (only inside method
  // calls), so no xterm/WebSocket/CodemanSplitPane globals are needed here.
  const fakeAppSrc = `
    class CodemanApp {
      _onSessionDeleted(data) {
        (this.__originalDeletedCalls ??= []).push(data);
      }
      selectSession(id) {
        (this.__originalSelectSessionCalls ??= []).push(id);
      }
    }
  `;
  vm.runInContext(`${fakeAppSrc}\n${terminalSplitSrc}\nglobalThis.__CodemanApp = CodemanApp;`, context);
  return (context as { __CodemanApp: new () => unknown }).__CodemanApp as {
    prototype: {
      _onSessionDeleted: (this: unknown, data: { id: string }) => unknown;
      closeSplitPane: (this: unknown, options?: { skipPrimaryResize?: boolean }) => unknown;
      openSplitPane: (this: unknown, sessionId: string) => unknown;
      _installSplitDividerDrag: (this: unknown, divider: unknown, wrap: unknown, paneB: unknown) => unknown;
    };
  };
}

const CodemanApp = loadCodemanAppClass();

type TestApp = {
  activeSessionId: string | null;
  _splitSessionId: string | null;
  _splitPane: { destroy: ReturnType<typeof vi.fn> } | null;
  _closingSessions: Set<string>;
  closeSplitPane: ReturnType<typeof vi.fn>;
  selectSession: ReturnType<typeof vi.fn>;
  __originalDeletedCalls?: Array<{ id: string }>;
};

/** A split-active instance: Pane A === activeSessionId, Pane B === _splitSessionId. */
function makeSplitActiveApp(): TestApp {
  const app = Object.create((CodemanApp as { prototype: object }).prototype) as TestApp;
  app.activeSessionId = 'session-a';
  app._splitSessionId = 'session-b';
  app._splitPane = { destroy: vi.fn() };
  // Empty by default: the app's OWN closeSession() is not mid-await for this
  // delete, so the promotion below is expected to fire. See the dedicated
  // test further down for the non-empty (_closingSessions owns it) case.
  app._closingSessions = new Set();
  // closeSplitPane is mocked but mirrors the REAL implementation's one
  // observable side effect relevant here: it nulls _splitPane/_splitSessionId.
  // If the wrapper captured _splitSessionId AFTER calling closeSplitPane
  // instead of before, this would surface as selectSession(undefined) below.
  app.closeSplitPane = vi.fn(() => {
    app._splitPane = null;
    app._splitSessionId = null;
  });
  app.selectSession = vi.fn();
  return app;
}

describe('terminal-split.js _onSessionDeleted wrapper (I6)', () => {
  it('Pane A ends: closes the split and promotes Pane B via selectSession(ORIGINAL splitSessionId)', () => {
    const app = makeSplitActiveApp();

    CodemanApp.prototype._onSessionDeleted.call(app, { id: 'session-a' });

    expect(app.closeSplitPane).toHaveBeenCalledTimes(1);
    // activeSessionId is still the deleted id while the split collapses (the
    // original handler, called last, is what retires it), so the closing
    // resize must be skipped or it targets a session the server already
    // removed; selectSession() below sizes the promoted session itself.
    expect(app.closeSplitPane).toHaveBeenCalledWith({ skipPrimaryResize: true });
    // Pinned ordering: selectSession must receive the id _splitSessionId held
    // BEFORE closeSplitPane ran (which nulls it), not whatever it holds after.
    // { auto: true } because this is an app-driven promotion, not the user
    // clicking a tab — it must not spend the promoted session's idle alert.
    expect(app.selectSession).toHaveBeenCalledWith('session-b', { auto: true });
    expect(app.__originalDeletedCalls).toEqual([{ id: 'session-a' }]);
  });

  it('Pane B ends: closes the split without promoting anything', () => {
    const app = makeSplitActiveApp();

    CodemanApp.prototype._onSessionDeleted.call(app, { id: 'session-b' });

    expect(app.closeSplitPane).toHaveBeenCalledTimes(1);
    // Pane A's session is alive and stays active: the closing resize is
    // wanted here, so no skip option must be passed.
    expect(app.closeSplitPane).toHaveBeenCalledWith();
    expect(app.selectSession).not.toHaveBeenCalled();
    expect(app.__originalDeletedCalls).toEqual([{ id: 'session-b' }]);
  });

  it('an unrelated session ending leaves the split untouched', () => {
    const app = makeSplitActiveApp();

    CodemanApp.prototype._onSessionDeleted.call(app, { id: 'session-c' });

    expect(app.closeSplitPane).not.toHaveBeenCalled();
    expect(app.selectSession).not.toHaveBeenCalled();
    expect(app._splitPane).not.toBeNull();
    expect(app._splitSessionId).toBe('session-b');
    expect(app.__originalDeletedCalls).toEqual([{ id: 'session-c' }]);
  });

  it('the original _onSessionDeleted always fires, split-active or not', () => {
    const app = Object.create((CodemanApp as { prototype: object }).prototype) as TestApp;
    app.activeSessionId = 'session-a';
    app._splitSessionId = null;
    app._splitPane = null;
    app._closingSessions = new Set();
    app.closeSplitPane = vi.fn();
    app.selectSession = vi.fn();

    CodemanApp.prototype._onSessionDeleted.call(app, { id: 'session-a' });

    expect(app.closeSplitPane).not.toHaveBeenCalled();
    expect(app.selectSession).not.toHaveBeenCalled();
    expect(app.__originalDeletedCalls).toEqual([{ id: 'session-a' }]);
  });

  it('Pane A ends via the user closing its OWN tab: still collapses the split, but skips the promotion', () => {
    // closeSession() (app.js) adds the id to _closingSessions BEFORE awaiting
    // the delete, then owns the follow-up selection itself once it lands —
    // selecting Pane B's session here too would race it for which tab wins.
    const app = makeSplitActiveApp();
    app._closingSessions.add('session-a');

    CodemanApp.prototype._onSessionDeleted.call(app, { id: 'session-a' });

    expect(app.closeSplitPane).toHaveBeenCalledTimes(1);
    expect(app.selectSession).not.toHaveBeenCalled();
    expect(app.__originalDeletedCalls).toEqual([{ id: 'session-a' }]);
  });
});

// ── closeSplitPane() vs a divider drag in progress ──────────────────────────

type DragEl = ReturnType<typeof fakeElement>;

/** A DOM element stub: class list, a listener registry, pointer-capture spies. */
function fakeElement() {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  return {
    style: {} as Record<string, string>,
    classList: fakeClassList(),
    parentElement: null as unknown,
    listeners,
    addEventListener(type: string, fn: (e: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener(type: string, fn: (e: unknown) => void) {
      listeners.get(type)?.delete(fn);
    },
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  };
}

function listenerCount(el: DragEl, type: string): number {
  return el.listeners.get(type)?.size ?? 0;
}

type DragTestApp = TestApp & {
  _splitDividerDragTeardown?: (() => void) | null;
  sendResize: ReturnType<typeof vi.fn>;
};

describe('closeSplitPane() tears down a divider drag that is still in progress', () => {
  afterEach(() => {
    fakeDocument.querySelector = () => null;
    fakeDocument.body.classList.remove('split-pane-resizing');
  });

  /**
   * A split-active app with the REAL _installSplitDividerDrag() wired to stub
   * elements, then armed the way the browser arms it: a primary-button
   * pointerdown on the divider. `document.querySelector` hands closeSplitPane()
   * a stub container so it runs its full body (reparent, remove, resize) rather
   * than the already-collapsed early return.
   */
  function makeDraggingApp() {
    const app = Object.create((CodemanApp as { prototype: object }).prototype) as DragTestApp;
    app.activeSessionId = 'session-a';
    app._splitSessionId = 'session-b';
    app._splitPane = { destroy: vi.fn() };
    app._closingSessions = new Set();
    app.sendResize = vi.fn(() => Promise.resolve(true));
    const divider = fakeElement();
    const wrap = fakeElement();
    const paneB = fakeElement();
    const container = { querySelector: () => wrap, parentElement: { insertBefore: vi.fn() }, remove: vi.fn() };
    fakeDocument.querySelector = (selector: string) => (selector === '.terminal-split-container' ? container : null);

    CodemanApp.prototype._installSplitDividerDrag.call(app, divider, wrap, paneB);
    const [onDown] = divider.listeners.get('pointerdown')!;
    onDown({ button: 0, pointerId: 7, preventDefault: vi.fn() });
    return { app, divider, container };
  }

  it('precondition: pointerdown arms the page-wide resize lock, capture and the drag listeners', () => {
    const { divider } = makeDraggingApp();

    expect(fakeDocument.body.classList.contains('split-pane-resizing')).toBe(true);
    expect(divider.classList.contains('dragging')).toBe(true);
    expect(divider.setPointerCapture).toHaveBeenCalledWith(7);
    for (const type of ['pointermove', 'pointerup', 'pointercancel']) {
      expect(listenerCount(divider, type), type).toBe(1);
    }
  });

  it('clears body.split-pane-resizing, releases capture and drops the drag listeners', () => {
    const { app, divider, container } = makeDraggingApp();

    CodemanApp.prototype.closeSplitPane.call(app);

    // The lock is `cursor: col-resize; user-select: none` on EVERY element
    // (styles.css); left set, it outlives the split until a reload.
    expect(fakeDocument.body.classList.contains('split-pane-resizing')).toBe(false);
    expect(divider.classList.contains('dragging')).toBe(false);
    expect(divider.releasePointerCapture).toHaveBeenCalledWith(7);
    for (const type of ['pointermove', 'pointerup', 'pointercancel']) {
      expect(listenerCount(divider, type), type).toBe(0);
    }
    expect(app._splitDividerDragTeardown).toBeNull();
    expect(app._splitPane).toBeNull();
    expect(container.remove).toHaveBeenCalledTimes(1);
    // An ordinary close still resizes the (live) primary pane's session.
    expect(app.sendResize).toHaveBeenCalledWith('session-a', { force: true });
  });

  it('cancels a reflow frame the drag had queued', () => {
    const { app, divider } = makeDraggingApp();
    const [onMove] = divider.listeners.get('pointermove')!;
    onMove({ clientX: 400 });
    const queuedRafId = rafCalls.length;

    CodemanApp.prototype.closeSplitPane.call(app);

    expect(cancelledRafs).toContain(queuedRafId);
  });

  it('closeSplitPane({ skipPrimaryResize: true }) collapses without resizing the primary session', () => {
    const { app, container } = makeDraggingApp();

    CodemanApp.prototype.closeSplitPane.call(app, { skipPrimaryResize: true });

    expect(app.sendResize).not.toHaveBeenCalled();
    expect(app._splitPane).toBeNull();
    expect(container.remove).toHaveBeenCalledTimes(1);
    expect(fakeDocument.body.classList.contains('split-pane-resizing')).toBe(false);
  });
});

// ── openSplitPane() re-applies the picker's exclusions ──────────────────────

type OpenTestApp = TestApp & {
  activeWebviewId: string | null;
  sessions: Map<string, { pid: number | null; name?: string }>;
  detachedSessions: Set<string>;
};

describe('openSplitPane() re-applies the picker exclusions at open time', () => {
  // buildSplitPickerSessions() (constants.js) never lists a detached session
  // or one with `pid === null`, but the menu can sit open while a listed
  // session's CLI exits or gets popped out, and the row's click carries only
  // the id. openSplitPane() must refuse those the same way the picker would
  // have (silently, like its neighbouring gates) BEFORE touching the DOM.
  const DOM_REACHED = 'sentinel: openSplitPane reached the DOM stage';

  function makeApp(): OpenTestApp {
    const app = Object.create((CodemanApp as { prototype: object }).prototype) as OpenTestApp;
    app.activeSessionId = 'session-a';
    app.activeWebviewId = null;
    app._splitPane = null;
    app._splitSessionId = null;
    app._closingSessions = new Set();
    app.closeSplitPane = vi.fn();
    app.selectSession = vi.fn();
    app.sessions = new Map([
      ['session-a', { pid: 101, name: 'w1-active' }],
      ['session-exited', { pid: null, name: 'w2-exited' }],
      ['session-detached', { pid: 103, name: 'w3-detached' }],
      ['session-ok', { pid: 104, name: 'w4-ok' }],
    ]);
    app.detachedSessions = new Set(['session-detached']);
    return app;
  }

  beforeEach(() => {
    fakeDocument.querySelector = vi.fn(() => {
      throw new Error(DOM_REACHED);
    });
  });
  afterEach(() => {
    fakeDocument.querySelector = () => null;
  });

  it('control: a listed, attached session gets past every guard to the DOM stage', () => {
    const app = makeApp();
    expect(() => CodemanApp.prototype.openSplitPane.call(app, 'session-ok')).toThrow(DOM_REACHED);
    expect(fakeDocument.querySelector).toHaveBeenCalledWith('.terminal-wrap');
  });

  it('refuses a session whose CLI has exited (pid === null) without touching the DOM', () => {
    const app = makeApp();
    expect(CodemanApp.prototype.openSplitPane.call(app, 'session-exited')).toBeUndefined();
    expect(fakeDocument.querySelector).not.toHaveBeenCalled();
    expect(app._splitPane).toBeNull();
  });

  it('refuses a detached (popped-out) session', () => {
    const app = makeApp();
    expect(CodemanApp.prototype.openSplitPane.call(app, 'session-detached')).toBeUndefined();
    expect(fakeDocument.querySelector).not.toHaveBeenCalled();
    expect(app._splitPane).toBeNull();
  });

  it('refuses an id with no session record at all', () => {
    const app = makeApp();
    expect(CodemanApp.prototype.openSplitPane.call(app, 'session-ghost')).toBeUndefined();
    expect(fakeDocument.querySelector).not.toHaveBeenCalled();
    expect(app._splitPane).toBeNull();
  });

  it('a refusal leaves an already-open split alone', () => {
    const app = makeApp();
    app._splitPane = { destroy: vi.fn() };
    app._splitSessionId = 'session-ok';

    CodemanApp.prototype.openSplitPane.call(app, 'session-exited');

    expect(app.closeSplitPane).not.toHaveBeenCalled();
    expect(app._splitPane).not.toBeNull();
    expect(app._splitSessionId).toBe('session-ok');
  });
});
