/**
 * Edit history image probe against a filesystem that stopped answering (#693 review): a Bash
 * call printed a path on a dead hard mount, whose stat() never settles. The real sync with the
 * real probe (`probeLocalPaths` → bounded `probePathKind`) must still finish, the next queued
 * sync too, and `remove()` must not wait on it. Own file: the stalled probe stays recorded
 * process-wide for the rest of the run.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DEAD = '/mnt/dead-nas';

vi.hoisted(() => {
  process.env.CODEMAN_PATH_PROBE_TIMEOUT_MS = '100';
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const hangs = (p: unknown) => String(p).startsWith('/mnt/dead-nas');
  const stat = ((p: Parameters<typeof real.stat>[0], ...rest: unknown[]) =>
    hangs(p) ? new Promise(() => {}) : (real.stat as (...a: unknown[]) => unknown)(p, ...rest)) as typeof real.stat;
  const realpath = ((p: Parameters<typeof real.realpath>[0], ...rest: unknown[]) =>
    hangs(p)
      ? new Promise(() => {})
      : (real.realpath as (...a: unknown[]) => unknown)(p, ...rest)) as typeof real.realpath;
  return { ...real, stat, realpath, default: { ...real, stat, realpath } };
});

import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditHistoryStore } from '../src/edit-history-store.js';
import { probeLocalPaths, type EditSources } from '../src/edit-history-local-source.js';
import { EditHistorySync, type EditHistorySession } from '../src/web/edit-history-sync.js';

const T0 = Date.parse('2026-10-15T20:00:00.000Z');
const session: EditHistorySession = { id: 's1', mode: 'claude', remote: undefined, claudeSessionId: 'conv1' };

function bashPair(id: string, start: number, end: number, stdout: string): string {
  const use = {
    type: 'assistant',
    timestamp: new Date(start).toISOString(),
    cwd: '/w',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'render' } }] },
  };
  const res = {
    type: 'user',
    timestamp: new Date(end).toISOString(),
    cwd: '/w',
    message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: stdout }] },
    toolUseResult: { stdout, stderr: '', interrupted: false, isImage: false },
  };
  return JSON.stringify(use) + '\n' + JSON.stringify(res) + '\n';
}

/** Rejects after `ms`, so a hang fails the test instead of timing it out silently. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what} still pending after ${ms} ms`)), ms)),
  ]);
}

let dir: string;
let stores: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edit-stall-'));
  stores = join(dir, 'stores');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('edit history image probe on an unresponsive mount', () => {
  it('finishes sync, a queued sync and remove() while one printed path never answers', async () => {
    const ok = join(dir, 'ok.png');
    writeFileSync(ok, 'PNG!');
    utimesSync(ok, new Date(T0 + 2000), new Date(T0 + 2000));
    let main = Buffer.from(bashPair('b1', T0, T0 + 5000, `${DEAD}/plots/a.png\nsaved ${ok}\n`));

    const sync = new EditHistorySync({
      transcriptPath: async () => '/p/conv1.jsonl',
      readSources: async (_session, _path, requests, budget): Promise<EditSources> => {
        const req = requests.find((r) => r.relPath === 'main');
        const start = Math.min(req?.offset ?? 0, main.length);
        const len = Math.min(budget, main.length - start);
        return {
          transcriptId: 'conv1',
          files: [{ relPath: 'main', size: main.length, startOffset: start, chunk: main.subarray(start, start + len) }],
          metas: {},
        };
      },
      probe: (_session, paths) => probeLocalPaths(paths),
      loadStore: (id) => EditHistoryStore.load(id, { dir: stores, debounceMs: 0 }),
      deleteStore: (id) => EditHistoryStore.delete(id, { dir: stores }),
      sweepStores: async () => 0,
    });

    const first = sync.sync(session);
    main = Buffer.concat([main, Buffer.from(bashPair('b2', T0 + 6000, T0 + 7000, `${DEAD}/plots/b.png\n`))]);
    const second = sync.sync(session);
    expect(await within(first, 1500, 'first sync')).toEqual({ state: 'ok' });
    expect(await within(second, 1500, 'queued sync')).toEqual({ state: 'ok' });
    expect((await sync.getStore('s1')).list().map((e) => e.path)).toEqual([ok]);
    await within(sync.remove('s1'), 1500, 'remove()');
  });
});
