import type { Page, CDPSession } from 'playwright';

/** Get or create a CDP session for the page (Chromium only) */
export async function getCDP(page: Page): Promise<CDPSession> {
  return page.context().newCDPSession(page);
}

/** Shrink visual viewport to simulate keyboard via device metrics override.
 *  Triggers REAL visualViewport resize event that KeyboardHandler detects. */
export async function setVisualViewportHeight(
  cdp: CDPSession,
  width: number,
  height: number,
  scale: number,
): Promise<void> {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: scale,
    mobile: true,
  });
}

/** Clear device metrics override, restoring original viewport */
export async function clearDeviceMetricsOverride(cdp: CDPSession): Promise<void> {
  await cdp.send('Emulation.clearDeviceMetricsOverride');
}

/** Dispatch a trusted touch event via CDP Input domain.
 *  Produces isTrusted=true events, unlike synthetic TouchEvent dispatch. */
export async function dispatchTouchEvent(
  cdp: CDPSession,
  type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel',
  touchPoints: Array<{ x: number; y: number }>,
): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', {
    type,
    touchPoints: touchPoints.map(p => ({ x: Math.round(p.x), y: Math.round(p.y) })),
  });
}

