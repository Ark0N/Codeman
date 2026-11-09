/**
 * @fileoverview `DELETE /api/sessions/:id/files?path=`, the Files panel's delete button (salvaged
 * from #529).
 *
 * Real temp workspace, no fs mock, like test/routes/file-write-routes.test.ts: the thing under
 * test is what the route does to real files, and the defect it fixes (a delete of
 * `AGENTS.md -> CLAUDE.md` removed CLAUDE.md, because the confinement check hands back the
 * realpath) only shows against a real symlink. Each refusal also checks that nothing on disk moved.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';
import { SETTINGS_PATH } from '../../src/web/route-helpers.js';

describe('DELETE /api/sessions/:id/files (real fs)', () => {
  let harness: RouteTestHarness;
  let base: string;
  let workDir: string;
  let outsideDir: string;

  const del = (path: string, h: RouteTestHarness = harness) =>
    h.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${h.ctx._sessionId}/files?path=${encodeURIComponent(path)}`,
    });

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerFileRoutes);
    // realpath: tmpdir() can hold a symlinked component (macOS /tmp), and the fixtures compare paths.
    base = realpathSync(mkdtempSync(join(tmpdir(), 'codeman-delete-')));
    workDir = join(base, 'ws');
    outsideDir = join(base, 'outside');
    mkdirSync(workDir);
    mkdirSync(outsideDir);
    harness.ctx._session.workingDir = workDir;
  });

  afterEach(async () => {
    await harness.app.close();
    rmSync(base, { recursive: true, force: true });
    rmSync(SETTINGS_PATH, { force: true });
  });

  it('deletes a regular file and answers the path it was given', async () => {
    mkdirSync(join(workDir, 'src'));
    writeFileSync(join(workDir, 'src', 'old.ts'), 'x');
    writeFileSync(join(workDir, 'keep.ts'), 'y');

    const res = await del('src/old.ts');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { path: 'src/old.ts' } });
    expect(existsSync(join(workDir, 'src', 'old.ts'))).toBe(false);
    expect(existsSync(join(workDir, 'src'))).toBe(true);
    expect(readFileSync(join(workDir, 'keep.ts'), 'utf8')).toBe('y');
  });

  it('deletes a file whose name carries quotes and other characters a shell or a URL cares about', async () => {
    const name = "x'-alert(1)-' & #?.txt";
    writeFileSync(join(workDir, name), 'x');

    const res = await del(name);

    expect(res.statusCode).toBe(200);
    expect(existsSync(join(workDir, name))).toBe(false);
  });

  describe('symbolic links are refused, never followed', () => {
    it('leaves both the link and its target when asked to delete AGENTS.md -> CLAUDE.md', async () => {
      writeFileSync(join(workDir, 'CLAUDE.md'), '# rules');
      symlinkSync('CLAUDE.md', join(workDir, 'AGENTS.md'));

      const res = await del('AGENTS.md');

      expect(res.statusCode).toBe(400);
      expect(res.json().success).toBe(false);
      expect(res.json().error).toMatch(/symbolic link/i);
      expect(readFileSync(join(workDir, 'CLAUDE.md'), 'utf8')).toBe('# rules');
      expect(lstatSync(join(workDir, 'AGENTS.md')).isSymbolicLink()).toBe(true);
    });

    it('refuses a link to a folder, which the listing shows as a file row', async () => {
      mkdirSync(join(workDir, 'real'));
      writeFileSync(join(workDir, 'real', 'a.txt'), 'a');
      symlinkSync('real', join(workDir, 'alias'));

      const res = await del('alias');

      expect(res.statusCode).toBe(400);
      expect(readFileSync(join(workDir, 'real', 'a.txt'), 'utf8')).toBe('a');
      expect(lstatSync(join(workDir, 'alias')).isSymbolicLink()).toBe(true);
    });

    it('answers 404 for a link that leads out of the workspace, and leaves its target', async () => {
      writeFileSync(join(outsideDir, 'secret.txt'), 'secret');
      symlinkSync(join(outsideDir, 'secret.txt'), join(workDir, 'leak.txt'));

      const res = await del('leak.txt');

      expect(res.statusCode).toBe(404);
      expect(readFileSync(join(outsideDir, 'secret.txt'), 'utf8')).toBe('secret');
    });

    it('deletes a plain file reached through a linked folder inside the workspace', async () => {
      mkdirSync(join(workDir, 'real'));
      writeFileSync(join(workDir, 'real', 'b.txt'), 'b');
      symlinkSync('real', join(workDir, 'alias'));

      const res = await del('alias/b.txt');

      expect(res.statusCode).toBe(200);
      expect(existsSync(join(workDir, 'real', 'b.txt'))).toBe(false);
      expect(lstatSync(join(workDir, 'alias')).isSymbolicLink()).toBe(true);
    });
  });

  it('refuses a file under .git with 403, also when .git is reached through a linked folder', async () => {
    mkdirSync(join(workDir, '.git'));
    writeFileSync(join(workDir, '.git', 'config'), '[core]');
    symlinkSync('.git', join(workDir, 'gitdir'));

    for (const path of ['.git/config', 'gitdir/config']) {
      const res = await del(path);
      expect(res.statusCode).toBe(403);
      expect(res.json().success).toBe(false);
    }
    expect(readFileSync(join(workDir, '.git', 'config'), 'utf8')).toBe('[core]');
  });

  it('refuses a sensitive file with 403', async () => {
    writeFileSync(join(workDir, '.env'), 'TOKEN=abc');

    const res = await del('.env');

    expect(res.statusCode).toBe(403);
    expect(readFileSync(join(workDir, '.env'), 'utf8')).toBe('TOKEN=abc');
  });

  it('answers 404 for a path that climbs out of the workspace', async () => {
    writeFileSync(join(outsideDir, 'victim.txt'), 'v');

    for (const path of ['../outside/victim.txt', join(outsideDir, 'victim.txt')]) {
      const res = await del(path);
      expect(res.statusCode).toBe(404);
    }
    expect(readFileSync(join(outsideDir, 'victim.txt'), 'utf8')).toBe('v');
  });

  it('answers 404 for a file that does not exist', async () => {
    expect((await del('nope.txt')).statusCode).toBe(404);
  });

  it('refuses a directory with 400', async () => {
    mkdirSync(join(workDir, 'src'));
    writeFileSync(join(workDir, 'src', 'a.ts'), 'a');

    const res = await del('src');

    expect(res.statusCode).toBe(400);
    expect(readFileSync(join(workDir, 'src', 'a.ts'), 'utf8')).toBe('a');
  });

  it('refuses a missing or repeated path parameter with 400', async () => {
    const missing = await harness.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${harness.ctx._sessionId}/files`,
    });
    expect(missing.statusCode).toBe(400);
    writeFileSync(join(workDir, 'a.txt'), 'a');
    const repeated = await harness.app.inject({
      method: 'DELETE',
      url: `/api/sessions/${harness.ctx._sessionId}/files?path=a.txt&path=a.txt`,
    });
    expect(repeated.statusCode).toBe(400);
    expect(existsSync(join(workDir, 'a.txt'))).toBe(true);
  });

  it('refuses a remote (SSH) session before looking at the local twin of its folder', async () => {
    // The local folder of the same absolute name is exactly the hazard: validation would resolve
    // against it and the delete would land here while the user meant the remote file.
    writeFileSync(join(workDir, 'twin.txt'), 'local');
    harness.ctx._session.remote = {
      hostId: 'host-1',
      label: 'testhost',
      host: '192.0.2.10',
      username: 'j',
      remotePath: workDir,
    };

    const res = await del('twin.txt');

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/remote/i);
    expect(readFileSync(join(workDir, 'twin.txt'), 'utf8')).toBe('local');
  });

  it('refuses an adopted session, whose folder is not a workspace of ours', async () => {
    writeFileSync(join(workDir, 'shared.txt'), 'tmp');
    harness.ctx._session.isAdopted = true;

    const res = await del('shared.txt');

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/adopted/i);
    expect(readFileSync(join(workDir, 'shared.txt'), 'utf8')).toBe('tmp');
  });

  describe('a worktree outside the session folder', () => {
    let sibling: string;

    beforeEach(() => {
      sibling = join(base, 'ws-feature');
      mkdirSync(join(sibling, 'src'), { recursive: true });
      writeFileSync(join(sibling, 'src', 'feature.ts'), 'feature');
      Object.assign(harness.ctx._session, {
        liveWorktree: { name: 'ws-feature', path: sibling, outside: true },
      });
    });

    it('deletes an absolute path inside it, as the other file routes serve it', async () => {
      const res = await del(join(sibling, 'src', 'feature.ts'));
      expect(res.statusCode).toBe(200);
      expect(existsSync(join(sibling, 'src', 'feature.ts'))).toBe(false);
    });

    it('does not reach it with a relative path, which resolves against the session folder only', async () => {
      const res = await del('../ws-feature/src/feature.ts');
      expect(res.statusCode).toBe(404);
      expect(existsSync(join(sibling, 'src', 'feature.ts'))).toBe(true);
    });

    it('refuses a symlink in it that leads out of it, and leaves the target', async () => {
      writeFileSync(join(outsideDir, 'key.txt'), 'secret');
      symlinkSync(join(outsideDir, 'key.txt'), join(sibling, 'leak.txt'));

      const res = await del(join(sibling, 'leak.txt'));

      expect(res.statusCode).toBe(404);
      expect(readFileSync(join(outsideDir, 'key.txt'), 'utf8')).toBe('secret');
    });

    it('reaches nothing there once it is no longer an outside worktree', async () => {
      Object.assign(harness.ctx._session, { liveWorktree: { name: 'ws-feature', path: sibling } });
      expect((await del(join(sibling, 'src', 'feature.ts'))).statusCode).toBe(404);
      expect(existsSync(join(sibling, 'src', 'feature.ts'))).toBe(true);
    });

    it.each([
      ['workspace confinement is turned on', () => ({ attachmentConfineToWorkspace: true })],
      ['its parent folder is blocked', () => ({ attachmentBlockedPaths: [base] })],
    ])('deletes nothing there once %s', async (_label, settings) => {
      mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
      writeFileSync(SETTINGS_PATH, JSON.stringify(settings()));

      const res = await del(join(sibling, 'src', 'feature.ts'));

      expect(res.statusCode).toBe(404);
      expect(readFileSync(join(sibling, 'src', 'feature.ts'), 'utf8')).toBe('feature');
    });
  });

  describe('multi-user mode', () => {
    let prevMultiUser: string | undefined;

    beforeEach(() => {
      prevMultiUser = process.env.CODEMAN_MULTIUSER;
      process.env.CODEMAN_MULTIUSER = '1';
    });

    afterEach(() => {
      if (prevMultiUser === undefined) delete process.env.CODEMAN_MULTIUSER;
      else process.env.CODEMAN_MULTIUSER = prevMultiUser;
    });

    it("answers 404 for another user's session and deletes nothing", async () => {
      const bob = await createRouteTestHarness(registerFileRoutes, { authUser: { username: 'bob', role: 'user' } });
      try {
        bob.ctx._session.workingDir = workDir;
        (bob.ctx._session as unknown as { owner?: string }).owner = 'alice';
        writeFileSync(join(workDir, 'alice.txt'), 'mine');

        const res = await del('alice.txt', bob);

        expect(res.statusCode).toBe(404);
        expect(readFileSync(join(workDir, 'alice.txt'), 'utf8')).toBe('mine');
      } finally {
        await bob.app.close();
      }
    });

    it('lets the owner delete in their own session', async () => {
      const bob = await createRouteTestHarness(registerFileRoutes, { authUser: { username: 'bob', role: 'user' } });
      try {
        bob.ctx._session.workingDir = workDir;
        (bob.ctx._session as unknown as { owner?: string }).owner = 'bob';
        writeFileSync(join(workDir, 'bob.txt'), 'mine');

        expect((await del('bob.txt', bob)).statusCode).toBe(200);
        expect(existsSync(join(workDir, 'bob.txt'))).toBe(false);
      } finally {
        await bob.app.close();
      }
    });
  });
});
