/**
 * @fileoverview The synced `agentCoordinationEnabled` setting (default OFF) that gates the
 * experimental inspect/stage/submit routes: the strict settings schema admits it, App
 * Settings loads and saves it under the same control id, and its row reads in Chinese
 * (zh-CN) with no English left beyond the command and product names. The route gate itself
 * is pinned in test/routes/agent-session-routes.test.ts.
 *
 * Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterAll, describe, expect, it } from 'vitest';
import { SettingsUpdateSchema } from '../src/web/schemas.js';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const I18N = readFileSync(resolve(PUBLIC, 'i18n.js'), 'utf8');
const INDEX = readFileSync(resolve(PUBLIC, 'index.html'), 'utf8');
const SETTINGS_UI = readFileSync(resolve(PUBLIC, 'settings-ui.js'), 'utf8');
const ID = 'appSettingsAgentCoordination';

type Api = { configure(o: Record<string, string>): void; start(): void };

/** What may stay Latin: the product, CLI, key and protocol names and the three commands. */
const leftover = (text: string) =>
  text.replace(/\b(Codex|Enter|HTTP|inspect|stage|submit)\b/g, '').match(/[A-Za-z]+/g) ?? [];

function rowStrings(doc: Document): { label: string; description: string } {
  const row = doc.getElementById(ID)!.closest('.set-row')!;
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

describe('agentCoordinationEnabled', () => {
  it('is a boolean the strict settings schema accepts, and nothing else', () => {
    expect(SettingsUpdateSchema.safeParse({ agentCoordinationEnabled: true }).success).toBe(true);
    expect(SettingsUpdateSchema.safeParse({ agentCoordinationEnabled: false }).success).toBe(true);
    expect(SettingsUpdateSchema.safeParse({ agentCoordinationEnabled: 'yes' }).success).toBe(false);
  });

  it('has one checkbox in App Settings, loaded only from an explicit true and saved by id', () => {
    expect(INDEX.split(`id="${ID}"`)).toHaveLength(2);
    expect(source.window.document.getElementById(ID)!.getAttribute('type')).toBe('checkbox');
    expect(SETTINGS_UI).toContain(
      `document.getElementById('${ID}').checked = settings.agentCoordinationEnabled === true;`
    );
    expect(SETTINGS_UI).toContain(`agentCoordinationEnabled: document.getElementById('${ID}').checked,`);
  });

  it('sits in the synced Cross-session features group', () => {
    const group = source.window.document.getElementById(ID)!.closest('.set-group')!;
    expect(group.querySelector('.set-group-head h4')!.textContent).toBe('Cross-session features');
    expect(group.querySelector('.set-group-head .set-scope')!.textContent).toBe('synced');
  });

  it('finds the row (the translation check is not vacuous)', () => {
    expect(english.label).toBe('Experimental agent coordination');
    expect(english.description).toMatch(/^Lets agents read another session's output/);
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
