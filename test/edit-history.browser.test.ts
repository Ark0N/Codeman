/**
 * @fileoverview Edit history button and panel, end to end in a real browser: real server, real
 * Chromium. The edits API is mocked with `page.route` (the UI is built against its contract); the
 * thumbnails (workspace `file-raw`, the attachment route outside it) and the transcript SSE
 * events the open panel follows go through the real server.
 */
import { homedir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chromium, type Browser, type Page, type Route } from 'playwright';
import { WebServer } from '../src/web/server.js';

/** A 2×2 red PNG, so the thumbnail has real pixels to decode. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEElEQVR4nGP4z8AARAwQCgAf7gP9i18U1AAAAABJRU5ErkJggg==',
  'base64'
);

type Entry = {
  id: string;
  ts: number;
  path: string;
  relPath: string;
  kind: 'code' | 'image';
  tool: string;
  created: boolean;
  added: number;
  removed: number;
  agentId?: string;
};

describe('Edit history panel in a real browser', () => {
  let server: WebServer;
  let browser: Browser;
  let page: Page;
  let root: string;
  /** A directory outside the session's workspace, for the attachment-route thumbnail. */
  let ext: string;
  let sessionA: string;
  let sessionB: string;
  const settingsPutStatuses: number[] = [];
  /** Bodies of POST /api/sessions/:id/attachments (the file preview registering an external image). */
  const attachmentPosts: unknown[] = [];
  /** Every request to the mocked API: `METHOD url`. */
  const calls: string[] = [];
  /** The mocked server state per session id. */
  const state = new Map<string, Record<string, unknown>>();
  let diffs: Record<string, { diff: string; truncated: boolean }> = {};
  let olderEntries: Entry[] = [];

  const entry = (over: Partial<Entry> & { id: string; relPath: string }): Entry => ({
    ts: Date.now(),
    path: join(root, over.relPath),
    kind: 'code',
    tool: 'Edit',
    created: false,
    added: 1,
    removed: 1,
    ...over,
  });

  const json = (route: Route, data: unknown) =>
    route.fulfill({ contentType: 'application/json', body: JSON.stringify({ success: true, data }) });

  const buttonVisible = () =>
    page.evaluate(() => getComputedStyle(document.getElementById('editHistoryBtn')!).display !== 'none');
  const bodyText = async () => (await page.textContent('#editHistoryBody')) ?? '';
  const setSetting = async (on: boolean) => {
    await page.evaluate(() => (window as any).app.openAppSettings());
    if ((await page.isChecked('#appSettingsShowEditHistory')) !== on)
      await page.click('label.set-chip:has(#appSettingsShowEditHistory)');
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
  const reload = () => page.evaluate(() => (window as any).app.refreshEditHistory());
  const syncReads = (sid: string) => calls.filter((c) => c === `GET /api/sessions/${sid}/edits?sync=1`).length;
  const toolEnd = (sessionId: string, toolName: string) =>
    (server as any).broadcast('transcript:tool_end', { sessionId, toolName, isError: false, timestamp: Date.now() });
  const rows = () => page.locator('#editHistoryBody .edit-history-entry');

  beforeAll(async () => {
    root = mkdtempSync(join(homedir(), 'edit-history-ui-'));
    writeFileSync(join(root, 'shot.png'), PNG);
    ext = mkdtempSync(join(homedir(), 'edit-history-ext-'));
    writeFileSync(join(ext, 'render.png'), PNG);

    server = new WebServer(0, false, true);
    await server.start();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    page.on('response', (r) => {
      if (r.request().method() === 'PUT' && r.url().endsWith('/api/settings')) settingsPutStatuses.push(r.status());
    });
    page.on('request', (r) => {
      if (r.method() === 'POST' && /\/api\/sessions\/[^/]+\/attachments$/.test(r.url()))
        attachmentPosts.push(r.postDataJSON());
    });
    await page.route('**/api/sessions/*/edits**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      calls.push(`${req.method()} ${url.pathname}${url.search}`);
      const m = url.pathname.match(/\/api\/sessions\/([^/]+)\/edits(?:\/(.+))?$/)!;
      const sid = decodeURIComponent(m[1]);
      const rest = m[2] ? decodeURIComponent(m[2]) : '';
      const s = state.get(sid) ?? { state: 'unsupported', backfillTruncated: false, agents: {}, entries: [] };
      if (req.method() === 'POST' && rest === 'older') {
        const entries = [...(s.entries as Entry[]), ...olderEntries];
        state.set(sid, { ...s, entries, backfillTruncated: false });
        return json(route, state.get(sid));
      }
      if (req.method() === 'GET' && rest) {
        const d = diffs[rest];
        if (!d) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"success":false}' });
        return json(route, d);
      }
      return json(route, s);
    });
    await page.goto(`http://localhost:${server.boundPort}`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => (window as any).app?.terminal, null, { timeout: 30000 });
    sessionA = await createSession(root);
    sessionB = await createSession(root);
    await select(sessionA);

    const t0 = Date.now();
    state.set(sessionA, {
      state: 'ok',
      backfillTruncated: true,
      agents: {
        agent1: { description: 'Refactor the parser', agentType: 'general-purpose', worktreeBranch: 'wt/parser' },
      },
      entries: [
        entry({ id: 'e4', ts: t0, relPath: 'src/a.ts', added: 3, removed: 1 }),
        entry({ id: 'e3', ts: t0 - 1000, relPath: 'shot.png', kind: 'image', tool: 'bash', created: true }),
        entry({
          id: 'e2',
          ts: t0 - 2000,
          relPath: 'src/b.ts',
          created: true,
          tool: 'Write',
          added: 10,
          removed: 0,
          agentId: 'agent1',
        }),
        entry({ id: 'e1', ts: t0 - 3000, relPath: 'src/a.ts', added: 2, removed: 2 }),
      ],
    });
    diffs = {
      e4: { diff: '@@ -1,3 +1,3 @@\n context\n-old line\n+new line\n+another\n', truncated: true },
      e1: { diff: '@@ -5 +5 @@\n-x\n+y\n', truncated: false },
    };
    olderEntries = [entry({ id: 'e0', ts: t0 - 86_400_000, relPath: 'src/old.ts', added: 7, removed: 0 })];
  }, 120000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await server.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(ext, { recursive: true, force: true });
  }, 60000);

  it('is off by default: no button, and nothing asks the edits API', async () => {
    await page.waitForTimeout(1000);
    expect(await buttonVisible()).toBe(false);
    expect(calls).toEqual([]);
  });

  it('turning it on through Settings shows the button and saves cleanly (the key never reaches the strict PUT)', async () => {
    await setSetting(true);
    expect(settingsPutStatuses.length).toBeGreaterThan(0);
    expect(settingsPutStatuses.every((s) => s === 200)).toBe(true);
    expect(await buttonVisible()).toBe(true);
    // In the header next to Attachments, where the panel opens; no longer in the bottom bar.
    expect(await page.evaluate(() => !!document.querySelector('#headerRight #editHistoryBtn'))).toBe(true);
    expect(await page.evaluate(() => !!document.querySelector('.toolbar #editHistoryBtn'))).toBe(false);
    expect(calls).toEqual([]); // no poll: nothing is read until the panel opens
  });

  it('opens a panel listing the entries newest first, with the subagent chip and an image thumbnail', async () => {
    await page.click('#editHistoryBtn');
    await page.waitForSelector('#editHistoryPanel.visible');
    await page.waitForSelector('#editHistoryBody .edit-history-entry');
    expect(calls[0]).toBe(`GET /api/sessions/${sessionA}/edits?sync=1`);
    expect(await page.getAttribute('#editHistoryBtn', 'aria-expanded')).toBe('true');
    expect(await rows().count()).toBe(4);
    const paths = await page.locator('#editHistoryBody .edit-history-path').allTextContents();
    expect(paths).toEqual(['src/a.ts', 'shot.png', 'src/b.ts', 'src/a.ts']);
    expect(await rows().nth(0).locator('.edit-history-badge').textContent()).toBe('edit');
    expect(await rows().nth(2).locator('.edit-history-badge').textContent()).toBe('new');
    expect(await rows().nth(0).locator('.edit-history-stats').textContent()).toBe('+3−1');
    // The image row: a symbol instead of a word, no +/− counts.
    expect(await rows().nth(1).locator('.edit-history-badge--image svg').count()).toBe(1);
    expect(await rows().nth(1).locator('.edit-history-stats').count()).toBe(0);
    // The subagent chip: its description, and type + branch on hover.
    const chip = rows().nth(2).locator('.edit-history-agent');
    expect(await chip.textContent()).toBe('Refactor the parser');
    expect(await chip.getAttribute('title')).toBe('general-purpose · wt/parser');
    expect(await page.locator('#editHistoryBody .edit-history-agent').count()).toBe(1);
    // The thumbnail is served by the real file-raw route and decodes.
    const thumb = page.locator('#editHistoryBody img.edit-history-thumb');
    expect(await thumb.count()).toBe(1);
    expect(await thumb.getAttribute('src')).toBe(
      `/api/sessions/${sessionA}/file-raw?path=${encodeURIComponent(join(root, 'shot.png'))}`
    );
    await page.waitForFunction(
      () => (document.querySelector('img.edit-history-thumb') as HTMLImageElement)?.naturalWidth === 2
    );
    expect(await page.textContent('#editHistoryCount')).toBe('4');
  });

  it('a code entry opens its diff inline with the Git panel line classes, and closes again', async () => {
    await rows().nth(0).locator('.edit-history-spacer').click();
    await page.waitForSelector('#editHistoryBody .edit-history-diff pre.git-diff');
    expect(calls).toContain(`GET /api/sessions/${sessionA}/edits/e4`);
    const lines = await page.$$eval('#editHistoryBody pre.git-diff .git-diff-line', (els) =>
      els.map((e) => [e.className.replace('git-diff-line', '').trim(), e.textContent])
    );
    expect(lines).toEqual([
      ['git-diff-line--hunk', '@@ -1,3 +1,3 @@\n'],
      ['', ' context\n'],
      ['git-diff-line--del', '-old line\n'],
      ['git-diff-line--add', '+new line\n'],
      ['git-diff-line--add', '+another\n'],
    ]);
    expect(await page.textContent('#editHistoryBody .edit-history-diff')).toContain('Diff cut short');
    expect(await rows().nth(0).getAttribute('aria-expanded')).toBe('true');
    // A re-read (what an SSE update does) keeps the open diff without fetching it again.
    const before = calls.filter((c) => c.endsWith('/edits/e4')).length;
    await reload();
    expect(await page.locator('#editHistoryBody pre.git-diff').count()).toBe(1);
    expect(calls.filter((c) => c.endsWith('/edits/e4')).length).toBe(before);
    await rows().nth(0).locator('.edit-history-spacer').click();
    expect(await page.locator('#editHistoryBody pre.git-diff').count()).toBe(0);
  });

  it('a path and an image open the shared file preview with the absolute path', async () => {
    await page.evaluate(() => {
      const w = window as any;
      w.__previewed = [];
      w.__openFilePreview = w.app.openFilePreview;
      w.app.openFilePreview = (p: string, sid: string) => w.__previewed.push([p, sid]);
    });
    await rows().nth(2).locator('.edit-history-path').click();
    await page.locator('#editHistoryBody img.edit-history-thumb').click();
    expect(await page.evaluate(() => (window as any).__previewed)).toEqual([
      [join(root, 'src/b.ts'), sessionA],
      [join(root, 'shot.png'), sessionA],
    ]);
    // Clicking the path never toggles the row's diff.
    expect(await page.locator('#editHistoryBody .edit-history-diff').count()).toBe(0);
    await page.evaluate(() => {
      const w = window as any;
      w.app.openFilePreview = w.__openFilePreview;
    });
  });

  it('"Main agent only" hides the subagent edits; "Group by file" puts edits under their file', async () => {
    await page.check('#editHistoryMainOnlyToggle');
    expect(await rows().count()).toBe(3);
    expect(await page.locator('#editHistoryBody .edit-history-agent').count()).toBe(0);
    expect(await bodyText()).not.toContain('src/b.ts');
    await page.uncheck('#editHistoryMainOnlyToggle');
    expect(await rows().count()).toBe(4);

    await page.check('#editHistoryGroupToggle');
    const groups = page.locator('#editHistoryBody .edit-history-group');
    expect(await groups.count()).toBe(3);
    expect(await groups.nth(0).locator('.edit-history-group-head .edit-history-path').textContent()).toBe('src/a.ts');
    expect(await groups.nth(0).locator('.edit-history-entry').count()).toBe(2);
    expect(await groups.nth(0).locator('.edit-history-group-head .edit-history-stats').textContent()).toBe('+5−3');
    await groups.nth(0).locator('.edit-history-entry').nth(1).locator('.edit-history-spacer').click();
    await page.waitForSelector('#editHistoryBody .git-diff-line--add');
    expect(await page.textContent('#editHistoryBody .git-diff-line--add')).toBe('+y\n');
    await page.uncheck('#editHistoryGroupToggle');
  });

  it('"Load older" asks the server with a POST and shows what it returns', async () => {
    const older = page.locator('#editHistoryBody button.edit-history-older');
    expect(await older.count()).toBe(1);
    await older.click();
    await page.waitForFunction(() =>
      /src\/old\.ts/.test(document.getElementById('editHistoryBody')!.textContent ?? '')
    );
    expect(calls).toContain(`POST /api/sessions/${sessionA}/edits/older`);
    expect(await rows().count()).toBe(5);
    expect(await page.locator('#editHistoryBody button.edit-history-older').count()).toBe(0);
  });

  it('while open it follows the session: an edit-capable tool end or a turn end re-reads (debounced), other tools, sessions and keep-alive turns do not', async () => {
    const before = syncReads(sessionA);
    const s = state.get(sessionA)!;
    state.set(sessionA, {
      ...s,
      entries: [entry({ id: 'e5', relPath: 'src/fresh.ts', added: 4, removed: 0 }), ...(s.entries as Entry[])],
    });
    toolEnd(sessionA, 'Read');
    toolEnd(sessionA, 'Grep');
    toolEnd('someone-else', 'Edit');
    await page.waitForTimeout(1000);
    expect(syncReads(sessionA)).toBe(before);
    toolEnd(sessionA, 'Edit');
    toolEnd(sessionA, 'Bash');
    await page.waitForFunction(() =>
      /src\/fresh\.ts/.test(document.getElementById('editHistoryBody')!.textContent ?? '')
    );
    await page.waitForTimeout(800);
    expect(syncReads(sessionA)).toBe(before + 1);
    // The end of a turn re-reads too (a parallel tool call reports one tool end only, a background
    // subagent writes later): `session:idle`, since claude's transcript has no `result` line.
    // Not another session's, and not the end of Codeman's own keep-alive turn (it edits nothing).
    (server as any).broadcast('session:idle', { id: 'someone-else' });
    (server as any).broadcast('session:idle', { id: sessionA, keepAlive: true });
    await page.waitForTimeout(1200);
    expect(syncReads(sessionA)).toBe(before + 1);
    (server as any).broadcast('session:idle', { id: sessionA });
    await page.waitForTimeout(1200);
    expect(syncReads(sessionA)).toBe(before + 2);
  });

  it('while the panel is closed, transcript events read nothing; opening reads once', async () => {
    await page.click('#editHistoryBtn');
    await page.waitForSelector('#editHistoryPanel:not(.visible)', { state: 'attached' });
    const before = syncReads(sessionA);
    toolEnd(sessionA, 'Edit');
    (server as any).broadcast('session:idle', { id: sessionA });
    await page.waitForTimeout(1200);
    expect(syncReads(sessionA)).toBe(before);
    expect(await page.$('#editHistoryUnread')).toBeNull(); // no unread badge: closed means idle
    await page.click('#editHistoryBtn');
    await page.waitForSelector('#editHistoryPanel.visible');
    await page.waitForFunction(() => document.querySelectorAll('#editHistoryBody .edit-history-entry').length > 0);
    expect(syncReads(sessionA)).toBe(before + 1);
  });

  it('an image outside the workspace registers nothing until clicked, then previews through the attachment route quietly', async () => {
    const s = state.get(sessionA)!;
    const outside = join(ext, 'render.png');
    state.set(sessionA, {
      ...s,
      entries: [
        entry({ id: 'ext', path: outside, relPath: outside, kind: 'image', tool: 'bash', added: 0, removed: 0 }),
        ...(s.entries as Entry[]),
      ],
    });
    await reload();
    const row = page.locator('#editHistoryBody .edit-history-entry', { hasText: 'render.png' });
    await row.waitFor();
    // No thumbnail for it (that would mint an attachment id per render), and no registration.
    expect(
      await page.evaluate(() =>
        [...document.querySelectorAll('#editHistoryBody img.edit-history-thumb')].map((i) => i.getAttribute('src'))
      )
    ).not.toContainEqual(expect.stringContaining('render.png'));
    await reload();
    expect(attachmentPosts).toEqual([]);
    // A click opens the shared preview, which registers the file once, without a notification.
    await row.click();
    await page.waitForSelector('#filePreviewOverlay.visible');
    expect(attachmentPosts).toEqual([{ path: outside, notify: false }]);
    await page.evaluate(() => (window as any).app.closeFilePreview());
    state.set(sessionA, s);
  });

  it('a remote session lists its images without a thumbnail (no ssh read per row); a click still previews', async () => {
    const thumbs = () => page.locator('#editHistoryBody img.edit-history-thumb').count();
    expect(await thumbs()).toBe(1);
    await page.evaluate((sid) => {
      const w = window as any;
      w.app.sessions.get(sid).remote = { hostId: 'h', label: 'h', host: '192.0.2.1', username: 'j', remotePath: '/' };
      w.__previewed = [];
      w.__openFilePreview = w.app.openFilePreview;
      w.app.openFilePreview = (p: string, s: string) => w.__previewed.push([p, s]);
    }, sessionA);
    await reload();
    await page.locator('#editHistoryBody .edit-history-entry', { hasText: 'shot.png' }).waitFor();
    expect(await thumbs()).toBe(0);
    await page.locator('#editHistoryBody .edit-history-entry', { hasText: 'shot.png' }).click();
    expect(await page.evaluate(() => (window as any).__previewed)).toEqual([[join(root, 'shot.png'), sessionA]]);
    await page.evaluate((sid) => {
      const w = window as any;
      delete w.app.sessions.get(sid).remote;
      w.app.openFilePreview = w.__openFilePreview;
    }, sessionA);
    await reload();
    await page.locator('#editHistoryBody img.edit-history-thumb').waitFor();
  });

  it('a long path outside the workspace keeps its file name readable, the folder is cut at the start', async () => {
    const s = state.get(sessionA)!;
    const long =
      '/tmp/claude-1000/-mnt-caches-ComfyUI/07e259af-d4d2-4ac3-8a7e-95972e3547df/scratchpad/icons/bremse_alt1_pedal.png';
    state.set(sessionA, {
      ...s,
      entries: [
        entry({ id: 'long', relPath: long, kind: 'image', tool: 'sent', added: 0, removed: 0 }),
        ...(s.entries as Entry[]),
      ],
    });
    await reload();
    const row = rows().nth(0);
    await row.waitFor();
    expect(await row.locator('.edit-history-path').textContent()).toBe(long);
    const name = row.locator('.edit-history-path-name');
    expect(await name.textContent()).toBe('bremse_alt1_pedal.png');
    // The name is shown whole; only the folder part is shortened.
    expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await row.locator('.edit-history-path-dir').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
    state.set(sessionA, s);
  });

  it('renders a hostile path as text, never as markup', async () => {
    const s = state.get(sessionA)!;
    const evil = '<script>window.__pwned=1</script><img src=x onerror="window.__pwned=2">.ts';
    state.set(sessionA, {
      ...s,
      agents: { agent1: { description: '<b>bold</b>', agentType: 'x', worktreeBranch: '' } },
      entries: [entry({ id: 'evil', relPath: evil, agentId: 'agent1' }), ...(s.entries as Entry[])],
    });
    await reload();
    await page.waitForFunction(() => /__pwned/.test(document.getElementById('editHistoryBody')!.textContent ?? ''));
    expect(await rows().nth(0).locator('.edit-history-path').textContent()).toBe(evil);
    expect(await rows().nth(0).locator('.edit-history-agent').textContent()).toBe('<b>bold</b>');
    expect(await page.$('#editHistoryBody script')).toBeNull();
    expect(await page.$('#editHistoryBody b')).toBeNull();
    expect(
      await page.$$eval(
        '#editHistoryBody img',
        (els) => els.filter((e) => !e.classList.contains('edit-history-thumb')).length
      )
    ).toBe(0);
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
  });

  it('unavailable: the saved entries stay, with the reason on top', async () => {
    const s = state.get(sessionA)!;
    state.set(sessionA, { ...s, state: 'unavailable', reason: 'EACCES: permission denied' });
    await reload();
    await page.waitForSelector('#editHistoryBody .edit-history-note--warn');
    expect(await page.textContent('#editHistoryBody .edit-history-note--warn')).toBe(
      'Showing saved entries only: EACCES: permission denied'
    );
    expect(await rows().count()).toBeGreaterThan(0);
    state.set(sessionA, { ...s, state: 'ok' });
  });

  it('no transcript yet: says it comes with the next prompt, and names CLAUDE_CONFIG_DIR', async () => {
    const s = state.get(sessionA)!;
    state.set(sessionA, { ...s, state: 'unavailable', reason: 'no-transcript', entries: [] });
    await reload();
    await page.waitForSelector('#editHistoryBody .edit-history-note--warn');
    const note = (await page.textContent('#editHistoryBody .edit-history-note--warn')) ?? '';
    expect(note).toContain('No transcript found for this session yet');
    expect(note).toContain('CLAUDE_CONFIG_DIR');
    // A remote host sends no hooks: no promise that the next prompt finds it.
    await page.evaluate((sid) => {
      (window as any).app.sessions.get(sid).remote = { hostId: 'h', label: 'h', host: '192.0.2.1' };
    }, sessionA);
    await reload();
    const remoteNote = page.locator('#editHistoryBody .edit-history-note--warn', {
      hasText: 'No transcript found on the remote host yet',
    });
    await remoteNote.waitFor();
    expect(await remoteNote.textContent()).not.toContain('next prompt');
    await page.evaluate((sid) => delete (window as any).app.sessions.get(sid).remote, sessionA);
    state.set(sessionA, s);
    await reload();
  });

  it('follows the active session, and says when a session is not a Claude session', async () => {
    await select(sessionB);
    await page.waitForFunction(() =>
      /only available for Claude sessions outside Docker/.test(
        document.getElementById('editHistoryBody')!.textContent ?? ''
      )
    );
    expect(calls).toContain(`GET /api/sessions/${sessionB}/edits?sync=1`);
    expect(await rows().count()).toBe(0);
    await select(sessionA);
    await page.waitForSelector('#editHistoryBody .edit-history-entry');
  });

  it('drags by the header', async () => {
    const before = await page.evaluate(() => document.getElementById('editHistoryPanel')!.getBoundingClientRect().left);
    const box = (await page.locator('.edit-history-header').boundingBox())!;
    await page.mouse.move(box.x + 40, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x - 140, box.y + 70, { steps: 5 });
    await page.mouse.up();
    const after = await page.evaluate(() => document.getElementById('editHistoryPanel')!.getBoundingClientRect().left);
    expect(after).toBeLessThan(before - 100);
  });

  it('turning the setting off hides the button and closes the panel; SSE then reads nothing', async () => {
    await setSetting(false);
    expect(await buttonVisible()).toBe(false);
    expect(await page.isVisible('#editHistoryPanel')).toBe(false);
    const before = calls.length;
    toolEnd(sessionA, 'Edit');
    await page.waitForTimeout(1200);
    expect(calls.length).toBe(before);
  });
});
