/**
 * @fileoverview The tile grid's chords: registry entries, when they apply, and
 * that a chord which applies never reaches a PTY.
 *
 * Defaults (all rebindable in App Settings, Shortcuts): Ctrl+Shift+G toggles
 * the grid, Alt+Shift+Arrows move focus between tiles, Ctrl+Shift+Arrows move
 * the focused tile (tile-grid-move.test.ts), Remove Focused Tile is unbound. The toggle applies wherever a grid could open; the focus and remove
 * chords only while the grid is open, so outside it Alt+Shift+Arrows reach the
 * terminal untouched. The capture-phase handler (app.js) dispatches a chord
 * that applies; its preventDefault() does not stop xterm, so every xterm key
 * handler (the main terminal's and TerminalTile's) returns false for it too,
 * for every event type and before the Shift+Enter gate (which would otherwise
 * send S-Enter for Alt+Shift+Enter style chords).
 *
 * Real code: the grid harness (test/mocks/tile-grid-vm.ts) for the registry,
 * the capture handler and the actions; a second `vm` context with the real
 * TerminalTile for its key handler; the main terminal's handler, which needs a
 * real xterm, is pinned at the source. Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  documentAddEventListener,
  makeGridApp,
  resetGridHarness,
  windowStub as gridWindow,
  type GridApp,
} from './mocks/tile-grid-vm.js';

const IDS = ['s-a', 's-b', 's-c'];
const read = (f: string) => readFileSync(resolve(import.meta.dirname, `../src/web/public/${f}`), 'utf8');

const chord = (overrides: Record<string, unknown>) => ({
  type: 'keydown',
  key: '',
  code: '',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  preventDefault: vi.fn(),
  target: { closest: () => null },
  ...overrides,
});
const TOGGLE = { key: 'G', code: 'KeyG', ctrlKey: true, shiftKey: true };
/** The per-device Tiles setting on (it enables the Tiles button and the toggle chord). */
const withTilesSetting = (app: GridApp) => {
  app.loadAppSettingsFromStorage = () => ({ showTileGridButton: true });
  return app;
};
const RIGHT = { key: 'ArrowRight', code: 'ArrowRight', altKey: true, shiftKey: true };

beforeEach(() => {
  resetGridHarness();
});

describe('registry', () => {
  it('ships the tile chords, rebindable, with Remove Focused Tile unbound', () => {
    const app = makeGridApp(IDS);
    const byId = Object.fromEntries(app.getShortcutRegistry().map((s: { id: string }) => [s.id, s])) as Record<
      string,
      { bindings: Array<Record<string, unknown>>; group: string }
    >;
    expect(byId['toggle-tile-grid'].bindings).toEqual([{ modifiers: ['ctrl', 'shift'], key: 'G', code: 'KeyG' }]);
    for (const dir of ['Left', 'Right', 'Up', 'Down']) {
      expect(byId[`focus-tile-${dir.toLowerCase()}`].bindings).toEqual([
        { modifiers: ['alt', 'shift'], key: `Arrow${dir}` },
      ]);
      // Moving the focused tile (tile-grid-move.test.ts).
      expect(byId[`move-tile-${dir.toLowerCase()}`].bindings).toEqual([
        { modifiers: ['ctrl', 'shift'], key: `Arrow${dir}` },
      ]);
      expect(byId[`move-tile-${dir.toLowerCase()}`].group).toBe('Tiles');
    }
    expect(byId['remove-tile'].bindings).toEqual([]);
    expect(byId['toggle-tile-grid'].group).toBe('Tiles');
  });
});

