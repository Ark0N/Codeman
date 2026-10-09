/**
 * @fileoverview Static guard: the wiki Home page's "Everything in the manual" index
 * links every page the sidebar lists.
 *
 * docs/wiki/ is mirrored to the GitHub wiki, where _Sidebar.md shows on every page and
 * Home.md calls itself the whole manual. A new page added to the sidebar alone (Tile
 * Grid, Custom Model Endpoints) silently dropped out of that index. Compared by link
 * target, since the two files label some pages differently.
 *
 * Port: N/A (pure static analysis).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const wiki = resolve(import.meta.dirname, '..', 'docs', 'wiki');
const read = (name: string) => readFileSync(resolve(wiki, name), 'utf8');

/** Internal wiki page targets of `[label](Target)` links, external URLs excluded. */
const pageTargets = (markdown: string): Set<string> =>
  new Set(
    [...markdown.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)]
      .map((m) => m[1])
      .filter((target) => !/^[a-z]+:/i.test(target) && target !== 'Home')
  );

describe('wiki Home index', () => {
  it('links every page the sidebar lists', () => {
    const sidebar = pageTargets(read('_Sidebar.md'));
    expect(sidebar.size).toBeGreaterThan(20);
    const index = read('Home.md').split('## Everything in the manual')[1] ?? '';
    expect(index, 'Home.md has an "Everything in the manual" section').not.toBe('');
    const indexed = pageTargets(index);
    const missing = [...sidebar].filter((target) => !indexed.has(target));
    expect(missing, 'add these to the "Everything in the manual" tables in docs/wiki/Home.md').toEqual([]);
  });
});
