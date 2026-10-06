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
