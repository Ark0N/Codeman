/** @fileoverview Worker-owned XLSX parse and viewport protocol. */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { crc32 } from 'node:zlib';
import vm from 'node:vm';
import { afterAll, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import * as fflate from 'fflate';

// A negative UTC offset is what turned ExcelJS `Date` cells into the previous
// day. Node re-reads TZ on assignment; the date test asserts it took effect.
const originalTz = process.env.TZ;
process.env.TZ = 'America/New_York';
afterAll(() => {
  if (originalTz === undefined) delete process.env.TZ;
  else process.env.TZ = originalTz;
});

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
    self,
    /** Evaluate an expression against the worker's own top-level bindings. */
    peek: (expression: string): unknown => vm.runInContext(expression, context),
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

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function writeWorkbook(workbook: ExcelJS.Workbook): Promise<ArrayBuffer> {
  return toArrayBuffer(new Uint8Array(await workbook.xlsx.writeBuffer()));
}

type Harness = ReturnType<typeof createHarness>;
type Range = { r1: number; c1: number; r2: number; c2: number };

async function loadMetadata(harness: Harness, bytes: ArrayBuffer): Promise<Record<string, any>> {
  await harness.send({ type: 'load', bytes });
  const metadata = harness.messages.at(-1) as Record<string, any>;
  expect(metadata.type, JSON.stringify(metadata)).toBe('metadata');
  return metadata;
}

async function requestTile(harness: Harness, sheetId: string, range: Range): Promise<Record<string, any>> {
  await harness.send({ type: 'tile', requestId: 1, sheetId, range });
  return harness.messages.at(-1) as Record<string, any>;
}

/** The range spreadsheet-preview.js asks for at scroll 0 with its fallback 800x500 viewport. */
function defaultViewportRange(harness: Harness, sheet: Record<string, any>): Range {
  const core = harness.self.CodemanSpreadsheetXlsxCore as {
    createSparseAxis(count: number, size: number, overrides: Array<[number, number]>): unknown;
    axisIndexAt(axis: unknown, offset: number): number;
  };
  const rows = core.createSparseAxis(sheet.rows, sheet.defaultRowHeight, sheet.rowOverrides);
  const cols = core.createSparseAxis(sheet.cols, sheet.defaultColumnWidth, sheet.columnOverrides);
  return {
    r1: 1,
    c1: 1,
    r2: Math.min(sheet.rows, core.axisIndexAt(rows, 500) + 2),
    c2: Math.min(sheet.cols, core.axisIndexAt(cols, 800) + 2),
  };
}

describe('spreadsheet preview worker: ExcelJS value shapes', () => {
  it('formats Date, rich text, hyperlink, error and formula-result cells as ExcelJS loads them', async () => {
    // Proves the negative-offset TZ is really in force for this file.
    expect(new Date(Date.UTC(2024, 0, 15)).getDate()).toBe(14);

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Values');
    const day = new Date(Date.UTC(2024, 0, 15));
    sheet.getCell('A1').value = day;
    sheet.getCell('A1').numFmt = 'yyyy-mm-dd';
    sheet.getCell('A2').value = new Date(Date.UTC(2024, 0, 15, 13, 45));
    sheet.getCell('A2').numFmt = 'yyyy-mm-dd hh:mm';
    sheet.getCell('A3').value = day; // ExcelJS's default date format (mm-dd-yy)
    sheet.getCell('A4').value = { richText: [{ text: 'Hello ' }, { font: { bold: true }, text: 'World' }] };
    sheet.getCell('A5').value = { text: 'Codeman', hyperlink: 'https://example.invalid/' };
    sheet.getCell('A6').value = { error: '#DIV/0!' } as ExcelJS.CellErrorValue;
    sheet.getCell('A7').value = { formula: '1/0', result: { error: '#DIV/0!' } } as ExcelJS.CellFormulaValue;
    sheet.getCell('A8').value = { formula: 'ROW()', result: 8, shareType: 'shared', ref: 'A8:A9' } as never;
    sheet.getCell('A9').value = { sharedFormula: 'A8', result: 9 } as ExcelJS.CellSharedFormulaValue;
    sheet.getCell('A10').value = { formula: 'DATE(2024,1,15)', result: day } as ExcelJS.CellFormulaValue;
    sheet.getCell('A10').numFmt = 'yyyy-mm-dd';
    sheet.getCell('A11').value = new Date(Date.UTC(1899, 11, 30, 6, 30, 15));
    sheet.getCell('A11').numFmt = 'hh:mm:ss';
    // Float error lands this one just under 00:05; truncating it showed 00:04.
    sheet.getCell('A12').value = new Date(Date.UTC(2020, 0, 1, 0, 5));
    sheet.getCell('A12').numFmt = 'yyyy-mm-dd hh:mm';

    const harness = createHarness();
    const metadata = await loadMetadata(harness, await writeWorkbook(workbook));
    const tile = await requestTile(harness, metadata.sheets[0].id, { r1: 1, c1: 1, r2: 12, c2: 1 });
    expect(tile.type).toBe('tile');
    const text = new Map((tile.cells as Array<{ row: number; text: string }>).map((cell) => [cell.row, cell.text]));
    expect(Object.fromEntries(text)).toEqual({
      1: '2024-01-15',
      2: '2024-01-15 13:45',
      3: '2024-01-15',
      4: 'Hello World',
      5: 'Codeman',
      6: '#DIV/0!',
      7: '#DIV/0!',
      8: '8',
      9: '9',
      10: '2024-01-15',
      11: '06:30:15',
      12: '2020-01-01 00:05',
    });
    for (const value of text.values()) expect(value).not.toMatch(/object Object|GMT/);
  });
});

describe('spreadsheet preview worker: hidden rows and dense tiles', () => {
  it('skips filtered-out rows and hidden columns at the renderer default viewport', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Filtered');
    for (let row = 1; row <= 1000; row += 1) {
      for (let col = 1; col <= 6; col += 1) sheet.getCell(row, col).value = row * 10 + col;
    }
    sheet.autoFilter = 'A1:F1000';
    for (let row = 2; row <= 981; row += 1) sheet.getRow(row).hidden = true; // 980 rows filtered out
    sheet.getColumn(3).hidden = true;

    const harness = createHarness();
    const metadata = await loadMetadata(harness, await writeWorkbook(workbook));
    const range = defaultViewportRange(harness, metadata.sheets[0]);
    expect(range).toEqual({ r1: 1, c1: 1, r2: 1000, c2: 6 });
    const tile = await requestTile(harness, metadata.sheets[0].id, range);

    expect(tile.type, JSON.stringify(tile)).toBe('tile');
    const cells = tile.cells as Array<{ row: number; col: number }>;
    expect(cells).toHaveLength(20 * 5);
    expect(cells.some((cell) => cell.row >= 2 && cell.row <= 981)).toBe(false);
    expect(cells.some((cell) => cell.col === 3)).toBe(false);
    expect(tile.warnings).toEqual([]);
  });

  it('returns a truncated tile with a warning instead of failing on a dense 60x60 block', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Dense');
    for (let row = 1; row <= 60; row += 1) {
      for (let col = 1; col <= 60; col += 1) sheet.getCell(row, col).value = row * 100 + col;
    }
    const harness = createHarness();
    const metadata = await loadMetadata(harness, await writeWorkbook(workbook));
    const tile = await requestTile(harness, metadata.sheets[0].id, { r1: 1, c1: 1, r2: 60, c2: 60 });

    expect(tile.type, JSON.stringify(tile)).toBe('tile');
    expect(tile.cells).toHaveLength(2500);
    expect(tile.cells[0]).toMatchObject({ row: 1, col: 1, text: '101' });
    expect(tile.warnings).toEqual([expect.stringMatching(/truncated/i)]);
  });
});

