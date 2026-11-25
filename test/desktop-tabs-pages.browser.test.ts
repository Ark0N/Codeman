/**
 * @fileoverview The Codeman Desktop server-tab pages (packages/desktop/assets/tabs.html, the strip
 * across the top of the window, and packages/desktop/assets/overview.html, "All servers"), driven
 * in a real browser.
 *
 * Both pages ask the native side for things with `window.ipc.postMessage(JSON)` and hear back
 * through `window.__codemanTabs.onNative(msg)` / `window.__codemanOverview.onNative(msg)`: here a
 * stub records the first and the test plays the second. The pages are served with the
 * Content-Security-Policy the app serves them with, read out of packages/desktop/src/assets.rs, so
 * a script that policy would block fails here as it would in the app.
 *
 * Chromium stands in for the app's WKWebView, so what this pins is the pages' own logic and layout,
 * not WebKit's rendering.
 *
 * Each test is one ordered walk (a later step builds on the state the earlier ones left), so a walk
 * collects every check that fails and reports them together.
 *
 * Browser-driven, so excluded from `npm test` (config/test-suites.ts). Run locally:
 *   npm run test:browser -- test/desktop-tabs-pages.browser.test.ts
 *
 * Port: N/A (the pages are served by request interception; nothing listens).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const PKG = resolve(import.meta.dirname, '../packages/desktop');
const PAGES: Record<string, string> = {
  'tabs.html': readFileSync(resolve(PKG, 'assets/tabs.html'), 'utf8'),
  'overview.html': readFileSync(resolve(PKG, 'assets/overview.html'), 'utf8'),
};
const assetsRs = readFileSync(resolve(PKG, 'src/assets.rs'), 'utf8');
// The app's real CSP (assets::CSP, shared by every bundled page).
const CSP = /const CSP: &str = "([^"]*)";/.exec(assetsRs)![1];

// The native side as the page sees it: `ipc.postMessage` records what the page asks for.
const IPC_STUB = `window.__posted = []; Object.defineProperty(window, 'ipc', { value: Object.freeze({ postMessage: function (s) { window.__posted.push(JSON.parse(s)); } }) });`;

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    __posted: any[];
    __codemanTabs: { onNative(msg: unknown): void };
    __codemanOverview: { onNative(msg: unknown): void };
    ipc: { postMessage(message: string): void };
  }
}

/** The checks of the walk under way that did not hold, as `name -> what was seen`. */
const failed: string[] = [];
function check(name: string, cond: unknown, extra?: unknown) {
  if (!cond) failed.push(extra === undefined ? name : `${name} -> ${JSON.stringify(extra)}`);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const HOSTILE = '<img src=x onerror=alert(1)>';
const BAD_COLOR = 'red;background:url(x)';
const FALLBACK_RGB = 'rgb(148, 163, 184)';

interface Opened {
  page: Page;
  close(): Promise<void>;
  /** What the page posted since the last call, then forgets it. */
  take(): Promise<any[]>;
  native(msg: unknown): Promise<void>;
  errors: string[];
  cspViolations: string[];
  dialogs: string[];
}

async function open(
  browser: Browser,
  file: 'tabs.html' | 'overview.html',
  viewport: { width: number; height: number },
  reducedMotion: 'reduce' | 'no-preference' = 'no-preference'
): Promise<Opened> {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1, reducedMotion });
  const page = await ctx.newPage();
  const errors: string[] = [];
  const cspViolations: string[] = [];
  const dialogs: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) cspViolations.push(m.text());
  });
  page.on('dialog', (d) => {
    dialogs.push(d.message());
    void d.dismiss();
  });
  await page.route('http://app.test/**', (route) =>
    route.fulfill({
      body: PAGES[file],
      contentType: 'text/html; charset=utf-8',
      headers: { 'Content-Security-Policy': CSP },
    })
  );
  await page.addInitScript(IPC_STUB);
  await page.goto('http://app.test/' + file);
  const global = file === 'tabs.html' ? '__codemanTabs' : '__codemanOverview';
  return {
    page,
    close: () => ctx.close(),
    take: () => page.evaluate(() => window.__posted.splice(0)),
    native: (msg) => page.evaluate(([g, m]) => (window as any)[g as string].onNative(m), [global, msg] as const),
    errors,
    cspViolations,
    dialogs,
  };
}

// ---------------------------------------------------------------------------------------------
// The strip

function tab(id: number, name: string, extra: Record<string, unknown> = {}, status: Record<string, unknown> = {}) {
  return {
    id,
    name,
    color: '#22d3ee',
    active: false,
    kind: 'server',
    local: false,
    url: `http://${name.replace(/\W/g, '') || 'host'}.lan:3000`,
    key: id <= 9 ? id : null,
    status: { working: 0, waiting: 0, needsYou: 0, offline: false, ...status },
    ...extra,
  };
}

