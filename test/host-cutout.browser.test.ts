/**
 * @fileoverview Real-Chromium coverage for the header beside a camera housing (host-cutout.js and the
 * `html.host-cutout-toolbar` rules in styles.css).
 *
 * Codeman Desktop can draw the page behind the notch of a MacBook display, and whatever the header puts there
 * cannot be seen or clicked. What only a real layout engine answers: that no tab, button or reading ends up
 * behind the housing, in a single row, in a wrapped (L-shaped) strip and with a toolbar too wide for the room
 * beside it; that the tabs carry on right of the housing where there is room; that a tab changing size with
 * no render behind it is followed; and that taking the housing away puts the header back exactly. The real
 * `<header>` from index.html, the shipping styles.css, constants.js, app.js and host-cutout.js are loaded
 * into a page.
 *
 * Port: none (page.route on a fake origin, no server).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const dir = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(dir, name), 'utf8');
const styles = read('styles.css');
const header = /<header class="header">[\s\S]*?<\/header>/.exec(read('index.html'))![0];
const ORIGIN = 'http://app.test/';

type Rect = { left: number; right: number; top: number; bottom: number };
type Cutout = { left: number; width: number; height: number };

/** MacBook displays in whole-screen mode: viewport and housing, in points. */
const DISPLAYS: Array<{ name: string; width: number; height: number; cutout: Cutout }> = [
  // Measured on a MacBook Pro (Mac17,13, macOS 27.2): a narrow housing in a taller strip.
  { name: 'narrow housing, default', width: 1512, height: 993, cutout: { left: 726.5, width: 59, height: 40 } },
  { name: '14-inch, default', width: 1512, height: 982, cutout: { left: 663.5, width: 185, height: 32 } },
  { name: '16-inch, default', width: 1728, height: 1117, cutout: { left: 771.5, width: 185, height: 32 } },
  { name: '14-inch, more space', width: 1800, height: 1169, cutout: { left: 790, width: 220, height: 38 } },
  { name: '14-inch, larger text', width: 1147, height: 745, cutout: { left: 503.5, width: 140, height: 24 } },
];
const NARROW = DISPLAYS[0];
const MBP14 = DISPLAYS[1];