type ZipPart = { name: string; data: Uint8Array; method: 0 | 8; size: number; crc: number };

function zipPart(name: string, content: Uint8Array, method: 0 | 8): ZipPart {
  return {
    name,
    data: method === 8 ? fflate.deflateSync(content) : content,
    method,
    size: content.length,
    crc: crc32(content) >>> 0,
  };
}

function localHeader(part: ZipPart): Uint8Array {
  const name = fflate.strToU8(part.name);
  const header = new Uint8Array(30 + name.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(8, part.method, true);
  view.setUint32(14, part.crc, true);
  view.setUint32(18, part.data.length, true);
  view.setUint32(22, part.size, true);
  view.setUint16(26, name.length, true);
  header.set(name, 30);
  return header;
}

function centralHeader(part: ZipPart, offset: number): Uint8Array {
  const name = fflate.strToU8(part.name);
  const header = new Uint8Array(46 + name.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x02014b50, true);
  view.setUint16(4, 20, true);
  view.setUint16(6, 20, true);
  view.setUint16(10, part.method, true);
  view.setUint32(16, part.crc, true);
  view.setUint32(20, part.data.length, true);
  view.setUint32(24, part.size, true);
  view.setUint16(28, name.length, true);
  view.setUint32(42, offset, true);
  header.set(name, 46);
  return header;
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * The reviewer's bypass: a STORED carrier entry whose data is a complete local
 * entry for a huge `sheet1.xml`, followed later by a one-cell decoy `sheet1.xml`.
 * The central directory points `sheet1.xml` INSIDE the carrier, so a local-header
 * walk (admission) meets the decoy while JSZip (ExcelJS) reads the hidden sheet.
 */
async function overlappingEntryWorkbook(hiddenRows = 11_000, hiddenCols = 10): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Data').getCell('A1').value = 'decoy';
  const entries = fflate.unzipSync(new Uint8Array(await workbook.xlsx.writeBuffer()));
  const decoyXml = fflate.strFromU8(entries['xl/worksheets/sheet1.xml']);
  const letters = Array.from({ length: hiddenCols }, (_, index) => String.fromCharCode(65 + index));
  let rows = '';
  for (let row = 1; row <= hiddenRows; row += 1) {
    rows += `<row r="${row}">${letters.map((letter) => `<c r="${letter}${row}"><v>${row}</v></c>`).join('')}</row>`;
  }
  const hiddenXml = decoyXml.replace(/<sheetData>[\s\S]*<\/sheetData>/, `<sheetData>${rows}</sheetData>`);
  expect(hiddenXml).not.toBe(decoyXml);

  const hidden = zipPart('xl/worksheets/sheet1.xml', fflate.strToU8(hiddenXml), 8);
  const carrier = zipPart('docProps/carrier.bin', concatBytes([localHeader(hidden), hidden.data]), 0);
  const decoy = zipPart('xl/worksheets/sheet1.xml', entries['xl/worksheets/sheet1.xml'], 8);
  const others = Object.keys(entries)
    .filter((name) => name !== 'xl/worksheets/sheet1.xml')
    .map((name) => zipPart(name, entries[name], 8));

  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const emit = (part: ZipPart) => {
    const at = offset;
    const chunk = concatBytes([localHeader(part), part.data]);
    locals.push(chunk);
    offset += chunk.length;
    return at;
  };
  for (const part of others) central.push(centralHeader(part, emit(part)));
  const carrierOffset = emit(carrier);
  central.push(centralHeader(carrier, carrierOffset));
  emit(decoy); // streamed by admission, absent from the central directory
  const hiddenOffset = carrierOffset + 30 + fflate.strToU8(carrier.name).length;
  central.push(centralHeader(hidden, hiddenOffset));

  const directory = concatBytes(central);
  const eocd = new Uint8Array(22);
  const view = new DataView(eocd.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, central.length, true);
  view.setUint16(10, central.length, true);
  view.setUint32(12, directory.length, true);
  view.setUint32(16, offset, true);
  return concatBytes([...locals, directory, eocd]);
}

describe('spreadsheet preview worker: ExcelJS sees only what admission checked', () => {
  it('parses the admitted decoy, never a sheet hidden inside an overlapping stored entry', async () => {
    const crafted = await overlappingEntryWorkbook();
    // The unpatched pipeline: JSZip, reading the central directory, finds the hidden sheet.
    const direct = new ExcelJS.Workbook();
    await direct.xlsx.load(toArrayBuffer(crafted));
    expect(direct.worksheets[0].rowCount).toBe(11_000);

    const harness = createHarness();
    const core = harness.self.CodemanSpreadsheetXlsxCore as {
      admitXlsx(bytes: Uint8Array, zip: typeof fflate): { counts: { cells: number } };
    };
    // Admission walks local headers, so it only ever counts the one-cell decoy.
    expect(core.admitXlsx(crafted, fflate).counts.cells).toBe(1);

    await harness.send({ type: 'load', bytes: toArrayBuffer(crafted) });
    const result = harness.messages.at(-1) as Record<string, any>;
    // Either outcome is safe; parsing the 110k hidden cells is not.
    if (result.type === 'metadata') expect(result.sheets[0]).toMatchObject({ rows: 1, cols: 1 });
    else expect(result.type).toBe('error');
  }, 60_000);
});

/** A one-cell ExcelJS workbook whose sheet1.xml gets `xml` spliced in at `where`. */
async function sheetWithInjectedXml(where: 'before-sheetData' | 'after-sheetData', xml: string): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Data').getCell('A1').value = 'one';
  const entries = fflate.unzipSync(new Uint8Array(await workbook.xlsx.writeBuffer()));
  const sheet = fflate.strFromU8(entries['xl/worksheets/sheet1.xml']);
  const patched =
    where === 'before-sheetData'
      ? sheet.replace('<sheetData>', `${xml}<sheetData>`)
      : sheet.replace('</sheetData>', `</sheetData>${xml}`);
  expect(patched).not.toBe(sheet);
  entries['xl/worksheets/sheet1.xml'] = fflate.strToU8(patched);
  return toArrayBuffer(fflate.zipSync(entries));
}

