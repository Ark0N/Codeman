// Issue #759: opt-in phone access, exercised against the real app and filesystem.
// Run with npm run test:mobile -- test/mobile/file-browser.test.ts (not the CI runner).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { BrowserContext, Locator, Page } from 'playwright';
import type { WebServer } from '../../src/web/server.js';
import { assertSandboxedHome, safeRmHomeTree } from '../mocks/test-helpers.js';
import { REPRESENTATIVE_DEVICES } from './devices.js';
import { createDevicePage, closeAllBrowsers } from './helpers/browser.js';
import { assertTouchTarget } from './helpers/assertions.js';
import { STORAGE_KEYS } from './helpers/constants.js';
import { createTestServer, stopTestServer } from './helpers/server.js';

describe('File browser on a phone (issue #759)', () => {
  let server: WebServer;
  let baseUrl: string;
  let sessionId: string;
  let workspace: string;
  let context: BrowserContext;
  let page: Page;

  beforeAll(async () => {
    assertSandboxedHome('Phone file browser fixture');
    workspace = join(homedir(), 'file-browser-phone');
    await mkdir(join(workspace, 'src'), { recursive: true });
    await writeFile(join(workspace, 'README.md'), 'Phone browser fixture');
    await writeFile(join(workspace, '.hidden.txt'), 'Hidden fixture');
    await writeFile(join(workspace, 'src', 'note.txt'), 'Nested fixture');
    await mkdir(join(workspace, 'src', 'deep'), { recursive: true });
    await writeFile(join(workspace, 'src', 'deep', 'needle.ts'), 'Deep fixture');
    await mkdir(join(workspace, 'bulk'));
    await mkdir(join(workspace, 'unavailable'));
    await Promise.all(
      Array.from({ length: 501 }, (_, index) =>
        writeFile(join(workspace, 'bulk', `entry-${String(index).padStart(4, '0')}.txt`), 'x')
      )
    );
    server = await createTestServer();
    baseUrl = `http://localhost:${server.boundPort}`;
    const response = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'phone-files', mode: 'shell', workingDir: workspace }),
    });
    const body = await response.json();
    expect(response.ok, JSON.stringify(body)).toBe(true);
    expect(body.success, JSON.stringify(body)).toBe(true);
    expect(body.data?.session?.id).toBeTypeOf('string');
    sessionId = body.data.session.id;
  });

  beforeEach(async () => {
    ({ context, page } = await createDevicePage(
      {
        ...REPRESENTATIVE_DEVICES['standard-phone'],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 1,
      },
      baseUrl,
      'chromium'
    ));
    await page.waitForFunction((id) => (window as any).app?.sessions.has(id), sessionId);
    await page.evaluate(async (id) => {
      await (window as any).app.selectSession(id);
    }, sessionId);
  });

  afterEach(async () => {
    await context?.close();
  });

  afterAll(async () => {
    await closeAllBrowsers();
    if (sessionId) await fetch(`${baseUrl}/api/sessions/${sessionId}`, { method: 'DELETE' });
    if (server) await stopTestServer(server);
    if (workspace) safeRmHomeTree(workspace);
  });

  async function saveSetting(id: string, checked: boolean) {
    const mobileSettings = page.locator('.btn-settings-mobile');
    const opener = (await mobileSettings.isVisible()) ? mobileSettings : page.locator('.btn-settings');
    await opener.click();
    const control = page.locator(`#${id}`);
    // The chip's native checkbox is visually hidden; the label is the touch target.
    if ((await control.isChecked()) !== checked) {
      await page.locator(`label:has(#${id})`).click();
    }
    const headSave = page.locator('#appSettingsModal .set-head-save').filter({ hasText: /^Save$/ });
    const save = (await headSave.isVisible()) ? headSave : page.locator('#appSettingsModal .set-foot .btn-primary');
    await save.click();
    await expect.poll(() => page.locator('#appSettingsModal').isVisible()).toBe(false);
  }

  async function expectReachable(control: Locator) {
    expect(await control.isVisible()).toBe(true);
    const box = await control.boundingBox();
    expect(box).not.toBeNull();
    const viewport = page.viewportSize()!;
    // Allow subpixel rounding at the fixed header's border.
    expect(box!.x).toBeGreaterThanOrEqual(-1);
    expect(box!.y).toBeGreaterThanOrEqual(-1);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1);
    // A Settings-saved toast can briefly cover the panel after opening it.
    // Wait for normal feedback to clear, but reject persistent occlusion.
    await expect
      .poll(
        () =>
          control.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return { reachable: target !== null && element.contains(target), target: target?.outerHTML.slice(0, 200) };
          }),
        { timeout: 5000 }
      )
      .toMatchObject({ reachable: true });
  }

  it('keeps the phone header button off by default', async () => {
    expect(await page.evaluate(() => (window as any).app.getDefaultSettings().showFileViewerButton)).toBe(false);
    expect(await page.locator('.btn-file-viewer').isVisible()).toBe(false);
  });

  it('honors enable/save/reload, opens and closes from the header, and honors disabling', async () => {
    await saveSetting('appSettingsShowFileViewerButton', true);
    const button = page.locator('.btn-file-viewer');
    await expect.poll(() => button.isVisible()).toBe(true);
    expect(
      await page.evaluate(
        (key) => JSON.parse(localStorage.getItem(key)!).showFileViewerButton,
        STORAGE_KEYS.SETTINGS_MOBILE
      )
    ).toBe(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction((id) => (window as any).app?.sessions.has(id), sessionId);

    await expect.poll(() => button.isVisible(), { timeout: 3000 }).toBe(true);
    await expectReachable(button);
    await assertTouchTarget(button);
    const panel = page.locator('#fileBrowserPanel');
    await button.tap();
    await expect.poll(() => panel.isVisible()).toBe(true);
    await page.locator('#fileBrowserTree [data-path="README.md"]').waitFor({ state: 'visible' });
    await button.tap();
    await expect.poll(() => panel.isVisible()).toBe(false);
    await button.tap();
    await expect.poll(() => panel.isVisible()).toBe(true);
    await panel.locator('button[title="Close"]').tap();
    await expect.poll(() => panel.isVisible()).toBe(false);

    await saveSetting('appSettingsShowFileViewerButton', false);
    expect(await button.isVisible()).toBe(false);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction((id) => (window as any).app?.sessions.has(id), sessionId);
    expect(await button.isVisible()).toBe(false);
  });

  it('keeps the panel and essential controls usable at 390px through the existing Settings entry', async () => {
    // Exercise panel usability independently of the missing header entry point.
    await saveSetting('appSettingsShowFileBrowser', true);
    const panel = page.locator('#fileBrowserPanel');
    await expect.poll(() => panel.isVisible()).toBe(true);
    const tree = panel.locator('#fileBrowserTree');
    await tree.locator('[data-path="README.md"]').waitFor({ state: 'visible' });
    for (const control of [
      panel,
      panel.locator('#fileBrowserSearch'),
      panel.locator('#fileBrowserHiddenBtn'),
      panel.locator('button[title="Refresh"]'),
      panel.locator('#fileBrowserExpandBtn'),
      panel.locator('button[title="Close"]'),
    ]) {
      await expectReachable(control);
    }

    await panel.locator('#fileBrowserExpandBtn').tap();
    expect(await tree.locator('[data-path="src/note.txt"]').count()).toBe(0);
    await tree.locator('[data-path="src"]').tap();
    await tree.locator('[data-path="src/note.txt"]').waitFor({ state: 'visible' });
    await panel.locator('#fileBrowserHiddenBtn').tap();
    await tree.locator('[data-path=".hidden.txt"]').waitFor({ state: 'visible' });
    expect(await tree.locator('[data-path="README.md"]').isVisible()).toBe(true);
    await panel.locator('#fileBrowserSearch').fill('note.txt');
    await expect.poll(() => tree.locator('[data-path="README.md"]').count()).toBe(0);
    await tree.locator('[data-path="src/note.txt"]').waitFor({ state: 'visible' });
    await panel.locator('button[title="Refresh"]').tap();
    await tree.locator('[data-path="README.md"]').waitFor({ state: 'visible' });
    await panel.locator('button[title="Close"]').tap();
    await expect.poll(() => panel.isVisible()).toBe(false);
  });

  it.each(['phone', 'desktop'])(
    'loads folders and pages on demand and reveals a workspace-search folder on %s',
    async (device) => {
      const activate = (control: Locator) => (device === 'phone' ? control.tap() : control.click());
      if (device === 'desktop') {
        await context.close();
        ({ context, page } = await createDevicePage(
          {
            ...REPRESENTATIVE_DEVICES['standard-phone'],
            viewport: { width: 1280, height: 900 },
            deviceScaleFactor: 1,
            isMobile: false,
            hasTouch: false,
            userAgent:
              'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
          },
          baseUrl,
          'chromium'
        ));
        await page.waitForFunction((id) => (window as any).app?.sessions.has(id), sessionId);
        await page.evaluate(async (id) => (window as any).app.selectSession(id), sessionId);
      }
      // The desktop may restore the panel from synced settings saved by the phone cases.
      // Start this request-count assertion from an explicit close/open on either device.
      const panel = page.locator('#fileBrowserPanel');
      if (await panel.isVisible()) {
        await activate(panel.locator('button[title="Close"]'));
        await expect.poll(() => panel.isVisible()).toBe(false);
      }
      const requests: URL[] = [];
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (request.method() === 'GET' && url.pathname.endsWith(`/sessions/${sessionId}/files`)) requests.push(url);
      });
      await saveSetting('appSettingsShowFileBrowser', true);
      const tree = panel.locator('#fileBrowserTree');
      await tree.locator('[data-path="README.md"]').waitFor({ state: 'visible' });
      expect(requests).toHaveLength(1);
      expect(requests[0].searchParams.get('lazy')).toBe('1');

      const input = panel.locator('#fileBrowserSearch');
      await input.fill('deep');
      await page.waitForTimeout(350); // Outwait the former automatic server-search debounce.
      expect(requests).toHaveLength(1);
      await input.press('Enter');
      await tree.locator('[data-path="src/deep"]').waitFor({ state: 'visible' });
      expect(requests.at(-1)!.searchParams.get('q')).toBe('deep');
      await activate(tree.locator('[data-path="src/deep"]'));
      await tree.locator('[data-path="src/deep/needle.ts"]').waitFor({ state: 'visible' });
      expect(await input.inputValue()).toBe('');
      expect(requests.filter((url) => url.searchParams.has('path')).map((url) => url.searchParams.get('path'))).toEqual(
        ['src', 'src/deep']
      );

      await activate(tree.locator('[data-path="bulk"]'));
      const more = tree.locator('[data-file-browser-load="more"]');
      await more.waitFor({ state: 'visible' });
      if (device === 'phone') await assertTouchTarget(more);
      expect(await tree.locator('[data-path^="bulk/"][data-type="file"]').count()).toBe(500);
      await activate(more);
      await expect.poll(() => tree.locator('[data-path^="bulk/"][data-type="file"]').count()).toBe(501);
      expect(await more.count()).toBe(0);
      expect(requests.at(-1)!.searchParams.get('cursor')).toBeTruthy();
      expect(await tree.locator('[data-path="src/deep/needle.ts"]').isVisible()).toBe(true);

      const unavailable = (url: URL) =>
        url.pathname.endsWith(`/sessions/${sessionId}/files`) && url.searchParams.get('path') === 'unavailable';
      await page.route(unavailable, (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, error: 'Folder unavailable; retry or refresh files' }),
        })
      );
      await activate(tree.locator('[data-path="unavailable"]'));
      const retry = tree.locator('[data-file-browser-load="retry"]');
      await retry.waitFor({ state: 'visible' });
      await retry.scrollIntoViewIfNeeded();
      await expectReachable(retry);
      if (device === 'phone') await assertTouchTarget(retry);
      await page.unroute(unavailable);
      await activate(retry);
      await expect.poll(() => retry.count()).toBe(0);
      expect(await tree.locator('[data-path="src/deep/needle.ts"]').isVisible()).toBe(true);
    }
  );
});
