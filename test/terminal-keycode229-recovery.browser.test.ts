/**
 * Wiring for the orphaned-input recovery controller, in a real browser.
 *
 * The controller's decision logic is unit-tested in
 * test/terminal-keycode229-recovery.test.ts. What can only be proven with a
 * real xterm instance is the wiring:
 *
 *  - our `input` listener is registered AFTER xterm's, so xterm's `cancel()`
 *    (stopPropagation, not stopImmediatePropagation) does not silence it;
 *  - a `composed: true` insertText preceded by a keydown — the shape Chrome on
 *    Android delivers — is dropped by xterm and recovered by us, exactly once;
 *  - a keystroke xterm DOES handle is delivered exactly once, not twice.
 *
 * Browser-driven, so it is excluded from `npm run test:ci` like the other
 * Playwright suites. Run locally:
 *   npm run test:browser -- test/terminal-keycode229-recovery.browser.test.ts
 *
 * Port: 3186 (per CLAUDE.md, ports 3150+ for tests)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const PORT = 3186;
const BASE_URL = `http://localhost:${PORT}`;

describe('orphaned terminal input recovery wiring', () => {
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
    await page.waitForFunction(() => (window as any).app?._keyCode229Recovery, null, { timeout: 30000 });
  }, 90000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
  }, 60000);

  /**
   * Drive one keystroke through the real textarea and report what reached the
   * PTY send path. `dispatchInput` mirrors GBoard: a keydown with no usable key
   * identity, then a `composed: true` insertText that xterm refuses to forward.
   */
  async function keystroke(options: { data: string; dispatchInput: boolean; keyCode: number }) {
    return page.evaluate(async ({ data, dispatchInput, keyCode }) => {
      const app = (window as any).app;
      const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
      const originalSessionId = app.activeSessionId;
      const originalLocalEcho = app._localEchoEnabled;
      const originalSendInput = app._sendInputAsync;
      const originalPendingInput = app._pendingInput;
      const originalLastKeystrokeTime = app._lastKeystrokeTime;
      const sent: string[] = [];
      let xtermEmitted = 0;
      const rec = app._keyCode229Recovery;

      try {
        app.activeSessionId = 'cod388-browser-regression';
        app._localEchoEnabled = false;
        app._pendingInput = '';
        app._lastKeystrokeTime = 0;
        app._sendInputAsync = (_sessionId: string, chunk: string) => sent.push(chunk);
        // The controller object is Object.freeze()d, so count xterm's own
        // canonical emissions by swapping the (writable) property on app.
        app._keyCode229Recovery = {
          handleKeyEvent: (e: any) => rec.handleKeyEvent(e),
          notifyCanonicalData: () => {
            xtermEmitted += 1;
            return rec.notifyCanonicalData();
          },
          destroy: () => rec.destroy(),
        };
        textarea.focus();

        const down = new KeyboardEvent('keydown', {
          key: 'Unidentified',
          bubbles: true,
          cancelable: true,
          composed: true,
        });
        Object.defineProperties(down, { keyCode: { value: keyCode }, which: { value: keyCode } });
        textarea.dispatchEvent(down);

        if (dispatchInput) {
          textarea.value = data;
          textarea.dispatchEvent(
            new InputEvent('input', { data, inputType: 'insertText', bubbles: true, composed: true })
          );
        }

        await new Promise((resolve) => setTimeout(resolve, 60));
        return { sent, xtermEmitted };
      } finally {
        app.activeSessionId = originalSessionId;
        app._localEchoEnabled = originalLocalEcho;
        app._sendInputAsync = originalSendInput;
        app._pendingInput = originalPendingInput;
        app._lastKeystrokeTime = originalLastKeystrokeTime;
        app._keyCode229Recovery = rec;
        textarea.value = '';
      }
    }, options);
  }

  /**
   * ⚠ The gap this controller actually fills is NARROWER than "keyCode 229",
   * and that matters for what these tests can prove.
   *
   * xterm already self-recovers keyCode 229: `CompositionHelper.keydown()`
   * calls `_handleAnyTextareaChanges()`, which snapshots `textarea.value` and
   * diffs it on a 0 ms timer, emitting the difference itself. So for a 229
   * keydown there is nothing orphaned to recover, and a test asserting "we
   * recovered it" would pass while xterm did all the work — measured: xterm
   * emits, our controller correctly stands down.
   *
   * The real gap is an `insertText` input event that xterm's `_inputEvent`
   * refuses (`composed: true` with a keydown seen) where NO 229 diff was
   * scheduled to rescue it. These tests therefore assert WHO delivered the
   * byte, via `xtermEmitted`, not merely that a byte arrived.
   */
  it('recovers a composed insertText that xterm dropped and did not self-rescue', async () => {
    const { sent, xtermEmitted } = await keystroke({ data: 'x', dispatchInput: true, keyCode: 65 });
    expect(xtermEmitted).toBe(0); // xterm delivered nothing: genuinely orphaned
    expect(sent.join('')).toBe('x'); // ...so this byte is ours
  });

  it('does not duplicate a keystroke xterm self-rescued via its own 0 ms diff', async () => {
    const { sent, xtermEmitted } = await keystroke({ data: 'y', dispatchInput: true, keyCode: 229 });
    expect(xtermEmitted).toBe(1); // xterm's 229 textarea diff spoke
    expect(sent.join('')).toBe('y'); // exactly once — we must not add a second copy
  });

  it('recovers the same character twice when both keystrokes are orphaned', async () => {
    const first = await keystroke({ data: 'z', dispatchInput: true, keyCode: 65 });
    const second = await keystroke({ data: 'z', dispatchInput: true, keyCode: 65 });
    expect(first.sent.join('')).toBe('z');
    expect(second.sent.join('')).toBe('z');
  });

  it('sends nothing for a keydown that produces no input event', async () => {
    const { sent } = await keystroke({ data: 'q', dispatchInput: false, keyCode: 65 });
    expect(sent).toEqual([]);
  });
});