describe('spreadsheet preview worker: admission bounds what ExcelJS expands', () => {
  // ExcelJS creates one cell object per covered cell of a merge, so a single
  // `<mergeCell>` tag over 3M cells took 10 s and a gigabyte of heap.
  it('refuses a merge whose area exceeds the cell caps before ExcelJS loads', async () => {
    const harness = createHarness();
    await harness.send({
      type: 'load',
      bytes: await sheetWithInjectedXml(
        'after-sheetData',
        '<mergeCells count="1"><mergeCell ref="A1:CV30000"/></mergeCells>'
      ),
    });
    expect(harness.messages.at(-1)).toMatchObject({ type: 'error', code: 'cell-limit' });
    expect(harness.imports.some((url) => url.includes('exceljs'))).toBe(false);
  });

  // `Column.fromModel` builds every column up to `<col max>` with no clamp.
  it('refuses a <col> range past column 16384 before ExcelJS loads', async () => {
    const harness = createHarness();
    await harness.send({
      type: 'load',
      bytes: await sheetWithInjectedXml('before-sheetData', '<cols><col min="1" max="3000000" width="9"/></cols>'),
    });
    expect(harness.messages.at(-1)).toMatchObject({ type: 'error', code: 'malformed' });
    expect(harness.imports.some((url) => url.includes('exceljs'))).toBe(false);
  });

  // A whole-column dropdown is a few bytes of XML that ExcelJS expands into one
  // object per address (5 s here; a whole-sheet range was still running after
  // 60 s). The preview never shows validations, so the worker does not parse
  // them, and the file still previews.
  it('previews a sheet with a whole-column data validation without expanding it', async () => {
    const harness = createHarness();
    const metadata = await loadMetadata(
      harness,
      await sheetWithInjectedXml(
        'after-sheetData',
        '<dataValidations count="1"><dataValidation type="list" allowBlank="1" sqref="B2:B1048576">' +
          '<formula1>"a,b"</formula1></dataValidation></dataValidations>'
      )
    );
    expect(harness.peek('Object.keys(workbook.worksheets[0].dataValidations.model).length')).toBe(0);
    expect(metadata.sheets[0]).toMatchObject({ rows: 1, cols: 1 });
    const tile = await requestTile(harness, metadata.sheets[0].id, { r1: 1, c1: 1, r2: 1, c2: 1 });
    expect(tile.cells).toEqual([expect.objectContaining({ row: 1, col: 1, text: 'one' })]);
  }, 30_000);
});

