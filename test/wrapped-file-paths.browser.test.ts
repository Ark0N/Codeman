/** Real xterm clicks resolve the complete filename or report its lookup error from either wrapped row. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';

const publicDir = resolve(import.meta.dirname, '../src/web/public');
const basePath = '/mnt/user/Scratch/Kobo/Set-KoboCovers/Kobo eReader.conf';

describe('wrapped configuration file links (Chromium)', () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser.close();
  });

  it.each([
    { wrap: 'soft', originalExists: false, extension: 'conf', registrationStatus: 200, prefix: '' },
    { wrap: 'hard', originalExists: false, extension: 'conf', registrationStatus: 200, prefix: '' },
    { wrap: 'hard', originalExists: true, extension: 'conf', registrationStatus: 200, prefix: '' },
    { wrap: 'hard', originalExists: true, extension: 'svg', registrationStatus: 400, prefix: '' },
    { wrap: 'hard', originalExists: true, extension: 'markdown', registrationStatus: 400, prefix: '' },
    { wrap: 'hard', originalExists: false, extension: 'svg', registrationStatus: 400, prefix: '' },
    { wrap: 'hard', originalExists: false, extension: 'conf', registrationStatus: 404, prefix: '' },
    { wrap: 'hard', originalExists: false, extension: 'markdown', registrationStatus: 200, prefix: 'Path: ' },
  ])(
    'handles .$extension links on both rows: $wrap, original exists: $originalExists, prefix: $prefix',
    async ({ wrap, originalExists, extension, registrationStatus, prefix }) => {
      const path = basePath.replace('.conf', `.${extension}`);
      const original = path.replace('Kobo eReader', 'KoboeReader');
      const expected = wrap === 'hard' && (originalExists || registrationStatus === 404) ? original : path;
      const lookupFails = registrationStatus === 400 && !originalExists;
      const lookups: string[] = [];
      const page = await browser.newPage({ viewport: { width: 1920, height: 600 } });
      try {
        await page.route('http://fixture.test/', (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: '<div id="terminal"></div>',
          })
        );
        await page.route('http://fixture.test/api/sessions/fixture/attachments', async (route) => {
          const body = route.request().postDataJSON();
          expect(body.notify).toBe(false);
          lookups.push(body.path);
          const exists = body.path === path || (originalExists && body.path === original);
          const status = exists ? registrationStatus : 404;
          await route.fulfill({
            status,
            json:
              status === 200
                ? { success: true, data: { attachmentId: 'att-fixture' } }
                : { success: false, error: status === 400 ? 'Unsupported attachment type' : 'File not found' },
          });
        });
        await page.goto('http://fixture.test/');
        await page.addStyleTag({ path: resolve(publicDir, '../../../node_modules/@xterm/xterm/css/xterm.css') });
        await page.addScriptTag({ path: resolve(publicDir, '../../../node_modules/@xterm/xterm/lib/xterm.js') });
        await page.addScriptTag({ content: 'window.CodemanApp = class CodemanApp {};' });
        for (const file of ['constants.js', 'terminal-ui.js', 'panels-ui.js']) {
          await page.addScriptTag({ content: readFileSync(resolve(publicDir, file), 'utf8') });
        }
        await page.evaluate(
          async ({ path, wrap, workingDir, prefix }) => {
            const w = window as any;
            const boundary = path.lastIndexOf(' ');
            const first = `Found it: prepared a corrected configuration (${prefix}${path.slice(0, boundary)}`;
            const terminal = new w.Terminal({ cols: first.length + (wrap === 'soft' ? 1 : 20), rows: 6 });
            terminal.open(document.getElementById('terminal'));
            w.opened = [];
            w.app = Object.assign(new w.CodemanApp(), {
              terminal,
              activeSessionId: 'fixture',
              sessions: new Map([['fixture', { workingDir }]]),
              openFilePreview: (file: string) => w.opened.push(file),
              openLogViewerWindow: (file: string) => w.opened.push(`log:${file}`),
              openFolderGrid: (file: string) => w.opened.push(`folder:${file}`),
              showToast: (message: string) => w.opened.push(`error:${message}`),
            });
            w.app.registerFilePathLinkProvider();
            const text = `${first}${wrap === 'soft' ? ' ' : '\r\n  '}${path.slice(boundary + 1)}).`;
            await new Promise<void>((done) => terminal.write(text, done));
            await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
          },
          { path, wrap, workingDir: registrationStatus === 400 ? '/mnt/user/Scratch/Kobo' : '/workspace', prefix }
        );

        expect(lookups).toEqual([]);
        for (const row of [0, 1]) {
          const point = await page.evaluate(
            async ({ path, row }) => {
              const app = (window as any).app;
              const terminal = app.terminal;
              const links = await new Promise<any[]>((done) => app._terminalLinkProvider.provideLinks(row + 1, done));
              const link = links.find((candidate) => candidate.text === path);
              if (!link) throw new Error(`The complete filename is not linked on row ${row + 1}`);
              const text = terminal.buffer.active.getLine(row).translateToString(true);
              const col = row === 0 ? link.range.start.x : text.indexOf('eReader') + 1;
              const box = terminal.element.querySelector('.xterm-screen').getBoundingClientRect();
              return {
                x: box.left + (col - 0.5) * (box.width / terminal.cols),
                y: box.top + (row + 0.5) * (box.height / terminal.rows),
              };
            },
            { path: wrap === 'hard' ? original : path, row }
          );
          await page.mouse.move(point.x, point.y);
          await page.waitForFunction(() => (window as any).app._linkHovered === true);
          await page.mouse.click(point.x, point.y);
          await page.waitForFunction((count) => (window as any).opened.length === count, row + 1);
          const opened = await page.evaluate(() => (window as any).opened as string[]);
          if (lookupFails) {
            for (const message of opened) {
              expect(message).toMatch(/^error:/);
              expect(message).toContain(path);
              expect(message).not.toContain('outside the session workspace');
            }
          } else {
            expect(opened).toEqual(Array(row + 1).fill(expected));
          }
          await page.mouse.move(0, 0);
        }
        expect(lookups).toEqual(
          wrap === 'soft' ? [] : originalExists ? [original, original] : [original, path, original, path]
        );
      } finally {
        await page.close();
      }
    }
  );
});
