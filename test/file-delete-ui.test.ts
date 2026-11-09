/**
 * @fileoverview The Files panel's delete button (salvaged from #529), in the browser module.
 *
 * #529 first rendered the button with an inline `onclick` that quoted the path inside
 * `decodeURIComponent('...')`. `encodeURIComponent` leaves `'` alone, so a file named
 * `x'-alert(1)-'.txt` ran script in Codeman's origin, and `it's.txt` was a syntax error whose
 * button did nothing. Workspace names come from agents and cloned repos, so the click is now
 * bound from the row's escaped `data-path`.
 *
 * The DOM is jsdom with `runScripts: 'dangerously'` on purpose: jsdom then compiles inline event
 * attributes the way a browser does, with `window.app` and `window.alert` present, so the old
 * markup would really call `alert` here and this test would fail on it. The escaper is the real
 * one from constants.js, not a stub. panels-ui.js loads via `vm` as in
 * test/file-browser-incomplete.test.ts. Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterAll, describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const PANELS = readFileSync(resolve(PUBLIC, 'panels-ui.js'), 'utf8');
const CONSTANTS = readFileSync(resolve(PUBLIC, 'constants.js'), 'utf8');
const STYLES = readFileSync(resolve(PUBLIC, 'styles.css'), 'utf8');

// The shipped escaper: its map, its pattern and the function, cut from constants.js.
const ESCAPE_START = CONSTANTS.indexOf('const _htmlEscapeMap');
const ESCAPE_END = CONSTANTS.indexOf('\n}\n', CONSTANTS.indexOf('function escapeHtml(')) + 3;
const ESCAPE_SRC = CONSTANTS.slice(ESCAPE_START, ESCAPE_END);

const HOSTILE = ["x'-alert(1)-'.txt", "it's.txt", 'a "b" <i>c</i> & d.txt', "');alert(2);('.txt"];
const SESSION = 'sess-1';

const dom = new JSDOM(
  `<div id="fileBrowserPanel" class="visible"></div>
   <input id="fileBrowserSearch">
   <div id="fileBrowserStatus"></div>
   <div id="fileBrowserTree"></div>`,
  { runScripts: 'dangerously' }
);
afterAll(() => dom.window.close());
const document = dom.window.document;
const win = dom.window as unknown as Record<string, unknown>;
const treeEl = () => document.getElementById('fileBrowserTree') as HTMLElement;

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}
const reply = (body: unknown, status = 200): FakeResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

function loadPanel(
  options: {
    confirm?: (message: string) => boolean;
    fetch?: (url: string, init?: { method?: string }) => Promise<FakeResponse>;
    session?: Record<string, unknown>;
  } = {}
) {
  const CodemanApp = function CodemanApp(this: unknown) {} as unknown as new () => Record<string, any>;
  const context = vm.createContext({
    CodemanApp,
    console,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    document: { getElementById: () => null, addEventListener: vi.fn() },
    window: { addEventListener: vi.fn() },
    // The search debounce, collapsed so the re-run lands on the next turn.
    setTimeout: (fn: () => void) => setTimeout(fn, 0),
    clearTimeout,
    CodemanBase: { url: (p: string) => p },
    confirm: vi.fn(options.confirm ?? (() => true)),
    fetch: vi.fn(options.fetch ?? (async () => reply({ success: true, data: {} }))),
  });
  vm.runInContext(ESCAPE_SRC, context, { filename: 'constants.js (escapeHtml)' });
  vm.runInContext(PANELS, context, { filename: 'panels-ui.js' });

  const app = new CodemanApp();
  app.$ = (id: string) => document.getElementById(id);
  app.activeSessionId = SESSION;
  app.sessions = new Map([[SESSION, options.session ?? { id: SESSION }]]);
  app.fileBrowserExpandedDirs = new Set(['src']);
  app.fileBrowserShowHidden = false;
  app.getFileIcon = () => '';
  app.formatFileSize = () => '';
  app.openFilePreview = vi.fn();
  app.showToast = vi.fn();
  // The sentinel the old inline handler reached: `app.deleteFileFromBrowser(...)` ran in the page.
  win.app = app;
  win.alert = vi.fn();
  return { app, context: context as Record<string, any> };
}

const fileNode = (name: string) => ({ name, path: `src/${name}`, type: 'file', size: 1, extension: 'txt' });
const treeEnvelope = (names: string[]) => ({
  success: true,
  data: {
    root: '/repo',
    tree: [{ name: 'src', path: 'src', type: 'directory', children: names.map(fileNode) }],
    totalFiles: names.length,
    totalDirectories: 1,
    truncated: false,
  },
});
const searchEnvelope = (names: string[]) => ({
  success: true,
  data: { mode: 'search', matches: names.map(fileNode), matchCount: names.length, truncated: false },
});

const rowFor = (path: string) =>
  [...treeEl().querySelectorAll<HTMLElement>('.file-tree-item')].find((row) => row.dataset.path === path);
const deleteButtonFor = (path: string) => rowFor(path)?.querySelector<HTMLButtonElement>('.file-tree-delete');

function renderTree(app: Record<string, any>, names: string[]) {
  app.fileBrowserData = app._validateFileBrowserTreeEnvelope(treeEnvelope(names));
  app.renderFileBrowserTree(SESSION);
}

function renderSearch(app: Record<string, any>, names: string[]) {
  app._renderFileBrowserSearchResults(names.map(fileNode), SESSION, { matchCount: names.length, truncated: false });
}

describe('Files panel delete button: no inline handler, the exact path', () => {
  it.each([
    ['tree', renderTree],
    ['search results', renderSearch],
  ])('%s: a click deletes exactly the hostile path and runs nothing', (_label, render) => {
    const { app } = loadPanel();
    app.deleteFileFromBrowser = vi.fn();
    render(app, HOSTILE);

    expect(treeEl().innerHTML).not.toContain('decodeURIComponent');
    for (const name of HOSTILE) {
      const button = deleteButtonFor(`src/${name}`);
      expect(button, name).toBeTruthy();
      expect(button!.getAttribute('onclick')).toBeNull();
      expect(button!.type).toBe('button');

      button!.click();

      expect(app.deleteFileFromBrowser).toHaveBeenLastCalledWith(SESSION, `src/${name}`);
    }
    expect(app.deleteFileFromBrowser).toHaveBeenCalledTimes(HOSTILE.length);
    expect(win.alert).not.toHaveBeenCalled();
    // The click stays on the button: the row behind it does not open the file.
    expect(app.openFilePreview).not.toHaveBeenCalled();
    // The row itself still opens it.
    rowFor(`src/${HOSTILE[0]}`)!.click();
    expect(app.openFilePreview).toHaveBeenCalledWith(`src/${HOSTILE[0]}`, SESSION);
  });

  it('labels the button with the escaped name, as text', () => {
    const { app } = loadPanel();
    renderTree(app, ['a "b" <i>c</i> & d.txt']);
    const button = deleteButtonFor('src/a "b" <i>c</i> & d.txt')!;
    expect(button.getAttribute('aria-label')).toBe('Delete a "b" <i>c</i> & d.txt');
    expect(rowFor('src/a "b" <i>c</i> & d.txt')!.querySelector('i')).toBeNull();
  });

  it('offers no delete button on a folder row', () => {
    const { app } = loadPanel();
    renderTree(app, ['a.txt']);
    expect(rowFor('src')!.querySelector('.file-tree-delete')).toBeNull();
    expect(deleteButtonFor('src/a.txt')).toBeTruthy();
  });

  it.each([
    ['a remote (SSH) session', { id: SESSION, remote: { host: 'h' } }],
    ['an adopted session', { id: SESSION, adopt: { kind: 'local' } }],
  ])('offers none for %s, which the route refuses', (_label, session) => {
    const { app } = loadPanel({ session });
    renderTree(app, ['a.txt']);
    expect(rowFor('src/a.txt')).toBeTruthy();
    expect(deleteButtonFor('src/a.txt')).toBeNull();
    renderSearch(app, ['a.txt']);
    expect(rowFor('src/a.txt')).toBeTruthy();
    expect(deleteButtonFor('src/a.txt')).toBeNull();
  });
});

describe('deleteFileFromBrowser', () => {
  it('asks first and sends nothing when the answer is no', async () => {
    const { app, context } = loadPanel({ confirm: () => false });
    await app.deleteFileFromBrowser(SESSION, "src/it's.txt");
    expect(context.confirm).toHaveBeenCalledWith("Delete the file src/it's.txt? This cannot be undone.");
    expect(context.fetch).not.toHaveBeenCalled();
  });

  it('sends one DELETE with the encoded path, then reloads keeping the query', async () => {
    const { app, context } = loadPanel({ fetch: async () => reply({ success: true, data: { path: 'x' } }) });
    app._reloadFileBrowserKeepingQuery = vi.fn(async () => {});
    const path = "src/x'-alert(1)-' & #?.txt";

    await app.deleteFileFromBrowser(SESSION, path);

    expect(context.fetch).toHaveBeenCalledTimes(1);
    expect(context.fetch).toHaveBeenCalledWith(`/api/sessions/${SESSION}/files?path=${encodeURIComponent(path)}`, {
      method: 'DELETE',
    });
    expect(app.showToast).toHaveBeenCalledWith(`File deleted: ${path}`, 'success');
    expect(app._reloadFileBrowserKeepingQuery).toHaveBeenCalledTimes(1);
  });

  it('shows the server reason and reloads nothing when the delete is refused', async () => {
    const { app } = loadPanel({
      fetch: async () => reply({ success: false, error: 'Symbolic links are not deleted from the Files panel' }, 400),
    });
    app._reloadFileBrowserKeepingQuery = vi.fn(async () => {});

    await app.deleteFileFromBrowser(SESSION, 'AGENTS.md');

    expect(app.showToast).toHaveBeenCalledWith(
      'Delete failed: Symbolic links are not deleted from the Files panel',
      'error'
    );
    expect(app._reloadFileBrowserKeepingQuery).not.toHaveBeenCalled();
  });

  it('removes the row from the search results it was deleted from', async () => {
    let files = ['delete-me.txt', 'keep-me.txt', 'other.md'];
    const { app, context } = loadPanel({
      fetch: async (url, init) => {
        const query = new URL(url, 'http://localhost');
        if (init?.method === 'DELETE') {
          const gone = query.searchParams.get('path')!.replace(/^src\//, '');
          files = files.filter((name) => name !== gone);
          return reply({ success: true, data: { path: query.searchParams.get('path') } });
        }
        const q = query.searchParams.get('q');
        return reply(q ? searchEnvelope(files.filter((name) => name.includes(q))) : treeEnvelope(files));
      },
    });
    await app.loadFileBrowser(SESSION);
    (document.getElementById('fileBrowserSearch') as HTMLInputElement).value = 'me';
    app.filterFileBrowser('me');
    await vi.waitFor(() => expect(rowFor('src/delete-me.txt')).toBeTruthy());
    expect(rowFor('src/other.md')).toBeUndefined();

    deleteButtonFor('src/delete-me.txt')!.click();

    await vi.waitFor(() => expect(rowFor('src/delete-me.txt')).toBeUndefined());
    expect(rowFor('src/keep-me.txt')).toBeTruthy();
    // Still the search view, not the tree behind it.
    expect(rowFor('src/other.md')).toBeUndefined();
    expect(document.getElementById('fileBrowserStatus')!.textContent).toBe('1 match');
    const methods = context.fetch.mock.calls.map(([url, init]: [string, { method?: string }?]) =>
      init?.method === 'DELETE' ? 'DELETE' : url.includes('&q=') ? 'search' : 'tree'
    );
    expect(methods).toEqual(['tree', 'search', 'DELETE', 'tree', 'search']);
  });
});

describe('Files panel delete button: touch screens', () => {
  it('keeps the row buttons visible where there is no hover', () => {
    const blocks = [...STYLES.matchAll(/@media \(hover: none\) \{([^{}]*\{[^{}]*\})\s*\}/g)].map((m) => m[1]);
    expect(
      blocks.some((block) => /\.file-tree-download,\s*\.file-tree-delete\s*\{\s*display: inline;/.test(block))
    ).toBe(true);
  });
});
