/**
 * @fileoverview A tile's header: `● [logo] name · model ..... ⋯ ⤢ ×`, and the tab marker.
 *
 * - The logo is PR #532's `run-mode-dot <cliId>` slot (the id is data); the
 *   logo's tooltip and accessible name carry the harness and the model, with
 *   where the model came from when the CLI did not report it. The model is
 *   text (never markup, never translated), and an unknown model shows nothing.
 *   An unchanged session writes nothing on a refresh.
 * - The dot uses the six-state classifier the tab rows and both home screens
 *   share (`_sidebarRichRow`), with the existing `.home-sessions-dot--*`
 *   classes; a `needs` tile gets the pulsing red border; hovering shows the
 *   state and how long ("working 3m").
 * - The name is text, never markup, and carries `data-i18n-skip`; a
 *   double-click renames through the tab rename's own write queue.
 * - `⋯` is the tab rail's session menu; `×` removes the tile ONLY (the
 *   session keeps running), and neither button focuses a tile that is not
 *   focused (which would spend its idle alert).
 * - Every tab render refreshes the headers, so they follow session changes.
 * - Tabs of tiled sessions carry `.in-tiles`.
 *
 * Real code via the shared vm harness (test/mocks/tile-grid-vm.ts). Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss, { type AtRule } from 'postcss';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeEl,
  FakeTile,
  makeGridApp,
  resetGridHarness,
  type GridApp,
  tileEl,
  windowStub,
} from './mocks/tile-grid-vm.js';

const IDS = ['s-a', 's-b', 's-c'];

/** A grid on IDS with the shared classifier stand-ins mobile-overview.js would provide. */
function openGrid(): GridApp {
  const app = makeGridApp(IDS);
  app._mobileOverviewState = (session: { status?: string }, hooks?: Set<string>) =>
    hooks?.has('permission_prompt') ? 'needs' : session.status === 'busy' ? 'working' : 'idle';
  app._mobileOverviewSince = (_state: string, session: { lastActivityAt?: number }) => ({
    key: 'x',
    at: session.lastActivityAt || 0,
  });
  app._mobileOverviewExit = () => null;
  app._mobileOverviewStampText = (at: number) => (at ? '3m' : '');
  app.openTileGrid(IDS);
  app.markIdleAlertSeen.mockClear();
  return app;
}

const headerOf = (id: string) => tileEl(id).children[0];
/** A header part by its class, wherever the header nests it. */
const partOf = (id: string, cls: string) => headerOf(id).querySelector(`.${cls}`) as FakeEl;
const buttonOf = (id: string, cls: string) =>
  partOf(id, 'tile-actions').children.find((b) => b.className.includes(cls)) as FakeEl;
/** Where the name sits: the name itself, or the rename input in its place. */
const nameSlotOf = (id: string) => partOf(id, 'tile-title').children[0];

beforeEach(() => {
  resetGridHarness();
});

describe('the header', () => {
  it('shows the session name as text, skipped by the translator', () => {
    const app = makeGridApp(IDS);
    app.sessions.get('s-b').name = '<b>Sessions</b>';
    app.openTileGrid(IDS);
    const name = partOf('s-b', 'tile-name');
    expect(name.textContent).toBe('<b>Sessions</b>');
    expect(name.getAttribute('data-i18n-skip')).toBe('');
    expect(name.children).toHaveLength(0);
  });

  it('header and body are siblings, the body holding the terminal', () => {
    openGrid();
    const el = tileEl('s-a');
    expect(el.children.map((c) => c.className)).toEqual(['tile-header', 'tile-body']);
    expect(FakeTile.all.find((t) => t.sessionId === 's-a')?.mountEl).toBe(el.children[1]);
  });

  it('the dot follows the session state, a permission prompt marks the whole tile', () => {
    const app = openGrid();
    app.sessions.get('s-b').status = 'busy';
    app.pendingHooks.set('s-c', new Set(['permission_prompt']));
    app._renderTileChrome();

    expect(partOf('s-a', 'tile-dot').className).toContain('home-sessions-dot--idle');
    expect(partOf('s-b', 'tile-dot').className).toContain('home-sessions-dot--working');
    expect(partOf('s-c', 'tile-dot').className).toContain('home-sessions-dot--needs');
    expect(tileEl('s-c').classList.contains('tile--needs')).toBe(true);
    expect(tileEl('s-b').classList.contains('tile--needs')).toBe(false);
  });

  it('hovering says the state and for how long', () => {
    const app = openGrid();
    app.sessions.get('s-b').status = 'busy';
    app.sessions.get('s-b').lastActivityAt = Date.now() - 180_000;
    app._renderTileChrome();
    // While tiles can move, a second line says the header drags.
    expect(headerOf('s-b').title).toBe('working 3m\nDrag to move the tile');
  });

  it('every tab render refreshes the headers', () => {
    const app = openGrid();
    app._renderTileChrome = vi.fn();
    // The original returns at once during an inline tab rename; the headers still refresh.
    app._inlineRenameActive = true;
    app._renderSessionTabsImmediate();
    expect(app._renderTileChrome).toHaveBeenCalledTimes(1);
  });
});

