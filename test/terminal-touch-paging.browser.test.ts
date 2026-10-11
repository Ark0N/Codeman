/**
 * @fileoverview Real Chromium coverage for the page-key fallback on the TOUCH
 * path of the primary pane (#527 review, #508): the touch listeners that
 * `initTerminal()` installs on `#terminalContainer`, not a call into the pure
 * helper.
 *
 * A slow drag reaches `_maybePageCliTranscript` once per whole cell of finger
 * travel, so its calls are further apart than the 150 ms gesture gap. Each call
 * used to start a new gesture and pre-pay a page, so twelve lines of slow
 * finger travel sent twelve PageUps. The touch paths now tag every call with
 * the contact's id (one per touchstart, carried by its momentum frames), and a
 * contact is one gesture.
 *
 * What runs for real: the shipped app (page served by a WebServer on port 0),
 * its xterm, the touch listeners, the momentum loop on requestAnimationFrame,
 * the gates in terminal-ui.js and the 40 ms key coalescer. What is stubbed:
 * the active session (a Codex session the page knows about but no PTY) and
 * `_sendInputEphemeral`, which records the keys instead of sending them. The
 * touch events are DOM events carrying `touches`, dispatched on the container
 * with real time between them.
 *
 * Port: ephemeral (`new WebServer(0, …)`, read back from `boundPort`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PROBE_ID = 'touch-paging-probe';
const UP = '\x1b[5~';

describe('touch paging of a hollow Codex pane in a real browser', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, hasTouch: true });
    await page.goto(`http://localhost:${server.boundPort}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).app?.terminal, null, { timeout: 30000 });
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

  const probe = () =>
    page.evaluate(() => {
      const p = (window as any).__touchProbe;
      p.app._flushWheelSgrQueue();
      return { keys: p.sent.join(''), calls: p.calls.slice(), rows: p.app.terminal.rows };
    });

  it('pages a slow one-line-at-a-time drag once, keeps momentum in it, and pages a new contact at once', async () => {
    const cell = await page.evaluate((id) => {
      const w = window as any;
      const app = w.app;
      app.sessions.set(id, { id, name: id, mode: 'codex', status: 'idle' });
      app.activeSessionId = id;
      app.tabAlerts?.delete?.(id);
      const sent: string[] = [];
      app._sendInputEphemeral = (_sessionId: string, data: string) => sent.push(data);
      const calls: Array<{ touchId: unknown; lines: number }> = [];
      const real = app._maybePageCliTranscript;
      app._maybePageCliTranscript = function (ev: { touchId?: unknown }, lines: number) {
        calls.push({ touchId: ev?.touchId, lines });
        return real.call(this, ev, lines);
      };
      w.__touchProbe = { app, sent, calls };
      return app.terminal._core?._renderService?.dimensions?.css?.cell?.height || 13;
    }, PROBE_ID);

    // The preconditions the fallback needs, so a pass is not vacuous.
    const pre = await page.evaluate(() => {
      const app = (window as any).app;
      return {
        hollow: app._localScrollbackIsHollow(),
        forwards: app._shouldForwardWheelToApp({ shiftKey: false }),
        modes: (window as any).__codemanTranscriptPageKeys,
      };
    });
    expect(pre.modes).toContain('codex');
    expect(pre.hollow).toBe(true);
    expect(pre.forwards).toBe(false);

    // One contact, finger moving DOWN one cell every 170 ms (scrolls back up).
    const x = 300;
    const y0 = 200;
    await touch('touchstart', x, y0);
    for (let i = 1; i <= 12; i++) {
      await page.waitForTimeout(170);
      await touch('touchmove', x, y0 + Math.ceil(cell) * i);
    }
    await page.waitForTimeout(60); // the 40 ms coalescer
    const drag = await probe();
    expect(drag.calls.length).toBeGreaterThanOrEqual(12);
    expect(drag.calls.every((c) => c.lines < 0)).toBe(true);
    expect(drag.keys).toBe(UP); // was one PageUp per line
    const contact = drag.calls[0].touchId;
    expect(typeof contact).toBe('number');
    expect(drag.calls.every((c) => c.touchId === contact)).toBe(true);

    // Lift: the momentum loop keeps calling with the SAME contact id.
    await touch('touchend', x, y0 + Math.ceil(cell) * 12);
    await page.waitForTimeout(800);
    const afterMomentum = await probe();
    const momentum = afterMomentum.calls.slice(drag.calls.length);
    expect(momentum.length).toBeGreaterThan(0);
    expect(momentum.every((c) => c.touchId === contact)).toBe(true);
    // The contact's whole travel (drag + momentum) is short of the two half
    // screens a second page needs once the first was pre-paid, so it is still
    // one PageUp. A momentum frame that opened its own gesture would have paged.
    const travelled = afterMomentum.calls.reduce((sum, c) => sum + Math.abs(c.lines), 0);
    expect(travelled).toBeGreaterThan(12);
    expect(travelled).toBeLessThan(2 * Math.round(afterMomentum.rows / 2));
    expect(afterMomentum.keys).toBe(UP);

    // A new contact is a new gesture: its first line pages at once.
    await touch('touchstart', x, y0);
    await page.waitForTimeout(20);
    await touch('touchmove', x, y0 + Math.ceil(cell));
    await page.waitForTimeout(60);
    const second = await probe();
    const fresh = second.calls.slice(afterMomentum.calls.length);
    expect(fresh.length).toBe(1);
    expect(fresh[0].touchId).not.toBe(contact);
    expect(second.keys).toBe(UP + UP);
    await touch('touchend', x, y0 + Math.ceil(cell));
  }, 60000);
});
