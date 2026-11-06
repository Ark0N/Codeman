/**
 * @fileoverview Static guards for the entrance-animation styles (App Settings →
 * Appearance → Entrance Animations, plus the `?animlab=1` picker).
 *
 * A style is FOUR things that have to line up, and any one of them missing fails
 * silently rather than loudly: the entry in the style array in
 * entrance-animations.js (which is what the lab lists and what `_styleDuration`
 * reads), the `html[data-*-anim="<key>"]` rule in styles.css, the @keyframes
 * block that rule names, and — for a style that belongs to a theme — the theme's
 * `<option>` in index.html. A style with no CSS behind it renders as "the
 * animation silently does nothing"; a rule naming a keyframe block that does not
 * exist behaves the same way.
 *
 * The terminal pane carries an extra rule of its own, and it is the one with
 * teeth: xterm's FitAddon derives rows+cols from getComputedStyle(parent)
 * .width/height, so a terminal keyframe that animates a box-model property would
 * resize the PTY mid-animation. Only paint-level properties are allowed there.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const animSource = readFileSync(resolve('src/web/public/entrance-animations.js'), 'utf8');
const stylesSource = readFileSync(resolve('src/web/public/styles.css'), 'utf8');
const indexSource = readFileSync(resolve('src/web/public/index.html'), 'utf8');

/** Surfaces, keyed by the `data-*-anim` attribute their styles are selected by. */
const SURFACES = [
  { attr: 'tab', array: 'TAB_ANIM_STYLES', selector: '.session-tab.tab-enter' },
  { attr: 'win', array: 'WIN_ANIM_STYLES', selector: '.subagent-window.win-enter' },
  { attr: 'line', array: 'LINE_ANIM_STYLES', selector: '.connection-line.line-enter' },
  { attr: 'term', array: 'TERM_ANIM_STYLES', selector: '.terminal-container.term-enter' },
  { attr: 'tile', array: 'TILE_ANIM_STYLES', selector: '.tile.tile--entering' },
] as const;

/**
 * Styles with no CSS of their own, by design: `off` means "do nothing" and `fly`
 * is the pre-existing JS transition in subagent-windows.js, which deliberately
 * skips the `win-enter` class entirely.
 */
const CSS_LESS_STYLES = new Set(['off', 'fly']);

/** `fly` is CSS-less on the window surface only: a tile's `fly` is keyframes like any other. */
function isCssLess(attr: string, key: string): boolean {
  return key === 'off' || (attr === 'win' && CSS_LESS_STYLES.has(key));
}

