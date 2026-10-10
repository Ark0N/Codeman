/**
 * @fileoverview `/api/events` must not lose the headers the security hook set.
 *
 * The SSE route answers with `reply.raw.writeHead()`, which writes straight to the
 * Node response and bypasses Fastify's header store. Everything the `onRequest`
 * security hook had granted was therefore dropped — including the
 * `Access-Control-Allow-Origin` it emits for localhost origins. The contradiction is
 * visible from a browser: a localhost page may call every other `/api` endpoint
 * cross-origin, but its EventSource fails CORS.
 *
 * These tests drive a REAL WebServer. An earlier version asserted against an inline
 * copy of the hook and the handler, which proved nothing: reverting the fix in
 * `server.ts` left every test green.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WebServer } from '../src/web/server.js';

const LOCAL_ORIGIN = 'http://localhost:5173';

/** Open /api/events, read the response headers, then abort — it never ends on its own. */
async function eventsHeaders(baseUrl: string, origin?: string): Promise<Headers> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`${baseUrl}/api/events`, {
      signal: controller.signal,
      headers: origin ? { Origin: origin } : undefined,
    });
    const headers = res.headers;
    controller.abort(); // stop consuming the stream
    return headers;
  } finally {
    clearTimeout(timeout);
  }
}

describe('GET /api/events header inheritance', () => {
  let server: WebServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = new WebServer(0, false, true);
    await server.start();
    baseUrl = `http://localhost:${server.boundPort}`;
  });

  afterAll(async () => {
    await server.stop();
  }, 60000);

  it('keeps the CORS header the security hook granted a localhost origin', async () => {
    // The regression: this header is set on the Fastify reply and was then thrown
    // away by writeHead, so an EventSource from a localhost dev server failed CORS
    // while every other endpoint worked.
    const headers = await eventsHeaders(baseUrl, LOCAL_ORIGIN);
    expect(headers.get('access-control-allow-origin')).toBe(LOCAL_ORIGIN);
  });

  it('keeps the security headers the hook set', async () => {
    const headers = await eventsHeaders(baseUrl);
    expect(headers.get('x-content-type-options')).toBe('nosniff');
    expect(headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(headers.get('content-security-policy')).toBeTruthy();
  });

  it('still sets the SSE headers, and they win over anything inherited', async () => {
    const headers = await eventsHeaders(baseUrl);
    expect(headers.get('content-type')).toBe('text/event-stream');
    expect(headers.get('cache-control')).toBe('no-cache');
    expect(headers.get('x-accel-buffering')).toBe('no');
  });

  it('grants nothing to a non-localhost origin — the hook decides, not this route', async () => {
    const headers = await eventsHeaders(baseUrl, 'https://evil.example');
    expect(headers.get('access-control-allow-origin')).toBeNull();
  });

  it('matches what a normal JSON endpoint returns for the same origin', async () => {
    // The point of the fix: /api/events stops being the odd one out.
    const json = await fetch(`${baseUrl}/api/status`, { headers: { Origin: LOCAL_ORIGIN } });
    const sse = await eventsHeaders(baseUrl, LOCAL_ORIGIN);

    expect(sse.get('access-control-allow-origin')).toBe(json.headers.get('access-control-allow-origin'));
    expect(sse.get('x-content-type-options')).toBe(json.headers.get('x-content-type-options'));
  });
});
