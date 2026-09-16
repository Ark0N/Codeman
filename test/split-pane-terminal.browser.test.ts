/** @fileoverview Real Chromium + real WebSocket coverage for SplitTerminalPane (Task 4 of the split-pane-sessions plan). */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3175;
const BASE_URL = `http://localhost:${PORT}`;

describe('SplitTerminalPane in a real browser', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = new WebServer(PORT, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).app?.terminal, null, { timeout: 30000 });
  }, 90000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
  }, 60000);

  it('connects, echoes real PTY output, and cleans up on destroy', async () => {
    const sessionId = await page.evaluate(async () => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: '/tmp', mode: 'shell' }),
      });
      const id = (await res.json()).data.session.id;
      // Session creation alone leaves pid:null and no pane (per CLAUDE.md's
      // Testing section) — the shell PTY only spawns once this is called, and
      // without it the WS opens but no bytes ever flow, and the echo assertion
      // below would hang until its own timeout for reasons unrelated to
      // SplitTerminalPane.
      await fetch(`/api/sessions/${id}/shell`, { method: 'POST' });
      return id;
    });

    const result = await page.evaluate(async (id) => {
      const mount = document.createElement('div');
      mount.style.width = '400px';
      mount.style.height = '300px';
      document.body.appendChild(mount);

      const pane = new (window as any).SplitTerminalPane(id, mount);
      pane.connect();

      // Wait for the WS to open, then send a real input frame — testMode's
      // echo PTY (TEST_PTY_SCRIPT) echoes each byte back exactly once, which
      // is what proves the WS round-trip actually reaches a real PTY and back,
      // not just that xterm can render locally-written text.
      await new Promise((resolve) => {
        const check = () => (pane._wsReady ? resolve(undefined) : setTimeout(check, 100));
        check();
      });
      pane.ws.send(JSON.stringify({ t: 'i', d: 'SPLITPANE_MARKER\r' }));

      const hasEcho = await new Promise((resolve) => {
        const deadline = Date.now() + 5000;
        const poll = () => {
          const buf = pane.terminal.buffer.active;
          for (let i = 0; i < buf.length; i++) {
            if (buf.getLine(i)?.translateToString(true).includes('SPLITPANE_MARKER')) {
              resolve(true);
              return;
            }
          }
          if (Date.now() > deadline) resolve(false);
          else setTimeout(poll, 100);
        };
        poll();
      });

      pane.destroy();
      const cleanedUp = mount.querySelector('.xterm') === null;
      document.body.removeChild(mount);

      return { hasEcho, cleanedUp };
    }, sessionId);

    expect(result.hasEcho).toBe(true);
    expect(result.cleanedUp).toBe(true);

    await page.evaluate(async (id) => {
      await fetch(`/api/sessions/${id}`, { method: 'DELETE' });
    }, sessionId);
  });
});