describe('the harness logo and the model', () => {
  const CATALOG = [
    { id: 'claude', label: 'Claude Code' },
    { id: 'deepseek', label: 'DeepSeek' },
    { id: 'shell', label: 'Shell' },
  ];

  /** s-a on dsh's route, s-b claude on its statusline's model, s-c a shell. */
  function harnessGrid(): GridApp {
    windowStub.__codemanCliCatalog = CATALOG;
    const app = makeGridApp(IDS);
    app.sessions.get('s-a').mode = 'deepseek';
    app.sessions.get('s-a').displayModel = { model: 'qwen3.8-27b', source: 'screen' };
    app.sessions.get('s-b').displayModel = { model: 'Haiku 4.5', source: 'statusline' };
    app.sessions.get('s-c').mode = 'shell';
    app.openTileGrid(IDS);
    return app;
  }
  const logoOf = (id: string) => partOf(id, 'tile-harness');
  const modelOf = (id: string) => partOf(id, 'tile-model');
  const modelNameOf = (id: string) => modelOf(id).children[0];

  it('sits between the dot and the name: `● [logo] name · model ... ⋯ ⤢ ×`', () => {
    harnessGrid();
    expect(headerOf('s-a').children.map((c) => c.className.split(' ')[0])).toEqual([
      'tile-dot',
      'tile-harness',
      'tile-title',
      'tile-actions',
    ]);
    expect(partOf('s-a', 'tile-title').children.map((c) => c.className)).toEqual(['tile-name', 'tile-model']);
  });

  it("draws the session's CLI as PR #532's logo slot, the id as data", () => {
    harnessGrid();
    expect(logoOf('s-a').className).toBe('tile-harness run-mode-dot deepseek');
    expect(logoOf('s-b').className).toBe('tile-harness run-mode-dot claude');
    expect(logoOf('s-c').className).toBe('tile-harness run-mode-dot shell');
    expect(logoOf('s-a').getAttribute('role')).toBe('img');
  });

  it('names the harness and the model in the tooltip and the accessible name', () => {
    harnessGrid();
    expect(logoOf('s-a').title).toBe('DeepSeek \u00B7 qwen3.8-27b');
    expect(logoOf('s-a').getAttribute('aria-label')).toBe('DeepSeek \u00B7 qwen3.8-27b');
    expect(modelOf('s-a').title).toBe('DeepSeek \u00B7 qwen3.8-27b');
    expect(modelNameOf('s-a').textContent).toBe('qwen3.8-27b');
    expect(modelOf('s-a').hidden).toBe(false);
    // Said once to a screen reader: the model's box is hidden from it.
    expect(modelOf('s-a').getAttribute('aria-hidden')).toBe('true');
    // The model name is never translated; its tooltip may be.
    expect(modelNameOf('s-a').getAttribute('data-i18n-skip')).toBe('');
    expect(modelOf('s-a').getAttribute('data-i18n-skip')).toBeNull();
  });

  it('an unknown model shows the logo alone: no text, no placeholder', () => {
    harnessGrid();
    expect(modelOf('s-c').hidden).toBe(true);
    expect(modelNameOf('s-c').textContent).toBe('');
    expect(logoOf('s-c').title).toBe('Shell');
  });

  it('says in the tooltip where a model came from when the CLI did not report it', () => {
    const app = harnessGrid();
    app.sessions.get('s-b').displayModel = { model: 'haiku', source: 'launch' };
    app.sessions.get('s-c').mode = 'claude';
    app.sessions.get('s-c').displayModel = { model: 'qwen3.8-27b', source: 'custom-endpoint' };
    app._renderTileChrome();
    expect(logoOf('s-b').title).toBe('Claude Code \u00B7 haiku (set at launch)');
    expect(logoOf('s-c').title).toBe('Claude Code \u00B7 qwen3.8-27b (custom endpoint)');
    app.sessions.get('s-a').displayModel = { model: 'qwen3.8-27b', source: 'config' };
    app._renderTileChrome();
    expect(logoOf('s-a').title).toBe('DeepSeek \u00B7 qwen3.8-27b (from config)');
    expect(modelNameOf('s-a').textContent).toBe('qwen3.8-27b');
    expect(modelNameOf('s-b').textContent).toBe('haiku');
  });

  it('a model change (session:updated) updates the header', () => {
    const app = harnessGrid();
    app.sessions.set('s-b', {
      ...app.sessions.get('s-b'),
      displayModel: { model: 'Sonnet 4.6', source: 'statusline' },
    });
    app._renderTileChrome();
    expect(modelNameOf('s-b').textContent).toBe('Sonnet 4.6');
    expect(logoOf('s-b').title).toBe('Claude Code \u00B7 Sonnet 4.6');
    // And the model going away takes the text with it.
    delete app.sessions.get('s-b').displayModel;
    app._renderTileChrome();
    expect(modelOf('s-b').hidden).toBe(true);
    expect(modelNameOf('s-b').textContent).toBe('');
  });

  it('a model with markup stays text', () => {
    const app = harnessGrid();
    app.sessions.get('s-b').displayModel = { model: '<img src=x onerror=alert(1)>', source: 'statusline' };
    app._renderTileChrome();
    expect(modelNameOf('s-b').textContent).toBe('<img src=x onerror=alert(1)>');
    expect(modelNameOf('s-b').children).toHaveLength(0);
    expect(modelOf('s-b').children).toHaveLength(1);
  });

  it('an unchanged session writes nothing on a refresh', () => {
    const app = harnessGrid();
    const writes: string[] = [];
    for (const id of IDS) {
      for (const [node, props] of [
        [logoOf(id), ['className', 'title']],
        [modelOf(id), ['title', 'hidden']],
        [modelNameOf(id), ['textContent']],
      ] as Array<[FakeEl, string[]]>) {
        for (const prop of props) {
          let value = (node as unknown as Record<string, unknown>)[prop];
          Object.defineProperty(node, prop, {
            get: () => value,
            set: (v) => {
              writes.push(`${id} ${prop}`);
              value = v;
            },
          });
        }
        const setAttribute = node.setAttribute.bind(node);
        node.setAttribute = (k: string, v: string) => {
          writes.push(`${id} @${k}`);
          setAttribute(k, v);
        };
      }
    }
    app._renderTileChrome();
    app._renderTileChrome();
    expect(writes).toEqual([]);
  });

  it('an id that is not a CLI id is not a class name; without a catalog the label is the id', () => {
    const app = harnessGrid();
    delete windowStub.__codemanCliCatalog;
    app.sessions.get('s-a').mode = 'bad id" onclick';
    app.sessions.get('s-b').mode = 'my-cli';
    app._renderTileChrome();
    expect(logoOf('s-a').className).toBe('tile-harness run-mode-dot');
    expect(logoOf('s-a').title).toBe('qwen3.8-27b');
    expect(logoOf('s-b').className).toBe('tile-harness run-mode-dot my-cli');
    expect(logoOf('s-b').title).toBe('my-cli \u00B7 Haiku 4.5');
  });
});

