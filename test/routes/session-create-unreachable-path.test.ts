/**
 * @fileoverview Session creation must not freeze the server on a workspace whose
 * network mount has gone away (`POST /api/sessions` with a `workingDir` on it, and
 * `POST /api/quick-start` for a linked case that lives there), and must not treat
 * "did not answer" as "does not exist" (quick-start would scaffold a fresh case
 * over the top of where the real one is mounted).
 *
 * A hard mount that stopped answering is simulated two ways, matching how each
 * API behaves on one: a synchronous probe (`existsSync`/`statSync`/`mkdirSync`)
 * busy-waits, freezing the event loop, and an async `stat()` never settles.
 *
 * Uses app.inject(), so no real HTTP port is needed.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';

const dead = vi.hoisted(() => {
  // Short probe timeout so a stalled stat costs ~200 ms here. Read at import.
  process.env.CODEMAN_PATH_PROBE_TIMEOUT_MS = '200';
  return {
    root: '/mnt/codeman-test-dead-mount',
    blockMs: 3_000,
    syncTouches: [] as string[],
    releases: [] as Array<() => void>,
  };
});

function onDeadMount(path: unknown): boolean {
  const p = String(path);
  return p === dead.root || p.startsWith(dead.root + '/');
}

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const freezeOn =
    <T extends (...args: never[]) => unknown>(fn: T) =>
    (...args: Parameters<T>): ReturnType<T> => {
      if (onDeadMount(args[0])) {
        dead.syncTouches.push(String(args[0]));
        const until = Date.now() + dead.blockMs;
        while (Date.now() < until) {
          // spin: the event loop is frozen for as long as the mount does not answer
        }
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      }
      return fn(...args) as ReturnType<T>;
    };
  const existsSync = freezeOn(actual.existsSync);
  const statSync = freezeOn(actual.statSync as (...args: never[]) => unknown);
  const mkdirSync = freezeOn(actual.mkdirSync as (...args: never[]) => unknown);
  return {
    ...actual,
    existsSync,
    statSync,
    mkdirSync,
    default: { ...actual, existsSync, statSync, mkdirSync },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const stat = ((path: string, ...rest: unknown[]) => {
    if (onDeadMount(path)) {
      return new Promise((_resolve, reject) => {
        dead.releases.push(() => reject(Object.assign(new Error('EIO'), { code: 'EIO' })));
      });
    }
    return (actual.stat as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof actual.stat;
  return { ...actual, stat, default: { ...actual, stat } };
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { dataPath } from '../../src/config/instance.js';

describe('session creation on an unreachable mount', () => {
  let app: FastifyInstance;
  let scratch: string;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    dead.syncTouches.length = 0;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    scratch = await mkdtemp(join(tmpdir(), 'codeman-unreachable-create-'));
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    registerSessionRoutes(app, createMockRouteContext() as never);
    installRouteErrorHandler(app);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    dead.releases.splice(0).forEach((release) => release());
    await new Promise((r) => setTimeout(r, 0));
    await rm(scratch, { recursive: true, force: true });
    await rm(dataPath('linked-cases.json'), { force: true });
    warn.mockRestore();
  });

  afterAll(() => {
    delete process.env.CODEMAN_PATH_PROBE_TIMEOUT_MS;
  });

  it('POST /api/sessions answers promptly, and not as "does not exist", for a workingDir on a dead mount', async () => {
    const started = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'dead-mount', mode: 'shell', workingDir: `${dead.root}/project` },
    });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(dead.blockMs - 1_000);
    expect(dead.syncTouches).toEqual([]);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('OPERATION_FAILED');
    expect(body.error).toMatch(/not responding/i);
  });

  it('POST /api/sessions keeps INVALID_INPUT for a missing workingDir and for a file', async () => {
    const file = join(scratch, 'a-file.txt');
    await writeFile(file, 'x');

    const missing = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'missing', mode: 'shell', workingDir: join(scratch, 'nope') },
    });
    expect(JSON.parse(missing.body)).toMatchObject({
      success: false,
      errorCode: 'INVALID_INPUT',
      error: 'workingDir does not exist',
    });

    const notDir = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      payload: { name: 'file', mode: 'shell', workingDir: file },
    });
    expect(JSON.parse(notDir.body)).toMatchObject({
      success: false,
      errorCode: 'INVALID_INPUT',
      error: 'workingDir is not a directory',
    });
  });

  it('POST /api/quick-start refuses, promptly and without scaffolding, a linked case on a dead mount', async () => {
    await writeFile(dataPath('linked-cases.json'), JSON.stringify({ 'nas-linked': `${dead.root}/linked` }));

    const started = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/api/quick-start',
      payload: { caseName: 'nas-linked', mode: 'shell' },
    });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(dead.blockMs - 1_000);
    // Neither probed nor created synchronously on the dead mount.
    expect(dead.syncTouches).toEqual([]);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.errorCode).toBe('OPERATION_FAILED');
    expect(body.error).toMatch(/not responding/i);
  });
});
