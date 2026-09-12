/**
 * @fileoverview Path picker: sort order and the editable path field.
 *
 * Same jsdom harness as path-picker-hidden.test.ts: keyboard-accessory.js is
 * evaluated against a jsdom window with a scripted fetch, so the assertions
 * run against the real DOM the picker builds rather than string matches.
 * Port: N/A
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const accessoryJs = readFileSync(resolve(PUBLIC, 'keyboard-accessory.js'), 'utf8');
const stylesCss = readFileSync(resolve(PUBLIC, 'styles.css'), 'utf8');

const SORT_KEY = 'codeman:pathPickerSort';

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { url: 'https://localhost/' });
const jsdomWindow = dom.window as unknown as Window & typeof globalThis;
const jsdomDocument = jsdomWindow.document;

function loadPathPicker(fetchImpl: (url: string) => Promise<unknown>): any {
  const MobileDetection = { isTouchDevice: () => false };
  const factory = new Function(
    'window',
    'document',
    'localStorage',
    'fetch',
    'MobileDetection',
    `${accessoryJs}\nreturn PathPicker;`
  );
  return factory(jsdomWindow, jsdomDocument, jsdomWindow.localStorage, fetchImpl, MobileDetection);
}

type Entry = { name: string; type: 'file' | 'directory'; mtimeMs?: number };

function browseResponse(entries: Entry[], path = '/home/dev/project') {
  return {
    ok: true,
    json: async () => ({
      success: true,
      data: {
        path,
        parent: path === '/home/dev' ? null : '/home/dev',
        root: '/home/dev',
        roots: [{ label: 'Home', path: '/home/dev' }],
        entries: entries.map((e) => ({ ...e, path: `${path}/${e.name}` })),
        truncated: false,
      },
    }),
  };
}

function errorResponse(error: string) {
  return { ok: false, json: async () => ({ success: false, error }) };
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const LISTING: Entry[] = [
  { name: 'zeta.txt', type: 'file', mtimeMs: NOW - 3 * DAY },
  { name: 'alpha.txt', type: 'file', mtimeMs: NOW - 1 * DAY },
  { name: 'mid.txt', type: 'file', mtimeMs: NOW - 2 * DAY },
  { name: 'old-dir', type: 'directory', mtimeMs: NOW - 30 * DAY },
  { name: 'new-dir', type: 'directory', mtimeMs: NOW - 1000 },
];

describe('PathPicker sort order', () => {
  let PathPicker: any;
  let urls: string[];
  let respond: (url: string) => unknown;

  beforeEach(() => {
    jsdomWindow.localStorage.clear();
    jsdomDocument.body.replaceChildren();
    urls = [];
    respond = () => browseResponse(LISTING);
    PathPicker = loadPathPicker(async (url: string) => {
      urls.push(url);
      return respond(url);
    });
  });

  afterEach(() => {
    PathPicker?.close?.(false);
    jsdomDocument.body.replaceChildren();
  });

  const open = async (options: Record<string, unknown> = {}) => {
    PathPicker.open({ onSelect: () => {}, ...options });
    await vi.waitFor(() => expect(jsdomDocument.querySelectorAll('.path-picker-item').length).toBeGreaterThan(0));
  };
  const names = () => Array.from(jsdomDocument.querySelectorAll('.path-picker-item-name')).map((el) => el.textContent);
  const sortSelect = () => jsdomDocument.querySelector('.path-picker-sort') as HTMLSelectElement;
  const setSort = (value: string) => {
    sortSelect().value = value;
    sortSelect().dispatchEvent(new jsdomWindow.Event('change', { bubbles: true }));
  };

  it('sorts by name with folders first by default', async () => {
    await open();
    expect(sortSelect().value).toBe('name-asc');
    expect(names()).toEqual(['new-dir', 'old-dir', 'alpha.txt', 'mid.txt', 'zeta.txt']);
  });

  it('re-orders the listing without another request, keeping folders first', async () => {
    await open();
    const requests = urls.length;

    setSort('mtime-desc');
    expect(names()).toEqual(['new-dir', 'old-dir', 'alpha.txt', 'mid.txt', 'zeta.txt']);

    setSort('mtime-asc');
    expect(names()).toEqual(['old-dir', 'new-dir', 'zeta.txt', 'mid.txt', 'alpha.txt']);

    setSort('name-desc');
    expect(names()).toEqual(['old-dir', 'new-dir', 'zeta.txt', 'mid.txt', 'alpha.txt']);

    expect(urls.length).toBe(requests);
  });

  it('remembers the sort mode across reopenings', async () => {
    await open();
    setSort('mtime-desc');
    expect(jsdomWindow.localStorage.getItem(SORT_KEY)).toBe('mtime-desc');
    PathPicker.close(false);

    await open();
    expect(sortSelect().value).toBe('mtime-desc');
  });

  it('ignores a corrupt stored mode and a localStorage that throws', async () => {
    jsdomWindow.localStorage.setItem(SORT_KEY, 'bogus');
    await open();
    expect(sortSelect().value).toBe('name-asc');
    PathPicker.close(false);

    const getItem = vi.spyOn(jsdomWindow.localStorage.__proto__, 'getItem').mockImplementation(() => {
      throw new Error('private mode');
    });
    try {
      await open();
      expect(sortSelect().value).toBe('name-asc');
      setSort('mtime-asc');
      expect(names()[0]).toBe('old-dir');
    } finally {
      getItem.mockRestore();
    }
  });

  it('places entries without a modified time after dated ones on a date sort', async () => {
    respond = () =>
      browseResponse([
        { name: 'undated.txt', type: 'file' },
        { name: 'dated.txt', type: 'file', mtimeMs: NOW - DAY },
      ]);
    await open();
    setSort('mtime-desc');
    expect(names()).toEqual(['dated.txt', 'undated.txt']);
    setSort('mtime-asc');
    expect(names()).toEqual(['dated.txt', 'undated.txt']);
  });

  it('shows a compact modified time only when the server supplied one', async () => {
    respond = () =>
      browseResponse([
        { name: 'undated.txt', type: 'file' },
        { name: 'today.txt', type: 'file', mtimeMs: NOW },
      ]);
    await open();
    const rows = Array.from(jsdomDocument.querySelectorAll('.path-picker-item'));
    const meta = (row: Element) => row.querySelector('.path-picker-item-meta')?.textContent ?? null;
    expect(meta(rows[0])).toMatch(/^\d{2}:\d{2}$/);
    expect(meta(rows[1])).toBeNull();
  });

  it('styles the sort control and the modified column', () => {
    expect(stylesCss).toContain('.path-picker-sort {');
    expect(stylesCss).toContain('.path-picker-item-meta {');
  });
});

describe('PathPicker editable path', () => {
  let PathPicker: any;
  let urls: string[];
  let respond: (url: string) => unknown;

  beforeEach(() => {
    jsdomWindow.localStorage.clear();
    jsdomDocument.body.replaceChildren();
    urls = [];
    respond = () => browseResponse(LISTING);
    PathPicker = loadPathPicker(async (url: string) => {
      urls.push(url);
      return respond(url);
    });
  });

  afterEach(() => {
    PathPicker?.close?.(false);
    jsdomDocument.body.replaceChildren();
  });

  const open = async (options: Record<string, unknown> = {}) => {
    PathPicker.open({ onSelect: () => {}, ...options });
    await vi.waitFor(() => expect(jsdomDocument.querySelectorAll('.path-picker-item').length).toBeGreaterThan(0));
  };
  const field = () => jsdomDocument.querySelector('.path-picker-current') as HTMLInputElement;
  const submit = (value: string) => {
    field().value = value;
    (jsdomDocument.querySelector('.path-picker-jump') as HTMLFormElement).dispatchEvent(
      new jsdomWindow.Event('submit', { bubbles: true, cancelable: true })
    );
  };
  const pathParam = (url: string) => new URL(url, 'https://localhost').searchParams.get('path');
  const status = () => jsdomDocument.querySelector('.path-picker-status') as HTMLElement;

  it('shows the current folder in an editable field and jumps on Enter', async () => {
    await open({ initialPath: '/home/dev/project' });
    expect(field().value).toBe('/home/dev/project');
    const before = urls.length;

    // Typing alone never fetches.
    field().value = '/home/dev/oth';
    field().dispatchEvent(new jsdomWindow.Event('input', { bubbles: true }));
    expect(urls.length).toBe(before);

    respond = () => browseResponse([{ name: 'readme.md', type: 'file' }], '/home/dev/other');
    submit('  /home/dev/other  ');
    await vi.waitFor(() => expect(field().value).toBe('/home/dev/other'));
    expect(pathParam(urls[urls.length - 1])).toBe('/home/dev/other');
    expect(jsdomDocument.querySelector('.path-picker-item-name')?.textContent).toBe('readme.md');
  });

  it('keeps the current listing and reports the error when neither a typed path nor its parent resolves', async () => {
    await open({ initialPath: '/home/dev/project' });
    respond = () => errorResponse('Path not found: /home/dev/nope/deeper');
    submit('/home/dev/nope/deeper');
    await vi.waitFor(() => expect(status().classList.contains('error')).toBe(true));
    expect(status().textContent).toBe('Path not found: /home/dev/nope/deeper');
    // One retry on the parent, then stop: never a climb to the root.
    expect(urls.slice(-2).map(pathParam)).toEqual(['/home/dev/nope/deeper', '/home/dev/nope']);
    expect(jsdomDocument.querySelectorAll('.path-picker-item').length).toBe(LISTING.length);
    // The typed text stays in the field so the typo can be corrected in place.
    expect(field().value).toBe('/home/dev/nope/deeper');
  });

  it('lands in the parent folder, unselected, when only the last segment is wrong', async () => {
    await open({ initialPath: '/home/dev' });
    respond = (url) =>
      pathParam(url) === '/home/dev/project/typo.txt'
        ? errorResponse('Path not found: /home/dev/project/typo.txt')
        : browseResponse(LISTING);
    submit('/home/dev/project/typo.txt');
    await vi.waitFor(() => expect(field().value).toBe('/home/dev/project'));
    await vi.waitFor(() => expect(status().classList.contains('error')).toBe(true));
    expect(status().textContent).toBe('Path not found: /home/dev/project/typo.txt');
    expect(jsdomDocument.querySelector('.path-picker-selection-value')?.textContent).toBe('None');
    expect((jsdomDocument.querySelector('.path-picker-confirm') as HTMLButtonElement).disabled).toBe(true);
  });

  it('lands a typed file path in its folder with the file selected', async () => {
    await open({ initialPath: '/home/dev/project' });
    respond = (url) =>
      pathParam(url) === '/home/dev/project/alpha.txt'
        ? errorResponse('Path not found: /home/dev/project/alpha.txt')
        : browseResponse(LISTING);
    submit('/home/dev/project/alpha.txt');
    await vi.waitFor(() =>
      expect(jsdomDocument.querySelector('.path-picker-selection-value')?.textContent).toBe(
        '/home/dev/project/alpha.txt'
      )
    );
    expect(field().value).toBe('/home/dev/project');
    expect(jsdomDocument.querySelector('.path-picker-item.selected .path-picker-item-name')?.textContent).toBe(
      'alpha.txt'
    );
    expect((jsdomDocument.querySelector('.path-picker-confirm') as HTMLButtonElement).disabled).toBe(false);
  });

  it('selects the current folder from the field value and refreshes in place', async () => {
    await open({ initialPath: '/home/dev/project' });
    (jsdomDocument.querySelector('.path-picker-current-select') as HTMLButtonElement).click();
    expect(jsdomDocument.querySelector('.path-picker-selection-value')?.textContent).toBe('/home/dev/project');

    const before = urls.length;
    (jsdomDocument.querySelector('.path-picker-refresh') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(urls.length).toBe(before + 1));
    expect(pathParam(urls[urls.length - 1])).toBe('/home/dev/project');
  });
});
