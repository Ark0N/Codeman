/**
 * @fileoverview CLI Logos on Tabs (`showTabCliLogos`): the per-device switch
 * that hides the agent logo on the session tabs and the desktop home rail.
 *
 * What is pinned, and why it matters:
 *  - The switch is a row in App Settings → Appearance → Tabs, right after Tall
 *    Tabs, and the REAL openAppSettings() / saveAppSettings() load and save it
 *    by its id. The load/save contract is getElementById by id, so a renamed
 *    control would otherwise just stop loading or saving, silently.
 *  - It is modelled on tabTwoRows: a display key in the server-settings merge
 *    (a phone never overwrites a desktop's choice) AND an optional boolean in
 *    the .strict() SettingsUpdateSchema (the save PUTs it; a key the schema did
 *    not declare would 400 the whole settings save).
 *  - Default ON on every device; only an explicit false turns it off.
 *  - The pre-paint script in index.html stamps `data-tab-logos` from the same
 *    stored blob, so a reload never flashes the logos it is about to hide, and
 *    a Save stamps it live through applyTabOrientation() without re-rendering
 *    the tabs (the logo spans are always in the markup; CSS hides them).
 *  - The CSS names exactly the tab logo and the home-rail logo. Tile and split
 *    headers, the Run menus and the welcome launchers keep theirs.
 *  - The row reads in Chinese under zh-CN.
 *
 * The real modules run INSIDE a JSDOM window (runScripts: 'outside-only').
 *
 * Port: none.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import postcss, { type Rule } from 'postcss';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsUpdateSchema } from '../src/web/schemas.js';

const PUBLIC = join(process.cwd(), 'src/web/public');
const read = (name: string) => readFileSync(join(PUBLIC, name), 'utf8');
const INDEX = read('index.html');
const STYLES = read('styles.css');
const MOBILE = read('mobile.css');
const I18N = read('i18n.js');
const SCRIPTS = ['constants.js', 'app.js', 'settings-ui.js'].map(read);

const DESKTOP_KEY = 'codeman-app-settings';
const PHONE_KEY = 'codeman-app-settings-mobile';

type Device = 'desktop' | 'mobile';
type Settings = Record<string, unknown>;
interface SettingsApp {
  openAppSettings(): void;
  saveAppSettings(): Promise<void>;
  loadAppSettingsFromServer(p: Promise<Settings>): Promise<Settings>;
  loadAppSettingsFromStorage(): Settings;
  getDefaultSettings(): Settings;
  tabCliLogosEnabled(s: Settings): boolean;
  applyTabOrientation(): void;
  _cachedAppSettings?: unknown;
  _apiPut: (path: string, body: Settings) => Promise<unknown>;
  _fullRenderSessionTabs: ReturnType<typeof vi.fn>;
  updateTabOverflowMode: ReturnType<typeof vi.fn>;
  _updateConnectionLinesImmediate: ReturnType<typeof vi.fn>;
}

/**
 * Methods that run for real. Every other method of the app is a no-op here:
 * openAppSettings() and saveAppSettings() fan out into the voice, webhook,
 * tunnel, model and push panels, none of which this setting touches, and the
 * load/save lines under test sit between those calls.
 */
const REAL = new Set([
  'openAppSettings',
  'saveAppSettings',
  'loadAppSettingsFromServer',
  'loadAppSettingsFromStorage',
  'saveAppSettingsToStorage',
  'getSettingsStorageKey',
  'getDefaultSettings',
  'tabCliLogosEnabled',
  'applyTabOrientation',
  'resolveTabArrangement',
  'resolveTabStateOrder',
  // Real so the save builds the body a browser would send (the schema check).
  'resolveHeaderStatsStyle',
  'resolveSessionSidebarFontSize',
]);

/**
 * Methods the load/save paths call that other modules add to the prototype
 * (terminal-ui.js, panels-ui.js, session-ui.js), which this harness does not
 * load. Stubbed as own properties.
 */
const ELSEWHERE = [
  'showToast',
  '_updateLocalEchoState',
  'renderProjectInsightsPanel',
  'updateSubagentWindowVisibility',
  'showWelcome',
  '_applyRunMode',
];

const windows: { close(): void }[] = [];
afterEach(() => {
  for (const win of windows.splice(0)) win.close();
});

