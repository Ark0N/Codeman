/**
 * @fileoverview Tests for case-routes route handlers.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 *
 * Responses follow the uniform envelope contract:
 *   SUCCESS -> HTTP 2xx, body = { success: true, data: <payload> }
 *   ERROR   -> HTTP 4xx/5xx, body = { success: false, error, errorCode }
 * Bare handler returns are wrapped into { success:true, data } and returned
 * error envelopes are mapped to their conventional HTTP status by the same
 * preSerialization hook the production server installs (mirrored below so test
 * behavior matches production exactly).
 */

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { registerCaseRoutes } from '../../src/web/routes/case-routes.js';
import { probePath } from '../../src/utils/index.js';
import { MAX_STALLED_PATH_PROBES } from '../../src/config/path-probe.js';

// A short path-probe timeout keeps the unreachable-mount tests quick. Read when the
// probe's config module is first imported, so it is set before any import runs.
vi.hoisted(() => {
  process.env.CODEMAN_PATH_PROBE_TIMEOUT_MS = '300';
});
afterAll(() => {
  delete process.env.CODEMAN_PATH_PROBE_TIMEOUT_MS;
});

// Mock filesystem modules
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  };
});

vi.mock('node:fs/promises', () => ({
  default: {
    stat: vi.fn(),
    readdir: vi.fn(async () => []),
    readFile: vi.fn(async () => {
      const err = new Error('ENOENT') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }),
    writeFile: vi.fn(async () => {}),
    // What the linked-cases writer needs to replace the registry atomically (temp file + rename).
    realpath: vi.fn(async (p: string) => p),
    mkdir: vi.fn(async () => undefined),
    chmod: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    rm: vi.fn(async () => {}),
  },
}));

vi.mock('../../src/templates/claude-md.js', () => ({
  generateClaudeMd: vi.fn(() => '# CLAUDE.md\nGenerated content'),
}));

vi.mock('../../src/hooks-config.js', () => ({
  writeHooksConfig: vi.fn(async () => {}),
}));

// Stub the remote-tmux prereq probe so remote-link tests never shell out to ssh
// (readRemoteHosts/writeRemoteHosts stay real, backed by the mocked fs).
vi.mock('../../src/remote-hosts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/remote-hosts.js')>();
  return {
    ...actual,
    checkRemoteTmuxAvailable: vi.fn(async () => ({ ok: true, tmuxPath: '/usr/bin/tmux' })),
  };
});

vi.mock('../../src/docker-hosts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/docker-hosts.js')>();
  return {
    ...actual,
    checkDockerAvailable: vi.fn(actual.checkDockerAvailable),
    checkDockerImagePresent: vi.fn(actual.checkDockerImagePresent),
  };
});

// Import mocked modules for test control
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { checkRemoteTmuxAvailable } from '../../src/remote-hosts.js';
import { checkDockerAvailable, checkDockerImagePresent } from '../../src/docker-hosts.js';
import { DOCKER_EXPORT_SCHEMA } from '../../src/docker-export.js';

const mockedExistsSync = vi.mocked(existsSync);
const mockedMkdirSync = vi.mocked(mkdirSync);
const mockedReaddirSync = vi.mocked(readdirSync);
const mockedReaddir = vi.mocked(fs.readdir);
const mockedReadFile = vi.mocked(fs.readFile);
const mockedWriteFile = vi.mocked(fs.writeFile);
const mockedStat = vi.mocked(fs.stat);
const mockedCheckRemoteTmux = vi.mocked(checkRemoteTmuxAvailable);

interface CaseRouteHarness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

/**
 * Build a route harness that mirrors production: cookie plugin, the shared
 * route error handler, AND the uniform-envelope preSerialization hook (copied
 * from src/web/server.ts) so bare handler returns become { success:true, data }
 * and returned error envelopes get mapped to a conventional HTTP status.
 */
async function createEnvelopeHarness(authUser?: { username: string; role: 'user' }): Promise<CaseRouteHarness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  if (authUser) {
    app.addHook('onRequest', async (req) => {
      Object.assign(req, { authUser });
    });
  }

  // Uniform response envelope (matches src/web/server.ts preSerialization hook).
  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    if (!req.url.startsWith('/api')) return done(null, payload);
    if (payload === null || typeof payload !== 'object') return done(null, payload);
    if (Buffer.isBuffer(payload) || typeof (payload as { pipe?: unknown }).pipe === 'function') {
      return done(null, payload);
    }
    const p = payload as { success?: unknown; errorCode?: unknown };
    if (p.success === false) {
      if (reply.statusCode === 200 && typeof p.errorCode === 'string') {
        reply.code(httpStatusForErrorCode(p.errorCode as ApiErrorCode));
      }
      return done(null, payload);
    }
    if (p.success === true) return done(null, payload);
    return done(null, { success: true, data: payload });
  });

  const ctx = createMockRouteContext();
  registerCaseRoutes(app, ctx as never);
  installRouteErrorHandler(app);
  await app.ready();

  return { app, ctx };
}

