/** @fileoverview Settings → Terminal & Input → Key tester, driven with real keystrokes in Chromium. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3197;

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
  });

  it('keeps only the last 14 lines and never types into the field', async () => {
    for (let i = 0; i < 8; i++) await page.keyboard.press('a');
    expect((await log()).split('\n').length).toBeLessThanOrEqual(14);
    expect(await page.inputValue('#keyTesterInput')).toBe('');
  });
});
