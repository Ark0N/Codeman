/** Real API and Chromium Settings verification; bridge stays disabled, no real Discord traffic. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const exec = promisify(execFile);
const screenshots = '/tmp/codeman-discord-case-thread-screenshots';

describe('Discord interface mode Settings', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;
  let base: string;
  const errors: string[] = [];

  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    base = `http://127.0.0.1:${server.boundPort}`;
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    page.on('pageerror', (e) => errors.push(e.message));
    await mkdir(screenshots, { recursive: true });
  }, 90000);

  afterAll(async () => {
    await browser?.close();
    await server?.stop();
  }, 60000);

  async function openSettings() {
    await page.goto(base, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).app?.terminal, null, { timeout: 30000 });
    await page.evaluate(() => (window as any).app.openAppSettings());
    await page.waitForFunction(() => document.getElementById('discordGroup')?.style.display !== 'none');
    await page.waitForTimeout(3500);
    await page.locator('#discordMode').scrollIntoViewIfNeeded();
  }

  it('round-trips mode through curl without enabling or exposing a token', async () => {
    const get = JSON.parse((await exec('curl', ['-fsS', `${base}/api/discord`])).stdout);
    expect(get.data).toMatchObject({ enabled: false, mode: 'notifications', sessionSync: { state: 'idle' } });
    const deliveries = JSON.parse((await exec('curl', ['-fsS', `${base}/api/discord/deliveries`])).stdout);
    expect(deliveries).toEqual({ success: true, data: [] });
    const put = JSON.parse(
      (
        await exec('curl', [
          '-fsS',
          '-X',
          'PUT',
          '-H',
          'Content-Type: application/json',
          '--data',
          '{"mode":"full"}',
          `${base}/api/discord`,
        ])
      ).stdout
    );
    expect(put.data).toMatchObject({ enabled: false, mode: 'full' });
    expect(put.data).not.toHaveProperty('token');
    await exec('curl', [
      '-fsS',
      '-X',
      'PUT',
      '-H',
      'Content-Type: application/json',
      '--data',
      '{"mode":"notifications"}',
      `${base}/api/discord`,
    ]);
  });

  it('shows the desktop mode switch, preview limits and preserves the legacy creation preference', async () => {
    await openSettings();
    expect(await page.inputValue('#discordMode')).toBe('notifications');
    expect(await page.isVisible('#discordSyncRow')).toBe(false);
    await page.selectOption('#discordThreadCreation', 'lazy');
    await page.selectOption('#discordMode', 'full');
    expect(await page.isVisible('#discordCategoryRow')).toBe(true);
    expect(await page.textContent('#discordModeHint')).toContain('One channel per case, one thread per session');
    expect(await page.isVisible('#discordChannelDeleteRow')).toBe(false);
    expect(await page.isVisible('#discordStaleThreadsRow')).toBe(false);
    expect(await page.isVisible('#discordOnSessionDelete')).toBe(true);
    await page.selectOption('#discordOnSessionDelete', 'archive');
    await page.fill('#discordCategoryId', '666666666666666666');
    expect(await page.isDisabled('#discordThreadCreation')).toBe(true);
    expect(await page.isVisible('#discordSyncRow')).toBe(true);
    expect(await page.textContent('#discordModeHint')).toContain(
      'Some CLI dialogs and ambiguous recoveries still require the terminal'
    );
    await page.click('#discordSaveBtn');
    await page.waitForFunction(async () => (await (await fetch('/api/discord')).json()).data.mode === 'full');
    await page.locator('#discordMode').scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${screenshots}/desktop.png` });
    const data = await page.evaluate(async () => (await (await fetch('/api/discord')).json()).data);
    expect(data).toMatchObject({
      enabled: false,
      mode: 'full',
      threadCreation: 'lazy',
      categoryId: '666666666666666666',
      onChannelDelete: 'keep',
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).app?.terminal);
    await page.evaluate(() => (window as any).app.openAppSettings());
    await page.waitForFunction(() => (document.getElementById('discordMode') as HTMLSelectElement)?.value === 'full');
    await page.locator('#discordMode').scrollIntoViewIfNeeded();
    await page.selectOption('#discordMode', 'notifications');
    expect(await page.isDisabled('#discordThreadCreation')).toBe(false);
    expect(await page.isVisible('#discordStaleThreadsRow')).toBe(true);
    expect(await page.inputValue('#discordThreadCreation')).toBe('lazy');
    expect(await page.isVisible('#discordSyncRow')).toBe(false);
    await page.click('#discordSaveBtn');
  });

  it('supports touch/mobile mode selection and displays disabled-sync feedback', async () => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 2,
    });
    const mobile = await context.newPage();
    mobile.on('pageerror', (e) => errors.push(e.message));
    await mobile.goto(base, { waitUntil: 'domcontentloaded' });
    await mobile.waitForFunction(() => (window as any).app?.terminal);
    await mobile.evaluate(() => (window as any).app.openAppSettings());
    await mobile.waitForFunction(() => document.getElementById('discordGroup')?.style.display !== 'none');
    await mobile.waitForTimeout(3500);
    await mobile.locator('#discordMode').scrollIntoViewIfNeeded();
    await mobile.selectOption('#discordMode', 'full');
    expect(await mobile.isVisible('#discordModeHint')).toBe(true);
    expect(await mobile.isDisabled('#discordThreadCreation')).toBe(true);
    const box = await mobile.locator('#discordMode').boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(391);
    await mobile.screenshot({ path: `${screenshots}/mobile.png` });
    await mobile.locator('#discordSyncBtn').tap();
    await mobile.waitForFunction(() =>
      /Enable Full interface/.test(document.getElementById('discordResult')?.textContent ?? '')
    );
    expect(await mobile.isDisabled('#discordSyncBtn')).toBe(false);
    await context.close();
  });

  it('persists Discord through the main Save and Apply, and leaves untouched groups alone', async () => {
    await openSettings();
    await page.selectOption('#discordMode', 'notifications');
    const saving = page.waitForResponse((r) => r.url().endsWith('/api/discord') && r.request().method() === 'PUT');
    await page.locator('.set-foot [onclick="app.saveAppSettings()"]').click();
    expect((await saving).status()).toBe(200);
    await page.waitForFunction(() => !document.getElementById('appSettingsModal')?.classList.contains('active'));
    expect((await (await fetch(base + '/api/discord')).json()).data.mode).toBe('notifications');
    await openSettings();
    await page.selectOption('#discordMode', 'full');
    const applying = page.waitForResponse((r) => r.url().endsWith('/api/discord') && r.request().method() === 'PUT');
    await page.locator('.set-foot [onclick="app.applyAppSettings()"]').click();
    expect((await applying).status()).toBe(200);
    await page.waitForFunction(() => (window as any).app._applyInFlight === false);
    expect(await page.isVisible('#appSettingsModal')).toBe(true);
    expect((await (await fetch(base + '/api/discord')).json()).data.mode).toBe('full');
    let extraWrites = 0;
    const listener = (r: import('playwright').Request) => {
      if (r.url().endsWith('/api/discord') && r.method() === 'PUT') extraWrites++;
    };
    page.on('request', listener);
    await page.locator('.set-foot [onclick="app.saveAppSettings()"]').click();
    await page.waitForFunction(() => !document.getElementById('appSettingsModal')?.classList.contains('active'));
    page.off('request', listener);
    expect(extraWrites).toBe(0);
  });

  it('keeps failed Full-mode saves open, shows a permissions error and never puts tokens in general settings', async () => {
    await openSettings();
    await page.route('**/api/discord', async (route) => {
      if (route.request().method() === 'PUT')
        return route.fulfill({
          status: 403,
          json: {
            success: false,
            error:
              'Discord bot needs Manage Channels and Manage Threads. Update its server role permissions, then save again.',
          },
        });
      return route.continue();
    });
    await page.selectOption('#discordMode', 'full');
    await page.locator('label:has(#discordEnabled)').click();
    await page.fill('#discordToken', 'fake-private-test-token');
    await page.fill('#discordGuildId', '111111111111111111');
    await page.fill('#discordParentChannelId', '222222222222222222');
    await page.fill('#discordAllowedUserIds', '333333333333333333');
    await page.fill('#discordCategoryId', '');
    const writing = page.waitForResponse((r) => r.url().endsWith('/api/discord') && r.request().method() === 'PUT');
    await page.locator('.set-foot [onclick="app.saveAppSettings()"]').click();
    expect((await writing).status()).toBe(403);
    await page.waitForFunction(() =>
      document.getElementById('discordResult')?.textContent?.includes('Manage Channels and Manage Threads')
    );
    expect(await page.isVisible('#appSettingsModal')).toBe(true);
    expect(await page.isVisible('#discordResult')).toBe(true);
    expect(await page.inputValue('#discordToken')).toBe('fake-private-test-token');
    const persisted = (await (await fetch(base + '/api/discord')).json()).data;
    expect(persisted.enabled).toBe(false);
    expect(persisted.hasToken).toBe(false);
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('fake-private-test-token');
    expect(JSON.stringify(await (await fetch(base + '/api/settings')).json())).not.toContain('fake-private-test-token');
    await page.screenshot({ path: `${screenshots}/save-error-desktop.png` });
    await page.unroute('**/api/discord');
    await page.evaluate(() => (window as any).app.closeAppSettings());
  });

  it('saves Discord using the mobile header Save button', async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const mobile = await context.newPage();
    mobile.on('pageerror', (e) => errors.push(e.message));
    await mobile.goto(base, { waitUntil: 'domcontentloaded' });
    await mobile.waitForFunction(() => (window as any).app?.terminal);
    await mobile.evaluate(() => (window as any).app.openAppSettings());
    await mobile.waitForTimeout(3500);
    await mobile.locator('#discordMode').scrollIntoViewIfNeeded();
    await mobile.selectOption('#discordMode', 'notifications');
    const response = mobile.waitForResponse((r) => r.url().endsWith('/api/discord') && r.request().method() === 'PUT');
    await mobile.locator('#appSettingsModal .set-head-save:not(.set-head-apply)').tap();
    expect((await response).status()).toBe(200);
    await mobile.waitForFunction(() => !document.getElementById('appSettingsModal')?.classList.contains('active'));
    expect((await (await fetch(base + '/api/discord')).json()).data.mode).toBe('notifications');
    await context.close();
  });

  it('saves an empty category and fills the category ID returned by automatic setup', async () => {
    const current = (await (await fetch(base + '/api/discord')).json()).data;
    let overlay = {
      ...current,
      enabled: true,
      mode: 'notifications',
      categoryId: '',
      hasToken: true,
      guildId: '111111111111111111',
      parentChannelId: '222222222222222222',
      allowedUserIds: ['333333333333333333'],
    };
    let writes = 0;
    await page.route('**/api/discord', async (route) => {
      if (route.request().method() === 'PUT') {
        const body = route.request().postDataJSON();
        expect(body.mode).toBe('full');
        expect(body.categoryId).toBe('');
        expect(body).not.toHaveProperty('token');
        overlay = { ...overlay, ...body, categoryId: '666666666666666666' };
        writes++;
      }
      return route.fulfill({ json: { success: true, data: overlay } });
    });
    await openSettings();
    await page.selectOption('#discordMode', 'full');
    expect(await page.inputValue('#discordCategoryId')).toBe('');
    expect(await page.getAttribute('#discordCategoryId', 'placeholder')).toContain('automatically');
    await page.locator('.set-foot [onclick="app.saveAppSettings()"]').click();
    await page.waitForFunction(() => !document.getElementById('appSettingsModal')?.classList.contains('active'));
    expect(writes).toBe(1);
    await openSettings();
    expect(await page.inputValue('#discordCategoryId')).toBe('666666666666666666');
    await page.screenshot({ path: `${screenshots}/automatic-category.png` });
    await page.unroute('**/api/discord');
    await page.evaluate(() => (window as any).app.closeAppSettings());
  });

  it('has no browser runtime errors', () => {
    expect(errors).toEqual([]);
  });
});