function styleKeys(arrayName: string): string[] {
  const start = animSource.indexOf(`const ${arrayName} = [`);
  expect(start, `${arrayName} not found`).toBeGreaterThan(-1);
  const body = animSource.slice(start, animSource.indexOf('];', start));
  return [...body.matchAll(/\{ key: '([^']+)'/g)].map((m) => m[1]);
}

type Theme = { key: string; tab: string; win: string; line: string; term: string; tile: string };

function themes(): Theme[] {
  const start = animSource.indexOf('const ANIM_THEMES = [');
  const body = animSource.slice(start, animSource.indexOf('];', start));
  const parsed = [
    ...body.matchAll(
      /\{ key: '([^']+)'.*?tab: '([^']+)', win: '([^']+)', line: '([^']+)', term: '([^']+)', tile: '([^']+)' \}/g
    ),
  ].map((m) => ({ key: m[1], tab: m[2], win: m[3], line: m[4], term: m[5], tile: m[6] }));
  // Every theme entry must parse: a theme missing a surface (or a regex that
  // drifted from the source) would otherwise pass the checks below vacuously.
  expect(parsed.length, 'a theme entry did not parse').toBe((body.match(/\{ key: '/g) || []).length);
  expect(parsed.length).toBeGreaterThan(0);
  return parsed;
}

/**
 * Every `animation-name:` a `html[data-<attr>-anim="<key>"]` block asks for,
 * tagged with whether it runs on the element itself or on its ::before overlay.
 * The distinction matters for the terminal: the FitAddon rule below binds to the
 * container, while ::before is a throwaway wash that may animate anything.
 */
function animationNamesFor(attr: string, key: string): { name: string; onPseudo: boolean }[] {
  const rules = [...stylesSource.matchAll(new RegExp(`html\\[data-${attr}-anim="${key}"\\]([^{]*)\\{([^}]*)\\}`, 'g'))];
  return rules.flatMap((rule) =>
    [...rule[2].matchAll(/animation-name:\s*([\w-]+);/g)].map((m) => ({
      name: m[1],
      onPseudo: rule[1].includes('::before'),
    }))
  );
}

function keyframeBody(name: string): string | null {
  const start = stylesSource.indexOf(`@keyframes ${name} {`);
  if (start === -1) return null;
  return stylesSource.slice(start, stylesSource.indexOf('\n}', start));
}

describe('entrance animation styles', () => {
  for (const surface of SURFACES) {
    describe(`${surface.attr} surface`, () => {
      it('backs every style with a rule that names a keyframe block that exists', () => {
        for (const key of styleKeys(surface.array)) {
          if (isCssLess(surface.attr, key)) {
            expect(stylesSource).not.toContain(`html[data-${surface.attr}-anim="${key}"]`);
            continue;
          }
          const names = animationNamesFor(surface.attr, key);
          expect(names.length, `no animation-name for ${surface.attr}/${key}`).toBeGreaterThan(0);
          for (const { name } of names) {
            expect(keyframeBody(name), `@keyframes ${name} missing`).not.toBeNull();
          }
          // The style has to reach the element the surface actually animates,
          // not just any selector carrying the attribute.
          expect(stylesSource).toContain(`html[data-${surface.attr}-anim="${key}"] ${surface.selector}`);
        }
      });
    });
  }

  /**
   * Tiles are the exception: six frames animate at once, so their styles stay
   * off `filter`, and a tile's blur is its SCREEN beat (the pane's `blur`
   * style on .tile-body, one tile at a time), which the Soft focus theme uses.
   */
  it('ships the blur style on the four single-element surfaces', () => {
    for (const surface of SURFACES) {
      if (surface.attr === 'tile') expect(styleKeys(surface.array)).not.toContain('blur');
      else expect(styleKeys(surface.array)).toContain('blur');
    }
  });

  it('gives every theme an <option> and only styles that exist', () => {
    for (const theme of themes()) {
      expect(indexSource, `no <option value="${theme.key}">`).toContain(`<option value="${theme.key}">`);
      for (const surface of SURFACES) {
        expect(styleKeys(surface.array), `theme ${theme.key} names an unknown ${surface.attr} style`).toContain(
          theme[surface.attr]
        );
      }
    }
    // 'custom' is a readout of a lab mix, never a theme you can select into.
    expect(indexSource).toContain('<option value="custom">');
    expect(themes().map((t) => t.key)).not.toContain('custom');
  });

  it('keeps every entrance under the reduced-motion kill switch', () => {
    const start = stylesSource.indexOf('@media (prefers-reduced-motion: reduce) {\n  .session-tab.tab-enter,');
    expect(start, 'the entrance reduced-motion block moved or was renamed').toBeGreaterThan(-1);
    const block = stylesSource.slice(
      start,
      stylesSource.indexOf('\n}', stylesSource.indexOf('animation: none', start))
    );
    for (const surface of SURFACES) expect(block).toContain(surface.selector);
  });

  /**
   * ⚠ The FitAddon rule. It reads getComputedStyle(parent).width/height, i.e. the
   * untransformed LAYOUT box, so paint-level properties are invisible to it and a
   * box-model property here would resize the PTY mid-animation.
   */
  it('animates only paint-level properties on the terminal pane', () => {
    const allowed = new Set(['opacity', 'transform', 'clip-path', 'filter']);
    for (const key of styleKeys('TERM_ANIM_STYLES')) {
      if (CSS_LESS_STYLES.has(key)) continue;
      for (const { name, onPseudo } of animationNamesFor('term', key)) {
        if (onPseudo) continue; // a wash over the pane, it has no layout of its own
        const body = keyframeBody(name);
        expect(body).not.toBeNull();
        for (const [, prop] of (body as string).matchAll(/(?:\{|;)\s*([a-z-]+):/g)) {
          expect(allowed.has(prop), `@keyframes ${name} animates ${prop} on the terminal pane`).toBe(true);
        }
      }
    }
  });

  /**
   * The `blur` line entrance animates `filter`, and a keyframe listing only the
   * blur would drop each line's own glow for the length of the run and pop it
   * back at the end. Both frames say `blur(N) var(--line-glow)` so the function
   * lists match and interpolate, which only works while both kinds of line
   * actually define that variable.
   */
  it('routes both kinds of connection line through --line-glow', () => {
    for (const selector of ['.connection-line {', '.connection-line.lineage-line {']) {
      const start = stylesSource.indexOf(selector);
      expect(start, `${selector} not found`).toBeGreaterThan(-1);
      const block = stylesSource.slice(start, stylesSource.indexOf('\n}', start));
      expect(block, `${selector} must define --line-glow`).toContain('--line-glow:');
      expect(block, `${selector} must apply it`).toContain('filter: var(--line-glow);');
    }
    const blur = keyframeBody('line-enter-blur') as string;
    expect(blur).not.toBeNull();
    expect(blur.match(/var\(--line-glow\)/g)?.length).toBe(2);
    // The 100% frame deliberately omits opacity so the endpoint comes from the
    // element's own resting value: 0.9 on a subagent line, 1 on a lineage
    // line (its family group is translucent), 0.5 on a proxied one. Pinning a
    // number here snaps them.
    expect(blur).toMatch(/100%\s*\{\s*filter:[^}]*\}/);
    expect(blur).not.toMatch(/100%\s*\{[^}]*opacity/);
  });
});

describe('tile grid entrance styles', () => {
  /** Keyframes a `html[data-tile-anim=...]` rule names, on the tile or on its ::before wash. */
  const tileNames = (key: string, scope: RegExp) =>
    [...stylesSource.matchAll(new RegExp(`html\\[data-tile-anim="${key}"\\]([^{]*)\\{([^}]*)\\}`, 'g'))]
      .filter((rule) => scope.test(rule[1]))
      .flatMap((rule) =>
        [...rule[2].matchAll(/animation(?:-name)?:\s*([\w-]+)/g)].map((m) => ({
          name: m[1],
          onPseudo: rule[1].includes('::before'),
        }))
      );

  /**
   * ⚠ The FitAddon rule, for six frames at once: transform and opacity only.
   * A tile fits once at its final size (#464); a box-model property here would
   * resize its PTY mid-animation, and a filter on six live terminals at once
   * is the frame-time cost the pane's `blur` takes for one.
   */
  it('animates only transform and opacity on a tile frame, entering and leaving', () => {
    for (const key of styleKeys('TILE_ANIM_STYLES')) {
      if (key === 'off') continue;
      const names = [...tileNames(key, /tile--entering/), ...tileNames(key, /tile--leaving/)];
      expect(names.length, `no keyframes for tile/${key}`).toBeGreaterThan(0);
      for (const { name, onPseudo } of names) {
        const body = keyframeBody(name);
        expect(body, `@keyframes ${name} missing`).not.toBeNull();
        if (onPseudo) continue; // a wash over the tile, no layout of its own
        for (const [, prop] of (body as string).matchAll(/(?:\{|;)\s*([a-z-]+):/g)) {
          expect(['opacity', 'transform'], `@keyframes ${name} animates ${prop} on a tile`).toContain(prop);
        }
      }
    }
  });

  /**
   * The mount clears `.tile--entering` on the tile's own `tile-enter*`
   * animationend, and the still copy goes on its last tile's `tile-leave*`:
   * a keyframe named otherwise would leave the class on (or the copy up)
   * until a backstop timer.
   */
  it('names every frame keyframe for the events tile-grid.js listens for', () => {
    for (const key of styleKeys('TILE_ANIM_STYLES')) {
      for (const { name, onPseudo } of tileNames(key, /tile--entering/)) {
        if (!onPseudo) expect(name, `tile/${key} entering`).toMatch(/^tile-enter/);
      }
      for (const { name, onPseudo } of tileNames(key, /tile--leaving/)) {
        if (!onPseudo) expect(name, `tile/${key} leaving`).toMatch(/^tile-leave/);
      }
    }
  });

  it('gives every exit the module times a leaving rule, and keeps `settle` on the grid default', () => {
    const exits = animSource.slice(animSource.indexOf('const TILE_EXIT_MS = {'));
    const timed = [...exits.slice(0, exits.indexOf('};')).matchAll(/(\w+): \d+/g)].map((m) => m[1]);
    expect(timed.length).toBeGreaterThan(0);
    for (const key of timed) {
      expect(styleKeys('TILE_ANIM_STYLES')).toContain(key);
      expect(tileNames(key, /tile--leaving/).length, `no leaving rule for tile/${key}`).toBeGreaterThan(0);
    }
    expect(timed).not.toContain('settle');
    expect(animSource).toContain("const TILE_ANIM_DEFAULT = 'settle';");
    // The legacy theme (the default) leaves the grid's own motion untouched.
    expect(themes().find((t) => t.key === 'legacy')?.tile).toBe('settle');
  });

  /**
   * App Settings → Appearance → Tile Animations: one option per style, wired
   * by id (entrance-animations.js _syncEntranceAnimSetting), with the grid's
   * own `settle` first and named as the off default.
   */
  it('lists every tile style in the Tile Animations setting, off by default', () => {
    const start = indexSource.indexOf('<select id="appSettingsTileAnim"');
    expect(start, 'the Tile Animations select is missing').toBeGreaterThan(-1);
    const select = indexSource.slice(start, indexSource.indexOf('</select>', start));
    const values = [...select.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
    expect([...values].sort()).toEqual([...styleKeys('TILE_ANIM_STYLES')].sort());
    expect(values[0]).toBe('settle');
    expect(select).toContain('<option value="settle">Off (default)</option>');
    expect(animSource).toContain("document.getElementById('appSettingsTileAnim')");
    // Nothing new for an install that never picks it: no saved key means settle.
    expect(animSource).toMatch(/pick\('tileanim', TILE_ANIM_STYLES, ANIM_KEYS\.tile, TILE_ANIM_DEFAULT\)/);
  });

  /** A tile's screen plays the pane's style: every term rule also reaches .tile-body. */
  it('plays every terminal pane style on a tile screen too', () => {
    for (const key of styleKeys('TERM_ANIM_STYLES')) {
      if (CSS_LESS_STYLES.has(key)) continue;
      // The body itself, not only its ::before wash.
      expect(stylesSource).toMatch(new RegExp(`html\\[data-term-anim="${key}"\\] \\.tile-body\\.term-enter \\{`));
    }
  });
});
