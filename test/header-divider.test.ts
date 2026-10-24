/**
 * @fileoverview The draggable divider at the left edge of the header toolbar: the width clamp keeps the tabs
 * some room, the controller is wired into the page and build, and the stored width is device-local.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const read = (name: string) => readFileSync(resolve(publicDir, name), 'utf8');
const buildJs = readFileSync(resolve(import.meta.dirname, '../scripts/build.mjs'), 'utf8');

function load() {
  const window: Record<string, unknown> = {};
  const context = vm.createContext({
    window,
    document: { readyState: 'loading', addEventListener: () => {}, querySelector: () => null },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  });
  vm.runInContext(read('header-divider.js'), context, { filename: 'header-divider.js' });
  return window.CodemanHeaderDivider as {
    clampWidth: (w: number, header: number, brand: number) => number;
    densityFor: (w: number) => string;
    MIN_WIDTH: number;
    MIN_TABS_ROOM: number;
  };
}

describe('header divider', () => {
  it('clamps the toolbar between its minimum and what leaves the tabs room', () => {
    const { clampWidth, MIN_WIDTH, MIN_TABS_ROOM } = load();
    expect(clampWidth(10, 1600, 120)).toBe(MIN_WIDTH);
    expect(clampWidth(5000, 1600, 120)).toBe(1600 - 120 - MIN_TABS_ROOM);
    expect(clampWidth(420.4, 1600, 120)).toBe(420);
  });

  it('shows less of the usage readings the narrower the toolbar gets', () => {
    const { densityFor } = load();
    expect([700, 560, 559, 400, 399, 280, 279, 160].map(densityFor)).toEqual([
      '',
      '',
      'tight',
      'tight',
      'dense',
      'dense',
      'tiny',
      'tiny',
    ]);
  });

  it('never goes below the minimum even in a header too narrow for the tabs room', () => {
    const { clampWidth, MIN_WIDTH } = load();
    expect(clampWidth(400, 300, 100)).toBe(MIN_WIDTH);
  });

  it('is wired into the page and the build, and hides where the tabs are not in the header', () => {
    expect(read('index.html')).toContain('<script defer src="header-divider.js"></script>');
    expect(buildJs).toContain("run('minify header-divider.js'");
    expect(buildJs).toMatch(/HASHABLE[\s\S]{0,1500}'header-divider\.js'/);
    const css = read('styles.css');
    expect(css).toContain('.header-divider');
    expect(css).toMatch(/data-session-list='sidebar'\] \.header-divider/);
    expect(css).toMatch(/data-tab-orientation='vertical'\] \.header-divider/);
  });

  it('keeps the width on the device only and offers a keyboard reset', () => {
    const js = read('header-divider.js');
    expect(js).toContain('localStorage');
    expect(js).not.toContain('/api/settings');
    expect(js).toMatch(/key === 'Home'/);
    // Escape belongs to the global close-panels handler (app.js), so the handle must not claim it too.
    expect(js).not.toMatch(/'Escape'/);
    expect(js).toContain("addEventListener('dblclick'");
  });
});
