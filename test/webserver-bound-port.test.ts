/**
 * @fileoverview `new WebServer(0, …)`: the OS picks the port and every reader of
 * `this.port` sees that number, not the 0 that was asked for (#440).
 *
 * Port: ephemeral.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { WebServer } from '../src/web/server.js';

describe('WebServer on an ephemeral port', () => {
  let server: WebServer;
  /** Built BEFORE start(), as setupRoutes() builds it, so a by-value snapshot would read 0. */
  let ctx: { port: number };
  const savedApiUrl = process.env.CODEMAN_API_URL;
  /** The socket's own answer, so each test stands on its own instead of trusting boundPort. */
  const socketPort = () =>
    ((server as unknown as { app: { server: { address(): AddressInfo } } }).app.server.address() as AddressInfo).port;

  beforeAll(async () => {
    server = new WebServer(0, false, true);
    ctx = (server as unknown as { createRouteContext(): { port: number } }).createRouteContext();
    await server.start();
  });

  afterAll(async () => {
    await server.stop();
    if (savedApiUrl === undefined) delete process.env.CODEMAN_API_URL;
    else process.env.CODEMAN_API_URL = savedApiUrl;
  });

  it('reports the port the OS assigned', async () => {
    expect(socketPort()).toBeGreaterThan(0);
    expect(server.boundPort).toBe(socketPort());
    const res = await fetch(`http://127.0.0.1:${server.boundPort}/api/status`);
    expect(res.status).toBe(200);
  });

  it('the route context reads it live (the tunnel start gets the real port, not 0)', () => {
    expect(ctx.port).toBe(socketPort());
  });

  it('exports the real port to the panes as CODEMAN_API_URL', () => {
    expect(process.env.CODEMAN_API_URL).toBe(`http://127.0.0.1:${socketPort()}`);
  });
});
