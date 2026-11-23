/**
 * @fileoverview Issue #759 lazy Files panel acceptance tests.
 *
 * The actual index.html panel (including inline search/header bindings) and panels-ui.js run in
 * jsdom. Only HTTP is faked: clicks, input and Enter traverse the shipped DOM handlers. This is
 * gate-runnable behavior coverage, not source-string assertions or a duplicate tree algorithm.
 * Playwright layout verification lives in mobile/file-browser.test.ts; these tests need no server.
 *
 * The lazy wire additions are shared with routes/file-routes-lazy.test.ts: lazy=true,
 * immediate children in tree, opaque nextCursor/cursor, and absent children means unloaded.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const INDEX = readFileSync(resolve(PUBLIC, 'index.html'), 'utf8');
const PANELS = readFileSync(resolve(PUBLIC, 'panels-ui.js'), 'utf8');

interface Entry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  extension?: string;
  children?: Entry[];
}
const folder = (path: string): Entry => ({ name: path.split('/').pop()!, path, type: 'directory' });
const file = (path: string): Entry => ({
  name: path.split('/').pop()!,
  path,
  type: 'file',
  size: 1,
  extension: 'ts',
});
const response = (data: unknown, ok = true) => ({
  ok,
  status: ok ? 200 : 503,
  json: async () => (ok ? { success: true, data } : { success: false, error: 'Folder unavailable' }),
});
const page = (tree: Entry[], nextCursor?: string, root = '/repo') =>
  response({
    root,
    lazy: true,
    tree,
    nextCursor,
    totalFiles: tree.filter((entry) => entry.type === 'file').length,
    totalDirectories: tree.filter((entry) => entry.type === 'directory').length,
    truncated: Boolean(nextCursor),
  });
const search = (matches: Entry[], truncated = false) =>
  response({
    root: '/repo',
    mode: 'search',
    tree: [],
    query: 'needle',
    matches,
    matchCount: matches.length,
    totalScanned: 10,
    truncated,
  });
type Response = ReturnType<typeof response>;
type Responder = (url: URL) => Response | Promise<Response>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function loadPanel() {
  const source = new JSDOM(INDEX);
  const panel = source.window.document.getElementById('fileBrowserPanel');
  if (!panel) throw new Error('Shipped Files panel is missing');
  const markup = panel.outerHTML;
  source.window.close();
  const dom = new JSDOM(markup, { url: 'http://localhost/', runScripts: 'dangerously' });
  const context = dom.getInternalVMContext();
  Object.assign(context, {
    console: { ...console, error: vi.fn() },
    setTimeout,
    clearTimeout,
    CodemanBase: { url: (path: string) => path },
    escapeHtml: (value: unknown) =>
      String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;'),
  });
  vm.runInContext('class CodemanApp {}', context);
  vm.runInContext(PANELS, context, { filename: 'panels-ui.js' });
  const app = vm.runInContext('new CodemanApp()', context) as Record<string, any>;
  const document = dom.window.document;
  app.$ = (id: string) => document.getElementById(id);
  app.activeSessionId = 'sess-A';
  app.fileBrowserData = null;
  app.fileBrowserExpandedDirs = new Set<string>();
  app.fileBrowserFilter = '';
  app.fileBrowserAllExpanded = false;
  app.fileBrowserShowHidden = false;
  app.getFileIcon = () => '';
  app.formatFileSize = () => '';
  app.openFilePreview = vi.fn();
  app.showToast = vi.fn();
  context.app = app;
  document.getElementById('fileBrowserPanel')!.classList.add('visible');

  const requests: URL[] = [];
  const server = {
    respond: ((url: URL) => {
      if (url.searchParams.has('q')) return search([folder('src/deep'), file('src/deep/needle.ts')]);
      switch (url.searchParams.get('path')) {
        case 'src':
          return page([folder('src/deep'), file('src/visible.ts')]);
        case 'src/deep':
          return page([file('src/deep/needle.ts')]);
        case 'empty':
          return page([]);
        default:
          return page([folder('empty'), folder('src'), file('README.md')]);
      }
    }) as Responder,
  };
  context.fetch = (input: string) => {
    const url = new URL(input, 'http://localhost/');
    requests.push(url);
    return Promise.resolve(server.respond(url));
  };
  const tree = document.getElementById('fileBrowserTree')!;
  const input = document.getElementById('fileBrowserSearch') as HTMLInputElement;
  const rows = () => [...tree.querySelectorAll<HTMLElement>('.file-tree-item')];
  const paths = () => rows().map((row) => row.dataset.path);
  const clickFolder = (path: string) => {
    const row = rows().find((item) => item.dataset.path === path);
    expect(row, `Missing folder row: ${path}`).toBeDefined();
    expect(row!.dataset.type).toBe('directory');
    row!.click();
  };
  const clickButton = (name: RegExp, within: Element = tree) => {
    const button = [...within.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
      name.test([item.textContent, item.getAttribute('aria-label'), item.title].join(' '))
    );
    expect(button, `Missing button: ${name}`).toBeDefined();
    expect(button!.disabled).toBe(false);
    button!.click();
  };
  const type = (value: string) => {
    input.value = value;
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  const enter = () =>
    input.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true,
      })
    );
  return { dom, app, document, tree, input, requests, server, paths, clickFolder, clickButton, type, enter };
}
type Panel = ReturnType<typeof loadPanel>;
const settle = () => vi.advanceTimersByTimeAsync(300);

describe('Files panel lazy browsing behavior (#759)', () => {
  let ui: Panel;
  beforeEach(() => {
    vi.useFakeTimers();
    ui = loadPanel();
  });
  afterEach(() => {
    ui.dom.window.close();
    vi.clearAllTimers();
    vi.useRealTimers();
  });
  const open = () => ui.app.loadFileBrowser('sess-A');
  const expand = async (path: string) => {
    ui.clickFolder(path);
    await settle();
  };
  const runSearch = async (value = 'needle') => {
    ui.type(value);
    ui.enter();
    await settle();
  };

  it('opens with one lazy root request and renders all returned root entries', async () => {
    await open();
    expect(ui.requests).toHaveLength(1);
    expect(ui.requests[0].searchParams.get('lazy')).toBe('1');
    expect(ui.requests[0].searchParams.get('root')).toBe('live-any');
    expect(ui.requests[0].searchParams.get('showHidden')).toBe('false');
    expect(ui.paths()).toEqual(['empty', 'src', 'README.md']);
    expect(ui.tree.textContent).not.toMatch(/empty folder|no files in/i);
  });

  it('loads just the expanded folder and reuses its children on collapse/reopen', async () => {
    await open();
    await expand('src');
    expect(ui.requests).toHaveLength(2);
    expect(ui.requests[1].searchParams.get('path')).toBe('src');
    expect(ui.requests[1].searchParams.get('lazy')).toBe('1');
    expect(ui.paths()).toContain('src/visible.ts');
    expect(ui.paths()).not.toContain('src/deep/needle.ts');
    await expand('src');
    expect(ui.paths()).not.toContain('src/visible.ts');
    await expand('src');
    expect(ui.paths()).toContain('src/visible.ts');
    expect(ui.requests).toHaveLength(2);
  });

  it('keeps indenting folder contents beyond the legacy recursive tree depth', async () => {
    ui.server.respond = (url) => {
      const path = url.searchParams.get('path');
      const depth = path ? path.split('/').length : 0;
      return page(depth < 11 ? [folder(`${path ? `${path}/` : ''}level-${depth}`)] : [file(`${path}/bottom.ts`)]);
    };
    await open();
    let path = '';
    for (let depth = 0; depth < 11; depth++) {
      path = `${path ? `${path}/` : ''}level-${depth}`;
      await expand(path);
    }
    const row = ui.tree.querySelector<HTMLElement>('[data-depth="11"]');
    expect(row?.dataset.path).toBe(`${path}/bottom.ts`);
    expect(row?.style.paddingInlineStart).toBe('8.75rem');
  });

  it('does not duplicate an unfinished folder request when rapidly reopened', async () => {
    await open();
    const pending = deferred<Response>();
    ui.server.respond = () => pending.promise;
    await expand('src');
    await expand('src');
    await expand('src');
    expect(ui.requests).toHaveLength(2);
    pending.resolve(page([file('src/visible.ts')]));
    await settle();
    expect(ui.paths()).toContain('src/visible.ts');
  });

  it('shows a completed empty folder differently from an unloaded or failed folder', async () => {
    await open();
    await expand('empty');
    expect(ui.requests.at(-1)!.searchParams.get('path')).toBe('empty');
    // Remove file/folder names: the folder named "empty" must not satisfy this assertion itself.
    const messages = ui.tree.cloneNode(true) as HTMLElement;
    messages.querySelectorAll('.file-tree-item').forEach((row) => row.remove());
    expect(messages.textContent).toMatch(/empty|no files/i);
    expect([...ui.tree.querySelectorAll('button')].some((button) => /retry/i.test(button.textContent!))).toBe(false);
    await expand('empty');
    await expand('empty');
    expect(ui.requests).toHaveLength(2);
  });

  it.each(['root', 'folder'])(
    'appends %s pages through Load more without refetching unrelated folders',
    async (where) => {
      ui.server.respond = (url) => {
        const path = url.searchParams.get('path');
        const cursor = url.searchParams.get('cursor');
        if (where === 'folder' && !path) return page([folder('src'), folder('untouched')]);
        const prefix = where === 'folder' ? 'src/' : '';
        return cursor ? page([file(`${prefix}second.ts`)]) : page([file(`${prefix}first.ts`)], 'page-two');
      };
      await open();
      if (where === 'folder') await expand('src');
      const before = ui.requests.length;
      ui.clickButton(/load more/i);
      await settle();
      expect(ui.requests).toHaveLength(before + 1);
      expect(ui.requests.at(-1)!.searchParams.get('cursor')).toBe('page-two');
      expect(ui.requests.at(-1)!.searchParams.get('path') ?? '').toBe(where === 'folder' ? 'src' : '');
      const prefix = where === 'folder' ? 'src/' : '';
      expect(ui.paths()).toContain(`${prefix}first.ts`);
      expect(ui.paths()).toContain(`${prefix}second.ts`);
      expect(new Set(ui.paths()).size).toBe(ui.paths().length);
      expect([...ui.tree.querySelectorAll('button')].some((button) => /load more/i.test(button.textContent!))).toBe(
        false
      );
      expect(ui.requests.some((url) => url.searchParams.get('path') === 'untouched')).toBe(false);
    }
  );

  it('keeps previously loaded entries when the next page fails, and retries that page only', async () => {
    let fail = true;
    ui.server.respond = (url) => {
      if (!url.searchParams.has('path')) return page([folder('src')]);
      if (!url.searchParams.has('cursor')) return page([file('src/first.ts')], 'page-two');
      return fail ? response(null, false) : page([file('src/second.ts')]);
    };
    await open();
    await expand('src');
    ui.clickButton(/load more/i);
    await settle();
    expect(ui.paths()).toContain('src/first.ts');
    expect(ui.tree.textContent).toMatch(/unavailable|failed|incomplete|could not/i);
    fail = false;
    const before = ui.requests.length;
    ui.clickButton(/retry/i);
    await settle();
    expect(ui.requests).toHaveLength(before + 1);
    expect(ui.requests.at(-1)!.searchParams.get('cursor')).toBe('page-two');
    expect(ui.paths()).toContain('src/first.ts');
    expect(ui.paths()).toContain('src/second.ts');
  });

  it('offers a folder-local Retry without automatically refreshing the tree', async () => {
    await open();
    ui.server.respond = () => response(null, false);
    await expand('src');
    expect(ui.requests).toHaveLength(2);
    expect(ui.paths()).toContain('README.md');
    expect(ui.tree.textContent).toMatch(/unavailable|failed|could not/i);
    ui.server.respond = () => page([file('src/recovered.ts')]);
    ui.clickButton(/retry/i);
    await settle();
    expect(ui.requests).toHaveLength(3);
    expect(ui.requests.at(-1)!.searchParams.get('path')).toBe('src');
    expect(ui.paths()).toContain('src/recovered.ts');
  });

  it('does not retry a failed sibling when another folder loads successfully', async () => {
    let fail = true;
    ui.server.respond = (url) => {
      const path = url.searchParams.get('path');
      if (!path) return page([folder('bad'), folder('good')]);
      if (path === 'bad' && fail) return response(null, false);
      return page([file(`${path}/note.ts`)]);
    };
    await open();
    await expand('bad');
    await expand('good');
    expect(ui.requests.map((url) => url.searchParams.get('path') ?? '')).toEqual(['', 'bad', 'good']);
    expect(ui.paths()).toContain('good/note.ts');
    fail = false;
    ui.clickButton(/retry/i);
    await settle();
    expect(ui.requests.map((url) => url.searchParams.get('path') ?? '')).toEqual(['', 'bad', 'good', 'bad']);
    expect(ui.paths()).toContain('bad/note.ts');
    expect(ui.paths()).toContain('good/note.ts');
  });

  it('does not retry a failed root page during an unrelated folder expansion', async () => {
    let refreshed = false;
    let fail = true;
    ui.server.respond = (url) => {
      const path = url.searchParams.get('path');
      if (path) return page([file(`${path}/note.ts`)]);
      if (!refreshed) return page([folder('good'), folder('later')]);
      if (url.searchParams.has('cursor')) return fail ? response(null, false) : page([folder('later')]);
      return page([folder('good')], 'two');
    };
    await open();
    await expand('later');
    refreshed = true;
    await ui.app.refreshFileBrowser(); // Restoring "later" reaches a failed root page.
    const before = ui.requests.length;
    await expand('good');
    expect(ui.requests.slice(before).map((url) => url.searchParams.get('path') ?? '')).toEqual(['good']);
    fail = false;
    ui.clickButton(/retry/i);
    await settle();
    expect(ui.requests.slice(before).map((url) => url.searchParams.get('path') ?? '')).toEqual(['good', '', 'later']);
    expect(ui.paths()).toContain('later/note.ts');
    expect(ui.paths()).toContain('good/note.ts');
  });

  it('Expand All opens loaded directories without fetching unloaded descendants', async () => {
    await open();
    await expand('src');
    await expand('src'); // Loaded, but collapsed again.
    const before = ui.requests.length;
    ui.clickButton(/expand\/collapse/i, ui.document.getElementById('fileBrowserPanel')!);
    await settle();
    expect(ui.paths()).toContain('src/visible.ts');
    expect(ui.requests).toHaveLength(before);
    expect(ui.app.fileBrowserExpandedDirs.has('src/deep')).toBe(false);
  });

  it('typing filters loaded files locally and never sends a request, even after the old debounce', async () => {
    await open();
    await expand('src');
    const before = ui.requests.length;
    ui.type('visible');
    await settle();
    expect(ui.requests).toHaveLength(before);
    expect(ui.paths()).toContain('src/visible.ts');
    expect(ui.paths()).not.toContain('README.md');
    expect(ui.document.getElementById('fileBrowserStatus')!.textContent).toMatch(/loaded/i);
  });

  it('Enter searches the whole workspace, including unopened folders', async () => {
    await open();
    ui.type('  needle  ');
    await settle();
    expect(ui.requests).toHaveLength(1);
    ui.enter();
    await settle();
    expect(ui.requests).toHaveLength(2);
    const request = ui.requests.at(-1)!;
    expect(request.searchParams.get('q')).toBe('needle');
    expect(request.searchParams.get('lazy')).not.toBe('1');
    expect(request.searchParams.get('root')).toBe('live-any');
    expect(ui.paths()).toContain('src/deep/needle.ts');
  });

  it('labels an incomplete zero-hit search instead of displaying an unqualified No matches', async () => {
    await open();
    ui.server.respond = () => search([], true);
    await runSearch();
    const message = `${ui.tree.textContent} ${ui.document.getElementById('fileBrowserStatus')!.textContent}`;
    expect(message).toMatch(/incomplete|truncated|not fully/i);
    expect(ui.tree.textContent!.trim()).not.toBe('No matches');
  });

  it('clearing search restores expanded folders and all loaded pages without network activity', async () => {
    ui.server.respond = (url) => {
      if (url.searchParams.has('q')) return search([file('elsewhere/needle.ts')]);
      if (!url.searchParams.has('path')) return page([folder('src'), file('README.md')]);
      return url.searchParams.has('cursor') ? page([file('src/second.ts')]) : page([file('src/first.ts')], 'page-two');
    };
    await open();
    await expand('src');
    ui.clickButton(/load more/i);
    await settle();
    const previous = ui.paths();
    await runSearch();
    expect(ui.paths()).toContain('elsewhere/needle.ts');
    const before = ui.requests.length;
    ui.type('');
    await settle();
    expect(ui.paths()).toEqual(previous);
    expect(ui.app.fileBrowserExpandedDirs.has('src')).toBe(true);
    expect(ui.requests).toHaveLength(before);
  });

  it('reveals a search-result folder by loading its ancestors and then its contents', async () => {
    await open();
    await runSearch();
    ui.clickFolder('src/deep');
    await settle();
    expect(
      ui.requests.filter((url) => url.searchParams.has('path')).map((url) => url.searchParams.get('path'))
    ).toEqual(['src', 'src/deep']);
    expect(ui.input.value).toBe('');
    expect(ui.paths()).toContain('src/deep/needle.ts');
    expect(ui.app.fileBrowserExpandedDirs.has('src')).toBe(true);
    expect(ui.app.fileBrowserExpandedDirs.has('src/deep')).toBe(true);
  });

  it('can reveal a search-result ancestor on a later root page', async () => {
    const original = ui.server.respond;
    ui.server.respond = (url) => {
      if (url.searchParams.has('q') || url.searchParams.has('path')) return original(url);
      return url.searchParams.has('cursor') ? page([folder('src')]) : page([folder('empty')], 'root-two');
    };
    await open();
    await runSearch();
    ui.clickFolder('src/deep');
    await settle();
    expect(ui.requests.some((url) => url.searchParams.get('cursor') === 'root-two')).toBe(true);
    expect(ui.paths()).toContain('src/deep/needle.ts');
  });

  it('hidden toggles add entries and reload expanded folders without collapsing them', async () => {
    await open();
    await expand('src');
    ui.server.respond = (url) =>
      url.searchParams.has('path')
        ? page([file('src/.hidden.ts'), file('src/visible.ts')])
        : page([folder('empty'), folder('src'), file('.env'), file('README.md')]);
    ui.clickButton(/show hidden/i, ui.document.getElementById('fileBrowserPanel')!);
    await settle();
    expect(ui.app.fileBrowserExpandedDirs.has('src')).toBe(true);
    expect(ui.paths()).toContain('README.md');
    expect(ui.paths()).toContain('.env');
    expect(ui.paths()).toContain('src/visible.ts');
    expect(ui.paths()).toContain('src/.hidden.ts');
    expect(ui.requests.slice(2).every((url) => url.searchParams.get('showHidden') === 'true')).toBe(true);
    expect(ui.requests.slice(2).map((url) => url.searchParams.get('path') ?? '')).toEqual(['', 'src']);
  });

  it('does not drain root pages trying to restore a hidden folder after hiding it', async () => {
    ui.app.fileBrowserShowHidden = true;
    ui.server.respond = (url) => {
      if (url.searchParams.get('path') === '.hidden') return page([file('.hidden/note.ts')]);
      if (url.searchParams.get('showHidden') === 'true') return page([folder('.hidden'), file('a.ts')]);
      if (url.searchParams.get('cursor') === 'two') return page([file('b.ts')], 'three');
      if (url.searchParams.get('cursor') === 'three') return page([file('c.ts')]);
      return page([file('a.ts')], 'two');
    };
    await open();
    await expand('.hidden');
    const before = ui.requests.length;
    await ui.app.toggleFileBrowserHidden();
    await settle();
    expect(ui.requests.slice(before).map((url) => url.searchParams.get('cursor') ?? '')).toEqual(['']);
    expect(ui.paths()).toEqual(['a.ts']);
    expect(ui.tree.querySelector('[data-file-browser-load="more"]')).not.toBeNull();
  });

  it('restores visible folders under a dotted worktree prefix with hidden files off', async () => {
    const prefix = '.claude/worktrees/feature';
    const root = `/repo/${prefix}`;
    ui.server.respond = (url) =>
      url.searchParams.has('path')
        ? page([file(`${prefix}/src/note.ts`)], undefined, root)
        : page([folder(`${prefix}/src`)], undefined, root);
    await open();
    await expand(`${prefix}/src`);
    const before = ui.requests.length;
    await ui.app.refreshFileBrowser();
    expect(ui.requests.slice(before).map((url) => url.searchParams.get('path') ?? '')).toEqual(['', `${prefix}/src`]);
    expect(ui.paths()).toContain(`${prefix}/src/note.ts`);
  });

  it('Refresh reloads root and expanded folders, preserves expansion and leaves collapsed folders alone', async () => {
    await open();
    await expand('src');
    const before = ui.requests.length;
    ui.server.respond = (url) =>
      url.searchParams.has('path')
        ? page([file('src/current.ts')])
        : page([folder('empty'), folder('src'), file('NEW.md')]);
    ui.clickButton(/refresh/i, ui.document.getElementById('fileBrowserPanel')!);
    await settle();
    expect(ui.requests.slice(before).map((url) => url.searchParams.get('path') ?? '')).toEqual(['', 'src']);
    expect(ui.app.fileBrowserExpandedDirs.has('src')).toBe(true);
    expect(ui.paths()).toContain('src/current.ts');
    expect(ui.paths()).toContain('NEW.md');
    expect(ui.paths()).not.toContain('src/visible.ts');
  });

  it('refreshes no subtree behind a collapsed parent, then restores its expanded child on reopen', async () => {
    await open();
    await expand('src');
    await expand('src/deep');
    await expand('src'); // Collapse the parent, retaining the child expansion preference.
    const before = ui.requests.length;
    await ui.app.refreshFileBrowser();
    expect(ui.requests.slice(before).map((url) => url.searchParams.get('path') ?? '')).toEqual(['']);
    expect(ui.app.fileBrowserExpandedDirs.has('src/deep')).toBe(true);
    expect(ui.paths()).not.toContain('src/deep/needle.ts');
    await expand('src');
    expect(ui.requests.slice(before).map((url) => url.searchParams.get('path') ?? '')).toEqual(['', 'src', 'src/deep']);
    expect(ui.paths()).toContain('src/deep/needle.ts');
  });

  it('preserves a local filter across a hidden toggle without silently starting whole-workspace search', async () => {
    await open();
    await expand('src');
    ui.type('visible');
    await settle();
    const original = ui.server.respond;
    ui.server.respond = (url) =>
      url.searchParams.get('path') === 'src' ? page([file('src/.visible.ts'), file('src/visible.ts')]) : original(url);
    const before = ui.requests.length;
    ui.clickButton(/show hidden/i, ui.document.getElementById('fileBrowserPanel')!);
    await settle();
    expect(ui.input.value).toBe('visible');
    expect(ui.paths()).toContain('src/.visible.ts');
    expect(ui.paths()).toContain('src/visible.ts');
    expect(ui.paths()).not.toContain('README.md');
    expect(ui.requests.slice(before).every((url) => !url.searchParams.has('q'))).toBe(true);
  });

  it('rejects a page completion invalidated by Refresh instead of appending it to the new tree', async () => {
    const pending = deferred<Response>();
    ui.server.respond = (url) =>
      url.searchParams.has('cursor') ? pending.promise : page([file('before.ts')], 'root-two');
    await open();
    ui.clickButton(/load more/i);
    await settle();
    expect(ui.requests.at(-1)!.searchParams.get('cursor')).toBe('root-two');
    ui.server.respond = () => page([file('current.ts')]);
    ui.app.refreshFileBrowser();
    await settle();
    pending.resolve(page([file('STALE.ts')]));
    await settle();
    expect(ui.paths()).toEqual(['current.ts']);
    expect(JSON.stringify(ui.app.fileBrowserData)).not.toContain('STALE.ts');
  });

  it.each(['refresh', 'hidden', 'session', 'hide', 'root'])(
    'drops a late folder response after %s changes the browsing context',
    async (change) => {
      await open();
      const pending = deferred<Response>();
      const original = ui.server.respond;
      let intercepted = false;
      ui.server.respond = (url) => {
        if (!intercepted && url.searchParams.get('path') === 'src') {
          intercepted = true;
          return pending.promise;
        }
        return original(url);
      };
      await expand('src');
      expect(intercepted).toBe(true);
      if (change === 'refresh') ui.app.refreshFileBrowser();
      if (change === 'hidden') ui.app.toggleFileBrowserHidden();
      if (change === 'session') {
        ui.app.activeSessionId = 'sess-B';
        ui.app._activateFileBrowserSession('sess-B');
      }
      if (change === 'hide') {
        ui.document.getElementById('fileBrowserPanel')!.classList.remove('visible');
        ui.app._resetFileBrowserForHide();
      }
      if (change === 'root') ui.app.toggleFileBrowserRoot();
      await settle();
      const before = ui.tree.innerHTML;
      pending.resolve(page([file('src/STALE.ts')]));
      await settle();
      expect(ui.tree.innerHTML).toBe(before);
      expect(JSON.stringify(ui.app.fileBrowserData)).not.toContain('STALE.ts');
    }
  );

  it('keeps preview and download actions bound to the listing owner after lazy expansion', async () => {
    await open();
    await expand('src');
    const row = [...ui.tree.querySelectorAll<HTMLElement>('.file-tree-item')].find(
      (item) => item.dataset.path === 'src/visible.ts'
    );
    expect(row).toBeDefined();
    const download = row!.querySelector('a.file-tree-download');
    expect(download).not.toBeNull();
    const url = new URL(download!.getAttribute('href')!, 'http://localhost/');
    expect(url.pathname).toBe('/api/sessions/sess-A/file-raw');
    expect(url.searchParams.get('path')).toBe('src/visible.ts');
    ui.app.activeSessionId = 'sess-B';
    row!.click();
    expect(ui.app.openFilePreview).toHaveBeenCalledWith('src/visible.ts', 'sess-A');
  });
});
