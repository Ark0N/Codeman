import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { WebServer } from '../src/web/server.js';

const id = 'log-reconnect-fixture',
  path = '/workspace/demo.log';
describe('log viewer pre-connect failures', () => {
  let server: WebServer, browser: Browser;
  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
  }, 60000);
  afterAll(async () => {
    await browser?.close();
    await server?.stop();
  });
  it.each([
    'Path must be within working directory or allowed log directories',
    'File does not exist',
    'File not found or not accessible',
    'File too large',
    'Maximum 5 concurrent streams per session',
    'Failed to spawn tail process',
  ])('does not reconnect after %s before connected', async (error) => {
    const page = await browser.newPage(),
      errors: string[] = [];
    let requests = 0;
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route(`**/api/sessions/${id}/tail-file?**`, async (route) => {
      requests++;
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        // retry: 200 makes a reconnect, if one came, show up within 200 ms.
        body: `retry: 200\ndata: ${JSON.stringify({ type: 'error', error })}\n\n`,
      });
    });
    try {
      await page.goto(`http://127.0.0.1:${server.boundPort}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => (window as any).app?.openLogViewerWindow);
      await page.waitForTimeout(3500);
      await page.evaluate(
        ({ id, path }) => {
          const app = (window as any).app;
          app.sessions.set(id, { id, mode: 'shell', workingDir: '/workspace' });
          app.openLogViewerWindow(path, id);
        },
        { id, path }
      );
      await expect.poll(() => page.locator('.log-viewer-window').innerText()).toContain(error);
      await page.waitForTimeout(1000);
      expect(requests).toBe(1);
      expect(errors).toEqual([]);
    } finally {
      await page.close();
    }
  });
});
