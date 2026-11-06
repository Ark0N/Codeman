/**
 * @fileoverview `GET /api/sessions/:id/files?root=live` (#765).
 *
 * The listing starts at the worktree the pane is in, and every `path` stays relative to
 * `workingDir`: that is what keeps the preview, raw and edit routes working unchanged, inside the
 * same confinement. Real filesystem on purpose, since the walk is the thing under test.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';

const PREFIX = '.claude/worktrees/probe';

describe('Files panel listing of a live worktree', () => {
  let harness: RouteTestHarness;
  let repo: string;
  let worktree: string;
  /** Removed after each test: a folder of the server user's outside the session folder. */
  let outside: string | undefined;

  const list = async (query = '') => {
    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/files?depth=5${query}`,
    });
    expect(res.statusCode).toBe(200);
    return res.json().data;
  };
  const names = (nodes: Array<{ name: string }>) => nodes.map((node) => node.name);

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerFileRoutes);
    repo = mkdtempSync(join(homedir(), 'live-worktree-route-'));
    worktree = join(repo, PREFIX);
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(worktree, 'src'), { recursive: true });
    writeFileSync(join(repo, 'src', 'main-only.ts'), 'main');
    writeFileSync(join(worktree, 'src', 'worktree-only.ts'), 'worktree');
    Object.assign(harness.ctx._session, {
      workingDir: repo,
      liveWorktree: { name: 'probe', path: worktree },
    });
  });

  afterEach(async () => {
    await harness.app.close();
    rmSync(repo, { recursive: true, force: true });
    if (outside) rmSync(outside, { recursive: true, force: true });
    outside = undefined;
  });

  /** A folder outside the session folder, holding a visible and a hidden file and a subfolder. */
  const makeOutsideFolder = () => {
    outside = mkdtempSync(join(homedir(), 'live-worktree-outside-'));
    mkdirSync(join(outside, 'inner'));
    writeFileSync(join(outside, '.hidden-outside'), 'secret');
    writeFileSync(join(outside, 'inner', 'outside-file.txt'), 'secret');
    return outside;
  };
  const expectSessionFolderListing = (data: {
    root: string;
    worktree: unknown;
    tree: Array<{ name: string; children?: Array<{ path: string }> }>;
  }) => {
    expect(data.root).toBe(repo);
    expect(JSON.stringify(data.tree)).not.toContain('outside');
    expect(data.tree.find((node) => node.name === 'src')?.children?.[0].path).toBe('src/main-only.ts');
    // Kept so the panel's comparison with the session's state settles instead of reloading forever.
    expect(data.worktree).toEqual({ name: 'probe', path: worktree });
  };

  it('lists the worktree with paths relative to the session folder', async () => {
    const data = await list('&root=live');
    expect(data.root).toBe(worktree);
    expect(data.worktree).toEqual({ name: 'probe', path: worktree });
    expect(names(data.tree)).toEqual(['src']);
    expect(data.tree[0].path).toBe(`${PREFIX}/src`);
    expect(data.tree[0].children[0].path).toBe(`${PREFIX}/src/worktree-only.ts`);
  });

  it('does not need hidden files on, though the worktree lives under a dot folder', async () => {
    const data = await list('&root=live&showHidden=false');
    expect(data.totalFiles).toBe(1);
  });

  it('keeps the session folder without the parameter, and still reports the worktree', async () => {
    const data = await list();
    expect(data.root).toBe(repo);
    expect(data.worktree).toEqual({ name: 'probe', path: worktree });
    expect(names(data.tree)).toEqual(['src']);
    expect(data.tree[0].children[0].path).toBe('src/main-only.ts');
  });

  it('answers exactly as before for a session in no worktree', async () => {
    Object.assign(harness.ctx._session, { liveWorktree: undefined });
    const data = await list('&root=live');
    expect(data).toEqual(await list());
    expect(data.root).toBe(repo);
    expect('worktree' in data).toBe(false);
  });

  it('falls back to the session folder when the worktree has gone, keeping the report', async () => {
    rmSync(worktree, { recursive: true });
    const data = await list('&root=live');
    expect(data.root).toBe(repo);
    // Kept so the panel's comparison with the session's state settles instead of reloading forever.
    expect(data.worktree).toEqual({ name: 'probe', path: worktree });
  });

  it('walks the session folder when a symlink replaced the worktree with a folder outside it', async () => {
    rmSync(worktree, { recursive: true });
    symlinkSync(makeOutsideFolder(), worktree);
    expectSessionFolderListing(await list('&root=live&showHidden=true'));
  });

  it('does not find anything outside the session folder through such a symlink when searching', async () => {
    rmSync(worktree, { recursive: true });
    symlinkSync(makeOutsideFolder(), worktree);
    const data = await list(`&root=live&showHidden=true&q=${encodeURIComponent('outside')}`);
    expect(data.root).toBe(repo);
    expect(data.matches).toEqual([]);
  });

  it('walks the session folder when a parent of the worktree is the symlink', async () => {
    const parent = join(repo, '.claude/worktrees');
    rmSync(parent, { recursive: true });
    mkdirSync(join(makeOutsideFolder(), 'probe'));
    writeFileSync(join(outside as string, 'probe', 'outside-file.txt'), 'secret');
    symlinkSync(outside as string, parent);
    expectSessionFolderListing(await list('&root=live&showHidden=true'));
  });

  it('walks the session folder when the worktree path is a symlink back to that folder', async () => {
    rmSync(worktree, { recursive: true });
    symlinkSync(repo, worktree);
    expectSessionFolderListing(await list('&root=live'));
  });

  it('still lists a worktree of a workspace reached through a symlink, in the workspace spelling', async () => {
    const link = `${repo}-link`;
    symlinkSync(repo, link);
    try {
      const spelled = join(link, PREFIX);
      Object.assign(harness.ctx._session, {
        workingDir: link,
        liveWorktree: { name: 'probe', path: spelled },
      });
      const data = await list('&root=live');
      expect(data.root).toBe(spelled);
      expect(data.tree[0].children[0].path).toBe(`${PREFIX}/src/worktree-only.ts`);
    } finally {
      rmSync(link);
    }
  });

  it('searches the worktree: the query reads paths in the listing, the result in the session folder', async () => {
    const data = await list(`&root=live&q=${encodeURIComponent('src/*.ts')}`);
    expect(data.root).toBe(worktree);
    expect(data.matches.map((match: { path: string }) => match.path)).toEqual([`${PREFIX}/src/worktree-only.ts`]);
    expect(data.worktree).toEqual({ name: 'probe', path: worktree });
  });

  it('walks a large worktree in fair rounds, and the paths stay relative to the session folder', async () => {
    mkdirSync(join(worktree, 'a-bulk'));
    mkdirSync(join(worktree, 'z-later'));
    for (let index = 0; index < 5100; index++) {
      writeFileSync(join(worktree, 'a-bulk', `item-${index}.txt`), '');
    }
    writeFileSync(join(worktree, 'z-later', 'needle.ts'), 'x');
    // The main checkout must play no part: this is the folder a walk seeded wrongly would list.
    writeFileSync(join(repo, 'src', 'needle.ts'), 'main');

    const data = await list('&root=live');
    expect(data.root).toBe(worktree);
    expect(data.truncated).toBe(true);
    expect(names(data.tree)).toEqual(['a-bulk', 'src', 'z-later']);
    const [bulk, , later] = data.tree;
    expect(bulk).toMatchObject({ path: `${PREFIX}/a-bulk`, incomplete: true });
    expect(bulk.children[0].path.startsWith(`${PREFIX}/a-bulk/`)).toBe(true);
    expect(later).not.toHaveProperty('incomplete');
    expect(later.children[0].path).toBe(`${PREFIX}/z-later/needle.ts`);

    // A `/` in the query reads the listing's paths, and only the answer is in workingDir's terms.
    const found = await list(`&root=live&q=${encodeURIComponent('z-later/*.ts')}`);
    expect(found.root).toBe(worktree);
    expect(found.matches.map((match: { path: string }) => match.path)).toEqual([`${PREFIX}/z-later/needle.ts`]);
    expect(found.truncated).toBe(true);
    const anywhere = await list('&root=live&q=needle');
    expect(anywhere.matches.map((match: { path: string }) => match.path)).toEqual([`${PREFIX}/z-later/needle.ts`]);
  });

  it('serves a listed path through the unchanged preview route', async () => {
    const path = `${PREFIX}/src/worktree-only.ts`;
    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=${encodeURIComponent(path)}`,
    });
    expect(res.json().success).toBe(true);
    expect(res.json().data.content).toBe('worktree');
  });
});
