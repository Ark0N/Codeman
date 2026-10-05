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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
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

/**
 * The preview with local echo ON, the default for Claude sessions on phones.
 * Committed text then sits in the LocalEchoOverlay (a z-index 7 layer in
 * `.xterm-screen`) and never reaches the PTY before Enter, so the PTY cursor,
 * which is where the helper span sits, stays at the prompt start: under the
 * overlay's own opaque text. So a composition that follows text already in the
 * overlay must be drawn by the overlay itself, after that text.
 *
 * Loads the real pieces: xterm 6, the overlay bundled from its package source
 * exactly as scripts/postinstall.js bundles it (plus the same LocalEchoOverlay
 * alias), styles.css, mobile-ime-preview.js, and terminal-ui.js's own
 * `_initMobileImePreview` on a bare CodemanApp prototype.
 */
describe('mobile IME preview over the local echo overlay', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    const bundled = await build({
      entryPoints: [resolve(root, 'packages/xterm-zerolag-input/src/zerolag-input-addon.ts')],
      bundle: true,
      format: 'iife',
      globalName: 'XtermZerolagInput',
      write: false,
      logLevel: 'silent',
    });
    const overlayBundle =
      bundled.outputFiles[0].text +
      '\nwindow.ZerolagInputAddon=XtermZerolagInput.ZerolagInputAddon;' +
      'window.LocalEchoOverlay=class extends XtermZerolagInput.ZerolagInputAddon{' +
      'constructor(terminal){super({prompt:{type:"character",char:"\\u276f",offset:2}});this.activate(terminal);}};\n';

    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 800, height: 400 }, deviceScaleFactor: 1 });
    await page.setContent(
      '<html class="touch-device"><body><div id="t" style="width:600px;height:240px"></div></body></html>'
    );
    await page.addStyleTag({ path: resolve(root, 'node_modules/@xterm/xterm/css/xterm.css') });
    await page.addStyleTag({ content: readFileSync(resolve(root, 'src/web/public/styles.css'), 'utf8') });
    await page.addScriptTag({ path: resolve(root, 'node_modules/@xterm/xterm/lib/xterm.js') });
    await page.addScriptTag({ content: overlayBundle });
    await page.addScriptTag({ path: resolve(root, 'src/web/public/mobile-ime-preview.js') });
    await page.addScriptTag({ content: 'window.CodemanApp = class CodemanApp {};' });
    await page.addScriptTag({ path: resolve(root, 'src/web/public/terminal-ui.js') });
  }, 60000);

  afterAll(async () => {
    if (browser) await browser.close();
  });

  /**
   * Types `pending` into the overlay (as the printable/paste branch does), then
   * composes `composing` and reports what is PAINTED at the cell right after
   * the pending text and at the PTY cursor. Painted = topmost by hit-testing
   * with pointer-events forced on, since the overlay and the preview are
   * pointer-events:none.
   */
  async function composeAfter(pending: string, composing: string, commit: boolean) {
    return page.evaluate(
      async ({ pending, composing, commit }) => {
        const w = window as any;
        const host = document.getElementById('t') as HTMLElement;
        host.innerHTML = '';
        const term = new w.Terminal({
          cols: 40,
          rows: 8,
          fontSize: 14,
          fontFamily: 'monospace',
          allowProposedApi: true,
        });
        term.open(host);
        await new Promise<void>((r) => term.write('\u276f ', () => r()));
        const app = new w.CodemanApp();
        app.terminal = term;
        app._localEchoEnabled = true;
        app._localEchoOverlay = new w.LocalEchoOverlay(term);
        w.MobileImePreview.isIosWebKitTouch = () => true;
        app._initMobileImePreview();

        // The helper textarea and span follow the PTY cursor (col 2, row 0), as
        // _syncMobileHelperTextareaToCursor places them.
        const screen = term.element.querySelector('.xterm-screen') as HTMLElement;
        const dims = term._core._renderService.dimensions.css.cell;
        term.element.style.setProperty('--xterm-helper-left', 2 * dims.width + 'px');
        term.element.style.setProperty('--xterm-helper-top', '0px');

        if (pending) app._localEchoOverlay.appendText(pending);
        const textarea = term.textarea as HTMLTextAreaElement;
        textarea.focus();
        textarea.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
        textarea.value = composing;
        textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: composing }));
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 20)));

        const force = document.createElement('style');
        force.textContent = '.xterm * { pointer-events: auto !important; }';
        document.head.appendChild(force);
        const rect = screen.getBoundingClientRect();
        const widthOf = (s: string) => term._core.unicodeService.getStringCellWidth(s);
        const paintedAt = (col: number) => {
          const el = document.elementFromPoint(
            rect.left + (col + 0.5) * dims.width,
            rect.top + 0.5 * dims.height
          ) as HTMLElement | null;
          return {
            text: el?.textContent ?? null,
            composition: !!el?.closest?.('[data-zerolag-composition]'),
            preview: !!el?.closest?.('.codeman-ime-preview'),
          };
        };
        const afterPending = paintedAt(2 + widthOf(pending));
        force.remove();

        let afterCommit = null;
        if (commit) {
          textarea.dispatchEvent(new CompositionEvent('compositionend', { data: composing }));
          // What the printable/paste branch of terminal-ui.js's onData does.
          if (app._consumeMobileImeTerminalData(composing)) {
            app._localEchoOverlay.appendText(composing);
            app._transferMobileImeCommitToLocalEcho();
          }
          await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 20)));
          afterCommit = {
            pendingText: app._localEchoOverlay.pendingText,
            compositionSpans: term.element.querySelectorAll('[data-zerolag-composition]').length,
            overlayText: app._localEchoOverlay._overlay?.textContent,
          };
        }
        const result = {
          afterPending,
          pendingText: app._localEchoOverlay.pendingText,
          afterCommit,
        };
        app._destroyMobileImePreview();
        app._localEchoOverlay.dispose();
        term.dispose();
        return result;
      },
      { pending, composing, commit }
    );
  }

  it('first composition on an empty prompt: the overlay draws it at the prompt', async () => {
    const result = await composeAfter('', '今日は', false);
    expect(result.afterPending).toEqual({ text: '今', composition: true, preview: false });
    expect(result.pendingText).toBe('');
  });

  it('a second composition is painted after the text already in the overlay, not under it', async () => {
    const result = await composeAfter('今日は', '天気', false);
    expect(result.afterPending.text).toBe('天');
    expect(result.afterPending.composition).toBe(true);
    // Provisional text is never taken into the overlay's pending (unsent) text.
    expect(result.pendingText).toBe('今日は');
  });

  it('the commit lands once in the overlay and the composition tail is gone', async () => {
    const result = await composeAfter('今日は', '天気', true);
    expect(result.afterCommit).toEqual({ pendingText: '今日は天気', compositionSpans: 0, overlayText: '今日は天気' });
  });

  /**
   * Composes `composing` after `pending`, then streams output through the REAL
   * write path (batchTerminalWrite, the scheduled flushPendingWrites, xterm's
   * async parse) that moves the ❯ row from 0 to 3, then one more frame that
   * leaves the prompt where it is (a status-line repaint). Reports the overlay
   * row after each frame.
   *
   * The post-write re-place runs right after terminal.write() returns, before
   * xterm parses that chunk, so it sees the buffer as of the previous frame: the
   * overlay reaches the new row on the frame after the move. That timing is the
   * same for pending text; the composition-only overlay used to never get there
   * because the re-place was gated on hasPending, which excludes it.
   */
  async function composeThenMovePrompt(pending: string, composing: string) {
    return page.evaluate(
      async ({ pending, composing }) => {
        const w = window as any;
        const host = document.getElementById('t') as HTMLElement;
        host.innerHTML = '';
        const term = new w.Terminal({
          cols: 40,
          rows: 8,
          fontSize: 14,
          fontFamily: 'monospace',
          allowProposedApi: true,
        });
        term.open(host);
        await new Promise<void>((r) => term.write('❯ ', () => r()));
        const app = new w.CodemanApp();
        Object.assign(app, {
          terminal: term,
          _localEchoEnabled: true,
          _localEchoOverlay: new w.LocalEchoOverlay(term),
          pendingWrites: [],
          activeSessionId: 'session-a',
          sessions: new Map([['session-a', { mode: 'claude' }]]),
        });
        w.MobileImePreview.isIosWebKitTouch = () => true;
        app._initMobileImePreview();

        if (pending) app._localEchoOverlay.appendText(pending);
        const textarea = term.textarea as HTMLTextAreaElement;
        textarea.focus();
        textarea.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
        textarea.value = composing;
        textarea.dispatchEvent(new CompositionEvent('compositionupdate', { data: composing }));
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 20)));

        const cellH = term._core._renderService.dimensions.css.cell.height;
        const overlayEl = app._localEchoOverlay._overlay as HTMLElement;
        const overlayRow = () =>
          overlayEl.style.display === 'none' ? null : Math.round(parseFloat(overlayEl.style.top) / cellH);
        // Output goes through the app's own scheduler; wait until it has been
        // flushed and parsed.
        const stream = async (data: string) => {
          app.batchTerminalWrite(data);
          for (let i = 0; i < 200; i++) {
            if (!app.writeFrameScheduled && !app._terminalWriteInFlight && app.pendingWrites.length === 0) break;
            await new Promise((r) => setTimeout(r, 10));
          }
          await new Promise<void>((r) => term.write('', () => r()));
        };

        const before = overlayRow();
        await stream('\r\x1b[2Kline 1\r\nline 2\r\nline 3\r\n❯ ');
        const promptRow = app._localEchoOverlay.findPrompt()?.row ?? null;
        await stream('\x1b7\x1b[8;1Hworking\x1b8');
        const result = {
          before,
          promptRow,
          after: overlayRow(),
          composition: Array.from(term.element.querySelectorAll('[data-zerolag-composition]'))
            .map((el) => (el as HTMLElement).textContent)
            .join(''),
          hasPending: app._localEchoOverlay.hasPending,
        };
        app._destroyMobileImePreview();
        app._localEchoOverlay.dispose();
        term.dispose();
        return result;
      },
      { pending, composing }
    );
  }

  it('a composition on an empty prompt follows the prompt when output moves it', async () => {
    const result = await composeThenMovePrompt('', '今日');
    expect(result.before).toBe(0);
    expect(result.promptRow).toBe(3);
    // Nothing is pending: before the fix this stayed on row 0, over "line 1".
    expect(result.hasPending).toBe(false);
    expect(result.after).toBe(3);
    expect(result.composition).toBe('今日');
  });

  it('a composition after pending text follows it the same way', async () => {
    const result = await composeThenMovePrompt('abc', '今日');
    expect(result).toEqual({ before: 0, promptRow: 3, after: 3, composition: '今日', hasPending: true });
  });
});
