/**
 * Terminal find bar: the vendor bundle is built and loaded everywhere the other xterm addons are,
 * the chord is a rebindable registry entry that stays out of the PTY, Esc inside the bar closes
 * only the bar, and the tile grid keeps it off.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf-8');
const terminalUi = read('src/web/public/terminal-ui.js');
const appJs = read('src/web/public/app.js');

describe('terminal find bar', () => {
  it('bundles and loads the search addon like the other xterm addons', () => {
    for (const f of ['scripts/build.mjs', 'scripts/postinstall.js', 'scripts/prepare-test-vendor.mjs']) {
      expect(read(f), f).toContain('addon-search');
    }
    expect(read('src/web/public/index.html')).toContain('vendor/xterm-addon-search.min.js');
    expect(JSON.parse(read('package.json')).dependencies['@xterm/addon-search']).toBeDefined();
  });

  it('is on unless the setting is false, and keeps the chord out of the PTY', () => {
    expect(terminalUi).toContain('this.loadAppSettingsFromStorage().terminalFindEnabled !== false');
    expect(terminalUi).toContain('if (this.isTerminalFindChord?.(ev)) return false;');
  });

  it('keeps the chord in the rebindable shortcut registry, not hard-coded', () => {
    expect(appJs).toContain("id: 'find-in-terminal'");
    expect(appJs).toContain("action: 'openTerminalFind'");
    expect(terminalUi).toContain("find((s) => s.id === 'find-in-terminal')");
    expect(terminalUi).not.toContain("ev.code === 'KeyF'");
  });

  it('leaves an Escape pressed inside the bar to the bar, not to closeAllPanels()', () => {
    const at = appJs.indexOf("if (e.target?.closest?.('#terminalFindBar')) return;");
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(appJs.indexOf('this.closeAllPanels();', at));
  });

  it('stays off while the tile grid owns the terminal', () => {
    const fn = terminalUi.slice(terminalUi.indexOf('terminalFindEnabled() {'));
    expect(fn.slice(0, fn.indexOf('},'))).toContain('!this._tilesOwnTerminal?.()');
  });
});
