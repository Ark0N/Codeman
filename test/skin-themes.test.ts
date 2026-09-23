/**
 * @fileoverview Static and VM regressions for Codeman UI/xterm skin parity.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const indexSource = readFileSync(resolve('src/web/public/index.html'), 'utf8');
const stylesSource = readFileSync(resolve('src/web/public/styles.css'), 'utf8');
const mobileStylesSource = readFileSync(resolve('src/web/public/mobile.css'), 'utf8');
const terminalSource = readFileSync(resolve('src/web/public/terminal-ui.js'), 'utf8');

const LIGHT_SKINS = ['paper-gray', 'solarized-light', 'catppuccin-latte', 'rose-pine-dawn'] as const;

function hexRgb(hex: string): [number, number, number] {
  const normalized = hex.replace('#', '');
  if (!/^[0-9a-f]{6}$/i.test(normalized)) throw new Error(`Expected six-digit hex color, got ${hex}`);
  return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function luminance(hex: string): number {
  const channels = hexRgb(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** Parse the `rgba(r,g,b,a)` form the palettes use for the selection layer. */
function rgba(value: string): { rgb: [number, number, number]; alpha: number } {
  const match = value.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/);
  if (!match) throw new Error(`Expected an rgba() color, got ${value}`);
  return {
    rgb: [Number(match[1]), Number(match[2]), Number(match[3])],
    alpha: Number(match[4]),
  };
}

/**
 * What xterm actually paints: `selectionBackgroundOpaque = blend(background, selection)`.
 * Comparing the raw rgba string against the background says nothing, since a 0.2-alpha
 * layer over a near-white surface is still near-white.
 */
function blendOverHex(base: string, layer: string): string {
  const [br, bg, bb] = hexRgb(base);
  const { rgb, alpha } = rgba(layer);
  const mix = (b: number, l: number) => Math.round(b * (1 - alpha) + l * alpha);
  return `#${[mix(br, rgb[0]), mix(bg, rgb[1]), mix(bb, rgb[2])].map((c) => c.toString(16).padStart(2, '0')).join('')}`;
}

/** Largest per-channel distance, in 0-255 units. */
function channelDelta(first: string, second: string): number {
  const a = hexRgb(first);
  const b = hexRgb(second);
  return Math.max(...a.map((channel, index) => Math.abs(channel - b[index])));
}

