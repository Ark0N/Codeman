/**
 * @fileoverview File Viewer: an `.html` file renders as a sandboxed page.
 *
 * The server half (`/html-view/<cap>/...`, html-view-routes.ts) is pinned by
 * test/routes/html-view-routes.test.ts. This file pins the frontend half:
 *
 *  1. `rendersAsPage()` (constants.js) and the server's HTML_VIEW_EXTENSIONS
 *     name the same extensions, so the terminal, the preview and the route
 *     agree on what a page is.
 *
 * Loaded via `vm` with a jsdom document injected, like
 * file-preview-markdown.test.ts: constants.js + panels-ui.js only.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { HTML_VIEW_EXTENSIONS } from '../src/web/routes/html-view-routes.js';

const PUBLIC = resolve(import.meta.dirname, '../src/web/public');
const constantsJs = readFileSync(resolve(PUBLIC, 'constants.js'), 'utf8');

describe('rendersAsPage', () => {
  it('names exactly the extensions the html-view route renders', () => {
    const context = vm.createContext({});
    vm.runInContext(`${constantsJs}\nglobalThis.__page = { rendersAsPage, HTML_PAGE_EXTENSIONS };`, context, {
      filename: 'constants.js',
    });
    const { rendersAsPage, HTML_PAGE_EXTENSIONS } = (
      context as { __page: { rendersAsPage: (p: string) => boolean; HTML_PAGE_EXTENSIONS: Set<string> } }
    ).__page;

    expect([...HTML_PAGE_EXTENSIONS].sort()).toEqual([...HTML_VIEW_EXTENSIONS].sort());
    expect(rendersAsPage('/tmp/out/report.html')).toBe(true);
    expect(rendersAsPage('docs/INDEX.HTM')).toBe(true);
    expect(rendersAsPage('notes.md')).toBe(false);
    expect(rendersAsPage('page.html.txt')).toBe(false);
    expect(rendersAsPage(undefined as unknown as string)).toBe(false);
  });
});