describe('case-routes', () => {
  let harness: CaseRouteHarness;

  beforeEach(async () => {
    harness = await createEnvelopeHarness();
    vi.clearAllMocks();

    // Default: existsSync returns false, readFile throws ENOENT
    mockedExistsSync.mockReturnValue(false);
    mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    // Async stat (the bounded path probe) follows the mocked existsSync, so a
    // test that sets up a path's presence via existsSync drives both the same way.
    mockedStat.mockImplementation(async (path) => {
      if (mockedExistsSync(path)) return { isDirectory: () => true } as never;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== GET /api/cases ==========

  describe('GET /api/cases', () => {
    it('returns empty array when no cases exist', async () => {
      mockedReaddir.mockRejectedValue(new Error('ENOENT'));

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toEqual([]);
    });

    it('returns cases from CASES_DIR', async () => {
      mockedReaddir.mockResolvedValue([
        { name: 'my-case', isDirectory: () => true },
        { name: 'other-case', isDirectory: () => true },
        { name: 'readme.txt', isDirectory: () => false },
      ] as never);
      // No CLAUDE.md exists
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toHaveLength(2);
      expect(body.data[0].name).toBe('my-case');
      expect(body.data[1].name).toBe('other-case');
      expect(body.data[0].hasClaudeMd).toBe(false);
    });

    it('includes hasClaudeMd flag', async () => {
      mockedReaddir.mockResolvedValue([{ name: 'case-with-md', isDirectory: () => true }] as never);
      mockedExistsSync.mockReturnValue(true);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data[0].hasClaudeMd).toBe(true);
    });

    it('includes linked cases from linked-cases.json', async () => {
      // CASES_DIR readdir returns one case
      mockedReaddir.mockResolvedValue([{ name: 'regular-case', isDirectory: () => true }] as never);
      // linked-cases.json is read second (after CASES_DIR readdir)
      let readCallCount = 0;
      mockedReadFile.mockImplementation(async () => {
        readCallCount++;
        if (readCallCount === 1) {
          return JSON.stringify({ 'linked-project': '/home/user/projects/linked' });
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      // existsSync: path exists for linked case, CLAUDE.md check
      mockedExistsSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('linked')) return true;
        return false;
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Should have both regular and linked cases
      expect(body.data.length).toBeGreaterThanOrEqual(1);
    });

    it('still answers promptly when a linked case sits on an unreachable mount', async () => {
      // A hard network mount that went away: a synchronous probe blocks the
      // thread (simulated by a busy-wait), and an async stat never settles.
      const stalledPath = '/mnt/unreachable/linked-nfs';
      const BLOCK_MS = 4_000;
      mockedReaddir.mockResolvedValue([] as never);
      mockedReadFile.mockResolvedValueOnce(JSON.stringify({ 'linked-nfs': stalledPath }) as never);
      mockedExistsSync.mockImplementation((p) => {
        if (String(p) !== stalledPath) return false;
        const until = Date.now() + BLOCK_MS;
        while (Date.now() < until) {
          // spin: the event loop is frozen for as long as the mount does not answer
        }
        return true;
      });
      let release: (() => void) | undefined;
      mockedStat.mockImplementation((p) => {
        if (String(p) !== stalledPath) {
          return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        }
        return new Promise((resolve) => {
          release = () => resolve({ isDirectory: () => true } as never);
        });
      });

      const started = Date.now();
      const res = await harness.app.inject({ method: 'GET', url: '/api/cases' });
      const elapsed = Date.now() - started;
      release?.();

      expect(res.statusCode).toBe(200);
      expect(elapsed).toBeLessThan(BLOCK_MS - 1_000);
      // The unreachable case is listed as such rather than holding the list
      // hostage, or vanishing as though it had been deleted.
      expect(JSON.parse(res.body).data).toEqual([
        {
          name: 'linked-nfs',
          path: stalledPath,
          hasClaudeMd: false,
          linked: true,
          location: 'linked-local',
          unreachable: true,
        },
      ]);
      await new Promise((r) => setTimeout(r, 0)); // let the released stat clear its stall
    });
  });

  describe('remote host and remote case routes', () => {
    function setupRemoteConfigStore() {
      const store = new Map<string, string>();
      mockedReadFile.mockImplementation(async (path) => {
        const key = String(path);
        if (store.has(key)) return store.get(key) || '';
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      mockedWriteFile.mockImplementation(async (path, data) => {
        store.set(String(path), String(data));
      });
    }

    it('creates a remote host and lists it', async () => {
      setupRemoteConfigStore();

      const create = await harness.app.inject({
        method: 'POST',
        url: '/api/remote-hosts',
        payload: {
          id: 'gpu-box',
          label: 'GPU Box',
          host: '10.0.0.42',
          username: 'ubuntu',
          commands: { codex: 'exec codx personal' },
        },
      });
      expect(create.statusCode).toBe(200);
      expect(JSON.parse(create.body)).toMatchObject({ success: true });

      const list = await harness.app.inject({ method: 'GET', url: '/api/remote-hosts' });
      expect(list.statusCode).toBe(200);
      expect(JSON.parse(list.body).data).toEqual([
        expect.objectContaining({ id: 'gpu-box', label: 'GPU Box', commands: { codex: 'exec codx personal' } }),
      ]);
    });

    // COD-107 — advanced SSH connection options (port, identity, SOCKS proxy,
    // jump host, escape-hatch -o options) round-trip through the host schema.
    it('persists advanced SSH options (port/identity/socks/jump/extra) on a remote host', async () => {
      setupRemoteConfigStore();

      const create = await harness.app.inject({
        method: 'POST',
        url: '/api/remote-hosts',
        payload: {
          id: 'aa-desktop',
          label: 'aa-desktop',
          host: '192.168.55.170',
          username: 'aakht',
          port: 2222,
          identityFile: '~/.ssh/remote_ed25519',
          socksProxy: '127.0.0.1:1080',
          jumpHost: 'bastion@10.0.0.1:22',
          extraSshOptions: ['StrictHostKeyChecking=accept-new'],
        },
      });
      expect(create.statusCode).toBe(200);
      expect(JSON.parse(create.body)).toMatchObject({ success: true });

      const list = await harness.app.inject({ method: 'GET', url: '/api/remote-hosts' });
      expect(JSON.parse(list.body).data).toEqual([
        expect.objectContaining({
          id: 'aa-desktop',
          port: 2222,
          identityFile: '~/.ssh/remote_ed25519',
          socksProxy: '127.0.0.1:1080',
          jumpHost: 'bastion@10.0.0.1:22',
          extraSshOptions: ['StrictHostKeyChecking=accept-new'],
        }),
      ]);
    });

    it('rejects a malformed extraSshOptions entry (not KEY=VALUE) with INVALID_INPUT', async () => {
      setupRemoteConfigStore();

      const create = await harness.app.inject({
        method: 'POST',
        url: '/api/remote-hosts',
        payload: {
          id: 'bad-host',
          label: 'bad',
          host: '10.0.0.9',
          username: 'ubuntu',
          extraSshOptions: ['not a valid option'],
        },
      });
      expect(create.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.INVALID_INPUT));
      expect(JSON.parse(create.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.INVALID_INPUT });
    });

    it('rejects a malformed socksProxy (missing port) with INVALID_INPUT', async () => {
      setupRemoteConfigStore();

      const create = await harness.app.inject({
        method: 'POST',
        url: '/api/remote-hosts',
        payload: { id: 'bad2', label: 'bad2', host: '10.0.0.9', username: 'ubuntu', socksProxy: '127.0.0.1' },
      });
      expect(create.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.INVALID_INPUT));
      expect(JSON.parse(create.body)).toMatchObject({ success: false });
    });

    it('links a remote case and includes it in GET /api/cases', async () => {
      setupRemoteConfigStore();
      mockedReaddir.mockRejectedValue(new Error('ENOENT'));

      await harness.app.inject({
        method: 'POST',
        url: '/api/remote-hosts',
        payload: { id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu' },
      });

      const link = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/remote-link',
        payload: { name: 'gpu-work', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' },
      });
      expect(link.statusCode).toBe(200);

      const cases = await harness.app.inject({ method: 'GET', url: '/api/cases' });
      expect(JSON.parse(cases.body).data).toContainEqual(
        expect.objectContaining({
          name: 'gpu-work',
          location: 'remote',
          path: 'ubuntu@10.0.0.42:/home/ubuntu/work',
          remote: expect.objectContaining({ hostId: 'gpu-box', path: '/home/ubuntu/work' }),
        })
      );
    });

    it('prefers remote case metadata over a same-name local managed case', async () => {
      setupRemoteConfigStore();
      mockedReaddir.mockResolvedValue([{ name: 'gpu-work', isDirectory: () => true }] as never);

      await harness.app.inject({
        method: 'POST',
        url: '/api/remote-hosts',
        payload: { id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu' },
      });
      await harness.app.inject({
        method: 'POST',
        url: '/api/cases/remote-link',
        payload: { name: 'gpu-work', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' },
      });
      mockedExistsSync.mockReturnValue(true);

      const cases = await harness.app.inject({ method: 'GET', url: '/api/cases' });
      expect(JSON.parse(cases.body).data).toContainEqual(
        expect.objectContaining({
          name: 'gpu-work',
          location: 'remote',
          path: 'ubuntu@10.0.0.42:/home/ubuntu/work',
        })
      );
    });

    it('deletes remote case metadata only', async () => {
      setupRemoteConfigStore();

      await harness.app.inject({
        method: 'POST',
        url: '/api/remote-hosts',
        payload: { id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu' },
      });
      await harness.app.inject({
        method: 'POST',
        url: '/api/cases/remote-link',
        payload: { name: 'gpu-work', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' },
      });

      const deleted = await harness.app.inject({ method: 'DELETE', url: '/api/cases/gpu-work' });
      expect(deleted.statusCode).toBe(200);
      expect(JSON.parse(deleted.body)).toEqual({ success: true, data: { name: 'gpu-work' } });
    });

    // Injection hardening: remotePath/identityFile are shell-escaped, then embedded
    // via JSON.stringify() inside `bash -c "..."` — a DOUBLE-quote layer that
    // re-exposes `$(...)`/backticks even inside the inner single quotes. The schema
    // MUST reject those before they reach the launch command.
    it('rejects an identityFile containing $(...) command substitution', async () => {
      setupRemoteConfigStore();

      const create = await harness.app.inject({
        method: 'POST',
        url: '/api/remote-hosts',
        payload: {
          id: 'evil-host',
          label: 'evil',
          host: '10.0.0.9',
          username: 'ubuntu',
          identityFile: '/home/u/$(touch /tmp/pwned)',
        },
      });
      expect(create.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.INVALID_INPUT));
      expect(JSON.parse(create.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.INVALID_INPUT });
    });

    it('rejects an identityFile containing a backtick', async () => {
      setupRemoteConfigStore();

      const create = await harness.app.inject({
        method: 'POST',
        url: '/api/remote-hosts',
        payload: {
          id: 'evil-host2',
          label: 'evil2',
          host: '10.0.0.9',
          username: 'ubuntu',
          identityFile: '/home/u/`touch /tmp/pwned`',
        },
      });
      expect(create.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.INVALID_INPUT));
      expect(JSON.parse(create.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.INVALID_INPUT });
    });

    it('rejects a remotePath containing $(...) command substitution', async () => {
      setupRemoteConfigStore();

      await harness.app.inject({
        method: 'POST',
        url: '/api/remote-hosts',
        payload: { id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu' },
      });
      const link = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/remote-link',
        payload: { name: 'gpu-work', hostId: 'gpu-box', remotePath: '/tmp/$(touch /tmp/pwned)' },
      });
      expect(link.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.INVALID_INPUT));
      expect(JSON.parse(link.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.INVALID_INPUT });
    });

    it('rejects a remotePath containing a backtick', async () => {
      setupRemoteConfigStore();

      await harness.app.inject({
        method: 'POST',
        url: '/api/remote-hosts',
        payload: { id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu' },
      });
      const link = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/remote-link',
        payload: { name: 'gpu-work', hostId: 'gpu-box', remotePath: '/tmp/`touch /tmp/pwned`' },
      });
      expect(link.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.INVALID_INPUT));
      expect(JSON.parse(link.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.INVALID_INPUT });
    });

    it('refuses remote-link when the remote host lacks tmux (courtesy prereq probe)', async () => {
      setupRemoteConfigStore();
      mockedCheckRemoteTmux.mockResolvedValueOnce({
        ok: false,
        error: 'remote host 10.0.0.42 needs tmux installed for durable remote sessions',
      });

      await harness.app.inject({
        method: 'POST',
        url: '/api/remote-hosts',
        payload: { id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu' },
      });
      const link = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/remote-link',
        payload: { name: 'gpu-work', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' },
      });
      expect(link.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.OPERATION_FAILED));
      expect(JSON.parse(link.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.OPERATION_FAILED });
    });
  });

  describe('POST /api/cases/docker-quickcreate', () => {
    const profiles = [
      {
        id: 'local-podman',
        label: 'Podman sandbox',
        engine: 'podman',
        image: 'localhost/agent:dev',
        mountCredentials: false,
      },
      { id: 'docker-dev', label: 'Docker sandbox', engine: 'docker', image: 'agent:dev', context: 'dev-context' },
    ] as const;

    const create = (name: string, body: Record<string, unknown> = {}) =>
      harness.app.inject({ method: 'POST', url: '/api/cases/docker-quickcreate', payload: { name, ...body } });

    let registry: Map<string, string>;

    beforeEach(() => {
      registry = new Map([['docker-hosts.json', JSON.stringify(profiles)]]);
      mockedReadFile.mockImplementation(async (path) => {
        const file = registry.get(String(path).split('/').at(-1)!);
        if (file !== undefined) return file;
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      mockedWriteFile.mockImplementation(async (path, data) => {
        registry.set(String(path).split('/').at(-1)!, String(data));
      });
    });

    afterEach(() => mockedWriteFile.mockResolvedValue(undefined));

    it('reuses a profile for distinct workspaces without rewriting its settings', async () => {
      const podman = profiles[0];
      const docker = profiles[1];
      const first = await create('podman-one', { hostId: podman.id });
      const second = await create('podman-two', { hostId: podman.id });
      const third = await create('docker-one', { hostId: docker.id });
      expect([first.statusCode, second.statusCode, third.statusCode]).toEqual([200, 200, 200]);
      expect(first.json().data.case).toMatchObject({ hostId: podman.id, name: 'podman-one' });
      expect(second.json().data.case).toMatchObject({ hostId: podman.id, name: 'podman-two' });
      expect(third.json().data.case).toMatchObject({ hostId: docker.id });
      expect(first.json().data.case.hostWorkspacePath).not.toBe(second.json().data.case.hostWorkspacePath);
      expect(checkDockerAvailable).toHaveBeenCalledWith('podman', expect.objectContaining({ id: podman.id }));
      expect(checkDockerAvailable).toHaveBeenCalledWith('docker', expect.objectContaining({ context: docker.context }));
      expect(checkDockerImagePresent).toHaveBeenCalledWith(
        expect.objectContaining({
          engine: 'podman',
          image: podman.image,
          mountCredentials: false,
          containerName: 'codeman-case-podman-one',
        }),
        podman.image
      );
      expect(checkDockerImagePresent).toHaveBeenCalledWith(
        expect.objectContaining({ engine: 'podman', containerName: 'codeman-case-podman-two' }),
        podman.image
      );
      expect(mockedWriteFile.mock.calls.some(([path]) => String(path).endsWith('/docker-hosts.json'))).toBe(false);
    });

    it('refuses unknown and mixed profile requests before creating anything', async () => {
      expect((await create('missing', { hostId: 'absent' })).statusCode).toBe(404);
      expect((await create('mixed', { hostId: profiles[0].id, mountCredentials: true })).statusCode).toBe(400);
      expect(mockedMkdirSync).not.toHaveBeenCalled();
      expect(mockedWriteFile).not.toHaveBeenCalled();
      expect(checkDockerAvailable).not.toHaveBeenCalled();
    });

    it('refuses profiles a non-admin cannot list or use', async () => {
      await harness.app.close();
      harness = await createEnvelopeHarness({ username: 'member', role: 'user' });
      vi.stubEnv('CODEMAN_MULTIUSER', '1');
      try {
        const list = await harness.app.inject('/api/docker-hosts');
        expect(list.json().data).toEqual([]);
        expect((await create('unauthorized', { hostId: profiles[0].id })).statusCode).toBe(403);
        expect(mockedMkdirSync).not.toHaveBeenCalled();
        expect(mockedWriteFile).not.toHaveBeenCalled();
        expect(checkDockerAvailable).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('reports an unavailable profile without creating the case or switching engines', async () => {
      vi.mocked(checkDockerAvailable).mockResolvedValueOnce({
        ok: false,
        engine: 'podman',
        rootless: true,
        isDesktop: false,
        cgroupV2: false,
        capsEnforced: false,
        error: 'Podman stopped',
      });
      const res = await create('offline', { hostId: profiles[0].id });
      expect(res.json()).toMatchObject({ success: false, error: expect.stringContaining('Podman stopped') });
      expect(checkDockerAvailable).toHaveBeenCalledTimes(1);
      expect(mockedMkdirSync).not.toHaveBeenCalled();
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });

    it('keeps both case links when two requests finish preflight together', async () => {
      let resumeProbing!: () => void;
      const bothProbing = new Promise<void>((resolve) => (resumeProbing = resolve));
      await vi.mocked(checkDockerImagePresent).withImplementation(
        async () => {
          await bothProbing;
          return true;
        },
        async () => {
          const requests = [
            create('concurrent-one', { hostId: profiles[0].id }),
            create('concurrent-two', { hostId: profiles[0].id }),
          ];
          try {
            await vi.waitFor(() => expect(checkDockerImagePresent).toHaveBeenCalledTimes(2));
          } finally {
            resumeProbing();
          }
          expect((await Promise.all(requests)).map((res) => res.statusCode)).toEqual([200, 200]);
        }
      );
      const cases = JSON.parse(registry.get('docker-cases.json')!);
      expect(cases).toHaveLength(2);
      expect(cases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'concurrent-one', hostId: profiles[0].id }),
          expect.objectContaining({ name: 'concurrent-two', hostId: profiles[0].id }),
        ])
      );
    });

    it.each(['DELETE', 'PUT'] as const)('declines a saved profile changed by %s during preflight', async (method) => {
      let finishProbe!: (present: boolean) => void;
      vi.mocked(checkDockerImagePresent).mockReturnValueOnce(new Promise((resolve) => (finishProbe = resolve)));
      const profile = profiles[0];
      const latest = create('stale-profile', { hostId: profile.id });
      await vi.waitFor(() => expect(checkDockerImagePresent).toHaveBeenCalledOnce());
      try {
        const changed = await harness.app.inject({
          method,
          url: `/api/docker-hosts/${profile.id}`,
          ...(method === 'PUT' ? { payload: { ...profile, image: 'agent:changed' } } : {}),
        });
        expect(changed.statusCode).toBe(200);
      } finally {
        finishProbe(true);
      }
      expect((await latest).statusCode).toBe(409);
      expect(mockedMkdirSync.mock.calls.some(([path]) => String(path).includes('stale-profile'))).toBe(false);
      expect(registry.has('docker-cases.json')).toBe(false);
    });

    it('keeps a generated profile intact when a later overrides request reuses its original case name', async () => {
      const original = await create('original', { memory: '2g' });
      const hostId = original.json().data.case.hostId;
      expect((await create('reused', { hostId })).statusCode).toBe(200);
      registry.set(
        'docker-cases.json',
        JSON.stringify(
          JSON.parse(registry.get('docker-cases.json')!).filter((entry: { name: string }) => entry.name !== 'original')
        )
      );

      const recreated = await create('original', { memory: '8g' });
      expect(recreated.statusCode).toBe(200);
      expect(recreated.json().data.case.hostId).not.toBe(hostId);
      expect(JSON.parse(registry.get('docker-hosts.json')!)).toContainEqual(
        expect.objectContaining({ id: hostId, resources: { memory: '2g' } })
      );
    });

    it('keeps an imported profile intact if a quick-created case uses it', async () => {
      const profile = { ...profiles[0], id: 'imported-original' };
      registry.set('docker-hosts.json', JSON.stringify([profile]));
      expect((await create('reused', { hostId: profile.id })).statusCode).toBe(200);
      registry.set(
        'case.tgz',
        JSON.stringify({
          schemaVersion: DOCKER_EXPORT_SCHEMA,
          mode: 'workspace',
          engine: 'docker',
          caseName: 'original',
          image: 'agent:new',
          containerWorkdir: '/workspace',
          network: 'bridge',
          checksums: {},
        })
      );
      mockedExistsSync.mockImplementation((path) => String(path).endsWith('/case.tgz'));
      const response = await harness.app.inject({
        method: 'POST',
        url: '/api/docker-cases/import',
        payload: { bundle: 'case.tgz', newCaseName: 'original', destWorkspacePath: '/tmp/import-workspace' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json().data.case.hostId).not.toBe(profile.id);
      expect(JSON.parse(registry.get('docker-hosts.json')!)).toContainEqual(profile);
    });

    it('keeps the legacy shared default and per-case overrides', async () => {
      const shared = await create('builtin');
      const custom = await create('custom', { memory: '2g' });
      expect(shared.json().data.case.hostId).toBe('default');
      expect(custom.json().data.case.hostId).toBe('q-custom');
      expect(checkDockerImagePresent).toHaveBeenCalledWith(
        expect.objectContaining({ resources: { memory: '2g' } }),
        expect.any(String)
      );
    });
  });

  // ========== POST /api/cases ==========

  describe('POST /api/cases', () => {
    it('rejects invalid case name', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases',
        payload: { name: 'invalid case name!!' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects missing name', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects path traversal in name', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases',
        payload: { name: '../etc' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects duplicate case name', async () => {
      mockedExistsSync.mockReturnValue(true);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases',
        payload: { name: 'existing-case' },
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('already exists');
    });

    it('creates case directory with CLAUDE.md and hooks config', async () => {
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases',
        payload: { name: 'new-case', description: 'A new test case' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.case.name).toBe('new-case');
      expect(body.data.case.path).toContain('new-case');

      // Verify directory creation
      expect(mockedMkdirSync).toHaveBeenCalled();

      // Verify broadcast
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('case:created', expect.objectContaining({ name: 'new-case' }));
    });
  });

  // ========== POST /api/cases/link ==========

  describe('POST /api/cases/link', () => {
    it('rejects invalid request body', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/link',
        payload: { name: 'bad name!' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects missing fields', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/link',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('says which field is wrong instead of a generic message', async () => {
      const badName = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/link',
        payload: { name: 'bad name!', path: '/home/user/project' },
      });
      expect(badName.statusCode).toBe(400);
      expect(JSON.parse(badName.body).error).toBe('Invalid case name format');

      // A leading `~` is expanded later in the route but fails the absolute-path rule first.
      const badPath = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/link',
        payload: { name: 'my-project', path: '~/project' },
      });
      expect(badPath.statusCode).toBe(400);
      expect(JSON.parse(badPath.body).error).toMatch(/^Invalid path:/);
    });

    it('returns not found when folder does not exist', async () => {
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/link',
        payload: { name: 'my-project', path: '/nonexistent/path' },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });

    it('rejects when case name already exists in CASES_DIR', async () => {
      // First call (expandedPath check) returns true, second (casePath check) also returns true
      mockedExistsSync.mockReturnValue(true);

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/link',
        payload: { name: 'existing-case', path: '/home/user/project' },
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('already exists');
    });

    it('links folder successfully', async () => {
      // expandedPath exists (first call), casePath does not (second call)
      let callIdx = 0;
      mockedExistsSync.mockImplementation(() => {
        callIdx++;
        return callIdx === 1; // first: folder exists, second: case dir doesn't
      });
      // linked-cases.json doesn't exist yet
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockedStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/cases/link',
        payload: { name: 'linked-project', path: '/home/user/project' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.case.name).toBe('linked-project');
      expect(harness.ctx.broadcast).toHaveBeenCalledWith(
        'case:linked',
        expect.objectContaining({ name: 'linked-project' })
      );
    });
  });

  // ========== GET /api/cases/:name ==========

  describe('GET /api/cases/:name', () => {
    it('returns linked case info', async () => {
      mockedReadFile.mockResolvedValue(JSON.stringify({ 'my-case': '/home/user/my-case' }) as never);
      mockedExistsSync.mockReturnValue(true);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/my-case',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.name).toBe('my-case');
      expect(body.data.linked).toBe(true);
    });

    it('returns CASES_DIR case when no linked case found', async () => {
      // linked-cases.json read fails
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      // case dir exists
      mockedExistsSync.mockReturnValue(true);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/regular-case',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.name).toBe('regular-case');
    });

    it('answers a linked case on an unreachable mount with its registered path, not NOT_FOUND', async () => {
      // The timeout path: the mount does not answer at all.
      const stalledPath = '/mnt/unreachable/linked-get';
      mockedReadFile.mockResolvedValue(JSON.stringify({ 'linked-get': stalledPath }) as never);
      let release: (() => void) | undefined;
      mockedStat.mockImplementation((p) => {
        if (String(p) !== stalledPath) {
          return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
        }
        return new Promise((resolve) => {
          release = () => resolve({ isDirectory: () => true } as never);
        });
      });

      const res = await harness.app.inject({ method: 'GET', url: '/api/cases/linked-get' });
      release?.();
      await new Promise((r) => setTimeout(r, 0)); // let the released stat clear its stall

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toMatchObject({ name: 'linked-get', path: stalledPath, linked: true, unreachable: true });
    });

    it('still answers a healthy case while unrelated mounts are stalled past the cap', async () => {
      const dead = Array.from({ length: MAX_STALLED_PATH_PROBES }, (_, i) => `/mnt/dead-${i}/linked`);
      const releases: Array<() => void> = [];
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockedStat.mockImplementation((p) => {
        if (dead.includes(String(p))) {
          return new Promise((resolve) => releases.push(() => resolve({ isDirectory: () => true } as never)));
        }
        return Promise.resolve({ isDirectory: () => true } as never);
      });
      expect(await Promise.all(dead.map((p) => probePath(p)))).toEqual(dead.map(() => 'unknown'));

      const res = await harness.app.inject({ method: 'GET', url: '/api/cases/healthy-local' });
      releases.forEach((release) => release());
      await new Promise((r) => setTimeout(r, 0));

      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data).toMatchObject({ name: 'healthy-local' });
      expect(JSON.parse(res.body).data.unreachable).toBeUndefined();
      // Its CLAUDE.md is probed the same way as its folder, so it is not misreported missing.
      expect(JSON.parse(res.body).data.hasClaudeMd).toBe(true);
    });

    it('answers a local case it cannot read with a non-NOT_FOUND error', async () => {
      // A soft mount that gave up (EIO) is not proof the case is gone, and the Run
      // button creates a case on NOT_FOUND.
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockedStat.mockRejectedValue(Object.assign(new Error('EIO'), { code: 'EIO' }));

      const res = await harness.app.inject({ method: 'GET', url: '/api/cases/eio-case' });
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('OPERATION_FAILED');
      expect(res.statusCode).not.toBe(404);
    });

    it('returns error when case not found anywhere', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/nonexistent',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });
  });

  // ========== GET /api/cases/:name/fix-plan ==========

  describe('GET /api/cases/:name/fix-plan', () => {
    it('returns exists=false when no fix plan file', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/my-case/fix-plan',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.exists).toBe(false);
      expect(body.data.content).toBeNull();
      expect(body.data.todos).toEqual([]);
    });

    it('reports an unreadable fix plan as an error, not as "no plan"', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockedStat.mockRejectedValue(Object.assign(new Error('EIO'), { code: 'EIO' }));

      const res = await harness.app.inject({ method: 'GET', url: '/api/cases/my-case/fix-plan' });
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('OPERATION_FAILED');
    });

    it('parses fix plan with todos and stats', async () => {
      const fixPlanContent = [
        '# Fix Plan',
        '## High Priority',
        '- [ ] Fix critical bug',
        '- [-] Working on auth',
        '- [x] Setup database',
        '## Standard',
        '- [ ] Add logging',
        '## Completed',
        '- [x] Initial setup',
      ].join('\n');

      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      mockedExistsSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('fix_plan')) return true;
        return false;
      });

      // Override readFile for the fix plan read
      mockedReadFile.mockImplementation(async (p: string) => {
        if (typeof p === 'string' && p.includes('fix_plan')) {
          return fixPlanContent as never;
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/my-case/fix-plan',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.exists).toBe(true);
      expect(body.data.todos.length).toBeGreaterThan(0);
      expect(body.data.stats.total).toBeGreaterThan(0);
    });
  });

  // ========== GET /api/cases/:caseName/ralph-wizard/files ==========

  describe('GET /api/cases/:caseName/ralph-wizard/files', () => {
    it('returns error when wizard directory not found', async () => {
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/my-case/ralph-wizard/files',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });

    it('rejects path traversal in case name', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/..%2F..%2Fetc/ralph-wizard/files',
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns wizard files when directory exists', async () => {
      mockedExistsSync.mockImplementation((p: string) => {
        if (typeof p === 'string' && p.includes('ralph-wizard')) return true;
        if (typeof p === 'string' && p.includes('prompt.md')) return true;
        if (typeof p === 'string' && p.includes('result.json')) return true;
        return false;
      });
      mockedReaddirSync.mockReturnValue([
        { name: 'research', isDirectory: () => true },
        { name: 'planner', isDirectory: () => true },
      ] as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/my-case/ralph-wizard/files',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.files).toHaveLength(2);
      expect(body.data.files[0].agentType).toBe('research');
    });
  });

  // ========== GET /api/cases/:caseName/ralph-wizard/file/:filePath ==========

  describe('GET /api/cases/:caseName/ralph-wizard/file/:filePath', () => {
    it('returns error for missing file', async () => {
      mockedExistsSync.mockReturnValue(false);
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/my-case/ralph-wizard/file/research%2Fprompt.md',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns markdown file content', async () => {
      mockedExistsSync.mockReturnValue(false);
      mockedReadFile.mockResolvedValue('# Research Prompt\nContent here' as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/my-case/ralph-wizard/file/research%2Fprompt.md',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.content).toContain('Research Prompt');
      expect(body.data.isJson).toBe(false);
    });

    it('parses JSON file content', async () => {
      mockedExistsSync.mockReturnValue(false);
      const jsonContent = JSON.stringify({ plan: 'test plan', steps: [1, 2, 3] });
      mockedReadFile.mockResolvedValue(jsonContent as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/my-case/ralph-wizard/file/planner%2Fresult.json',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.isJson).toBe(true);
      expect(body.data.parsed.plan).toBe('test plan');
    });

    it('sets no-cache headers', async () => {
      mockedExistsSync.mockReturnValue(false);
      mockedReadFile.mockResolvedValue('content' as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/cases/my-case/ralph-wizard/file/research%2Fprompt.md',
      });
      expect(res.headers['cache-control']).toContain('no-store');
    });
  });
});
