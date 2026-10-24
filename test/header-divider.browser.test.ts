/**
 * Real Chromium, against the real header markup from index.html and the real styles.css: dragging the divider
 * resizes the toolbar and wraps it onto a second line, the readings shed detail as it narrows, nothing pokes
 * out past the divider (even for content that arrives later), and none of it applies where the handle is hidden.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const dir = resolve(import.meta.dirname, '../src/web/public');
const styles = readFileSync(resolve(dir, 'styles.css'), 'utf8');
const controller = readFileSync(resolve(dir, 'header-divider.js'), 'utf8');
const header = /<header class="header">[\s\S]*?<\/header>/.exec(readFileSync(resolve(dir, 'index.html'), 'utf8'))![0];

const CHIP =
  '<span class="pu-row"><span data-short="CL" class="pu-provider">Claude</span><span class="pu-windows">' +
  '<span class="pu-win"><span class="pu-ring"></span><span class="pu-label">5h</span><span class="pu-val">49%</span></span>' +
  '<span class="pu-win"><span class="pu-ring"></span><span class="pu-label">7d</span><span class="pu-val">72%</span></span>' +
  '</span></span><span class="pu-row"><span data-short="CP" class="pu-provider">Copilot</span><span class="pu-windows">' +
  '<span class="pu-win"><span class="pu-ring"></span><span class="pu-label">mo</span><span class="pu-val">81%</span></span></span></span>';

const ORIGIN = 'http://app.test/';

/** The default layout attributes, with any `name="value"` in `extra` replacing the matching default. */
function rootAttrs(extra = '') {
  const attrs = new Map([
    ['data-header-stats', 'compact'],
    ['data-tab-orientation', 'horizontal'],
    ['data-session-list', 'header'],
  ]);
  for (const [, name, value] of extra.matchAll(/([\w-]+)="([^"]*)"/g)) attrs.set(name, value);
  return [...attrs].map(([name, value]) => `${name}="${value}"`).join(' ');
}
type Attrs = { root?: string; body?: string };

