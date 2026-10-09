/**
 * @fileoverview zh-CN coverage for the tab's exited-agent badge (and the tab's
 * accessible name that carries it).
 *
 * Every form `paneExitLabel()` produces (plain, an exit code, a negative code,
 * a signal) must translate fully through i18n.js's real `t()`, with the
 * session name in the accessible name passed through untranslated (a name
 * that is itself a dictionary word included), and read unchanged in English.
 *
 * The toolbar's case picker rows (which replaced the translated "+" and gear
 * buttons) and the host-window and dictation toasts are read from their source,
 * so a renamed label without an entry fails here.
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

/** Latin words left after removing what may stay: key names, the AI acronym, the N placeholder. */
const leftover = (text: string) =>
  text
    .replace(/\b(Ctrl|Cmd|Shift|Alt|Option)\+\w+/g, '')
    .replace(/\b(Ctrl|Cmd|Shift|Alt|Option|Enter|Tab|Space|End|Home|Escape|G|AI|N)\b/g, '')
    .match(/[A-Za-z]+/g) ?? [];

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

describe('the Run button family in zh-CN', () => {
  const SESSION_UI = read('session-ui.js');
  const STOCK = JSON.parse(readFileSync(resolve(import.meta.dirname, '../config/clis.stock.json'), 'utf8')) as Array<{
    shortBadge: string;
  }>;
  // What _applyRunMode can show: its hard-coded labels, and `Run <shortBadge>` for any registry CLI.
  const applyRunMode = SESSION_UI.slice(
    SESSION_UI.indexOf('  _applyRunMode() {'),
    SESSION_UI.indexOf('  sendEnterKey() {')
  );
  const hardCoded = [...applyRunMode.matchAll(/'(Run(?: [A-Z]+)?)'/g)].map((m) => m[1]);
  const fromRegistry = STOCK.map((e) => `Run ${e.shortBadge}`);

  it('covers the hard-coded labels and every stock mode code', () => {
    expect(hardCoded).toEqual(expect.arrayContaining(['Run SH', 'Run OC', 'Run CX', 'Run OMP', 'Run']));
    expect(fromRegistry).toEqual(expect.arrayContaining(['Run CC', 'Run SH', 'Run OM']));
  });

  it('"Run" becomes 运行, the mode code and product names stay, English unchanged', () => {
    for (const label of new Set([...hardCoded, ...fromRegistry])) {
      const text = zh.api.t(label);
      const code = label.slice(4);
      // A code that is also a product name has its own entry, matched without
      // case ("Run PI" -> the "Run Pi" entry, 运行 Pi): the code survives either way.
      expect(text.startsWith('运行'), label).toBe(true);
      expect(text.slice(2).trim().toLowerCase(), label).toBe(code.toLowerCase());
      expect(en.api.t(label)).toBe(label);
    }
  });

  it('the toolbar around it: titles and the Shell button', () => {
    for (const s of [
      'Run Shell',
      'Select AI backend',
      'Terminal / Shell',
      'Send Enter',
      'Instance count',
      'Stop (Ctrl+C)',
    ]) {
      const text = zh.api.t(s);
      expect(text, s).not.toBe(s);
      // "Shell" stays, as the table already had it (运行 Shell).
      expect(leftover(text.replace(/Shell/g, '')), s).toEqual([]);
      expect(en.api.t(s)).toBe(s);
    }
  });
});

