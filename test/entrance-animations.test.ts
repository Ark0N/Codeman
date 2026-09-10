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
] as const;

/**
 * Styles with no CSS of their own, by design: `off` means "do nothing" and `fly`
 * is the pre-existing JS transition in subagent-windows.js, which deliberately
 * skips the `win-enter` class entirely.
 */
const CSS_LESS_STYLES = new Set(['off', 'fly']);

function styleKeys(arrayName: string): string[] {
  const start = animSource.indexOf(`const ${arrayName} = [`);
  expect(start, `${arrayName} not found`).toBeGreaterThan(-1);
  const body = animSource.slice(start, animSource.indexOf('];', start));
  return [...body.matchAll(/\{ key: '([^']+)'/g)].map((m) => m[1]);
}

function themes(): { key: string; tab: string; win: string; line: string; term: string }[] {
  const start = animSource.indexOf('const ANIM_THEMES = [');
  const body = animSource.slice(start, animSource.indexOf('];', start));
  return [
    ...body.matchAll(/\{ key: '([^']+)'.*?tab: '([^']+)', win: '([^']+)', line: '([^']+)', term: '([^']+)' \}/g),
  ].map((m) => ({ key: m[1], tab: m[2], win: m[3], line: m[4], term: m[5] }));
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
          if (CSS_LESS_STYLES.has(key)) {
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

  it('ships the blur style on all four surfaces', () => {
    for (const surface of SURFACES) expect(styleKeys(surface.array)).toContain('blur');
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
    // element's own resting value: 0.9 on a subagent line, 0.72 on a lineage
    // line, 0.95 on a working one. Pinning a number here snaps three of them.
    expect(blur).toMatch(/100%\s*\{\s*filter:[^}]*\}/);
    expect(blur).not.toMatch(/100%\s*\{[^}]*opacity/);
  });
});
