/**
 * @fileoverview A proxied page inside the web-tab sandbox must be reported as
 * storage-blocked only if the page itself touches storage.
 *
 * The shim used to probe `window.localStorage` at boot. In a frame without
 * `allow-same-origin` that getter always throws, so every sandboxed dashboard
 * claimed blocked storage — including a page that is one <h1> and never runs a
 * line of its own script. jsdom cannot reproduce the opaque origin a sandboxed
 * frame gets (its `localStorage` is a normal, working object), so the premise is
 * checked here in real Chromium: a plain page produces no notice, a page that
 * reads storage produces exactly one and still sees its own SecurityError.
 *
 * Browser-driven, so excluded from `npm test` (config/test-suites.ts). Run locally:
 *   npm run test:browser -- test/webview-sandbox-notice.browser.test.ts
 *
 * Port: N/A (both the parent page and the proxied pages are served by request
 * interception; no Codeman server is started).
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { rewriteHtml } from '../src/web/webview-proxy.js';

const CAP = 'A'.repeat(32);
const PREFIX = `/webview/${CAP}/`;
const ORIGIN = 'http://codeman.test';

/**
 * `chromium.launch()` wants the revision this Playwright release pins, and a
 * checkout can have a different one cached. Use a cached build when the pinned
 * one is absent; when the pinned one is there, return undefined and let
 * Playwright resolve it as usual.
 */
function cachedChromium(): string | undefined {
  if (existsSync(chromium.executablePath())) return undefined;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), '.cache', 'ms-playwright');
  let builds: string[];
  try {
    builds = readdirSync(root).filter((name) => /^chromium-\d+$/.test(name));
  } catch {
    return undefined;
  }
  builds.sort((a, b) => Number(b.slice('chromium-'.length)) - Number(a.slice('chromium-'.length)));
  const executables = [
    'chrome-linux64/chrome',
    'chrome-linux/chrome',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
    'chrome-win/chrome.exe',
  ];
  for (const build of builds) {
    for (const executable of executables) {
      const candidate = join(root, build, executable);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const PLAIN_SOURCE =
  '<!doctype html><html><head><title>Plain</title></head><body><h1>Static dashboard</h1></body></html>';
const STORAGE_SOURCE = `<!doctype html><html><head><title>Storage</title></head><body>
<h1>Storage dashboard</h1>
<script>
try {
  localStorage.getItem('theme');
  parent.postMessage({ type: 'test:storage-ok' }, '*');
} catch (error) {
  parent.postMessage({ type: 'test:storage-error', name: error.name }, '*');
}
</script>
</body></html>`;

function parentHtml(source: 'plain' | 'storage'): string {
  return `<!doctype html><html><head><title>Codeman</title></head><body>
<p id="status">no notice</p>
<iframe id="frame" sandbox="allow-scripts allow-forms allow-popups allow-downloads allow-modals"
  src="${PREFIX}${source}" onload="window.__frameLoads = (window.__frameLoads || 0) + 1"></iframe>
<script>
window.__messages = [];
window.addEventListener('message', function (event) {
  window.__messages.push(event.data);
  if (event.data && event.data.type === 'codeman:webview-needs-origin') {
    document.getElementById('status').textContent = 'notice';
  }
});
</script>
</body></html>`;
}

async function open(
  browser: Browser,
  source: 'plain' | 'storage'
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const html = source === 'plain' ? PLAIN_SOURCE : STORAGE_SOURCE;
  await page.route(`${ORIGIN}/**`, (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/') return route.fulfill({ body: parentHtml(source), contentType: 'text/html' });
    if (pathname === `${PREFIX}${source}`) {
      return route.fulfill({ body: rewriteHtml(html, CAP), contentType: 'text/html' });
    }
    return route.fulfill({ status: 404, body: 'not found' });
  });
  await page.goto(`${ORIGIN}/`);
  return { page, close: () => context.close() };
}

const messages = (page: Page) => page.evaluate(() => (window as any).__messages as any[]);
const needsOrigin = (list: any[]) => list.filter((message) => message?.type === 'codeman:webview-needs-origin');

describe('webview sandbox notice in Chromium', () => {
  let browser: Browser;

  beforeAll(async () => {
    const executablePath = cachedChromium();
    browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('loads the frame without allow-same-origin', async () => {
    const { page, close } = await open(browser, 'plain');
    try {
      const sandbox = await page.getAttribute('#frame', 'sandbox');
      expect(sandbox).toContain('allow-scripts');
      expect(sandbox).not.toContain('allow-same-origin');
    } finally {
      await close();
    }
  });

  it('does not report a page whose body is a single <h1>', async () => {
    const { page, close } = await open(browser, 'plain');
    try {
      await page.waitForFunction(() => (window as any).__frameLoads === 1);
      // A report, if the shim still probed storage at boot, is already queued by now.
      await page.waitForTimeout(300);
      expect(await messages(page)).toEqual([]);
      expect(await page.textContent('#status')).toBe('no notice');
    } finally {
      await close();
    }
  });

  it('reports once when the page touches localStorage, with the original SecurityError', async () => {
    const { page, close } = await open(browser, 'storage');
    try {
      await page.waitForFunction(() =>
        (window as any).__messages.some((message: any) => message?.type === 'test:storage-error')
      );
      await page.waitForTimeout(100);
      const list = await messages(page);
      expect(needsOrigin(list)).toHaveLength(1);
      expect(list.find((message) => message?.type === 'test:storage-error')?.name).toBe('SecurityError');
      expect(await page.textContent('#status')).toBe('notice');
    } finally {
      await close();
    }
  });
});