describe('when a chord applies', () => {
  it('with the Tiles setting on, the toggle applies wherever a grid could open, and while one is open', () => {
    const app = withTilesSetting(makeGridApp(IDS));
    expect(app.tileShortcutFor(chord(TOGGLE))).toBe('toggle-tile-grid');
    app.openTileGrid(IDS);
    expect(app.tileShortcutFor(chord(TOGGLE))).toBe('toggle-tile-grid');
  });

  it('with the Tiles setting off (the default) the toggle is inert, like an unbound key', () => {
    const app = makeGridApp(IDS);
    expect(app.tileShortcutFor(chord(TOGGLE))).toBeNull();
  });

  it('with the setting off, a grid opened another way (Ctrl+click, a drop) still has its chords, toggle included', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(IDS);
    expect(app.tileShortcutFor(chord(RIGHT))).toBe('focus-tile-right');
    expect(app.tileShortcutFor(chord(TOGGLE))).toBe('toggle-tile-grid');
  });

  it('the toggle does not apply in a narrow window or a solo window', () => {
    const app = withTilesSetting(makeGridApp(IDS));
    gridWindow.innerWidth = 1000;
    expect(app.tileShortcutFor(chord(TOGGLE))).toBeNull();
    gridWindow.innerWidth = 2400;
    app.isSoloWindow = true;
    expect(app.tileShortcutFor(chord(TOGGLE))).toBeNull();
  });

  it('the focus chords apply only while the grid is open', () => {
    const app = makeGridApp(IDS);
    expect(app.tileShortcutFor(chord(RIGHT))).toBeNull();
    app.openTileGrid(IDS);
    expect(app.tileShortcutFor(chord(RIGHT))).toBe('focus-tile-right');
  });

  it('the focus chords leave a text field its keys (shifted arrows select there); a terminal still gets them', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(IDS);
    for (const tagName of ['INPUT', 'TEXTAREA']) {
      const target = { tagName, closest: () => null, classList: { contains: () => false } };
      expect(app.tileShortcutFor(chord({ ...RIGHT, target }))).toBeNull();
    }
    expect(
      app.tileShortcutFor(chord({ ...RIGHT, target: { isContentEditable: true, closest: () => null } }))
    ).toBeNull();
    // xterm's own input is a textarea too, and the chord is the grid's there.
    const xterm = {
      tagName: 'TEXTAREA',
      closest: () => null,
      classList: { contains: (c: string) => c === 'xterm-helper-textarea' },
    };
    expect(app.tileShortcutFor(chord({ ...RIGHT, target: xterm }))).toBe('focus-tile-right');
    // Not an arrow chord: the toggle and zoom still apply from a field.
    const input = { tagName: 'INPUT', closest: () => null, classList: { contains: () => false } };
    expect(app.tileShortcutFor(chord({ ...TOGGLE, target: input }))).toBe('toggle-tile-grid');
  });

  it('plain typing and unrelated chords never match', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(IDS);
    expect(app.tileShortcutFor(chord({ key: 'g', code: 'KeyG' }))).toBeNull();
    expect(app.tileShortcutFor(chord({ key: 'ArrowRight', altKey: true }))).toBeNull();
    expect(app.tileShortcutFor(chord({ key: 'G', code: 'KeyG', ctrlKey: true }))).toBeNull();
  });

  it('honours a disable and a rebind from App Settings', () => {
    const app = makeGridApp(IDS);
    app.loadAppSettingsFromStorage = () => ({
      shortcutOverrides: {
        'toggle-tile-grid': { disabled: true },
        'focus-tile-right': { bindings: [{ modifiers: ['ctrl', 'alt'], key: 'l', code: 'KeyL' }] },
      },
    });
    expect(app.tileShortcutFor(chord(TOGGLE))).toBeNull();
    app.openTileGrid(IDS);
    expect(app.tileShortcutFor(chord(RIGHT))).toBeNull();
    expect(app.tileShortcutFor(chord({ key: 'l', code: 'KeyL', ctrlKey: true, altKey: true }))).toBe(
      'focus-tile-right'
    );
  });
});

