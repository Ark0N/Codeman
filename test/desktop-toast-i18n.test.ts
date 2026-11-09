/**
 * @fileoverview zh-CN coverage for the toasts shown when a window could not be
 * opened, and for the Codeman desktop app's own toasts.
 *
 * The literals are read from their sources: the transcript and detached
 * preview toasts from panels-ui.js, and the desktop shim's toasts from
 * packages/desktop/src/assets.rs (a Rust file whose strings reach Codeman's
 * `showToast`), so a reworded toast on either side without an entry fails
 * here. The download toasts carry a file name and go through the pattern
 * rule, which must keep the name exactly as written.
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
const PANELS_UI = read('panels-ui.js');
const ASSETS_RS = readFileSync(resolve(import.meta.dirname, '../packages/desktop/src/assets.rs'), 'utf8');

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

const panelToasts = [
  ...PANELS_UI.matchAll(/this\.showToast\('(Could not open the transcript window[^']*|Pop-up blocked[^']*)'/g),
].map((m) => m[1]);
// The shim's JavaScript may quote a literal either way.
const shimToasts = [...ASSETS_RS.matchAll(/showToast\((['"])([^'"]+)\1/g)].map((m) => m[2]);
const downloadTemplates = [...ASSETS_RS.matchAll(/format!\("([^"]*\{file_name\}[^"]*)"\)/g)].map((m) => m[1]);

// File names with spaces, dots, brackets and English words, one of them a
// dictionary word on its own ("Settings saved"), which must not be translated.
const FILE_NAMES = ['report v2.pdf', 'Settings saved', 'a (1).tar.gz', '数据.csv'];

describe('the window and desktop toasts in zh-CN', () => {
  it('finds the strings it checks (the check is not vacuous)', () => {
    expect(new Set(panelToasts)).toEqual(
      new Set([
        'Could not open the transcript window: pop-up windows are blocked here',
        'Pop-up blocked: allow pop-ups for this site to detach previews',
      ])
    );
    expect(new Set(shimToasts)).toEqual(new Set(['Could not open a new window']));
    expect(new Set(downloadTemplates)).toEqual(
      new Set(['Downloaded {file_name} to Downloads', 'Download of {file_name} failed'])
    );
  });

  it('every literal toast translates, and reads the same in English', () => {
    const bad = [...panelToasts, ...shimToasts].filter((l) => {
      const text = zh.api.t(l);
      return text === l || /[A-Za-z]/.test(text) || en.api.t(l) !== l;
    });
    expect(bad).toEqual([]);
  });

  it('the download toasts translate around the file name, which stays as written', () => {
    for (const template of downloadTemplates) {
      for (const name of FILE_NAMES) {
        const source = template.replace('{file_name}', name);
        const text = zh.api.t(source);
        expect(text, source).not.toBe(source);
        expect(text.split(name), source).toHaveLength(2);
        expect(text.replace(name, ''), source).not.toMatch(/[A-Za-z]/);
        expect(en.api.t(source)).toBe(source);
      }
    }
    expect(zh.api.t('Downloaded report v2.pdf to Downloads')).toBe('已将 report v2.pdf 下载到“下载”文件夹');
    expect(zh.api.t('Download of report v2.pdf failed')).toBe('下载 report v2.pdf 失败');
  });
});
