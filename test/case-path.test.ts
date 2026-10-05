// @vitest-environment node
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blockedReason, expandHome, prepareNewCasePath, type NewCasePathContext } from '../src/web/case-path.js';

let root: string;
let home: string;
let ctx: NewCasePathContext;

beforeEach(() => {
  // Resolved: prepareNewCasePath answers with symlink-resolved paths (macOS temp is under /private).
  root = realpathSync(mkdtempSync(join(tmpdir(), 'case-path-')));
  home = join(root, 'home');
  mkdirSync(join(home, 'code'), { recursive: true });
  ctx = { home, dataDir: join(home, '.codeman') };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('expandHome', () => {
  it('expands ~ and ~/x only', () => {
    expect(expandHome('~', '/h')).toBe('/h');
    expect(expandHome('~/code/app', '/h')).toBe('/h/code/app');
    expect(expandHome('~other/x', '/h')).toBe('~other/x');
    expect(expandHome('/abs/~/x', '/h')).toBe('/abs/~/x');
  });
});

describe('blockedReason', () => {
  const c = { home: '/home/u', dataDir: '/home/u/.codeman' };
  it.each([
    ['/', /root/],
    ['/etc', /system directory/],
    ['/etc/cron.d/x', /system directory/],
    ['/usr/local/src', /system directory/],
    ['/proc/1', /system directory/],
    ['/home/u', /home folder itself/],
    ['/home/u/.ssh', /credentials/],
    ['/home/u/.ssh/proj', /credentials/],
    ['/home/u/.aws/x', /credentials/],
    ['/home/u/.claude/skills/x', /configuration/],
    ['/home/u/.codeman/cases/x', /data folder/],
    ['/home/u/.codeman-beta/x', /data folder/],
  ])('refuses %s', (p, why) => expect(blockedReason(p, c)).toMatch(why));

  it.each(['/home/u/code/app', '/home/u/.config/app', '/srv/projects/x', '/opt/work', '/tmp/x', '/home/u/etc/app'])(
    'allows %s (a name that merely contains a blocked word is fine)',
    (p) => expect(blockedReason(p, c)).toBeNull()
  );

  it('does not treat /etcetera or /usrlocal as the system directories', () => {
    expect(blockedReason('/etcetera/x', c)).toBeNull();
    expect(blockedReason('/usrlocal', c)).toBeNull();
  });

  it('refuses a cases directory and anything inside it, when given', () => {
    const withCases = { ...c, casesDirs: ['/home/u/codeman-cases'] };
    expect(blockedReason('/home/u/codeman-cases', withCases)).toMatch(/plain Create New/);
    expect(blockedReason('/home/u/codeman-cases/foo', withCases)).toMatch(/plain Create New/);
    expect(blockedReason('/home/u/codeman-cases-old/foo', withCases)).toBeNull();
    expect(blockedReason('/home/u/codeman-cases/foo', c)).toBeNull();
  });

  it('judges against the system roots it is given', () => {
    expect(blockedReason('/private/etc/x', c)).toBeNull();
    expect(blockedReason('/private/etc/x', c, ['/private/etc'])).toMatch(/system directory/);
  });
});

describe('prepareNewCasePath', () => {
  it('accepts a new folder under an existing parent and reports it does not exist yet', async () => {
    const r = await prepareNewCasePath(join(home, 'code', 'new-app'), ctx);
    expect(r).toMatchObject({ ok: true, existedEmpty: false });
    if (r.ok) expect(r.path).toMatch(/code\/new-app$/);
  });

  it('accepts an existing EMPTY folder and says so', async () => {
    mkdirSync(join(home, 'code', 'empty'));
    expect(await prepareNewCasePath(join(home, 'code', 'empty'), ctx)).toMatchObject({ ok: true, existedEmpty: true });
  });

  it('expands ~, tolerates a trailing slash and a ./ segment, and accepts spaces', async () => {
    const a = await prepareNewCasePath('~/code/from-tilde', ctx);
    expect(a.ok && a.path).toBe(join(home, 'code', 'from-tilde'));
    // A "./" segment and a trailing slash normalise away; the folder name may contain a space.
    const b = await prepareNewCasePath(`${join(home, 'code')}/./with space/`, ctx);
    expect(b.ok && b.path).toBe(join(home, 'code', 'with space'));
    // ...and a folder with a space in it can be the PARENT of the next one.
    mkdirSync(join(home, 'code', 'with space'));
    expect(await prepareNewCasePath(`${join(home, 'code', 'with space')}/proj/`, ctx)).toMatchObject({ ok: true });
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['relative', 'code/app'],
    ['dot-relative', './app'],
    ['traversal', '/tmp/../etc/x'],
    ['shell metacharacters', '/tmp/a;rm -rf /'],
    ['command substitution', '/tmp/$(id)'],
    ['quotes', "/tmp/it's"],
    ['newline', '/tmp/a\nb'],
  ])('rejects %s as invalid', async (_label, raw) => {
    expect(await prepareNewCasePath(raw, ctx)).toMatchObject({ ok: false, code: 'INVALID' });
  });

  it('refuses system, home, credential and Codeman folders as BLOCKED', async () => {
    for (const raw of [
      '/etc/proj',
      '/usr/src/x',
      home,
      join(home, '.ssh', 'x'),
      join(home, '.codeman', 'cases', 'x'),
    ]) {
      expect(await prepareNewCasePath(raw, ctx), raw).toMatchObject({ ok: false, code: 'BLOCKED' });
    }
  });

  it('judges the symlink-resolved path too: a link into a blocked tree is not a way around it', async () => {
    symlinkSync('/etc', join(home, 'code', 'sneaky'));
    expect(await prepareNewCasePath(join(home, 'code', 'sneaky', 'proj'), ctx)).toMatchObject({
      ok: false,
      code: 'BLOCKED',
    });
  });

  it('judges the resolved path against the resolved home too, when home is reached through a symlink', async () => {
    const realHome = join(root, 'realhome');
    mkdirSync(join(realHome, '.ssh'), { recursive: true });
    mkdirSync(join(realHome, 'code'));
    const linkHome = join(root, 'linkhome');
    symlinkSync(realHome, linkHome);
    // Typed, this reads as <link home>/code/innocent/x; resolved, it is <real home>/.ssh/x.
    symlinkSync(join(realHome, '.ssh'), join(realHome, 'code', 'innocent'));
    const viaLink = { home: linkHome, dataDir: join(linkHome, '.codeman') };
    expect(await prepareNewCasePath(join(linkHome, 'code', 'innocent', 'x'), viaLink)).toMatchObject({
      ok: false,
      code: 'BLOCKED',
    });
    // The same for Codeman's data dir given through the link.
    mkdirSync(join(realHome, '.codeman'));
    symlinkSync(join(realHome, '.codeman'), join(realHome, 'code', 'state'));
    expect(await prepareNewCasePath(join(linkHome, 'code', 'state', 'x'), viaLink)).toMatchObject({
      ok: false,
      code: 'BLOCKED',
    });
  });

  it('refuses a link into a cases directory, judged on its resolved form', async () => {
    const cases = join(home, 'codeman-cases');
    mkdirSync(cases);
    symlinkSync(cases, join(home, 'code', 'shortcut'));
    const r = await prepareNewCasePath(join(home, 'code', 'shortcut', 'app'), { ...ctx, casesDirs: [cases] });
    expect(r).toMatchObject({ ok: false, code: 'BLOCKED' });
    if (!r.ok) expect(r.reason).toMatch(/plain Create New/);
  });

  it('reports a missing parent as NOT_FOUND and never makes a chain of folders', async () => {
    const r = await prepareNewCasePath(join(home, 'code', 'nope', 'deeper', 'app'), ctx);
    expect(r).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('refuses a parent that is a file', async () => {
    writeFileSync(join(home, 'code', 'afile'), 'x');
    expect(await prepareNewCasePath(join(home, 'code', 'afile', 'app'), ctx)).toMatchObject({ ok: false });
  });

  it('refuses a folder that already has files in it, pointing at Link Existing', async () => {
    mkdirSync(join(home, 'code', 'mine'));
    writeFileSync(join(home, 'code', 'mine', 'README.md'), 'hello');
    const r = await prepareNewCasePath(join(home, 'code', 'mine'), ctx);
    expect(r).toMatchObject({ ok: false, code: 'EXISTS' });
    if (!r.ok) expect(r.reason).toMatch(/Link Existing/);
  });

  it('refuses a target that is a file or a symbolic link', async () => {
    writeFileSync(join(home, 'code', 'plain'), 'x');
    expect(await prepareNewCasePath(join(home, 'code', 'plain'), ctx)).toMatchObject({ ok: false, code: 'INVALID' });
    mkdirSync(join(home, 'code', 'real'));
    symlinkSync(join(home, 'code', 'real'), join(home, 'code', 'link'));
    const r = await prepareNewCasePath(join(home, 'code', 'link'), ctx);
    expect(r).toMatchObject({ ok: false, code: 'INVALID' });
    if (!r.ok) expect(r.reason).toMatch(/symbolic link/);
  });

  it('never creates anything', async () => {
    await prepareNewCasePath(join(home, 'code', 'dry-run'), ctx);
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(home, 'code', 'dry-run'))).toBe(false);
  });
});