describe('header divider (real Chromium)', () => {
  let browser: Browser;
  let p: Page;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  /** Open the real header; `stored` is the width kept from an earlier visit, `chip` fills the plan-usage chip. */
  async function open(options: { root?: string; body?: string; stored?: number; chip?: boolean; width?: number } = {}) {
    p = await browser.newPage({ viewport: { width: options.width ?? 1400, height: 600 } });
    await p.route(ORIGIN, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html ${rootAttrs(options.root)}><head><style>${styles}</style></head><body class="${options.body ?? ''}">${header}</body></html>`,
      })
    );
    await p.goto(ORIGIN);
    if (options.stored)
      await p.evaluate((w) => localStorage.setItem('codeman-header-right-width', String(w)), options.stored);
    if (options.chip) {
      await p.evaluate((html) => {
        const chip = document.getElementById('planUsageChip')!;
        chip.classList.remove('header-plan-usage--hidden');
        chip.innerHTML = html;
      }, CHIP);
    }
    await p.addScriptTag({ content: controller });
  }
  const box = (sel: string) => p.locator(sel).evaluate((el) => el.getBoundingClientRect().toJSON());
  const settled = () => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const dragTo = async (toolbarWidth: number) => {
    const handle = await box('.header-divider');
    const head = await box('.header');
    await p.mouse.move(handle.left + 6, handle.top + 10);
    await p.mouse.down();
    await p.mouse.move(head.right - 12 - toolbarWidth, handle.top + 10, { steps: 6 });
    await p.mouse.up();
    await settled();
  };
  const readingsInside = async () => {
    const edge = (await box('#headerRight')).left + 1;
    const lefts = await p
      .locator('#headerRight > :not(.header-divider)')
      .evaluateAll((els) =>
        els.filter((el) => (el as HTMLElement).offsetParent !== null).map((el) => el.getBoundingClientRect().left)
      );
    return { edge, lefts };
  };
  const display = (sel: string) =>
    p
      .locator(sel)
      .first()
      .evaluate((el) => getComputedStyle(el).display);

  it('narrows the toolbar and wraps it when dragged right, and resets on double-click', async () => {
    await open({ chip: true });
    const before = await box('#headerRight');
    await dragTo(330);
    const after = await box('#headerRight');
    expect(after.width).toBeLessThan(before.width - 100);
    expect(after.height).toBeGreaterThan(before.height + 10);
    expect((await box('.session-tabs-host')).width).toBeGreaterThan(before.width / 2);
    expect(await p.evaluate(() => localStorage.getItem('codeman-header-right-width'))).not.toBeNull();
    await p.locator('.header-divider').dblclick();
    expect(Math.abs((await box('#headerRight')).width - before.width)).toBeLessThan(2);
    expect(await p.evaluate(() => localStorage.getItem('codeman-header-right-width'))).toBeNull();
    await p.close();
  });

  it('resizes from the keyboard and tells the tab strip to re-measure', async () => {
    await open({ chip: true });
    await p.evaluate(() => {
      (window as any).relayouts = 0;
      (window as any).app = {
        updateTabOverflowMode: () => (window as any).relayouts++,
        updateConnectionLines: () => {},
      };
    });
    const before = await box('#headerRight');
    await p.locator('.header-divider').focus();
    await p.keyboard.press('ArrowRight');
    await p.keyboard.press('ArrowRight');
    expect((await box('#headerRight')).width).toBeLessThan(before.width - 20);
    expect(await p.evaluate(() => (window as any).relayouts)).toBeGreaterThanOrEqual(2);
    await p.keyboard.press('Home');
    expect(Math.abs((await box('#headerRight')).width - before.width)).toBeLessThan(2);
    await p.close();
  });

  it('never stores a width below the minimum, and widens on the first ArrowLeft after a held ArrowRight', async () => {
    await open({ chip: true });
    const stored = () => p.evaluate(() => Number(localStorage.getItem('codeman-header-right-width')));
    // a drag into the window's last pixels used to store a negative width, which the next load dropped
    await dragTo(-6);
    expect(await stored()).toBeGreaterThanOrEqual(160);
    await p.locator('.header-divider').dblclick();
    await p.locator('.header-divider').focus();
    for (let i = 0; i < 60; i++) await p.keyboard.press('ArrowRight');
    await settled();
    expect(await stored()).toBeGreaterThanOrEqual(160);
    const floor = (await box('#headerRight')).width;
    // Escape is the global close-panels key, not a reset
    await p.keyboard.press('Escape');
    await settled();
    expect(Math.abs((await box('#headerRight')).width - floor)).toBeLessThan(2);
    await p.keyboard.press('ArrowLeft');
    await settled();
    expect((await box('#headerRight')).width).toBeGreaterThan(floor);
    await p.close();
  });

  it('stops the divider at the widest reading so nothing pokes out past it', async () => {
    await open({ chip: true });
    await dragTo(20);
    const { edge, lefts } = await readingsInside();
    for (const left of lefts) expect(left).toBeGreaterThanOrEqual(edge);
    await p.close();
  });

  it('keeps a reading inside the divider when it arrives after the width was applied', async () => {
    await open({ stored: 160 });
    await settled();
    await p.evaluate((html) => {
      const chip = document.getElementById('planUsageChip')!;
      chip.classList.remove('header-plan-usage--hidden');
      chip.innerHTML = html;
    }, CHIP);
    await settled();
    const { edge, lefts } = await readingsInside();
    for (const left of lefts) expect(left).toBeGreaterThanOrEqual(edge);
    await p.close();
  });

  it('keeps a wide reading that is switched on later inside the divider', async () => {
    await open({ stored: 160 });
    await settled();
    await p.evaluate(() => {
      const wide = document.createElement('div');
      wide.id = 'lateReading';
      wide.style.cssText = 'width:320px;flex:none;height:24px';
      document.getElementById('headerRight')!.appendChild(wide);
    });
    await settled();
    const { edge, lefts } = await readingsInside();
    for (const left of lefts) expect(left).toBeGreaterThanOrEqual(edge);
    expect((await box('#headerRight')).width).toBeGreaterThanOrEqual(320);
    await p.close();
  });

  it('sheds labels, then provider names, then percentages as the toolbar narrows', async () => {
    await open({ chip: true });
    expect(await display('.pu-label')).not.toBe('none');
    const seen: string[] = [];
    for (const width of [450, 330, 200]) {
      await dragTo(width);
      seen.push((await p.evaluate(() => document.documentElement.dataset.headerDensity)) ?? '');
    }
    expect(seen).toEqual(['tight', 'dense', 'tiny']);
    expect(await display('.pu-label')).toBe('none');
    expect(await display('.pu-val')).toBe('none');
    expect(
      await p
        .locator('.pu-provider')
        .first()
        .evaluate((el) => getComputedStyle(el, '::after').content)
    ).toBe('"CL"');
    await p.close();
  });

  for (const style of ['tiles', 'classic']) {
    it(`follows the density steps under the ${style} style, keeping values at the narrowest step`, async () => {
      await open({ chip: true, root: `data-header-stats="${style}"` });
      await dragTo(330);
      expect(
        await p
          .locator('.pu-provider')
          .first()
          .evaluate((el) => getComputedStyle(el).fontSize)
      ).toBe('0px');
      await dragTo(200);
      expect(await display('.pu-val')).not.toBe('none');
      await p.close();
    });
  }

  for (const [name, root, body] of [
    ['the sidebar layout', 'data-session-list="sidebar"', ''],
    ['the vertical rail', 'data-tab-orientation="vertical"', ''],
    ['a solo window', '', 'solo-mode'],
  ] as const) {
    it(`leaves a stored narrow width alone in ${name}, where the handle is hidden`, async () => {
      await open({ chip: true, stored: 180, root, body });
      // the stored width is read at init, which already ran inside open() before storage was set
      await p.evaluate(() => localStorage.setItem('codeman-header-right-width', '180'));
      await p.reload();
      await p.addScriptTag({ content: controller });
      await settled();
      expect(await p.locator('.header-divider').isVisible()).toBe(false);
      expect(await display('.stat-label')).not.toBe('none');
      expect(await p.locator('.header-right').evaluate((el) => getComputedStyle(el).flexBasis)).not.toBe('180px');
      await p.close();
    });
  }

  it('does not pin the toolbar to a stored width on a narrow viewport', async () => {
    await open({ chip: true, width: 700 });
    await p.evaluate(() => localStorage.setItem('codeman-header-right-width', '300'));
    await p.reload();
    await p.addScriptTag({ content: controller });
    await settled();
    expect(await p.locator('.header-right').evaluate((el) => getComputedStyle(el).flexBasis)).not.toBe('300px');
    await p.close();
  });

  it('gets the chosen width back when the window shrinks and grows again', async () => {
    await open({ chip: true });
    await dragTo(700);
    const chosen = (await box('#headerRight')).width;
    await p.setViewportSize({ width: 1000, height: 600 });
    await settled();
    expect((await box('#headerRight')).width).toBeLessThan(chosen);
    await p.setViewportSize({ width: 1400, height: 600 });
    await settled();
    expect(Math.abs((await box('#headerRight')).width - chosen)).toBeLessThan(2);
    await p.close();
  });

  it('clears the dragging state when the pointer capture is lost', async () => {
    await open({ chip: true });
    const handle = await box('.header-divider');
    await p.mouse.move(handle.left + 6, handle.top + 10);
    await p.mouse.down();
    expect(await p.evaluate(() => document.body.classList.contains('header-divider-dragging'))).toBe(true);
    await p.locator('.header-divider').evaluate((el) => el.dispatchEvent(new PointerEvent('lostpointercapture')));
    expect(await p.evaluate(() => document.body.classList.contains('header-divider-dragging'))).toBe(false);
    await p.mouse.up();
    await p.close();
  });
});
