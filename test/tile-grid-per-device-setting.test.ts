// test/tile-grid-per-device-setting.test.ts
// Port: none (pure static analysis, runs in CI, no browser/server).
//
// `showTileGridButton` (the header Tiles button, and the Ctrl+Shift+G chord) is
// a PER-DEVICE setting (default ON on desktop, OFF on handhelds and touch-primary
// tablets) with the same three-way rule as
// showSplitButton (test/split-pane-per-device-setting.test.ts, read it for the
// history): in settings-ui.js's displayKeys merge policy, stripped out of the
// object saveAppSettings() PUTs (SettingsUpdateSchema is .strict(), so sending
// it would 400 the whole save), and never declared in the schema. Plus the
// parts that make the setting reachable: the App Settings chip, its load and
// save lines, the mobile default, and the `--hidden` marker's display:none
// rule (also covered generically by split-pane-hidden-button-css.test.ts).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { makeGridApp } from './mocks/tile-grid-vm.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(HERE, '../src/web/public');
const read = (file: string) => readFileSync(join(PUBLIC, file), 'utf8');

describe('showTileGridButton stays per-device: display key, stripped from the PUT, absent from the schema', () => {
  const settingsUi = read('settings-ui.js');
  const schemas = readFileSync(join(HERE, '../src/web/schemas.ts'), 'utf8');

  it('is in the client-side displayKeys merge policy', () => {
    const start = settingsUi.indexOf('const displayKeys = new Set([');
    const displayKeys = settingsUi.slice(start, settingsUi.indexOf('])', start));
    expect(displayKeys).toContain("'showTileGridButton'");
  });

  it('is stripped out of the object saveAppSettings() PUTs to the server', () => {
    expect(settingsUi).toContain('showTileGridButton: _stg,');
  });

  it('is never declared in the .strict() SettingsUpdateSchema', () => {
    expect(schemas).not.toContain('showTileGridButton');
  });

  it('defaults ON on desktop (an absent key reads as ON) and OFF on handhelds', () => {
    // Owner's pick on the 1.36.0 beta: the Tiles button ships visible on desktop.
    // Handhelds keep it OFF in their defaults object, and the button never shows
    // below 1180px wide anyway.
    expect(settingsUi).toMatch(/showSplitButton: false,\s*showTileGridButton: false,/);
    expect(settingsUi).toContain(
      "document.getElementById('appSettingsShowTileGridButton').checked = settings.showTileGridButton ?? defaults.showTileGridButton ?? true;"
    );
    expect(settingsUi).toContain(
      'const showTileGridButton = settings.showTileGridButton ?? defaults.showTileGridButton ?? true;'
    );
  });

  it('is saved from its App Settings chip and applied to the header', () => {
    expect(settingsUi).toContain(
      "showTileGridButton: document.getElementById('appSettingsShowTileGridButton').checked,"
    );
    expect(settingsUi).toContain('this._applyTileGridButtonVisibility?.(showTileGridButton);');
  });
});