/** The whole index.html with constants.js, app.js and settings-ui.js loaded into it. */
async function boot(device: Device = 'desktop', stored?: Settings) {
  const dom = new JSDOM(INDEX, { url: 'http://localhost/', runScripts: 'outside-only' });
  const win = dom.window as unknown as Window & typeof globalThis & { eval(src: string): void; __App: any };
  windows.push(win);
  // After load, so app.js's DOMContentLoaded boot (new CodemanApp(): SSE,
  // timers, the terminal) never runs; only the prototype is under test.
  if (win.document.readyState !== 'complete') await new Promise((resolve) => win.addEventListener('load', resolve));
  win.setInterval = (() => 0) as unknown as typeof win.setInterval;
  if (stored) win.localStorage.setItem(device === 'desktop' ? DESKTOP_KEY : PHONE_KEY, JSON.stringify(stored));
  win.eval(
    [
      `var MobileDetection = {
         getDeviceType: () => ${JSON.stringify(device)},
         isHandheldDevice: () => ${JSON.stringify(device)} !== 'desktop',
         isMobile: () => false,
         isTouchDevice: () => false,
       };
       var KeyboardHandler = {}, SwipeHandler = {}, DeepgramProvider = {}, NotificationManager = function () {};
       var KeyboardAccessoryBar = { setMode() {} };
       var VoiceInput = { _getDeepgramConfig: () => ({}), _saveDeepgramConfig() {}, refreshClaudeStatus: () => Promise.resolve() };
       var FocusTrap = function () { this.activate = () => {}; this.deactivate = () => {}; };
       var DEFAULT_VOICE_KEYTERMS = '';`,
      ...SCRIPTS,
      'window.__App = CodemanApp;',
    ].join('\n')
  );
  const target = Object.create(win.__App.prototype);
  target.sessions = new Map();
  target.sessionOrder = [];
  target._apiPut = vi.fn(async () => ({ ok: true }));
  target._fullRenderSessionTabs = vi.fn();
  target.updateTabOverflowMode = vi.fn();
  target._updateConnectionLinesImmediate = vi.fn();
  const noop = () => undefined;
  for (const name of ELSEWHERE) target[name] = noop;
  const app = new Proxy(target, {
    get(t, key, receiver) {
      const value = Reflect.get(t, key, receiver);
      const stubbed =
        typeof key === 'string' && typeof value === 'function' && !Object.hasOwn(t, key) && !REAL.has(key);
      return stubbed ? noop : value;
    },
  }) as SettingsApp;
  const doc = win.document;
  const checkbox = () => doc.getElementById('appSettingsShowTabCliLogos') as HTMLInputElement;
  const storedBlob = () =>
    JSON.parse(win.localStorage.getItem(device === 'desktop' ? DESKTOP_KEY : PHONE_KEY) || '{}') as Settings;
  return { win, doc, app, checkbox, storedBlob };
}

describe('the App Settings row', () => {
  const doc = new JSDOM(INDEX).window.document;
  const input = doc.getElementById('appSettingsShowTabCliLogos') as HTMLInputElement;
  const row = input?.closest('.set-row') as HTMLElement;

  it('is a switch in Appearance → Tabs (device scope), right after Tall Tabs', () => {
    expect(input?.type).toBe('checkbox');
    expect(input.parentElement!.matches('label.switch.switch-sm')).toBe(true);
    const group = row.closest('.set-group')!;
    expect(group.querySelector('.set-group-head h4')!.textContent).toBe('Tabs');
    expect(group.querySelector('.set-group-head .set-scope')!.textContent).toBe('device');
    expect(row.closest('.set-section')!.id).toBe('settings-appearance');
    expect(row.previousElementSibling!.querySelector('#appSettingsTabTwoRows')).not.toBeNull();
  });

  it('says what it shows, what stays, and what it does not touch', () => {
    expect(row.querySelector('.set-row-label')!.textContent).toBe('CLI Logos on Tabs');
    const desc = row.querySelector('.set-row-desc')!.textContent!;
    for (const part of ['logo', 'status dot', 'SH badge', 'Tiles', 'split headers', 'Run menus']) {
      expect(desc, part).toContain(part);
    }
  });

  it('is found by the settings search for logo, icon, harness, agent, cli, tab and hide', () => {
    const words = row.getAttribute('data-search')!.split(/\s+/);
    for (const word of ['logo', 'icon', 'harness', 'agent', 'cli', 'tab', 'hide']) expect(words, word).toContain(word);
  });
});

