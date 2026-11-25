/**
 * @fileoverview Issue #759: opt-in, one-directory Files panel listings.
 *
 * Real folders exercise the shipped route, confinement, exclusions and continuation. Spies are
 * limited to proving that a listing never opens descendants, and to simulating an unreachable
 * mount (which a real fixture cannot do). No ports, real sessions or production HOME are used.
 *
 * Additive wire contract: lazy=1, optional path and opaque cursor; data.tree contains
 * immediate children, directories omit children until loaded, and nextCursor is present only
 * while another page remains (null/absent both mean finished). Page size is deliberately not
 * prescribed here, apart from staying within the existing 5,000-entry response budget.
 */
import { mkdirSync, mkdtempSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeRmHomeTree } from '../mocks/index.js';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';
import * as pathProbe from '../../src/utils/bounded-path-probe.js';

interface Entry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: Entry[];
}

describe('Files panel directory-at-a-time route (#759)', () => {
  let harness: RouteTestHarness;
  let fixture: string;
  let repo: string;
  let outside: string;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerFileRoutes);
    fixture = realpathSync(mkdtempSync(join(homedir(), 'files-lazy-')));
    repo = join(fixture, 'repo');
    outside = join(fixture, 'outside');
    mkdirSync(join(repo, 'src', 'deep'), { recursive: true });
    mkdirSync(join(repo, 'empty'));
    mkdirSync(join(repo, '.config'));
    mkdirSync(outside);
    writeFileSync(join(repo, 'README.md'), 'readme');
    writeFileSync(join(repo, '.env'), 'hidden');
    writeFileSync(join(repo, '.config', 'prefs.json'), '{}');
    writeFileSync(join(repo, 'src', 'visible.ts'), 'visible');
    writeFileSync(join(repo, 'src', 'deep', 'needle.ts'), 'needle');
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    harness.ctx._session.workingDir = repo;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await harness.app.close();
    safeRmHomeTree(fixture);
  });

  const request = (query: Record<string, string> = {}) =>
    harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/files?${new URLSearchParams(query)}`,
    });
  const list = async (query: Record<string, string> = {}) => {
    const res = await request({ lazy: '1', ...query });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);
    return res.json().data;
  };
  const paths = (entries: Entry[]) => entries.map((entry) => entry.path);

  it('returns every ordinary root entry without opening or embedding descendants', async () => {
    const reads = vi.spyOn(fs, 'readdir');
    const data = await list();
    expect(paths(data.tree)).toEqual(['empty', 'src', 'README.md']);
    expect(data.root).toBe(repo);
    expect(data.lazy).toBe(true);
    expect(data.truncated).toBe(false);
    expect(data.nextCursor ?? null).toBeNull();
    for (const node of data.tree.filter((entry: Entry) => entry.type === 'directory')) {
      expect(node).not.toHaveProperty('children');
    }
    expect(reads.mock.calls.map(([path]) => String(path))).toEqual([repo]);
  });

  it('loads just the requested folder and keeps paths usable by the existing preview', async () => {
    const reads = vi.spyOn(fs, 'readdir');
    const data = await list({ path: 'src' });
    expect(paths(data.tree)).toEqual(['src/deep', 'src/visible.ts']);
    expect(data.tree[0]).not.toHaveProperty('children');
    expect(reads.mock.calls.map(([path]) => String(path))).toEqual([join(repo, 'src')]);
    const preview = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=src%2Fvisible.ts`,
    });
    expect(preview.json().data.content).toBe('visible');
  });

  it('preserves a workspace file link as a legacy file row and previews its returned path', async () => {
    symlinkSync(join(repo, 'README.md'), join(repo, 'AGENTS.md'));
    const legacy = (await request()).json().data.tree.find((entry: Entry) => entry.path === 'AGENTS.md');
    const lazy = (await list()).tree.find((entry: Entry) => entry.path === 'AGENTS.md');
    expect(legacy).toMatchObject({ name: 'AGENTS.md', path: 'AGENTS.md', type: 'file' });
    expect(lazy).toEqual(legacy);
    const preview = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=${encodeURIComponent(lazy.path)}`,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.content).toBe('readme');
  });

  it('keeps directory links and dangling links as legacy leaves without traversing them', async () => {
    symlinkSync(join(repo, 'src'), join(repo, 'folder-link'));
    symlinkSync(join(repo, 'missing.md'), join(repo, 'dangling.md'));
    const legacy = (await request()).json().data.tree;
    const reads = vi.spyOn(fs, 'readdir');
    const data = await list();
    for (const path of ['folder-link', 'dangling.md']) {
      const row = data.tree.find((entry: Entry) => entry.path === path);
      expect(row).toEqual(legacy.find((entry: Entry) => entry.path === path));
      expect(row).toMatchObject({ type: 'file' });
      expect(row).not.toHaveProperty('children');
    }
    expect(reads.mock.calls.map(([path]) => String(path))).toEqual([repo]);
  });

  it('distinguishes a successfully loaded empty folder from an unloaded one', async () => {
    const data = await list({ path: 'empty' });
    expect(data.tree).toEqual([]);
    expect(data.truncated).toBe(false);
    expect(data.nextCursor ?? null).toBeNull();
  });

  it('has no accumulated depth budget across successive folder expansions', async () => {
    const deep = Array.from({ length: 12 }, (_, index) => `level-${index}`).join('/');
    mkdirSync(join(repo, deep), { recursive: true });
    writeFileSync(join(repo, deep, 'bottom.txt'), 'bottom');
    const data = await list({ path: deep });
    expect(paths(data.tree)).toEqual([`${deep}/bottom.txt`]);
    expect(data.truncated).toBe(false);
  });

  it('adds hidden entries alongside visible entries at the root and below it', async () => {
    expect(paths((await list()).tree)).toEqual(['empty', 'src', 'README.md']);
    expect(paths((await list({ showHidden: 'true' })).tree)).toEqual(['.config', 'empty', 'src', '.env', 'README.md']);
    writeFileSync(join(repo, 'src', '.hidden.ts'), 'hidden');
    expect(paths((await list({ path: 'src', showHidden: 'true' })).tree)).toEqual([
      'src/deep',
      'src/.hidden.ts',
      'src/visible.ts',
    ]);
  });

  it('requires the hidden preference to open a hidden path segment', async () => {
    const denied = await request({ lazy: '1', path: '.config' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().success).toBe(false);
    expect(paths((await list({ path: '.config', showHidden: 'true' })).tree)).toEqual(['.config/prefs.json']);
  });

  it('preserves generated-directory exclusions even when hidden files are enabled', async () => {
    for (const name of ['.git', 'node_modules', 'dist', 'build', 'coverage']) {
      mkdirSync(join(repo, name));
      writeFileSync(join(repo, name, 'excluded.txt'), 'excluded');
    }
    const data = await list({ showHidden: 'true' });
    expect(paths(data.tree)).toEqual(['.config', 'empty', 'src', '.env', 'README.md']);
  });

  it.each(['../outside', '/etc', 'src/../../outside'])(
    'refuses a requested directory outside the session: %s',
    async (path) => {
      const res = await request({ lazy: '1', path, showHidden: 'true' });
      expect(res.statusCode).toBe(403);
      expect(res.json().success).toBe(false);
      expect(res.body).not.toContain('secret.txt');
    }
  );

  it('refuses a directory symlink escaping the workspace', async () => {
    symlinkSync(outside, join(repo, 'escape'));
    const res = await request({ lazy: '1', path: 'escape' });
    expect(res.statusCode).toBe(403);
    expect(res.json().success).toBe(false);
  });

  it.each(['missing', 'README.md'])('does not report %s as an empty directory', async (path) => {
    const res = await request({ lazy: '1', path });
    expect(res.statusCode).toBe(path === 'missing' ? 404 : 400);
    expect(res.json().success).toBe(false);
  });

  it('probes a requested subfolder before readdir and never opens an unreachable folder', async () => {
    const target = join(repo, 'src');
    const realProbe = pathProbe.probePathKind;
    vi.spyOn(pathProbe, 'probePathKind').mockImplementation((path, options) =>
      path === target ? Promise.resolve('unknown') : realProbe(path, options)
    );
    const reads = vi.spyOn(fs, 'readdir');
    const res = await request({ lazy: '1', path: 'src' });
    expect(res.statusCode).toBe(422);
    expect(res.json().success).toBe(false);
    expect(vi.mocked(pathProbe.probePathKind).mock.calls.some(([path]) => path === target)).toBe(true);
    expect(reads.mock.calls.map(([path]) => String(path))).not.toContain(target);
  });

  it.each(['', 'bulk'])('paginates an oversized %s directory without losing or repeating entries', async (path) => {
    const folder = path ? join(repo, path) : repo;
    if (path) mkdirSync(folder);
    const expected = Array.from({ length: 5105 }, (_, index) => `item-${String(index).padStart(5, '0')}.txt`);
    for (const name of expected) writeFileSync(join(folder, name), '');
    const seen: string[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const data = await list({ ...(path && { path }), ...(cursor && { cursor }) });
      expect(data.tree.length).toBeGreaterThan(0);
      expect(data.tree.length).toBeLessThanOrEqual(500);
      seen.push(...paths(data.tree));
      cursor = data.nextCursor ?? undefined;
      expect(data.truncated).toBe(Boolean(cursor));
      if (cursor) {
        expect(typeof cursor).toBe('string');
        expect(cursors.has(cursor)).toBe(false);
        cursors.add(cursor);
        expect(cursors.size).toBeLessThan(100);
      }
    } while (cursor);
    expect(cursors.size).toBeGreaterThan(0);
    expect(new Set(seen).size).toBe(seen.length);
    const wanted = expected.map((name) => (path ? `${path}/${name}` : name));
    expect(seen.filter((entry) => entry.includes('item-')).sort()).toEqual(wanted);
    expect(paths((await list({ path: 'src/deep' })).tree)).toEqual(['src/deep/needle.ts']);
  });

  it('rejects a malformed continuation rather than silently restarting at page one', async () => {
    const res = await request({ lazy: '1', cursor: 'not-a-valid-cursor' });
    expect(res.statusCode).toBe(400);
    expect(res.json().success).toBe(false);
  });

  it('refuses to reuse a continuation for a different folder or hidden-files preference', async () => {
    for (let index = 0; index < 501; index++) writeFileSync(join(repo, `item-${index}.txt`), '');
    const { nextCursor } = await list();
    expect(nextCursor).toBeTypeOf('string');
    for (const changed of [{ path: 'src' }, { showHidden: 'true' }]) {
      const res = await request({ lazy: '1', cursor: nextCursor, ...changed });
      expect(res.statusCode).toBe(400);
      expect(res.json().success).toBe(false);
    }
  });

  it('keeps existing non-lazy response bytes and search behavior unchanged', async () => {
    const legacy = await request();
    expect(legacy.body).toBe(
      JSON.stringify({
        success: true,
        data: {
          root: repo,
          tree: [
            { name: 'empty', path: 'empty', type: 'directory', children: [] },
            {
              name: 'src',
              path: 'src',
              type: 'directory',
              children: [
                {
                  name: 'deep',
                  path: 'src/deep',
                  type: 'directory',
                  children: [{ name: 'needle.ts', path: 'src/deep/needle.ts', type: 'file', size: 6, extension: 'ts' }],
                },
                { name: 'visible.ts', path: 'src/visible.ts', type: 'file', size: 7, extension: 'ts' },
              ],
            },
            { name: 'README.md', path: 'README.md', type: 'file', size: 6, extension: 'md' },
          ],
          totalFiles: 3,
          totalDirectories: 3,
          truncated: false,
        },
      })
    );
    await list({ path: 'src' });
    expect((await request()).body).toBe(legacy.body);
    expect((await request({ lazy: '0' })).body).toBe(legacy.body);
    const search = await request({ q: 'needle' });
    expect(search.json().data.mode).toBe('search');
    expect(paths(search.json().data.matches)).toEqual(['src/deep/needle.ts']);
  });

  it.each(['live', 'live-any'])('preserves inside-worktree paths for root=%s', async (root) => {
    const prefix = '.claude/worktrees/feature';
    const worktree = join(repo, prefix);
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(worktree, 'src', 'feature.ts'), 'feature');
    harness.ctx._session.liveWorktree = { name: 'feature', path: worktree };
    const data = await list({ root });
    expect(data.root).toBe(worktree);
    expect(data.worktree).toEqual({ name: 'feature', path: worktree });
    expect(paths(data.tree)).toEqual([`${prefix}/src`]);
    expect(paths((await list({ root, path: `${prefix}/src` })).tree)).toEqual([`${prefix}/src/feature.ts`]);
  });

  it('keeps outside-worktree paths absolute only with root=live-any', async () => {
    mkdirSync(join(outside, 'src'));
    writeFileSync(join(outside, 'src', 'feature.ts'), 'feature');
    harness.ctx._session.liveWorktree = { name: 'feature', path: outside, outside: true };
    const data = await list({ root: 'live-any' });
    expect(data.root).toBe(outside);
    expect(data.worktree).toEqual({ name: 'feature', path: outside, outside: true });
    expect(paths(data.tree)).toEqual([join(outside, 'src'), join(outside, 'secret.txt')]);
    expect(paths((await list({ root: 'live-any', path: join(outside, 'src') })).tree)).toEqual([
      join(outside, 'src', 'feature.ts'),
    ]);
    expect(paths((await list({ root: 'live' })).tree)).toEqual(['empty', 'src', 'README.md']);
    expect(paths((await list()).tree)).toEqual(['empty', 'src', 'README.md']);
  });

  it('rechecks an outside worktree replaced by a symlink before loading its children', async () => {
    harness.ctx._session.liveWorktree = { name: 'feature', path: outside, outside: true };
    renameSync(outside, `${outside}-moved`);
    symlinkSync(repo, outside);
    const res = await request({ lazy: '1', root: 'live-any', path: outside });
    expect(res.statusCode).toBe(403);
    expect(res.json().success).toBe(false);
  });
});
