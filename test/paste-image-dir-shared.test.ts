/**
 * @fileoverview Deleting a session keeps the upload dirs while a sibling in the
 * same working directory is still live (Ark0N/Codeman#446).
 *
 * `cleanupSession()` removes `{workingDir}/.codeman-uploads` (and the pre-move
 * `.claude-images`) recursively. That
 * dir belongs to the working directory, not to the session, and several
 * sessions routinely share one case directory, so closing one used to delete
 * the pasted images a live sibling still referred to. The exited-agent sweep
 * closes sessions unattended, which turns that from an occasional loss into a
 * routine one.
 *
 * Port: 0 (ephemeral, read from `server.boundPort`)
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { pasteImageDirInUseByOtherSession } from '../src/web/paste-image-gc.js';
import { probePathKind } from '../src/utils/bounded-path-probe.js';

vi.mock('../src/utils/bounded-path-probe.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/utils/bounded-path-probe.js')>();
  return { ...real, probePathKind: vi.fn(real.probePathKind) };
});

describe('pasteImageDirInUseByOtherSession', () => {
  const none = new Set<string>();
  const check = (
    live: Array<{ id: string; workingDir: string }>,
    opts: { persisted?: Array<{ id: string; workingDir: string; status?: string }>; killing?: Set<string> } = {}
  ) =>
    pasteImageDirInUseByOtherSession({
      live,
      persisted: opts.persisted ?? [],
      closingId: 'a',
      workingDir: '/work/case',
      killing: opts.killing ?? none,
    });

  it('finds a live sibling in the same working directory', () => {
    expect(
      check([
        { id: 'a', workingDir: '/work/case' },
        { id: 'b', workingDir: '/work/case' },
      ])
    ).toBe(true);
  });

  it('ignores the session being closed', () => {
    expect(check([{ id: 'a', workingDir: '/work/case' }])).toBe(false);
  });

  it('ignores sessions in other directories, including a subdirectory', () => {
    expect(
      check([
        { id: 'a', workingDir: '/work/case' },
        { id: 'b', workingDir: '/work/other' },
        { id: 'c', workingDir: '/work/case/sub' },
      ])
    ).toBe(false);
  });

  it('normalises a trailing slash and dot segments', () => {
    expect(check([{ id: 'b', workingDir: '/work/x/../case/' }])).toBe(true);
  });

  it('does not count a sibling that is being killed too', () => {
    // Two sessions of one case killed together must not each defer to the
    // other, or neither removes the dir.
    expect(check([{ id: 'b', workingDir: '/work/case' }], { killing: new Set(['a', 'b']) })).toBe(false);
  });

  it('counts a detached session, which left the map but still runs in tmux', () => {
    // `DELETE ?killMux=false` removes the session from the server's map and
    // keeps its persisted record and its pane.
    expect(check([], { persisted: [{ id: 'b', workingDir: '/work/case', status: 'idle' }] })).toBe(true);
  });

  it('does not count a persisted record demoted to stopped, or the closing session', () => {
    expect(
      check([], {
        persisted: [
          { id: 'a', workingDir: '/work/case', status: 'idle' },
          { id: 'b', workingDir: '/work/case', status: 'stopped' },
        ],
      })
    ).toBe(false);
  });

  it('matches a sibling that reaches the same directory through a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'codeman-paste-link-'));
    try {
      const real = join(root, 'case');
      mkdirSync(real);
      symlinkSync(real, join(root, 'current'));
      expect(
        pasteImageDirInUseByOtherSession({
          live: [{ id: 'b', workingDir: join(root, 'current') }],
          persisted: [],
          closingId: 'a',
          workingDir: real,
          killing: none,
        })
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('deleting a session that shares its working directory', () => {
  let server: WebServer;
  let workingDir: string;
  let base = '';

  beforeAll(async () => {
    workingDir = mkdtempSync(join(tmpdir(), 'codeman-paste-shared-'));
    server = new WebServer(0, false, true);
    await server.start();
    base = `http://localhost:${server.boundPort}`;
  });

  afterAll(async () => {
    await server.stop();
    rmSync(workingDir, { recursive: true, force: true });
  }, 60000);

  const create = async (): Promise<string> => {
    const res = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workingDir }),
    });
    const body = await res.json();
    return body.data.session.id as string;
  };

  const remove = (id: string) => fetch(`${base}/api/sessions/${id}`, { method: 'DELETE' });

  it('keeps the uploads while a sibling is live, and removes them with the last session', async () => {
    const first = await create();
    const second = await create();
    // Both the current dir and the pre-move one, which a case in use back then still carries.
    const uploadDir = join(workingDir, '.codeman-uploads');
    const legacyDir = join(workingDir, '.claude-images');
    mkdirSync(uploadDir, { recursive: true });
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(uploadDir, 'paste-1.png'), 'x');
    writeFileSync(join(legacyDir, 'paste-0.png'), 'x');

    expect((await remove(first)).status).toBe(200);
    expect(existsSync(join(uploadDir, 'paste-1.png'))).toBe(true);
    expect(existsSync(join(legacyDir, 'paste-0.png'))).toBe(true);

    // The delete acts on one path at the user's request, so its probe goes past
    // the bulk stall cap (#516); the hourly sweep keeps the cap. Cleared first:
    // the create path probes the same workspace past the cap too.
    vi.mocked(probePathKind).mockClear();
    expect((await remove(second)).status).toBe(200);
    expect(existsSync(uploadDir)).toBe(false);
    expect(existsSync(legacyDir)).toBe(false);
    expect(probePathKind).toHaveBeenCalledWith(workingDir, { pastCap: true });
  });

  it('does not follow a planted symlink at the upload dir into another case when the last session closes', async () => {
    const other = mkdtempSync(join(tmpdir(), 'codeman-paste-other-'));
    const otherUploads = join(other, '.codeman-uploads');
    mkdirSync(otherUploads);
    writeFileSync(join(otherUploads, 'paste-7.png'), 'x');
    // Planted by a workspace script. uploadDirs() never lists a link, so the delete
    // removes nothing here, and the link itself stays: it is not Codeman's to remove.
    symlinkSync(otherUploads, join(workingDir, '.codeman-uploads'));
    try {
      const only = await create();
      expect((await remove(only)).status).toBe(200);
      expect(existsSync(join(otherUploads, 'paste-7.png'))).toBe(true);
      expect(lstatSync(join(workingDir, '.codeman-uploads')).isSymbolicLink()).toBe(true);
    } finally {
      rmSync(join(workingDir, '.codeman-uploads'), { force: true });
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('keeps the images while a sibling is only detached, since it still runs in tmux', async () => {
    const detached = await create();
    const deleted = await create();
    // Persisting a new record is debounced, and a detach cancels the pending
    // write, so wait for the record a long-running session would already have.
    const store = (server as unknown as { store: { getSession: (id: string) => unknown } }).store;
    await vi.waitFor(() => expect(store.getSession(detached)).toBeTruthy(), { timeout: 10_000 });
    const imageDir = join(workingDir, '.codeman-uploads');
    mkdirSync(imageDir, { recursive: true });
    writeFileSync(join(imageDir, 'paste-2.png'), 'x');

    expect((await fetch(`${base}/api/sessions/${detached}?killMux=false`, { method: 'DELETE' })).status).toBe(200);
    expect((await remove(deleted)).status).toBe(200);
    expect(existsSync(join(imageDir, 'paste-2.png'))).toBe(true);
  });
});
