/** Real Chromium: dragging the header divider resizes the toolbar and wraps it onto a second line. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const dir = resolve(import.meta.dirname, '../src/web/public');
const styles = readFileSync(resolve(dir, 'styles.css'), 'utf8');
const controller = readFileSync(resolve(dir, 'header-divider.js'), 'utf8');

const page = (root = 'data-tab-orientation="horizontal" data-session-list="header"') => `<!doctype html>
<html ${root}><head><style>${styles}</style></head><body>
  <div class="app"><header class="header">
    <div class="header-brand"><span class="logo">Codeman</span></div>
    <div class="session-tabs-host"><div class="session-tabs" id="sessionTabs"></div></div>
    <div class="header-right" id="headerRight">
      <div class="header-plan-usage" style="width:230px;flex:none">usage</div>
      <div class="header-system-stats" style="width:200px;flex:none">stats</div>
      <button class="btn-icon-header">a</button><button class="btn-icon-header">b</button>
    </div>
  </header></div>
</body></html>`;

describe('header divider (real Chromium)', () => {
  let browser: Browser;
  let p: Page;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  async function open(html: string) {
    p = await browser.newPage({ viewport: { width: 1400, height: 600 } });
    await p.setContent(html);
    await p.addScriptTag({ content: controller });
  }
  const box = (sel: string) => p.locator(sel).evaluate((el) => el.getBoundingClientRect().toJSON());

  it('narrows the toolbar and wraps it onto a second line when dragged right, and resets on double-click', async () => {
    await open(page());
    const before = await box('#headerRight');
    const handle = await box('.header-divider');
    const y = handle.top + handle.height / 2;
    await p.mouse.move(handle.left + 6, y);
    await p.mouse.down();
    await p.mouse.move(handle.left + 6 + 330, y, { steps: 6 });
    await p.mouse.up();
    const after = await box('#headerRight');
    expect(after.width).toBeLessThan(before.width - 250);
    expect(after.height).toBeGreaterThan(before.height + 10);
    // setContent gives an opaque origin: storage is blocked, and the drag must still work.
    expect(await p.evaluate(() => document.documentElement.style.getPropertyValue('--header-right-width'))).not.toBe(
      ''
    );
    const tabs = await box('.session-tabs-host');
    expect(tabs.width).toBeGreaterThan(before.width);

    await p.locator('.header-divider').dblclick();
    const reset = await box('#headerRight');
    expect(Math.abs(reset.width - before.width)).toBeLessThan(2);
    expect(await p.evaluate(() => document.documentElement.style.getPropertyValue('--header-right-width'))).toBe('');
    await p.close();
  });

  it('drops usage labels, then provider names, then percentages as the toolbar narrows', async () => {
    const chip =
      '<div class="header-plan-usage" id="planUsageChip"><span class="pu-row"><span data-short="CL" class="pu-provider">Claude</span>' +
      '<span class="pu-windows"><span class="pu-win"><span class="pu-ring"></span><span class="pu-label">5h</span><span class="pu-val">49%</span></span></span></span></div>';
    await open(page('data-header-stats="compact" data-tab-orientation="horizontal" data-session-list="header"'));
    await p.evaluate((html) => document.getElementById('headerRight')!.insertAdjacentHTML('beforeend', html), chip);
    const visible = (sel: string) => p.locator(sel).isVisible();
    expect(await visible('.pu-label')).toBe(true);
    const sizes: Array<[number, string]> = [
      [450, 'tight'],
      [330, 'dense'],
      [200, 'tiny'],
    ];
    for (const [width, density] of sizes) {
      const handle = await box('.header-divider');
      const header = await box('.header');
      await p.mouse.move(handle.left + 6, handle.top + handle.height / 2);
      await p.mouse.down();
      await p.mouse.move(header.right - width - 12, handle.top + handle.height / 2, { steps: 5 });
      await p.mouse.up();
      expect(await p.evaluate(() => document.documentElement.dataset.headerDensity)).toBe(density);
    }
    expect(await visible('.pu-label')).toBe(false);
    expect(await visible('.pu-val')).toBe(false);
    expect(await p.locator('.pu-provider').evaluate((el) => getComputedStyle(el, '::after').content)).toBe('"CL"');
    await p.close();
  });

  it('stops the divider at the widest reading so nothing pokes out past it', async () => {
    await open(page());
    const handle = await box('.header-divider');
    const header = await box('.header');
    await p.mouse.move(handle.left + 6, handle.top + handle.height / 2);
    await p.mouse.down();
    await p.mouse.move(header.right - 20, handle.top + handle.height / 2, { steps: 8 });
    await p.mouse.up();
    const right = await box('#headerRight');
    const edge = right.left + 1;
    const lefts = await p
      .locator('#headerRight > :not(.header-divider)')
      .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().left));
    for (const left of lefts) expect(left).toBeGreaterThanOrEqual(edge);
    await p.close();
  });

  it('resizes from the keyboard', async () => {
    await open(page());
    const before = await box('#headerRight');
    await p.locator('.header-divider').focus();
    await p.keyboard.press('ArrowRight');
    await p.keyboard.press('ArrowRight');
    const after = await box('#headerRight');
    expect(after.width).toBeLessThan(before.width - 20);
    await p.keyboard.press('Home');
    expect(Math.abs((await box('#headerRight')).width - before.width)).toBeLessThan(2);
    await p.close();
  });

  it('is hidden when the tabs live in the sidebar', async () => {
    await open(page('data-tab-orientation="horizontal" data-session-list="sidebar"'));
    expect(await p.locator('.header-divider').isVisible()).toBe(false);
    await p.close();
  });
});