// The real getDefaultSettings() (settings-ui.js) on each kind of device. A
// touch-primary tablet (iPad, an Android tablet: primary pointer coarse) is
// not a handheld, so it used to take the desktop defaults and get the Tiles
// button ON, although a tile has none of the main terminal's touch, IME and
// soft-keyboard handling. It defaults OFF there (opt-in, like Split); a
// touchscreen laptop (primary pointer fine) keeps the desktop default.
describe('the device default: ON on desktop, OFF on handhelds and touch-primary tablets', () => {
  const SOURCE = readFileSync(join(PUBLIC, 'settings-ui.js'), 'utf8');
  type Device = { handheld: boolean; touch: boolean; coarse: boolean };
  function defaultsOn({ handheld, touch, coarse }: Device) {
    const CodemanApp = function CodemanApp(this: unknown) {};
    const context = vm.createContext({
      CodemanApp,
      VoiceInput: {},
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: () => null },
      console,
      MobileDetection: {
        isHandheldDevice: () => handheld,
        isTouchDevice: () => touch,
        getDeviceType: () => (handheld ? 'mobile' : 'desktop'),
      },
      window: {
        matchMedia: (q: string) => ({
          matches: q === '(pointer: coarse)' ? coarse : q === '(pointer: fine)' && !coarse,
        }),
      },
    });
    vm.runInContext(SOURCE, context, { filename: 'settings-ui.js' });
    const app = Object.create(CodemanApp.prototype) as { getDefaultSettings(): Record<string, unknown> };
    return app.getDefaultSettings();
  }
  /** What every reader resolves an absent key to: the button, the App Settings chip and the chord. */
  const resolved = (d: Device) => (defaultsOn(d).showTileGridButton ?? true) === true;

  const DESKTOP = { handheld: false, touch: false, coarse: false };
  const TOUCH_LAPTOP = { handheld: false, touch: true, coarse: false };
  const TABLET = { handheld: false, touch: true, coarse: true };
  const PHONE = { handheld: true, touch: true, coarse: true };

  it('a desktop and a touchscreen laptop (fine primary pointer): ON', () => {
    expect(defaultsOn(DESKTOP).showTileGridButton).toBeUndefined();
    expect(resolved(DESKTOP)).toBe(true);
    expect(defaultsOn(TOUCH_LAPTOP).showTileGridButton).toBeUndefined();
    expect(resolved(TOUCH_LAPTOP)).toBe(true);
  });

  it('a touch-primary tablet (coarse primary pointer, not a handheld): OFF, and only that key changes', () => {
    expect(defaultsOn(TABLET)).toEqual({ showTileGridButton: false });
    expect(resolved(TABLET)).toBe(false);
  });

  it('a handheld: OFF, as before', () => {
    expect(defaultsOn(PHONE).showTileGridButton).toBe(false);
  });

  it('never stores the posture default: a 2-in-1 first opened as a tablet gets the button once it is docked', () => {
    // A fresh device caches loadAppSettingsFromStorage()'s fallback, and the
    // server-settings merge saves that object (saveAppSettingsToStorage(merged)),
    // so a default taken from the instantaneous primary pointer must not be in it.
    let coarse = true;
    const stored = new Map<string, string>();
    const CodemanApp = function CodemanApp(this: unknown) {};
    const context = vm.createContext({
      CodemanApp,
      VoiceInput: {},
      localStorage: {
        getItem: (k: string) => stored.get(k) ?? null,
        setItem: (k: string, v: string) => stored.set(k, String(v)),
      },
      document: { getElementById: () => null },
      console,
      MobileDetection: {
        isHandheldDevice: () => false,
        isTouchDevice: () => true,
        getDeviceType: () => 'desktop',
      },
      window: {
        matchMedia: (q: string) => ({
          matches: q === '(pointer: coarse)' ? coarse : q === '(pointer: fine)' && !coarse,
        }),
      },
    });
    vm.runInContext(SOURCE, context, { filename: 'settings-ui.js' });
    type SettingsApp = {
      getDefaultSettings(): Record<string, unknown>;
      loadAppSettingsFromStorage(): Record<string, unknown>;
      saveAppSettingsToStorage(s: Record<string, unknown>): void;
    };
    const app = Object.create(CodemanApp.prototype) as SettingsApp;
    // What every reader resolves (header button, App Settings chip, chord).
    const resolvedNow = () =>
      (app.loadAppSettingsFromStorage().showTileGridButton ?? app.getDefaultSettings().showTileGridButton ?? true) ===
      true;

    // First load in tablet posture: OFF, and nothing about it is cached or saved.
    expect(resolvedNow()).toBe(false);
    expect(app.loadAppSettingsFromStorage()).not.toHaveProperty('showTileGridButton');
    app.saveAppSettingsToStorage({ ...app.loadAppSettingsFromStorage() });
    expect([...stored.values()].join('')).not.toContain('showTileGridButton');

    // Docked (keyboard and trackpad: fine primary pointer): the desktop default.
    coarse = false;
    expect(resolvedNow()).toBe(true);
  });

  it('a context with no window at all still answers (the desktop default)', () => {
    const CodemanApp = function CodemanApp(this: unknown) {};
    const context = vm.createContext({
      CodemanApp,
      VoiceInput: {},
      localStorage: { getItem: () => null, setItem: () => {} },
      document: { getElementById: () => null },
      console,
      MobileDetection: { isHandheldDevice: () => false, getDeviceType: () => 'desktop' },
    });
    vm.runInContext(SOURCE, context, { filename: 'settings-ui.js' });
    const app = Object.create(CodemanApp.prototype) as { getDefaultSettings(): Record<string, unknown> };
    expect(app.getDefaultSettings()).toEqual({});
  });

  it('the Ctrl+Shift+G chord follows the same default: inert on a tablet with nothing stored, live on a touchscreen laptop', () => {
    const TOGGLE = {
      type: 'keydown',
      key: 'G',
      code: 'KeyG',
      ctrlKey: true,
      shiftKey: true,
      metaKey: false,
      altKey: false,
      target: { closest: () => null },
    };
    for (const [device, applies] of [
      [TABLET, false],
      [TOUCH_LAPTOP, true],
    ] as const) {
      const app = makeGridApp(['s-a', 's-b']);
      app.loadAppSettingsFromStorage = () => ({});
      app.getDefaultSettings = () => defaultsOn(device);
      expect(app.tileShortcutFor(TOGGLE)).toBe(applies ? 'toggle-tile-grid' : null);
    }
  });
});

describe('App Settings search finds Split and Tiles', () => {
  // The real filter (settings-ui.js) over the real markup: it matches each chip
  // by its own data-search and its text, so the chips carry their own keywords.
  const html = read('index.html');
  const settingsSrc = read('settings-ui.js');
  const start = settingsSrc.indexOf('  _filterSettings(query) {');
  const end = settingsSrc.indexOf('\n  },', start);
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  const filter = new Function('document', `return ({${settingsSrc.slice(start, end + 4)}});`)(doc) as {
    _filterSettings(q: string): void;
  };
  const shown = (id: string) => !doc.getElementById(id)!.closest('.set-chip')!.classList.contains('set-hit-hidden');

  it.each([
    ['tiles', true, false],
    ['tile grid', true, false],
    ['side by side', true, true],
    ['split', false, true],
    ['split pane', false, true],
  ])('"%s": Tiles shown %s, Split shown %s', (query, tiles, split) => {
    filter._filterSettings(query);
    expect(shown('appSettingsShowTileGridButton')).toBe(tiles);
    expect(shown('appSettingsShowSplitButton')).toBe(split);
  });

  it('the Header buttons group names both in its keywords', () => {
    expect(html).toMatch(/data-search="header buttons [^"]*\bsplit tiles\b[^"]*"/);
  });
});

describe('markup and styles', () => {
  const html = read('index.html');
  const css = read('styles.css');

  it('has a header chip in App Settings, beside Split', () => {
    expect(html).toMatch(
      /data-preview-order="11\.6"><input type="checkbox" id="appSettingsShowTileGridButton">[\s\S]*?<span>Tiles<\/span>/
    );
  });

  it('ships the header button hidden by its marker class, which has a display:none rule', () => {
    expect(html).toContain('class="btn-icon-header btn-tile-grid btn-tile-grid--hidden"');
    expect(css).toMatch(/\.btn-tile-grid--hidden\s*\{\s*display: none !important;/);
  });
});