describe('header buttons', () => {
  it('are ⋯ ⤢ × and nothing else: no + (owner decision 9)', () => {
    const app = openGrid();
    const tile = tileEl('s-a');
    const actions = tile.children[0].children.find((c) => c.className === 'tile-actions') as FakeEl;
    expect(actions.children.map((b) => b.className)).toEqual([
      'tile-btn tile-menu',
      'tile-btn tile-zoom',
      'tile-btn tile-remove',
    ]);
    expect(actions.children.map((b) => b.textContent)).toEqual(['\u22EF', '\u2922', '\u00D7']);
    // The + menu and its "New session in this case" went with it.
    for (const gone of ['openTileAddMenu', 'closeTileAddMenu', 'runInCaseForTiles']) {
      expect(gone in app, gone).toBe(false);
    }
  });

  it('× removes the tile only: the session keeps running, a neighbour takes focus unacknowledged', () => {
    const app = openGrid();
    app._apiDelete = vi.fn();
    buttonOf('s-a', 'tile-remove').dispatch('click', { stopPropagation: vi.fn() });

    expect(app._tileGrid.ids).toEqual(['s-b', 's-c']);
    expect(app.sessions.has('s-a')).toBe(true);
    expect(app._apiDelete).not.toHaveBeenCalled();
    expect(app.activeSessionId).toBe('s-b');
    expect(app.markIdleAlertSeen).not.toHaveBeenCalled();
  });

  it('× on the last tile shows that session in the single view', () => {
    const app = makeGridApp(['s-a']);
    app.openTileGrid(['s-a']);
    app.selectSession = vi.fn();
    buttonOf('s-a', 'tile-remove').dispatch('click', { stopPropagation: vi.fn() });
    expect(app._tilesOwnTerminal()).toBe(false);
    expect(app.selectSession).toHaveBeenCalledWith('s-a', { forceReload: true, auto: true });
  });

  it('⋯ opens the tab rail session menu for that session', () => {
    const app = openGrid();
    app.openTabRailActionMenu = vi.fn();
    const ev = { stopPropagation: vi.fn() };
    buttonOf('s-c', 'tile-menu').dispatch('click', ev);
    expect(app.openTabRailActionMenu).toHaveBeenCalledWith(ev, 's-c');
  });

  it('pressing a header button never focuses the tile (no selection, no acknowledgement)', () => {
    const app = openGrid();
    app.selectSession = vi.fn();
    const stop = vi.fn();
    buttonOf('s-c', 'tile-remove').dispatch('pointerdown', { stopPropagation: stop });
    expect(stop).toHaveBeenCalled();
    // The tile's own pointerdown (a focus) only runs if the event reaches it.
    tileEl('s-c').dispatch('pointerdown', {});
    expect(app.selectSession).toHaveBeenCalledWith('s-c');
  });
});

