/**
 * @fileoverview The camera housing module (host-cutout.js): what counts as a housing, when the page tells a
 * native wrapper that it may be drawn behind one, what `apply` writes, how the tabs are moved around the
 * housing and when the toolbar takes the box that covers it, the option's switch, and that the page, the
 * build and the stylesheet carry it. The tabs here are a row model (widths, margins, a wrap width); the
 * layout itself is measured in real Chromium (host-cutout.browser.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(publicDir, name), 'utf8');
const buildJs = readFileSync(resolve(import.meta.dirname, '../scripts/build.mjs'), 'utf8');
const shim = readFileSync(resolve(import.meta.dirname, '../packages/desktop/src/assets.rs'), 'utf8');

type Cutout = { left: number; width: number; height: number };
type Api = {
  apply: (cutout: unknown) => boolean;
  normalize: (cutout: unknown) => Cutout | null;
  fits: () => boolean;
  fitTabs: () => boolean;
  option: (state: unknown) => boolean;
  wholeScreen: () => { available: boolean; enabled: boolean } | null;
  setWholeScreen: (on: unknown) => boolean;
  current: () => Cutout | null;
};

/** The MacBook Pro the layout was first seen on (Mac17,13): a housing 59 px wide in a strip 40 px high. */
const NARROW: Cutout = { left: 726.5, width: 59, height: 40 };

type Rect = { left: number; right: number; top: number; bottom: number; width: number; height: number };

/** A 14-inch MacBook Pro at its default scaling. */
const MBP14: Cutout = { left: 663.5, width: 185, height: 32 };

/**
 * Run the module in a page that has `dataset` on <html> and, with `host`, the bridge Codeman Desktop injects.
 * `tabs` are widths: they are laid out the way the strip lays them out, left to right from `stripLeft`, 2 px
 * apart, wrapping to a new row (36 px lower) before `rowRight`, and a margin the module sets moves them like a
 * real one. `toolbarLeft` is where the toolbar's own box begins (null: the header is not parsed yet).
 * Returns the module, what it told the bridge, the root's style and classes, and how to change the layout.
 */
