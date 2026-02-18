import type { Page } from 'playwright';
import { getCDP, setVisualViewportHeight, clearDeviceMetricsOverride } from './cdp.js';

export type KeyboardLayer = 'cdp' | 'mock' | 'dom';

export interface KeyboardSimOptions {
  /** Preferred layer (auto-selects best available if not specified) */
  preferredLayer?: KeyboardLayer;
  /** Whether the page is running in Chromium (CDP available) */
  isChromium?: boolean;
}

/** Result of a keyboard simulation attempt */
export interface KeyboardSimResult {
  layer: KeyboardLayer;
  success: boolean;
}

// ─── Page globals access ───
// KeyboardHandler and app are `const` declarations in app.js (not a module).
// `const` at script top-level lives in the global lexical environment but
// is NOT a property of `window`.  Use string-based page.evaluate() to
// access them, which runs directly in the page's global scope.

/** Check if KeyboardHandler.keyboardVisible is true */
async function isKeyboardVisible(page: Page): Promise<boolean> {
  return page.evaluate(`
    typeof KeyboardHandler !== 'undefined' && KeyboardHandler.keyboardVisible === true
  `);
}

/** Check if KeyboardHandler.keyboardVisible is false (explicitly false, not undefined) */
async function isKeyboardHidden(page: Page): Promise<boolean> {
  return page.evaluate(`
    typeof KeyboardHandler !== 'undefined' && KeyboardHandler.keyboardVisible === false
  `);
}

// ─── Layer 1: CDP Metrics Override (Chromium only) ───

/** Simulate keyboard show by shrinking device metrics via CDP.
 *  In headless mode, setDeviceMetricsOverride changes BOTH innerHeight and
 *  visualViewport.height. On a real device, only visualViewport shrinks while
 *  innerHeight stays at the layout viewport size. The safety check in
 *  updateLayoutForKeyboard() computes keyboardOffset = innerHeight - vv.height
 *  and dismisses if <= 0. So we must override innerHeight to return the
 *  original value and visualViewport.height to return the shrunk value. */
export async function showKeyboardViaCDP(page: Page, keyboardHeight: number): Promise<boolean> {
  try {
    const cdp = await getCDP(page);
    const viewport = page.viewportSize()!;
    const newHeight = viewport.height - keyboardHeight;
    await setVisualViewportHeight(
      cdp,
      viewport.width,
      newHeight,
      1,
    );
    await page.waitForTimeout(100);

    await page.evaluate(`(function(newH, origH) {
      var vv = window.visualViewport;
      if (!vv) return;

      // Override visualViewport.height to return shrunk value
      Object.defineProperty(vv, 'height', {
        get: function() { return newH; },
        configurable: true,
      });

      // CRITICAL: Override innerHeight to return ORIGINAL height.
      // CDP changes both innerHeight and visualViewport, but on real devices
      // only visualViewport shrinks. Without this, the safety check in
      // updateLayoutForKeyboard() sees keyboardOffset=0 and dismisses.
      Object.defineProperty(window, 'innerHeight', {
        get: function() { return origH; },
        configurable: true,
      });

      // Directly invoke handler — event dispatch alone is unreliable in headless
      if (typeof KeyboardHandler !== 'undefined' &&
          typeof KeyboardHandler.handleViewportResize === 'function') {
        KeyboardHandler.handleViewportResize();
      }

      vv.dispatchEvent(new Event('resize'));
    })(${newHeight}, ${viewport.height})`);
    await page.waitForTimeout(300);
    return isKeyboardVisible(page);
  } catch {
    return false;
  }
}

/** Dismiss keyboard via CDP by restoring original metrics */
export async function hideKeyboardViaCDP(page: Page): Promise<boolean> {
  try {
    const cdp = await getCDP(page);
    await clearDeviceMetricsOverride(cdp);
    await page.waitForTimeout(100);
    // Restore height overrides to original values, then invoke handler.
    // Note: `delete vv.height` does NOT work on VisualViewport platform objects
    // in Chromium — the instance property override persists. We must explicitly
    // redefine the getter to return the original height.
    await page.evaluate(`(function() {
      var vv = window.visualViewport;
      if (!vv) return;

      // Get the original height (initialViewportHeight was set during init)
      var origH = (typeof KeyboardHandler !== 'undefined')
        ? KeyboardHandler.initialViewportHeight
        : window.innerHeight;

      // Override height to return original value (simulates keyboard dismiss)
      Object.defineProperty(vv, 'height', {
        get: function() { return origH; },
        configurable: true,
      });

      // Restore innerHeight to original value too
      Object.defineProperty(window, 'innerHeight', {
        get: function() { return origH; },
        configurable: true,
      });

      // Invoke handler — sees matching heights, triggers hide
      if (typeof KeyboardHandler !== 'undefined' &&
          typeof KeyboardHandler.handleViewportResize === 'function') {
        KeyboardHandler.handleViewportResize();
      }

      vv.dispatchEvent(new Event('resize'));
    })()`);
    await page.waitForTimeout(300);
    return isKeyboardHidden(page);
  } catch {
    return false;
  }
}

// ─── Layer 2: VisualViewport Mock (cross-engine) ───

/** Install visualViewport height mock via addInitScript.
 *  MUST be called before page.goto(). */
export async function setupViewportMock(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let heightOverride: number | null = null;
    const realVV = window.visualViewport;
    if (!realVV) return;

    const origDesc = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(realVV),
      'height',
    );

    Object.defineProperty(realVV, 'height', {
      get() {
        if (heightOverride !== null) return heightOverride;
        return origDesc?.get?.call(this) ?? window.innerHeight;
      },
      configurable: true,
    });

    (window as any).__mockKeyboardHeight = (kbHeight: number | null) => {
      heightOverride = kbHeight !== null ? window.innerHeight - kbHeight : null;
      realVV.dispatchEvent(new Event('resize'));
    };
  });
}