describe('header button size (owner feedback: the 12px glyphs read as tiny)', () => {
  const css = readFileSync(resolve(import.meta.dirname, '../src/web/public/styles.css'), 'utf8');
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    return at === -1 ? '' : css.slice(at, css.indexOf('}', at));
  };

  it("buttons are the app header's icon size: 26px targets, a 16px glyph, never the header's inherited 12px", () => {
    const btn = rule('.tile-btn');
    expect(btn).toContain('min-width: 26px;');
    expect(btn).toContain('height: 26px;');
    expect(btn).toContain('font-size: 16px;');
    expect(btn).not.toMatch(/\bfont: inherit;/);
  });

  it('the thin glyphs (ellipsis, cross) get a step more, and the header holds the buttons', () => {
    expect(rule('.tile-btn.tile-menu,\n.tile-btn.tile-remove')).toContain('font-size: 19px;');
    const header = rule('.tile-header');
    expect(header).toContain('flex: 0 0 28px;');
    expect(header).toContain('height: 28px;');
  });
});

describe('a translated label survives a refresh (zh-CN)', () => {
  // The i18n observer writes the translation into the DOM. Comparing the DOM
  // with the English source would never match again, so each refresh would
  // rewrite English for the observer to translate again. The guards compare
  // with the last English value set instead.
  it('the header tooltip, the Attach overlay text and the zoom title stay translated until they change', () => {
    const app = makeGridApp(['s-a', 's-b']);
    let pill = 'idle';
    app._sidebarRichRow = () => ({ state: pill, pill, since: { at: 1 } });
    app._mobileOverviewStampText = () => '3m';
    app.sessions.get('s-b').pid = null;
    app.openTileGrid(['s-a', 's-b']);
    const a = app._tileGrid.tiles.get('s-a');
    const b = app._tileGrid.tiles.get('s-b');
    expect(a.header.title).toBe('idle 3m\nDrag to move the tile');
    expect(b.overlayText.textContent).toBe('Not attached');
    app.zoomTile('s-a');
    expect(a.zoomBtn.title).toBe('Restore the grid');
    // Zoomed, nothing moves: the drag hint goes.
    expect(a.header.title).toBe('idle 3m');

    // What the translator does to them.
    a.header.title = '空闲 3m';
    b.overlayText.textContent = '未附加';
    a.zoomBtn.title = '恢复平铺网格';
    app._renderTileChrome();
    app._applyTileLayout();
    expect(a.header.title).toBe('空闲 3m');
    expect(b.overlayText.textContent).toBe('未附加');
    expect(a.zoomBtn.title).toBe('恢复平铺网格');

    // A real change still writes the new English, for the translator to take.
    pill = 'working';
    app._renderTileChrome();
    expect(a.header.title).toBe('working 3m');
    app.zoomTile('s-a');
    expect(a.zoomBtn.title).toBe('Zoom this tile');
  });
});

