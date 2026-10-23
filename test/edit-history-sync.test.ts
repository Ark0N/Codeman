/**
 * Edit history sync: reader, store, image confirmation, single-flight, failure states and the
 * "reads only on request" wiring. Reader and probe are fakes; the store is real (temp dir).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditHistoryStore } from '../src/edit-history-store.js';
import type {
  EditSourceReadOptions,
  EditSourceRequest,
  EditSources,
  PathProbe,
} from '../src/edit-history-local-source.js';
import {
  confirmImages,
  EditHistorySync,
  NO_TRANSCRIPT,
  REMOVED,
  type EditHistorySession,
  type EditHistorySyncDeps,
  unsupportedReason,
} from '../src/web/edit-history-sync.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edit-sync-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.parse('2026-10-15T20:00:00.000Z');

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
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
      },
      ...extra,
    }) + '\n'
  );
}

function bashPair(id: string, start: number, end: number, command: string): string {
  const use = JSON.stringify({
    type: 'assistant',
    timestamp: new Date(start).toISOString(),
    cwd: '/w',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
  });
  const res = JSON.stringify({
    type: 'user',
    timestamp: new Date(end).toISOString(),
    cwd: '/w',
    message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: '' }] },
    toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false },
  });
  return use + '\n' + res + '\n';
}

/** An in-memory transcript: files by relPath, served with the reader contract. */
class FakeHost {
  transcriptId = 'conv1';
  files = new Map<string, Buffer>();
  metas: Record<string, string> = {};
  calls: EditSourceRequest[][] = [];
  paths: string[] = [];
  /** What `transcriptPath` answers (the transcript watcher's path); null = none yet. */
  get path(): string | null {
    return this.files.size > 0 ? `/p/${this.transcriptId}.jsonl` : null;
  }
  read = async (
    mainPath: string,
    requests: readonly EditSourceRequest[],
    budget: number,
    opts: EditSourceReadOptions = {}
  ): Promise<EditSources | null> => {
    this.calls.push([...requests]);
    this.paths.push(mainPath);
    if (this.files.size === 0) return null;
    let remaining = budget;
    const out: EditSources = { transcriptId: this.transcriptId, files: [], metas: {} };
    for (const [relPath, buf] of this.files) {
      const req = requests.find((r) => r.relPath === relPath);
      if (!req && opts.onlyRequested) continue;
      let start: number;
      let len: number;
      if (req?.len !== undefined) {
        const blockEnd = Math.min(req.offset + req.len, buf.length);
        len = Math.min(blockEnd - Math.min(req.offset, buf.length), remaining);
        start = blockEnd - len;
      } else if (req) {
        start = Math.min(req.offset, buf.length);
        len = Math.min(remaining, buf.length - start);
      } else {
        len = Math.min(buf.length, remaining);
        start = buf.length - len;
        const agent = /^subagents\/agent-(.+)\.jsonl$/.exec(relPath)?.[1];
        if (agent && this.metas[agent]) out.metas[agent] = this.metas[agent];
      }
      remaining -= len;
      out.files.push({ relPath, size: buf.length, startOffset: start, chunk: buf.subarray(start, start + len) });
    }
    return out;
  };
  append(relPath: string, text: string): void {
    this.files.set(relPath, Buffer.concat([this.files.get(relPath) ?? Buffer.alloc(0), Buffer.from(text)]));
  }
}

function setup(over: Partial<EditHistorySyncDeps> = {}) {
  const host = new FakeHost();
  const probes = new Map<string, PathProbe>();
  const lookups: string[] = [];
  const deps: EditHistorySyncDeps = {
    transcriptPath: async (session) => {
      lookups.push(session.id);
      return host.path;
    },
    readSources: (path, req, budget, opts) => host.read(path, req, budget, opts),
    probe: async (paths) => paths.map((p) => probes.get(p) ?? null),
    loadStore: (id) => EditHistoryStore.load(id, { dir, debounceMs: 0 }),
    ...over,
  };
  return { host, probes, lookups, deps, sync: new EditHistorySync(deps) };
}

