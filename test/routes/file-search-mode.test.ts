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
    const middle = join(root, 'm-middle');
    const later = join(root, 'z-later');
    mkdirSync(bulk);
    mkdirSync(middle);
    mkdirSync(later);
    for (let index = 0; index < 5100; index++) {
      writeFileSync(join(bulk, `item-${index}.txt`), '');
    }
    writeFileSync(join(middle, 'middle.ts'), 'x\n');
    writeFileSync(join(later, 'needle.ts'), 'x\n');

    try {
      const tree = await get('');
      const treePaths = tree.data.tree.map((entry: { path: string }) => entry.path);
      expect(treePaths).toContain('a-bulk');
      expect(treePaths).toContain('m-middle');
      expect(treePaths).toContain('src');
      expect(treePaths).toContain('z-later');
      expect(tree.data.truncated).toBe(true);
      expect(tree.data.totalFiles + tree.data.totalDirectories).toBeLessThanOrEqual(5000);

      const node = (path: string) => tree.data.tree.find((entry: { path: string }) => entry.path === path);
      expect(node('a-bulk').incomplete).toBe(true);
      expect(node('a-bulk').children.length).toBeGreaterThan(0);
      // Finished folders do not carry the key at all, not even as false.
      expect(node('z-later')).not.toHaveProperty('incomplete');
      expect(node('z-later').children.map((entry: { path: string }) => entry.path)).toEqual([
        join('z-later', 'needle.ts'),
      ]);
      expect(node('m-middle')).not.toHaveProperty('incomplete');

      const search = await get('?q=needle');
      expect(search.data.matches.map((match: { path: string }) => match.path)).toContain(join('z-later', 'needle.ts'));
      expect(search.data.truncated).toBe(true);
    } finally {
      rmSync(bulk, { recursive: true, force: true });
      rmSync(middle, { recursive: true, force: true });
      rmSync(later, { recursive: true, force: true });
    }
  });

  it('adds nothing to a listing that fits the budget', async () => {
    const { data } = await get('');

    expect(data.truncated).toBe(false);
    expect(JSON.stringify(data)).not.toContain('incomplete');
    const dir = data.tree.find((entry: { name: string }) => entry.name === 'src');
    expect(Object.keys(dir)).toEqual(['name', 'path', 'type', 'children']);
    const file = data.tree.find((entry: { name: string }) => entry.name === 'README.md');
    expect(Object.keys(file)).toEqual(['name', 'path', 'type', 'size', 'extension']);
  });

  it('flags folders the budget ran out on part way through a round, read or not', async () => {
    // 3,000 folders use 3,000 of the 5,000 in the first round. The 2,000 left then buy one file
    // each, so the round ends with 1,000 folders never read: the last of those is the one a budget
    // check after the shift would drop from the queue, and with it the flag.
    const wide = mkdtempSync(join(tmpdir(), 'codeman-file-wide-'));
    for (let index = 0; index < 3000; index++) {
      const dir = join(wide, `dir-${String(index).padStart(4, '0')}`);
      mkdirSync(dir);
      writeFileSync(join(dir, 'one.txt'), '');
      writeFileSync(join(dir, 'two.txt'), '');
    }
    harness.ctx._session.workingDir = wide;

    try {
      const { data } = await get('');
      expect(data.truncated).toBe(true);
      expect(data.tree).toHaveLength(3000);
      expect(data.tree.filter((node: { incomplete?: boolean }) => node.incomplete === true)).toHaveLength(3000);
      const sizes = data.tree.map((node: { children: unknown[] }) => node.children.length);
      expect(sizes.filter((size: number) => size === 1)).toHaveLength(2000);
      expect(sizes.filter((size: number) => size === 0)).toHaveLength(1000);
    } finally {
      rmSync(wide, { recursive: true, force: true });
    }
  });

  it('copes with the root itself being unfinished, and its subfolders still get read', async () => {
    // The root has no node to flag. Its files stop the walk, but only after the folder it found.
    const wide = mkdtempSync(join(tmpdir(), 'codeman-file-root-'));
    mkdirSync(join(wide, 'first'));
    writeFileSync(join(wide, 'first', 'inside.txt'), '');
    for (let index = 0; index < 5100; index++) {
      writeFileSync(join(wide, `item-${index}.txt`), '');
    }
    harness.ctx._session.workingDir = wide;

    try {
      const { data } = await get('');
      expect(data.truncated).toBe(true);
      expect(data.totalFiles + data.totalDirectories).toBe(5000);
      expect(data.tree[0]).toMatchObject({ name: 'first', children: [{ name: 'inside.txt' }] });
      expect(data.tree[0]).not.toHaveProperty('incomplete');

      const search = await get('?q=inside');
      expect(search.data.matches.map((match: { path: string }) => match.path)).toEqual([join('first', 'inside.txt')]);
      expect(search.data.truncated).toBe(true);
    } finally {
      rmSync(wide, { recursive: true, force: true });
    }
  });

  it('does not let a large folder alone in its round starve the subfolders it holds', async () => {
    // One level below the walk root, with a second level of subfolder to reach.
    const wide = mkdtempSync(join(tmpdir(), 'codeman-file-sole-'));
    mkdirSync(join(wide, 'repo', 'src', 'lib'), { recursive: true });
    writeFileSync(join(wide, 'repo', 'src', 'lib', 'needle.ts'), '');
    for (let index = 0; index < 5100; index++) {
      writeFileSync(join(wide, 'repo', `item-${index}.txt`), '');
    }
    harness.ctx._session.workingDir = wide;

    try {
      const { data } = await get('?q=needle');
      expect(data.matches.map((match: { path: string }) => match.path)).toEqual([
        join('repo', 'src', 'lib', 'needle.ts'),
      ]);
      expect(data.truncated).toBe(true);
    } finally {
      rmSync(wide, { recursive: true, force: true });
    }
  });

  it('does not let large sibling folders starve the subfolders they hold', async () => {
    // Two in a round, so "alone in its round" is not what makes this go wrong: each folder's
    // equal share used to be spent on its own files, leaving nothing for what it had just found.
    const wide = mkdtempSync(join(tmpdir(), 'codeman-file-pair-'));
    for (const name of ['a-big', 'b-big']) {
      mkdirSync(join(wide, name, 'src'), { recursive: true });
      writeFileSync(join(wide, name, 'src', 'needle.ts'), '');
      for (let index = 0; index < 5100; index++) {
        writeFileSync(join(wide, name, `item-${index}.txt`), '');
      }
    }
    harness.ctx._session.workingDir = wide;

    try {
      const { data } = await get('?q=needle');
      expect(data.matches.map((match: { path: string }) => match.path).sort()).toEqual([
        join('a-big', 'src', 'needle.ts'),
        join('b-big', 'src', 'needle.ts'),
      ]);
    } finally {
      rmSync(wide, { recursive: true, force: true });
    }
  });

  it('calls a workspace of exactly 5,000 nodes finished', async () => {
    const exact = mkdtempSync(join(tmpdir(), 'codeman-file-exact-'));
    mkdirSync(join(exact, 'empty'));
    for (let index = 0; index < 4999; index++) {
      writeFileSync(join(exact, `item-${index}.txt`), '');
    }
    harness.ctx._session.workingDir = exact;

    try {
      const { data } = await get('');
      expect(data.totalFiles + data.totalDirectories).toBe(5000);
      expect(data.truncated).toBe(false);
      expect(JSON.stringify(data)).not.toContain('incomplete');
    } finally {
      rmSync(exact, { recursive: true, force: true });
    }
  });

  it('does not flag a folder whose only unread entries are ones the listing leaves out', async () => {
    // 3,000 folders leave 2,000 of the budget, which buys each of the first 2,000 its `src`. All
    // that is left unread in them is `vendor` and `.hidden`, which would never be listed anyway.
    const wide = mkdtempSync(join(tmpdir(), 'codeman-file-excluded-'));
    for (let index = 0; index < 3000; index++) {
      const dir = join(wide, `dir-${String(index).padStart(4, '0')}`);
      mkdirSync(join(dir, 'src'), { recursive: true });
      mkdirSync(join(dir, 'vendor'));
      writeFileSync(join(dir, '.hidden'), '');
    }
    harness.ctx._session.workingDir = wide;

    try {
      const { data } = await get('');
      expect(data.truncated).toBe(true);
      expect(data.tree[0].children.map((node: { name: string }) => node.name)).toEqual(['src']);
      expect(data.tree[0]).not.toHaveProperty('incomplete');
      expect(data.tree[2999]).toMatchObject({ incomplete: true, children: [] });
    } finally {
      rmSync(wide, { recursive: true, force: true });
    }
  });

  it('returns search results shallow-first', async () => {
    const deep = join(root, 'a-deep', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    mkdirSync(join(root, 'z-shallow'));
    writeFileSync(join(deep, 'order-probe.ts'), 'x\n');
    writeFileSync(join(root, 'z-shallow', 'order-probe.ts'), 'x\n');

    try {
      const { data } = await get('?q=order-probe');
      expect(data.matches.map((match: { path: string }) => match.path)).toEqual([
        join('z-shallow', 'order-probe.ts'),
        join('a-deep', 'b', 'c', 'order-probe.ts'),
      ]);
    } finally {
      rmSync(join(root, 'a-deep'), { recursive: true, force: true });
      rmSync(join(root, 'z-shallow'), { recursive: true, force: true });
    }
  });

  it('stops at the match limit and says so', async () => {
    const many = mkdtempSync(join(tmpdir(), 'codeman-file-many-'));
    for (let index = 0; index < 1100; index++) {
      writeFileSync(join(many, `hit-${index}.txt`), '');
    }
    harness.ctx._session.workingDir = many;

    try {
      const { data } = await get('?q=hit-');
      expect(data.matches).toHaveLength(1000);
      expect(data.matchCount).toBe(1000);
      expect(data.truncated).toBe(true);
    } finally {
      rmSync(many, { recursive: true, force: true });
    }
  });
});