describe('spreadsheet preview worker: quoted attribute values and empty rows', () => {
  // XML allows a raw `>` and the other quote character inside an attribute
  // value. Each of these was admitted before and made ExcelJS build millions of
  // cells or columns.
  it.each([
    [
      'a quoted fake ref before the real merge ref',
      'after-sheetData',
      `<mergeCells count="1"><mergeCell x=' ref="A1"' ref="A1:CV30000"/></mergeCells>`,
      'cell-limit',
    ],
    [
      'a quoted > before the real col max',
      'before-sheetData',
      '<cols><col x=">" min="1" max="3000000"/></cols>',
      'malformed',
    ],
    [
      'a quoted fake max before the real col max',
      'before-sheetData',
      `<cols><col x=' max="1"' min="1" max="3000000"/></cols>`,
      'malformed',
    ],
  ] as const)('refuses %s before ExcelJS loads', async (_label, where, xml, code) => {
    const harness = createHarness();
    await harness.send({ type: 'load', bytes: await sheetWithInjectedXml(where, xml) });
    expect(harness.messages.at(-1)).toMatchObject({ type: 'error', code });
    expect(harness.imports.some((url) => url.includes('exceljs'))).toBe(false);
  });

  // ExcelJS keeps a Row object for every <row>, so cell-less rows cost memory
  // too: three sheets of a million empty rows sat inside every cell cap.
  it('refuses a sheet of empty rows past the row cap before ExcelJS loads', async () => {
    const harness = createHarness();
    const rows = Array.from({ length: 100_001 }, (_, i) => `<row r="${i + 2}"/>`).join('');
    await harness.send({ type: 'load', bytes: await emptyRowsWorkbook(rows) });
    expect(harness.messages.at(-1)).toMatchObject({ type: 'error', code: 'row-limit' });
    expect(harness.imports.some((url) => url.includes('exceljs'))).toBe(false);
  }, 30_000);
});

async function emptyRowsWorkbook(extraRows: string): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Data').getCell('A1').value = 'one';
  const entries = fflate.unzipSync(new Uint8Array(await workbook.xlsx.writeBuffer()));
  const sheet = fflate.strFromU8(entries['xl/worksheets/sheet1.xml']);
  const patched = sheet.replace('</sheetData>', `${extraRows}</sheetData>`);
  expect(patched).not.toBe(sheet);
  entries['xl/worksheets/sheet1.xml'] = fflate.strToU8(patched);
  return toArrayBuffer(fflate.zipSync(entries));
}

/**
 * A one-cell workbook whose sheet carries a merge one cell over the per-sheet
 * cap, stored under `entryName` instead of `xl/worksheets/sheet1.xml`. JSZip
 * (inside ExcelJS) resolves `.`, `..` and empty segments, and ExcelJS strips one
 * leading `/` and matches worksheets with an unanchored pattern, so each of
 * these names still reaches ExcelJS as a worksheet.
 */
