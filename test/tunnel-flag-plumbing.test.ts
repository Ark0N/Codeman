/**
 * @fileoverview Issue #706 carries the WebServer tunnel opt-in into its real route context. Requests use Fastify injection and settings use the isolated HOME from test/setup.ts; the tunnel process and socket listener are stubbed.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startWebServer, WebServer } from '../src/web/server.js';
import { TunnelManager } from '../src/tunnel-manager.js';
import { TmuxManager } from '../src/tmux-manager.js';
import { SETTINGS_PATH } from '../src/web/route-helpers.js';

const ENV_KEYS = [
  'CODEMAN_PASSWORD',
  'CODEMAN_ALLOW_UNAUTHENTICATED_NETWORK',
  'CODEMAN_ALLOW_UNAUTHENTICATED_TUNNEL',
  'CODEMAN_MULTIUSER',
] as const;
const INITIAL = { tunnelEnabled: false, subagentTrackingEnabled: false };
let savedEnv: (string | undefined)[];
let server: WebServer | undefined;
let startTunnel: ReturnType<typeof vi.spyOn<TunnelManager, 'start'>>;

beforeEach(async () => {
  savedEnv = ENV_KEYS.map((key) => process.env[key]);
  for (const key of ENV_KEYS) delete process.env[key];
  vi.spyOn(TmuxManager, 'isTmuxAvailable').mockReturnValue(true);
  startTunnel = vi.spyOn(TunnelManager.prototype, 'start').mockImplementation(() => {});
  vi.spyOn(TunnelManager.prototype, 'isRunning').mockReturnValue(false);
  await mkdir(dirname(SETTINGS_PATH), { recursive: true });
  await writeFile(SETTINGS_PATH, JSON.stringify(INITIAL));
});

afterEach(async () => {
  try {
    await server?.stop();
  } finally {
    server = undefined;
    vi.restoreAllMocks();
    ENV_KEYS.forEach((key, i) => {
      if (savedEnv[i] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[i];
    });
  }
});

async function enableTunnel(instance: WebServer) {
  server = instance;
  const app = (server as unknown as { app: FastifyInstance }).app;
  // Only the transport is replaced: start() still builds the production route context and middleware.
  const listen = vi.spyOn(app, 'listen').mockImplementation(async () => {
    await app.ready();
    return 'http://127.0.0.1:0';
  });
  await server.start();
  expect(listen.mock.calls).toEqual([[{ port: 0, host: '127.0.0.1' }]]);
  startTunnel.mockClear();
  return app.inject({ method: 'PUT', url: '/api/settings', payload: { tunnelEnabled: true } });
}

describe('WebServer tunnel flag plumbing', () => {
  it('permits an unauthenticated tunnel through the startWebServer factory flag', async () => {
    const start = WebServer.prototype.start;
    // Keep the real factory and startup path, replacing only the socket transport before startup.
    vi.spyOn(WebServer.prototype, 'start').mockImplementation(async function (this: WebServer) {
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- Teardown must also stop an instance whose factory startup fails.
      server = this;
      const app = (this as unknown as { app: FastifyInstance }).app;
      const listen = vi.spyOn(app, 'listen').mockImplementation(async () => {
        await app.ready();
        return 'http://127.0.0.1:0';
      });
      await start.call(this);
      expect(listen.mock.calls).toEqual([[{ port: 0, host: '127.0.0.1' }]]);
    });
    server = await startWebServer(0, false, true, '127.0.0.1', undefined, false, '', true);
    const app = (server as unknown as { app: FastifyInstance }).app;
    startTunnel.mockClear();
    const res = await app.inject({ method: 'PUT', url: '/api/settings', payload: { tunnelEnabled: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: {} });
    expect(startTunnel.mock.calls).toEqual([[server.boundPort, false]]);
    expect(JSON.parse(await readFile(SETTINGS_PATH, 'utf8'))).toEqual({ ...INITIAL, tunnelEnabled: true });
  });

  it('permits an unauthenticated tunnel through the constructor flag', async () => {
    const res = await enableTunnel(new WebServer(0, false, true, '127.0.0.1', undefined, false, '', true));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: {} });
    expect(startTunnel.mock.calls).toEqual([[0, false]]);
    expect(JSON.parse(await readFile(SETTINGS_PATH, 'utf8'))).toEqual({ ...INITIAL, tunnelEnabled: true });
  });

  it('refuses an unauthenticated tunnel when the constructor flag is omitted', async () => {
    const res = await enableTunnel(new WebServer(0, false, true, '127.0.0.1', undefined, false, ''));
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ success: false, errorCode: 'OPERATION_FAILED', error: expect.any(String) });
    expect(startTunnel.mock.calls).toEqual([]);
    expect(await readFile(SETTINGS_PATH, 'utf8')).toBe(JSON.stringify(INITIAL));
  });
});
