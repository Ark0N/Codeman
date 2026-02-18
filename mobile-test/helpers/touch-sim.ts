import type { Page } from 'playwright';
import { getCDP, dispatchTouchEvent } from './cdp.js';
import { SWIPE } from './constants.js';

export type SwipeDirection = 'left' | 'right' | 'up' | 'down';

export interface SwipeOptions {
  /** Distance in pixels (default: SWIPE.MIN_DISTANCE + 20 = 100) */
  distance?: number;
  /** Duration in ms (default: 150, must be < SWIPE.MAX_TIME) */
  duration?: number;
  /** Number of intermediate touch move points (default: 5) */
  steps?: number;
  /** Start position override (default: center of target element) */
  startPoint?: { x: number; y: number };
}

// ─── CDP Touch (Chromium, trusted events) ───

/** Perform a swipe gesture via CDP Input.dispatchTouchEvent (trusted, Chromium only).
 *  Target element defaults to '.main' (where SwipeHandler listens). */
export async function swipeViaCDP(
  page: Page,
  direction: SwipeDirection,
  options: SwipeOptions = {},
): Promise<void> {
  const {
    distance = SWIPE.MIN_DISTANCE + 20,
    duration = 150,
    steps = 5,
  } = options;

  const cdp = await getCDP(page);
  const targetSelector = '.main';
  const box = await page.locator(targetSelector).boundingBox();
  if (!box) throw new Error(`Element ${targetSelector} not found`);

  let startX: number, startY: number, endX: number, endY: number;

  if (options.startPoint) {
    startX = options.startPoint.x;
    startY = options.startPoint.y;
  } else {
    startX = box.x + box.width / 2;
    startY = box.y + box.height / 2;
  }

  // Calculate end point based on direction
  switch (direction) {
    case 'left':
      startX = box.x + box.width * 0.75;
      endX = startX - distance;
      endY = startY;
      break;
    case 'right':
      startX = box.x + box.width * 0.25;
      endX = startX + distance;
      endY = startY;
      break;
    case 'up':
      endX = startX;
      endY = startY - distance;
      break;
    case 'down':
      endX = startX;
      endY = startY + distance;
      break;
  }

  // Touch start
  await dispatchTouchEvent(cdp, 'touchStart', [{ x: startX, y: startY }]);

  // Intermediate moves
  const stepDelay = duration / steps;
  for (let i = 1; i <= steps; i++) {
    const progress = i / steps;
    const x = startX + (endX! - startX) * progress;
    const y = startY + (endY! - startY) * progress;
    await dispatchTouchEvent(cdp, 'touchMove', [{ x, y }]);
    await page.waitForTimeout(stepDelay);
  }

  // Touch end
  await dispatchTouchEvent(cdp, 'touchEnd', []);
}

// ─── Synthetic Touch (cross-engine fallback) ───

/** Perform a swipe gesture via synthetic TouchEvent dispatch.
 *  Events have isTrusted=false but still trigger handler callbacks. */
export async function swipeViaSynthetic(
  page: Page,
  direction: SwipeDirection,
  options: SwipeOptions = {},
): Promise<void> {
  const {
    distance = SWIPE.MIN_DISTANCE + 20,
    duration = 150,
    steps = 5,
  } = options;

  await page.evaluate(
    ({ dir, dist, dur, numSteps }) => {
      const main = document.querySelector('.main');
      if (!main) return;

      const rect = main.getBoundingClientRect();
      let startX = rect.left + rect.width / 2;
      let startY = rect.top + rect.height / 2;
      let endX = startX;
      let endY = startY;

      switch (dir) {
        case 'left':
          startX = rect.left + rect.width * 0.75;
          endX = startX - dist;
          break;
        case 'right':
          startX = rect.left + rect.width * 0.25;
          endX = startX + dist;
          break;
        case 'up':
          endY = startY - dist;
          break;
        case 'down':
          endY = startY + dist;
          break;
      }

      function createTouch(x: number, y: number) {
        return new Touch({
          identifier: 0,
          target: main!,
          clientX: x,
          clientY: y,
          pageX: x,
          pageY: y,
        });
      }

      // touchstart
      main.dispatchEvent(new TouchEvent('touchstart', {
        touches: [createTouch(startX, startY)],
        changedTouches: [createTouch(startX, startY)],
        bubbles: true,
        cancelable: true,
      }));

      // Intermediate moves
      const stepDelay = dur / numSteps;
      for (let i = 1; i <= numSteps; i++) {
        const progress = i / numSteps;
        const x = startX + (endX - startX) * progress;
        const y = startY + (endY - startY) * progress;
        setTimeout(() => {
          main.dispatchEvent(new TouchEvent('touchmove', {
            touches: [createTouch(x, y)],
            changedTouches: [createTouch(x, y)],
            bubbles: true,
            cancelable: true,
          }));
        }, stepDelay * i);
      }

      // touchend
      setTimeout(() => {
        main.dispatchEvent(new TouchEvent('touchend', {
          touches: [],
          changedTouches: [createTouch(endX, endY)],
          bubbles: true,
          cancelable: true,
        }));
      }, dur + 10);
    },
    { dir: direction, dist: distance, dur: duration, numSteps: steps },
  );

  // Wait for the full gesture + a little buffer
  await page.waitForTimeout(duration + 100);
}

// ─── Unified API ───

/** Perform a swipe gesture using the best available method.
 *  Uses CDP for Chromium (trusted events), synthetic for WebKit. */
export async function swipe(
  page: Page,
  direction: SwipeDirection,
  options: SwipeOptions & { isChromium?: boolean } = {},
): Promise<void> {
  const { isChromium = true, ...swipeOpts } = options;

  if (isChromium) {
    try {
      await swipeViaCDP(page, direction, swipeOpts);
      return;
    } catch {
      // Fall through to synthetic
    }
  }

  await swipeViaSynthetic(page, direction, swipeOpts);
}

/** Tap an element via CDP (trusted touch) */
export async function tapViaCDP(page: Page, selector: string): Promise<void> {
  const cdp = await getCDP(page);
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`Element ${selector} not found for tap`);

  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  await dispatchTouchEvent(cdp, 'touchStart', [{ x, y }]);
  await page.waitForTimeout(50);
  await dispatchTouchEvent(cdp, 'touchEnd', []);
}

/** Tap an element via synthetic touch (cross-engine) */
export async function tapViaSynthetic(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const touch = new Touch({
      identifier: 0,
      target: el,
      clientX: x,
      clientY: y,
    });
    el.dispatchEvent(new TouchEvent('touchstart', {
      touches: [touch],
      changedTouches: [touch],
      bubbles: true,
    }));
    el.dispatchEvent(new TouchEvent('touchend', {
      touches: [],
      changedTouches: [touch],
      bubbles: true,
    }));
  }, selector);
}

/** Tap using the best available method */
export async function tap(
  page: Page,
  selector: string,
  options: { isChromium?: boolean } = {},
): Promise<void> {
  if (options.isChromium !== false) {
    try {
      await tapViaCDP(page, selector);
      return;
    } catch {
      // Fall through
    }
  }
  await tapViaSynthetic(page, selector);
}
