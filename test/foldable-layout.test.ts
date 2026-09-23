/**
 * @fileoverview Folding devices: dialogs stay off the hinge, and a fold never
 * changes which settings the device is using.
 *
 * Apple's "Designing for iPhone Duo" calls the band a partly-open display folds
 * through a RESERVED REGION: content avoids covering it and system components
 * move aside for it. On the web that region is described by the CSS Viewport
 * Segments media features and env() variables, so the styles.css section this
 * file guards is the whole mechanism.
 *
 * Three things about it fail silently and none is observable without the
 * hardware, which is why they are pinned here rather than left to a device lab:
 *
 * 1. Each fold rule RE-STATES the overlay's own gutter, because a later
 *    `padding-right` longhand beats the earlier `padding` shorthand it composes
 *    with and would otherwise erase it. The two numbers are read out of the
 *    stylesheet below and compared, so changing one alone fails here.
 * 2. The overlay list is DERIVED, not typed out: every `position: fixed;
 *    inset: 0` flex-centring box in styles.css must have a fold rule. A new
 *    overlay added without one would centre its dialog on the hinge, and
 *    nothing else in the suite would notice.
 * 3. The gutter an overlay ends up with is a CASCADE across two files and
 *    several breakpoints, not one rule: a later @media block can zero it (the
 *    phone path picker under 600px), mobile.css can replace it with a
 *    shorthand (the palette between 600 and 768px) and, loading later, can
 *    outrank a same-specificity rule (the response viewer under 600px). So the
 *    cascade is simulated at every breakpoint, once with the fold rules and
 *    once without, and the two results must differ by exactly the fold strip.
 *    Each of the three shipped once with the top-level-only comparison green.
 *
 * Parsed with postcss rather than regexes because the values are calc()
 * expressions and some of the rules live in @media blocks. Rendered behaviour
 * needs a real foldable; this is the cheap regression fence. Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import postcss, { type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const STYLES = postcss.parse(readFileSync(resolve(PUBLIC, 'styles.css'), 'utf8'));
const MOBILE = postcss.parse(readFileSync(resolve(PUBLIC, 'mobile.css'), 'utf8'));

type Decls = Record<string, string>;

function declsOf(rule: Rule): Decls {
  const out: Decls = {};
  rule.walkDecls((d) => {
    out[d.prop] = d.value;
  });
  return out;
}

/** Every rule in a stylesheet whose selector list contains `selector`. */
function rulesFor(root: postcss.Root, selector: string): Rule[] {
  const found: Rule[] = [];
  root.walkRules((rule) => {
    if (rule.selectors.includes(selector)) found.push(rule);
  });
  return found;
}

/**
 * The centred overlays, derived from the stylesheet. `.modal` is `display:none`
 * until `.modal.active`, so display is deliberately not part of the shape.
 */
const CENTRED_OVERLAYS: { selector: string; decls: Decls }[] = [];
STYLES.walkRules((rule) => {
  const d = declsOf(rule);
  if (d.position === 'fixed' && d.inset === '0' && d['justify-content'] === 'center') {
    CENTRED_OVERLAYS.push({ selector: rule.selector, decls: d });
  }
});

/**
 * The side of a `padding` shorthand that applies to `side`. Every centred
 * overlay uses a one-value shorthand today; anything else throws rather than
 * being guessed at, since a wrong guess would silently weaken the comparison.
 */
function shorthandSide(value: string): string {
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 1) throw new Error(`multi-value padding shorthand not handled: ${value}`);
  return parts[0];
}

/** What an overlay's padding on `side` resolves to before the fold rule. */
function effectivePadding(decls: Decls, side: 'right' | 'bottom'): string | null {
  const longhand = decls[`padding-${side}`];
  if (longhand) return longhand;
  if (decls.padding) return shorthandSide(decls.padding);
  return null;
}

/** The value a fold rule must carry to add `foldVar` without dropping `base`. */
function composed(base: string | null, foldVar: string): string {
  if (base === null || base === '0' || base === '0px') return `var(${foldVar})`;
  const inner = base.startsWith('calc(') ? base.slice('calc('.length, -1) : base;
  return `calc(${inner} + var(${foldVar}))`;
}

