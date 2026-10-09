/**
 * @fileoverview The Tab Layout settings in Chinese (zh-CN): the App Settings
 * rows #538 added (Tab Layout, State Order, Header Stats Style), their
 * descriptions and every option, run through the real translator over the
 * real index.html in JSDOM.
 *
 * - Each one reads in Chinese with no English left beyond key names and the
 *   WS / CPU / MEM readout names, and reads unchanged in English.
 * - The header style "Tiles" is not the tile grid: its option must not take
 *   平铺, the grid's own word, or "Tiles (default)" reads as the grid.
 * - Every new key is in the dictionary once (a repeated key in the object
 *   literal silently replaces the first).
 * - The state-row headings the strip draws (CodemanTabTriage's labels)
 *   translate too.
 * - The Bottom bar group (the Git status rows, #543's max repositories and
 *   git timeout among them) translates as one group: heading, every label and
 *   description, and the Git panel's names that the group's key now reaches.
 *
 * The rows' `desktop` tag is a generic tag shared with rows older than #538
 * (WebGL Renderer) and is left out of the check.
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
const INDEX = read('index.html');

type Api = { t(s: string): string; configure(o: Record<string, string>): void; start(): void };

const ROWS = ['appSettingsTabArrangement', 'appSettingsTabStateOrder', 'appSettingsHeaderStatsStyle'];

/** What may stay Latin: key names and the header's readout names. */
const leftover = (text: string) => text.replace(/\bAlt\+\d\.\.\d\b|\b(WS|CPU|MEM)\b/g, '').match(/[A-Za-z]+/g) ?? [];

/** The rows' visible strings: label (without its tag), description, options. */
function rowStrings(doc: Document): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of ROWS) {
    const select = doc.getElementById(id)!;
    const row = select.closest('.set-row')!;
    const label = row.querySelector('.set-row-label')!.cloneNode(true) as Element;
    label.querySelector('.set-tag')?.remove();
    out.set(`${id} label`, label.textContent!.trim());
    out.set(`${id} description`, row.querySelector('.set-row-desc')!.textContent!.trim());
    for (const option of select.querySelectorAll('option')) {
      out.set(`${id} option ${option.getAttribute('value')}`, option.textContent!.trim());
    }
  }
  return out;
}

const source = new JSDOM(INDEX);
const english = rowStrings(source.window.document);

const dom = new JSDOM(INDEX, { runScripts: 'outside-only', url: 'http://localhost/' });
vm.runInContext(I18N, dom.getInternalVMContext(), { filename: 'i18n.js' });
const api = (dom.window as unknown as { CodemanI18n: Api }).CodemanI18n;
api.start();
api.configure({ language: 'zh-CN' });
const chinese = rowStrings(dom.window.document);

afterAll(() => {
  source.window.close();
  dom.window.close();
});

describe('the Tab Layout settings rows in zh-CN', () => {
  it('finds the three rows and all their options (the check is not vacuous)', () => {
    expect(english.size).toBe(15);
    expect(english.get('appSettingsHeaderStatsStyle option compact')).toBe('Compact (default)');
    expect(english.get('appSettingsHeaderStatsStyle option tiles')).toBe('Tiles (label over value)');
    expect(english.get('appSettingsTabStateOrder option urgent-last')).toBe('Needs you at the bottom');
  });

  it('translates every label, description and option, with no English left', () => {
    const bad: string[] = [];
    for (const [where, text] of chinese) {
      if (text === english.get(where) || leftover(text).length) bad.push(`${where}: "${text}"`);
    }
    expect(bad).toEqual([]);
  });

  it('keeps the header style Tiles apart from the tile grid (平铺)', () => {
    expect(chinese.get('appSettingsHeaderStatsStyle option tiles')).not.toContain('平铺');
    expect(chinese.get('appSettingsHeaderStatsStyle description')).not.toContain('平铺');
  });

  it('reads exactly as before in English', () => {
    const en = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only',
      url: 'http://localhost/',
    });
    vm.runInContext(I18N, en.getInternalVMContext(), { filename: 'i18n.js' });
    const t = (en.window as unknown as { CodemanI18n: Api }).CodemanI18n;
    t.configure({ language: 'en' });
    expect([...english.values()].filter((s) => t.t(s) !== s)).toEqual([]);
    en.window.close();
  });

  it('adds each key to the dictionary once', () => {
    const repeated = [...english.values()].filter((s) => {
      const key = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return (I18N.match(new RegExp(`^\\s*(?:'${key}'|"${key}"|${key}):`, 'gm')) ?? []).length !== 1;
    });
    expect(repeated).toEqual([]);
  });

  it('translates the state-row headings the strip draws', () => {
    const labels = [...read('constants.js').matchAll(/\{ key: '\w+', label: '([^']+)'/g)].map((m) => m[1]);
    expect(labels).toEqual(['Needs you', 'Waiting', 'Working', 'Idle']);
    expect(labels.filter((s) => api.t(s) === s || leftover(api.t(s)).length)).toEqual([]);
  });
});

