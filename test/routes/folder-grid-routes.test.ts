/**
 * @fileoverview Folder grid — `POST /api/sessions/:id/folders` grants + lists a
 * folder, `GET …/folders/:folderId/files/:name/(raw|preview|thumbnail)` serves one
 * of its files by name. Local folders are real temp dirs; a remote case mocks only
 * the ssh IO, and the remote listing script itself runs on a real `sh`.
 *
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';
import { folderGrants, validFolderFileName } from '../../src/folder-listing.js';
import type { SessionRemote } from '../../src/types/session.js';

vi.mock('../../src/remote-files.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/remote-files.js')>();
  return {
    ...actual,
    remoteListFolder: vi.fn(),
    remoteProbePaths: vi.fn(),
    remoteCreateReadStream: vi.fn(),
  };
});

import {
  buildRemoteFolderListCommand,
  parseRemoteFolderListOutput,
  remoteCreateReadStream,
  remoteListFolder,
  remoteProbePaths,
} from '../../src/remote-files.js';

const mockedListFolder = vi.mocked(remoteListFolder);
const mockedProbePaths = vi.mocked(remoteProbePaths);
const mockedCreateReadStream = vi.mocked(remoteCreateReadStream);

function touch(path: string, body: string, mtimeSec: number) {
  writeFileSync(path, body);
  utimesSync(path, mtimeSec, mtimeSec);
}

describe('folder grid routes — local folder', () => {
  let harness: RouteTestHarness;
  let sessionId: string;
  let root: string;
  let dir: string;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerFileRoutes);
    sessionId = harness.ctx._sessionId;
    root = mkdtempSync(join(tmpdir(), 'codeman-folder-grid-'));
    dir = join(root, 'renders');
    mkdirSync(dir);
    touch(join(dir, 'old.png'), 'old-png', 1_700_000_000);
    touch(join(dir, 'new.PNG'), 'new-png', 1_700_000_500);
    touch(join(dir, 'clip.mp4'), 'mp4', 1_700_000_100);
    touch(join(dir, 'notes.xyz'), 'unsupported', 1_700_000_900);
    touch(join(dir, '.hidden.png'), 'hidden', 1_700_000_900);
    mkdirSync(join(dir, 'shots'));
    mkdirSync(join(dir, '.cache'));
    harness.ctx._session.workingDir = root;
  });

  afterEach(async () => {
    await harness.app.close();
    folderGrants.clearSession(sessionId);
    rmSync(root, { recursive: true, force: true });
    delete process.env.CODEMAN_ATTACHMENT_CONFINE;
    delete process.env.CODEMAN_ATTACHMENT_BLOCKED_PATHS;
  });

  async function grant(path: string) {
    return harness.app.inject({ method: 'POST', url: `/api/sessions/${sessionId}/folders`, payload: { path } });
  }

  it('lists supported files newest first plus subfolders, skipping hidden + unsupported', async () => {
    const res = await grant(dir);
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body).data;
    expect(data.folderId).toMatch(/^fld_/);
    expect(data.path).toBe(dir);
    expect(data.files.map((f: { name: string }) => f.name)).toEqual(['new.PNG', 'clip.mp4', 'old.png']);
    expect(data.files[0]).toMatchObject({ extension: 'png', attachmentType: 'image', size: 7 });
    expect(data.folders).toEqual(['shots']);
    expect(data.truncated).toBe(false);
  });

  it('grants the same folder the same id', async () => {
    const a = JSON.parse((await grant(dir)).body).data.folderId;
    const b = JSON.parse((await grant(`${dir}/`)).body).data.folderId;
    expect(b).toBe(a);
  });

  it('rejects a relative path, a file, and a missing folder', async () => {
    expect((await grant('renders')).statusCode).toBe(400);
    expect((await grant(join(dir, 'old.png'))).statusCode).toBe(400);
    expect((await grant(join(root, 'nope'))).statusCode).toBe(404);
  });

  it('refuses a blocked folder and a folder outside a confined workspace', async () => {
    process.env.CODEMAN_ATTACHMENT_BLOCKED_PATHS = dir;
    expect((await grant(dir)).statusCode).toBe(403);
    delete process.env.CODEMAN_ATTACHMENT_BLOCKED_PATHS;

    process.env.CODEMAN_ATTACHMENT_CONFINE = '1';
    harness.ctx._session.workingDir = join(dir, 'shots');
    expect((await grant(dir)).statusCode).toBe(403);
    harness.ctx._session.workingDir = root;
    expect((await grant(dir)).statusCode).toBe(200);
  });

  it('serves a granted file by name, with ranges', async () => {
    const { folderId } = JSON.parse((await grant(dir)).body).data;
    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/folders/${folderId}/files/old.png/raw`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.body).toBe('old-png');

    const ranged = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/folders/${folderId}/files/old.png/raw`,
      headers: { range: 'bytes=0-2' },
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.body).toBe('old');
  });

  it('redirects a non-office preview to raw', async () => {
    const { folderId } = JSON.parse((await grant(dir)).body).data;
    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/folders/${folderId}/files/clip.mp4/preview`,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/api/sessions/${sessionId}/folders/${folderId}/files/clip.mp4/raw`);
  });

  it('never serves a name that leaves the folder or has an unsupported type', async () => {
    const { folderId } = JSON.parse((await grant(dir)).body).data;
    writeFileSync(join(root, 'outside.png'), 'outside');
    for (const name of ['..%2Foutside.png', '..', '.', 'notes.xyz', 'shots%2Fx.png']) {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${sessionId}/folders/${folderId}/files/${name}/raw`,
      });
      expect(res.statusCode, name).not.toBe(200);
    }
    const missing = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/folders/${folderId}/files/gone.png/raw`,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('refuses a file in the folder that symlinks to a blocked target', async () => {
    const secret = join(root, 'secret');
    mkdirSync(secret);
    writeFileSync(join(secret, 'key.png'), 'secret');
    symlinkSync(join(secret, 'key.png'), join(dir, 'innocent.png'));
    const { folderId } = JSON.parse((await grant(dir)).body).data;
    process.env.CODEMAN_ATTACHMENT_BLOCKED_PATHS = secret;
    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/folders/${folderId}/files/innocent.png/raw`,
    });
    expect(res.statusCode).toBe(403);
  });

  it('404s an unknown folder id and another session’s grant', async () => {
    const res = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/folders/fld_nope/files/old.png/raw`,
    });
    expect(res.statusCode).toBe(404);
    const foreign = folderGrants.grant('another-session', dir);
    const res2 = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/folders/${foreign}/files/old.png/raw`,
    });
    expect(res2.statusCode).toBe(404);
    folderGrants.clearSession('another-session');
  });
});

describe('folder grid routes — remote (SSH) case', () => {
  const REMOTE_DIR = '/srv/remote/case';
  const remote: SessionRemote = {
    hostId: 'host-1',
    label: 'testhost',
    host: '192.0.2.10',
    username: 'j',
    remotePath: REMOTE_DIR,
  };
  let harness: RouteTestHarness;
  let sessionId: string;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerFileRoutes);
    sessionId = harness.ctx._sessionId;
    harness.ctx._session.workingDir = REMOTE_DIR;
    harness.ctx._session.remote = { ...remote };
    mockedListFolder.mockResolvedValue({
      dir: '/mnt/raid/styleframes',
      entries: [
        { kind: 'file', name: 'a.png', size: 3, mtimeMs: 1000 },
        { kind: 'file', name: 'b.jpg', size: 4, mtimeMs: 2000 },
        { kind: 'directory', name: 'old', size: 0, mtimeMs: 0 },
      ],
      truncated: true,
    });
    mockedProbePaths.mockResolvedValue([
      { realPath: '/mnt/raid/styleframes/a.png', kind: 'file', size: 3, mtimeMs: 1000 },
      { realPath: REMOTE_DIR, kind: 'directory', size: 0, mtimeMs: 0 },
    ]);
    mockedCreateReadStream.mockReturnValue({ stream: Readable.from([Buffer.from('abc')]), close: vi.fn() } as never);
  });

  afterEach(async () => {
    await harness.app.close();
    folderGrants.clearSession(sessionId);
    vi.clearAllMocks();
  });

  it('lists the folder on the remote host and serves its files over ssh', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/folders`,
      payload: { path: '~/styleframes' },
    });
    expect(res.statusCode).toBe(200);
    const data = JSON.parse(res.body).data;
    expect(mockedListFolder).toHaveBeenCalledWith(
      expect.objectContaining({ host: '192.0.2.10' }),
      '~/styleframes',
      expect.arrayContaining(['png', 'pdf']),
      expect.any(Number)
    );
    expect(data.path).toBe('/mnt/raid/styleframes');
    expect(data.files.map((f: { name: string }) => f.name)).toEqual(['b.jpg', 'a.png']);
    expect(data.folders).toEqual(['old']);
    expect(data.truncated).toBe(true);

    const raw = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/folders/${data.folderId}/files/a.png/raw`,
    });
    expect(raw.statusCode).toBe(200);
    expect(raw.body).toBe('abc');
    expect(mockedProbePaths).toHaveBeenCalledWith(expect.anything(), ['/mnt/raid/styleframes/a.png', REMOTE_DIR]);

    const thumb = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/folders/${data.folderId}/files/a.png/thumbnail`,
    });
    expect(thumb.statusCode).toBe(400);
  });

  it('answers 400 "Not a folder" for a remote file, so the client falls back to the preview', async () => {
    mockedListFolder.mockResolvedValue('not-a-folder');
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/folders`,
      payload: { path: '/srv/remote/case/Makefile' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/not a folder/i);
  });

  it('answers 404 for a missing remote folder', async () => {
    mockedListFolder.mockResolvedValue(null);
    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${sessionId}/folders`,
      payload: { path: '/nope' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('remote folder listing script (real sh)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codeman-folder-sh-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function run(dir: string, max = 100, home = root) {
    const stdout = execFileSync('sh', ['-c', buildRemoteFolderListCommand(dir, ['png', 'pdf'], max)], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });
    return parseRemoteFolderListOutput(stdout);
  }

  it('lists supported files with size/mtime, subfolders, odd names; resolves ~ and symlinks', () => {
    const dir = join(root, 'frames');
    mkdirSync(dir);
    touch(join(dir, "it's a | frame.PNG"), '12345', 1_700_000_000);
    touch(join(dir, 'doc.pdf'), 'pdf', 1_700_000_100);
    touch(join(dir, 'skip.txt'), 'x', 1_700_000_100);
    touch(join(dir, '.hidden.png'), 'x', 1_700_000_100);
    mkdirSync(join(dir, 'sub dir'));
    symlinkSync(dir, join(root, 'link'));

    const listing = run('~/link');
    expect(listing?.dir).toBe(dir);
    expect(listing?.truncated).toBe(false);
    const byName = Object.fromEntries((listing?.entries ?? []).map((e) => [e.name, e]));
    expect(Object.keys(byName).sort()).toEqual(['doc.pdf', "it's a | frame.PNG", 'sub dir']);
    expect(byName["it's a | frame.PNG"]).toMatchObject({ kind: 'file', size: 5, mtimeMs: 1_700_000_000_000 });
    expect(byName['sub dir']).toMatchObject({ kind: 'directory' });
  });

  it('caps entries; tells a missing folder (null) from a file', () => {
    for (let i = 0; i < 5; i++) touch(join(root, `f${i}.png`), 'x', 1_700_000_000);
    const capped = run(root, 3);
    expect(capped?.entries).toHaveLength(3);
    expect(capped?.truncated).toBe(true);
    expect(run(join(root, 'missing'))).toBeNull();
    expect(run(join(root, 'f0.png'))).toBe('not-a-folder');
  });
});

describe('validFolderFileName', () => {
  it('accepts bare supported names only', () => {
    expect(validFolderFileName('a b.png')).toBe('a b.png');
    for (const bad of ['', '.', '..', 'a/b.png', 'a\\b.png', 'x.xyz', 'a\0.png', 42]) {
      expect(validFolderFileName(bad)).toBeNull();
    }
  });
});
