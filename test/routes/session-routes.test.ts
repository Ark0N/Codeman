/**
 * @fileoverview Tests for session route handlers.
 *
 * Uses app.inject() (Fastify's built-in test helper) — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 *
 * These tests assert the UNIFORM response envelope (stable HTTP contract):
 *   success -> 2xx, { success: true, data: <payload> }
 *   error   -> 4xx/5xx, { success: false, error, errorCode }
 * The production server applies this via a preSerialization hook (server.ts).
 * The shared route harness doesn't install it, so we build a local harness here
 * that mirrors production: the same preSerialization envelope hook + the shared
 * route error handler, so assertions match the real wire format.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { join } from 'node:path';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { Session } from '../../src/session.js';

// Mock execFile so the send-key route's `tmux` invocation is observable (not run for real).
const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
// The real converter spawns a worker thread (TS worker file — not loadable
// under vitest); the conversion pipeline itself is covered by
// test/heic-jpeg-core.test.ts against the real heic-decode WASM.
const heicConvert = vi.hoisted(() => vi.fn(async () => Buffer.from('ffd8ffe000104a4649460001', 'hex')));
vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>();
  return { ...actual, execFile };
});
vi.mock('../../src/web/heic-jpeg-converter.js', () => ({ convertHeicToJpeg: heicConvert }));

// In-memory remote store so remote-case tests can inject hosts/cases without real JSON files.
const remoteStore = vi.hoisted(() => ({
  hosts: [] as unknown[],
  cases: [] as unknown[],
  tmuxCheck: { ok: true, tmuxPath: '/usr/bin/tmux' } as { ok: boolean; tmuxPath?: string; error?: string },
}));
vi.mock('../../src/remote-hosts.js', async (orig) => {
  const actual = await orig<typeof import('../../src/remote-hosts.js')>();
  return {
    ...actual,
    readRemoteHosts: vi.fn(async () => remoteStore.hosts),
    readRemoteCases: vi.fn(async () => remoteStore.cases),
    // Stub the remote-tmux prereq probe so quick-start never shells out to ssh.
    checkRemoteTmuxAvailable: vi.fn(async () => remoteStore.tmuxCheck),
  };
});

import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { resolveTerminalHistoryConfig } from '../../src/config/terminal-history.js';

interface LocalHarness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

/**
 * Build a Fastify instance that mirrors production's uniform-envelope behavior
 * (server.ts preSerialization hook) so the test wire format matches the contract:
 * bare payloads become { success: true, data }, and { success:false } error
 * envelopes get the conventional HTTP status from their errorCode.
 */
async function createEnvelopeHarness(
  registerFn: (app: FastifyInstance, ctx: MockRouteContext) => void
): Promise<LocalHarness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  await app.register(fastifyMultipart, {
    limits: { fileSize: 10 * 1024 * 1024, files: 1, fields: 4, parts: 5 },
  });

  const ctx = createMockRouteContext();
  registerFn(app, ctx);

  // Mirror production uniform response envelope (server.ts).
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

