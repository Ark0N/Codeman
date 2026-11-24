/**
 * @fileoverview The camera housing module (host-cutout.js): what counts as a housing, when the page tells a
 * native wrapper that it may be drawn behind one, what `apply` writes, and that the page, the build and the
 * stylesheet carry it. The layout itself is measured in real Chromium (host-cutout.browser.test.ts).
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
  current: () => Cutout | null;
};

/** A 14-inch MacBook Pro at its default scaling. */
const MBP14: Cutout = { left: 663.5, width: 185, height: 32 };

/**
 * Run the module in a page that has `dataset` on <html> and, with `host`, the bridge Codeman Desktop injects.
 * Returns the module, what it told the bridge, the root's style and classes, and how to change the layout.
 */
function load(options: { dataset?: Record<string, string>; host?: boolean; pathname?: string; solo?: string } = {}) {
  const calls: unknown[] = [];
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
  const documentElement = {
    dataset,
    style: {
      setProperty: (name: string, value: string) => props.set(name, value),
      removeProperty: (name: string) => props.delete(name),
    },
    classList: {
      add: (name: string) => classes.add(name),
      remove: (name: string) => classes.delete(name),
    },
  };
  const window: Record<string, unknown> = {
    app: {
      updateTabOverflowMode: () => relayouts.push('tabs'),
      updateConnectionLines: () => relayouts.push('lines'),
    },
  };
  if (options.solo !== undefined) window.__CODEMAN_SOLO__ = options.solo;
  if (options.host !== false) window.CodemanHost = { cutoutReady: (ready: unknown) => calls.push(ready) };
  const context = vm.createContext({
    window,
    document: { documentElement },
    location: { pathname: options.pathname ?? '/' },
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
    calls,
    relayouts,
    props,
    classes,
    /** Change the layout the way the settings do, and let the observer see it. */
    setLayout(change: Record<string, string>) {
      Object.assign(dataset, change);
      observer?.();
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
          classList: { add: () => {}, remove: () => {} },
        },
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

  it('lays the toolbar out from the housing in every desktop layout', () => {
    const rule = /html\.host-cutout \.header > \.header-right \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('width: calc(100vw - 0.75rem - var(--host-cutout-left) + var(--host-cutout-gap));');
    expect(rule).toContain('padding-left: calc(var(--host-cutout-width) + 2 * var(--host-cutout-gap));');
    expect(rule).toContain('flex-wrap: wrap;');
    expect(rule).toContain('box-sizing: border-box;');
    // 0.75rem is the header's own side padding: the two must change together.
    expect(/\n\.header \{[^}]*padding: 0\.35rem 0\.75rem;/.test(css)).toBe(true);
  });

  it('wins over a toolbar width the user chose, and hides the handle that sets it', () => {
    expect(css).toMatch(
      /html\[data-header-right-width\]:not\(\.host-cutout\):not\(\[data-tab-orientation='vertical'\]\)/
    );
    expect(css).toMatch(/html\.host-cutout \.header-divider \{\s*display: none;/);
  });
});
