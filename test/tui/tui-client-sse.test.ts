/**
 * @fileoverview Integration tests for the TUI's live-update stream.
 *
 * These run against a real loopback `text/event-stream` endpoint rather than a
 * mocked socket, because the behaviours that matter here are all socket-level:
 * a stream that ENDS, a stream that goes SILENT without erroring (the failure
 * mode `EventSource` cannot see, which is why the server heartbeats), and a
 * teardown that must leave no timer behind.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { TuiClient, type TuiApprovalEvent, type TuiSseStatusDetail } from '../../src/tui/tui-client.js';

let port: number;
let baseUrl: string;

interface Connection {
  url: string;
  headers: http.IncomingHttpHeaders;
  res: http.ServerResponse;
}

const connections: Connection[] = [];
/** Flipped by a test that wants every connect attempt to fail. */
let refuse = false;

let server: http.Server;
let client: TuiClient | null = null;

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

async function until(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('condition not met before the deadline');
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (!req.url?.startsWith('/api/events')) {
      res.writeHead(404).end();
      return;
    }
    if (refuse) {
      res.writeHead(503).end('busy');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    // Node holds headers back until the first body write; the real server sends
    // an `init` frame immediately, so flush to match it. Without this the
    // client never sees a response and every test here waits forever.
    res.flushHeaders();
    connections.push({ url: req.url, headers: req.headers, res });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
  connections.length = 0;
  refuse = false;
});

afterEach(() => {
  client?.close();
  client = null;
  for (const connection of connections) connection.res.end();
});

describe('subscribeEvents', () => {
  it('routes each frame to the handler that owns it', async () => {
    const resyncs: string[] = [];
    const approvals: TuiApprovalEvent[] = [];
    let planUsage: unknown = null;
    let init: unknown = null;

    client = new TuiClient({ baseUrl, password: 's3cret' });
    client.subscribeEvents({
      onInit: (state) => {
        init = state;
      },
      onResync: (event) => resyncs.push(event),
      onApproval: (event) => approvals.push(event),
      onPlanUsage: (usage) => {
        planUsage = usage;
      },
    });

    await until(() => connections.length === 1);
    const { res } = connections[0];
    res.write(frame('init', { version: '9.9.9', planUsage: { fiveHour: { usedPercentage: 5, resetAt: 1 } } }));
    res.write(frame('session:created', { id: 'a' }));
    // Split across writes on purpose: the parser must not need frame-aligned reads.
    res.write('event: approval:pending\ndata: {"id":"a:1","sessionId":"a",');
    res.write('"kind":"permission","createdAt":7}\n\n');
    res.write(frame('session:terminal', { id: 'a', data: 'noise' }));
    res.write(frame('sse:heartbeat', { t: 1 }));
    res.write(frame('session:statusTelemetry', { sessionId: 'a', fiveHour: { usedPercentage: 41, resetAt: 2 } }));

    await until(() => planUsage !== null);
    expect(init).toEqual({ version: '9.9.9', planUsage: { fiveHour: { usedPercentage: 5, resetAt: 1 } } });
    expect(approvals).toEqual([
      { kind: 'pending', item: { id: 'a:1', sessionId: 'a', kind: 'permission', createdAt: 7 } },
    ]);
    expect(planUsage).toEqual({ sessionId: 'a', fiveHour: { usedPercentage: 41, resetAt: 2 } });
    // The approval also regrouped a row, so it resyncs too. Terminal and
    // heartbeat frames never do.
    expect(resyncs).toEqual(['session:created', 'approval:pending']);
  });

  it('suppresses the terminal firehose by default and carries the auth header', async () => {
    client = new TuiClient({ baseUrl, password: 's3cret' });
    client.subscribeEvents({});
    await until(() => connections.length === 1);
    expect(connections[0].url).toBe('/api/events?sessions=tui-no-terminal');
    expect(connections[0].headers.authorization).toBe(`Basic ${Buffer.from('admin:s3cret').toString('base64')}`);
    expect(connections[0].headers.accept).toBe('text/event-stream');
  });

  it('subscribes to the terminal stream of named sessions when asked', async () => {
    client = new TuiClient({ baseUrl });
    client.subscribeEvents({}, { sessionIds: ['a', 'b'] });
    await until(() => connections.length === 1);
    expect(connections[0].url).toBe('/api/events?sessions=a%2Cb');
  });

  it('reconnects when the stream ends', async () => {
    const statuses: Array<[string, TuiSseStatusDetail]> = [];
    client = new TuiClient({ baseUrl });
    const stream = client.subscribeEvents(
      { onStatus: (status, detail) => statuses.push([status, detail]) },
      { baseBackoffMs: 10, maxBackoffMs: 20 }
    );

    await until(() => stream.status === 'connected');
    connections[0].res.end();
    await until(() => connections.length === 2 && stream.status === 'connected');
    expect(statuses.map(([status]) => status)).toEqual(['connected', 'reconnecting', 'connected']);
    expect(statuses[1][1].message).toBeTruthy();
  });

  it('reconnects when a live stream goes silent, which no socket error reports', async () => {
    client = new TuiClient({ baseUrl });
    client.subscribeEvents({}, { staleTimeoutMs: 150, checkIntervalMs: 25, baseBackoffMs: 10, maxBackoffMs: 20 });

    await until(() => connections.length === 1);
    // The server holds the connection open and says nothing: exactly the case
    // the watchdog exists for.
    await until(() => connections.length === 2);
    expect(connections).toHaveLength(2);
  });

  it('recommends polling once connecting keeps failing', async () => {
    refuse = true;
    const details: TuiSseStatusDetail[] = [];
    client = new TuiClient({ baseUrl });
    const stream = client.subscribeEvents(
      { onStatus: (_status, detail) => details.push(detail) },
      { baseBackoffMs: 10, maxBackoffMs: 20, pollingAfterFailures: 2 }
    );

    await until(() => details.length >= 2);
    expect(details[0]).toMatchObject({ attempt: 1, recommendPolling: false });
    expect(details[1]).toMatchObject({ attempt: 2, recommendPolling: true });
    expect(stream.recommendPolling).toBe(true);
    expect(stream.status).toBe('reconnecting');
  });

  it('stops reconnecting after close, so the process can exit', async () => {
    client = new TuiClient({ baseUrl });
    const stream = client.subscribeEvents({}, { baseBackoffMs: 10, maxBackoffMs: 20 });
    await until(() => connections.length === 1);

    connections[0].res.end();
    stream.close();
    const seen = connections.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(connections.length).toBe(seen);
  });

  it('closes every stream the client opened', async () => {
    client = new TuiClient({ baseUrl });
    client.subscribeEvents({});
    client.subscribeEvents({});
    await until(() => connections.length === 2);

    client.close();
    await until(() => connections.every((connection) => connection.res.socket === null || connection.res.destroyed));
    const seen = connections.length;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(connections.length).toBe(seen);
  });

  it('refuses to subscribe before the client knows where the server is', () => {
    const disconnected = new TuiClient({ port });
    expect(() => disconnected.subscribeEvents({})).toThrow(/connect\(\)/);
  });
});
