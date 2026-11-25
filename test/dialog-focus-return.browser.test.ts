/**
 * @fileoverview Real-Chromium coverage for where a dialog hands the keyboard
 * back to (`FocusTrap.focusToReturn`, keyboard-accessory.js).
 *
 * What the vm test in `test/dialog-focus-return.test.ts` cannot answer is the
 * order a browser does things in: the rule reads `document.activeElement` in a
 * `pointerdown` listener and relies on the engine moving focus only afterwards,
 * as the default action of `mousedown`. Here a real mouse presses real controls
 * and a real keyboard types, on a page that holds the shipping
 * keyboard-accessory.js, a textarea standing in for the terminal's own, and a
 * dialog built on `FocusTrap` the way App Settings and Session Options are.
 *
 * Four ways into the dialog: a button (Chromium gives it focus on a press), an
 * element that cannot take focus (the press clears focus to `<body>`, which is
 * what WebKit on macOS does for a button), a focusable element pressed on an
 * icon inside it (a tab's gear), and an item of a menu opened by a press before
 * it (a tile's menu button, then "Session options").
 *
 * Port: none (page.route on a fake origin, no server).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const ORIGIN = 'http://codeman.test/';

const PAGE = `<!doctype html><html><body>
<textarea id="term" style="display:block;width:300px;height:80px"></textarea>
<button id="other">Other</button>
<button id="open">Open</button>
<div id="plain" style="display:inline-block;padding:8px;background:#ccc">Open, takes no focus</div>
<span id="gear" tabindex="0" style="display:inline-block;padding:8px">
  <svg width="24" height="24"><rect id="gearIcon" width="24" height="24"></rect></svg>
</span>
<button id="menuButton">Menu</button>
<div id="modal" hidden style="position:fixed;left:40px;top:160px;padding:20px;background:#eee">
  <button id="close">Close</button><input id="name">
</div>
</body></html>`;

const WIRING = `
  const modal = document.getElementById('modal');
  const focused = () => (document.activeElement === document.body ? 'body' : document.activeElement.id);
  window.__focused = focused;
  window.__focusAtClick = [];
  let trap = null;
  const open = () => {
    window.__focusAtClick.push(focused());
    modal.hidden = false;
    trap = new FocusTrap(modal);
    trap.activate();
  };
  const close = () => {
    if (!trap) return;
    modal.hidden = true;
    trap.deactivate();
    trap = null;
  };
  for (const id of ['open', 'plain', 'gear']) document.getElementById(id).addEventListener('click', open);
  document.getElementById('close').addEventListener('click', close);
  // A menu the way the rail's row menu is built: appended to <body>, its first
  // item focused, removed by the item's click before the action runs.
  document.getElementById('menuButton').addEventListener('click', () => {
    const menu = document.createElement('div');
    menu.id = 'menu';
    menu.setAttribute('role', 'menu');
    menu.style.cssText = 'position:fixed;left:400px;top:160px;padding:8px;background:#ddd';
    for (const [id, action] of [['menuFirst', () => {}], ['menuOptions', open]]) {
      const item = document.createElement('button');
      item.id = id;
      item.setAttribute('role', 'menuitem');
      item.textContent = id;
      item.addEventListener('click', () => {
        menu.remove();
        action();
      });
      menu.appendChild(item);
    }
    document.body.appendChild(menu);
    menu.querySelector('button').focus();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); }, true);
`;

describe('where a dialog hands the keyboard back to, in Chromium', () => {
  let browser: Browser;
  const contexts: BrowserContext[] = [];
  let page: Page;
  const errors: string[] = [];

  async function newPage(options: { hasTouch?: boolean } = {}): Promise<Page> {
    const context = await browser.newContext({ viewport: { width: 800, height: 500 }, ...options });
    contexts.push(context);
    const p = await context.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.route(ORIGIN, (route) => route.fulfill({ contentType: 'text/html', body: PAGE }));
    await p.goto(ORIGIN);
    await p.addScriptTag({ content: readFileSync(resolve(publicDir, 'keyboard-accessory.js'), 'utf8') });
    await p.addScriptTag({ content: WIRING });
    return p;
  }

  const focused = (p: Page = page) => p.evaluate(() => (window as any).__focused());
  const focusAtClick = (p: Page = page) => p.evaluate(() => (window as any).__focusAtClick);
  const termText = (p: Page = page) => p.evaluate(() => (document.getElementById('term') as HTMLTextAreaElement).value);

  /** Put the keyboard in the terminal stand-in and type, as a user in the middle of a prompt. */
  async function typeInTerminal(p: Page = page) {
    await p.click('#term');
    await p.keyboard.type('a');
    expect(await focused(p)).toBe('term');
  }

  /** The trap moves focus to the dialog's first control one frame after it opens. */
  async function dialogOpen(p: Page = page) {
    await p.waitForFunction(() => (window as any).__focused() === 'close');
  }

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  beforeEach(async () => {
    errors.length = 0;
    page = await newPage();
  });

  afterAll(async () => {
    for (const context of contexts) await context.close();
    await browser?.close();
  });

  it('a button pressed with the mouse: the keyboard is back in the terminal', async () => {
    await typeInTerminal();
    await page.click('#open');
    await dialogOpen();
    // The engine fact the rule exists for: the press gave the button focus.
    expect(await focusAtClick()).toEqual(['open']);

    await page.keyboard.press('Escape');
    expect(await focused()).toBe('term');
    await page.keyboard.type('b');
    expect(await termText()).toBe('ab');
    expect(errors).toEqual([]);
  });

  it('a control that takes no focus (a button in WebKit on macOS): the keyboard is back in the terminal', async () => {
    await typeInTerminal();
    await page.click('#plain');
    await dialogOpen();
    // The press cleared focus: before the fix this is what the dialog handed back.
    expect(await focusAtClick()).toEqual(['body']);

    await page.keyboard.press('Escape');
    expect(await focused()).toBe('term');
    await page.keyboard.type('b');
    expect(await termText()).toBe('ab');
  });

  it("a press on the icon inside a focusable control (a tab's gear): the keyboard is back in the terminal", async () => {
    await typeInTerminal();
    await page.click('#gearIcon');
    await dialogOpen();
    expect(await focusAtClick()).toEqual(['gear']);

    await page.keyboard.press('Escape');
    expect(await focused()).toBe('term');
    await page.keyboard.type('b');
    expect(await termText()).toBe('ab');
  });

  it("two presses through a menu (a tile's menu, then Session options): the keyboard is back in the terminal", async () => {
    await typeInTerminal();
    await page.click('#menuButton');
    expect(await focused()).toBe('menuFirst');
    await page.click('#menuOptions');
    await dialogOpen();
    // The item's click removed the menu, so nothing had focus when the dialog opened.
    expect(await focusAtClick()).toEqual(['body']);

    await page.keyboard.press('Escape');
    expect(await focused()).toBe('term');
    await page.keyboard.type('b');
    expect(await termText()).toBe('ab');
  });

  it('a menu walked with the keyboard keeps the keyboard pattern', async () => {
    await typeInTerminal();
    await page.click('#menuButton');
    await page.keyboard.press('Tab');
    expect(await focused()).toBe('menuOptions');
    await page.keyboard.press('Enter');
    await dialogOpen();
    await page.keyboard.press('Escape');
    // Nothing was remembered: the dialog hands back what had focus, and that was nothing.
    expect(await focused()).not.toBe('term');
  });

  it('closing the dialog with the mouse instead of Escape changes nothing', async () => {
    await typeInTerminal();
    await page.click('#open');
    await dialogOpen();
    await page.click('#close');
    expect(await focused()).toBe('term');
    await page.keyboard.type('b');
    expect(await termText()).toBe('ab');
  });

  it('typing in the dialog and opening it a second time still ends in the terminal', async () => {
    await typeInTerminal();
    await page.click('#open');
    await dialogOpen();
    await page.click('#name');
    await page.keyboard.type('x');
    await page.keyboard.press('Escape');
    expect(await focused()).toBe('term');

    await page.click('#open');
    await dialogOpen();
    await page.keyboard.press('Escape');
    expect(await focused()).toBe('term');
    await page.keyboard.type('b');
    expect(await termText()).toBe('ab');
  });

  it('a keyboard user gets the control back that opened the dialog', async () => {
    await typeInTerminal();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    expect(await focused()).toBe('open');
    await page.keyboard.press('Enter');
    await dialogOpen();
    await page.keyboard.press('Escape');
    expect(await focused()).toBe('open');
  });

  it('a keyboard user gets the control back even after pressing it with the mouse earlier', async () => {
    await typeInTerminal();
    await page.click('#open');
    await dialogOpen();
    await page.keyboard.press('Escape');
    expect(await focused()).toBe('term');

    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await dialogOpen();
    await page.keyboard.press('Escape');
    expect(await focused()).toBe('open');
  });

  it('a press that began on a button returns to the pressed control, as before', async () => {
    await typeInTerminal();
    await page.click('#other');
    expect(await focused()).toBe('other');
    await page.click('#open');
    await dialogOpen();
    await page.keyboard.press('Escape');
    expect(await focused()).toBe('open');
  });

  it('a finger changes nothing: focus returns to what had it when the dialog opened', async () => {
    const touch = await newPage({ hasTouch: true });
    await touch.tap('#term');
    expect(await focused(touch)).toBe('term');
    await touch.tap('#open');
    await dialogOpen(touch);
    const atClick = (await focusAtClick(touch))[0];
    await touch.keyboard.press('Escape');
    expect(await focused(touch)).toBe(atClick);
  });
});
