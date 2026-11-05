/**
 * @fileoverview `GET /api/sessions/:id/files?root=live` (#765).
 *
 * The listing starts at the worktree the pane is in, and every `path` stays relative to
 * `workingDir`: that is what keeps the preview, raw and edit routes working unchanged, inside the
 * same confinement. Real filesystem on purpose, since the walk is the thing under test.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  });

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

  it('searches the worktree: the query reads paths in the listing, the result in the session folder', async () => {
    const data = await list(`&root=live&q=${encodeURIComponent('src/*.ts')}`);
    expect(data.root).toBe(worktree);
    expect(data.matches.map((match: { path: string }) => match.path)).toEqual([`${PREFIX}/src/worktree-only.ts`]);
    expect(data.worktree).toEqual({ name: 'probe', path: worktree });
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
