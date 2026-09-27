/**
 * The iOS IME preview controller against a REAL xterm 6 instance.
 *
 * The controller's logic is unit-tested in test/mobile-ime-preview.test.ts
 * with a stand-in for xterm. What only real xterm proves is the event ORDER:
 * `terminal.open()` registers xterm's keydown listener in the capture phase on
 * the helper textarea, and CompositionHelper.keydown finalizes a composition
 * there and emits the commit through onData synchronously. The controller must
 * observe that keydown first (capture phase on `terminal.element`), and must
 * finalize on exactly the keys xterm does.
 *
 * No server: a blank page loads the vendored xterm bundle and the controller.
 * Browser-driven, so it is excluded from `npm run test:ci` like the other
 * Playwright suites. Run locally:
 *   npm run test:browser -- test/mobile-ime-preview.browser.test.ts
 */

import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const root = resolve(import.meta.dirname, '..');

type Step =
  | ['start']
  | ['update', string]
  | ['end', string]
  | ['key', number, string, boolean]
  | ['wait', number]
  | ['consume', string];

describe('mobile IME preview with real xterm', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.setContent('<div id="t" style="width:600px;height:300px"></div>');
    await page.addScriptTag({ path: resolve(root, 'node_modules/@xterm/xterm/lib/xterm.js') });
    await page.addScriptTag({ path: resolve(root, 'src/web/public/mobile-ime-preview.js') });
  }, 60000);

  afterAll(async () => {
    if (browser) await browser.close();
  });

  async function drive(steps: Step[]) {
    return page.evaluate(async (steps: Step[]) => {
      const w = window as any;
      const host = document.getElementById('t') as HTMLElement;
      host.innerHTML = '';
      const term = new w.Terminal();
      term.open(host);
      const textarea = term.textarea as HTMLTextAreaElement;
      const renders: Array<{ text: string; phase: string }> = [];
      const onData: Array<{ data: string; consumed: boolean }> = [];
      const controller = w.MobileImePreview.create({
        textarea,
        keydownTarget: term.element,
        render: (r: { text: string; phase: string }) => renders.push(r),
        clear: () => {},
      });
      term.onData((data: string) => onData.push({ data, consumed: controller.consumeTerminalData(data) }));
      textarea.focus();
      const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
      for (const step of steps) {
        if (step[0] === 'start') textarea.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
        if (step[0] === 'update') {
          textarea.value = step[1];
          textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: step[1] }));
        }
        if (step[0] === 'end') textarea.dispatchEvent(new CompositionEvent('compositionend', { data: step[1] }));
        if (step[0] === 'key') {
          const [, keyCode, key, isComposing] = step;
          const event = new KeyboardEvent('keydown', { key, isComposing, bubbles: true, cancelable: true });
          Object.defineProperty(event, 'keyCode', { get: () => keyCode });
          textarea.dispatchEvent(event);
        }
        if (step[0] === 'wait') await tick(step[1]);
        if (step[0] === 'consume') onData.push({ data: step[1], consumed: controller.consumeTerminalData(step[1]) });
      }
      await tick(20);
      const { composing, awaitingCommit, committed, latest } = controller.state;
      const result = { onData, state: { composing, awaitingCommit, committed, latest }, lastRender: renders.at(-1) };
      controller.destroy();
      term.dispose();
      return result;
    }, steps);
  }

  it('Enter mid-composition: xterm emits the commit and the controller takes it as committed', async () => {
    // compositionupdate's textarea end offset is recorded by xterm on a 0 ms timer.
    const result = await drive([['start'], ['update', '確定'], ['wait', 10], ['key', 13, 'Enter', false]]);
    expect(result.onData).toEqual([
      { data: '確定', consumed: true },
      { data: '\r', consumed: false },
    ]);
    expect(result.state).toMatchObject({ awaitingCommit: false, committed: true, latest: '確定' });
    expect(result.lastRender).toEqual({ text: '確定', phase: 'committed' });
  });

  it('keyCode 229 with isComposing false: xterm keeps composing, so the preview keeps following', async () => {
    const result = await drive([
      ['start'],
      ['update', 'か'],
      ['wait', 10],
      ['key', 229, 'k', false],
      ['update', 'かな'],
    ]);
    expect(result.onData).toEqual([]);
    expect(result.state).toMatchObject({ composing: true, awaitingCommit: false, latest: 'かな' });
    expect(result.lastRender).toEqual({ text: 'かな', phase: 'provisional' });
  });

  it('a deleted composition stops waiting after 2 s, so a later paste is not taken as its commit', async () => {
    const result = await drive([
      ['start'],
      ['update', 'abc'],
      ['update', ''],
      ['end', ''],
      ['wait', 2100],
      ['consume', 'pasted'],
    ]);
    expect(result.onData).toEqual([{ data: 'pasted', consumed: false }]);
    expect(result.state).toMatchObject({ awaitingCommit: false, committed: false });
  });
});
