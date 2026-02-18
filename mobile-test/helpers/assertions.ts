import type { Page, Locator } from 'playwright';
import { MIN_TOUCH_TARGET, BREAKPOINTS, BODY_CLASSES, SELECTORS } from './constants.js';

/** Assert an element meets minimum touch target size (WCAG 2.5.5 / Apple HIG) */
export async function assertTouchTarget(
  locator: Locator,
  minSize: number = MIN_TOUCH_TARGET,
): Promise<void> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(minSize);
  expect(box!.height).toBeGreaterThanOrEqual(minSize);
}

/** Assert no horizontal overflow (scrollbar) exists */
export async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const overflow = await page.evaluate(() => {
    return document.documentElement.scrollWidth > document.documentElement.clientWidth;
  });
  expect(overflow).toBe(false);
}

/** Assert element has fixed positioning */
export async function assertFixedPosition(page: Page, selector: string): Promise<void> {
  const position = await getCSSProperty(page, selector, 'position');
  expect(position).toBe('fixed');
}

/** Assert correct body device classes based on viewport width */
export async function assertDeviceClasses(page: Page, width: number): Promise<void> {
  const classes = await page.evaluate(() => document.body.className);

  if (width < BREAKPOINTS.PHONE_MAX) {
    expect(classes).toContain(BODY_CLASSES.MOBILE);
    expect(classes).not.toContain(BODY_CLASSES.TABLET);
    expect(classes).not.toContain(BODY_CLASSES.DESKTOP);
  } else if (width < BREAKPOINTS.TABLET_MAX) {
    expect(classes).not.toContain(BODY_CLASSES.MOBILE);
    expect(classes).toContain(BODY_CLASSES.TABLET);
    expect(classes).not.toContain(BODY_CLASSES.DESKTOP);
  } else {
    expect(classes).not.toContain(BODY_CLASSES.MOBILE);
    expect(classes).not.toContain(BODY_CLASSES.TABLET);
    expect(classes).toContain(BODY_CLASSES.DESKTOP);
  }
}

/** Assert element is hidden (display:none or visibility:hidden or not in DOM) */
export async function assertHidden(page: Page, selector: string): Promise<void> {
  const visible = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }, selector);
  expect(visible).toBe(false);
}

/** Assert element is visible */
export async function assertVisible(page: Page, selector: string): Promise<void> {
  const visible = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
  }, selector);
  expect(visible).toBe(true);
}

/** Get a computed CSS property value */
export async function getCSSProperty(
  page: Page,
  selector: string,
  property: string,
): Promise<string> {
  return page.evaluate(
    ({ sel, prop }) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`Element not found: ${sel}`);
      return getComputedStyle(el).getPropertyValue(prop);
    },
    { sel: selector, prop: property },
  );
}

/** Get computed numeric value (parses px values) */
export async function getCSSNumericValue(
  page: Page,
  selector: string,
  property: string,
): Promise<number> {
  const value = await getCSSProperty(page, selector, property);
  return parseFloat(value) || 0;
}

/** Scan ALL visible interactive elements for touch target compliance.
 *  Returns list of violations (elements smaller than minSize). */
export async function assertAccessibleTouchTargets(
  page: Page,
  minSize: number = MIN_TOUCH_TARGET,
): Promise<{ selector: string; width: number; height: number }[]> {
  const violations = await page.evaluate((min) => {
    const interactiveSelectors = 'button, a, [role="button"], input, select, textarea, [tabindex]';
    const elements = document.querySelectorAll(interactiveSelectors);
    const results: { selector: string; width: number; height: number }[] = [];

    for (const el of elements) {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        continue;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.width < min || rect.height < min) {
        // Generate a useful selector for the failing element
        const tag = el.tagName.toLowerCase();
        const id = el.id ? `#${el.id}` : '';
        const cls = el.className && typeof el.className === 'string'
          ? '.' + el.className.trim().split(/\s+/).join('.')
          : '';
        const text = el.textContent?.trim().substring(0, 20) || '';
        results.push({
          selector: `${tag}${id}${cls} ("${text}")`,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        });
      }
    }
    return results;
  }, minSize);

  return violations;
}

/** Assert font-size >= 16px on text inputs (prevents iOS auto-zoom) */
export async function assertFontSizeNoZoom(page: Page, selector: string): Promise<void> {
  const fontSize = await getCSSNumericValue(page, selector, 'font-size');
  expect(fontSize).toBeGreaterThanOrEqual(16);
}

/** Assert an element has a specific CSS class */
export async function assertHasClass(page: Page, selector: string, className: string): Promise<void> {
  const has = await page.evaluate(
    ({ sel, cls }) => document.querySelector(sel)?.classList.contains(cls) ?? false,
    { sel: selector, cls: className },
  );
  expect(has).toBe(true);
}

/** Assert an element does NOT have a specific CSS class */
export async function assertNotHasClass(page: Page, selector: string, className: string): Promise<void> {
  const has = await page.evaluate(
    ({ sel, cls }) => document.querySelector(sel)?.classList.contains(cls) ?? false,
    { sel: selector, cls: className },
  );
  expect(has).toBe(false);
}

/** Assert element's computed transform includes a translateY value */
export async function assertTranslateY(
  page: Page,
  selector: string,
  expectedY: number,
  tolerance: number = 2,
): Promise<void> {
  const transform = await getCSSProperty(page, selector, 'transform');
  // transform is a matrix(...) string; extract translateY
  // matrix(a, b, c, d, tx, ty) — ty is the 6th value
  const match = transform.match(/matrix\([^,]+,[^,]+,[^,]+,[^,]+,[^,]+,\s*([^)]+)\)/);
  const ty = match ? parseFloat(match[1]) : 0;
  expect(Math.abs(ty - expectedY)).toBeLessThanOrEqual(tolerance);
}

/** Check viewport meta tag doesn't disable zoom */
export async function assertZoomNotDisabled(page: Page): Promise<void> {
  const meta = await page.evaluate(() => {
    const el = document.querySelector('meta[name="viewport"]');
    return el?.getAttribute('content') || '';
  });
  expect(meta).not.toContain('maximum-scale=1');
  expect(meta).not.toContain('user-scalable=no');
  expect(meta).not.toContain('user-scalable=0');
}