const local: EditHistorySession = { id: 's1', mode: 'claude', remote: undefined, claudeSessionId: 'conv1' };
const remote: EditHistorySession = {
  id: 's2',
  mode: 'claude',
  remote: { host: 'huff' } as EditHistorySession['remote'],
  claudeSessionId: 'conv1',
};

describe('unsupportedReason', () => {
  it('accepts a local claude session, rejects remote, docker and non-claude CLIs', () => {
    expect(unsupportedReason(local)).toBeUndefined();
    expect(unsupportedReason(remote)).toBe('remote');
    expect(unsupportedReason({ ...local, docker: { image: 'x' } })).toBe('docker');
    expect(unsupportedReason({ ...local, mode: 'shell' })).toBe('mode');
  });
});

describe('EditHistorySync', () => {
  it('reads new edits forward from the stored offset', async () => {
    const { host, sync } = setup();
    host.append('main', editLine('t1', T0, '/w/a.ts'));
    expect(await sync.sync(local)).toEqual({ state: 'ok' });
    host.append('main', editLine('t2', T0 + 1000, '/w/b.ts'));
    await sync.sync(local);
    expect((await sync.getStore('s1')).list().map((e) => e.id)).toEqual(['t2', 't1']);
    expect(host.calls[1]).toEqual([
      { relPath: 'main', offset: host.files.get('main')!.length - editLine('t2', T0 + 1000, '/w/b.ts').length },
    ]);
    expect(host.paths).toEqual(['/p/conv1.jsonl', '/p/conv1.jsonl']);
  });

  it('reads subagent transcripts and records their meta', async () => {
    const { host, sync } = setup();
    host.append('main', editLine('t1', T0, '/w/a.ts'));
    host.append('subagents/agent-a1.jsonl', editLine('t9', T0 + 5, '/w/sub.ts', { isSidechain: true, agentId: 'a1' }));
    host.metas.a1 = '{"description":"Fix it","agentType":"coding"}';
    await sync.sync(local);
    const store = await sync.getStore('s1');
    expect(store.get('t9')?.agentId).toBe('a1');
    expect(store.getAgents().a1).toEqual({ description: 'Fix it', agentType: 'coding' });
  });

  it('reads a new conversation (/clear, resume) from its end, keeping the entries', async () => {
    const { host, sync } = setup();
    host.append('main', editLine('t1', T0, '/w/a.ts'));
    await sync.sync(local);
    host.transcriptId = 'conv2';
    host.files.set('main', Buffer.from(editLine('n1', T0 + 9, '/w/n.ts')));
    await sync.sync(local);
    expect(host.paths.at(-1)).toBe('/p/conv2.jsonl');
    expect(host.calls.at(-1)).toEqual([]); // no offsets of the old file
    const store = await sync.getStore('s1');
    expect(store.getTranscriptId()).toBe('conv2');
    expect(store.list().map((e) => e.id)).toEqual(['n1', 't1']);
  });

  it('keeps reading in passes when a file grew by more than one budget', async () => {
    const { host, sync } = setup({ budget: 600 });
    host.append('main', editLine('t0', T0, '/w/z.ts'));
    await sync.sync(local);
    for (let i = 1; i <= 3; i++) host.append('main', editLine(`t${i}`, T0 + i, `/w/${i}.ts`));
    await sync.sync(local);
    expect((await sync.getStore('s1')).list()).toHaveLength(4);
  });

  it('turns a Bash image into an entry only when its mtime lies in the call window', async () => {
    const { host, probes, sync } = setup();
    host.append('main', bashPair('b1', T0, T0 + 5000, 'render out/new.png old.png ~/x.png'));
    probes.set('/w/out/new.png', { realPath: '/w/out/new.png', kind: 'file', size: 9, mtimeMs: T0 + 4000 });
    probes.set('/w/old.png', { realPath: '/w/old.png', kind: 'file', size: 9, mtimeMs: T0 - 60_000 });
    probes.set('~/x.png', { realPath: '/home/u/x.png', kind: 'file', size: 9, mtimeMs: T0 + 6500 });
    await sync.sync(local);
    expect((await sync.getStore('s1')).list().map((e) => [e.path, e.tool, e.kind])).toEqual([
      ['/w/out/new.png', 'bash', 'image'],
      ['/home/u/x.png', 'bash', 'image'],
    ]);
  });

  it('keeps the edits when only the image probe fails', async () => {
    const { host, sync } = setup({
      probe: async () => {
        throw new Error('probe failed');
      },
    });
    host.append('main', editLine('t1', T0, '/w/a.ts') + bashPair('b1', T0, T0 + 1, 'x out.png'));
    expect(await sync.sync(local)).toEqual({ state: 'ok' });
    expect((await sync.getStore('s1')).list().map((e) => e.id)).toEqual(['t1']);
  });

  it('reports a session without a transcript yet, then reads it once there is one', async () => {
    const { host, sync } = setup();
    expect(await sync.sync(local)).toEqual({ state: 'unavailable', reason: NO_TRANSCRIPT });
    expect(host.calls).toEqual([]);
    host.append('main', editLine('t1', T0, '/w/a.ts'));
    expect(await sync.sync(local)).toEqual({ state: 'ok' });
    expect((await sync.getStore('s1')).list()).toHaveLength(1);
  });

  it('reports a transcript that vanished (watcher path stale) the same way', async () => {
    const { host, sync } = setup({ transcriptPath: async () => '/p/gone.jsonl' });
    expect(await sync.sync(local)).toEqual({ state: 'unavailable', reason: NO_TRANSCRIPT });
    expect(host.paths).toEqual(['/p/gone.jsonl']);
  });

  it('reports a read error as unavailable and keeps the stored entries', async () => {
    const { host, sync, deps } = setup();
    host.append('main', editLine('t1', T0, '/w/a.ts'));
    await sync.sync(local);
    deps.readSources = async () => {
      throw new Error('EACCES: permission denied');
    };
    const status = await sync.sync(local);
    expect(status).toEqual({ state: 'unavailable', reason: 'EACCES: permission denied' });
    expect((await sync.getStore('s1')).list()).toHaveLength(1);
  });

  it('marks remote, docker and non-claude sessions unsupported without looking for a transcript', async () => {
    const { host, lookups, sync } = setup();
    host.append('main', editLine('t1', T0, '/w/a.ts'));
    expect(await sync.sync({ ...local, mode: 'shell' })).toEqual({ state: 'unsupported', reason: 'mode' });
    expect(await sync.sync(remote)).toEqual({ state: 'unsupported', reason: 'remote' });
    expect(await sync.sync({ ...local, docker: {} })).toEqual({ state: 'unsupported', reason: 'docker' });
    expect(lookups).toEqual([]);
    expect(host.calls).toEqual([]);
  });

  it('runs one sync per session at a time and folds occasions into one more run', async () => {
    const { host, sync } = setup();
    host.append('main', editLine('t1', T0, '/w/a.ts'));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = host.read;
    host.read = async (...a) => {
      await gate;
      return orig(...a);
    };
    const runs = [sync.sync(local), sync.sync(local), sync.sync(local)];
    release();
    await Promise.all(runs);
    expect(host.calls).toHaveLength(2); // the first run + one folded follow-up
  });

  it('loads older blocks on request', async () => {
    const { host, sync } = setup({ budget: 400 });
    for (let i = 0; i < 4; i++) host.append('main', editLine(`t${i}`, T0 + i, `/w/${i}.ts`));
    await sync.sync(local);
    const store = await sync.getStore('s1');
    const before = store.list().length;
    expect(store.backfillTruncated).toBe(true);
    await sync.sync(local, { older: true });
    expect(store.list().length).toBeGreaterThan(before);
  });

  it('flushAll writes pending saves (shutdown) so a reload keeps the entries', async () => {
    const { host, sync } = setup({ loadStore: (id) => EditHistoryStore.load(id, { dir, debounceMs: 60_000 }) });
    host.append('main', editLine('t1', T0, '/w/a.ts'));
    await sync.sync(local);
    await sync.flushAll();
    const reloaded = await EditHistoryStore.load('s1', { dir });
    expect(reloaded.list().map((e) => e.id)).toEqual(['t1']);
  });

  it('remove deletes the stored history', async () => {
    const { host, sync } = setup();
    host.append('main', editLine('t1', T0, '/w/a.ts'));
    await sync.sync(local);
    await (await sync.getStore('s1')).flush();
    await sync.remove('s1');
    expect(() => readFileSync(join(dir, 's1.json'))).toThrow();
  });

  it('a deleted session stays deleted: neither a run in flight nor a later request writes it again', async () => {
    const { host, sync } = setup();
    host.append('main', editLine('t1', T0, '/w/a.ts'));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = host.read;
    host.read = async (...a) => {
      await gate;
      return orig(...a);
    };
    const runs = [sync.sync(local), sync.sync(local)]; // one running, one queued
    const removing = sync.remove('s1');
    release();
    await Promise.all([...runs, removing]);
    await new Promise((r) => setTimeout(r, 20)); // past the store's debounce
    expect(readdirSync(dir)).toEqual([]);
    const reads = host.calls.length;
    expect(await sync.sync(local)).toEqual({ state: 'unavailable', reason: REMOVED });
    await new Promise((r) => setTimeout(r, 20));
    expect(host.calls).toHaveLength(reads);
    expect(readdirSync(dir)).toEqual([]);
    expect((await sync.getStore('s1')).list()).toEqual([]);
  });

  it('concurrent first callers share one store', async () => {
    const { sync } = setup();
    const [a, b] = await Promise.all([sync.getStore('s1'), sync.getStore('s1')]);
    expect(a).toBe(b);
  });

  it('a forward request queued together with an older one still reads forward', async () => {
    const { host, sync } = setup();
    host.append('main', editLine('t1', T0, '/w/a.ts'));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const orig = host.read;
    host.read = async (...a) => {
      const res = await orig(...a); // the first run's bytes are taken before the append
      await gate;
      return res;
    };
    const first = sync.sync(local);
    await new Promise((r) => setTimeout(r, 0));
    host.append('main', editLine('t2', T0 + 1, '/w/b.ts'));
    const queued = [sync.sync(local), sync.sync(local, { older: true })];
    release();
    await Promise.all([first, ...queued]);
    expect((await sync.getStore('s1')).get('t2')).toBeDefined();
  });

  it('load older moves every source back, reading only the blocks it asked for', async () => {
    const { host, sync } = setup({ budget: 2000 });
    for (let i = 0; i < 10; i++) host.append('main', editLine(`m${i}`, T0 + i, `/w/m${i}.ts`));
    for (let i = 0; i < 10; i++) {
      host.append('subagents/agent-ab.jsonl', editLine(`s${i}`, T0 + 100 + i, `/w/s${i}.ts`, { agentId: 'ab' }));
    }
    await sync.sync(local);
    await sync.sync(local); // the subagent gets its first block once main is up to date
    const store = await sync.getStore('s1');
    const floors = () => [store.getCursor('main')!.floor, store.getCursor('subagents/agent-ab.jsonl')!.floor];
    const [main0, sub0] = floors();
    expect(main0).toBeGreaterThan(0);
    expect(sub0).toBeGreaterThan(0);
    await sync.sync(local, { older: true });
    const [main1, sub1] = floors();
    expect(main1).toBeLessThan(main0);
    expect(sub1).toBeLessThan(sub0);
    expect(
      host.calls
        .at(-1)!
        .map((r) => r.relPath)
        .sort()
    ).toEqual(['main', 'subagents/agent-ab.jsonl']);
    for (let i = 0; i < 20 && store.backfillTruncated; i++) await sync.sync(local, { older: true });
    expect(store.list()).toHaveLength(20);
  });
});

