/**
 * @fileoverview Route tests for paste-image in a remote (SSH) case.
 *
 * A remote case's `workingDir` is an absolute path on ANOTHER host, so the
 * local-`fs` save path in POST /api/sessions/:id/paste-image dies as a 500
 * ENOENT there. These tests pin the remote branch: bytes go over ssh, the
 * remote `.claude-images` dir is verified (no symlink escape), and ssh
 * failures surface as 502s — never a 500 with a local path in it.
 *
 * The ssh layer (`src/remote-files.ts`) is mocked — a test never opens a
 * connection — but the REAL module is kept alongside the mocks so
 * `RemoteFileAccessError` stays authentic.
 *
 * Port: N/A (app.inject doesn't open ports)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { RemoteWakeRegistry } from '../../src/remote-wake.js';

// Keep the pure builders + the error class real; replace only the IO.
vi.mock('../../src/remote-files.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/remote-files.js')>();
  return {
    ...actual,
    remoteProbePaths: vi.fn(),
    remoteEnsureDir: vi.fn(),
    remoteWriteFile: vi.fn(),
  };
});

import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { RemoteFileAccessError, remoteProbePaths, remoteEnsureDir, remoteWriteFile } from '../../src/remote-files.js';
import type { RemoteProbe } from '../../src/remote-files.js';
import type { SessionRemote } from '../../src/types/session.js';

const mockedProbePaths = vi.mocked(remoteProbePaths);
const mockedEnsureDir = vi.mocked(remoteEnsureDir);
const mockedWriteFile = vi.mocked(remoteWriteFile);

const REMOTE_DIR = '/srv/remote/case';
const REMOTE_IMG_DIR = '/srv/remote/case/.claude-images';
const remote: SessionRemote = {
  hostId: 'host-1',
  label: 'testhost',
  host: '192.0.2.10',
  username: 'j',
  remotePath: REMOTE_DIR,
};

function dirProbe(realPath: string): RemoteProbe {
  return { realPath, kind: 'directory', size: 0, mtimeMs: 0 };
}

// A real 1x1 PNG so the server's magic-byte check passes.
const ONE_PX_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function imageUploadBody(boundary: string, filename: string, mimetype: string, imageBytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="image"; filename="${filename}"\r\n` +
        `Content-Type: ${mimetype}\r\n\r\n`
    ),
    imageBytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}

interface LocalHarness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

async function createEnvelopeHarness(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerFn: (app: FastifyInstance, ctx: any) => void
): Promise<LocalHarness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 4, parts: 5 },
  });

  const ctx = createMockRouteContext();
  registerFn(app, ctx);

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

  installRouteErrorHandler(app);
  await app.ready();

  return { app, ctx };
}

function postPng(harness: LocalHarness, filename = 'shot.png') {
  const boundary = 'codeman-test-boundary';
  return harness.app.inject({
    method: 'POST',
    url: `/api/sessions/${harness.ctx._sessionId}/paste-image`,
    headers: {
      host: 'codeman.test',
      origin: 'http://codeman.test',
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: imageUploadBody(boundary, filename, 'image/png', ONE_PX_PNG),
  });
}

describe('paste-image in a remote (SSH) case', () => {
  let harness: LocalHarness;

  beforeEach(async () => {
    const wakeRegistry = new RemoteWakeRegistry({
      probe: async () => true,
      wake: async () => true,
      waitUntilReady: async () => true,
      delay: async () => {},
      log: () => {},
    });
    harness = await createEnvelopeHarness((app, ctx) => registerSessionRoutes(app, ctx, { remoteWake: wakeRegistry }));
    harness.ctx._session.workingDir = REMOTE_DIR;
    harness.ctx._session.remote = { ...remote };

    mockedProbePaths.mockReset();
    mockedEnsureDir.mockReset();
    mockedWriteFile.mockReset();
    // Healthy remote: working dir + image dir both resolve as real directories.
    mockedProbePaths.mockImplementation(async (_remote, paths) =>
      paths.map((p) => (p === REMOTE_DIR || p === REMOTE_IMG_DIR ? dirProbe(p) : null))
    );
    mockedEnsureDir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('writes the bytes over ssh and returns the remote path', async () => {
    const res = await postPng(harness);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.path).toMatch(/^\/srv\/remote\/case\/\.claude-images\/paste-\d+-[a-f0-9]{8}\.png$/);
    expect(mockedEnsureDir).toHaveBeenCalledWith(remote, REMOTE_IMG_DIR);
    expect(mockedWriteFile).toHaveBeenCalledTimes(1);
    const [writeRemote, writePath, writeBytes] = mockedWriteFile.mock.calls[0];
    expect(writeRemote).toEqual(remote);
    expect(writePath.startsWith(REMOTE_IMG_DIR + '/paste-')).toBe(true);
    expect(Buffer.compare(writeBytes as Buffer, ONE_PX_PNG)).toBe(0);
  });

  it('never touches the local filesystem for a remote session', async () => {
    const { existsSync } = await import('node:fs');
    const res = await postPng(harness);

    expect(res.statusCode).toBe(200);
    // The remote path must not exist locally (it lives on another host).
    expect(existsSync(JSON.parse(res.body).data.path)).toBe(false);
  });

  it('maps an unreachable host to a 502, not a 500 with a local path', async () => {
    mockedWriteFile.mockRejectedValueOnce(new RemoteFileAccessError('remote host testhost unreachable: timeout'));

    const res = await postPng(harness);

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).not.toMatch(/ENOENT|no such file/);
  });

  it('refuses a symlinked remote .claude-images dir with a 403', async () => {
    mockedProbePaths.mockImplementation(async (_remote, paths) =>
      paths.map((p) => {
        if (p === REMOTE_DIR) return dirProbe(REMOTE_DIR);
        // .claude-images resolves elsewhere: a planted symlink.
        if (p === REMOTE_IMG_DIR) return dirProbe('/tmp/evil');
        return null;
      })
    );

    const res = await postPng(harness);

    expect(res.statusCode).toBe(403);
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });
});
