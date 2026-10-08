// test/tile-grid-per-device-setting.test.ts
// Port: none (pure static analysis, runs in CI, no browser/server).
//
// `showTileGridButton` (the header Tiles button, and the Ctrl+Shift+G chord) is
// a PER-DEVICE setting, default OFF, with the same three-way rule as
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
import { JSDOM } from 'jsdom';

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

  it('defaults OFF on handhelds (and reads as OFF when absent everywhere)', () => {
    expect(settingsUi).toMatch(/showSplitButton: false,\s*showTileGridButton: false,/);
    expect(settingsUi).toContain(
      "document.getElementById('appSettingsShowTileGridButton').checked = settings.showTileGridButton ?? defaults.showTileGridButton ?? false;"
    );
  });

  it('is saved from its App Settings chip and applied to the header', () => {
    expect(settingsUi).toContain(
      "showTileGridButton: document.getElementById('appSettingsShowTileGridButton').checked,"
    );
    expect(settingsUi).toContain('this._applyTileGridButtonVisibility?.(showTileGridButton);');
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
