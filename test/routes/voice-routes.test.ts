/**
 * @fileoverview Claude voice dictation routes.
 *
 * Covers the status endpoint's gating and the full relay round trip against a
 * mock upstream (a local `ws` server speaking the Anthropic voice-stream
 * protocol, selected via CODEMAN_VOICE_STREAM_BASE). WebSocket routes need a
 * real listening server — app.inject() cannot do upgrades.
 *
 * What these pin, beyond "it works":
 * - the OAuth token never appears in an API response,
 * - the socket refuses exactly what the status endpoint calls unavailable,
 * - a cross-site upgrade cannot open a stream on the operator's subscription.
 *
 * Port: ephemeral (`port: 0` for the routes and the mock upstream)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import WebSocket, { WebSocketServer } from 'ws';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';
import { registerVoiceRoutes, _resetVoiceStreamCountForTesting } from '../../src/web/routes/voice-routes.js';
import { MAX_CONCURRENT_STREAMS } from '../../src/config/voice.js';

// SAFETY (2026-08-29): anchor on the REDIRECTED test HOME (process.env.HOME,
// which test/setup.ts points at a throwaway dir). `os.homedir()` follows it too,
// but this file writes and deletes `~/.claude/.credentials.json`, the one file
// where a wrong anchor would sign the developer out of their own CLI, so it
// fails loudly if setup.ts did not run rather than trusting any fallback.
function testHome(): string {
  if (!process.env.HOME) throw new Error('process.env.HOME unset — test/setup.ts must run first');
  return process.env.HOME;
}

function writeCredentials(expiresAt: number | undefined): void {
  const dir = join(testHome(), '.claude');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt, subscriptionType: 'max' } })
  );
}

function removeCredentials(): void {
  rmSync(join(testHome(), '.claude', '.credentials.json'), { force: true });
}

/** Both assigned by the OS on every listen (`port: 0`); see beforeEach. */
let PORT = 0;
let UPSTREAM_PORT = 0;
const TOKEN = 'sk-ant-oat01-voice-route-test';

/** State captured by the mock upstream, so tests can assert what Codeman sent. */
interface UpstreamCapture {
  headers: Record<string, string | string[] | undefined>;
  url: string;
  binaryFrames: Buffer[];
  textFrames: string[];
  socket: WebSocket | null;
}

function waitForClose(ws: WebSocket, timeoutMs = 3000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS close timeout')), timeoutMs);
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
  });
}

/** Wait for the first message satisfying `match`, ignoring earlier frames. */
function waitForMessage(
  ws: WebSocket,
  match: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 3000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS message timeout')), timeoutMs);
    const onMessage = (raw: WebSocket.RawData) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (!match(msg)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(msg);
    };
    ws.on('message', onMessage);
  });
}