describe('confirmImages', () => {
  it('ignores directories and missing files', () => {
    const c = [{ toolUseId: 'b', start: T0, end: T0 + 1, paths: ['/d.png', '/m.png'] }];
    const out = confirmImages(c, (p) =>
      p === '/d.png' ? { realPath: p, kind: 'directory', size: 0, mtimeMs: T0 } : null
    );
    expect(out).toEqual([]);
  });

  it('lists a file sent to the user outside any window, once per file version', () => {
    const png = { realPath: '/w/p.png', kind: 'file' as const, size: 9, mtimeMs: T0 };
    const sent = { toolUseId: 's', start: T0 + 9000, end: T0 + 9000, paths: ['/w/p.png'], sent: true };
    expect(confirmImages([sent], () => png)).toEqual([
      { toolUseId: 's', path: '/w/p.png', ts: T0 + 9000, tool: 'sent' },
    ]);
    // The Bash call that wrote it was already listed: same version, not again.
    expect(
      confirmImages(
        [sent],
        () => png,
        () => T0 + 500
      )
    ).toEqual([]);
    expect(confirmImages([sent], () => null)).toEqual([]);
  });

  it('skips a file version already recorded: the ls right after the render, a listing after a Write', () => {
    const png = { realPath: '/w/p.png', kind: 'file' as const, size: 9, mtimeMs: T0 + 900 };
    const render = { toolUseId: 'r', start: T0, end: T0 + 1000, paths: ['/w/p.png'] };
    const ls = { toolUseId: 'l', start: T0 + 1500, end: T0 + 1600, paths: ['/w/p.png'] };
    expect(confirmImages([ls, render], () => png).map((i) => i.toolUseId)).toEqual(['r']);
    // A Write entry for the same path at T0 + 950 already covers it.
    expect(
      confirmImages(
        [ls],
        () => png,
        () => T0 + 950
      )
    ).toEqual([]);
    // A later re-render (newer mtime, outside the slack) is a new version.
    const again = { toolUseId: 'r2', start: T0 + 10_000, end: T0 + 11_000, paths: ['/w/p.png'] };
    const newer = { ...png, mtimeMs: T0 + 10_500 };
    expect(
      confirmImages(
        [again],
        () => newer,
        () => T0 + 1000
      ).map((i) => i.toolUseId)
    ).toEqual(['r2']);
  });
});

