/**
 * @fileoverview The Git fetch interval rows (App Settings → Bottom bar, Session Options → Git) in Chinese
 * (zh-CN): each label and description runs through the real translator over the real index.html in JSDOM and
 * reads in Chinese with no English left beyond the product name and the technical names Git / git fetch, and
 * every new key (the save toast in session-ui.js included) is in the dictionary exactly once (a repeated key
 * in the object literal silently replaces the first).
 *
 * The Git tab's Status row is not here: its text is written at runtime by updateGitFetchStatus and carries
 * data-i18n-skip, so translating it would rewrite the stamp the code builds. 'sec' is not a key either: only
 * whole unit words are ('hours'), so 'sec' stays as written.
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
// Keys that contain a quote are written escaped in the object literal, so the dictionary is counted unescaped.
const DICT = I18N.replace(/\\'/g, "'").replace(/\\"/g, '"');

type Api = { configure(o: Record<string, string>): void; start(): void };

const ROWS = [
  'appSettingsGitFetchEnabled',
  'appSettingsGitFetchIntervalSeconds',
  'modalGitFetchFollow',
  'modalGitFetchEnabled',
  'modalGitFetchInterval',
];

/** What may stay Latin: the product names, and Git / git fetch as technical names. */
const leftover = (text: string) =>
  text.replace(/\b(Claude Code|Claude|Codeman|Ralph|Git|git|fetch)\b/g, '').match(/[A-Za-z]+/g) ?? [];

function rowStrings(doc: Document, id: string): { label: string; description: string } {
  const row = doc.getElementById(id)!.closest('.set-row')!;
  const label = row.querySelector('.set-row-label')!;
  // The row's own scope marker ('synced') rides inside the label; the dictionary key is the label without it.
  const scope = label.querySelector('.set-scope')?.textContent ?? '';
  return {
    label: label.textContent!.replace(scope, '').trim(),
    description: row.querySelector('.set-row-desc')!.textContent!.trim(),
  };
}

/** The Git section's blurb, which is not a row. */
function blurb(doc: Document): string {
  const section = doc.getElementById('git-tab')!;
  return section.querySelector('.set-section-blurb')!.textContent!.trim();
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

describe('the Git fetch rows in zh-CN', () => {
  it.each(ROWS)('translates the %s row, with no English left', (id) => {
    const english = rowStrings(source.window.document, id);
    const chinese = rowStrings(dom.window.document, id);
    expect(english.label.length).toBeGreaterThan(0);
    for (const key of ['label', 'description'] as const) {
      expect(chinese[key]).not.toBe(english[key]);
      expect(leftover(chinese[key])).toEqual([]);
    }
  });

  it('translates the Git section blurb too, which is not a row', () => {
    expect(blurb(dom.window.document)).not.toBe(blurb(source.window.document));
    expect(leftover(blurb(dom.window.document))).toEqual([]);
  });

  it("leaves the Status row's runtime text to the code that writes it", () => {
    // updateGitFetchStatus builds this row's sentence; a dictionary key for it would overwrite the stamp.
    expect(INDEX).toContain('id="gitFetchStatus" data-i18n-skip hidden');
  });

  it('adds each key to the dictionary once, the save toast included', () => {
    const texts = ROWS.flatMap((id) => Object.values(rowStrings(source.window.document, id)));
    texts.push(blurb(source.window.document), 'Git fetch settings saved');
    // 'sec' is deliberately not a key: only whole unit words are, so the unit stays as the markup writes it.
    expect(DICT).not.toMatch(/\n    sec: /);
    for (const text of texts) {
      const quoted = DICT.split(`'${text}'`).length + DICT.split(`"${text}"`).length - 2;
      const bare = /^\w+$/.test(text) ? DICT.split(`\n    ${text}: `).length - 1 : 0;
      expect(quoted + bare, text).toBe(1);
    }
  });
});
