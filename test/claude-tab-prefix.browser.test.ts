import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3165;
const BASE_URL = `http://localhost:${PORT}`;

describe('Claude Code tab prefix', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = new WebServer(PORT, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof window.app !== 'undefined');
  }, 60000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
  }, 60000);

  it('renders CC on a Claude Code terminal tab', async () => {
    const badge = await page.evaluate(() => {
      const app = window.app as {
        sessions: Map<string, { id: string; name: string; mode: string; status: string }>;
        sessionOrder: string[];
        _renderSessionTabsImmediate: () => void;
      };
      app.sessions.clear();
      app.sessions.set('claude-prefix', {
        id: 'claude-prefix',
        name: 'w1-prefix-test',
        mode: 'claude',
        status: 'idle',
      });
      app.sessionOrder = ['claude-prefix'];
      app._renderSessionTabsImmediate();
      return document.querySelector('[data-id="claude-prefix"] .tab-mode')?.textContent;
    });

    expect(badge).toBe('cc');
  });
});
