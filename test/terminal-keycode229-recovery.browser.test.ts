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
 *  - a keystroke xterm DOES handle is delivered exactly once, not twice;
 *  - a character committed in the SAME page task as Enter reaches the send
 *    path ahead of the `\r`, which is the ordering the zero-delay timer
 *    alone cannot produce.
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

  /**
   * The batched shape an Android soft keyboard actually delivers when the user
   * taps the last character and then Enter: the character's keydown, its
   * `composed: true` insertText, and Enter's keydown all land in ONE page task,
   * before any zero-delay timer can run.
   *
   * This is the ordering half of the fix, and the half the unit harness cannot
   * reach: the unit tests prove WHICH candidate is forwarded, this proves WHEN.
   * Resolving the pending candidate only on its 0 ms timer loses the character
   * outright here, because by the time that timer runs xterm has already
   * emitted the `\r` and bumped the canonical counter past the candidate's
   * snapshot, so it stands down. Draining at the next keydown, from xterm's
   * custom key handler (which runs before xterm processes that key), puts the
   * character on the wire ahead of the `\r`.
   */
  async function batchedCommitThenEnter(data: string) {
    return page.evaluate(async (text) => {
      const app = (window as any).app;
      const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
      const originalSessionId = app.activeSessionId;
      const originalLocalEcho = app._localEchoEnabled;
      const originalSendInput = app._sendInputAsync;
      const originalPendingInput = app._pendingInput;
      const originalLastKeystrokeTime = app._lastKeystrokeTime;
      const sent: string[] = [];

      try {
        app.activeSessionId = 'cod388-browser-batched';
        app._localEchoEnabled = false;
        app._pendingInput = '';
        app._lastKeystrokeTime = 0;
        app._sendInputAsync = (_sessionId: string, chunk: string) => sent.push(chunk);
        textarea.focus();

        // One task, no awaits between the three dispatches.
        const charDown = new KeyboardEvent('keydown', {
          key: 'Unidentified',
          bubbles: true,
          cancelable: true,
          composed: true,
        });
        Object.defineProperties(charDown, { keyCode: { value: 65 }, which: { value: 65 } });
        textarea.dispatchEvent(charDown);

        textarea.value = text;
        textarea.dispatchEvent(
          new InputEvent('input', { data: text, inputType: 'insertText', bubbles: true, composed: true })
        );

        const enterDown = new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          bubbles: true,
          cancelable: true,
          composed: true,
        });
        Object.defineProperties(enterDown, { keyCode: { value: 13 }, which: { value: 13 } });
        textarea.dispatchEvent(enterDown);

        await new Promise((resolve) => setTimeout(resolve, 80));
        return { wire: sent.join('') };
      } finally {
        app.activeSessionId = originalSessionId;
        app._localEchoEnabled = originalLocalEcho;
        app._sendInputAsync = originalSendInput;
        app._pendingInput = originalPendingInput;
        app._lastKeystrokeTime = originalLastKeystrokeTime;
        textarea.value = '';
      }
    }, data);
  }

  it('delivers a character committed in the same task as Enter BEFORE the carriage return', async () => {
    const { wire } = await batchedCommitThenEnter('o');
    // Not '\r' (character lost, the defect) and not '\ro' (recovered too late).
    expect(wire).toBe('o\r');
  });

  it('sends nothing for a keydown that produces no input event', async () => {
    const { sent } = await keystroke({ data: 'q', dispatchInput: false, keyCode: 65 });
    expect(sent).toEqual([]);
  });

  /**
   * The sequence a real Android device logged (SwiftKey in Edge) when autocorrect fired on
   * space: every key is a keyCode-229 keydown plus a plain `insertText`, then ONE keydown that
   * deletes five characters and a second that inserts `rompt `. Trusted events through the real
   * textarea and the real xterm, so `execCommand` produces the same `beforeinput`/`input`
   * pairs the keyboard does. The byte stream is replayed (DEL erases a character) to get the
   * line the shell ends up with.
   */
  async function autocorrectOnSpace() {
    return page.evaluate(async () => {
      const app = (window as any).app;
      const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
      const originalSessionId = app.activeSessionId;
      const originalLocalEcho = app._localEchoEnabled;
      const originalSendInput = app._sendInputAsync;
      const originalPendingInput = app._pendingInput;
      const originalLastKeystrokeTime = app._lastKeystrokeTime;
      const sent: string[] = [];
      const key229 = () => {
        const down = new KeyboardEvent('keydown', { key: 'Unidentified', bubbles: true, cancelable: true });
        Object.defineProperties(down, { keyCode: { value: 229 }, which: { value: 229 } });
        textarea.dispatchEvent(down);
      };
      const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
      try {
        app.activeSessionId = 'cod388-browser-autocorrect';
        app._localEchoEnabled = false;
        app._pendingInput = '';
        app._lastKeystrokeTime = 0;
        app._sendInputAsync = (_sessionId: string, chunk: string) => sent.push(chunk);
        textarea.value = '';
        textarea.focus();

        for (const ch of 'testing the peompt') {
          key229();
          document.execCommand('insertText', false, ch);
          await tick();
        }
        // SwiftKey's autocorrect: both edits in one task, before any timer runs.
        key229();
        textarea.setSelectionRange(textarea.value.length - 5, textarea.value.length);
        document.execCommand('delete');
        key229();
        document.execCommand('insertText', false, 'rompt ');
        await new Promise((resolve) => setTimeout(resolve, 80));

        const line: string[] = [];
        for (const ch of sent.join('')) {
          if (ch === '\x7f') line.pop();
          else line.push(ch);
        }
        return { raw: sent.join(''), line: line.join(''), textarea: textarea.value };
      } finally {
        app.activeSessionId = originalSessionId;
        app._localEchoEnabled = originalLocalEcho;
        app._sendInputAsync = originalSendInput;
        app._pendingInput = originalPendingInput;
        app._lastKeystrokeTime = originalLastKeystrokeTime;
        textarea.value = '';
      }
    });
  }

  it('an autocorrect that deletes a word and retypes it reaches the shell once, not duplicated', async () => {
    const { line, textarea } = await autocorrectOnSpace();
    expect(textarea).toBe('testing the prompt ');
    expect(line).toBe('testing the prompt ');
  });

  /**
   * The batched Android shape from #441, now with an edit that REWRITES text: the last
   * character's 229 keydown and insertText land in the same page task as Enter's keydown.
   * xterm clears the textarea for Enter before the edit-sync timer would run, so a timer
   * left pending diffed the whole line against '' and sent one DEL per character ahead of
   * the submitted line (with local echo on, `hello` + Enter submitted `h`). The edit is
   * settled at the next keydown, before xterm sees it. Run with local echo both ways: it
   * changes which of the DELs and the `\r` reaches the wire first.
   */
  async function lastEditThenEnter(options: { localEcho: boolean; autocorrect: boolean }) {
    return page.evaluate(async ({ localEcho, autocorrect }) => {
      const app = (window as any).app;
      const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement;
      const originalSessionId = app.activeSessionId;
      const originalLocalEcho = app._localEchoEnabled;
      const originalSendInput = app._sendInputAsync;
      const originalPendingInput = app._pendingInput;
      const originalLastKeystrokeTime = app._lastKeystrokeTime;
      const sent: string[] = [];
      const keydown = (init: KeyboardEventInit, keyCode: number) => {
        const down = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
        Object.defineProperties(down, { keyCode: { value: keyCode }, which: { value: keyCode } });
        textarea.dispatchEvent(down);
      };
      const key229 = () => keydown({ key: 'Unidentified' }, 229);
      const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
      try {
        app.activeSessionId = 'cod388-browser-edit-enter';
        app._localEchoEnabled = localEcho;
        app._pendingInput = '';
        app._lastKeystrokeTime = 0;
        app._sendInputAsync = (_sessionId: string, chunk: string) => sent.push(chunk);
        textarea.value = '';
        textarea.focus();

        const typed = autocorrect ? 'testing the peompt' : 'hell';
        for (const ch of typed) {
          key229();
          document.execCommand('insertText', false, ch);
          await tick();
        }
        // ONE task: no awaits between the edit(s) and Enter.
        if (autocorrect) {
          key229();
          textarea.setSelectionRange(textarea.value.length - 5, textarea.value.length);
          document.execCommand('delete');
          key229();
          document.execCommand('insertText', false, 'rompt ');
        } else {
          key229();
          document.execCommand('insertText', false, 'o');
        }
        keydown({ key: 'Enter', code: 'Enter' }, 13);
        await new Promise((resolve) => setTimeout(resolve, 250)); // local echo delays the \r by 80 ms

        const line: string[] = [];
        for (const ch of sent.join('')) {
          if (ch === '\x7f') line.pop();
          else line.push(ch);
        }
        return { raw: sent.join(''), line: line.join('') };
      } finally {
        app.activeSessionId = originalSessionId;
        app._localEchoEnabled = originalLocalEcho;
        app._sendInputAsync = originalSendInput;
        app._pendingInput = originalPendingInput;
        app._lastKeystrokeTime = originalLastKeystrokeTime;
        textarea.value = '';
      }
    }, options);
  }

  for (const localEcho of [true, false]) {
    it(`a 229 last character in the same task as Enter submits the whole line (local echo ${localEcho ? 'on' : 'off'})`, async () => {
      const { raw, line } = await lastEditThenEnter({ localEcho, autocorrect: false });
      expect(raw).not.toContain('\x7f');
      expect(line).toBe('hello\r');
    });

    it(`an autocorrect plus Enter in one task submits the corrected line (local echo ${localEcho ? 'on' : 'off'})`, async () => {
      const { line } = await lastEditThenEnter({ localEcho, autocorrect: true });
      expect(line).toBe('testing the prompt \r');
    });
  }

  it('control: without the edit sync, xterm alone reproduces the duplicated line', async () => {
    // destroy() puts xterm's own handler back. Keep this LAST: it leaves the controller off.
    await page.evaluate(() => (window as any).app._keyCode229Recovery.destroy());
    const { line } = await autocorrectOnSpace();
    // Byte for byte what the phone sent in the device log.
    expect(line).toBe('testing the peompttesting the prompt rompt ');
  });
});
