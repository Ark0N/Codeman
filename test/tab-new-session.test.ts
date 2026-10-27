/**
 * @fileoverview A session tab's "+" (`showTabNewButton`, per device, off by
 * default) and the row menu's "New session here…": the picker of CLIs the
 * tab's case can start, and the one-off launch beside that tab.
 *
 * Driven through the shipping CodemanApp inside JSDOM (app.js, tab-rail-resize.js,
 * mobile-overview.js and session-ui.js loaded as the page loads them). Pins:
 *  - each entry is a Run menu entry (the CLI's logo, then its name), agents in
 *    catalog order and the shell last, the Run button's mode preselected;
 *  - the tab's case is found by what the session runs on: a Docker session's
 *    container, a remote session's host and path, a local session's folder among
 *    LOCAL cases only (the case records are shaped as GET /api/cases sends them:
 *    display paths for remote and Docker cases, the raw values nested);
 *  - which CLIs are offered follows the Run menu's own rule for that case
 *    (_runModeAvailableForCase): the host's CLIs for a local case, the
 *    container's for a Docker case (live probe, then the stored list, nothing
 *    gated for an owned container), only the shell for an unreadable one; the
 *    picker starts that probe when nothing is cached for a Docker case;
 *  - a pick runs ONE launch in the tab's case or managed worktree with the tab's
 *    named group, and an ungrouped tab sends no group (the server's case default
 *    group then applies, pinned end to end in case-default-group-routes.test.ts);
 *  - the Run button's mode and the toolbar case are left as they were, also when
 *    the mode is changed while the launch is pending and when the server has
 *    moved lastUsedCase to the tab's case, and a later launch that names no case
 *    (a worktree tab's "+", the toolbar Run, a group's "New session") keeps the
 *    toolbar's case too;
 *  - a failed launch reports the server's own error;
 *  - Enter and Space on the "+" open the picker (the header strip's only
 *    keyboard path) and stop there; every other key passes on to the strip; a
 *    held key's repeat cannot also pick the entry the picker focuses;
 *  - the row menu offers the picker on session rows only while the setting is on;
 *  - the picker closes on a re-render and gives focus back to the tab on Escape;
 *  - the setting stays per device and OFF until switched on, and every new
 *    string has its zh-CN entry.
 *
 * Port: none (stubbed fetch).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsUpdateSchema } from '../src/web/schemas.js';

const PUBLIC = join(process.cwd(), 'src/web/public');
const read = (name: string) => readFileSync(join(PUBLIC, name), 'utf8');

const CATALOG = [
  { id: 'claude', kind: 'agent', label: 'Claude Code', enabled: true },
  { id: 'shell', kind: 'shell', label: 'Shell', enabled: true },
  { id: 'codex', kind: 'agent', label: 'Codex', enabled: true },
  { id: 'gemini', kind: 'agent', label: 'Gemini CLI', enabled: true },
  { id: 'pi', kind: 'agent', label: 'Pi', enabled: false },
];
/** What this host has installed: no gemini. */
const HOST = new Set(['claude', 'codex']);
/** As GET /api/cases sends them: remote and Docker cases carry a DISPLAY path, the raw values nested. */
const CASES = [
  { name: 'toolbar-case', path: '/tmp/toolbar-case', location: 'local' },
  // Same container name and same remote path on ANOTHER host, listed first: only the host tells them apart.
  {
    name: 'box-h2',
    path: 'box:/srv/box',
    location: 'docker',
    docker: { hostId: 'h2', container: 'box', path: '/srv/box', containerWorkdir: '/srv/box' },
  },
  {
    name: 'rem2',
    path: 'dev@host2:/home/dev/work',
    location: 'remote',
    remote: { hostId: 'r2', host: 'host2', username: 'dev', path: '/home/dev/work' },
  },
  // Inside proj and listed before it: the deepest enclosing case wins, whatever the order.
  { name: 'nested', path: '/tmp/proj/nested', location: 'local' },
  { name: 'proj', path: '/tmp/proj', location: 'local' },
  {
    name: 'box',
    path: 'box:/srv/box',
    location: 'docker',
    docker: {
      hostId: 'h1',
      container: 'box',
      path: '/srv/box',
      containerWorkdir: '/srv/box',
      owned: false,
      availableModes: ['gemini', 'shell'],
    },
  },
  {
    name: 'own',
    path: 'own:/srv/own',
    location: 'docker',
    docker: { hostId: 'h1', container: 'own', path: '/srv/own', containerWorkdir: '/srv/own' },
  },
  // A local case whose folder is the Docker case's workspace: only a LOCAL session belongs to it.
  { name: 'clash', path: '/srv/box', location: 'linked-local' },
  {
    name: 'rem',
    path: 'dev@host1:/home/dev/work',
    location: 'remote',
    remote: { hostId: 'r1', host: 'host1', username: 'dev', path: '/home/dev/work' },
  },
];
const DOCKER_BOX = { hostId: 'h1', containerName: 'box', hostWorkspacePath: '/srv/box', containerWorkdir: '/srv/box' };
const DOCKER_OWN = { hostId: 'h1', containerName: 'own', hostWorkspacePath: '/srv/own', containerWorkdir: '/srv/own' };
const REMOTE_R1 = { hostId: 'r1', host: 'host1', username: 'dev', remotePath: '/home/dev/work/api' };
const SESSIONS: Array<[string, string, Record<string, unknown>?]> = [
  ['a', '/tmp/proj/sub'],
  ['b', '/tmp/proj'],
  ['c', '/srv/box', { docker: DOCKER_BOX }],
  ['d', '/srv/own', { docker: DOCKER_OWN }],
  ['e', '/home/u/scratch'],
  ['f', '/tmp/proj/.claude/worktrees/feat'],
  ['g', '/srv/box'],
  ['r', '/home/dev/work/api', { remote: REMOTE_R1 }],
  ['n', '/tmp/proj/nested/src'],
];
const LAYOUT = {
  version: 4,
  updatedAt: '2026-10-01T00:00:00.000Z',
  groups: [{ id: 'gx', name: 'Core', refs: [{ kind: 'session', id: 'b' }] }],
  ungrouped: ['a', 'c', 'd', 'e', 'f', 'g', 'r', 'n'].map((id) => ({ kind: 'session', id })),
};

