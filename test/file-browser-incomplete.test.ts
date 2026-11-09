/**
 * @fileoverview The Files panel's row for a folder the scan stopped short of.
 *
 * `GET .../files` gives a directory its node before reading it, so a folder still queued when the
 * budget ends, or one that did not answer, has `children: []` or a partial list
 * (test/routes/file-search-mode.test.ts, test/routes/file-walk-bounds.test.ts). Without
 * `incomplete` that reads as an empty folder. What can go wrong here is the client: the flag lost
 * on the way in, the row drawn for a collapsed or finished folder, or the click wiring treating it
 * as a file.
 *
 * panels-ui.js loads via `vm` as in file-browser-worktree.test.ts, over a real DOM, since the row
 * has to survive `innerHTML` and the `.file-tree-item` selector. Translation goes through the real
 * i18n.js. Port: N/A.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { afterAll, describe, expect, it, vi } from 'vitest';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const PANELS = readFileSync(resolve(PUBLIC, 'panels-ui.js'), 'utf8');
const I18N = readFileSync(resolve(PUBLIC, 'i18n.js'), 'utf8');
const STYLES = readFileSync(resolve(PUBLIC, 'styles.css'), 'utf8');

const dom = new JSDOM('<div id="fileBrowserTree"></div><div id="fileBrowserPanel" class="visible"></div>');
afterAll(() => dom.window.close());
const document = dom.window.document;
const treeEl = () => document.getElementById('fileBrowserTree') as HTMLElement;

function loadPanel(expanded: string[] = []) {
  const CodemanApp = function CodemanApp(this: unknown) {} as unknown as new () => Record<string, any>;
  const context = vm.createContext({
    CodemanApp,
    console,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    escapeHtml: (s: string) => String(s),
    document: { getElementById: () => null, addEventListener: vi.fn() },
    window: { addEventListener: vi.fn() },
    setTimeout,
    clearTimeout,
    CodemanBase: { url: (p: string) => p },
  });
  vm.runInContext(PANELS, context, { filename: 'panels-ui.js' });

  const app = new CodemanApp();
  app.$ = (id: string) => document.getElementById(id);
  app.activeSessionId = 'sess-1';
  app.fileBrowserExpandedDirs = new Set(expanded);
  app.getFileIcon = () => '';
  app.formatFileSize = () => '';
  app.openFilePreview = vi.fn();
  return app;
}

const bulk = {
  name: 'a-bulk',
  path: 'a-bulk',
  type: 'directory',
  incomplete: true,
  children: [{ name: 'one.txt', path: 'a-bulk/one.txt', type: 'file', size: 1, extension: 'txt' }],
};
const later = {
  name: 'z-later',
  path: 'z-later',
  type: 'directory',
  children: [{ name: 'needle.ts', path: 'z-later/needle.ts', type: 'file', size: 1, extension: 'ts' }],
};
const envelope = (tree: unknown[]) => ({
  success: true,
  data: { root: '/repo', tree, totalFiles: 2, totalDirectories: 2, truncated: true },
});

const render = (app: Record<string, any>, tree: unknown[]) => {
  app.fileBrowserData = app._validateFileBrowserTreeEnvelope(envelope(tree));
  app.renderFileBrowserTree('sess-1');
  return [...treeEl().querySelectorAll('.file-tree-incomplete')] as HTMLElement[];
};

describe('Files panel, a folder the scan stopped short of', () => {
  it('keeps the flag through the envelope check, which ignores what it does not know', () => {
    const app = loadPanel();
    const data = app._validateFileBrowserTreeEnvelope(envelope([bulk, later]));
    expect(data.tree[0].incomplete).toBe(true);
    // An old tab on a new server, and a new tab on an old server: neither is refused.
    expect(app._validateFileBrowserTreeEnvelope(envelope([later]))).not.toBeNull();
  });

  it('draws one row under an expanded incomplete folder, after what was read', () => {
    const rows = render(loadPanel(['a-bulk']), [bulk, later]);

    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toBe('Not fully scanned');
    expect(rows[0].dataset.depth).toBe('1');
    const items = [...treeEl().children].map((el) => (el as HTMLElement).dataset.path ?? 'ROW');
    expect(items).toEqual(['a-bulk', 'a-bulk/one.txt', 'ROW', 'z-later']);
  });

  it('draws it for a folder nothing was read from, which would otherwise look empty', () => {
    const unread = { name: 'b-unread', path: 'b-unread', type: 'directory', incomplete: true, children: [] };
    const rows = render(loadPanel(['b-unread']), [unread]);

    expect(rows).toHaveLength(1);
    expect(treeEl().querySelectorAll('.file-tree-item')).toHaveLength(1);
  });

  it('indents the row one level under a nested folder', () => {
    const nested = { name: 'outer', path: 'outer', type: 'directory', children: [bulk] };
    const rows = render(loadPanel(['outer', 'a-bulk']), [nested]);

    expect(rows[0].dataset.depth).toBe('2');
  });

  it('draws nothing while the folder is collapsed', () => {
    expect(render(loadPanel(), [bulk, later])).toHaveLength(0);
  });

  it('draws nothing under an expanded folder that was finished', () => {
    expect(render(loadPanel(['z-later']), [bulk, later])).toHaveLength(0);
  });

  it('accepts only a real true, so a stray truthy value draws nothing', () => {
    const odd = { ...bulk, incomplete: 'false' };
    expect(render(loadPanel(['a-bulk']), [odd])).toHaveLength(0);
  });

  it('is inert: a click neither opens nor toggles anything', () => {
    const app = loadPanel(['a-bulk']);
    const toggle = vi.spyOn(app, 'toggleFileBrowserFolder');
    const [row] = render(app, [bulk, later]);

    row.click();

    expect(row.matches('.file-tree-item')).toBe(false);
    expect(row.dataset.path).toBeUndefined();
    expect(app.openFilePreview).not.toHaveBeenCalled();
    expect(toggle).not.toHaveBeenCalled();
    // The file beside it still opens, so the click wiring did run.
    (treeEl().querySelector('[data-path="a-bulk/one.txt"]') as HTMLElement).click();
    expect(app.openFilePreview).toHaveBeenCalledWith('a-bulk/one.txt', 'sess-1');
  });

  it('is indented by the same steps as the rows around it', () => {
    for (let depth = 1; depth <= 9; depth++) {
      expect(STYLES).toContain(
        `.file-tree-item[data-depth="${depth}"], .file-tree-incomplete[data-depth="${depth}"] {`
      );
    }
  });

  it('reads in Chinese, through the string the row really shows', () => {
    const [row] = render(loadPanel(['a-bulk']), [bulk]);
    const i18n = new JSDOM('<html></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
    vm.runInContext(I18N, i18n.getInternalVMContext(), { filename: 'i18n.js' });
    const api = (
      i18n.window as unknown as {
        CodemanI18n: { t(s: string): string; configure(o: Record<string, string>): void; start(): void };
      }
    ).CodemanI18n;
    api.start();
    api.configure({ language: 'zh-CN' });

    const translated = api.t(row.textContent as string);
    expect(translated).not.toBe(row.textContent);
    expect(translated).not.toMatch(/[A-Za-z]/);
    i18n.window.close();
  });
});
