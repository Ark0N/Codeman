/**
 * @fileoverview A `vm` harness for the tile grid (tile-grid.js) with the real
 * app around it: constants.js + app.js + terminal-ui.js + terminal-split.js +
 * tile-grid.js in one context, a small fake DOM (just what the grid touches) and a fake
 * TerminalTile that records what the grid asks of it.
 *
 * `makeGridApp()` returns an app instance with everything around the grid that
 * a test does not exercise stubbed as `vi.fn()`; a test overrides what it needs
 * (or deletes a stub to run the real method from the prototype).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { vi } from 'vitest';

/** Just enough DOM for tile-grid.js: elements with classes, children, styles and listeners. */
export class FakeEl {
  id = '';
  className = '';
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  children: FakeEl[] = [];
  parentElement: FakeEl | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, Array<(ev: unknown) => void>> = {};
  classList = {
    add: (...names: string[]) => names.forEach((n) => this._setClass(n, true)),
    remove: (...names: string[]) => names.forEach((n) => this._setClass(n, false)),
    toggle: (n: string, on?: boolean) => this._setClass(n, on ?? !this.classList.contains(n)),
    contains: (n: string) => this.className.split(/\s+/).includes(n),
  };
  _setClass(name: string, on: boolean) {
    const set = new Set(this.className.split(/\s+/).filter(Boolean));
    if (on) set.add(name);
    else set.delete(name);
    this.className = [...set].join(' ');
    return on;
  }
  append(...children: FakeEl[]) {
    for (const child of children) this.appendChild(child);
  }
  replaceWith(other: FakeEl) {
    const parent = this.parentElement;
    if (!parent) return;
    other.remove();
    const i = parent.children.indexOf(this);
    parent.children.splice(i, 1, other);
    other.parentElement = parent;
    this.parentElement = null;
  }
  title = '';
  hidden = false;
  disabled = false;
  checked = false;
  contains(other: FakeEl | null): boolean {
    for (let n: FakeEl | null = other; n; n = n.parentElement) if (n === this) return true;
    return false;
  }
  textContent = '';
  value = '';
  type = '';
  focus = vi.fn();
  select = vi.fn();
  setPointerCapture = vi.fn();
  releasePointerCapture = vi.fn();
  removeEventListener(type: string, fn: (ev: unknown) => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }
  appendChild(child: FakeEl) {
    child.remove();
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  insertBefore(child: FakeEl, ref: FakeEl | null) {
    child.remove();
    child.parentElement = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i === -1) this.children.push(child);
    else this.children.splice(i, 0, child);
    return child;
  }
  get nextSibling() {
    const siblings = this.parentElement?.children ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  remove() {
    if (!this.parentElement) return;
    const siblings = this.parentElement.children;
    const i = siblings.indexOf(this);
    if (i !== -1) siblings.splice(i, 1);
    this.parentElement = null;
  }
  setAttribute(k: string, v: string) {
    this.attrs[k] = v;
  }
  getAttribute(k: string) {
    return this.attrs[k] ?? null;
  }
  /** Per event type, whether each listener was registered for the capture phase. */
  captureFlags: Record<string, boolean[]> = {};
  addEventListener(type: string, fn: (ev: unknown) => void, opts?: boolean | { capture?: boolean }) {
    (this.listeners[type] ||= []).push(fn);
    (this.captureFlags[type] ||= []).push(opts === true || (typeof opts === 'object' && !!opts?.capture));
  }
  dispatch(type: string, ev: unknown = {}) {
    for (const fn of this.listeners[type] ?? []) fn(ev);
  }
  getBoundingClientRect() {
    return { width: 2400, height: 1200, top: 0, left: 0, right: 2400, bottom: 1200 };
  }
  /** `.class` selectors only: the first descendant carrying that class. */
  querySelector(sel: string): FakeEl | null {
    if (!sel.startsWith('.') || /[\s[>:]/.test(sel)) return null;
    const cls = sel.slice(1);
    for (const child of this.children) {
      if (child.classList.contains(cls)) return child;
      const deeper = child.querySelector(sel);
      if (deeper) return deeper;
    }
    return null;
  }
}

/** A TerminalTile stand-in: records what the grid asks of it. */
export class FakeTile {
  static all: FakeTile[] = [];
  _wsReady = false;
  _stoppedCode: number | null = null;
  _destroyed = false;
  fontSize: number | null;
  terminal = { focus: vi.fn(), options: { fontSize: 0 } as Record<string, unknown> };
  connect = vi.fn(async () => {});
  reconnectNow = vi.fn();
  fit = vi.fn();
  localFit = vi.fn();
  paneStarted = vi.fn();
  destroy = vi.fn(() => {
    this._destroyed = true;
  });
  onExit: ((code: number) => void) | null;
  constructor(
    public sessionId: string,
    public mountEl: FakeEl,
    public opts: Record<string, unknown>
  ) {
    this.fontSize = (opts.fontSize as number) ?? null;
    this.onExit = (opts.onExit as (code: number) => void) ?? null;
    FakeTile.all.push(this);
  }
}

export const main = new FakeEl();
main.className = 'main';
const wrap = new FakeEl();
wrap.className = 'terminal-wrap';
main.appendChild(wrap);
export const section = new FakeEl();
section.id = 'tileGrid';
section.className = 'tile-grid';
main.appendChild(section);

/** Extra elements `document.querySelector` finds, by exact selector (e.g. '.btn-split'). */
export const bySelector = new Map<string, FakeEl>();
export const body = new FakeEl();
/** The context's `fetch`; a test sets what it answers. */
export const fetchSpy = vi.fn(async (..._args: unknown[]) => ({ ok: true, json: async () => ({}) }));
/** `document.addEventListener`, so a test can find a listener the app installed. */
export const documentAddEventListener = vi.fn();
export const documentRemoveEventListener = vi.fn();
export const localStore = new Map<string, string>();
/** The clock behind `performance.now` inside the context; tests move it with advanceClock(). */
let clock = 100_000;
export function advanceClock(ms: number) {
  clock += ms;
}
export const clockNow = () => clock;
/** Every callback the code under test handed a PerformanceObserver, newest last. */
export const perfObserverCallbacks: Array<(list: { getEntries(): unknown[] }) => void> = [];
/** Animation-frame callbacks the code under test queued (id = index + 1); a test runs them. */
export const rafCallbacks: Array<() => void> = [];
/** What the code under test deferred with requestIdleCallback; a test runs them. */
export const idleCallbacks: Array<() => void> = [];
export const windowStub: Record<string, unknown> = {
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
  CodemanBase: { base: '' },
  innerWidth: 2400,
  innerHeight: 1200,
};

const read = (f: string) => readFileSync(resolve(import.meta.dirname, `../../src/web/public/${f}`), 'utf8');
const context = vm.createContext({
  console: { ...console, log: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  performance: { now: () => clock },
  PerformanceObserver: class {
    constructor(cb: (list: { getEntries(): unknown[] }) => void) {
      perfObserverCallbacks.push(cb);
    }
    observe() {}
    disconnect() {}
  },
  setInterval: vi.fn(),
  clearInterval: vi.fn(),
  setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
  clearTimeout: (id: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id),
  requestAnimationFrame: (cb: () => void) => rafCallbacks.push(cb),
  cancelAnimationFrame: (id: number) => {
    if (id > 0) rafCallbacks[id - 1] = () => {};
  },
  requestIdleCallback: (cb: () => void) => idleCallbacks.push(cb),
  HTMLCanvasElement: class HTMLCanvasElement {},
  WebSocket: { OPEN: 1 },
  fetch: (...args: unknown[]) => fetchSpy(...args),
  navigator: { onLine: true },
  location: { protocol: 'http:', host: 'codeman.test', pathname: '/', search: '', hash: '' },
  history: { replaceState: vi.fn(), state: null },
  document: {
    addEventListener: documentAddEventListener,
    removeEventListener: documentRemoveEventListener,
    documentElement: { dataset: {} },
    createElement: () => new FakeEl(),
    getElementById: (id: string) => (id === 'tileGrid' ? section : (bySelector.get(`#${id}`) ?? null)),
    body,
    querySelector: (sel: string) =>
      bySelector.get(sel) ?? (sel === '.main' ? main : sel === '.terminal-wrap' ? wrap : null),
    querySelectorAll: () => [],
  },
  localStorage: {
    getItem: (k: string) => localStore.get(k) ?? null,
    setItem: (k: string, v: string) => localStore.set(k, String(v)),
    removeItem: (k: string) => localStore.delete(k),
  },
  window: windowStub,
  VoiceInput: { cleanup: vi.fn() },
  MobileDetection: { isTouchDevice: () => false, isHandheldDevice: () => false, getDeviceType: () => 'desktop' },
});
vm.runInContext(
  `${read('constants.js')}\n${read('app.js')}\n${read('terminal-ui.js')}\n${read('terminal-split.js')}\n` +
    `${read('tile-grid.js')}\n` +
    'globalThis.__CodemanApp = CodemanApp;',
  context
);
windowStub.TerminalTile = FakeTile;
windowStub.TileLoadQueue = class {
  schedule(_t: unknown, _k: string, run: () => Promise<void>) {
    return run();
  }
  drop() {}
};

export const CodemanApp = (context as unknown as { __CodemanApp: { prototype: Record<string, unknown> } }).__CodemanApp;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type GridApp = Record<string, any>;

/** Stubbed around the grid: panels, tabs, the main terminal's own select path. */
const STUBS = [
  '_cleanupPreviousSession',
  'hideWelcome',
  'showWelcome',
  'markIdleAlertSeen',
  'renderSessionTabs',
  'renderRalphStatePanel',
  'renderProjectInsightsPanel',
  '_updateActiveTabImmediate',
  '_refreshSessionPanels',
  '_updateSseSubscription',
  '_updateConnectionIndicator',
  '_activateFileBrowserSession',
  '_hideWebviewLayer',
  'closeSessionSidebarOnHandheld',
  'updateAttachmentHistoryBadge',
  'refreshHostWakeBanner',
  '_connectWs',
  'sendResize',
  'showToast',
  '_cleanupSessionData',
  'stopSystemStatsPolling',
];

/**
 * An app with sessions `ids` plus one more (`s-other`, FIRST in sessionOrder and
 * never tiled), `s-a` active, nothing open.
 */
export function makeGridApp(ids: string[] = ['s-a', 's-b', 's-c']): GridApp {
  const app = Object.create(CodemanApp.prototype) as GridApp;
  app.sessions = new Map(
    [...ids, 's-other'].map((id) => [id, { id, name: id, mode: 'claude', pid: 1, workingDir: '/w' }])
  );
  app.sessionOrder = ['s-other', ...ids];
  app.detachedSessions = new Set();
  app.isSoloWindow = false;
  app.activeSessionId = ids[0];
  app._selectGeneration = 0;
  app._xtermSnapshots = new Map();
  app.terminalBufferCache = new Map();
  app._pendingDeliveries = new Map();
  app._closingSessions = new Set();
  app.pendingHooks = new Map();
  app.terminal = { writeln: vi.fn(), clear: vi.fn(), focus: vi.fn(), options: { fontSize: 14 } };
  for (const name of STUBS) app[name] = vi.fn();
  app.loadAppSettingsFromStorage = () => ({});
  return app;
}

/** Resets the shared fake DOM and tile registry between tests. */
export function resetGridHarness() {
  FakeTile.all = [];
  idleCallbacks.length = 0;
  rafCallbacks.length = 0;
  localStore.clear();
  windowStub.innerWidth = 2400;
  section.children = [];
  main.className = 'main';
  // A split a test left open moved .terminal-wrap into its container.
  main.children = [];
  main.appendChild(wrap);
  main.appendChild(section);
  bySelector.clear();
  body.children = [];
}