const STRIP_TABS = [
  tab(1, 'This Mac', { color: '#a78bfa', local: true, url: 'http://127.0.0.1:3000' }, { working: 2 }),
  tab(2, 'atlas', { active: true }),
  tab(
    3,
    'studio',
    { color: '#34d399', url: 'https://studio.example.ts.net' },
    {
      needsYou: 1,
      waiting: 1,
      working: 3,
      offline: true,
    }
  ),
  tab(4, 'build-01', { color: '#f472b6' }, { waiting: 1, working: 2, offline: true }),
  tab(5, 'pi-lab', { color: BAD_COLOR }, { offline: true }),
  tab(6, HOSTILE, { color: '#64748b' }, { working: 1, offline: true }),
  tab(7, 'New server tab', { kind: 'connect', url: null }),
  tab(8, 'loading.lan', { kind: 'loading' }),
];

async function stripWalk(browser: Browser) {
  const o = await open(browser, 'tabs.html', { width: 1280, height: 38 });
  const { page, take, native } = o;
  const sel = (id: number, inner = '') => `.tab[data-id="${id}"]${inner ? ' ' + inner : ''}`;
  const box = async (s: string) => (await page.locator(s).boundingBox())!;

  // 1. Before the first state: only the two buttons.
  check('posts ready on load', same(await take(), [{ cmd: 'ready' }]));
  check(
    'before a state: no tabs, both buttons shown',
    (await page.locator('[role=tab]').count()) === 0 &&
      (await page.isVisible('#overview')) &&
      (await page.isVisible('#new'))
  );
  check('the strip is 38px tall', (await box('#strip')).height === 38, await box('#strip'));
  check(
    'room for the traffic lights',
    (await page.evaluate(() => getComputedStyle(document.getElementById('strip')!).paddingLeft)) === '78px'
  );

  // 2. A state.
  await native({ type: 'state', tabs: STRIP_TABS, overviewActive: false, fullscreen: false });
  check('one tab per entry', (await page.locator('[role=tab]').count()) === 8);
  check('a tablist owns them', (await page.locator('[role=tablist] [role=tab]').count()) === 8);
  const selected = await page.$$eval('[role=tab]', (els) => els.map((e) => e.getAttribute('aria-selected')));
  check(
    'only the active tab is aria-selected',
    same(selected, ['false', 'true', 'false', 'false', 'false', 'false', 'false', 'false']),
    selected
  );
  check('the active tab is marked', (await page.locator('.tab.active').getAttribute('data-id')) === '2');
  const active = await page.$eval(sel(2), (e) => {
    const cs = getComputedStyle(e);
    return { bg: cs.backgroundColor, shadow: cs.boxShadow, color: cs.color };
  });
  check(
    'the active tab joins the page and carries its colour stripe',
    active.bg === 'rgb(11, 12, 15)' &&
      active.shadow.includes('rgb(34, 211, 238)') &&
      active.color === 'rgb(232, 234, 237)',
    active
  );
  check(
    'an inactive tab is transparent',
    (await page.$eval(sel(1), (e) => getComputedStyle(e).backgroundColor)) === 'rgba(0, 0, 0, 0)'
  );

  // Badge precedence.
  const badge = (id: number) =>
    page.$eval(sel(id, '.badge'), (e) => ({
      cls: e.className,
      text: e.textContent,
      shown: getComputedStyle(e).display,
    }));
  const b3 = await badge(3);
  check('needs you beats waiting, working and offline', b3.cls === 'badge needs' && b3.text === '1', b3);
  check(
    'the needs-you pill is red',
    (await page.$eval(sel(3, '.badge'), (e) => getComputedStyle(e).backgroundColor)) === 'rgb(248, 113, 113)'
  );
  check('waiting beats working and offline', (await badge(4)).cls === 'badge waiting', await badge(4));
  check('working beats offline', (await badge(6)).cls === 'badge working', await badge(6));
  check('offline alone: the dashed circle', (await badge(5)).cls === 'badge offline', await badge(5));
  check('nothing going on: no badge', (await badge(2)).shown === 'none', await badge(2));
  check(
    'an offline tab has its name dimmed, a needs-you one does not',
    (await page.$eval(sel(5, '.name'), (e) => getComputedStyle(e).color)) === 'rgb(107, 112, 121)' &&
      (await page.$eval(sel(3, '.name'), (e) => getComputedStyle(e).color)) !== 'rgb(107, 112, 121)'
  );
  check(
    'a working ring turns',
    (await page.$eval(sel(1, '.badge'), (e) => getComputedStyle(e).animationName)) === 'spin'
  );

  // Icons.
  const icons = await page.$$eval('.tab .ico', (els) =>
    els.map((e) => (e.querySelector('.spin') ? 'spin' : (e.querySelector('svg')?.childElementCount ?? 0)))
  );
  check(
    'laptop for this Mac, rack for a server, + for new, spinner while loading',
    same(icons, [2, 3, 3, 3, 3, 3, 1, 'spin']),
    icons
  );
  check(
    'the + of a new tab is blue',
    (await page.$eval(sel(7, '.ico'), (e) => getComputedStyle(e).color)) === 'rgb(96, 165, 250)'
  );

  // Untrusted text and colours.
  check('a hostile name is text', (await page.textContent(sel(6, '.name'))) === HOSTILE);
  check('no element came out of it', (await page.locator('img').count()) === 0);
  check(
    'a bad colour falls back',
    (await page.$eval(sel(5, '.ico'), (e) => getComputedStyle(e).color)) === FALLBACK_RGB &&
      !((await page.getAttribute(sel(5), 'style')) || '').includes('url'),
    await page.getAttribute(sel(5), 'style')
  );

  // Labels and the tooltip.
  check(
    'aria-label carries the status',
    (await page.getAttribute(sel(3, '[role=tab]'), 'aria-label'))?.startsWith('studio, 1 needs you')
  );
  const title3 = await page.getAttribute(sel(3, '[role=tab]'), 'title');
  check(
    'the tooltip: name and shortcut, URL, one line per status',
    title3 === 'studio  ⌘3\nhttps://studio.example.ts.net\n1 needs you\n1 waiting\n3 working\nNot answering',
    title3
  );
  check(
    'the loading tab says it is connecting',
    (await page.getAttribute(sel(8, '[role=tab]'), 'aria-label')) === 'loading.lan, Connecting'
  );
  check(
    'icon buttons are named',
    (await page.getAttribute('#overview', 'aria-label')) === 'All servers' &&
      (await page.getAttribute('#new', 'aria-label')) === 'New server tab' &&
      (await page.getAttribute(sel(2, '.close'), 'aria-label')) === 'Close tab'
  );
  check(
    'nothing in the strip takes the keyboard focus',
    await page.$$eval('button', (els) => els.every((e) => e.getAttribute('tabindex') === '-1'))
  );

  // 3. Clicks.
  await take();
  await page.click(sel(1));
  check('a click selects', same(await take(), [{ cmd: 'select', id: 1 }]));
  check(
    'the strip does not take the focus on a click',
    await page.evaluate(() => document.activeElement === document.body)
  );
  check('the close button shows on the active tab', await page.isVisible(sel(2, '.close')));
  check('and not on an inactive one', !(await page.isVisible(sel(4, '.close'))));
  await page.hover(sel(4));
  check('hovering shows it', await page.isVisible(sel(4, '.close')));
  await page.click(sel(4, '.close'));
  check('the close button closes, and only that', same(await take(), [{ cmd: 'close', id: 4 }]));
  await page.click(sel(3), { button: 'middle' });
  check('a middle click closes', same(await take(), [{ cmd: 'close', id: 3 }]));
  await page.click(sel(5), { button: 'right' });
  check('a right click asks for the menu', same(await take(), [{ cmd: 'menu', id: 5 }]));
  // WebKit's own menu never shows on the strip: every contextmenu is cancelled, and only a
  // tab asks for one. Seen from window, after the page's own listener on document.
  await page.evaluate(() => {
    (window as any).__menus = [];
    window.addEventListener('contextmenu', (e) => (window as any).__menus.push(e.defaultPrevented));
  });
  await page.click('#new', { button: 'right' });
  await page.click('#overview', { button: 'right' });
  await page.mouse.click(30, 19, { button: 'right' });
  await page.click(sel(2, '.close'), { button: 'right' });
  check(
    'a right click on a button or empty strip asks for nothing; on a close button, the tab menu',
    same(await take(), [{ cmd: 'menu', id: 2 }])
  );
  check(
    'and none of them shows the WebKit menu',
    same(await page.evaluate(() => (window as any).__menus), [true, true, true, true]),
    await page.evaluate(() => (window as any).__menus)
  );
  await page.click('#new');
  check('+ opens a new tab', same(await take(), [{ cmd: 'new' }]));
  await page.click('#overview');
  check('the grid button asks for the overview', same(await take(), [{ cmd: 'overview' }]));

  // 4. Empty strip: window drag and zoom.
  const fill = await box('#fill');
  check('there is empty strip to drag by', fill.width >= 48, fill);
  const fx = fill.x + fill.width / 2;
  await page.mouse.click(fx, 19);
  check('a press on empty strip drags the window', same(await take(), [{ cmd: 'drag' }]));
  await page.mouse.click(30, 19);
  check('so does a press under the traffic lights', same(await take(), [{ cmd: 'drag' }]));
  await page.waitForTimeout(600);
  await page.mouse.dblclick(fx, 19);
  check(
    'a double click zooms on its second press (one drag, for the first)',
    same(await take(), [{ cmd: 'drag' }, { cmd: 'zoom' }])
  );
  const t1 = await box(sel(1));
  await page.mouse.move(t1.x + t1.width / 2, 22);
  await page.mouse.down();
  await page.mouse.up();
  check('a press on a tab is not a window drag', same(await take(), [{ cmd: 'select', id: 1 }]));

  // 5. Overview on, fullscreen.
  await native({ type: 'state', tabs: STRIP_TABS, overviewActive: true, fullscreen: true });
  check(
    'the grid button is lit while the overview shows',
    (await page.$eval('#overview', (e) => getComputedStyle(e).backgroundColor)) === 'rgb(37, 99, 235)' &&
      (await page.getAttribute('#overview', 'aria-pressed')) === 'true'
  );
  check(
    'fullscreen has no traffic lights to make room for',
    (await page.evaluate(() => getComputedStyle(document.getElementById('strip')!).paddingLeft)) === '10px'
  );

  // 6. Rename.
  await native({ type: 'state', tabs: STRIP_TABS, overviewActive: false, fullscreen: false });
  await take();
  await page.dblclick(sel(2));
  const input = sel(2, 'input.rename');
  check(
    'a double click on a tab starts a rename',
    (await page.isVisible(input)) &&
      (await page.inputValue(input)) === 'atlas' &&
      (await page.evaluate(() => document.activeElement?.className)) === 'rename'
  );
  await page.keyboard.type('  prod box  ');
  await page.keyboard.press('Enter');
  check(
    'Enter commits it, trimmed (the clicks of the double click selected)',
    same(await take(), [
      { cmd: 'select', id: 2 },
      { cmd: 'select', id: 2 },
      { cmd: 'editing' },
      { cmd: 'rename', id: 2, name: 'prod box' },
    ])
  );
  check(
    'and shows it at once',
    !(await page.isVisible(input)) && (await page.textContent(sel(2, '.name'))) === 'prod box'
  );
  await native({ type: 'rename', id: 1 });
  check('the native menu starts a rename too', (await page.inputValue(sel(1, 'input.rename'))) === 'This Mac');
  await page.keyboard.type('zzz');
  await page.keyboard.press('Escape');
  const cancelled = await take();
  check(
    'Escape cancels, and still says the rename is over (with the old name)',
    same(cancelled, [{ cmd: 'editing' }, { cmd: 'rename', id: 1, name: 'This Mac' }]) &&
      (await page.locator('input.rename').count()) === 0 &&
      (await page.textContent(sel(1, '.name'))) === 'This Mac',
    cancelled
  );
  await native({ type: 'rename', id: 1 });
  await page.keyboard.press('Enter');
  check(
    'an unchanged name posts the old name',
    same(await take(), [{ cmd: 'editing' }, { cmd: 'rename', id: 1, name: 'This Mac' }])
  );
  await native({ type: 'rename', id: 1 });
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Enter');
  check(
    'an empty name asks for the default',
    same(await take(), [{ cmd: 'editing' }, { cmd: 'rename', id: 1, name: '' }])
  );
  await native({ type: 'rename', id: 3 });
  check('a rename asks the native side for the keyboard', same(await take(), [{ cmd: 'editing' }]));
  await page.keyboard.type('x'.repeat(50));
  check('at most 40 characters', (await page.inputValue(sel(3, 'input.rename'))).length === 40);
  await page.click(sel(3, 'input.rename'), { button: 'right' });
  check(
    'a right click in the rename field shows no menu at all and keeps the rename going',
    (await page.evaluate(() => (window as any).__menus.at(-1))) === true &&
      (await page.locator(sel(3, 'input.rename')).count()) === 1 &&
      (await take()).length === 0
  );
  // A state arriving mid-rename (statuses change all the time) keeps the field and its text.
  const moved = [STRIP_TABS[2], ...STRIP_TABS.filter((t) => t.id !== 3)];
  await native({ type: 'state', tabs: moved, overviewActive: false, fullscreen: false });
  check(
    'a state mid-rename keeps the field, its text and the focus',
    (await page.inputValue(sel(3, 'input.rename'))) === 'x'.repeat(40) &&
      (await page.evaluate(() => document.activeElement?.className)) === 'rename' &&
      (await page.$eval('#tabs', (e) => e.firstElementChild?.getAttribute('data-id'))) === '3'
  );
  await page.mouse.click(fx, 19);
  const committed = await take();
  check(
    'a click elsewhere commits it',
    same(committed, [{ cmd: 'rename', id: 3, name: 'x'.repeat(40) }, { cmd: 'drag' }]),
    committed
  );

  // 7. Drag to reorder.
  const four = [tab(11, 'one', { active: true }), tab(12, 'two'), tab(13, 'three'), tab(14, 'four')];
  await native({ type: 'state', tabs: four, overviewActive: false, fullscreen: false });
  await take();
  const widths = await page.$$eval('.tab', (els) => els.map((e) => e.getBoundingClientRect().width));
  check(
    'a few tabs are 200px wide',
    widths.every((w) => w === 200),
    widths
  );
  const centre = async (id: number) => {
    const b = await box(sel(id));
    return b.x + b.width / 2;
  };
  await page.mouse.move(await centre(11), 22);
  await page.mouse.down();
  await page.mouse.move((await centre(11)) + 2, 22);
  await page.mouse.up();
  check('a press that moves under 4px is still a click', same(await take(), [{ cmd: 'select', id: 11 }]));
  const target = (await centre(13)) + 10;
  await page.mouse.move(await centre(11), 22);
  await page.mouse.down();
  await page.mouse.move(target, 22, { steps: 12 });
  const shifted = await page.$eval(sel(12), (e) => (e as HTMLElement).style.transform);
  check('the tabs passed over slide aside', shifted === 'translateX(-202px)', shifted);
  await page.mouse.up();
  const order = () => page.$$eval('.tab', (els) => els.map((e) => Number(e.getAttribute('data-id'))));
  check('a drag posts the new place, and no select', same(await take(), [{ cmd: 'move', id: 11, to: 2 }]));
  check('and shows it at once', same(await order(), [12, 13, 11, 14]), await order());
  check(
    'nothing stays shifted',
    await page.$$eval('.tab', (els) => els.every((e) => !(e as HTMLElement).style.transform))
  );
  // A state that arrives during a drag waits for the drop.
  await page.mouse.move(await centre(14), 22);
  await page.mouse.down();
  await page.mouse.move((await centre(12)) - 20, 22, { steps: 12 });
  const renamed = [four[1], four[2], four[0], four[3]].map((t) => (t.id === 12 ? { ...t, name: 'twelve' } : t));
  await native({ type: 'state', tabs: renamed, overviewActive: false, fullscreen: false });
  check('mid-drag, the row holds still', (await page.textContent(sel(12, '.name'))) === 'two');
  await page.mouse.up();
  check('dropped at the front', same(await take(), [{ cmd: 'move', id: 14, to: 0 }]));
  check(
    'then the waiting state shows, in the new order',
    same(await order(), [14, 12, 13, 11]) && (await page.textContent(sel(12, '.name'))) === 'twelve',
    await order()
  );

  // 8. Many tabs and long names.
  const many = Array.from({ length: 30 }, (_, i) => tab(100 + i, 'server-' + i, { active: i === 0 }));
  many[0].name = 'a very long server name that cannot possibly fit in a tab';
  await native({ type: 'state', tabs: many, overviewActive: false, fullscreen: false });
  const geo = await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll('.tab')).map((e) => e.getBoundingClientRect());
    const plus = document.getElementById('new')!.getBoundingClientRect();
    const name = document.querySelector('.tab .name') as HTMLElement;
    return {
      minWidth: Math.min(...tabs.map((r) => r.width)),
      tops: new Set(tabs.map((r) => r.top)).size,
      plusRight: plus.right,
      plusLeft: plus.left,
      pageWidth: document.documentElement.scrollWidth,
      ellipsis: name.scrollWidth > name.clientWidth && getComputedStyle(name).textOverflow === 'ellipsis',
      fill: document.getElementById('fill')!.getBoundingClientRect().width,
    };
  });
  check(
    'thirty tabs: 72px each, one row, + still on screen, the page never scrolls',
    geo.minWidth === 72 && geo.tops === 1 && geo.plusRight <= 1280 && geo.plusLeft > 0 && geo.pageWidth <= 1280,
    geo
  );
  check('a long name ends in an ellipsis', geo.ellipsis, geo);
  check('and some strip stays empty to drag the window by', geo.fill >= 48, geo);
  await native({
    type: 'state',
    tabs: [tab(1, 'busy', { active: true }, { needsYou: 250 })],
    overviewActive: false,
    fullscreen: false,
  });
  check('a big count is capped', (await page.textContent(sel(1, '.badge'))) === '99+');

  check('no page errors', o.errors.length === 0, o.errors);
  check('no CSP violations', o.cspViolations.length === 0, o.cspViolations);
  check('no dialogs', o.dialogs.length === 0, o.dialogs);
  await o.close();
}

