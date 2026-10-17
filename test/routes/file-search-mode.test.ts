/**
 * GET /api/sessions/:id/files?q=... — search mode.
 *
 * A query turns the endpoint from a nested tree into a flat match list. Two
 * properties are worth pinning: the walk must recurse PAST non-matching
 * directories (searching is pointless if a file whose parents don't match is
 * unreachable), and an empty query must leave the default tree response exactly
 * as it was, since that is every existing caller.
 *
 * Runs against a real temp directory rather than a mocked fs: the value here is
 * the traversal, and a mocked readdir would just be asserting the mock.
 * Port: none (app.inject).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';

const root = mkdtempSync(join(tmpdir(), 'codeman-file-search-'));
mkdirSync(join(root, 'src', 'deep', 'nested'), { recursive: true });
mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
writeFileSync(join(root, 'README.md'), '#\n');
writeFileSync(join(root, 'src', 'widget.ts'), 'x\n');
writeFileSync(join(root, 'src', 'deep', 'nested', 'widget-test.ts'), 'x\n');
writeFileSync(join(root, 'node_modules', 'pkg', 'widget.ts'), 'x\n');

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('files endpoint search mode', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerFileRoutes);
    harness.ctx._session.workingDir = root;
  });

  const get = async (query: string) => {
    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/files${query}`,
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body);
  };

  it('returns a flat match list and reaches files under non-matching directories', () => {
    return get('?q=widget').then((body) => {
      expect(body.success).toBe(true);
      expect(body.data.mode).toBe('search');

      const paths = body.data.matches.map((m: { path: string }) => m.path).sort();
      // deep/nested matches only because the walk recursed through `src` and
      // `deep`, neither of which matches 'widget' itself.
      expect(paths).toEqual([join('src', 'deep', 'nested', 'widget-test.ts'), join('src', 'widget.ts')]);
      expect(body.data.matchCount).toBe(2);
      expect(body.data.query).toBe('widget');
      // The nested tree is not built in search mode.
      expect(body.data.tree).toEqual([]);
    });
  });

  it('still honours the excluded-directory list while searching', async () => {
    const body = await get('?q=widget');
    const paths = body.data.matches.map((m: { path: string }) => m.path);

    expect(paths.some((p: string) => p.includes('node_modules'))).toBe(false);
  });

  it('leaves the default tree response untouched when no query is given', async () => {
    const body = await get('');

    expect(body.data.mode).toBeUndefined();
    expect(body.data.matches).toBeUndefined();
    expect(Array.isArray(body.data.tree)).toBe(true);
    expect(body.data.tree.length).toBeGreaterThan(0);
  });

  it('treats a whitespace-only query as no query at all', async () => {
    const body = await get('?q=%20%20');

    expect(body.data.mode).toBeUndefined();
    expect(Array.isArray(body.data.tree)).toBe(true);
  });

  it('reports directories that match as well as files', async () => {
    const body = await get('?q=nested');

    expect(body.data.matches).toHaveLength(1);
    expect(body.data.matches[0]).toMatchObject({ name: 'nested', type: 'directory' });
  });

  it('shares the scan budget across sibling folders in both tree and search modes', async () => {
    const bulk = join(root, 'a-bulk');
    const later = join(root, 'z-later');
    mkdirSync(bulk);
    mkdirSync(later);
    for (let index = 0; index < 5100; index++) {
      writeFileSync(join(bulk, `item-${index}.txt`), '');
    }
    writeFileSync(join(later, 'needle.ts'), 'x\n');

    try {
      const tree = await get('');
      const treePaths = tree.data.tree.map((entry: { path: string }) => entry.path);
      expect(treePaths).toContain('a-bulk');
      expect(treePaths).toContain('z-later');
      expect(tree.data.truncated).toBe(true);

      const search = await get('?q=needle');
      expect(search.data.matches.map((match: { path: string }) => match.path)).toContain(join('z-later', 'needle.ts'));
      expect(search.data.truncated).toBe(true);
    } finally {
      rmSync(bulk, { recursive: true, force: true });
      rmSync(later, { recursive: true, force: true });
    }
  });
});
