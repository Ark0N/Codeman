/**
 * @fileoverview The file routes for a worktree OUTSIDE the session's folder (#765 follow-up).
 *
 * A session's outside worktree is a second root: `GET .../files?root=live-any` lists it with
 * ABSOLUTE paths (`root=live` keeps walking `workingDir`), and the read, raw, edit and download
 * routes confine an absolute path inside it to it. What must not change: a relative path still resolves against `workingDir` only, a path that
 * escapes the worktree through a symlink is refused, and a worktree folder replaced by a symlink is
 * neither listed nor served. Real filesystem on purpose, since realpath is the thing under test.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';
import { SETTINGS_PATH } from '../../src/web/route-helpers.js';

// The converter would shell out to pdftoppm/LibreOffice; the route's own path check is under test.
vi.mock('../../src/document-thumbnailer.js', () => ({
  generateFirstPageThumbnail: vi.fn(async () => ({ content: Buffer.from('\x89PNG fake'), contentType: 'image/png' })),
}));
import { generateFirstPageThumbnail } from '../../src/document-thumbnailer.js';

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
    rmSync(SETTINGS_PATH, { force: true });
  });

  describe('GET .../files', () => {
    it('lists the worktree with absolute paths', async () => {
      const data = await list('&root=live-any');
      expect(data.root).toBe(sibling);
      expect(data.worktree).toEqual({ name: 'myapp-feature', path: sibling, outside: true });
      expect(data.tree[0].path).toBe(join(sibling, 'src'));
      expect(data.tree[0].children[0].path).toBe(join(sibling, 'src', 'feature-only.ts'));
    });

    it('searches the worktree, matching on paths relative to it and answering absolute ones', async () => {
      const data = await list(`&root=live-any&q=${encodeURIComponent('src/feature*')}`);
      expect(data.matches.map((m: { path: string }) => m.path)).toEqual([join(sibling, 'src', 'feature-only.ts')]);
    });

    it('keeps walking the session folder, with relative paths, for root=live', async () => {
      const data = await list('&root=live');
      expect(data.root).toBe(repo);
      expect(data.worktree).toBeUndefined();
      expect(data.tree[0].children[0].path).toBe('src/main-only.ts');
      expect(JSON.stringify(data.tree)).not.toContain('feature-only.ts');
    });

    it('keeps the session folder, with relative paths, without the parameter', async () => {
      const data = await list();
      expect(data.root).toBe(repo);
      expect(data.worktree).toBeUndefined();
      expect(data.tree[0].children[0].path).toBe('src/main-only.ts');
    });

    it('falls back to the session folder once a symlink has taken the worktree folder’s place', async () => {
      renameSync(sibling, `${sibling}-moved`);
      symlinkSync(secret, sibling);
      const data = await list('&root=live-any');
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

    it('refuses a sensitive file in the worktree on file-content and file-raw, and serves its neighbours', async () => {
      writeFileSync(join(sibling, '.env'), 'TOKEN=abc');
      mkdirSync(join(sibling, '.aws'));
      writeFileSync(join(sibling, '.aws', 'credentials'), 'aws_secret=abc');
      writeFileSync(join(sibling, 'plain.ts'), 'plain');
      for (const blocked of [join(sibling, '.env'), join(sibling, '.aws', 'credentials')]) {
        const content = await readContent(blocked);
        expect(content.json().success).toBe(false);
        expect(content.body).not.toContain('abc');
        const raw = await harness.app.inject({
          method: 'GET',
          url: sessionUrl(`file-raw?path=${encodeURIComponent(blocked)}`),
        });
        expect(raw.statusCode).not.toBe(200);
        expect(raw.body).not.toContain('abc');
      }
      const plain = await readContent(join(sibling, 'plain.ts'));
      expect(plain.json().success).toBe(true);
      const plainRaw = await harness.app.inject({
        method: 'GET',
        url: sessionUrl(`file-raw?path=${encodeURIComponent(join(sibling, 'plain.ts'))}`),
      });
      expect(plainRaw.statusCode).toBe(200);
      expect(plainRaw.body).toBe('plain');
    });

    // The editor's own gate lets a dotenv file through (#796), so for a file in an outside
    // worktree `validateLocalSessionFilePath()` is the ONLY refusal on the edit path.
    it('refuses to open or save a dotenv file in the worktree through the editor', async () => {
      const target = join(sibling, '.env');
      writeFileSync(target, 'TOKEN=abc');
      const edit = await harness.app.inject({
        method: 'GET',
        url: sessionUrl(`file-content?edit=1&path=${encodeURIComponent(target)}`),
      });
      expect(edit.json().success).toBe(false);
      expect(edit.body).not.toContain('abc');

      const put = await harness.app.inject({
        method: 'PUT',
        url: sessionUrl('file-content'),
        payload: { path: target, content: 'TOKEN=changed', baseHash: sha256('TOKEN=abc') },
      });
      expect(put.statusCode).not.toBe(200);
      expect(put.json().success).toBe(false);
      expect(readFileSync(target, 'utf8')).toBe('TOKEN=abc');

      // The same file in the session's own folder is the one #796 opened.
      writeFileSync(join(repo, '.env'), 'TOKEN=abc');
      const own = await harness.app.inject({
        method: 'PUT',
        url: sessionUrl('file-content'),
        payload: { path: '.env', content: 'TOKEN=changed', baseHash: sha256('TOKEN=abc') },
      });
      expect(own.statusCode).toBe(200);
      expect(readFileSync(join(repo, '.env'), 'utf8')).toBe('TOKEN=changed');
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

  describe('file-preview and file-thumbnail', () => {
    const preview = (path: string) =>
      harness.app.inject({ method: 'GET', url: sessionUrl(`file-preview?path=${encodeURIComponent(path)}`) });
    const thumbnail = (path: string) =>
      harness.app.inject({ method: 'GET', url: sessionUrl(`file-thumbnail?path=${encodeURIComponent(path)}`) });

    beforeEach(() => {
      vi.mocked(generateFirstPageThumbnail).mockClear();
      writeFileSync(join(sibling, 'doc.pdf'), '%PDF-1.4 fake');
      writeFileSync(join(sibling, 'pic.png'), 'png');
    });

    it('answers file-preview for an absolute path inside the worktree', async () => {
      const res = await preview(join(sibling, 'doc.pdf'));
      expect(res.statusCode).toBeGreaterThanOrEqual(300);
      expect(res.statusCode).toBeLessThan(400);
      expect(res.headers.location).toContain('/file-raw?path=');
    });

    it('serves file-thumbnail for an absolute path inside the worktree', async () => {
      const res = await thumbnail(join(sibling, 'pic.png'));
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('image/png');
      expect(generateFirstPageThumbnail).toHaveBeenCalled();
    });

    it('refuses both once a symlink has taken the worktree folder’s place', async () => {
      writeFileSync(join(secret, 'doc.pdf'), '%PDF-1.4 fake');
      writeFileSync(join(secret, 'pic.png'), 'png');
      renameSync(sibling, `${sibling}-moved`);
      symlinkSync(secret, sibling);
      expect((await preview(join(sibling, 'doc.pdf'))).statusCode).toBe(404);
      expect((await thumbnail(join(sibling, 'pic.png'))).statusCode).toBe(404);
      expect(generateFirstPageThumbnail).not.toHaveBeenCalled();
    });
  });
  describe('the attachment guard, judged again on every request', () => {
    const target = () => join(sibling, 'src', 'feature-only.ts');
    const writeSettings = (settings: Record<string, unknown>) => {
      mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
      writeFileSync(SETTINGS_PATH, JSON.stringify(settings));
    };
    const get = (route: string) =>
      harness.app.inject({ method: 'GET', url: sessionUrl(`${route}?path=${encodeURIComponent(target())}`) });

    it('serves the worktree while no guard rule applies', async () => {
      writeSettings({});
      expect((await get('file-raw')).statusCode).toBe(200);
    });

    it.each([
      ['workspace confinement is turned on', () => ({ attachmentConfineToWorkspace: true })],
      ['the worktree’s parent folder is blocked', () => ({ attachmentBlockedPaths: [base] })],
    ])('stops serving it once %s', async (_label, settings) => {
      writeSettings(settings());

      const content = await get('file-content');
      expect(content.json().success).toBe(false);
      expect(content.body).not.toContain('feature');
      expect((await get('file-raw')).statusCode).toBe(404);

      const before = readFileSync(target(), 'utf8');
      const put = await harness.app.inject({
        method: 'PUT',
        url: sessionUrl('file-content'),
        payload: { path: target(), content: 'changed', baseHash: sha256(before) },
      });
      expect(put.statusCode).toBe(404);
      expect(readFileSync(target(), 'utf8')).toBe(before);

      const download = await harness.app.inject({
        method: 'GET',
        url: `/api/download?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(target())}`,
      });
      expect(download.statusCode).toBe(404);

      // The listing walks the session folder, and keeps reporting the worktree so the panel settles.
      const data = await list('&root=live-any');
      expect(data.root).toBe(repo);
      expect(data.tree[0].children[0].path).toBe('src/main-only.ts');
      expect(data.worktree).toEqual({ name: 'myapp-feature', path: sibling, outside: true });
    });
  });
});
