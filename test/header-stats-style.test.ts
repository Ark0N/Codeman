/**
 * @fileoverview The header-stats styles (`headerStatsStyle`, Discussion #426
 * option G): 'classic' (as before), 'compact' (one system pill with sparklines
 * plus a plan-ring pill) and 'tiles' (label over value, bar underneath; the
 * default).
 *
 * Pinned here:
 *  - The default is 'tiles', and only the three known values are honoured.
 *  - The two clustered styles move the connection indicator INTO the system
 *    stats pill and the plan chip right after it, on the REAL header markup
 *    from index.html, and 'classic' puts both back exactly where the template
 *    had them.
 *  - The WS readout never disappears with a hidden System Stats pill.
 *  - The parts only the new styles draw (sparklines, rings, meters, tile words)
 *    are rendered with sane values and hidden by default in CSS, which is what
 *    keeps 'classic' looking exactly as before.
 *
 * The real modules run INSIDE a JSDOM window (runScripts: 'outside-only').
 *
 * Port: none.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const PUBLIC = join(process.cwd(), 'src/web/public');
const read = (name: string) => readFileSync(join(PUBLIC, name), 'utf8');
const INDEX = read('index.html');
const HEADER = INDEX.slice(INDEX.indexOf('<header class="header">'), INDEX.indexOf('</header>') + '</header>'.length);

let CodemanApp: { prototype: Record<string, any> };
let window: any;
let document: Document;

beforeAll(async () => {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: 'https://localhost/',
    runScripts: 'outside-only',
  });
  if (dom.window.document.readyState !== 'complete') {
    await new Promise((resolve) => dom.window.addEventListener('load', resolve));
  }
  window = dom.window;
  document = window.document;
  window.setInterval = () => 0;
  window.requestAnimationFrame = () => 0;
  window.eval(
    'var MobileDetection = { isTouchDevice: () => false, isHandheldDevice: () => false, getDeviceType: () => "desktop" }, ' +
      'KeyboardHandler = {}, SwipeHandler = {}, VoiceInput = {}, DeepgramProvider = {}, NotificationManager = function(){};\n' +
      read('constants.js') +
      '\n' +
      read('app.js') +
      '\n' +
      read('settings-ui.js') +
      '\n' +
      read('panels-ui.js') +
      '\n;window.__HeaderStatsCodemanApp = CodemanApp;'
  );
  CodemanApp = window.__HeaderStatsCodemanApp;
});

function makeApp() {
  const app = Object.create(CodemanApp.prototype) as Record<string, any>;
  app.$ = (id: string) => document.getElementById(id);
  return app;
}

/** Element children of the header's right side, by id (or first class). */
const rightSide = () =>
  [...document.getElementById('headerRight')!.children].map((el) => el.id || el.classList[0]);
const statsChildren = () =>
  [...document.getElementById('headerSystemStats')!.children].map((el) => el.id || el.classList[0]);

beforeEach(() => {
  document.body.innerHTML = HEADER;
  delete document.documentElement.dataset.headerStats;
});

describe('resolveHeaderStatsStyle', () => {
  it("defaults to 'tiles' and honours only the three known styles", () => {
    const app = makeApp();
    expect(app.resolveHeaderStatsStyle({})).toBe('tiles');
    expect(app.resolveHeaderStatsStyle(undefined)).toBe('tiles');
    expect(app.resolveHeaderStatsStyle({ headerStatsStyle: 'classic' })).toBe('classic');
    expect(app.resolveHeaderStatsStyle({ headerStatsStyle: 'compact' })).toBe('compact');
    expect(app.resolveHeaderStatsStyle({ headerStatsStyle: 'tiles' })).toBe('tiles');
    expect(app.resolveHeaderStatsStyle({ headerStatsStyle: 'neon' })).toBe('tiles');
  });
});

