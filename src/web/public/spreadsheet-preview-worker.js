/**
 * @fileoverview Same-origin XLSX parsing worker for the file-preview overlay.
 *
 * Runs off the main thread and is the ONLY place the spreadsheet vendor bundles
 * load: fflate + the pure core at worker start, ExcelJS only after the ZIP has
 * passed `admitXlsx()` (entry/inflate/ratio/cell/style caps). ExcelJS is then
 * given a STORE-only archive rebuilt from the entries admission inflated, never
 * the fetched bytes, so it can only parse what admission counted. The page never
 * loads either vendor file. Cell values are sent back as plain strings; the
 * renderer writes them with `textContent`. Formulas are never evaluated (the
 * cached result is shown, else the formula text), and nothing here fetches:
 * external links, images and drawings are reported as unsupported features.
 *
 * Script URLs are RELATIVE so they resolve against this worker's own URL, which
 * keeps a reverse-proxy `--base-url` mount working.
 */

'use strict';

const spreadsheetAssetVersion = new URL(self.location.href).searchParams.get('v') || 'dev';
const spreadsheetAssetQuery = `?v=${encodeURIComponent(spreadsheetAssetVersion)}`;
importScripts(`vendor/fflate.min.js${spreadsheetAssetQuery}`, `spreadsheet-xlsx-core.js${spreadsheetAssetQuery}`);

const core = self.CodemanSpreadsheetXlsxCore;
let workbook = null;
let sheetsById = new Map();
// Per sheet: its populated rows in order, each with its populated cells in
// column order, built once at load from the keys that exist (`populatedRowIndex`).
let populatedRowsById = new Map();
// Merges read once at load: `sheet.model` rebuilds every row and cell model,
// which is far too much to pay on every tile.
let mergesById = new Map();
let normalizedStyles = [];
let styleIds = new Map();
let themePalette = core.DEFAULT_THEME_PALETTE;

function postError(error) {
  self.postMessage({
    type: 'error',
    code: error?.code || 'parse-failed',
    message: error?.message || 'Spreadsheet preview failed',
  });
}

// Maximum cells in one tile reply; the renderer draws at most this many too.
const MAX_TILE_CELLS = 2500;

// ExcelJS keeps the workbook's raw theme XML on `_themes.theme1`; the admitted
// entry is the fallback and the default Office palette is the last resort.
function readThemeXml(loadedWorkbook, admittedEntries) {
  const stashed = loadedWorkbook?._themes?.theme1;
  if (typeof stashed === 'string' && stashed.length > 0) return stashed;
  const theme = admittedEntries?.['xl/theme/theme1.xml'];
  return theme ? new TextDecoder().decode(theme) : '';
}

function normalizeStyle(cell) {
  // Colours are resolved and contrast-checked as a PAIR. Emitting a
  // font colour without its background lets workbook text land on the skin's
  // `var(--bg-primary)` and disappear.
  const colors = core.resolveCellColors(cell.fill?.fgColor, cell.font?.color, themePalette);
  const style = {
    font: {
      bold: Boolean(cell.font?.bold),
      italic: Boolean(cell.font?.italic),
      color: colors.foreground,
    },
    fill: colors.background,
    alignment: ['left', 'center', 'right'].includes(cell.alignment?.horizontal) ? cell.alignment.horizontal : undefined,
    wrapText: Boolean(cell.alignment?.wrapText),
  };
  const key = JSON.stringify(style);
  if (styleIds.has(key)) return styleIds.get(key);
  if (normalizedStyles.length >= core.LIMITS.maxStyles) {
    throw new core.XlsxPreviewError('style-limit', 'Workbook exceeds the normalized styles limit');
  }
  const id = normalizedStyles.length;
  normalizedStyles.push(style);
  styleIds.set(key, id);
  return id;
}

// Ascending numeric own keys of a sparse array. ExcelJS keeps rows at
// `_rows[r - 1]` and a row's cells at `_cells[col - 1]`, and one far index puts
// the array in dictionary mode, where its own `eachRow`, `eachCell` and
// `hasValues` (forEach/some) visit every index up to the largest: a single XFD
// cell per row costs 16,384 steps a row. Walking the keys that exist does not.
function presentIndices(sparse) {
  const indices = [];
  for (const key of Object.keys(sparse || [])) {
    const index = Number(key);
    if (Number.isInteger(index) && index >= 0) indices.push(index);
  }
  return indices.sort((a, b) => a - b);
}

