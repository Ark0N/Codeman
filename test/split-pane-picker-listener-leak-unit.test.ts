// test/split-pane-picker-listener-leak-unit.test.ts
// Port: N/A (no server/browser — loaded via `vm`, like split-pane-auto-collapse-unit.test.ts).
//
// Fast, CI-visible regression coverage for a listener leak in `openSplitPicker()` /
// `_dismissSplitPicker()` (terminal-split.js): repeatedly opening the split picker
// (e.g. clicking the `.btn-split` button, whose real clicks land on its inner
// <svg>) used to leave a `click`/`keydown` listener pair attached to `document`
// on every cycle, because a pre-existing menu was torn down with a raw
// `existing.remove()` instead of through `_dismissSplitPicker()`, and the
// single-slot `_splitPickerDismissHandlers` field was overwritten rather than
// used to clean up the previous pair first.
//
// This is a `vm`-driven DOM-listener-count assertion rather than a real-browser
// interaction test (`test/split-pane-orchestration.browser.test.ts` already
// covers the real click-through-svg interaction and is excluded from `npm test`
// per CLAUDE.md's Testing section) — it exercises the exact document
// addEventListener/removeEventListener calls the fix and the bug both hinge on,
// with no xterm/WebSocket/tmux involved.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A tiny fake DOM element: enough surface for createElement/appendChild/contains/remove/closest. */
function makeFakeElement(tag: string) {
  const children: Array<ReturnType<typeof makeFakeElement>> = [];
  let id: string | undefined;
  let parent: ReturnType<typeof makeFakeElement> | null = null;
  const el = {
    tag,
    style: {} as Record<string, string>,
    innerHTML: '',
    className: '',
    get id() {
      return id;
    },
    set id(v: string | undefined) {
      id = v;
    },
    appendChild(child: ReturnType<typeof makeFakeElement>) {
      children.push(child);
      (child as { _parent: unknown })._parent = el;
      return child;
    },
    contains(target: unknown): boolean {
      if (target === el) return true;
      return children.some((c) => c.contains(target));
    },
    // Real Element.closest(): walk up from THIS element (inclusive), matching
    // a bare class selector like `.btn-split` against a space-separated
    // className — enough to exercise the fix's `e.target.closest('.btn-split')`
    // check without a real DOM.
    closest(selector: string): ReturnType<typeof makeFakeElement> | null {
      const cls = selector.replace(/^\./, '');
      let node: ReturnType<typeof makeFakeElement> | null = el;
      while (node) {
        if (node.className.split(/\s+/).includes(cls)) return node;
        node = (node as unknown as { __parent: ReturnType<typeof makeFakeElement> | null }).__parent;
      }
      return null;
    },
    remove() {
      if (parent) {
        parent = null;
      }
    },
    getBoundingClientRect() {
      return { bottom: 0, right: 0, left: 0, top: 0, width: 0, height: 0 };
    },
    set _parent(p: ReturnType<typeof makeFakeElement>) {
      parent = p;
      (el as unknown as { __parent: ReturnType<typeof makeFakeElement> }).__parent = p;
    },
  };
  return el;
}

