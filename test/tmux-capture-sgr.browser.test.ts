import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { createStyledPaneCapture } from './fixtures/styled-pane-capture.js';

let browser: Browser;
let capture: Awaited<ReturnType<typeof createStyledPaneCapture>>;
beforeAll(async () => {
  capture = await createStyledPaneCapture();
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});

describe('captured status-bar colors stay out of live writes (#629)', () => {
  it.each([
    [true, true],
    [true, false],
    [false, false],
  ])('fullHistory=%s, geometry=%s', async (fullHistory, geometry) => {
    const snapshot = capture(fullHistory, geometry);
    expect(snapshot).not.toBeNull();
    const page = await browser.newPage();
    try {
      await page.setContent('<div id="terminal"></div>');
      await page.addScriptTag({ path: createRequire(import.meta.url).resolve('@xterm/xterm') });
      const result = await page.evaluate(async (snapshot) => {
        const terminal = new (window as any).Terminal({ cols: 40, rows: 2 });
        terminal.open(document.getElementById('terminal'));
        const write = (data: string) => new Promise<void>((resolve) => terminal.write(data, resolve));
        await write(snapshot!);
        const status = terminal.buffer.active.getLine(1).getCell(0);
        const statusBackground = status.getBgColor();
        await write('\x1b[1;1Htyped\x1b[K');
        const line = terminal.buffer.active.getLine(0);
        const result = {
          statusBackground,
          text: line.translateToString(true),
          typedDefault: line.getCell(0).isBgDefault(),
          erasedDefault: line.getCell(10).isBgDefault(),
          statusAfter: terminal.buffer.active.getLine(1).getCell(0).getBgColor(),
        };
        terminal.dispose();
        return result;
      }, snapshot);
      expect(result).toEqual({
        statusBackground: 2,
        text: 'typed',
        typedDefault: true,
        erasedDefault: true,
        statusAfter: 2,
      });
    } finally {
      await page.close();
    }
  });
});
