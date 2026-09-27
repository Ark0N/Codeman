/** @fileoverview Worker-owned XLSX parse and viewport protocol. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import * as fflate from 'fflate';

const root = resolve(import.meta.dirname, '..');
const workerSource = readFileSync(resolve(root, 'src/web/public/spreadsheet-preview-worker.js'), 'utf8');
const coreSource = readFileSync(resolve(root, 'src/web/public/spreadsheet-xlsx-core.js'), 'utf8');

async function fixture(): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  const first = workbook.addWorksheet('Summary');
  first.getCell('A1').value = 'Revenue';
  first.getCell('B2').value = 1234.5;
  first.getCell('B2').numFmt = '$#,##0.00';
  first.getCell('C3').value = { formula: 'SUM(B2)', result: 1234.5 };
  first.getCell('C3').numFmt = '$#,##0.00';
  first.mergeCells('A4:C4');
  first.getCell('A4').value = 'Merged';
  first.getRow(2).height = 30;
  first.getColumn(2).width = 18;
  const second = workbook.addWorksheet('Details');
  second.getCell('A1').value = 'Detail';
  workbook.addWorksheet('Hidden').state = 'hidden';
  const bytes = await workbook.xlsx.writeBuffer();
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function fixtureWithChartPart(): Promise<ArrayBuffer> {
  const entries = fflate.unzipSync(new Uint8Array(await fixture()));
  entries['xl/charts/chart1.xml'] = fflate.strToU8('<chart/>');
  const bytes = fflate.zipSync(entries);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

// Theme fills, indexed colours, and unfilled cells in one workbook.
// accent1 is forced to pure red so a resolved theme colour cannot be confused
// with the built-in default Office palette.
async function themedFixture(): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Themed');
  for (const ref of ['A1', 'A2', 'A3', 'A4']) sheet.getCell(ref).value = ref;
  const entries = fflate.unzipSync(new Uint8Array(await workbook.xlsx.writeBuffer()));
  entries['xl/theme/theme1.xml'] = fflate.strToU8(
    '<?xml version="1.0"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">' +
      '<a:themeElements><a:clrScheme name="Custom">' +
      '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
      '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
      '<a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2>' +
      '<a:accent1><a:srgbClr val="FF0000"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2>' +
      '<a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4>' +
      '<a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6>' +
      '<a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink>' +
      '</a:clrScheme></a:themeElements></a:theme>'
  );
  entries['xl/styles.xml'] = fflate.strToU8(
    '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="5"><font><sz val="11"/></font><font><color theme="1"/></font><font><color indexed="9"/></font>' +
      '<font><color rgb="FF000000"/></font><font><color rgb="FF11111B"/></font></fonts>' +
      '<fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor theme="4"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor indexed="13"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FF1A1A2E"/></patternFill></fill></fills>' +
      '<borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
      '<xf numFmtId="0" fontId="2" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
      '<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '<xf numFmtId="0" fontId="4" fillId="4" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
  );
  entries['xl/worksheets/sheet1.xml'] = fflate.strToU8(
    fflate
      .strFromU8(entries['xl/worksheets/sheet1.xml'])
      .replace('<c r="A1"', '<c s="1" r="A1"')
      .replace('<c r="A2"', '<c s="2" r="A2"')
      .replace('<c r="A3"', '<c s="3" r="A3"')
      .replace('<c r="A4"', '<c s="4" r="A4"')
  );
  const bytes = fflate.zipSync(entries);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function createHarness() {
  const messages: unknown[] = [];
  const imports: string[] = [];
  const self: Record<string, unknown> = {
    location: { href: 'http://localhost/spreadsheet-preview-worker.js?v=test' },
    postMessage: (message: unknown) => messages.push(message),
  };
  const context = vm.createContext({
    self,
    globalThis: self,
    URL,
    Uint8Array,
    ArrayBuffer,
    DataView,
    TextDecoder,
    Date,
    Math,
    Number,
    String,
    Object,
    Map,
    Set,
    console,
    importScripts: (...urls: string[]) => {
      imports.push(...urls);
      for (const url of urls) {
        if (url.includes('fflate')) Object.assign(self, { fflate });
        if (url.includes('spreadsheet-xlsx-core')) vm.runInContext(coreSource, context);
        if (url.includes('exceljs')) Object.assign(self, { ExcelJS });
      }
    },
  });
  vm.runInContext(workerSource, context);
  return {
    messages,
    imports,
    send: async (data: unknown) => {
      await (self.onmessage as (event: { data: unknown }) => Promise<void>)({ data });
    },
  };
}

describe('spreadsheet preview worker', () => {
  it('admits before lazy ExcelJS loading and returns visible sheets in workbook order', async () => {
    const harness = createHarness();
    expect(harness.messages).toEqual([{ type: 'ready' }]);
    expect(harness.imports.some((url) => url.includes('exceljs'))).toBe(false);

    await harness.send({ type: 'load', bytes: await fixture() });

    expect(harness.imports.some((url) => url.includes('exceljs'))).toBe(true);
    const metadata = harness.messages.at(-1) as Record<string, any>;
    expect(metadata.type).toBe('metadata');
    expect(metadata.sheets.map((sheet: { name: string }) => sheet.name)).toEqual(['Summary', 'Details']);
    expect(metadata.sheets[0]).toMatchObject({ rows: 4, cols: 3 });
    expect(metadata.sheets[0].rowOverrides).toContainEqual([2, 40]);
    expect(metadata.sheets[0].columnOverrides[0][0]).toBe(2);
    expect(metadata.styles.length).toBeLessThanOrEqual(5000);
  });

  it('returns bounded intersecting tiles and echoes request and sheet identity', async () => {
    const harness = createHarness();
    await harness.send({ type: 'load', bytes: await fixture() });
    const metadata = harness.messages.at(-1) as Record<string, any>;
    const sheetId = metadata.sheets[0].id;

    await harness.send({ type: 'tile', requestId: 7, sheetId, range: { r1: 2, c1: 2, r2: 4, c2: 3 } });

    const tile = harness.messages.at(-1) as Record<string, any>;
    expect(tile).toMatchObject({ type: 'tile', requestId: 7, sheetId });
    expect(tile.cells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ row: 2, col: 2, text: '$1,234.50' }),
        expect.objectContaining({ row: 3, col: 3, text: '$1,234.50' }),
      ])
    );
    expect(tile.merges).toContain('A4:C4');
    expect(tile.cells).toContainEqual(expect.objectContaining({ row: 4, col: 1, text: 'Merged' }));
    expect(tile.cells.length).toBeLessThanOrEqual(9);
  });

  it('rejects malformed input without loading ExcelJS', async () => {
    const harness = createHarness();
    await harness.send({ type: 'load', bytes: Uint8Array.from([1, 2, 3]).buffer });
    expect(harness.messages.at(-1)).toMatchObject({ type: 'error', code: 'malformed' });
    expect(harness.imports.some((url) => url.includes('exceljs'))).toBe(false);
  });

  it('resolves theme and indexed colours and emits contrast-safe colour pairs', async () => {
    const harness = createHarness();
    await harness.send({ type: 'load', bytes: await themedFixture() });
    const metadata = harness.messages.at(-1) as Record<string, any>;
    const sheetId = metadata.sheets[0].id;
    await harness.send({ type: 'tile', requestId: 1, sheetId, range: { r1: 1, c1: 1, r2: 4, c2: 1 } });
    const tile = harness.messages.at(-1) as Record<string, any>;
    const pairs = new Map<number, { fill?: string; color?: string }>();
    for (const cell of tile.cells as Array<{ row: number; styleId: number }>) {
      const style = metadata.styles[cell.styleId];
      pairs.set(cell.row, { fill: style.fill, color: style.font?.color });
    }
    // Theme fill (workbook's own accent1 = red) survives instead of being dropped.
    expect(pairs.get(1)).toEqual({ fill: '#ff0000', color: '#000000' });
    // Indexed white-on-yellow is illegible, so the foreground flips to black.
    expect(pairs.get(2)).toEqual({ fill: '#ffff00', color: '#000000' });
    // A black font with no fill renders on the implicit white sheet background.
    expect(pairs.get(3)).toEqual({ fill: '#ffffff', color: '#000000' });
    // Near-black on near-black flips the other way.
    expect(pairs.get(4)).toEqual({ fill: '#1a1a2e', color: '#ffffff' });
  });

  it('loads its scripts by RELATIVE url so a --base-url mount resolves them under the prefix', async () => {
    const harness = createHarness();
    await harness.send({ type: 'load', bytes: await fixture() });
    expect(harness.imports.length).toBeGreaterThan(0);
    for (const url of harness.imports) {
      expect(url.startsWith('/'), url).toBe(false);
      expect(url).toContain('?v=test');
    }
  });

  it('never evaluates formulas: an uncached formula is shown as its source text', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Formulas');
    sheet.getCell('A1').value = { formula: 'WEBSERVICE("http://example.invalid/")' } as ExcelJS.CellFormulaValue;
    const written = await workbook.xlsx.writeBuffer();
    const harness = createHarness();
    await harness.send({
      type: 'load',
      bytes: written.buffer.slice(written.byteOffset, written.byteOffset + written.byteLength),
    });
    const metadata = harness.messages.at(-1) as Record<string, any>;
    await harness.send({
      type: 'tile',
      requestId: 1,
      sheetId: metadata.sheets[0].id,
      range: { r1: 1, c1: 1, r2: 1, c2: 1 },
    });
    const tile = harness.messages.at(-1) as Record<string, any>;
    expect(tile.cells).toEqual([
      expect.objectContaining({ row: 1, col: 1, text: '=WEBSERVICE("http://example.invalid/")' }),
    ]);
    expect(tile.warnings).toContain('Formula has no cached result');
  });

  it('carries detected unsupported features into workbook metadata', async () => {
    const harness = createHarness();
    await harness.send({ type: 'load', bytes: await fixtureWithChartPart() });
    expect(harness.messages.at(-1)).toMatchObject({ type: 'metadata', warnings: ['charts'] });
  });
});
