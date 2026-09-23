/**
 * @fileoverview File Viewer server-side search (COD-341).
 *
 * The browser module is loaded as the real CodemanApp mixin in a VM. The fake
 * DOM intentionally implements only the element contract used by the File
 * Viewer, while fetch responses and timers remain controllable so races can be
 * exercised without jsdom.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const appJs = readFileSync(resolve(PUBLIC, 'app.js'), 'utf8');
const constantsJs = readFileSync(resolve(PUBLIC, 'constants.js'), 'utf8');
const panelsJs = readFileSync(resolve(PUBLIC, 'panels-ui.js'), 'utf8');
const settingsJs = readFileSync(resolve(PUBLIC, 'settings-ui.js'), 'utf8');

type ClickHandler = () => void;

interface FakeClassList {
  add: (...names: string[]) => void;
  remove: (...names: string[]) => void;
  contains: (name: string) => boolean;
  toggle: (name: string, force?: boolean) => boolean;
}

interface FakeRow {
  dataset: Record<string, string>;
  addEventListener: (type: string, handler: ClickHandler) => void;
  click: () => void;
}

interface FakeElement {
  innerHTML: string;
  textContent: string;
  value: string;
  disabled: boolean;
  style: Record<string, string>;
  attrs: Record<string, string>;
  classList: FakeClassList;
  setAttribute: (name: string, value: string) => void;
  querySelector: (selector: string) => FakeElement | null;
  querySelectorAll: (selector: string) => FakeRow[];
}

function decodeHtml(value: string): string {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&#039;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fakeElement(initialClasses: string[] = []): FakeElement {
  const classes = new Set(initialClasses);
  const attrs: Record<string, string> = {};
  const rows: FakeRow[] = [];
  let html = '';

  const classList: FakeClassList = {
    add: (...names) => names.forEach((name) => classes.add(name)),
    remove: (...names) => names.forEach((name) => classes.delete(name)),
    contains: (name) => classes.has(name),
    toggle(name, force) {
      const on = force === undefined ? !classes.has(name) : force;
      if (on) classes.add(name);
      else classes.delete(name);
      return on;
    },
  };

  return {
    get innerHTML() {
      return html;
    },
    set innerHTML(value: string) {
      html = value;
      rows.length = 0;
      const rowPattern = /<div class="file-tree-item[^"]*"([^>]*)>/g;
      for (const match of value.matchAll(rowPattern)) {
        const attributes = match[1];
        const dataset: Record<string, string> = {};
        for (const attr of attributes.matchAll(/data-([a-z-]+)="([^"]*)"/g)) {
          const key = attr[1].replace(/-([a-z])/g, (_whole, letter: string) => letter.toUpperCase());
          dataset[key] = decodeHtml(attr[2]);
        }
        let clickHandler: ClickHandler | null = null;
        rows.push({
          dataset,
          addEventListener(type, handler) {
            if (type === 'click') clickHandler = handler;
          },
          click() {
            clickHandler?.();
          },
        });
      }
    },
    textContent: '',
    value: '',
    disabled: false,
    style: {},
    attrs,
    classList,
    setAttribute(name, value) {
      attrs[name] = value;
    },
    querySelector() {
      return null;
    },
    querySelectorAll(selector) {
      return selector === '.file-tree-item' ? rows : [];
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function response(body: unknown, ok = true): FakeResponse {
  return { ok, status: ok ? 200 : 500, json: async () => body };
}

function loadPanel(options: { sessionId?: string | null; showHidden?: boolean } = {}) {
  const CodemanApp = function CodemanApp(this: unknown) {} as unknown as new () => Record<string, unknown>;
  const elements: Record<string, FakeElement> = {
    fileBrowserPanel: fakeElement(['visible']),
    fileBrowserTree: fakeElement(),
    fileBrowserStatus: fakeElement(),
    fileBrowserSearch: fakeElement(),
    fileBrowserExpandBtn: fakeElement(),
    fileBrowserHiddenBtn: fakeElement(),
  };
  const pending: Array<{ url: string; reply: ReturnType<typeof deferred<FakeResponse>> }> = [];
  const context = vm.createContext({
    CodemanApp,
    console,
    escapeHtml,
    // Reverse-proxy route builder from constants.js (not loaded here); identity at root.
    CodemanBase: { base: '', url: (p: string) => p },
    localStorage: { getItem: () => null, setItem: vi.fn() },
    document: {
      getElementById: (id: string) => elements[id] ?? null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      querySelector: vi.fn(),
    },
    window: { addEventListener: vi.fn() },
    setTimeout,
    clearTimeout,
    fetch: (url: string) => {
      const reply = deferred<FakeResponse>();
      pending.push({ url, reply });
      return reply.promise;
    },
  });
  vm.runInContext(settingsJs, context, { filename: 'settings-ui.js' });
  vm.runInContext(panelsJs, context, { filename: 'panels-ui.js' });

  const app = new CodemanApp() as Record<string, any>;
  app.$ = (id: string) => elements[id] ?? null;
  app.activeSessionId = options.sessionId === undefined ? 'session/A' : options.sessionId;
  app.fileBrowserData = null;
  app.fileBrowserExpandedDirs = new Set<string>();
  app.fileBrowserFilter = '';
  app.fileBrowserAllExpanded = false;
  app.fileBrowserShowHidden = options.showHidden ?? false;
  app.openFilePreview = vi.fn();
  app.showToast = vi.fn();
  app.loadAppSettingsFromStorage = () => ({ showFileBrowser: false });
  app.getDefaultSettings = () => ({});
  app.saveAppSettingsToStorage = vi.fn();

  return { app, elements, pending };
}

function loadRealSelectSessionHarness(options: { terminalFailure?: boolean } = {}) {
  const elements: Record<string, FakeElement> = {
    fileBrowserPanel: fakeElement(['visible']),
    fileBrowserTree: fakeElement(),
    fileBrowserStatus: fakeElement(),
    fileBrowserSearch: fakeElement(),
    fileBrowserExpandBtn: fakeElement(),
    fileBrowserHiddenBtn: fakeElement(),
  };
  const filePending: Array<{ url: string; reply: ReturnType<typeof deferred<FakeResponse>> }> = [];
  const idleCallbacks: Array<() => void> = [];
  const context = vm.createContext({
    console: { ...console, log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    performance,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    setTimeout,
    clearTimeout,
    requestAnimationFrame: vi.fn(),
    requestIdleCallback: (callback: () => void) => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    },
    HTMLCanvasElement: class HTMLCanvasElement {},
    WebSocket: { OPEN: 1 },
    // Reverse-proxy route builder from constants.js (not loaded here); identity at root.
    CodemanBase: { base: '', url: (p: string) => p },
    MobileDetection: { isTouchDevice: () => false },
    localStorage: { length: 0, key: vi.fn(), getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
    document: {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      getElementById: (id: string) => elements[id] ?? null,
      querySelector: vi.fn(() => null),
    },
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    fetch: (url: string) => {
      if (url.includes('/files?')) {
        const reply = deferred<FakeResponse>();
        filePending.push({ url, reply });
        return reply.promise;
      }
      if (url.includes('/terminal?')) {
        if (options.terminalFailure) return Promise.reject(new Error('terminal replay failed'));
        return Promise.resolve({
          ok: true,
          headers: { get: () => '' },
          json: async () => ({ data: { terminalBuffer: '', truncated: false, source: 'test' } }),
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    },
  });
  vm.runInContext(`${constantsJs}\n${appJs}\n${panelsJs}\nglobalThis.__CodemanApp = CodemanApp;`, context);

  const CodemanApp = (context as { __CodemanApp: new () => unknown }).__CodemanApp;
  const app = Object.create(CodemanApp.prototype) as Record<string, any>;
  const terminalBoundary = deferred<boolean>();
  let resizeCalls = 0;
  app.activeSessionId = 'session/A';
  app.detachedSessions = new Set();
  app.isSoloWindow = false;
  app._selectGeneration = 0;
  app.sessions = new Map([
    ['session/B', { id: 'session/B', name: 'B', pid: 1, status: 'idle', mode: 'shell', workingDir: '/tmp/B' }],
  ]);
  app.fileBrowserData = successfulTree('old-A.ts').data;
  app.fileBrowserExpandedDirs = new Set<string>();
  app.fileBrowserFilter = '';
  app.fileBrowserAllExpanded = false;
  app.fileBrowserShowHidden = false;
  app.fileBrowserDragListeners = null;
  app.$ = (id: string) => elements[id] ?? null;
  app._shouldFocusTerminalForTabSwitch = () => false;
  app._setTerminalLoadState = vi.fn();
  app._clearTerminalLoadState = vi.fn();
  app._cleanupPreviousSession = vi.fn();
  app._renderHistoryTruncationBanner = vi.fn();
  app._updateSseSubscription = vi.fn();
  app.hideWelcome = vi.fn();
  app.markIdleAlertSeen = vi.fn();
  app._updateActiveTabImmediate = vi.fn();
  app.closeSessionSidebarOnHandheld = vi.fn();
  app.renderSessionTabs = vi.fn();
  app.updateAttachmentHistoryBadge = vi.fn();
  app.attachmentHistoryDrawerOpen = false;
  app._updateLocalEchoState = vi.fn();
  app._flushedOffsets = new Map();
  app._flushedTexts = new Map();
  app._localEchoOverlay = null;
  app._beginBufferLoad = vi.fn(() => 1);
  app._isLoadingBuffer = false;
  app.fitAddon = { fit: vi.fn() };
  // selectSession fits through the one owner now, which also applies the floor
  // it reports to the PTY (#464). Without it on the fake, the unconditional
  // call throws into selectSession's catch and nothing after it runs.
  app.syncTerminalGeometry = vi.fn(() => ({ cols: 120, rows: 40 }));
  app.sendResize = vi.fn(() => {
    resizeCalls++;
    return resizeCalls === 1 ? terminalBoundary.promise : Promise.resolve(false);
  });
  app.terminalBufferCache = new Map();
  app._xtermSnapshots = new Map();
  app._fullHistoryLoaded = new Set();
  app._resetTerminalForReplay = vi.fn();
  app._connectWs = vi.fn();
  app.scrollToLastNonEmptyLine = vi.fn();
  app._recordTerminalLoadTiming = vi.fn();
  app.respawnStatus = {};
  app.respawnCountdownTimers = {};
  app.hideRespawnBanner = vi.fn();
  app.stopCountdownInterval = vi.fn();
  app.renderRalphStatePanel = vi.fn();
  app.updateCliInfoDisplay = vi.fn();
  app.renderProjectInsightsPanel = vi.fn();
  app.updateSubagentWindowVisibility = vi.fn();
  app.loadAppSettingsFromStorage = () => ({ showFileBrowser: true });

  const activateImplementation = app._activateFileBrowserSession.bind(app);
  app._activateFileBrowserSession = vi.fn(activateImplementation);
  const loadImplementation = app.loadFileBrowser.bind(app);
  app.loadFileBrowser = vi.fn(loadImplementation);

  return { app, elements, filePending, idleCallbacks, terminalBoundary };
}

async function startSearch(app: Record<string, any>, query = 'widget') {
  const input = app.$('fileBrowserSearch');
  if (input) input.value = query;
  app.filterFileBrowser(query);
  await vi.advanceTimersByTimeAsync(250);
}

async function settleSearch(
  app: Record<string, any>,
  pending: Array<{ url: string; reply: ReturnType<typeof deferred<FakeResponse>> }>,
  body: unknown,
  ok = true
) {
  await startSearch(app);
  pending[0].reply.resolve(response(body, ok));
  await vi.advanceTimersByTimeAsync(0);
}

function successfulData(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      mode: 'search',
      matches: [],
      truncated: false,
      matchCount: 0,
      ...overrides,
    },
  };
}

function successfulTree(name: string, overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    data: {
      tree: [{ name, path: name, type: 'file', size: 1, extension: 'ts' }],
      totalFiles: 1,
      totalDirectories: 0,
      truncated: false,
      ...overrides,
    },
  };
}

describe('File Viewer server search', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces for 250ms and encodes the owner and exact trimmed query', async () => {
    const { app, pending } = loadPanel();

    app.filterFileBrowser('src & docs');
    await vi.advanceTimersByTimeAsync(249);
    expect(pending).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(pending).toHaveLength(1);
    expect(pending[0].url).toBe('/api/sessions/session%2FA/files?depth=5&showHidden=false&q=src%20%26%20docs');
  });

  it('is a safe no-op without a panel or session and can lazily adopt a later active owner', async () => {
    const { app, elements, pending } = loadPanel({ sessionId: null });
    app.filterFileBrowser('before-session');
    await vi.advanceTimersByTimeAsync(250);
    expect(pending).toHaveLength(0);

    app.activeSessionId = 'session/B';
    app.filterFileBrowser('after-session');
    await vi.advanceTimersByTimeAsync(250);
    expect(pending[0].url).toBe('/api/sessions/session%2FB/files?depth=5&showHidden=false&q=after-session');

    pending[0].reply.resolve(response(successfulData()));
    await vi.advanceTimersByTimeAsync(0);
    expect(elements.fileBrowserTree.innerHTML).toContain('No matches');

    delete elements.fileBrowserPanel;
    app.filterFileBrowser('without-panel');
    await vi.advanceTimersByTimeAsync(250);
    expect(pending).toHaveLength(1);
  });

  it('does not schedule when the active session is missing or differs from the retained owner', async () => {
    const { app, elements, pending } = loadPanel();
    app._ensureFileBrowserState();

    app.activeSessionId = null;
    app.filterFileBrowser('missing-active');
    await vi.advanceTimersByTimeAsync(250);
    expect(pending).toHaveLength(0);
    expect(elements.fileBrowserTree.innerHTML).toBe('');
    expect(app._fileBrowserState.inFlight).toBeNull();

    app.activeSessionId = 'session/B';
    app.filterFileBrowser('wrong-active');
    await vi.advanceTimersByTimeAsync(250);
    expect(pending).toHaveLength(0);
    expect(elements.fileBrowserTree.innerHTML).toBe('');
    expect(app._fileBrowserState.inFlight).toBeNull();
  });

  it('cancels the prior debounce and clears a deferred directory target on every input', async () => {
    const { app, pending } = loadPanel();
    app._ensureFileBrowserState().deferredDirectoryTarget = {
      ownerSessionId: 'session/A',
      path: 'old-directory',
    };

    app.filterFileBrowser('first query');
    await vi.advanceTimersByTimeAsync(200);
    app._fileBrowserState.deferredDirectoryTarget = {
      ownerSessionId: 'session/A',
      path: 'another-directory',
    };
    app.filterFileBrowser('second query');

    expect(app._fileBrowserState.deferredDirectoryTarget).toBeNull();
    await vi.advanceTimersByTimeAsync(249);
    expect(pending).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(pending.map(({ url }) => url)).toEqual([
      '/api/sessions/session%2FA/files?depth=5&showHidden=false&q=second%20query',
    ]);
  });

  it('renders flat file and directory matches with captured-owner actions and status', async () => {
    const { app, elements, pending } = loadPanel();
    await settleSearch(
      app,
      pending,
      successfulData({
        matches: [
          { name: 'widget.ts', path: 'src/widget.ts', type: 'file', size: 1536, extension: 'ts' },
          { name: 'widgets', path: 'docs/widgets', type: 'directory' },
        ],
        matchCount: 2,
        truncated: true,
      })
    );

    expect(elements.fileBrowserTree.innerHTML).toContain('class="file-tree-name">widget.ts</span>');
    expect(elements.fileBrowserTree.innerHTML).toContain('class="file-tree-name directory">widgets</span>');
    expect(elements.fileBrowserTree.innerHTML).toContain('class="file-tree-size">1.5 KB</span>');
    expect(elements.fileBrowserTree.innerHTML).toContain('📘');
    expect(elements.fileBrowserTree.innerHTML).toContain('📁');
    expect(elements.fileBrowserTree.innerHTML).toContain('data-path="src/widget.ts"');
    expect(elements.fileBrowserTree.innerHTML).not.toContain('class="file-tree-path"');
    expect(elements.fileBrowserTree.innerHTML).toContain(
      'href="/api/sessions/session%2FA/file-raw?path=src%2Fwidget.ts&amp;download=true"'
    );
    expect(elements.fileBrowserStatus.textContent).toBe('2 matches (truncated)');
    expect(elements.fileBrowserExpandBtn.disabled).toBe(true);

    app._openFileBrowserSearchDirectory = vi.fn();
    app.activeSessionId = 'later-session';
    const rows = elements.fileBrowserTree.querySelectorAll('.file-tree-item');
    rows[0].click();
    rows[1].click();
    expect(app.openFilePreview).toHaveBeenCalledWith('src/widget.ts', 'session/A');
    expect(app._openFileBrowserSearchDirectory).toHaveBeenCalledWith({
      ownerSessionId: 'session/A',
      showHidden: false,
      treeEpoch: 0,
      searchEpoch: 1,
      rawInput: 'widget',
      query: 'widget',
      path: 'docs/widgets',
      view: 'search-results',
    });
  });

  it('uses the match list length when matchCount is omitted and renders no matches', async () => {
    const { app, elements, pending } = loadPanel();
    await settleSearch(app, pending, successfulData({ matchCount: undefined }));

    expect(elements.fileBrowserTree.innerHTML).toContain('No matches');
    expect(elements.fileBrowserStatus.textContent).toBe('0 matches');
  });

  it('rejects deferred results after any captured search context changes', async () => {
    const scenarios: Array<{
      name: string;
      mutate: (app: Record<string, any>, elements: Record<string, FakeElement>) => void;
    }> = [
      {
        name: 'raw input',
        mutate: (app) => {
          app._fileBrowserState.filter = 'changed raw input';
        },
      },
      {
        name: 'search epoch',
        mutate: (app) => {
          app._fileBrowserState.searchEpoch++;
        },
      },
      {
        name: 'owner',
        mutate: (app) => {
          app._fileBrowserState.ownerSessionId = 'another-owner';
        },
      },
      {
        name: 'active session',
        mutate: (app) => {
          app.activeSessionId = 'another-active-session';
        },
      },
      {
        name: 'hidden preference',
        mutate: (app) => {
          app.fileBrowserShowHidden = true;
        },
      },
      {
        name: 'panel visibility',
        mutate: (_app, elements) => {
          elements.fileBrowserPanel.classList.remove('visible');
        },
      },
    ];

    for (const scenario of scenarios) {
      const { app, elements, pending } = loadPanel();
      await startSearch(app);
      expect(app._fileBrowserState.inFlight.treeEpoch, scenario.name).toBe(0);
      scenario.mutate(app, elements);

      pending[0].reply.resolve(
        response(
          successfulData({
            matches: [{ name: `late-${scenario.name}.ts`, path: 'late.ts', type: 'file' }],
            matchCount: 1,
          })
        )
      );
      await vi.advanceTimersByTimeAsync(0);

      expect(elements.fileBrowserTree.innerHTML, scenario.name).toContain('Searching');
      expect(elements.fileBrowserTree.innerHTML, scenario.name).not.toContain(`late-${scenario.name}.ts`);
      expect(app._fileBrowserState.inFlight, scenario.name).toBeNull();
    }
  });

  it('keeps query B rendered when its response beats an already-launched query A', async () => {
    const { app, elements, pending } = loadPanel();
    app.filterFileBrowser('query A');
    await vi.advanceTimersByTimeAsync(250);
    app.filterFileBrowser('query B');
    await vi.advanceTimersByTimeAsync(250);
    expect(pending).toHaveLength(2);

    pending[1].reply.resolve(
      response(
        successfulData({
          matches: [{ name: 'result-B.ts', path: 'result-B.ts', type: 'file' }],
          matchCount: 1,
        })
      )
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(elements.fileBrowserTree.innerHTML).toContain('result-B.ts');

    pending[0].reply.resolve(
      response(
        successfulData({
          matches: [{ name: 'result-A.ts', path: 'result-A.ts', type: 'file' }],
          matchCount: 1,
        })
      )
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(elements.fileBrowserTree.innerHTML).toContain('result-B.ts');
    expect(elements.fileBrowserTree.innerHTML).not.toContain('result-A.ts');
    expect(app._fileBrowserState.matches[0].name).toBe('result-B.ts');
  });

  it('clears a blank query and restores the compatible cached tree immediately without fetching', () => {
    const { app, elements, pending } = loadPanel();
    app.fileBrowserData = {
      tree: [{ name: 'cached.ts', path: 'src/cached.ts', type: 'file', size: 4, extension: 'ts' }],
      totalFiles: 1,
      totalDirectories: 0,
      truncated: false,
    };

    app.filterFileBrowser('cache');
    expect(elements.fileBrowserTree.innerHTML).toContain('Searching');
    app.filterFileBrowser('   ');

    expect(pending).toHaveLength(0);
    expect(elements.fileBrowserTree.innerHTML).toContain('cached.ts');
    expect(elements.fileBrowserStatus.textContent).toBe('1 files, 0 dirs');
    expect(elements.fileBrowserExpandBtn.disabled).toBe(false);
  });

  it('binds normal-tree previews and encoded downloads to the captured owner', () => {
    const { app, elements } = loadPanel();
    app.fileBrowserData = {
      tree: [
        {
          name: 'normal & safe.ts',
          path: 'src/normal & safe.ts',
          type: 'file',
          size: 7,
          extension: 'ts',
        },
      ],
      totalFiles: 1,
      totalDirectories: 0,
      truncated: false,
    };
    app.renderFileBrowserTree();

    expect(elements.fileBrowserTree.innerHTML).toContain(
      'href="/api/sessions/session%2FA/file-raw?path=src%2Fnormal%20%26%20safe.ts&amp;download=true"'
    );
    app.activeSessionId = 'later-session';
    elements.fileBrowserTree.querySelectorAll('.file-tree-item')[0].click();
    expect(app.openFilePreview).toHaveBeenCalledWith('src/normal & safe.ts', 'session/A');
  });

  it('accepts 256 trimmed characters', async () => {
    const { app, pending } = loadPanel();
    app.filterFileBrowser(`  ${'x'.repeat(256)}  `);

    await vi.advanceTimersByTimeAsync(250);

    expect(pending).toHaveLength(1);
    expect(pending[0].url.endsWith(`&q=${'x'.repeat(256)}`)).toBe(true);
  });

  it('rejects 257 trimmed characters without a request', async () => {
    const { app, elements, pending } = loadPanel();
    app.filterFileBrowser('x'.repeat(257));

    await vi.advanceTimersByTimeAsync(1_000);

    expect(pending).toHaveLength(0);
    expect(elements.fileBrowserStatus.textContent).toBe('Search queries are limited to 256 characters');
    expect(app._fileBrowserState.matches).toEqual([]);
    expect(app._fileBrowserState.view).toBe('query-error');
  });

  it('fails closed on a non-2xx response', async () => {
    const { app, elements, pending } = loadPanel();
    await settleSearch(app, pending, { success: true }, false);

    expect(elements.fileBrowserTree.innerHTML).toBe('<div class="file-browser-empty">Search failed</div>');
    expect(elements.fileBrowserStatus.textContent).toBe('Search failed');
    expect(app._fileBrowserState.view).toBe('search-error');
  });

  it('fails closed on an unsuccessful envelope', async () => {
    const { app, elements, pending } = loadPanel();
    await settleSearch(app, pending, { success: false, error: '<b>server detail</b>' });

    expect(elements.fileBrowserTree.innerHTML).toBe('<div class="file-browser-empty">Search failed</div>');
    expect(elements.fileBrowserTree.innerHTML).not.toContain('server detail');
  });

  it.each([
    ['mode is not search', successfulData({ mode: 'tree' })],
    ['matches is not an array', successfulData({ matches: {} })],
    ['a match name is not a string', successfulData({ matches: [{ name: 1, path: 'x', type: 'file' }] })],
    ['a match path is not a string', successfulData({ matches: [{ name: 'x', path: null, type: 'file' }] })],
    ['a match type is unknown', successfulData({ matches: [{ name: 'x', path: 'x', type: 'symlink' }] })],
    [
      'a supplied size is not a number',
      successfulData({ matches: [{ name: 'x', path: 'x', type: 'file', size: '1' }] }),
    ],
    [
      'a supplied extension is not a string',
      successfulData({ matches: [{ name: 'x', path: 'x', type: 'file', extension: 1 }] }),
    ],
    ['truncated is not boolean', successfulData({ truncated: 'false' })],
    ['matchCount is negative', successfulData({ matchCount: -1 })],
    ['matchCount is not finite', successfulData({ matchCount: Number.POSITIVE_INFINITY })],
  ])('rejects a malformed successful envelope when %s', async (_case, body) => {
    const { app, elements, pending } = loadPanel();
    app.fileBrowserData = {
      tree: [{ name: 'cached-safe.ts', path: 'cached-safe.ts', type: 'file' }],
      totalFiles: 1,
      totalDirectories: 0,
      truncated: false,
    };
    const malformed = structuredClone(body);
    if (_case === 'matchCount is not finite') {
      (malformed as { data: { matchCount: number } }).data.matchCount = Number.POSITIVE_INFINITY;
    }
    await settleSearch(app, pending, malformed);

    expect(elements.fileBrowserTree.innerHTML).toBe('<div class="file-browser-empty">Search failed</div>');
    expect(elements.fileBrowserTree.innerHTML).not.toContain('cached-safe.ts');
    expect(app.fileBrowserData.tree[0].name).toBe('cached-safe.ts');
  });

  it('escapes metacharacters in displayed values, attributes, and links', async () => {
    const owner = 'session/"<&\'';
    const path = 'src/"<&\'/evil.ts';
    const name = '<img src=x onerror="boom"> &\'';
    const { app, elements, pending } = loadPanel({ sessionId: owner });
    await settleSearch(
      app,
      pending,
      successfulData({ matches: [{ name, path, type: 'file', extension: 'ts' }], matchCount: 1 })
    );

    const html = elements.fileBrowserTree.innerHTML;
    expect(html).toContain('&lt;img src=x onerror=&quot;boom&quot;&gt; &amp;&#039;');
    expect(html).toContain('src/&quot;&lt;&amp;&#039;/evil.ts');
    expect(html).toContain('data-path="src/&quot;&lt;&amp;&#039;/evil.ts"');
    expect(html).toContain(
      'href="/api/sessions/session%2F%22%3C%26&#039;/file-raw?path=src%2F%22%3C%26&#039;%2Fevil.ts&amp;download=true"'
    );
    expect(html).not.toContain('<img src=x');
  });

  describe('hidden-preference transitions', () => {
    it('owns normal loading immediately and reruns an exact valid query only after the replacement tree succeeds', async () => {
      const { app, elements, pending } = loadPanel();
      app.fileBrowserData = successfulTree('old-preference.ts').data;
      await settleSearch(
        app,
        pending,
        successfulData({
          matches: [{ name: 'old-result.ts', path: 'old-result.ts', type: 'file' }],
          matchCount: 1,
        })
      );
      elements.fileBrowserSearch.value = '  widget  ';
      app._fileBrowserState.filter = '  widget  ';
      app.fileBrowserFilter = '  widget  ';
      const beforeSearchEpoch = app._fileBrowserState.searchEpoch;
      const beforeTreeEpoch = app._fileBrowserState.treeEpoch;

      const toggle = app.toggleFileBrowserHidden();

      expect(app.fileBrowserShowHidden).toBe(true);
      expect(elements.fileBrowserHiddenBtn.attrs['aria-pressed']).toBe('true');
      expect(app._fileBrowserState.searchEpoch).toBe(beforeSearchEpoch + 1);
      expect(app._fileBrowserState.treeEpoch).toBe(beforeTreeEpoch + 1);
      expect(app._fileBrowserState.view).toBe('normal');
      expect(app._fileBrowserState.matches).toEqual([]);
      expect(app._fileBrowserState.normalState).toMatchObject({
        sessionId: 'session/A',
        showHidden: true,
        treeEpoch: beforeTreeEpoch + 1,
        phase: 'loading',
      });
      expect(app.fileBrowserData).toBeNull();
      expect(elements.fileBrowserSearch.value).toBe('  widget  ');
      expect(elements.fileBrowserExpandBtn.disabled).toBe(true);
      expect(elements.fileBrowserTree.innerHTML).toContain('Loading files');
      expect(elements.fileBrowserTree.innerHTML).not.toContain('old-result.ts');
      expect(elements.fileBrowserTree.innerHTML).not.toContain('old-preference.ts');
      expect(pending[1].url).toBe('/api/sessions/session%2FA/files?depth=5&showHidden=true');

      pending[1].reply.resolve(response(successfulTree('new-preference.ts')));
      await toggle;

      expect(app._fileBrowserState.view).toBe('search-pending');
      expect(elements.fileBrowserTree.innerHTML).toContain('Searching');
      await vi.advanceTimersByTimeAsync(250);
      expect(pending[2].url).toBe('/api/sessions/session%2FA/files?depth=5&showHidden=true&q=widget');
      pending[2].reply.resolve(
        response(
          successfulData({
            matches: [{ name: 'new-result.ts', path: 'new-result.ts', type: 'file' }],
            matchCount: 1,
          })
        )
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(elements.fileBrowserTree.innerHTML).toContain('new-result.ts');
    });

    it('lets input during the reload own the UI and invalidates the captured continuation', async () => {
      const { app, elements, pending } = loadPanel();
      await settleSearch(
        app,
        pending,
        successfulData({ matches: [{ name: 'old.ts', path: 'old.ts', type: 'file' }], matchCount: 1 })
      );

      const toggle = app.toggleFileBrowserHidden();
      await startSearch(app, 'new query');
      expect(pending[2].url).toContain('showHidden=true&q=new%20query');
      pending[2].reply.resolve(
        response(
          successfulData({ matches: [{ name: 'new-query.ts', path: 'new-query.ts', type: 'file' }], matchCount: 1 })
        )
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(elements.fileBrowserTree.innerHTML).toContain('new-query.ts');

      pending[1].reply.resolve(response(successfulTree('behind-new-query.ts')));
      await toggle;

      expect(app._fileBrowserState.normalState.phase).toBe('ready');
      expect(elements.fileBrowserTree.innerHTML).toContain('new-query.ts');
      expect(elements.fileBrowserTree.innerHTML).not.toContain('behind-new-query.ts');
      await vi.advanceTimersByTimeAsync(250);
      expect(pending).toHaveLength(3);
    });

    it.each([
      ['tree epoch', (app: Record<string, any>) => app._fileBrowserState.treeEpoch++],
      ['search epoch', (app: Record<string, any>) => app._fileBrowserState.searchEpoch++],
      ['owner', (app: Record<string, any>) => (app._fileBrowserState.ownerSessionId = 'session/B')],
      ['active session', (app: Record<string, any>) => (app.activeSessionId = 'session/B')],
      ['hidden preference', (app: Record<string, any>) => (app.fileBrowserShowHidden = false)],
      ['raw filter', (app: Record<string, any>) => (app._fileBrowserState.filter = 'changed')],
      [
        'raw input',
        (_app: Record<string, any>, elements: Record<string, FakeElement>) =>
          (elements.fileBrowserSearch.value = 'changed'),
      ],
      [
        'panel visibility',
        (_app: Record<string, any>, elements: Record<string, FakeElement>) =>
          elements.fileBrowserPanel.classList.remove('visible'),
      ],
    ])('does not rerun a captured query after its %s context changes', async (_case, mutate) => {
      const { app, elements, pending } = loadPanel();
      await settleSearch(app, pending, successfulData());
      const toggle = app.toggleFileBrowserHidden();

      mutate(app, elements);
      pending[1].reply.resolve(response(successfulTree('replacement.ts')));
      await toggle;
      await vi.advanceTimersByTimeAsync(250);

      expect(pending).toHaveLength(2);
    });

    it('invalidates the first load and continuation when two toggles happen rapidly', async () => {
      const { app, elements, pending } = loadPanel();
      await settleSearch(
        app,
        pending,
        successfulData({ matches: [{ name: 'old.ts', path: 'old.ts', type: 'file' }], matchCount: 1 })
      );

      const firstToggle = app.toggleFileBrowserHidden();
      const secondToggle = app.toggleFileBrowserHidden();
      expect(pending.slice(1).map(({ url }) => url)).toEqual([
        '/api/sessions/session%2FA/files?depth=5&showHidden=true',
        '/api/sessions/session%2FA/files?depth=5&showHidden=false',
      ]);

      pending[1].reply.resolve(response(successfulTree('stale-hidden.ts')));
      await firstToggle;
      expect(elements.fileBrowserTree.innerHTML).toContain('Loading files');
      expect(elements.fileBrowserTree.innerHTML).not.toContain('stale-hidden.ts');

      pending[2].reply.resolve(response(successfulTree('fresh-visible.ts')));
      await secondToggle;
      await vi.advanceTimersByTimeAsync(250);

      expect(pending).toHaveLength(4);
      expect(pending[3].url).toBe('/api/sessions/session%2FA/files?depth=5&showHidden=false&q=widget');
      expect(app.fileBrowserShowHidden).toBe(false);
    });

    it('stores and escapes a tree failure, keeps the new preference, and exposes the error on clear', async () => {
      const { app, elements, pending } = loadPanel();
      await settleSearch(
        app,
        pending,
        successfulData({ matches: [{ name: 'old.ts', path: 'old.ts', type: 'file' }], matchCount: 1 })
      );

      const toggle = app.toggleFileBrowserHidden();
      pending[1].reply.reject(new Error('<img src=x onerror=boom>'));
      await toggle;

      expect(app.fileBrowserShowHidden).toBe(true);
      expect(app._fileBrowserState.normalState).toMatchObject({ phase: 'error', showHidden: true });
      expect(app._fileBrowserState.normalState.error).toBe('<img src=x onerror=boom>');
      expect(elements.fileBrowserTree.innerHTML).toContain('&lt;img src=x onerror=boom&gt;');
      expect(elements.fileBrowserTree.innerHTML).not.toContain('<img src=x');
      expect(pending).toHaveLength(2);

      elements.fileBrowserSearch.value = '';
      app.filterFileBrowser('');
      expect(elements.fileBrowserTree.innerHTML).toContain('&lt;img src=x onerror=boom&gt;');
    });

    it('keeps a newer search result visible when the hidden reload fails, then reveals the stored error on clear', async () => {
      const { app, elements, pending } = loadPanel();
      await settleSearch(
        app,
        pending,
        successfulData({ matches: [{ name: 'old.ts', path: 'old.ts', type: 'file' }], matchCount: 1 })
      );

      const toggle = app.toggleFileBrowserHidden();
      await startSearch(app, 'new query');
      pending[2].reply.resolve(
        response(successfulData({ matches: [{ name: 'newer.ts', path: 'newer.ts', type: 'file' }], matchCount: 1 }))
      );
      await vi.advanceTimersByTimeAsync(0);
      pending[1].reply.reject(new Error('new preference failed'));
      await toggle;

      expect(elements.fileBrowserTree.innerHTML).toContain('newer.ts');
      expect(app._fileBrowserState.normalState).toMatchObject({ phase: 'error', error: 'new preference failed' });
      elements.fileBrowserSearch.value = '';
      app.filterFileBrowser('');
      expect(elements.fileBrowserTree.innerHTML).toContain('new preference failed');
    });

    it.each([
      ['ready', false],
      ['error', true],
    ])(
      'reloads behind an unchanged overlength query-error and reveals the new normal %s state on clear',
      async (_case, fail) => {
        const { app, elements, pending } = loadPanel();
        const query = 'x'.repeat(257);
        elements.fileBrowserSearch.value = query;
        app.filterFileBrowser(query);
        const message = elements.fileBrowserTree.innerHTML;
        const beforeSearchEpoch = app._fileBrowserState.searchEpoch;
        const beforeTreeEpoch = app._fileBrowserState.treeEpoch;

        const toggle = app.toggleFileBrowserHidden();

        expect(app._fileBrowserState.searchEpoch).toBe(beforeSearchEpoch + 1);
        expect(app._fileBrowserState.treeEpoch).toBe(beforeTreeEpoch + 1);
        expect(app._fileBrowserState.view).toBe('query-error');
        expect(elements.fileBrowserTree.innerHTML).toBe(message);
        expect(pending).toHaveLength(1);
        expect(pending[0].url).not.toContain('&q=');
        if (fail) pending[0].reply.reject(new Error('hidden tree failed'));
        else pending[0].reply.resolve(response(successfulTree('hidden-ready.ts')));
        await toggle;
        await vi.advanceTimersByTimeAsync(500);

        expect(elements.fileBrowserTree.innerHTML).toBe(message);
        expect(pending).toHaveLength(1);
        elements.fileBrowserSearch.value = '';
        app.filterFileBrowser('');
        if (fail) expect(elements.fileBrowserTree.innerHTML).toContain('hidden tree failed');
        else expect(elements.fileBrowserTree.innerHTML).toContain('hidden-ready.ts');
      }
    );

    it('recovers a failed hidden transition through refresh without reverting the preference', async () => {
      const { app, elements, pending } = loadPanel();
      await settleSearch(app, pending, successfulData());
      const toggle = app.toggleFileBrowserHidden();
      pending[1].reply.reject(new Error('toggle failed'));
      await toggle;

      const refresh = app.refreshFileBrowser();
      expect(app.fileBrowserShowHidden).toBe(true);
      expect(pending[2].url).toContain('showHidden=true');
      pending[2].reply.resolve(response(successfulTree('refresh-recovered.ts')));
      await refresh;
      expect(elements.fileBrowserTree.innerHTML).toContain('refresh-recovered.ts');
    });

    it('drops the prior-preference normal cache safely when the tree surface is missing', async () => {
      const { app, elements } = loadPanel();
      app.fileBrowserData = successfulTree('old-preference.ts').data;
      app._ensureFileBrowserState();
      delete elements.fileBrowserTree;

      await expect(app.toggleFileBrowserHidden()).resolves.toBeUndefined();

      expect(app.fileBrowserShowHidden).toBe(true);
      expect(app.fileBrowserData).toBeNull();
      expect(app._fileBrowserState.normalState).toBeNull();
    });
  });

  describe('Expand and Collapse gating', () => {
    it.each(['search-pending', 'search-results', 'search-error', 'query-error', 'normal'])(
      'disables the Expand control for trimmed input while the %s view owns the panel',
      (view) => {
        const { app, elements } = loadPanel();
        const state = app._ensureFileBrowserState();
        state.view = view;
        state.filter = '  query  ';
        elements.fileBrowserSearch.value = '  query  ';

        app._syncFileBrowserExpandBtn();
        expect(elements.fileBrowserExpandBtn.disabled).toBe(true);

        state.filter = '   ';
        elements.fileBrowserSearch.value = '   ';
        app._syncFileBrowserExpandBtn();
        expect(elements.fileBrowserExpandBtn.disabled).toBe(false);
      }
    );

    it('guards Expand and Collapse without repainting or changing expansion state during a query', () => {
      const { app, elements } = loadPanel();
      app.fileBrowserData = successfulTree('tree.ts').data;
      app._ensureFileBrowserState().filter = 'query';
      elements.fileBrowserSearch.value = 'query';
      elements.fileBrowserTree.innerHTML = '<div>search result sentinel</div>';
      elements.fileBrowserExpandBtn.innerHTML = '\u229E';
      const render = vi.spyOn(app, 'renderFileBrowserTree');

      app.toggleFileBrowserExpand();

      expect(app.fileBrowserAllExpanded).toBe(false);
      expect(app.fileBrowserExpandedDirs.size).toBe(0);
      expect(elements.fileBrowserExpandBtn.innerHTML).toBe('\u229E');
      expect(elements.fileBrowserTree.innerHTML).toBe('<div>search result sentinel</div>');
      expect(render).not.toHaveBeenCalled();
    });

    it('restores the control without changing its expansion state or icon when a search is cleared', () => {
      const { app, elements } = loadPanel();
      app.fileBrowserData = successfulTree('tree.ts').data;
      app.fileBrowserAllExpanded = true;
      app.fileBrowserExpandedDirs.add('existing');
      elements.fileBrowserExpandBtn.innerHTML = '\u229F';
      elements.fileBrowserSearch.value = 'query';
      app.filterFileBrowser('query');

      elements.fileBrowserSearch.value = '';
      app.filterFileBrowser('');

      expect(elements.fileBrowserExpandBtn.disabled).toBe(false);
      expect(elements.fileBrowserExpandBtn.innerHTML).toBe('\u229F');
      expect(app.fileBrowserAllExpanded).toBe(true);
      expect(app.fileBrowserExpandedDirs.has('existing')).toBe(true);
    });
  });

  describe('search directory navigation', () => {
    const unixTree = [
      {
        name: 'src',
        path: 'src',
        type: 'directory',
        children: [
          {
            name: 'components',
            path: 'src/components',
            type: 'directory',
            children: [
              {
                name: 'widgets',
                path: 'src/components/widgets',
                type: 'directory',
                children: [{ name: 'index.ts', path: 'src/components/widgets/index.ts', type: 'file' }],
              },
            ],
          },
        ],
      },
    ];

    it('finds a directory and its object-derived ancestors without parsing separators, including Windows paths', () => {
      const { app } = loadPanel();
      const windowsTree = [
        {
          name: 'src',
          path: 'C:\\repo\\src',
          type: 'directory',
          children: [
            {
              name: 'widgets',
              path: 'C:\\repo\\src\\widgets',
              type: 'directory',
              children: [],
            },
          ],
        },
      ];

      const found = app._findFileBrowserDirectory(windowsTree, 'C:\\repo\\src\\widgets');

      expect(found.target.path).toBe('C:\\repo\\src\\widgets');
      expect(found.ancestors).toEqual(['C:\\repo\\src']);
    });

    it('leaves search explicitly for a ready directory and resets every search field without synthetic input', async () => {
      const { app, elements, pending } = loadPanel();
      app.fileBrowserData = successfulTree('unused', {
        tree: unixTree,
        totalFiles: 1,
        totalDirectories: 3,
      }).data;
      app.fileBrowserAllExpanded = true;
      app.fileBrowserExpandedDirs.add('already-open');
      elements.fileBrowserExpandBtn.innerHTML = '\u229F';
      await settleSearch(
        app,
        pending,
        successfulData({
          matches: [{ name: 'widgets', path: 'src/components/widgets', type: 'directory' }],
          matchCount: 1,
        })
      );
      const staleTimer = vi.fn();
      app._fileBrowserState.inFlight = { timer: setTimeout(staleTimer, 10) };
      app._fileBrowserState.deferredDirectoryTarget = { stale: true };
      const beforeEpoch = app._fileBrowserState.searchEpoch;
      const filter = vi.spyOn(app, 'filterFileBrowser');

      elements.fileBrowserTree.querySelectorAll('.file-tree-item')[0].click();
      await vi.advanceTimersByTimeAsync(20);

      expect(app._fileBrowserState.searchEpoch).toBe(beforeEpoch + 1);
      expect(app._fileBrowserState.inFlight).toBeNull();
      expect(app._fileBrowserState.filter).toBe('');
      expect(app.fileBrowserFilter).toBe('');
      expect(app._fileBrowserState.matches).toEqual([]);
      expect(app._fileBrowserState.deferredDirectoryTarget).toBeNull();
      expect(app._fileBrowserState.view).toBe('normal');
      expect(elements.fileBrowserSearch.value).toBe('');
      expect(elements.fileBrowserExpandBtn.disabled).toBe(false);
      expect(elements.fileBrowserExpandBtn.innerHTML).toBe('\u229F');
      expect(app.fileBrowserAllExpanded).toBe(true);
      expect([...app.fileBrowserExpandedDirs]).toEqual([
        'already-open',
        'src',
        'src/components',
        'src/components/widgets',
      ]);
      expect(app.fileBrowserData).toBe(app._fileBrowserState.normalState.data);
      expect(elements.fileBrowserTree.innerHTML).toContain('index.ts');
      expect(staleTimer).not.toHaveBeenCalled();
      expect(filter).not.toHaveBeenCalled();
    });

    it('defers a directory transfer during the exact normal load while keeping results visible', async () => {
      const { app, elements, pending } = loadPanel();
      const treeLoad = app.loadFileBrowser('session/A');
      await startSearch(app);
      pending[1].reply.resolve(
        response(
          successfulData({
            matches: [{ name: 'widgets', path: 'src/components/widgets', type: 'directory' }],
            matchCount: 1,
          })
        )
      );
      await vi.advanceTimersByTimeAsync(0);

      elements.fileBrowserTree.querySelectorAll('.file-tree-item')[0].click();

      expect(elements.fileBrowserTree.innerHTML).toContain('widgets');
      expect(app._fileBrowserState.view).toBe('search-results');
      expect(app._fileBrowserState.deferredDirectoryTarget).toEqual({
        ownerSessionId: 'session/A',
        showHidden: false,
        treeEpoch: 0,
        searchEpoch: 1,
        rawInput: 'widget',
        query: 'widget',
        path: 'src/components/widgets',
        view: 'search-results',
      });
      const renderNormalTree = vi.spyOn(app, 'renderFileBrowserTree');

      pending[0].reply.resolve(
        response(successfulTree('unused', { tree: unixTree, totalFiles: 1, totalDirectories: 3 }))
      );
      await treeLoad;

      expect(renderNormalTree).toHaveBeenCalledTimes(1);
      expect(app._fileBrowserState.view).toBe('normal');
      expect(elements.fileBrowserTree.innerHTML).toContain('index.ts');
      expect(elements.fileBrowserTree.querySelectorAll('.file-tree-item')).toHaveLength(4);
      expect(app.fileBrowserExpandedDirs.has('src/components/widgets')).toBe(true);
    });

    it('cancels a deferred directory when a new query arrives', async () => {
      const { app, elements, pending } = loadPanel();
      const treeLoad = app.loadFileBrowser('session/A');
      await startSearch(app);
      pending[1].reply.resolve(
        response(
          successfulData({
            matches: [{ name: 'widgets', path: 'src/components/widgets', type: 'directory' }],
            matchCount: 1,
          })
        )
      );
      await vi.advanceTimersByTimeAsync(0);
      elements.fileBrowserTree.querySelectorAll('.file-tree-item')[0].click();
      expect(app._fileBrowserState.deferredDirectoryTarget).not.toBeNull();

      elements.fileBrowserSearch.value = 'new query';
      app.filterFileBrowser('new query');
      expect(app._fileBrowserState.deferredDirectoryTarget).toBeNull();
      pending[0].reply.resolve(
        response(successfulTree('unused', { tree: unixTree, totalFiles: 1, totalDirectories: 3 }))
      );
      await treeLoad;

      expect(app._fileBrowserState.view).toBe('search-pending');
      expect(elements.fileBrowserTree.innerHTML).toContain('Searching');
    });

    it('retains results, clears the deferred target, and toasts when the exact normal load fails', async () => {
      const { app, elements, pending } = loadPanel();
      const treeLoad = app.loadFileBrowser('session/A');
      await startSearch(app);
      pending[1].reply.resolve(
        response(
          successfulData({
            matches: [{ name: 'widgets', path: 'src/components/widgets', type: 'directory' }],
            matchCount: 1,
          })
        )
      );
      await vi.advanceTimersByTimeAsync(0);
      elements.fileBrowserTree.querySelectorAll('.file-tree-item')[0].click();

      pending[0].reply.reject(new Error('tree failed'));
      await treeLoad;

      expect(app._fileBrowserState.deferredDirectoryTarget).toBeNull();
      expect(app._fileBrowserState.view).toBe('search-results');
      expect(elements.fileBrowserTree.innerHTML).toContain('widgets');
      expect(app.showToast).toHaveBeenCalledWith('Reload files before opening this folder', 'info');
      expect(app._fileBrowserState.normalState).toMatchObject({ phase: 'error', error: 'tree failed' });

      elements.fileBrowserSearch.value = '';
      app.filterFileBrowser('');
      expect(elements.fileBrowserTree.innerHTML).toContain('tree failed');
    });

    it.each([
      ['error', { phase: 'error', error: 'cached failure' }],
      [
        'ready cache missing the directory',
        {
          phase: 'ready',
          data: successfulTree('other.ts').data,
        },
      ],
    ])('retains search results and prompts for reload for a compatible %s normal state', async (_case, normal) => {
      const { app, elements, pending } = loadPanel();
      const state = app._ensureFileBrowserState();
      state.normalState = {
        sessionId: 'session/A',
        showHidden: false,
        treeEpoch: 0,
        ...normal,
      };
      await settleSearch(
        app,
        pending,
        successfulData({ matches: [{ name: 'missing', path: 'missing', type: 'directory' }], matchCount: 1 })
      );

      elements.fileBrowserTree.querySelectorAll('.file-tree-item')[0].click();

      expect(app._fileBrowserState.view).toBe('search-results');
      expect(app._fileBrowserState.filter).toBe('widget');
      expect(elements.fileBrowserTree.innerHTML).toContain('missing');
      expect(app.showToast).toHaveBeenCalledWith('Reload files before opening this folder', 'info');
      expect(app._fileBrowserState.deferredDirectoryTarget).toBeNull();
    });

    it.each(['session', 'hidden preference', 'search epoch', 'tree epoch'])(
      'does not complete a deferred transfer after a new %s invalidates its binding',
      async (scenario) => {
        const { app, elements, pending } = loadPanel();
        app.loadFileBrowser('session/A');
        await startSearch(app);
        pending[1].reply.resolve(
          response(
            successfulData({
              matches: [{ name: 'widgets', path: 'src/components/widgets', type: 'directory' }],
              matchCount: 1,
            })
          )
        );
        await vi.advanceTimersByTimeAsync(0);
        elements.fileBrowserTree.querySelectorAll('.file-tree-item')[0].click();
        const ready = {
          sessionId: 'session/A',
          showHidden: false,
          treeEpoch: 0,
          phase: 'ready',
          data: successfulTree('unused', { tree: unixTree, totalFiles: 1, totalDirectories: 3 }).data,
        };

        if (scenario === 'session') {
          app.activeSessionId = 'session/B';
          app._fileBrowserState.ownerSessionId = 'session/B';
        } else if (scenario === 'hidden preference') {
          app.fileBrowserShowHidden = true;
        } else if (scenario === 'search epoch') {
          app._fileBrowserState.searchEpoch++;
        } else {
          app._fileBrowserState.treeEpoch++;
        }
        app._completeDeferredFileBrowserDirectory(ready);

        expect(app._fileBrowserState.view).toBe('search-results');
        expect(elements.fileBrowserSearch.value).toBe('widget');
        expect(elements.fileBrowserTree.innerHTML).toContain('widgets');
        expect(app.fileBrowserExpandedDirs.size).toBe(0);
        expect(app._fileBrowserState.deferredDirectoryTarget).toBeNull();
      }
    );

    it('does not clear a newer deferred replacement while compare-and-clearing an obsolete binding', () => {
      const { app } = loadPanel();
      const state = app._ensureFileBrowserState();
      const obsolete = {
        ownerSessionId: 'session/A',
        showHidden: false,
        treeEpoch: 0,
        searchEpoch: 0,
        rawInput: 'old',
        query: 'old',
        path: 'old/path',
        view: 'search-results',
      };
      const replacement = { ...obsolete, searchEpoch: 1, rawInput: 'new', query: 'new', path: 'new/path' };
      state.deferredDirectoryTarget = obsolete;
      vi.spyOn(app, '_isFileBrowserDirectoryContextCurrent').mockImplementationOnce((target) => {
        expect(target).toBe(obsolete);
        state.deferredDirectoryTarget = replacement;
        return false;
      });

      app._completeDeferredFileBrowserDirectory({
        sessionId: 'session/A',
        showHidden: false,
        treeEpoch: 0,
        phase: 'ready',
        data: successfulTree('ready.ts').data,
      });

      expect(state.deferredDirectoryTarget).toBe(replacement);
    });
  });

  describe('normal tree loads', () => {
    it('deduplicates compatible in-flight loads and reuses compatible ready and error states', async () => {
      const ready = loadPanel();
      ready.app._completeDeferredFileBrowserDirectory = vi.fn();
      const first = ready.app.loadFileBrowser('session/A');
      const duplicate = ready.app.loadFileBrowser('session/A');

      expect(duplicate).toBe(first);
      expect(ready.pending).toHaveLength(1);
      ready.pending[0].reply.resolve(response(successfulTree('ready.ts')));
      await first;
      expect(ready.app._fileBrowserState.normalState.phase).toBe('ready');
      expect(ready.elements.fileBrowserTree.innerHTML).toContain('ready.ts');
      expect(ready.app._completeDeferredFileBrowserDirectory).toHaveBeenCalledWith(
        ready.app._fileBrowserState.normalState
      );

      ready.elements.fileBrowserTree.innerHTML = '';
      const reusedReady = ready.app.loadFileBrowser('session/A');
      expect(ready.pending).toHaveLength(1);
      expect(typeof reusedReady.then).toBe('function');
      await reusedReady;
      expect(ready.elements.fileBrowserTree.innerHTML).toContain('ready.ts');

      const failed = loadPanel();
      failed.app._completeDeferredFileBrowserDirectory = vi.fn();
      const failedLoad = failed.app.loadFileBrowser('session/A');
      failed.pending[0].reply.reject(new Error('<img src=x onerror=boom>'));
      await failedLoad;
      expect(failed.app._fileBrowserState.normalState.phase).toBe('error');
      expect(failed.elements.fileBrowserTree.innerHTML).toContain('&lt;img src=x onerror=boom&gt;');
      expect(failed.elements.fileBrowserTree.innerHTML).not.toContain('<img src=x');
      expect(failed.elements.fileBrowserStatus.textContent).toContain('<img src=x onerror=boom>');
      expect(failed.elements.fileBrowserStatus.innerHTML).toBe('');
      expect(failed.app._completeDeferredFileBrowserDirectory).toHaveBeenCalledWith(
        failed.app._fileBrowserState.normalState
      );

      failed.elements.fileBrowserTree.innerHTML = '';
      await failed.app.loadFileBrowser('session/A');
      expect(failed.pending).toHaveLength(1);
      expect(failed.elements.fileBrowserTree.innerHTML).toContain('&lt;img src=x onerror=boom&gt;');
    });

    it('refresh invalidates both work classes, clears navigation state, and forces an epoch-safe replacement', async () => {
      const { app, elements, pending } = loadPanel();
      const stale = app.loadFileBrowser('session/A');
      app.filterFileBrowser('old query');
      app.fileBrowserExpandedDirs.add('src');
      app.fileBrowserAllExpanded = true;
      app._fileBrowserState.deferredDirectoryTarget = { ownerSessionId: 'session/A', path: 'src' };
      const beforeSearchEpoch = app._fileBrowserState.searchEpoch;
      const beforeTreeEpoch = app._fileBrowserState.treeEpoch;

      const replacement = app.refreshFileBrowser();

      expect(app._fileBrowserState.searchEpoch).toBe(beforeSearchEpoch + 1);
      expect(app._fileBrowserState.treeEpoch).toBe(beforeTreeEpoch + 1);
      expect(app._fileBrowserState.filter).toBe('');
      expect(app._fileBrowserState.matches).toEqual([]);
      expect(app._fileBrowserState.deferredDirectoryTarget).toBeNull();
      expect(app._fileBrowserState.view).toBe('normal');
      expect(app.fileBrowserExpandedDirs.size).toBe(0);
      expect(app.fileBrowserAllExpanded).toBe(false);
      expect(elements.fileBrowserExpandBtn.disabled).toBe(false);
      expect(elements.fileBrowserSearch.value).toBe('');
      expect(elements.fileBrowserTree.innerHTML).toContain('Loading files');
      expect(pending).toHaveLength(2);

      pending[0].reply.resolve(response(successfulTree('stale.ts')));
      await stale;
      expect(elements.fileBrowserTree.innerHTML).not.toContain('stale.ts');
      expect(app._fileBrowserState.treeInFlight.promise).toBe(replacement);

      pending[1].reply.resolve(response(successfulTree('fresh.ts')));
      await replacement;
      expect(elements.fileBrowserTree.innerHTML).toContain('fresh.ts');
      expect(elements.fileBrowserTree.innerHTML).not.toContain('stale.ts');
    });

    it('ignores stale pre-refresh failures while the replacement remains loading', async () => {
      const { app, elements, pending } = loadPanel();
      const stale = app.loadFileBrowser('session/A');
      const replacement = app.refreshFileBrowser();

      pending[0].reply.reject(new Error('stale failure'));
      await stale;
      expect(elements.fileBrowserTree.innerHTML).toContain('Loading files');
      expect(elements.fileBrowserTree.innerHTML).not.toContain('stale failure');

      pending[1].reply.resolve(response(successfulTree('replacement.ts')));
      await replacement;
      expect(elements.fileBrowserTree.innerHTML).toContain('replacement.ts');
    });

    it('isolates overlapping owners and does not reuse an unresolved A request after A to B to A', async () => {
      const { app, elements, pending } = loadPanel();
      const firstA = app.loadFileBrowser('session/A');
      app._fileBrowserState.ownerSessionId = 'session/B';
      app.activeSessionId = 'session/B';
      const loadB = app.loadFileBrowser('session/B');

      app._fileBrowserState.ownerSessionId = 'session/A';
      app.activeSessionId = 'session/A';
      const secondA = app.loadFileBrowser('session/A');
      expect(secondA).not.toBe(firstA);
      expect(pending).toHaveLength(3);

      pending[0].reply.resolve(response(successfulTree('stale-A.ts')));
      await firstA;
      expect(app.fileBrowserData).toBeNull();
      expect(elements.fileBrowserTree.innerHTML).toContain('Loading files');
      expect(elements.fileBrowserTree.innerHTML).not.toContain('stale-A.ts');

      pending[1].reply.reject(new Error('late B failure'));
      await loadB;
      expect(elements.fileBrowserTree.innerHTML).not.toContain('late B failure');
      pending[2].reply.resolve(response(successfulTree('current-A.ts')));
      await secondA;
      expect(elements.fileBrowserTree.innerHTML).toContain('current-A.ts');
    });

    it('shows B loading after clearing search while B is unsettled, never cached A data', async () => {
      const { app, elements, pending } = loadPanel();
      const firstA = app.loadFileBrowser('session/A');
      pending[0].reply.resolve(response(successfulTree('cached-A.ts')));
      await firstA;
      expect(elements.fileBrowserTree.innerHTML).toContain('cached-A.ts');

      app._fileBrowserState.ownerSessionId = 'session/B';
      app.activeSessionId = 'session/B';
      const loadB = app.loadFileBrowser('session/B');
      app.filterFileBrowser('temporary');
      app.filterFileBrowser('');

      expect(elements.fileBrowserTree.innerHTML).toContain('Loading files');
      expect(elements.fileBrowserTree.innerHTML).not.toContain('cached-A.ts');
      pending[1].reply.resolve(response(successfulTree('current-B.ts')));
      await loadB;
      expect(elements.fileBrowserTree.innerHTML).toContain('current-B.ts');
    });

    it('settles a compatible tree behind search without repainting and keeps tree/search epochs independent', async () => {
      const { app, elements, pending } = loadPanel();
      const treeLoad = app.loadFileBrowser('session/A');
      app.filterFileBrowser('query A');
      await vi.advanceTimersByTimeAsync(250);
      app.filterFileBrowser('query B');
      await vi.advanceTimersByTimeAsync(250);
      expect(pending).toHaveLength(3);

      pending[0].reply.resolve(response(successfulTree('behind-search.ts')));
      await treeLoad;
      expect(app._fileBrowserState.normalState.phase).toBe('ready');
      expect(app.fileBrowserData.tree[0].name).toBe('behind-search.ts');
      expect(elements.fileBrowserTree.innerHTML).toContain('Searching');
      expect(elements.fileBrowserTree.innerHTML).not.toContain('behind-search.ts');

      app._fileBrowserState.treeEpoch++;
      pending[2].reply.resolve(
        response(successfulData({ matches: [{ name: 'query-B.ts', path: 'query-B.ts', type: 'file' }] }))
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(elements.fileBrowserTree.innerHTML).toContain('query-B.ts');

      pending[1].reply.resolve(
        response(successfulData({ matches: [{ name: 'query-A.ts', path: 'query-A.ts', type: 'file' }] }))
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(elements.fileBrowserTree.innerHTML).not.toContain('query-A.ts');
    });

    it('suppresses invalidated tree responses and hidden-panel repainting', async () => {
      const scenarios = [
        {
          name: 'owner',
          mutate(app: Record<string, any>) {
            app._fileBrowserState.ownerSessionId = 'session/B';
          },
        },
        {
          name: 'tree epoch',
          mutate(app: Record<string, any>) {
            app._fileBrowserState.treeEpoch++;
          },
        },
        {
          name: 'hidden preference',
          mutate(app: Record<string, any>) {
            app.fileBrowserShowHidden = true;
          },
        },
      ];

      for (const scenario of scenarios) {
        const { app, elements, pending } = loadPanel();
        const load = app.loadFileBrowser('session/A');
        scenario.mutate(app);
        pending[0].reply.resolve(response(successfulTree(`late-${scenario.name}.ts`)));
        await load;
        expect(app.fileBrowserData, scenario.name).toBeNull();
        expect(elements.fileBrowserTree.innerHTML, scenario.name).not.toContain(`late-${scenario.name}.ts`);
      }

      const hidden = loadPanel();
      const hiddenLoad = hidden.app.loadFileBrowser('session/A');
      hidden.elements.fileBrowserPanel.classList.remove('visible');
      hidden.pending[0].reply.resolve(response(successfulTree('hidden-ready.ts')));
      await hiddenLoad;
      expect(hidden.app._fileBrowserState.normalState.phase).toBe('ready');
      expect(hidden.elements.fileBrowserTree.innerHTML).toContain('Loading files');
      expect(hidden.elements.fileBrowserTree.innerHTML).not.toContain('hidden-ready.ts');
    });

    it('compare-and-clears only the exact stale request and preserves replacement deduplication', async () => {
      const { app, pending } = loadPanel();
      const stale = app.loadFileBrowser('session/A');
      const replacement = app.loadFileBrowser('session/A', { force: true });
      const replacementRecord = app._fileBrowserState.treeInFlight;

      pending[0].reply.resolve(response(successfulTree('stale.ts')));
      await stale;
      expect(app._fileBrowserState.treeInFlight).toBe(replacementRecord);

      const reused = app.loadFileBrowser('session/A');
      expect(reused).toBe(replacement);
      expect(pending).toHaveLength(2);

      pending[1].reply.resolve(response(successfulTree('replacement.ts')));
      await replacement;
    });

    it.each([
      ['tree is not an array', successfulTree('x.ts', { tree: {} })],
      ['totalFiles is not finite', successfulTree('x.ts', { totalFiles: Number.POSITIVE_INFINITY })],
      ['the envelope is search-discriminated', successfulTree('x.ts', { mode: 'search', matches: [], matchCount: 0 })],
      [
        'a nested node is malformed',
        successfulTree('x.ts', { tree: [{ name: 'dir', path: 'dir', type: 'directory', children: [{}] }] }),
      ],
    ])('stores an escaped error instead of malformed tree data when %s', async (_case, body) => {
      const { app, elements, pending } = loadPanel();
      const load = app.loadFileBrowser('session/A');
      pending[0].reply.resolve(response(body));
      await load;

      expect(app.fileBrowserData).toBeNull();
      expect(app._fileBrowserState.normalState.phase).toBe('error');
      expect(elements.fileBrowserTree.innerHTML).toContain('Failed to load files');
    });

    it('does not adopt a different owner or fetch without a usable tree surface', () => {
      const wrongOwner = loadPanel();
      wrongOwner.app._ensureFileBrowserState().ownerSessionId = 'session/B';
      expect(wrongOwner.app.loadFileBrowser('session/A')).toBeUndefined();
      expect(wrongOwner.pending).toHaveLength(0);
      expect(wrongOwner.app._fileBrowserState.ownerSessionId).toBe('session/B');

      const missingTree = loadPanel();
      delete missingTree.elements.fileBrowserTree;
      expect(missingTree.app.loadFileBrowser('session/A')).toBeUndefined();
      expect(missingTree.pending).toHaveLength(0);
    });
  });

  describe('session ownership lifecycle', () => {
    it('activates the real selectSession owner before any terminal await can fail and retains the idle load', () => {
      const selectStart = appJs.indexOf('async selectSession(sessionId, options = {})');
      const activeAssignment = appJs.indexOf('this.activeSessionId = sessionId;', selectStart);
      const activation = appJs.indexOf('this._activateFileBrowserSession?.(sessionId);', activeAssignment);
      const firstTerminalAwait = appJs.indexOf('await ', activeAssignment);
      const retainedIdleLoad = appJs.indexOf('this.loadFileBrowser(sessionId);', firstTerminalAwait);

      expect(selectStart).toBeGreaterThanOrEqual(0);
      expect(appJs.slice(activeAssignment, activation + 53)).toMatch(
        /this\.activeSessionId = sessionId;\s*this\._activateFileBrowserSession\?\.\(sessionId\);/
      );
      expect(activeAssignment).toBeLessThan(activation);
      expect(activation).toBeLessThan(firstTerminalAwait);
      expect(firstTerminalAwait).toBeLessThan(retainedIdleLoad);
    });

    it('executes real selectSession activation before a pending terminal boundary and keeps the B load on failure', async () => {
      const { app, filePending, terminalBoundary } = loadRealSelectSessionHarness({ terminalFailure: true });

      const selection = app.selectSession('session/B');
      const immediateState = {
        activationCalls: app._activateFileBrowserSession.mock.calls.length,
        activeSessionId: app.activeSessionId,
        ownerSessionId: app._fileBrowserState?.ownerSessionId,
        resizeCalls: app.sendResize.mock.calls.length,
        fileUrls: filePending.map(({ url }) => url),
      };

      terminalBoundary.reject(new Error('resize failed'));
      await selection;

      expect(immediateState.activationCalls).toBe(1);
      expect(app._activateFileBrowserSession).toHaveBeenCalledWith('session/B');
      expect(immediateState.activeSessionId).toBe('session/B');
      expect(immediateState.ownerSessionId).toBe('session/B');
      expect(immediateState.resizeCalls).toBe(1);
      expect(immediateState.fileUrls).toEqual(['/api/sessions/session%2FB/files?depth=5&showHidden=false']);

      expect(filePending).toHaveLength(1);
      expect(app._fileBrowserState.ownerSessionId).toBe('session/B');
      filePending[0].reply.resolve(response(successfulTree('B-after-terminal-failure.ts')));
      await app._fileBrowserState.treeInFlight.promise;
      expect(app.fileBrowserData.tree[0].name).toBe('B-after-terminal-failure.ts');
    });

    it.each([
      ['in-flight request', false],
      ['settled ready state', true],
    ])('the real selectSession idle callback reuses the immediate B %s', async (_case, settleBeforeIdle) => {
      const { app, elements, filePending, idleCallbacks, terminalBoundary } = loadRealSelectSessionHarness();

      const selection = app.selectSession('session/B');
      const immediateActivationCalls = app._activateFileBrowserSession.mock.calls.length;
      const immediateLoadCalls = app.loadFileBrowser.mock.calls.length;
      const immediateLoad = app.loadFileBrowser.mock.results[0]?.value;
      const immediateRequestCount = filePending.length;

      if (settleBeforeIdle && filePending[0]) {
        filePending[0].reply.resolve(response(successfulTree('ready-B.ts')));
        await immediateLoad;
        expect(elements.fileBrowserTree.innerHTML).toContain('ready-B.ts');
      }

      terminalBoundary.resolve(false);
      await selection;
      expect(idleCallbacks).toHaveLength(1);
      idleCallbacks[0]();

      expect(immediateActivationCalls).toBe(1);
      expect(immediateLoadCalls).toBe(1);
      expect(immediateRequestCount).toBe(1);
      expect(app.loadFileBrowser).toHaveBeenCalledTimes(2);
      expect(app.loadFileBrowser).toHaveBeenLastCalledWith('session/B');
      expect(filePending).toHaveLength(1);
      const idleLoad = app.loadFileBrowser.mock.results[1].value;
      if (settleBeforeIdle) {
        await idleLoad;
        expect(app._fileBrowserState.normalState.phase).toBe('ready');
      } else {
        expect(idleLoad).toBe(immediateLoad);
        filePending[0].reply.resolve(response(successfulTree('in-flight-B.ts')));
        await idleLoad;
      }
    });

    it('synchronously resets A state, owns B, and starts one visible B tree load', async () => {
      const { app, elements, pending } = loadPanel();
      app.fileBrowserData = successfulTree('old-A.ts').data;
      app.renderFileBrowserTree('session/A');
      app.filterFileBrowser('old query');
      app.fileBrowserExpandedDirs.add('src');
      app.fileBrowserAllExpanded = true;
      app._fileBrowserState.deferredDirectoryTarget = { ownerSessionId: 'session/A', path: 'src' };
      const searchEpoch = app._fileBrowserState.searchEpoch;
      const treeEpoch = app._fileBrowserState.treeEpoch;

      app.activeSessionId = 'session/B';
      app._activateFileBrowserSession('session/B');

      expect(app._fileBrowserState.ownerSessionId).toBe('session/B');
      expect(app._fileBrowserState.searchEpoch).toBe(searchEpoch + 1);
      expect(app._fileBrowserState.treeEpoch).toBe(treeEpoch + 1);
      expect(app._fileBrowserState.inFlight).toBeNull();
      expect(app._fileBrowserState.normalState.phase).toBe('loading');
      expect(app._fileBrowserState.matches).toEqual([]);
      expect(app._fileBrowserState.deferredDirectoryTarget).toBeNull();
      expect(app._fileBrowserState.filter).toBe('');
      expect(app._fileBrowserState.view).toBe('normal');
      expect(app.fileBrowserData).toBeNull();
      expect(app.fileBrowserFilter).toBe('');
      expect(app.fileBrowserExpandedDirs.size).toBe(0);
      expect(app.fileBrowserAllExpanded).toBe(false);
      expect(elements.fileBrowserSearch.value).toBe('');
      expect(elements.fileBrowserExpandBtn.disabled).toBe(false);
      expect(elements.fileBrowserExpandBtn.innerHTML).toBe('\u229E');
      expect(elements.fileBrowserTree.querySelectorAll('.file-tree-item')).toHaveLength(0);
      expect(elements.fileBrowserTree.innerHTML).toContain('Loading files');
      expect(pending.map(({ url }) => url)).toEqual(['/api/sessions/session%2FB/files?depth=5&showHidden=false']);

      await vi.advanceTimersByTimeAsync(250);
      expect(pending).toHaveLength(1);
      const activatedLoad = app._fileBrowserState.treeInFlight.promise;
      const retainedIdleLoad = app.loadFileBrowser('session/B');
      expect(retainedIdleLoad).toBe(activatedLoad);
      expect(pending).toHaveLength(1);

      pending[0].reply.resolve(response(successfulTree('current-B.ts')));
      await retainedIdleLoad;
      expect(elements.fileBrowserTree.innerHTML).toContain('current-B.ts');
    });

    it('does not load while hidden and tolerates missing session or elements', () => {
      const hidden = loadPanel();
      hidden.elements.fileBrowserPanel.classList.remove('visible');
      hidden.app.activeSessionId = 'session/B';
      expect(() => hidden.app._activateFileBrowserSession('session/B')).not.toThrow();
      expect(hidden.pending).toHaveLength(0);
      expect(hidden.app._fileBrowserState.ownerSessionId).toBe('session/B');
      expect(hidden.app._fileBrowserState.normalState).toBeNull();
      expect(hidden.elements.fileBrowserTree.innerHTML).toBe('');
      expect(hidden.elements.fileBrowserStatus.textContent).toBe('');

      const missing = loadPanel();
      delete missing.elements.fileBrowserTree;
      delete missing.elements.fileBrowserStatus;
      delete missing.elements.fileBrowserSearch;
      delete missing.elements.fileBrowserExpandBtn;
      expect(() => missing.app._activateFileBrowserSession(null)).not.toThrow();
      expect(() => missing.app._activateFileBrowserSession('session/B')).not.toThrow();
    });

    it('targets B when a query is entered before the activated B tree settles', async () => {
      const { app, pending } = loadPanel();
      app.activeSessionId = 'session/B';
      app._activateFileBrowserSession('session/B');
      app.filterFileBrowser('during load');
      await vi.advanceTimersByTimeAsync(250);

      expect(pending.map(({ url }) => url)).toEqual([
        '/api/sessions/session%2FB/files?depth=5&showHidden=false',
        '/api/sessions/session%2FB/files?depth=5&showHidden=false&q=during%20load',
      ]);
      expect(pending.every(({ url }) => !url.includes('session%2FA'))).toBe(true);
    });

    it('starts fresh A work on A to B to A and rejects the original A completion', async () => {
      const { app, elements, pending } = loadPanel();
      const firstA = app.loadFileBrowser('session/A');
      app.activeSessionId = 'session/B';
      app._activateFileBrowserSession('session/B');
      const loadB = app._fileBrowserState.treeInFlight.promise;
      app.activeSessionId = 'session/A';
      app._activateFileBrowserSession('session/A');
      const secondA = app._fileBrowserState.treeInFlight.promise;

      expect(secondA).not.toBe(firstA);
      expect(pending.map(({ url }) => url)).toEqual([
        '/api/sessions/session%2FA/files?depth=5&showHidden=false',
        '/api/sessions/session%2FB/files?depth=5&showHidden=false',
        '/api/sessions/session%2FA/files?depth=5&showHidden=false',
      ]);

      pending[0].reply.resolve(response(successfulTree('stale-A.ts')));
      await firstA;
      expect(app._fileBrowserState.treeInFlight.promise).toBe(secondA);
      expect(elements.fileBrowserTree.innerHTML).not.toContain('stale-A.ts');
      pending[1].reply.reject(new Error('late B failure'));
      await loadB;
      expect(app._fileBrowserState.treeInFlight.promise).toBe(secondA);
      pending[2].reply.resolve(response(successfulTree('fresh-A.ts')));
      await secondA;
      expect(elements.fileBrowserTree.innerHTML).toContain('fresh-A.ts');
    });
  });

  describe('hide lifecycle', () => {
    it('the real settings hide branch resets once and does not churn epochs while already hidden', () => {
      const { app, elements } = loadPanel();
      const state = app._ensureFileBrowserState();
      const searchEpoch = state.searchEpoch;
      const treeEpoch = state.treeEpoch;

      app.applyMonitorVisibility();

      expect(elements.fileBrowserPanel.classList.contains('visible')).toBe(false);
      expect(state.searchEpoch).toBe(searchEpoch + 1);
      expect(state.treeEpoch).toBe(treeEpoch + 1);
      app.applyMonitorVisibility();
      expect(state.searchEpoch).toBe(searchEpoch + 1);
      expect(state.treeEpoch).toBe(treeEpoch + 1);
    });

    it('cancels an unlaunched debounce and clears all hide-reset controls and navigation state', async () => {
      const { app, elements, pending } = loadPanel();
      app.filterFileBrowser('not launched');
      app.fileBrowserExpandedDirs.add('src');
      app.fileBrowserAllExpanded = true;
      app._fileBrowserState.matches = [{ name: 'old.ts' }];
      app._fileBrowserState.deferredDirectoryTarget = { ownerSessionId: 'session/A', path: 'src' };
      elements.fileBrowserSearch.value = 'not launched';
      elements.fileBrowserExpandBtn.disabled = true;
      elements.fileBrowserExpandBtn.innerHTML = '\u229F';

      app.closeFileBrowserPanel();
      await vi.advanceTimersByTimeAsync(250);

      expect(pending).toHaveLength(0);
      expect(app._fileBrowserState.view).toBe('normal');
      expect(app._fileBrowserState.filter).toBe('');
      expect(app.fileBrowserFilter).toBe('');
      expect(app.fileBrowserExpandedDirs.size).toBe(0);
      expect(app.fileBrowserAllExpanded).toBe(false);
      expect(app._fileBrowserState.matches).toEqual([]);
      expect(app._fileBrowserState.deferredDirectoryTarget).toBeNull();
      expect(elements.fileBrowserSearch.value).toBe('');
      expect(elements.fileBrowserExpandBtn.disabled).toBe(false);
      expect(elements.fileBrowserExpandBtn.innerHTML).toBe('\u229E');
    });

    it.each([
      ['tree success', 'tree', false],
      ['tree failure', 'tree', true],
      ['search success', 'search', false],
      ['search failure', 'search', true],
    ])('explicit close blocks pending %s from updating state or UI', async (_name, kind, fail) => {
      const { app, elements, pending } = loadPanel();
      const operation = kind === 'tree' ? app.loadFileBrowser('session/A') : (await startSearch(app), undefined);

      app.closeFileBrowserPanel();
      expect(app._fileBrowserState.treeInFlight).toBeNull();
      expect(app._fileBrowserState.inFlight).toBeNull();
      expect(app._fileBrowserState.normalState).toBeNull();
      expect(app._fileBrowserState.matches).toEqual([]);
      expect(elements.fileBrowserTree.innerHTML).toBe('');
      expect(elements.fileBrowserStatus.textContent).toBe('');

      if (fail) pending[0].reply.reject(new Error(`late ${kind} failure`));
      else
        pending[0].reply.resolve(
          response(
            kind === 'tree'
              ? successfulTree('late.ts')
              : successfulData({
                  matches: [{ name: 'late.ts', path: 'late.ts', type: 'file' }],
                  matchCount: 1,
                })
          )
        );
      if (operation) await operation;
      await vi.advanceTimersByTimeAsync(0);

      expect(app.fileBrowserData).toBeNull();
      expect(app._fileBrowserState.normalState).toBeNull();
      expect(app._fileBrowserState.matches).toEqual([]);
      expect(elements.fileBrowserTree.innerHTML).toBe('');
      expect(elements.fileBrowserStatus.textContent).toBe('');
    });

    it.each([
      ['tree success', 'tree', false],
      ['tree failure', 'tree', true],
      ['search success', 'search', false],
      ['search failure', 'search', true],
    ])('settings-driven hide blocks pending %s from updating state or UI', async (_name, kind, fail) => {
      const { app, elements, pending } = loadPanel();
      const operation = kind === 'tree' ? app.loadFileBrowser('session/A') : (await startSearch(app), undefined);

      app.applyMonitorVisibility();
      expect(elements.fileBrowserPanel.classList.contains('visible')).toBe(false);
      if (fail) pending[0].reply.reject(new Error(`late ${kind} failure`));
      else
        pending[0].reply.resolve(
          response(
            kind === 'tree'
              ? successfulTree('late.ts')
              : successfulData({
                  matches: [{ name: 'late.ts', path: 'late.ts', type: 'file' }],
                  matchCount: 1,
                })
          )
        );
      if (operation) await operation;
      await vi.advanceTimersByTimeAsync(0);

      expect(app.fileBrowserData).toBeNull();
      expect(app._fileBrowserState.normalState).toBeNull();
      expect(app._fileBrowserState.matches).toEqual([]);
      expect(elements.fileBrowserTree.innerHTML).toBe('');
      expect(elements.fileBrowserStatus.textContent).toBe('');
    });

    it.each([
      ['stale success', false],
      ['stale failure', true],
    ])('reopen after %s starts a replacement and stale settlement cannot clear it', async (_name, fail) => {
      const { app, elements, pending } = loadPanel();
      const stale = app.loadFileBrowser('session/A');
      app.closeFileBrowserPanel();
      elements.fileBrowserPanel.classList.add('visible');
      const replacement = app.loadFileBrowser('session/A');
      const replacementRecord = app._fileBrowserState.treeInFlight;

      expect(replacement).not.toBe(stale);
      expect(pending).toHaveLength(2);
      if (fail) pending[0].reply.reject(new Error('stale failure'));
      else pending[0].reply.resolve(response(successfulTree('stale.ts')));
      await stale;
      expect(app._fileBrowserState.treeInFlight).toBe(replacementRecord);
      expect(elements.fileBrowserTree.innerHTML).toContain('Loading files');
      expect(elements.fileBrowserTree.innerHTML).not.toContain('stale.ts');

      const reused = app.loadFileBrowser('session/A');
      expect(reused).toBe(replacement);
      expect(pending).toHaveLength(2);
      pending[1].reply.resolve(response(successfulTree('replacement.ts')));
      await replacement;
      expect(elements.fileBrowserTree.innerHTML).toContain('replacement.ts');
    });
  });
});
