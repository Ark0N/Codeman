/**
 * @fileoverview A terminal is measured only once its own font can be measured.
 *
 * The first fit runs while the browser is still painting with a fallback font,
 * whose character cell is a different size from the terminal font's. The grid
 * that fit produces is therefore wrong, the pane is sized to it, and the
 * correction arrives after the session's buffer has been replayed — so the CLI
 * repaints for a shape that does not match what is on screen.
 *
 * Two properties carry the fix and both are pinned here:
 *
 *  - The wait REQUESTS each measurable face and then forces xterm to re-measure.
 *    Waiting alone buys nothing: `FitAddon.proposeDimensions()` divides by a
 *    cached cell size that xterm refreshes only from `open()`, from a resize
 *    that changed the grid, and on a device-pixel-ratio change. Nothing in it
 *    listens for font loading, so a fit after the font arrives can still divide
 *    by the fallback cell and short-circuit.
 *  - The wait is BOUNDED. `FontFaceSet.ready` has no deadline, and `selectSession`
 *    awaits this before painting, so an unbounded wait would strand the session
 *    instead of merely mis-measuring it.
 *
 * Loaded via `vm` with a stubbed context (no jsdom — jsdom is broken on this
 * box; see connection-indicator.test.ts), the same way terminal-buffer-flush
 * extracts the real mixin methods from terminal-ui.js.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The mixin runs inside the vm context, so its `document` must live there. */
let currentDocument: unknown;

function loadTerminalMixin(): Record<string, unknown> {
  const dir = resolve(import.meta.dirname, '../src/web/public');
  const FakeCodemanApp = function () {} as unknown as { prototype: Record<string, unknown> };
  const context = vm.createContext({
    console,
    performance,
    setTimeout,
    clearTimeout,
    setInterval: vi.fn(),
    clearInterval: vi.fn(),
    requestAnimationFrame: vi.fn(),
    CodemanApp: FakeCodemanApp,
    window: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
    get document() {
      return currentDocument;
    },
  });
  // constants.js supplies TERMINAL_FONT_WAIT_MS and TERMINAL_FONT_UNMEASURED.
  const constants = readFileSync(resolve(dir, 'constants.js'), 'utf8');
  const source = readFileSync(resolve(dir, 'terminal-ui.js'), 'utf8');
  vm.runInContext(`${constants}\n${source}`, context);
  return FakeCodemanApp.prototype;
}

const mixin = loadTerminalMixin();

type FontApp = {
  _awaitTerminalFont: () => Promise<void>;
  terminal: unknown;
};

function makeApp(fontFamily: string, opts: { measure?: () => void } = {}) {
  const measure = vi.fn(opts.measure);
  const app = {
    _awaitTerminalFont: mixin._awaitTerminalFont,
    terminal: {
      options: { fontFamily, fontSize: 14 },
      _core: { _charSizeService: { measure } },
    },
  } as unknown as FontApp & { terminal: { _core: { _charSizeService: { measure: typeof measure } } } };
  return { app, measure };
}

/** A FontFaceSet stub recording what was asked for. */
function fontsStub(overrides: { load?: unknown; ready?: Promise<unknown> } = {}) {
  const requested: string[] = [];
  return {
    requested,
    fonts: {
      load: overrides.load ?? ((spec: string) => (requested.push(spec), Promise.resolve([]))),
      ready: overrides.ready ?? Promise.resolve(),
      status: 'loaded',
    },
  };
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  currentDocument = undefined;
  vi.useRealTimers();
});

