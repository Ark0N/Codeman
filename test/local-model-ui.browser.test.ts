/**
 * @fileoverview Real-Chromium coverage for the "Run a model on this Mac" window
 * (src/web/public/local-model-ui.js): what DOM emulation cannot answer, because it lays nothing
 * out.
 *
 *  - the numbers of the model list line up: every row's speed and download size end on the
 *    same edge, under their captions, and every tag starts on the same edge;
 *  - a row is one line on a desktop and two lines under 560px, where nothing runs off the
 *    side and the buttons take the full width;
 *  - the memory bar is 12px high and filled to the selected model's share of its track, and
 *    the fill follows the selection;
 *  - the selected row carries the feature's colour on its reading edge;
 *  - the welcome button is really gone while it is `hidden`, and the window paints above App
 *    Settings;
 *  - the models on this Mac: the sizes on disk end on one edge under their caption, a row's
 *    buttons end on the list's edge, the sizes do not move when a row's Delete question opens,
 *    a long list scrolls from its top (it is never cut off above the frame), and under 560px a
 *    row is two lines with nothing running off the side.
 *
 * The REAL index.html is served with its scripts taken out and the two shipping stylesheets
 * inlined (mobile.css under the media query its `<link>` carries); the real module runs on a
 * bare `CodemanApp` whose `_api` answers a fixture payload. The states themselves are pinned in
 * JSDOM by test/local-model-ui.test.ts.
 *
 * Port: none (page.route on a fake origin, no server).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const dir = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(dir, name), 'utf8');
const ORIGIN = 'http://app.test/';

/**
 * index.html as shipped, minus every script, with styles.css and mobile.css inlined. The
 * comments go first: some of them mention a script tag, which would otherwise open a match
 * that swallows the markup up to the next real one.
 */
const MARKUP = read('index.html')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<script\b[\s\S]*?<\/script>/g, '');
const PAGE = MARKUP.replace(
  '<link rel="stylesheet" href="styles.css">',
  () => `<style>${read('styles.css')}</style>`
).replace(
  '<link rel="stylesheet" href="mobile.css" media="(max-width: 1023px)">',
  () => `<style media="(max-width: 1023px)">${read('mobile.css')}</style>`
);

const RUNTIME = 185971671;

function row(modelId: string, modelLabel: string, downloadBytes: number, downloadGb: string, over: object = {}) {
  return {
    modelId,
    modelLabel,
    license: 'Apache-2.0',
    paramsB: 9,
    context: 131072,
    cli: 'opencode',
    cliLabel: 'OpenCode',
    cliInstalled: true,
    needBytes: 1,
    needGb: '20.0',
    downloadBytes,
    downloadGb,
    budgetShare: 0.5,
    fit: 'good',
    fitLabel: 'Good',
    speed: 'ok',
    tested: false,
    needSource: 'estimated',
    harnesses: [{ cli: 'opencode', cliLabel: 'OpenCode', installed: true }],
    installBytes: downloadBytes + RUNTIME,
    installGb: downloadGb,
    ...over,
  };
}

const STATUS = {
  hardware: {
    platform: 'darwin',
    arch: 'arm64',
    memBytes: 51539607552,
    memGb: '51.5',
    memClassGb: 48,
    chip: 'Apple M5 Pro',
    freeDiskBytes: 897000000000,
    freeDiskGb: '897',
    source: 'sysctl',
  },
  recommendation: {
    verdict: 'ok',
    headline: { text: 'Recommended for this Mac' },
    notes: [],
    pick: row('qwen3.6:35b-a3b', 'Qwen3.6 35B-A3B', 23105798956, '23.1', {
      needGb: '36.0',
      budgetShare: 0.957,
      tokensPerSecond: 67.7,
      tested: true,
      tag: { kind: 'tested', label: 'Tested on a Mac like this' },
    }),
    alternatives: [
      row('qwen3.8:27b', 'Qwen3.8 27B', 17741871939, '17.7', {
        needGb: '30.6',
        budgetShare: 0.814,
        tokensPerSecond: 9.1,
        tag: { kind: 'slow', label: 'Slow' },
      }),
      row('gpt-oss:20b', 'GPT-OSS 20B', 13793441427, '13.8', { needGb: '26.6', budgetShare: 0.709, speed: 'unknown' }),
      row('qwen3.5:9b', 'Qwen3.5 9B', 6550825373, '6.6', {
        needGb: '17.0',
        budgetShare: 0.25,
        tokensPerSecond: 28.6,
        tag: { kind: 'small', label: 'Small model' },
      }),
    ],
    budgetBytes: 37580963840,
    budgetGb: '37.6',
    budgetSource: 'estimated',
  },
  catalogUpdated: '2026-11-06',
  install: {
    state: 'idle',
    running: false,
    developerTools: 'present',
    runtime: { version: '0.40.15', installed: false, downloadBytes: RUNTIME, downloadGb: '0.2', unpackedGb: '0.6' },
    folder: '/Users/sam/.codeman/local-model',
    library: [],
    actions: ['install'],
  },
};

