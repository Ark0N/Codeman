/**
 * @fileoverview Real Chromium coverage for the axis the primary pane's touch
 * listeners lock on the first travel past the tap slop (#674): `'swipe'` for a
 * sideways drag on a terminal that cannot pan, which belongs to the session
 * swipe (SwipeHandler, mobile-handlers.js) and so neither scrolls nor ends as a
 * tap.
 *
 * The edge this pins: a scroll whose first few pixels lean sideways (a thumb
 * arc: +9 px across, +5 px down, then straight down) used to lock as `'swipe'`
 * for the whole contact, so every later touchmove returned before the scroll
 * code, the swipe itself gave up at its vertical drift limit, and the gesture
 * did nothing. Past `SwipeHandler.maxVerticalDrift` the drag is handed back to
 * the scroll (`'y'`). A clean sideways swipe must still lock as `'swipe'` and
 * leave the buffer where it was.
 *
 * What runs for real: the shipped app (page served by a WebServer on port 0),
 * its xterm, the touch listeners `initTerminal()` installs on
 * `#terminalContainer` and the gates they call. What is stubbed: the active
 * session (a shell session the page knows about but no PTY, so a drag scrolls
 * xterm's own buffer), and `nextSession`/`prevSession`, so a swipe can never
 * switch away mid-test. The touch events are DOM events carrying `touches`,
 * dispatched on the container.
 *
 * Port: ephemeral (`new WebServer(0, …)`, read back from `boundPort`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PROBE_ID = 'touch-swipe-axis-probe';

describe('touch axis lock of the primary pane in a real browser', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, hasTouch: true });
    await page.goto(`http://localhost:${server.boundPort}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).app?.terminal, null, { timeout: 30000 });
    // Let the page settle first: its layout refits the terminal (62 rows to 50
    // at this size, measured) a moment after load, which moves baseY.
    await page.waitForTimeout(3500);
    await page.evaluate(async (id) => {
      const app = (window as any).app;
      app.sessions.set(id, { id, name: id, mode: 'shell', status: 'idle' });
      app.activeSessionId = id;
      app.loadAppSettingsFromStorage = () => ({ terminalWheelLocalScrollback: false });
      app.nextSession = () => {};
      app.prevSession = () => {};
      let text = '';
      for (let i = 0; i < 300; i++) text += `\r\nscrollback row ${i}`;
      await new Promise<void>((resolve) => app.terminal.write(text, resolve));
    }, PROBE_ID);
  }, 90000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
  }, 60000);

  /** Dispatch one touch event of `type` at (x, y) on the terminal container. */
  const touch = (type: string, x: number, y: number) =>
    page.evaluate(
      ([t, cx, cy]) => {
        const container = document.getElementById('terminalContainer')!;
        const ev = new Event(t as string, { bubbles: true, cancelable: true });
        const point = { clientX: cx, clientY: cy, target: container };
        Object.defineProperty(ev, 'touches', { value: t === 'touchend' ? [] : [point] });
        Object.defineProperty(ev, 'changedTouches', { value: [point] });
        container.dispatchEvent(ev);
      },
      [type, x, y] as const
    );

  /** Viewport back at the bottom, and a start point inside the container. */
  const reset = () =>
    page.evaluate(() => {
      const app = (window as any).app;
      app.terminal.scrollToBottom();
      const container = document.getElementById('terminalContainer')!;
      const r = container.getBoundingClientRect();
      const b = app.terminal.buffer.active;
      return {
        x: Math.round(r.left + r.width / 2),
        y: Math.round(r.top + 40),
        height: Math.round(r.height),
        baseY: b.baseY,
        viewportY: b.viewportY,
        rows: app.terminal.rows,
        canPan: container.classList.contains('term-overflows-x'),
      };
    });

  /** SwipeHandler is a top-level `const` (no window property): read it by name. */
  const swipeDrift = () =>
    page.evaluate<number | null>('typeof SwipeHandler === "undefined" ? null : SwipeHandler.maxVerticalDrift');

  const state = () =>
    page.evaluate(() => {
      const app = (window as any).app;
      const b = app.terminal.buffer.active;
      return { axis: app._terminalGestureAxis, viewportY: b.viewportY, baseY: b.baseY, rows: app.terminal.rows };
    });

  it('hands a drag that opens sideways back to the scroll once it passes the swipe drift limit', async () => {
    const start = await reset();
    // The preconditions, so a pass is not vacuous: real scrollback to scroll
    // through, a terminal that cannot pan (a sideways opening locks 'swipe',
    // not 'x'), and room in the container for 300 px of travel.
    expect(start.baseY).toBeGreaterThan(50);
    expect(start.viewportY).toBe(start.baseY);
    expect(start.canPan).toBe(false);
    expect(await swipeDrift()).toBe(50);
    expect(start.height).toBeGreaterThan(340);

    const { x, y } = start;
    await touch('touchstart', x, y);
    await touch('touchmove', x + 9, y + 5); // the thumb arc: past the slop, mostly sideways
    const opened = await state();
    expect(opened.axis).toBe('swipe');
    expect(opened.viewportY).toBe(opened.baseY);

    for (let dy = 25; dy <= 305; dy += 20) await touch('touchmove', x + 9, y + dy);
    const dragged = await state();
    expect(dragged.axis).toBe('y');
    // Finger down scrolls back through the scrollback, measured from the bottom
    // (baseY) as it is now. 300 px of travel is well over ten rows; the travel
    // up to the drift limit is not counted.
    expect(dragged.baseY - dragged.viewportY).toBeGreaterThanOrEqual(5);
    // Cancel rather than lift: a lift starts a momentum fling, which would keep
    // scrolling into the next test.
    await touch('touchcancel', x + 9, y + 305);
  }, 60000);

  it('keeps a clean sideways swipe locked as the session swipe, with nothing scrolled', async () => {
    const start = await reset();
    const { x, y } = start;
    await touch('touchstart', x + 120, y);
    for (let dx = 20; dx <= 160; dx += 20) await touch('touchmove', x + 120 - dx, y + 3);
    const swiped = await state();
    expect(swiped.axis).toBe('swipe');
    expect(swiped.viewportY).toBe(swiped.baseY);
    await touch('touchcancel', x - 40, y + 3);
  }, 60000);
});
