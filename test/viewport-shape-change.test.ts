// Port: none (pure logic in a vm context: no browser, no server).
//
// A virtual keyboard only ever takes HEIGHT off the visual viewport. Anything
// that changes its WIDTH is the device changing shape: a rotation, or a
// foldable opening or closing.
//
// KeyboardHandler.handleViewportResize() used to read any height drop over
// 150px as the keyboard appearing, so closing a foldable latched
// `keyboardVisible` with no keyboard on screen: the accessory bar appeared,
// `main` grew 84px of dead padding, and updateAppHeight() (which bails while
// the keyboard is up) stopped refreshing --app-height. The latch is sticky:
// clearing it needs the height back within 100px of a baseline belonging to a
// display the user is no longer looking at, so it survived until the device was
// opened again. Rotating any phone hit the same latch.
//
// Lives outside test/mobile/ deliberately, because that suite is
// Playwright-driven and excluded from `npm run test:ci`, so a regression
// guarded only there is invisible to CI (same reasoning as the note in
// mobile-keyboard-bottom-padding.test.ts).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(resolve(import.meta.dirname, '../src/web/public/mobile-handlers.js'), 'utf8');

interface Handler {
  init(): void;
  handleViewportResize(): void;
  keyboardVisible: boolean;
  initialViewportHeight: number;
  lastViewportWidth: number;
}

/** iPhone Duo, both postures, in CSS px (see test/mobile/devices.ts). */
const DUO_INNER = { width: 626, height: 890 };
const DUO_OUTER = { width: 466, height: 678 };
/** iOS keyboard over the inner display: height only. */
const KEYBOARD_HEIGHT = 300;

/**
 * Load mobile-handlers.js against a fake DOM and return its KeyboardHandler
 * plus the mutable viewport it reads.
 *
 * `const KeyboardHandler = {...}` is a lexical binding that does not survive to
 * a second `vm.runInContext`, so the export is appended to the SAME script.
 */
