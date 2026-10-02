/** @fileoverview Settings → Notifications → Webhook, end to end: real server, real Chromium, a local receiver. */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3195;
const SECRET = 'SUPERSECRET-topic-123';

describe('Webhook settings in a real browser', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;
  let receiver: Server;
  let receiverPort: number;
  let respondWith = 200;
  const got: { url?: string; title?: string; body: string }[] = [];

  beforeAll(async () => {
    receiver = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        got.push({ url: req.url, title: req.headers.title as string | undefined, body });
        res.statusCode = respondWith;
        res.end('x');
      });
    });
    await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
    receiverPort = (receiver.address() as AddressInfo).port;

    server = new WebServer(PORT, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).app?.terminal, null, { timeout: 30000 });
    await page.evaluate(() => (window as any).app.openAppSettings());
    await page.waitForSelector('#webhookGroup', { state: 'attached' });
    await page.waitForFunction(() => document.getElementById('webhookGroup')!.style.display !== 'none');
  }, 90000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
    await new Promise<void>((r) => receiver.close(() => r()));
  }, 60000);

  const result = () => page.textContent('#webhookResult');

  it('shows the group, starts empty, and refuses to enable without a URL', async () => {
    expect(await page.textContent('#webhookUrlHint')).toBe('Nothing saved yet.');
    await page.check('#webhookEnabled');
    await page.click('#webhookSaveBtn');
    await page.waitForFunction(() =>
      /Add a webhook URL/.test(document.getElementById('webhookResult')?.textContent ?? '')
    );
    await page.uncheck('#webhookEnabled');
  });

  it('refuses a cloud-metadata URL with the server’s reason', async () => {
    await page.fill('#webhookUrl', 'http://169.254.169.254/latest');
    await page.click('#webhookSaveBtn');
    await page.waitForFunction(() =>
      /metadata|link-local/.test(document.getElementById('webhookResult')?.textContent ?? '')
    );
  });

  it('saves a URL, shows only scheme and host, and empties the secret field', async () => {
    await page.selectOption('#webhookKind', 'ntfy');
    await page.fill('#webhookUrl', `http://127.0.0.1:${receiverPort}/${SECRET}`);
    await page.check('#webhookEnabled');
    await page.click('#webhookSaveBtn');
    await page.waitForFunction(() => /Saved\./.test(document.getElementById('webhookResult')?.textContent ?? ''));
    expect(await page.textContent('#webhookUrlHint')).toBe(`Saved: http://127.0.0.1:${receiverPort}/•••`);
    expect(await page.inputValue('#webhookUrl')).toBe('');
    expect(await page.content()).not.toContain(SECRET);
    // ...and GET /api/webhook never returns it either.
    const body = await page.evaluate(async () => (await fetch('/api/webhook')).text());
    expect(body).not.toContain('SUPERSECRET');
  });

  it('sends a test message that reaches the receiver with the ntfy headers', async () => {
    got.length = 0;
    await page.click('#webhookTestBtn');
    await page.waitForFunction(() => /Test sent/.test(document.getElementById('webhookResult')?.textContent ?? ''));
    expect(got).toHaveLength(1);
    expect(got[0].url).toBe(`/${SECRET}`);
    expect(got[0].title).toMatch(/Codeman test notification/);
    expect(got[0].body).toMatch(/webhook notifications are working/);
  });

  it('reports a failing endpoint without exposing the URL', async () => {
    respondWith = 500;
    await page.click('#webhookTestBtn');
    await page.waitForFunction(() =>
      /Delivery failed: HTTP 500/.test(document.getElementById('webhookResult')?.textContent ?? '')
    );
    expect(await result()).not.toContain(SECRET);
    respondWith = 200;
  });

  it('keeps the saved URL when only the service changes', async () => {
    got.length = 0;
    await page.selectOption('#webhookKind', 'generic');
    await page.click('#webhookSaveBtn');
    await page.waitForFunction(() => /Saved\./.test(document.getElementById('webhookResult')?.textContent ?? ''));
    await page.click('#webhookTestBtn');
    await page.waitForFunction(() => /Test sent/.test(document.getElementById('webhookResult')?.textContent ?? ''));
    expect(JSON.parse(got[0].body)).toMatchObject({ event: 'webhook:test', urgency: 'info' });
  });
});
