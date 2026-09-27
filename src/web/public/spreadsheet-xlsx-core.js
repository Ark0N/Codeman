/**
 * @fileoverview Pure XLSX admission, formatting, and sparse-grid helpers.
 *
 * Loaded only inside spreadsheet-preview-worker.js (never by the page) and by
 * test/spreadsheet-xlsx-core.test.ts. `admitXlsx()` walks the ZIP central
 * directory and streams every entry through fflate BEFORE ExcelJS sees the
 * bytes, enforcing {@link LIMITS}; a workbook that trips any cap is refused
 * rather than truncated. It returns the entries it inflated, and the worker
 * hands ExcelJS a STORE-only archive rebuilt from exactly those
 * (`buildAdmittedArchive()`), never the original bytes: admission follows local
 * headers while ExcelJS (JSZip) follows the central directory, so overlapping
 * entries could otherwise show each reader a different file.
 */

(function initSpreadsheetXlsxCore(global) {
  'use strict';

  const LIMITS = Object.freeze({
    maxEntries: 5000,
    maxInflatedBytes: 64 * 1024 * 1024,
    maxEntryBytes: 32 * 1024 * 1024,
    maxCompressionRatio: 100,
    maxWorksheets: 50,
    maxCells: 250000,
    maxCellsPerSheet: 100000,
    maxMergesPerSheet: 5000,
    maxStyles: 5000,
  });
  const MAX_ROW = 1048576;
  const MAX_COL = 16384;

  class XlsxPreviewError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'XlsxPreviewError';
      this.code = code;
    }
  }

  function fail(code, message) {
    throw new XlsxPreviewError(code, message);
  }

  function mergedLimits(overrides) {
    return Object.assign({}, LIMITS, overrides || {});
  }

  function u16(bytes, offset) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(offset, true);
  }

  function u32(bytes, offset) {
    return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
  }

  function inspectZipDirectory(bytes, overrides) {
    const limits = mergedLimits(overrides);
    if (bytes.length >= 4 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
      fail('encrypted', 'Encrypted or legacy OLE workbooks cannot be previewed');
    }
    let eocd = -1;
    const floor = Math.max(0, bytes.length - 65557);
    for (let i = bytes.length - 22; i >= floor; i -= 1) {
      if (u32(bytes, i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) fail('malformed', 'Malformed XLSX ZIP directory');
    const entryCount = u16(bytes, eocd + 10);
    const directorySize = u32(bytes, eocd + 12);
    const directoryOffset = u32(bytes, eocd + 16);
    if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
      fail('zip64', 'ZIP64 workbooks are not supported');
    }
    if (entryCount > limits.maxEntries) fail('entry-limit', `Workbook exceeds ${limits.maxEntries} ZIP entries`);
    if (directoryOffset + directorySize > eocd) fail('malformed', 'Malformed XLSX central directory bounds');
    const entries = [];
    let cursor = directoryOffset;
    for (let i = 0; i < entryCount; i += 1) {
      if (cursor + 46 > eocd || u32(bytes, cursor) !== 0x02014b50)
        fail('malformed', 'Malformed XLSX central directory');
      const compressedSize = u32(bytes, cursor + 20);
      const declaredSize = u32(bytes, cursor + 24);
      const nameLength = u16(bytes, cursor + 28);
      const extraLength = u16(bytes, cursor + 30);
      const commentLength = u16(bytes, cursor + 32);
      const localHeaderOffset = u32(bytes, cursor + 42);
      if (compressedSize === 0xffffffff || declaredSize === 0xffffffff)
        fail('zip64', 'ZIP64 entries are not supported');
      const end = cursor + 46 + nameLength + extraLength + commentLength;
      if (end > eocd) fail('malformed', 'Malformed XLSX entry bounds');
      const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
      if (localHeaderOffset + 30 > directoryOffset || u32(bytes, localHeaderOffset) !== 0x04034b50) {
        fail('malformed', 'Malformed XLSX local file header');
      }
      const localNameLength = u16(bytes, localHeaderOffset + 26);
      const localExtraLength = u16(bytes, localHeaderOffset + 28);
      const localNameEnd = localHeaderOffset + 30 + localNameLength;
      if (localNameEnd + localExtraLength > directoryOffset) fail('malformed', 'Malformed XLSX local entry bounds');
      const localName = new TextDecoder().decode(bytes.subarray(localHeaderOffset + 30, localNameEnd));
      if (localName !== name) fail('malformed', 'XLSX local and central directory names do not match');
      entries.push({ name, compressedSize, declaredSize, localHeaderOffset });
      cursor = end;
    }
    return { entries };
  }

  function featureForName(name) {
    if (name.startsWith('xl/charts/')) return 'charts';
    if (name.startsWith('xl/drawings/')) return 'drawings';
    if (name.startsWith('xl/pivotCache/')) return 'pivotTables';
    if (name.startsWith('xl/externalLinks/')) return 'externalLinks';
    if (/vbaProject\.bin$/i.test(name)) return 'macros';
    return null;
  }

  function createXmlCounter(name, counts, limits) {
    let tail = '';
    const decoder = new TextDecoder();
    let sheetCells = 0;
    let sheetMerges = 0;
    let inCellXfs = false;
    const worksheet = /^xl\/worksheets\/[^/]+\.xml$/i.test(name);
    const styles = name === 'xl/styles.xml';
    return {
      push(chunk, final) {
        if (!worksheet && !styles) return;
        const text = tail + decoder.decode(chunk, { stream: !final });
        const safeEnd = final ? text.length : Math.max(0, text.length - 128);
        const scan = text.slice(0, safeEnd);
        if (worksheet) {
          const cells = (scan.match(/<c(?:\s|>)/g) || []).length;
          const merges = (scan.match(/<mergeCell(?:\s|>)/g) || []).length;
          sheetCells += cells;
          sheetMerges += merges;
          counts.cells += cells;
          counts.merges += merges;
          if (sheetCells > limits.maxCellsPerSheet || counts.cells > limits.maxCells)
            fail('cell-limit', 'Workbook exceeds the cells limit');
          if (sheetMerges > limits.maxMergesPerSheet) fail('merge-limit', 'Worksheet exceeds the merged ranges limit');
        }
        if (styles) {
          const tokens = scan.match(/<cellXfs(?:\s|>)|<\/cellXfs\s*>|<xf(?:\s|\/?>)/g) || [];
          for (const token of tokens) {
            if (token.startsWith('<cellXfs')) inCellXfs = true;
            else if (token.startsWith('</cellXfs')) inCellXfs = false;
            else if (inCellXfs) counts.styles += 1;
          }
          if (counts.styles > limits.maxStyles) fail('style-limit', 'Workbook exceeds the cell styles limit');
        }
        tail = text.slice(safeEnd);
      },
    };
  }

  function admitXlsx(bytes, zipApi, overrides) {
    const limits = mergedLimits(overrides);
    const directory = inspectZipDirectory(bytes, limits);
    const directoryByName = new Map(directory.entries.map((entry) => [entry.name, entry]));
    const expectedEntries = new Map();
    for (const entry of directory.entries) expectedEntries.set(entry.name, (expectedEntries.get(entry.name) || 0) + 1);
    const streamedEntries = new Map();
    const inflatedEntries = Object.create(null);
    const counts = { worksheets: 0, cells: 0, merges: 0, styles: 0 };
    const features = new Set();
    let totalInflated = 0;
    let seenEntries = 0;
    let thrown;
    const unzip = new zipApi.Unzip((file) => {
      if (!directoryByName.has(file.name)) fail('malformed', 'Local XLSX entry is absent from the central directory');
      // The admitted archive is rebuilt from these entries, which cannot hold two
      // files under one name, so a duplicate name is refused rather than dropped.
      if (streamedEntries.has(file.name)) fail('malformed', 'Duplicate XLSX entry name');
      streamedEntries.set(file.name, (streamedEntries.get(file.name) || 0) + 1);
      seenEntries += 1;
      if (seenEntries > limits.maxEntries) fail('entry-limit', 'Workbook exceeds the ZIP entries limit');
      if (/^xl\/worksheets\/[^/]+\.xml$/i.test(file.name)) {
        counts.worksheets += 1;
        if (counts.worksheets > limits.maxWorksheets) fail('worksheet-limit', 'Workbook exceeds the worksheet limit');
      }
      const feature = featureForName(file.name);
      if (feature) features.add(feature);
      const counter = createXmlCounter(file.name, counts, limits);
      let entryInflated = 0;
      const chunks = [];
      file.ondata = (error, chunk, final) => {
        if (error) throw error;
        chunks.push(chunk.slice());
        entryInflated += chunk.length;
        totalInflated += chunk.length;
        if (entryInflated > limits.maxEntryBytes) fail('entry-size', 'Inflated ZIP entry exceeds the entry limit');
        if (totalInflated > limits.maxInflatedBytes) fail('inflated-size', 'Workbook exceeds the inflated bytes limit');
        const compressed = directoryByName.get(file.name)?.compressedSize || 1;
        if (entryInflated / Math.max(1, compressed) > limits.maxCompressionRatio) {
          fail('compression-ratio', 'ZIP entry exceeds the compression ratio limit');
        }
        counter.push(chunk, final);
        if (final) {
          const data = new Uint8Array(entryInflated);
          let offset = 0;
          for (const part of chunks) {
            data.set(part, offset);
            offset += part.length;
          }
          chunks.length = 0;
          inflatedEntries[file.name] = data;
        }
      };
      file.start();
    });
    unzip.register(zipApi.UnzipInflate);
    try {
      const inputChunkBytes = 64 * 1024;
      for (let offset = 0; offset < bytes.length && !thrown; offset += inputChunkBytes) {
        const end = Math.min(bytes.length, offset + inputChunkBytes);
        unzip.push(bytes.subarray(offset, end), end === bytes.length);
      }
    } catch (error) {
      thrown = error;
    }
    if (thrown) throw thrown;
    for (const [name, count] of expectedEntries) {
      if (streamedEntries.get(name) !== count) fail('malformed', 'Central XLSX entry was not streamed for admission');
    }
    for (const name of streamedEntries.keys()) {
      if (!(name in inflatedEntries)) fail('malformed', 'XLSX entry did not finish streaming for admission');
    }
    return { counts, features: Array.from(features), inflatedBytes: totalInflated, entries: inflatedEntries };
  }

  // The ONLY bytes ExcelJS may parse: the entries admission itself inflated and
  // counted, re-packed uncompressed. Its size is ~ the inflated total (already
  // capped at LIMITS.maxInflatedBytes) plus per-entry headers.
  function buildAdmittedArchive(admission, zipApi) {
    return zipApi.zipSync(admission.entries, { level: 0 });
  }

  function parseCellRef(ref) {
    const match = /^\$?([A-Z]{1,3})\$?([1-9]\d*)$/i.exec(String(ref || ''));
    if (!match) return null;
    let col = 0;
    for (const char of match[1].toUpperCase()) col = col * 26 + char.charCodeAt(0) - 64;
    const row = Number(match[2]);
    return row <= MAX_ROW && col <= MAX_COL ? { row, col } : null;
  }

  function parseRange(range) {
    const parts = String(range).split(':');
    const start = parseCellRef(parts[0]);
    const end = parseCellRef(parts[1] || parts[0]);
    return start && end ? { r1: start.row, c1: start.col, r2: end.row, c2: end.col } : null;
  }

  function deriveExtent(cells, merges) {
    let rows = 0;
    let cols = 0;
    for (const ref of cells) {
      const cell = parseCellRef(ref);
      if (cell) {
        rows = Math.max(rows, cell.row);
        cols = Math.max(cols, cell.col);
      }
    }
    for (const merge of merges) {
      const range = parseRange(merge);
      if (range) {
        rows = Math.max(rows, range.r2);
        cols = Math.max(cols, range.c2);
      }
    }
    return { rows, cols };
  }

  function createSparseAxis(count, defaultSize, overrides) {
    const sorted = Array.from(overrides || [])
      .filter(([index, size]) => index >= 1 && index <= count && Number.isFinite(size))
      .map(([index, size]) => [index, Math.max(0, size)])
      .sort((a, b) => a[0] - b[0]);
    return { count: Math.max(0, count), defaultSize: Math.max(0, defaultSize), overrides: sorted };
  }

  function axisOffset(axis, index) {
    const bounded = Math.max(1, Math.min(axis.count + 1, index));
    let offset = (bounded - 1) * axis.defaultSize;
    for (const [overrideIndex, size] of axis.overrides) {
      if (overrideIndex >= bounded) break;
      offset += size - axis.defaultSize;
    }
    return offset;
  }

  function axisIndexAt(axis, offset) {
    let low = 1;
    let high = Math.max(1, axis.count);
    const target = Math.max(0, offset);
    while (low < high) {
      const mid = Math.floor((low + high + 1) / 2);
      if (axisOffset(axis, mid) <= target) low = mid;
      else high = mid - 1;
    }
    return low;
  }

  function computeViewport(axis, offset, viewportSize, overscan) {
    const pad = Math.max(0, overscan || 0);
    const start = Math.max(1, axisIndexAt(axis, offset) - pad);
    const end = Math.min(axis.count, axisIndexAt(axis, offset + Math.max(0, viewportSize)) + pad);
    return [start, end];
  }

  function intersectingMerges(merges, viewport) {
    return merges.filter((merge) => {
      const range = parseRange(merge);
      return (
        range &&
        range.r1 <= viewport.r2 &&
        range.r2 >= viewport.r1 &&
        range.c1 <= viewport.c2 &&
        range.c2 >= viewport.c1
      );
    });
  }

  // Rounded to whole milliseconds: `new Date(fraction)` truncates, which turned
  // midnight minus a float error into the previous day.
  function excelDate(serial, date1904) {
    if (date1904) return new Date(Math.round(Date.UTC(1904, 0, 1) + Number(serial) * 86400000));
    const numeric = Number(serial);
    const adjusted = numeric >= 60 ? numeric - 1 : numeric;
    return new Date(Math.round(Date.UTC(1899, 11, 31) + adjusted * 86400000));
  }

  function isDateValue(value) {
    return Object.prototype.toString.call(value) === '[object Date]' && Number.isFinite(value.getTime());
  }

  // Inverse of ExcelJS's own `excelToDate()` (utils.js), which builds the Date
  // from the serial in UTC. Recovering the serial keeps the result independent of
  // the viewer's timezone; `String(date)` rendered it in local time, a day early
  // at any negative UTC offset.
  function dateToSerial(date, date1904) {
    return 25569 + date.getTime() / 86400000 - (date1904 ? 1462 : 0);
  }

  const DATE_FORMAT = /^[ymd\-/ ]+$/i;
  const TIME_FORMAT = /^[hms: ]+$/i;
  const DATE_TIME_FORMAT = /^[ymdhis\-/: ]+$/i;

  function isFormulaValue(value) {
    return 'formula' in value || 'sharedFormula' in value;
  }

  // Every non-scalar shape ExcelJS loads a cell value as. Anything not handled
  // here would otherwise reach String() and render as "[object Object]".
  function formatCellValue(value, format, date1904) {
    if (value === null || value === undefined) return { text: '' };
    if (isDateValue(value)) {
      const code = String(format || 'General');
      const known = DATE_FORMAT.test(code) || TIME_FORMAT.test(code) || DATE_TIME_FORMAT.test(code);
      const serial = dateToSerial(value, date1904);
      if (known) return formatCellValue(serial, code, date1904);
      const fallback = serial % 1 === 0 ? 'yyyy-mm-dd' : 'yyyy-mm-dd hh:mm';
      const formatted = formatCellValue(serial, fallback, date1904);
      return /^General$/i.test(code)
        ? formatted
        : { text: formatted.text, warning: `Unsupported number format: ${code}` };
    }
    if (typeof value === 'object') {
      if (isFormulaValue(value)) {
        if (value.result !== undefined && value.result !== null) return formatCellValue(value.result, format, date1904);
        const source = typeof value.formula === 'string' ? `=${value.formula}` : '';
        return { text: source, warning: 'Formula has no cached result' };
      }
      if (typeof value.error === 'string') return { text: value.error };
      if (Array.isArray(value.richText)) {
        return { text: value.richText.map((run) => (typeof run?.text === 'string' ? run.text : '')).join('') };
      }
      // Hyperlink: the display text, never the target. The text may be rich.
      if ('text' in value) return formatCellValue(value.text, 'General', date1904);
      return { text: '', warning: 'Unsupported cell value' };
    }
    const code = String(format || 'General');
    if (typeof value !== 'number') return { text: String(value) };
    if (/^General$/i.test(code)) return { text: String(value) };
    if (DATE_FORMAT.test(code)) {
      const date = excelDate(value, Boolean(date1904));
      const yyyy = date.getUTCFullYear();
      const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(date.getUTCDate()).padStart(2, '0');
      return { text: `${yyyy}-${mm}-${dd}` };
    }
    if (TIME_FORMAT.test(code)) {
      const seconds = Math.round((value - Math.floor(value)) * 86400) % 86400;
      const hh = String(Math.floor(seconds / 3600)).padStart(2, '0');
      const mm = String(Math.floor((seconds % 3600) / 60)).padStart(2, '0');
      const ss = String(seconds % 60).padStart(2, '0');
      return { text: `${hh}:${mm}:${ss}` };
    }
    if (DATE_TIME_FORMAT.test(code)) {
      const date = excelDate(value, Boolean(date1904));
      const yyyy = date.getUTCFullYear();
      const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
      const dd = String(date.getUTCDate()).padStart(2, '0');
      const hh = String(date.getUTCHours()).padStart(2, '0');
      const minutes = String(date.getUTCMinutes()).padStart(2, '0');
      return { text: `${yyyy}-${mm}-${dd} ${hh}:${minutes}` };
    }
    const percent = code.includes('%');
    const decimals = code.match(/\.([0#]+)/)?.[1].length || 0;
    const numericPattern = /^[€£¥$]?[#,0]+(?:\.[0#]+)?%?$/;
    if (numericPattern.test(code)) {
      const currency = /^[€£¥$]/.exec(code)?.[0] || '';
      const numeric = percent ? value * 100 : value;
      const useGrouping = code.includes(',');
      return {
        text:
          currency +
          numeric.toLocaleString('en-US', {
            useGrouping,
            minimumFractionDigits: decimals,
            maximumFractionDigits: decimals,
          }) +
          (percent ? '%' : ''),
      };
    }
    return { text: String(value), warning: `Unsupported number format: ${code}` };
  }

  // Colour resolution --------------------------------------------------------
  //
  // ExcelJS surfaces theme and indexed palette colours WITHOUT an `argb` key
  // (`{theme,tint}` / `{indexed}`), and theme colours are what Excel emits by
  // default. Dropping them left cells rendering the workbook's font colour on
  // the skin's own background, which is how black-on-dark (invisible) text got
  // shipped. Everything below is pure so `test/spreadsheet-xlsx-core.test.ts`
  // can pin it without a DOM.

  // styles.xml `theme="N"` order. NOTE: theme1.xml's <a:clrScheme> lists
  // dk1, lt1, dk2, lt2 — indices 0/1 and 2/3 are SWAPPED between the two.
  const THEME_SLOT_ORDER = Object.freeze([
    'lt1',
    'dk1',
    'lt2',
    'dk2',
    'accent1',
    'accent2',
    'accent3',
    'accent4',
    'accent5',
    'accent6',
    'hlink',
    'folHlink',
  ]);

  // Default Office theme, used when theme1.xml is missing or unparseable.
  const DEFAULT_THEME_PALETTE = Object.freeze([
    '#ffffff',
    '#000000',
    '#eeece1',
    '#1f497d',
    '#4f81bd',
    '#c0504d',
    '#9bbb59',
    '#8064a2',
    '#4bacc6',
    '#f79646',
    '#0000ff',
    '#800080',
  ]);

  // Legacy 64-entry indexed palette. Indices 64/65 are the "auto" foreground and
  // background sentinels and deliberately have no entry here.
  // prettier-ignore
  const INDEXED_PALETTE = Object.freeze([
    '#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff',
    '#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff',
    '#800000', '#008000', '#000080', '#808000', '#800080', '#008080', '#c0c0c0', '#808080',
    '#9999ff', '#993366', '#ffffcc', '#ccffff', '#660066', '#ff8080', '#0066cc', '#ccccff',
    '#000080', '#ff00ff', '#ffff00', '#00ffff', '#800080', '#800000', '#008080', '#0000ff',
    '#00ccff', '#ccffff', '#ccffcc', '#ffff99', '#99ccff', '#ff99cc', '#cc99ff', '#ffcc99',
    '#3366ff', '#33cccc', '#99cc00', '#ffcc00', '#ff9900', '#ff6600', '#666699', '#969696',
    '#003366', '#339966', '#003300', '#333300', '#993300', '#993366', '#333399', '#333333',
  ]);

  const MIN_CONTRAST_RATIO = 4.5;
  // A workbook with no fill renders on Excel's implicit white sheet background,
  // never on the viewer skin's `var(--bg-primary)`.
  const IMPLICIT_SHEET_BACKGROUND = '#ffffff';
  const IMPLICIT_SHEET_FOREGROUND = '#000000';

  function hexToRgb(hex) {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''));
    if (!match) return null;
    return [Number.parseInt(match[1], 16), Number.parseInt(match[2], 16), Number.parseInt(match[3], 16)];
  }

  function rgbToHex(rgb) {
    let hex = '#';
    for (const channel of rgb) {
      const bounded = Math.max(0, Math.min(255, Math.round(channel)));
      hex += (bounded < 16 ? '0' : '') + bounded.toString(16);
    }
    return hex;
  }

  function rgbToHsl(rgb) {
    const r = rgb[0] / 255;
    const g = rgb[1] / 255;
    const b = rgb[2] / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return { h: 0, s: 0, l };
    const delta = max - min;
    const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
    let h;
    if (max === r) h = (g - b) / delta + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / delta + 2;
    else h = (r - g) / delta + 4;
    return { h: h / 6, s, l };
  }

  function hueToChannel(p, q, hue) {
    let t = hue;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }

  function hslToRgb(hsl) {
    if (hsl.s === 0) {
      const gray = hsl.l * 255;
      return [gray, gray, gray];
    }
    const q = hsl.l < 0.5 ? hsl.l * (1 + hsl.s) : hsl.l + hsl.s - hsl.l * hsl.s;
    const p = 2 * hsl.l - q;
    return [
      hueToChannel(p, q, hsl.h + 1 / 3) * 255,
      hueToChannel(p, q, hsl.h) * 255,
      hueToChannel(p, q, hsl.h - 1 / 3) * 255,
    ];
  }

  // Excel tint acts on HSL luminance: negative darkens, positive lightens.
  function applyTint(hex, tint) {
    const amount = Number(tint);
    if (!Number.isFinite(amount) || amount === 0) return hex;
    const rgb = hexToRgb(hex);
    if (!rgb) return hex;
    const bounded = Math.max(-1, Math.min(1, amount));
    const hsl = rgbToHsl(rgb);
    const luminance = bounded < 0 ? hsl.l * (1 + bounded) : hsl.l * (1 - bounded) + bounded;
    return rgbToHex(hslToRgb({ h: hsl.h, s: hsl.s, l: Math.max(0, Math.min(1, luminance)) }));
  }

  function parseSchemeColor(fragment) {
    const srgb = /<(?:[A-Za-z0-9_]+:)?srgbClr\b[^>]*\bval="([0-9A-Fa-f]{6})"/.exec(fragment);
    if (srgb) return `#${srgb[1].toLowerCase()}`;
    const sys = /<(?:[A-Za-z0-9_]+:)?sysClr\b[^>]*\blastClr="([0-9A-Fa-f]{6})"/.exec(fragment);
    if (sys) return `#${sys[1].toLowerCase()}`;
    return undefined;
  }

  function parseThemePalette(xml) {
    const palette = DEFAULT_THEME_PALETTE.slice();
    const text = typeof xml === 'string' ? xml : '';
    const scheme = /<(?:[A-Za-z0-9_]+:)?clrScheme\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?clrScheme\s*>/.exec(text);
    if (!scheme) return palette;
    // Fresh pattern per call: a shared /g regex would carry lastIndex across calls.
    const slots =
      /<(?:[A-Za-z0-9_]+:)?(lt1|dk1|lt2|dk2|accent[1-6]|hlink|folHlink)\b[^>]*>([\s\S]*?)<\/(?:[A-Za-z0-9_]+:)?\1\s*>/g;
    let match = slots.exec(scheme[1]);
    while (match) {
      const index = THEME_SLOT_ORDER.indexOf(match[1]);
      const resolved = index >= 0 ? parseSchemeColor(match[2]) : undefined;
      if (resolved) palette[index] = resolved;
      match = slots.exec(scheme[1]);
    }
    return palette;
  }

  function themePaletteOrDefault(palette) {
    return Array.isArray(palette) && palette.length === THEME_SLOT_ORDER.length ? palette : DEFAULT_THEME_PALETTE;
  }

  // Accepts every colour shape ExcelJS emits: {argb}, {theme,tint}, {indexed}.
  function resolveColor(color, palette) {
    if (!color || typeof color !== 'object') return undefined;
    const argb = color.argb;
    if (typeof argb === 'string' && /^[A-Fa-f0-9]{8}$/.test(argb)) return `#${argb.slice(2).toLowerCase()}`;
    const theme = color.theme;
    if (Number.isInteger(theme) && theme >= 0 && theme < THEME_SLOT_ORDER.length) {
      const base = themePaletteOrDefault(palette)[theme];
      return typeof base === 'string' ? applyTint(base, color.tint) : undefined;
    }
    const indexed = color.indexed;
    if (Number.isInteger(indexed) && indexed >= 0 && indexed < INDEXED_PALETTE.length) return INDEXED_PALETTE[indexed];
    return undefined;
  }

  function channelLuminance(channel) {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
  }

  function relativeLuminance(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return 0;
    return 0.2126 * channelLuminance(rgb[0]) + 0.7152 * channelLuminance(rgb[1]) + 0.0722 * channelLuminance(rgb[2]);
  }

  function contrastRatio(a, b) {
    const first = relativeLuminance(a);
    const second = relativeLuminance(b);
    return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
  }

  function ensureContrast(foreground, background, minRatio) {
    const minimum = Number.isFinite(minRatio) ? minRatio : MIN_CONTRAST_RATIO;
    if (contrastRatio(foreground, background) >= minimum) return foreground;
    return contrastRatio('#000000', background) >= contrastRatio('#ffffff', background) ? '#000000' : '#ffffff';
  }

  // Returns a SELF-CONSISTENT pair, or nothing at all. Emitting only one half is
  // what let workbook text land on the skin's background and vanish.
  function resolveCellColors(fillColor, fontColor, palette) {
    const fill = resolveColor(fillColor, palette);
    const font = resolveColor(fontColor, palette);
    if (!fill && !font) return {};
    const background = fill || IMPLICIT_SHEET_BACKGROUND;
    return { background, foreground: ensureContrast(font || IMPLICIT_SHEET_FOREGROUND, background) };
  }

  global.CodemanSpreadsheetXlsxCore = Object.freeze({
    LIMITS,
    MAX_ROW,
    MAX_COL,
    XlsxPreviewError,
    inspectZipDirectory,
    admitXlsx,
    buildAdmittedArchive,
    parseCellRef,
    parseRange,
    deriveExtent,
    createSparseAxis,
    axisOffset,
    axisIndexAt,
    computeViewport,
    intersectingMerges,
    formatCellValue,
    DEFAULT_THEME_PALETTE,
    INDEXED_PALETTE,
    MIN_CONTRAST_RATIO,
    parseThemePalette,
    resolveColor,
    contrastRatio,
    ensureContrast,
    resolveCellColors,
  });
})(typeof self !== 'undefined' ? self : globalThis);