// The rows and cells `sheet.eachRow({ includeEmpty: false })` and
// `row.eachCell({ includeEmpty: false })` would visit, in the same order: a
// cell counts when it exists and its type is not `ValueType.Null`, and a row
// counts when it holds at least one such cell (ExcelJS's `row.hasValues`).
function populatedRowIndex(sheet) {
  const nullType = self.ExcelJS.ValueType.Null;
  const rows = [];
  for (const rowIndex of presentIndices(sheet._rows)) {
    const row = sheet._rows[rowIndex];
    if (!row) continue;
    const cells = [];
    for (const cellIndex of presentIndices(row._cells)) {
      const cell = row._cells[cellIndex];
      if (cell && cell.type !== nullType) cells.push(cell);
    }
    if (cells.length > 0) rows.push({ number: row.number, row, cells });
  }
  return rows;
}

function worksheetMetadata(sheet) {
  const cellRefs = [];
  const rowOverrides = [];
  const populatedRows = populatedRowIndex(sheet);
  for (const { number, row, cells } of populatedRows) {
    for (const cell of cells) {
      cellRefs.push(cell.address);
      normalizeStyle(cell);
    }
    if (row.hidden) rowOverrides.push([number, 0]);
    else if (row.height) rowOverrides.push([number, Math.min(546, Math.max(0, row.height * (4 / 3)))]);
  }
  // `sheet.model` rebuilds every row and cell model, so merges come straight
  // from ExcelJS's own merge map, in the order the model getter would list them.
  const merges = Object.values(sheet._merges || {}).map((merge) => merge.range);
  const extent = core.deriveExtent(cellRefs, merges);
  const columnOverrides = [];
  for (let col = 1; col <= extent.cols; col += 1) {
    const column = sheet.getColumn(col);
    if (column.hidden) columnOverrides.push([col, 0]);
    else if (column.width) columnOverrides.push([col, Math.min(1785, Math.max(0, column.width * 7))]);
  }
  return {
    populatedRows,
    merges,
    metadata: {
      id: String(sheet.id),
      name: sheet.name,
      rows: extent.rows,
      cols: extent.cols,
      defaultRowHeight: Math.min(546, Math.max(1, (sheet.properties?.defaultRowHeight || 15) * (4 / 3))),
      defaultColumnWidth: Math.min(1785, Math.max(1, (sheet.properties?.defaultColWidth || 9.14) * 7)),
      rowOverrides,
      columnOverrides,
      merges,
    },
  };
}

function cellDisplay(cell, date1904, warnings) {
  const formatted = core.formatCellValue(cell.value, cell.numFmt || 'General', date1904);
  if (formatted.warning) warnings.add(formatted.warning);
  return formatted.text;
}