function load(
  options: {
    dataset?: Record<string, string>;
    host?: boolean;
    pathname?: string;
    solo?: string;
    tabs?: number[];
    stripLeft?: number;
    rowRight?: number;
    toolbarLeft?: number | null;
  } = {}
) {
  const calls: unknown[] = [];
  const switched: unknown[] = [];
  const relayouts: string[] = [];
  const props = new Map<string, string>();
  const classes = new Set<string>();
  const dataset: Record<string, string> = {
    sessionList: 'header',
    tabOrientation: 'horizontal',
    tabArrangement: 'classic',
    ...options.dataset,
  };
  let observer: (() => void) | null = null;
  let ready: (() => void) | null = null;
  const documentElement = {
    dataset,
    style: {
      setProperty: (name: string, value: string) => props.set(name, value),
      removeProperty: (name: string) => props.delete(name),
    },
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
      contains: (name: string) => classes.has(name),
      toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)),
    },
  };

  const stripLeft = options.stripLeft ?? 100;
  const rowRight = options.rowRight ?? 1123;
  const px = (value: string | undefined, fallback: number) => (value === undefined ? fallback : parseFloat(value));
  const tabs = (options.tabs ?? []).map((width, index) => ({
    index,
    width,
    margins: new Map<string, string>(),
    rect: null as Rect | null,
  }));
  const layout = () => {
    let x = stripLeft;
    let top = 8;
    for (const tab of tabs) {
      const before = px(tab.margins.get('margin-left'), 0);
      const after = px(tab.margins.get('margin-right'), 2);
      if (x > stripLeft && x + before + tab.width + after > rowRight) {
        x = stripLeft;
        top += 36;
      }
      tab.rect = {
        left: x + before,
        right: x + before + tab.width,
        top,
        bottom: top + 30,
        width: tab.width,
        height: 30,
      };
      x += before + tab.width + after;
    }
  };
  const tabElements = tabs.map((tab) => ({
    model: tab,
    style: {
      setProperty: (name: string, value: string) => tab.margins.set(name, value),
      removeProperty: (name: string) => tab.margins.delete(name),
    },
    getBoundingClientRect: () => {
      layout();
      return tab.rect;
    },
  }));
  const strip = {
    dataset: {} as Record<string, string>,
    querySelectorAll: () => tabElements,
    addEventListener: () => {},
  };
  let toolbarLeft = options.toolbarLeft === undefined ? 1131 : options.toolbarLeft;
  const toolbar = {
    children: [{ offsetWidth: 200 }, { offsetWidth: 120 }],
    getBoundingClientRect: () => ({ left: toolbarLeft ?? 0, width: 1500 - (toolbarLeft ?? 0) }),
  };
  let headerParsed = toolbarLeft !== null;

  const window: Record<string, unknown> = {
    innerWidth: 1512,
    app: {
      // The real one ends by having the module place the tabs (app.js, updateTabOverflowMode).
      updateTabOverflowMode: () => {
        relayouts.push('tabs');
        (window.CodemanHostCutout as Api).fitTabs();
      },
      updateConnectionLines: () => relayouts.push('lines'),
    },
  };
  if (options.solo !== undefined) window.__CODEMAN_SOLO__ = options.solo;
  if (options.host !== false) {
    window.CodemanHost = {
      cutoutReady: (yes: unknown) => calls.push(yes),
      setWholeScreen: (on: unknown) => {
        switched.push(on);
        return true;
      },
    };
  }
  const context = vm.createContext({
    window,
    document: {
      documentElement,
      getElementById: (id: string) => {
        if (id === 'sessionTabs') return headerParsed ? strip : null;
        if (id === 'headerRight') return headerParsed ? toolbar : null;
        return null;
      },
      addEventListener: (type: string, callback: () => void) => {
        if (type === 'DOMContentLoaded') ready = callback;
      },
    },
    location: { pathname: options.pathname ?? '/' },
    getComputedStyle: (element: (typeof tabElements)[number]) => ({
      getPropertyValue: (name: string) => element.model.margins.get(name) ?? (name === 'margin-right' ? '2px' : '0px'),
    }),
    MutationObserver: class {
      constructor(callback: () => void) {
        observer = callback;
      }
      observe(target: unknown, init: { attributeFilter: string[] }) {
        expect(target).toBe(documentElement);
        expect(init.attributeFilter).toEqual(['data-tab-arrangement', 'data-session-list', 'data-tab-orientation']);
      }
    },
  });
  vm.runInContext(read('host-cutout.js'), context, { filename: 'host-cutout.js' });
  return {
    api: window.CodemanHostCutout as Api,
    window,
    calls,
    switched,
    relayouts,
    props,
    classes,
    /** Where each tab is now: `[left, right, top]`. */
    places() {
      layout();
      return tabs.map((tab) => [tab.rect!.left, tab.rect!.right, tab.rect!.top]);
    },
    /** The margins the module set, by tab index. */
    margins() {
      return Object.fromEntries(
        tabs.filter((tab) => tab.margins.size).map((tab) => [tab.index, Object.fromEntries(tab.margins)])
      );
    },
    /** Change the layout the way the settings do, and let the observer see it. */
    setLayout(change: Record<string, string>) {
      Object.assign(dataset, change);
      observer?.();
    },
    /** The header arrives, as when the parser reaches <body>, with its toolbar beginning at `left`. */
    parseHeader(left: number) {
      toolbarLeft = left;
      headerParsed = true;
      ready?.();
    },
  };
}

