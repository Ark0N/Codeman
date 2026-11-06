/**
 * @fileoverview Static guard: the inline rename editor is never line-clamped.
 *
 * A vertical rail or sidebar row clamps its name (2 lines, 3 in the detailed
 * rail), and one shared rule unclamps `.tab-name.tab-name-renaming` so the
 * editor can lay out as a flex row. A clamping rule MORE specific than that
 * shared rule wins over it, which is how the detailed rail shipped with its
 * 3-line clamp around the editor (#534, fixed alongside #526). The behavioural
 * check lives in test/inline-rename.test.ts, a browser suite the CI gate does
 * not run, so this pins the cascade from the stylesheet itself: every rule that
 * clamps a rail or sidebar `.tab-name` must be out-ranked by an unclamp rule,
 * either the shared one or its own `.tab-name-renaming` twin.
 */
import { readFileSync } from 'node:fs';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const STYLES_CSS = readFileSync(new URL('../src/web/public/styles.css', import.meta.url), 'utf-8');

type Specificity = [number, number, number];

function compare(a: Specificity, b: Specificity): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

const IDENT = /^-?(?:[\w-]|\\.)+/;

function closingParen(selector: string, open: number): number {
  let depth = 0;
  for (let i = open; i < selector.length; i++) {
    if (selector[i] === '(') depth++;
    else if (selector[i] === ')' && --depth === 0) return i;
  }
  return selector.length - 1;
}

/**
 * Specificity of one complex selector, with :is()/:not()/:has() taking their
 * most specific argument and :where() counting nothing. Hand-rolled because
 * postcss (a dependency) splits selector lists but does not parse selectors;
 * checked against postcss-selector-parser over every selector in styles.css.
 */
function specificityOf(selector: string): Specificity {
  const total: Specificity = [0, 0, 0];
  let i = 0;
  while (i < selector.length) {
    const ch = selector[i];
    if (ch === '[') {
      total[1]++;
      i = selector.indexOf(']', i) + 1;
    } else if (ch === '#' || ch === '.') {
      total[ch === '#' ? 0 : 1]++;
      i += 1 + (selector.slice(i + 1).match(IDENT)?.[0].length ?? 0);
    } else if (ch === ':') {
      const element = selector[i + 1] === ':';
      const start = i + (element ? 2 : 1);
      const name = selector.slice(start).match(IDENT)?.[0] ?? '';
      i = start + name.length;
      let args: string | null = null;
      if (selector[i] === '(') {
        const end = closingParen(selector, i);
        args = selector.slice(i + 1, end);
        i = end + 1;
      }
      if (element) total[2]++;
      else if (name === 'where') continue;
      else if (['is', 'not', 'has'].includes(name) && args !== null) {
        const max = postcss.list
          .comma(args)
          .map(specificityOf)
          .sort((a, b) => compare(b, a))[0] ?? [0, 0, 0];
        for (let k = 0; k < 3; k++) total[k] += max[k];
      } else total[1]++;
    } else if (/[A-Za-z_]/.test(ch)) {
      total[2]++;
      i += selector.slice(i).match(IDENT)?.[0].length ?? 1;
    } else i++;
  }
  return total;
}

type Entry = { selector: string; specificity: Specificity; order: number; rule: Rule };

/** Every complex selector in the stylesheet, flattened, with its source order. */
function entries(): Entry[] {
  const out: Entry[] = [];
  let order = 0;
  postcss.parse(STYLES_CSS).walkRules((rule) => {
    order++;
    for (const selector of rule.selectors) {
      out.push({ selector: selector.replace(/\s+/g, ' ').trim(), specificity: specificityOf(selector), order, rule });
    }
  });
  return out;
}

function declares(rule: Rule, prop: string): string | null {
  let value: string | null = null;
  rule.walkDecls(prop, (decl) => {
    value = decl.value.trim();
  });
  return value;
}

const unclamps = (rule: Rule) =>
  ['-webkit-line-clamp', 'line-clamp'].every((prop) => ['unset', 'none'].includes(declares(rule, prop) ?? ''));

describe('inline rename editor is never line-clamped', () => {
  const all = entries();
  const clamping = all.filter(
    (e) =>
      /\.tab-name$/.test(e.selector) &&
      /\.tab-rail|\.session-sidebar/.test(e.selector) &&
      /^\d+$/.test(declares(e.rule, '-webkit-line-clamp') ?? '')
  );
  const shared = all.filter((e) => e.selector.startsWith(':is(') && e.selector.endsWith('.tab-name.tab-name-renaming'));

  it('finds the clamped rail rows and the shared unclamp rule', () => {
    // The base rail row and the detailed rail card both clamp; if this drops to
    // zero the selectors moved and the guard below is checking nothing.
    expect(clamping.length).toBeGreaterThanOrEqual(2);
    expect(shared).toHaveLength(1);
    expect(unclamps(shared[0].rule)).toBe(true);
  });

  it.each(clamping.map((e) => [e.selector, e] as const))('%s is out-ranked while renaming', (_selector, clamp) => {
    const twin = all.filter((e) => e.selector === `${clamp.selector}.tab-name-renaming` && unclamps(e.rule));
    const winners = [...shared, ...twin].filter((u) => {
      const byWeight = compare(u.specificity, clamp.specificity);
      return byWeight > 0 || (byWeight === 0 && u.order > clamp.order);
    });
    expect(winners.map((w) => w.selector)).not.toEqual([]);
  });
});
