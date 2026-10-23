/**
 * Real Chromium, real header markup and styles.css: the opt-in host readings stay out of the header until they
 * are switched on and reported, under every header-stats style, and a reported one is drawn with its value.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const dir = resolve(import.meta.dirname, '../src/web/public');
const styles = readFileSync(resolve(dir, 'styles.css'), 'utf8');
const header = /<header class="header">[\s\S]*?<\/header>/.exec(readFileSync(resolve(dir, 'index.html'), 'utf8'))![0];
const ITEMS = ['statGpuItem', 'statVramItem', 'statCpuMhzItem', 'statGpuMhzItem'];

describe('opt-in host readings in the header (real Chromium)', () => {
  let browser: Browser;
  let p: Page;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  for (const style of ['compact', 'tiles', 'classic']) {
    it(`draws none of them until reported, and the reported one with its value, in the ${style} style`, async () => {
      p = await browser.newPage({ viewport: { width: 1500, height: 400 } });
      await p.setContent(
        `<!doctype html><html data-header-stats="${style}" data-tab-orientation="horizontal" data-session-list="header"><head><style>${styles}</style></head><body>${header}</body></html>`
      );
      const shown = () =>
        p.evaluate(
          (ids) => ids.filter((id) => getComputedStyle(document.getElementById(id)!).display !== 'none'),
          ITEMS
        );
      expect(await shown()).toEqual([]);
      await p.evaluate(() => {
        document.getElementById('statGpuItem')!.hidden = false;
        document.getElementById('statGpu')!.textContent = '42%';
      });
      expect(await shown()).toEqual(['statGpuItem']);
      const box = await p.locator('#statGpuItem').boundingBox();
      expect(box!.width).toBeGreaterThan(20);
      expect(await p.locator('#statGpuItem').innerText()).toContain('42%');
      await p.close();
    });
  }
});
