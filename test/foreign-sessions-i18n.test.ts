/**
 * @fileoverview The strings of the outside-sessions block in Chinese (zh-CN).
 *
 * Harvested from the real module rather than listed here, so a new string without a
 * dictionary entry fails this test instead of showing up English on one surface. The
 * block's row text carries data-i18n-skip (a session name and a command line are
 * someone else's), so its location words only translate through the module's own
 * foreignT() call, and the DOM translator would never reach them.
 *
 * Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterAll, describe, expect, it } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const I18N = readFileSync(resolve(PUBLIC, 'i18n.js'), 'utf8');
const MODULE = readFileSync(resolve(PUBLIC, 'foreign-sessions.js'), 'utf8');

type Api = { configure(o: Record<string, string>): void; t(source: string): string };

/** Everything the module sends through foreignT, plus the toggle's two literal labels. */
const FROM_MODULE = [...MODULE.matchAll(/foreignT\('([^']+)'\)/g)].map((m) => m[1]);
const LOCATION_WORDS = ['this machine', 'container', 'remote'];
const TOGGLE = ['⟳ all', '⟳ local'];
const ELSEWHERE = [
  'Close Tab',
  'Detaches only. The tmux session keeps running for whoever started it.',
  'Where the tmux session was when it was opened here. It was started outside Codeman and keeps running if this tab closes.',
  'Git status is not available for a tmux session opened outside Codeman.',
];
const ALL = [...FROM_MODULE, ...LOCATION_WORDS, ...TOGGLE, ...ELSEWHERE];

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  runScripts: 'outside-only',
  url: 'http://localhost/',
});
vm.runInContext(I18N, dom.getInternalVMContext(), { filename: 'i18n.js' });
const api = (dom.window as unknown as { CodemanI18n: Api }).CodemanI18n;
api.configure({ language: 'zh-CN' });

afterAll(() => {
  dom.window.close();
});

describe('the outside-sessions block in zh-CN', () => {
  it('harvests the module (the check is not vacuous)', () => {
    expect(FROM_MODULE).toContain('Opened outside Codeman');
    expect(FROM_MODULE).toContain('Go to tab');
    expect(FROM_MODULE.length).toBeGreaterThanOrEqual(10);
  });

  it('wraps every location word, whose row the DOM translator skips', () => {
    expect(MODULE).toContain('foreignT(FOREIGN_LOCATION_LABEL[row.location] || row.location)');
    for (const word of LOCATION_WORDS) expect(MODULE).toContain(`: '${word}'`);
  });

  it.each(ALL)('translates %s', (source) => {
    const chinese = api.t(source);
    expect(chinese).not.toBe(source);
    expect(chinese.replace(/\b(Codeman|tmux|Git)\b/g, '').match(/[A-Za-z]+/g) ?? []).toEqual([]);
  });

  it('adds each key to the dictionary once', () => {
    // Prettier leaves a key that is one word unquoted.
    for (const source of new Set(ALL)) {
      const bare = /^\w+$/.test(source) ? I18N.split(`\n    ${source}: `).length - 1 : 0;
      expect(I18N.split(`'${source}':`).length - 1 + bare, source).toBe(1);
    }
  });
});