/** A minimal `document` mock tracking real addEventListener/removeEventListener identity. */
function makeFakeDocument() {
  const elementsById = new Map<string, ReturnType<typeof makeFakeElement>>();
  const listeners: Record<string, Array<(...args: unknown[]) => unknown>> = {
    click: [],
    keydown: [],
  };

  return {
    createElement(tag: string) {
      return makeFakeElement(tag);
    },
    body: {
      appendChild(el: ReturnType<typeof makeFakeElement>) {
        if (el.id) elementsById.set(el.id, el);
      },
    },
    getElementById(id: string) {
      const el = elementsById.get(id);
      if (el) {
        // Support the real `?.remove()` call site removing it from the registry.
        const originalRemove = el.remove.bind(el);
        el.remove = () => {
          elementsById.delete(id);
          originalRemove();
        };
      }
      return el;
    },
    querySelector(sel: string) {
      return sel === '.btn-split' ? makeFakeElement('button') : null;
    },
    addEventListener(type: string, fn: (...args: unknown[]) => unknown) {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener(type: string, fn: (...args: unknown[]) => unknown) {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
    __listenerCount(type: string) {
      return (listeners[type] ?? []).length;
    },
    // Test-only helpers: fire a snapshot of the currently-registered
    // listeners (a handler removing itself mid-dispatch must not skip or
    // double-invoke a sibling — snapshotting avoids that ambiguity here).
    __dispatchClick(target: unknown) {
      for (const fn of [...(listeners.click ?? [])]) fn({ target });
    },
    __dispatchKeydown(key: string) {
      for (const fn of [...(listeners.keydown ?? [])]) fn({ key });
    },
  };
}

function loadCodemanAppClass(documentMock: ReturnType<typeof makeFakeDocument>) {
  const dir = resolve(import.meta.dirname, '../src/web/public');
  const terminalSplitSrc = readFileSync(resolve(dir, 'terminal-split.js'), 'utf8');
  const context = vm.createContext({
    console: { ...console, log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    window: { innerWidth: 1024 },
    document: documentMock,
    setTimeout,
    // terminal-split.js's picker markup calls the global `escapeHtml()` helper
    // (defined in constants.js at runtime); a plain identity stub is enough
    // here since no candidate labels/ids in this test contain HTML.
    escapeHtml: (s: unknown) => String(s),
  });
  const fakeAppSrc = `
    class CodemanApp {
      constructor() {
        this.sessions = new Map();
        this.sessionOrder = [];
        this.activeSessionId = 'active-session';
        this._splitPane = null;
      }
    }
  `;
  vm.runInContext(
    `${fakeAppSrc}\nwindow.CodemanSplitPane = { buildSplitPickerSessions: () => [] };\n${terminalSplitSrc}\nglobalThis.__CodemanApp = CodemanApp;`,
    context
  );
  return (
    context as { __CodemanApp: new () => { openSplitPicker: (e?: unknown) => void; _dismissSplitPicker: () => void } }
  ).__CodemanApp;
}

describe('terminal-split.js split-picker document-listener leak (repeated open/close)', () => {
  let documentMock: ReturnType<typeof makeFakeDocument>;
  let CodemanApp: ReturnType<typeof loadCodemanAppClass>;

  beforeEach(() => {
    vi.useFakeTimers();
    documentMock = makeFakeDocument();
    CodemanApp = loadCodemanAppClass(documentMock);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not grow document click/keydown listeners across repeated open cycles with no dismissal', () => {
    const app = new CodemanApp();

    // Simulates the real failure sequence: the button's onclick re-fires
    // `openSplitPicker()` on every click (e.g. landing on the button's inner
    // <svg>) without an intervening outside click or Escape ever resolving.
    for (let i = 0; i < 5; i++) {
      app.openSplitPicker();
      vi.runAllTimers(); // flush the deferred `setTimeout(() => addEventListener('click', ...))`
    }

    // Exactly one pair should be live — the CURRENT menu's — never one per cycle.
    expect(documentMock.__listenerCount('click')).toBe(1);
    expect(documentMock.__listenerCount('keydown')).toBe(1);
  });

  it('drops to zero listeners after the outside-click handler fires', () => {
    const app = new CodemanApp();
    app.openSplitPicker();
    vi.runAllTimers();
    expect(documentMock.__listenerCount('click')).toBe(1);

    app._dismissSplitPicker();

    expect(documentMock.__listenerCount('click')).toBe(0);
    expect(documentMock.__listenerCount('keydown')).toBe(0);
  });

  it('never accumulates listeners across many open→dismiss cycles', () => {
    const app = new CodemanApp();

    for (let i = 0; i < 20; i++) {
      app.openSplitPicker();
      vi.runAllTimers();
      app._dismissSplitPicker();
    }

    expect(documentMock.__listenerCount('click')).toBe(0);
    expect(documentMock.__listenerCount('keydown')).toBe(0);
  });

  it("does not dismiss when the click lands on the split button's own inner icon (closest() match, not exact-node equality)", () => {
    const app = new CodemanApp();
    app.openSplitPicker();
    vi.runAllTimers();
    expect(documentMock.__listenerCount('click')).toBe(1);

    // Mirrors the real DOM: the button carries the onclick and the
    // `.btn-split` class, but the actual click target is its inner <svg>.
    // The old `e.target !== splitBtn` check matched this (target !== button)
    // and dismissed the menu the same click had just (re)opened.
    const button = makeFakeElement('button');
    button.className = 'btn-split';
    const svg = button.appendChild(makeFakeElement('svg'));

    documentMock.__dispatchClick(svg);

    expect(documentMock.__listenerCount('click')).toBe(1);
    expect(documentMock.__listenerCount('keydown')).toBe(1);
  });

  it('dismisses and removes both listeners by identity when a genuine outside click fires', () => {
    const app = new CodemanApp();
    app.openSplitPicker();
    vi.runAllTimers();
    expect(documentMock.__listenerCount('click')).toBe(1);

    const outside = makeFakeElement('div');
    documentMock.__dispatchClick(outside);

    expect(documentMock.__listenerCount('click')).toBe(0);
    expect(documentMock.__listenerCount('keydown')).toBe(0);
  });

  it('dismisses and removes both listeners by identity when Escape fires', () => {
    const app = new CodemanApp();
    app.openSplitPicker();
    vi.runAllTimers();
    expect(documentMock.__listenerCount('keydown')).toBe(1);

    documentMock.__dispatchKeydown('Escape');

    expect(documentMock.__listenerCount('click')).toBe(0);
    expect(documentMock.__listenerCount('keydown')).toBe(0);
  });
});