const libraryRow = (id: string, label: string, sizeGb: string, over: object = {}) => ({
  id,
  label,
  context: 131072,
  sizeBytes: Number(sizeGb) * 1e9,
  sizeGb,
  active: false,
  verified: true,
  status: 'ready',
  actions: ['use', 'delete'],
  ...over,
});

/** An installed model with two more models beside it: one checked, one the runtime lists and Codeman never checked. */
const INSTALLED = {
  ...STATUS,
  install: {
    ...STATUS.install,
    state: 'installed',
    running: true,
    runtime: { version: '0.40.15', installed: true, downloadBytes: 0, downloadGb: '0.0', unpackedGb: '0.6' },
    model: { id: 'qwen3.6:35b-a3b', label: 'Qwen3.6 35B-A3B' },
    cli: 'opencode',
    cliLabel: 'OpenCode',
    context: 131072,
    port: 11435,
    endpointId: 'local-ollama',
    loaded: { context: 131072, memoryBytes: 26300000000, memoryGb: '26.3', onGpu: true },
    library: [
      libraryRow('qwen3.6:35b-a3b', 'Qwen3.6 35B-A3B', '23.1', { active: true, actions: [] }),
      libraryRow('qwen3.8:27b-mtp-q4_k_m', 'Qwen3.8 27B', '17.7'),
      libraryRow('mimo-v2.6:9b-q4_k_m', 'MiMo V2.6 9B', '6.6', {
        context: undefined,
        verified: false,
        status: 'unverified',
        actions: ['delete'],
      }),
    ],
    store: { bytes: 47400000000, gb: '47.4' },
    actions: ['start-session', 'stop', 'install', 'use', 'delete-model', 'remove'],
  },
};

type Box = { left: number; right: number; top: number; bottom: number; width: number; height: number };

/** What the page holds once the module ran on the stand-in class. */
interface PageApp {
  _api: () => Promise<unknown>;
  loadLocalModel(): Promise<void>;
  openLocalModelWindow(): void;
}
type PageWindow = { CodemanApp: new () => PageApp; app: PageApp };