describe('the Help modal and the shortcut overlay in zh-CN', () => {
  const dom = new JSDOM(read('index.html'), { runScripts: 'outside-only', url: 'http://localhost/' });
  vm.runInContext(I18N, dom.getInternalVMContext(), { filename: 'i18n.js' });
  const doc = dom.window.document;
  const control = doc.createElement('button');
  control.textContent = 'Home';
  doc.body.appendChild(control);
  const api = (dom.window as unknown as { CodemanI18n: Api & { start(): void } }).CodemanI18n;
  api.start();
  api.configure({ language: 'zh-CN' });

  it('no English left in the Help modal outside the key names', () => {
    const left: string[] = [];
    const walk = (el: Element) => {
      for (const node of el.childNodes) {
        if (node.nodeType === 3) {
          if (node.parentElement?.tagName !== 'KBD' && leftover(node.nodeValue ?? '').length)
            left.push(node.nodeValue!.trim());
        } else if (node.nodeType === 1) walk(node as Element);
      }
    };
    walk(doc.getElementById('helpModal')!);
    expect(left).toEqual([]);
  });

  it('the Home KEY stays Home, while the word Home elsewhere still translates', () => {
    const homeKey = [...doc.querySelectorAll('#helpModal kbd')].find((k) => k.closest('div')?.nextElementSibling);
    const keys = [...doc.querySelectorAll('#helpModal kbd')].map((k) => k.textContent);
    expect(keys).toContain('Home');
    expect(keys).not.toContain('主页');
    // Mouse inputs in the key column do translate (as Click / Right-click do).
    expect(keys).toContain('滚轮');
    expect(homeKey).toBeTruthy();
    expect(control.textContent).toBe('主页');
  });

  it('every shortcut registry group and label translates (the overlay and the App Settings list)', () => {
    const start = APP.indexOf('const DEFAULT_SHORTCUTS = [');
    const registry = APP.slice(start, APP.indexOf('\n];', start));
    const pairs = [...registry.matchAll(/group: '([^']+)',\s*label: '([^']+)'/g)];
    expect(pairs.length).toBeGreaterThan(20);
    const bad = pairs.flatMap(([, group, label]) =>
      [group, label].filter((s) => zh.api.t(s) === s || leftover(zh.api.t(s)).length > 0)
    );
    expect([...new Set(bad)]).toEqual([]);
  });

  it("the overlay's key column is never translated", () => {
    const overlay = APP.slice(APP.indexOf('  renderShortcutOverlay() {'), APP.indexOf('  closeShortcutOverlay() {'));
    expect(overlay.match(/<kbd data-i18n-skip>/g)).toHaveLength(2);
    expect(overlay).not.toMatch(/<kbd>/);
  });
});

describe('the case picker rows and the host-window and dictation toasts in zh-CN', () => {
  const SESSION_UI = read('session-ui.js');
  const actions = SESSION_UI.slice(
    SESSION_UI.indexOf('const CASE_PICKER_ACTIONS = ['),
    SESSION_UI.indexOf('];', SESSION_UI.indexOf('const CASE_PICKER_ACTIONS = ['))
  );
  const pickerLabels = [...actions.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
  const toasts = ['app.js', 'panels-ui.js', 'webview-tabs.js', 'voice-input.js'].flatMap((file) =>
    [
      ...read(file).matchAll(
        /showToast\??\.?\(\s*'(Could not open a new window for this \w+|That session has closed; dictation not sent)'/g
      ),
    ].map((m) => m[1])
  );

  it('finds the strings it checks (the check is not vacuous)', () => {
    expect(pickerLabels).toEqual(['New or link a case\u2026', 'Case settings\u2026']);
    expect(SESSION_UI).toContain('<div class="case-combobox-empty">No cases match</div>');
    expect(toasts.sort()).toEqual([
      'Could not open a new window for this dashboard',
      'Could not open a new window for this preview',
      'Could not open a new window for this session',
      'That session has closed; dictation not sent',
    ]);
  });

  it('each one reads in Chinese with no English left, and unchanged in English', () => {
    const bad = [...pickerLabels, 'No cases match', ...toasts].filter((s) => {
      const text = zh.api.t(s);
      return text === s || leftover(text).length > 0 || en.api.t(s) !== s;
    });
    expect(bad).toEqual([]);
    // The rows reuse the wording of the buttons they replaced.
    expect(zh.api.t('Case settings\u2026')).toBe(`${zh.api.t('Case settings')}\u2026`);
  });
});