// ---------------------------------------------------------------------------------------------
// The overview

function server(tabId: number, name: string, extra: Record<string, unknown> = {}) {
  return {
    tab: tabId,
    name,
    color: '#22d3ee',
    url: `http://${name.replace(/\W/g, '')}.lan:3000`,
    local: false,
    key: tabId,
    version: '1.51.0',
    kind: 'server',
    offline: false,
    refused: false,
    sessions: [] as unknown[],
    counts: { needsYou: 0, waiting: 0, working: 0, sessions: 0 },
    ...extra,
  };
}
const sess = (id: string, name: string, state: string, text: string) => ({ id, name, state, text });

const SERVERS = [
  server(3, 'studio', {
    color: '#34d399',
    url: 'https://studio.example.ts.net',
    sessions: [
      sess('s-billing', 'billing', 'needs', 'Allow Bash(npm run migrate)?'),
      sess('s-docs', HOSTILE, 'needs', HOSTILE),
    ],
    counts: { needsYou: 2, waiting: 0, working: 0, sessions: 2 },
  }),
  server(2, 'atlas', {
    url: 'http://192.168.1.40:3000',
    sessions: [
      sess('s-api', 'api-gateway', 'waiting', 'finished 3 min ago'),
      sess('s-shop', 'webshop', 'working', 'Refactoring… 1m 12s'),
      sess('s-ingest', 'ingest-pipeline', 'working', 'Running tests… 20s'),
      sess('s-a', 'landing', 'idle', 'idle'),
      sess('s-b', 'extra', 'idle', 'idle'),
    ],
    counts: { needsYou: 0, waiting: 1, working: 2, sessions: 7 },
  }),
  server(1, 'This Mac', {
    color: BAD_COLOR,
    local: true,
    url: 'http://127.0.0.1:3000',
    sessions: [sess('s-sb', 'sandbox-3f9a', 'working', 'Writing tests… 4m 40s')],
    counts: { needsYou: 0, waiting: 0, working: 1, sessions: 1 },
  }),
  server(5, 'pi-lab', { offline: true, counts: { needsYou: 4, waiting: 0, working: 0, sessions: 3 } }),
  server(6, 'old-nas', { refused: true, version: null }),
  server(7, 'New server tab', { kind: 'connect', url: null, version: null }),
  server(8, 'build-01', { kind: 'loading', version: null, key: null }),
];

