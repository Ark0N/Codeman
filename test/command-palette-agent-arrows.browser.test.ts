import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { WebServer } from '../src/web/server.js';

describe('Command-K agent arrow keys in Chromium', () => {
  let server: WebServer;
  let browser: Browser;
  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
  }, 60000);
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
  });

  it('cycles both directions at query boundaries while preserving text editing and selection', async () => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`http://127.0.0.1:${server.boundPort}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => (window as any).app?.openCommandPalette);
      await page.waitForTimeout(3500);
      await page.evaluate(() => {
        const a = (window as any).app;
        a.cases = [{ name: 'buildmesh', path: '/fixture/buildmesh' }];
        a.sessions = new Map();
        a.sessionOrder = [];
        a._runMode = 'codex';
        (window as any).__codemanCliCatalog = [
          { id: 'claude', label: 'Claude', enabled: true, kind: 'agent' },
          { id: 'codex', label: 'Codex', enabled: true, kind: 'agent' },
          { id: 'shell', label: 'Shell', enabled: true, kind: 'shell' },
        ];
        a._runModeAvailableForCase = () => true;
        a._sendInputEphemeral = () => {
          throw new Error('Palette leaked terminal input');
        };
        a.run = () => {
          throw new Error('Arrow key launched a session');
        };
      });
      await page.keyboard.press('Control+k');
      await page.locator('#commandPaletteModal.active').waitFor();
      const input = page.locator('#commandPaletteSearch');
      await input.fill('buildmesh');
      const label = page.locator('.command-palette-agent-label');
      expect(await label.innerText()).toBe('Codex');
      await page.keyboard.press('ArrowLeft');
      expect(await label.innerText()).toBe('Claude');
      await page.keyboard.press('ArrowRight');
      expect(await label.innerText()).toBe('Codex');
      expect(await input.inputValue()).toBe('buildmesh');
      expect(await input.evaluate((e: HTMLInputElement) => e.selectionStart)).toBe(9);
      await page.keyboard.press('Home');
      await page.keyboard.press('ArrowRight');
      expect(await label.innerText()).toBe('Shell');
      await page.keyboard.press('ArrowLeft');
      expect(await label.innerText()).toBe('Codex');
      await input.evaluate((e: HTMLInputElement) => e.setSelectionRange(4, 4));
      await page.keyboard.press('ArrowLeft');
      expect(await input.evaluate((e: HTMLInputElement) => e.selectionStart)).toBe(3);
      await page.keyboard.press('ArrowRight');
      expect(await input.evaluate((e: HTMLInputElement) => e.selectionStart)).toBe(4);
      await page.keyboard.press('Shift+End');
      await page.keyboard.press('ArrowLeft');
      expect(await label.innerText()).toBe('Codex');
      await page.screenshot({ path: '/tmp/codeman-21-palette.png' });
      await page.keyboard.press('ArrowDown');
      expect(
        await page.evaluate(
          () => (window as any).app.commandPaletteItems[(window as any).app.commandPaletteActiveIndex].type
        )
      ).toBe('browse-sessions');
      await page.keyboard.press('End');
      await page.keyboard.press('ArrowLeft');
      expect(await label.innerText()).toBe('Codex');
      await page.keyboard.press('Escape');
      expect(await page.locator('#commandPaletteModal').evaluate((e) => e.classList.contains('active'))).toBe(false);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
