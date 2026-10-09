/**
 * @fileoverview The server's side of the tile grid's SSE filter (live server,
 * multi-user mode, ephemeral port).
 *
 * While tiles own the terminal the page subscribes with TILE_GRID_SSE_FILTER
 * (constants.js), an id that names no session, so the server sends it no
 * session:terminal batches (test/tile-grid-sse-filter.test.ts covers the page).
 * That holds only while:
 * - the server takes an id it does not know, on the connect query and on
 *   POST /api/events/subscribe (a validation change that refused it would
 *   leave the grid's stream unfiltered, or with no live filter updates at all);
 * - the filter gates nothing but terminal batches: in multi-user mode SSE
 *   routing is fail-closed, so this also checks that session:updated and hook
 *   events still reach their owner, and only their owner, through the filter.
 *
 * Every server read of the filter, for the record: the connect route parses
 * `?sessions=` (server.ts, GET /api/events), POST /api/events/subscribe
 * replaces it (SseStreamManager.updateClientFilter), and its ONE use is
 * flushSessionTerminalBatch. broadcast(), the ownership check (canDeliver), the
 * heartbeat, the order and tab-layout frames and the shutdown notice never read it.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { WebServer } from '../src/web/server.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { createUser, invalidateUsersCache } from '../src/user-store.js';

vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);

const url = (p: string) => `http://localhost:${server.boundPort}${p}`;
const basic = (u: string, p: string) => 'Basic ' + Buffer.from(`${u}:${p}`).toString('base64');
const alice = { Authorization: basic('alice', 'alicepass1') };

/** The page's own constant, read from constants.js, so the two can never drift. */
function gridFilter(): string {
  const window: Record<string, { TILE_GRID_SSE_FILTER?: string }> = {};
  const context = vm.createContext({ window, globalThis: {} });
  vm.runInContext(readFileSync(path.resolve(import.meta.dirname, '../src/web/public/constants.js'), 'utf8'), context);
  return window.CodemanTileGrid.TILE_GRID_SSE_FILTER as string;
}
const FILTER = gridFilter();

type Received = { event: string; data: unknown };
/** An open SSE stream for `headers`, collecting every event until close(). */
async function openStream(query: string, headers: Record<string, string>) {
  const controller = new AbortController();
  const received: Received[] = [];
  const res = await fetch(url(`/api/events${query}`), { headers, signal: controller.signal });
  let text = '';
  const reading = (async () => {
    const reader = res.body!.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
        let cut: number;
        while ((cut = text.indexOf('\n\n')) !== -1) {
          const frame = text.slice(0, cut);
          text = text.slice(cut + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1];
          const data = /^data: (.*)$/m.exec(frame)?.[1];
          if (event && data !== undefined) {
            try {
              received.push({ event, data: JSON.parse(data) });
            } catch {
              received.push({ event, data });
            }
          }
        }
      }
    } catch {
      /* aborted */
    }
  })();
  return {
    status: res.status,
    received,
    close: async () => {
      controller.abort();
      await reading;
    },
  };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn() && Date.now() < end) await wait(20);
};

let server: WebServer;
let dataDir: string;
let spacesDir: string;
const saved: Record<string, string | undefined> = {};
type Internals = {
  sessions: Map<string, unknown>;
  broadcast(event: string, data: unknown): void;
  batchTerminalData(sessionId: string, data: string): void;
};

beforeAll(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sse-grid-data-'));
  spacesDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sse-grid-spaces-'));
  for (const k of [
    'CODEMAN_DATA_DIR',
    'CODEMAN_USER_SPACES_DIR',
    'CODEMAN_MULTIUSER',
    'CODEMAN_PASSWORD',
    'CODEMAN_USERNAME',
  ]) {
    saved[k] = process.env[k];
  }
  process.env.CODEMAN_DATA_DIR = dataDir;
  process.env.CODEMAN_USER_SPACES_DIR = spacesDir;
  process.env.CODEMAN_MULTIUSER = '1';
  delete process.env.CODEMAN_PASSWORD;
  delete process.env.CODEMAN_USERNAME;
  invalidateUsersCache();
  await createUser({ username: 'root', role: 'admin', password: 'rootpass123' });
  await createUser({ username: 'alice', role: 'user', password: 'alicepass1' });
  await createUser({ username: 'bob', role: 'user', password: 'bobpass1234' });
  server = new WebServer(0, false, true);
  await server.start();
});

