/**
 * @fileoverview The file routes for a worktree OUTSIDE the session's folder (#765 follow-up).
 *
 * `liveWorktree.outside` makes that worktree a second root: `GET .../files?root=live` lists it with
 * ABSOLUTE paths, and the read, raw, edit and download routes confine an absolute path inside it to
 * it. What must not change: a relative path still resolves against `workingDir` only, a path that
 * escapes the worktree through a symlink is refused, and a worktree folder replaced by a symlink is
 * neither listed nor served. Real filesystem on purpose, since realpath is the thing under test.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

describe('file routes for a worktree outside the session folder', () => {
  let harness: RouteTestHarness;
  let base: string;
  let repo: string;
  let sibling: string;
  let secret: string;

  const sessionUrl = (rest: string) => `/api/sessions/${harness.ctx._sessionId}/${rest}`;
  const list = async (query = '') => {
    const res = await harness.app.inject({ method: 'GET', url: sessionUrl(`files?depth=5${query}`) });
    expect(res.statusCode).toBe(200);
    return res.json().data;
  };
  const readContent = (path: string) =>
    harness.app.inject({ method: 'GET', url: sessionUrl(`file-content?path=${encodeURIComponent(path)}`) });

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerFileRoutes);
    base = realpathSync(mkdtempSync(join(tmpdir(), 'outside-worktree-route-')));
    repo = join(base, 'myapp');
    sibling = join(base, 'myapp-feature');
    secret = join(base, 'secret');
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(sibling, 'src'), { recursive: true });
    mkdirSync(secret);
    writeFileSync(join(repo, 'src', 'main-only.ts'), 'main');
    writeFileSync(join(sibling, 'src', 'feature-only.ts'), 'feature');
    writeFileSync(join(secret, 'key.txt'), 'secret');
    Object.assign(harness.ctx._session, {
      workingDir: repo,
      liveWorktree: { name: 'myapp-feature', path: sibling, outside: true },
    });
  });

  afterEach(async () => {
    await harness.app.close();
    rmSync(base, { recursive: true, force: true });
  });

  describe('GET .../files', () => {
    it('lists the worktree with absolute paths', async () => {
      const data = await list('&root=live');
      expect(data.root).toBe(sibling);
      expect(data.worktree).toEqual({ name: 'myapp-feature', path: sibling, outside: true });
      expect(data.tree[0].path).toBe(join(sibling, 'src'));
      expect(data.tree[0].children[0].path).toBe(join(sibling, 'src', 'feature-only.ts'));
    });

    it('searches the worktree, matching on paths relative to it and answering absolute ones', async () => {
      const data = await list(`&root=live&q=${encodeURIComponent('src/feature*')}`);
      expect(data.matches.map((m: { path: string }) => m.path)).toEqual([join(sibling, 'src', 'feature-only.ts')]);
    });

    it('keeps the session folder, with relative paths, without the parameter', async () => {
      const data = await list();
      expect(data.root).toBe(repo);
      expect(data.tree[0].children[0].path).toBe('src/main-only.ts');
    });

    it('falls back to the session folder once a symlink has taken the worktree folder’s place', async () => {
      renameSync(sibling, `${sibling}-moved`);
      symlinkSync(secret, sibling);
      const data = await list('&root=live');
      expect(data.root).toBe(repo);
      expect(JSON.stringify(data.tree)).not.toContain('key.txt');
    });
  });

  describe('GET .../file-content', () => {
    it('serves an absolute path inside the worktree', async () => {
      const res = await readContent(join(sibling, 'src', 'feature-only.ts'));
      expect(res.statusCode).toBe(200);
      expect(JSON.stringify(res.json())).toContain('feature');
    });

    it('still resolves a relative path against the session folder only', async () => {
      expect((await readContent('src/main-only.ts')).statusCode).toBe(200);
      const escaped = await readContent('../myapp-feature/src/feature-only.ts');
      expect(JSON.stringify(escaped.json())).not.toContain('"feature"');
      expect(escaped.json().success).toBe(false);
    });

    it('refuses a symlink in the worktree that leads out of it', async () => {
      symlinkSync(join(secret, 'key.txt'), join(sibling, 'leak.txt'));
      const res = await readContent(join(sibling, 'leak.txt'));
      expect(res.json().success).toBe(false);
      expect(JSON.stringify(res.json())).not.toContain('"secret"');
    });

    it('serves a symlink in the worktree that leads into the session folder', async () => {
      symlinkSync(join(repo, 'src', 'main-only.ts'), join(sibling, 'main-link.ts'));
      const res = await readContent(join(sibling, 'main-link.ts'));
      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
    });

    it('serves nothing from the folder once a symlink has taken its place', async () => {
      renameSync(sibling, `${sibling}-moved`);
      symlinkSync(secret, sibling);
      const res = await readContent(join(sibling, 'key.txt'));
      expect(res.json().success).toBe(false);
    });

    it('serves nothing outside the session folder once the worktree is not outside', async () => {
      Object.assign(harness.ctx._session, { liveWorktree: { name: 'myapp-feature', path: sibling } });
      const res = await readContent(join(sibling, 'src', 'feature-only.ts'));
      expect(res.json().success).toBe(false);
    });
  });

  describe('file-raw, download and edit', () => {
    it('streams an absolute path inside the worktree from file-raw and download', async () => {
      const target = join(sibling, 'src', 'feature-only.ts');
      const raw = await harness.app.inject({
        method: 'GET',
        url: sessionUrl(`file-raw?path=${encodeURIComponent(target)}`),
      });
      expect(raw.statusCode).toBe(200);
      expect(raw.body).toBe('feature');
      const download = await harness.app.inject({
        method: 'GET',
        url: `/api/download?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(target)}`,
      });
      expect(download.statusCode).toBe(200);
      expect(download.body).toBe('feature');
    });

    it('edits a file inside the worktree in place', async () => {
      const target = join(sibling, 'notes.md');
      writeFileSync(target, 'before\n');
      const res = await harness.app.inject({
        method: 'PUT',
        url: sessionUrl('file-content'),
        payload: { path: target, content: 'after\n', baseHash: sha256('before\n') },
      });
      expect(res.statusCode).toBe(200);
      expect(readFileSync(target, 'utf8')).toBe('after\n');
    });

    it('refuses to edit through a symlink that leads out of the worktree', async () => {
      symlinkSync(join(secret, 'key.txt'), join(sibling, 'leak.md'));
      const res = await harness.app.inject({
        method: 'PUT',
        url: sessionUrl('file-content'),
        payload: { path: join(sibling, 'leak.md'), content: 'pwned', baseHash: sha256('secret') },
      });
      expect(res.statusCode).toBe(404);
      expect(readFileSync(join(secret, 'key.txt'), 'utf8')).toBe('secret');
    });
  });
});