let CodemanApp: { prototype: Record<string, any> };
/** The test's app, so afterEach can close its menus: their document listeners would outlive the DOM. */
let current: Record<string, any> | null = null;
let win: any;
let document: Document;

beforeAll(async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://localhost/',
    runScripts: 'outside-only',
  });
  if (dom.window.document.readyState !== 'complete') {
    await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  }
  win = dom.window;
  document = win.document;
  win.setInterval = () => 0;
  win.requestAnimationFrame = () => 0;
  win.CSS = { escape: (value: string) => value };
  win.eval(
    'var MobileDetection = { isTouchDevice: () => false, getDeviceType: () => "desktop" }, KeyboardHandler = {}, ' +
      'SwipeHandler = {}, VoiceInput = {}, DeepgramProvider = {}, NotificationManager = function(){};\n' +
      [
        'constants.js',
        'tab-layout-browser.js',
        'app.js',
        'tab-rail-resize.js',
        'api-client.js',
        'webview-tabs.js',
        'mobile-overview.js',
        'session-ui.js',
      ]
        .map(read)
        .join('\n;\n') +
      '\n;window.__TabNewCodemanApp = CodemanApp;'
  );
  CodemanApp = win.__TabNewCodemanApp;
});

function makeApp({ orientation = 'horizontal' } = {}) {
  const app = Object.create(CodemanApp.prototype) as Record<string, any>;
  document.documentElement.setAttribute('data-tab-orientation', orientation);
  document.documentElement.dataset.tabRailSort = 'manual';
  document.body.innerHTML =
    '<div id="sessionTabs" role="tablist" aria-label="Session tabs"></div>' +
    '<select id="quickStartCase"><option value="toolbar-case" selected>toolbar-case</option></select>' +
    '<input id="tabCount" value="3"><button id="runBtn"></button>';
  app.$ = (id: string) => document.getElementById(id);
  app.sessions = new Map(
    SESSIONS.map(([id, workingDir, extra]) => [id, { id, name: id, status: 'idle', workingDir, ...extra }])
  );
  app.sessionOrder = SESSIONS.map(([id]) => id);
  app.webviews = new Map();
  app.webviewOrder = [];
  app.activeSessionId = 'a';
  app.activeWebviewId = null;
  app.tabLayout = null;
  app.collapsedTabGroupIds = new Set();
  app._hiddenTabGroupByRef = new Map();
  app._lastTabGroupStructureKey = null;
  app._tabCollapseStorageFailed = false;
  app._inlineRenameActive = false;
  app.tabAlerts = new Map();
  app.terminalLoadStates = new Map();
  app.minimizedSubagents = new Map();
  app.hasTabDetachOverride = () => false;
  app.renderSubagentTabBadge = () => '';
  app.cancelHideSubagentDropdown = () => {};
  app.updateTabOverflowMode = () => {};
  app.updateConnectionLines = () => {};
  app._applyTabEntrances = () => {};
  app._scrollActiveTabIntoView = () => {};
  app.applySidebarFilter = () => {};
  app.isSessionSidebarActive = () => false;
  app._startSidebarRichClock = () => {};
  app._stopSidebarRichClock = () => {};
  app.loadAppSettingsFromStorage = () => ({});
  app.openSessionOptions = vi.fn();
  app.requestCloseSession = vi.fn();
  app.selectSession = vi.fn(async () => {});
  app.showToast = vi.fn();
  app.closeAllPanels = vi.fn();
  // What the real run() reads beyond the DOM (the same stubs as tab-group-launch.test.ts).
  app._runMinLockMs = 0;
  app._runMode = 'codex';
  app.terminal = { clear: () => {}, writeln: () => {}, focus: () => {}, cols: 80, rows: 24 };
  app.cases = CASES;
  app.isCliAvailable = (id: string) => HOST.has(id);
  app.getCaseSettings = () => ({});
  app.buildEnvOverrides = () => ({});
  app.getEffortSetting = () => undefined;
  app.isRalphTrackerEnabledByDefault = () => false;
  app.getTerminalDimensions = () => null;
  app.loadQuickStartCases = () => {};
  app._fullRenderSessionTabs();
  app._applyTabLayout(LAYOUT);
  current = app;
  return app;
}

