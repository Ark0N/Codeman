// Port: none (pure logic in a vm context — no browser, no server).
//
// KeyboardHandler scrolls a newly focused text field into view (scrollInputIntoView,
// `scrollIntoView({ block: 'center' })`) once the keyboard is up. The pinned CJK /
// Send on Enter field (#cjkInput) is position:fixed and already lifted above the
// keyboard by updateLayoutForKeyboard(), so scrolling it into view only centred it in
// its scrollable ancestors and pushed the terminal off screen. It must be skipped,
// like xterm's own inputs, while ordinary inputs keep the behaviour.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(resolve(import.meta.dirname, '../src/web/public/mobile-handlers.js'), 'utf8');

function loadHandler() {
  const context = vm.createContext({
    console,
    navigator: { userAgent: 'test', maxTouchPoints: 1 },
    window: { addEventListener: () => {}, matchMedia: () => ({ matches: false }), scrollTo: () => {} },
    document: {
      body: { classList: { add: () => {}, remove: () => {} } },
      addEventListener: () => {},
      getElementById: () => null,
      querySelector: () => null,
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  vm.runInContext(`${SOURCE}\nglobalThis.__KH = KeyboardHandler;`, context, { filename: 'mobile-handlers.js' });
  return (context as { __KH: any }).__KH;
}

function element(tagName: string, { id = '', inside = '' }: { id?: string; inside?: string } = {}) {
  return { tagName, id, type: '', isContentEditable: false, closest: (sel: string) => (sel === inside ? {} : null) };
}

describe('KeyboardHandler.isInputElement', () => {
  it('skips the pinned CJK field, which the keyboard layout positions itself', () => {
    expect(loadHandler().isInputElement(element('TEXTAREA', { id: 'cjkInput' }))).toBe(false);
  });

  it('still skips xterm inputs and still scrolls ordinary fields into view', () => {
    const kh = loadHandler();
    expect(kh.isInputElement(element('TEXTAREA', { inside: '.xterm' }))).toBe(false);
    expect(kh.isInputElement(element('TEXTAREA', { id: 'someOtherField' }))).toBe(true);
    expect(kh.isInputElement(element('INPUT'))).toBe(true);
  });
});

function loadLayout({
  focused = 'cjkInput',
  offsetTop,
  height = 458,
  width = 390,
  innerHeight = 744,
  clientHeight = 744,
}: {
  focused?: string;
  offsetTop: number;
  height?: number;
  width?: number;
  innerHeight?: number;
  clientHeight?: number;
}) {
  const el = (offsetHeight = 36) => ({
    style: {} as Record<string, string>,
    offsetHeight,
    classList: { contains: () => true },
  });
  // .app is sized to the visual viewport (--app-height), which is what its fixed
  // children are placed against once it carries a transform.
  const nodes: Record<string, any> = {
    '.app': el(height),
    '.toolbar': el(),
    '.main': el(),
    '.keyboard-accessory-bar': el(),
    '.mobile-case-picker.active .mobile-case-picker-sheet': el(300),
  };
  const cjk = { ...el(), id: 'cjkInput' };
  const context = vm.createContext({
    console,
    navigator: { userAgent: 'test', maxTouchPoints: 1 },
    window: {
      addEventListener: () => {},
      matchMedia: () => ({ matches: false }),
      scrollTo: () => {},
      innerHeight,
      innerWidth: width, // MobileDetection (defined in the module) reads this
      visualViewport: { offsetTop, height },
    },
    document: {
      body: { classList: { add: () => {}, remove: () => {} } },
      documentElement: { clientHeight },
      addEventListener: () => {},
      activeElement: focused === 'cjkInput' ? cjk : { id: focused },
      getElementById: (id: string) => (id === 'cjkInput' ? cjk : null),
      querySelector: (sel: string) => nodes[sel] || null,
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  vm.runInContext(`${SOURCE}\nglobalThis.__KH = KeyboardHandler;`, context, { filename: 'mobile-handlers.js' });
  const kh = (context as { __KH: any }).__KH;
  kh.keyboardVisible = true;
  kh.initialViewportHeight = 744;
  return { kh, nodes, cjk };
}

describe('KeyboardHandler follows the visual-viewport pan on phones', () => {
  it('moves the app down by the pan and lifts nothing more (measured Android case)', () => {
    const { kh, nodes, cjk } = loadLayout({ offsetTop: 285 });
    kh.updateLayoutForKeyboard();
    expect(nodes['.app'].style.transform).toBe('translateY(285px)');
    // .app bottom = 285 + 458 = 743, visual bottom = 743: the bars already sit on it.
    expect(nodes['.toolbar'].style.transform).toBe('');
    expect(nodes['.keyboard-accessory-bar'].style.transform).toBe('');
    expect(cjk.style.transform).toBe('');
  });

  it('does not lift the bars twice on a partial pan', () => {
    // Mid-animation: offsetTop 100 in a 744 layout. Lifting by the layout gap (186px)
    // inside the shifted .app would float the bars 186px above the keyboard.
    const { kh, nodes, cjk } = loadLayout({ offsetTop: 100 });
    kh.updateLayoutForKeyboard();
    expect(nodes['.app'].style.transform).toBe('translateY(100px)');
    expect(nodes['.toolbar'].style.transform).toBe('');
    expect(nodes['.keyboard-accessory-bar'].style.transform).toBe('');
    expect(cjk.style.transform).toBe('');
    // The open case sheet is inside .app too (index.html #mobileCasePickerModal):
    // the layout gap on top of the shift floated it 186px above the keyboard.
    expect(nodes['.mobile-case-picker.active .mobile-case-picker-sheet'].style.transform).toBe('');
  });

  it('keeps the old lift when there is no pan', () => {
    const { kh, nodes } = loadLayout({ offsetTop: 0 });
    kh.updateLayoutForKeyboard();
    expect(nodes['.app'].style.transform).toBe('');
    expect(nodes['.toolbar'].style.transform).toBe('translateY(-286px)');
    // Without a pan insideLift is the layout gap, so the case sheet keeps its lift
    // (test/mobile-case-sheet-keyboard-lift.test.ts).
    expect(nodes['.mobile-case-picker.active .mobile-case-picker-sheet'].style.transform).toBe('translateY(-286px)');
  });

  it('follows a pan whatever has focus, so a focus change cannot drop the shift', () => {
    const { kh, nodes } = loadLayout({ focused: 'someOtherField', offsetTop: 285 });
    kh.updateLayoutForKeyboard();
    expect(nodes['.app'].style.transform).toBe('translateY(285px)');
  });

  it('never shifts the app outside the phone layout (tablet landscape)', () => {
    const { kh, nodes } = loadLayout({ offsetTop: 285, width: 1024 });
    nodes['.app'].style.transform = 'translateY(285px)'; // left over from portrait
    kh.updateLayoutForKeyboard();
    expect(nodes['.app'].style.transform).toBe('');
  });

  it('lifts the bars when iOS reports innerHeight as the shrunk visual height', () => {
    // Measured on an iPhone, first keyboard open: innerHeight 323 = visual height,
    // documentElement.clientHeight 640. Lifting by innerHeight - visual bottom gave 0.
    const { kh, nodes, cjk } = loadLayout({ offsetTop: 0, height: 323, innerHeight: 323, clientHeight: 640 });
    kh.updateLayoutForKeyboard();
    expect(nodes['.toolbar'].style.transform).toBe('translateY(-317px)');
    expect(nodes['.keyboard-accessory-bar'].style.transform).toBe('translateY(-317px)');
    expect(cjk.style.transform).toBe('translateY(-317px)');
  });

  it('clears the shift when the layout resets', () => {
    const { kh, nodes } = loadLayout({ offsetTop: 285 });
    kh.updateLayoutForKeyboard();
    kh.resetLayout();
    expect(nodes['.app'].style.transform).toBe('');
  });
});
