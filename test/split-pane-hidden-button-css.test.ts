// test/split-pane-hidden-button-css.test.ts
// Port: none (pure static analysis — runs in CI, no browser/server).
//
// Regression guard for the split-pane whole-branch review finding C1: the
// header ships `.btn-split.btn-split--hidden` in index.html (an opt-in
// header button, gated behind `showSplitButton`), but no CSS anywhere gave
// `--hidden` markers meaning for that class, so the Split button rendered
// VISIBLE to every user on every viewport regardless of the setting.
//
// Every OTHER opt-in header button follows a marker-class pattern: the base
// rule is `display:inline-flex !important` and a more-specific
// `.btn-x.btn-x--hidden { display: none !important; }` rule hides it
// (`.btn-multimonitor--hidden` etc. in styles.css). C1 fixed the missing rule
// for `.btn-split--hidden`; this test is the guard so the NEXT such class
// fails loudly here instead of shipping invisible-until-noticed, the same
// static-parse shape as test/mobile-header-buttons-policy.test.ts (read
// first for the parsing conventions this file reuses).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import postcss from 'postcss';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(HERE, '../src/web/public');

/** Every distinct `*--hidden` class token referenced anywhere in index.html. */
function loadHiddenMarkerClasses(): Set<string> {
  const html = readFileSync(join(PUBLIC, 'index.html'), 'utf-8');
  const classes = new Set<string>();
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    for (const token of m[1].split(/\s+/)) {
      if (token.endsWith('--hidden')) classes.add(token);
    }
  }
  return classes;
}

/**
 * Every `*--hidden` class that has a CSS rule (anywhere — top-level or inside
 * any at-rule, e.g. a phone-only @media block) whose selector targets that
 * exact class and whose declarations set `display: none` (with or without
 * `!important`).
 */
function loadCssHiddenClasses(cssFile: string): Set<string> {
  const css = readFileSync(join(PUBLIC, cssFile), 'utf-8');
  const hidden = new Set<string>();
  postcss.parse(css).walkRules((rule) => {
    let hides = false;
    rule.walkDecls('display', (decl) => {
      if (decl.value.replace(/!important/i, '').trim() === 'none') hides = true;
    });
    if (!hides) return;
    for (const token of rule.selector.match(/\.[a-z0-9-]*--hidden\b/gi) || []) {
      hidden.add(token.slice(1));
    }
  });
  return hidden;
}

describe('Every "*--hidden" marker class has a matching CSS hide rule (static guard)', () => {
  const markerClasses = loadHiddenMarkerClasses();
  const cssHidden = new Set([...loadCssHiddenClasses('styles.css'), ...loadCssHiddenClasses('mobile.css')]);

  it('finds at least one *--hidden marker class in index.html (sanity)', () => {
    // If this drops to 0 the parser/markup drifted — fix the parser, don't delete the test.
    expect(markerClasses.size).toBeGreaterThan(0);
  });

  it('every "*--hidden" class in index.html has a `display: none` rule in styles.css or mobile.css', () => {
    for (const cls of markerClasses) {
      expect(
        cssHidden.has(cls),
        `index.html references class "${cls}" (an opt-in-hide marker) but no rule in styles.css or ` +
          `mobile.css sets "display: none" for it — the element it marks ships VISIBLE regardless of the ` +
          `setting that is supposed to gate it. Add ".${cls} { display: none !important; }" (see the sibling ` +
          `.btn-multimonitor--hidden / .btn-redraw-terminal--hidden rules in styles.css for the pattern).`
      ).toBe(true);
    }
  });

  it('locks the split-pane Split button specifically (C1 regression)', () => {
    expect(markerClasses.has('btn-split--hidden')).toBe(true);
    expect(cssHidden.has('btn-split--hidden')).toBe(true);
  });
});
