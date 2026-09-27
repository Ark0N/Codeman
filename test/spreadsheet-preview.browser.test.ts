/** @fileoverview XLSX preview in real Chromium: Worker + vendor bundles load same-origin under a strict CSP. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import ExcelJS from 'exceljs';

const root = resolve(import.meta.dirname, '..');
const publicRoot = resolve(root, 'src/web/public');
let browser: Browser;

async function workbookBytes(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const summary = workbook.addWorksheet('Summary');
  summary.getCell('A1').value = 'Local workbook';
  summary.getCell('B2').value = 42;
  summary.mergeCells('A3:C3');
  summary.getCell('A3').value = 'Merged cells';
  summary.getCell('A100').value = 'Far row';
  summary.getCell('Z1').value = 'Far column';
  const details = workbook.addWorksheet('Details');
  details.getCell('A1').value = 'Second sheet';
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe('spreadsheet preview browser boundary', () => {
  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('renders through same-origin versioned Worker assets under CSP without external requests', async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 760 }, hasTouch: true });
    const workbook = await workbookBytes();
    const requests: string[] = [];
    page.on('request', (request) => requests.push(request.url()));
    await page.route('https://codeman.test/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') {
        await route.fulfill({
          contentType: 'text/html',
          headers: {
            'Content-Security-Policy':
              "default-src 'self'; script-src 'self'; worker-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'",
          },
          body:
            '<!doctype html><html><head><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/mobile.css"></head>' +
            '<body><div id="preview" style="width:370px;height:650px"></div>' +
            '<script src="/spreadsheet-preview.js"></script><script src="/start.js"></script></body></html>',
        });
        return;
      }
      if (url.pathname === '/start.js') {
        await route.fulfill({
          contentType: 'application/javascript',
          body: `window.previewHandle = window.CodemanSpreadsheetPreview.open({container:document.querySelector('#preview'),url:'/api/book.xlsx?preview=true',size:${workbook.length}});`,
        });
        return;
      }
      if (url.pathname === '/api/book.xlsx') {
        await route.fulfill({
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          body: workbook,
        });
        return;
      }
      const assetPath = resolve(publicRoot, `.${url.pathname}`);
      if (!assetPath.startsWith(publicRoot)) throw new Error('Unexpected asset path');
      await route.fulfill({
        contentType: url.pathname.endsWith('.js')
          ? 'application/javascript'
          : url.pathname.endsWith('.css')
            ? 'text/css'
            : 'application/octet-stream',
        body: readFileSync(assetPath),
      });
    });

    await page.goto('https://codeman.test/');
    await expect.poll(() => page.locator('.spreadsheet-sheet-tab').count()).toBe(2);
    await expect.poll(() => page.locator('.spreadsheet-cell', { hasText: 'Local workbook' }).count()).toBe(1);
    const initialGeometry = await page.locator('.spreadsheet-grid').evaluate((grid) => {
      const cell = grid.querySelector('.spreadsheet-cell');
      if (!cell) throw new Error('Missing rendered spreadsheet cell');
      const gridRect = grid.getBoundingClientRect();
      const cellRect = cell.getBoundingClientRect();
      return { left: cellRect.left - gridRect.left, top: cellRect.top - gridRect.top };
    });
    expect(initialGeometry.left).toBeGreaterThanOrEqual(36);
    expect(initialGeometry.top).toBeGreaterThanOrEqual(20);
    await page.locator('.spreadsheet-grid').evaluate((grid) => {
      grid.scrollTop = 400;
      grid.scrollLeft = 400;
      grid.dispatchEvent(new Event('scroll'));
    });
    await expect
      .poll(() =>
        page.locator('.spreadsheet-grid').evaluate((grid) => {
          const bounds = grid.getBoundingClientRect();
          return [...grid.querySelectorAll('.spreadsheet-row-heading, .spreadsheet-column-heading')].filter(
            (heading) => {
              const rect = heading.getBoundingClientRect();
              return (
                rect.right > bounds.left &&
                rect.left < bounds.right &&
                rect.bottom > bounds.top &&
                rect.top < bounds.bottom
              );
            }
          ).length;
        })
      )
      .toBeGreaterThan(0);
    await page.getByRole('tab', { name: 'Details' }).click();
    await expect.poll(() => page.locator('.spreadsheet-cell', { hasText: 'Second sheet' }).count()).toBe(1);
    expect(await page.locator('.spreadsheet-grid').evaluate((element) => getComputedStyle(element).overflow)).toBe(
      'auto'
    );

    const origins = new Set(requests.map((request) => new URL(request).origin));
    expect(origins).toEqual(new Set(['https://codeman.test']));
    expect(requests.some((request) => /spreadsheet-preview-worker\.js\?v=[a-f0-9]{12}/.test(request))).toBe(true);
    expect(requests.some((request) => /vendor\/exceljs\.min\.js\?v=[a-f0-9]{12}/.test(request))).toBe(true);
    expect(requests.some((request) => /vendor\/fflate\.min\.js\?v=[a-f0-9]{12}/.test(request))).toBe(true);
    await page.close();
  });
});