const tab = (id: string) => document.querySelector<HTMLElement>(`.session-tab[data-id="${id}"]`)!;
const plus = (id: string) => tab(id).querySelector<HTMLElement>('.tab-new')!;
const picker = () => document.querySelector<HTMLElement>('[role="menu"][aria-label="New session here"]');
/** Each entry as [logo slot classes, visible text, button classes]. */
const entries = () =>
  [...(picker()?.querySelectorAll('button') || [])].map((button) => [
    button.querySelector('.run-mode-dot')?.className,
    button.textContent,
    button.className,
  ]);
const openFrom = (app: Record<string, any>, id: string) =>
  app.openTabNewSessionMenu({ preventDefault() {}, stopPropagation() {}, currentTarget: plus(id) }, id);
const pick = (label: string) =>
  [...picker()!.querySelectorAll<HTMLElement>('button')].find((button) => button.textContent === label)!.click();
const rowMenuLabels = () =>
  [...document.querySelectorAll('.tab-rail-action-menu:not(.tab-layout-group-action-menu) button')].map(
    (button) => button.textContent
  );
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  win.localStorage.clear();
  document.body.innerHTML = '';
  document.documentElement.className = '';
  win.__codemanCliCatalog = CATALOG;
  win.__codemanUser = { username: 'admin', role: 'admin', multiUser: false };
});

afterEach(() => {
  current?.closeTabGroupMenu();
  current?.closeTabRailActionMenu();
  current = null;
});

