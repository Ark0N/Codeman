/**
 * @fileoverview "Run a model on this Mac" in Chinese (zh-CN): the welcome button, the chooser
 * window and the App Settings group.
 *
 * Three sources of text, all checked against the real dictionary in i18n.js:
 *  - the module's own strings, HARVESTED from the real local-model-ui.js (every literal it
 *    passes to `localModelT`), so a new string without an entry fails here instead of showing
 *    up English on one surface;
 *  - every sentence and label the SERVER may send: the recommendation (`LOCAL_MODEL_LABELS`),
 *    the tag of a model row (`LOCAL_MODEL_TAG_LABELS`) and the install
 *    (`LOCAL_MODEL_INSTALL_LABELS`), all imported from the contract, so a label added there
 *    fails here until it has an entry;
 *  - the static strings of the real index.html (the Settings group's heading and hint, the
 *    window's title), run through the real DOM translator.
 *
 * The window's body, the welcome button and the Settings row carry data-i18n-skip (model,
 * coding agent and chip names are someone else's text), so nothing in them is reached by the
 * DOM translator: these strings translate only through the module's own call, which is why
 * they are checked through `t()` here.
 *
 * Beyond "it is Chinese now", each entry must keep its `{placeholder}` slots: a translation
 * that drops one prints a sentence without its number.
 *
 * Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterAll, describe, expect, it } from 'vitest';
import {
  LOCAL_MODEL_ERROR_LABELS,
  LOCAL_MODEL_INSTALL_LABELS,
  LOCAL_MODEL_LABELS,
  LOCAL_MODEL_NONE_LABELS,
  LOCAL_MODEL_TAG_LABELS,
} from '../src/types.js';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const I18N = readFileSync(resolve(PUBLIC, 'i18n.js'), 'utf8');
const INDEX = readFileSync(resolve(PUBLIC, 'index.html'), 'utf8');
const MODULE = readFileSync(resolve(PUBLIC, 'local-model-ui.js'), 'utf8');

type Api = {
  configure(o: Record<string, string>): void;
  start(): void;
  t(source: string, vars?: Record<string, string>): string;
};

/** Every literal the module hands to its translator call (Prettier may break after the paren). */
const FROM_MODULE = [...new Set([...MODULE.matchAll(/localModelT\(\s*'([^']+)'/g)].map((m) => m[1]))];
/** Every text the server may send: the recommendation, the tag of a row, the install. */
const FROM_SERVER: string[] = [
  ...new Set([
    ...Object.values(LOCAL_MODEL_LABELS),
    ...Object.values(LOCAL_MODEL_TAG_LABELS),
    ...Object.values(LOCAL_MODEL_INSTALL_LABELS),
  ]),
];

/** A page with only the translator in it: enough for `t()`, and cheap to re-configure. */
const small = new JSDOM('<!doctype html><html><body></body></html>', {
  runScripts: 'outside-only',
  url: 'http://localhost/',
});
vm.runInContext(I18N, small.getInternalVMContext(), { filename: 'i18n.js' });
const api = (small.window as unknown as { CodemanI18n: Api }).CodemanI18n;
api.configure({ language: 'zh-CN' });

/** The real page, translated once, for the strings that live in index.html. */
const page = new JSDOM(INDEX, { runScripts: 'outside-only', url: 'http://localhost/' });
vm.runInContext(I18N, page.getInternalVMContext(), { filename: 'i18n.js' });
const pageApi = (page.window as unknown as { CodemanI18n: Api }).CodemanI18n;
pageApi.start();
pageApi.configure({ language: 'zh-CN' });

afterAll(() => {
  small.window.close();
  page.window.close();
});

/** The static strings of the page, as index.html ships them (English): the Settings group and the window's title. */
const GROUP_MARKUP = INDEX.match(
  /<div class="set-group" id="localModelGroup">\s*<div class="set-group-head"><h4>([^<]+)<\/h4><\/div>\s*<p class="set-group-hint">([^<]+)<\/p>/
);
const TITLE_MARKUP = INDEX.match(/<h3 id="localModelModalTitle">([^<]+)<\/h3>/);
const STATIC =
  GROUP_MARKUP && TITLE_MARKUP ? [GROUP_MARKUP[1].trim(), GROUP_MARKUP[2].trim(), TITLE_MARKUP[1].trim()] : [];

const ALL = [...new Set([...FROM_MODULE, ...FROM_SERVER, ...STATIC])];

/** The `{slot}` names of a source text. */
const slots = (text: string) => [...text.matchAll(/\{([a-zA-Z]\w*)\}/g)].map((m) => m[1]);

/** U+2013, U+2014 and U+2015, built from their code points so this file holds none of them. */
const LONG_DASH = new RegExp(`[${String.fromCharCode(0x2013, 0x2014, 0x2015)}]`);

/**
 * What may stay Latin: the product, the platform and its vendors, the units, Token (the
 * dictionary's own word), and the proper names of the install (the runtime, the two tools a
 * coding agent calls, the GPU and an API key).
 */
const leftover = (text: string) =>
  text.replace(/\b(Codeman|macOS|Mac|GB|MB|Apple|Intel|Token|Ollama|GPU|API|git|Python)\b/g, '').match(/[A-Za-z]+/g) ??
  [];

describe('the local model strings in zh-CN', () => {
  it('harvests the module (the check is not vacuous)', () => {
    expect(FROM_MODULE).toContain('Run a local model');
    expect(FROM_MODULE).toContain('Local model');
    expect(FROM_MODULE).toContain('About {need} of {budget} GB of memory');
    expect(FROM_MODULE).toContain('Install on this Mac');
    expect(FROM_MODULE).toContain('Download and install');
    expect(FROM_MODULE).toContain('{speed} MB per second, {left}');
    expect(FROM_MODULE).toContain('You can close this window. The download continues while Codeman is running.');
    expect(FROM_MODULE).toContain('Start a session');
    expect(FROM_MODULE).toContain('{model} is ready on this Mac.');
    expect(FROM_MODULE.length).toBeGreaterThanOrEqual(70);
    // The only other way the module calls its translator is with payload text (a server
    // sentence, or the tag of a row), so no string of its own can reach the page unharvested.
    const code = MODULE.split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');
    const calls = code.split('localModelT(').length - 1;
    const literalCalls = [...code.matchAll(/localModelT\(\s*'/g)].length;
    const payloadCalls = [...code.matchAll(/localModelT\((message\.text, message\.vars|label)\)/g)].length;
    // One more: the function's own declaration.
    expect(calls).toBe(literalCalls + payloadCalls + 1);
    expect(payloadCalls).toBe(2);
    // The stage that only read is gone, with its sentence.
    expect(MODULE).not.toContain('cannot download or install');
  });

  it('lists every server label: the recommendation, the tags and the install', () => {
    // A label added to the contract later fails below by its text, not here by a count.
    expect(FROM_SERVER.length).toBeGreaterThanOrEqual(18 + 3 + 26);
    for (const text of Object.values(LOCAL_MODEL_NONE_LABELS)) expect(FROM_SERVER).toContain(text);
    // Every error code has its sentence in the list.
    for (const text of Object.values(LOCAL_MODEL_ERROR_LABELS)) expect(FROM_SERVER).toContain(text);
    expect(FROM_SERVER).toContain('Best fit for this Mac');
    expect(FROM_SERVER).toContain('Speed unknown');
    expect(FROM_SERVER).toContain('Tested on a Mac like this');
    expect(FROM_SERVER).toContain('Best fit');
    expect(FROM_SERVER).toContain('Small model');
    expect(FROM_SERVER).toContain(LOCAL_MODEL_INSTALL_LABELS.conflictSizeChanged);
    expect(FROM_SERVER).toContain(LOCAL_MODEL_INSTALL_LABELS.conflictSessionsOpen);
    // The two other sentences of the `memory` reason and the two notes are not in the
    // reason map, so they are named here.
    expect(FROM_SERVER).toContain(LOCAL_MODEL_LABELS.noneMemoryContext);
    expect(FROM_SERVER).toContain(LOCAL_MODEL_LABELS.noneMemoryUnknown);
    expect(FROM_SERVER).toContain(LOCAL_MODEL_LABELS.noteSmallPick);
    expect(FROM_SERVER).toContain(LOCAL_MODEL_LABELS.noteDiskDropped);
  });

  it('prints the developer tools sentence from one source', () => {
    // Not sent by the server: the window prints it when `developerTools` is `missing`. The
    // module's literal is the contract's text, so one dictionary entry serves both.
    expect(FROM_MODULE).toContain(LOCAL_MODEL_INSTALL_LABELS.developerToolsMissing);
  });

  it('never uses the translator slot {name} for a value of its own', () => {
    for (const text of ALL) expect(slots(text), text).not.toContain('name');
  });

  it.each(ALL)('translates %s, with no English left', (text) => {
    const chinese = api.t(text);
    expect(chinese).not.toBe(text);
    expect(leftover(chinese)).toEqual([]);
    // No long dash in any form: commas, colons and parentheses only.
    expect(chinese).not.toMatch(LONG_DASH);
  });

  it.each(ALL.filter((text) => slots(text).length > 0))('keeps every slot of %s', (text) => {
    // Digits only, so a marker is neither translated nor counted as leftover English.
    const vars = Object.fromEntries(slots(text).map((slot, i) => [slot, `90${i}1`]));
    const chinese = api.t(text, vars);
    for (const value of Object.values(vars)) expect(chinese, `${text} lost a slot`).toContain(value);
    expect(chinese).not.toMatch(/[{}]/);
  });

  it('keeps the product name a slot, so a custom display name reaches the Chinese text', () => {
    api.configure({ language: 'zh-CN', displayName: 'Acme' });
    try {
      for (const text of ALL.filter((candidate) => candidate.includes('Codeman'))) {
        const chinese = api.t(text);
        expect(chinese, text).toContain('Acme');
        expect(chinese, text).not.toContain('Codeman');
      }
    } finally {
      api.configure({ language: 'zh-CN', displayName: 'Codeman' });
    }
  });

  it('adds each key to the dictionary once', () => {
    // A repeated key in the object literal silently replaces the first. Prettier leaves a key
    // that is one word unquoted.
    for (const text of ALL) {
      const bare = /^\w+$/.test(text) ? I18N.split(`\n    ${text}: `).length - 1 : 0;
      expect(I18N.split(`'${text}':`).length - 1 + bare, text).toBe(1);
    }
  });

  it('translates the static strings in the page, and leaves what the module writes alone', () => {
    expect(STATIC).toHaveLength(3);
    expect(STATIC[0]).toBe('Model on this Mac');
    expect(STATIC[2]).toBe('Run a model on this Mac');
    const translated = page.window.document.getElementById('localModelGroup')!;
    const heading = translated.querySelector('.set-group-head h4')!.textContent!.trim();
    const hint = translated.querySelector('.set-group-hint')!.textContent!.trim();
    expect(heading).toBe('此 Mac 上的模型');
    expect(hint).not.toBe(STATIC[1]);
    expect(hint).toBe(api.t(STATIC[1]));
    expect(leftover(hint)).toEqual([]);
    const title = page.window.document.getElementById('localModelModalTitle')!.textContent!.trim();
    expect(title).toBe('在此 Mac 上运行模型');
    // The dialog's close button is named in Chinese too.
    const close = page.window.document.querySelector('#localModelModal .modal-close')!;
    expect(close.getAttribute('aria-label')).toBe('关闭');
    // Written only by the module, through its own translator call. The button keeps the
    // English label it ships with until the module shows it.
    for (const id of ['welcomeLocalModelBtn', 'localModelSettings', 'localModelSettingsOpen', 'localModelWindowBody']) {
      expect(INDEX).toMatch(new RegExp(`id="${id}"[^>]*data-i18n-skip`));
    }
    expect(page.window.document.getElementById('welcomeLocalModelLabel')!.textContent).toBe('Run a local model');
  });
});
