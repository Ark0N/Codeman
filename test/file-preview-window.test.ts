/**
 * @fileoverview File Viewer window: back/forward between previews, expand, resize.
 *
 * Links between documents open the next file in the same overlay with no way back.
 * Pinned here:
 *   1. jumping between files fills a back/forward list and the buttons reveal,
 *   2. back/forward reopen the right file WITHOUT recording a new entry,
 *   3. opening a file mid-list drops the forward entries,
 *   4. reopening the file already showing (MD/Page toggles) adds nothing,
 *   5. closing the preview clears the list and hides the buttons,
 *   6. unsaved edits ask before leaving,
 *   7. Expand toggles the window class and the pref, and is re-applied on open,
 *   8. the markup carries the buttons and the resize grip,
 *   9. stepping onto a folder-grid page moves the grid's own index with it,
 *  10. Alt+←/→ steps, ignores other chords and text fields, and is swallowed at the ends,
 *  11. the corner grip doubles the pointer delta and clamps the size,
 *  12. phones ignore Expand and the grip (mobile.css).
 *
 * Loaded via `vm` against a stub app, same harness style as file-preview-detach.test.ts.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const panelsJs = readFileSync(resolve(PUBLIC, 'panels-ui.js'), 'utf8');
const indexHtml = readFileSync(resolve(PUBLIC, 'index.html'), 'utf8');

function btn() {
  const attrs: Record<string, string> = {};
  return {
    hidden: true,
    disabled: true,
    title: '',
    setAttribute: (k: string, v: string) => (attrs[k] = v),
    attrs,
  };
}

function loadApp(confirmResult = true) {
  const CodemanApp = function CodemanApp(this: unknown) {} as unknown as new () => Record<string, unknown>;
  const store: Record<string, string> = {};
  const context = vm.createContext({
    CodemanApp,
    console: { ...console, warn: vi.fn(), error: vi.fn() },
    localStorage: {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => (store[k] = v),
      removeItem: () => {},
    },
    escapeHtml: (s: string) => String(s),
    CodemanBase: { base: '', url: (p: string) => p },
    rendersAsPage: () => false,
    document: { getElementById: () => null, addEventListener: vi.fn() },
    window: { addEventListener: vi.fn(), open: vi.fn(), innerWidth: 1000, innerHeight: 800 },
    setTimeout,
    clearTimeout,
    confirm: vi.fn(() => confirmResult),
    fetch: () => {
      throw new Error('fetch not stubbed');
    },
  });
  vm.runInContext(panelsJs, context, { filename: 'panels-ui.js' });

  const winClasses = new Set<string>();
  const windowEl = {
    classList: {
      toggle: (c: string, on: boolean) => (on ? winClasses.add(c) : winClasses.delete(c)),
      contains: (c: string) => winClasses.has(c),
    },
  };
  const overlayClasses = new Set<string>(['visible']);
  const overlay = {
    classList: {
      add: (c: string) => overlayClasses.add(c),
      remove: (c: string) => overlayClasses.delete(c),
      contains: (c: string) => overlayClasses.has(c),
    },
    querySelector: () => windowEl,
  };
  const back = btn();
  const fwd = btn();
  const expand = btn();
  const elements: Record<string, unknown> = {
    filePreviewBody: { innerHTML: '', querySelectorAll: () => [], querySelector: () => null },
    filePreviewOverlay: overlay,
    filePreviewTitle: { textContent: '' },
    filePreviewFooter: { textContent: '' },
    filePreviewDetachBtn: { hidden: true },
    filePreviewBackBtn: back,
    filePreviewForwardBtn: fwd,
    filePreviewExpandBtn: expand,
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const app = new CodemanApp() as Record<string, any>;
  app.$ = (id: string) => elements[id] ?? null;
  app._resetFilePreviewEdit = () => {};
  app._isExternalPreviewPath = () => false;
  app.showToast = vi.fn();
  app.filePreviewContent = '';
  const confirmFn = (context as { confirm: ReturnType<typeof vi.fn> }).confirm;
  const keydown = () => {
    const calls = (context as { document: { addEventListener: ReturnType<typeof vi.fn> } }).document.addEventListener
      .mock.calls;
    return calls.find((c: unknown[]) => c[0] === 'keydown')?.[1] as (ev: unknown) => void;
  };
  return { app, overlay, back, fwd, expand, winClasses, store, confirmFn, elements, overlayClasses, keydown };
}

describe('file viewer back/forward', () => {
  it('stays hidden for one file and reveals once a second one is opened', async () => {
    const { app, back, fwd } = loadApp();
    await app.openFilePreview('/ws/a.pdf', 's1');
    expect(back.hidden).toBe(true);

    await app.openFilePreview('/ws/b.pdf', 's1');
    expect(back.hidden).toBe(false);
    expect(back.disabled).toBe(false);
    expect(fwd.hidden).toBe(false);
    expect(fwd.disabled).toBe(true);
  });

  it('steps back and forward without recording the step as a new entry', async () => {
    const { app, back, fwd } = loadApp();
    await app.openFilePreview('/ws/a.pdf', 's1');
    await app.openFilePreview('/ws/b.pdf', 's1');
    await app.openFilePreview('/ws/c.pdf', 's1');

    await app.stepFilePreviewHistory(-1);
    expect(app.filePreviewHistory.entries.map((e: { filePath: string }) => e.filePath)).toEqual([
      '/ws/a.pdf',
      '/ws/b.pdf',
      '/ws/c.pdf',
    ]);
    expect(app.filePreviewHistory.index).toBe(1);
    expect(app.filePreviewDetachUrl).toContain(encodeURIComponent('/ws/b.pdf'));
    expect(fwd.disabled).toBe(false);

    await app.stepFilePreviewHistory(-1);
    expect(back.disabled).toBe(true);
    await app.stepFilePreviewHistory(-1); // at the start: a no-op
    expect(app.filePreviewHistory.index).toBe(0);

    await app.stepFilePreviewHistory(1);
    expect(app.filePreviewHistory.index).toBe(1);
  });

  it('drops the forward entries when a new file is opened mid-list', async () => {
    const { app } = loadApp();
    await app.openFilePreview('/ws/a.pdf', 's1');
    await app.openFilePreview('/ws/b.pdf', 's1');
    await app.stepFilePreviewHistory(-1);
    await app.openFilePreview('/ws/c.pdf', 's1');

    expect(app.filePreviewHistory.entries.map((e: { filePath: string }) => e.filePath)).toEqual([
      '/ws/a.pdf',
      '/ws/c.pdf',
    ]);
    expect(app.filePreviewHistory.index).toBe(1);
  });

  it('does not add an entry when the file already showing is reopened', async () => {
    const { app } = loadApp();
    await app.openFilePreview('/ws/a.pdf', 's1');
    await app.openFilePreview('/ws/a.pdf', 's1');
    expect(app.filePreviewHistory.entries).toHaveLength(1);
  });

  it('clears the list and hides the buttons on close', async () => {
    const { app, back, fwd } = loadApp();
    await app.openFilePreview('/ws/a.pdf', 's1');
    await app.openFilePreview('/ws/b.pdf', 's1');
    app.closeFilePreview();

    expect(app.filePreviewHistory).toBeNull();
    expect(back.hidden).toBe(true);
    expect(fwd.hidden).toBe(true);
  });

  it('asks before leaving unsaved edits and stays put when declined', async () => {
    const { app, confirmFn } = loadApp(false);
    await app.openFilePreview('/ws/a.pdf', 's1');
    await app.openFilePreview('/ws/b.pdf', 's1');
    app.filePreviewEdit = { dirty: true };

    await app.stepFilePreviewHistory(-1);

    expect(confirmFn).toHaveBeenCalled();
    expect(app.filePreviewHistory.index).toBe(1);
  });
});

describe('file viewer expand', () => {
  it('toggles the window class, the pref and the button state', () => {
    const { app, winClasses, store, expand } = loadApp();
    // As index.html ships it.
    expand.title = 'Expand';
    expand.attrs['aria-label'] = 'Expand';

    app.toggleFilePreviewExpanded();
    expect(winClasses.has('expanded')).toBe(true);
    expect(store['codeman:filePreviewExpanded']).toBe('1');
    expect(expand.attrs['aria-pressed']).toBe('true');
    // aria-pressed carries the state; the label stays fixed, like the MD/Lines/Wrap toggles.
    expect(expand.title).toBe('Expand');
    expect(expand.attrs['aria-label']).toBe('Expand');

    app.toggleFilePreviewExpanded();
    expect(winClasses.has('expanded')).toBe(false);
    expect(expand.attrs['aria-pressed']).toBe('false');
    expect(expand.title).toBe('Expand');
  });

  it('re-applies a remembered expanded state when a preview opens', async () => {
    const { app, winClasses, store } = loadApp();
    store['codeman:filePreviewExpanded'] = '1';

    await app.openFilePreview('/ws/a.pdf', 's1');

    expect(winClasses.has('expanded')).toBe(true);
  });
});

describe('file viewer window markup', () => {
  it('carries the back, forward and expand buttons and the resize grip', () => {
    for (const id of ['filePreviewBackBtn', 'filePreviewForwardBtn', 'filePreviewExpandBtn', 'filePreviewResize']) {
      expect(indexHtml).toContain(`id="${id}"`);
    }
    expect(indexHtml).toContain('app.stepFilePreviewHistory(-1)');
    expect(indexHtml).toContain('app.stepFilePreviewHistory(1)');
  });
});

describe('file viewer folder paging in the history', () => {
  it('moves the grid index with a back step, so the next page continues from there', async () => {
    const { app } = loadApp();
    const names = ['a', 'b', 'c', 'd'].map((n) => ({ name: `${n}.pdf`, size: 1 }));
    app.folderGrid = {
      folderId: 'f1',
      path: '/ws',
      sessionId: 's1',
      files: names,
      folders: [],
      index: null,
      lastIndex: null,
    };
    app._openFolderGridFile(0);
    app._openFolderGridFile(1);
    app._openFolderGridFile(2);

    await app.stepFilePreviewHistory(-1);
    expect(app.folderGrid.index).toBe(1);
    expect(app.folderGrid.lastIndex).toBe(1);

    app.stepFolderPreview(1);
    const paths = app.filePreviewHistory.entries.map((e: { filePath: string }) => e.filePath);
    expect(paths).toEqual(['/ws/a.pdf', '/ws/b.pdf', '/ws/c.pdf']);
    expect(app.folderGrid.index).toBe(2);
  });

  it('falls back to a plain open when the entry is from another folder', async () => {
    const { app } = loadApp();
    app.folderGrid = {
      folderId: 'f1',
      path: '/ws',
      sessionId: 's1',
      files: [{ name: 'a.pdf', size: 1 }],
      folders: [],
      index: 0,
      lastIndex: 0,
    };
    await app.openFilePreview('/other/x.pdf', 's1', null, { folderFile: { folderId: 'f2', name: 'x.pdf' } });
    await app.openFilePreview('/ws/y.pdf', 's1');
    await app.stepFilePreviewHistory(-1);
    expect(app.filePreviewHistory.index).toBe(0);
    expect(app.filePreviewHistory.entries).toHaveLength(2);
  });
});

describe('file viewer Alt+arrow chord', () => {
  const key = (over: Record<string, unknown> = {}) => ({
    altKey: true,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    key: 'ArrowLeft',
    target: { tagName: 'DIV' },
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    ...over,
  });

  async function setup() {
    const h = loadApp();
    await h.app.openFilePreview('/ws/a.pdf', 's1');
    await h.app.openFilePreview('/ws/b.pdf', 's1');
    h.app._bindFilePreviewChrome();
    const step = vi.spyOn(h.app, 'stepFilePreviewHistory');
    return { ...h, step, fire: h.keydown() };
  }

  it('steps back and forward and swallows the chord', async () => {
    const { fire, step } = await setup();
    const ev = key();
    fire(ev);
    expect(step).toHaveBeenCalledWith(-1);
    expect(ev.preventDefault).toHaveBeenCalled();
    expect(ev.stopPropagation).toHaveBeenCalled();
  });

  it('swallows the chord at the ends of the list without stepping', async () => {
    const { fire, step } = await setup();
    const fwd = key({ key: 'ArrowRight' }); // already at the newest entry
    fire(fwd);
    expect(step).not.toHaveBeenCalled();
    expect(fwd.preventDefault).toHaveBeenCalled();
    expect(fwd.stopPropagation).toHaveBeenCalled();
  });

  it.each([
    ['a plain arrow', { altKey: false }],
    ['Shift+Alt', { shiftKey: true }],
    ['Ctrl+Alt', { ctrlKey: true }],
    ['another key', { key: 'ArrowUp' }],
    ['a textarea target', { target: { tagName: 'TEXTAREA', classList: { contains: () => false } } }],
  ])('leaves %s alone', async (_name, over) => {
    const { fire, step } = await setup();
    const ev = key(over);
    fire(ev);
    expect(step).not.toHaveBeenCalled();
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });

  it('leaves the chord alone while the overlay is hidden', async () => {
    const { fire, step, overlayClasses } = await setup();
    overlayClasses.delete('visible');
    const ev = key();
    fire(ev);
    expect(step).not.toHaveBeenCalled();
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });
});

describe('file viewer resize grip', () => {
  function drag(to: [number, number], button = 0) {
    const { app, elements } = loadApp();
    const listeners: Record<string, (e: unknown) => void> = {};
    const win = { offsetWidth: 400, offsetHeight: 300, style: {} as Record<string, string> };
    elements.filePreviewResize = {
      parentElement: win,
      setPointerCapture: () => {},
      addEventListener: (t: string, fn: (e: unknown) => void) => (listeners[t] = fn),
      removeEventListener: () => {},
    };
    app._bindFilePreviewResize();
    listeners.pointerdown({ preventDefault: () => {}, clientX: 100, clientY: 100, pointerId: 1, button });
    if (!listeners.pointermove) return win.style; // a refused pointerdown binds no move handler
    listeners.pointermove({ clientX: 100 + to[0], clientY: 100 + to[1] });
    return win.style;
  }

  it('ignores a pointerdown that is not the primary button', () => {
    expect(drag([100, 50], 2)).toEqual({});
  });

  it('doubles the pointer delta, because the window is centred', () => {
    expect(drag([100, 50])).toMatchObject({ width: '600px', height: '400px' });
  });

  it('clamps to the minimum and to 96% x 94% of the viewport', () => {
    expect(drag([-500, -500])).toMatchObject({ width: '320px', height: '240px' });
    expect(drag([900, 900])).toMatchObject({ width: '960px', height: '752px' });
  });
});

describe('file viewer on phones', () => {
  it('overrides Expand and any dragged size, and hides both controls, under 600px', () => {
    const css = readFileSync(resolve(PUBLIC, 'mobile.css'), 'utf8');
    const phone = css.slice(css.indexOf('@media (max-width: 599px)'));
    expect(phone).toMatch(
      /\.file-preview-window,\s*\.file-preview-window\.expanded\s*\{[^}]*width: 100vw !important;[^}]*height: var\(--app-height, 100vh\) !important;/
    );
    expect(phone).toMatch(/#filePreviewExpandBtn,\s*\.file-preview-resize\s*\{\s*display: none;/);
  });
});