describe('load and save through settings-ui.js', () => {
  it('loads the stored value into the switch, and an absent key as on', async () => {
    for (const [stored, expected] of [
      [{ showTabCliLogos: false }, false],
      [{ showTabCliLogos: true }, true],
      [{}, true],
    ] as const) {
      const { app, checkbox } = await boot('desktop', stored);
      checkbox().checked = !expected;
      app.openAppSettings();
      expect(checkbox().checked, JSON.stringify(stored)).toBe(expected);
    }
  });

  it('saves the switch to this device and sends it in the settings PUT, which the schema accepts', async () => {
    const { app, checkbox, storedBlob } = await boot('desktop', {});
    app.openAppSettings();
    checkbox().checked = false;
    await app.saveAppSettings();
    expect(storedBlob().showTabCliLogos).toBe(false);
    expect(app._apiPut).toHaveBeenCalledTimes(1);
    const [path, body] = (app._apiPut as unknown as { mock: { calls: [string, Settings][] } }).mock.calls[0];
    expect(path).toBe('/api/settings');
    expect(body.showTabCliLogos).toBe(false);
    // The whole body, not just this key: an undeclared key 400s every save.
    expect(SettingsUpdateSchema.safeParse(body).error?.issues ?? []).toEqual([]);
  });

  it('a Save stamps the attribute live', async () => {
    const { app, checkbox, doc } = await boot('desktop', {});
    app.openAppSettings();
    checkbox().checked = false;
    await app.saveAppSettings();
    expect(doc.documentElement.dataset.tabLogos).toBe('off');
    checkbox().checked = true;
    await app.saveAppSettings();
    expect(doc.documentElement.dataset.tabLogos).toBe('on');
  });
});