describe('camera housing: what counts as one', () => {
  it('takes three finite, positive numbers', () => {
    const { api } = load();
    expect(api.normalize(MBP14)).toEqual(MBP14);
    expect(api.normalize({ left: '663.5', width: '185', height: '32' })).toEqual(MBP14);
    expect(api.normalize({ left: 0, width: 200, height: 38 })).toEqual({ left: 0, width: 200, height: 38 });
  });

  it('refuses anything else, so a bad message can never empty the header', () => {
    const { api } = load();
    for (const bad of [
      null,
      undefined,
      'notch',
      42,
      {},
      { left: 663 },
      { left: NaN, width: 185, height: 32 },
      { left: 663, width: Infinity, height: 32 },
      { left: -1, width: 185, height: 32 },
      { left: 663, width: 0, height: 32 },
      { left: 663, width: 185, height: 0 },
      { left: 663, width: 185, height: 900 },
    ]) {
      expect(api.normalize(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('camera housing: laying the header out around it', () => {
  it('writes the housing to <html> and has the tab strip measure the toolbar again', () => {
    const page = load();
    expect(page.api.apply(MBP14)).toBe(true);
    expect(Object.fromEntries(page.props)).toEqual({
      '--host-cutout-left': '663.5px',
      '--host-cutout-width': '185px',
      '--host-cutout-height': '32px',
    });
    expect([...page.classes]).toEqual(['host-cutout']);
    expect(page.api.current()).toEqual(MBP14);
    expect(page.relayouts).toEqual(['tabs', 'lines']);
  });

  it('does nothing for the housing it already has', () => {
    const page = load();
    page.api.apply(MBP14);
    page.relayouts.length = 0;
    expect(page.api.apply({ ...MBP14 })).toBe(true);
    expect(page.relayouts).toEqual([]);
  });

  it('puts everything back when the housing is gone', () => {
    const page = load();
    page.api.apply(MBP14);
    page.relayouts.length = 0;
    expect(page.api.apply(null)).toBe(true);
    expect(page.props.size).toBe(0);
    expect(page.classes.size).toBe(0);
    expect(page.api.current()).toBeNull();
    expect(page.relayouts).toEqual(['tabs', 'lines']);
  });

  it('treats a housing that is not a rectangle as none', () => {
    const page = load();
    page.api.apply(MBP14);
    page.api.apply({ left: 663, width: -4, height: 32 });
    expect(page.classes.size).toBe(0);
    expect(page.props.size).toBe(0);
  });

  it('follows the housing to another display', () => {
    const page = load();
    page.api.apply(MBP14);
    page.api.apply({ left: 771.5, width: 185, height: 32 });
    expect(page.props.get('--host-cutout-left')).toBe('771.5px');
    expect([...page.classes]).toEqual(['host-cutout']);
  });

  it('works before the app exists (the module runs in <head>)', () => {
    const calls: unknown[] = [];
    const props = new Map<string, string>();
    const window: Record<string, unknown> = { CodemanHost: { cutoutReady: (r: unknown) => calls.push(r) } };
    const context = vm.createContext({
      window,
      document: {
        documentElement: {
          dataset: {},
          style: { setProperty: (n: string, v: string) => props.set(n, v), removeProperty: () => {} },
          classList: { add: () => {}, remove: () => {}, contains: () => false, toggle: () => {} },
        },
        getElementById: () => null,
        addEventListener: () => {},
      },
      location: { pathname: '/' },
    });
    vm.runInContext(read('host-cutout.js'), context, { filename: 'host-cutout.js' });
    expect(calls).toEqual([true]);
    expect((window.CodemanHostCutout as Api).apply(MBP14)).toBe(true);
    expect(props.get('--host-cutout-width')).toBe('185px');
  });
});

describe('camera housing: telling the app whether the page may be drawn behind it', () => {
  it('says yes once for the classic strip, the sidebar and the rail', () => {
    expect(load().calls).toEqual([true]);
    expect(load({ dataset: { sessionList: 'sidebar' } }).calls).toEqual([true]);
    expect(load({ dataset: { tabOrientation: 'vertical' } }).calls).toEqual([true]);
  });

  it('says no while the tabs are grouped in the header strip', () => {
    for (const tabArrangement of ['state', 'case', 'ledger']) {
      const page = load({ dataset: { tabArrangement } });
      expect(page.calls, tabArrangement).toEqual([false]);
      expect(page.api.fits()).toBe(false);
    }
  });

  it('says yes for grouped tabs that are not in the header', () => {
    expect(load({ dataset: { tabArrangement: 'state', sessionList: 'sidebar' } }).calls).toEqual([true]);
    expect(load({ dataset: { tabArrangement: 'ledger', tabOrientation: 'vertical' } }).calls).toEqual([true]);
  });

  it('says yes in a solo window, which has no tab strip, under any base path', () => {
    expect(load({ dataset: { tabArrangement: 'state' }, pathname: '/session/abc' }).calls).toEqual([true]);
    expect(load({ dataset: { tabArrangement: 'state' }, pathname: '/codeman/session/abc/' }).calls).toEqual([true]);
    expect(load({ dataset: { tabArrangement: 'state' }, solo: 'abc' }).calls).toEqual([true]);
    // A dashboard URL that only mentions the word is not one.
    expect(load({ dataset: { tabArrangement: 'state' }, pathname: '/session/' }).calls).toEqual([false]);
  });

  it('says so again when the layout changes, and only then', () => {
    const page = load();
    page.setLayout({ tabArrangement: 'classic' });
    expect(page.calls).toEqual([true]);
    page.setLayout({ tabArrangement: 'state' });
    page.setLayout({ tabArrangement: 'case' });
    expect(page.calls).toEqual([true, false]);
    page.setLayout({ tabOrientation: 'vertical' });
    expect(page.calls).toEqual([true, false, true]);
  });

  it('drops the layout at once when it stops fitting, without waiting for the app', () => {
    const page = load();
    page.api.apply(MBP14);
    page.setLayout({ tabArrangement: 'state' });
    expect(page.classes.size).toBe(0);
    expect(page.props.size).toBe(0);
    expect(page.api.current()).toBeNull();
  });

  it('ignores a housing the app sent before it heard the no', () => {
    const page = load({ dataset: { tabArrangement: 'ledger' } });
    expect(page.api.apply(MBP14)).toBe(true);
    expect(page.classes.size).toBe(0);
    expect(page.api.current()).toBeNull();
  });

  it('is silent in a browser tab, where nothing is ever drawn behind a housing', () => {
    const page = load({ host: false });
    expect(page.calls).toEqual([]);
    expect(page.classes.size).toBe(0);
    expect(typeof page.api.apply).toBe('function');
  });
});

describe('camera housing: the tabs go around it', () => {
  // Five tabs of 150 px from x = 100, 2 px apart: 100-250, 252-402, 404-554, 556-706, 708-858.
  // The housing with its 8 px of air on each side is 718.5 to 793.5.
  const FIVE = [150, 150, 150, 150, 150];

  it('starts the tab that would sit under the housing just right of it', () => {
    const page = load({ tabs: FIVE });
    page.api.apply(NARROW);
    // The room is the right margin of the tab before it: 2 px of its own plus 793.5 - 708, rounded up.
    expect(page.margins()).toEqual({ 3: { 'margin-right': '88px' } });
    expect(page.places()).toEqual([
      [100, 250, 8],
      [252, 402, 8],
      [404, 554, 8],
      [556, 706, 8],
      [794, 944, 8],
    ]);
  });

  it('leaves a row alone that the housing does not reach', () => {
    const page = load({ tabs: [150, 150, 150, 150] });
    page.api.apply(NARROW);
    expect(page.margins()).toEqual({});
  });

  it('wraps a tab that no longer fits right of the housing, flush left', () => {
    // The row ends at 900: 794 + 150 does not fit before it.
    const page = load({ tabs: FIVE, rowRight: 900 });
    page.api.apply(NARROW);
    expect(page.places()[4]).toEqual([100, 250, 44]);
    // The margin is the fourth tab's, so the wrapped one carries no indent.
    expect(page.margins()).toEqual({ 3: { 'margin-right': '88px' } });
  });

  it('moves the first tab of a row by its own margin, having no tab before it', () => {
    const page = load({ tabs: [150, 150], stripLeft: 700 });
    page.api.apply(NARROW);
    expect(page.margins()).toEqual({ 0: { 'margin-left': '94px' } });
    expect(page.places()[0]).toEqual([794, 944, 8]);
  });

  it('clears every row beside a tall housing, and none below it', () => {
    // Rows at 8 and 44 are beside a housing 60 px high, the one at 80 is not.
    const tabs = Array.from({ length: 18 }, () => 150);
    const page = load({ tabs });
    page.api.apply({ ...NARROW, height: 60 });
    const under = page.places().filter(([left, right, top]) => top < 60 && right > 718.5 && left < 793.5);
    expect(under).toEqual([]);
    const third = page.places().filter(([, , top]) => top === 80);
    expect(third.some(([left, right]) => right > 718.5 && left < 793.5)).toBe(true);
  });

  it('says whether a pass moved anything, so the lineage lines are only redrawn when one did', () => {
    const page = load({ tabs: FIVE });
    page.api.apply(NARROW);
    expect(page.api.fitTabs()).toBe(false);
    expect(page.margins()).toEqual({ 3: { 'margin-right': '88px' } });
  });

  it('follows the tabs: a wider fourth tab reaches the housing itself and is the one that moves', () => {
    // A selected tab is wider (its gear and close show): 556 + 170 passes 718.5.
    const page = load({ tabs: [150, 150, 150, 170, 150] });
    page.api.apply(NARROW);
    expect(page.margins()).toEqual({ 2: { 'margin-right': '240px' } });
    expect(page.places()[3]).toEqual([794, 964, 8]);
    // The fifth follows it in the row, with nothing under the housing.
    expect(page.places()[4]).toEqual([966, 1116, 8]);
  });

  it('takes its margins back when the housing is gone', () => {
    const page = load({ tabs: FIVE });
    page.api.apply(NARROW);
    page.api.apply(null);
    expect(page.margins()).toEqual({});
    expect(page.places()[4]).toEqual([708, 858, 8]);
  });

  it('adds nothing to the strip and never reorders it', () => {
    const source = read('host-cutout.js');
    expect(source).not.toMatch(/createElement|insertBefore|appendChild|\.order\b/);
  });
});

describe('camera housing: the toolbar', () => {
  it('stays as it is when it ends right of the housing', () => {
    const page = load({ toolbarLeft: 1131 });
    page.api.apply(NARROW);
    expect([...page.classes]).toEqual(['host-cutout']);
  });

  it('takes the box that covers the housing when it would reach it', () => {
    // 793 is inside the 8 px of air right of the housing (793.5).
    const page = load({ toolbarLeft: 793 });
    page.api.apply(NARROW);
    expect([...page.classes].sort()).toEqual(['host-cutout', 'host-cutout-toolbar']);
    page.api.apply(null);
    expect(page.classes.size).toBe(0);
  });

  it('always takes it in a solo window, whose title shares the row', () => {
    const page = load({ pathname: '/session/abc', toolbarLeft: 1131 });
    page.api.apply(NARROW);
    expect(page.classes.has('host-cutout-toolbar')).toBe(true);
  });

  it('covers the housing until the header can be measured, then decides', () => {
    const page = load({ toolbarLeft: null });
    page.api.apply(NARROW);
    expect(page.classes.has('host-cutout-toolbar')).toBe(true);
    page.parseHeader(1131);
    expect([...page.classes]).toEqual(['host-cutout']);
  });
});

describe('camera housing: the option in App Settings', () => {
  it('knows nothing until the app says, and then what the app said', () => {
    const page = load();
    expect(page.api.wholeScreen()).toBeNull();
    expect(page.api.option({ available: true, enabled: true })).toBe(true);
    expect(page.api.wholeScreen()).toEqual({ available: true, enabled: true });
    page.api.option({ available: 'yes', enabled: 1 });
    expect(page.api.wholeScreen()).toEqual({ available: false, enabled: false });
    page.api.option(null);
    expect(page.api.wholeScreen()).toBeNull();
  });

  it('has the settings page show it as soon as the app says', () => {
    const page = load();
    let synced = 0;
    (page.window.app as Record<string, unknown>).syncHostWholeScreenSetting = () => synced++;
    page.api.option({ available: true, enabled: false });
    expect(synced).toBe(1);
  });

  it('turns it on and off in the app, and only with a plain true', () => {
    const page = load();
    expect(page.api.setWholeScreen(true)).toBe(true);
    expect(page.api.setWholeScreen('true')).toBe(true);
    expect(page.api.setWholeScreen(false)).toBe(true);
    expect(page.switched).toEqual([true, false, false]);
  });

  it('says there is no app to tell in a browser tab', () => {
    const page = load({ host: false });
    expect(page.api.setWholeScreen(true)).toBe(false);
  });
});

describe('camera housing: wiring', () => {
  const html = read('index.html');
  const css = read('styles.css');

  it('loads in <head>, not deferred, after the layout attributes are written', () => {
    const tag = '<script src="host-cutout.js"></script>';
    const at = html.indexOf(tag);
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(html.indexOf('</head>'));
    // The pre-paint script that writes data-tab-arrangement and its two siblings comes first: `fits()` reads them.
    expect(at).toBeGreaterThan(html.indexOf('document.documentElement.dataset.tabArrangement='));
    expect(html).not.toContain('<script defer src="host-cutout.js">');
  });

  it('is minified and content-hashed by the build', () => {
    expect(buildJs).toContain("run('minify host-cutout.js'");
    expect(buildJs).toMatch(/HASHABLE[\s\S]{0,1500}'host-cutout\.js'/);
  });

  it('speaks the bridge Codeman Desktop injects', () => {
    // packages/desktop/src/assets.rs (HOST_SHIM) and policy.rs (RawHost::CutoutReady).
    expect(shim).toContain("cutoutReady: function (ready) { post({ cmd: 'cutoutReady', ready: ready !== false }); }");
    expect(read('host-cutout.js')).toContain('window.CodemanHost.cutoutReady(ready)');
  });

  it('gives a toolbar that would reach the housing a box that covers it', () => {
    const rule = /html\.host-cutout-toolbar \.header > \.header-right \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('width: calc(100vw - 0.75rem - var(--host-cutout-left) + var(--host-cutout-gap));');
    expect(rule).toContain('padding-left: calc(var(--host-cutout-width) + 2 * var(--host-cutout-gap));');
    expect(rule).toContain('flex-wrap: wrap;');
    expect(rule).toContain('box-sizing: border-box;');
    // 0.75rem is the header's own side padding: the two must change together.
    expect(/\n\.header \{[^}]*padding: 0\.35rem 0\.75rem;/.test(css)).toBe(true);
    // And the gap is the module's GAP.
    expect(css).toMatch(/html\.host-cutout \{\s*--host-cutout-gap: 8px;/);
    expect(read('host-cutout.js')).toContain('const GAP = 8;');
  });

  it('lets that box win over a toolbar width the user chose, and hides the handle that sets it', () => {
    expect(css).toMatch(
      /html\[data-header-right-width\]:not\(\.host-cutout-toolbar\):not\(\[data-tab-orientation='vertical'\]\)/
    );
    expect(css).toMatch(/html\.host-cutout-toolbar \.header-divider \{\s*display: none;/);
    // A toolbar that ends right of the housing keeps the user's width and the handle.
    expect(css).not.toMatch(/html\.host-cutout \.header-divider/);
    expect(css).not.toMatch(/html\.host-cutout \.header > \.header-right/);
  });

  it('has the tab strip place the tabs once its row mode is decided, and before one row is measured', () => {
    const app = read('app.js');
    const mode = /\n  updateTabOverflowMode\(\) \{([\s\S]*?)\n  \}/.exec(app)?.[1] ?? '';
    expect(mode.indexOf('this._syncTabStripCorner(container);')).toBeGreaterThan(-1);
    expect(mode.indexOf('window.CodemanHostCutout?.fitTabs?.(container);')).toBeGreaterThan(
      mode.indexOf('this._syncTabStripCorner(container);')
    );
    const decide = /\n  _decideTabOverflow\(container\) \{([\s\S]*?)\n  \}/.exec(app)?.[1] ?? '';
    const fit = decide.lastIndexOf('window.CodemanHostCutout?.fitTabs?.(container);');
    expect(fit).toBeGreaterThan(decide.lastIndexOf("container.classList.remove('tabs-auto-wrap');"));
    expect(fit).toBeLessThan(decide.indexOf('scrollWidth: container.scrollWidth'));
  });

  it('has a switch in App Settings that only the Mac app shows, wired to the app and not to the settings blob', () => {
    const html = read('index.html');
    expect(html).toMatch(/<div class="set-group" id="appSettingsHostGroup" style="display: none">/);
    expect(html).toContain('<input type="checkbox" id="appSettingsHostWholeScreen">');
    const ui = read('settings-ui.js');
    expect(ui).toContain("group.style.display = option?.available ? '' : 'none';");
    expect(ui).toContain('window.CodemanHostCutout.setWholeScreen(hostBox.checked);');
    // Never a key of the settings object the page stores and sends to the server.
    expect(ui).not.toMatch(/wholeScreen\s*:/);
    expect(shim).toContain("setWholeScreen: function (on) { return post({ cmd: 'wholeScreen', on: on === true }); }");
  });
});
