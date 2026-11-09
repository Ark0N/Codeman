/** Regression coverage for empty API POSTs reframed as chunked by a reverse proxy. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import fastifyMultipart from '@fastify/multipart';
import { connect } from 'node:net';
import { Readable } from 'node:stream';
import { installEmptyApiPostParser } from '../src/web/request-body-parser.js';
import { registerAuthMiddleware, registerHostGuard } from '../src/web/middleware/auth.js';
import { registerMuxRoutes } from '../src/web/routes/mux-routes.js';
import { registerWebviewRoutes } from '../src/web/routes/webview-routes.js';
import { createMockRouteContext } from './mocks/index.js';
import { writeWebviews } from '../src/webview-store.js';
import { webviewCapabilities } from '../src/webview-capabilities.js';
import { getDataDir } from '../src/config/instance.js';

const apps: FastifyInstance[] = [];
function createApp(options: FastifyServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false, ...options });
  installEmptyApiPostParser(app);
  apps.push(app);
  return app;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  webviewCapabilities.revokeWebview('empty-post-preview');
});

const emptyChunked = { 'transfer-encoding': 'chunked' };
describe('empty API POST parser', () => {
  it.each([{}, { 'content-length': '0' }, emptyChunked])(
    'preserves an absent body and the original headers (%j)',
    async (headers) => {
      const app = createApp();
      app.post('/api/action', async (req) => ({
        absent: req.body === undefined,
        contentType: req.headers['content-type'] ?? null,
        contentLength: req.headers['content-length'] ?? null,
        transferEncoding: req.headers['transfer-encoding'] ?? null,
      }));
      const res = await app.inject({ method: 'POST', url: '/api/action', headers });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        absent: true,
        contentType: null,
        contentLength: 'content-length' in headers ? '0' : null,
        transferEncoding: 'transfer-encoding' in headers ? 'chunked' : null,
      });
    }
  );

  it.each([' ', '{}', '{"prompt":"hello"}', 'x'.repeat(1024)])(
    'rejects nonempty untyped chunked input (%#)',
    async (payload) => {
      const app = createApp();
      const handler = vi.fn(async () => ({}));
      app.post('/api/action', handler);
      const res = await app.inject({ method: 'POST', url: '/api/action', headers: emptyChunked, payload });
      expect(res.statusCode).toBe(415);
      expect(res.json().code).toBe('FST_ERR_CTP_INVALID_MEDIA_TYPE');
      expect(handler).not.toHaveBeenCalled();
    }
  );

  it('rejects a positive Content-Length without reading the body', async () => {
    const app = createApp();
    let streamRead = false;
    app.addHook(
      'preParsing',
      async () =>
        new Readable({
          read() {
            streamRead = true;
          },
        })
    );
    app.post('/api/action', async () => ({}));
    const res = await app.inject({ method: 'POST', url: '/api/action', headers: { 'content-length': '1' } });
    expect(res.statusCode).toBe(415);
    expect(streamRead).toBe(false);
  });

  it('waits for the end of an empty stream before executing the handler', async () => {
    const app = createApp();
    let started!: () => void;
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    const stream = new Readable({
      read() {
        started();
      },
    });
    app.addHook('preParsing', async () => stream);
    const handler = vi.fn(async (req: FastifyRequest) => ({ absent: req.body === undefined }));
    app.post('/api/action', handler);
    const response = app.inject({ method: 'POST', url: '/api/action', headers: emptyChunked });
    await reading;
    expect(handler).not.toHaveBeenCalled();
    stream.push(null);
    const res = await response;
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ absent: true });
  });

  it('rejects on the first byte without waiting for an unsupported stream to end', async () => {
    const app = createApp({ bodyLimit: 16 });
    const stream = new Readable({
      read() {
        this.push(Buffer.alloc(32));
        this._read = () => {};
      },
    });
    app.addHook('preParsing', async () => stream);
    app.post('/api/action', async () => ({}));
    try {
      const res = await app.inject({ method: 'POST', url: '/api/action', headers: emptyChunked });
      expect(res.statusCode).toBe(415);
      expect(res.headers.connection).toBe('close');
      expect(stream.readableEnded).toBe(false);
    } finally {
      stream.destroy();
    }
  });

  it.each(['application/octet-stream', 'application/xml', 'invalid/type/extra', ''])(
    'preserves rejection of an explicit type %j',
    async (contentType) => {
      const app = createApp();
      app.post('/api/action', async () => ({}));
      const res = await app.inject({ method: 'POST', url: '/api/action', headers: { 'content-type': contentType } });
      expect(res.statusCode).toBe(415);
    }
  );

  it('preserves JSON parsing, required-body validation, text and body limits', async () => {
    const app = createApp({ bodyLimit: 64 });
    app.post('/api/json', async (req) => ({ body: req.body }));
    app.post(
      '/api/required',
      { schema: { body: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } } } },
      async (req) => req.body
    );
    const missing = await app.inject({ method: 'POST', url: '/api/required', headers: emptyChunked });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().code).toBe('FST_ERR_VALIDATION');
    const valid = await app.inject({ method: 'POST', url: '/api/required', payload: { prompt: 'hello' } });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual({ prompt: 'hello' });
    for (const [payload, code] of [
      ['', 'FST_ERR_CTP_EMPTY_JSON_BODY'],
      ['{broken', 'FST_ERR_CTP_INVALID_JSON_BODY'],
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/json',
        headers: { 'content-type': 'application/json' },
        payload,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe(code);
    }
    const text = await app.inject({
      method: 'POST',
      url: '/api/json',
      headers: { 'content-type': 'text/plain' },
      payload: '{"admin":true}',
    });
    expect(text.json()).toEqual({ body: '{"admin":true}' });
    const oversized = await app.inject({ method: 'POST', url: '/api/json', payload: { value: 'x'.repeat(64) } });
    expect(oversized.statusCode).toBe(413);
  });

  it('leaves other methods and non-API routes outside the compatibility rule', async () => {
    const app = createApp();
    app.put('/api/action', async () => ({}));
    app.patch('/api/action', async () => ({}));
    app.post('/outside-api', async () => ({}));
    for (const [method, url] of [
      ['PUT', '/api/action'],
      ['PATCH', '/api/action'],
      ['POST', '/outside-api'],
    ] as const) {
      const res = await app.inject({ method, url, headers: emptyChunked });
      expect(res.statusCode).toBe(415);
    }
  });

  it('preserves unknown routes and leaves their body stream unread for fallback handlers', async () => {
    const app = createApp();
    app.setNotFoundHandler(async (req, reply) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req.raw) chunks.push(chunk);
      return reply.code(404).send({ body: Buffer.concat(chunks).toString(), absent: req.body === undefined });
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/unknown',
      headers: emptyChunked,
      payload: 'untyped-data',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ body: 'untyped-data', absent: true });
  });

  it('keeps multipart uploads and an encapsulated raw-stream proxy parser intact', async () => {
    const app = createApp();
    await app.register(fastifyMultipart);
    app.post('/api/upload', async (req) => {
      const file = await req.file();
      return { name: file?.filename, data: (await file?.toBuffer())?.toString('base64') };
    });
    app.register(async (scope) => {
      scope.removeAllContentTypeParsers();
      scope.addContentTypeParser('*', (_req, stream, done) => done(null, stream));
      scope.post('/webview/test/*', async (req) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req.body as Readable) chunks.push(chunk);
        return { data: Buffer.concat(chunks).toString('base64') };
      });
    });
    const bytes = Buffer.from([0, 255, 128, 13, 10, 65]);
    const boundary = 'empty-post-boundary';
    const multipart = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const upload = await app.inject({
      method: 'POST',
      url: '/api/upload',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart,
    });
    expect(upload.statusCode).toBe(200);
    expect(upload.json()).toEqual({ name: 'sample.bin', data: bytes.toString('base64') });
    const proxy = await app.inject({
      method: 'POST',
      url: '/webview/test/upload',
      headers: { 'content-type': 'application/octet-stream' },
      payload: bytes,
    });
    expect(proxy.statusCode).toBe(200);
    expect(proxy.json()).toEqual({ data: bytes.toString('base64') });
  });

  it('exercises real mux operations and the real webview open route without a synthetic JSON body', async () => {
    const app = createApp();
    const ctx = createMockRouteContext();
    registerMuxRoutes(app, ctx as never);
    registerWebviewRoutes(app, ctx as never);
    await writeWebviews(getDataDir(), [
      {
        id: 'empty-post-preview',
        name: 'Preview',
        url: 'http://127.0.0.1:18716/',
        embedMode: 'proxy',
        trusted: false,
        createdAt: 1,
      },
    ]);
    const stats = await app.inject({ method: 'POST', url: '/api/mux-sessions/stats/start', headers: emptyChunked });
    expect(stats.statusCode).toBe(200);
    expect(ctx.mux.startStatsCollection).toHaveBeenCalledOnce();
    const preview = await app.inject({
      method: 'POST',
      url: '/api/webviews/empty-post-preview/open',
      headers: emptyChunked,
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().data.embedUrl).toMatch(/^\/webview\/.+\/$/);
  });

  it('preserves Host/Origin guards and authentication before parsing', async () => {
    vi.stubEnv('CODEMAN_USERNAME', 'bodyless-test-user');
    vi.stubEnv('CODEMAN_PASSWORD', 'isolated-test-password');
    const app = createApp();
    await app.register(fastifyCookie);
    registerHostGuard(app, () => ({ bindHost: '127.0.0.1', allowedHosts: [], tunnelHost: null }));
    const auth = registerAuthMiddleware(app, false);
    app.post('/api/action', async () => ({ ok: true }));
    const authorization = 'Basic ' + Buffer.from('bodyless-test-user:isolated-test-password').toString('base64');
    const headers = { host: '127.0.0.1', ...emptyChunked };
    try {
      expect((await app.inject({ method: 'POST', url: '/api/action', headers })).statusCode).toBe(401);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/action',
            headers: { ...headers, authorization, origin: 'https://evil.example' },
          })
        ).statusCode
      ).toBe(403);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/action',
            headers: { ...headers, authorization, host: 'evil.example' },
          })
        ).statusCode
      ).toBe(403);
      expect(
        (await app.inject({ method: 'POST', url: '/api/action', headers: { ...headers, authorization } })).statusCode
      ).toBe(200);
    } finally {
      for (const map of Object.values(auth)) map?.dispose();
      vi.unstubAllEnvs();
    }
  });
});

function sendRaw(port: number, frames: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    socket.setTimeout(2000, () => socket.destroy(new Error('Raw request timed out')));
    socket.on('error', reject);
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString()));
    socket.on('connect', () => socket.write(frames.join('')));
  });
}

describe('real HTTP/1.1 framing', () => {
  it('consumes the complete empty chunk before a second request on the same connection', async () => {
    const app = createApp();
    const seen: unknown[] = [];
    app.post('/api/action', async (req) => {
      seen.push(req.body);
      return { ok: true };
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const res = await sendRaw(port, [
      'POST /api/action HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX-Test-Trailer: done\r\n\r\n',
      'POST /api/action HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n',
    ]);
    expect(res.match(/HTTP\/1.1 200 OK/g)).toHaveLength(2);
    expect(seen).toEqual([undefined, undefined]);
  });

  it('returns 415 after the first nonempty chunk, without needing a terminating chunk', async () => {
    const app = createApp();
    const handler = vi.fn(async () => ({}));
    app.post('/api/action', handler);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const res = await sendRaw(port, [
      'POST /api/action HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n',
    ]);
    expect(res).toMatch(/^HTTP\/1.1 415 /);
    expect(handler).not.toHaveBeenCalled();
  });

  it('leaves conflicting length and transfer headers to the HTTP parser', async () => {
    const app = createApp();
    const handler = vi.fn(async () => ({}));
    app.post('/api/action', handler);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const res = await sendRaw(port, [
      'POST /api/action HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n',
    ]);
    expect(res).toMatch(/^HTTP\/1.1 400 /);
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not execute the handler after a client aborts an unfinished chunked request', async () => {
    const app = createApp();
    const handler = vi.fn(async () => ({}));
    const onError = vi.fn();
    app.addHook('onError', async (_req, _reply, error) => {
      onError(error.statusCode);
    });
    app.post('/api/action', handler);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as { port: number }).port;
    await new Promise<void>((resolve) => {
      const socket = connect({ host: '127.0.0.1', port });
      socket.on('connect', () =>
        socket.end('POST /api/action HTTP/1.1\r\nHost: localhost\r\nTransfer-Encoding: chunked\r\n\r\n')
      );
      socket.resume();
      socket.on('close', () => resolve());
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(400));
    expect(handler).not.toHaveBeenCalled();
  });
});
