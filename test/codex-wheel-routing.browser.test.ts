import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { WebServer } from '../src/web/server.js';

// Adversarial browser layout fixture, not evidence of native Codex history:
// authentic CLI behavior is measured separately in an isolated live pane.
describe('tracked Codex wheel routing in the primary pane', () => {
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

  it('sends plain wheel to the CLI rather than scrolling stale repaint frames', async () => {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    try {
      await page.goto(`http://127.0.0.1:${server.boundPort}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => (window as any).app?.terminal);
      await page.waitForTimeout(3500);
      await page.evaluate(async () => {
        const app = (window as any).app;
        app.activeSessionId = 'codex-wheel-probe';
        app.sessions.set(app.activeSessionId, { id: app.activeSessionId, mode: 'codex', cliMouseTracking: true });
        (window as any).scrollInputs = [];
        // Cell hit testing is irrelevant to routing; the empty dashboard covers the test terminal.
        app._clientPointToCell = () => ({ col: 1, row: 1 });
        app._sendInputEphemeral = (id: string, data: string) => (window as any).scrollInputs.push({ id, data });
        app.loadAppSettingsFromStorage = () => ({ terminalWheelLocalScrollback: false });
        await new Promise<void>((resolve) => app.terminal.write('\r\nold repaint row'.repeat(100), resolve));
        app.terminal.scrollToTop();
      });
      const fire = (shiftKey = false) =>
        page.evaluate((shiftKey) => {
          const t = (window as any).app.terminal;
          t.element.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, shiftKey, bubbles: true, cancelable: true }));
        }, shiftKey);
      await fire();
      await page.waitForTimeout(150);
      const forwarded = await page.evaluate(() => {
        const app = (window as any).app;
        return {
          inputs: (window as any).scrollInputs,
          baseY: app.terminal.buffer.active.baseY,
          viewportY: app.terminal.buffer.active.viewportY,
        };
      });
      expect(forwarded.inputs.length).toBeGreaterThan(0);
      expect(forwarded.inputs.every((i: { id: string }) => i.id === 'codex-wheel-probe')).toBe(true);
      expect(
        forwarded.inputs
          .map((i: { data: string }) => i.data)
          .join('')
          .match(/\x1b\[<64;/g)
      ).toHaveLength(4);
      expect(forwarded.viewportY).toBe(forwarded.baseY);
      for (const shift of [false, true]) {
        await page.evaluate((tracked) => {
          const app = (window as any).app;
          app.sessions.get(app.activeSessionId).cliMouseTracking = tracked;
          app.terminal.scrollToBottom();
          (window as any).scrollInputs = [];
        }, shift);
        await fire(shift);
        await page.waitForTimeout(150);
        const local = await page.evaluate(() => {
          const b = (window as any).app.terminal.buffer.active;
          return { inputs: (window as any).scrollInputs, baseY: b.baseY, viewportY: b.viewportY };
        });
        expect(local.inputs).toEqual([]);
        expect(local.viewportY).toBeLessThan(local.baseY);
      }
    } finally {
      await page.close();
    }
  });
});
