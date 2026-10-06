/**
 * @fileoverview The tile grid in Chinese (zh-CN): every string it puts on
 * screen has its own entry or pattern in i18n.js, so nothing is left in
 * English and nothing falls through to the generic leading-verb fallback.
 *
 * - Runtime strings are HARVESTED from the real tile code (the shared vm
 *   harness, test/mocks/tile-grid-vm.ts) driven through every state that
 *   writes text: the picker (cap and window wording), a tile's +, the Attach
 *   overlay (not attached, attaching, exited, ended), zoom, the header
 *   tooltip, the dividers, the empty slot, every toast, the crash-restart
 *   confirm, the Tiles and Split button titles. Each must translate to text
 *   with no Latin word left beyond key names and durations, and read
 *   unchanged in English.
 * - Static strings: the shortcut registry's tile entries (overlay and App
 *   Settings list), and index.html run through the real translator in JSDOM
 *   (the Tiles button, the App Settings chips, the Help modal's Tiles rows).
 * - User text stays as typed: session names (tile header, picker, + menu)
 *   and group names carry data-i18n-skip, and a session name inside the
 *   confirm passes through the pattern untranslated.
 *
 * Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  FakeEl,
  body,
  bySelector,
  fetchSpy,
  makeGridApp,
  resetGridHarness,
  section,
  windowStub,
  type GridApp,
} from './mocks/tile-grid-vm.js';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const read = (f: string) => readFileSync(resolve(PUBLIC, f), 'utf8');
const I18N = read('i18n.js');
const INDEX = read('index.html');

type Api = {
  t(s: string, v?: Record<string, string>): string;
  configure(o: Record<string, string>): void;
  start(): void;
};
function translator(language: string) {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
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

// What may stay Latin in a translation: key names, compact durations, glyphs.
const ALLOWED = /\b(Ctrl|Cmd|Shift|Alt|Option|Enter|G)\b|<1m|\b\d+[dhm]\b/g;
const leftover = (text: string) => text.replace(ALLOWED, '').match(/[A-Za-z]+/g) ?? [];

/** Every string a translation must handle, with where it was seen. */
const seen = new Map<string, string>();
/** Text in a data-i18n-skip subtree (user text): must never be translated. */
const userText = new Set<string>();

function harvest(root: FakeEl | null | undefined, where: string) {
  const walk = (el: FakeEl, inSkip: boolean) => {
    const skip = inSkip || 'data-i18n-skip' in el.attrs;
    const add = (value: unknown, kind: string) => {
      if (typeof value !== 'string' || !/[A-Za-z]/.test(value)) return;
      if (skip) userText.add(value.trim());
      else if (!seen.has(value.trim())) seen.set(value.trim(), `${where} (${kind})`);
    };
    add(el.textContent, 'text');
    add(el.title, 'title');
    add(el.attrs['aria-label'], 'aria-label');
    add(el.attrs.title, 'title attribute');
    for (const child of el.children) walk(child, skip);
  };
  if (root) walk(root, false);
}

function harvestAll(app: GridApp, where: string) {
  harvest(section, where);
  harvest(body, where);
  harvest(bySelector.get('.btn-tile-grid'), where);
  harvest(bySelector.get('.btn-split'), where);
  for (const [msg] of (app.showToast as ReturnType<typeof vi.fn>).mock.calls) {
    if (typeof msg === 'string' && !seen.has(msg)) seen.set(msg, `${where} (toast)`);
  }
}

let wrapRect = { width: 2400, height: 1200 };
function setUp() {
  resetGridHarness();
  wrapRect = { width: 2400, height: 1200 };
  const wrap = new FakeEl();
  wrap.getBoundingClientRect = () => ({ ...wrapRect, top: 0, left: 0, right: wrapRect.width, bottom: wrapRect.height });
  bySelector.set('.terminal-wrap', wrap);
  for (const cls of ['btn-tile-grid', 'btn-split']) {
    const btn = new FakeEl();
    btn.className = `btn-icon-header ${cls}`;
    bySelector.set(`.${cls}`, btn);
  }
}