/** Show keyboard via visualViewport mock */
export async function showKeyboardViaMock(page: Page, keyboardHeight: number): Promise<boolean> {
  try {
    await page.evaluate((h) => {
      const fn = (window as any).__mockKeyboardHeight;
      if (fn) fn(h);
    }, keyboardHeight);
    await page.waitForTimeout(300);
    return isKeyboardVisible(page);
  } catch {
    return false;
  }
}

/** Hide keyboard via visualViewport mock */
export async function hideKeyboardViaMock(page: Page): Promise<boolean> {
  try {
    await page.evaluate(() => {
      const fn = (window as any).__mockKeyboardHeight;
      if (fn) fn(null);
    });
    await page.waitForTimeout(300);
    return isKeyboardHidden(page);
  } catch {
    return false;
  }
}

// ─── Layer 3: Direct DOM Manipulation (fallback) ───

/** Force keyboard visible state via direct DOM manipulation.
 *  Does not trigger KeyboardHandler — sets CSS state only. */
export async function showKeyboardViaDOM(page: Page, keyboardHeight: number): Promise<boolean> {
  try {
    await page.evaluate(`(function(h) {
      document.body.classList.add('keyboard-visible');
      // Set KeyboardHandler state if it exists
      if (typeof KeyboardHandler !== 'undefined') KeyboardHandler.keyboardVisible = true;

      var toolbar = document.querySelector('.toolbar');
      var accessoryBar = document.querySelector('.keyboard-accessory-bar');
      var main = document.querySelector('.main');

      if (toolbar) toolbar.style.transform = 'translateY(' + (-h) + 'px)';
      if (accessoryBar) {
        accessoryBar.classList.add('visible');
        accessoryBar.style.transform = 'translateY(' + (-h) + 'px)';
      }
      if (main) main.style.paddingBottom = (h + 94) + 'px';
    })(${keyboardHeight})`);
    return true;
  } catch {
    return false;
  }
}

/** Hide keyboard via direct DOM manipulation */
export async function hideKeyboardViaDOM(page: Page): Promise<boolean> {
  try {
    await page.evaluate(`(function() {
      document.body.classList.remove('keyboard-visible');
      if (typeof KeyboardHandler !== 'undefined') {
        KeyboardHandler.keyboardVisible = false;
        if (typeof KeyboardHandler.resetLayout === 'function') KeyboardHandler.resetLayout();
      }

      var toolbar = document.querySelector('.toolbar');
      var accessoryBar = document.querySelector('.keyboard-accessory-bar');
      var main = document.querySelector('.main');

      if (toolbar) toolbar.style.transform = '';
      if (accessoryBar) {
        accessoryBar.classList.remove('visible');
        accessoryBar.style.transform = '';
      }
      if (main) main.style.paddingBottom = '';
    })()`);
    return true;
  } catch {
    return false;
  }
}

// ─── Unified API ───

/** Show keyboard using the best available simulation layer.
 *  Tries CDP → Mock → DOM in order. */
export async function showKeyboard(
  page: Page,
  keyboardHeight: number,
  options: KeyboardSimOptions = {},
): Promise<KeyboardSimResult> {
  const { preferredLayer, isChromium = true } = options;

  // Try specific layer if requested
  if (preferredLayer) {
    const success = await tryLayer(page, keyboardHeight, preferredLayer, isChromium);
    return { layer: preferredLayer, success };
  }

  // Auto-select: try CDP first (Chromium only), then mock, then DOM
  if (isChromium) {
    const cdpSuccess = await showKeyboardViaCDP(page, keyboardHeight);
    if (cdpSuccess) return { layer: 'cdp', success: true };
  }

  const mockSuccess = await showKeyboardViaMock(page, keyboardHeight);
  if (mockSuccess) return { layer: 'mock', success: true };

  const domSuccess = await showKeyboardViaDOM(page, keyboardHeight);
  return { layer: 'dom', success: domSuccess };
}

/** Hide keyboard using the best available simulation layer */
export async function hideKeyboard(
  page: Page,
  options: KeyboardSimOptions = {},
): Promise<KeyboardSimResult> {
  const { preferredLayer, isChromium = true } = options;

  if (preferredLayer) {
    let success = false;
    switch (preferredLayer) {
      case 'cdp': success = await hideKeyboardViaCDP(page); break;
      case 'mock': success = await hideKeyboardViaMock(page); break;
      case 'dom': success = await hideKeyboardViaDOM(page); break;
    }
    return { layer: preferredLayer, success };
  }

  if (isChromium) {
    const cdpSuccess = await hideKeyboardViaCDP(page);
    if (cdpSuccess) return { layer: 'cdp', success: true };
  }

  const mockSuccess = await hideKeyboardViaMock(page);
  if (mockSuccess) return { layer: 'mock', success: true };

  const domSuccess = await hideKeyboardViaDOM(page);
  return { layer: 'dom', success: domSuccess };
}

async function tryLayer(
  page: Page,
  keyboardHeight: number,
  layer: KeyboardLayer,
  isChromium: boolean,
): Promise<boolean> {
  switch (layer) {
    case 'cdp':
      if (!isChromium) return false;
      return showKeyboardViaCDP(page, keyboardHeight);
    case 'mock':
      return showKeyboardViaMock(page, keyboardHeight);
    case 'dom':
      return showKeyboardViaDOM(page, keyboardHeight);
  }
}