function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() > deadline) return reject(new Error('condition not met in time'));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe('voice-routes', () => {
  let app: FastifyInstance;
  let ctx: MockRouteContext;
  let upstream: WebSocketServer;
  let capture: UpstreamCapture;
  let voiceEnabled: boolean;

  beforeEach(async () => {
    _resetVoiceStreamCountForTesting();
    voiceEnabled = true;
    capture = { headers: {}, url: '', binaryFrames: [], textFrames: [], socket: null };

    upstream = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    upstream.on('connection', (socket, req) => {
      capture.headers = req.headers;
      capture.url = req.url ?? '';
      capture.socket = socket;
      socket.on('message', (raw, isBinary) => {
        if (isBinary) capture.binaryFrames.push(Buffer.from(raw as Buffer));
        else capture.textFrames.push(String(raw));
      });
    });
    await new Promise<void>((resolve) => upstream.once('listening', resolve));
    UPSTREAM_PORT = (upstream.address() as AddressInfo).port;
    process.env.CODEMAN_VOICE_STREAM_BASE = `ws://127.0.0.1:${UPSTREAM_PORT}`;

    writeCredentials(Date.now() + 3_600_000);

    app = Fastify({ logger: false });
    await app.register(fastifyWebsocket);
    ctx = createMockRouteContext();
    ctx.getClaudeVoiceEnabled = (async () => voiceEnabled) as typeof ctx.getClaudeVoiceEnabled;
    registerVoiceRoutes(app, ctx as never, () => ({ bindHost: '127.0.0.1', allowedHosts: [], tunnelHost: null }));
    await app.listen({ port: 0, host: '127.0.0.1' });
    PORT = (app.server.address() as AddressInfo).port;
  });

  afterEach(async () => {
    delete process.env.CODEMAN_VOICE_STREAM_BASE;
    removeCredentials();
    await app.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });

  describe('GET /api/voice/status', () => {
    it('reports available with display metadata when enabled and signed in', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/voice/status' });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toMatchObject({ available: true, subscriptionType: 'max' });
    });

    it('never returns the access token', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/voice/status' });
      expect(res.body).not.toContain(TOKEN);
      expect(res.body).not.toContain('sk-ant');
    });

    it('reports disabled when the setting is off, without touching credentials', async () => {
      voiceEnabled = false;
      const res = await app.inject({ method: 'GET', url: '/api/voice/status' });
      expect(res.json().data).toEqual({ available: false, reason: 'disabled' });
    });

    it('reports no-credentials when nothing is signed in', async () => {
      removeCredentials();
      const res = await app.inject({ method: 'GET', url: '/api/voice/status' });
      expect(res.json().data).toEqual({ available: false, reason: 'no-credentials' });
    });

    it('reports expired separately, so the UI can say how to fix it', async () => {
      writeCredentials(Date.now() - 1000);
      const res = await app.inject({ method: 'GET', url: '/api/voice/status' });
      expect(res.json().data.available).toBe(false);
      expect(res.json().data.reason).toBe('expired');
    });
  });

  describe('GET /ws/voice/stream', () => {
    it('relays audio up and transcripts down, finalizing on request', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/voice/stream?language=en&keyterms=tmux,respawn`);
      const ready = waitForMessage(ws, (m) => m.t === 'ready');
      await new Promise((resolve) => ws.once('open', resolve));
      await ready;

      ws.send(Buffer.alloc(3200));
      await waitUntil(() => capture.binaryFrames.length > 0);
      expect(capture.binaryFrames[0].length).toBe(3200);

      const interim = waitForMessage(ws, (m) => m.t === 'transcript' && m.final === false);
      capture.socket!.send(JSON.stringify({ type: 'TranscriptText', data: 'run the type check' }));
      expect((await interim).text).toBe('run the type check');

      ws.send(JSON.stringify({ t: 'finalize' }));
      await waitUntil(() => capture.textFrames.some((f) => f.includes('CloseStream')));

      const final = waitForMessage(ws, (m) => m.t === 'transcript' && m.final === true);
      capture.socket!.send(JSON.stringify({ type: 'TranscriptEndpoint' }));
      expect((await final).text).toBe('run the type check');

      const { code } = await waitForClose(ws);
      expect(code).toBe(1000);
    });

    it('authenticates upstream with the bearer token and forwards keyterms', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/voice/stream?keyterms=tmux,respawn`);
      await waitForMessage(ws, (m) => m.t === 'ready');
      expect(capture.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(capture.headers['x-config-keyterms']).toBe('tmux,respawn');
      expect(capture.url).toContain('encoding=linear16');
      expect(capture.url).toContain('sample_rate=16000');
      ws.close();
    });

    it('pings upstream immediately so the idle gap before first audio cannot drop it', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/voice/stream`);
      await waitForMessage(ws, (m) => m.t === 'ready');
      await waitUntil(() => capture.textFrames.some((f) => f.includes('KeepAlive')));
      ws.close();
    });

    it('surfaces an upstream transcription error to the browser', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/voice/stream`);
      await waitForMessage(ws, (m) => m.t === 'ready');
      const err = waitForMessage(ws, (m) => m.t === 'error');
      capture.socket!.send(JSON.stringify({ type: 'TranscriptError', description: 'no audio' }));
      expect((await err).message).toBe('no audio');
      ws.close();
    });

    it('drops an oversized audio frame instead of relaying it', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/voice/stream`);
      await waitForMessage(ws, (m) => m.t === 'ready');

      ws.send(Buffer.alloc(200_000));
      ws.send(Buffer.alloc(1600));
      await waitUntil(() => capture.binaryFrames.length > 0);
      // The legal frame arrived; the oversized one was never forwarded.
      expect(capture.binaryFrames.every((f) => f.length === 1600)).toBe(true);
      ws.close();
    });

    it('closes 4004 with the reason when the setting is off', async () => {
      voiceEnabled = false;
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/voice/stream`);
      const { code, reason } = await waitForClose(ws);
      expect(code).toBe(4004);
      expect(reason).toBe('disabled');
    });

    it('closes 4004 when no Claude login exists on the server', async () => {
      removeCredentials();
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/voice/stream`);
      const { code, reason } = await waitForClose(ws);
      expect(code).toBe(4004);
      expect(reason).toBe('no-credentials');
    });

    it('closes 4004 rather than streaming on an expired login', async () => {
      writeCredentials(Date.now() - 1000);
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/voice/stream`);
      const { code, reason } = await waitForClose(ws);
      expect(code).toBe(4004);
      expect(reason).toBe('expired');
    });

    it('refuses a cross-site upgrade (a foreign page must not spend the subscription)', async () => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/voice/stream`, {
        headers: { origin: 'https://evil.example' },
      });
      const { code } = await waitForClose(ws);
      expect(code).toBe(4003);
      expect(capture.socket).toBeNull();
    });

    it('caps concurrent streams', async () => {
      const open: WebSocket[] = [];
      for (let i = 0; i < MAX_CONCURRENT_STREAMS; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/voice/stream`);
        await waitForMessage(ws, (m) => m.t === 'ready');
        open.push(ws);
      }
      const extra = new WebSocket(`ws://127.0.0.1:${PORT}/ws/voice/stream`);
      const { code, reason } = await waitForClose(extra);
      expect(code).toBe(4008);
      expect(reason).toBe('Too many voice streams');
      for (const ws of open) ws.close();
    });

    it('frees a stream slot when the browser hangs up', async () => {
      const first = new WebSocket(`ws://127.0.0.1:${PORT}/ws/voice/stream`);
      await waitForMessage(first, (m) => m.t === 'ready');
      first.close();
      await waitForClose(first);

      // The slot is reusable: MAX_CONCURRENT more streams must still be admitted.
      const reopened: WebSocket[] = [];
      for (let i = 0; i < MAX_CONCURRENT_STREAMS; i++) {
        const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/voice/stream`);
        await waitForMessage(ws, (m) => m.t === 'ready');
        reopened.push(ws);
      }
      for (const ws of reopened) ws.close();
    });
  });
});
