/** @fileoverview Settings → Terminal & Input → Key tester, driven with real keystrokes in Chromium. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3194;

describe('Key tester in a real browser', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = new WebServer(PORT, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).app?.terminal, null, { timeout: 30000 });
    await page.evaluate(() => (window as any).app.openAppSettings());
    await page.focus('#keyTesterInput');
  }, 90000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
  }, 60000);

  const log = () => page.evaluate(() => document.getElementById('keyTesterLog')!.textContent ?? '');

  it('shows keydown, keypress and keyup for Shift+Enter, with the modifier and charCode', async () => {
    await page.keyboard.press('Shift+Enter');
    const text = await log();
    expect(text).toMatch(/keydown\s+key="Enter" code=Enter mods=shift/);
    // The keypress is the event that used to leak a bare \r to the PTY.
    expect(text).toMatch(/keypress\s+key="Enter" code=Enter mods=shift charCode=13/);
    expect(text).toMatch(/keyup\s+key="Enter" code=Enter mods=shift/);
  });

  it('shows Ctrl+Enter without a keypress, as xterm would never see one for Ctrl', async () => {
    await page.evaluate(() => (document.getElementById('keyTesterLog')!.textContent = ''));
    await page.keyboard.press('Control+Enter');
    const text = await log();
    expect(text).toMatch(/keydown\s+key="Enter" code=Enter mods=ctrl/);
    expect(text).toMatch(/keyup/);
    // Chromium emits no keypress for a Ctrl chord, which is why only Shift+Enter ever leaked a \r.
    expect(text).not.toMatch(/keypress/);
  });

  it('lets no app shortcut fire for keys pressed in the field (Ctrl+W, Ctrl+L, Escape, Alt+1, Ctrl+K)', async () => {
    // The shortcut dispatcher is a capture-phase document listener, so without a guard it ran before
    // the field's own handler: Ctrl+W killed the active session, Ctrl+L cleared the terminal and
    // Escape closed Settings, while this row says nothing is sent to a session.
    await page.evaluate(() => {
      const app = (window as any).app;
      const calls: string[] = [];
      (window as any).__calls = calls;
      for (const name of ['killActiveSession', 'clearTerminal', 'openCommandPalette', 'closeAllPanels']) {
        app[name] = (...args: unknown[]) => void calls.push(name + args.length);
      }
    });
    await page.focus('#keyTesterInput');
    // [chord, what the tester must report for it]; checked one at a time because the log keeps 14 lines.
    const chords: [string, RegExp][] = [
      ['Control+W', /key="w" code=KeyW mods=ctrl/i],
      ['Control+L', /key="l" code=KeyL mods=ctrl/i],
      ['Escape', /key="Escape" code=Escape/],
      ['Alt+1', /code=Digit1 mods=alt/],
      ['Control+K', /key="k" code=KeyK mods=ctrl/i],
    ];
    for (const [chord, seen] of chords) {
      await page.evaluate(() => (document.getElementById('keyTesterLog')!.textContent = ''));
      await page.keyboard.press(chord);
      expect(await log(), chord).toMatch(seen);
      expect(await page.evaluate(() => (window as any).__calls), chord).toEqual([]);
    }
    expect(await page.evaluate(() => document.getElementById('appSettingsModal')!.classList.contains('active'))).toBe(
      true
    );
  });

  it('still lets the shortcut fire anywhere else (the guard is scoped to data-raw-keys)', async () => {
    await page.evaluate(() => {
      (window as any).__calls.length = 0;
      (document.activeElement as HTMLElement | null)?.blur();
    });
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => (window as any).__calls)).toContain('closeAllPanels0');
  });

  it('keeps only the last 14 lines and never types into the field', async () => {
    // The test above blurred the field, so focus it again: without this the presses land on
    // <body>, the log keeps whatever the earlier tests left, and the cap is never exercised.
    await page.focus('#keyTesterInput');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('keyTesterInput');
    await page.evaluate(() => (document.getElementById('keyTesterLog')!.textContent = ''));
    const lines = async () => (await log()).split('\n');

    // A printable key fires keydown, keypress and keyup, so 2 presses are 6 lines: under the cap
    // the log accumulates rather than showing only the latest event.
    for (let i = 0; i < 2; i++) await page.keyboard.press('a');
    expect(await lines()).toHaveLength(6);

    // A different key, so eviction is visible: 4 x 3 = 12 more lines makes 18, capped to 14. The
    // oldest 4 go (all of the first 'a' press and the second one's keydown), the newest stay in order.
    for (let i = 0; i < 4; i++) await page.keyboard.press('b');
    const capped = await lines();
    expect(capped).toHaveLength(14);
    expect(capped.filter((l) => l.includes('key="a"'))).toHaveLength(2);
    expect(capped.filter((l) => l.includes('key="b"'))).toHaveLength(12);
    expect(capped[0]).toMatch(/^keypress\s+key="a" code=KeyA mods=none charCode=97$/);
    expect(capped[13]).toMatch(/^keyup\s+key="b" code=KeyB mods=none$/);

    // Readonly: none of those presses typed anything into the field itself.
    expect(await page.inputValue('#keyTesterInput')).toBe('');
  });
});