async function renamedOversizedSheet(entryName: string, relTarget?: string): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Data').getCell('A1').value = 'one';
  const entries = fflate.unzipSync(new Uint8Array(await workbook.xlsx.writeBuffer()));
  const sheet = fflate.strFromU8(entries['xl/worksheets/sheet1.xml']);
  const patched = sheet.replace(
    '</sheetData>',
    '</sheetData><mergeCells count="1"><mergeCell ref="A1:A100001"/></mergeCells>'
  );
  expect(patched).not.toBe(sheet);
  delete entries['xl/worksheets/sheet1.xml'];
  entries[entryName] = fflate.strToU8(patched);
  if (relTarget) {
    const rels = fflate.strFromU8(entries['xl/_rels/workbook.xml.rels']);
    const retargeted = rels.replace('Target="worksheets/sheet1.xml"', `Target="${relTarget}"`);
    expect(retargeted).not.toBe(rels);
    entries['xl/_rels/workbook.xml.rels'] = fflate.strToU8(retargeted);
  }
  return toArrayBuffer(fflate.zipSync(entries));
}

describe('spreadsheet preview worker: entry names as ExcelJS sees them', () => {
  it.each([
    ['/xl/worksheets/sheet1.xml', undefined],
    ['xl/./worksheets/sheet1.xml', undefined],
    ['xl//worksheets/sheet1.xml', undefined],
    ['xl/xl/worksheets/sheet1.xml', 'xl/worksheets/sheet1.xml'],
    ['xl/worksheets/sheet1.xml.x', 'worksheets/sheet1.xml.x'],
  ] as const)(
    'counts a sheet stored as %s and refuses it before ExcelJS loads',
    async (entryName, relTarget) => {
      const bytes = await renamedOversizedSheet(entryName, relTarget);
      // The fixture is real: unguarded ExcelJS parses this entry as the sheet.
      const direct = new ExcelJS.Workbook();
      await direct.xlsx.load(bytes.slice(0));
      expect(direct.worksheets[0]?.model.merges).toContain('A1:A100001');

      const harness = createHarness();
      await harness.send({ type: 'load', bytes });
      expect(harness.messages.at(-1)).toMatchObject({ type: 'error', code: 'cell-limit' });
      expect(harness.imports.some((url) => url.includes('exceljs'))).toBe(false);
    },
    30_000
  );
});

describe('spreadsheet preview worker: defined names', () => {
  // ExcelJS's DefinedNames model setter creates one object per cell of every
  // range; a whole-sheet name exhausted a 4 GB heap. The preview never shows
  // defined names, so they are not expanded at all.
  it('loads a workbook with a defined name without expanding its range', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Data').getCell('A1').value = 'one';
    workbook.definedNames.add('Data!$A$1:$J$10', 'Block');
    const bytes = await writeWorkbook(workbook);
    expect(fflate.strFromU8(fflate.unzipSync(new Uint8Array(bytes))['xl/workbook.xml'])).toContain('Block');

    const harness = createHarness();
    const metadata = await loadMetadata(harness, bytes);
    expect(metadata.sheets[0]).toMatchObject({ name: 'Data', rows: 1, cols: 1 });
    expect(harness.peek('Object.keys(workbook.definedNames.matrixMap).length')).toBe(0);
  });
});

describe('spreadsheet preview worker: indices a row or sheet claims', () => {
  // ExcelJS stores a row at `_rows[r - 1]`, and eachRow and `sheet.model` walk
  // every index up to the largest, so one far row made each tile cost seconds.
  it('refuses a <row r> past the last Excel row before ExcelJS loads', async () => {
    const rows =
      Array.from({ length: 4 }, (_, i) => `<row r="${i + 2}"><c r="A${i + 2}"><v>${i + 2}</v></c></row>`).join('') +
      '<row r="50000000"><c r="A50000000"><v>6</v></c></row>';
    const bytes = await emptyRowsWorkbook(rows);
    const harness = createHarness();
    await harness.send({ type: 'load', bytes });
    expect(harness.messages.at(-1)).toMatchObject({ type: 'error', code: 'malformed' });
    expect(harness.imports.some((url) => url.includes('exceljs'))).toBe(false);
  }, 60_000);

  // ExcelJS stores a sheet at `_worksheets[sheetId]`; 30,000,000 took 1.6 s
  // and 557 MB on a one-cell workbook.
  it('refuses a sheetId above the cap in xl/workbook.xml before ExcelJS loads', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Data').getCell('A1').value = 'one';
    const entries = fflate.unzipSync(new Uint8Array(await workbook.xlsx.writeBuffer()));
    const book = fflate.strFromU8(entries['xl/workbook.xml']);
    const patched = book.replace('sheetId="1"', 'sheetId="30000000"');
    expect(patched).not.toBe(book);
    entries['xl/workbook.xml'] = fflate.strToU8(patched);
    const harness = createHarness();
    await harness.send({ type: 'load', bytes: toArrayBuffer(fflate.zipSync(entries)) });
    expect(harness.messages.at(-1)).toMatchObject({ type: 'error', code: 'malformed' });
    expect(harness.imports.some((url) => url.includes('exceljs'))).toBe(false);
  }, 60_000);
});