describe('applyHeaderStatsStyle', () => {
  it('clusters WS, the system stats and the plan chip for tiles and compact', () => {
    for (const style of ['tiles', 'compact']) {
      document.body.innerHTML = HEADER;
      const app = makeApp();
      app.applyHeaderStatsStyle({ style, showSystemStats: true });
      expect(document.documentElement.dataset.headerStats).toBe(style);
      expect(statsChildren()[0]).toBe('connectionIndicator');
      const right = rightSide();
      expect(right[right.indexOf('headerSystemStats') + 1]).toBe('planUsageChip');
      expect(right).not.toContain('connectionIndicator');
    }
  });

  it("'classic' puts both back exactly where the template had them", () => {
    const template = rightSide();
    const app = makeApp();
    app.applyHeaderStatsStyle({ style: 'tiles', showSystemStats: true });
    app.applyHeaderStatsStyle({ style: 'compact', showSystemStats: true });
    app.applyHeaderStatsStyle({ style: 'classic', showSystemStats: true });
    expect(rightSide()).toEqual(template);
    expect(statsChildren()).not.toContain('connectionIndicator');
    expect(document.documentElement.dataset.headerStats).toBe('classic');
  });

  it('keeps WS out of a hidden System Stats pill', () => {
    const template = rightSide();
    const app = makeApp();
    app.applyHeaderStatsStyle({ style: 'tiles', showSystemStats: true });
    app.applyHeaderStatsStyle({ style: 'tiles', showSystemStats: false });
    expect(statsChildren()).not.toContain('connectionIndicator');
    expect(rightSide().indexOf('connectionIndicator')).toBe(template.indexOf('connectionIndicator'));
  });

  it('is idempotent: re-applying the same style moves nothing', () => {
    const app = makeApp();
    app.applyHeaderStatsStyle({ style: 'tiles', showSystemStats: true });
    const once = document.getElementById('headerRight')!.innerHTML;
    app.applyHeaderStatsStyle({ style: 'tiles', showSystemStats: true });
    expect(document.getElementById('headerRight')!.innerHTML).toBe(once);
  });
});

describe('the parts the new styles draw', () => {
  it('gives every plan window a ring and a meter with a clamped fill, the label the real number', () => {
    const app = makeApp();
    app.updatePlanUsageChip({ fiveHour: { usedPercentage: 28 }, sevenDay: { usedPercentage: 104 } });
    const wins = [...document.querySelectorAll<HTMLElement>('#planUsageChip .pu-win')];
    expect(wins).toHaveLength(2);
    expect(wins[0].querySelector<HTMLElement>('.pu-ring')!.style.getPropertyValue('--pu')).toBe('28');
    expect(wins[0].querySelector<HTMLElement>('.pu-meter > i')!.style.width).toBe('28%');
    expect(wins[0].querySelector('.pu-ring')!.classList.contains('pu-green')).toBe(true);
    expect(wins[1].querySelector('.pu-val')!.textContent).toBe('104%');
    expect(wins[1].querySelector<HTMLElement>('.pu-meter > i')!.style.width).toBe('100%');
    expect(wins[1].querySelector('.pu-meter')!.classList.contains('pu-red')).toBe(true);
  });

  it('keeps an idle Claude window as a dimmed slot with an empty ring and meter', () => {
    const app = makeApp();
    app.updatePlanUsageChip({ sevenDay: { usedPercentage: 35 } });
    const idle = document.querySelector<HTMLElement>('#planUsageChip .pu-win-idle')!;
    expect(idle.querySelector('.pu-val')!.textContent).toBe('—');
    expect(idle.querySelector<HTMLElement>('.pu-ring')!.style.getPropertyValue('--pu')).toBe('0');
    expect(idle.querySelector<HTMLElement>('.pu-meter > i')!.style.width).toBe('0%');
  });

  it('names the connection state in two short words per dot state', () => {
    const app = makeApp();
    const words = (dotClass: string, text = '') => app._connectionTileWords({ dotClass, text });
    expect(words('connection-dot connected', 'WS')).toMatchObject({ label: 'WS', value: 'live', state: 'connected' });
    expect(words('connection-dot fallback', 'HTTP')).toMatchObject({ label: 'HTTP', value: 'fallback' });
    expect(words('connection-dot offline', 'Offline')).toMatchObject({ label: 'NET', value: 'offline' });
    expect(words('connection-dot draining', 'Sending...')).toMatchObject({ label: 'SEND', value: 'queued' });
    expect(words('connection-dot reconnecting', 'WS…')).toMatchObject({ label: 'WS', value: 'retry' });
    expect(words('connection-dot reconnecting', 'Reconnecting...')).toMatchObject({ label: 'SSE', value: 'retry' });
  });

  it('writes the tile words beside the classic text, which stays as it was', () => {
    const app = makeApp();
    app._computeConnectionDescriptor = () => ({
      display: 'flex',
      dotClass: 'connection-dot connected',
      text: 'WS · 2.0KB queued',
      title: 'Terminal connected over WebSocket',
    });
    app._updateConnectionIndicator();
    expect(document.getElementById('connectionText')!.textContent).toBe('WS · 2.0KB queued');
    expect(document.getElementById('connectionTileLabel')!.textContent).toBe('WS');
    expect(document.getElementById('connectionTileValue')!.textContent).toBe('live');
    expect(document.getElementById('connectionTileValue')!.className).toBe('connection-tile-value connected');
  });

  it('draws the sparkline newest-right, with a 10% floor and only real samples', () => {
    const app = makeApp();
    const bars = () =>
      [...document.querySelectorAll<HTMLElement>('#statCpuSpark > i')].map((bar) => bar.style.height);
    app._pushStatSpark('cpu', 40);
    expect(bars()).toEqual(['', '', '', '40%']);
    app._pushStatSpark('cpu', 2);
    app._pushStatSpark('cpu', 250);
    app._pushStatSpark('cpu', 60);
    app._pushStatSpark('cpu', 70);
    expect(bars()).toEqual(['10%', '100%', '60%', '70%']);
  });
});