async function overviewWalk(browser: Browser) {
  const o = await open(browser, 'overview.html', { width: 1280, height: 800 });
  const { page, take, native } = o;
  const card = (n: number) => `#grid > .card:nth-child(${n})`;

  check('posts ready on load', same(await take(), [{ cmd: 'ready' }]));
  check(
    'before a state: just the Add card, nothing needs you',
    (await page.locator('#grid > *').count()) === 1 &&
      (await page.isVisible('#grid > button.add')) &&
      (await page.textContent('#summary')) === 'Nothing needs you'
  );

  await native({ type: 'state', servers: SERVERS });
  const names = await page.$$eval('#grid > .card .name', (els) => els.map((e) => e.textContent));
  check(
    'one card per server, in the order given, then Add',
    same(names, ['studio', 'atlas', 'This Mac', 'pi-lab', 'old-nas', 'New server tab', 'build-01']) &&
      (await page.$eval('#grid', (g) => g.lastElementChild!.classList.contains('add'))),
    names
  );
  check(
    'the summary counts what is up (an offline server counts as offline only)',
    (await page.textContent('#summary')) === '2 need you · 1 waiting · 3 working · 1 offline',
    await page.textContent('#summary')
  );
  check(
    'need you and waiting are coloured',
    (await page.$eval('#summary .needs', (e) => getComputedStyle(e).color)) === 'rgb(252, 165, 165)' &&
      (await page.$eval('#summary .waiting', (e) => getComputedStyle(e).color)) === 'rgb(252, 211, 77)'
  );

  // A card that needs you.
  const studio = card(1);
  check(
    'needs you: red border, Answer in red',
    (await page.$eval(studio, (e) => getComputedStyle(e).borderTopColor)) === 'rgba(248, 113, 113, 0.45)' &&
      (await page.textContent(studio + ' .action')) === 'Answer' &&
      (await page.$eval(studio + ' .action', (e) => getComputedStyle(e).backgroundColor)) === 'rgb(239, 68, 68)'
  );
  check(
    'header: name, URL, shortcut',
    (await page.textContent(studio + ' .url')) === 'https://studio.example.ts.net' &&
      (await page.textContent(studio + ' .key')) === '⌘3'
  );
  check(
    'its colour is the stripe',
    (await page.$eval(studio, (e) => getComputedStyle(e).boxShadow)).includes('rgb(52, 211, 153)')
  );
  check('footer: sessions and version', (await page.textContent(studio + ' .meta')) === '2 sessions · 1.51.0');
  check(
    'hostile session text stays text',
    (await page
      .locator(studio + ' .row .sname')
      .nth(1)
      .textContent()) === HOSTILE &&
      (await page
        .locator(studio + ' .row .stext')
        .nth(1)
        .textContent()) === HOSTILE &&
      (await page.locator('img').count()) === 0
  );
  check(
    'the needs mark is a red !',
    (await page
      .locator(studio + ' .row .mark')
      .first()
      .textContent()) === '!' &&
      (await page
        .locator(studio + ' .row .mark')
        .first()
        .evaluate((e) => getComputedStyle(e).backgroundColor)) === 'rgb(248, 113, 113)'
  );
  await page.click(studio + ' .action');
  check(
    'Answer goes to the first session that needs you',
    same(await take(), [{ cmd: 'openSession', tab: 3, session: 's-billing' }])
  );

  // A busy card with more sessions than fit.
  const atlas = card(2);
  check('at most four rows', (await page.locator(atlas + ' .row').count()) === 4);
  check('the rest as +N more', (await page.textContent(atlas + ' .more')) === '+3 more');
  check(
    'rows are buttons, in the order given',
    same(await page.$$eval(atlas + ' .row', (els) => els.map((e) => e.tagName + ':' + e.className)), [
      'BUTTON:row waiting',
      'BUTTON:row working',
      'BUTTON:row working',
      'BUTTON:row idle',
    ])
  );
  check('Open when nothing needs you', (await page.textContent(atlas + ' .action')) === 'Open');
  check('no red border', (await page.$eval(atlas, (e) => getComputedStyle(e).borderTopColor)) === 'rgb(35, 37, 43)');
  await page.click(atlas + ' .action');
  await page.click(atlas + ' .head');
  await page
    .locator(atlas + ' .row')
    .nth(1)
    .click();
  check(
    'Open, the header and a row post what they should',
    same(await take(), [
      { cmd: 'open', tab: 2 },
      { cmd: 'open', tab: 2 },
      { cmd: 'openSession', tab: 2, session: 's-shop' },
    ])
  );

  // A bad colour.
  const mac = card(3);
  check(
    'a bad colour falls back',
    (await page.$eval(mac, (e) => getComputedStyle(e).boxShadow)).includes(FALLBACK_RGB) &&
      !((await page.getAttribute(mac, 'style')) || '').includes('url'),
    await page.getAttribute(mac, 'style')
  );
  check('one session, singular', (await page.textContent(mac + ' .meta')) === '1 session · 1.51.0');

  // Offline, refused, new, loading.
  const pi = card(4);
  check(
    'offline: dashed, says so, offers Retry',
    (await page.$eval(pi, (e) => getComputedStyle(e).borderTopStyle)) === 'dashed' &&
      (await page.textContent(pi + ' .note')) === 'Not answering, the app keeps trying' &&
      (await page.textContent(pi + ' .action')) === 'Retry' &&
      (await page.locator(pi + ' .row').count()) === 0
  );
  await page.click(pi + ' .action');
  check('Retry retries', same(await take(), [{ cmd: 'retry', tab: 5 }]));
  const nas = card(5);
  check(
    'refused: says so, offers Open',
    (await page.textContent(nas + ' .note')) === 'The login was refused' &&
      (await page.textContent(nas + ' .action')) === 'Open'
  );
  await page.click(nas + ' .action');
  check('which opens the tab', same(await take(), [{ cmd: 'open', tab: 6 }]));
  check(
    'a new tab: a small card with Open',
    (await page.textContent(card(6) + ' .name')) === 'New server tab' &&
      (await page.textContent(card(6) + ' .action')) === 'Open' &&
      (await page.locator(card(6) + ' .url').count()) === 0
  );
  check(
    'loading: Connecting with a spinner',
    (await page.textContent(card(7) + ' .note')) === 'Connecting…' &&
      (await page.locator(card(7) + ' .spin').count()) === 1 &&
      (await page.$eval(card(7) + ' .spin', (e) => getComputedStyle(e).animationName)) === 'spin'
  );
  await page.click('#grid > .add');
  check('Add asks for a new tab', same(await take(), [{ cmd: 'new' }]));

  // Keyboard: real buttons, a visible ring, and the focus survives a state.
  await page.focus(atlas + ' .head');
  await page.keyboard.press('Tab');
  const ring = await page.evaluate(() => {
    const a = document.activeElement as HTMLElement;
    const cs = getComputedStyle(a);
    return { cls: a.className, outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor };
  });
  check(
    'Tab reaches the first row, with a blue ring',
    ring.cls === 'row waiting' && ring.outline === 'solid 2px rgb(59, 130, 246)',
    ring
  );
  await page.keyboard.press('Enter');
  check('Enter on a row opens that session', same(await take(), [{ cmd: 'openSession', tab: 2, session: 's-api' }]));
  const changed = SERVERS.map((s) =>
    s.tab === 2
      ? { ...s, sessions: [sess('s-api', 'api-gateway', 'waiting', 'finished 4 min ago'), ...s.sessions.slice(1)] }
      : s
  );
  await native({ type: 'state', servers: changed });
  check(
    'a new state keeps the focus on the same row',
    (await page.evaluate(() => (document.activeElement as HTMLElement).dataset.focus)) === 'row:2:s-api' &&
      (await page.textContent(atlas + ' .row .stext')) === 'finished 4 min ago'
  );

  // Back to nothing.
  await native({ type: 'state', servers: [] });
  check(
    'no servers: just the Add card',
    (await page.locator('#grid > *').count()) === 1 && (await page.textContent('#summary')) === 'Nothing needs you'
  );
  const tooNarrow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check('no sideways scroll', !tooNarrow);

  check('no page errors', o.errors.length === 0, o.errors);
  check('no CSP violations', o.cspViolations.length === 0, o.cspViolations);
  check('no dialogs', o.dialogs.length === 0, o.dialogs);
  await o.close();
}

