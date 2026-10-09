/**
 * @fileoverview The hourly upload sweep reads BOTH upload dirs of a live session:
 * `.codeman-uploads` and the `.claude-images` a case in use before the move still
 * carries. Only `paste-*` regular files past the age cap go. `uploadDirs()` never
 * lists a planted symlink, a directory that is, contains or sits inside the data
 * dir, or anything for a remote session, since the sweep and the delete cleanup
 * both act on what it returns.
 */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LEGACY_UPLOADS_DIR, UPLOADS_DIR, sweepPasteImagesOnce, uploadDirs } from '../src/web/paste-image-gc.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const sessionsOf = (workingDir: string, remote?: unknown) => ({
  sessions: new Map([['s1', { workingDir, remote } as never]]) as never,
});

describe('sweepPasteImagesOnce', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('ages paste-* files out of both the current and the legacy upload dir', async () => {
    const workingDir = mkdtempSync(join(tmpdir(), 'codeman-gc-'));
    dirs.push(workingDir);
    const now = Date.now();
    const current = join(workingDir, UPLOADS_DIR);
    const legacy = join(workingDir, LEGACY_UPLOADS_DIR);
    mkdirSync(current);
    mkdirSync(legacy);
    expect(uploadDirs({ workingDir })).toEqual([current, legacy]);
    const old = (now - 8 * DAY_MS) / 1000;
    const fresh = (now - 1 * DAY_MS) / 1000;
    const plant = (dir: string, name: string, mtime: number) => {
      writeFileSync(join(dir, name), 'x');
      utimesSync(join(dir, name), mtime, mtime);
    };
    plant(current, 'paste-1-aa.pdf', old);
    plant(current, 'paste-2-bb.png', fresh);
    plant(current, 'keep.png', old); // not an upload of ours
    plant(legacy, 'paste-0-cc.png', old);
    symlinkSync(join(legacy, 'paste-0-cc.png'), join(current, 'paste-3-dd.png'));
    utimesSync(join(current, 'paste-3-dd.png'), old, old);

    const result = await sweepPasteImagesOnce(sessionsOf(workingDir), now);

    expect(result.deleted).toBe(2);
    expect(existsSync(join(current, 'paste-1-aa.pdf'))).toBe(false);
    expect(existsSync(join(legacy, 'paste-0-cc.png'))).toBe(false);
    expect(existsSync(join(current, 'paste-2-bb.png'))).toBe(true);
    expect(existsSync(join(current, 'keep.png'))).toBe(true);
    // A planted symlink is skipped (lstat, never followed), so the sweep leaves the link itself.
    expect(lstatSync(join(current, 'paste-3-dd.png')).isSymbolicLink()).toBe(true);
  });

  it('never reads through a planted symlink at the upload dir', async () => {
    const workingDir = mkdtempSync(join(tmpdir(), 'codeman-gc-'));
    const other = mkdtempSync(join(tmpdir(), 'codeman-gc-other-'));
    dirs.push(workingDir, other);
    const now = Date.now();
    const old = (now - 8 * DAY_MS) / 1000;
    mkdirSync(join(other, UPLOADS_DIR));
    writeFileSync(join(other, UPLOADS_DIR, 'paste-9-zz.png'), 'x');
    utimesSync(join(other, UPLOADS_DIR, 'paste-9-zz.png'), old, old);
    // readdir follows a link to a directory, so a listed link would let the sweep
    // age out the other case's uploads through it.
    symlinkSync(join(other, UPLOADS_DIR), join(workingDir, UPLOADS_DIR));

    expect(uploadDirs({ workingDir })).toEqual([]);
    expect(await sweepPasteImagesOnce(sessionsOf(workingDir), now)).toEqual({ scanned: 0, deleted: 0 });
    expect(existsSync(join(other, UPLOADS_DIR, 'paste-9-zz.png'))).toBe(true);
  });
});

describe('uploadDirs', () => {
  const dirs: string[] = [];
  const savedDataDir = process.env.CODEMAN_DATA_DIR;
  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.CODEMAN_DATA_DIR;
    else process.env.CODEMAN_DATA_DIR = savedDataDir;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('lists the upload dir of a home workspace, which sits beside the data dir, not inside it', () => {
    // The home-as-workspace case the flat name exists for: `<home>/.codeman-uploads`
    // is a sibling of `<home>/.codeman`, so a prefix test without the separator would
    // wrongly refuse it.
    const home = mkdtempSync(join(tmpdir(), 'codeman-gc-home-'));
    dirs.push(home);
    process.env.CODEMAN_DATA_DIR = join(home, '.codeman');
    const dir = join(home, UPLOADS_DIR);
    mkdirSync(dir);
    expect(uploadDirs({ workingDir: home })).toEqual([dir]);
  });

  it('refuses an upload dir that is the data dir, contains it, or sits inside it', () => {
    const root = mkdtempSync(join(tmpdir(), 'codeman-gc-data-'));
    const parent = mkdtempSync(join(tmpdir(), 'codeman-gc-link-'));
    dirs.push(root, parent);
    const uploads = join(root, UPLOADS_DIR);
    mkdirSync(join(uploads, 'state'), { recursive: true });
    // `CODEMAN_INSTANCE=uploads` on a home workspace: the upload dir IS the data dir.
    process.env.CODEMAN_DATA_DIR = uploads;
    expect(uploadDirs({ workingDir: root })).toEqual([]);
    // A data dir pointed inside the upload dir: the recursive delete would take it.
    process.env.CODEMAN_DATA_DIR = join(uploads, 'state');
    expect(uploadDirs({ workingDir: root })).toEqual([]);
    // An upload dir inside the data dir, directly and through a symlinked working
    // directory (the upload dir itself is real there).
    process.env.CODEMAN_DATA_DIR = root;
    expect(uploadDirs({ workingDir: root })).toEqual([]);
    symlinkSync(root, join(parent, 'ws'));
    expect(uploadDirs({ workingDir: join(parent, 'ws') })).toEqual([]);
  });

  it('lists nothing for a remote session, whose workingDir is the remote path', async () => {
    // The same path on THIS host belongs to whoever has a local case there.
    const workingDir = mkdtempSync(join(tmpdir(), 'codeman-gc-remote-'));
    dirs.push(workingDir);
    mkdirSync(join(workingDir, UPLOADS_DIR));
    writeFileSync(join(workingDir, UPLOADS_DIR, 'paste-1-aa.png'), 'x');
    const old = (Date.now() - 8 * DAY_MS) / 1000;
    utimesSync(join(workingDir, UPLOADS_DIR, 'paste-1-aa.png'), old, old);
    const remote = { hostId: 'gpu-box' };
    expect(uploadDirs({ workingDir, remote })).toEqual([]);
    expect(await sweepPasteImagesOnce(sessionsOf(workingDir, remote))).toEqual({ scanned: 0, deleted: 0 });
    expect(existsSync(join(workingDir, UPLOADS_DIR, 'paste-1-aa.png'))).toBe(true);
  });
});
