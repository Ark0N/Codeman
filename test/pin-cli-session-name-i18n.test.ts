/**
 * @fileoverview The "Pin tab names on the CLI" App Settings row (#646) in Chinese (zh-CN):
 * its label and description run through the real translator over the real index.html in
 * JSDOM, read in Chinese with no English left beyond `CLI`, `Claude`, `Codeman` and
 * `/resume`, and each key is in the dictionary once (a repeated key in the object literal
 * silently replaces the first).
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
const INDEX = readFileSync(resolve(PUBLIC, 'index.html'), 'utf8');

type Api = { configure(o: Record<string, string>): void; start(): void };

/** What may stay Latin: the product and CLI names and the slash command. */
const leftover = (text: string) => text.replace(/\/resume|\b(CLI|Claude|Codeman)\b/g, '').match(/[A-Za-z]+/g) ?? [];

function rowStrings(doc: Document): { label: string; description: string } {
  const row = doc.getElementById('appSettingsPinCliSessionName')!.closest('.set-row')!;
  return {
    label: row.querySelector('.set-row-label')!.textContent!.trim(),
    description: row.querySelector('.set-row-desc')!.textContent!.trim(),
  };
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

describe('the Pin tab names on the CLI row in zh-CN', () => {
  it('finds the row (the check is not vacuous)', () => {
    expect(english.label).toBe('Pin tab names on the CLI');
    expect(english.description).toMatch(/^Launch every Claude session with its tab name/);
  });

  it('translates the label and the description, with no English left', () => {
    for (const key of ['label', 'description'] as const) {
      expect(chinese[key]).not.toBe(english[key]);
      expect(leftover(chinese[key])).toEqual([]);
    }
  });

  it('adds each key to the dictionary once', () => {
    for (const text of [english.label, english.description]) {
      expect(I18N.split(`'${text}'`).length + I18N.split(`"${text}"`).length - 2).toBe(1);
    }
  });
});
