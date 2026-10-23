/**
 * @fileoverview The edit history panel's API (GET/POST /api/sessions/:id/edits…): a real
 * EditHistorySync and store over a fake transcript reader. Port: N/A (app.inject()).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouteTestHarness } from './_route-test-utils.js';
import { hunksToUnified, registerEditHistoryRoutes, relativeTo } from '../../src/web/routes/edit-history-routes.js';
import { EditHistorySync, NO_TRANSCRIPT, type EditHistorySyncDeps } from '../../src/web/edit-history-sync.js';
import { EditHistoryStore } from '../../src/edit-history-store.js';
import type { EditSources } from '../../src/edit-history-local-source.js';

const T0 = Date.parse('2026-10-15T20:00:00.000Z');
let dir: string;
let session: Record<string, unknown>;

function editLine(id: string, ts: number, path: string, extra: Record<string, unknown> = {}): string {
  return (
    JSON.stringify({
      type: 'user',
      timestamp: new Date(ts).toISOString(),
      cwd: '/w',
      message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: 'ok' }] },
      toolUseResult: {
        filePath: path,
        oldString: 'a',
        newString: 'b',
        structuredPatch: [{ oldStart: 4, oldLines: 1, newStart: 4, newLines: 2, lines: ['-a', '+b', '+c'] }],
      },
      ...extra,
    }) + '\n'
  );
}

function sources(main: string, sub?: string): EditSources {
  const files = [{ relPath: 'main', size: Buffer.byteLength(main), startOffset: 0, chunk: Buffer.from(main) }];
  const metas: Record<string, string> = {};
  if (sub) {
    files.push({
      relPath: 'subagents/agent-a1.jsonl',
      size: Buffer.byteLength(sub),
      startOffset: 0,
      chunk: Buffer.from(sub),
    });
    metas.a1 = JSON.stringify({
      description: 'Fix it',
      agentType: 'coding',
      worktreePath: '/w/.claude/worktrees/agent-a1',
      worktreeBranch: 'worktree-agent-a1',
    });
  }
  return { transcriptId: 'conv1', files, metas };
}

async function setup(
  deps: Partial<EditHistorySyncDeps> = {},
  opts: { authUser?: { username: string; role: 'admin' | 'user' } } = {}
) {
  const read = vi.fn(async () => sources(editLine('t1', T0, '/w/src/a.ts')));
  const sync = new EditHistorySync({
    transcriptPath: async () => '/p/conv1.jsonl',
    readSources: read,
    probe: async (p) => p.map(() => null),
    loadStore: async (id) => {
      const store = await EditHistoryStore.load(id, { dir, debounceMs: 0 });
      opened.push(store);
      return store;
    },
    deleteStore: (id) => EditHistoryStore.delete(id, { dir }),
    sweepStores: async () => 0,
    ...deps,
  });
  const h = await createRouteTestHarness((app, ctx) => registerEditHistoryRoutes(app, ctx, sync), {
    authUser: opts.authUser,
  });
  session = h.ctx._session as unknown as Record<string, unknown>;
  session.workingDir = '/w';
  session.mode = 'claude';
  session.claudeSessionId = 'conv1';
  return { ...h, read, sync };
}

/** Stores the tests opened; removed before the temp dir, so no late save recreates it. */
const opened: EditHistoryStore[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edit-routes-'));
});
afterEach(async () => {
  delete process.env.CODEMAN_MULTIUSER;
  await Promise.all(opened.splice(0).map((s) => s.remove()));
  rmSync(dir, { recursive: true, force: true });
});

const URL = '/api/sessions/test-session-1/edits';

