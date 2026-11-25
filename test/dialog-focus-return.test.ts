/**
 * @fileoverview A dialog hands the keyboard back to the field the user was
 * typing in when the mouse press that opened it began.
 *
 * Measured in Chromium against a real shell session before the change: App
 * Settings opened from the header gear and closed left `activeElement` on the
 * gear button, Session Options opened from a tab's gear left it on that gear,
 * and nothing typed afterwards reached the terminal. With the press clearing
 * focus (what WebKit on macOS does for a button) it was left on `<body>`.
 *
 * `FocusTrap` is loaded with `vm` against a fake document, like the other
 * accessory-bar tests. A press is the two steps a browser takes: `pointerdown`
 * reaches the page first, then the engine moves focus. The real event order is
 * covered in `test/dialog-focus-return.browser.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type Listener = (e: unknown) => void;
type Node = Record<string, any>;

const read = (name: string) => readFileSync(resolve(import.meta.dirname, '../src/web/public', name), 'utf8');

function node(tagName: string, extra: Node = {}): Node {
  return { tagName, isConnected: true, focus: vi.fn(), contains: () => false, ...extra };
}

function loadPage({ panels = false } = {}) {
  const listeners: Record<string, Listener[]> = {};
  const body = node('BODY');
  let active: Node | null = body;
  const document = {
    body,
    get activeElement() {
      return active;
    },
    addEventListener: (type: string, fn: Listener, capture?: boolean) => {
      (listeners[`${type}:${capture === true}`] ||= []).push(fn);
    },
    createElement: () => node('DIV'),
    querySelector: () => null,
    getElementById: () => null,
  };
  const CodemanApp = function CodemanApp(this: unknown) {};
  const context = vm.createContext({
    console,
    document,
    CodemanApp,
    MobileDetection: { isTouchDevice: () => false },
    localStorage: { getItem: () => null, setItem: () => {} },
    requestAnimationFrame: (fn: () => void) => fn(),
  });
  vm.runInContext(`${read('keyboard-accessory.js')}\nglobalThis.__FocusTrap = FocusTrap;`, context, {
    filename: 'keyboard-accessory.js',
  });
  if (panels) vm.runInContext(read('panels-ui.js'), context, { filename: 'panels-ui.js' });
  const FocusTrap = (context as unknown as { __FocusTrap: any }).__FocusTrap;
  const fire = (type: string, event: unknown) => (listeners[`${type}:true`] ?? []).forEach((fn) => fn(event));
  return {
    FocusTrap,
    listeners,
    body,
    app: panels ? new (CodemanApp as any)() : null,
    setActive: (el: Node | null) => (active = el),
    /** A press: the page hears `pointerdown`, then the engine moves focus to `focusAfter`. */
    press(target: Node, focusAfter?: Node | null, pointerType = 'mouse') {
      fire('pointerdown', { pointerType, target });
      if (focusAfter !== undefined) active = focusAfter;
    },
    key: (key: string) => fire('keydown', { key }),
  };
}

