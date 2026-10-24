/**
 * Real Chromium, real header markup and styles.css: the opt-in host readings stay out of the header until they
 * are switched on and reported, under every header-stats style, and a reported one is drawn with its value.
 * As the header divider narrows the toolbar (data-header-density), they keep the label that says which reading
 * is which, and the Compact style's rings-only step hides a reading with no ring instead of leaving it empty.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const dir = resolve(import.meta.dirname, '../src/web/public');
const styles = readFileSync(resolve(dir, 'styles.css'), 'utf8');
const header = /<header class="header">[\s\S]*?<\/header>/.exec(readFileSync(resolve(dir, 'index.html'), 'utf8'))![0];
const ITEMS = ['statGpuItem', 'statVramItem', 'statCpuMhzItem', 'statGpuMhzItem'];
/** Each host reading: its value element, a value that looks like CPU's or MEM's, and the label naming it. */
const READINGS: Record<string, { value: string; text: string; label: string }> = {
  statGpuItem: { value: 'statGpu', text: '40%', label: 'GPU' },
  statVramItem: { value: 'statVram', text: '3.2G', label: 'VRAM' },
  statGpuMhzItem: { value: 'statGpuMhz', text: '1800 MHz', label: 'GPU' },
  statCpuMhzItem: { value: 'statCpuMhz', text: '4200 MHz', label: 'CPU' },
};
const RINGLESS = ['statGpuMhzItem', 'statCpuMhzItem'];

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

    it(`keeps every host reading's label as the toolbar narrows, in the ${style} style`, async () => {
      p = await browser.newPage({ viewport: { width: 1600, height: 400 } });
      await p.setContent(
        `<!doctype html><html data-header-stats="${style}" data-tab-orientation="horizontal" data-session-list="header"><head><style>${styles}</style></head><body>${header}</body></html>`
      );
      await p.evaluate((readings) => {
        document.getElementById('statCpu')!.textContent = '12%';
        document.getElementById('statMem')!.textContent = '7.9G';
        for (const [id, r] of Object.entries(readings)) {
          document.getElementById(id)!.hidden = false;
          document.getElementById(r.value)!.textContent = r.text;
        }
      }, READINGS);
      const read = () =>
        p.evaluate((ids) => {
          const shown = (el: Element) => getComputedStyle(el).display !== 'none';
          return Object.fromEntries(
            ids.map((id) => {
              const item = document.getElementById(id)!;
              const label = item.querySelector('.stat-label')!;
              return [
                id,
                {
                  shown: shown(item),
                  width: item.getBoundingClientRect().width,
                  label: shown(label) && label.getBoundingClientRect().width > 0 ? label.textContent : null,
                },
              ];
            })
          );
        }, ITEMS);
      const cpuLabel = () =>
        p.evaluate(() => getComputedStyle(document.querySelector('.header-system-stats .stat-label')!).display);
      for (const density of ['tight', 'dense', 'tiny']) {
        await p.evaluate((d) => (document.documentElement.dataset.headerDensity = d), density);
        const items = await read();
        // the density step still sheds CPU's and MEM's labels
        expect(await cpuLabel(), density).toBe('none');
        for (const id of ITEMS) {
          if (style === 'compact' && density === 'tiny' && RINGLESS.includes(id)) {
            // rings only: a clock has no ring, so it goes rather than stay an empty item taking a gap
            expect(items[id].shown, `${density} ${id}`).toBe(false);
            continue;
          }
          expect(items[id].shown, `${density} ${id}`).toBe(true);
          expect(items[id].width, `${density} ${id}`).toBeGreaterThan(0);
          expect(items[id].label, `${density} ${id}`).toBe(READINGS[id].label);
        }
      }
      // VRAM whose total is unknown has no ring either (panels-ui.js marks it ringless)
      await p.evaluate(() => {
        document.getElementById('statVramItem')!.classList.add('stat-item--ringless');
        document.getElementById('statVramRing')!.style.display = 'none';
      });
      expect((await read()).statVramItem.shown).toBe(style !== 'compact');
      await p.close();
    });
  }
});