describe('spreadsheet preview worker: tiles reuse the merges read at load', () => {
  // `sheet.model` rebuilds every row and cell model; a tile must not pay that.
  it('serves a tile with its merge without touching sheet.model', async () => {
    const harness = createHarness();
    const metadata = await loadMetadata(harness, await fixture());
    const sheetId = metadata.sheets[0].id;
    harness.peek(
      `Object.defineProperty(sheetsById.get(${JSON.stringify(sheetId)}), 'model', {
        configurable: true,
        get() { throw new Error('sheet.model touched'); },
      })`
    );
    const tile = await requestTile(harness, sheetId, { r1: 4, c1: 2, r2: 4, c2: 3 });
    expect(tile.type, JSON.stringify(tile)).toBe('tile');
    expect(tile.merges).toEqual(['A4:C4']);
    expect(tile.cells).toContainEqual(expect.objectContaining({ row: 4, col: 1, text: 'Merged' }));
  });
});

/** Row and Worksheet prototypes of the ExcelJS build the harness hands the worker. */
function excelJsPrototypes(): { row: Record<string, unknown>; sheet: Record<string, unknown> } {
  const probe = new ExcelJS.Workbook().addWorksheet('probe');
  return { row: Object.getPrototypeOf(probe.getRow(1)), sheet: Object.getPrototypeOf(probe) };
}

/** Make ExcelJS's dense row, cell and model walks throw until the returned restore runs. */
function forbidDenseWalks(): () => void {
  const { row, sheet } = excelJsPrototypes();
  const saved = [
    [sheet, 'eachRow', Object.getOwnPropertyDescriptor(sheet, 'eachRow')],
    [row, 'eachCell', Object.getOwnPropertyDescriptor(row, 'eachCell')],
    [row, 'hasValues', Object.getOwnPropertyDescriptor(row, 'hasValues')],
  ] as const;
  for (const [target, name] of saved) {
    Object.defineProperty(target, name, {
      configurable: true,
      get() {
        throw new Error(`${name} touched`);
      },
    });
  }
  // `sheet.model` rebuilds every row and cell model the same dense way; load
  // still needs its setter, so only reading it throws.
  const model = Object.getOwnPropertyDescriptor(sheet, 'model')!;
  Object.defineProperty(sheet, 'model', {
    configurable: true,
    get() {
      throw new Error('model touched');
    },
    set: model.set,
  });
  return () => {
    for (const [target, name, descriptor] of saved) Object.defineProperty(target, name, descriptor!);
    Object.defineProperty(sheet, 'model', model);
  };
}

describe('spreadsheet preview worker: rows and cells are indexed by their present keys', () => {
  // ExcelJS keeps a row's cells at `_cells[col - 1]`; one far-column cell makes
  // eachCell and hasValues (behind eachRow) visit every index up to 16,384.
  it('loads and serves a tile without ExcelJS eachRow, eachCell, hasValues or sheet.model', async () => {
    const harness = createHarness();
    const bytes = await fixture();
    const restore = forbidDenseWalks();
    try {
      const metadata = await loadMetadata(harness, bytes);
      expect(metadata.sheets[0]).toMatchObject({ rows: 4, cols: 3 });
      expect(metadata.sheets[0].rowOverrides).toContainEqual([2, 40]);
      expect(metadata.sheets[0].merges).toEqual(['A4:C4']);
      const tile = await requestTile(harness, metadata.sheets[0].id, { r1: 1, c1: 1, r2: 4, c2: 3 });
      expect(tile.type, JSON.stringify(tile)).toBe('tile');
      expect(
        (tile.cells as Array<{ row: number; col: number; text: string }>).map(({ row, col, text }) => [row, col, text])
      ).toEqual([
        [1, 1, 'Revenue'],
        [2, 2, '$1,234.50'],
        [3, 3, '$1,234.50'],
        [4, 1, 'Merged'],
      ]);
      expect(tile.merges).toEqual(['A4:C4']);
    } finally {
      restore();
    }
  });

  // eachCell and eachRow skip a cell whose value is Null (a styled empty `<c/>`),
  // and a row holding only such cells; the key walk must skip them the same way.
  it('skips value-less cells and the rows that hold only them, as ExcelJS eachRow/eachCell do', async () => {
    const bytes = await emptyRowsWorkbook(
      '<row r="3" ht="30" customHeight="1"><c r="E3" s="1"/></row><row r="4"><c r="B4" s="1"/><c r="C4"><v>7</v></c></row>'
    );
    const harness = createHarness();
    const metadata = await loadMetadata(harness, bytes);
    // The styled empty cells really exist in ExcelJS, as Null-type cells.
    expect(harness.peek('sheetsById.values().next().value.findCell(3, 5)?.type')).toBe(0);
    expect(harness.peek('sheetsById.values().next().value.findCell(4, 2)?.type')).toBe(0);
    expect(metadata.sheets[0]).toMatchObject({ rows: 4, cols: 3 });
    expect(metadata.sheets[0].rowOverrides).toEqual([]);
    const tile = await requestTile(harness, metadata.sheets[0].id, { r1: 1, c1: 1, r2: 4, c2: 5 });
    expect((tile.cells as Array<{ row: number; col: number }>).map(({ row, col }) => [row, col])).toEqual([
      [1, 1],
      [4, 3],
    ]);
  });

  it('loads and tiles 3,000 rows that each hold one XFD cell', async () => {
    const rows = Array.from(
      { length: 3_000 },
      (_, i) => `<row r="${i + 2}" ht="0.01" customHeight="1"><c r="XFD${i + 2}"><v>${i + 2}</v></c></row>`
    ).join('');
    const bytes = await emptyRowsWorkbook(rows);
    const harness = createHarness();
    const restore = forbidDenseWalks();
    try {
      const started = performance.now();
      const metadata = await loadMetadata(harness, bytes);
      expect(metadata.sheets[0]).toMatchObject({ rows: 3_001, cols: 16_384 });
      expect(metadata.sheets[0].rowOverrides).toHaveLength(3_000);
      const tile = await requestTile(harness, metadata.sheets[0].id, { r1: 1, c1: 16_380, r2: 3_001, c2: 16_384 });
      expect(tile.type, JSON.stringify(tile).slice(0, 200)).toBe('tile');
      expect(tile.cells).toHaveLength(2_500);
      expect(tile.cells[0]).toMatchObject({ row: 2, col: 16_384, text: '2' });
      expect(performance.now() - started).toBeLessThan(5_000);
    } finally {
      restore();
    }
  }, 60_000);
});

