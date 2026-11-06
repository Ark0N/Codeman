/**
 * @fileoverview Every agent tab shows its harness logo (claude included).
 *
 * What is pinned, and why it matters:
 *  - A session tab draws its CLI through PR #532's `run-mode-dot <id>` slot,
 *    the mode id as data, so the tab, the tile and split headers and the Run
 *    menus all draw the same mark. Claude used to get nothing at all and the
 *    other CLIs a two-letter text pill, so a claude tab read as "no harness".
 *  - The shell is not an agent and keeps its SH pill.
 *  - A CLI added through ~/.codeman/clis.json still gets the slot (its plain
 *    dot), and a mode string never reaches the markup unescaped.
 *  - Every stock agent CLI has a logo rule, so a new stock CLI cannot ship a
 *    tab that shows only the plain dot.
 *  - The desktop home rail mirrors the strip.
 *
 * The real modules run INSIDE a JSDOM window (runScripts: 'outside-only').
 *
 * Port: none.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';

const PUBLIC = join(process.cwd(), 'src/web/public');
const read = (name: string) => readFileSync(join(PUBLIC, name), 'utf8');

describe('session tab harness logo (app.js)', () => {
  let CodemanApp: { prototype: Record<string, any> };
  let window: any;
  let document: Document;

  beforeAll(async () => {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
      url: 'https://localhost/',
      runScripts: 'outside-only',
    });
    if (dom.window.document.readyState !== 'complete') {
      await new Promise((resolve) => dom.window.addEventListener('load', resolve));
    }
    window = dom.window;
    document = window.document;
    window.setInterval = () => 0;
    window.requestAnimationFrame = () => 0;
    window.CSS = { escape: (value: string) => value };
    window.eval(
      'var MobileDetection = { isTouchDevice: () => false, getDeviceType: () => "desktop" }, KeyboardHandler = {}, ' +
        'SwipeHandler = {}, VoiceInput = {}, DeepgramProvider = {}, NotificationManager = function(){};\n' +
        read('constants.js') +
        '\n' +
        read('tab-layout-browser.js') +
        '\n' +
        read('app.js') +
        '\n' +
        read('mobile-overview.js') +
        '\n' +
        read('home-sessions.js') +
        '\n' +
        read('webview-tabs.js') +
        '\n;window.__HarnessCodemanApp = CodemanApp;'
    );
    CodemanApp = window.__HarnessCodemanApp;
  });

  function makeApp(sessions: Array<Record<string, unknown>>) {
    const app = Object.create(CodemanApp.prototype) as Record<string, any>;
    const root = document.documentElement;
    root.setAttribute('data-tab-orientation', 'horizontal');
    root.dataset.tabRailSort = 'activity';
    root.dataset.tabArrangement = 'classic';
    document.body.innerHTML = '<div class="session-tabs-host"><div id="sessionTabs" class="session-tabs"></div></div>';
    app.$ = (id: string) => document.getElementById(id);
    app.cases = [];
    app.sessions = new Map(sessions.map((s) => [s.id as string, { status: 'idle', workingDir: '/c/x', ...s }]));
    app.sessionOrder = sessions.map((s) => s.id as string);
    app.pendingHooks = new Map();
    app.webviews = new Map();
    app.webviewOrder = [];
    app.activeSessionId = sessions[0]?.id ?? null;
    app.activeWebviewId = null;
    app.tabLayout = null;
    app.collapsedTabGroupIds = new Set();
    app._hiddenTabGroupByRef = new Map();
    app._lastTabGroupStructureKey = null;
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
    return app;
  }

  const tab = (id: string) => document.querySelector<HTMLElement>(`.session-tab[data-id="${id}"]`)!;

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('draws the logo slot for every agent CLI, claude included, and no text pill', () => {
    const agents = STOCK_CLIS.map((c) => c.id).filter((id) => id !== 'shell');
    makeApp(agents.map((mode) => ({ id: `s-${mode}`, name: `w1-${mode}`, mode })))._fullRenderSessionTabs();
    for (const mode of agents) {
      const logo = tab(`s-${mode}`).querySelector('.tab-name-row > .tab-harness');
      expect(logo, mode).not.toBeNull();
      expect(logo!.className, mode).toBe(`tab-harness run-mode-dot ${mode}`);
      expect(logo!.getAttribute('aria-hidden'), mode).toBe('true');
      expect(logo!.textContent, mode).toBe('');
      expect(tab(`s-${mode}`).querySelector('.tab-mode'), mode).toBeNull();
    }
  });

  it('treats a session with no mode as claude', () => {
    makeApp([{ id: 'legacy', name: 'w1-legacy' }])._fullRenderSessionTabs();
    expect(tab('legacy').querySelector('.tab-harness')?.className).toBe('tab-harness run-mode-dot claude');
  });

  it('keeps the SH pill for a shell, with no logo slot', () => {
    makeApp([{ id: 'sh', name: 'w1-shell', mode: 'shell' }])._fullRenderSessionTabs();
    const pill = tab('sh').querySelector('.tab-mode.shell');
    expect(pill?.textContent).toBe('sh');
    expect(tab('sh').querySelector('.tab-harness')).toBeNull();
  });

  it('gives a registry-added CLI the slot and escapes the mode string', () => {
    makeApp([
      { id: 'custom', name: 'w1-custom', mode: 'mycli' },
      { id: 'hostile', name: 'w1-hostile', mode: 'x"><img src=x onerror=1>' },
    ])._fullRenderSessionTabs();
    expect(tab('custom').querySelector('.tab-harness')?.className).toBe('tab-harness run-mode-dot mycli');
    expect(tab('hostile').querySelector('img')).toBeNull();
    expect(tab('hostile').querySelectorAll('.tab-name-row > .tab-harness')).toHaveLength(1);
  });

  it('mirrors the strip on the desktop home rail', () => {
    const app = makeApp([
      { id: 'c', name: 'w1-c', mode: 'claude' },
      { id: 'd', name: 'w1-d', mode: 'deepseek' },
      { id: 'sh', name: 'w1-sh', mode: 'shell' },
    ]);
    app._mobileOverviewCaseFor = () => null;
    app._mobileOverviewState = () => 'idle';
    const rows = app.buildHomeSessionRows();
    const titleOf = (id: string) =>
      app._buildHomeSessionRow(rows.find((r: any) => r.id === id)).querySelector('.home-sessions-row-title');
    expect(titleOf('c').querySelector('.home-sessions-harness')?.className).toBe(
      'home-sessions-harness run-mode-dot claude'
    );
    expect(titleOf('c').querySelector('.home-sessions-mode')).toBeNull();
    expect(titleOf('d').querySelector('.home-sessions-harness')?.className).toBe(
      'home-sessions-harness run-mode-dot deepseek'
    );
    expect(titleOf('sh').querySelector('.home-sessions-mode')?.textContent).toBe('sh');
    expect(titleOf('sh').querySelector('.home-sessions-harness')).toBeNull();
  });
});

describe('harness logo rules (styles.css)', () => {
  const css = read('styles.css');

  it('has a logo for every stock agent CLI', () => {
    for (const { id } of STOCK_CLIS) {
      expect(css, id).toMatch(new RegExp(`\\.run-mode-dot\\.${id} \\{ --run-mode-logo: url\\(`));
    }
  });

  it('no longer colours a per-CLI tab pill, and hides the logo while renaming', () => {
    expect(css).not.toMatch(/\.session-tab \.tab-mode\.(?!shell\b)[a-z]+/);
    expect(css).toMatch(/\.tab-mode,\s*\.tab-harness,\s*\.tab-exited-badge,/);
  });
});
