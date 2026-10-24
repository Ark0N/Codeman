/**
 * @fileoverview The prompt-cache keep-warm rows (Session Options → Respawn switch, App Settings
 * → Automation default and cap) in Chinese (zh-CN): each label and description runs through
 * the real translator over the real index.html in JSDOM and reads in Chinese with no English
 * left beyond the product names, and every new key, the toggle toasts included, is in the
 * dictionary exactly once (a repeated key in the object literal silently replaces the first).
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

const IDS = ['modalKeepWarmEnabled', 'appSettingsPromptCacheKeepWarm', 'appSettingsPromptCacheKeepWarmMaxHours'];

/** What may stay Latin: the product names. */
const leftover = (text: string) =>
  text.replace(/\b(Claude Code|Claude|Codeman|Ralph)\b/g, '').match(/[A-Za-z]+/g) ?? [];

function rowStrings(doc: Document, id: string): { label: string; description: string } {
  const row = doc.getElementById(id)!.closest('.set-row')!;
  return {
    label: row.querySelector('.set-row-label')!.textContent!.trim(),
    description: row.querySelector('.set-row-desc')!.textContent!.trim(),
  };
}

const source = new JSDOM(INDEX);
const dom = new JSDOM(INDEX, { runScripts: 'outside-only', url: 'http://localhost/' });
vm.runInContext(I18N, dom.getInternalVMContext(), { filename: 'i18n.js' });
const api = (dom.window as unknown as { CodemanI18n: Api }).CodemanI18n;
api.start();
api.configure({ language: 'zh-CN' });

afterAll(() => {
  source.window.close();
  dom.window.close();
});

describe('the keep-warm rows in zh-CN', () => {
  it.each(IDS)('translates the %s row, with no English left', (id) => {
    const english = rowStrings(source.window.document, id);
    const chinese = rowStrings(dom.window.document, id);
    expect(english.label.length).toBeGreaterThan(0);
    for (const key of ['label', 'description'] as const) {
      expect(chinese[key]).not.toBe(english[key]);
      expect(leftover(chinese[key])).toEqual([]);
    }
  });

  it('adds each key to the dictionary once, the toasts included', () => {
    const texts = IDS.flatMap((id) => Object.values(rowStrings(source.window.document, id)));
    texts.push('hours', 'Prompt-cache keep-warm enabled', 'Prompt-cache keep-warm disabled');
    for (const text of texts) {
      const quoted = I18N.split(`'${text}'`).length + I18N.split(`"${text}"`).length - 2;
      const bare = /^\w+$/.test(text) ? I18N.split(`\n    ${text}: `).length - 1 : 0;
      expect(quoted + bare, text).toBe(1);
    }
  });
});
