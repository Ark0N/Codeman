/**
 * @fileoverview The Focus section of the vertical rail, driven through the shipping CodemanApp.
 *
 * A ref flagged `focus: true` gets a SHORTCUT in a "Focus" section pinned above
 * the rail's list; the row itself stays in its group. Pinned here:
 *  - the section is its own element in #tabRail, above #sessionTabs, on the
 *    grouped AND the flat rail, and absent off the vertical rail;
 *  - shortcuts are not rows: no `.session-tab`, no Alt+N badge, no tree item,
 *    so the badges, the tree's single tab stop, the row count and drag are
 *    exactly what they were, and no id is duplicated;
 *  - a click selects the tab; the selected tab's shortcut is aria-current;
 *  - "Add to Focus" / "Remove from Focus" in the row and web-tab menus send
 *    one `setFocus` through the edit coordinator (whole-layout PUT);
 *  - per-device collapse, a list keyboard model with one tab stop, a gone
 *    session dropping out, and a flag changed elsewhere repainting the section;
 *  - the new strings translate to zh-CN.
 *
 * Port: none (JSDOM, stubbed fetch).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = join(process.cwd(), 'src/web/public');
const read = (name: string) => readFileSync(join(PUBLIC, name), 'utf8');

type Ref = { kind: 'session' | 'webview'; id: string; placement?: 'manual'; focus?: true };
type Layout = {
  version: number;
  updatedAt: string;
  groups: Array<{ id: string; name: string; refs: Ref[] }>;
  ungrouped: Ref[];
};

let CodemanApp: { prototype: Record<string, any> };
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
      read('constants.js') +
      '\n' +
      read('tab-layout-browser.js') +
      '\n' +
      read('app.js') +
      '\n' +
      read('tab-rail-resize.js') +
      '\n' +
      read('api-client.js') +
      '\n' +
      read('webview-tabs.js') +
      '\n;window.__FocusCodemanApp = CodemanApp;'
  );
  CodemanApp = win.__FocusCodemanApp;
});

const s = (id: string, extra: Partial<Ref> = {}): Ref => ({ kind: 'session', id, ...extra });
const w = (id: string, extra: Partial<Ref> = {}): Ref => ({ kind: 'webview', id, ...extra });

const grouped = (version = 8): Layout => ({
  version,
  updatedAt: '2026-10-09T00:00:00.000Z',
  groups: [
    { id: 'gx', name: 'Core', refs: [s('s2', { focus: true }), w('w1', { focus: true })] },
    { id: 'gy', name: 'Later', refs: [] },
  ],
  ungrouped: [s('s1'), s('s3', { focus: true })],
});
const flat = (version = 8): Layout => ({
  version,
  updatedAt: '2026-10-09T00:00:00.000Z',
  groups: [],
  ungrouped: [s('s1'), s('s2', { focus: true }), s('s3'), w('w1')],
});

function installFetch() {
  const puts: any[] = [];
  win.fetch = vi.fn(async (_url: string, init: any) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    if (init?.method === 'PUT') puts.push(body);
    const payload = { success: true, data: { layout: { ...body?.layout, version: (body?.baseVersion ?? 0) + 1 } } };
    return { ok: true, status: 200, json: async () => payload };
  });
  return puts;
}

function makeApp(layout: Layout | null = grouped(), orientation = 'vertical') {
  const app = Object.create(CodemanApp.prototype) as Record<string, any>;
  document.documentElement.setAttribute('data-tab-orientation', orientation);
  document.documentElement.dataset.tabRailSort = 'manual';
  document.body.innerHTML =
    '<aside class="tab-rail" id="tabRail"><div id="tabRailResizeHandle"></div>' +
    '<div id="sessionTabs" class="session-tabs" role="tablist" aria-label="Session tabs"></div></aside>';
  app.$ = (id: string) => document.getElementById(id);
  app.sessions = new Map([
    ['s1', { id: 's1', name: 'One', status: 'idle' }],
    ['s2', { id: 's2', name: 'Two <b>', status: 'busy' }],
    ['s3', { id: 's3', name: 'Three', status: 'idle' }],
  ]);
  app.sessionOrder = ['s1', 's2', 's3'];
  app.webviews = new Map([['w1', { id: 'w1', name: 'Dashboard', url: 'https://example.test' }]]);
  app.webviewOrder = ['w1'];
  app.activeSessionId = 's2';
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
  app.updateConnectionLines = vi.fn();
  app._applyTabEntrances = () => {};
  app._scrollActiveTabIntoView = () => {};
  app._refreshMobileOverviewIfVisible = () => {};
  app._refreshHomeSessionsIfVisible = () => {};
  app.applySidebarFilter = () => {};
  app.isSessionSidebarActive = () => false;
  app._startSidebarRichClock = () => {};
  app._stopSidebarRichClock = () => {};
  app.loadAppSettingsFromStorage = () => ({});
  app.openSessionOptions = vi.fn();
  app.requestCloseSession = vi.fn();
  app.selectSession = vi.fn();
  app.openWebview = vi.fn();
  app.showWebviewModal = vi.fn();
  app.showToast = vi.fn();
  app._fullRenderSessionTabs();
  if (layout) app._applyTabLayout(layout);
  return app;
}

const section = () => document.getElementById('tabFocus');
const shortcuts = () => [...document.querySelectorAll<HTMLButtonElement>('#tabFocus .tab-focus-item')];
const shortcutKeys = () => shortcuts().map((item) => item.dataset.focusKey);
const rows = () =>
  [...document.querySelectorAll<HTMLElement>('#sessionTabs .session-tab')].map(
    (tab) => tab.dataset.webviewId || tab.dataset.id
  );
const badges = () =>
  [...document.querySelectorAll<HTMLElement>('#sessionTabs .session-tab')].map(
    (tab) => tab.querySelector('.tab-number')?.textContent ?? null
  );
const menuLabels = () => [...document.querySelectorAll('.tab-rail-action-menu button')].map((b) => b.textContent);
const clickMenu = (label: string) =>
  [...document.querySelectorAll<HTMLElement>('.tab-rail-action-menu button')]
    .find((b) => b.textContent === label)!
    .click();
const row = (id: string) => document.querySelector<HTMLElement>(`#sessionTabs .session-tab[data-id="${id}"]`)!;
const key = (target: Element, k: string) =>
  target.dispatchEvent(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const focusedIn = (layout: Layout) =>
  [...layout.groups.flatMap((g) => g.refs), ...layout.ungrouped]
    .filter((ref) => ref.focus === true)
    .map((ref) => `${ref.kind}:${ref.id}`);

beforeEach(() => {
  win.localStorage.clear();
  win.sessionStorage.clear();
  document.body.innerHTML = '';
  win.__codemanUser = { username: 'admin', role: 'admin', multiUser: false };
  installFetch();
});

afterEach(() => {
  document.querySelectorAll('.tab-rail-action-menu').forEach((menu) => menu.remove());
});

describe('the Focus section', () => {
  it('draws shortcuts in stored order in its own section above the grouped list', () => {
    makeApp();
    const host = section()!;
    expect(host.hidden).toBe(false);
    expect(host.parentElement!.id).toBe('tabRail');
    expect(host.nextElementSibling!.id).toBe('sessionTabs');
    expect(shortcutKeys()).toEqual(['session:s2', 'webview:w1', 'session:s3']);
    expect(shortcuts().map((item) => item.textContent)).toEqual(['Two <b>', 'Dashboard', 'Three']);
    expect(document.getElementById('tabFocusToggle')!.textContent).toBe('Focus3');
    expect(document.getElementById('tabFocusList')!.getAttribute('aria-labelledby')).toBe('tabFocusTitle');
  });

  it('leaves the rows, Alt+N badges, tree and drag exactly as without Focus', () => {
    const plainApp = makeApp({
      ...grouped(),
      groups: grouped().groups.map((g) => ({ ...g, refs: g.refs.map(({ focus: _f, ...ref }) => ref) })),
      ungrouped: [s('s1'), s('s3')],
    });
    const before = { rows: rows(), badges: badges(), html: document.getElementById('sessionTabs')!.innerHTML };
    expect(section()?.hidden ?? true).toBe(true);
    plainApp._tabLayoutEditor?.dispose();
    makeApp();
    expect(rows()).toEqual(before.rows);
    expect(badges()).toEqual(before.badges);
    expect(document.getElementById('sessionTabs')!.innerHTML).toBe(before.html);
    // Shortcuts are not rows and not tree items.
    expect(
      document.querySelectorAll('#tabFocus .session-tab, #tabFocus [role="treeitem"], #tabFocus .tab-number')
    ).toHaveLength(0);
    expect(document.getElementById('sessionTabs')!.getAttribute('role')).toBe('tree');
    expect(document.querySelectorAll('#sessionTabs [role="treeitem"][tabindex="0"]')).toHaveLength(1);
    // One tab stop in the Focus list too, and no id appears twice on the page.
    expect(shortcuts().filter((item) => item.tabIndex === 0)).toHaveLength(1);
    const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
    expect(ids.length).toBe(new Set(ids).size);
    expect(shortcuts().every((item) => item.getAttribute('draggable') !== 'true')).toBe(true);
  });

  it('shows above the FLAT rail too, which stays a plain tablist', () => {
    makeApp(flat());
    expect(document.getElementById('sessionTabs')!.getAttribute('role')).toBe('tablist');
    expect(rows()).toEqual(['s1', 's2', 's3', 'w1']);
    expect(shortcutKeys()).toEqual(['session:s2']);
    expect(section()!.hidden).toBe(false);
  });

  it('is absent off the vertical rail and with no layout', () => {
    makeApp(grouped(), 'horizontal');
    expect(section()?.hidden ?? true).toBe(true);
    expect(shortcuts()).toHaveLength(0);
    makeApp(null);
    expect(section()?.hidden ?? true).toBe(true);
  });

  it('a click selects the tab, and the selected tab shortcut is aria-current', () => {
    const app = makeApp();
    expect(shortcuts().map((item) => item.getAttribute('aria-current'))).toEqual(['true', 'false', 'false']);
    shortcuts()[2].click();
    expect(app.selectSession).toHaveBeenCalledWith('s3', { forceReload: true });
    shortcuts()[1].click();
    expect(app.openWebview).toHaveBeenCalledWith('w1');
    app.activeSessionId = 's3';
    app._updateActiveTabImmediate('s3');
    expect(shortcuts().map((item) => item.getAttribute('aria-current'))).toEqual(['false', 'false', 'true']);
    app.activeWebviewId = 'w1';
    app._updateActiveWebviewTab();
    expect(shortcuts().map((item) => item.getAttribute('aria-current'))).toEqual(['false', 'true', 'false']);
  });

  it('carries the tab status and alert onto the shortcut', () => {
    const app = makeApp();
    expect(shortcuts()[0].querySelector('.tab-status')!.className).toBe('tab-status busy');
    app.tabAlerts.set('s3', 'action');
    app._renderSessionTabsImmediate();
    expect(shortcuts()[2].classList.contains('tab-alert-action')).toBe(true);
  });

  it('a closed session drops out harmlessly, and the section hides when nothing is left', () => {
    const app = makeApp(flat());
    app.sessions.delete('s2');
    app.sessionOrder = ['s1', 's3'];
    app._renderSessionTabsImmediate();
    expect(shortcuts()).toHaveLength(0);
    expect(section()!.hidden).toBe(true);
  });

  it('repaints when another device changes a flag (not a structural change)', () => {
    const app = makeApp();
    app._applyTabLayout({ ...grouped(9), ungrouped: [s('s1', { focus: true }), s('s3')] });
    expect(shortcutKeys()).toEqual(['session:s2', 'webview:w1', 'session:s1']);
  });
});

describe('adding and removing', () => {
  it('row menu offers Add to Focus, and choosing it PUTs the whole layout with the flag', async () => {
    const puts = installFetch();
    const app = makeApp();
    app.openTabRailActionMenu({ preventDefault() {}, stopPropagation() {}, currentTarget: row('s1') }, 's1');
    expect(menuLabels()[1]).toBe('Add to Focus');
    clickMenu('Add to Focus');
    // Optimistic, and the row did not move.
    expect(shortcutKeys()).toEqual(['session:s2', 'webview:w1', 'session:s1', 'session:s3']);
    expect(rows()).toEqual(['s2', 'w1', 's1', 's3']);
    await flush();
    expect(puts).toHaveLength(1);
    expect(puts[0].baseVersion).toBe(8);
    expect(focusedIn(puts[0].layout)).toEqual(['session:s2', 'webview:w1', 'session:s1', 'session:s3']);
  });

  it('a focused row offers Remove from Focus', async () => {
    const puts = installFetch();
    const app = makeApp(flat());
    app.openTabRailActionMenu({ preventDefault() {}, stopPropagation() {}, currentTarget: row('s2') }, 's2');
    expect(menuLabels()).toEqual(['Session options', 'Remove from Focus', 'Move to new group', 'Close session']);
    clickMenu('Remove from Focus');
    await flush();
    expect(focusedIn(puts[0].layout)).toEqual([]);
    expect(section()!.hidden).toBe(true);
  });

  it('the strip menu (horizontal) has no Focus entry', () => {
    const app = makeApp(grouped(), 'horizontal');
    app.openTabRailActionMenu({ preventDefault() {}, stopPropagation() {}, currentTarget: row('s1') }, 's1');
    expect(menuLabels()).toEqual(['Session options', 'Close session']);
  });

  it('a web tab: right-click in the rail opens its menu with the Focus entry; elsewhere the native menu stays', async () => {
    const puts = installFetch();
    const app = makeApp(flat());
    const web = document.querySelector<HTMLElement>('#sessionTabs .session-tab[data-webview-id="w1"]')!;
    // The row markup wires the handler (inline handlers do not run under JSDOM;
    // the Chromium test right-clicks for real).
    expect(web.getAttribute('oncontextmenu')).toBe('app.handleWebviewTabContextMenu(event, "w1")');
    const event = new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'currentTarget', { value: web });
    app.handleWebviewTabContextMenu(event, 'w1');
    expect(event.defaultPrevented).toBe(true);
    expect(menuLabels()).toEqual(['Web tab settings', 'Add to Focus', 'Move to new group']);
    clickMenu('Add to Focus');
    await flush();
    expect(focusedIn(puts[0].layout)).toEqual(['session:s2', 'webview:w1']);

    const strip = makeApp(flat(), 'horizontal');
    const native = new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    expect(strip.handleWebviewTabContextMenu(native, 'w1')).toBe(false);
    expect(native.defaultPrevented).toBe(false);
    expect(document.querySelectorAll('.tab-rail-action-menu')).toHaveLength(0);
  });

  it('right-click on a shortcut offers Remove from Focus only', async () => {
    const puts = installFetch();
    makeApp();
    shortcuts()[0].dispatchEvent(new win.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    expect(menuLabels()).toEqual(['Remove from Focus']);
    clickMenu('Remove from Focus');
    await flush();
    expect(focusedIn(puts[0].layout)).toEqual(['webview:w1', 'session:s3']);
    // The real row is still there, in its group.
    expect(row('s2').closest('.tab-layout-group')!.getAttribute('data-tab-group-id')).toBe('gx');
  });
});

describe('collapse and keyboard', () => {
  it('collapse is per-device, survives a reload, and is not a group id', () => {
    const app = makeApp();
    document.getElementById('tabFocusToggle')!.click();
    expect(document.getElementById('tabFocusList')!.hidden).toBe(true);
    expect(document.getElementById('tabFocusToggle')!.getAttribute('aria-expanded')).toBe('false');
    expect(win.localStorage.getItem('codeman:tab-focus-collapsed')).toBe('true');
    expect(JSON.parse(win.localStorage.getItem('codeman:tab-groups-collapsed') || '[]')).toEqual([]);
    expect(app.collapsedTabGroupIds.size).toBe(0);
    makeApp();
    expect(document.getElementById('tabFocusList')!.hidden).toBe(true);
    document.getElementById('tabFocusToggle')!.click();
    expect(document.getElementById('tabFocusList')!.hidden).toBe(false);
  });

  it('Up/Down/Home/End walk the shortcuts with one tab stop; the tree is untouched', () => {
    makeApp();
    const treeStop = document.querySelector('#sessionTabs [role="treeitem"][tabindex="0"]');
    shortcuts()[0].focus();
    key(shortcuts()[0], 'ArrowDown');
    expect(document.activeElement).toBe(shortcuts()[1]);
    key(shortcuts()[1], 'End');
    expect(document.activeElement).toBe(shortcuts()[2]);
    key(shortcuts()[2], 'ArrowDown');
    expect(document.activeElement).toBe(shortcuts()[0]);
    key(shortcuts()[0], 'ArrowUp');
    expect(document.activeElement).toBe(shortcuts()[2]);
    expect(shortcuts().map((item) => item.tabIndex)).toEqual([-1, -1, 0]);
    expect(document.querySelector('#sessionTabs [role="treeitem"][tabindex="0"]')).toBe(treeStop);
  });

  it('keeps keyboard focus on the same shortcut across a repaint', () => {
    const app = makeApp();
    shortcuts()[1].focus();
    app.tabAlerts.set('s2', 'idle');
    app._renderSessionTabsImmediate();
    expect(document.activeElement).toBe(shortcuts()[1]);
  });
});

describe('zh-CN', () => {
  it('translates every Focus string, and leaves a shortcut name alone', () => {
    const I18N = read('i18n.js');
    const dom = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only',
      url: 'http://localhost/',
    });
    vm.runInContext(I18N, dom.getInternalVMContext(), { filename: 'i18n.js' });
    const api = (dom.window as any).CodemanI18n;
    api.configure({ language: 'zh-CN' });
    const strings = ['Focus', 'Add to Focus', 'Remove from Focus', 'Focus actions'];
    const untranslated = strings.filter((text) => api.t(text) === text || /[A-Za-z]/.test(api.t(text)));
    expect(untranslated).toEqual([]);
    // Each is in the dictionary exactly once (a repeated key silently wins).
    for (const text of strings) {
      const keyPattern = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect((I18N.match(new RegExp(`^\\s*(?:'${keyPattern}'|${keyPattern}):`, 'gm')) ?? []).length).toBe(1);
    }
    // The section in the live DOM: heading translated, the user's names not.
    makeApp();
    dom.window.document.body.innerHTML = section()!.outerHTML;
    api.start();
    const translated = dom.window.document.getElementById('tabFocusTitle')!.textContent;
    expect(translated).toBe('焦点');
    expect(
      [...dom.window.document.querySelectorAll('.tab-focus-item')].map((b: any) => b.getAttribute('aria-label'))
    ).toEqual(['Two <b>', 'Dashboard', 'Three']);
    dom.window.close();
  });
});