const EIGHT = Array.from({ length: 8 }, (_, i) => `s-${i + 1}`);

/** Drives the real code through every state that writes text, harvesting as it goes. */
async function exercise() {
  setUp();
  const app = makeGridApp(EIGHT);
  let pill = 'idle';
  app._sidebarRichRow = () => ({ state: pill, pill, since: { at: 1 } });
  app._mobileOverviewStampText = () => '3m';
  app.cases = [{ name: 'proj', path: '/w' }];
  app._mobileOverviewCaseFor = (_dir: string, cases: Array<{ name: string }>) => cases[0] ?? null;
  app.sessions.get('s-2').pid = null;
  app.sessions.get('s-3').paneExit = { status: 3 };
  app.sessions.get('s-4').paneExit = { signal: 9 };
  // A session named like a UI string: user text, never translated.
  app.sessions.get('s-5').name = 'Open tiles';

  // The picker, the cap wording, then the window wording.
  app.openTilePicker({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
  const boxes = () =>
    body.children.find((c) => c.id === 'tilePickerMenu')!.children[0].children.map((r) => r.children[0]);
  for (const b of boxes()) {
    if (b.checked || b.disabled) continue;
    b.checked = true;
    b.dispatch('change');
  }
  harvestAll(app, 'picker, cap');
  app.closeTilePicker();
  wrapRect = { width: 1200, height: 900 };
  app.openTilePicker({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
  for (const b of boxes()) {
    if (b.checked || b.disabled) continue;
    b.checked = true;
    b.dispatch('change');
  }
  harvestAll(app, 'picker, window');
  app.closeTilePicker();
  // A window that fits one tile words it in the singular.
  wrapRect = { width: 700, height: 500 };
  app.openTilePicker({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
  harvestAll(app, 'picker, one tile');
  app.closeTilePicker();
  wrapRect = { width: 2400, height: 1200 };

  // The grid: five tiles first (an empty slot), then the sixth.
  app.openTileGrid(EIGHT.slice(0, 5));
  harvestAll(app, 'grid of five');
  app.addTile('s-6');
  app._renderTileChrome();
  harvestAll(app, 'grid of six');
  for (const state of ['needs you', 'error', 'waiting', 'working', 'done', 'exited']) {
    pill = state;
    app._renderTileChrome();
    harvestAll(app, `tooltip ${state}`);
  }
  pill = 'idle';

  // Zoom and back.
  app.zoomTile('s-1');
  harvestAll(app, 'zoomed');
  app.zoomTile('s-1');

  // A tile's + on a full grid, from a session in a case and from one outside.
  app.openTileAddMenu({ stopPropagation: vi.fn(), preventDefault: vi.fn(), currentTarget: null }, 's-1');
  harvestAll(app, '+ menu, full');
  app.closeTileAddMenu();
  app._mobileOverviewCaseFor = () => null;
  app.openTileAddMenu({ stopPropagation: vi.fn(), preventDefault: vi.fn(), currentTarget: null }, 's-1');
  harvestAll(app, '+ menu, no case');
  app.closeTileAddMenu();

  // The toasts of a full grid, by the cap and by the window.
  app._joinTileGridFromRun('s-7');
  app.addSessionToTiles('s-7');
  wrapRect = { width: 1200, height: 900 };
  section.getBoundingClientRect = () => ({ width: 1200, height: 900, top: 0, left: 0, right: 1200, bottom: 900 });
  app._joinTileGridFromRun('s-7');
  app.addSessionToTiles('s-8');
  // Too small for six: the auto-zoom hint.
  section.getBoundingClientRect = () => ({ width: 900, height: 400, top: 0, left: 0, right: 900, bottom: 400 });
  app._applyTileLayout();
  delete (section as unknown as Record<string, unknown>).getBoundingClientRect;
  wrapRect = { width: 2400, height: 1200 };
  harvestAll(app, 'full grid');

  // Attach: in flight, failed, the crash-restart confirm, a socket that ended.
  let release: (v: unknown) => void = () => {};
  fetchSpy.mockImplementationOnce(() => new Promise((r) => (release = r)));
  const pending = app.attachTileSession('s-2');
  harvestAll(app, 'attaching');
  release({ ok: false, json: async () => ({ success: false }) });
  await pending;
  harvestAll(app, 'attach failed');
  const confirmText: string[] = [];
  windowStub.confirm = vi.fn((msg: string) => {
    confirmText.push(msg);
    return false;
  });
  app.sessions.get('s-5').pid = null;
  app.sessions.get('s-5').respawnBlocked = true;
  app._renderTileChrome();
  await app.attachTileSession('s-5');
  for (const msg of confirmText) seen.set(msg, 'confirm');
  const tile6 = app._tileFor('s-6');
  tile6._stoppedCode = 4009;
  app._renderTileChrome();
  harvestAll(app, 'socket ended');

  // A group with no live session, and a toggle with nothing to open.
  app.tabLayout = { groups: [{ id: 'g', name: 'Tiles', refs: [{ kind: 'session', id: 'gone' }] }] };
  app.openGroupAsTiles('g');
  harvestAll(app, 'empty group');
  app.closeTileGrid({ reselect: false });
  harvestAll(app, 'grid closed');
  const empty = makeGridApp([]);
  empty.sessions.clear();
  empty.sessionOrder = [];
  empty.toggleTileGrid();
  harvestAll(empty, 'nothing to open');
  return { confirmText };
}

// The harvest runs once, in the first test; the others read what it saw.
let confirmText: string[] = [];

describe('every tile grid string the code puts on screen translates to zh-CN', () => {
  it('harvests the strings it should (the harvest itself is not vacuous)', async () => {
    ({ confirmText } = await exercise());
    // ('Tiled sessions', the grid region's label, is markup: the JSDOM test below.)
    const expected = [
      'Show sessions as tiles',
      'Open tiles',
      'Up to 6 tiles',
      'The grid holds at most 6 tiles',
      'This window fits 4 tiles',
      'This window fits 1 tile',
      'The grid already holds what this window fits (4)',
      'Drop a tab here',
      'Resize tile columns',
      'Resize tile rows',
      'Zoom this tile',
      'Restore the grid',
      'Session actions',
      'Add a session to the grid',
      'Remove tile (the session keeps running)',
      'idle 3m',
      'needs you 3m',
      'exited 3m',
      'Not attached',
      'Attach',
      'Attaching…',
      'The agent exited (3)',
      'The agent exited (signal 9)',
      'The session ended',
      'It cannot be restarted in place: close it from ⋯ (Close session).',
      'New session in this case',
      'This session is not in a case',
      'The grid holds at most 6 tiles: the new session opens on its own',
      'The grid already holds what this window fits (4): the new session opens on its own',
      'The grid already holds what this window fits (4)',
      'The window is too small for 6 tiles: showing the focused one',
      'Could not attach the session',
      'This group has no session to show as tiles',
      'No sessions to show as tiles',
      'Split: unavailable while tiles are open',
      'Tiles: show several sessions side by side (right-click to choose which)',
      'Tiles: back to a single session (right-click to choose which sessions)',
      'Open tiles was stopped after crashing repeatedly. Restart it?',
    ];
    const missing = expected.filter((s) => !seen.has(s));
    expect(missing).toEqual([]);
  });

  it('each one: Chinese with no English left, and no half-translated fallback', () => {
    const bad: string[] = [];
    for (const [source, where] of seen) {
      const text = zh.api.t(source);
      // The session name inside the confirm is user text, allowed to stay.
      const words = leftover(text.replace('Open tiles', ''));
      if (text === source || words.length) bad.push(`${where}: "${source}" -> "${text}"`);
    }
    expect(bad).toEqual([]);
  });

  it('each one reads exactly as before in English', () => {
    const changed = [...seen.keys()].filter((s) => en.api.t(s) !== s);
    expect(changed).toEqual([]);
  });

  it('the shortcut registry entries: the Tiles group, its labels, "not bound", the group menu item', () => {
    const app = read('app.js');
    const labels = [...app.matchAll(/group: 'Tiles',\s*label: '([^']+)'/g)].map((m) => m[1]);
    expect(labels).toHaveLength(7);
    expect(app).toContain("label: 'Open group as tiles'");
    expect(app).toContain('not bound');
    const bad = ['Tiles', 'not bound', 'Open group as tiles', ...labels].filter((s) => {
      const text = zh.api.t(s);
      return text === s || leftover(text).length > 0;
    });
    expect(bad).toEqual([]);
  });
});

describe('the static markup through the real translator (JSDOM, zh-CN)', () => {
  const dom = new JSDOM(INDEX, { runScripts: 'outside-only', url: 'http://localhost/' });
  vm.runInContext(I18N, dom.getInternalVMContext(), { filename: 'i18n.js' });
  const doc = dom.window.document;
  const extra = doc.createElement('div');
  extra.innerHTML =
    '<span id="u-session" data-i18n-skip>Open tiles</span>' +
    '<span id="u-group" class="tab-layout-group-name" data-i18n-skip>Tiles</span>' +
    '<span id="control">Tiles</span>';
  doc.body.appendChild(extra);
  const api = (dom.window as unknown as { CodemanI18n: Api }).CodemanI18n;
  api.start();
  api.configure({ language: 'zh-CN' });

  it('the Tiles header button: title and accessible name', () => {
    const btn = doc.querySelector('.btn-tile-grid')!;
    for (const text of [btn.getAttribute('title')!, btn.getAttribute('aria-label')!]) {
      expect(text).toContain('平铺');
      expect(leftover(text)).toEqual([]);
    }
  });

  it('the App Settings chips (Tiles, and Split beside it) and the grid region', () => {
    const chip = (id: string) => doc.getElementById(id)!.closest('label')!.textContent!.trim();
    expect(chip('appSettingsShowTileGridButton')).toBe('平铺');
    expect(chip('appSettingsShowSplitButton')).toBe('分屏');
    expect(doc.getElementById('tileGrid')!.getAttribute('aria-label')).toBe('平铺的会话');
  });

  it("the Help modal's Tiles rows: Chinese around the key names", () => {
    const tiles = [...doc.querySelectorAll('#helpModal .shortcut-section')].find(
      (s) => s.querySelector('h4')!.textContent === '平铺'
    );
    expect(tiles).toBeTruthy();
    expect(leftover(tiles!.textContent!)).toEqual([]);
    expect(tiles!.textContent).toContain('切换平铺网格');
    expect(tiles!.textContent).toContain('右键单击');
  });

  it('user text stays as typed: a session name and a group name that are also UI words', () => {
    expect(doc.getElementById('u-session')!.textContent).toBe('Open tiles');
    expect(doc.getElementById('u-group')!.textContent).toBe('Tiles');
    expect(doc.getElementById('control')!.textContent).toBe('平铺');
  });
});

describe('user text in the tile code', () => {
  it('session names in a tile header, the picker and the + menu are marked data-i18n-skip', () => {
    // The harvest saw them only inside skipped subtrees.
    expect(userText.has('Open tiles')).toBe(true);
    expect([...seen.keys()]).not.toContain('s-1');
    const src = read('tile-grid.js');
    expect(src.match(/setAttribute\('data-i18n-skip', ''\)/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('the group names of the grouped rail are marked data-i18n-skip', () => {
    expect(read('tab-layout-browser.js')).toContain('class="tab-layout-group-name" id="${nameId}" data-i18n-skip>');
  });

  it('a session name inside the crash-restart confirm passes through the pattern untranslated', () => {
    expect(confirmText).toEqual(['Open tiles was stopped after crashing repeatedly. Restart it?']);
    expect(zh.api.t(confirmText[0])).toBe('Open tiles 因反复崩溃已被停止。要重启吗？');
  });
});
