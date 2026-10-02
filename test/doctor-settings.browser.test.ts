/** @fileoverview Settings → System → Diagnostics in a real browser, with GET /api/doctor stubbed at the network layer. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3196;

const REPORT = {
  platform: { environment: 'linux' },
  summary: { ok: 1, requiredMissing: 1, optionalMissing: 0, exitCode: 1 },
  tools: [
    {
      id: 'node',
      label: 'Node.js',
      category: 'core',
      required: true,
      usedBy: [],
      status: 'ok',
      version: '22.1.0',
      path: '/usr/bin/node',
    },
    {
      id: 'tmux',
      label: 'tmux',
      category: 'core',
      required: true,
      usedBy: [],
      status: 'missing',
      installHint: 'apt install tmux',
    },
    // Host-supplied strings must be rendered as text, never as markup.
    {
      id: 'x',
      label: '<img src=x onerror=window.__pwned=1>',
      category: 'other',
      required: false,
      usedBy: [],
      status: 'missing',
    },
  ],
};

describe('Diagnostics panel in a real browser', () => {
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
  }, 90000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
  }, 60000);

  it('lists each tool with status, version, path and install hint, and renders host strings as text', async () => {
    await page.route('**/api/doctor', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data: REPORT }) })
    );
    await page.click('#doctorRunBtn');
    await page.waitForFunction(() => /1 ok/.test(document.getElementById('doctorResult')?.textContent ?? ''));
    const text = await page.textContent('#doctorResult');
    expect(text).toContain('1 ok · 1 required missing · 0 optional missing (linux)');
    expect(text).toContain('✓ Node.js ok · 22.1.0');
    expect(text).toContain('/usr/bin/node');
    expect(text).toContain('✗ tmux missing · required');
    expect(text).toContain('Install: apt install tmux');
    expect(text).toContain('<img src=x onerror=window.__pwned=1>'); // shown literally
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
    expect(await page.$('#doctorResult img')).toBeNull();
    expect(await page.isDisabled('#doctorRunBtn')).toBe(false);
  });

  it('shows the server’s message when the check fails, and re-enables the button', async () => {
    await page.unroute('**/api/doctor');
    await page.route('**/api/doctor', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, errorCode: 'OPERATION_FAILED', error: 'doctor failed: boom' }),
      })
    );
    await page.click('#doctorRunBtn');
    await page.waitForFunction(() => /boom/.test(document.getElementById('doctorResult')?.textContent ?? ''));
    expect(await page.isDisabled('#doctorRunBtn')).toBe(false);
  });
});
