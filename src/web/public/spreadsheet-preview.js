/**
 * @fileoverview Read-only, virtualized XLSX preview for the file-preview overlay.
 *
 * `CodemanSpreadsheetPreview.open({ container, url, size })` fetches the workbook
 * bytes (same-origin only, `?preview=true` so the server applies its 10 MB
 * preview cap), hands them to spreadsheet-preview-worker.js, and renders only
 * the visible tile of cells. Parsing happens entirely in the browser worker; the
 * server just streams the file through its existing confined raw routes.
 *
 * Every workbook string (cell text, sheet names) is written with `textContent`,
 * never markup. The per-style `<style>` block only emits validated `#rrggbb`
 * colours and a fixed set of keywords. `dispose()` aborts the fetch and
 * terminates the worker; panels-ui.js calls it whenever the overlay is reused
 * or closed.
 *
 * @dependency constants.js (CodemanBase.url for the worker URL under --base-url)
 * @loadorder 16.5 (after image-input.js; only defines a global, used on demand)
 */

(function initSpreadsheetPreview(global) {
  'use strict';

  const SPREADSHEET_ASSET_VERSION = '078d54b1055a';
  const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
  const DEFAULT_TIMEOUT_MS = 20000;
  const MAX_SCROLL_PX = 8000000;
  const ROW_HEADING_WIDTH = 36;
  const COLUMN_HEADING_HEIGHT = 20;
  const assets = Object.freeze({
    version: SPREADSHEET_ASSET_VERSION,
    workerUrl: `/spreadsheet-preview-worker.js?v=${SPREADSHEET_ASSET_VERSION}`,
  });

  function message(container, text, kind) {
    container.textContent = '';
    const state = document.createElement('div');
    state.className = `spreadsheet-preview-message ${kind || ''}`.trim();
    state.textContent = text;
    container.appendChild(state);
  }

  function safePreviewUrl(candidate) {
    const url = new URL(candidate, global.location.href);
    if (url.origin !== global.location.origin) throw new Error('Spreadsheet preview must use a same-origin URL');
    url.searchParams.set('preview', 'true');
    return `${url.pathname}${url.search}${url.hash}`;
  }

  function open(options) {
    const container = options.container;
    const isCurrent = typeof options.isCurrent === 'function' ? options.isCurrent : () => true;
    let disposed = false;
    let worker = null;
    let controller = null;
    let timer = null;
    let metadata = null;
    let activeSheetId = null;
    let latestRequestId = 0;
    let grid = null;
    let spacer = null;
    let cellsLayer = null;
    let headingsLayer = null;
    let emptySheetState = null;
    let resizeObserver = null;
    let scaleX = 1;
    let scaleY = 1;
    let latestRange = null;
    let scrollFrame = null;

    const current = () => !disposed && isCurrent();
    const clearTimer = () => {
      if (timer !== null) global.clearTimeout(timer);
      timer = null;
    };
    const fail = (text) => {
      if (!current()) return;
      clearTimer();
      message(container, text || 'Spreadsheet preview failed', 'error');
    };

    function sheetMetadata() {
      return metadata?.sheets.find((sheet) => String(sheet.id) === String(activeSheetId));
    }

    // Prefix sums per override list, built once per sheet's axis: renderTile
    // asks for several offsets per cell, so a linear walk over every override
    // (one per row on a sheet with explicit heights) made each tile O(n) per cell.
    const axisDeltas = new WeakMap();

    function overrideDeltas(overrides, defaultSize) {
      let entry = axisDeltas.get(overrides);
      if (!entry || entry.defaultSize !== defaultSize) {
        const deltas = [];
        let delta = 0;
        for (const [, size] of overrides) {
          delta += size - defaultSize;
          deltas.push(delta);
        }
        entry = { defaultSize, deltas };
        axisDeltas.set(overrides, entry);
      }
      return entry.deltas;
    }

    function axisOffset(count, defaultSize, overrides, index) {
      const bounded = Math.max(1, Math.min(count + 1, index));
      const list = overrides || [];
      let low = 0;
      let high = list.length;
      while (low < high) {
        const mid = (low + high) >> 1;
        if (list[mid][0] < bounded) low = mid + 1;
        else high = mid;
      }
      return (bounded - 1) * defaultSize + (low ? overrideDeltas(list, defaultSize)[low - 1] : 0);
    }

    function axisIndex(count, defaultSize, overrides, offset) {
      let low = 1;
      let high = Math.max(1, count);
      while (low < high) {
        const mid = Math.floor((low + high + 1) / 2);
        if (axisOffset(count, defaultSize, overrides, mid) <= offset) low = mid;
        else high = mid - 1;
      }
      return low;
    }

    function requestTile() {
      if (!current() || !worker || !grid) return;
      const sheet = sheetMetadata();
      if (!sheet || sheet.rows === 0 || sheet.cols === 0) return;
      scaleY = Math.max(
        1,
        axisOffset(sheet.rows, sheet.defaultRowHeight, sheet.rowOverrides, sheet.rows + 1) / MAX_SCROLL_PX
      );
      scaleX = Math.max(
        1,
        axisOffset(sheet.cols, sheet.defaultColumnWidth, sheet.columnOverrides, sheet.cols + 1) / MAX_SCROLL_PX
      );
      const r1 = Math.max(
        1,
        axisIndex(
          sheet.rows,
          sheet.defaultRowHeight,
          sheet.rowOverrides,
          Math.max(0, grid.scrollTop - COLUMN_HEADING_HEIGHT) * scaleY
        ) - 2
      );
      const c1 = Math.max(
        1,
        axisIndex(
          sheet.cols,
          sheet.defaultColumnWidth,
          sheet.columnOverrides,
          Math.max(0, grid.scrollLeft - ROW_HEADING_WIDTH) * scaleX
        ) - 2
      );
      const r2 = Math.min(
        sheet.rows,
        axisIndex(
          sheet.rows,
          sheet.defaultRowHeight,
          sheet.rowOverrides,
          Math.max(0, grid.scrollTop - COLUMN_HEADING_HEIGHT + (grid.clientHeight || 500)) * scaleY
        ) + 2
      );
      const c2 = Math.min(
        sheet.cols,
        axisIndex(
          sheet.cols,
          sheet.defaultColumnWidth,
          sheet.columnOverrides,
          Math.max(0, grid.scrollLeft - ROW_HEADING_WIDTH + (grid.clientWidth || 800)) * scaleX
        ) + 2
      );
      latestRequestId += 1;
      latestRange = { r1, c1, r2, c2 };
      worker.postMessage({
        type: 'tile',
        requestId: latestRequestId,
        sheetId: String(activeSheetId),
        range: { r1, c1, r2, c2 },
      });
    }

    function renderWarnings(tileWarnings) {
      const notice = container.querySelector('.spreadsheet-preview-notice');
      if (!notice) return;
      const warnings = [...(metadata?.warnings || []), ...(tileWarnings || [])];
      notice.hidden = warnings.length === 0;
      const warningLabel =
        global.codemanT?.('Some workbook features are not shown') || 'Some workbook features are not shown';
      notice.textContent = warnings.length ? `${warningLabel}: ${warnings.join(', ')}` : '';
    }

    function pinHeadings() {
      if (!grid || !headingsLayer) return;
      headingsLayer.querySelectorAll('.spreadsheet-row-heading').forEach((heading) => {
        heading.style.left = `${grid.scrollLeft}px`;
      });
      headingsLayer.querySelectorAll('.spreadsheet-column-heading').forEach((heading) => {
        heading.style.top = `${grid.scrollTop}px`;
      });
    }

    function renderTile(tile) {
      if (!current() || tile.requestId !== latestRequestId || String(tile.sheetId) !== String(activeSheetId)) return;
      const sheet = sheetMetadata();
      if (!sheet || !cellsLayer || !headingsLayer || !latestRange) return;
      cellsLayer.textContent = '';
      headingsLayer.textContent = '';
      const mergeByAnchor = new Map();
      for (const merge of tile.merges || []) {
        const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/i.exec(merge);
        if (!match) continue;
        const column = (letters) =>
          [...letters.toUpperCase()].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0);
        mergeByAnchor.set(`${Number(match[2])}:${column(match[1])}`, {
          r2: Number(match[4]),
          c2: column(match[3]),
        });
      }
      for (const cell of tile.cells.slice(0, 2500)) {
        const element = document.createElement('div');
        element.className = `spreadsheet-cell spreadsheet-style-${Number(cell.styleId) || 0}`;
        element.dataset.row = String(cell.row);
        element.dataset.col = String(cell.col);
        element.textContent = String(cell.text ?? '');
        element.style.top = `${COLUMN_HEADING_HEIGHT + axisOffset(sheet.rows, sheet.defaultRowHeight, sheet.rowOverrides, cell.row) / scaleY}px`;
        element.style.left = `${ROW_HEADING_WIDTH + axisOffset(sheet.cols, sheet.defaultColumnWidth, sheet.columnOverrides, cell.col) / scaleX}px`;
        const merge = mergeByAnchor.get(`${cell.row}:${cell.col}`);
        const finalRow = merge?.r2 || cell.row;
        const finalCol = merge?.c2 || cell.col;
        element.style.height = `${Math.max(0, (axisOffset(sheet.rows, sheet.defaultRowHeight, sheet.rowOverrides, finalRow + 1) - axisOffset(sheet.rows, sheet.defaultRowHeight, sheet.rowOverrides, cell.row)) / scaleY)}px`;
        element.style.width = `${Math.max(0, (axisOffset(sheet.cols, sheet.defaultColumnWidth, sheet.columnOverrides, finalCol + 1) - axisOffset(sheet.cols, sheet.defaultColumnWidth, sheet.columnOverrides, cell.col)) / scaleX)}px`;
        cellsLayer.appendChild(element);
      }
      // Headings take their size from the same axis math as the cells, so custom
      // widths/heights line up; hidden (0 px) rows and columns get no heading and
      // do not count against the heading caps.
      let rowHeadings = 0;
      for (let row = latestRange.r1; row <= latestRange.r2 && rowHeadings < 200; row += 1) {
        const top = axisOffset(sheet.rows, sheet.defaultRowHeight, sheet.rowOverrides, row);
        const height = (axisOffset(sheet.rows, sheet.defaultRowHeight, sheet.rowOverrides, row + 1) - top) / scaleY;
        if (height <= 0) continue;
        rowHeadings += 1;
        const heading = document.createElement('div');
        heading.className = 'spreadsheet-row-heading';
        heading.textContent = String(row);
        heading.style.top = `${COLUMN_HEADING_HEIGHT + top / scaleY}px`;
        heading.style.height = `${height}px`;
        heading.style.left = `${grid.scrollLeft}px`;
        headingsLayer.appendChild(heading);
      }
      let columnHeadings = 0;
      for (let col = latestRange.c1; col <= latestRange.c2 && columnHeadings < 100; col += 1) {
        const left = axisOffset(sheet.cols, sheet.defaultColumnWidth, sheet.columnOverrides, col);
        const width =
          (axisOffset(sheet.cols, sheet.defaultColumnWidth, sheet.columnOverrides, col + 1) - left) / scaleX;
        if (width <= 0) continue;
        columnHeadings += 1;
        const heading = document.createElement('div');
        heading.className = 'spreadsheet-column-heading';
        let label = '';
        for (let value = col; value > 0; value = Math.floor((value - 1) / 26))
          label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
        heading.textContent = label;
        heading.style.left = `${ROW_HEADING_WIDTH + left / scaleX}px`;
        heading.style.width = `${width}px`;
        heading.style.top = `${grid.scrollTop}px`;
        headingsLayer.appendChild(heading);
      }
      renderWarnings(tile.warnings);
    }

    function selectSheet(sheetId) {
      if (!current() || !metadata?.sheets.some((sheet) => String(sheet.id) === String(sheetId))) return;
      activeSheetId = String(sheetId);
      latestRequestId += 1;
      latestRange = null;
      if (cellsLayer) cellsLayer.textContent = '';
      if (headingsLayer) headingsLayer.textContent = '';
      container.querySelectorAll('[role="tab"]').forEach((tab) => {
        const selected = tab.dataset.sheetId === activeSheetId;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
      });
      if (grid) {
        grid.scrollTop = 0;
        grid.scrollLeft = 0;
      }
      const sheet = sheetMetadata();
      if (sheet && spacer) {
        const logicalHeight = axisOffset(sheet.rows, sheet.defaultRowHeight, sheet.rowOverrides, sheet.rows + 1);
        const logicalWidth = axisOffset(sheet.cols, sheet.defaultColumnWidth, sheet.columnOverrides, sheet.cols + 1);
        scaleY = Math.max(1, logicalHeight / MAX_SCROLL_PX);
        scaleX = Math.max(1, logicalWidth / MAX_SCROLL_PX);
        spacer.style.height = `${COLUMN_HEADING_HEIGHT + Math.min(MAX_SCROLL_PX, logicalHeight)}px`;
        spacer.style.width = `${ROW_HEADING_WIDTH + Math.min(MAX_SCROLL_PX, logicalWidth)}px`;
      }
      if (emptySheetState) emptySheetState.hidden = Boolean(sheet?.rows && sheet?.cols);
      renderWarnings([]);
      requestTile();
    }

    function renderMetadata(nextMetadata) {
      if (!current()) return;
      metadata = nextMetadata;
      container.textContent = '';
      if (!metadata.sheets?.length) {
        message(container, 'This workbook has no visible worksheets.', 'empty');
        return;
      }
      const shell = document.createElement('div');
      shell.className = 'spreadsheet-preview-shell';
      const styleSheet = document.createElement('style');
      styleSheet.textContent = (metadata.styles || [])
        .map((style, id) => {
          const declarations = [];
          if (style.font?.bold) declarations.push('font-weight:700');
          if (style.font?.italic) declarations.push('font-style:italic');
          // Colour and background are emitted together or not at all.
          // The worker already contrast-checked them as a pair; contributing
          // one half would drop the cell back onto the skin's own background.
          if (/^#[a-f0-9]{6}$/i.test(style.font?.color || '') && /^#[a-f0-9]{6}$/i.test(style.fill || '')) {
            declarations.push(`color:${style.font.color}`, `background-color:${style.fill}`);
          }
          if (['left', 'center', 'right'].includes(style.alignment)) declarations.push(`text-align:${style.alignment}`);
          if (style.wrapText) declarations.push('white-space:normal');
          return `.spreadsheet-style-${id}{${declarations.join(';')}}`;
        })
        .join('');
      const tabs = document.createElement('div');
      tabs.className = 'spreadsheet-sheet-tabs';
      tabs.setAttribute('role', 'tablist');
      tabs.setAttribute('data-i18n-skip', '');
      for (const sheet of metadata.sheets) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'spreadsheet-sheet-tab';
        tab.setAttribute('role', 'tab');
        tab.dataset.sheetId = String(sheet.id);
        tab.textContent = sheet.name;
        tab.addEventListener('click', () => selectSheet(sheet.id));
        tabs.appendChild(tab);
      }
      const notice = document.createElement('div');
      notice.className = 'spreadsheet-preview-notice';
      notice.hidden = true;
      emptySheetState = document.createElement('div');
      emptySheetState.className = 'spreadsheet-empty-sheet';
      emptySheetState.textContent = 'This worksheet is empty.';
      emptySheetState.hidden = true;
      grid = document.createElement('div');
      grid.className = 'spreadsheet-grid';
      grid.setAttribute('data-i18n-skip', '');
      spacer = document.createElement('div');
      spacer.className = 'spreadsheet-grid-spacer';
      cellsLayer = document.createElement('div');
      cellsLayer.className = 'spreadsheet-cells';
      headingsLayer = document.createElement('div');
      headingsLayer.className = 'spreadsheet-headings';
      grid.append(spacer, cellsLayer, headingsLayer);
      grid.addEventListener(
        'scroll',
        () => {
          pinHeadings();
          if (scrollFrame !== null) return;
          scrollFrame = global.requestAnimationFrame(() => {
            scrollFrame = null;
            requestTile();
          });
        },
        { passive: true }
      );
      shell.append(styleSheet, tabs, notice, emptySheetState, grid);
      container.appendChild(shell);
      resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(requestTile) : null;
      resizeObserver?.observe(grid);
      selectSheet(metadata.sheets[0].id);
    }

    function dispose() {
      if (disposed) return;
      disposed = true;
      clearTimer();
      if (scrollFrame !== null) global.cancelAnimationFrame(scrollFrame);
      controller?.abort();
      resizeObserver?.disconnect();
      try {
        worker?.postMessage({ type: 'dispose' });
        worker?.terminate();
      } catch {
        // A worker that failed during startup may already be unavailable.
      }
      worker = null;
    }

    async function start() {
      if (Number(options.size) > MAX_PREVIEW_BYTES) {
        fail('This workbook is too large to preview (10 MB limit).');
        return;
      }
      message(container, 'Loading spreadsheet…', 'loading');
      let previewUrl;
      try {
        previewUrl = safePreviewUrl(options.url);
        controller = new AbortController();
        // Root-absolute paths ignore <base href>; route through the mount prefix.
        worker = new Worker(global.CodemanBase?.url ? global.CodemanBase.url(assets.workerUrl) : assets.workerUrl);
        const ready = new Promise((resolve, reject) => {
          worker.onerror = () => reject(new Error('Spreadsheet parser failed to start'));
          worker.onmessageerror = () => reject(new Error('Spreadsheet parser message failed'));
          worker.onmessage = (event) => {
            if (event.data?.type === 'ready') resolve();
          };
        });
        const responsePromise = fetch(previewUrl, { signal: controller.signal });
        const [response] = await Promise.all([responsePromise, ready]);
        if (!current()) return;
        if (response.status === 413) throw new Error('This workbook is too large to preview (10 MB limit).');
        if (!response.ok) throw new Error(`Spreadsheet preview failed (${response.status})`);
        const bytes = await response.arrayBuffer();
        if (!current()) return;
        worker.onmessage = (event) => {
          if (!current()) return;
          const payload = event.data || {};
          if (payload.type === 'metadata') {
            clearTimer();
            renderMetadata(payload);
          } else if (payload.type === 'tile') renderTile(payload);
          else if (payload.type === 'error') fail(payload.message);
        };
        worker.onerror = () => fail('Spreadsheet parser failed.');
        worker.onmessageerror = () => fail('Spreadsheet parser message failed.');
        timer = global.setTimeout(() => {
          worker?.terminate();
          fail('Spreadsheet preview timed out.');
        }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
        worker.postMessage({ type: 'load', bytes }, [bytes]);
      } catch (error) {
        if (!disposed && error?.name !== 'AbortError') fail(error?.message);
      }
    }

    void start();
    return Object.freeze({ dispose, selectSheet, resize: requestTile });
  }

  global.CodemanSpreadsheetPreviewAssets = assets;
  global.CodemanSpreadsheetPreview = Object.freeze({ open, MAX_PREVIEW_BYTES });
})(window);