describe('FocusTrap.focusToReturn', () => {
  it('answers the typing field when the pressed control took focus (Chromium, Firefox)', () => {
    const page = loadPage();
    const terminal = node('TEXTAREA');
    const gear = node('BUTTON');
    page.setActive(terminal);
    page.press(gear, gear);
    expect(page.FocusTrap.focusToReturn()).toBe(terminal);
  });

  it('answers the typing field when the press cleared focus (a button in WebKit on macOS)', () => {
    const page = loadPage();
    const terminal = node('TEXTAREA');
    page.setActive(terminal);
    page.press(node('BUTTON'), page.body);
    expect(page.FocusTrap.focusToReturn()).toBe(terminal);
  });

  it('answers the typing field when the press landed inside the control that took focus', () => {
    const page = loadPage();
    const terminal = node('TEXTAREA');
    const icon = node('path');
    const gear = node('BUTTON', { contains: (el: Node) => el === icon });
    page.setActive(terminal);
    page.press(icon, gear);
    expect(page.FocusTrap.focusToReturn()).toBe(terminal);
  });

  it('keeps the control for a keyboard user: any key forgets the press', () => {
    const page = loadPage();
    const terminal = node('TEXTAREA');
    const gear = node('BUTTON');
    page.setActive(terminal);
    page.press(gear, gear);
    // Later the same control is reached with Tab and opened with Enter.
    page.key('Tab');
    expect(page.FocusTrap.focusToReturn()).toBe(gear);
  });

  it('does not let a modifier held for the click forget the press', () => {
    const page = loadPage();
    const terminal = node('TEXTAREA');
    const gear = node('BUTTON');
    page.setActive(terminal);
    page.press(gear, gear);
    for (const key of ['Shift', 'Control', 'Alt', 'Meta']) page.key(key);
    expect(page.FocusTrap.focusToReturn()).toBe(terminal);
  });

  it('returns to the pressed control when the press came from a button (a dialog opened inside a dialog)', () => {
    const page = loadPage();
    const closeButton = node('BUTTON');
    const row = node('BUTTON');
    page.setActive(closeButton);
    page.press(row, row);
    expect(page.FocusTrap.focusToReturn()).toBe(row);
  });

  it('never carries the field of an earlier press over', () => {
    const page = loadPage();
    const terminal = node('TEXTAREA');
    const gear = node('BUTTON');
    const row = node('BUTTON');
    page.setActive(terminal);
    page.press(gear, gear);
    // A dialog is open now and the terminal is behind it; the next press starts from a button.
    page.press(row, row);
    expect(page.FocusTrap.focusToReturn()).toBe(row);
  });

  it('keeps the field through a menu: the press on a menu item belongs to the press that opened the menu', () => {
    const page = loadPage();
    const terminal = node('TEXTAREA');
    const menuButton = node('BUTTON');
    const firstItem = node('BUTTON');
    const item = node('BUTTON', { closest: (selector: string) => (selector === '[role="menu"]' ? {} : null) });
    page.setActive(terminal);
    // The menu focuses its first item when it opens.
    page.press(menuButton, firstItem);
    // The item's click removes the menu, which drops focus on <body>, and opens the dialog.
    page.press(item, page.body);
    expect(page.FocusTrap.focusToReturn()).toBe(terminal);
  });

  it('keeps nothing through a menu that was opened from a button', () => {
    const page = loadPage();
    const closeButton = node('BUTTON');
    const menuButton = node('BUTTON');
    const item = node('BUTTON', { closest: (selector: string) => (selector === '[role="menu"]' ? {} : null) });
    page.setActive(closeButton);
    page.press(menuButton, menuButton);
    page.press(item, page.body);
    expect(page.FocusTrap.focusToReturn()).toBe(page.body);
  });

  it('spends the press when a dialog asks, so nothing pressed inside the dialog reaches the field behind it', () => {
    const page = loadPage();
    const terminal = node('TEXTAREA');
    const gear = node('BUTTON');
    page.setActive(terminal);
    page.press(gear, gear);
    expect(page.FocusTrap.focusToReturn()).toBe(terminal);
    expect(page.FocusTrap.focusToReturn()).toBe(gear);

    // The dialog is open. A menu item in it is pressed directly, with a dialog control focused.
    const dialogControl = node('BUTTON');
    const item = node('BUTTON', { closest: (selector: string) => (selector === '[role="menu"]' ? {} : null) });
    page.setActive(dialogControl);
    page.press(item, page.body);
    expect(page.FocusTrap.focusToReturn()).toBe(page.body);
  });

  it('leaves a finger alone, and a finger forgets an earlier mouse press', () => {
    const page = loadPage();
    const terminal = node('TEXTAREA');
    const gear = node('BUTTON');
    page.setActive(terminal);
    page.press(gear, gear, 'touch');
    expect(page.FocusTrap.focusToReturn()).toBe(gear);

    page.setActive(terminal);
    page.press(gear, gear, 'mouse');
    page.press(gear, gear, 'touch');
    expect(page.FocusTrap.focusToReturn()).toBe(gear);

    page.setActive(terminal);
    page.press(gear, gear, 'pen');
    expect(page.FocusTrap.focusToReturn()).toBe(gear);
  });

  it('answers what has focus when the field is gone from the page', () => {
    const page = loadPage();
    const terminal = node('TEXTAREA');
    const gear = node('BUTTON');
    page.setActive(terminal);
    page.press(gear, gear);
    terminal.isConnected = false;
    expect(page.FocusTrap.focusToReturn()).toBe(gear);
  });

  it('answers what has focus when the click itself moved it somewhere else', () => {
    const page = loadPage();
    const terminal = node('TEXTAREA');
    const elsewhere = node('BUTTON');
    page.setActive(terminal);
    page.press(node('BUTTON'), elsewhere);
    expect(page.FocusTrap.focusToReturn()).toBe(elsewhere);
  });

  it('answers what has focus when there was no press at all', () => {
    const page = loadPage();
    const terminal = node('TEXTAREA');
    page.setActive(terminal);
    expect(page.FocusTrap.focusToReturn()).toBe(terminal);
    page.setActive(page.body);
    expect(page.FocusTrap.focusToReturn()).toBe(page.body);
  });

  it('answers the field itself when the press left focus in it', () => {
    const page = loadPage();
    const terminal = node('TEXTAREA');
    page.setActive(terminal);
    // An accessory key cancels the mousedown default, so the terminal keeps focus.
    page.press(node('BUTTON'));
    expect(page.FocusTrap.focusToReturn()).toBe(terminal);
  });
});

