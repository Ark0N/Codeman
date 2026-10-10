/** @fileoverview Bottom-bar Git indicator and panel, end to end: real server, real Chromium, a real git repo with a remote. */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { WebServer } from '../src/web/server.js';

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], { cwd, env: ENV, stdio: 'ignore' });

describe('Git status indicator in a real browser', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;
  let root: string;
  let repo: string;
  let plain: string;
  let repoSession: string;
  let plainSession: string;
  const gitStatusRequests: string[] = [];
  const settingsPutStatuses: number[] = [];

  const write = (rel: string, text = 'x\n') => writeFileSync(join(repo, rel), text);
  const commitAll = (msg: string) => {
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', msg);
  };
  const label = () => page.evaluate(() => document.querySelector('#gitStatusBtn .git-status-label')?.textContent ?? '');
  const buttonVisible = () => page.evaluate(() => !document.getElementById('gitStatusBtn')!.hidden);
  const refresh = () => page.evaluate(() => (window as any).app.refreshGitStatusNow());
  const setSetting = async (on: boolean) => {
    await page.evaluate(() => (window as any).app.openAppSettings());
    if ((await page.isChecked('#appSettingsShowGitStatus')) !== on)
      await page.click('label.switch:has(#appSettingsShowGitStatus)');
    await page.evaluate(() => (window as any).app.saveAppSettings());
    await page.waitForTimeout(300);
    await page.evaluate(() => (window as any).app.closeAppSettings());
  };
  const createSession = (dir: string) =>
    page.evaluate(async (workingDir) => {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir, mode: 'shell' }),
      });
      const id = (await res.json()).data.session.id;
      await fetch(`/api/sessions/${id}/shell`, { method: 'POST' });
      return id as string;
    }, dir);
  const select = (id: string) =>
    page.evaluate(async (sid) => {
      const app = (window as any).app;
      for (let i = 0; i < 100 && !app.sessions.has(sid); i++) await new Promise((r) => setTimeout(r, 100));
      await app.selectSession(sid);
    }, id);

  beforeAll(async () => {
    root = mkdtempSync(join(homedir(), 'git-ui-'));
    const bare = join(root, 'origin.git');
    repo = join(root, 'repo');
    plain = join(root, 'plain');
    mkdirSync(repo);
    mkdirSync(plain);
    git(root, 'init', '-q', '--bare', '-b', 'main', bare);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'remote', 'add', 'origin', bare);
    write('a.txt', '1\n');
    commitAll('base');
    git(repo, 'push', '-q', '-u', 'origin', 'main');
    // Dirty: a modified file, an untracked file, and one commit nobody has pushed.
    write('b.txt', 'b\n');
    commitAll('add b (not pushed)');
    write('a.txt', '2\n');
    write('new file.txt', 'n\n');

    server = new WebServer(0, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('request', (r) => {
      // The API route only: the page also loads /git-status-ui.js, whose URL contains the same words.
      if (/\/api\/sessions\/[^/]+\/git-status/.test(r.url())) gitStatusRequests.push(r.url());
    });
    page.on('response', (r) => {
      if (r.request().method() === 'PUT' && r.url().endsWith('/api/settings')) settingsPutStatuses.push(r.status());
    });
    await page.goto(`http://localhost:${server.boundPort}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).app?.terminal, null, { timeout: 30000 });
    repoSession = await createSession(repo);
    plainSession = await createSession(plain);
    await select(repoSession);
  }, 120000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
    rmSync(root, { recursive: true, force: true });
  }, 60000);

  it('is off by default: no button and no request to the git-status route', async () => {
    await page.waitForTimeout(2500); // longer than one tick
    expect(await buttonVisible()).toBe(false);
    expect(gitStatusRequests).toEqual([]);
  });

  it('turning it on through Settings saves cleanly (the key must not reach the strict PUT) and shows the counts', async () => {
    await setSetting(true);
    expect(settingsPutStatuses.length).toBeGreaterThan(0);
    expect(settingsPutStatuses.every((s) => s === 200)).toBe(true);
    await page.waitForFunction(() => !document.getElementById('gitStatusBtn')!.hidden, null, { timeout: 15000 });
    expect(await label()).toContain('● 2'); // a.txt modified + new file.txt untracked
    expect(await label()).toContain('↑ 1'); // one commit not pushed
    const title = await page.getAttribute('#gitStatusBtn', 'title');
    expect(title).toMatch(/main/);
    expect(title).toMatch(/2 uncommitted files/);
    expect(title).toMatch(/1 commit not pushed/);
    expect(await page.getAttribute('#gitStatusBtn', 'class')).toMatch(/git-status--dirty/);
    // The toolbar skin rules out-rank a bare class, so check the colour the user actually sees.
    const colour = await page.evaluate(() => getComputedStyle(document.getElementById('gitStatusBtn')!).color);
    expect(colour).toBe('rgb(224, 160, 48)');
  });

  it('sits at the right of the bottom bar, beside the version', async () => {
    const inRight = await page.evaluate(() => !!document.querySelector('.toolbar-right #gitStatusBtn'));
    expect(inRight).toBe(true);
    const order = await page.evaluate(() => {
      const right = document.querySelector('.toolbar-right')!;
      return [...right.children].map((c) => c.id).filter(Boolean);
    });
    expect(order.indexOf('gitStatusBtn')).toBeLessThan(order.indexOf('versionDisplay'));
  });

  it('opens a panel listing the uncommitted files and the unpushed commit', async () => {
    await page.click('#gitStatusBtn');
    await page.waitForSelector('#gitStatusPanel.visible');
    await page.waitForFunction(() => /Not staged/.test(document.getElementById('gitStatusBody')!.textContent ?? ''));
    const body = (await page.textContent('#gitStatusBody')) ?? '';
    expect(body).toContain('main → origin/main');
    expect(body).toContain('Uncommitted changes (2)');
    expect(body).toMatch(/Not staged \(1\)/);
    expect(body).toMatch(/Untracked \(1\)/);
    expect(body).toContain('a.txt');
    expect(body).toContain('new file.txt');
    expect(body).toContain('Not pushed (1)');
    expect(body).toContain('add b (not pushed)');
    expect(await page.textContent('#gitStatusBranch')).toBe('main');
    expect(await page.textContent('#gitStatusFooter')).toMatch(/Read-only/);
    expect(await page.getAttribute('#gitStatusBtn', 'aria-expanded')).toBe('true');
  });

  it('renders hostile file names as text, never as markup', async () => {
    write('<img src=x onerror=window.__pwned=1>.txt');
    await refresh();
    await page.waitForFunction(() => /onerror/.test(document.getElementById('gitStatusBody')!.textContent ?? ''));
    expect(await page.$('#gitStatusBody img')).toBeNull();
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
  });

  it('clicking a file shows its diff in the panel; Back returns to the list; Open file previews it', async () => {
    await page.evaluate(() => {
      (window as any).__previewed = [];
      (window as any).app.openFilePreview = (p: string) => (window as any).__previewed.push(p);
    });
    await page.click('.git-status-file:has-text("a.txt")');
    await page.waitForSelector('#gitStatusBody .git-diff');
    expect(await page.textContent('#gitStatusBody .git-diff-path')).toBe('a.txt');
    expect(await page.textContent('#gitStatusBody .git-diff-line--del')).toBe('-1\n');
    expect(await page.textContent('#gitStatusBody .git-diff-line--add')).toBe('+2\n');
    // The 15 s poll re-renders the panel; the diff must survive it.
    await refresh();
    expect(await page.$('#gitStatusBody .git-diff')).not.toBeNull();
    await page.click('#gitStatusBody button:has-text("Open file")');
    expect(await page.evaluate(() => (window as any).__previewed)).toEqual([join(repo, 'a.txt')]);
    await page.click('#gitStatusBody button:has-text("Back")');
    await page.waitForSelector('.git-status-file:has-text("a.txt")');
    expect(await page.$('#gitStatusBody .git-diff')).toBeNull();
  });

  it('an untracked file diffs as all additions, and a deleted file as all removals (with no Open file)', async () => {
    await page.click('.git-status-file:has-text("new file.txt")');
    await page.waitForSelector('#gitStatusBody .git-diff-line--add');
    expect(await page.locator('#gitStatusBody .git-diff-line--del').count()).toBe(0);
    await page.click('#gitStatusBody button:has-text("Back")');
    rmSync(join(repo, 'b.txt'));
    await refresh();
    await page.waitForSelector('.git-status-file:has(.git-status-badge--D)');
    await page.click('.git-status-file:has(.git-status-badge--D)');
    await page.waitForSelector('#gitStatusBody .git-diff-line--del');
    expect(await page.locator('#gitStatusBody .git-diff-line--add').count()).toBe(0);
    expect(await page.locator('#gitStatusBody button:has-text("Open file")').count()).toBe(0);
    await page.click('#gitStatusBody button:has-text("Back")');
  });

  it('keeps keyboard focus on the same file row across the 15 s re-render', async () => {
    await page.focus('.git-status-file:has-text("a.txt")');
    const key = () => page.evaluate(() => (document.activeElement as HTMLElement | null)?.dataset?.gitKey ?? null);
    expect(await key()).toBe('unstaged|a.txt');
    await refresh();
    await page.waitForFunction(() => document.activeElement?.getAttribute('data-git-key') === 'unstaged|a.txt');
    expect(await key()).toBe('unstaged|a.txt');
  });

  it('the panel never starts off-screen, even on a 650px-wide viewport', async () => {
    const original = page.viewportSize()!;
    await page.setViewportSize({ width: 650, height: original.height });
    const left = await page.evaluate(() => document.getElementById('gitStatusPanel')!.getBoundingClientRect().left);
    await page.setViewportSize(original);
    expect(left).toBeGreaterThanOrEqual(0);
  });

  it('drags by the header', async () => {
    const before = await page.evaluate(() => document.getElementById('gitStatusPanel')!.getBoundingClientRect().left);
    const box = (await page.locator('.git-status-header').boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x - 140, box.y + 70, { steps: 5 });
    await page.mouse.up();
    const after = await page.evaluate(() => document.getElementById('gitStatusPanel')!.getBoundingClientRect().left);
    expect(after).toBeLessThan(before - 100);
  });

  it('groups files under folders that start collapsed and expand on click; the setting turns it off', async () => {
    mkdirSync(join(repo, 'deep/er/still'), { recursive: true });
    mkdirSync(join(repo, 'docs'));
    write('deep/er/still/one.txt');
    write('docs/a.md');
    write('docs/b.md');
    // git reports an all-untracked folder as ONE `dir/` entry, so commit these first and then edit them.
    git(repo, 'add', 'deep', 'docs');
    git(repo, 'commit', '-q', '-m', 'add folders');
    write('deep/er/still/one.txt', 'changed\n');
    write('docs/a.md', 'changed\n');
    write('docs/b.md', 'changed\n');
    await refresh();
    await page.waitForSelector('.git-tree-dir');
    // `deep/er/still` is a chain of single-child folders: one row, not three.
    const names = await page.locator('.git-tree-name').allTextContents();
    expect(names).toContain('deep/er/still/');
    expect(names).toContain('docs/');
    expect(await page.locator('.git-tree-dir[open]').count()).toBe(0);
    expect(await page.locator('.git-status-file:has-text("one.txt")').isVisible()).toBe(false);
    expect(await page.locator('.git-tree-dir:has(.git-tree-name:text-is("docs/")) .git-tree-count').textContent()).toBe(
      '2'
    );
    await page.click('.git-tree-summary:has-text("docs/")');
    expect(await page.locator('.git-status-file:has-text("a.md")').isVisible()).toBe(true);
    // The open folder survives the re-render a refresh causes.
    await refresh();
    await page.waitForSelector('.git-tree-dir[open]');
    expect(await page.locator('.git-status-file:has-text("a.md")').isVisible()).toBe(true);
    // A file in a folder still opens its diff, and shows only its own name.
    await page.click('.git-status-file:has-text("a.md")');
    await page.waitForSelector('#gitStatusBody .git-diff-path');
    expect(await page.textContent('#gitStatusBody .git-diff-path')).toBe('docs/a.md');
    await page.click('#gitStatusBody button:has-text("Back")');

    // Setting off: the flat list, every file by its full path.
    await page.evaluate(() => (window as any).app.openAppSettings());
    await page.click('label.switch:has(#appSettingsGitStatusTree)');
    await page.evaluate(() => (window as any).app.saveAppSettings());
    await page.waitForTimeout(300);
    await page.evaluate(() => (window as any).app.closeAppSettings());
    await page.evaluate(() => (window as any).app._renderGitStatusPanel());
    expect(await page.locator('.git-tree-dir').count()).toBe(0);
    expect(await page.locator('.git-status-path', { hasText: 'docs/a.md' }).count()).toBe(1);
    // Back on for the rest of the file.
    await page.evaluate(() => (window as any).app.openAppSettings());
    await page.click('label.switch:has(#appSettingsGitStatusTree)');
    await page.evaluate(() => (window as any).app.saveAppSettings());
    await page.waitForTimeout(300);
    await page.evaluate(() => (window as any).app.closeAppSettings());
    // gitStatusTree is per-device: it must never reach the strict PUT /api/settings (a 400 there is
    // what an unstripped key looks like), and it must round-trip through the saved settings.
    expect(settingsPutStatuses.every((st) => st === 200)).toBe(true);
    expect(await page.evaluate(() => (window as any).app.isGitStatusTree())).toBe(true);
    rmSync(join(repo, 'deep'), { recursive: true });
    rmSync(join(repo, 'docs'), { recursive: true });
  }, 30000);

  it('once everything is committed and pushed the button says so, and the panel agrees', async () => {
    rmSync(join(repo, '<img src=x onerror=window.__pwned=1>.txt'));
    git(repo, 'checkout', '-q', '--', '.');
    git(repo, 'clean', '-fdq');
    git(repo, 'push', '-q');
    await refresh();
    // A manual refresh bypasses the server's short cache, so this shows the push at once (not at the
    // next 15 s poll, which is what a cached answer would mean).
    await page.waitForFunction(
      () => (document.querySelector('#gitStatusBtn .git-status-label')?.textContent ?? '').includes('✓'),
      null,
      { timeout: 5000 }
    );
    expect(await page.getAttribute('#gitStatusBtn', 'class')).toMatch(/git-status--clean/);
    // Toolbar buttons animate colour changes, so wait for the transition rather than racing it.
    await page.waitForFunction(
      () => getComputedStyle(document.getElementById('gitStatusBtn')!).color !== 'rgb(224, 160, 48)'
    );
    const body = (await page.textContent('#gitStatusBody')) ?? '';
    expect(body).toContain('Nothing uncommitted.');
    expect(body).toContain('Every commit on this branch is on a remote.');
  });

  it('shows nothing for a session whose folder is not a repository, and follows the active session', async () => {
    await select(plainSession);
    await page.waitForFunction(() => document.getElementById('gitStatusBtn')!.hidden, null, { timeout: 15000 });
    // The open panel must stop showing the previous repo at once, then say why there is nothing.
    await page.waitForFunction(
      () => /No git repository here/.test(document.getElementById('gitStatusBody')!.textContent ?? ''),
      null,
      {
        timeout: 15000,
      }
    );
    expect(await page.textContent('#gitStatusBody')).not.toContain('a.txt');
    await select(repoSession);
    await page.waitForFunction(() => !document.getElementById('gitStatusBtn')!.hidden, null, { timeout: 15000 });
  });

  it('a folder that holds several repositories shows each one, and the indicator adds them up', async () => {
    const parent = join(root, 'monorepo-ish');
    mkdirSync(parent);
    for (const name of ['api', 'web']) {
      const r = join(parent, name);
      mkdirSync(r);
      git(r, 'init', '-q', '-b', 'main');
      writeFileSync(join(r, 'f.txt'), '1\n');
      git(r, 'add', '-A');
      git(r, 'commit', '-q', '-m', 'init');
    }
    writeFileSync(join(parent, 'api', 'dirty.txt'), 'x');
    writeFileSync(join(parent, 'api', 'dirty2.txt'), 'y');
    const multiSession = await createSession(parent);
    await select(multiSession);
    await page.waitForFunction(() => document.querySelectorAll('#gitStatusBody .git-status-repo').length === 2, null, {
      timeout: 15000,
    });
    expect(await page.textContent('#gitStatusBranch')).toBe('2 repositories');
    expect(await label()).toContain('● 2'); // only api is dirty, with two files
    expect(await page.getAttribute('#gitStatusBtn', 'title')).toMatch(/Git \(2 repositories\)/);
    const names = await page.$$eval('.git-status-repo-name', (els) => els.map((e) => e.textContent));
    expect(names).toEqual(['api', 'web']);
    // Every repository starts collapsed (the summary line shows what is outstanding); one the user
    // opens stays open when a refresh re-renders the panel.
    const allClosed = await page.$$eval('.git-status-repo', (els) => els.map((e) => (e as HTMLDetailsElement).open));
    expect(allClosed).toEqual([false, false]);
    await page.click('.git-status-repo:nth-of-type(1) > summary');
    await refresh();
    await page.waitForSelector('.git-status-repo[open]');
    const open = await page.$$eval('.git-status-repo', (els) => els.map((e) => (e as HTMLDetailsElement).open));
    expect(open).toEqual([true, false]);
    const apiBody = (await page.textContent('.git-status-repo:nth-of-type(1)')) ?? '';
    expect(apiBody).toContain('dirty.txt');
    expect(apiBody).toContain('dirty2.txt');
    await select(repoSession);
    await page.waitForFunction(() => document.querySelectorAll('#gitStatusBody .git-status-repo').length === 0, null, {
      timeout: 15000,
    });
  });

  it('turning the setting off while a read is in flight, then on again, does not leave polling dead', async () => {
    let slow = true;
    await page.route('**/api/sessions/*/git-status*', async (route) => {
      if (slow) await new Promise((r) => setTimeout(r, 1500));
      await route.continue();
    });
    page.setDefaultTimeout(6000);
    // A background poll may be mid-read: let it finish so OUR read is the one the slow route holds.
    await page.waitForFunction(() => (window as any).app._gitStatusInFlight === false);
    await page.evaluate(() => void (window as any).app.refreshGitStatus({ fresh: true }));
    await page.waitForFunction(() => (window as any).app._gitStatusInFlight === true);
    await setSetting(false);
    expect(await page.evaluate(() => (window as any).app._gitStatusInFlight)).toBe(false);
    slow = false;
    await setSetting(true);
    // Re-enabling starts its own read. With the flag stuck true that read is skipped for this session
    // and the indicator never comes back.
    await page.waitForFunction(() => !!(window as any).app._currentGitStatus());
    expect(await page.evaluate(() => (window as any).app._gitStatusInFlight)).toBe(false);
    page.setDefaultTimeout(30000);
    // The first read may still be asleep in the handler: wait for it to continue, or its late
    // route.continue() lands after the route is gone and fails the run as an unhandled rejection.
    await page.unrouteAll({ behavior: 'wait' });
    expect(await buttonVisible()).toBe(true);
    // Turning the setting off closed the panel; reopen it for the tests that follow.
    await page.click('#gitStatusBtn');
    await page.waitForSelector('#gitStatusPanel.visible');
  }, 30000);

  it('sends the max-repositories and git-timeout settings, and lists an unreadable repository with its reason', async () => {
    const setLimits = async (maxRepos: string, timeout: string) => {
      await page.evaluate(() => (window as any).app.openAppSettings());
      await page.fill('#appSettingsGitStatusMaxRepos', maxRepos);
      await page.fill('#appSettingsGitStatusTimeout', timeout);
      await page.evaluate(() => (window as any).app.saveAppSettings());
      await page.waitForTimeout(300);
      await page.evaluate(() => (window as any).app.closeAppSettings());
    };
    await setLimits('7', '45');
    // Per-device keys must never reach the strict PUT /api/settings.
    expect(settingsPutStatuses.every((st) => st === 200)).toBe(true);
    expect(await page.evaluate(() => (window as any).app.gitStatusLimits())).toEqual({ maxRepos: 7, timeout: 45 });
    await refresh();
    expect(gitStatusRequests.at(-1)).toMatch(/maxRepos=7/);
    expect(gitStatusRequests.at(-1)).toMatch(/timeout=45/);

    // Out-of-range values are clamped when saved, not sent as typed.
    await setLimits('9999', '1');
    expect(await page.evaluate(() => (window as any).app.gitStatusLimits())).toEqual({ maxRepos: 50, timeout: 5 });

    // A folder with more repositories than the limit, one of which git could not read.
    const emptyCounts = { staged: 0, unstaged: 0, untracked: 0, conflicted: 0, uncommitted: 0, stashes: 0 };
    const status = (over: Record<string, unknown>) => ({
      state: 'ok',
      branch: 'main',
      detached: false,
      upstream: 'origin/main',
      upstreamGone: false,
      ahead: 0,
      behind: 0,
      hasRemote: true,
      counts: emptyCounts,
      files: [],
      filesTruncated: false,
      unpushedCount: 0,
      unpushed: [],
      checkedAt: Date.now(),
      ...over,
    });
    await page.route('**/api/sessions/*/git-status*', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            state: 'ok',
            reposTruncated: true,
            repoLimit: 2,
            checkedAt: Date.now(),
            repos: [
              { name: 'fast', path: 'fast', status: status({ repoRoot: '/x/fast' }) },
              { name: 'slow', path: 'slow', status: status({ state: 'error', error: 'git timed out' }) },
            ],
          },
        }),
      })
    );
    await refresh();
    await page.waitForFunction(() =>
      /could not read/.test(document.getElementById('gitStatusBody')?.textContent ?? '')
    );
    const body = (await page.textContent('#gitStatusBody')) ?? '';
    expect(body).toContain('slow');
    expect(body).toContain('could not read: git timed out');
    expect(body).toContain('Showing the first 2 of more than 2 repositories');
    expect(body).toContain('Raise “Git status: max repositories”');
    // The unreadable repository must keep the indicator from claiming everything is fine.
    expect(await label()).toContain('? 1');
    expect(await label()).not.toContain('✓');
    expect(await page.getAttribute('#gitStatusBtn', 'title')).toMatch(/1 repository could not be read/);

    const mockOverview = async (data: Record<string, unknown>) => {
      await page.unroute('**/api/sessions/*/git-status*');
      await page.route('**/api/sessions/*/git-status*', (route) =>
        route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify({ success: true, data: { state: 'ok', checkedAt: Date.now(), ...data } }),
        })
      );
      await refresh();
    };
    // The ONLY repository git could not read: still the error row, never a clean, empty repository.
    await mockOverview({
      reposTruncated: false,
      repoLimit: 12,
      repos: [
        {
          name: 'slow',
          path: 'slow',
          status: status({ state: 'error', error: 'git timed out', branch: null, hasRemote: false, upstream: null }),
        },
      ],
    });
    await page.waitForFunction(() => document.getElementById('gitStatusBranch')?.textContent === '1 repository');
    const lone = (await page.textContent('#gitStatusBody')) ?? '';
    expect(lone).toContain('could not read: git timed out');
    expect(lone).not.toContain('Nothing uncommitted');
    expect(await label()).toContain('? 1');
    expect(await page.getAttribute('#gitStatusBtn', 'title')).toMatch(/Git \(slow\)/);

    // A limit of 1 in a folder of several: the one row shown keeps the "Showing the first" notice.
    await mockOverview({
      reposTruncated: true,
      repoLimit: 1,
      repos: [{ name: 'fast', path: 'fast', status: status({ repoRoot: '/x/fast' }) }],
    });
    await page.waitForFunction(() =>
      /Showing the first 1 /.test(document.getElementById('gitStatusBody')?.textContent ?? '')
    );
    expect(await page.textContent('#gitStatusBranch')).toBe('1 repository');

    await page.unroute('**/api/sessions/*/git-status*');
    await setLimits('12', '30');
    await refresh();
  }, 40000);

  it('closing the panel resets it; turning the setting off hides the button, closes the panel and stops polling', async () => {
    await page.click('.git-status-actions button[aria-label="Close git status"]');
    expect(await page.isVisible('#gitStatusPanel')).toBe(false);
    await page.click('#gitStatusBtn');
    expect(await page.isVisible('#gitStatusPanel')).toBe(true);
    await setSetting(false);
    expect(await buttonVisible()).toBe(false);
    expect(await page.isVisible('#gitStatusPanel')).toBe(false);
    expect(await page.evaluate(() => (window as any).app._gitStatusTimer)).toBeNull();
    const before = gitStatusRequests.length;
    await page.waitForTimeout(3000);
    expect(gitStatusRequests.length).toBe(before);
  }, 30000);
});
