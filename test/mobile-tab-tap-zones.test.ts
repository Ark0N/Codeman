/**
 * @fileoverview A phone tab's tap-to-switch area must stay bigger than its
 * action icons.
 *
 * The active tab is the only one that grows a gear and a close button, and on a
 * phone they were eating it: with a short session name ("w1", "api") the label
 * rendered 13-16px wide while gear + close took 50px of a 116px tab, so the
 * tab's geometric CENTRE landed on the gear. Aiming a thumb at the middle of
 * the tab opened Session Options instead of switching sessions, measured at
 * 360, 393 and 430px.
 *
 * `min-width` on the active tab's name is what fixes it, and this guard pins the
 * arithmetic behind the number rather than the number itself.
 *
 * ⚠️ The governing case is the 10th tab onward, NOT the tabs you can see.
 * `.tab-number` is rendered only for `_tabIdx < 9` (app.js), so tab 10 loses
 * 16px + a 4px gap off its left and its centre sits 10px further right. Measured
 * in Chromium at 393px: a NUMBERED tab clears the gear once the label reserves
 * 20px, a numberless one needs 40px. Reasoning from the tabs on screen is
 * exactly what would put the centre back on the gear.
 *
 * The centre sits left of the icons when
 *
 *     reserved > icons + rightEdge - leftRunUp - gap
 *
 * which is what `requiredReserve()` below recomputes from the stylesheet, so
 * widening the gear or the padding fails here instead of on someone's phone.
 * Note this is "off the icons", not "inside the label": on a numberless tab the
 * centre lands in the 4px gap between the name and the icons, which still
 * switches sessions, because the click handler is on the tab and gear/close
 * both `stopPropagation()`.
 *
 * Parsed with postcss instead of a regex because the declarations live in a
 * nested `@media` block. Behaviour (the tap itself, the gear still opening
 * options, tablets unaffected) is covered live in a browser; this file is the
 * cheap regression fence. Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import postcss, { type Declaration, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync(resolve(import.meta.dirname, '../src/web/public/mobile.css'), 'utf8');
const ROOT = postcss.parse(CSS);
/** The phone block. Tablets keep the roomier layout and are deliberately out of scope. */
const PHONE_QUERY = '(max-width: 599px)';
/** `.session-tab` border, from styles.css: `border: 1px solid transparent`. */
const TAB_BORDER = 1;
/**
 * Hit testing snaps to whole pixels, so a centre half a pixel left of the icons
 * still reports as the gear (measured: 39px reserved -> centre 59.5, icons at
 * 60.0, `elementFromPoint` returned `.tab-gear`). One pixel is the rounding, the
 * second is deliberate slack.
 */
const ROUNDING_ALLOWANCE = 2;

/** Declarations for a selector inside the phone media block, later rules winning. */
function phoneDeclarations(selector: string): Record<string, string> {
  const found: Record<string, string> = {};
  ROOT.walkAtRules('media', (atRule) => {
    if (atRule.params !== PHONE_QUERY) return;
    atRule.walkRules((rule: Rule) => {
      const selectors = rule.selectors.map((s) => s.trim());
      if (!selectors.includes(selector)) return;
      rule.walkDecls(record(found));
    });
  });
  return found;
}

/** Declarations for a selector anywhere at or above the phone block (e.g. the <=768px one). */
function mobileDeclarations(selector: string): Record<string, string> {
  const found: Record<string, string> = {};
  ROOT.walkRules((rule: Rule) => {
    if (!rule.selectors.map((s) => s.trim()).includes(selector)) return;
    rule.walkDecls(record(found));
  });
  return found;
}

/**
 * postcss lifts `!important` off the value onto `decl.important`, and here it is
 * load-bearing rather than noise (it is what beats the hover/detached reveal
 * rules in styles.css), so put it back where a test can assert it.
 */
const record =
  (into: Record<string, string>) =>
  (decl: Declaration): void => {
    into[decl.prop] = decl.value.trim() + (decl.important ? ' !important' : '');
  };

/** px value of a single CSS length. `rem` resolves against the untouched 16px root. */
const len = (value: string | undefined): number => {
  if (!value) return NaN;
  const m = /^(-?[\d.]+)(px|rem)?$/.exec(value.trim());
  if (!m) return NaN;
  return Number.parseFloat(m[1]!) * (m[2] === 'rem' ? 16 : 1);
};
/** Horizontal component of a `padding: <v> <h>` shorthand. */
const paddingX = (shorthand: string | undefined): number => {
  const parts = shorthand?.trim().split(/\s+/) ?? [];
  return len(parts.length >= 2 ? parts[1] : parts[0]);
};

describe('phone tab tap zones', () => {
  const name = phoneDeclarations('.session-tab.active .tab-name');
  const nameShared = phoneDeclarations('.session-tab .tab-name');
  const tab = phoneDeclarations('.session-tab');
  const status = phoneDeclarations('.session-tab .tab-status');
  const gear = phoneDeclarations('.session-tab.active .tab-gear');
  const close = phoneDeclarations('.session-tab.active .tab-close');

  const reserved = len(name['min-width']);
  const gap = len(tab.gap);
  const padX = paddingX(tab.padding);
  /** gear + close, less the negative margin that overlaps them. */
  const icons = len(gear.width) + len(close.width) + len(close['margin-left']);

  /**
   * The worst case: tab 10+, which renders no `.tab-number`, so the left run-up
   * is border + padding + status dot + one gap.
   */
  function requiredReserve(): number {
    const leftRunUp = TAB_BORDER + padX + len(status.width) + gap;
    const rightEdge = padX + TAB_BORDER;
    return icons + rightEdge - leftRunUp - gap;
  }

  it('reads every term the arithmetic depends on', () => {
    // A typo'd selector would silently make every threshold below NaN, and NaN
    // comparisons are always false, so a broken parse must fail loudly here.
    for (const [label, value] of Object.entries({ reserved, gap, padX, icons, status: len(status.width) })) {
      expect(value, `${label} did not parse`).toBeGreaterThan(0);
    }
  });

  it('reserves enough label that a numberless tab centres off its action icons', () => {
    // This is the whole point, and the 10th tab is the one that decides it.
    expect(reserved).toBeGreaterThanOrEqual(requiredReserve() + ROUNDING_ALLOWANCE);
  });

  it('keeps the measured practical floor', () => {
    // Belt to the braces above: 40px is where a numberless tab was measured to
    // stop hit-testing onto the gear at 360/393/430px.
    expect(reserved).toBeGreaterThanOrEqual(40);
  });

  it('the reserved width still fits inside the truncation cap', () => {
    // A min-width above the max-width would stretch every tab to the reserved
    // size and silently undo the aggressive phone truncation.
    expect(reserved).toBeLessThanOrEqual(len(nameShared['max-width']));
  });

  it('the icons stay tappable in their own right', () => {
    // Shrinking the icons is the other way to win this argument, and it trades
    // one mis-tap for another. They must not get smaller than this.
    expect(len(gear.width)).toBeGreaterThanOrEqual(28);
    expect(len(close.width)).toBeGreaterThanOrEqual(18);
  });

  it('icons stay hidden on non-active tabs, so those are tappable end to end', () => {
    expect(phoneDeclarations('.session-tab .tab-gear').display).toBe('none');
  });

  it('the pop-out icon stays out of the cluster on handhelds', () => {
    // `icons` above counts gear + close only. If detach ever became visible on a
    // phone the reserve would be ~30px short and the centre would walk back.
    expect(mobileDeclarations('.session-tab .tab-detach').display).toBe('none !important');
  });
});
