/**
 * @fileoverview With the on-screen keyboard up, the phone's toolbar and keyboard
 * accessory bar sit DIRECTLY on the keyboard, with no bottom safe-area gap.
 *
 * Both bars are `position: fixed` and `KeyboardHandler.updateLayoutForKeyboard()`
 * lifts them by the whole distance from the layout-viewport bottom to the
 * visual-viewport bottom, i.e. onto the keyboard's top edge. Their CSS `bottom`
 * still added `--safe-area-bottom` (env(safe-area-inset-bottom), 34px on a Face ID
 * iPhone because index.html sets `viewport-fit=cover`), although the keyboard
 * covers the home-indicator strip that inset reserves. Two things followed, both
 * seen on an iPhone:
 *
 * 1. an empty 34px band between the toolbar and the keyboard;
 * 2. the bars stood 34px ABOVE the room `main`'s keyboard padding reserves for
 *    them. That padding (84px, set inline by KeyboardHandler) counts the two
 *    bars only, so the bottom 34px of the terminal box, the last line of the
 *    prompt being typed, was painted under the accessory bar.
 *
 * So the keyboard-up offsets must be the bar stack alone: toolbar at 0, the
 * accessory bar on the toolbar, the CJK textarea on the accessory bar, and the
 * top of that stack equal to the padding the JS reserves.
 *
 * Parsed with postcss: headless Chromium reports a zero safe area, so the browser
 * suite cannot show the gap, and that suite is not part of the CI gate anyway.
 * Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss, { type AtRule, type Root, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const MOBILE = postcss.parse(readFileSync(resolve(PUBLIC, 'mobile.css'), 'utf8'));
const STYLES = postcss.parse(readFileSync(resolve(PUBLIC, 'styles.css'), 'utf8'));
const HANDLERS = readFileSync(resolve(PUBLIC, 'mobile-handlers.js'), 'utf8');

/** The phone breakpoint block of mobile.css (the toolbar is fixed only there). */
function phoneBlock(): AtRule {
  let found: AtRule | undefined;
  MOBILE.walkAtRules('media', (at) => {
    if (!found && at.params.trim() === '(max-width: 599px)' && at.parent?.type === 'root') found = at;
  });
  if (!found) throw new Error('mobile.css has no top-level (max-width: 599px) block');
  return found;
}

/** The last value `prop` gets from a rule whose selector list contains `selector`. */
function lastDecl(root: Root | AtRule, selector: string, prop: string): string | undefined {
  let value: string | undefined;
  root.walkRules((rule: Rule) => {
    if (!rule.selectors.includes(selector)) return;
    // Only the block's own rules: a nested @media inside it applies to a narrower width.
    if (rule.parent !== root) return;
    rule.walkDecls(prop, (d) => {
      value = d.value;
    });
  });
  return value;
}

const PHONE = phoneBlock();

describe('phone bars with the keyboard up', () => {
  // Every selector that sets a keyboard-up `bottom` on these bars, generic and
  // iOS Safari (which needs its own, to outrank `.ios-device.safari-browser .toolbar`).
  const toolbarSelectors = ['.keyboard-visible .toolbar', '.keyboard-visible.ios-device.safari-browser .toolbar'];
  const accessorySelectors = [
    '.keyboard-visible .keyboard-accessory-bar',
    '.keyboard-visible.ios-device.safari-browser .keyboard-accessory-bar',
  ];

  it('reserve no bottom safe area (the keyboard covers the home indicator)', () => {
    for (const selector of [...toolbarSelectors, ...accessorySelectors]) {
      const bottom = lastDecl(PHONE, selector, 'bottom');
      expect(bottom, selector).toBeDefined();
      expect(bottom, selector).not.toMatch(/safe-area|chrome-overlap/);
    }
    const cjk = lastDecl(PHONE, '.touch-device.keyboard-visible #cjkInput.cjk-input-visible', 'bottom');
    expect(cjk).toBeDefined();
    expect(cjk).not.toMatch(/safe-area/);
  });

  it('stack toolbar, accessory bar and CJK textarea with no gaps between them', () => {
    const px = (v: string | undefined) => {
      expect(v).toMatch(/^\d+(px)?$/);
      return parseFloat(v as string);
    };
    const toolbarHeight = px(lastDecl(PHONE, '.toolbar', 'height'));
    const accessoryHeight = px(lastDecl(PHONE, '.keyboard-accessory-bar', 'height'));

    for (const selector of toolbarSelectors) expect(px(lastDecl(PHONE, selector, 'bottom')), selector).toBe(0);
    for (const selector of accessorySelectors) {
      expect(px(lastDecl(PHONE, selector, 'bottom')), selector).toBe(toolbarHeight);
    }
    expect(px(lastDecl(PHONE, '.touch-device.keyboard-visible #cjkInput.cjk-input-visible', 'bottom'))).toBe(
      toolbarHeight + accessoryHeight
    );
  });

  it("put the stack's top exactly where main's keyboard padding ends", () => {
    // KeyboardHandler.updateLayoutForKeyboard(): `${84 + cjkInputHeight}px`.
    const match = HANDLERS.match(/main\.style\.paddingBottom = `\$\{(\d+) \+ cjkInputHeight\}px`/);
    expect(match, 'the keyboard padding assignment in mobile-handlers.js').not.toBeNull();
    const reserved = Number(match![1]);
    const toolbarHeight = parseFloat(lastDecl(PHONE, '.toolbar', 'height') ?? 'NaN');
    const accessoryHeight = parseFloat(lastDecl(PHONE, '.keyboard-accessory-bar', 'height') ?? 'NaN');
    expect(reserved).toBe(toolbarHeight + accessoryHeight);
  });

  it('beat the touch-device CJK rule in styles.css, which still adds the safe area', () => {
    // Same selector in both files: mobile.css loads after styles.css, so its rule
    // wins on a phone. If styles.css ever drops the safe area this test can go.
    expect(lastDecl(STYLES, '.touch-device.keyboard-visible #cjkInput.cjk-input-visible', 'bottom')).toMatch(
      /safe-area-bottom/
    );
    const html = readFileSync(resolve(PUBLIC, 'index.html'), 'utf8');
    expect(html.indexOf('href="styles.css"')).toBeGreaterThan(-1);
    expect(html.indexOf('href="mobile.css"')).toBeGreaterThan(html.indexOf('href="styles.css"'));
  });
});