function isFoldValue(value: string): boolean {
  return value.includes('--fold-inline-end') || value.includes('--fold-block-end');
}

/** Every rule that adds the fold inset to `selector`, top level or inside @media, in source order. */
function foldRulesFor(selector: string): Rule[] {
  const found: Rule[] = [];
  STYLES.walkRules((rule) => {
    if (!rule.selectors.some((s) => s === selector || s.endsWith(selector))) return;
    if (Object.values(declsOf(rule)).some(isFoldValue)) found.push(rule);
  });
  return found;
}

/** The first (unconditional, for the derived overlays) fold rule for `selector`. */
function foldRuleFor(selector: string): Rule | undefined {
  return foldRulesFor(selector)[0];
}

// ─── Cascade simulation ──────────────────────────────────────────────────────
//
// A small model of what the browser does for one element's padding: every rule
// in styles.css then mobile.css (index.html link order) whose selector is a
// class compound matching the element, whose enclosing @media matches the
// width, ordered by specificity then source order, shorthand expanded to the
// side asked for. Deliberately narrow: rules nested inside another rule (the
// skin block) or under an at-rule other than @media / @supports are ignored,
// and a media query with any feature other than min/max-width is treated as
// not matching, which is right for a FLAT device (viewport-segments queries
// only match while bent). The numbers it produces were checked against
// getComputedStyle in headless Chromium at every width below.

type Side = 'right' | 'bottom';

interface PaddingDecl {
  order: number;
  file: 'styles.css' | 'mobile.css';
  classes: string[];
  specificity: number;
  media: string | null;
  prop: 'padding' | `padding-${Side}`;
  value: string;
  fold: boolean;
}

/** `.a.b` -> ['a', 'b']; anything that is not a pure class compound -> null. */
function classCompound(selector: string): string[] | null {
  const trimmed = selector.trim();
  if (!/^(\.[A-Za-z0-9_-]+)+$/.test(trimmed)) return null;
  return trimmed.slice(1).split('.');
}

const PADDING_DECLS: PaddingDecl[] = [];
{
  let order = 0;
  for (const [file, root] of [
    ['styles.css', STYLES],
    ['mobile.css', MOBILE],
  ] as const) {
    root.walkRules((rule) => {
      const media: string[] = [];
      let nested = false;
      for (let p = rule.parent; p && p.type !== 'root'; p = p.parent) {
        if (p.type === 'rule') nested = true;
        else if (p.type === 'atrule' && p.name === 'media') media.push(p.params);
        else if (p.type === 'atrule' && p.name !== 'supports') nested = true;
      }
      if (nested) return;
      for (const selector of rule.selectors) {
        const classes = classCompound(selector);
        if (!classes) continue;
        rule.each((node) => {
          if (node.type !== 'decl') return;
          if (!/^padding(-right|-bottom)?$/.test(node.prop)) return;
          PADDING_DECLS.push({
            order: order++,
            file,
            classes,
            specificity: classes.length,
            media: media.length ? media.join(' and ') : null,
            prop: node.prop as PaddingDecl['prop'],
            value: node.value,
            fold: isFoldValue(node.value),
          });
        });
      }
    });
  }
}

/** Does a width-only media query match `width`? Anything else is "not on a flat device". */
function mediaMatches(params: string, width: number): boolean {
  return params.split(',').some((alt) =>
    alt.split(/\s+and\s+/).every((term) => {
      const t = term.trim();
      if (t === 'screen' || t === 'all') return true;
      const m = /^\((max|min)-width:\s*(\d+(?:\.\d+)?)px\)$/.exec(t);
      if (!m) return false;
      return m[1] === 'max' ? width <= Number(m[2]) : width >= Number(m[2]);
    })
  );
}

/** Split a shorthand on whitespace outside parentheses. */
function tokens(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of value.trim()) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** The side of a 1-4 value `padding` shorthand. */
function shorthandSideOf(value: string, side: Side): string {
  const t = tokens(value);
  if (t.length < 1 || t.length > 4) throw new Error(`padding shorthand not handled: ${value}`);
  const [top, right = top, bottom = top, left = right] = t;
  void left;
  return side === 'right' ? right : bottom;
}

