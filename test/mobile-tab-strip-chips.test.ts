/**
 * @fileoverview The phone header's tab strip must read as live tabs.
 *
 * It used to render every inactive tab transparent: grey 11px text floating in
 * unmarked gaps, a boxed Alt+N digit in each (a phone has no Alt key), names cut
 * to 50px so a shared `w1-` prefix was most of what showed, and the tab that did
 * not fit chopped mid-word against the connection dot. On a phone it looked like
 * a row of disabled labels.
 *
 * The fix is four small rules in the phone block of mobile.css, and each has a
 * way to be silently undone, which is what this file fences:
 *
 * - The chip rule is written `:where(.header) .session-tab` so it stays at
 *   (0,1,0). Written `.header .session-tab` it would be (0,2,0), tie with the
 *   per-colour `.session-tab[data-color="red"]` left border in styles.css, and
 *   win on source order (mobile.css loads later): every colour-tagged tab would
 *   lose its identity stripe.
 * - The edge fade is scroll-DRIVEN (no JS). Its two widths must be registered
 *   with @property to interpolate, and @property is only valid at the top
 *   level: nested inside the phone @media it is dropped, the keyframes stop
 *   interpolating, and the fade snaps between states instead of following the
 *   scroll position.
 * - `animation` is a shorthand that resets `animation-timeline`, so the
 *   timeline must be declared AFTER it or the fade silently becomes a 0s time
 *   animation.
 *
 * Parsed with postcss because the declarations live in nested at-rules. The
 * rendered result (chips on dark and light skins, the fade at both scroll ends)
 * was checked in a browser; this is the cheap regression fence. Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss, { type AtRule, type Declaration, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(resolve(import.meta.dirname, '../src/web/public/mobile.css'), 'utf8');
const ROOT = postcss.parse(CSS);
const PHONE_QUERY = '(max-width: 599px)';

/** Declarations of the rule matching `selector` inside the phone block (later rules win). */
function phoneDeclarations(selector: string): Record<string, string> {
  const found: Record<string, string> = {};
  ROOT.walkAtRules('media', (atRule) => {
    if (atRule.params !== PHONE_QUERY) return;
    atRule.walkRules((rule: Rule) => {
      if (!rule.selectors.map((s) => s.trim()).includes(selector)) return;
      rule.walkDecls((decl: Declaration) => {
        found[decl.prop] = decl.value.trim();
      });
    });
  });
  return found;
}

/** The `@property` rule for `name`, wherever it sits. */
function propertyRule(name: string): AtRule | undefined {
  let hit: AtRule | undefined;
  ROOT.walkAtRules('property', (atRule) => {
    if (atRule.params.trim() === name) hit = atRule;
  });
  return hit;
}

function declsOf(node: AtRule | Rule): Record<string, string> {
  const out: Record<string, string> = {};
  node.each((child) => {
    if (child.type === 'decl') out[child.prop] = child.value.trim();
  });
  return out;
}

describe('phone header tab strip', () => {
  describe('chips', () => {
    const chip = phoneDeclarations(':where(.header) .session-tab');

    it('gives every header tab a fill and border from the skin control tokens', () => {
      // Tokens, not literals: the four light skins repaint the header with
      // --glass-bg and define their own --control-* values.
      expect(chip.background).toMatch(/^var\(--control-bg/);
      expect(chip['border-color']).toMatch(/^var\(--control-border/);
      expect(chip.color).toBe('var(--text)');
    });

    it('keeps the chip selector at (0,1,0) so per-colour borders still win', () => {
      // The lookup above only matches the exact `:where(.header)` spelling, so a
      // rewrite to `.header .session-tab` leaves it empty and fails here.
      expect(Object.keys(chip).length).toBeGreaterThan(0);
      expect(phoneDeclarations('.header .session-tab')).toEqual({});
    });

    it('hides the Alt+N digit, which a phone has no key for', () => {
      expect(phoneDeclarations(':where(.header) .session-tab .tab-number').display).toBe('none');
    });

    it('drops the empty action container on inactive tabs only', () => {
      // The active tab's gear and close live in .tab-actions, so the rule must
      // stay scoped to :not(.active).
      expect(phoneDeclarations(':where(.header) .session-tab:not(.active) .tab-actions').display).toBe('none');
      expect(phoneDeclarations(':where(.header) .session-tab .tab-actions')).toEqual({});
    });

    it('leaves enough name to get past a shared w1- prefix', () => {
      const maxWidth = Number.parseFloat(phoneDeclarations('.session-tab .tab-name')['max-width'] ?? '');
      expect(maxWidth).toBeGreaterThanOrEqual(72);
    });
  });

  describe('scroll-driven edge fade', () => {
    it('registers both fade widths at the top level, as lengths starting at 0px', () => {
      for (const name of ['--tab-strip-fade-start', '--tab-strip-fade-end']) {
        const rule = propertyRule(name);
        expect(rule, `${name} is not registered`).toBeDefined();
        // Nested in @media it is invalid and silently ignored.
        expect(rule!.parent?.type, `${name} must be top level`).toBe('root');
        const d = declsOf(rule!);
        expect(d.syntax).toBe("'<length>'");
        expect(d['initial-value']).toBe('0px');
      }
    });

    it('fades only the far edge at the start and only the near edge at the end', () => {
      let frames: Record<string, Record<string, string>> = {};
      ROOT.walkAtRules('keyframes', (atRule) => {
        if (atRule.params.trim() !== 'tab-strip-edge-fade') return;
        frames = {};
        atRule.each((node) => {
          if (node.type !== 'rule') return;
          for (const sel of node.selectors) frames[sel.trim()] = declsOf(node);
        });
      });
      expect(frames['0%']?.['--tab-strip-fade-start']).toBe('0px');
      expect(Number.parseFloat(frames['0%']?.['--tab-strip-fade-end'] ?? '0')).toBeGreaterThan(0);
      expect(frames['100%']?.['--tab-strip-fade-end']).toBe('0px');
      expect(Number.parseFloat(frames['100%']?.['--tab-strip-fade-start'] ?? '0')).toBeGreaterThan(0);
    });

    it('masks the header strip behind a scroll-timeline feature check, timeline after the shorthand', () => {
      let strip: Rule | undefined;
      ROOT.walkAtRules('media', (media) => {
        if (media.params !== PHONE_QUERY) return;
        media.walkAtRules('supports', (supports) => {
          if (!/animation-timeline:\s*scroll\(\)/.test(supports.params)) return;
          supports.walkRules((rule) => {
            if (rule.selectors.map((s) => s.trim()).includes('.header .session-tabs')) strip = rule;
          });
        });
      });
      expect(strip, 'no @supports-gated .header .session-tabs rule in the phone block').toBeDefined();

      const props: string[] = [];
      const d: Record<string, string> = {};
      strip!.each((node) => {
        if (node.type !== 'decl') return;
        props.push(node.prop);
        d[node.prop] = node.value.replace(/\s+/g, ' ').trim();
      });
      for (const prop of ['mask-image', '-webkit-mask-image']) {
        expect(d[prop]).toContain('var(--tab-strip-fade-start)');
        expect(d[prop]).toContain('var(--tab-strip-fade-end)');
      }
      expect(d.animation).toContain('tab-strip-edge-fade');
      expect(d['animation-timeline']).toBe('scroll(self inline)');
      expect(props.indexOf('animation-timeline')).toBeGreaterThan(props.indexOf('animation'));
    });
  });
});
