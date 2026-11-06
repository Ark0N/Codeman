/**
 * @fileoverview src/case-rename.ts: the in-process lock, the record of sessions still being created, the
 * retried folder move and Claude history migration. Real filesystem under test/setup.ts's temp HOME. Port: N/A.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CaseRenameError,
  caseSessionSettled,
  claudeProjectDirName,
  isCasePathLocked,
  isCaseSessionStarting,
  moveCaseFolder,
  noteCaseSessionStarting,
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

describe('sessions still being created', () => {
  it('counts a constructed session as starting in its folder until the server settles it', () => {
    const root = tmp();
    const dir = join(root, 'case');
    const session = new Session({ workingDir: join(dir, 'sub') });
    expect(isCaseSessionStarting(dir)).toBe(true);
    expect(isCaseSessionStarting(join(dir, 'sub'))).toBe(true);
    expect(isCaseSessionStarting(join(dir, 'other'))).toBe(false);
    expect(isCaseSessionStarting(`${dir}-2`)).toBe(false);
    caseSessionSettled(session);
    expect(isCaseSessionStarting(dir)).toBe(false);
  });

  it('lets go of a session that is stopped, and of one never registered once a while has passed', async () => {
    const root = tmp();
    const stopped = new Session({ workingDir: root });
    await stopped.stop();
    expect(isCaseSessionStarting(root)).toBe(false);
    // a create that failed before registering, or a one-shot prompt that never registers
    const lost = {};
    noteCaseSessionStarting(lost, root, 1000);
    expect(isCaseSessionStarting(root, 1000 + 29_999)).toBe(true);
    expect(isCaseSessionStarting(root, 1000 + 30_000)).toBe(false);
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

  it('moves the old path’s history to the new one', async () => {
    const cfg = tmp();
    const projects = join(cfg, 'projects');
    const oldPath = join(tmp(), 'alpha');
    const newPath = join(tmp(), 'beta');
    mkdirSync(join(projects, claudeProjectDirName(oldPath)), { recursive: true });
    writeFileSync(join(projects, claudeProjectDirName(oldPath), 'c.jsonl'), '{}');
    expect(await moveClaudeHistory(oldPath, newPath, cfg)).toBe(true);
    expect(existsSync(join(projects, claudeProjectDirName(newPath), 'c.jsonl'))).toBe(true);
    expect(existsSync(join(projects, claudeProjectDirName(oldPath)))).toBe(false);
    expect(await moveClaudeHistory(join(tmp(), 'none'), newPath, cfg)).toBe(false);
  });

  it('merges into history already at the new path (a deleted case’s leftovers) without overwriting any of it', async () => {
    const cfg = tmp();
    const projects = join(cfg, 'projects');
    const oldPath = join(tmp(), 'alpha');
    const newPath = join(tmp(), 'beta');
    const from = join(projects, claudeProjectDirName(oldPath));
    const to = join(projects, claudeProjectDirName(newPath));
    mkdirSync(join(from, 'conv-a', 'subagents'), { recursive: true });
    writeFileSync(join(from, 'conv-a.jsonl'), 'alpha');
    writeFileSync(join(from, 'conv-a', 'subagents', 'agent-1.jsonl'), 'alpha agent');
    mkdirSync(join(from, 'memory'));
    writeFileSync(join(from, 'memory', 'MEMORY.md'), 'alpha memory');
    // Claude Code never removes a project directory, so a case deleted earlier under the new name left this.
    mkdirSync(join(to, 'memory'), { recursive: true });
    writeFileSync(join(to, 'conv-old.jsonl'), 'old beta');
    writeFileSync(join(to, 'memory', 'MEMORY.md'), 'old beta memory');

    expect(await moveClaudeHistory(oldPath, newPath, cfg)).toBe(true);

    expect(readFileSync(join(to, 'conv-a.jsonl'), 'utf8')).toBe('alpha');
    expect(readFileSync(join(to, 'conv-a', 'subagents', 'agent-1.jsonl'), 'utf8')).toBe('alpha agent');
    expect(readFileSync(join(to, 'conv-old.jsonl'), 'utf8')).toBe('old beta');
    // an entry both have is never overwritten: it stays where it was
    expect(readFileSync(join(to, 'memory', 'MEMORY.md'), 'utf8')).toBe('old beta memory');
    expect(readFileSync(join(from, 'memory', 'MEMORY.md'), 'utf8')).toBe('alpha memory');
    expect(existsSync(join(from, 'conv-a.jsonl'))).toBe(false);
  });

  it('removes the old project directory once a merge has emptied it, and never merges into a symlink', async () => {
    const cfg = tmp();
    const projects = join(cfg, 'projects');
    const oldPath = join(tmp(), 'alpha');
    const newPath = join(tmp(), 'beta');
    const from = join(projects, claudeProjectDirName(oldPath));
    const to = join(projects, claudeProjectDirName(newPath));
    mkdirSync(from, { recursive: true });
    mkdirSync(to, { recursive: true });
    writeFileSync(join(from, 'conv-a.jsonl'), 'alpha');
    expect(await moveClaudeHistory(oldPath, newPath, cfg)).toBe(true);
    expect(existsSync(from)).toBe(false);

    const elsewhere = tmp();
    const linkedPath = join(tmp(), 'gamma');
    mkdirSync(from);
    writeFileSync(join(from, 'conv-b.jsonl'), 'alpha');
    symlinkSync(elsewhere, join(projects, claudeProjectDirName(linkedPath)));
    expect(await moveClaudeHistory(oldPath, linkedPath, cfg)).toBe(false);
    expect(existsSync(join(from, 'conv-b.jsonl'))).toBe(true);
    expect(existsSync(join(elsewhere, 'conv-b.jsonl'))).toBe(false);
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