/**
 * What `padding-<side>` resolves to for an element carrying `classes` at
 * `width`, as the declaration VALUE that wins (null when nothing sets it).
 * `withFold: false` drops every declaration that references a fold variable,
 * which is the cascade a non-folding build would have.
 */
function cascadedPadding(classes: string[], side: Side, width: number, withFold: boolean): string | null {
  const have = new Set(classes);
  const winners = PADDING_DECLS.filter(
    (d) =>
      (withFold || !d.fold) &&
      (d.file === 'styles.css' || width <= 1023) &&
      (d.media === null || mediaMatches(d.media, width)) &&
      d.classes.every((c) => have.has(c)) &&
      (d.prop === 'padding' || d.prop === `padding-${side}`)
  );
  winners.sort((a, b) => a.specificity - b.specificity || a.order - b.order);
  const last = winners.at(-1);
  if (!last) return null;
  return last.prop === 'padding' ? shorthandSideOf(last.value, side) : last.value;
}

/** Every breakpoint either stylesheet keys on, plus a phone, a Duo posture and a desktop. */
const WIDTHS = [393, 430, 500, 600, 626, 768, 900, 1400];

describe('fold reserved region: custom properties', () => {
  it('defaults to zero, so nothing moves on a device that does not fold', () => {
    const roots = rulesFor(STYLES, ':root').map(declsOf);
    const defaults = roots.filter((d) => d['--fold-inline-end'] || d['--fold-block-end']);

    // The overriding definitions live inside @media blocks, which walkRules
    // reaches too, so the unconditional one is the last top-level :root.
    expect(defaults.length).toBeGreaterThanOrEqual(3);
    expect(defaults[0]['--fold-inline-end']).toBe('0px');
    expect(defaults[0]['--fold-block-end']).toBe('0px');
  });

  it('measures the strip from the LEADING segment in each axis', () => {
    // env() indices are [column, row] with (0,0) the top-left segment, so the
    // left segment's right edge is `0 0` and the top segment's bottom edge is
    // `0 0` as well. Swapping an index silently measures the wrong strip.
    const byQuery = new Map<string, Decls>();
    STYLES.walkAtRules('media', (at) => {
      at.walkRules(':root', (rule) => byQuery.set(at.params, declsOf(rule)));
    });

    expect(byQuery.get('(horizontal-viewport-segments: 2)')?.['--fold-inline-end']).toBe(
      'calc(100vw - env(viewport-segment-right 0 0, 100vw))'
    );
    expect(byQuery.get('(vertical-viewport-segments: 2)')?.['--fold-block-end']).toBe(
      'calc(100vh - env(viewport-segment-bottom 0 0, 100vh))'
    );
  });

  it('caps the response viewer to the bottom segment in tabletop pose', () => {
    // A vertical hinge through a full-width bottom sheet is fine; a horizontal
    // one folds the transcript away mid-read.
    const rule = rulesFor(STYLES, '.response-viewer').find((r) =>
      declsOf(r)['max-height']?.includes('viewport-segment')
    );

    expect(rule?.parent).toMatchObject({ params: '(vertical-viewport-segments: 2)' });
    expect(declsOf(rule!)['max-height']).toBe('min(88vh, env(viewport-segment-height 0 1, 88vh))');
  });
});

