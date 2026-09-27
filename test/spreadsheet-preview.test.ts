/**
 * @fileoverview Spreadsheet renderer lifecycle and virtualization, plus its
 * wiring into the file-preview overlay (panels-ui.js).
 *
 * The renderer runs against a standalone JSDOM window (like i18n-branding.test.ts)
 * rather than the `jsdom` vitest environment. Workbook strings are asserted to
 * land as text, never markup.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const source = readFileSync(resolve(import.meta.dirname, '../src/web/public/spreadsheet-preview.js'), 'utf8');
const panelsSource = readFileSync(resolve(import.meta.dirname, '../src/web/public/panels-ui.js'), 'utf8');

// A real origin: the renderer resolves its fetch URL against `location.href`.
const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const window = dom.window as any;
const document = window.document as Document;

class WorkerMock {
  static instances: WorkerMock[] = [];
  onmessage: ((event: { data: any }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor(readonly url: string) {
    WorkerMock.instances.push(this);
  }
  emit(data: unknown) {
    this.onmessage?.({ data });
  }
}

function loadRenderer(fetchMock: ReturnType<typeof vi.fn>) {
  const context = vm.createContext({
    window,
    document,
    URL,
    AbortController,
    Worker: WorkerMock,
    ResizeObserver: undefined,
    fetch: fetchMock,
    setTimeout,
    clearTimeout,
    console,
  });
  vm.runInContext(source, context);
  return (window as any).CodemanSpreadsheetPreview as { open(options: Record<string, unknown>): { dispose(): void } };
}

function metadata() {
  return {
    type: 'metadata',
    sheets: [
      {
        id: '1',
        name: '<Summary>',
        rows: 1_000_000,
        cols: 100,
        defaultRowHeight: 20,
        defaultColumnWidth: 64,
        rowOverrides: [],
        columnOverrides: [],
      },
      { id: '2', name: 'Details', rows: 1, cols: 1, defaultRowHeight: 20, defaultColumnWidth: 64 },
    ],
  };
}

describe('spreadsheet preview renderer', () => {
  beforeEach(() => {
    WorkerMock.instances = [];
    document.body.innerHTML = '<div id="preview"></div>';
    delete (window as any).CodemanSpreadsheetPreview;
    window.requestAnimationFrame = (callback: FrameRequestCallback) =>
      setTimeout(() => callback(0), 0) as unknown as number;
    window.cancelAnimationFrame = (id: number) => clearTimeout(id);
  });

  it('refuses oversized metadata before fetch or worker creation', () => {
    const fetchMock = vi.fn();
    const renderer = loadRenderer(fetchMock);
    renderer.open({ container: document.querySelector('#preview'), url: '/book.xlsx', size: 10 * 1024 * 1024 + 1 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(WorkerMock.instances).toHaveLength(0);
    expect(document.body.textContent).toContain('10 MB limit');
  });

  it('fetches same-origin preview bytes, transfers them, and bounds rendered cells', async () => {
    const bytes = new ArrayBuffer(8);
    const fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes }));
    const renderer = loadRenderer(fetchMock);
    renderer.open({ container: document.querySelector('#preview'), url: '/api/book.xlsx', size: 8 });
    const worker = WorkerMock.instances[0];
    worker.emit({ type: 'ready' });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith({ type: 'load', bytes }, [bytes]));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/book.xlsx?preview=true',
      expect.objectContaining({ signal: expect.anything() })
    );

    worker.emit(metadata());
    const tileRequest = worker.postMessage.mock.calls.at(-1)?.[0];
    expect(tileRequest.type).toBe('tile');
    expect(tileRequest.range.r2 - tileRequest.range.r1).toBeLessThan(100);
    worker.emit({
      type: 'tile',
      requestId: tileRequest.requestId,
      sheetId: '1',
      cells: Array.from({ length: 3000 }, (_, index) => ({
        row: index + 1,
        col: 1,
        text: `<b>${index}</b>`,
        styleId: 0,
      })),
    });
    expect(document.querySelectorAll('.spreadsheet-cell')).toHaveLength(2500);
    expect(document.querySelector('.spreadsheet-cell')?.textContent).toBe('<b>0</b>');
    expect((document.querySelector('.spreadsheet-cell') as HTMLElement).style.top).toBe('20px');
    expect((document.querySelector('.spreadsheet-cell') as HTMLElement).style.left).toBe('36px');
    const grid = document.querySelector('.spreadsheet-grid') as HTMLElement;
    grid.scrollLeft = 400;
    grid.scrollTop = 300;
    grid.dispatchEvent(new window.Event('scroll'));
    expect((document.querySelector('.spreadsheet-row-heading') as HTMLElement).style.left).toBe('400px');
    expect((document.querySelector('.spreadsheet-column-heading') as HTMLElement).style.top).toBe('300px');
    expect(document.querySelector('.spreadsheet-sheet-tabs')?.hasAttribute('data-i18n-skip')).toBe(true);
    expect(document.querySelector('.spreadsheet-grid')?.hasAttribute('data-i18n-skip')).toBe(true);
    expect(Number.parseFloat((document.querySelector('.spreadsheet-grid-spacer') as HTMLElement).style.height)).toBe(
      8_000_020
    );
    (document.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement).click();
    expect((document.querySelector('.spreadsheet-grid-spacer') as HTMLElement).style.height).toBe('40px');
  });

  it('drops stale tiles and aborts fetch plus terminates worker on dispose', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
    const renderer = loadRenderer(fetchMock);
    const handle = renderer.open({ container: document.querySelector('#preview'), url: '/book.xlsx', size: 8 });
    const worker = WorkerMock.instances[0];
    worker.emit({ type: 'ready' });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled());
    worker.emit(metadata());
    const request = worker.postMessage.mock.calls.at(-1)?.[0];
    worker.emit({
      type: 'tile',
      requestId: request.requestId - 1,
      sheetId: '1',
      cells: [{ row: 1, col: 1, text: 'stale' }],
    });
    expect(document.body.textContent).not.toContain('stale');
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    handle.dispose();
    expect(signal.aborted).toBe(true);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('shows feature warnings and reports worker failures after readiness', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
    const renderer = loadRenderer(fetchMock);
    renderer.open({ container: document.querySelector('#preview'), url: '/book.xlsx', size: 8 });
    const worker = WorkerMock.instances[0];
    worker.emit({ type: 'ready' });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled());
    worker.emit({ ...metadata(), warnings: ['charts'] });
    const request = worker.postMessage.mock.calls.at(-1)?.[0];
    worker.emit({ type: 'tile', requestId: request.requestId, sheetId: '1', cells: [], warnings: [] });
    expect(document.body.textContent).toContain('charts');
    worker.onerror?.();
    expect(document.body.textContent).toContain('Spreadsheet parser failed');
  });

  it('shows an explicit empty-sheet state without dropping workbook warnings', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
    const renderer = loadRenderer(fetchMock);
    renderer.open({ container: document.querySelector('#preview'), url: '/book.xlsx', size: 8 });
    const worker = WorkerMock.instances[0];
    worker.emit({ type: 'ready' });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled());
    worker.emit({
      type: 'metadata',
      warnings: ['charts'],
      styles: [],
      sheets: [
        {
          id: '0',
          name: 'Data',
          rows: 1,
          cols: 1,
          defaultRowHeight: 20,
          defaultColumnWidth: 64,
          rowOverrides: [],
          columnOverrides: [],
        },
        {
          id: '1',
          name: 'Empty',
          rows: 0,
          cols: 0,
          defaultRowHeight: 20,
          defaultColumnWidth: 64,
          rowOverrides: [],
          columnOverrides: [],
        },
      ],
    });
    const request = worker.postMessage.mock.calls.at(-1)?.[0];
    worker.emit({
      type: 'tile',
      requestId: request.requestId,
      sheetId: '0',
      cells: [{ row: 1, col: 1, text: 'old cell', styleId: 0 }],
      warnings: [],
    });
    expect(document.body.textContent).toContain('old cell');
    (document.querySelectorAll('[role="tab"]')[1] as HTMLButtonElement).click();
    expect(document.body.textContent).toContain('This worksheet is empty.');
    expect(document.body.textContent).toContain('charts');
    expect(document.body.textContent).not.toContain('old cell');
  });

  it('emits colour and background together or not at all', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
    const renderer = loadRenderer(fetchMock);
    renderer.open({ container: document.querySelector('#preview'), url: '/book.xlsx', size: 8 });
    const worker = WorkerMock.instances[0];
    worker.emit({ type: 'ready' });
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled());
    worker.emit({
      ...metadata(),
      styles: [
        { font: { color: '#000000' }, fill: '#ffffff' },
        { font: { bold: true, color: '#000000' }, fill: undefined },
        { font: {}, fill: '#ffff00' },
        { font: { italic: true }, alignment: 'center' },
      ],
    });
    const css = (document.querySelector('.spreadsheet-preview-shell style') as HTMLElement).textContent || '';
    expect(css).toContain('.spreadsheet-style-0{color:#000000;background-color:#ffffff}');
    // A half pair would strand the text on the skin's own background, so drop both.
    expect(css).toContain('.spreadsheet-style-1{font-weight:700}');
    expect(css).toContain('.spreadsheet-style-2{}');
    expect(css).toContain('.spreadsheet-style-3{font-style:italic;text-align:center}');
    expect(css).not.toContain('background-color:#ffff00');
  });
});

/**
 * The overlay wiring in panels-ui.js: which route the renderer is pointed at,
 * and that the worker/fetch lifecycle is torn down on close and on re-open.
 */
