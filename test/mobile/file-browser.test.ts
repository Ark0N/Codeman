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
    await page.locator('.btn-settings-mobile').tap();
    const control = page.locator(`#${id}`);
    // The chip's native checkbox is visually hidden; the label is the touch target.
    if ((await control.isChecked()) !== checked) {
      await page.locator(`label:has(#${id})`).tap();
    }
    await page
      .locator('#appSettingsModal .set-head-save')
      .filter({ hasText: /^Save$/ })
      .tap();
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
});