describe('fold reserved region: every centred overlay is covered', () => {
  it('finds the overlays it is meant to guard', () => {
    // A rename that empties this list would turn every assertion below into a
    // no-op, so the count is pinned.
    expect(CENTRED_OVERLAYS.length).toBe(7);
  });

  it.each(CENTRED_OVERLAYS.map((o) => [o.selector, o] as const))('%s keeps its dialog out of the hinge', (_, o) => {
    const fold = foldRuleFor(o.selector);
    expect(fold, `${o.selector} has no fold rule`).toBeDefined();

    const d = declsOf(fold!);
    expect(d['padding-right']).toBe(composed(effectivePadding(o.decls, 'right'), '--fold-inline-end'));
    expect(d['padding-bottom']).toBe(composed(effectivePadding(o.decls, 'bottom'), '--fold-block-end'));
  });

  /**
   * The elements whose padding cascade is simulated: every derived overlay as
   * a bare element, plus the open command palette, which is a `.modal` wearing
   * two more classes and the one overlay mobile.css pads with a shorthand, plus
   * the mobile prompt composer, a `.paste-overlay` wearing a second class that
   * carries its own `padding` shorthand. The derived list cannot see the
   * composer (it inherits the centring declarations rather than declaring
   * them), and simulating `['paste-overlay']` alone stayed green while the
   * generic `.paste-overlay` fold rule erased the composer's bottom gutter.
   */
  const ELEMENTS: { name: string; classes: string[] }[] = [
    ...CENTRED_OVERLAYS.map((o) => ({ name: o.selector, classes: classCompound(o.selector)! })),
    { name: '.modal.command-palette-modal.active', classes: ['modal', 'command-palette-modal', 'active'] },
    { name: '.paste-overlay.prompt-composer-overlay', classes: ['paste-overlay', 'prompt-composer-overlay'] },
  ];

  it('simulates the cascade the browser measured', () => {
    // Anchors for the model, all read off getComputedStyle in headless
    // Chromium (styles.css + mobile.css in index.html link order): the phone
    // path picker is flush under 600px and keeps its 16px gutter above it;
    // the palette carries mobile.css's 0.75rem side gutter only inside the
    // 600-768px band. A model that cannot reproduce these numbers proves
    // nothing about the fold rules built on top of them.
    const picker = ['path-picker-overlay'];
    expect(cascadedPadding(picker, 'right', 393, false)).toBe('0');
    expect(cascadedPadding(picker, 'right', 626, false)).toBe('16px');
    const palette = ELEMENTS.find((e) => e.name === '.modal.command-palette-modal.active')!.classes;
    expect(cascadedPadding(palette, 'right', 393, false)).toBeNull();
    expect(cascadedPadding(palette, 'right', 626, false)).toBe('0.75rem');
    expect(cascadedPadding(palette, 'bottom', 626, false)).toBe('0');
    expect(cascadedPadding(palette, 'right', 900, false)).toBeNull();
  });

  it.each(ELEMENTS.map((e) => [e.name, e.classes] as const))(
    '%s ends up with exactly its own gutter plus the fold strip at every breakpoint',
    (_, classes) => {
      for (const width of WIDTHS) {
        for (const side of ['right', 'bottom'] as const) {
          const foldVar = side === 'right' ? '--fold-inline-end' : '--fold-block-end';
          const base = cascadedPadding(classes, side, width, false);
          const actual = cascadedPadding(classes, side, width, true);
          expect(actual, `padding-${side} at ${width}px (base ${base})`).toBe(composed(base, foldVar));
        }
      }
    }
  );

  it('composes with the padding shorthand mobile.css gives the command palette, inside that band only', () => {
    // mobile.css loads after styles.css and sets a `padding` SHORTHAND on
    // .command-palette-modal between 600 and 768px, exactly where a folding
    // phone lives, so a bare .command-palette-modal rule would lose to it and
    // the compound rule has to restate BOTH of that band's gutters. Scoped to
    // the same band: unscoped, it added 0.75rem where the palette has no side
    // gutter at all and pushed the shell 6px off centre.
    const mobileRule = rulesFor(MOBILE, '.command-palette-modal').find((r) => declsOf(r).padding);
    expect(mobileRule, 'mobile.css no longer pads the palette; this rule can be simplified').toBeDefined();
    const band = mobileRule!.parent;
    expect(band).toMatchObject({ type: 'atrule', name: 'media' });

    const shorthand = declsOf(mobileRule!).padding;
    const fold = foldRulesFor('.command-palette-modal');
    expect(fold).toHaveLength(1);
    expect(fold[0].selector).toBe('.modal.command-palette-modal');
    expect(fold[0].parent).toMatchObject({ type: 'atrule', name: 'media', params: (band as postcss.AtRule).params });
    expect(declsOf(fold[0])['padding-right']).toBe(composed(shorthandSideOf(shorthand, 'right'), '--fold-inline-end'));
    expect(declsOf(fold[0])['padding-bottom']).toBe(composed(shorthandSideOf(shorthand, 'bottom'), '--fold-block-end'));
  });

  it('gives the response viewer cap a later twin in mobile.css', () => {
    // mobile.css sets `max-height` on .response-viewer at the same specificity
    // under 600px and loads later, so the styles.css cap alone loses on a
    // phone-width foldable. The twin must come after that rule and carry the
    // identical value.
    const capOf = (root: postcss.Root) =>
      rulesFor(root, '.response-viewer').find((r) => declsOf(r)['max-height']?.includes('viewport-segment'));
    const styles = capOf(STYLES);
    const mobile = capOf(MOBILE);
    expect(mobile, 'mobile.css has no twin of the tabletop cap').toBeDefined();
    expect(mobile!.parent).toMatchObject({ params: '(vertical-viewport-segments: 2)' });
    expect(declsOf(mobile!)['max-height']).toBe(declsOf(styles!)['max-height']);

    const competing = rulesFor(MOBILE, '.response-viewer').filter((r) => r !== mobile && declsOf(r)['max-height']);
    expect(competing.length).toBeGreaterThan(0);
    for (const rule of competing) expect(rule.source!.start!.line).toBeLessThan(mobile!.source!.start!.line);
  });
});

