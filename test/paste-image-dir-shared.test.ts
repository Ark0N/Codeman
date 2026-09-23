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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebServer } from '../src/web/server.js';
import { pasteImageDirInUseByOtherSession } from '../src/web/paste-image-gc.js';

const PORT = 3188;

describe('pasteImageDirInUseByOtherSession', () => {
  const none = new Set<string>();

  it('finds a live sibling in the same working directory', () => {
    const sessions = [
      { id: 'a', workingDir: '/work/case' },
      { id: 'b', workingDir: '/work/case' },
    ];
    expect(pasteImageDirInUseByOtherSession(sessions, 'a', '/work/case', none)).toBe(true);
  });

  it('ignores the session being closed', () => {
    const sessions = [{ id: 'a', workingDir: '/work/case' }];
    expect(pasteImageDirInUseByOtherSession(sessions, 'a', '/work/case', none)).toBe(false);
  });

  it('ignores sessions in other directories, including a subdirectory', () => {
    const sessions = [
      { id: 'a', workingDir: '/work/case' },
      { id: 'b', workingDir: '/work/other' },
      { id: 'c', workingDir: '/work/case/sub' },
    ];
    expect(pasteImageDirInUseByOtherSession(sessions, 'a', '/work/case', none)).toBe(false);
  });

  it('normalises a trailing slash and dot segments', () => {
    const sessions = [
      { id: 'a', workingDir: '/work/case' },
      { id: 'b', workingDir: '/work/x/../case/' },
    ];
    expect(pasteImageDirInUseByOtherSession(sessions, 'a', '/work/case', none)).toBe(true);
  });

  it('does not count a sibling that is being closed too', () => {
    // Two sessions of one case closed together must not each defer to the
    // other, or neither removes the dir.
    const sessions = [
      { id: 'a', workingDir: '/work/case' },
      { id: 'b', workingDir: '/work/case' },
    ];
    expect(pasteImageDirInUseByOtherSession(sessions, 'a', '/work/case', new Set(['a', 'b']))).toBe(false);
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
});
