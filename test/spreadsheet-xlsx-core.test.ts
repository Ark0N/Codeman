/** @fileoverview XLSX admission, formatting, and sparse geometry contracts. */

import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as fflate from 'fflate';

type Core = {
  LIMITS: Record<string, number>;
  XlsxPreviewError: new (code: string, message: string) => Error & { code: string };
  inspectZipDirectory(bytes: Uint8Array, limits?: Record<string, number>): { entries: Array<{ name: string }> };
  admitXlsx(bytes: Uint8Array, zip: typeof fflate, limits?: Record<string, number>): unknown;
  createXmlCounter(
    name: string,
    counts: { cells: number; merges: number; styles: number },
    limits: Record<string, number>
  ): { push(chunk: Uint8Array, final: boolean): void };
  buildAdmittedArchive(admission: unknown, zip: typeof fflate): Uint8Array;
  excelJsEntryName(name: string): string;
  parseCellRef(ref: string): { row: number; col: number } | null;
  deriveExtent(cells: string[], merges: string[]): { rows: number; cols: number };
  createSparseAxis(count: number, defaultSize: number, overrides: Array<[number, number]>): unknown;
  axisOffset(axis: unknown, index: number): number;
  axisIndexAt(axis: unknown, offset: number): number;
  computeViewport(axis: unknown, offset: number, viewportSize: number, overscan?: number): [number, number];
  intersectingMerges(merges: string[], range: { r1: number; c1: number; r2: number; c2: number }): string[];
  formatCellValue(value: unknown, format: string, date1904?: boolean): { text: string; warning?: string };
  DEFAULT_THEME_PALETTE: string[];
  INDEXED_PALETTE: string[];
  parseThemePalette(xml?: string): string[];
  resolveColor(color: unknown, palette?: string[]): string | undefined;
  contrastRatio(a: string, b: string): number;
  ensureContrast(foreground: string, background: string, minRatio?: number): string;
  resolveCellColors(
    fillColor: unknown,
    fontColor: unknown,
    palette?: string[]
  ): { background?: string; foreground?: string };
};

const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/spreadsheet-xlsx-core.js'), 'utf8');
const context = vm.createContext({ Uint8Array, DataView, TextDecoder, Date, Math, Number, String, Object, Map, Set });
vm.runInContext(source, context);
const core = (context as unknown as { CodemanSpreadsheetXlsxCore: Core }).CodemanSpreadsheetXlsxCore;

const workbookZip = (sheet = '<worksheet><sheetData><row><c r="A1"/></row></sheetData><mergeCells/></worksheet>') =>
  fflate.zipSync({
    '[Content_Types].xml': fflate.strToU8('<Types/>'),
    'xl/workbook.xml': fflate.strToU8('<workbook><sheets><sheet name="Sheet1"/></sheets></workbook>'),
    'xl/styles.xml': fflate.strToU8('<styleSheet><cellXfs count="1"><xf/></cellXfs></styleSheet>'),
    'xl/worksheets/sheet1.xml': fflate.strToU8(sheet),
  });

