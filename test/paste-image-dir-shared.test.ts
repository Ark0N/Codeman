/**
 * @fileoverview Deleting a session keeps `.claude-images` while a sibling in the
 * same working directory is still live (Ark0N/Codeman#446).
 *
 * `cleanupSession()` removes `{workingDir}/.claude-images` recursively. That
 * dir belongs to the working directory, not to the session, and several
 * sessions routinely share one case directory, so closing one used to delete
 * the pasted images a live sibling still referred to. The exited-agent sweep
 * closes sessions unattended, which turns that from an occasional loss into a
 * routine one.
 *
 * Port: 3188
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { pasteImageDirInUseByOtherSession } from '../src/web/paste-image-gc.js';

const PORT = 3188;

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
  const base = `http://localhost:${PORT}`;

  beforeAll(async () => {
    workingDir = mkdtempSync(join(tmpdir(), 'codeman-paste-shared-'));
    server = new WebServer(PORT, false, true);
    await server.start();
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

  it('keeps the images while a sibling is live, and removes them with the last session', async () => {
    const first = await create();
    const second = await create();
    const imageDir = join(workingDir, '.claude-images');
    mkdirSync(imageDir, { recursive: true });
    writeFileSync(join(imageDir, 'paste-1.png'), 'x');

    expect((await remove(first)).status).toBe(200);
    expect(existsSync(join(imageDir, 'paste-1.png'))).toBe(true);

    expect((await remove(second)).status).toBe(200);
    expect(existsSync(imageDir)).toBe(false);
  });

  it('keeps the images while a sibling is only detached, since it still runs in tmux', async () => {
    const detached = await create();
    const deleted = await create();
    // Persisting a new record is debounced, and a detach cancels the pending
    // write, so wait for the record a long-running session would already have.
    const store = (server as unknown as { store: { getSession: (id: string) => unknown } }).store;
    await vi.waitFor(() => expect(store.getSession(detached)).toBeTruthy(), { timeout: 10_000 });
    const imageDir = join(workingDir, '.claude-images');
    mkdirSync(imageDir, { recursive: true });
    writeFileSync(join(imageDir, 'paste-2.png'), 'x');

    expect((await fetch(`${base}/api/sessions/${detached}?killMux=false`, { method: 'DELETE' })).status).toBe(200);
    expect((await remove(deleted)).status).toBe(200);
    expect(existsSync(join(imageDir, 'paste-2.png'))).toBe(true);
  });
});
