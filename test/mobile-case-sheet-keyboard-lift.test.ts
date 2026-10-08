// Port: none (pure logic in a vm context — no browser, no server).
//
// The phone "Select Case" bottom sheet (#mobileCasePickerModal) has a search
// field (#488), so the on-screen keyboard can open over it. The sheet is a third
// `position: fixed` bottom-anchored surface beside the toolbar and the keyboard
// accessory bar, and iOS does not shrink the layout viewport for the keyboard, so
// an unlifted sheet sits BEHIND the keyboard with its own search box out of
// sight. KeyboardHandler therefore lifts an OPEN sheet the same way it lifts the
// toolbar (translateY on phones, `bottom` on iPads), and resetLayout() clears the
// offset on ANY sheet, open or not, so a sheet closed with the keyboard still up
// does not slide in already displaced next time (#428).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(resolve(import.meta.dirname, '../src/web/public/mobile-handlers.js'), 'utf8');

interface Styled {
  style: Record<string, string>;
}

function loadHandler(opts: { width: number; layoutHeight: number; visualHeight: number; sheetOpen: boolean }) {
  const el = (): Styled => ({ style: { transform: '', bottom: '', paddingBottom: '' } });
  const sheet = el();
  const toolbar = el();
  const accessoryBar = el();
  const main = el();
  const context = vm.createContext({
    console,
    navigator: { userAgent: 'Mozilla/5.0 (iPhone) Mobile', maxTouchPoints: 5 },
    window: {
      innerWidth: opts.width,
      innerHeight: opts.layoutHeight,
      visualViewport: { height: opts.visualHeight, offsetTop: 0 },
      addEventListener: () => {},
      matchMedia: () => ({ matches: true }),
      scrollTo: () => {},
    },
    document: {
      body: { classList: { add: () => {}, remove: () => {}, contains: () => false } },
      addEventListener: () => {},
      getElementById: () => null,
      querySelector: (sel: string) => {
        if (sel === '.mobile-case-picker.active .mobile-case-picker-sheet') return opts.sheetOpen ? sheet : null;
        if (sel === '.mobile-case-picker-sheet') return sheet;
        if (sel === '.toolbar') return toolbar;
        if (sel === '.keyboard-accessory-bar') return accessoryBar;
        if (sel === '.main') return main;
        return null;
      },
    },
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  vm.runInContext(`${SOURCE}\nglobalThis.__KH = KeyboardHandler;`, context, { filename: 'mobile-handlers.js' });
  const handler = (context as { __KH: any }).__KH;
  handler.keyboardVisible = true;
  handler.initialViewportHeight = opts.layoutHeight;
  return { handler, sheet, toolbar };
}

describe('mobile case sheet keyboard lift', () => {
  it('lifts an open sheet above the keyboard on a phone, by the same offset as the toolbar', () => {
    const { handler, sheet, toolbar } = loadHandler({
      width: 390,
      layoutHeight: 844,
      visualHeight: 500,
      sheetOpen: true,
    });
    handler.updateLayoutForKeyboard();
    expect(sheet.style.transform).toBe('translateY(-344px)');
    expect(sheet.style.transform).toBe(toolbar.style.transform);
  });

  it('positions an open sheet by `bottom` on an iPad-sized screen', () => {
    const { handler, sheet } = loadHandler({ width: 1024, layoutHeight: 1366, visualHeight: 966, sheetOpen: true });
    handler.updateLayoutForKeyboard();
    expect(sheet.style.bottom).toBe('400px');
    expect(sheet.style.transform).toBe('');
  });

  it('leaves a closed sheet alone while the keyboard is up', () => {
    const { handler, sheet } = loadHandler({ width: 390, layoutHeight: 844, visualHeight: 500, sheetOpen: false });
    handler.updateLayoutForKeyboard();
    expect(sheet.style.transform).toBe('');
  });

  it('resetLayout clears the offset even on a sheet that is no longer open', () => {
    const { handler, sheet } = loadHandler({ width: 390, layoutHeight: 844, visualHeight: 500, sheetOpen: false });
    sheet.style.transform = 'translateY(-344px)';
    sheet.style.bottom = '400px';
    handler.resetLayout();
    expect(sheet.style.transform).toBe('');
    expect(sheet.style.bottom).toBe('');
  });
});