/** Deterministic, poorly compressible text, so the ratio cap does not refuse it first. */
function noisyText(length: number, seed = 1): string {
  let state = seed;
  let text = '';
  for (let i = 0; i < length; i += 1) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    text += String.fromCharCode(97 + (state % 26));
  }
  return text;
}

describe('spreadsheet preview worker: cell text reaching the page is bounded', () => {
  // Every tile cell carried its whole string and structured clone copied it
  // once per cell: one 1 MB shared string over a 60 x 20 block froze the page.
  it('caps every tile cell text, shared string, rich text and hyperlink alike', async () => {
    const long = noisyText(200_000);
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Long');
    for (let row = 1; row <= 20; row += 1) {
      for (let col = 1; col <= 10; col += 1) sheet.getCell(row, col).value = long;
    }
    sheet.getCell(21, 1).value = { richText: [{ text: long }, { font: { bold: true }, text: long }] };
    sheet.getCell(21, 2).value = { text: long, hyperlink: 'https://example.invalid/' };
    sheet.getCell(21, 3).value = 'short';
    const bytes = await writeWorkbook(workbook);
    const entries = fflate.unzipSync(new Uint8Array(bytes));
    // One shared string (index 0), referenced by every cell of the block.
    expect(fflate.strFromU8(entries['xl/sharedStrings.xml'])).toContain(`<si><t>${long}</t></si>`);
    expect(
      fflate.strFromU8(entries['xl/worksheets/sheet1.xml']).match(/t="s"><v>0<\/v>/g)?.length
    ).toBeGreaterThanOrEqual(200);

    const harness = createHarness();
    const metadata = await loadMetadata(harness, bytes);
    const tile = await requestTile(harness, metadata.sheets[0].id, { r1: 1, c1: 1, r2: 21, c2: 10 });
    expect(tile.type).toBe('tile');
    const cells = tile.cells as Array<{ row: number; col: number; text: string }>;
    expect(cells).toHaveLength(203);
    for (const cell of cells) expect(cell.text.length, `${cell.row}:${cell.col}`).toBeLessThanOrEqual(1000);
    expect(cells.find((cell) => cell.row === 1 && cell.col === 1)?.text).toBe(`${long.slice(0, 999)}…`);
    expect(cells.find((cell) => cell.row === 21 && cell.col === 1)?.text.length).toBe(1000);
    expect(cells.find((cell) => cell.row === 21 && cell.col === 2)?.text.length).toBe(1000);
    expect(cells.find((cell) => cell.row === 21 && cell.col === 3)?.text).toBe('short');
  }, 60_000);
});

/** A workbook of `sheets` one-cell sheets, each carrying `mergesPerSheet` one-row merges. */
async function mergeHeavyWorkbook(sheets: number, mergesPerSheet: number): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  for (let i = 1; i <= sheets; i += 1) workbook.addWorksheet(`S${i}`).getCell('A1').value = 'one';
  const entries = fflate.unzipSync(new Uint8Array(await workbook.xlsx.writeBuffer()));
  const merges = Array.from({ length: mergesPerSheet }, (_, i) => `<mergeCell ref="A${i + 2}:B${i + 2}"/>`).join('');
  for (let i = 1; i <= sheets; i += 1) {
    const name = `xl/worksheets/sheet${i}.xml`;
    const sheet = fflate.strFromU8(entries[name]);
    const patched = sheet.replace(
      '</sheetData>',
      `</sheetData><mergeCells count="${mergesPerSheet}">${merges}</mergeCells>`
    );
    expect(patched).not.toBe(sheet);
    entries[name] = fflate.strToU8(patched);
  }
  return toArrayBuffer(fflate.zipSync(entries));
}