afterAll(async () => {
  await server?.stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  invalidateUsersCache();
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(spacesDir, { recursive: true, force: true }).catch(() => {});
});

describe('the tile grid SSE filter, multi-user', () => {
  it('is taken on a live re-subscribe though it names no session, and then withholds terminal output', async () => {
    // A tile focus re-subscribes the open stream (POST /api/events/subscribe).
    // A 204 alone would not do: a validation that dropped the id would still
    // answer 204 with the filter cleared, and the stream would carry every
    // session's output. So the filter is checked by what it withholds.
    expect(FILTER).toBe('tile-grid');
    const internals = server as unknown as Internals;
    const grid = await openStream('?clientId=grid-tolerance-1', alice);
    const control = await openStream('?clientId=control-1', alice);
    expect(grid.status).toBe(200);
    await until(() => [grid, control].every((s) => s.received.some((r) => r.event === 'init')));
    const res = await fetch(url('/api/events/subscribe'), {
      method: 'POST',
      headers: { ...alice, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: 'grid-tolerance-1', sessions: [FILTER] }),
    });
    expect(res.status).toBe(204);
    internals.sessions.set('alice-2', { id: 'alice-2', owner: 'alice', toState: () => ({ id: 'alice-2' }) });
    try {
      internals.batchTerminalData('alice-2', 'output of alice-2');
      await until(() => control.received.some((r) => r.event === 'session:terminal'));
      await wait(150);
    } finally {
      internals.sessions.delete('alice-2');
    }
    expect(control.received.some((r) => r.event === 'session:terminal')).toBe(true);
    expect(grid.received.some((r) => r.event === 'session:terminal')).toBe(false);
    await grid.close();
    await control.close();
  });

  it("withholds only terminal output: the subscriber still gets its own sessions' updates and hooks", async () => {
    const internals = server as unknown as Internals;
    const grid = await openStream(`?clientId=grid-1&sessions=${FILTER}`, alice);
    const plain = await openStream('?clientId=plain-1', alice);
    await until(() => [grid, plain].every((s) => s.received.some((r) => r.event === 'init')));

    // One session of alice's and one of bob's (spawning is a no-op under test).
    const fake = (id: string, owner: string) => ({ id, owner, toState: () => ({ id, owner }) });
    internals.sessions.set('alice-1', fake('alice-1', 'alice'));
    internals.sessions.set('bob-1', fake('bob-1', 'bob'));
    try {
      internals.broadcast('session:updated', { id: 'alice-1', session: { id: 'alice-1', status: 'busy' } });
      internals.broadcast('session:updated', { id: 'bob-1', session: { id: 'bob-1', status: 'busy' } });
      internals.broadcast('hook:idle_prompt', { sessionId: 'alice-1' });
      internals.batchTerminalData('alice-1', 'output of alice-1');
      await until(() => plain.received.some((r) => r.event === 'session:terminal'));
      await wait(150);
    } finally {
      internals.sessions.delete('alice-1');
      internals.sessions.delete('bob-1');
    }
    // Only what names the two sessions above (heartbeats and anything else the
    // server sends meanwhile are not this test's business).
    const kinds = (s: { received: Received[] }) =>
      s.received
        .map((r) => {
          const d = (r.data ?? {}) as { id?: string; sessionId?: string };
          return `${r.event} ${d.id ?? d.sessionId}`;
        })
        .filter((k) => k.endsWith(' alice-1') || k.endsWith(' bob-1'));

    expect(kinds(grid)).toEqual(['session:updated alice-1', 'hook:idle_prompt alice-1']);
    // The same user without the filter got the terminal batch: it was sent.
    expect(kinds(plain)).toContain('session:terminal alice-1');
    expect(kinds(plain)).not.toContain('session:updated bob-1');
    await grid.close();
    await plain.close();
  });
});
