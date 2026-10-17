/**
 * @fileoverview `GET /api/sessions/:id/files?lazy=1[&path=]`: the File Viewer's
 * one-directory listing. Pins that it lists exactly one level (folders without
 * `children`), carries `mtimeMs` for date sorting, stays confined to the
 * workspace (traversal and symlink escapes), honours the hidden opt-in, and does
 * not change the default (non-lazy) tree response.
 *
 * Real temp directory, app.inject(), no port.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';

describe('lazy File Viewer listing', () => {
  let app: FastifyInstance;
  let ctx: ReturnType<typeof createMockRouteContext>;
  let workspace: string;
  let outside: string;

  beforeEach(async () => {
    workspace = await realpath(await mkdtemp(join(tmpdir(), 'codeman-lazy-tree-')));
    outside = await realpath(await mkdtemp(join(tmpdir(), 'codeman-lazy-outside-')));
    await mkdir(join(workspace, 'src', 'deep'), { recursive: true });
    await mkdir(join(workspace, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(join(workspace, '.git'));
    await writeFile(join(workspace, 'README.md'), 'hello');
    await writeFile(join(workspace, 'src', 'app.ts'), 'x');
    await writeFile(join(workspace, 'src', 'deep', 'leaf.ts'), 'y');
    await writeFile(join(outside, 'secret.txt'), 'nope');
    app = Fastify({ logger: false });
    ctx = createMockRouteContext();
    ctx._session.workingDir = workspace;
    registerFileRoutes(app, ctx as never);
    installRouteErrorHandler(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const list = async (query: string) => {
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${ctx._sessionId}/files?lazy=1${query}` });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };

  it('lists one level: folders first, no children, mtime on every entry, generated folders included', async () => {
    const { status, body } = await list('');
    expect(status).toBe(200);
    expect(body.data.lazy).toBe(true);
    expect(body.data.tree.map((n: { name: string }) => n.name)).toEqual(['node_modules', 'src', 'README.md']);
    for (const node of body.data.tree) {
      expect(node.children).toBeUndefined();
      expect(typeof node.mtimeMs).toBe('number');
    }
    expect(body.data.tree[2]).toMatchObject({ path: 'README.md', type: 'file', size: 5, extension: 'md' });
    expect(body.data).toMatchObject({ totalFiles: 1, totalDirectories: 2, truncated: false });
  });

  it('lists a subfolder with workspace-relative paths', async () => {
    const { body } = await list('&path=src');
    expect(body.data.path).toBe('src');
    expect(body.data.tree.map((n: { path: string }) => n.path)).toEqual(['src/deep', 'src/app.ts']);
    const deep = await list('&path=src/deep');
    expect(deep.body.data.tree.map((n: { path: string }) => n.path)).toEqual(['src/deep/leaf.ts']);
  });

  it('hides dot entries and hidden folders unless asked', async () => {
    expect((await list('')).body.data.tree.some((n: { name: string }) => n.name === '.git')).toBe(false);
    expect((await list('&path=.git')).status).toBe(403);
    const shown = await list('&showHidden=true');
    expect(shown.body.data.tree.some((n: { name: string }) => n.name === '.git')).toBe(true);
  });

  it('refuses traversal and symlink escapes out of the workspace', async () => {
    expect((await list(`&path=${encodeURIComponent('../')}`)).status).toBe(404);
    await symlink(outside, join(workspace, 'escape'));
    expect((await list('&path=escape')).status).toBe(404);
  });

  it('answers a missing folder with 404 and a file with 400', async () => {
    expect((await list('&path=missing')).status).toBe(404);
    expect((await list('&path=README.md')).status).toBe(400);
  });

  it('leaves the default tree response unchanged (nested, excludes generated folders)', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${ctx._sessionId}/files?depth=5` });
    const data = JSON.parse(res.body).data;
    expect(data.lazy).toBeUndefined();
    expect(data.tree.map((n: { name: string }) => n.name)).toEqual(['src', 'README.md']);
    expect(data.tree[0].children.map((n: { name: string }) => n.name)).toEqual(['deep', 'app.ts']);
  });
});