/**
 * Load the real MobileDetection against a given UA and viewport width.
 * `const MobileDetection = {...}` is lexical, so the export rides the same
 * script, the recipe used by the other mobile-handlers tests.
 */
function detectionFor(userAgent: string, width: number) {
  const context = vm.createContext({
    console,
    navigator: { userAgent, maxTouchPoints: 5 },
    window: {
      innerWidth: width,
      innerHeight: 800,
      addEventListener: () => {},
      matchMedia: () => ({ matches: true }),
    },
    document: { body: { classList: { add: () => {}, remove: () => {} } }, addEventListener: () => {} },
    setTimeout: () => 1,
    clearTimeout: () => {},
  });
  vm.runInContext(
    `${readFileSync(resolve(PUBLIC, 'mobile-handlers.js'), 'utf8')}\nglobalThis.__MD = MobileDetection;`,
    context,
    { filename: 'mobile-handlers.js' }
  );
  return (context as unknown as { __MD: { isHandheldDevice(): boolean; getDeviceType(): string } }).__MD;
}

describe('a fold never changes which settings the device is using', () => {
  // Per-device settings are namespaced on isHandheldDevice(), which is
  // form-factor based precisely so it holds still while getDeviceType() (a
  // layout decision) follows the width. A posture change that flipped the
  // namespace would drop every opt-in setting the user saved while folded, and
  // an Android foldable really does reload the page when it opens.
  const postures = [
    { name: 'iPhone Duo (outer)', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) Mobile/15E148', w: 466 },
    { name: 'iPhone Duo (inner)', ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) Mobile/15E148', w: 626 },
    { name: 'Find N5 (folded)', ua: 'Mozilla/5.0 (Linux; Android 15; CPH2671) Mobile Safari/537.36', w: 404 },
    { name: 'Find N5 (unfolded)', ua: 'Mozilla/5.0 (Linux; Android 15; CPH2671) Mobile Safari/537.36', w: 1124 },
  ];

  it.each(postures)('$name stays handheld', ({ ua, w }) => {
    expect(detectionFor(ua, w).isHandheldDevice()).toBe(true);
  });

  it('lets the layout follow the width even when it crosses a breakpoint', () => {
    const n5 = postures[3];
    expect(detectionFor(n5.ua, n5.w).getDeviceType()).toBe('desktop');
    expect(detectionFor(postures[2].ua, postures[2].w).getDeviceType()).toBe('mobile');
  });

  it('gives the closed iPhone Duo the phone layout and the open one the tablet layout', () => {
    // 466 sits under the 600px phone cut (#390 moved it up from 430) and 626
    // above it, below 768. Deliberate (see shouldUseMobileOverview), and pinned
    // because the tier flipping under a fold is the kind of thing that looks
    // like a bug later: closed, the Duo is a phone; open, it is a small tablet.
    expect(detectionFor(postures[0].ua, postures[0].w).getDeviceType()).toBe('mobile');
    expect(detectionFor(postures[1].ua, postures[1].w).getDeviceType()).toBe('tablet');
  });
});