function loadHandler(start: { width: number; height: number }) {
  const viewport = { ...start, offsetTop: 0, addEventListener: () => {}, removeEventListener: () => {} };
  const bodyClasses = new Set<string>();
  const appHeight: string[] = [];

  const context = vm.createContext({
    console,
    app: { relayoutMobileSubagentWindows: () => {} },
    navigator: { userAgent: 'iPhone', maxTouchPoints: 5 },
    window: {
      get innerWidth() {
        return viewport.width;
      },
      get innerHeight() {
        return viewport.height;
      },
      visualViewport: viewport,
      addEventListener: () => {},
      removeEventListener: () => {},
      matchMedia: () => ({ matches: true }),
      scrollTo: () => {},
    },
    document: {
      body: {
        classList: {
          add: (c: string) => bodyClasses.add(c),
          remove: (c: string) => bodyClasses.delete(c),
        },
      },
      documentElement: {
        style: {
          setProperty: (name: string, value: string) => {
            if (name === '--app-height') appHeight.push(value);
          },
        },
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      getElementById: () => null,
      querySelector: () => null,
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
  });

  vm.runInContext(`${SOURCE}\nglobalThis.__KH = KeyboardHandler;`, context, { filename: 'mobile-handlers.js' });
  const handler = (context as unknown as { __KH: Handler }).__KH;
  handler.init();

  /** Move the viewport and fire the resize the browser would fire. */
  const resizeTo = (width: number, height: number) => {
    viewport.width = width;
    viewport.height = height;
    handler.handleViewportResize();
  };

  return { handler, resizeTo, bodyClasses, appHeight };
}

describe('handleViewportResize: height-only changes are the keyboard', () => {
  it('detects the keyboard opening', () => {
    const { handler, resizeTo, bodyClasses } = loadHandler(DUO_INNER);

    resizeTo(DUO_INNER.width, DUO_INNER.height - KEYBOARD_HEIGHT);

    expect(handler.keyboardVisible).toBe(true);
    expect(bodyClasses.has('keyboard-visible')).toBe(true);
    // The baseline must survive the keyboard, or closing it is undetectable.
    expect(handler.initialViewportHeight).toBe(DUO_INNER.height);
  });

  it('detects the keyboard closing', () => {
    const { handler, resizeTo, bodyClasses } = loadHandler(DUO_INNER);

    resizeTo(DUO_INNER.width, DUO_INNER.height - KEYBOARD_HEIGHT);
    resizeTo(DUO_INNER.width, DUO_INNER.height);

    expect(handler.keyboardVisible).toBe(false);
    expect(bodyClasses.has('keyboard-visible')).toBe(false);
  });

  it('reads a drop on the very first resize as the keyboard', () => {
    // init() has to seed lastViewportWidth, or this first event looks like a
    // width change (0 → 626) and swallows a real keyboard.
    const { handler, resizeTo } = loadHandler(DUO_INNER);

    expect(handler.lastViewportWidth).toBe(DUO_INNER.width);
    resizeTo(DUO_INNER.width, DUO_INNER.height - KEYBOARD_HEIGHT);

    expect(handler.keyboardVisible).toBe(true);
  });

  it('ignores address-bar drift, which is under the threshold', () => {
    const { handler, resizeTo } = loadHandler(DUO_INNER);

    resizeTo(DUO_INNER.width, DUO_INNER.height - 90);

    expect(handler.keyboardVisible).toBe(false);
  });
});

describe('handleViewportResize: width changes are the device changing shape', () => {
  it('does not read closing a foldable as the keyboard', () => {
    const { handler, resizeTo, bodyClasses } = loadHandler(DUO_INNER);

    // 890 → 678 is a 212px drop, well past the 150px keyboard threshold.
    resizeTo(DUO_OUTER.width, DUO_OUTER.height);

    expect(handler.keyboardVisible).toBe(false);
    expect(bodyClasses.has('keyboard-visible')).toBe(false);
  });

  it('re-baselines to the display it moved to', () => {
    const { handler, resizeTo } = loadHandler(DUO_INNER);

    resizeTo(DUO_OUTER.width, DUO_OUTER.height);

    expect(handler.initialViewportHeight).toBe(DUO_OUTER.height);
  });

  it('detects a keyboard opened after the fold', () => {
    // The re-baseline is what makes this work: measured against the old inner
    // baseline the outer display's keyboard is a 512px drop that was already
    // "open", and against no baseline at all it would never be seen.
    const { handler, resizeTo } = loadHandler(DUO_INNER);

    resizeTo(DUO_OUTER.width, DUO_OUTER.height);
    resizeTo(DUO_OUTER.width, DUO_OUTER.height - KEYBOARD_HEIGHT);

    expect(handler.keyboardVisible).toBe(true);
  });

  it('does not read opening a foldable as the keyboard closing', () => {
    const { handler, resizeTo } = loadHandler(DUO_OUTER);

    resizeTo(DUO_INNER.width, DUO_INNER.height);

    expect(handler.keyboardVisible).toBe(false);
    expect(handler.initialViewportHeight).toBe(DUO_INNER.height);
  });

  it('does not read a rotation as the keyboard', () => {
    // The same latch, on hardware that has shipped for years: 659 → 330 is a
    // 329px drop with no keyboard anywhere.
    const { handler, resizeTo, bodyClasses } = loadHandler({ width: 393, height: 659 });

    resizeTo(852, 330);

    expect(handler.keyboardVisible).toBe(false);
    expect(bodyClasses.has('keyboard-visible')).toBe(false);
    expect(handler.initialViewportHeight).toBe(330);
  });

  it('keeps --app-height following the new display when the keyboard was up', () => {
    // Rotating with the keyboard open cannot be told from folding with it open,
    // so keyboardVisible is left alone, but the baseline moves and the
    // keyboard-open sizing has to follow the display rather than freeze on the
    // one that is gone (updateAppHeight() bails while the keyboard is up).
    const { handler, resizeTo, appHeight } = loadHandler(DUO_INNER);

    resizeTo(DUO_INNER.width, DUO_INNER.height - KEYBOARD_HEIGHT);
    expect(handler.keyboardVisible).toBe(true);

    resizeTo(DUO_OUTER.width, DUO_OUTER.height - KEYBOARD_HEIGHT);

    expect(appHeight.at(-1)).toBe(`${DUO_OUTER.height - KEYBOARD_HEIGHT}px`);
    expect(handler.initialViewportHeight).toBe(DUO_OUTER.height - KEYBOARD_HEIGHT);
  });
});