// ---------------------------------------------------------------------------------------------
// Both: reduced motion, the globals, the text of the files

async function bothPages(browser: Browser) {
  for (const [file, text] of Object.entries(PAGES)) {
    check(`${file}: no em dash`, !text.includes(String.fromCharCode(0x2014)));
    check(`${file}: no innerHTML`, !/innerHTML|insertAdjacentHTML|outerHTML/.test(text));
  }

  const strip = await open(browser, 'tabs.html', { width: 900, height: 38 }, 'reduce');
  await strip.native({
    type: 'state',
    tabs: [tab(1, 'busy', { active: true }, { working: 1 }), tab(2, 'starting', { kind: 'loading' })],
    overviewActive: false,
    fullscreen: false,
  });
  check(
    'reduced motion: the strip does not spin',
    (await strip.page.$eval('.badge.working', (e) => getComputedStyle(e).animationName)) === 'none' &&
      (await strip.page.$eval('.spin', (e) => getComputedStyle(e).animationName)) === 'none'
  );
  const desc = await strip.page.evaluate(() => {
    const d = Object.getOwnPropertyDescriptor(window, '__codemanTabs')!;
    const before = window.__codemanTabs;
    try {
      (window as any).__codemanTabs = null;
    } catch {
      /* strict code would throw; the page's own is the point */
    }
    return { writable: d.writable, configurable: d.configurable, kept: window.__codemanTabs === before };
  });
  check('the strip global cannot be replaced', !desc.writable && !desc.configurable && desc.kept, desc);
  await strip.native('{"type":"state","tabs":[{"id":9,"name":"from a string"}]}');
  check('a message as a JSON string works too', (await strip.page.textContent('.tab .name')) === 'from a string');
  await strip.native({ type: 'state', tabs: 'nonsense' });
  await strip.native(null);
  check(
    'junk empties the strip without an error',
    (await strip.page.locator('.tab').count()) === 0 && strip.errors.length === 0,
    strip.errors
  );
  await strip.close();

  const ov = await open(browser, 'overview.html', { width: 1280, height: 800 }, 'reduce');
  await ov.native({ type: 'state', servers: SERVERS });
  check(
    'reduced motion: the overview does not spin',
    (await ov.page.$eval('.row.working .mark', (e) => getComputedStyle(e, '::before').animationName)) === 'none' &&
      (await ov.page.$eval('.spin', (e) => getComputedStyle(e).animationName)) === 'none'
  );
  const odesc = await ov.page.evaluate(() => {
    const d = Object.getOwnPropertyDescriptor(window, '__codemanOverview')!;
    return { writable: d.writable, configurable: d.configurable };
  });
  check('the overview global cannot be replaced', !odesc.writable && !odesc.configurable, odesc);
  check('no page errors', ov.errors.length === 0, ov.errors);
  await ov.close();
}

describe('Codeman Desktop server tab pages', () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  const walk = (name: string, steps: (browser: Browser) => Promise<void>) =>
    it(
      name,
      async () => {
        failed.length = 0;
        await steps(browser);
        expect(failed).toEqual([]);
      },
      120_000
    );

  walk('the strip: tabs, badges, clicks, window drag, rename and reorder', stripWalk);
  walk('the overview: cards, rows, buttons and the summary', overviewWalk);
  walk('both: reduced motion, the globals, junk from the native side', bothPages);
});