describe('session-routes', () => {
  let harness: LocalHarness;

  beforeEach(async () => {
    harness = await createEnvelopeHarness(registerSessionRoutes);
    // Reset remote store so tests start with empty hosts/cases and a passing tmux probe
    remoteStore.hosts = [];
    remoteStore.cases = [];
    remoteStore.tmuxCheck = { ok: true, tmuxPath: '/usr/bin/tmux' };
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== POST /api/sessions/:id/send-key ==========

  describe('POST /api/sessions/:id/send-key', () => {
    it('routes tmux send-keys through the dedicated Codeman socket (-L)', async () => {
      // Regression guard: bare `tmux` would hit the user's default server and never
      // find a session that lives only on the Codeman socket (#80 regression class).
      execFile.mockReset();
      execFile.mockImplementation((_bin: string, _argv: string[], _opts: unknown, cb: (e: Error | null) => void) =>
        cb(null)
      );

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/send-key',
        payload: { key: 'S-Enter' },
      });

      expect(res.statusCode).toBe(200);
      expect(execFile).toHaveBeenCalledTimes(1);
      const [bin, argv] = execFile.mock.calls[0];
      expect(bin).toBe('tmux');
      expect((argv as string[]).slice(0, 2)).toEqual(['-L', 'codeman']);
      expect(argv).toContain('send-keys');
      expect(argv).toContain('-H');
    });

    it('rejects keys outside the hex allowlist without invoking tmux', async () => {
      execFile.mockReset();
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/test-session-1/send-key',
        payload: { key: 'rm -rf' },
      });
      expect(JSON.parse(res.body).success).toBe(false);
      expect(execFile).not.toHaveBeenCalled();
    });
  });

  // ========== POST /api/sessions/:id/paste-image ==========

  describe('POST /api/sessions/:id/paste-image', () => {
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

    it('converts HEIC paste images to JPEG attachments when browser-side normalization falls back', async () => {
      const workDir = await mkdtemp(join(tmpdir(), 'codeman-heic-'));
      harness.ctx._session.workingDir = workDir;
      heicConvert.mockClear();

      const boundary = 'codeman-test-boundary';
      const heic = Buffer.from('00000034667479706865696300000000', 'hex');
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/paste-image`,
        headers: {
          host: 'codeman.test',
          origin: 'http://codeman.test',
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: imageUploadBody(boundary, 'IMG_4996.HEIC', 'image/heic', heic),
      });

      await rm(workDir, { recursive: true });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.path).toMatch(/\/\.claude-images\/paste-\d+-[a-f0-9]{8}\.jpg$/);
      expect(heicConvert).toHaveBeenCalledWith(heic);
    });

    it('converts mislabeled HEIC (declared image/jpeg, HEIF bytes — the MIUI/Android case) via magic sniff', async () => {
      const workDir = await mkdtemp(join(tmpdir(), 'codeman-heic-mislabel-'));
      harness.ctx._session.workingDir = workDir;
      heicConvert.mockClear();

      const boundary = 'codeman-test-boundary';
      // ftyp brand mif1 — HEIF bytes hiding under a JPEG filename + MIME.
      const heic = Buffer.from('000000346674797061696631000000006d69663168656963', 'hex');
      heic.write('mif1', 8, 'ascii'); // major brand
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/paste-image`,
        headers: {
          host: 'codeman.test',
          origin: 'http://codeman.test',
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: imageUploadBody(boundary, 'IMG_2001.jpg', 'image/jpeg', heic),
      });

      await rm(workDir, { recursive: true });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.path).toMatch(/\/\.claude-images\/paste-\d+-[a-f0-9]{8}\.jpg$/);
      expect(heicConvert).toHaveBeenCalledWith(heic);
    });

    it('returns 415 with the error envelope when HEIC conversion fails', async () => {
      heicConvert.mockClear();
      heicConvert.mockRejectedValueOnce(new Error('HEIC dimensions 30000x30000 exceed the 64MP decode limit'));

      const boundary = 'codeman-test-boundary';
      const heic = Buffer.from('00000034667479706865696300000000', 'hex');
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/paste-image`,
        headers: {
          host: 'codeman.test',
          origin: 'http://codeman.test',
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: imageUploadBody(boundary, 'IMG_4997.HEIC', 'image/heic', heic),
      });

      expect(res.statusCode).toBe(415);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('INVALID_INPUT');
      expect(body.error).toMatch(/HEIC/);
    });

    it('rejects ftyp brands heic-decode cannot convert (e.g. heim) without invoking the converter', async () => {
      heicConvert.mockClear();

      const boundary = 'codeman-test-boundary';
      const heim = Buffer.from('00000034667479706865696d00000000', 'hex');
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/paste-image`,
        headers: {
          host: 'codeman.test',
          origin: 'http://codeman.test',
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: imageUploadBody(boundary, 'IMG_4998.HEIC', 'image/heic', heim),
      });

      expect(res.statusCode).toBe(415);
      expect(JSON.parse(res.body).success).toBe(false);
      expect(heicConvert).not.toHaveBeenCalled();
    });
  });

  // ========== GET /api/sessions ==========

  describe('GET /api/sessions', () => {
    it('returns session list when sessions exist', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/sessions' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body.data).toHaveLength(1);
    });

    it('returns empty array when no sessions', async () => {
      harness.ctx.sessions.clear();
      const res = await harness.app.inject({ method: 'GET', url: '/api/sessions' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).data).toEqual([]);
    });
  });

  // ========== GET /api/sessions/:id ==========

  describe('GET /api/sessions/:id', () => {
    it('returns session state for existing session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.id).toBe(harness.ctx._sessionId);
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toBeDefined();
    });
  });

  // ========== DELETE /api/sessions/:id ==========

  describe('DELETE /api/sessions/:id', () => {
    it('deletes existing session', async () => {
      const res = await harness.app.inject({
        method: 'DELETE',
        url: `/api/sessions/${harness.ctx._sessionId}`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx.cleanupSession).toHaveBeenCalledWith(harness.ctx._sessionId, true, 'user_delete');
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/sessions/nonexistent',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('removes a persisted-only session (not live) via the state store, without touching cleanupSession', async () => {
      vi.mocked(harness.ctx.store.getSession).mockReturnValueOnce({
        id: 'ghost-session',
        owner: undefined,
      } as never);
      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/sessions/ghost-session',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx.store.demoteOrRemoveSession).toHaveBeenCalledWith('ghost-session');
      expect(harness.ctx.cleanupSession).not.toHaveBeenCalled();
      // Ark0N/Codeman#353 review: the persisted-only branch used to demote/remove
      // with no broadcast, so other open tabs kept showing the retired row until
      // their next unrelated fetch.
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:deleted', { id: 'ghost-session' });
    });

    it('404s a persisted-only session id the state store does not recognize either', async () => {
      vi.mocked(harness.ctx.store.getSession).mockReturnValueOnce(null);
      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/sessions/truly-nonexistent',
      });
      expect(res.statusCode).toBe(404);
      expect(harness.ctx.store.demoteOrRemoveSession).not.toHaveBeenCalled();
    });
  });

  // ========== DELETE /api/sessions (delete all) ==========

  describe('DELETE /api/sessions', () => {
    it('deletes all sessions', async () => {
      const res = await harness.app.inject({
        method: 'DELETE',
        url: '/api/sessions',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.killed).toBe(1);
      expect(harness.ctx.cleanupSession).toHaveBeenCalled();
    });
  });

  // ========== PUT /api/sessions/:id/name ==========

  describe('PUT /api/sessions/:id/name', () => {
    it('renames session', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/name`,
        payload: { name: 'new-name' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.name).toBe('new-name');
      expect(harness.ctx.persistSessionState).toHaveBeenCalled();
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:updated', expect.anything());
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/sessions/nonexistent/name',
        payload: { name: 'test' },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== PUT /api/sessions/:id/color ==========

  describe('PUT /api/sessions/:id/color', () => {
    it('sets session color', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/color`,
        payload: { color: 'blue' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.color).toBe('blue');
    });

    it('rejects invalid color', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: `/api/sessions/${harness.ctx._sessionId}/color`,
        payload: { color: 'neon-rainbow' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== POST /api/sessions/:id/auto-resume ==========

  describe('POST /api/sessions/:id/auto-resume', () => {
    it('enables auto-resume on usage limit', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/auto-resume`,
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.autoResume.enabled).toBe(true);
      const session = harness.ctx.sessions.get(harness.ctx._sessionId)!;
      expect(session.setAutoResume).toHaveBeenCalledWith(true);
      expect(harness.ctx.persistSessionState).toHaveBeenCalled();
      expect(harness.ctx.broadcast).toHaveBeenCalledWith('session:updated', expect.anything());
    });

    it('disables auto-resume', async () => {
      const session = harness.ctx.sessions.get(harness.ctx._sessionId)!;
      session.autoResumeEnabled = true;
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/auto-resume`,
        payload: { enabled: false },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.autoResume.enabled).toBe(false);
      expect(session.setAutoResume).toHaveBeenCalledWith(false);
    });

    it('rejects invalid body', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/auto-resume`,
        payload: { enabled: 'yes' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe(ApiErrorCode.INVALID_INPUT);
    });

    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/auto-resume',
        payload: { enabled: true },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== POST /api/sessions/:id/input ==========

  describe('POST /api/sessions/:id/input', () => {
    it('sends input to session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/input`,
        payload: { input: 'hello' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/input',
        payload: { input: 'hello' },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects empty payload', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/input`,
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('applies a tagged (clientId, seq) input exactly once on redelivery', async () => {
      const url = `/api/sessions/${harness.ctx._sessionId}/input`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session = harness.ctx.sessions.get(harness.ctx._sessionId) as any;
      session.writeBuffer.length = 0;

      const post = (payload: unknown) => harness.app.inject({ method: 'POST', url, payload });

      // First delivery of seq 1 — applied (200, written once).
      const first = await post({ input: 'prompt', seq: 1, clientId: 'cid-1' });
      expect(first.statusCode).toBe(200);

      // Redelivery of the SAME seq (client never saw the ACK) — still 200, but
      // must NOT write again.
      const dup = await post({ input: 'prompt', seq: 1, clientId: 'cid-1' });
      expect(dup.statusCode).toBe(200);

      // A genuinely new seq — applied.
      const next = await post({ input: '\r', seq: 2, clientId: 'cid-1' });
      expect(next.statusCode).toBe(200);

      expect(session.writeBuffer).toEqual(['prompt', '\r']);
    });

    it('always applies untagged input (curl/legacy, no dedup)', async () => {
      const url = `/api/sessions/${harness.ctx._sessionId}/input`;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const session = harness.ctx.sessions.get(harness.ctx._sessionId) as any;
      session.writeBuffer.length = 0;

      const post = () => harness.app.inject({ method: 'POST', url, payload: { input: 'x' } });
      await post();
      await post();
      // No seq/clientId ⇒ no dedup ⇒ both writes land.
      expect(session.writeBuffer).toEqual(['x', 'x']);
    });
  });

  // ========== POST /api/sessions/:id/resize ==========

  describe('POST /api/sessions/:id/resize', () => {
    it('resizes session terminal', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 120, rows: 40 },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx._session.resize).toHaveBeenCalledWith(120, 40, { viewportType: undefined, force: undefined });
    });

    it('passes viewport type through for resize arbitration', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 48, rows: 28, viewportType: 'mobile' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx._session.resize).toHaveBeenCalledWith(48, 28, { viewportType: 'mobile', force: undefined });
    });

    it('passes force resize through for redraw requests', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 120, rows: 40, force: true },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx._session.resize).toHaveBeenCalledWith(120, 40, { viewportType: undefined, force: true });
    });

    it('rejects cols exceeding max (500)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 501, rows: 24 },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects rows exceeding max (200)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 80, rows: 201 },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('rejects zero dimensions', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/resize`,
        payload: { cols: 0, rows: 24 },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== GET /api/sessions/:id/terminal ==========

  describe('GET /api/sessions/:id/terminal', () => {
    it('returns terminal buffer', async () => {
      harness.ctx._session.terminalBuffer = 'hello world';
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toBeDefined();
    });

    // ── #258: a single `truncated` boolean could not distinguish "we tailed for
    // speed, the rest is still there" from "the oldest bytes are gone". The UI
    // needs that difference to know whether offering "Load full history" is a
    // promise it can keep.
    describe('truncation reason (#258)', () => {
      const lines = (n: number) => Array.from({ length: n }, (_, i) => `history line ${i}`).join('\n');

      beforeEach(() => {
        (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(() => null);
        harness.ctx._session.mode = 'shell';
      });

      it('reports no reason when nothing was cut', async () => {
        harness.ctx._session.terminalBuffer = 'short buffer';
        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
        });
        const body = JSON.parse(res.body);
        expect(body.data.truncated).toBe(false);
        expect(body.data.truncationReason).toBeNull();
        expect(body.data.retainedBytes).toBe(body.data.terminalBuffer.length);
      });

      it("reports 'tail' for an intentional partial replay", async () => {
        harness.ctx._session.terminalBuffer = lines(4000);
        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal?tail=500`,
        });
        const body = JSON.parse(res.body);
        expect(body.data.truncated).toBe(true);
        expect(body.data.truncationReason).toBe('tail');
        // fullSize describes what existed, retainedBytes what was sent.
        expect(body.data.retainedBytes).toBeLessThan(body.data.fullSize);
      });

      it("reports 'capped' when the byte ceiling dropped the oldest output", async () => {
        harness.ctx.getTerminalHistoryConfig = vi.fn(async () => ({
          ...resolveTerminalHistoryConfig({}),
          terminalBufferMaxBytes: 2000,
        }));
        harness.ctx._session.terminalBuffer = lines(4000);

        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
        });
        const body = JSON.parse(res.body);
        expect(body.data.truncated).toBe(true);
        expect(body.data.truncationReason).toBe('capped');
      });

      it("keeps 'capped' when a tail cut lands on top of it", async () => {
        // Both sites fire. 'capped' is the stronger statement (bytes are gone),
        // so a subsequent tail must not downgrade it to the recoverable reason.
        harness.ctx.getTerminalHistoryConfig = vi.fn(async () => ({
          ...resolveTerminalHistoryConfig({}),
          terminalBufferMaxBytes: 2000,
        }));
        harness.ctx._session.terminalBuffer = lines(4000);

        const res = await harness.app.inject({
          method: 'GET',
          url: `/api/sessions/${harness.ctx._sessionId}/terminal?tail=500`,
        });
        const body = JSON.parse(res.body);
        expect(body.data.truncationReason).toBe('capped');
      });
    });

    it('does not strip VPA-like shell scrollback as Ink redraw bloat', async () => {
      const shellHistory = Array.from(
        { length: 3000 },
        (_, index) => `SHELL_SCROLLBACK_${String(index + 1).padStart(6, '0')} payload payload payload \x1b[1d`
      ).join('\n');
      harness.ctx._session.terminalBuffer = shellHistory;
      harness.ctx._session.mode = 'shell';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(() => null);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('SHELL_SCROLLBACK_000001');
      expect(body.data.terminalBuffer).toContain('SHELL_SCROLLBACK_003000');
    });

    it('preserves accumulated history before the live mux pane snapshot for Codex TUI replay', async () => {
      harness.ctx._session.terminalBuffer = 'hello world\nlater accumulated history';
      harness.ctx._session.mode = 'codex';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () => 'visible tmux pane only\n› current prompt'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('hello world');
      expect(body.data.terminalBuffer).toContain('later accumulated history');
      expect(body.data.terminalBuffer).toContain('\x1b[H\x1b[2Jvisible tmux pane only');
      expect(body.data.terminalBuffer.indexOf('hello world')).toBeLessThan(
        body.data.terminalBuffer.indexOf('visible tmux pane only')
      );
      // No ?full=1 → visible-frame capture (no fullHistory opts).
      expect(harness.ctx.mux.captureActivePaneBuffer).toHaveBeenCalledWith(harness.ctx._session.muxName, undefined);
    });

    // ── COD-47: full tmux scrollback replay on full page reload ──
    it('full reload (?full=1) requests full tmux history and replays boundary markers', async () => {
      // A realistic scrollback-length capture: ~5000 lines, well past one screen.
      const firstLine = 'SCROLLBACK_FIRST_LINE_0001';
      const lastLine = 'SCROLLBACK_LAST_LINE_5000';
      const lines: string[] = [firstLine];
      for (let i = 2; i <= 4999; i++) {
        lines.push(`scrollback line ${String(i).padStart(4, '0')} lorem ipsum payload`);
      }
      lines.push(lastLine);
      const fullHistoryCapture = lines.join('\n');

      harness.ctx._session.mode = 'shell';
      harness.ctx._session.terminalBuffer = '';
      const captureSpy = vi.fn((_name: string, opts?: { fullHistory?: boolean }) =>
        opts?.fullHistory ? fullHistoryCapture : 'only the visible frame'
      );
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = captureSpy;

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?full=1`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Full reload asked tmux for the entire scrollback, with the configured
      // capture bounds (history-line limit + byte cap for exec maxBuffer).
      expect(captureSpy).toHaveBeenCalledWith(
        harness.ctx._session.muxName,
        expect.objectContaining({
          fullHistory: true,
          historyLimitLines: expect.any(Number),
          maxCaptureBytes: expect.any(Number),
        })
      );
      // Both boundary markers survived the capture → route pipeline.
      expect(body.data.terminalBuffer).toContain(firstLine);
      expect(body.data.terminalBuffer).toContain(lastLine);
      expect(body.data.source).toBe('mux-full-history');
      expect(typeof body.data.fullSize).toBe('number');
      expect(res.headers['server-timing']).toMatch(/^capture;dur=\d+\.\d, prepare;dur=\d+\.\d, total;dur=\d+\.\d$/);
    });

    it('full reload (?full=1) returns the tmux capture ALONE — byte history is not duplicated', async () => {
      // The full-history capture is the rendered form of everything already in
      // the byte buffer; prepending the byte history would replay the whole
      // conversation twice (\x1b[2J clears the viewport, not xterm scrollback).
      harness.ctx._session.mode = 'claude';
      harness.ctx._session.terminalBuffer = 'BYTE_BUFFER_COPY of the conversation';
      const rendered = 'BYTE_BUFFER_COPY of the conversation\r\nplus older scrollback\r\n› prompt';
      const captureSpy = vi.fn((_name: string, opts?: { fullHistory?: boolean }) =>
        opts?.fullHistory ? rendered : 'visible frame only'
      );
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = captureSpy;

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?full=1`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.source).toBe('mux-full-history');
      expect(body.data.terminalBuffer).toContain('plus older scrollback');
      // Capture alone: no history+clear-viewport concat, and the byte-buffer
      // content appears exactly once (from the capture, not a duplicate prepend).
      expect(body.data.terminalBuffer).not.toContain('\x1b[H\x1b[2J');
      expect(body.data.terminalBuffer.indexOf('BYTE_BUFFER_COPY')).toBe(
        body.data.terminalBuffer.lastIndexOf('BYTE_BUFFER_COPY')
      );
    });

    it('full reload (?full=1) keeps every leading row so the restored cursor lands on the right line', async () => {
      // The capture ends with an absolute cursor move, so its rows and the pane's
      // rows must line up one for one. Three transforms used to run over it and
      // each could delete a leading line: redraw-bloat stripping, the trim that
      // cuts everything above the Claude banner, and a leading-whitespace strip.
      // Any one of them shifted the frame up and left the caret a row off.
      harness.ctx._session.mode = 'claude';
      harness.ctx._session.terminalBuffer = '';
      // A blank first row, then the banner — the shape a real pane has.
      const rendered = ['', '\x1b[1mClaude Code v2.1.266', 'conversation', '\u276f ', '\x1b[4;3H'].join('\r\n');
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        (_name: string, opts?: { fullHistory?: boolean }) => (opts?.fullHistory ? rendered : 'visible frame')
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?full=1`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.source).toBe('mux-full-history');
      // The blank first row survives, so row N of the reply is row N of the pane.
      expect(body.data.terminalBuffer.startsWith('\r\n')).toBe(true);
      expect(body.data.terminalBuffer.split('\r\n')).toHaveLength(rendered.split('\r\n').length);
    });

    it('full reload (?full=1) still strips the byte history when no capture came back', async () => {
      // The row-preserving skips exist for a rendered pane. When the capture is
      // unavailable the reply IS the byte stream — successive Ink frames, no row
      // alignment to protect — so keying the skips on the query parameter rather
      // than on the capture returned it unstripped, which is the whole reason
      // stripInkRedrawBloat exists. A session with no mux takes this path on
      // every first selection, not just during an outage.
      harness.ctx._session.mode = 'claude';
      // A VPA cluster the stripper will collapse: >= 10 sequences, spanning the
      // 32KB minimum, with real content after it.
      const frame = '\x1b[12d' + 'spinner frame '.repeat(240);
      harness.ctx._session.terminalBuffer = frame.repeat(20) + 'REAL CONTENT AFTER THE BLOAT';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(() => null);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?full=1`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.source).toBe('history');
      expect(body.data.terminalBuffer).toContain('REAL CONTENT AFTER THE BLOAT');
      // Stripped, not passed through whole.
      expect(body.data.terminalBuffer.length).toBeLessThan(harness.ctx._session.terminalBuffer.length);
    });

    it('full reload (?full=1) keeps the byte history when the capture is empty', async () => {
      // Pins the contract the capture side relies on: an empty capture means
      // "nothing to replay" and the byte history survives. capturePaneBuffer
      // returns '' for an all-blank pane precisely to reach this branch, since
      // retaining trailing blank rows and appending a cursor move would
      // otherwise make a blank screen non-empty and replace the history with it.
      // (The blank-pane decision itself is unit-tested on hasVisibleContent —
      // capturePaneBuffer short-circuits under IS_TEST_MODE and cannot run here.)
      harness.ctx._session.mode = 'claude';
      harness.ctx._session.terminalBuffer = 'a real conversation worth keeping';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        (_name: string, opts?: { fullHistory?: boolean }) => (opts?.fullHistory ? '' : 'visible frame')
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?full=1`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.source).toBe('history');
      expect(body.data.terminalBuffer).toContain('a real conversation worth keeping');
    });

    it('full reload (?full=1) falls back to the byte history when the capture is unavailable', async () => {
      harness.ctx._session.mode = 'claude';
      harness.ctx._session.terminalBuffer = 'byte history survives';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(() => null);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?full=1`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.source).toBe('history');
      expect(body.data.terminalBuffer).toContain('byte history survives');
    });

    it('full reload forwards the configured history-line limit and byte cap to the capture', async () => {
      harness.ctx.getTerminalHistoryConfig = vi.fn(async () => ({
        terminalScrollbackLines: 60_000,
        tmuxHistoryLimit: 123_456,
        terminalBufferMaxBytes: 5 * 1024 * 1024,
        terminalBufferTrimBytes: 4 * 1024 * 1024,
      }));
      const captureSpy = vi.fn(() => 'full scrollback');
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = captureSpy;

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?full=1`,
      });

      expect(res.statusCode).toBe(200);
      expect(captureSpy).toHaveBeenCalledWith(harness.ctx._session.muxName, {
        fullHistory: true,
        historyLimitLines: 123_456,
        maxCaptureBytes: 5 * 1024 * 1024,
      });
    });

    it('tab switch (with tail) uses the visible frame, not full history', async () => {
      harness.ctx._session.mode = 'codex';
      harness.ctx._session.terminalBuffer = 'accumulated history';
      const captureSpy = vi.fn((_name: string, opts?: { fullHistory?: boolean }) =>
        opts?.fullHistory ? 'FULL_HISTORY_SHOULD_NOT_APPEAR' : 'visible frame only\n› prompt'
      );
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = captureSpy;

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?tail=65536`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Tail/tab-switch must NOT request fullHistory (undefined opts).
      expect(captureSpy).toHaveBeenCalledWith(harness.ctx._session.muxName, undefined);
      expect(body.data.terminalBuffer).toContain('visible frame only');
      expect(body.data.terminalBuffer).not.toContain('FULL_HISTORY_SHOULD_NOT_APPEAR');
      expect(body.data.source).toBe('mux-visible');
    });

    it('caps huge full-history at the configured terminal buffer limit and marks truncated', async () => {
      // Shrink the cap so the test can exceed it without allocating 32MB.
      harness.ctx.getTerminalHistoryConfig = vi.fn(async () => ({
        terminalScrollbackLines: 100_000,
        tmuxHistoryLimit: 100_000,
        terminalBufferMaxBytes: 4096,
        terminalBufferTrimBytes: 4096,
      }));
      harness.ctx._session.mode = 'shell';
      harness.ctx._session.terminalBuffer = '';
      const oldestMarker = 'OLDEST_EVICTED_MARKER';
      const newestMarker = 'NEWEST_KEPT_MARKER';
      const filler = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n');
      const huge = `${oldestMarker}\n${filler}\n${newestMarker}`;
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        (_name: string, opts?: { fullHistory?: boolean }) => (opts?.fullHistory ? huge : 'visible')
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal?full=1`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.truncated).toBe(true);
      expect(body.data.fullSize).toBeGreaterThan(4096);
      expect(body.data.terminalBuffer.length).toBeLessThanOrEqual(4096);
      // Cap keeps the most RECENT bytes: newest marker survives, oldest is dropped.
      expect(body.data.terminalBuffer).toContain(newestMarker);
      expect(body.data.terminalBuffer).not.toContain(oldestMarker);
    });

    it('treats stale Codex scrollback config as TUI replay', async () => {
      harness.ctx._session.terminalBuffer = 'hello world\nlater accumulated history';
      harness.ctx._session.mode = 'codex';
      harness.ctx._session.codexConfig = { renderMode: 'scrollback' } as any;
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () => 'visible tmux pane only\n› current prompt'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('hello world');
      expect(body.data.terminalBuffer).toContain('later accumulated history');
      expect(body.data.terminalBuffer).toContain('\x1b[H\x1b[2Jvisible tmux pane only');
      expect(body.data.terminalBuffer.indexOf('hello world')).toBeLessThan(
        body.data.terminalBuffer.indexOf('visible tmux pane only')
      );
      expect(harness.ctx.mux.captureActivePaneBuffer).toHaveBeenCalledWith(harness.ctx._session.muxName, undefined);
    });

    it('preserves one-time OAuth authorization URLs in Codex TUI replay history', async () => {
      const authUrl =
        'https://auth.atlassian.com/authorize?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A35547%2Fcallback%2Fxyz';
      harness.ctx._session.terminalBuffer =
        'Authorize `atlassian` by opening this URL in your browser:\n' +
        authUrl +
        '\n(Browser launch failed; please copy the URL above manually.)\n';
      harness.ctx._session.mode = 'codex';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () => 'visible tmux pane only\n› current prompt'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain(authUrl);
      expect(body.data.terminalBuffer).toContain('visible tmux pane only');
      expect(body.data.terminalBuffer.indexOf(authUrl)).toBeLessThan(
        body.data.terminalBuffer.indexOf('visible tmux pane only')
      );
    });

    it('preserves incidental OAuth URL mentions as ordinary Codex TUI history', async () => {
      const authUrl =
        'https://auth.atlassian.com/authorize?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A35547%2Fcallback%2Fxyz';
      harness.ctx._session.terminalBuffer =
        'Root cause: URLs like ' +
        authUrl +
        ' could be present in history but missing from browser-rendered terminal replay.\n' +
        "+        'Authorize `atlassian` by opening this URL in your browser:\\n' +\n";
      harness.ctx._session.mode = 'codex';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () => 'visible tmux pane only\n› current prompt'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain(authUrl);
      expect(body.data.terminalBuffer).toContain('visible tmux pane only');
    });

    it('preserves accumulated history before a live mux pane snapshot for non-Codex sessions', async () => {
      harness.ctx._session.terminalBuffer = 'hello world\nlater accumulated history';
      harness.ctx._session.mode = 'claude';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () => 'visible tmux pane only\n› current prompt'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('hello world');
      expect(body.data.terminalBuffer).toContain('later accumulated history');
      expect(body.data.terminalBuffer).toContain('visible tmux pane only');
      expect(body.data.terminalBuffer).toContain('\x1b[H\x1b[2Jvisible tmux pane only');
      expect(body.data.terminalBuffer.indexOf('hello world')).toBeLessThan(
        body.data.terminalBuffer.indexOf('visible tmux pane only')
      );
      expect(harness.ctx.mux.captureActivePaneBuffer).toHaveBeenCalledWith(harness.ctx._session.muxName, undefined);
    });

    it('uses live mux pane capture only when the accumulated buffer is empty', async () => {
      harness.ctx._session.terminalBuffer = '';
      harness.ctx._session.mode = 'codex';
      (harness.ctx.mux as { captureActivePaneBuffer?: unknown }).captureActivePaneBuffer = vi.fn(
        () => 'visible restored tmux pane\n› current prompt'
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data.terminalBuffer).toContain('visible restored tmux pane');
      expect(body.data.terminalBuffer).toContain('› current prompt');
      expect(harness.ctx.mux.captureActivePaneBuffer).toHaveBeenCalledWith(harness.ctx._session.muxName, undefined);
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/terminal',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('prepends the live tmux pane buffer (cleared) before the byte history', async () => {
      harness.ctx._session.terminalBuffer = 'history-bytes';
      harness.ctx.mux.captureActivePaneBuffer = vi.fn(() => 'LIVE-PANE-FRAME');

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });
      expect(res.statusCode).toBe(200);
      const buf = JSON.parse(res.body).data.terminalBuffer as string;
      // history, then a viewport clear, then the live pane frame
      expect(buf).toContain('history-bytes');
      expect(buf).toContain('\x1b[H\x1b[2J');
      expect(buf).toContain('LIVE-PANE-FRAME');
      expect(buf.indexOf('history-bytes')).toBeLessThan(buf.indexOf('LIVE-PANE-FRAME'));
      expect(harness.ctx.mux.captureActivePaneBuffer).toHaveBeenCalledWith(harness.ctx._session.muxName, undefined);
    });

    it('falls back to the byte history when no live pane buffer is available', async () => {
      harness.ctx._session.terminalBuffer = 'history-only';
      // Empty string (the test-mode return) and null both mean "no live frame".
      harness.ctx.mux.captureActivePaneBuffer = vi.fn(() => '');

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/terminal`,
      });
      expect(res.statusCode).toBe(200);
      const buf = JSON.parse(res.body).data.terminalBuffer as string;
      expect(buf).toContain('history-only');
      expect(buf).not.toContain('\x1b[H\x1b[2J');
    });
  });

  // ========== POST /api/sessions/:id/run ==========

  describe('POST /api/sessions/:id/run', () => {
    it('runs prompt on session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/run`,
        payload: { prompt: 'do something' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });

    it('rejects empty prompt', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/run`,
        payload: { prompt: '' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/run',
        payload: { prompt: 'test' },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns error if session is busy', async () => {
      harness.ctx._session.isBusy.mockReturnValue(true);
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/run`,
        payload: { prompt: 'test' },
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== POST /api/sessions/:id/interactive ==========

  describe('POST /api/sessions/:id/interactive', () => {
    it('starts interactive mode', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx._session.startInteractive).toHaveBeenCalled();
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions/nonexistent/interactive',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('returns error if session is busy', async () => {
      harness.ctx._session.isBusy.mockReturnValue(true);
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    // COD-118: this endpoint is ALSO the frontend's automatic re-attach path, so it
    // must never clear a tripped PTY-exit breaker unless the request explicitly asks.
    it('does NOT clear the PTY-exit breaker on an automatic re-attach (no body)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
      });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx._session.resetRespawnBreaker).not.toHaveBeenCalled();
      expect(harness.ctx._session.startInteractive).toHaveBeenCalled();
    });

    it('clears the PTY-exit breaker when the explicit restart flag is sent (COD-118)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
        payload: { clearBreaker: true },
      });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx._session.resetRespawnBreaker).toHaveBeenCalledTimes(1);
      expect(harness.ctx._session.startInteractive).toHaveBeenCalled();
    });

    it('rejects a non-boolean clearBreaker flag', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
        payload: { clearBreaker: 'yes' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe(ApiErrorCode.INVALID_INPUT);
      expect(harness.ctx._session.resetRespawnBreaker).not.toHaveBeenCalled();
      expect(harness.ctx._session.startInteractive).not.toHaveBeenCalled();
    });

    // COD-118: the wiring exit handler detaches ALL session listeners on PTY exit;
    // re-attach must restore them or later trips/output go unobserved.
    it('re-runs session listener wiring before starting', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/interactive`,
      });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx.setupSessionListeners).toHaveBeenCalledWith(harness.ctx._session);
    });
  });

  // ========== POST /api/sessions/:id/shell ==========

  describe('POST /api/sessions/:id/shell', () => {
    it('starts shell mode', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/shell`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(harness.ctx._session.startShell).toHaveBeenCalled();
      // COD-118: re-attach restores listener wiring detached by a prior PTY exit.
      expect(harness.ctx.setupSessionListeners).toHaveBeenCalledWith(harness.ctx._session);
    });

    it('returns error if session is busy', async () => {
      harness.ctx._session.isBusy.mockReturnValue(true);
      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/shell`,
      });
      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== GET /api/sessions/:id/output ==========

  describe('GET /api/sessions/:id/output', () => {
    it('returns session output data', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/output`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toHaveProperty('textOutput');
      expect(body.data).toHaveProperty('messages');
      expect(body.data).toHaveProperty('errorBuffer');
    });

    it('returns error for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/output',
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== GET /api/sessions/:id/ralph-state ==========

  describe('GET /api/sessions/:id/ralph-state', () => {
    it('returns ralph state data', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/ralph-state`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toHaveProperty('loop');
      expect(body.data).toHaveProperty('todos');
      expect(body.data).toHaveProperty('todoStats');
    });
  });

  // ========== GET /api/sessions/:id/active-tools ==========

  describe('GET /api/sessions/:id/active-tools', () => {
    it('returns active tools', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/active-tools`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toHaveProperty('tools');
    });
  });

  // ========== POST /api/logout ==========

  describe('POST /api/logout', () => {
    it('returns success', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/logout',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });
  });

  // ========== GET /api/history/sessions ==========

  describe('GET /api/history/sessions', () => {
    it('returns sessions array', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.data).toHaveProperty('sessions');
      expect(Array.isArray(body.data.sessions)).toBe(true);
    });

    it('sessions have required fields', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions',
      });
      const body = JSON.parse(res.body);
      for (const session of body.data.sessions) {
        expect(session).toHaveProperty('sessionId');
        expect(session).toHaveProperty('workingDir');
        expect(session).toHaveProperty('projectKey');
        expect(session).toHaveProperty('sizeBytes');
        expect(session).toHaveProperty('lastModified');
        // sessionId must be a valid UUID
        expect(session.sessionId).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
      }
    });

    it('sessions are sorted by lastModified descending', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions',
      });
      const body = JSON.parse(res.body);
      const dates = body.data.sessions.map((s: { lastModified: string }) => new Date(s.lastModified).getTime());
      for (let i = 1; i < dates.length; i++) {
        expect(dates[i - 1]).toBeGreaterThanOrEqual(dates[i]);
      }
    });

    it('returns at most 50 sessions', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions',
      });
      const body = JSON.parse(res.body);
      expect(body.data.sessions.length).toBeLessThanOrEqual(50);
    });

    it('decodes a dotdir working directory (e.g. ~/.codeman) instead of falling back to $HOME', async () => {
      // Claude Code's project-key encoding maps both '/' and '.' to '-', so
      // "/home/x/.dotcase" and "/home/x/dotcase" collapse to the same-looking
      // dash run except for a doubled dash. decodeProjectKey() must still
      // recover the real (dotdir) path rather than silently falling back to
      // bare $HOME (COD bug: 2026-08-01, ~/.codeman resumed sessions got
      // workingDir "/home/timkjr" instead of "/home/timkjr/.codeman").
      const home = process.env.HOME as string;
      const realDir = join(home, '.dotcase');
      await mkdir(realDir, { recursive: true });

      const projectKey = realDir.replace(/\//g, '-').replace(/\./g, '-');
      const projDir = join(home, '.claude', 'projects', projectKey);
      await mkdir(projDir, { recursive: true });

      const sessionId = '12345678-1234-1234-1234-123456789012';
      const transcriptLine = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello world' } }) + '\n';
      // scanProjectDir skips files under 4000 bytes.
      const padding = '#'.repeat(4200 - transcriptLine.length);
      await writeFile(join(projDir, `${sessionId}.jsonl`), transcriptLine + padding);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/history/sessions?projectKey=${projectKey}`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      const row = body.data.sessions.find((s: { sessionId: string }) => s.sessionId === sessionId);
      expect(row).toBeDefined();
      expect(row.workingDir).toBe(realDir);
      expect(row.workingDir).not.toBe(home);
    });

    it('prefers the dotdir over a same-named non-dot sibling, and never emits a "//" path', async () => {
      // A doubled dash also lets the decoder read the empty split segment as a
      // directory NAME. `isDir(current + '/' + '')` stats `current + '/'`, which
      // always succeeds, so `~/.sib` + `~/sib` both existing used to resolve to
      // "/home/x//sib": the wrong directory, spelled with a double slash that
      // then fails every string comparison against session.workingDir. The empty
      // candidate is never a real path component, so it is skipped outright,
      // which is also what lets the dotdir branch below it run at all.
      const home = process.env.HOME as string;
      const dotDir = join(home, '.sib');
      await mkdir(dotDir, { recursive: true });
      await mkdir(join(home, 'sib'), { recursive: true });

      const projectKey = dotDir.replace(/\//g, '-').replace(/\./g, '-');
      const projDir = join(home, '.claude', 'projects', projectKey);
      await mkdir(projDir, { recursive: true });

      const sessionId = '22222222-2222-2222-2222-222222222222';
      const line = JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello world' } }) + '\n';
      await writeFile(join(projDir, `${sessionId}.jsonl`), line + '#'.repeat(4200 - line.length));

      const res = await harness.app.inject({ method: 'GET', url: `/api/history/sessions?projectKey=${projectKey}` });
      expect(res.statusCode).toBe(200);
      const row = JSON.parse(res.body).data.sessions.find((s: { sessionId: string }) => s.sessionId === sessionId);
      expect(row).toBeDefined();
      expect(row.workingDir).toBe(dotDir);
      expect(row.workingDir).not.toContain('//');
    });

    it('excludes non-interactive (SDK-driven) transcripts from the history list', async () => {
      // CI review bots and other automated tools write transcripts into the same
      // ~/.claude/projects tree as interactive sessions (entrypoint "sdk-py" etc.)
      // but were never something a user can resume into — no PTY, no running
      // process. They cluttered Past Sessions as blank rows or identical
      // boilerplate ("Review this change for security vulnerabilities...").
      const home = process.env.HOME as string;
      const projPath = join(home, '.claude', 'projects', 'proj-entrypoint-test');
      await mkdir(projPath, { recursive: true });

      const cliId = '33333333-3333-3333-3333-333333333333';
      const sdkId = '44444444-4444-4444-4444-444444444444';
      const noEntrypointId = '55555555-5555-5555-5555-555555555555';

      const cliLine =
        JSON.stringify({ type: 'user', entrypoint: 'cli', message: { role: 'user', content: 'a real question' } }) +
        '\n';
      const sdkLine =
        JSON.stringify({
          type: 'user',
          entrypoint: 'sdk-py',
          message: { role: 'user', content: 'Review this change for security vulnerabilities.' },
        }) + '\n';
      // Older transcripts predate the entrypoint field entirely — must still show.
      const noEntrypointLine =
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'a pre-entrypoint session' } }) + '\n';

      await writeFile(join(projPath, `${cliId}.jsonl`), cliLine + '#'.repeat(4200 - cliLine.length));
      await writeFile(join(projPath, `${sdkId}.jsonl`), sdkLine + '#'.repeat(4200 - sdkLine.length));
      await writeFile(
        join(projPath, `${noEntrypointId}.jsonl`),
        noEntrypointLine + '#'.repeat(4200 - noEntrypointLine.length)
      );

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions?projectKey=proj-entrypoint-test',
      });
      expect(res.statusCode).toBe(200);
      const ids = JSON.parse(res.body).data.sessions.map((s: { sessionId: string }) => s.sessionId);
      expect(ids).toContain(cliId);
      expect(ids).toContain(noEntrypointId);
      expect(ids).not.toContain(sdkId);
    });

    it('ignores a bookkeeping line that happens to mention "entrypoint" outside a real message record', async () => {
      // Scanning must anchor on "type":"user"/"assistant" lines specifically,
      // not any line that happens to contain the substring "entrypoint".
      const home = process.env.HOME as string;
      const projPath = join(home, '.claude', 'projects', 'proj-entrypoint-bookkeeping-test');
      await mkdir(projPath, { recursive: true });

      const sessionId = '77777777-7777-7777-7777-777777777777';
      const bookkeepingLine = JSON.stringify({ type: 'mode', mode: 'normal', entrypoint: 'sdk-py' }) + '\n';
      const realLine =
        JSON.stringify({ type: 'user', entrypoint: 'cli', message: { role: 'user', content: 'a real message' } }) +
        '\n';

      // scanProjectDir skips files under 4000 bytes.
      const body = bookkeepingLine + realLine;
      await writeFile(join(projPath, `${sessionId}.jsonl`), body + '#'.repeat(4200 - body.length));

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions?projectKey=proj-entrypoint-bookkeeping-test',
      });
      expect(res.statusCode).toBe(200);
      const ids = JSON.parse(res.body).data.sessions.map((s: { sessionId: string }) => s.sessionId);
      expect(ids).toContain(sessionId);
    });

    it('shows a session with ANY interactive (cli) message, even if an earlier message was automated', async () => {
      // "First field wins" would have misattributed this: an old transcript
      // whose true first message predates the entrypoint field, later resumed
      // under something automated (entrypoint: 'sdk-py' on message 2), then
      // continued interactively by a real person (entrypoint: 'cli' on message
      // 3). Stopping at the first entrypoint-bearing line found ('sdk-py')
      // would wrongly exclude a session a human genuinely used. One real
      // interactive message anywhere is enough to keep it visible.
      const home = process.env.HOME as string;
      const projPath = join(home, '.claude', 'projects', 'proj-entrypoint-any-cli-test');
      await mkdir(projPath, { recursive: true });

      const sessionId = '99999999-9999-9999-9999-999999999999';
      const firstLine =
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'pre-entrypoint-field message' } }) + '\n';
      const automatedLine =
        JSON.stringify({
          type: 'user',
          entrypoint: 'sdk-py',
          message: { role: 'user', content: 'an automated follow-up' },
        }) + '\n';
      const interactiveLine =
        JSON.stringify({
          type: 'user',
          entrypoint: 'cli',
          message: { role: 'user', content: 'a real person continued this' },
        }) + '\n';

      const body = firstLine + automatedLine + interactiveLine;
      await writeFile(join(projPath, `${sessionId}.jsonl`), body + '#'.repeat(4200 - body.length));

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions?projectKey=proj-entrypoint-any-cli-test',
      });
      expect(res.statusCode).toBe(200);
      const ids = JSON.parse(res.body).data.sessions.map((s: { sessionId: string }) => s.sessionId);
      expect(ids).toContain(sessionId);
    });

    it('still excludes a session where every entrypoint-bearing message is automated', async () => {
      // Mirror of the previous test with no 'cli' message anywhere — proves the
      // "any cli wins" fix isn't just failing open unconditionally.
      const home = process.env.HOME as string;
      const projPath = join(home, '.claude', 'projects', 'proj-entrypoint-all-automated-test');
      await mkdir(projPath, { recursive: true });

      const sessionId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const firstLine =
        JSON.stringify({
          type: 'user',
          entrypoint: 'sdk-py',
          message: { role: 'user', content: 'Review this change for security vulnerabilities.' },
        }) + '\n';
      const secondLine =
        JSON.stringify({
          type: 'assistant',
          entrypoint: 'sdk-py',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Looking at the diff...' }] },
        }) + '\n';

      const body = firstLine + secondLine;
      await writeFile(join(projPath, `${sessionId}.jsonl`), body + '#'.repeat(4200 - body.length));

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions?projectKey=proj-entrypoint-all-automated-test',
      });
      expect(res.statusCode).toBe(200);
      const ids = JSON.parse(res.body).data.sessions.map((s: { sessionId: string }) => s.sessionId);
      expect(ids).not.toContain(sessionId);
    });

    it('keeps a session whose entrypoint is an unrecognized non-SDK value (fail open)', async () => {
      // The exclusion is a blocklist on the SDK shape, NOT an allowlist on 'cli'.
      // An allowlist fails CLOSED on any value Claude Code has not shipped yet:
      // the day it stamps a new interactive entrypoint, nothing matches 'cli' and
      // the entire Past Sessions list silently goes blank. Excluding only what we
      // positively recognize as automated fails open instead — a few noisy rows,
      // not a dead feature.
      const home = process.env.HOME as string;
      const projPath = join(home, '.claude', 'projects', 'proj-entrypoint-unknown-test');
      await mkdir(projPath, { recursive: true });

      const sessionId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      const line =
        JSON.stringify({
          type: 'user',
          entrypoint: 'cli-next',
          message: { role: 'user', content: 'a question from a future interactive host' },
        }) + '\n';
      await writeFile(join(projPath, `${sessionId}.jsonl`), line + '#'.repeat(4200 - line.length));

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions?projectKey=proj-entrypoint-unknown-test',
      });
      expect(res.statusCode).toBe(200);
      const ids = JSON.parse(res.body).data.sessions.map((s: { sessionId: string }) => s.sessionId);
      expect(ids).toContain(sessionId);
    });

    it('finds the real first prompt past a large run of pre-message bookkeeping lines', async () => {
      // A session restarted many times over a long conversation accumulates a batch
      // of small bookkeeping lines (mode/permission-mode/last-prompt/queue-operation)
      // per restart, ahead of the real first message. With enough restarts these can
      // push the genuine first prompt past a 16KB head-read window even though the
      // message itself is tiny — the row showed up blank despite having real content.
      const home = process.env.HOME as string;
      const projPath = join(home, '.claude', 'projects', 'proj-bookkeeping-test');
      await mkdir(projPath, { recursive: true });

      const sessionId = '66666666-6666-6666-6666-666666666666';
      const bookkeepingLine = JSON.stringify({ type: 'mode', mode: 'normal', sessionId }) + '\n';
      // > 16KB (the old head-read size) but well under 128KB (the new one).
      const prefix = bookkeepingLine.repeat(Math.ceil(20000 / bookkeepingLine.length));
      const realLine =
        JSON.stringify({
          type: 'user',
          entrypoint: 'cli',
          message: { role: 'user', content: 'the real first message' },
        }) + '\n';
      expect(prefix.length).toBeGreaterThan(16384);

      await writeFile(join(projPath, `${sessionId}.jsonl`), prefix + realLine);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions?projectKey=proj-bookkeeping-test',
      });
      expect(res.statusCode).toBe(200);
      const row = JSON.parse(res.body).data.sessions.find((s: { sessionId: string }) => s.sessionId === sessionId);
      expect(row).toBeDefined();
      expect(row.firstPrompt).toBe('the real first message');
    });

    it('still falls back to the tail read when bookkeeping alone exceeds the new 128KB head window', async () => {
      // Raising the head buffer to 128KB helps most restart-heavy sessions, but an
      // even more extreme case (many more restarts) can still exceed it. This
      // proves the tail-read fallback itself is intact after the threshold
      // rewrite (`fileStat.size > headBuf.length` replacing the old hardcoded
      // 16384/65536) — the fallback's own logic, not the exact threshold value,
      // is what could have silently broken (e.g. a copy-paste slip that dropped
      // the `> headBuf.length` check entirely). The real message sits near the
      // end of the file, well inside the 32KB tail window, so a working fallback
      // finds it; a broken one leaves the row blank exactly like the bug this
      // whole fix addresses.
      const home = process.env.HOME as string;
      const projPath = join(home, '.claude', 'projects', 'proj-tail-fallback-test');
      await mkdir(projPath, { recursive: true });

      const sessionId = '88888888-8888-8888-8888-888888888888';
      const bookkeepingLine = JSON.stringify({ type: 'mode', mode: 'normal', sessionId }) + '\n';
      // Comfortably past the new 128KB head window (was 16KB), so the head read
      // never reaches a single "type":"user"/"assistant"/"summary" line.
      const prefix = bookkeepingLine.repeat(Math.ceil(140000 / bookkeepingLine.length));
      const realLine =
        JSON.stringify({
          type: 'user',
          entrypoint: 'cli',
          message: { role: 'user', content: 'found via tail fallback' },
        }) + '\n';
      expect(prefix.length).toBeGreaterThan(131072);

      await writeFile(join(projPath, `${sessionId}.jsonl`), prefix + realLine);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/history/sessions?projectKey=proj-tail-fallback-test',
      });
      expect(res.statusCode).toBe(200);
      const row = JSON.parse(res.body).data.sessions.find((s: { sessionId: string }) => s.sessionId === sessionId);
      expect(row).toBeDefined();
      expect(row.firstPrompt).toBe('found via tail fallback');
    });
  });

  // ========== POST /api/sessions (with resumeSessionId) ==========

  describe('POST /api/sessions with resumeSessionId', () => {
    it('creates session from a remote case without local stat validation', async () => {
      // Remote cases go through /api/quick-start which skips local stat() of the workingDir.
      // /api/sessions always requires workingDir to exist on the local filesystem.
      const startShell = vi.spyOn(Session.prototype, 'startShell').mockResolvedValue(undefined);
      try {
        remoteStore.hosts = [
          {
            id: 'gpu-box',
            label: 'GPU Box',
            host: '10.0.0.42',
            username: 'ubuntu',
            commands: { codex: 'exec codx personal' },
          },
        ];
        remoteStore.cases = [{ name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' }];

        const res = await harness.app.inject({
          method: 'POST',
          url: '/api/quick-start',
          payload: { caseName: 'gpu-work', mode: 'shell', name: 'Remote Shell' },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(true);
        expect(body.data.casePath).toBe('/home/ubuntu/work');
        const session = [...harness.ctx.sessions.values()].find((item) => item.id === body.data.sessionId);
        expect(session?.toState()).toMatchObject({
          workingDir: '/home/ubuntu/work',
          remote: expect.objectContaining({
            hostId: 'gpu-box',
            host: '10.0.0.42',
            username: 'ubuntu',
            remotePath: '/home/ubuntu/work',
            commands: { codex: 'exec codx personal' },
          }),
        });
      } finally {
        startShell.mockRestore();
      }
    });

    it('quick-start creates remote case sessions through ssh metadata', async () => {
      const startShell = vi.spyOn(Session.prototype, 'startShell').mockResolvedValue(undefined);
      try {
        remoteStore.hosts = [
          {
            id: 'gpu-box',
            label: 'GPU Box',
            host: '10.0.0.42',
            username: 'ubuntu',
            commands: { codex: 'exec codx personal' },
          },
        ];
        remoteStore.cases = [{ name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' }];

        const res = await harness.app.inject({
          method: 'POST',
          url: '/api/quick-start',
          payload: { caseName: 'gpu-work', mode: 'shell' },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.success).toBe(true);
        expect(body.data.casePath).toBe('/home/ubuntu/work');
        const session = [...harness.ctx.sessions.values()].find((item) => item.id === body.data.sessionId);
        expect(session?.toState()).toMatchObject({
          workingDir: '/home/ubuntu/work',
          remote: expect.objectContaining({
            hostId: 'gpu-box',
            host: '10.0.0.42',
            username: 'ubuntu',
            remotePath: '/home/ubuntu/work',
          }),
        });
      } finally {
        startShell.mockRestore();
      }
    });

    it('rejects a remote quick-start that carries envOverrides (inert over ssh)', async () => {
      remoteStore.hosts = [{ id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu' }];
      remoteStore.cases = [{ name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' }];

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/quick-start',
        payload: { caseName: 'gpu-work', mode: 'claude', envOverrides: { CLAUDE_CODE_FOO: 'bar' } },
      });

      expect(res.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.INVALID_INPUT));
      expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.INVALID_INPUT });
    });

    it('rejects a remote quick-start when the remote host lacks tmux', async () => {
      remoteStore.hosts = [{ id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu' }];
      remoteStore.cases = [{ name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' }];
      remoteStore.tmuxCheck = {
        ok: false,
        error: 'remote host 10.0.0.42 needs tmux installed for durable remote sessions',
      };

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/quick-start',
        payload: { caseName: 'gpu-work', mode: 'shell' },
      });

      expect(res.statusCode).toBe(httpStatusForErrorCode(ApiErrorCode.OPERATION_FAILED));
      expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: ApiErrorCode.OPERATION_FAILED });
    });

    it('does not run local codex availability check for a remote codex case', async () => {
      // A remote codex case must NOT be blocked by the LOCAL codex availability gate
      // (the CLI runs on the remote host). Probe is stubbed ok in remoteStore.tmuxCheck.
      const startInteractive = vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValue(undefined);
      try {
        remoteStore.hosts = [
          { id: 'gpu-box', label: 'GPU Box', host: '10.0.0.42', username: 'ubuntu', commands: { codex: 'exec codx' } },
        ];
        remoteStore.cases = [{ name: 'gpu-work', type: 'remote', hostId: 'gpu-box', remotePath: '/home/ubuntu/work' }];

        const res = await harness.app.inject({
          method: 'POST',
          url: '/api/quick-start',
          payload: { caseName: 'gpu-work', mode: 'codex' },
        });

        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body).success).toBe(true);
      } finally {
        startInteractive.mockRestore();
      }
    });

    it('creates session with valid resumeSessionId', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          name: 'resume-test',
          mode: 'claude',
          workingDir: process.env.HOME || '/tmp',
          resumeSessionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.session).toBeDefined();
    });

    it('rejects invalid resumeSessionId format', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          name: 'bad-resume',
          mode: 'claude',
          workingDir: process.env.HOME || '/tmp',
          resumeSessionId: 'not-a-uuid',
        },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('creates session without resumeSessionId (optional field)', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/sessions',
        payload: {
          name: 'no-resume',
          mode: 'claude',
          workingDir: process.env.HOME || '/tmp',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });
  });
});
