/**
 * @fileoverview src/case-rename.ts: the in-process lock, the retried folder move and Claude history
 * migration. Real filesystem under test/setup.ts's temp HOME. Port: N/A.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CaseRenameError,
  claudeProjectDirName,
  isCasePathLocked,
  moveCaseFolder,
  moveClaudeHistory,
  renameInOrder,
  siblingPath,
  withCaseLock,
} from '../src/case-rename.js';
import { Session } from '../src/session.js';

const roots: string[] = [];
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'case-rename-'));
  roots.push(dir);
  return dir;
};
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) await fsp.rm(dir, { recursive: true, force: true });
});

describe('withCaseLock', () => {
  it('holds both paths and everything inside them for the length of the call, then lets go', async () => {
    const root = tmp();
    const from = join(root, 'old');
    const to = join(root, 'new');
    let during: boolean[] = [];
    await withCaseLock(from, to, async () => {
      during = [
        isCasePathLocked(from),
        isCasePathLocked(join(from, 'src')),
        isCasePathLocked(to),
        isCasePathLocked(root),
      ];
    });
    expect(during).toEqual([true, true, true, false]);
    expect(isCasePathLocked(from)).toBe(false);
    expect(isCasePathLocked(to)).toBe(false);
  });

  it('refuses an overlapping rename with BUSY and releases on failure', async () => {
    const root = tmp();
    await withCaseLock(join(root, 'a'), join(root, 'b'), async () => {
      await expect(withCaseLock(join(root, 'b'), join(root, 'c'), async () => {})).rejects.toMatchObject({
        code: 'BUSY',
      });
      await expect(withCaseLock(join(root, 'a', 'inner'), join(root, 'x'), async () => {})).rejects.toBeInstanceOf(
        CaseRenameError
      );
    });
    await expect(
      withCaseLock(join(root, 'a'), join(root, 'b'), async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');
    expect(isCasePathLocked(join(root, 'a'))).toBe(false);
  });

  it('keeps a session from starting in a folder that is being moved', async () => {
    const root = tmp();
    const from = join(root, 'case');
    mkdirSync(from);
    await withCaseLock(from, join(root, 'renamed'), async () => {
      expect(() => new Session({ workingDir: from })).toThrow(/being renamed/);
      expect(() => new Session({ workingDir: join(from, 'sub') })).toThrow(/being renamed/);
    });
  });
});

describe('moveCaseFolder', () => {
  it('moves a folder and its contents', async () => {
    const root = tmp();
    mkdirSync(join(root, 'old'));
    writeFileSync(join(root, 'old', 'CLAUDE.md'), 'x');
    await moveCaseFolder(join(root, 'old'), join(root, 'new'));
    expect(existsSync(join(root, 'old'))).toBe(false);
    expect(existsSync(join(root, 'new', 'CLAUDE.md'))).toBe(true);
  });

  it('never replaces an existing folder, even an empty one that rename would silently overwrite', async () => {
    const root = tmp();
    mkdirSync(join(root, 'old'));
    mkdirSync(join(root, 'taken'));
    await expect(moveCaseFolder(join(root, 'old'), join(root, 'taken'))).rejects.toMatchObject({ code: 'EXISTS' });
    expect(existsSync(join(root, 'old'))).toBe(true);
  });

  it('retries a lock error, and succeeds once the other program lets go', async () => {
    const root = tmp();
    mkdirSync(join(root, 'old'));
    const real = fsp.rename.bind(fsp);
    let calls = 0;
    vi.spyOn(fsp, 'rename').mockImplementation(async (a, b) => {
      if (++calls < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      return real(a, b);
    });
    await moveCaseFolder(join(root, 'old'), join(root, 'new'), 4, 1);
    expect(calls).toBe(3);
    expect(existsSync(join(root, 'new'))).toBe(true);
  });

  it('reports a lock that never clears as LOCKED, with what to do about it', async () => {
    const root = tmp();
    mkdirSync(join(root, 'old'));
    vi.spyOn(fsp, 'rename').mockRejectedValue(Object.assign(new Error('perm'), { code: 'EPERM' }));
    const err = await moveCaseFolder(join(root, 'old'), join(root, 'new'), 2, 1).catch((e) => e);
    expect(err).toBeInstanceOf(CaseRenameError);
    expect(err.code).toBe('LOCKED');
    expect(err.message).toMatch(/in use by another program/);
    expect(existsSync(join(root, 'old'))).toBe(true);
  });

  it('refuses to cross filesystems', async () => {
    const root = tmp();
    mkdirSync(join(root, 'old'));
    vi.spyOn(fsp, 'rename').mockRejectedValue(Object.assign(new Error('xdev'), { code: 'EXDEV' }));
    await expect(moveCaseFolder(join(root, 'old'), join(root, 'new'))).rejects.toMatchObject({ code: 'CROSS_DEVICE' });
  });
});

describe('Claude history', () => {
  it('names a project directory the way Claude Code does', () => {
    expect(claudeProjectDirName('/home/devvyn/codeman-cases/my_case')).toBe('-home-devvyn-codeman-cases-my-case');
    expect(claudeProjectDirName('/home/devvyn/.dotcase')).toBe('-home-devvyn--dotcase');
  });

  it('moves the old path’s history to the new one, and leaves existing history alone', async () => {
    const cfg = tmp();
    const projects = join(cfg, 'projects');
    const oldPath = join(tmp(), 'alpha');
    const newPath = join(tmp(), 'beta');
    mkdirSync(join(projects, claudeProjectDirName(oldPath)), { recursive: true });
    writeFileSync(join(projects, claudeProjectDirName(oldPath), 'c.jsonl'), '{}');
    expect(await moveClaudeHistory(oldPath, newPath, cfg)).toBe(true);
    expect(existsSync(join(projects, claudeProjectDirName(newPath), 'c.jsonl'))).toBe(true);
    expect(existsSync(join(projects, claudeProjectDirName(oldPath)))).toBe(false);

    mkdirSync(join(projects, claudeProjectDirName(oldPath)), { recursive: true });
    expect(await moveClaudeHistory(oldPath, newPath, cfg)).toBe(false); // the target already has history
    expect(existsSync(join(projects, claudeProjectDirName(oldPath)))).toBe(true);
    expect(await moveClaudeHistory(join(tmp(), 'none'), newPath, cfg)).toBe(false);
  });
});

describe('small helpers', () => {
  it('renames in an order list keeping the position, and says nothing when absent', () => {
    expect(renameInOrder(['a', 'b', 'c'], 'b', 'z')).toEqual(['a', 'z', 'c']);
    expect(renameInOrder(['a'], 'q', 'z')).toBeNull();
    expect(renameInOrder(undefined, 'a', 'z')).toBeNull();
  });
  it('puts the new name next to the old folder', () => {
    expect(siblingPath('/srv/work/app', 'app2')).toBe('/srv/work/app2');
  });
});