describe('spreadsheet XLSX core', () => {
  it('rejects encrypted OLE files, malformed ZIPs, and ZIP64 sentinels', () => {
    expect(() => core.inspectZipDirectory(Uint8Array.from([0xd0, 0xcf, 0x11, 0xe0]))).toThrowError(/encrypted/i);
    expect(() => core.inspectZipDirectory(Uint8Array.from([1, 2, 3]))).toThrowError(/malformed/i);

    const zip = workbookZip();
    const eocd = zip.length - 22;
    zip[eocd + 10] = 0xff;
    zip[eocd + 11] = 0xff;
    expect(() => core.inspectZipDirectory(zip)).toThrowError(/ZIP64/i);
  });

  it('rejects divergent local-header and central-directory entry names', () => {
    const zip = workbookZip();
    const localNameLength = new DataView(zip.buffer, zip.byteOffset, zip.byteLength).getUint16(26, true);
    expect(localNameLength).toBeGreaterThan(0);
    zip[30] = zip[30] === 120 ? 121 : 120;
    expect(() => core.inspectZipDirectory(zip)).toThrowError(/names do not match/i);
  });

  it('rejects central-directory entries that were not streamed through admission', () => {
    class IncompleteUnzip {
      constructor(private readonly onFile: (file: any) => void) {}
      register() {}
      push(_bytes: Uint8Array, final: boolean) {
        if (!final) return;
        const file: Record<string, any> = {
          name: '[Content_Types].xml',
          start: () => file.ondata(null, new Uint8Array(), true),
        };
        this.onFile(file);
      }
    }
    const incomplete = { Unzip: IncompleteUnzip, UnzipInflate: class {} } as unknown as typeof fflate;
    expect(() => core.admitXlsx(workbookZip(), incomplete)).toThrowError(/not streamed/i);
  });

  it('uses actual streamed output for entry, total, ratio, and XML-count limits', () => {
    const inflated = 'x'.repeat(20_000);
    const bomb = fflate.zipSync({ 'xl/worksheets/sheet1.xml': fflate.strToU8(inflated) }, { level: 9 });
    expect(() => core.admitXlsx(bomb, fflate, { maxEntryBytes: 10_000 })).toThrowError(/entry/i);
    expect(() => core.admitXlsx(bomb, fflate, { maxInflatedBytes: 10_000 })).toThrowError(/inflated/i);
    expect(() => core.admitXlsx(bomb, fflate, { maxCompressionRatio: 2 })).toThrowError(/compression ratio/i);

    const cells = '<worksheet><sheetData>' + '<c r="A1"/>'.repeat(4) + '</sheetData></worksheet>';
    expect(() => core.admitXlsx(workbookZip(cells), fflate, { maxCellsPerSheet: 3 })).toThrowError(/cells/i);
    expect(() => core.admitXlsx(workbookZip(), fflate, { maxEntries: 2 })).toThrowError(/entries/i);
  });

  it('detects OOXML feature parts and counts worksheets, merges, styles, and cells', () => {
    const zip = fflate.zipSync({
      ...fflate.unzipSync(
        workbookZip('<worksheet><sheetData><c r="A1"/></sheetData><mergeCell ref="A1:B2"/></worksheet>')
      ),
      'xl/charts/chart1.xml': fflate.strToU8('<chart/>'),
      'xl/externalLinks/externalLink1.xml': fflate.strToU8('<externalLink/>'),
    });
    const result = core.admitXlsx(zip, fflate) as {
      counts: { worksheets: number; cells: number; merges: number; styles: number };
      features: string[];
    };
    // The 2x2 merge costs its four covered cells on top of the one real cell.
    expect(result.counts).toEqual({ worksheets: 1, cells: 5, rows: 0, merges: 1, styles: 1 });
    expect(result.features).toEqual(expect.arrayContaining(['charts', 'externalLinks']));
  });

  it('rebuilds a STORE-only archive from exactly the entries admission inflated', () => {
    const zip = workbookZip();
    const admission = core.admitXlsx(zip, fflate) as { entries: Record<string, Uint8Array>; inflatedBytes: number };
    expect(Object.keys(admission.entries).sort()).toEqual(Object.keys(fflate.unzipSync(zip)).sort());
    const rebuilt = core.buildAdmittedArchive(admission, fflate);
    const directory = core.inspectZipDirectory(rebuilt).entries as Array<{
      name: string;
      compressedSize: number;
      declaredSize: number;
    }>;
    for (const entry of directory) expect(entry.compressedSize).toBe(entry.declaredSize);
    const roundTrip = fflate.unzipSync(rebuilt);
    for (const [name, data] of Object.entries(admission.entries)) expect(roundTrip[name]).toEqual(data);
  });

  it('refuses a local entry name streamed twice, since the rebuilt archive could hold only one', () => {
    const zip = workbookZip();
    class DuplicateUnzip {
      constructor(private readonly onFile: (file: any) => void) {}
      register() {}
      push(_bytes: Uint8Array, final: boolean) {
        if (!final) return;
        for (let i = 0; i < 2; i += 1) {
          const file: Record<string, any> = {
            name: 'xl/workbook.xml',
            start: () => file.ondata(null, new Uint8Array(1), true),
          };
          this.onFile(file);
        }
      }
    }
    const duplicate = { Unzip: DuplicateUnzip, UnzipInflate: class {} } as unknown as typeof fflate;
    expect(() => core.admitXlsx(zip, duplicate)).toThrowError(/duplicate/i);
  });

  it('names every entry the way JSZip and ExcelJS will see it', () => {
    expect(core.excelJsEntryName('xl/worksheets/sheet1.xml')).toBe('xl/worksheets/sheet1.xml');
    expect(core.excelJsEntryName('/xl/worksheets/sheet1.xml')).toBe('xl/worksheets/sheet1.xml');
    expect(core.excelJsEntryName('xl/./worksheets/sheet1.xml')).toBe('xl/worksheets/sheet1.xml');
    expect(core.excelJsEntryName('xl//worksheets/sheet1.xml')).toBe('xl/worksheets/sheet1.xml');
    expect(core.excelJsEntryName('xl/foo/../worksheets/sheet1.xml')).toBe('xl/worksheets/sheet1.xml');
    expect(core.excelJsEntryName('../xl/styles.xml')).toBe('xl/styles.xml');
    expect(core.excelJsEntryName('//xl/styles.xml')).toBe('xl/styles.xml');
    expect(core.excelJsEntryName('xl/media/')).toBe('xl/media/');
  });

  it('refuses two entries that resolve to the same name', () => {
    const entries = fflate.unzipSync(workbookZip());
    const big = '<worksheet><sheetData>' + '<c r="A1"/>'.repeat(4) + '</sheetData></worksheet>';
    for (const twin of ['/xl/worksheets/sheet1.xml', 'xl/./worksheets/sheet1.xml', 'xl/x/../worksheets/sheet1.xml']) {
      const zip = fflate.zipSync({ ...entries, [twin]: fflate.strToU8(big) });
      expect(() => core.admitXlsx(zip, fflate), twin).toThrowError(/same name/i);
    }
  });

  it('counts and rebuilds entries under the names ExcelJS will see', () => {
    const cells = '<worksheet><sheetData>' + '<c r="A1"/>'.repeat(4) + '</sheetData></worksheet>';
    const renamed = (name: string) => {
      const entries = fflate.unzipSync(workbookZip(cells));
      const sheet = entries['xl/worksheets/sheet1.xml'];
      delete entries['xl/worksheets/sheet1.xml'];
      return fflate.zipSync({ ...entries, [name]: sheet });
    };
    for (const name of ['/xl/worksheets/sheet1.xml', 'xl/./worksheets/sheet1.xml', 'a/xl/worksheets/sheet2.xml.x']) {
      expect(() => core.admitXlsx(renamed(name), fflate, { maxCellsPerSheet: 3 }), name).toThrowError(/cells/i);
      expect(() => core.admitXlsx(renamed(name), fflate, { maxWorksheets: 0 }), name).toThrowError(/worksheet/i);
    }
    const admission = core.admitXlsx(renamed('/xl/./worksheets/sheet1.xml'), fflate) as {
      entries: Record<string, Uint8Array>;
    };
    expect(Object.keys(admission.entries)).toContain('xl/worksheets/sheet1.xml');
    expect(Object.keys(fflate.unzipSync(core.buildAdmittedArchive(admission, fflate)))).toContain(
      'xl/worksheets/sheet1.xml'
    );

    // `/xl/styles.xml` is ExcelJS's `xl/styles.xml`, so its <xf> tags count.
    const styles = fflate.unzipSync(workbookZip());
    const xf = styles['xl/styles.xml'];
    delete styles['xl/styles.xml'];
    const leading = fflate.zipSync({ ...styles, '/xl/styles.xml': xf });
    expect(() => core.admitXlsx(leading, fflate, { maxStyles: 0 })).toThrowError(/styles limit/i);
  });

  it('charges a merged range its full area and refuses one that does not parse', () => {
    const merged = (ref: string) =>
      workbookZip(
        `<worksheet><sheetData><row><c r="A1"/></row></sheetData><mergeCells><mergeCell ref="${ref}"/></mergeCells></worksheet>`
      );
    expect(() => core.admitXlsx(merged('A1:CV30000'), fflate)).toThrowError(/cells limit/i);
    // Reversed corners describe the same area.
    expect(() => core.admitXlsx(merged('CV30000:A1'), fflate)).toThrowError(/cells limit/i);
    expect(() => core.admitXlsx(merged('A1:XFE2'), fflate)).toThrowError(/merged range/i);
    expect(() => core.admitXlsx(merged('not-a-range'), fflate)).toThrowError(/merged range/i);
    const admitted = core.admitXlsx(merged('A1:J10'), fflate) as { counts: { cells: number } };
    expect(admitted.counts.cells).toBe(101);
  });

  it('refuses a <col> whose min or max is past the last Excel column', () => {
    const cols = (attrs: string) =>
      workbookZip(
        `<worksheet><cols><col ${attrs} width="9"/></cols><sheetData><row><c r="A1"/></row></sheetData></worksheet>`
      );
    expect(() => core.admitXlsx(cols('min="1" max="3000000"'), fflate)).toThrowError(/column max/i);
    expect(() => core.admitXlsx(cols('min="16385" max="16385"'), fflate)).toThrowError(/column min/i);
    expect(() => core.admitXlsx(cols('min="1" max="1e9"'), fflate)).toThrowError(/column max/i);
    expect(() => core.admitXlsx(cols('min="1" max="16384"'), fflate)).not.toThrow();
  });

  it('reads a merge or col tag whole even when a stream chunk boundary cuts through it', () => {
    // Markup on both sides, so a cut can land 128+ bytes past the tag's start.
    const pad = '<sheetView workbookViewId="0"/>'.repeat(12);
    const cases: Array<[string, RegExp]> = [
      [`<worksheet>${pad}<cols><col min="1" max="99999"/></cols>${pad}</worksheet>`, /column max/i],
      [`<worksheet>${pad}<cols><col x=">" min="1" max="99999"/></cols>${pad}</worksheet>`, /column max/i],
      [`<worksheet>${pad}<mergeCells><mergeCell ref="A1:CV30000"/></mergeCells>${pad}</worksheet>`, /cells limit/i],
    ];
    for (const [xml, pattern] of cases) {
      const bytes = fflate.strToU8(xml);
      for (let cut = 1; cut < bytes.length; cut += 1) {
        const counter = core.createXmlCounter(
          'xl/worksheets/sheet1.xml',
          { cells: 0, merges: 0, styles: 0 },
          core.LIMITS
        );
        expect(() => {
          counter.push(bytes.subarray(0, cut), false);
          counter.push(bytes.subarray(cut), true);
        }, `cut at ${cut}`).toThrowError(pattern);
      }
    }
  });

  it('reads attributes in order, so a quoted value cannot hide or fake one', () => {
    const counter = () =>
      core.createXmlCounter(
        'xl/worksheets/sheet1.xml',
        { cells: 0, merges: 0, styles: 0, rows: 0 } as never,
        core.LIMITS
      );
    const push = (xml: string) => counter().push(fflate.strToU8(xml), true);
    // A raw `>` or the other quote character is legal inside a value.
    expect(() => push(`<mergeCell x=' ref="A1"' ref="A1:CV30000"/>`)).toThrowError(/cells limit/i);
    expect(() => push('<col x=">" min="1" max="3000000"/>')).toThrowError(/column max/i);
    expect(() => push(`<col x=' max="1"' min="1" max="3000000"/>`)).toThrowError(/column max/i);
    // Anything the walk cannot read up to `>` is refused, as is a repeated name.
    expect(() => push('<mergeCell ref="A1:B2" junk/>')).toThrowError(/do not parse/i);
    expect(() => push('<mergeCell ref="A1" ref="A1:CV30000"/>')).toThrowError(/do not parse/i);
    expect(() => push('<cols><col min="1" max="3" width="9"></col></cols><mergeCell ref="A1:B2" />')).not.toThrow();
  });

  it('counts every <row>, empty or not, against per-sheet and total caps', () => {
    const rows = (n: number) => '<worksheet><sheetData>' + '<row r="1"/>'.repeat(n) + '</sheetData></worksheet>';
    expect(() => core.admitXlsx(workbookZip(rows(4)), fflate, { maxRowsPerSheet: 3 })).toThrowError(/rows limit/i);
    expect(() => core.admitXlsx(workbookZip(rows(4)), fflate, { maxRows: 3 })).toThrowError(/rows limit/i);
    const admitted = core.admitXlsx(workbookZip(rows(3)), fflate, { maxRowsPerSheet: 3 }) as {
      counts: { rows: number };
    };
    expect(admitted.counts.rows).toBe(3);
    // <rowBreaks>/<rows...> style names are not rows.
    expect(
      (core.admitXlsx(workbookZip('<worksheet><rowBreaks/></worksheet>'), fflate) as { counts: { rows: number } })
        .counts.rows
    ).toBe(0);
  });

  it('counts every <xf> in styles.xml, so a </cellXfs> inside a comment cannot hide styles', () => {
    const counts = { cells: 0, merges: 0, styles: 0, rows: 0 };
    const counter = core.createXmlCounter('xl/styles.xml', counts as never, { ...core.LIMITS, maxStyles: 100 });
    const xml = '<styleSheet><cellXfs><!-- </cellXfs> -->' + '<xf/>'.repeat(200) + '</cellXfs></styleSheet>';
    expect(() => counter.push(fflate.strToU8(xml), true)).toThrowError(/styles limit/i);
  });

  it('refuses an entry whose declared compressed size runs past the file', () => {
    const zip = workbookZip();
    const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
    const eocd = zip.length - 22;
    const centralStart = view.getUint32(eocd + 16, true);
    view.setUint32(centralStart + 20, 0x7fffffff, true);
    expect(() => core.inspectZipDirectory(zip)).toThrowError(/compressed bytes/i);
  });

  it('derives bounded extents from real cells and merges', () => {
    expect(core.parseCellRef('XFD1048576')).toEqual({ row: 1_048_576, col: 16_384 });
    expect(core.parseCellRef('XFE1')).toBeNull();
    expect(core.deriveExtent(['B3'], ['D5:F9'])).toEqual({ rows: 9, cols: 6 });
  });

  it('maps sparse axes and virtual viewports without dense allocation', () => {
    const axis = core.createSparseAxis(1_000_000, 20, [
      [2, 0],
      [10, 40],
    ]);
    expect(core.axisOffset(axis, 3)).toBe(20);
    expect(core.axisIndexAt(axis, 20)).toBe(3);
    const [start, end] = core.computeViewport(axis, 199, 60, 1);
    expect(start).toBeLessThanOrEqual(9);
    expect(end - start).toBeLessThan(10);
  });

  it('matches a plain walk over the overrides at every index', () => {
    const overrides: Array<[number, number]> = [];
    for (let index = 3; index <= 400; index += 7) overrides.push([index, (index * 13) % 50]);
    const axis = core.createSparseAxis(500, 20, overrides);
    for (let index = 0; index <= 502; index += 1) {
      const bounded = Math.max(1, Math.min(501, index));
      let expected = (bounded - 1) * 20;
      for (const [at, size] of overrides) if (at < bounded) expected += size - 20;
      expect(core.axisOffset(axis, index), `index ${index}`).toBe(expected);
    }
  });

  it('returns intersecting merges even when their anchor is offscreen', () => {
    expect(core.intersectingMerges(['A1:D4', 'Z1:Z2'], { r1: 3, c1: 3, r2: 6, c2: 6 })).toEqual(['A1:D4']);
  });

  it('formats common values and safely flags unknown formats', () => {
    expect(core.formatCellValue(0.125, '0.0%').text).toBe('12.5%');
    expect(core.formatCellValue(1234.5, '#,##0.00').text).toBe('1,234.50');
    expect(core.formatCellValue(10, '$#,##0.00').text).toBe('$10.00');
    expect(core.formatCellValue(1, 'yyyy-mm-dd').text).toBe('1900-01-01');
    expect(core.formatCellValue(0, 'yyyy-mm-dd', true).text).toBe('1904-01-01');
    expect(core.formatCellValue(0.5, 'hh:mm:ss').text).toBe('12:00:00');
    expect(core.formatCellValue(1.5, 'yyyy-mm-dd hh:mm').text).toBe('1900-01-01 12:00');
    expect(core.formatCellValue(7, '[Red][<0]0.0')).toMatchObject({ text: '7', warning: expect.any(String) });
    expect(core.formatCellValue({ formula: 'SUM(A1:A2)' }, 'General')).toMatchObject({ text: '=SUM(A1:A2)' });
  });
});

const themeXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Custom"><a:themeElements>
<a:clrScheme name="Custom">
<a:dk1><a:sysClr val="windowText" lastClr="102030"/></a:dk1>
<a:lt1><a:sysClr val="window" lastClr="F0F1F2"/></a:lt1>
<a:dk2><a:srgbClr val="203040"/></a:dk2>
<a:lt2><a:srgbClr val="E0E1E2"/></a:lt2>
<a:accent1><a:srgbClr val="FF0000"/></a:accent1>
<a:accent2><a:srgbClr val="00FF00"/></a:accent2>
<a:accent3><a:srgbClr val="0000FF"/></a:accent3>
<a:accent4><a:srgbClr val="010203"/></a:accent4>
<a:accent5><a:srgbClr val="040506"/></a:accent5>
<a:accent6><a:srgbClr val="070809"/></a:accent6>
<a:hlink><a:srgbClr val="123456"/></a:hlink>
<a:folHlink><a:srgbClr val="654321"/></a:folHlink>
</a:clrScheme></a:themeElements></a:theme>`;

describe('spreadsheet XLSX colour resolution', () => {
  it('parses a theme palette into styles.xml index order, swapping lt/dk against clrScheme order', () => {
    const palette = core.parseThemePalette(themeXml);
    expect(palette).toHaveLength(12);
    // styles.xml order is lt1, dk1, lt2, dk2 while clrScheme lists dk1, lt1, dk2, lt2.
    expect(palette[0]).toBe('#f0f1f2');
    expect(palette[1]).toBe('#102030');
    expect(palette[2]).toBe('#e0e1e2');
    expect(palette[3]).toBe('#203040');
    expect(palette.slice(4)).toEqual([
      '#ff0000',
      '#00ff00',
      '#0000ff',
      '#010203',
      '#040506',
      '#070809',
      '#123456',
      '#654321',
    ]);
    expect(core.resolveColor({ theme: 0 }, palette)).toBe('#f0f1f2');
    expect(core.resolveColor({ theme: 1 }, palette)).toBe('#102030');
    expect(core.resolveColor({ theme: 12 }, palette)).toBeUndefined();
  });

  it('reads sysClr entries from lastClr and srgbClr entries from val', () => {
    const sysOnly = core.parseThemePalette(
      themeXml.replace('<a:srgbClr val="203040"/>', '<a:sysClr val="windowText" lastClr="ABCDEF"/>')
    );
    expect(sysOnly[3]).toBe('#abcdef');
    // A sysClr with no lastClr is unusable and must not poison the whole palette.
    const missing = core.parseThemePalette(
      themeXml.replace('<a:sysClr val="window" lastClr="F0F1F2"/>', '<a:sysClr val="window"/>')
    );
    expect(missing[0]).toBe(core.DEFAULT_THEME_PALETTE[0]);
    expect(missing[1]).toBe('#102030');
  });

  it('applies Excel tint to HSL luminance in both directions', () => {
    const palette = core.parseThemePalette(themeXml);
    expect(core.resolveColor({ theme: 4, tint: 0.5 }, palette)).toBe('#ff8080');
    expect(core.resolveColor({ theme: 4, tint: -0.5 }, palette)).toBe('#800000');
    expect(core.resolveColor({ theme: 4, tint: 0 }, palette)).toBe('#ff0000');
    expect(core.resolveColor({ theme: 4, tint: 1 }, palette)).toBe('#ffffff');
    expect(core.resolveColor({ theme: 4, tint: -1 }, palette)).toBe('#000000');
  });

  it('falls back to the default Office palette when theme XML is missing or unparseable', () => {
    expect(core.DEFAULT_THEME_PALETTE).toHaveLength(12);
    expect(core.DEFAULT_THEME_PALETTE[0]).toBe('#ffffff');
    expect(core.DEFAULT_THEME_PALETTE[1]).toBe('#000000');
    expect(core.DEFAULT_THEME_PALETTE[2]).toBe('#eeece1');
    expect(core.DEFAULT_THEME_PALETTE[3]).toBe('#1f497d');
    expect(core.DEFAULT_THEME_PALETTE[4]).toBe('#4f81bd');
    expect(core.DEFAULT_THEME_PALETTE[11]).toBe('#800080');
    expect(core.parseThemePalette('')).toEqual(core.DEFAULT_THEME_PALETTE);
    expect(core.parseThemePalette(undefined)).toEqual(core.DEFAULT_THEME_PALETTE);
    expect(core.parseThemePalette('<html>not a theme</html>')).toEqual(core.DEFAULT_THEME_PALETTE);
    expect(core.resolveColor({ theme: 1 })).toBe('#000000');
    expect(core.resolveColor({ theme: 0 })).toBe('#ffffff');
  });

  it('resolves legacy indexed palette entries and ignores the auto sentinels', () => {
    expect(core.INDEXED_PALETTE).toHaveLength(64);
    expect(core.resolveColor({ indexed: 0 })).toBe('#000000');
    expect(core.resolveColor({ indexed: 9 })).toBe('#ffffff');
    expect(core.resolveColor({ indexed: 13 })).toBe('#ffff00');
    expect(core.resolveColor({ indexed: 22 })).toBe('#c0c0c0');
    expect(core.resolveColor({ indexed: 63 })).toBe('#333333');
    expect(core.resolveColor({ indexed: 64 })).toBeUndefined();
    expect(core.resolveColor({ indexed: 65 })).toBeUndefined();
    expect(core.resolveColor({ argb: 'FF1F497D' })).toBe('#1f497d');
    expect(core.resolveColor({ argb: 'nope' })).toBeUndefined();
    expect(core.resolveColor(undefined)).toBeUndefined();
  });

  it('computes WCAG contrast ratios and overrides with the correct polarity', () => {
    expect(core.contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(core.contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(core.contrastRatio('#ffff00', '#ffffff')).toBeLessThan(4.5);
    // White on yellow is unreadable -> black wins.
    expect(core.ensureContrast('#ffffff', '#ffff00')).toBe('#000000');
    // Near-black on black -> white wins.
    expect(core.ensureContrast('#11111b', '#1a1a2e')).toBe('#ffffff');
    // Already-legible pairs are preserved verbatim.
    expect(core.ensureContrast('#1f497d', '#ffffff')).toBe('#1f497d');
  });

  it('pins an implicit white sheet background for a dark font with no resolvable fill', () => {
    expect(core.resolveCellColors(undefined, { argb: 'FF000000' })).toEqual({
      background: '#ffffff',
      foreground: '#000000',
    });
    expect(core.resolveCellColors({ indexed: 64 }, { theme: 1 })).toEqual({
      background: '#ffffff',
      foreground: '#000000',
    });
  });

  it('pins black text when a fill resolves but the font colour does not', () => {
    expect(core.resolveCellColors({ theme: 0 }, undefined)).toEqual({
      background: '#ffffff',
      foreground: '#000000',
    });
    expect(core.resolveCellColors({ argb: 'FFFFF8E7' }, undefined)).toEqual({
      background: '#fff8e7',
      foreground: '#000000',
    });
  });

  it('overrides light-on-light and dark-on-dark pairs while keeping legible authored pairs', () => {
    expect(core.resolveCellColors({ indexed: 13 }, { indexed: 9 })).toEqual({
      background: '#ffff00',
      foreground: '#000000',
    });
    expect(core.resolveCellColors({ argb: 'FFFFFFFF' }, { argb: 'FFF5F5F5' })).toEqual({
      background: '#ffffff',
      foreground: '#000000',
    });
    expect(core.resolveCellColors({ argb: 'FF1A1A2E' }, { argb: 'FF11111B' })).toEqual({
      background: '#1a1a2e',
      foreground: '#ffffff',
    });
    expect(core.resolveCellColors({ argb: 'FFFFFFFF' }, { argb: 'FF1F497D' })).toEqual({
      background: '#ffffff',
      foreground: '#1f497d',
    });
  });

  it('keeps theme fills and theme fonts instead of dropping them', () => {
    const palette = core.parseThemePalette(themeXml);
    expect(core.resolveCellColors({ theme: 4, tint: 0.6 }, { theme: 1 }, palette)).toEqual({
      background: '#ff9999',
      foreground: '#102030',
    });
  });

  it('emits neither colour when nothing resolves, so the skin tokens stay paired', () => {
    expect(core.resolveCellColors(undefined, undefined)).toEqual({});
    expect(core.resolveCellColors({ indexed: 64 }, { theme: 99 })).toEqual({});
    expect(core.resolveCellColors({ argb: 'bogus' }, { argb: '' })).toEqual({});
  });
});
