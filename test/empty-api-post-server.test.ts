/** Verify parser installation through the real server, including API aliases and base paths. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { WebServer } from '../src/web/server.js';

describe('empty POST: production server wiring', () => {
  let server: WebServer;
  let app: FastifyInstance;
  beforeAll(async () => {
    server = new WebServer(0, false, true, '127.0.0.1', undefined, false, '/codeman');
    await server.start();
    app = (server as unknown as { app: FastifyInstance }).app;
  });
  afterAll(async () => {
    await server?.stop();
  });

  it('accepts empty chunked POSTs to a real API through each supported prefix', async () => {
    for (const prefix of ['/api', '/api/v1', '/codeman/api', '/codeman/api/v1']) {
      const res = await app.inject({
        method: 'POST',
        url: `${prefix}/approvals/session/nonexistent/viewed`,
        headers: { 'transfer-encoding': 'chunked' },
      });
      // The real handler ran and found no session, instead of the parser returning 415.
      expect(res.statusCode, res.body).toBe(404);
      expect(res.json().errorCode).toBe('NOT_FOUND');
    }
  });

  it('still rejects a nonempty untyped POST before reaching the same handler', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/approvals/session/nonexistent/viewed',
      headers: { 'transfer-encoding': 'chunked' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(415);
  });

  it('preserves the API 404 envelope for an unknown empty chunked POST', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/nonexistent',
      headers: { 'transfer-encoding': 'chunked' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().errorCode).toBe('NOT_FOUND');
  });
});
