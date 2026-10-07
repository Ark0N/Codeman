/**
 * @fileoverview zh-CN coverage for the tab's exited-agent badge (and the tab's
 * accessible name that carries it).
 *
 * Every form `paneExitLabel()` produces (plain, an exit code, a negative code,
 * a signal) must translate fully through i18n.js's real `t()`, with the
 * session name in the accessible name passed through untranslated (a name
 * that is itself a dictionary word included), and read unchanged in English.
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
const APP = read('app.js');

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

/** Latin words left after removing what may stay (key names). */
const leftover = (text: string) =>
  text.replace(/\b(Ctrl|Cmd|Shift|Alt|Option|Enter|Tab|Space|End|Home|Escape|G)\b/g, '').match(/[A-Za-z]+/g) ?? [];

const helpers = new Function(
  `${APP.match(/function paneExitLabel\([\s\S]*?\n\}/)![0]}\n${APP.match(/function paneExitAriaLabel\([\s\S]*?\n\}/)![0]}\n` +
    'return { paneExitLabel, paneExitAriaLabel };'
)() as { paneExitLabel(p: unknown): string; paneExitAriaLabel(name: string, label: string): string };

const EXITS = [{}, { status: 0 }, { status: 3 }, { status: 137 }, { status: -1 }, { signal: 9 }];

describe('the exited-agent badge in zh-CN', () => {
  const labels = EXITS.map((p) => helpers.paneExitLabel({ ...p, at: 1 }));

  it('produces the forms this test covers', () => {
    expect(labels).toEqual(['exited', 'exited (0)', 'exited (3)', 'exited (137)', 'exited (-1)', 'exited (signal 9)']);
  });

  it('every badge form translates fully, and reads the same in English', () => {
    const bad = labels.filter((l) => {
      const text = zh.api.t(l);
      return text === l || leftover(text).length > 0 || en.api.t(l) !== l;
    });
    expect(bad).toEqual([]);
    expect(zh.api.t('exited (3)')).toBe('已退出（3）');
    expect(zh.api.t('exited (signal 9)')).toBe('已退出（信号 9）');
  });

  it("the tab's accessible name translates around the session name, which stays as typed", () => {
    for (const name of ['w1-case', 'Open tiles', 'Tiles']) {
      for (const label of labels) {
        const source = helpers.paneExitAriaLabel(name, label);
        const text = zh.api.t(source);
        expect(text.startsWith(`${name} 会话，智能体已退出`), `${source} -> ${text}`).toBe(true);
        expect(leftover(text.slice(name.length))).toEqual([]);
        expect(en.api.t(source)).toBe(source);
      }
    }
  });
});