describe('header beside a camera housing (real Chromium)', () => {
  let browser: Browser;
  let p: Page;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  /** Open the real header at a display's size with `tabs` classic tabs. */
  async function open(options: { tabs: number; width: number; height: number; attrs?: string }) {
    p = await browser.newPage({
      viewport: { width: options.width, height: options.height },
      deviceScaleFactor: 1,
    });
    await p.route(ORIGIN, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body:
          '<!doctype html><html data-header-stats="compact" data-tab-orientation="horizontal" ' +
          `data-session-list="header" data-tab-arrangement="classic" ${options.attrs ?? ''}>` +
          `<head><style>${styles}</style></head><body>${header}</body></html>`,
      })
    );
    await p.goto(ORIGIN);
    await p.addScriptTag({
      content:
        'var MobileDetection = { isTouchDevice: () => false, getDeviceType: () => "desktop" }, KeyboardHandler = {}, ' +
        'SwipeHandler = {}, VoiceInput = {}, DeepgramProvider = {}, NotificationManager = function(){};\n' +
        read('constants.js') +
        '\n' +
        read('app.js') +
        '\nwindow.CodemanApp = CodemanApp;',
    });
    await p.evaluate(
      ({ tabs }) => {
        const w = window as any;
        const app = Object.create(w.CodemanApp.prototype);
        app.$ = (id: string) => document.getElementById(id);
        app.sessions = new Map();
        app.loadAppSettingsFromStorage = () => ({});
        app.getDefaultSettings = () => ({});
        app.isSessionSidebarActive = () => false;
        app.updateConnectionLines = () => undefined;
        const strip = document.getElementById('sessionTabs')!;
        for (let i = 1; i <= tabs; i++) {
          const id = `s${i}`;
          app.sessions.set(id, { id, name: `session-${i}` });
          strip.insertAdjacentHTML(
            'beforeend',
            `<div class="session-tab" data-id="${id}" role="tab"><span class="tab-name">session-${i}</span></div>`
          );
        }
        // The module asks `window.app` to measure the toolbar again, as the page does.
        w.app = app;
      },
      { tabs: options.tabs }
    );
    await p.addScriptTag({ content: read('host-cutout.js') });
    await relayout();
  }

  const settled = () => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const relayout = async () => {
    await p.evaluate(() => (window as any).app.updateTabOverflowMode());
    await settled();
  };
  const apply = async (cutout: Cutout | null) => {
    expect(await p.evaluate((c) => (window as any).CodemanHostCutout.apply(c), cutout)).toBe(true);
    await settled();
  };
  const toolbar = () =>
    p.evaluate(() => document.getElementById('headerRight')!.getBoundingClientRect().toJSON()) as Promise<Rect>;
  const cornered = () => p.evaluate(() => document.getElementById('sessionTabs')!.classList.contains('tabs-corner'));
  /** Whether the toolbar has the box that covers the housing. */
  const boxed = () => p.evaluate(() => document.documentElement.classList.contains('host-cutout-toolbar'));
  /** Tabs that carry a margin of the module's. */
  const moved = () =>
    p.evaluate(() => document.querySelectorAll('#sessionTabs > .session-tab[style*="margin"]').length);
  const tabRects = async () => (await painted()).filter((r) => r.what.startsWith('tab '));

  /** Everything the header row paints: tabs, the brand, the toolbar's controls. */
  const painted = () =>
    p.evaluate(() => {
      const strip = document.getElementById('sessionTabs')!.getBoundingClientRect();
      const shown = (el: Element) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      };
      const out: Array<{ what: string; left: number; right: number; top: number; bottom: number }> = [];
      for (const el of document.querySelectorAll('#sessionTabs > .session-tab')) {
        const r = el.getBoundingClientRect();
        // The strip clips what it scrolls or overflows.
        const box = {
          left: Math.max(r.left, strip.left),
          right: Math.min(r.right, strip.right),
          top: Math.max(r.top, strip.top),
          bottom: Math.min(r.bottom, strip.bottom),
        };
        if (box.right > box.left && box.bottom > box.top)
          out.push({ what: 'tab ' + el.getAttribute('data-id'), ...box });
      }
      for (const el of document.querySelectorAll('#headerRight > *, .header-brand .logo')) {
        if (!shown(el) || el.classList.contains('header-divider')) continue;
        const r = el.getBoundingClientRect();
        out.push({
          what: el.id || el.className.toString().slice(0, 40),
          left: r.left,
          right: r.right,
          top: r.top,
          bottom: r.bottom,
        });
      }
      return out;
    });

  /** What is painted behind the housing, or closer to it than `margin` px. */
  const behind = async (cutout: Cutout, margin = 4) =>
    (await painted()).filter(
      (r) => r.top < cutout.height && r.right > cutout.left - margin && r.left < cutout.left + cutout.width + margin
    );

  for (const display of DISPLAYS) {
    const right = display.cutout.left + display.cutout.width;

    it(`leaves a short row of tabs and the toolbar as they are (${display.name})`, async () => {
      await open({ tabs: 3, width: display.width, height: display.height });
      const before = { toolbar: await toolbar(), painted: await painted() };
      await apply(display.cutout);
      // Three tabs end long before the housing and the toolbar begins long after it: nothing has to move.
      expect(await behind(display.cutout)).toEqual([]);
      expect(await boxed()).toBe(false);
      expect(await moved()).toBe(0);
      expect(await toolbar()).toEqual(before.toolbar);
      expect(await painted()).toEqual(before.painted);
      await p.close();
    });

    it(`carries the first row of a wrapped strip on past the housing (${display.name})`, async () => {
      await open({ tabs: 34, width: display.width, height: display.height });
      const natural = await toolbar();
      await apply(display.cutout);
      expect(await cornered()).toBe(true);
      expect(await behind(display.cutout)).toEqual([]);
      // The toolbar keeps its own box, and the tabs fill the row up to it on both sides of the housing.
      expect(await boxed()).toBe(false);
      expect(await toolbar()).toEqual(natural);
      const tabs = await tabRects();
      const first = tabs.filter((t) => t.top < display.cutout.height);
      expect(first.some((t) => t.right <= display.cutout.left)).toBe(true);
      expect(first.some((t) => t.left >= right)).toBe(true);
      // The first tab right of the housing starts where its 8 px of air end, not somewhere further on.
      const next = Math.min(...first.filter((t) => t.left >= right).map((t) => t.left));
      expect(next).toBeGreaterThanOrEqual(right + 8);
      expect(next).toBeLessThan(right + 10);
      // Rows below the housing are not touched: some tab there lies in the housing's column.
      const below = tabs.filter((t) => t.top >= display.cutout.height);
      expect(below.some((t) => t.left < right && t.right > display.cutout.left)).toBe(true);
      // One tab per row beside the housing gave up its margin for the gap, and no tab was added to the strip.
      const rows = new Set(first.map((t) => Math.round(t.top))).size;
      expect(await moved()).toBe(rows);
      expect(await p.evaluate(() => document.getElementById('sessionTabs')!.children.length)).toBe(34);
      await p.close();
    });
  }

  it('keeps a strip that is too tall for the corner clear of the housing too', async () => {
    // Past its max-height the strip scrolls and keeps the plain wrap (_syncTabStripCorner).
    const display = DISPLAYS[4];
    await open({ tabs: 140, width: display.width, height: display.height });
    await apply(display.cutout);
    expect(await cornered()).toBe(false);
    expect(await behind(display.cutout)).toEqual([]);
    // Scrolled, the rows that come up beside the housing are cleared as well.
    await p.evaluate(() => (document.getElementById('sessionTabs')!.scrollTop = 40));
    await settled();
    expect(await behind(display.cutout)).toEqual([]);
    await p.close();
  });

  it('follows a tab that grows with no render behind it (a selection shows its gear and close)', async () => {
    await open({ tabs: 34, width: NARROW.width, height: NARROW.height });
    await apply(NARROW.cutout);
    // The last tab left of the housing gets wider, as a selected one does, and nothing calls the strip.
    await p.evaluate((left) => {
      const tabs = [...document.querySelectorAll<HTMLElement>('#sessionTabs > .session-tab')];
      const row = tabs.filter((t) => t.getBoundingClientRect().top < 40 && t.getBoundingClientRect().right <= left);
      row[row.length - 1].style.paddingRight = '90px';
    }, NARROW.cutout.left);
    await settled();
    await settled();
    expect(await behind(NARROW.cutout)).toEqual([]);
    await p.close();
  });

  it('follows a tab that is added with no render behind it', async () => {
    await open({ tabs: 34, width: NARROW.width, height: NARROW.height });
    await apply(NARROW.cutout);
    await p.evaluate(() => {
      document
        .getElementById('sessionTabs')!
        .insertAdjacentHTML(
          'afterbegin',
          '<div class="session-tab" data-id="new" role="tab"><span class="tab-name">a-new-session</span></div>'
        );
    });
    await settled();
    await settled();
    expect(await behind(NARROW.cutout)).toEqual([]);
    await p.close();
  });

  it('gives a toolbar that would reach the housing the box that covers it, wrapped below the housing', async () => {
    await open({ tabs: 3, width: MBP14.width, height: MBP14.height });
    // A toolbar full of readings: wider than the 660 px right of the housing.
    await p.evaluate(() => {
      const right = document.getElementById('headerRight')!;
      for (let i = 0; i < 9; i++) {
        const reading = document.createElement('div');
        reading.className = 'test-reading';
        reading.style.cssText = 'flex:0 0 auto;width:110px;height:24px;background:#345';
        right.appendChild(reading);
      }
    });
    await relayout();
    const before = await toolbar();
    await apply(MBP14.cutout);
    expect(await boxed()).toBe(true);
    const after = await toolbar();
    // Its box starts just left of the housing and still ends where the header's padding begins.
    expect(after.left).toBeLessThanOrEqual(MBP14.cutout.left);
    expect(after.left).toBeGreaterThan(MBP14.cutout.left - 16);
    expect(Math.round(MBP14.width - after.right)).toBe(12);
    expect(after.bottom - after.top).toBeGreaterThan(before.bottom - before.top + 16);
    expect(await behind(MBP14.cutout)).toEqual([]);
    // Nothing is cut off either: every control is inside the viewport.
    for (const r of await painted()) expect(r.left, r.what).toBeGreaterThanOrEqual(0);
    // Readings that go away give the toolbar its own box back.
    await p.evaluate(() => document.querySelectorAll('.test-reading').forEach((el) => el.remove()));
    await settled();
    await settled();
    expect(await boxed()).toBe(false);
    expect(await behind(MBP14.cutout)).toEqual([]);
    await p.close();
  });

  it('puts the header back exactly when the housing is gone', async () => {
    await open({ tabs: 40, width: MBP14.width, height: MBP14.height });
    const before = { toolbar: await toolbar(), painted: await painted() };
    await apply(MBP14.cutout);
    expect(await painted()).not.toEqual(before.painted);
    await apply(null);
    expect(await toolbar()).toEqual(before.toolbar);
    expect(await painted()).toEqual(before.painted);
    expect(await moved()).toBe(0);
    expect(await p.evaluate(() => document.documentElement.getAttribute('style') || '')).not.toContain('host-cutout');
    expect(await p.evaluate(() => document.documentElement.className)).not.toContain('host-cutout');
    await p.close();
  });

  it('keeps a toolbar width the user chose while it ends right of the housing', async () => {
    await open({
      tabs: 3,
      width: MBP14.width,
      height: MBP14.height,
      attrs: 'data-header-right-width="set" style="--header-right-width: 300px"',
    });
    const chosen = await toolbar();
    expect(Math.round(chosen.right - chosen.left)).toBe(300);
    await apply(MBP14.cutout);
    expect(await boxed()).toBe(false);
    expect(await toolbar()).toEqual(chosen);
    expect(await behind(MBP14.cutout)).toEqual([]);
    await p.close();
  });

  it('sets a chosen toolbar width aside while it would reach the housing', async () => {
    await open({
      tabs: 3,
      width: MBP14.width,
      height: MBP14.height,
      attrs: 'data-header-right-width="set" style="--header-right-width: 800px"',
    });
    const chosen = await toolbar();
    expect(Math.round(chosen.right - chosen.left)).toBe(800);
    await apply(MBP14.cutout);
    // 800 px begins the toolbar's box at 700, under the housing: it takes the box that covers the housing.
    expect(await boxed()).toBe(true);
    expect((await toolbar()).left).toBeLessThanOrEqual(MBP14.cutout.left);
    expect(await behind(MBP14.cutout)).toEqual([]);
    await apply(null);
    expect(await toolbar()).toEqual(chosen);
    await p.close();
  });

  it('leaves the toolbar alone where the header has no tabs (sidebar, rail)', async () => {
    await open({ tabs: 0, width: MBP14.width, height: MBP14.height });
    const natural = await toolbar();
    await apply(MBP14.cutout);
    expect(await behind(MBP14.cutout)).toEqual([]);
    expect(await boxed()).toBe(false);
    expect(await toolbar()).toEqual(natural);
    await p.close();
  });
});