describe('the tab "+" picker', () => {
  it('lists the CLIs the case can start as logo + name, agents in catalog order, the shell last', () => {
    const app = makeApp();
    // The markup wires the "+" to this picker for its own tab.
    expect(plus('a').getAttribute('onclick')).toBe('event.stopPropagation(); app.openTabNewSessionMenu(event, "a")');
    expect(openFrom(app, 'a')).toBe(true);
    // gemini is not on this host and pi is disabled in the catalog.
    expect(entries()).toEqual([
      ['run-mode-dot claude', 'Claude Code', 'run-mode-option'],
      ['run-mode-dot codex', 'Codex', 'run-mode-option selected'],
      ['run-mode-dot shell', 'Terminal / Shell', 'run-mode-option'],
    ]);
    for (const dot of picker()!.querySelectorAll('.run-mode-dot')) expect(dot.getAttribute('aria-hidden')).toBe('true');
    // The Run button's mode is the one preselected for the keyboard.
    expect(document.activeElement?.textContent).toBe('Codex');
  });

  it("a Docker case offers the container's CLIs through the Run menu's rule, never the host's", () => {
    const app = makeApp();
    // Adopted, not probed yet: the list stored at adoption (gemini, which the host lacks; no claude, which it has).
    openFrom(app, 'c');
    expect(entries()).toEqual([
      ['run-mode-dot gemini', 'Gemini CLI', 'run-mode-option'],
      ['run-mode-dot shell', 'Terminal / Shell', 'run-mode-option'],
    ]);
    app.closeTabGroupMenu();
    // A live probe wins over the stored list.
    app._dockerCaseModes = { box: ['claude', 'shell'] };
    openFrom(app, 'c');
    expect(entries()).toEqual([
      ['run-mode-dot claude', 'Claude Code', 'run-mode-option'],
      ['run-mode-dot shell', 'Terminal / Shell', 'run-mode-option'],
    ]);
    app.closeTabGroupMenu();
    // An unreadable adopted container offers no agent at all.
    app._dockerCaseProbeError = { box: 'Could not read container "box".' };
    openFrom(app, 'c');
    expect(entries()).toEqual([['run-mode-dot shell', 'Terminal / Shell', 'run-mode-option']]);
    app.closeTabGroupMenu();
    // An owned container with nothing probed is not gated: its image ships every CLI.
    openFrom(app, 'd');
    expect(entries()).toEqual([
      ['run-mode-dot claude', 'Claude Code', 'run-mode-option'],
      ['run-mode-dot codex', 'Codex', 'run-mode-option selected'],
      ['run-mode-dot gemini', 'Gemini CLI', 'run-mode-option'],
      ['run-mode-dot shell', 'Terminal / Shell', 'run-mode-option'],
    ]);
  });

  it("opening on a Docker tab whose container is not probed yet probes it, so the next open lists the container's CLIs", async () => {
    const app = makeApp();
    const probe = vi.spyOn(app, '_probeDockerCaseModes');
    const previousFetch = win.fetch;
    // The network boundary: what POST /api/docker-cases/adopt-preflight answers for this container.
    win.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ success: true, data: { ok: true, availableModes: ['codex', 'shell'] } }),
    }));
    try {
      probe.mockClear();
      win.fetch.mockClear();
      openFrom(app, 'c');
      // This open reads what is already known (the list stored at adoption) and starts the probe.
      expect(entries()).toEqual([
        ['run-mode-dot gemini', 'Gemini CLI', 'run-mode-option'],
        ['run-mode-dot shell', 'Terminal / Shell', 'run-mode-option'],
      ]);
      expect(probe).toHaveBeenCalledTimes(1);
      expect(probe.mock.calls[0][0]).toBe(CASES.find((c) => c.name === 'box'));
      expect(probe.mock.calls[0][1]).toBeNull();
      expect(win.fetch).toHaveBeenCalledTimes(1);
      const [url, init] = win.fetch.mock.calls[0];
      expect(url).toBe('/api/docker-cases/adopt-preflight');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toStrictEqual({ hostId: 'h1', container: 'box' });
      await flush();
      app.closeTabGroupMenu();

      // The next open lists what the container answered, and probes no more.
      probe.mockClear();
      win.fetch.mockClear();
      openFrom(app, 'c');
      expect(entries()).toEqual([
        ['run-mode-dot codex', 'Codex', 'run-mode-option selected'],
        ['run-mode-dot shell', 'Terminal / Shell', 'run-mode-option'],
      ]);
      expect(probe).not.toHaveBeenCalled();
      expect(win.fetch).not.toHaveBeenCalled();
      app.closeTabGroupMenu();

      // An owned container with nothing probed is probed as well.
      probe.mockClear();
      openFrom(app, 'd');
      expect(probe).toHaveBeenCalledTimes(1);
      expect(probe.mock.calls[0][0]).toBe(CASES.find((c) => c.name === 'own'));
      expect(probe.mock.calls[0][1]).toBeNull();
      await flush();
      app.closeTabGroupMenu();

      // Local, remote and worktree tabs have no container to ask.
      for (const id of ['a', 'g', 'r', 'f']) {
        probe.mockClear();
        win.fetch.mockClear();
        openFrom(app, id);
        expect(probe).not.toHaveBeenCalled();
        expect(win.fetch).not.toHaveBeenCalled();
        app.closeTabGroupMenu();
      }
    } finally {
      win.fetch = previousFetch;
    }
  });

  it('finds the case by what the session runs on, never a same-path case elsewhere', async () => {
    const app = makeApp();
    const runs: unknown[] = [];
    app.run = vi.fn(async (options: unknown) => {
      runs.push(structuredClone(options));
    });
    // A Docker session belongs to its container's case, not to the local case at the same path.
    openFrom(app, 'c');
    pick('Terminal / Shell');
    // A local session at that path belongs to the local case, never the Docker one.
    openFrom(app, 'g');
    expect(entries().map(([, text]) => text)).toEqual(['Claude Code', 'Codex', 'Terminal / Shell']);
    pick('Terminal / Shell');
    // A remote session belongs to the case on its own host, by path prefix.
    openFrom(app, 'r');
    pick('Terminal / Shell');
    // A local session in a case inside another case belongs to the inner one.
    openFrom(app, 'n');
    pick('Terminal / Shell');
    await flush();
    expect(runs).toStrictEqual([
      { count: 1, caseName: 'box', mode: 'shell' },
      { count: 1, caseName: 'clash', mode: 'shell' },
      { count: 1, caseName: 'rem', mode: 'shell' },
      { count: 1, caseName: 'nested', mode: 'shell' },
    ]);
  });

  it('a tab whose folder is no case says so and opens nothing', () => {
    const app = makeApp();
    expect(openFrom(app, 'e')).toBe(false);
    expect(picker()).toBeNull();
    expect(app.showToast).toHaveBeenCalledWith(
      "This tab's folder is not a case, so there is nothing to start beside it.",
      'info'
    );
  });
});

