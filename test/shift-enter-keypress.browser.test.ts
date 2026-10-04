// @vitest-environment node
// Real xterm.js in real Chromium, real keystrokes. xterm runs the custom key handler for
// keydown AND keypress, and drops a keypress that carries Ctrl/Alt but NOT a Shift-only one,
// so a handler that returns false for keydown alone lets Shift+Enter fall through to a bare
// \r (submit). That is why Ctrl+Enter and Alt+Enter inserted a newline while Shift+Enter
// submitted. Self-contained: no server, only the xterm bundle.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const XTERM = readFileSync(join(process.cwd(), 'node_modules/@xterm/xterm/lib/xterm.js'), 'utf8');

declare global {
  interface Window {
    __t: Record<string, { term: { focus(): void }; sent: string[] }>;
    Terminal: new () => {
      open(el: HTMLElement): void;
      focus(): void;
      onData(cb: (d: string) => void): void;
      attachCustomKeyEventHandler(cb: (ev: KeyboardEvent) => boolean): void;
    };
  }
}

describe('Shift/Ctrl+Enter reach the PTY as a bare \\r only if the handler lets keypress through', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await page.setContent('<body></body>');
    await page.addScriptTag({ content: XTERM });
    await page.evaluate(() => {
      const mk = (handler: (ev: KeyboardEvent) => boolean) => {
        const host = document.createElement('div');
        document.body.appendChild(host);
        const term = new window.Terminal();
        term.open(host);
        const sent: string[] = [];
        term.onData((d) => sent.push(d));
        term.attachCustomKeyEventHandler(handler);
        return { term, sent };
      };
      // The shipped predicate (terminal-ui.js / terminal-split.js) and the one it replaced.
      const shipped = (ev: KeyboardEvent) => !(ev.key === 'Enter' && (ev.shiftKey || ev.ctrlKey));
      const keydownOnly = (ev: KeyboardEvent) =>
        !(ev.key === 'Enter' && (ev.shiftKey || ev.ctrlKey) && ev.type === 'keydown');
      window.__t = { shipped: mk(shipped), keydownOnly: mk(keydownOnly) };
    });
  });
  afterAll(async () => {
    await browser?.close();
  });

  async function typed(which: 'shipped' | 'keydownOnly', key: string): Promise<string[]> {
    await page.evaluate((w) => {
      window.__t[w].sent.length = 0;
      window.__t[w].term.focus();
    }, which);
    await page.keyboard.press(key);
    return page.evaluate((w) => [...window.__t[w].sent], which);
  }

  it('reproduces the bug with the old keydown-only handler', async () => {
    expect(await typed('keydownOnly', 'Shift+Enter')).toEqual(['\r']);
    expect(await typed('keydownOnly', 'Control+Enter')).toEqual([]);
  });

  it('sends nothing for Shift+Enter and Ctrl+Enter with the shipped handler (the send-key route supplies the newline)', async () => {
    expect(await typed('shipped', 'Shift+Enter')).toEqual([]);
    expect(await typed('shipped', 'Control+Enter')).toEqual([]);
  });

  it('leaves plain Enter and Alt+Enter alone', async () => {
    expect(await typed('shipped', 'Enter')).toEqual(['\r']);
    expect(await typed('shipped', 'Alt+Enter')).toEqual(['\x1b\r']);
  });
});