describe('the capture-phase handler', () => {
  function handlerFor(app: GridApp) {
    app.$ = () => null;
    app.setupColorPicker = vi.fn();
    const before = (documentAddEventListener.mock.calls as unknown[]).length;
    app.setupEventListeners();
    const added = (documentAddEventListener.mock.calls as Array<[string, (e: unknown) => void, boolean]>).slice(before);
    const keydown = added.find(([type, , capture]) => type === 'keydown' && capture === true);
    if (!keydown) throw new Error('no capture-phase keydown listener');
    return keydown[1];
  }

  it('setting off: Ctrl+Shift+G is left alone (no preventDefault), the grid stays closed', () => {
    const app = makeGridApp(IDS);
    const onKeydown = handlerFor(app);
    const e = chord(TOGGLE);
    onKeydown(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(app._tilesOwnTerminal()).toBe(false);
  });

  it('Ctrl+Shift+G opens the grid on the open sessions (the active one focused), then closes it, overriding the browser', () => {
    const app = withTilesSetting(makeGridApp(IDS));
    app.selectSession = vi.fn();
    const onKeydown = handlerFor(app);
    const open = chord(TOGGLE);
    onKeydown(open);
    expect(open.preventDefault).toHaveBeenCalled();
    expect(app._tileGrid.ids).toEqual(['s-other', ...IDS]);
    expect(app.activeSessionId).toBe('s-a');

    onKeydown(chord(TOGGLE));
    expect(app._tilesOwnTerminal()).toBe(false);
    expect(app.selectSession).toHaveBeenCalledWith('s-a', { forceReload: true, auto: true });
  });

  it('Alt+Shift+Right moves focus to the tile on the right, as a human selection', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(IDS);
    app.markIdleAlertSeen.mockClear();
    // The real selectSession routes a tiled id to the tile branch.
    delete app.selectSession;
    const onKeydown = handlerFor(app);
    const e = chord(RIGHT);
    onKeydown(e);
    expect(e.preventDefault).toHaveBeenCalled();
    expect(app.activeSessionId).toBe('s-b');
    expect(app.markIdleAlertSeen).toHaveBeenCalledWith('s-b');
  });

  it('outside the grid Alt+Shift+Right is left alone for the terminal', () => {
    const app = makeGridApp(IDS);
    const onKeydown = handlerFor(app);
    const e = chord(RIGHT);
    onKeydown(e);
    expect(e.preventDefault).not.toHaveBeenCalled();
    expect(app._tilesOwnTerminal()).toBe(false);
  });
});

describe('the actions', () => {
  it('the toggle brings back the grid this tab last left, focus included, filled to the count', () => {
    const app = makeGridApp(IDS);
    app.selectSession = vi.fn();
    app.openTileGrid(IDS, { focusedId: 's-c' });
    app.closeTileGrid({ reselect: false });
    app.toggleTileGrid();
    // Its three first, then the open sessions in tab order (the default count, 6).
    expect(app._tileGrid.ids).toEqual([...IDS, 's-other']);
    expect(app.activeSessionId).toBe('s-c');
  });

  it('a remembered tile whose session is gone is not brought back', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(IDS);
    app.closeTileGrid({ reselect: false });
    app.sessions.delete('s-b');
    app.toggleTileGrid();
    expect(app._tileGrid.ids).not.toContain('s-b');
    // Its cell stays where it was, and the count fills it first (s-other, tab order).
    expect(app._tileGrid.cells).toEqual(['s-a', 's-other', 's-c']);
  });

  it('with every remembered session gone, it opens on the open sessions in tab order instead', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(['s-b', 's-c']);
    app.closeTileGrid({ reselect: false });
    app.sessions.delete('s-b');
    app.sessions.delete('s-c');
    app.activeSessionId = 's-a';
    app.toggleTileGrid();
    expect(app._tileGrid.ids).toEqual(['s-other', 's-a']);
    expect(app.activeSessionId).toBe('s-a');
  });

  it('Remove Focused Tile removes it (the session keeps running) and a neighbour takes focus', () => {
    const app = makeGridApp(IDS);
    app.openTileGrid(IDS, { focusedId: 's-b' });
    app._apiDelete = vi.fn();
    app.removeFocusedTile();
    expect(app._tileGrid.ids).toEqual(['s-a', 's-c']);
    expect(app.activeSessionId).toBe('s-c');
    expect(app.sessions.has('s-b')).toBe(true);
    expect(app._apiDelete).not.toHaveBeenCalled();
  });
});