describe('header stats wiring (static)', () => {
  const css = read('styles.css');

  it('hides the new-style parts by default, so classic looks exactly as before', () => {
    expect(css).toMatch(
      /\.stat-spark,\s*\.connection-tile,\s*\.header-plan-usage \.pu-ring,\s*\.header-plan-usage \.pu-meter \{\s*display: none;/
    );
  });

  it('lays a tile out as three rows, so its height never depends on the font', () => {
    // A bar laid over the bottom of a fixed-height tile is what let a taller
    // system mono (SF Mono) push the value into it.
    expect(css).toMatch(/grid-template-rows: 9px 14px 2px;\s*row-gap: 2px;/);
    const tiles = css.slice(css.indexOf('/* --- Tiles: label over value'));
    const bar = tiles.slice(tiles.indexOf("html[data-header-stats='tiles'] .header-system-stats .stat-bar,"));
    expect(bar.slice(0, bar.indexOf('}'))).not.toContain('position: absolute');
    expect(bar.slice(0, bar.indexOf('}'))).toContain('grid-row: 3;');
  });

  it('gives the header buttons the tile box beside the tiles', () => {
    expect(css).toMatch(
      /html\[data-header-stats='tiles'\] \.header-right > \.btn-icon-header \{\s*width: 36px;\s*height: 36px;/
    );
    expect(css).toMatch(/html\[data-header-stats='tiles'\] \.header-right > \.btn-icon-header > svg \{\s*width: 18px;/);
  });

  it('stamps data-header-stats before first paint, tiles by default and classic on narrow screens', () => {
    expect(INDEX).toContain(
      "dataset.headerStats=(window.innerWidth<768||solo)?'classic':(H==='classic'||H==='compact')?H:'tiles'"
    );
  });

  it('offers the three styles with tiles marked as the default', () => {
    expect(INDEX).toMatch(
      /<select id="appSettingsHeaderStatsStyle"[^>]*>\s*<option value="classic">[^<]+<\/option>\s*<option value="compact">[^<]+<\/option>\s*<option value="tiles">Tiles \(default\)<\/option>/
    );
  });
});
