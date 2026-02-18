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

/** Throttle CPU to simulate mobile hardware (rate = slowdown factor, e.g. 4 = 4x slower) */
export async function setCPUThrottle(cdp: CDPSession, rate: number): Promise<void> {
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
}

/** Clear CPU throttling */
export async function clearCPUThrottle(cdp: CDPSession): Promise<void> {
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
}

/** Emulate network conditions */
export async function setNetworkThrottle(
  cdp: CDPSession,
  downloadKbps: number,
  uploadKbps: number,
  latencyMs: number,
): Promise<void> {
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    downloadThroughput: (downloadKbps * 1024) / 8,
    uploadThroughput: (uploadKbps * 1024) / 8,
    latency: latencyMs,
  });
}

/** Clear network throttling */
export async function clearNetworkThrottle(cdp: CDPSession): Promise<void> {
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    downloadThroughput: -1,
    uploadThroughput: -1,
    latency: 0,
  });
}