/** The Bottom bar group: its heading, then each row's label (without its tag) and description. */
function bottomBarStrings(doc: Document): Map<string, string> {
  const out = new Map<string, string>();
  const group = doc.getElementById('appSettingsShowGitStatus')!.closest('.set-group')!;
  out.set('heading', group.querySelector('h4')!.textContent!.trim());
  for (const row of group.querySelectorAll('.set-row')) {
    const id = row.querySelector('input, select')!.id;
    const label = row.querySelector('.set-row-label')!.cloneNode(true) as Element;
    label.querySelector('.set-scope')?.remove();
    out.set(`${id} label`, label.textContent!.trim());
    out.set(`${id} description`, row.querySelector('.set-row-desc')!.textContent!.trim());
  }
  return out;
}

describe('the Bottom bar settings group in zh-CN', () => {
  const englishGroup = bottomBarStrings(source.window.document);
  const chineseGroup = bottomBarStrings(dom.window.document);
  /** What may stay Latin here: the git and Docker names, and the product name. */
  const left = (text: string) => text.replace(/\b(Git|git|Docker|Codeman)\b/g, '').match(/[A-Za-z]+/g) ?? [];

  it("finds the heading and the four Git status rows, #543's two included (the check is not vacuous)", () => {
    expect(englishGroup.size).toBe(9);
    expect(englishGroup.get('heading')).toBe('Bottom bar');
    expect(englishGroup.get('appSettingsGitStatusMaxRepos label')).toBe('Git status: max repositories');
    expect(englishGroup.get('appSettingsGitStatusTimeout label')).toBe('Git status: git timeout');
  });

  it('translates the heading, every label and every description, with no English left', () => {
    const bad: string[] = [];
    for (const [where, text] of chineseGroup) {
      if (text === englishGroup.get(where) || left(text).length) bad.push(`${where}: "${text}"`);
    }
    expect(bad).toEqual([]);
    expect(chineseGroup.get('appSettingsGitStatusMaxRepos label')).toBe('Git 状态：最多仓库数');
  });

  it('reads exactly as before in English, and adds each key once', () => {
    const en = new JSDOM('<!doctype html><html><body></body></html>', {
      runScripts: 'outside-only',
      url: 'http://localhost/',
    });
    vm.runInContext(I18N, en.getInternalVMContext(), { filename: 'i18n.js' });
    const t = (en.window as unknown as { CodemanI18n: Api }).CodemanI18n;
    t.configure({ language: 'en' });
    expect([...englishGroup.values()].filter((s) => t.t(s) !== s)).toEqual([]);
    en.window.close();
    const repeated = [...englishGroup.values()].filter((s) => {
      const key = s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return (I18N.match(new RegExp(`^\\s*(?:'${key}'|"${key}"|${key}):`, 'gm')) ?? []).length !== 1;
    });
    expect(repeated).toEqual([]);
  });

  it("the Git panel's names, which the group's 'Git status' key reaches too, read naturally", () => {
    const doc = dom.window.document;
    expect(doc.getElementById('gitStatusPanel')!.getAttribute('aria-label')).toBe('Git 状态');
    const labels = [...doc.querySelectorAll('#gitStatusPanel .git-status-actions button')].map((b) =>
      b.getAttribute('aria-label')
    );
    expect(labels).toEqual(['刷新 Git 状态', '关闭 Git 状态']);
  });
});