function contrastRatio(first: string, second: string): number {
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function loadTerminalThemes() {
  const FakeCodemanApp = function () {} as unknown as { prototype: Record<string, (...args: unknown[]) => unknown> };
  const document = { documentElement: { dataset: { skin: 'paper-gray' } } };
  const window: Record<string, unknown> = {};
  vm.runInNewContext(terminalSource, { CodemanApp: FakeCodemanApp, document, window }, { filename: 'terminal-ui.js' });
  return {
    mixin: FakeCodemanApp.prototype,
    themes: window.CODEMAN_XTERM_THEMES as Record<string, Record<string, string>>,
    isLight: window.codemanCurrentSkinIsLight as (skin?: string) => boolean,
  };
}

describe('Codeman light skins', () => {
  const terminal = loadTerminalThemes();

  it('keeps the picker, pre-paint allowlist, CSS, and xterm palette in sync', () => {
    for (const skin of LIGHT_SKINS) {
      expect(indexSource).toContain(`value="${skin}"`);
      expect(indexSource).toContain(`'${skin}'`);
      expect(stylesSource).toContain(`html[data-skin="${skin}"]`);
      expect(stylesSource).toMatch(new RegExp(`html\\[data-skin="${skin}"\\] \\{[\\s\\S]*?color-scheme: light;`));
      expect(terminal.themes[skin]).toBeDefined();
      expect(terminal.isLight(skin)).toBe(true);
    }
    expect(terminal.isLight('daylight-blue')).toBe(false);
  });

  it('provides readable dark-on-light terminal foregrounds', () => {
    for (const skin of LIGHT_SKINS) {
      const theme = terminal.themes[skin];
      expect(contrastRatio(theme.background, theme.foreground), skin).toBeGreaterThanOrEqual(4.5);
    }
  });

  // Issue #360. xterm renamed this key in v5 and an ITheme is a plain object, so the
  // old `selection` key was silently dropped and every skin fell back to xterm's own
  // default of rgba(255,255,255,0.3). Nobody noticed on the dark skins, where white at
  // 30% is roughly what the palettes asked for anyway; on the light ones it made the
  // highlight invisible, which reads as "selecting text does nothing".
  it('names the selection layer the way xterm 6 does, and keeps it visible', () => {
    const XTERM_DEFAULT_SELECTION = 'rgba(255, 255, 255, 0.3)';
    const themeBlock = terminalSource.slice(
      terminalSource.indexOf('const CODEMAN_XTERM_THEMES = {'),
      terminalSource.indexOf('const CODEMAN_LIGHT_SKINS')
    );
    // The renderer only knows this spelling (xterm.js >= 5, and package.json pins ^6);
    // a palette key it does not know is dropped without an error, so the name IS the fix.
    // Asserted against package.json rather than the bundle, which is gitignored and only
    // exists after an install step.
    expect(JSON.parse(readFileSync(resolve('package.json'), 'utf8')).dependencies['@xterm/xterm']).toMatch(
      /\^?[6-9]\./
    );
    expect(themeBlock).not.toMatch(/\bselection: '/);

    for (const [skin, theme] of Object.entries(terminal.themes)) {
      expect(theme.selectionBackground, skin).toBeDefined();
      const painted = blendOverHex(theme.background, theme.selectionBackground);
      expect(channelDelta(theme.background, painted), skin).toBeGreaterThanOrEqual(16);
    }

    // And the half that proves the rename was the fix rather than a tidy-up: on the
    // light skins xterm's own fallback lands under that floor (about 3/255), so those
    // palettes were declaring a selection colour nothing ever read.
    for (const skin of LIGHT_SKINS) {
      const background = terminal.themes[skin].background;
      const fallback = blendOverHex(background, XTERM_DEFAULT_SELECTION);
      expect(channelDelta(background, fallback), skin).toBeLessThan(16);
    }
  });

  it('switches live terminals between light and dark contrast policies', () => {
    const main = { options: {} as Record<string, unknown>, rows: 24, refresh: vi.fn() };
    const teammate = { options: {} as Record<string, unknown>, rows: 12, refresh: vi.fn() };
    const refreshFont = vi.fn();
    const app = {
      terminal: main,
      teammateTerminals: new Map([['agent-1', { terminal: teammate }]]),
      _localEchoOverlay: { refreshFont },
    };

    terminal.mixin.applyTerminalSkin.call(app, 'paper-gray');
    expect(main.options.minimumContrastRatio).toBe(4.5);
    expect(teammate.options.minimumContrastRatio).toBe(4.5);
    expect((main.options.theme as Record<string, string>).background).toBe('#f6f8fa');
    expect(refreshFont).toHaveBeenCalledTimes(1);

    terminal.mixin.applyTerminalSkin.call(app, 'daylight-blue');
    expect(main.options.minimumContrastRatio).toBe(1);
    expect(teammate.options.minimumContrastRatio).toBe(1);
    expect((main.options.theme as Record<string, string>).background).toBe('#161b23');
    expect(refreshFont).toHaveBeenCalledTimes(2);
  });

  it('themes stateful input and response surfaces instead of pinning dark colors', () => {
    expect(stylesSource).toContain('background: var(--bg-input);\n  color: var(--text);');
    expect(stylesSource).toMatch(/#cjkInput \{[\s\S]*?background: var\(--bg-input\);[\s\S]*?color: var\(--text\);/);
    expect(stylesSource).toMatch(/\.response-viewer \{[\s\S]*?background: var\(--floating-bg\);/);
    expect(stylesSource).toMatch(/\.response-viewer-body pre \{[\s\S]*?background: var\(--bg-dark\);/);
    expect(stylesSource).toMatch(/\.response-viewer-body pre code \{[\s\S]*?color: var\(--text\);/);
    expect(stylesSource).toMatch(/\.file-preview-body \{[\s\S]*?background: var\(--bg-dark\);/);
  });

  it('uses skin variables for the pre-paint skeleton and native controls', () => {
    expect(indexSource).toContain('background:var(--term-bg,#161b23)');
    expect(indexSource).toContain('background:var(--glass-bg,rgba(31,38,48,0.85))');
    expect(stylesSource).toContain('color-scheme: light;');
    expect(stylesSource).toContain('background: var(--floating-bg);');
    expect(mobileStylesSource).toContain(':is(.header, .toolbar, .keyboard-accessory-bar)');
    expect(mobileStylesSource).toContain(':is(.case-settings-popover-mobile, .mobile-case-picker-sheet)');
  });

  it('re-declares every run-mode colour inside the non-og skin block', () => {
    // The skin block nests under `html:not([data-skin="og"])`, so its generic
    // `.btn-toolbar.btn-run` outranks a base-sheet `.mode-<id>` pair. A mode with no
    // resting rule of its own in there (a `:hover` alone does not count) renders as generic claude blue on the DEFAULT skin
    // (gemini, antigravity and omp all shipped that way). Ids come from the sheet.
    const css = stylesSource.replace(/\/\*[\s\S]*?\*\//g, '');
    const opener = 'html:not([data-skin="og"]) {';
    const start = css.indexOf(opener);
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let end = -1;
    for (let i = start + opener.length - 1; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) {
        end = i;
        break;
      }
    }
    expect(end).toBeGreaterThan(start);
    const nested = css.slice(start, end);
    const base = css.slice(0, start) + css.slice(end);
    const ids = (text: string) =>
      new Set([...text.matchAll(/\.btn-toolbar\.btn-run\.mode-([\w-]+)(?![\w-]|:)/g)].map((m) => m[1]));
    const baseIds = [...ids(base)];
    expect(baseIds.length).toBeGreaterThanOrEqual(5);
    const nestedIds = ids(nested);
    expect(baseIds.filter((id) => !nestedIds.has(id))).toEqual([]);
  });
});
