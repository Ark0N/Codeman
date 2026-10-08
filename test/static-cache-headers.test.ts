/**
 * @fileoverview `@fastify/static`'s `setHeaders` callback is what sets Cache-Control
 * on every asset Codeman serves, and v10 silently changed its contract.
 *
 * In v9 the first argument was a Node `ServerResponse`, so the body called
 * `res.setHeader(...)`. In v10 it is a `FastifyReply`, which has no `setHeader`, so
 * the v9 body throws `TypeError: res.setHeader is not a function` from inside
 * `@fastify/static` on EVERY static request. Nothing in the type-checker catches a
 * revert (the callback's parameter is inferred), and nothing else in the suite reads
 * these headers, so without this file the whole caching contract is untested.
 *
 * That contract is load-bearing: assets are served `immutable` for a year, and
 * `index.html` must revalidate every time or a deploy leaves browsers on stale
 * markup (see `cacheBustAssets` in server.ts). No HTML is left behind the static
 * plugin (every page has its own route), so the HTML half is asserted on the route.
 *
 * These tests drive a REAL WebServer on purpose. Asserting against an inline
 * re-registration of the plugin would keep passing after a revert in server.ts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WebServer } from '../src/web/server.js';

const TEST_PORT = 3183;

/**
 * Fetch and fully drain the body. Both halves matter for teardown: an unconsumed
 * body leaves undici holding the socket, and a pooled keep-alive socket makes
 * `server.stop()` wait for it, which times out the afterAll hook.
 */
async function get(url: string): Promise<Response> {
  const res = await fetch(url, { headers: { connection: 'close' } });
  await res.arrayBuffer();
  return res;
}

describe('static asset Cache-Control headers', () => {
  let server: WebServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = new WebServer(TEST_PORT, false, true);
    await server.start();
    baseUrl = `http://localhost:${TEST_PORT}`;
  });

  afterAll(async () => {
    await server.stop();
  }, 60000);

  it('serves a static asset at all (proves setHeaders did not throw)', async () => {
    // The v9-form regression surfaces here first: @fastify/static invokes setHeaders
    // while streaming, so a TypeError inside it takes the response down rather than
    // merely omitting a header.
    const res = await get(`${baseUrl}/app.js`);
    expect(res.status).toBe(200);
  });

  it('marks long-lived assets immutable', async () => {
    const res = await get(`${baseUrl}/app.js`);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('lets a route keep the Cache-Control it set, so sw.js stays uncached', async () => {
    // Regression guard for the OTHER half of the v10 change. setHeaders runs for
    // sendFile() too, and v10 moved it from the raw response onto the reply, which
    // flipped precedence: the callback started overriding routes instead of being
    // overridden by them. That gave /sw.js `immutable, max-age=31536000` in place of
    // the `no-cache, no-store` its route sets — a service worker pinned for a year,
    // which is unrecoverable from the server side because clients stop asking.
    // Measured against v9 to confirm this is the historical behaviour, not a guess.
    const res = await get(`${baseUrl}/sw.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-cache, no-store');
  });

  it('serves the rendered index with no-cache too, via its own route', async () => {
    // Different code path from the above, same contract: index.html is generated per
    // request (cacheBustAssets stamps ?v= onto every asset ref), so caching it would
    // pin browsers to the asset versions current at deploy time.
    const res = await get(`${baseUrl}/index.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-cache');
  });
});
