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
 * Two things about it fail silently and neither is observable without the
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

/** The rule that adds the fold inset to `selector`, wherever it lives. */
function foldRuleFor(selector: string): Rule | undefined {
  return STYLES.nodes
    .filter((n): n is Rule => n.type === 'rule')
    .find((rule) => {
      if (!rule.selectors.some((s) => s === selector || s.endsWith(selector))) return false;
      const d = declsOf(rule);
      return Object.values(d).some((v) => v.includes('--fold-inline-end') || v.includes('--fold-block-end'));
    });
}

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

  it('outranks the padding shorthand mobile.css gives the command palette', () => {
    // mobile.css loads after styles.css and sets a `padding` SHORTHAND on
    // .command-palette-modal under 768px, exactly the width a folding phone
    // lives at, so a bare .command-palette-modal rule here would lose to it.
    const mobileRule = rulesFor(MOBILE, '.command-palette-modal').find((r) => declsOf(r).padding);
    expect(mobileRule, 'mobile.css no longer pads the palette; this rule can be simplified').toBeDefined();

    const sideGutter = declsOf(mobileRule!).padding.trim().split(/\s+/)[1];
    const fold = foldRuleFor('.command-palette-modal');

    expect(fold?.selector).toBe('.modal.command-palette-modal');
    expect(declsOf(fold!)['padding-right']).toBe(`calc(${sideGutter} + var(--fold-inline-end))`);
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

  it('gives both iPhone Duo displays the tablet layout', () => {
    // 466 and 626 both sit above the 430px phone cut and below 768. Deliberate
    // (see shouldUseMobileOverview), and pinned because a 5.4" phone landing in
    // the tablet band is the kind of thing that looks like a bug later.
    expect(detectionFor(postures[0].ua, postures[0].w).getDeviceType()).toBe('tablet');
    expect(detectionFor(postures[1].ua, postures[1].w).getDeviceType()).toBe('tablet');
  });
});
