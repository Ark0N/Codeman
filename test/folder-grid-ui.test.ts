/**
 * @fileoverview Folder grid, client side.
 *
 * - Folder paths are links (`findFilePathLinks` marks them `folder: true`): rooted
 *   and `~/` paths whose last segment has no extension, relative ones only with a
 *   trailing slash. File links win any overlap; prose and URLs stay plain text.
 * - Both consumers route a folder link to `openFolderGrid`.
 * - `openFolderGrid` grants the folder (`POST …/folders`), renders tiles from the
 *   folder's by-name routes, and falls back to the file preview when the server
 *   finds a file there.
 * - A tile's preview renders from the folder routes (never the attachment
 *   registry), pages with ‹ › / ←/→ (wrapping), and the arrows are kept away from
 *   the terminal; "Show folder" opens the grid of a previewed file's folder.
 *
 * Real code under test: constants.js + panels-ui.js in a `vm` context against a
 * stub app and a minimal fake DOM (no jsdom), as in file-preview-detach.test.ts.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const read = (f: string) => readFileSync(resolve(PUBLIC, f), 'utf8');

type Found = { path: string; index: number; folder?: true };
const constants = vm.createContext({});
vm.runInContext(`${read('constants.js')}\nglobalThis.__h = { findFilePathLinks, resolveLinkedFilePath };`, constants, {
  filename: 'constants.js',
});
const { findFilePathLinks, resolveLinkedFilePath } = (
  constants as unknown as {
    __h: { findFilePathLinks: (t: string) => Found[]; resolveLinkedFilePath: (p: string, w?: string) => string };
  }
).__h;
const folders = (text: string) =>
  findFilePathLinks(text)
    .filter((f) => f.folder)
    .map((f) => f.path);

describe('folder links (findFilePathLinks)', () => {
  it('links rooted, ~/ and slash-terminated relative folders', () => {
    expect(folders('post mal /mnt/raid1/neon_getaway/styleframes')).toEqual(['/mnt/raid1/neon_getaway/styleframes']);
    expect(folders('ls ~/repos/neon-menu/assets/')).toEqual(['~/repos/neon-menu/assets/']);
    expect(folders('see builds/captures/ next')).toEqual(['builds/captures/']);
    expect(folders('cd /home/joe/.codeman/app.')).toEqual(['/home/joe/.codeman/app']);
    expect(folders('in (/mnt/raid1/foo), ok')).toEqual(['/mnt/raid1/foo']);
  });

  it('leaves files, prose, bare roots and URLs alone', () => {
    expect(folders('/home/joe/a.png and /home/joe/a.rs')).toEqual([]);
    expect(folders('Node.js and/or foo')).toEqual([]);
    expect(folders('/home/ alone, ~/ alone')).toEqual([]);
    expect(folders('https://x.io/home/joe/dir and http://host/a/')).toEqual([]);
    expect(folders('/etc/nginx is not a link root')).toEqual([]);
  });

  it('keeps the file link where both could match, and orders by position', () => {
    const found = findFilePathLinks('dir /mnt/a/frames then /mnt/a/frames/x.png');
    expect(found.map((f) => [f.path, !!f.folder])).toEqual([
      ['/mnt/a/frames', true],
      ['/mnt/a/frames/x.png', false],
    ]);
  });
});

describe('folder links are routed to the grid', () => {
  it('terminal provider opens folder links in the grid', () => {
    const src = read('terminal-ui.js');
    expect(src).toMatch(/addLink\(found\.path, found\.index, !!found\.folder\)/);
    expect(src).toMatch(/if \(folder\) \{\s*self\.openFolderGrid\(target, sessionId\);/);
  });

  it('response viewer marks folder links and opens them in the grid', () => {
    const src = read('app.js');
    expect(src).toMatch(/if \(folder\) link\.dataset\.folder = '1';/);
    expect(src).toMatch(/pathLink\.dataset\.folder\) this\.openFolderGrid\(/);
  });

  it('ships the grid overlay and the preview buttons', () => {
    const html = read('index.html');
    for (const id of [
      'folderGridOverlay',
      'folderGridTitle',
      'folderGridFolders',
      'folderGridBody',
      'folderGridFooter',
      'folderGridUpBtn',
      'filePreviewPrevBtn',
      'filePreviewNextBtn',
      'filePreviewFolderBtn',
    ]) {
      expect(html, id).toContain(`id="${id}"`);
    }
  });
});

// ---------- panels-ui.js against a stub app ----------

type FakeEl = {
  tagName: string;
  children: FakeEl[];
  textContent: string;
  innerHTML: string;
  className: string;
  dataset: Record<string, string>;
  hidden?: boolean;
  disabled?: boolean;
  title?: string;
  src?: string;
  onclick?: () => void;
  onerror?: () => void;
  classList: { add: (c: string) => void; remove: (c: string) => void; contains: (c: string) => boolean };
  appendChild: (c: FakeEl) => void;
  append: (...c: FakeEl[]) => void;
  querySelector: (sel: string) => FakeEl | null;
  querySelectorAll: (sel: string) => FakeEl[];
  scrollIntoView: () => void;
};

function el(tagName = 'div'): FakeEl {
  const classes = new Set<string>();
  const node: FakeEl = {
    tagName: tagName.toUpperCase(),
    children: [],
    textContent: '',
    className: '',
    dataset: {},
    get innerHTML() {
      return '';
    },
    set innerHTML(_v: string) {
      node.children = [];
    },
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c) || node.className.split(' ').includes(c),
    },
    appendChild: (c) => void node.children.push(c),
    append: (...c) => void node.children.push(...c),
    querySelector: () => null,
    querySelectorAll: () => [],
    scrollIntoView: () => {},
  } as FakeEl;
  return node;
}

function loadApp(fetchImpl: (url: string, init?: { body?: string }) => unknown) {
  const CodemanApp = function CodemanApp(this: unknown) {} as unknown as new () => Record<string, unknown>;
  const keyHandlers: Array<(ev: unknown) => void> = [];
  const context = vm.createContext({
    CodemanApp,
    console: { ...console, warn: vi.fn(), error: vi.fn() },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    escapeHtml: (s: string) => String(s),
    CodemanBase: { base: '', url: (p: string) => p },
    resolveLinkedFilePath,
    document: {
      getElementById: () => null,
      createElement: (t: string) => el(t),
      addEventListener: (type: string, fn: (ev: unknown) => void) => {
        if (type === 'keydown') keyHandlers.push(fn);
      },
    },
    window: { addEventListener: vi.fn(), open: vi.fn() },
    setTimeout,
    clearTimeout,
    confirm: () => true,
    fetch: vi.fn(async (url: string, init?: { body?: string }) => fetchImpl(url, init)),
  });
  vm.runInContext(read('panels-ui.js'), context, { filename: 'panels-ui.js' });

  const previewOverlay = el();
  const gridOverlay = el();
  const previewBody = el();
  const gridBody = el();
  const elements: Record<string, FakeEl> = {
    filePreviewOverlay: previewOverlay,
    filePreviewBody: previewBody,
    filePreviewTitle: el(),
    filePreviewFooter: el(),
    filePreviewDetachBtn: el(),
    filePreviewPrevBtn: Object.assign(el(), { hidden: true }),
    filePreviewNextBtn: Object.assign(el(), { hidden: true }),
    filePreviewFolderBtn: Object.assign(el(), { hidden: true }),
    folderGridOverlay: gridOverlay,
    folderGridTitle: el(),
    folderGridFolders: el(),
    folderGridBody: gridBody,
    folderGridFooter: el(),
    folderGridUpBtn: el(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new CodemanApp() as Record<string, any>;
  app.$ = (id: string) => elements[id] ?? null;
  app._resetFilePreviewEdit = () => {};
  app.showToast = vi.fn();
  app.formatFileSize = (n: number) => `${n} B`;
  app.sessions = new Map([['s1', { workingDir: '/home/joe/wiki' }]]);
  app._registerExternalPreview = vi.fn(async () => ({ attachmentId: 'att-x' }));
  return { app, elements, keyHandlers, fetch: context.fetch as ReturnType<typeof vi.fn> };
}

const LISTING = {
  folderId: 'fld_1',
  path: '/mnt/raid1/styleframes',
  files: [
    { name: 'b.png', extension: 'png', attachmentType: 'image', size: 10, mtimeMs: 2 },
    { name: 'deck.pdf', extension: 'pdf', attachmentType: 'pdf', size: 20, mtimeMs: 1 },
    { name: 'clip.mp4', extension: 'mp4', attachmentType: 'video', size: 30, mtimeMs: 0 },
  ],
  folders: ['old'],
  truncated: false,
};

function ok(data: unknown) {
  return { ok: true, status: 200, json: async () => ({ success: true, data }) };
}

describe('openFolderGrid', () => {
  it('grants the folder and renders a tile per file from the folder routes', async () => {
    const { app, elements, fetch } = loadApp(() => ok(LISTING));
    await app.openFolderGrid('~/styleframes', 's1');

    expect(fetch).toHaveBeenCalledWith('/api/sessions/s1/folders', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ path: '~/styleframes' });
    expect(elements.folderGridOverlay.classList.contains('visible')).toBe(true);
    expect(elements.folderGridTitle.textContent).toBe('/mnt/raid1/styleframes');

    const tiles = elements.folderGridBody.children;
    expect(tiles).toHaveLength(3);
    const thumb = (i: number) => tiles[i].children[0];
    expect(thumb(0).children[0].src).toBe('/api/sessions/s1/folders/fld_1/files/b.png/raw');
    expect(thumb(1).children[0].src).toBe('/api/sessions/s1/folders/fld_1/files/deck.pdf/thumbnail');
    expect(thumb(2).children).toHaveLength(0);
    expect(thumb(2).textContent).toBe('MP4');
    expect(elements.folderGridFolders.children.map((c) => c.textContent)).toEqual(['old/']);
    expect(elements.folderGridFooter.textContent).toBe('3 files • 1 folder');
  });

  it('falls back to the file preview when the path is a file', async () => {
    const { app } = loadApp(() => ({ ok: false, status: 400, json: async () => ({ error: 'Not a folder' }) }));
    app.openFilePreview = vi.fn();
    await app.openFolderGrid('/mnt/raid1/notes', 's1');
    expect(app.openFilePreview).toHaveBeenCalledWith('/mnt/raid1/notes', 's1');
  });

  it('toasts a missing or blocked folder', async () => {
    const { app, elements } = loadApp(() => ({
      ok: false,
      status: 404,
      json: async () => ({ error: 'Folder not found' }),
    }));
    await app.openFolderGrid('/mnt/raid1/gone', 's1');
    expect(app.showToast).toHaveBeenCalledWith(expect.stringContaining('Folder not found'), 'error');
    expect(elements.folderGridOverlay.classList.contains('visible')).toBe(false);
  });
});

describe('folder preview paging', () => {
  async function openGrid() {
    const ctx = loadApp(() => ok(LISTING));
    await ctx.app.openFolderGrid('/mnt/raid1/styleframes', 's1');
    return ctx;
  }

  it('previews a tile from the folder routes, never registering an attachment', async () => {
    const { app, elements } = await openGrid();
    elements.folderGridBody.children[0].onclick?.();
    await Promise.resolve();

    expect(app._registerExternalPreview).not.toHaveBeenCalled();
    expect(app.filePreviewDetachUrl).toBe('/api/sessions/s1/folders/fld_1/files/b.png/raw');
    expect(elements.filePreviewTitle.textContent).toBe('/mnt/raid1/styleframes/b.png');
    expect(elements.filePreviewPrevBtn.hidden).toBe(false);
    expect(elements.filePreviewNextBtn.hidden).toBe(false);
    expect(elements.filePreviewFolderBtn.hidden).toBe(true);
  });

  it('pages with wrap-around and keeps arrow keys away from the terminal', async () => {
    const { app, elements, keyHandlers } = await openGrid();
    elements.folderGridBody.children[0].onclick?.();
    elements.filePreviewOverlay.classList.add('visible');

    app.stepFolderPreview(-1);
    expect(app.folderGrid.index).toBe(2);
    expect(app.filePreviewDetachUrl).toBe('/api/sessions/s1/folders/fld_1/files/clip.mp4/raw');

    const ev = {
      key: 'ArrowRight',
      target: { tagName: 'TEXTAREA', classList: { contains: (c: string) => c === 'xterm-helper-textarea' } },
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    keyHandlers.forEach((h) => h(ev));
    expect(app.folderGrid.index).toBe(0);
    expect(ev.stopPropagation).toHaveBeenCalled();

    const typing = {
      ...ev,
      target: { tagName: 'INPUT', classList: { contains: () => false } },
      stopPropagation: vi.fn(),
    };
    keyHandlers.forEach((h) => h(typing));
    expect(app.folderGrid.index).toBe(0);
    expect(typing.stopPropagation).not.toHaveBeenCalled();
  });

  it('Escape closes the preview first, then the grid', async () => {
    const { app, elements, keyHandlers } = await openGrid();
    elements.folderGridBody.children[1].onclick?.();
    elements.filePreviewOverlay.classList.add('visible');
    const esc = () => ({ key: 'Escape', target: null, preventDefault: vi.fn(), stopPropagation: vi.fn() });

    keyHandlers.forEach((h) => h(esc()));
    expect(elements.filePreviewOverlay.classList.contains('visible')).toBe(false);
    expect(elements.folderGridOverlay.classList.contains('visible')).toBe(true);
    expect(app.folderGrid.index).toBeNull();

    keyHandlers.forEach((h) => h(esc()));
    expect(elements.folderGridOverlay.classList.contains('visible')).toBe(false);
    expect(app.folderGrid).toBeNull();
  });
});

describe('"Show folder" in the preview', () => {
  it('knows the folder of absolute, relative and ~/ paths, not of a bare attachment card', () => {
    const { app } = loadApp(() => ok(LISTING));
    expect(app._previewFolderPath('/mnt/raid1/x/a.png', 's1', null)).toEqual({ dir: '/mnt/raid1/x', sessionId: 's1' });
    expect(app._previewFolderPath('builds/a.png', 's1', null)).toEqual({
      dir: '/home/joe/wiki/builds',
      sessionId: 's1',
    });
    expect(app._previewFolderPath('~/r/a.png', 's1', null)).toEqual({ dir: '~/r', sessionId: 's1' });
    expect(app._previewFolderPath('a.png', 's1', 'att-1')).toBeNull();
  });

  it('shows the button for a previewed file and opens its folder', async () => {
    const { app, elements, fetch } = loadApp(() => ok(LISTING));
    await app.openFilePreview('/mnt/raid1/styleframes/b.png', 's1');
    expect(elements.filePreviewFolderBtn.hidden).toBe(false);
    expect(elements.filePreviewPrevBtn.hidden).toBe(true);

    app.openFolderOfPreview();
    await vi.waitFor(() => expect(elements.folderGridOverlay.classList.contains('visible')).toBe(true));
    expect(JSON.parse(fetch.mock.calls.at(-1)[1].body)).toEqual({ path: '/mnt/raid1/styleframes' });
  });
});