describe('xterm key handlers swallow a chord that applies', () => {
  it("the main terminal's handler checks the chord before the Shift+Enter gate, for every event type", () => {
    // That handler lives in initTerminal's closure over a real xterm, so the
    // rule is pinned at the source, as terminal-copy-clean.test.ts does.
    const src = read('terminal-ui.js');
    const handler = src.slice(src.indexOf('this.terminal.attachCustomKeyEventHandler((ev) => {'));
    const gate = handler.indexOf('if (this.tileShortcutFor?.(ev)) return false;');
    const enter = handler.indexOf("if (ev.key === 'Enter' && (ev.shiftKey || ev.ctrlKey)) {");
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(enter);
  });

  describe("TerminalTile's handler (real tile, real tileShortcutFor)", () => {
    class FakeTerminal {
      static last: FakeTerminal;
      keyHandler: ((ev: Record<string, unknown>) => boolean) | null = null;
      options: Record<string, unknown>;
      cols = 80;
      rows = 24;
      buffer = { active: { type: 'normal', viewportY: 0, length: 24 } };
      textarea = { addEventListener() {}, removeEventListener() {} };
      constructor(options: Record<string, unknown>) {
        this.options = options;
        FakeTerminal.last = this;
      }
      loadAddon() {}
      open() {}
      onData() {}
      attachCustomKeyEventHandler(fn: (ev: Record<string, unknown>) => boolean) {
        this.keyHandler = fn;
      }
      registerLinkProvider() {}
      write() {}
      clear() {}
      dispose() {}
    }
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ data: { terminalBuffer: '' } }) }));
    const windowStub: Record<string, unknown> = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      CodemanBase: { base: '' },
      innerWidth: 2400,
    };
    const context = vm.createContext({
      console: { ...console, log: vi.fn(), debug: vi.fn() },
      performance,
      setInterval: vi.fn(),
      clearInterval: vi.fn(),
      setTimeout,
      clearTimeout,
      requestAnimationFrame: vi.fn(),
      HTMLCanvasElement: class HTMLCanvasElement {},
      WebSocket: class {
        static OPEN = 1;
        send() {}
        close() {}
      },
      Terminal: FakeTerminal,
      FitAddon: {
        FitAddon: class {
          fit() {}
          proposeDimensions() {
            return { cols: 80, rows: 24 };
          }
        },
      },
      fetch: fetchMock,
      location: { protocol: 'http:', host: 'codeman.test' },
      document: { addEventListener: vi.fn(), documentElement: { dataset: {} } },
      localStorage: { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() },
      window: windowStub,
      MobileDetection: { isTouchDevice: () => false, isHandheldDevice: () => false, getDeviceType: () => 'desktop' },
    });
    vm.runInContext(
      `${read('constants.js')}\n${read('app.js')}\n${read('terminal-ui.js')}\n${read('terminal-tile.js')}\n` +
        `${read('terminal-split.js')}\n${read('tile-grid.js')}\nglobalThis.__CodemanApp = CodemanApp;`,
      context
    );
    const App = (context as unknown as { __CodemanApp: { prototype: object } }).__CodemanApp;
    const TerminalTile = windowStub.TerminalTile as new (
      id: string,
      mount: unknown,
      opts: object
    ) => { connect(): Promise<void>; destroy(): void };

    async function tileHandler(gridOpen: boolean) {
      const app = Object.create(App.prototype) as GridApp;
      app.loadAppSettingsFromStorage = () => ({});
      app.isSoloWindow = false;
      app._tileGrid = { open: gridOpen };
      windowStub.app = app;
      const tile = new TerminalTile('s1', { addEventListener() {}, removeEventListener() {} }, { mode: 'claude' });
      await tile.connect();
      const handler = FakeTerminal.last.keyHandler!;
      tile.destroy();
      return handler;
    }

    it.each(['keydown', 'keypress', 'keyup'])(
      'returns false for Alt+Shift+Right (%s) while the grid is open',
      async (type) => {
        const handler = await tileHandler(true);
        expect(handler({ ...chord(RIGHT), type })).toBe(false);
      }
    );

    it('lets Alt+Shift+Right through to the PTY when no grid is open', async () => {
      const handler = await tileHandler(false);
      expect(handler(chord(RIGHT))).toBe(true);
    });

    const MOVE_RIGHT = { key: 'ArrowRight', code: 'ArrowRight', ctrlKey: true, shiftKey: true };
    it.each(['keydown', 'keypress', 'keyup'])(
      'returns false for Ctrl+Shift+Right, Move Tile Right (%s), while the grid is open',
      async (type) => {
        const handler = await tileHandler(true);
        expect(handler({ ...chord(MOVE_RIGHT), type })).toBe(false);
      }
    );

    it('lets Ctrl+Shift+Right through to the PTY when no grid is open', async () => {
      const handler = await tileHandler(false);
      expect(handler(chord(MOVE_RIGHT))).toBe(true);
    });

    it('Alt+Shift+Enter (zoom) never becomes a Shift+Enter newline in the tile session', async () => {
      const handler = await tileHandler(true);
      fetchMock.mockClear();
      expect(handler(chord({ key: 'Enter', code: 'Enter', altKey: true, shiftKey: true }))).toBe(false);
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/send-key'))).toBe(false);
    });

    it('returns false for the toggle chord', async () => {
      const handler = await tileHandler(true);
      expect(handler(chord(TOGGLE))).toBe(false);
    });
  });
});
