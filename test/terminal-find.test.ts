/**
 * Terminal find bar: the vendor bundle is built and loaded everywhere the other xterm addons are,
 * the chord stays out of the PTY, and a transcript line is only ever rendered as text.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf-8');
const terminalUi = read('src/web/public/terminal-ui.js');

describe('terminal find bar', () => {
  it('bundles and loads the search addon like the other xterm addons', () => {
    for (const f of ['scripts/build.mjs', 'scripts/postinstall.js', 'scripts/prepare-test-vendor.mjs']) {
      expect(read(f), f).toContain('addon-search');
    }
    expect(read('src/web/public/index.html')).toContain('vendor/xterm-addon-search.min.js');
    expect(JSON.parse(read('package.json')).dependencies['@xterm/addon-search']).toBeDefined();
  });

  it('is on unless the setting is false, and keeps the chord out of the PTY', () => {
    expect(terminalUi).toContain('terminalFindEnabled !== false');
    expect(terminalUi).toContain('if (this.isTerminalFindChord?.(ev)) return false;');
  });

  it('renders saved-history lines with textContent, never as markup', () => {
    const start = terminalUi.indexOf('async _searchSavedHistory()');
    const body = terminalUi.slice(start, terminalUi.indexOf('async _clearSavedHistory()'));
    expect(body).toContain('btn.textContent = m.text');
    expect(body).not.toContain('innerHTML');
  });

  it('searches the saved history as you type, only when it is on, and drops a stale answer', () => {
    expect(terminalUi).toContain('this._queueSavedHistorySearch();');
    const q = terminalUi.slice(terminalUi.indexOf('_queueSavedHistorySearch() {'));
    expect(q.slice(0, q.indexOf('},'))).toContain('if (!this._terminalFindHistoryEnabled()) return;');
    expect(terminalUi).toContain('a newer search owns the panel');
  });

  it('says where a match is: in the terminal, in the saved history, or both', () => {
    expect(terminalUi).toContain('`Not in terminal, ${inHistory}`');
    expect(terminalUi).toContain('`${live}, ${inHistory}`');
  });

  it('looks for the start of a saved line without its label, not the whole line', () => {
    expect(terminalUi).toContain('[60, 30, 15].some');
    expect(terminalUi).toContain('(You|Claude)');
  });

  it('explains a miss on a terminal with no scrollback, where a fullscreen CLI keeps its own', () => {
    expect(terminalUi).toContain('(this.terminal?.buffer.active.baseY || 0) === 0');
    expect(terminalUi).toContain('this terminal keeps no scrollback');
  });

  it('shows the History button only when saved history is on', () => {
    expect(terminalUi).toContain('this.loadAppSettingsFromStorage().transcriptSearchEnabled === true');
  });
});
