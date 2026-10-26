import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { WebServer } from '../src/web/server.js';

const id = 'originating-file-session';
const path = '/Users/example/contexts/hdai-hyperdrive/manifests/demo workloads #1%.yaml';
const denial = 'Path must be within working directory or allowed log directories';
const yaml = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: demo\n';

describe('one-file approval from the blocked log viewer (#23)', () => {
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

  for (const outcome of ['allowed', 'still blocked', 'non-codex']) {
    it(`${outcome}: stops permission retries and grants only the explicitly clicked file`, async () => {
      const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
      const approvals: unknown[] = [],
        errors: string[] = [];
      let tailRequests = 0,
        rawReads = 0;
      page.on('pageerror', (e) => errors.push(e.message));
      await page.route(`**/api/sessions/${id}/**`, async (route) => {
        const url = new URL(route.request().url());
        const json = (data: unknown, status = 200) =>
          route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
        if (url.pathname.endsWith('/tail-file')) {
          tailRequests++;
          expect(url.searchParams.get('path')).toBe(path);
          return route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body: `data: ${JSON.stringify({ type: 'error', error: denial })}\n\n`,
          });
        }
        if (url.pathname.endsWith('/attachments') && route.request().method() === 'POST') {
          approvals.push(route.request().postDataJSON());
          return outcome === 'still blocked'
            ? json({ success: false, error: 'Access to this file is blocked' }, 403)
            : json({ success: true, data: { attachmentId: 'approved', fileName: path.split('/').pop() } });
        }
        if (url.pathname.endsWith('/attachments/approved'))
          return json({
            success: true,
            data: {
              type: 'text',
              extension: 'yaml',
              size: yaml.length,
              mtimeMs: 1,
              editable: false,
              url: `/api/sessions/${id}/attachments/approved/raw`,
            },
          });
        if (url.pathname.endsWith('/raw')) {
          rawReads++;
          return route.fulfill({ status: 200, contentType: 'text/plain', body: yaml });
        }
        return json({ success: true, data: [] });
      });
      try {
        await page.goto(`http://127.0.0.1:${server.boundPort}`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => (window as any).app?.openLogViewerWindow);
        await page.waitForTimeout(3500);
        await page.evaluate(
          ({ id, path, outcome }) => {
            const app = (window as any).app;
            app.sessions.set(id, {
              id,
              mode: outcome === 'non-codex' ? 'claude' : 'codex',
              workingDir: '/Users/example/contexts/saif',
              remote: { hostId: 'fixture' },
            });
            // The approval must remain bound to the log's session, not the active tab.
            app.activeSessionId = 'different-active-session';
            app.openLogViewerWindow(path, id);
          },
          { id, path, outcome }
        );
        const viewer = page.locator('.log-viewer-window');
        await expect.poll(() => viewer.innerText()).toContain(denial);
        await page.waitForTimeout(3200);
        expect(tailRequests).toBe(1);
        expect(await viewer.locator('.status').innerText()).toBe('permission needed');
        expect((await viewer.innerText()).split(denial)).toHaveLength(2);
        expect(approvals).toEqual([]);
        const allow = viewer.getByRole('button', { name: 'Allow this file once', exact: true });
        if (outcome === 'non-codex') {
          expect(await allow.count()).toBe(0);
        } else {
          await allow.waitFor({ state: 'visible' });
          if (outcome === 'allowed') await page.screenshot({ path: '/tmp/codeman-23-blocked.png' });
          await allow.click();
          const body = page.locator('#filePreviewBody');
          await expect
            .poll(() => body.innerText())
            .toContain(outcome === 'allowed' ? 'kind: ConfigMap' : 'Access to this file is blocked');
          expect(approvals).toEqual([{ path, notify: false }]);
          expect(await viewer.count()).toBe(0);
          if (outcome === 'allowed') {
            expect(rawReads).toBeGreaterThan(0);
            expect(await page.locator('#filePreviewEditBtn').isVisible()).toBe(false);
            await page.screenshot({ path: '/tmp/codeman-23-approved.png' });
          } else {
            expect(rawReads).toBe(0);
            expect(await body.getByRole('button', { name: 'Allow this file once', exact: true }).count()).toBe(0);
          }
        }
        expect(errors).toEqual([]);
      } finally {
        await page.close();
      }
    });
  }
});