async function loadWorkbook(bytes) {
  const admission = core.admitXlsx(new Uint8Array(bytes), self.fflate);
  const admitted = core.buildAdmittedArchive(admission, self.fflate);
  if (!self.ExcelJS) importScripts(`vendor/exceljs.min.js${spreadsheetAssetQuery}`);
  const nextWorkbook = new self.ExcelJS.Workbook();
  // ExcelJS's DefinedNames model setter expands every range into one object per
  // cell (a whole-sheet name exhausts the heap), and admission reads only the
  // `<sheet>` ids in xl/workbook.xml, never defined names. The preview never shows defined names, so they are not
  // stored at all; print areas and titles are split off before this setter runs.
  // defineProperty throws if a future ExcelJS renames `_definedNames`, rather
  // than silently expanding again.
  Object.defineProperty(nextWorkbook._definedNames, 'model', { configurable: true, get: () => [], set: () => {} });
  // ExcelJS expands every address of a `<dataValidation sqref>` into its own
  // object (a whole-column dropdown is a million), and the preview never shows
  // validations, so they are not parsed at all. `maxRows` is a per-sheet
  // backstop behind admission's row count, which also caps the workbook total.
  await nextWorkbook.xlsx.load(admitted, {
    ignoreNodes: ['dataValidations'],
    maxRows: core.LIMITS.maxRowsPerSheet,
  });
  const nextSheets = new Map();
  const nextRows = new Map();
  const nextMerges = new Map();
  normalizedStyles = [];
  styleIds = new Map();
  themePalette = core.parseThemePalette(readThemeXml(nextWorkbook, admission.entries));
  const sheets = [];
  for (const sheet of nextWorkbook.worksheets) {
    if (sheet.state === 'hidden' || sheet.state === 'veryHidden') continue;
    const sheetResult = worksheetMetadata(sheet);
    const metadata = sheetResult.metadata;
    nextSheets.set(metadata.id, sheet);
    nextRows.set(metadata.id, sheetResult.populatedRows);
    nextMerges.set(metadata.id, sheetResult.merges);
    sheets.push(metadata);
  }
  workbook = nextWorkbook;
  sheetsById = nextSheets;
  populatedRowsById = nextRows;
  mergesById = nextMerges;
  self.postMessage({
    type: 'metadata',
    sheets,
    styles: normalizedStyles,
    date1904: Boolean(workbook.properties?.date1904),
    empty: sheets.length === 0,
    warnings: admission.features,
  });
}

function sendTile(message) {
  if (!workbook) throw new Error('Workbook is not loaded');
  const sheet = sheetsById.get(String(message.sheetId));
  if (!sheet) throw new Error('Worksheet is unavailable');
  const range = message.range;
  const warnings = new Set();
  const cells = [];
  const seenCells = new Set();
  let truncated = false;
  // Hidden rows and columns are 0 px, so a viewport can span thousands of them
  // (a filtered sheet); they are never drawn, so never sent.
  const hiddenColumns = new Map();
  const columnHidden = (col) => {
    if (!hiddenColumns.has(col)) hiddenColumns.set(col, Boolean(sheet.getColumn(col).hidden));
    return hiddenColumns.get(col);
  };
  const addCell = (cell) => {
    const key = `${cell.row}:${cell.col}`;
    if (seenCells.has(key) || (cell.isMerged && cell.master !== cell)) return;
    if (sheet.getRow(cell.row).hidden || columnHidden(cell.col)) return;
    if (cells.length >= MAX_TILE_CELLS) {
      truncated = true;
      return;
    }
    seenCells.add(key);
    cells.push({
      row: cell.row,
      col: cell.col,
      text: cellDisplay(cell, Boolean(workbook.properties?.date1904), warnings),
      styleId: normalizeStyle(cell),
    });
  };
  const populatedRows = populatedRowsById.get(String(message.sheetId)) || [];
  for (const populated of populatedRows) {
    if (truncated) break;
    if (populated.number < range.r1) continue;
    if (populated.number > range.r2) break;
    if (populated.row.hidden) continue;
    for (const cell of populated.cells) {
      if (cell.col < range.c1) continue;
      if (cell.col > range.c2) break;
      addCell(cell);
    }
  }
  const merges = core.intersectingMerges(mergesById.get(String(message.sheetId)) || [], range);
  for (const merge of merges) {
    const anchor = core.parseRange(merge);
    if (anchor) addCell(sheet.getCell(anchor.r1, anchor.c1));
  }
  if (truncated) warnings.add(`View truncated to the first ${MAX_TILE_CELLS} cells`);
  self.postMessage({
    type: 'tile',
    requestId: message.requestId,
    sheetId: String(message.sheetId),
    cells,
    merges,
    warnings: Array.from(warnings),
  });
}

self.onmessage = async (event) => {
  try {
    const message = event.data || {};
    if (message.type === 'load') await loadWorkbook(message.bytes);
    else if (message.type === 'tile') sendTile(message);
    else if (message.type === 'dispose') {
      workbook = null;
      sheetsById = new Map();
      populatedRowsById = new Map();
      mergesById = new Map();
      themePalette = core.DEFAULT_THEME_PALETTE;
    }
  } catch (error) {
    postError(error);
  }
};

self.postMessage({ type: 'ready' });
