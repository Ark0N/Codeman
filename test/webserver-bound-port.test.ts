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

  it('registers bounded agent routes with the server route modules', async () => {
    const { Session } = await import('../src/session.js');
    const session = new Session({ id: 'agent-route-wiring', workingDir: process.env.HOME!, mode: 'shell' });
    const sessions = (server as unknown as { sessions: Map<string, typeof session> }).sessions;
    sessions.set(session.id, session);
    const { mkdirSync, rmSync, writeFileSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const { SETTINGS_PATH } = await import('../src/web/route-helpers.js');
    const setEnabled = (on: boolean) => {
      mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
      writeFileSync(SETTINGS_PATH, JSON.stringify({ agentCoordinationEnabled: on }));
    };
    try {
      const prefix = `http://127.0.0.1:${server.boundPort}/api/v1/sessions/${session.id}`;
      // Opt-in: off, the /api/v1 alias of every route refuses with 403 FORBIDDEN.
      setEnabled(false);
      for (const [method, verb] of [
        ['GET', 'inspect'],
        ['POST', 'stage'],
        ['POST', 'submit'],
      ] as const) {
        const refused = await fetch(prefix + '/' + verb, {
          method,
          ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
        });
        expect(refused.status).toBe(403);
        const body = await refused.json();
        expect(body.errorCode).toBe('FORBIDDEN');
        expect(body.error).toContain('agentCoordinationEnabled');
      }
      setEnabled(true);
      const inspected = await fetch(prefix + '/inspect');
      expect(inspected.status).toBe(200);
      expect((await inspected.json()).data.source).toBe('pane-snapshot');
      for (const [verb, body] of [
        ['stage', { message: 'hello' }],
        ['submit', { stageId: '11111111-1111-4111-8111-111111111111', confirmSha: 'a'.repeat(64) }],
      ] as const) {
        const response = await fetch(prefix + '/' + verb, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        expect(response.status).toBe(409);
        expect((await response.json()).errorCode).toBe('CONFLICT');
      }
    } finally {
      rmSync(SETTINGS_PATH, { force: true });
      sessions.delete(session.id);
      await session.stop(false);
    }
  });

  it('exports the real port to the panes as CODEMAN_API_URL', () => {
    expect(process.env.CODEMAN_API_URL).toBe(`http://127.0.0.1:${socketPort()}`);
  });
});
