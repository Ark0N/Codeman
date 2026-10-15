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
 *   8. the markup carries the buttons and the resize grip.
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
    window: { addEventListener: vi.fn(), open: vi.fn() },
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
  return { app, overlay, back, fwd, expand, winClasses, store, confirmFn };
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

    app.toggleFilePreviewExpanded();
    expect(winClasses.has('expanded')).toBe(true);
    expect(store['codeman:filePreviewExpanded']).toBe('1');
    expect(expand.attrs['aria-pressed']).toBe('true');
    expect(expand.title).toBe('Restore size');

    app.toggleFilePreviewExpanded();
    expect(winClasses.has('expanded')).toBe(false);
    expect(expand.attrs['aria-pressed']).toBe('false');
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
