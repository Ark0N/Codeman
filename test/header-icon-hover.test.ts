/**
 * @fileoverview Header icon buttons: hover motion moves the icon, never the button.
 *
 * A global `.btn-icon-header:hover { transform: rotate(45deg) }` (meant for the
 * settings gear) turned EVERY header icon button on hover, so the folder, Tiles,
 * Split and the rest swung their rounded hover background into a diamond. Three
 * buttons had already been patched one by one with `transform: none`. The owner
 * asked for a nicer hover on the folder and Tiles buttons; this file pins the
 * shape of the fix:
 *
 * 1. No rule on a header icon button transforms the BUTTON on hover.
 * 2. Only the gear's icon turns; the Tiles squares spread apart; the folder
 *    cross-fades from closed to open (two drawings in its SVG).
 * 3. Those motions live inside `@media (hover: hover)`, so a tap on a touch
 *    screen cannot leave an icon stuck mid-motion, and reduced motion turns the
 *    transitions off.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss, { type AtRule, type Rule } from 'postcss';

const ROOT = resolve(__dirname, '..');
const css = readFileSync(resolve(ROOT, 'src/web/public/styles.css'), 'utf8');
const html = readFileSync(resolve(ROOT, 'src/web/public/index.html'), 'utf8');
const root = postcss.parse(css);

interface FoundRule {
  selector: string;
  decls: Record<string, string>;
  media: string[];
}

function rules(): FoundRule[] {
  const out: FoundRule[] = [];
  root.walkRules((rule: Rule) => {
    const media: string[] = [];
    for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
      if (p.type === 'atrule' && (p as AtRule).name === 'media') media.push((p as AtRule).params);
    }
    const decls: Record<string, string> = {};
    rule.walkDecls((d) => {
      decls[d.prop] = d.value;
    });
    for (const selector of rule.selectors) out.push({ selector, decls, media });
  });
  return out;
}

const all = rules();
const iconRules = all.filter((r) => r.selector.includes('btn-icon-header'));

function buttonTag(cls: string): string {
  const i = html.indexOf(`class="btn-icon-header ${cls}`);
  expect(i, `${cls} button in index.html`).toBeGreaterThan(-1);
  return html.slice(i, html.indexOf('</button>', i));
}

describe('header icon hover', () => {
  it('never transforms the button itself on hover', () => {
    const offenders = iconRules.filter(
      (r) => /:hover\s*$/.test(r.selector) && r.decls.transform && r.decls.transform !== 'none'
    );
    expect(offenders.map((r) => `${r.selector} { transform: ${r.decls.transform} }`)).toEqual([]);
  });

  it('turns only the gear icon, and only on pointer devices', () => {
    const rotations = iconRules.filter((r) => /rotate\(/.test(r.decls.transform || ''));
    expect(rotations.map((r) => r.selector)).toEqual(['.btn-icon-header.btn-settings:hover svg']);
    expect(rotations[0].media).toContain('(hover: hover)');
  });

  it('spreads the four Tiles squares apart, each toward its own corner', () => {
    const svg = buttonTag('btn-tile-grid');
    expect(svg.match(/<rect /g)?.length).toBe(4);
    const expected = ['(-1.5px, -1.5px)', '(1.5px, -1.5px)', '(-1.5px, 1.5px)', '(1.5px, 1.5px)'];
    expected.forEach((offset, i) => {
      const rule = iconRules.find(
        (r) => r.selector === `.btn-icon-header.btn-tile-grid:hover svg rect:nth-of-type(${i + 1})`
      );
      expect(rule?.decls.transform, `rect ${i + 1}`).toBe(`translate${offset}`);
      expect(rule?.media).toContain('(hover: hover)');
    });
    const box = iconRules.find(
      (r) => r.selector === '.btn-icon-header.btn-tile-grid svg rect' && r.decls['transform-box']
    );
    expect(box?.decls['transform-origin']).toBe('center');
  });

  it('opens the folder: the open drawing is hidden at rest and replaces the closed one on hover', () => {
    const svg = buttonTag('btn-file-viewer');
    expect(svg).toContain('class="icon-folder-closed"');
    expect(svg).toContain('class="icon-folder-open"');
    const rest = iconRules.find(
      (r) => r.selector === '.btn-icon-header.btn-file-viewer svg .icon-folder-open' && r.decls.opacity
    );
    expect(rest?.decls.opacity).toBe('0');
    expect(rest?.media).toEqual([]);
    const hoverClosed = iconRules.find(
      (r) => r.selector === '.btn-icon-header.btn-file-viewer:hover svg .icon-folder-closed'
    );
    const hoverOpen = iconRules.find(
      (r) => r.selector === '.btn-icon-header.btn-file-viewer:hover svg .icon-folder-open'
    );
    expect(hoverClosed?.decls.opacity).toBe('0');
    expect(hoverOpen?.decls.opacity).toBe('1');
    expect(hoverClosed?.media).toContain('(hover: hover)');
    expect(hoverOpen?.media).toContain('(hover: hover)');
  });

  it('turns the motion off under reduced motion', () => {
    const reduced = iconRules.filter((r) => r.media.includes('(prefers-reduced-motion: reduce)'));
    for (const sel of [
      '.btn-icon-header.btn-settings svg',
      '.btn-icon-header.btn-tile-grid svg rect',
      '.btn-icon-header.btn-file-viewer svg .icon-folder-closed',
      '.btn-icon-header.btn-file-viewer svg .icon-folder-open',
    ]) {
      expect(reduced.find((r) => r.selector === sel)?.decls.transition, sel).toBe('none');
    }
    for (const sel of ['.btn-icon-header.btn-settings:hover svg', '.btn-icon-header.btn-tile-grid:hover svg rect']) {
      expect(reduced.find((r) => r.selector === sel)?.decls.transform, sel).toBe('none');
    }
  });
});
