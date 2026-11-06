// Ephemeral port - Header button visibility (real-browser E2E).
//
// Companion to the CI static guard (test/mobile-header-buttons-policy.test.ts).
// Renders the real app and asserts ACTUAL computed visibility, catching CSS/layout
// regressions the static parser can't see. Two behaviours are covered:
//   1. The minimal phone header hides the settings gear + lifecycle log.
//   2. The attachments button (COD-39) is OPT-IN — default-hidden everywhere, shown
//      only when App Settings → Display → "Attachments Button" is enabled. It first
//      shipped always-visible (mobile, then desktop), which is the regression here.
import { describe, it, beforeAll, afterAll } from 'vitest';
import type { WebServer } from '../../src/web/server.js';
import { createTestServer, stopTestServer } from './helpers/server.js';
import { createDevicePage, closeAllBrowsers } from './helpers/browser.js';
import { assertHidden, assertVisible } from './helpers/assertions.js';
import { REPRESENTATIVE_DEVICES } from './devices.js';
import { WAIT } from './helpers/constants.js';

let baseUrl: string;

describe('Header button visibility (E2E)', () => {
  let server: WebServer;

  beforeAll(async () => {
    server = await createTestServer();
    baseUrl = `http://localhost:${server.boundPort}`;
  });

  afterAll(async () => {
    await closeAllBrowsers();
    await stopTestServer(server);
  });

  it('hides the settings gear + lifecycle log on a standard phone (iPhone 14 Pro)', async () => {
    const { page } = await createDevicePage(REPRESENTATIVE_DEVICES['standard-phone'], baseUrl);
    await page.waitForTimeout(WAIT.PAGE_SETTLE);
    await assertHidden(page, '.btn-icon-header.btn-settings');
    await assertHidden(page, '.btn-icon-header.btn-lifecycle-log');
  });

  it('keeps the opt-in attachments button HIDDEN by default on a desktop-class viewport', async () => {
    const { page } = await createDevicePage(REPRESENTATIVE_DEVICES['large-tablet'], baseUrl);
    await page.waitForTimeout(WAIT.PAGE_SETTLE);
    await assertHidden(page, '#attachmentsHistoryBtn');
  });

  it('shows the attachments button once the setting is enabled', async () => {
    const { page } = await createDevicePage(REPRESENTATIVE_DEVICES['large-tablet'], baseUrl);
    // Desktop-class devices use the non-mobile settings blob.
    await page.evaluate(() => {
      const cur = JSON.parse(localStorage.getItem('codeman-app-settings') || '{}');
      cur.showAttachmentsButton = true;
      localStorage.setItem('codeman-app-settings', JSON.stringify(cur));
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(WAIT.PAGE_SETTLE);
    await assertVisible(page, '#attachmentsHistoryBtn');
  });
});