describe('file-preview overlay spreadsheet wiring', () => {
  function loadOverlay(fileContent: Record<string, unknown>) {
    const handles: Array<{ dispose: ReturnType<typeof vi.fn> }> = [];
    const open = vi.fn(() => {
      const handle = { dispose: vi.fn() };
      handles.push(handle);
      return handle;
    });
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ success: true, data: fileContent }) }));
    const CodemanApp = function CodemanApp(this: unknown) {} as unknown as new () => Record<string, any>;
    const context = vm.createContext({
      CodemanApp,
      console,
      escapeHtml: (value: unknown) => String(value ?? ''),
      CodemanBase: { base: '', url: (p: string) => p },
      fetch: fetchMock,
      setTimeout,
      clearTimeout,
      confirm: () => true,
      document,
      window: { CodemanSpreadsheetPreview: { open }, addEventListener: vi.fn(), removeEventListener: vi.fn() },
    });
    vm.runInContext(panelsSource, context, { filename: 'panels-ui.js' });
    document.body.innerHTML =
      '<div id="filePreviewOverlay"></div><div id="filePreviewTitle"></div><div id="filePreviewBody"></div>' +
      '<div id="filePreviewFooter"></div>';
    const app = new CodemanApp();
    app.$ = (id: string) => document.getElementById(id);
    app.sessions = new Map([['s1', { workingDir: '/work' }]]);
    app.formatFileSize = () => '8 KB';
    return { app, open, handles, fetchMock };
  }

  it('renders a workspace xlsx through the renderer, pointed at the confined file-raw route', async () => {
    const { app, open, handles } = loadOverlay({
      type: 'spreadsheet',
      size: 8192,
      extension: 'xlsx',
      url: '/api/sessions/s1/file-raw?path=book.xlsx',
    });
    await app.openFilePreview('book.xlsx', 's1');
    const body = document.getElementById('filePreviewBody');
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({ container: body, url: '/api/sessions/s1/file-raw?path=book.xlsx', size: 8192 })
    );
    expect(document.getElementById('filePreviewFooter')?.textContent).toContain('xlsx');

    app.closeFilePreview();
    expect(handles[0].dispose).toHaveBeenCalledTimes(1);
  });

  it('disposes the previous spreadsheet when another preview opens, and stale renders stop', async () => {
    const { app, open, handles } = loadOverlay({
      type: 'spreadsheet',
      size: 1,
      extension: 'xlsx',
      url: '/api/sessions/s1/file-raw?path=a.xlsx',
    });
    await app.openFilePreview('a.xlsx', 's1');
    const firstIsCurrent = (open.mock.calls[0] as unknown as [{ isCurrent(): boolean }])[0].isCurrent;
    expect(firstIsCurrent()).toBe(true);
    await app.openFilePreview('b.xlsx', 's1');
    expect(handles[0].dispose).toHaveBeenCalledTimes(1);
    expect(firstIsCurrent()).toBe(false);
    expect(handles[1].dispose).not.toHaveBeenCalled();
  });

  it('renders a registered xlsx attachment from its by-id raw route', async () => {
    const { app, open, fetchMock } = loadOverlay({});
    await app.openFilePreview('book.xlsx', 's1', 'att-1');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ url: '/api/sessions/s1/attachments/att-1/raw' }));
  });

  it('leaves xls/ods on the download-only binary path', async () => {
    const { app, open } = loadOverlay({ type: 'binary', size: 10, extension: 'xls' });
    await app.openFilePreview('old.xls', 's1');
    expect(open).not.toHaveBeenCalled();
    expect(document.getElementById('filePreviewBody')?.textContent).toContain('Cannot preview');
  });
});