describe('per-device like tabTwoRows', () => {
  it('is a display key: a server value only seeds a device that has none', async () => {
    // Local choice made: the server's value (another device's) never replaces it,
    // while a synced key in the same payload does (the merge really ran).
    const kept = await boot('desktop', { showTabCliLogos: true, autoNameSessions: false });
    const merged = await kept.app.loadAppSettingsFromServer(
      Promise.resolve({ showTabCliLogos: false, autoNameSessions: true })
    );
    expect(merged.showTabCliLogos).toBe(true);
    expect(merged.autoNameSessions).toBe(true);

    // A fresh device takes the server's value as its seed.
    const fresh = await boot('desktop');
    expect(
      (await fresh.app.loadAppSettingsFromServer(Promise.resolve({ showTabCliLogos: false }))).showTabCliLogos
    ).toBe(false);
  });

  it('is an optional boolean in SettingsUpdateSchema, and nothing else passes', () => {
    expect(SettingsUpdateSchema.safeParse({ showTabCliLogos: true }).success).toBe(true);
    expect(SettingsUpdateSchema.safeParse({ showTabCliLogos: false }).success).toBe(true);
    expect(SettingsUpdateSchema.safeParse({}).success).toBe(true);
    for (const bad of ['off', 'false', 0, 1, null, {}]) {
      expect(SettingsUpdateSchema.safeParse({ showTabCliLogos: bad }).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('defaults to on, on a desktop and on a phone', async () => {
    for (const device of ['desktop', 'mobile'] as const) {
      const { app, checkbox } = await boot(device);
      expect(app.tabCliLogosEnabled(app.loadAppSettingsFromStorage()), device).toBe(true);
      checkbox().checked = false;
      app.openAppSettings();
      expect(checkbox().checked, device).toBe(true);
    }
    // The phone's defaults blob carries it explicitly, like its other tab keys.
    expect((await boot('mobile')).app.getDefaultSettings().showTabCliLogos).toBe(true);
  });

  it('only an explicit false turns it off', async () => {
    const { app } = await boot();
    expect(app.tabCliLogosEnabled({ showTabCliLogos: false })).toBe(false);
    for (const value of [true, undefined, 'off', 0, null]) {
      expect(app.tabCliLogosEnabled({ showTabCliLogos: value }), String(value)).toBe(true);
    }
  });
});

describe('applyTabOrientation() stamps data-tab-logos without re-rendering', () => {
  async function settled(stored: Settings) {
    const booted = await boot('desktop', stored);
    booted.app.applyTabOrientation();
    for (const fn of [
      booted.app._fullRenderSessionTabs,
      booted.app.updateTabOverflowMode,
      booted.app._updateConnectionLinesImmediate,
    ]) {
      fn.mockClear();
    }
    const apply = (next: Settings) => {
      booted.win.localStorage.setItem(DESKTOP_KEY, JSON.stringify(next));
      delete booted.app._cachedAppSettings;
      booted.app.applyTabOrientation();
    };
    return { ...booted, apply };
  }

  it('flips the attribute and leaves the tab markup alone', async () => {
    const { doc, app, apply } = await settled({ showTabCliLogos: true });
    expect(doc.documentElement.dataset.tabLogos).toBe('on');
    apply({ showTabCliLogos: false });
    expect(doc.documentElement.dataset.tabLogos).toBe('off');
    expect(app._fullRenderSessionTabs).not.toHaveBeenCalled();
  });

  it('re-measures the strip wrap and re-anchors the lines on a flip, and only on a flip', async () => {
    // Every agent tab just got narrower (or wider) with no render behind it: the
    // one-row wrap decision and the lines drawn from tab rects are stale.
    const { app, apply } = await settled({ showTabCliLogos: true });
    apply({ showTabCliLogos: false });
    expect(app.updateTabOverflowMode).toHaveBeenCalledTimes(1);
    expect(app._updateConnectionLinesImmediate).toHaveBeenCalledTimes(1);

    apply({ showTabCliLogos: false });
    expect(app.updateTabOverflowMode).toHaveBeenCalledTimes(1);
    expect(app._updateConnectionLinesImmediate).toHaveBeenCalledTimes(1);

    apply({ showTabCliLogos: true });
    expect(app.updateTabOverflowMode).toHaveBeenCalledTimes(2);
    expect(app._updateConnectionLinesImmediate).toHaveBeenCalledTimes(2);
    expect(app._fullRenderSessionTabs).not.toHaveBeenCalled();
  });
});

describe('the pre-paint script in index.html', () => {
  // The layout one: there is an earlier inline script with the same opening.
  const PRE_PAINT =
    [...INDEX.matchAll(/<script>(try\{var m=window\.innerWidth[\s\S]*?)<\/script>/g)]
      .map((m) => m[1])
      .find((src) => src.includes('dataset.tabStateOrder')) ?? '';

  /**
   * Runs the real inline script in a fresh window as `device` (a phone is a
   * 393px viewport, the width test the script uses), with `blob` stored under
   * that device's key, or under `storeAs`'s key when given.
   */
  function prePaint(blob: string | null, device: Device = 'desktop', storeAs: Device = device) {
    const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
      url: 'http://localhost/',
      runScripts: 'outside-only',
    });
    const win = dom.window as unknown as Window & { eval(src: string): void };
    Object.defineProperty(win, 'innerWidth', { value: device === 'desktop' ? 1440 : 393, configurable: true });
    if (blob !== null) win.localStorage.setItem(storeAs === 'desktop' ? DESKTOP_KEY : PHONE_KEY, blob);
    win.eval(PRE_PAINT);
    return win.document.documentElement;
  }

  it('is found (the checks below are not vacuous)', () => {
    expect(PRE_PAINT).toContain('localStorage.getItem(k)');
  });

  it('stamps off from the stored setting, on a desktop and on a phone', () => {
    expect(prePaint(JSON.stringify({ showTabCliLogos: false })).dataset.tabLogos).toBe('off');
    expect(prePaint(JSON.stringify({ showTabCliLogos: false }), 'mobile').dataset.tabLogos).toBe('off');
  });

  it('leaves the logos on otherwise', () => {
    expect(prePaint(null).dataset.tabLogos).toBe('on');
    expect(prePaint('{}').dataset.tabLogos).toBe('on');
    expect(prePaint(JSON.stringify({ showTabCliLogos: true })).dataset.tabLogos).toBe('on');
    // A phone reads its own blob: a desktop's choice does not reach it.
    expect(prePaint(JSON.stringify({ showTabCliLogos: false }), 'mobile', 'desktop').dataset.tabLogos).toBe('on');
  });

  it('falls back to on, beside the other fallbacks, when the stored blob does not parse', () => {
    const root = prePaint('{not json');
    expect(root.dataset.tabLogos).toBe('on');
    expect(root.dataset.tabArrangement).toBe('classic');
    expect(root.dataset.headerStats).toBe('classic');
  });
});

describe('the CSS', () => {
  const rulesNaming = (css: string, pattern: RegExp) => {
    const found: Rule[] = [];
    postcss.parse(css).walkRules((rule: Rule) => {
      if (pattern.test(rule.selector)) found.push(rule);
    });
    return found;
  };
  const selectorsOf = (rule: Rule) => rule.selectors.map((s) => s.replace(/\s+/g, ' ').trim());

  it('hides the tab logo and the home-rail logo under the attribute, in one rule, and nothing else', () => {
    const rules = rulesNaming(STYLES, /data-tab-logos/);
    expect(rules).toHaveLength(1);
    expect(selectorsOf(rules[0])).toEqual([
      "html[data-tab-logos='off'] .session-tab .tab-harness",
      "html[data-tab-logos='off'] .home-sessions-harness",
    ]);
    const decls: string[] = [];
    rules[0].walkDecls((d) => {
      decls.push(`${d.prop}: ${d.value}${d.important ? ' !important' : ''}`);
    });
    expect(decls).toEqual(['display: none']);
    expect(rules[0].parent?.type).toBe('root');
  });

  it('leaves the tile and split headers, the Run menus and the welcome launchers their logos', () => {
    const selectors = rulesNaming(STYLES, /data-tab-logos/)
      .flatMap(selectorsOf)
      .join(' ');
    for (const other of ['tile-harness', 'split-harness', 'run-mode-option', 'welcome', 'mobile-overview']) {
      expect(selectors, other).not.toContain(other);
    }
    // Not the shared slot either: the Run menus draw the same `.run-mode-dot`.
    expect(selectors).not.toMatch(/(^|\s)\.run-mode-dot/);
  });

  it('nothing on a phone or in a skin brings the logo back over the rule', () => {
    expect(MOBILE).not.toContain('data-tab-logos');
    for (const css of [STYLES, MOBILE]) {
      for (const rule of rulesNaming(css, /tab-harness|home-sessions-harness|run-mode-dot/)) {
        rule.walkDecls('display', (d) => {
          // The only other display rule on the logo is the compact rail's rename
          // rule, which hides it too.
          expect(d.value, rule.selector).toBe('none');
        });
      }
    }
  });
});

describe('zh-CN', () => {
  const rowText = (doc: Document) => {
    const row = doc.getElementById('appSettingsShowTabCliLogos')!.closest('.set-row')!;
    return {
      label: row.querySelector('.set-row-label')!.textContent!.trim(),
      description: row.querySelector('.set-row-desc')!.textContent!.trim(),
    };
  };
  const english = rowText(new JSDOM(INDEX).window.document);
  const dom = new JSDOM(INDEX, { runScripts: 'outside-only', url: 'http://localhost/' });
  vm.runInContext(I18N, dom.getInternalVMContext(), { filename: 'i18n.js' });
  const api = (dom.window as unknown as { CodemanI18n: { start(): void; configure(o: object): void } }).CodemanI18n;
  api.start();
  api.configure({ language: 'zh-CN' });
  const chinese = rowText(dom.window.document);
  /** What may stay Latin: the CLI and SH names. */
  const leftover = (text: string) => text.replace(/\b(CLI|SH|Shell)\b/g, '').match(/[A-Za-z]+/g) ?? [];

  it('translates the label and the description, with no English left', () => {
    expect(chinese.label).toBe('标签页上的 CLI 图标');
    expect(chinese.description).not.toBe(english.description);
    expect(leftover(chinese.label)).toEqual([]);
    expect(leftover(chinese.description)).toEqual([]);
  });

  it('adds each key to the dictionary once', () => {
    for (const key of [english.label, english.description]) {
      const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      expect(I18N.match(new RegExp(`^\\s*(?:'${escaped}'|"${escaped}"):`, 'gm')) ?? [], key).toHaveLength(1);
    }
  });
});
