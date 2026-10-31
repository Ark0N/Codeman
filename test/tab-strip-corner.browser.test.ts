/**
 * @fileoverview Real-Chromium coverage for the L-shaped header strip (`_syncTabStripCorner()`, app.js).
 *
 * What DOM emulation cannot answer: whether the float the strip measures really keeps every tab out from under
 * the toolbar, whether the rows below it really run the header's full width, and when the strip falls back to
 * the plain wrap. The real `<header>` from index.html, the shipping styles.css, constants.js and app.js are
 * loaded into a page; `updateTabOverflowMode()` runs for real on a bare app instance.
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

describe('L-shaped header tab strip (real Chromium)', () => {
  let browser: Browser;
  let p: Page;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });

  /** Open the real header with `tabs` classic tabs; `twoRows` is the manual two-rows setting. */
  async function open(options: { tabs: number; width?: number; height?: number; twoRows?: boolean }) {
    p = await browser.newPage({
      viewport: { width: options.width ?? 1400, height: options.height ?? 700 },
      deviceScaleFactor: 1,
    });
    await p.route(ORIGIN, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body:
          '<!doctype html><html data-header-stats="compact" data-tab-orientation="horizontal" data-session-list="header">' +
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
      ({ tabs, twoRows }) => {
        const w = window as any;
        const app = Object.create(w.CodemanApp.prototype);
        app.$ = (id: string) => document.getElementById(id);
        app.sessions = new Map();
        app.loadAppSettingsFromStorage = () => ({ tabTwoRows: twoRows });
        app.getDefaultSettings = () => ({});
        app.isSessionSidebarActive = () => false;
        app.updateConnectionLines = () => undefined;
        const strip = document.getElementById('sessionTabs')!;
        if (twoRows) strip.classList.add('tabs-two-rows');
        for (let i = 1; i <= tabs; i++) {
          const id = `s${i}`;
          app.sessions.set(id, { id, name: `session-${i}` });
          strip.insertAdjacentHTML(
            'beforeend',
            `<div class="session-tab" data-id="${id}" role="tab"><span class="tab-name">session-${i}</span></div>`
          );
        }
        w.__app = app;
      },
      { tabs: options.tabs, twoRows: !!options.twoRows }
    );
    await relayout();
  }

  const settled = () => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const relayout = async () => {
    await p.evaluate(() => (window as any).__app.updateTabOverflowMode());
    await settled();
  };
  const cornered = () => p.evaluate(() => document.getElementById('sessionTabs')!.classList.contains('tabs-corner'));
  const toolbar = () =>
    p.evaluate(() => document.getElementById('headerRight')!.getBoundingClientRect().toJSON()) as Promise<Rect>;
  /** The visible part of each tab: the strip clips what it scrolls or overflows. */
  const visibleTabs = () =>
    p.evaluate(() => {
      const strip = document.getElementById('sessionTabs')!.getBoundingClientRect();
      return [...document.querySelectorAll('#sessionTabs > .session-tab')]
        .map((el) => {
          const r = el.getBoundingClientRect();
          return {
            left: Math.max(r.left, strip.left),
            right: Math.min(r.right, strip.right),
            top: Math.max(r.top, strip.top),
            bottom: Math.min(r.bottom, strip.bottom),
          };
        })
        .filter((r) => r.right > r.left && r.bottom > r.top);
    }) as Promise<Rect[]>;
  const overlapping = async () => {
    const b = await toolbar();
    return (await visibleTabs()).filter(
      (r) => r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top
    );
  };

  it('puts a wrapped classic desktop strip around the toolbar, with no tab under it', async () => {
    await open({ tabs: 40 });
    expect(await p.evaluate(() => document.getElementById('sessionTabs')!.classList.contains('tabs-auto-wrap'))).toBe(
      true
    );
    expect(await cornered()).toBe(true);
    expect(await overlapping()).toEqual([]);
    await p.close();
  });

  it('runs a row below the toolbar past its left edge', async () => {
    await open({ tabs: 40 });
    const b = await toolbar();
    const below = (await visibleTabs()).filter((r) => r.top >= b.bottom);
    expect(below.length).toBeGreaterThan(0);
    expect(Math.max(...below.map((r) => r.right))).toBeGreaterThan(b.left);
    await p.close();
  });

  /** Give tab `n` (1-based) a name long enough to be wider than the room beside the toolbar. */
  const longName = (n: number) =>
    p.evaluate((n) => {
      const tab = document.querySelectorAll<HTMLElement>('#sessionTabs > .session-tab')[n - 1];
      const name = tab.querySelector<HTMLElement>('.tab-name')!;
      name.textContent = 'a-very-long-session-name '.repeat(12);
    }, n);
  /** Is the first tab beside the toolbar (not dropped below it), and does it carry the trim? */
  const firstTab = () =>
    p.evaluate(() => {
      const tab = document.querySelector('#sessionTabs > .session-tab')!;
      const r = tab.getBoundingClientRect();
      const b = document.getElementById('headerRight')!.getBoundingClientRect();
      return {
        besideToolbar: r.top < b.bottom && r.right <= b.left,
        trimmed: tab.classList.contains('tab-corner-fit'),
      };
    });
  /** Each visible tab's top, in strip order: equal tops share a row. */
  const rowTops = async () => (await visibleTabs()).map((r) => Math.round(r.top));

  it('trims a first tab too wide for the room beside the toolbar instead of dropping the corner', async () => {
    await open({ tabs: 40 });
    await longName(1);
    await relayout();
    expect(await cornered()).toBe(true);
    expect(await overlapping()).toEqual([]);
    // Beside the toolbar, not dropped a row below it.
    const [first] = await visibleTabs();
    const b = await toolbar();
    expect(first.right).toBeLessThanOrEqual(b.left);
    expect(first.top).toBeLessThan(b.bottom);
    // The rows below still run the full width, several tabs to a row.
    const tops = await rowTops();
    expect(tops[1]).toBe(tops[2]);
    await p.close();
  });

  it('keeps the corner whichever tab is selected, though selecting widens the first tab past the room', async () => {
    await open({ tabs: 40 });
    // Real selection: the gear and close show only on the active tab. The first
    // tab's name is grown until it fits the room unselected but not selected.
    await p.evaluate(() => {
      for (const tab of document.querySelectorAll('#sessionTabs > .session-tab')) {
        tab.insertAdjacentHTML('beforeend', '<span class="tab-gear">⚙</span><span class="tab-close">×</span>');
      }
    });
    await relayout();
    await p.evaluate(() => {
      const strip = document.getElementById('sessionTabs')!;
      const room = parseFloat(strip.style.getPropertyValue('--tab-corner-first-max'));
      const tab = strip.querySelector<HTMLElement>(':scope > .session-tab')!;
      const name = tab.querySelector('.tab-name')!;
      while (tab.offsetWidth < room - 10) name.textContent += 'x';
    });
    const select = async (n: number) => {
      await p.evaluate((n) => {
        document
          .querySelectorAll('#sessionTabs > .session-tab')
          .forEach((tab, i) => tab.classList.toggle('active', i === n - 1));
      }, n);
      await relayout();
      return { cornered: await cornered(), overlapping: await overlapping(), first: await firstTab() };
    };
    expect(await select(3)).toEqual({
      cornered: true,
      overlapping: [],
      first: { besideToolbar: true, trimmed: false },
    });
    expect(await select(1)).toEqual({ cornered: true, overlapping: [], first: { besideToolbar: true, trimmed: true } });
    expect(await select(3)).toEqual({
      cornered: true,
      overlapping: [],
      first: { besideToolbar: true, trimmed: false },
    });
    await p.close();
  });

  it('re-trims the first tab when the room grows but is still too narrow for it', async () => {
    await open({ tabs: 40 });
    await longName(1);
    // One pass must get it right: the toolbar's ResizeObserver would run a
    // second one and hide a first pass that read the last trim as the width.
    await p.evaluate(() => (window as any).__app._tabCornerObserver?.disconnect());
    const toolbarWidth = async (px: string | null) => {
      await p.evaluate((px) => {
        const root = document.documentElement;
        if (px === null) {
          root.removeAttribute('data-header-right-width');
          root.style.removeProperty('--header-right-width');
        } else {
          root.setAttribute('data-header-right-width', 'set');
          root.style.setProperty('--header-right-width', px);
        }
      }, px);
      await relayout();
    };
    await toolbarWidth('500px');
    expect(await firstTab()).toEqual({ besideToolbar: true, trimmed: true });
    await toolbarWidth('300px');
    expect(await cornered()).toBe(true);
    expect(await firstTab()).toEqual({ besideToolbar: true, trimmed: true });
    expect(await overlapping()).toEqual([]);
    await p.close();
  });

  it('keeps the plain wrap when the toolbar leaves no usable room beside it', async () => {
    await open({ tabs: 40 });
    await p.evaluate(() => {
      const head = document.querySelector('.header')!.getBoundingClientRect();
      const right = document.getElementById('headerRight')!;
      right.style.minWidth = `${Math.round(head.width - 150)}px`;
    });
    await relayout();
    expect(await cornered()).toBe(false);
    expect(await overlapping()).toEqual([]);
    await p.close();
  });

  it('leaves a strip that fits on one row unwrapped and plain', async () => {
    await open({ tabs: 3 });
    expect(await p.evaluate(() => document.getElementById('sessionTabs')!.classList.contains('tabs-auto-wrap'))).toBe(
      false
    );
    expect(await cornered()).toBe(false);
    await p.close();
  });

  for (const arrangement of ['tabs-triage', 'tabs-clusters', 'tabs-ledger']) {
    it(`never corners the ${arrangement} arrangement`, async () => {
      await open({ tabs: 40 });
      await p.evaluate((cls) => document.getElementById('sessionTabs')!.classList.add(cls), arrangement);
      await relayout();
      expect(await cornered()).toBe(false);
      await p.close();
    });
  }

  it('never corners a strip outside #sessionTabsHost', async () => {
    await open({ tabs: 40 });
    await p.evaluate(() => {
      const elsewhere = document.createElement('div');
      elsewhere.style.width = '600px';
      document.body.appendChild(elsewhere);
      elsewhere.appendChild(document.getElementById('sessionTabs')!);
      document.getElementById('sessionTabs')!.classList.add('tabs-two-rows');
    });
    await relayout();
    expect(await cornered()).toBe(false);
    await p.close();
  });

  it('keeps the plain wrap for a wrapped strip past its max-height, so scrolling never puts tabs under the toolbar', async () => {
    await open({ tabs: 50, width: 1100, height: 500 });
    expect(await p.evaluate(() => document.getElementById('sessionTabs')!.classList.contains('tabs-auto-wrap'))).toBe(
      true
    );
    expect(await cornered()).toBe(false);
    await p.evaluate(() => (document.getElementById('sessionTabs')!.scrollTop = 60));
    await settled();
    expect(await overlapping()).toEqual([]);
    await p.close();
  });

  it('keeps the plain wrap for a scrolled two-rows strip across a re-render', async () => {
    await open({ tabs: 50, width: 1100, height: 500, twoRows: true });
    await p.evaluate(() => (document.getElementById('sessionTabs')!.scrollTop = 60));
    await relayout();
    expect(await cornered()).toBe(false);
    expect(await overlapping()).toEqual([]);
    await p.evaluate(() => (document.getElementById('sessionTabs')!.scrollTop = 0));
    await settled();
    expect(await overlapping()).toEqual([]);
    await p.close();
  });

  it('re-sizes the corner when the toolbar is narrowed with --header-right-width', async () => {
    await open({ tabs: 40 });
    const width = () =>
      p.evaluate(() =>
        parseFloat(document.getElementById('sessionTabs')!.style.getPropertyValue('--tab-corner-width'))
      );
    const before = await width();
    await p.evaluate(() => {
      const root = document.documentElement;
      root.setAttribute('data-header-right-width', 'set');
      root.style.setProperty('--header-right-width', '300px');
    });
    await relayout();
    expect(await cornered()).toBe(true);
    const after = await width();
    expect(after).toBeLessThan(before);
    expect(Math.abs(after - ((await toolbar()).width + 8))).toBeLessThan(16);
    expect(await overlapping()).toEqual([]);
    await p.close();
  });
});