describe('FocusTrap.isTypingField', () => {
  it('counts textareas, text-like inputs and editable regions, and nothing else', () => {
    const { FocusTrap, body } = loadPage();
    expect(FocusTrap.isTypingField(node('TEXTAREA'))).toBe(true);
    expect(FocusTrap.isTypingField(node('textarea'))).toBe(true);
    expect(FocusTrap.isTypingField(node('INPUT'))).toBe(true);
    for (const type of ['text', 'search', 'number', 'password', 'email', 'url']) {
      expect(FocusTrap.isTypingField(node('INPUT', { type }))).toBe(true);
    }
    for (const type of [
      'button',
      'checkbox',
      'color',
      'file',
      'hidden',
      'image',
      'radio',
      'range',
      'reset',
      'submit',
    ]) {
      expect(FocusTrap.isTypingField(node('INPUT', { type }))).toBe(false);
    }
    expect(FocusTrap.isTypingField(node('DIV', { isContentEditable: true }))).toBe(true);
    expect(FocusTrap.isTypingField(node('DIV'))).toBe(false);
    expect(FocusTrap.isTypingField(node('BUTTON'))).toBe(false);
    expect(FocusTrap.isTypingField(node('SELECT'))).toBe(false);
    expect(FocusTrap.isTypingField(body)).toBe(false);
    expect(FocusTrap.isTypingField(null)).toBe(false);
  });
});

describe('the document listeners', () => {
  it('are two capture listeners, installed once however often the page asks', () => {
    const page = loadPage();
    page.FocusTrap.watchPresses();
    page.FocusTrap.watchPresses();
    expect(Object.keys(page.listeners).sort()).toEqual(['keydown:true', 'pointerdown:true']);
    expect(page.listeners['pointerdown:true']).toHaveLength(1);
    expect(page.listeners['keydown:true']).toHaveLength(1);
  });

  it('are skipped on a page with no document to listen on', () => {
    const context = vm.createContext({ console, document: { createElement: () => node('DIV') } });
    vm.runInContext(`${read('keyboard-accessory.js')}\nglobalThis.__FocusTrap = FocusTrap;`, context);
    expect((context as unknown as { __FocusTrap: any }).__FocusTrap._watching).toBe(false);
  });
});

describe('a dialog built on FocusTrap', () => {
  function dialog() {
    return { addEventListener: vi.fn(), removeEventListener: vi.fn(), querySelectorAll: () => [] };
  }

  it('hands the keyboard back to the terminal after it was opened by a mouse press', () => {
    const page = loadPage();
    const terminal = node('TEXTAREA');
    const gear = node('BUTTON');
    page.setActive(terminal);
    page.press(gear, gear);

    const trap = new page.FocusTrap(dialog());
    trap.activate();
    expect(trap.previouslyFocused).toBe(terminal);
    trap.deactivate();
    expect(terminal.focus).toHaveBeenCalledTimes(1);
    expect(gear.focus).not.toHaveBeenCalled();
  });

  it('still hands it back to the control it was opened from with the keyboard', () => {
    const page = loadPage();
    const gear = node('BUTTON');
    page.setActive(gear);
    page.key('Enter');

    const trap = new page.FocusTrap(dialog());
    trap.activate();
    trap.deactivate();
    expect(gear.focus).toHaveBeenCalledTimes(1);
  });

  it('is not misled by the press that closes it', () => {
    const page = loadPage();
    const terminal = node('TEXTAREA');
    const gear = node('BUTTON');
    const close = node('BUTTON');
    page.setActive(terminal);
    page.press(gear, gear);
    const trap = new page.FocusTrap(dialog());
    trap.activate();
    page.setActive(close);
    page.press(close, close);
    trap.deactivate();
    expect(terminal.focus).toHaveBeenCalledTimes(1);
  });
});

describe('the command palette and the Session Manager', () => {
  it('save the same answer, so an overlay opened by a mouse press returns to the terminal', () => {
    const page = loadPage({ panels: true });
    const terminal = node('TEXTAREA');
    const headerButton = node('BUTTON');
    page.setActive(terminal);
    page.press(headerButton, headerButton);
    page.app._rememberOverlayFocus('_sessionManagerPrevFocus');
    expect(page.app._sessionManagerPrevFocus).toBe(terminal);
  });

  it('save what has focus when the overlay was opened with its shortcut', () => {
    const page = loadPage({ panels: true });
    const terminal = node('TEXTAREA');
    page.setActive(terminal);
    page.key('k');
    page.app._rememberOverlayFocus('_commandPalettePrevFocus');
    expect(page.app._commandPalettePrevFocus).toBe(terminal);
  });
});
