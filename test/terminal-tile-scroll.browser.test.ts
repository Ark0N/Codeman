/**
 * @fileoverview Real Chromium + real xterm coverage for a TerminalTile's
 * hollow-buffer paging (#555 parity), the parts a fake xterm cannot prove:
 *
 *  - the capture-phase wheel listener on the tile's mount really keeps the
 *    paged wheel away from xterm (its viewport does not move into the stale
 *    rows above the screen), while a wheel the tile does not page still
 *    reaches xterm and scrolls it, and
 *  - real xterm puts a one-screen capture taken at a taller size above the
 *    screen, and a row-shrinking fit pushes more rows up, which is what the
 *    tile's overflow discount (`_localRows`) counts. Output that scrolls real
 *    lines is history, and the tile stops paging.
 *
 * The wheel is a real one (`page.mouse.wheel()`), and the last step proves it
 * reaches xterm: a wheel the tile does not page scrolls xterm's viewport, so
 * "xterm did not scroll" on a paged wheel means something. What keeps xterm
 * still there is the tile's preventDefault (xterm 6's scrollable element skips
 * a wheel whose default was prevented); its stopPropagation, the primary
 * pane's other half, keeps xterm's own handlers from seeing the event at all.
 * Dropping both makes this test fail.
 *
 * The tile's load and socket are stubbed in the page (fetch answers its one
 * capture, WebSocket never opens), so nothing here needs a PTY; the page keys
 * are read from a spy on `app._sendInputEphemeral`. The gates themselves are
 * the real ones in terminal-ui.js, asked for the tile's own session.
 *
 * Port: ephemeral (`new WebServer(0, …)`, read back from `boundPort`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PROBE_ID = 'tile-scroll-probe';

type Snap = { rows: number; baseY: number; viewportY: number; localRows: number; sent: Array<[string, string]> };

describe('TerminalTile wheel paging in a real browser', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
    await page.goto(`http://localhost:${server.boundPort}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).app?.terminal && (window as any).TerminalTile, null, {
      timeout: 30000,
    });
  }, 90000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
  }, 60000);

  /** The tile's state plus every page key sent so far. */
  const snap = () =>
    page.evaluate(() => {
      const probe = (window as any).__tileProbe;
      const term = probe.tile.terminal;
      return {
        rows: term.rows,
        baseY: term.buffer.active.baseY,
        viewportY: term.buffer.active.viewportY,
        localRows: probe.tile._localRows(),
        sent: probe.sent.slice(),
      } as Snap;
    });

  /** A real wheel-up of a whole screen over the tile, then time for the 40 ms flush and a frame. */
  async function wheelUp(rows: number) {
    await page.mouse.move(200, 60);
    await page.mouse.wheel(0, -rows * 25);
    await page.waitForTimeout(150);
  }

  it('pages a hollow tile, keeps xterm still, survives a shrink, and stops once real lines scroll', async () => {
    await page.evaluate(async (id) => {
      const w = window as any;
      const app = w.app;
      const CAPTURE_ROWS = 40;
      const capture = Array.from({ length: CAPTURE_ROWS }, (_, i) => `row ${i}`).join('\r\n');

      // The tile's session, as the app knows it: opencode, which draws in place.
      app.sessions.set(id, { id, mode: 'opencode' });
      const sent: Array<[string, string]> = [];
      const realEphemeral = app._sendInputEphemeral;
      app._sendInputEphemeral = (sessionId: string, data: string) => sent.push([sessionId, data]);
      const realFetch = w.fetch;
      w.fetch = async (url: string, init?: unknown) =>
        String(url).includes(`/api/sessions/${id}/terminal`)
          ? new Response(JSON.stringify({ data: { terminalBuffer: capture, captureRows: CAPTURE_ROWS } }))
          : realFetch(url, init);
      const RealWebSocket = w.WebSocket;
      w.WebSocket = class {
        static OPEN = 1;
        readyState = 0;
        send() {}
        close() {}
      };

      const mount = document.createElement('div');
      mount.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:300px;z-index:99999;background:#000';
      document.body.appendChild(mount);
      const tile = new w.TerminalTile(id, mount, { mode: 'opencode' });
      try {
        await tile.connect();
      } finally {
        w.fetch = realFetch;
        w.WebSocket = RealWebSocket;
      }
      w.__tileProbe = { tile, mount, sent, realEphemeral };
    }, PROBE_ID);

    try {
      // A 40-row capture in a shorter xterm: the extra rows sit above the
      // screen, and the tile counts every one of them as its own overflow.
      const afterLoad = await snap();
      expect(afterLoad.rows).toBeLessThan(40);
      expect(afterLoad.baseY).toBe(40 - afterLoad.rows);
      expect(afterLoad.viewportY).toBe(afterLoad.baseY);
      expect(afterLoad.localRows).toBe(0);

      // The wheel is consumed and paged: xterm never saw it, so its viewport
      // stayed at the bottom instead of scrolling into the stale rows.
      await wheelUp(afterLoad.rows);
      const afterWheel = await snap();
      expect(afterWheel.viewportY).toBe(afterLoad.baseY);
      expect(afterWheel.sent.length).toBeGreaterThanOrEqual(1);
      expect(afterWheel.sent.every(([id]) => id === PROBE_ID)).toBe(true);
      expect(afterWheel.sent.map(([, data]) => data).join('')).toMatch(/^(?:\x1b\[5~)+$/);

      // A row-shrinking fit pushes more rows up; still not history, still paged.
      await page.evaluate(() => {
        const probe = (window as any).__tileProbe;
        probe.mount.style.height = '200px';
        probe.tile.localFit();
      });
      const afterShrink = await snap();
      expect(afterShrink.rows).toBeLessThan(afterLoad.rows);
      expect(afterShrink.baseY).toBeGreaterThan(afterLoad.baseY);
      expect(afterShrink.localRows).toBe(0);
      await wheelUp(afterShrink.rows);
      const afterSecondWheel = await snap();
      expect(afterSecondWheel.sent.length).toBeGreaterThan(afterWheel.sent.length);
      expect(afterSecondWheel.viewportY).toBe(afterShrink.baseY);

      // Output that scrolled real lines is history: the wheel goes back to
      // xterm, which scrolls its own buffer, and no page key is sent.
      await page.evaluate(
        () =>
          new Promise((resolve) =>
            (window as any).__tileProbe.tile.terminal.write('real 1\r\nreal 2\r\nreal 3\r\n', resolve)
          )
      );
      const afterOutput = await snap();
      expect(afterOutput.localRows).toBe(3);
      await wheelUp(afterOutput.rows);
      const afterThirdWheel = await snap();
      expect(afterThirdWheel.sent.length).toBe(afterSecondWheel.sent.length);
      expect(afterThirdWheel.viewportY).toBeLessThan(afterOutput.baseY);
    } finally {
      await page.evaluate((id) => {
        const w = window as any;
        const probe = w.__tileProbe;
        probe.tile.destroy();
        probe.mount.remove();
        w.app.sessions.delete(id);
        w.app._sendInputEphemeral = probe.realEphemeral;
        delete w.__tileProbe;
      }, PROBE_ID);
    }
  });
});