describe('the "+" from the keyboard', () => {
  /**
   * Wire the "+"'s inline keydown handler the way a browser wires an on* attribute
   * (the attribute's text as the body of a function of `event`, `this` the
   * element, `app` the page's global), since this JSDOM does not run inline handlers.
   */
  function wireInlineKeydown(app: Record<string, any>, el: HTMLElement) {
    win.app = app;
    const body = el.getAttribute('onkeydown');
    expect(body).not.toBeNull();
    const handler = new win.Function('event', body);
    el.addEventListener('keydown', function (this: HTMLElement, event: Event) {
      handler.call(this, event);
    });
  }
  const press = (el: HTMLElement, key: string) => {
    const event = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    el.dispatchEvent(event);
    return event;
  };

  it('Enter and Space on the header strip\'s "+" open its picker, and the key goes no further', () => {
    const app = makeApp({ orientation: 'horizontal' });
    const strip = document.getElementById('sessionTabs')!;
    // The header strip: a flat tablist, no row menu to fall back on.
    expect(strip.getAttribute('role')).toBe('tablist');
    const open = vi.spyOn(app, 'openTabNewSessionMenu');
    const reachedStrip = vi.fn();
    strip.addEventListener('keydown', reachedStrip);
    wireInlineKeydown(app, plus('a'));
    for (const key of ['Enter', ' ']) {
      open.mockClear();
      reachedStrip.mockClear();
      const event = press(plus('a'), key);
      expect(open).toHaveBeenCalledTimes(1);
      expect(open.mock.calls[0][0]).toBe(event);
      expect(open.mock.calls[0][1]).toBe('a');
      expect(event.defaultPrevented).toBe(true);
      expect(reachedStrip).not.toHaveBeenCalled();
      expect(entries()).toEqual([
        ['run-mode-dot claude', 'Claude Code', 'run-mode-option'],
        ['run-mode-dot codex', 'Codex', 'run-mode-option selected'],
        ['run-mode-dot shell', 'Terminal / Shell', 'run-mode-option'],
      ]);
      // Anchored on the "+" itself; Escape gives focus back to its tab row (the shared menu's design).
      expect(app._tabGroupMenuTrigger).toBe(plus('a'));
      app.closeTabGroupMenu();
    }
    strip.removeEventListener('keydown', reachedStrip);
  });

  it('on a tab whose folder is no case the key still stops at the "+", so Space does not scroll the page', () => {
    const app = makeApp({ orientation: 'horizontal' });
    const strip = document.getElementById('sessionTabs')!;
    const reachedStrip = vi.fn();
    strip.addEventListener('keydown', reachedStrip);
    wireInlineKeydown(app, plus('e'));
    app.showToast.mockClear();
    const event = press(plus('e'), ' ');
    expect(event.defaultPrevented).toBe(true);
    expect(reachedStrip).not.toHaveBeenCalled();
    expect(picker()).toBeNull();
    expect(app.showToast).toHaveBeenCalledWith(
      "This tab's folder is not a case, so there is nothing to start beside it.",
      'info'
    );
    strip.removeEventListener('keydown', reachedStrip);
  });

  it('every other key leaves the "+" alone and reaches the strip as before', () => {
    const app = makeApp({ orientation: 'horizontal' });
    const strip = document.getElementById('sessionTabs')!;
    const open = vi.spyOn(app, 'openTabNewSessionMenu');
    const reachedStrip = vi.fn();
    strip.addEventListener('keydown', reachedStrip);
    wireInlineKeydown(app, plus('a'));
    for (const key of ['a', 'ArrowRight', 'ArrowDown', 'Escape', 'Tab', 'F2']) {
      open.mockClear();
      reachedStrip.mockClear();
      const event = press(plus('a'), key);
      expect(open).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
      expect(reachedStrip).toHaveBeenCalledTimes(1);
      expect(picker()).toBeNull();
    }
    strip.removeEventListener('keydown', reachedStrip);
  });

  it('a held Enter or Space that opened the picker cannot also pick its focused entry', async () => {
    const app = makeApp({ orientation: 'horizontal' });
    const runs: unknown[] = [];
    app.run = vi.fn(async (options: unknown) => {
      runs.push(structuredClone(options));
    });
    wireInlineKeydown(app, plus('a'));
    for (const key of ['Enter', ' ']) {
      press(plus('a'), key);
      const focused = document.activeElement as HTMLElement;
      expect(focused.textContent).toBe('Codex');
      // The key's auto-repeat lands on the entry the picker just focused: its
      // native activation is cancelled, so nothing launches and the picker stays.
      const repeat = new win.KeyboardEvent('keydown', { key, repeat: true, bubbles: true, cancelable: true });
      focused.dispatchEvent(repeat);
      expect(repeat.defaultPrevented).toBe(true);
      expect(picker()).not.toBeNull();
      // A fresh press on an entry keeps its native activation.
      const fresh = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
      focused.dispatchEvent(fresh);
      expect(fresh.defaultPrevented).toBe(false);
      app.closeTabGroupMenu();
    }
    // Other repeated keys keep their own handling (ArrowDown still moves).
    press(plus('a'), 'Enter');
    const arrow = new win.KeyboardEvent('keydown', { key: 'ArrowDown', repeat: true, bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(arrow);
    expect(arrow.defaultPrevented).toBe(true);
    expect(document.activeElement?.textContent).toBe('Terminal / Shell');
    app.closeTabGroupMenu();
    await flush();
    expect(runs).toStrictEqual([]);
  });
});

describe('a pick from the "+"', () => {
  function recordRuns(app: Record<string, any>) {
    const runs: Array<{ options: unknown; runMode: string }> = [];
    app.run = vi.fn(async (options: unknown) => {
      // Cloned into this realm, so toStrictEqual compares keys and values, not JSDOM's prototypes.
      runs.push({ options: structuredClone(options), runMode: app._runMode });
    });
    return runs;
  }

  it("starts ONE session in the tab's case and named group, then leaves the Run mode and case alone", async () => {
    const app = makeApp();
    const runs = recordRuns(app);
    app.collapsedTabGroupIds.add('gx');
    openFrom(app, 'b');
    pick('Claude Code');
    await flush();
    // Its group is opened, so the new tab is visible when it arrives.
    expect(app.collapsedTabGroupIds.has('gx')).toBe(false);
    // The mode rides the launch; the Run button's own mode is never swapped.
    expect(runs).toStrictEqual([
      { options: { count: 1, caseName: 'proj', tabGroupId: 'gx', mode: 'claude' }, runMode: 'codex' },
    ]);
    expect(picker()).toBeNull();
    expect(app._runMode).toBe('codex');
    expect((document.getElementById('quickStartCase') as HTMLSelectElement).value).toBe('toolbar-case');
  });

  it('from an ungrouped tab it sends no group at all, so the case default group can place it', async () => {
    const app = makeApp();
    const runs = recordRuns(app);
    openFrom(app, 'a');
    pick('Terminal / Shell');
    await flush();
    expect(runs).toStrictEqual([{ options: { count: 1, caseName: 'proj', mode: 'shell' }, runMode: 'codex' }]);
  });

  it('from a tab in a managed worktree it starts in that worktree, not the case folder', async () => {
    const app = makeApp();
    const runs = recordRuns(app);
    openFrom(app, 'f');
    pick('Codex');
    await flush();
    expect(runs).toStrictEqual([
      {
        options: {
          count: 1,
          worktree: { caseName: 'proj', name: 'feat', path: '/tmp/proj/.claude/worktrees/feat' },
          mode: 'codex',
        },
        runMode: 'codex',
      },
    ]);
  });

  it('refuses while another launch is in flight, and says so', async () => {
    const app = makeApp();
    const runs = recordRuns(app);
    openFrom(app, 'a');
    app._runInFlight = true;
    app.showToast.mockClear();
    pick('Codex');
    await flush();
    expect(runs).toEqual([]);
    expect(app.showToast).toHaveBeenCalledWith('A launch is already in progress', 'info');
    expect(app._runMode).toBe('codex');
  });

  it("a launch the server refuses reports the server's own error", async () => {
    const app = makeApp();
    app._runMode = 'claude';
    const posted: Array<{ url: string; body: unknown }> = [];
    win.fetch = vi.fn(async (url: string, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : undefined;
      posted.push({ url, body });
      const json = (value: unknown) => ({ ok: true, status: 200, json: async () => value });
      if (url === '/api/codex/status') return json({ success: true, data: { available: true, runnable: true } });
      if (url === '/api/quick-start') {
        return json({ success: false, error: 'Case "proj" has no free session slot', errorCode: 'CONFLICT' });
      }
      return json({ success: true, data: {} });
    });
    openFrom(app, 'a');
    app.showToast.mockClear();
    pick('Codex');
    await flush();
    expect(posted.find((req) => req.url === '/api/quick-start')?.body).toMatchObject({
      caseName: 'proj',
      mode: 'codex',
    });
    expect(app.showToast).toHaveBeenLastCalledWith('Case "proj" has no free session slot', 'error');
    expect(app._runMode).toBe('claude');
  });

  it('a Run mode chosen while the launch is pending is kept, on screen and on disk', async () => {
    const app = makeApp();
    app._applyRunMode = () => {};
    app._apiPut = vi.fn(async () => ({ success: true }));
    let finish: () => void = () => {};
    app.runShell = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    openFrom(app, 'a');
    pick('Terminal / Shell');
    await flush();
    expect(app.runShell).toHaveBeenCalledTimes(1);
    app.setRunMode('claude');
    finish();
    await flush();
    expect(app._runMode).toBe('claude');
    expect(win.localStorage.getItem('codeman_runMode')).toBe('claude');
    expect(app._apiPut).toHaveBeenCalledWith('/api/settings', { runMode: 'claude' });
  });

  /**
   * Readies a Claude launch with the shipping case-list reload and the server's
   * lastUsedCase at `lastUsedCase`; the returned wait resolves once that reload ran.
   */
  function useShippingCaseReload(app: Record<string, any>, lastUsedCase: string) {
    app._runMode = 'claude';
    app.getAdvisorSetting = () => undefined;
    app._onSessionCreated = () => {};
    delete app.loadQuickStartCases; // the shipping reload, not makeApp's no-op
    // The UI-only steps of the case list reload.
    for (const name of ['updateDirDisplayForCase', 'updateMobileCaseLabel', 'updateCasePickerInput'])
      app[name] = () => {};
    for (const name of ['renderCasePickerList', 'closeCasePicker', 'setupQuickStartCasePicker']) app[name] = () => {};
    win.fetch = vi.fn(async (url: string) => {
      const json = (value: unknown) => ({ ok: true, status: 200, json: async () => value });
      // quick-start saved the launched case as lastUsedCase (session-routes.ts).
      if (url === '/api/settings') return json({ success: true, data: { lastUsedCase } });
      if (url === '/api/cases') return json({ success: true, data: CASES });
      if (url.startsWith('/api/cases/')) {
        const record = CASES.find((c) => `/api/cases/${c.name}` === url);
        return json(record ? { success: true, data: record } : { success: false, errorCode: 'NOT_FOUND' });
      }
      if (url === '/api/quick-start')
        return json({ success: true, data: { sessionId: 'new1', session: { id: 'new1' } } });
      if (url === '/api/sessions') return json({ success: true, data: { session: { id: 'new1', name: 'w1' } } });
      return json({ success: true, data: {} });
    });
    return async () => {
      await vi.waitFor(() => expect(app.selectSession).toHaveBeenCalledWith('new1'));
      // The case list is reloaded after the launch (not awaited by it).
      await vi.waitFor(() => expect(win.fetch.mock.calls.map((call: unknown[]) => call[0])).toContain('/api/cases'));
      await flush();
    };
  }

  it.each([
    ['a remote Claude launch (quick-start)', 'rem', 'r'],
    ['a local Claude launch', 'proj', 'a'],
  ])("%s leaves the toolbar on its own case, though the server's lastUsedCase moved", async (_label, tabCase, id) => {
    const app = makeApp();
    const reloaded = useShippingCaseReload(app, tabCase);
    const select = document.getElementById('quickStartCase') as HTMLSelectElement;
    openFrom(app, id);
    pick('Claude Code');
    await reloaded();
    expect(select.value).toBe('toolbar-case');
  });

  // An earlier "+" launch through quick-start left lastUsedCase on the tab's case
  // (proj); a later Claude launch that names no case must not follow it there.
  it.each([
    [
      'a "+" Claude launch from a managed worktree tab',
      'horizontal',
      (app: Record<string, any>) => {
        openFrom(app, 'f');
        pick('Claude Code');
      },
    ],
    ['the toolbar Run with Claude', 'horizontal', (app: Record<string, any>) => app.run()],
    [
      'a group\'s "New session" with Claude',
      'vertical',
      (app: Record<string, any>) => app.createSessionInTabGroup('gx'),
    ],
  ])('%s keeps the toolbar on its own case after a "+" moved lastUsedCase', async (_label, orientation, launch) => {
    const app = makeApp({ orientation });
    const reloaded = useShippingCaseReload(app, 'proj');
    const select = document.getElementById('quickStartCase') as HTMLSelectElement;
    (document.getElementById('tabCount') as HTMLInputElement).value = '1';
    void launch(app);
    await reloaded();
    expect(select.value).toBe('toolbar-case');
  });
});

describe('"New session here…" in the row menu', () => {
  const rowMenu = (app: Record<string, any>, trigger: HTMLElement, id: string) =>
    app.openTabRailActionMenu({ preventDefault() {}, stopPropagation() {}, currentTarget: trigger }, id);

  it('is offered on a session row only while the "+" is switched on, and opens the same picker', () => {
    const app = makeApp({ orientation: 'vertical' });
    rowMenu(app, tab('a'), 'a');
    expect(rowMenuLabels()).toEqual([
      'Session options',
      'Add to Focus',
      'Move down',
      'Move to "Core"',
      'Move to new group',
      'Close session',
    ]);
    app.closeTabRailActionMenu();

    document.documentElement.classList.add('tabs-show-new');
    rowMenu(app, tab('a'), 'a');
    expect(rowMenuLabels()).toEqual([
      'Session options',
      'New session here…',
      'Add to Focus',
      'Move down',
      'Move to "Core"',
      'Move to new group',
      'Close session',
    ]);
    [...document.querySelectorAll<HTMLElement>('.tab-rail-action-menu button')]
      .find((button) => button.textContent === 'New session here…')!
      .click();
    expect(rowMenuLabels()).toEqual([]);
    expect(entries().map(([, text]) => text)).toEqual(['Claude Code', 'Codex', 'Terminal / Shell']);
    // Escape gives the keyboard back to the tab row.
    document.activeElement!.dispatchEvent(
      new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    );
    expect(picker()).toBeNull();
    expect(document.activeElement).toBe(tab('a'));
  });

  it("is never offered on a tile's menu, which shares the function", () => {
    const app = makeApp({ orientation: 'vertical' });
    document.documentElement.classList.add('tabs-show-new');
    const tileButton = document.createElement('button');
    tileButton.className = 'tile-menu';
    document.body.appendChild(tileButton);
    rowMenu(app, tileButton, 'a');
    expect(rowMenuLabels()).toEqual([
      'Session options',
      'Add to Focus',
      'Move down',
      'Move to "Core"',
      'Move to new group',
      'Close session',
    ]);
  });
});

describe('picker lifetime', () => {
  it('a full re-render closes it and drops its document listeners', () => {
    const app = makeApp();
    openFrom(app, 'a');
    expect(picker()).not.toBeNull();
    app.sessions.delete('a');
    app._fullRenderSessionTabs();
    expect(picker()).toBeNull();
    expect(app._tabGroupMenuOutside).toBeNull();
    expect(app._tabGroupMenuKeydown).toBeNull();
    expect(app._tabGroupMenuResize).toBeNull();
  });

  it('pressing the same "+" again closes it, like the row menu', () => {
    const app = makeApp();
    openFrom(app, 'a');
    expect(openFrom(app, 'a')).toBe(false);
    expect(picker()).toBeNull();
  });
});

describe('showTabNewButton stays per-device and OFF by default', () => {
  const settingsUi = read('settings-ui.js');
  const index = read('index.html');

  it('is a display key, stripped from the settings PUT, which would refuse it', () => {
    const start = settingsUi.indexOf('const displayKeys = new Set([');
    expect(settingsUi.slice(start, settingsUi.indexOf('])', start))).toContain("'showTabNewButton'");
    expect(settingsUi).toContain('showTabNewButton: _tnb,');
    expect(SettingsUpdateSchema.safeParse({ showTabNewButton: true }).success).toBe(false);
  });

  it('loads OFF unless switched on, saves from its switch, and drives the class the CSS reads', () => {
    expect(settingsUi).toContain(
      "document.getElementById('appSettingsShowTabNewButton').checked = settings.showTabNewButton === true;"
    );
    expect(settingsUi).toContain("showTabNewButton: document.getElementById('appSettingsShowTabNewButton').checked,");
    expect(settingsUi).toContain(
      "document.documentElement.classList.toggle('tabs-show-new', settings.showTabNewButton === true);"
    );
    expect(index).toContain('<input type="checkbox" id="appSettingsShowTabNewButton">');
  });

  it('translates every string it adds', () => {
    const i18n = read('i18n.js');
    for (const text of [
      "'New session here'",
      "'New session here…'",
      '"New session in this tab\'s case"',
      '"This tab\'s folder is not a case, so there is nothing to start beside it."',
      "'New Session Button on Tabs'",
      "'A + on the tab that starts a session in the same case and group, in any installed CLI.'",
    ]) {
      expect(i18n).toContain(`${text}:`);
    }
  });
});
