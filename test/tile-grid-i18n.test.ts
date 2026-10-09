/**
 * @fileoverview The tile grid in Chinese (zh-CN): every string it puts on
 * screen has its own entry or pattern in i18n.js, so nothing is left in
 * English and nothing falls through to the generic leading-verb fallback.
 *
 * - Runtime strings are HARVESTED from the real tile code (the shared vm
 *   harness, test/mocks/tile-grid-vm.ts) driven through every state that
 *   writes text: the count menu (cap and window wording), the Attach
 *   overlay (not attached, attaching, exited, ended), zoom, the header
 *   tooltip, the dividers, the empty slot, every toast, the crash-restart
 *   confirm, the Tiles and Split button titles, the loading label (a body
 *   attribute, shown as CSS generated content) and the rename field's name.
 *   Each must translate to text with no Latin word left beyond key names and
 *   durations, and read unchanged in English.
 * - Static strings: the shortcut registry's tile entries (overlay and App
 *   Settings list), and index.html run through the real translator in JSDOM
 *   (the Tiles button, the App Settings chips, the Help modal's Tiles rows).
 * - No words in the tile CSS: generated content (`content: '...'`) is out of
 *   the translator's reach, so a tile rule may carry glyphs, never text.
 * - User text stays as typed: session names (tile header) and group names
 *   carry data-i18n-skip, and a session name inside the
 *   confirm passes through the pattern untranslated.
 *
 * Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import postcss from 'postcss';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  FakeEl,
  body,
  bySelector,
  fetchSpy,
  makeGridApp,
  resetGridHarness,
  section,
  tileEl,
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
const ALLOWED = /\b(Ctrl|Cmd|Shift|Alt|Option|Enter|G|F10)\b|<1m|\b\d+[dhm]\b/g;
const leftover = (text: string) => text.replace(ALLOWED, '').match(/[A-Za-z]+/g) ?? [];

/** Every string a translation must handle, with where it was seen. */
const seen = new Map<string, string>();
/** Text in a data-i18n-skip subtree (user text): must never be translated. */
const userText = new Set<string>();
/**
 * The harness logo's tooltip and accessible name (and the model box's
 * tooltip): harness and model NAMES, which stay as they are, plus at most a
 * note on where the model came from, which translates.
 */
const harnessLabels = new Map<string, string>();
/** The harness labels and models the exercise below gives its sessions. */
const HARNESS_NAMES = ['Claude Code', 'DeepSeek', 'Codex', 'qwen3.8-27b', 'Haiku 4.5', 'haiku', 'gpt-5.6-terra'];
/**
 * A title or accessible name inside a skipped subtree: the translator skips
 * the element's attributes along with its text, so a UI label there stays
 * English. Only the user text itself may be skipped.
 */
const labelsInSkip: string[] = [];

