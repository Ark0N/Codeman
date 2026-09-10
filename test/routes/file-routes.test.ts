/**
 * @fileoverview Tests for file-routes route handlers.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';
import { ApiErrorCode } from '../../src/types.js';
import { CASES_DIR } from '../../src/web/route-helpers.js';

// Mock fs/promises for file operations
vi.mock('node:fs/promises', () => ({
  default: {
    readdir: vi.fn(async () => []),
    readFile: vi.fn(async () => 'file content'),
    stat: vi.fn(async () => ({ size: 100, isFile: () => true, isDirectory: () => true })),
  },
}));

// Mock realpathSync for symlink resolution, plus createReadStream: file-raw
// STREAMS its body (range support), so an unmocked read would hit the real
// filesystem and fail with ENOENT rather than serving the fixture bytes.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    realpathSync: vi.fn((p: string) => p),
    createReadStream: vi.fn(() => Readable.from([Buffer.from('fake file bytes')])),
  };
});

// Mock fileStreamManager
vi.mock('../../src/file-stream-manager.js', () => ({
  fileStreamManager: {
    createStream: vi.fn(async () => ({ success: true, streamId: 'stream-1' })),
    closeStream: vi.fn(() => true),
  },
}));

import fs from 'node:fs/promises';
import { createReadStream, realpathSync } from 'node:fs';
import { fileStreamManager } from '../../src/file-stream-manager.js';

const mockedReaddir = vi.mocked(fs.readdir);
const mockedReadFile = vi.mocked(fs.readFile);
const mockedStat = vi.mocked(fs.stat);
const mockedRealpathSync = vi.mocked(realpathSync);
const mockedCreateReadStream = vi.mocked(createReadStream);
const mockedFileStreamManager = vi.mocked(fileStreamManager);

describe('file-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerFileRoutes);
    vi.clearAllMocks();

    // Default: realpathSync returns the path unchanged
    mockedRealpathSync.mockImplementation((p: string) => p as never);
    mockedCreateReadStream.mockImplementation(() => Readable.from([Buffer.from('fake file bytes')]) as never);
    // Default stat
    mockedStat.mockResolvedValue({ size: 100, isFile: () => true, isDirectory: () => true } as never);
    mockedReadFile.mockImplementation(async (path) =>
      String(path).endsWith('settings.json') ? ('{}' as never) : ('file content' as never)
    );
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== GET /api/filesystem/browse ==========

  describe('GET /api/filesystem/browse', () => {
    it('lists the active session folder lazily with directories first', async () => {
      mockedReaddir.mockResolvedValueOnce([
        {
          name: 'notes.txt',
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        },
        {
          name: 'src',
          isDirectory: () => true,
          isFile: () => false,
          isSymbolicLink: () => false,
        },
      ] as never);

      const path = harness.ctx._session.workingDir;
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/filesystem/browse?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(path)}`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.path).toBe(path);
      expect(body.data.roots[0]).toEqual({ label: 'Current Folder', path });
      expect(
        body.data.entries.map((entry: { name: string; type: string; previewKind?: string }) => [
          entry.name,
          entry.type,
          entry.previewKind,
        ])
      ).toEqual([
        ['src', 'directory', undefined],
        ['notes.txt', 'file', 'text'],
      ]);
    });

    it('defaults to the Codeman Cases root, not Home, when linking a case with no path chosen yet', async () => {
      // The "Link Existing" case picker opens with an empty path and no
      // sessionId. `Home` and `Codeman Cases` are unrelated bind mounts under
      // Docker, so falling back to whichever root happened to be listed first
      // could open the picker somewhere with no cases in it at all — and, worse,
      // make a stale directory from a since-changed CODEMAN_CASES_PATH look like
      // a normal thing to stumble across while browsing for one to link.
      const res = await harness.app.inject({ method: 'GET', url: '/api/filesystem/browse' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.path).toBe(CASES_DIR);
    });

    it('rejects paths outside the configured roots', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/filesystem/browse?path=${encodeURIComponent('/tmp/not-an-allowed-root')}`,
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.INVALID_INPUT });
    });

    it('does not expose hidden entries or symlinks that escape the allowed roots', async () => {
      const root = harness.ctx._session.workingDir;
      mockedReaddir.mockResolvedValueOnce([
        {
          name: '.secret',
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => false,
        },
        {
          name: 'outside-link',
          isDirectory: () => false,
          isFile: () => false,
          isSymbolicLink: () => true,
        },
      ] as never);
      mockedRealpathSync.mockImplementation((path: string) =>
        path === `${root}/outside-link` ? ('/etc/shadow' as never) : (path as never)
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/filesystem/browse?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(root)}`,
      });

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data.entries).toEqual([]);
    });

    it('returns 404 for an unknown session scope', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/filesystem/browse?sessionId=missing-session',
      });

      expect(res.statusCode).toBe(404);
      expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.NOT_FOUND });
    });

    it('rejects direct navigation into a hidden descendant', async () => {
      const hidden = `${harness.ctx._session.workingDir}/.git`;
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/filesystem/browse?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(hidden)}`,
      });

      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.INVALID_INPUT });
    });

    // ===== showHidden=true (issue #221) =====
    //
    // The dotfile filter used to be doing security work by accident: with every
    // hidden path unreachable, the sensitive-path blocklist never had to cover
    // `~/.config/gh/hosts.yml` and friends. These pin that opting in lifts the
    // hidden filter and NOTHING else — blocked trees, sensitive files and root
    // confinement all still apply.
    describe('showHidden=true', () => {
      it('lists dot-prefixed entries', async () => {
        mockedReaddir.mockResolvedValueOnce([
          { name: '.github', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
          { name: '.gitignore', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
          { name: 'src', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
        ] as never);

        const root = harness.ctx._session.workingDir;
        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/filesystem/browse?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(root)}&showHidden=true`,
        });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).data.entries.map((e: { name: string }) => e.name)).toEqual([
          '.github',
          'src',
          '.gitignore',
        ]);
      });

      it('allows navigating into a hidden descendant', async () => {
        mockedReaddir.mockResolvedValueOnce([
          { name: 'workflows', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
        ] as never);

        const hidden = `${harness.ctx._session.workingDir}/.github`;
        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/filesystem/browse?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(hidden)}&showHidden=true`,
        });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).data.path).toBe(hidden);
      });

      it('still hides dot-prefixed entries when the flag is absent or false', async () => {
        const entries = [
          { name: '.gitignore', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
          { name: 'src', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
        ];
        const root = harness.ctx._session.workingDir;

        for (const query of ['', '&showHidden=false']) {
          mockedReaddir.mockResolvedValueOnce(entries as never);
          const res = await harness.app.inject({
            method: 'GET',
            url: `/api/filesystem/browse?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(root)}${query}`,
          });
          expect(res.statusCode).toBe(200);
          expect(JSON.parse(res.body).data.entries.map((e: { name: string }) => e.name)).toEqual(['src']);
        }
      });

      it('rejects a showHidden value that is not a boolean string', async () => {
        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/filesystem/browse?sessionId=${harness.ctx._sessionId}&showHidden=yes`,
        });

        expect(res.statusCode).toBe(400);
        expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.INVALID_INPUT });
      });

      it('still omits blocked and sensitive entries', async () => {
        const root = harness.ctx._session.workingDir;
        mockedReaddir.mockResolvedValueOnce([
          { name: '.ssh', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false },
          { name: '.npmrc', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
          { name: '.env', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
          { name: '.gitignore', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false },
          // A plainly-named symlink whose target is a secret: caught on the
          // resolved path, not the visible name.
          { name: 'notes', isDirectory: () => false, isFile: () => false, isSymbolicLink: () => true },
        ] as never);
        mockedRealpathSync.mockImplementation((p: string) =>
          p === `${root}/notes` ? (`${root}/.aws/credentials` as never) : (p as never)
        );

        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/filesystem/browse?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(root)}&showHidden=true`,
        });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).data.entries.map((e: { name: string }) => e.name)).toEqual(['.gitignore']);
      });

      it('refuses a hidden path that resolves outside every root', async () => {
        const outside = `${harness.ctx._session.workingDir}/.cache`;
        mockedRealpathSync.mockImplementation((p: string) =>
          p === outside ? ('/tmp/somewhere-else' as never) : (p as never)
        );

        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/filesystem/browse?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(outside)}&showHidden=true`,
        });

        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.INVALID_INPUT });
      });
    });
  });

  // ========== Multi-user scoping for the filesystem picker ==========
  //
  // The picker is a SECOND file-serving surface and does not inherit the
  // attachment guard's ownership scoping, so both of its endpoints have to do
  // it themselves. Two distinct holes are covered here:
  //   1. `sessionId` was used without an owner check, so any user could pin
  //      another user's workingDir as a browse root.
  //   2. `Home` and `CASES_DIR` were unconditional roots, and per-user spaces
  //      live INSIDE homedir(), so Home alone exposed every other user's files.
  describe('filesystem picker multi-user scoping', () => {
    const SPACES = '/tmp/codeman-test-user-spaces';
    let prevMultiUser: string | undefined;
    let prevSpaces: string | undefined;

    beforeEach(() => {
      prevMultiUser = process.env.CODEMAN_MULTIUSER;
      prevSpaces = process.env.CODEMAN_USER_SPACES_DIR;
      process.env.CODEMAN_MULTIUSER = '1';
      process.env.CODEMAN_USER_SPACES_DIR = SPACES;
    });

    afterEach(() => {
      if (prevMultiUser === undefined) delete process.env.CODEMAN_MULTIUSER;
      else process.env.CODEMAN_MULTIUSER = prevMultiUser;
      if (prevSpaces === undefined) delete process.env.CODEMAN_USER_SPACES_DIR;
      else process.env.CODEMAN_USER_SPACES_DIR = prevSpaces;
    });

    const harnessAs = (role: 'admin' | 'user', username: string) =>
      createRouteTestHarness(registerFileRoutes, { authUser: { username, role } });

    it('404s a browse scoped to another user session instead of adopting its folder', async () => {
      const scoped = await harnessAs('user', 'bob');
      scoped.ctx._session.owner = 'alice';
      try {
        const res = await scoped.app.inject({
          method: 'GET',
          url: `/api/filesystem/browse?sessionId=${scoped.ctx._sessionId}`,
        });

        expect(res.statusCode).toBe(404);
        expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.NOT_FOUND });
        // The decisive part: alice's folder must not have leaked in as a root.
        expect(res.body).not.toContain(scoped.ctx._session.workingDir);
      } finally {
        await scoped.app.close();
      }
    });

    it('404s a preview scoped to another user session', async () => {
      const scoped = await harnessAs('user', 'bob');
      scoped.ctx._session.owner = 'alice';
      try {
        const res = await scoped.app.inject({
          method: 'GET',
          url: `/api/filesystem/preview?sessionId=${scoped.ctx._sessionId}&path=${encodeURIComponent(
            `${scoped.ctx._session.workingDir}/notes.md`
          )}`,
        });

        expect(res.statusCode).toBe(404);
      } finally {
        await scoped.app.close();
      }
    });

    it('confines a regular user to their own space, never Home or the shared cases dir', async () => {
      const scoped = await harnessAs('user', 'bob');
      try {
        mockedReaddir.mockResolvedValueOnce([] as never);
        const res = await scoped.app.inject({ method: 'GET', url: '/api/filesystem/browse' });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.data.roots).toEqual([{ label: 'My Space', path: `${SPACES}/bob` }]);
        expect(body.data.path).toBe(`${SPACES}/bob`);
      } finally {
        await scoped.app.close();
      }
    });

    it("refuses to browse another user's space by absolute path", async () => {
      const scoped = await harnessAs('user', 'bob');
      try {
        const res = await scoped.app.inject({
          method: 'GET',
          url: `/api/filesystem/browse?path=${encodeURIComponent(`${SPACES}/alice/cases`)}`,
        });

        expect(res.statusCode).toBe(403);
        expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.INVALID_INPUT });
      } finally {
        await scoped.app.close();
      }
    });

    it('keeps the host-wide roots for a multi-user admin', async () => {
      const scoped = await harnessAs('admin', 'root');
      try {
        mockedReaddir.mockResolvedValueOnce([] as never);
        const res = await scoped.app.inject({ method: 'GET', url: '/api/filesystem/browse' });

        expect(res.statusCode).toBe(200);
        const labels = JSON.parse(res.body).data.roots.map((root: { label: string }) => root.label);
        expect(labels).toContain('Home');
        expect(labels).not.toContain('My Space');
      } finally {
        await scoped.app.close();
      }
    });
  });

  // ========== GET /api/filesystem/preview ==========

  describe('GET /api/filesystem/preview', () => {
    it('serves Markdown as inert plain text inside the active session root', async () => {
      const path = `${harness.ctx._session.workingDir}/notes.md`;
      mockedReadFile.mockImplementation(async (candidate) =>
        candidate === path ? ('# Safe heading\n<script>alert(1)</script>' as never) : ('{}' as never)
      );
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/filesystem/preview?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(path)}`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/plain');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.body).toContain('<script>alert(1)</script>');
    });

    it('rejects unsupported file types', async () => {
      const path = `${harness.ctx._session.workingDir}/archive.exe`;
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/filesystem/preview?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(path)}`,
      });

      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.INVALID_INPUT });
    });

    it('rejects hidden files even when requested directly', async () => {
      const path = `${harness.ctx._session.workingDir}/.env`;
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/filesystem/preview?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(path)}`,
      });

      expect(res.statusCode).toBe(403);
    });

    it('rejects a preview symlink whose real path escapes every allowed root', async () => {
      const path = `${harness.ctx._session.workingDir}/outside.png`;
      mockedRealpathSync.mockImplementation((candidate: string) =>
        candidate === path ? ('/etc/shadow' as never) : (candidate as never)
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/filesystem/preview?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(path)}`,
      });

      expect(res.statusCode).toBe(403);
    });

    it('caps text previews at 2MB', async () => {
      const path = `${harness.ctx._session.workingDir}/large.txt`;
      mockedStat.mockImplementation(async (candidate) =>
        candidate === path
          ? ({ size: 2 * 1024 * 1024 + 1, isFile: () => true, isDirectory: () => false } as never)
          : ({ size: 100, isFile: () => true, isDirectory: () => true } as never)
      );
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/filesystem/preview?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(path)}`,
      });

      expect(res.statusCode).toBe(413);
    });
  });

  // ========== GET /api/sessions/:id/files ==========

  describe('GET /api/sessions/:id/files', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/files',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns file tree for valid session', async () => {
      mockedReaddir.mockResolvedValue([
        { name: 'src', isDirectory: () => true },
        { name: 'package.json', isDirectory: () => false, name_: 'package.json' },
      ] as never);
      // Nested readdir for src/ returns empty
      mockedReaddir.mockResolvedValueOnce([
        { name: 'src', isDirectory: () => true },
        { name: 'package.json', isDirectory: () => false },
      ] as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.root).toBe(harness.ctx._session.workingDir);
      expect(body.data.tree).toBeDefined();
    });

    it('respects depth parameter', async () => {
      mockedReaddir.mockResolvedValue([] as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files?depth=2`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });

    it('excludes hidden files by default', async () => {
      mockedReaddir.mockResolvedValue([
        { name: '.hidden', isDirectory: () => false },
        { name: 'visible.ts', isDirectory: () => false },
      ] as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Hidden files should be excluded
      expect(body.data.totalFiles).toBe(1);
    });

    it('includes hidden files when showHidden=true', async () => {
      mockedReaddir.mockResolvedValue([
        { name: '.hidden', isDirectory: () => false },
        { name: 'visible.ts', isDirectory: () => false },
      ] as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files?showHidden=true`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.totalFiles).toBe(2);
    });

    it('excludes node_modules and .git directories', async () => {
      let callCount = 0;
      mockedReaddir.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return [
            { name: 'node_modules', isDirectory: () => true },
            { name: '.git', isDirectory: () => true },
            { name: 'src', isDirectory: () => true },
          ] as never;
        }
        return [] as never;
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/files?showHidden=true`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // node_modules and .git are in excludeDirs set — only src should be counted
      expect(body.data.totalDirectories).toBe(1); // only src
    });
  });

  // ========== GET /api/sessions/:id/file-content ==========

  describe('GET /api/sessions/:id/file-content', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/file-content?path=test.ts',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns error for missing path parameter', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Missing path');
    });

    it('returns text file content', async () => {
      const fileContent = 'const x = 1;\nconst y = 2;\n';
      mockedReadFile.mockResolvedValue(fileContent as never);
      mockedStat.mockResolvedValue({ size: fileContent.length } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=src/test.ts`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.content).toBe(fileContent);
      expect(body.data.extension).toBe('ts');
    });

    it('returns binary metadata for image files', async () => {
      mockedStat.mockResolvedValue({ size: 1024 } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=logo.png`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.type).toBe('image');
      expect(body.data.url).toContain('file-raw');
    });

    it('returns audio metadata for audio files', async () => {
      mockedStat.mockResolvedValue({ size: 2048 } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=clip.mp3`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.type).toBe('audio');
      expect(body.data.url).toContain('file-raw');
    });

    it('flags known-binary extensions (e.g. xlsx) instead of dumping mojibake', async () => {
      mockedStat.mockResolvedValue({ size: 4096 } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=sheet.xlsx`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.type).toBe('binary');
      expect(body.data.content).toBeUndefined();
    });

    it('sniffs NUL bytes and flags binary content for unknown extensions', async () => {
      const binary = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01, 0x02]);
      mockedReadFile.mockResolvedValue(binary as never);
      mockedStat.mockResolvedValue({ size: binary.length } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=mystery.dat`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.type).toBe('binary');
      expect(body.data.content).toBeUndefined();
    });

    it('rejects path traversal attempts', async () => {
      // realpathSync resolves the symlink to a path outside workingDir
      mockedRealpathSync.mockImplementation(
        (p: string) => (p === harness.ctx._session.workingDir ? p : '/etc/passwd') as never
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=../../etc/passwd`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects files that are too large', async () => {
      mockedStat.mockResolvedValue({ size: 20 * 1024 * 1024 } as never); // 20MB

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=large-file.txt`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('too large');
    });

    it('truncates content when exceeding line limit', async () => {
      const lines = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join('\n');
      mockedReadFile.mockResolvedValue(lines as never);
      mockedStat.mockResolvedValue({ size: lines.length } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=big.txt&lines=100`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.truncated).toBe(true);
      expect(body.data.totalLines).toBe(600);
    });

    it('returns file not found when realpathSync throws', async () => {
      mockedRealpathSync.mockImplementation(() => {
        throw new Error('ENOENT');
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-content?path=nonexistent.ts`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });
  });

  // ========== GET /api/sessions/:id/file-raw ==========

  describe('GET /api/sessions/:id/file-raw', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/file-raw?path=test.png',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 400 for missing path parameter', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-raw`,
      });
      expect(res.statusCode).toBe(400);
    });

    it('serves raw file with correct content type', async () => {
      const content = Buffer.from('fake png data');
      mockedCreateReadStream.mockReturnValue(Readable.from([content]) as never);
      mockedStat.mockResolvedValue({ size: content.length } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-raw?path=image.png`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
    });

    it('serves workspace SVG as an untrusted attachment instead of inline image/svg+xml', async () => {
      const content = Buffer.from('<svg><script>alert("xss")</script></svg>');
      mockedCreateReadStream.mockReturnValue(Readable.from([content]) as never);
      mockedStat.mockResolvedValue({ size: content.length } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-raw?path=malicious.svg`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('application/octet-stream');
      expect(res.headers['content-disposition']).toContain('attachment; filename="malicious.svg"');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
    });

    it('rejects path traversal in raw file serving', async () => {
      mockedRealpathSync.mockImplementation(
        (p: string) => (p === harness.ctx._session.workingDir ? p : '/etc/shadow') as never
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-raw?path=../../etc/shadow`,
      });
      // Path traversal returns 404 ("File not found") to avoid revealing the target exists.
      expect(res.statusCode).toBe(404);
    });

    it('serves a file past the historical 50MB cap', async () => {
      // The body is streamed and Range-aware, so size costs a read stream, not
      // RSS. The old 50MB refusal only blocked legitimate artifact downloads.
      mockedStat.mockResolvedValue({ size: 100 * 1024 * 1024, isFile: () => true } as never); // 100MB

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-raw?path=huge.bin`,
      });
      expect(res.statusCode).toBe(200);
    });

    it('still refuses a file past the configured download cap', async () => {
      mockedStat.mockResolvedValue({ size: 3 * 1024 * 1024 * 1024, isFile: () => true } as never); // 3GB > 2GB default

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/file-raw?path=enormous.bin`,
      });
      expect(res.statusCode).toBe(413);
      expect(JSON.parse(res.body).error).toContain('CODEMAN_MAX_DOWNLOAD_BYTES');
    });
  });

  // ========== DELETE /api/sessions/:id/tail-file/:streamId ==========

  describe('DELETE /api/sessions/:id/tail-file/:streamId', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/sessions/nonexistent/tail-file/stream-1',
      });
      expect(res.statusCode).toBe(404);
    });

    it('closes an existing stream', async () => {
      mockedFileStreamManager.closeStream.mockReturnValue(true);

      const res = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}/tail-file/stream-1`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.closed).toBe(true);
      expect(mockedFileStreamManager.closeStream).toHaveBeenCalledWith('stream-1');
    });

    it('returns closed: false for unknown stream', async () => {
      mockedFileStreamManager.closeStream.mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}/tail-file/nonexistent`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.closed).toBe(false);
    });
  });

  // ========== GET /api/download ==========

  describe('GET /api/download', () => {
    it('requires a sessionId to scope downloads', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/download?path=${encodeURIComponent('/tmp/test-workdir/report.txt')}`,
      });

      expect(res.statusCode).toBe(400);
    });

    it('downloads files scoped to the session working directory', async () => {
      // The body is streamed (shared sendFileBody path), so the bytes come from
      // the createReadStream mock rather than from readFile.
      const content = Buffer.from('fake file bytes');
      mockedStat.mockResolvedValue({ size: content.length, isFile: () => true } as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/download?sessionId=${harness.ctx._sessionId}&path=report.txt`,
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-disposition']).toContain('filename="report.txt"');
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.body).toBe('fake file bytes');
    });

    it('refuses a download past the configured cap', async () => {
      mockedStat.mockResolvedValue({ size: 3 * 1024 * 1024 * 1024, isFile: () => true } as never); // 3GB > 2GB default

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/download?sessionId=${harness.ctx._sessionId}&path=enormous.bin`,
      });

      expect(res.statusCode).toBe(413);
    });

    it('rejects absolute paths outside the session working directory', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/download?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent('/var/log/app.log')}`,
      });

      expect(res.statusCode).toBe(404);
    });

    it('rejects symlink targets that escape the session working directory', async () => {
      mockedRealpathSync.mockImplementation(
        (p: string) => (p === harness.ctx._session.workingDir ? p : '/tmp/outside-workdir/link.log') as never
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/download?sessionId=${harness.ctx._sessionId}&path=${encodeURIComponent(
          '/tmp/test-workdir/link.log'
        )}`,
      });

      expect(res.statusCode).toBe(404);
    });

    it('blocks sensitive files even when they are inside the session working directory', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/download?sessionId=${harness.ctx._sessionId}&path=.env`,
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