describe('GET /api/sessions/:id/edits', () => {
  it('syncs on ?sync=1 and lists entries without diffs, paths relative to the workspace', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: `${URL}?sync=1` });
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data).toMatchObject({ state: 'ok', backfillTruncated: false, agents: {} });
    expect(data.entries).toEqual([
      expect.objectContaining({
        id: 't1',
        path: '/w/src/a.ts',
        relPath: 'src/a.ts',
        tool: 'Edit',
        added: 2,
        removed: 1,
      }),
    ]);
    expect(data.entries[0]).not.toHaveProperty('hunks');
  });

  it('starts the sync before it loads the store (a deletion right after the session check stops the sync)', async () => {
    const { app, sync } = await setup();
    const calls: string[] = [];
    const syncFn = sync.sync.bind(sync);
    const getStore = sync.getStore.bind(sync);
    vi.spyOn(sync, 'sync').mockImplementation((...a) => (calls.push('sync'), syncFn(...a)));
    vi.spyOn(sync, 'getStore').mockImplementation((...a) => (calls.push('getStore'), getStore(...a)));
    await app.inject({ method: 'GET', url: `${URL}?sync=1` });
    await app.inject({ method: 'POST', url: `${URL}/older` });
    expect(calls).toEqual(['sync', 'getStore', 'sync', 'getStore']);
  });

  it('without sync=1 answers from the store and does not read', async () => {
    const { app, read } = await setup();
    const res = await app.inject({ method: 'GET', url: URL });
    expect(res.json().data).toMatchObject({ state: 'ok', entries: [] });
    expect(read).not.toHaveBeenCalled();
  });

  it('labels subagent entries and shows their paths relative to the worktree', async () => {
    const sub = editLine('t9', T0 + 5, '/w/.claude/worktrees/agent-a1/lib/x.ts', { isSidechain: true, agentId: 'a1' });
    const read = vi.fn(async () => sources(editLine('t1', T0, '/w/src/a.ts'), sub));
    const { app } = await setup({ readSources: read });
    const data = (await app.inject({ method: 'GET', url: `${URL}?sync=1` })).json().data;
    expect(data.agents).toEqual({
      a1: { description: 'Fix it', agentType: 'coding', worktreeBranch: 'worktree-agent-a1' },
    });
    expect(data.entries.find((e: { id: string }) => e.id === 't9')).toMatchObject({
      agentId: 'a1',
      relPath: 'lib/x.ts',
    });
  });

  it('a read error answers unavailable with the stored entries', async () => {
    let fail = false;
    const read = vi.fn(async () => {
      if (fail) throw new Error('EACCES: permission denied');
      return sources(editLine('t1', T0, '/w/src/a.ts'));
    });
    const { app } = await setup({ readSources: read });
    await app.inject({ method: 'GET', url: `${URL}?sync=1` });
    fail = true;
    const data = (await app.inject({ method: 'GET', url: `${URL}?sync=1` })).json().data;
    expect(data).toMatchObject({ state: 'unavailable', reason: 'EACCES: permission denied' });
    expect(data.entries).toHaveLength(1);
  });

  it('hands the reader the session ids and its own CLAUDE_CONFIG_DIR', async () => {
    const seen: unknown[] = [];
    const { app } = await setup({
      transcriptPath: async (s) => {
        seen.push({ id: s.id, claudeSessionId: s.claudeSessionId, claudeConfigDir: s.claudeConfigDir });
        return '/p/conv1.jsonl';
      },
    });
    session.claudeConfigDirOverride = '/cfg/alt ';
    await app.inject({ method: 'GET', url: `${URL}?sync=1` });
    expect(seen).toEqual([{ id: 'test-session-1', claudeSessionId: 'conv1', claudeConfigDir: '/cfg/alt' }]);
  });

  it('a session without a transcript yet answers unavailable (no-transcript)', async () => {
    const { app, read } = await setup({ transcriptPath: async () => null });
    const data = (await app.inject({ method: 'GET', url: `${URL}?sync=1` })).json().data;
    expect(data).toMatchObject({ state: 'unavailable', reason: NO_TRANSCRIPT, entries: [] });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ['remote', { remote: { host: 'huff' } }],
    ['docker', { docker: { image: 'x' } }],
    ['mode', { mode: 'shell' }],
  ])('answers unsupported (%s) without reading', async (reason, patch) => {
    const { app, read } = await setup();
    Object.assign(session, patch);
    const data = (await app.inject({ method: 'GET', url: `${URL}?sync=1` })).json().data;
    expect(data).toMatchObject({ state: 'unsupported', reason });
    expect(read).not.toHaveBeenCalled();
  });

  it('404s an unknown session', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/sessions/nope/edits' })).statusCode).toBe(404);
  });

  it('multi-user: another user’s session is not found and nothing is read', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const { app, read } = await setup({}, { authUser: { username: 'bob', role: 'user' } });
    session.owner = 'alice';
    const res = await app.inject({ method: 'GET', url: `${URL}?sync=1` });
    expect(res.statusCode).toBe(404);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('GET /api/sessions/:id/edits/:entryId', () => {
  it('returns the diff as unified text', async () => {
    const { app } = await setup();
    await app.inject({ method: 'GET', url: `${URL}?sync=1` });
    const res = await app.inject({ method: 'GET', url: `${URL}/t1` });
    expect(res.json().data).toEqual({ diff: '@@ -4,1 +4,2 @@\n-a\n+b\n+c', truncated: false });
  });

  it('404s an edit the session does not have', async () => {
    const { app } = await setup();
    expect((await app.inject({ method: 'GET', url: `${URL}/missing` })).statusCode).toBe(404);
  });

  it('multi-user: another user’s diff is not found', async () => {
    process.env.CODEMAN_MULTIUSER = '1';
    const { app } = await setup({}, { authUser: { username: 'bob', role: 'user' } });
    await app.inject({ method: 'GET', url: `${URL}?sync=1` });
    session.owner = 'alice';
    expect((await app.inject({ method: 'GET', url: `${URL}/t1` })).statusCode).toBe(404);
  });
});

describe('POST /api/sessions/:id/edits/older', () => {
  it('reads the next older block and lists the result', async () => {
    const lines = [0, 1, 2, 3].map((i) => editLine(`t${i}`, T0 + i, `/w/${i}.ts`)).join('');
    const full = Buffer.from(lines);
    const read = vi.fn(
      async (_path: string, requests: readonly { relPath: string; offset: number; len?: number }[], budget: number) => {
        const req = requests.find((r) => r.relPath === 'main');
        const start = req ? req.offset : full.length - budget;
        const len = req?.len ?? full.length - start;
        return {
          transcriptId: 'conv1',
          metas: {},
          files: [{ relPath: 'main', size: full.length, startOffset: start, chunk: full.subarray(start, start + len) }],
        };
      }
    );
    const { app } = await setup({ readSources: read, budget: 400 });
    const first = (await app.inject({ method: 'GET', url: `${URL}?sync=1` })).json().data;
    expect(first.backfillTruncated).toBe(true);
    const older = (await app.inject({ method: 'POST', url: `${URL}/older` })).json().data;
    expect(older.entries.length).toBeGreaterThan(first.entries.length);
  });

  it('answers unsupported for a remote session without reading', async () => {
    const { app, read } = await setup();
    session.remote = { host: 'huff' };
    const data = (await app.inject({ method: 'POST', url: `${URL}/older` })).json().data;
    expect(data).toMatchObject({ state: 'unsupported', reason: 'remote' });
    expect(read).not.toHaveBeenCalled();
  });
});

describe('helpers', () => {
  it('relativeTo strips only a real directory prefix', () => {
    expect(relativeTo('/w/a/b.ts', '/w')).toBe('a/b.ts');
    expect(relativeTo('/w/a/b.ts', '/w/')).toBe('a/b.ts');
    expect(relativeTo('/wx/b.ts', '/w')).toBe('/wx/b.ts');
    expect(relativeTo('/w/b.ts', undefined)).toBe('/w/b.ts');
  });

  it('hunksToUnified writes one header per hunk', () => {
    expect(
      hunksToUnified([
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-x', '+y'] },
        { oldStart: 9, oldLines: 0, newStart: 9, newLines: 1, lines: ['+z'] },
      ])
    ).toBe('@@ -1,1 +1,1 @@\n-x\n+y\n@@ -9,0 +9,1 @@\n+z');
  });
});
