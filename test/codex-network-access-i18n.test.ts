/**
 * @fileoverview The Codex "Allow network access" row (App Settings → Codex) in Chinese (zh-CN).
 * That description is the only warning a user gets that the switch weakens Codex's sandbox, so
 * it must read in Chinese, through the real translator over the real index.html in JSDOM, with
 * no English left beyond product names and the `workspace-write` mode name, and each key must be
 * in the dictionary exactly once (a repeated key in the object literal silently replaces the
 * first).
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
const ROW_INPUT = 'appSettingsCodexNetworkAccess';

type Api = { configure(o: Record<string, string>): void; start(): void };

/** What may stay Latin: the product names, the API acronym and codex's own sandbox mode name. */
const leftover = (text: string) =>
  text.replace(/workspace-write|\b(Codex|Codeman|API)\b/g, '').match(/[A-Za-z]+/g) ?? [];

function rowStrings(doc: Document): { label: string; description: string } {
  const row = doc.getElementById(ROW_INPUT)!.closest('.set-row')!;
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

describe('the Allow network access row in zh-CN', () => {
  const english = rowStrings(source.window.document);
  const chinese = rowStrings(dom.window.document);

  it.each(['label', 'description'] as const)('translates the %s, with no English left', (key) => {
    expect(english[key].length).toBeGreaterThan(0);
    expect(chinese[key]).not.toBe(english[key]);
    expect(leftover(chinese[key])).toEqual([]);
  });

  it('keeps the warning that the setting is close to Bypass', () => {
    expect(chinese.description).toContain('绕过审批与沙箱');
  });

  it('adds each key to the dictionary once', () => {
    for (const text of Object.values(english)) {
      const quoted = text.includes("'") ? JSON.stringify(text) : `'${text}'`;
      expect(I18N.split(`${quoted}:`).length - 1).toBe(1);
    }
  });
});
