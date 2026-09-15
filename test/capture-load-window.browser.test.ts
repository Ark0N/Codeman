/**
 * @fileoverview Output arriving after a pane capture survives the buffer load.
 *
 * `batchTerminalWrite` queues live terminal events while a buffer load runs,
 * and `_finishBufferLoad` discards that queue by default. That is right when
 * the loaded buffer is the server's accumulated byte history, which is current
 * up to the response. A tmux pane capture is current only up to CAPTURE time,
 * so anything arriving between the capture and the end of the chunked write is
 * queued and then dropped, with nothing scheduling a re-fetch.
 *
 * The queue now stamps each entry with its arrival time, and a capture load
 * replays the tail that arrived after the response headers. These drive the
 * real client in chromium: the event is injected from inside the response's
 * own `json()` call, which is the one place guaranteed to land after the
 * headers and before the chunked write.
 *
 * Port: 3256 (capture load window)
 *
 * Run: npx vitest run --config config/vitest.browser.config.ts test/capture-load-window.browser.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3256;
const BASE_URL = `http://localhost:${PORT}`;
const MARKER = 'ARRIVED-AFTER-THE-CAPTURE';

let server: WebServer;
let browser: Browser;

beforeAll(async () => {
  server = new WebServer(PORT, false, true); // testMode
  await server.start();
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
}, 30_000);

/**
 * Select the session with the terminal fetch stubbed, injecting one live event
 * from inside `json()`. Returns how many terminal rows carry the marker, so a
 * flush that replays too much fails as loudly as one that replays nothing.
 */
async function runLoad(page: Page, sessionId: string, source: string): Promise<number> {
  return page.evaluate(
    async ({ sid, src, marker }) => {
      const app = (
        window as unknown as {
          app: {
            selectSession: (id: string, o?: object) => Promise<void>;
            _onSessionTerminal: (e: { id: string; data: string }) => void;
            terminal: {
              buffer: {
                active: {
                  length: number;
                  getLine: (i: number) => { translateToString: (t: boolean) => string } | undefined;
                };
              };
            };
          };
        }
      ).app;

      const realFetch = window.fetch.bind(window);
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(typeof input === 'string' ? input : ((input as Request).url ?? input));
        if (!url.includes('/terminal')) return realFetch(input as RequestInfo, init);
        return Promise.resolve({
          ok: true,
          status: 200,
          // `selectSession` timestamps the headers the moment this promise
          // resolves, then calls json(). Injecting here puts the event after
          // that timestamp and inside the load window, which is exactly the
          // gap a pane capture cannot cover.
          json: async () => {
            app._onSessionTerminal({ id: sid, data: `\r\n${marker}\r\n` });
            return {
              success: true,
              data: {
                terminalBuffer: '\x1b[1;1Hcaptured frame line one\r\n',
                status: 'idle',
                fullSize: 512,
                retainedBytes: 512,
                truncated: false,
                truncationReason: null,
                source: src,
                captureCols: 80,
                captureRows: 24,
              },
            };
          },
        }) as unknown as Promise<Response>;
      }) as typeof window.fetch;

      try {
        await app.selectSession(sid);
        await new Promise((r) => setTimeout(r, 1200));
        const buf = app.terminal.buffer.active;
        let hits = 0;
        for (let i = 0; i < buf.length; i++) {
          if (buf.getLine(i)?.translateToString(true).includes(marker)) hits += 1;
        }
        return hits;
      } finally {
        window.fetch = realFetch;
      }
    },
    { sid: sessionId, src: source, marker: MARKER }
  );
}

async function openSession(page: Page): Promise<string> {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.classList.contains('app-loaded'), { timeout: 10_000 });
  // xterm loads from /vendor, so the terminal appears a beat after the app.
  // Without it every buffer assertion below would throw rather than compare.
  await page.waitForFunction(() => (window as unknown as { app?: { terminal?: unknown } }).app?.terminal, null, {
    timeout: 30_000,
  });
  return page.evaluate(async () => {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir: '/tmp', name: 'capture-load-window-test' }),
    });
    const body = await res.json();
    return body.data?.session?.id ?? body.data?.id ?? body.id;
  });
}

describe('output emitted during a capture load', () => {
  let context: BrowserContext;
  let page: Page;

  afterAll(async () => {
    await context?.close();
  });

  it('reaches the terminal exactly once when the buffer came from a pane capture', async () => {
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    const sessionId = await openSession(page);
    expect(sessionId).toBeTruthy();

    // Exactly once. The cutoff exists so the flush cannot also replay events the
    // payload already carried, which would double the output rather than heal it.
    expect(await runLoad(page, sessionId, 'mux-visible')).toBe(1);

    await page.evaluate(
      (sid: string) => fetch(`/api/sessions/${sid}`, { method: 'DELETE' }).then(() => undefined),
      sessionId
    );
    await context.close();
  }, 60_000);

  it('stays dropped when the buffer came from the accumulated byte history', async () => {
    // The byte history already contains everything up to the response, so
    // replaying the queue on top of it would duplicate the output — most
    // visibly Ink's cursor-up redraws. The discard has to survive this fix.
    context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    page = await context.newPage();
    const sessionId = await openSession(page);

    expect(await runLoad(page, sessionId, 'history')).toBe(0);

    await page.evaluate(
      (sid: string) => fetch(`/api/sessions/${sid}`, { method: 'DELETE' }).then(() => undefined),
      sessionId
    );
    await context.close();
  }, 60_000);
});