describe('rename', () => {
  function startRename(app: GridApp, id: string) {
    nameSlotOf(id).dispatch('dblclick', { stopPropagation: vi.fn() });
    return nameSlotOf(id);
  }

  it('double-click puts an input in place of the name; Enter renames through the write queue', () => {
    const app = openGrid();
    // The real queue records the name in flight before its PUT lands.
    app._inlineRenamePending = new Map();
    app._queueInlineSessionName = vi.fn(async (id: string, name: string) => {
      app._inlineRenamePending.set(id, name);
      return { status: 'confirmed' };
    });
    const input = startRename(app, 's-b');
    expect(input.className).toBe('tile-rename-input');
    expect(input.value).toBe('s-b');

    input.value = 'renamed';
    input.dispatch('keydown', { key: 'Enter', preventDefault: vi.fn() });
    expect(app._queueInlineSessionName).toHaveBeenCalledWith('s-b', 'renamed');
    expect(nameSlotOf('s-b').className).toBe('tile-name');
    expect(nameSlotOf('s-b').textContent).toBe('renamed');
  });

  it('Escape cancels without a write', () => {
    const app = openGrid();
    app._queueInlineSessionName = vi.fn();
    const input = startRename(app, 's-b');
    input.value = 'nope';
    input.dispatch('keydown', { key: 'Escape', preventDefault: vi.fn() });
    expect(app._queueInlineSessionName).not.toHaveBeenCalled();
    expect(nameSlotOf('s-b').textContent).toBe('s-b');
  });

  it('a header refresh while renaming leaves the input alone', () => {
    const app = openGrid();
    const input = startRename(app, 's-b');
    input.value = 'half-typed';
    app._renderTileChrome();
    expect(nameSlotOf('s-b')).toBe(input);
    expect(input.value).toBe('half-typed');
  });

  it('an IME composition owns Enter', () => {
    const app = openGrid();
    app._queueInlineSessionName = vi.fn();
    const input = startRename(app, 's-b');
    input.value = 'x';
    input.dispatch('keydown', { key: 'Enter', isComposing: true, preventDefault: vi.fn() });
    expect(app._queueInlineSessionName).not.toHaveBeenCalled();
    expect(nameSlotOf('s-b')).toBe(input);
  });
});

describe('the tab marker', () => {
  // Tab rendering needs the whole strip; the class is pinned at both render paths.
  const app = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');

  it('the full render puts .in-tiles on a tiled session tab', () => {
    expect(app).toContain("${this._tileGrid?.has(id) ? ' in-tiles' : ''}");
  });

  it('the incremental render toggles it', () => {
    expect(app).toContain("tab.classList.toggle('in-tiles', !!this._tileGrid?.has(id));");
  });

  it('it has a style', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../src/web/public/styles.css'), 'utf8');
    expect(css).toMatch(/\.session-tab\.in-tiles/);
  });

  it('every tab arrangement that draws its own cell shadow keeps the marker in it', () => {
    // The marker is an inset box-shadow, so an arrangement that paints its
    // cells with a box-shadow of its own (the ledger's status bar, #538)
    // replaces it unless it restates the marker alongside its own shadow.
    const css = readFileSync(resolve(import.meta.dirname, '../src/web/public/styles.css'), 'utf8');
    type Found = { selector: string; shadow: string; media: string };
    const shadows: Found[] = [];
    postcss.parse(css).walkRules((rule) => {
      let shadow = '';
      rule.walkDecls('box-shadow', (d) => {
        shadow = d.value;
      });
      if (!shadow) return;
      const media: string[] = [];
      for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
        if (p.type === 'atrule') media.push((p as AtRule).params);
      }
      for (const selector of rule.selectors) shadows.push({ selector, shadow, media: media.join(' ') });
    });
    const marker = shadows.find((r) => r.selector === '.session-tab.in-tiles:not(.active)');
    expect(marker?.shadow).toMatch(/^inset 0 -2px 0 /);
    // A whole tab cell at rest, scoped to an arrangement: not a pseudo-element,
    // not a passing state (hover, press, drag) and not the active tab, which
    // the marker skips anyway.
    const cells = shadows.filter((r) => {
      const last = r.selector.split(/\s*[\s>+~]\s*/).pop()!;
      return (
        /^\.session-tab(?![\w-])/.test(last) &&
        r.selector !== last &&
        !/::|:hover|:active|\.active(?![\w-])|drag-over|in-tiles/.test(last.replace(':not(.active)', ''))
      );
    });
    expect(cells.map((r) => r.selector)).toContain('.session-tabs-host > .session-tabs.tabs-ledger > .session-tab');
    const missing = cells.filter((cell) => {
      const tiled = shadows.find(
        (r) => r.selector === `${cell.selector}.in-tiles:not(.active)` && r.media === cell.media
      );
      return !tiled || !tiled.shadow.includes(cell.shadow) || !tiled.shadow.includes(marker!.shadow);
    });
    expect(missing.map((r) => r.selector)).toEqual([]);
  });
});