function harvest(root: FakeEl | null | undefined, where: string) {
  const walk = (el: FakeEl, inSkip: boolean) => {
    const skip = inSkip || 'data-i18n-skip' in el.attrs;
    const names = /\b(run-mode-dot|tile-model)\b/.test(el.className);
    const add = (value: unknown, kind: string) => {
      if (typeof value !== 'string' || !/[A-Za-z]/.test(value)) return;
      if (names && !skip && kind !== 'text') harnessLabels.set(value.trim(), `${where} (${kind})`);
      else if (skip && kind === 'text') userText.add(value.trim());
      else if (skip) labelsInSkip.push(`${where} (${kind}): ${value}`);
      else if (!seen.has(value.trim())) seen.set(value.trim(), `${where} (${kind})`);
    };
    add(el.textContent, 'text');
    add(el.title, 'title');
    add(el.attrs['aria-label'], 'aria-label');
    add(el.attrs.title, 'title attribute');
    // The loading label: CSS shows it (content: attr(data-loading-label)).
    add(el.dataset.loadingLabel, 'loading label');
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
  // The harness logos: a CLI-reported model, a launch one, a custom endpoint's, none.
  windowStub.__codemanCliCatalog = [
    { id: 'claude', label: 'Claude Code' },
    { id: 'deepseek', label: 'DeepSeek' },
    { id: 'codex', label: 'Codex' },
  ];
  Object.assign(app.sessions.get('s-1'), {
    mode: 'deepseek',
    displayModel: { model: 'qwen3.8-27b', source: 'screen' },
  });
  app.sessions.get('s-2').displayModel = { model: 'haiku', source: 'launch' };
  Object.assign(app.sessions.get('s-3'), {
    mode: 'codex',
    displayModel: { model: 'qwen3.8-27b', source: 'custom-endpoint' },
  });
  app.sessions.get('s-6').displayModel = { model: 'Haiku 4.5', source: 'statusline' };
  Object.assign(app.sessions.get('s-4'), {
    mode: 'deepseek',
    displayModel: { model: 'qwen3.8-27b', source: 'config' },
  });
  let pill = 'idle';
  app._sidebarRichRow = () => ({ state: pill, pill, since: { at: 1 } });
  app._mobileOverviewStampText = () => '3m';
  app.sessions.get('s-2').pid = null;
  app.sessions.get('s-3').paneExit = { status: 3 };
  app.sessions.get('s-4').paneExit = { signal: 9 };
  // A session named like a UI string (a count menu label): user text, never translated.
  app.sessions.get('s-5').name = '6 tiles';

  // The Tiles button's hover card, closed: the default count, then a count
  // the window cannot fit (the card is in body, harvested with it).
  app._applyTileGridButtonVisibility(true);
  harvestAll(app, 'hover card, closed');
  wrapRect = { width: 1200, height: 900 };
  app._rememberTileGridCount(6);
  harvestAll(app, 'hover card, does not fit');
  wrapRect = { width: 2400, height: 1200 };
  app._renderTileHint();

  // The count menu: the cap (nothing greyed), then the window wording.
  app.openTileCountMenu({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
  harvestAll(app, 'count menu, cap');
  app.closeTileCountMenu();
  wrapRect = { width: 1200, height: 900 };
  app.openTileCountMenu({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
  harvestAll(app, 'count menu, window');
  app.closeTileCountMenu();
  // A window that fits one tile words it in the singular.
  wrapRect = { width: 700, height: 500 };
  app.openTileCountMenu({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
  harvestAll(app, 'count menu, one tile');
  app.closeTileCountMenu();
  wrapRect = { width: 2400, height: 1200 };

  // The grid: five tiles first (an empty slot), then the sixth.
  app.openTileGrid(EIGHT.slice(0, 5));
  harvestAll(app, 'grid of five');
  // The hover card with the grid open, and a count it cannot fit there.
  section.getBoundingClientRect = () => ({ width: 1200, height: 900, top: 0, left: 0, right: 1200, bottom: 900 });
  app._renderTileHint();
  harvestAll(app, 'hover card, open, does not fit');
  delete (section as unknown as Record<string, unknown>).getBoundingClientRect;
  app._renderTileHint();
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

  // Renaming a tile: the input in the name's place, then Escape.
  app.startTileRename('s-1');
  harvestAll(app, 'renaming');
  tileEl('s-1').querySelector('.tile-rename-input')!.dispatch('keydown', { key: 'Escape', preventDefault: vi.fn() });

  // A file that is not an image dropped on a tile.
  section.dispatch('drop', {
    target: section.children.find((el) => el.dataset.sessionId === 's-1'),
    dataTransfer: { types: ['Files'], files: [{ type: 'application/pdf' }] },
    preventDefault: vi.fn(),
  });
  harvestAll(app, 'file drop');

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
      'How many tiles',
      'Tiles',
      'Tiles \u00B7 6',
      'Click: open the grid',
      'Click: close the grid',
      'Right-click: choose 2, 4 or 6 tiles',
      'Shift+F10: the same menu from the keyboard',
      'This window fits 4 tiles: a click opens 4',
      '2 tiles',
      '4 tiles',
      '6 tiles',
      'The grid holds at most 6 tiles',
      'This window fits 4 tiles',
      'This window fits 1 tile',
      'The grid already holds what this window fits (4)',
      'Drop a tab or a tile here',
      'Resize tile columns',
      'Resize tile rows',
      'Zoom this tile',
      'Restore the grid',
      'Session actions',
      'Remove tile (the session keeps running)',
      'idle 3m',
      'idle 3m\nDrag to move the tile',
      'needs you 3m\nDrag to move the tile',
      'exited 3m\nDrag to move the tile',
      'Not attached',
      'Attach',
      'Attaching…',
      'The agent exited (3)',
      'The agent exited (signal 9)',
      'The session ended',
      'It cannot be restarted in place: close it from ⋯ (Close session).',
      'The grid holds at most 6 tiles: the new session opens on its own',
      'The grid already holds what this window fits (4): the new session opens on its own',
      'The grid already holds what this window fits (4)',
      'The window is too small for 6 tiles: showing the focused one',
      'Could not attach the session',
      'This group has no session to show as tiles',
      'No sessions to show as tiles',
      'Only image files are supported',
      'Split: unavailable while tiles are open',
      'Tiles: show several sessions side by side (right-click for how many)',
      'Tiles: back to a single session (right-click for how many tiles)',
      '6 tiles was stopped after crashing repeatedly. Restart it?',
      'Loading…',
      'Session name',
    ];
    const missing = expected.filter((s) => !seen.has(s));
    expect(missing).toEqual([]);
  });

  it('each one: Chinese with no English left, and no half-translated fallback', () => {
    const bad: string[] = [];
    for (const [source, where] of seen) {
      const text = zh.api.t(source);
      // The session name inside the confirm is user text, allowed to stay.
      const words = leftover(text.replace('6 tiles', ''));
      if (text === source || words.length) bad.push(`${where}: "${source}" -> "${text}"`);
    }
    expect(bad).toEqual([]);
  });

  it('the harness logo keeps harness and model names as they are and translates the rest', () => {
    // Not vacuous: every form the logo's tooltip takes was seen.
    expect([...harnessLabels.keys()]).toEqual(
      expect.arrayContaining([
        'DeepSeek \u00B7 qwen3.8-27b',
        'Claude Code \u00B7 haiku (set at launch)',
        'Codex \u00B7 qwen3.8-27b (custom endpoint)',
        'DeepSeek \u00B7 qwen3.8-27b (from config)',
        'Claude Code \u00B7 Haiku 4.5',
        'Claude Code',
      ])
    );
    const bad: string[] = [];
    for (const [label, where] of harnessLabels) {
      const text = zh.api.t(label);
      const kept = HARNESS_NAMES.filter((n) => label.includes(n));
      let rest = text;
      for (const n of [...kept].sort((a, b) => b.length - a.length)) rest = rest.split(n).join('');
      if (!kept.length || kept.some((n) => !text.includes(n)) || leftover(rest).length || en.api.t(label) !== label) {
        bad.push(`${where}: "${label}" -> "${text}"`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the header tooltip with the drag hint: every state, with and without a duration', () => {
    // The harvest sees the hint under a state with a duration; a session the
    // overview gives no time yet shows the bare state above it.
    expect(zh.api.t('working 3m\nDrag to move the tile')).toBe('工作中 3m\n拖动可移动窗格');
    expect(zh.api.t('needs you <1m\nDrag to move the tile')).toBe('需要你 <1m\n拖动可移动窗格');
    expect(zh.api.t('idle\nDrag to move the tile')).toBe('空闲\n拖动可移动窗格');
    expect(zh.api.t('Drag to move the tile')).toBe('拖动可移动窗格');
    expect(en.api.t('idle\nDrag to move the tile')).toBe('idle\nDrag to move the tile');
  });

  it('no UI label sits inside a skipped subtree (where the translator cannot reach it)', () => {
    expect(labelsInSkip).toEqual([]);
  });

  it('each one reads exactly as before in English', () => {
    const changed = [...seen.keys()].filter((s) => en.api.t(s) !== s);
    expect(changed).toEqual([]);
  });

  it('the shortcut registry entries: the Tiles group, its labels, "not bound", the group menu item', () => {
    const app = read('app.js');
    const labels = [...app.matchAll(/group: 'Tiles',\s*label: '([^']+)'/g)].map((m) => m[1]);
    expect(labels).toHaveLength(11);
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
    '<span id="u-session" data-i18n-skip>6 tiles</span>' +
    '<span id="u-group" class="tab-layout-group-name" data-i18n-skip>Tiles</span>' +
    '<span id="control">Tiles</span>';
  doc.body.appendChild(extra);
  const api = (dom.window as unknown as { CodemanI18n: Api }).CodemanI18n;
  api.start();
  api.configure({ language: 'zh-CN' });

  it('the Tiles header button: its accessible name, no native title, its description is the hover card', () => {
    const btn = doc.querySelector('.btn-tile-grid')!;
    const label = btn.getAttribute('aria-label')!;
    expect(label).toContain('平铺');
    expect(leftover(label)).toEqual([]);
    expect(btn.hasAttribute('title')).toBe(false);
    expect(btn.getAttribute('aria-describedby')).toBe('tileGridHint');
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
    expect(tiles!.textContent).toContain('选择窗格数量（2、4 或 6）');
    // Moving tiles: the chords and the header drag.
    expect(tiles!.textContent).toContain('向左 / 右 / 上 / 下移动窗格');
    expect(tiles!.textContent).toContain('拖动');
    expect(tiles!.textContent).toContain('窗格的标题栏');
  });

  it('user text stays as typed: a session name and a group name that are also UI words', () => {
    expect(doc.getElementById('u-session')!.textContent).toBe('6 tiles');
    expect(doc.getElementById('u-group')!.textContent).toBe('Tiles');
    expect(doc.getElementById('control')!.textContent).toBe('平铺');
  });
});

describe('user text in the tile code', () => {
  it('session names in a tile header are marked data-i18n-skip', () => {
    // The harvest saw them only inside skipped subtrees.
    expect(userText.has('6 tiles')).toBe(true);
    expect([...seen.keys()]).not.toContain('s-1');
    const src = read('tile-grid.js');
    expect(src.match(/setAttribute\('data-i18n-skip', ''\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('the group names of the grouped rail are marked data-i18n-skip', () => {
    expect(read('tab-layout-browser.js')).toContain('class="tab-layout-group-name" id="${nameId}" data-i18n-skip>');
  });

  it('a session name inside the crash-restart confirm passes through the pattern untranslated', () => {
    expect(confirmText).toEqual(['6 tiles was stopped after crashing repeatedly. Restart it?']);
    expect(zh.api.t(confirmText[0])).toBe('6 tiles 因反复崩溃已被停止。要重启吗？');
  });
});

describe('the loading label: CSS generated content, written in the UI language', () => {
  it('goes through the translator when the tile is built, and again each time the tile starts loading', () => {
    setUp();
    const Queue = windowStub.TileLoadQueue;
    const queue: { onChange?: (tile: unknown, state: string) => void } = {};
    windowStub.TileLoadQueue = class {
      constructor(opts: { onChange: (tile: unknown, state: string) => void }) {
        queue.onChange = opts.onChange;
      }
      schedule() {}
      drop() {}
    };
    try {
      windowStub.codemanT = zh.api.t;
      const app = makeGridApp(EIGHT);
      app.openTileGrid(EIGHT.slice(0, 2));
      const entry = app._tileGrid.tiles.get('s-1');
      expect(entry.body.dataset.loadingLabel).toBe('加载中…');
      // A language switched since is picked up the next time the tile loads.
      windowStub.codemanT = en.api.t;
      app._tileLoadQueue();
      queue.onChange!(entry.tile, 'queued');
      expect(entry.el.classList.contains('tile--loading')).toBe(true);
      expect(entry.body.dataset.loadingLabel).toBe('Loading…');
      queue.onChange!(entry.tile, 'idle');
      expect(entry.el.classList.contains('tile--loading')).toBe(false);
    } finally {
      windowStub.TileLoadQueue = Queue;
      delete windowStub.codemanT;
    }
  });

  it('no tile rule carries words in generated content (the translator cannot reach it)', () => {
    const bad: string[] = [];
    const contents = new Map<string, string>();
    postcss.parse(read('styles.css')).walkRules((rule) => {
      if (!/\.tile\b/.test(rule.selector)) return;
      rule.walkDecls('content', (decl) => {
        contents.set(rule.selector, decl.value);
        // CSS escapes are glyphs (\2026, \00B7), not words.
        const literals = [...decl.value.matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) =>
          (m[1] ?? m[2]).replace(/\\[0-9a-fA-F]{1,6}\s?/g, '')
        );
        if (literals.some((text) => /[A-Za-z]/.test(text))) bad.push(`${rule.selector} { content: ${decl.value} }`);
      });
    });
    // Not vacuous: the loading label is one of the rules read.
    expect(contents.get('.tile.tile--loading .tile-body::after')).toBe('attr(data-loading-label)');
    expect(bad).toEqual([]);
  });
});