describe('the local model window (real Chromium)', () => {
  let browser: Browser;
  let p: Page;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser.close();
  });
  afterEach(async () => {
    await p?.close();
  });

  it('runs on the real page with both stylesheets in it', () => {
    expect(MARKUP).toContain('id="localModelModal"');
    expect(MARKUP.includes('<script')).toBe(false);
    expect(PAGE.includes('.lm-bar-fill {')).toBe(true);
    expect(PAGE.includes('<style media="(max-width: 1023px)">')).toBe(true);
    expect(PAGE.includes('href="styles.css"')).toBe(false);
  });

  /** The real page at a width, the module loaded, the answer in, the window closed. */
  async function load(width: number, height = 900, answer: object = STATUS) {
    p = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    // No motion: the bar is at its width as soon as it is painted, so nothing here waits on a clock.
    await p.emulateMedia({ reducedMotion: 'reduce' });
    await p.route('**/*', (route) =>
      route.request().url() === ORIGIN
        ? route.fulfill({ contentType: 'text/html', body: PAGE })
        : route.fulfill({ status: 404, body: '' })
    );
    await p.goto(ORIGIN);
    await p.addScriptTag({ content: `function CodemanApp() {}\n${read('local-model-ui.js')}` });
    await p.evaluate(async (status) => {
      const w = window as unknown as PageWindow;
      document.body.classList.add('app-loaded');
      document.getElementById('welcomeOverlay')!.classList.add('visible');
      w.app = new w.CodemanApp();
      w.app._api = async () => ({ ok: true, status: 200, json: async () => ({ success: true, data: status }) });
      await w.app.loadLocalModel();
    }, answer);
  }

  /** Two animation frames: whatever was just written is laid out and painted. */
  const painted = () =>
    p.evaluate(() => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))));

  async function open() {
    await p.evaluate(() => (window as unknown as PageWindow).app.openLocalModelWindow());
    await painted();
  }

  const boxes = (selector: string) =>
    p.evaluate(
      (sel) =>
        [...document.querySelectorAll(sel)].map((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
        }),
      selector
    ) as Promise<Box[]>;

  const same = (values: number[]) => Math.max(...values) - Math.min(...values) <= 0.6;

  it('shows the welcome button only once the server answered for a Mac', async () => {
    p = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
    await p.route('**/*', (route) =>
      route.request().url() === ORIGIN
        ? route.fulfill({ contentType: 'text/html', body: PAGE })
        : route.fulfill({ status: 404, body: '' })
    );
    await p.goto(ORIGIN);
    // As shipped: `hidden`, and really not laid out although the chip class is inline-flex.
    expect(await p.evaluate(() => getComputedStyle(document.getElementById('welcomeLocalModelBtn')!).display)).toBe(
      'none'
    );
    await p.close();
    await load(1440);
    const [button] = await boxes('#welcomeLocalModelBtn');
    expect(button.width).toBeGreaterThan(100);
    // The first thing on the start screen, in the size of the primary launcher below it.
    expect(Math.round(button.height)).toBe(46);
    expect(await p.textContent('#welcomeLocalModelLabel')).toBe('Run a local model');
  });

  it('lines the numbers up down the list on a desktop, one line a row', async () => {
    await load(1440);
    await open();
    const rows = await boxes('.lm-models .lm-model');
    expect(rows).toHaveLength(4);
    const names = await boxes('.lm-model-name');
    const tags = await boxes('.lm-model-tag');
    const speeds = await boxes('.lm-model-speed');
    const sizes = await boxes('.lm-model-size');
    // Every number ends on the same edge, and every tag starts on the same edge.
    expect(same(sizes.map((box) => box.right))).toBe(true);
    expect(same(speeds.map((box) => box.right))).toBe(true);
    expect(same(tags.map((box) => box.left))).toBe(true);
    expect(same(names.map((box) => box.left))).toBe(true);
    // The captions sit over their columns.
    const [speedCaption] = await boxes('.lm-caption-speed');
    const [sizeCaption] = await boxes('.lm-caption-size');
    expect(same([speedCaption.right, speeds[0].right])).toBe(true);
    expect(same([sizeCaption.right, sizes[0].right])).toBe(true);
    // One line: name, tag, speed and size share a row's middle.
    for (let i = 0; i < rows.length; i++) {
      const middle = (box: Box) => (box.top + box.bottom) / 2;
      expect(Math.abs(middle(names[i]) - middle(sizes[i]))).toBeLessThan(3);
      expect(Math.abs(middle(names[i]) - middle(speeds[i]))).toBeLessThan(3);
      expect(names[i].right).toBeLessThanOrEqual(tags[i].left + 0.6);
      expect(speeds[i].right).toBeLessThanOrEqual(sizes[i].left + 0.6);
    }
    // The memory panel lines up with the rows on both edges, and the bar with its figure.
    const [figure] = await boxes('.lm-figure');
    const [radio] = await boxes('.lm-radio');
    const [bar] = await boxes('.lm-bar');
    const [meter] = await boxes('.lm-meter');
    expect(same([figure.left, bar.left])).toBe(true);
    expect(same([meter.left, radio.left])).toBe(true);
    expect(same([meter.right, sizes[0].right])).toBe(true);
  });

  it('fills the bar to the selected model, and the fill follows the selection', async () => {
    await load(1440);
    await open();
    const share = async () => {
      const [track] = await boxes('.lm-bar');
      const [fill] = await boxes('.lm-bar-fill');
      expect(Math.round(track.height)).toBe(12);
      expect(Math.round(fill.height)).toBe(12);
      expect(same([track.left, fill.left])).toBe(true);
      return fill.width / track.width;
    };
    // The pick is a tight fit: the bar is nearly full, and a sliver of the track still shows.
    expect(await share()).toBeCloseTo(0.96, 2);
    await p.click('.lm-models .lm-model:nth-child(4)');
    await painted();
    expect(await share()).toBeCloseTo(0.25, 2);
    await p.keyboard.press('ArrowUp');
    await painted();
    expect(await share()).toBeCloseTo(0.71, 2);
    // The fill moves over a short moment, and stands still for a reader who wants no motion.
    const duration = () =>
      p.evaluate(() => getComputedStyle(document.querySelector('.lm-bar-fill')!).transitionDuration);
    expect(await duration()).toBe('0s');
    await p.emulateMedia({ reducedMotion: 'no-preference' });
    expect(await duration()).toBe('0.32s');
    await p.emulateMedia({ reducedMotion: 'reduce' });
    // The track is not the window's own colour, or the free part could not be seen.
    const paint = await p.evaluate(() => {
      const css = (sel: string, prop: string) => getComputedStyle(document.querySelector(sel)!).getPropertyValue(prop);
      // The feature's colour as the browser paints it: a custom property reads back unresolved.
      const probe = document.body.appendChild(document.createElement('i'));
      probe.style.color = 'var(--lm-brand)';
      const brand = getComputedStyle(probe).color;
      probe.remove();
      return {
        brand,
        track: css('.lm-bar', 'background-color'),
        fillImage: css('.lm-bar-fill', 'background-image'),
        window: css('.local-model-window', 'background-color'),
        edge: css('.lm-model-on', 'border-left-color'),
        idleEdge: css('.lm-model:not(.lm-model-on)', 'border-left-color'),
      };
    });
    expect(paint.track).not.toBe(paint.window);
    expect(paint.track).not.toBe(paint.brand);
    // Without a memory map the one fill runs from the feature's colour to the context's.
    expect(paint.fillImage).toContain('linear-gradient');
    // The selected row carries the feature's colour on its reading edge.
    expect(paint.edge).toBe(paint.brand);
    expect(paint.idleEdge).not.toBe(paint.brand);
  });

  it('stacks two lines a row under 560px, with nothing running off the side', async () => {
    await load(390, 844);
    await open();
    const names = await boxes('.lm-model-name');
    const tags = await boxes('.lm-model-tag');
    const speeds = await boxes('.lm-model-speed');
    const sizes = await boxes('.lm-model-size');
    for (let i = 0; i < names.length; i++) {
      // Name and tag, then speed and size.
      expect(speeds[i].top).toBeGreaterThanOrEqual(names[i].bottom - 1);
      expect(sizes[i].top).toBeGreaterThanOrEqual(names[i].bottom - 1);
      expect(tags[i].top).toBeLessThan(names[i].bottom);
      expect(same([names[i].left, speeds[i].left])).toBe(true);
    }
    expect(same(sizes.map((box) => box.right))).toBe(true);
    // The window fills the phone, the bar and the button take its width, and nothing overflows.
    const [win] = await boxes('.local-model-window');
    expect(Math.round(win.width)).toBe(390);
    expect(Math.round(win.height)).toBe(844);
    const [meter] = await boxes('.lm-meter');
    const [button] = await boxes('.lm-buttons button');
    expect(same([meter.left, button.left])).toBe(true);
    expect(same([meter.right, button.right])).toBe(true);
    expect(button.height).toBeGreaterThanOrEqual(44);
    const overflow = await p.evaluate(() => {
      const body = document.getElementById('localModelWindowBody')!;
      return body.scrollWidth - body.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
  });

  it('the models on this Mac: sizes on one edge, a row one line, its buttons on the list edge', async () => {
    await load(1440, 900, INSTALLED);
    await open();
    const rows = await boxes('.lm-lib-row');
    expect(rows).toHaveLength(3);
    const names = await boxes('.lm-lib-name');
    const tags = await boxes('.lm-lib-tag');
    const sizes = await boxes('.lm-lib-size');
    const [caption] = await boxes('.lm-lib-caption-size');
    expect(same(sizes.map((box) => box.right))).toBe(true);
    expect(same([caption.right, sizes[0].right])).toBe(true);
    expect(same(names.map((box) => box.left))).toBe(true);
    expect(same(tags.map((box) => box.left))).toBe(true);
    // One line a row: the name, the tag, the size and the buttons share its middle.
    const middle = (box: Box) => (box.top + box.bottom) / 2;
    const actions = await boxes('.lm-lib-row .lm-lib-actions');
    for (let i = 0; i < rows.length; i++) {
      expect(Math.abs(middle(names[i]) - middle(sizes[i]))).toBeLessThan(3);
      expect(Math.abs(middle(tags[i]) - middle(sizes[i]))).toBeLessThan(3);
      expect(names[i].right).toBeLessThanOrEqual(tags[i].left + 0.6);
      expect(sizes[i].right).toBeLessThanOrEqual(actions[i].left + 0.6);
    }
    // The last button of a row ends where every line of the window ends: on "Add a model"'s edge.
    const rowButtons = await boxes('.lm-lib-row .lm-lib-actions button:last-child');
    const [add] = await boxes('.lm-lib-foot button');
    expect(same([...rowButtons.map((box) => box.right), add.right])).toBe(true);
    // The model in use carries the feature's colour on its reading edge; the others do not.
    const paint = await p.evaluate(() => {
      const probe = document.body.appendChild(document.createElement('i'));
      probe.style.color = 'var(--lm-brand)';
      const brand = getComputedStyle(probe).color;
      probe.remove();
      const edge = (sel: string) => getComputedStyle(document.querySelector(sel)!).borderLeftColor;
      return { brand, on: edge('.lm-lib-row-on'), off: edge('.lm-lib-row:not(.lm-lib-row-on)') };
    });
    expect(paint.on).toBe(paint.brand);
    expect(paint.off).not.toBe(paint.brand);
    // The screen starts at the top of the frame, right under the header.
    const [body] = await boxes('#localModelWindowBody');
    const [title] = await boxes('.lm-title');
    expect(title.top - body.top).toBeLessThan(40);
  });

  it('the Delete question opens under its row without moving the sizes', async () => {
    await load(1440, 900, INSTALLED);
    await open();
    const before = await boxes('.lm-lib-size');
    await p.click('.lm-lib-row:nth-of-type(3) .lm-lib-actions button:last-child');
    await painted();
    const [ask] = await boxes('.lm-lib-ask');
    const rows = await boxes('.lm-lib-row');
    const after = await boxes('.lm-lib-size');
    // Sideways nothing moved; the rows after the question moved down by it.
    expect(after.map((box) => Math.round(box.right))).toEqual(before.map((box) => Math.round(box.right)));
    expect(ask.top).toBeGreaterThanOrEqual(rows[1].bottom - 1);
    expect(rows[2].top).toBeGreaterThanOrEqual(ask.bottom - 1);
    // The row's own buttons are unseen while it is asked about, and the red button is the question's.
    const seen = await p.evaluate(() => ({
      away: getComputedStyle(document.querySelector('.lm-lib-actions-away')!).visibility,
      red: [...document.querySelectorAll('.local-model-window .wt-btn-danger')].map((el) => el.textContent),
      focus: document.activeElement?.textContent,
    }));
    expect(seen).toEqual({ away: 'hidden', red: ['Delete'], focus: 'Cancel' });
  });

  it('a long list of models scrolls from its top: the first lines are never cut off above the frame', async () => {
    const many = Array.from({ length: 14 }, (_unused, i) => libraryRow(`model-${i}:9b`, `Model ${i}`, '6.6'));
    const answer = {
      ...INSTALLED,
      install: { ...INSTALLED.install, library: [...INSTALLED.install.library, ...many] },
    };
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
    ]) {
      await load(width, height, answer);
      await open();
      const scroll = await p.evaluate(() => {
        const body = document.getElementById('localModelWindowBody')!;
        const title = body.querySelector('.lm-title')!.getBoundingClientRect();
        const box = body.getBoundingClientRect();
        return {
          overflows: body.scrollHeight > body.clientHeight,
          top: body.scrollTop,
          titleInside: title.top >= box.top - 0.5,
          sideways: body.scrollWidth - body.clientWidth,
        };
      });
      expect(scroll).toEqual({ overflows: true, top: 0, titleInside: true, sideways: 0 });
      // The buttons of the screen stay in the frame's foot, under the part that scrolls.
      const [foot] = await boxes('#localModelWindowFoot');
      const [win] = await boxes('.local-model-window');
      expect(foot.bottom).toBeLessThanOrEqual(win.bottom + 0.6);
      await p.close();
    }
  });

  it('the models on this Mac under 560px: two lines a row, nothing off the side', async () => {
    await load(390, 844, INSTALLED);
    await open();
    const names = await boxes('.lm-lib-name');
    const tags = await boxes('.lm-lib-tag');
    const sizes = await boxes('.lm-lib-size');
    for (let i = 0; i < names.length; i++) {
      // The name and its size, then the state and what can be done.
      expect(tags[i].top).toBeGreaterThanOrEqual(names[i].bottom - 1);
      expect(sizes[i].top).toBeLessThan(names[i].bottom);
      expect(same([names[i].left, tags[i].left])).toBe(true);
    }
    expect(same(sizes.map((box) => box.right))).toBe(true);
    const buttons = await boxes('.lm-lib-row .lm-lib-actions button');
    for (const button of buttons) expect(button.height).toBeGreaterThanOrEqual(36);
    const overflow = await p.evaluate(() => {
      const body = document.getElementById('localModelWindowBody')!;
      return body.scrollWidth - body.clientWidth;
    });
    expect(overflow).toBeLessThanOrEqual(0);
  });

  it('the coding agents: chips that wrap inside the window at every width, the install command included', async () => {
    const agents = [
      { cli: 'opencode', cliLabel: 'OpenCode', default: true, status: 'ready', actions: ['start-session'] },
      {
        cli: 'claude',
        cliLabel: 'Claude Code',
        default: false,
        status: 'ready',
        slowFirstTurn: true,
        actions: ['start-session'],
      },
      {
        cli: 'pi',
        cliLabel: 'Pi',
        default: false,
        status: 'installable',
        installCommand: 'npm install -g --ignore-scripts @earendil-works/pi-coding-agent',
        actions: ['install'],
      },
      { cli: 'deepseek', cliLabel: 'DeepSeek', default: false, status: 'setup-needed', actions: [] },
    ];
    const answer = {
      ...INSTALLED,
      install: {
        ...INSTALLED.install,
        harnesses: agents,
        actions: [...INSTALLED.install.actions, 'install-agent'],
      },
    };
    for (const [width, height] of [
      [1440, 900],
      [390, 844],
      [320, 640],
    ]) {
      await load(width, height, answer);
      await open();
      // The agent that is not on this Mac: its command is the longest line of the block.
      await p.locator('.lm-agent', { hasText: 'Pi' }).click();
      const seen = await p.evaluate(() => {
        const frame = document.querySelector('.local-model-window')!.getBoundingClientRect();
        const body = document.getElementById('localModelWindowBody')!;
        const outside = [...document.querySelectorAll('.lm-agent, .lm-agents .lm-command, .lm-buttons button')]
          .map((el) => el.getBoundingClientRect())
          .filter((box) => box.width > 0 && (box.left < frame.left - 0.5 || box.right > frame.right + 0.5)).length;
        const chips = [...document.querySelectorAll<HTMLElement>('.lm-agent')];
        return {
          chips: chips.length,
          outside,
          sideways: body.scrollWidth - body.clientWidth,
          checked: document.querySelector('.lm-agent[aria-checked="true"] .lm-agent-name')!.textContent,
          tabStops: chips.filter((chip) => chip.tabIndex === 0).length,
          main: document.querySelector('.lm-buttons .wt-btn-primary')!.textContent,
        };
      });
      expect(seen, `${width}px`).toEqual({
        chips: 4,
        outside: 0,
        sideways: 0,
        checked: 'Pi',
        tabStops: 1,
        main: 'Install Pi',
      });
    }
  });

  it('paints above App Settings when it is opened from there', async () => {
    await load(1440);
    await p.evaluate(() => document.getElementById('appSettingsModal')!.classList.add('active'));
    await open();
    const top = await p.evaluate(() => {
      const box = document.querySelector('.local-model-window')!.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + 20);
      return !!hit && !!hit.closest('#localModelModal');
    });
    expect(top).toBe(true);
  });
});