describe('reads only on request (wiring guard)', () => {
  const read = (file: string) => readFileSync(join(__dirname, '..', file), 'utf-8');

  it('the server never starts a sync itself: it only hands the reader to the routes', () => {
    const server = read('src/web/server.ts');
    const uses = [...server.matchAll(/this\.editHistorySync\b(\.\w+)?/g)].map((m) => m[1] ?? '');
    expect(uses.sort()).toEqual(['', '.flushAll', '.remove']);
    expect(server).toMatch(/registerEditHistoryRoutes\(this\.app, ctx, this\.editHistorySync\)/);
  });

  it('no other module holds the reader, and the edit history modules run no timer or watcher', () => {
    for (const file of ['src/web/session-listener-wiring.ts', 'src/web/routes/hook-event-routes.ts']) {
      expect(read(file)).not.toMatch(/editHistory/i);
    }
    for (const file of [
      'src/web/edit-history-sync.ts',
      'src/edit-history-store.ts',
      'src/edit-history-local-source.ts',
      'src/edit-history-parse.ts',
      'src/web/routes/edit-history-routes.ts',
    ]) {
      const src = read(file);
      expect(src, file).not.toMatch(/setInterval|\bwatch\(|chokidar/);
    }
    // The store's only timer is its debounced save.
    expect(read('src/web/edit-history-sync.ts')).not.toMatch(/setTimeout/);
  });
});

vi.setConfig({ testTimeout: 10_000 });