describe('terminal font settle', () => {
  it('requests every measurable family in the stack, unquoted', async () => {
    const stub = fontsStub();
    currentDocument = stub;
    const { app } = makeApp('"Fira Code", "JetBrains Mono", monospace');

    await app._awaitTerminalFont();

    expect(stub.requested).toEqual(['14px "Fira Code"', '14px "JetBrains Mono"']);
  });

  it('does not wait on faces that cannot move the measured cell', async () => {
    // The symbols face is ~1.2MB of private-use-area glyphs and xterm measures
    // `W`, so awaiting it puts a megabyte in front of the first frame for
    // nothing. The generics match no FontFace at all.
    const stub = fontsStub();
    currentDocument = stub;
    const { app } = makeApp('"JetBrains Mono", "Symbols Nerd Font Mono", monospace, serif, system-ui');

    await app._awaitTerminalFont();

    expect(stub.requested).toEqual(['14px "JetBrains Mono"']);
  });

  it('forces xterm to re-measure, because loading a font does not', async () => {
    // The property the whole change rests on. Without this the fit that follows
    // still divides the container by the fallback cell.
    currentDocument = fontsStub();
    const { app, measure } = makeApp('"JetBrains Mono"');

    await app._awaitTerminalFont();

    expect(measure).toHaveBeenCalledTimes(1);
  });

  it('gives up on a font that never arrives, and still re-measures', async () => {
    // FontFaceSet.ready has no deadline of its own, and selectSession awaits
    // this before painting: unbounded here means a session that never renders.
    currentDocument = fontsStub({ ready: new Promise(() => {}) });
    const { app, measure } = makeApp('"JetBrains Mono"');

    const started = Date.now();
    await app._awaitTerminalFont();

    expect(measure).toHaveBeenCalledTimes(1);
    // Bounded by TERMINAL_FONT_WAIT_MS (2s), not left pending.
    expect(Date.now() - started).toBeLessThan(4000);
  }, 10_000);

  it('survives a rejecting load and a browser with no font API', async () => {
    currentDocument = fontsStub({ load: () => Promise.reject(new Error('network')) });
    const { app: rejecting, measure: m1 } = makeApp('"JetBrains Mono"');
    await expect(rejecting._awaitTerminalFont()).resolves.toBeUndefined();
    expect(m1).toHaveBeenCalledTimes(1);

    currentDocument = {};
    const { app: noApi, measure: m2 } = makeApp('"JetBrains Mono"');
    await expect(noApi._awaitTerminalFont()).resolves.toBeUndefined();
    // No font API means nothing to wait for and nothing to re-measure against.
    expect(m2).not.toHaveBeenCalled();
  });

  it('does not throw when the terminal was disposed mid-wait', async () => {
    currentDocument = fontsStub();
    const app = { _awaitTerminalFont: mixin._awaitTerminalFont, terminal: null } as unknown as FontApp;

    await expect(app._awaitTerminalFont()).resolves.toBeUndefined();
  });
});

describe('selectSession font gate', () => {
  const appSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/app.js'), 'utf8');
  const selectStart = appSource.indexOf('async selectSession(sessionId, options = {})');
  const body = appSource.slice(
    selectStart,
    appSource.indexOf('\n  // Shared cleanup for all session data', selectStart)
  );

  it('waits for the font before the first fit', () => {
    const wait = body.indexOf('await this._terminalFontReady');
    const fit = body.indexOf('if (this.fitAddon) this.fitAddon.fit();');
    expect(wait).toBeGreaterThan(-1);
    expect(fit).toBeGreaterThan(-1);
    expect(wait).toBeLessThan(fit);
  });

  it('waits BEFORE opening the buffer-load gate', () => {
    // Inside the gate every live SSE event queues instead of painting, so a slow
    // font would hold output back rather than only mis-measuring the grid.
    const wait = body.indexOf('await this._terminalFontReady');
    const gate = body.indexOf('this._beginBufferLoad(selectGen)');
    expect(gate).toBeGreaterThan(-1);
    expect(wait).toBeLessThan(gate);
  });

  it('keeps the synchronous focus ahead of the wait (iOS Safari)', () => {
    // iOS honours programmatic focus only inside the user-gesture call stack,
    // which the first await ends.
    const focus = body.indexOf('if (shouldFocusTerminal && this.terminal) this.terminal.focus();');
    const wait = body.indexOf('await this._terminalFontReady');
    expect(focus).toBeGreaterThan(-1);
    expect(focus).toBeLessThan(wait);
  });

  it('re-checks for a newer selection after the wait', () => {
    const wait = body.indexOf('await this._terminalFontReady');
    const guard = body.indexOf('this._isStaleSelect(selectGen)', wait);
    expect(guard).toBeGreaterThan(-1);
    expect(guard - wait).toBeLessThan(200);
  });
});
