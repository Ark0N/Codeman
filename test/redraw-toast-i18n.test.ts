/**
 * @fileoverview zh-CN coverage for the Redraw toasts (Ctrl+Shift+R and the
 * header Redraw button, `restoreTerminalSize()` in terminal-ui.js).
 *
 * Every literal toast that method shows, on the main pane, a tile or the
 * split's Pane B, is read from the source, so a reworded toast without an
 * entry fails here. The size report is a template literal and goes through
 * the pattern rule, which must keep the numbers.
 *
 * Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterAll, describe, expect, it } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const read = (f: string) => readFileSync(resolve(PUBLIC, f), 'utf8');
const I18N = read('i18n.js');
const TERMINAL_UI = read('terminal-ui.js');

type Api = { t(s: string): string; configure(o: Record<string, string>): void };
function translator(language: string) {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    runScripts: 'outside-only',
    url: 'http://localhost/',
  });
  vm.runInContext(I18N, dom.getInternalVMContext(), { filename: 'i18n.js' });
  const api = (dom.window as unknown as { CodemanI18n: Api }).CodemanI18n;
  api.configure({ language });
  return { api, dom };
}
const zh = translator('zh-CN');
const en = translator('en');
afterAll(() => {
  zh.dom.window.close();
  en.dom.window.close();
});

const body = TERMINAL_UI.match(/\n {2}async restoreTerminalSize\(\) \{[\s\S]*?\n {2}\},\n/)?.[0] ?? '';
const literals = [...body.matchAll(/this\.showToast\('([^']+)'/g)].map((m) => m[1]);

describe('the Redraw toasts in zh-CN', () => {
  it('finds the toasts restoreTerminalSize shows', () => {
    expect(body).not.toBe('');
    expect(new Set(literals)).toEqual(
      new Set([
        'This session is sized by its own window',
        'Terminal not connected: its size is sent when it reconnects',
        'Could not determine terminal size',
        'Failed to restore terminal size',
        'No active session',
      ])
    );
    expect(body).toContain('this.showToast(`Terminal restored to ${');
  });

  it('every literal toast translates, and reads the same in English', () => {
    const bad = literals.filter((l) => {
      const text = zh.api.t(l);
      return text === l || /[A-Za-z]/.test(text) || en.api.t(l) !== l;
    });
    expect(bad).toEqual([]);
  });

  it('the size report keeps its numbers', () => {
    expect(zh.api.t('Terminal restored to 120x40')).toBe('终端已恢复为 120x40');
    expect(en.api.t('Terminal restored to 120x40')).toBe('Terminal restored to 120x40');
  });
});
