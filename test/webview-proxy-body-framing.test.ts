/**
 * @fileoverview The webview proxy relays a request body with the browser's own
 * Content-Length, not as `Transfer-Encoding: chunked`.
 *
 * The proxy hands undici the body as a stream, and undici frames a stream with
 * no known length as chunked. Servers that read only Content-Length (Python's
 * `http.server`, many small Go/C ones) then see an EMPTY body: a WoL dashboard's
 * "Shut down" posted `{"confirm":true}` and was refused for missing the flag on
 * every click through the web tab, while curl straight at it worked.
 *
 * Uses app.inject() against the real registerWebviewRoutes with a real upstream
 * that parses requests the way such a server does: headers, then exactly
 * Content-Length bytes, and nothing else. Port: ephemeral (server.listen(0)).
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createServer, type Server } from 'node:net';

import { registerWebviewRoutes } from '../src/web/routes/webview-routes.js';
import { webviewCapabilities } from '../src/webview-capabilities.js';
import { writeWebviews } from '../src/webview-store.js';
import { getDataDir } from '../src/config/instance.js';
import type { EventPort } from '../src/web/ports/index.js';

const WEBVIEW_ID = 'wv-body-framing-test';

let upstream: Server;
let upstreamPort: number;
let app: FastifyInstance;
let capability: string;

const eventPortStub: EventPort = {
  broadcast: vi.fn(),
  sendPushNotifications: vi.fn(),
  batchTerminalData: vi.fn(),
  broadcastSessionStateDebounced: vi.fn(),
  batchTaskUpdate: vi.fn(),
  getSseClientCount: vi.fn(() => 0),
};

interface Seen {
  method: string;
  body: string;
  contentLength: string | null;
  transferEncoding: string | null;
}

beforeAll(async () => {
  // A Content-Length-only HTTP/1.0 server. It answers with what it saw, so a
  // chunked body shows up as `body: ''` exactly as it did for the dashboard.
  upstream = createServer((socket) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      const lines = buf.subarray(0, end).toString('latin1').split('\r\n');
      const headers = new Map(
        lines.slice(1).map((l) => [l.slice(0, l.indexOf(':')).trim().toLowerCase(), l.slice(l.indexOf(':') + 1).trim()])
      );
      const length = Number(headers.get('content-length') ?? 0);
      if (buf.length - (end + 4) < length) return;
      socket.off('data', onData);
      const seen: Seen = {
        method: lines[0].split(' ')[0],
        body: buf.subarray(end + 4, end + 4 + length).toString(),
        contentLength: headers.get('content-length') ?? null,
        transferEncoding: headers.get('transfer-encoding') ?? null,
      };
      const payload = JSON.stringify(seen);
      socket.end(
        `HTTP/1.0 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(payload)}\r\n\r\n${payload}`
      );
    };
    socket.on('data', onData);
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const address = upstream.address();
  if (typeof address === 'object' && address) upstreamPort = address.port;

  await writeWebviews(getDataDir(), [
    {
      id: WEBVIEW_ID,
      name: 'body-framing-under-test',
      url: `http://127.0.0.1:${upstreamPort}/`,
      embedMode: 'proxy',
      trusted: false,
      createdAt: Date.now(),
    },
  ]);
  capability = webviewCapabilities.mint(WEBVIEW_ID, undefined);

  app = Fastify({ logger: false });
  registerWebviewRoutes(app, eventPortStub);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  webviewCapabilities.revokeWebview(WEBVIEW_ID);
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
});

describe('webview proxy request body framing', () => {
  it('relays a JSON POST body with its Content-Length, so a length-only server reads it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/webview/${capability}/api/shutdown`,
      headers: { 'content-type': 'application/json' },
      payload: '{"confirm":true}',
    });
    expect(res.statusCode).toBe(200);
    const seen = res.json() as Seen;
    expect(seen.transferEncoding).toBeNull();
    expect(seen.contentLength).toBe('16');
    expect(JSON.parse(seen.body)).toEqual({ confirm: true });
  });

  it('keeps a large body intact under the same framing', async () => {
    const big = 'x'.repeat(256 * 1024);
    const res = await app.inject({
      method: 'PUT',
      url: `/webview/${capability}/upload`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: big,
    });
    const seen = res.json() as Seen;
    expect(seen.contentLength).toBe(String(big.length));
    expect(seen.body).toBe(big);
  });

  it('sends no length on a GET, which carries no body', async () => {
    const res = await app.inject({ method: 'GET', url: `/webview/${capability}/status` });
    const seen = res.json() as Seen;
    expect(seen.method).toBe('GET');
    expect(seen.contentLength).toBeNull();
    expect(seen.transferEncoding).toBeNull();
  });
});
