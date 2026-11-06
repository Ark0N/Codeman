/**
 * GET /api/sessions/:id/files: what one listing costs the server.
 *
 * test/routes/file-search-mode.test.ts pins what the walk returns, on real folders. This file pins
 * what it reads, which is where a real tree cannot go: 100 folders of 50,000 files is minutes of
 * setup, and a dead network mount cannot be made in a test. So `fs.readdir` and `fs.stat` are
 * stubbed here, on the one object the route and the bounded probe both call through.
 *
 * Port: none (app.inject).
 */
import { Dirent, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';

const UV_DIRENT_FILE = 1;
const UV_DIRENT_DIR = 2;
const dirent = (name: string, type: number, parent: string): Dirent =>
  new (Dirent as unknown as new (name: string, type: number, path: string) => Dirent)(name, type, parent);

describe('files endpoint read bounds', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerFileRoutes);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const get = async (query: string) => {
    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/files${query}`,
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body).data;
  };

  describe('over a workspace far bigger than the budget', () => {
    const FOLDERS = 100;
    const FILES_EACH = 50_000;
    const WORKSPACE = '/virtual/ws';
    let entriesServed = 0;

    beforeEach(() => {
      entriesServed = 0;
      const folders = Array.from({ length: FOLDERS }, (_, index) =>
        dirent(`class-${String(index).padStart(5, '0')}`, UV_DIRENT_DIR, WORKSPACE)
      );
      const files = Array.from({ length: FILES_EACH }, (_, index) =>
        dirent(`image-${String(index).padStart(8, '0')}.jpg`, UV_DIRENT_FILE, 'x')
      );
      vi.spyOn(fs, 'readdir').mockImplementation((async (path: string) => {
        const entries = path === WORKSPACE ? folders : files;
        entriesServed += entries.length;
        return [...entries];
      }) as never);
      vi.spyOn(fs, 'stat').mockImplementation((async (path: string) => ({
        size: 1,
        isDirectory: () => !String(path).endsWith('.jpg'),
      })) as never);
      harness.ctx._session.workingDir = WORKSPACE;
    });

    it('stops reading once it has read 250,000 entries, not at the end of the workspace', async () => {
      const data = await get('');

      // Past the ceiling by at most the folder that crossed it.
      expect(entriesServed).toBeLessThanOrEqual(250_000 + FILES_EACH);
      // What was read is still used, up to the budget, and nothing unread passes as empty.
      expect(data.totalFiles + data.totalDirectories).toBe(5000);
      expect(data.truncated).toBe(true);
      expect(data.tree).toHaveLength(FOLDERS);
      for (const folder of data.tree) expect(folder.incomplete).toBe(true);
      expect(data.tree.filter((folder: { children: unknown[] }) => folder.children.length === 0)).toHaveLength(
        FOLDERS - 5
      );
    });

    it('stops a search the same way', async () => {
      const data = await get('?q=image-00000000');

      expect(entriesServed).toBeLessThanOrEqual(250_000 + FILES_EACH);
      expect(data.matches.length).toBeGreaterThan(0);
      expect(data.truncated).toBe(true);
    });
  });

  describe('with a dead mount below the workspace', () => {
    let workspace: string;
    let deadFolder: string;
    let deadReads: number;
    let releaseStat: (() => void) | undefined;

    beforeEach(() => {
      workspace = mkdtempSync(join(tmpdir(), 'codeman-file-dead-'));
      deadFolder = join(workspace, 'z-nas');
      mkdirSync(deadFolder);
      mkdirSync(join(workspace, 'a-fine'));
      writeFileSync(join(workspace, 'a-fine', 'needle.ts'), '');
      harness.ctx._session.workingDir = workspace;

      deadReads = 0;
      const never = new Promise<never>(() => {});
      const realReaddir = fs.readdir.bind(fs);
      const realStat = fs.stat.bind(fs);
      vi.spyOn(fs, 'readdir').mockImplementation(((path: string, options: never) => {
        if (path !== deadFolder) return realReaddir(path, options);
        deadReads++;
        return never;
      }) as never);
      vi.spyOn(fs, 'stat').mockImplementation(((path: string) => {
        if (path !== deadFolder) return realStat(path);
        // Settled in afterEach: the probe calls a path stalled for as long as its stat is pending.
        return new Promise((_resolve, reject) => {
          releaseStat = () => reject(Object.assign(new Error('gone'), { code: 'EIO' }));
        });
      }) as never);
      vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(async () => {
      releaseStat?.();
      releaseStat = undefined;
      await new Promise((settled) => setTimeout(settled, 0));
      rmSync(workspace, { recursive: true, force: true });
    });

    const deadline = <T>(work: Promise<T>): Promise<T> =>
      Promise.race([
        work,
        new Promise<T>((_resolve, reject) => {
          setTimeout(() => reject(new Error('the listing never answered')), 5000).unref();
        }),
      ]);

    it('answers without it, and costs it one stuck stat however often the panel asks', async () => {
      const first = await deadline(get(''));

      // Nothing was read from it, so `children: []` alone would pass it off as an empty folder (#516:
      // unknown is never absent).
      const dead = first.tree.find((node: { name: string }) => node.name === 'z-nas');
      expect(dead).toEqual({ name: 'z-nas', path: 'z-nas', type: 'directory', children: [], incomplete: true });
      expect(first.truncated).toBe(true);
      expect(first.tree[0].children.map((node: { name: string }) => node.name)).toEqual(['needle.ts']);
      expect(deadReads).toBe(0);

      const statCalls = () => vi.mocked(fs.stat).mock.calls.filter(([path]) => path === deadFolder).length;
      const stats = statCalls();
      const search = await deadline(get('?q=needle'));
      expect(search.matches.map((match: { path: string }) => match.path)).toEqual([join('a-fine', 'needle.ts')]);
      // A hit could be behind it, which is what the search's own `truncated` is for.
      expect(search.truncated).toBe(true);
      expect(statCalls()).toBe(stats);
      expect(deadReads).toBe(0);
    });

    it('leaves a folder alone once the filesystem says it is gone: that is not an unfinished scan', async () => {
      vi.mocked(fs.stat).mockImplementation((async (path: string) => {
        if (path === deadFolder) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        return { size: 1, isDirectory: () => true };
      }) as never);

      const data = await deadline(get(''));

      const gone = data.tree.find((node: { name: string }) => node.name === 'z-nas');
      expect(gone).toEqual({ name: 'z-nas', path: 'z-nas', type: 'directory', children: [] });
      expect(data.truncated).toBe(false);
      expect(deadReads).toBe(0);
    });
  });
});