describe('spreadsheet preview worker: merges are bounded per sheet and workbook-wide', () => {
  // ExcelJS checks each new merge against every earlier one on its sheet, so
  // a sheet's load cost grows with the square of its merge count.
  it('refuses one sheet over the per-sheet merge cap before ExcelJS loads', async () => {
    const harness = createHarness();
    await harness.send({ type: 'load', bytes: await mergeHeavyWorkbook(1, 2_001) });
    expect(harness.messages.at(-1)).toMatchObject({ type: 'error', code: 'merge-limit' });
    expect(harness.imports.some((url) => url.includes('exceljs'))).toBe(false);
  }, 60_000);

  it('refuses sheets each under the per-sheet cap once the workbook total passes 10,000', async () => {
    const harness = createHarness();
    await harness.send({ type: 'load', bytes: await mergeHeavyWorkbook(6, 2_000) });
    expect(harness.messages.at(-1)).toMatchObject({ type: 'error', code: 'merge-limit' });
    expect(harness.imports.some((url) => url.includes('exceljs'))).toBe(false);
  }, 60_000);

  it('still previews a sheet at the per-sheet merge cap', async () => {
    const harness = createHarness();
    const metadata = await loadMetadata(harness, await mergeHeavyWorkbook(1, 2_000));
    expect(metadata.sheets[0].merges).toHaveLength(2_000);
  }, 60_000);
});

/** A one-cell numeric workbook whose styles.xml declares `formatCode` for the cell. */
async function numberFormatWorkbook(formatCode: string): Promise<ArrayBuffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Data');
  sheet.getCell('A1').value = 1.5;
  sheet.getCell('A1').numFmt = '0.000';
  const entries = fflate.unzipSync(new Uint8Array(await workbook.xlsx.writeBuffer()));
  const styles = fflate.strFromU8(entries['xl/styles.xml']);
  const patched = styles.replace('formatCode="0.000"', `formatCode="${formatCode}"`);
  expect(patched).not.toBe(styles);
  entries['xl/styles.xml'] = fflate.strToU8(patched);
  return toArrayBuffer(fflate.zipSync(entries));
}

describe('spreadsheet preview worker: number formats ExcelJS would rescan', () => {
  // `isDateFmt` runs `/\[[^\]]*]/g` per numeric cell; a 60,000-character code of
  // `[` cost 2.2 s a cell, and the code is echoed into the notice bar.
  it.each([
    ['an unclosed [', `0${'['.repeat(200)}`],
    ['a code over 255 characters', `${'0'.repeat(300)}.00`],
  ])(
    'refuses %s before ExcelJS loads',
    async (_label, code) => {
      const harness = createHarness();
      await harness.send({ type: 'load', bytes: await numberFormatWorkbook(code) });
      expect(harness.messages.at(-1)).toMatchObject({ type: 'error', code: 'number-format' });
      expect(harness.imports.some((url) => url.includes('exceljs'))).toBe(false);
    },
    60_000
  );

  it('previews a closed bracketed format and keeps its warning bounded', async () => {
    const code = `[Red]${'0'.repeat(200)}`;
    const harness = createHarness();
    const metadata = await loadMetadata(harness, await numberFormatWorkbook(code));
    const tile = await requestTile(harness, metadata.sheets[0].id, { r1: 1, c1: 1, r2: 1, c2: 1 });
    expect(tile.cells).toEqual([expect.objectContaining({ row: 1, col: 1, text: '1.5' })]);
    expect(tile.warnings).toEqual([`Unsupported number format: ${code}`]);
  }, 60_000);
});

describe('spreadsheet preview worker: the notice bar stays bounded', () => {
  // Each distinct unsupported code was its own notice entry; a 40 x 20 sheet
  // with a code per cell grew the bar to thousands of pixels.
  it('folds many distinct unsupported number formats in one tile into one counted warning', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Formats');
    for (let row = 1; row <= 40; row += 1) {
      for (let col = 1; col <= 20; col += 1) {
        const cell = sheet.getCell(row, col);
        cell.value = row * col + 0.5;
        cell.numFmt = `"c${row}-${col}"0.00E+00`;
      }
    }
    const harness = createHarness();
    const metadata = await loadMetadata(harness, await writeWorkbook(workbook));
    const tile = await requestTile(harness, metadata.sheets[0].id, { r1: 1, c1: 1, r2: 40, c2: 20 });
    expect(tile.type, JSON.stringify(tile).slice(0, 200)).toBe('tile');
    expect(tile.cells).toHaveLength(800);
    expect(tile.warnings).toEqual(['800 unsupported number formats']);
  }, 60_000);
});
