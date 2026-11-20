/** Saved transcript routes (src/web/routes/transcript-routes.ts) via app.inject(). */
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { registerTranscriptRoutes } from '../../src/web/routes/transcript-routes.js';
import { TranscriptStore } from '../../src/transcript-store.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { createMockRouteContext } from '../mocks/index.js';

const SID = 'aaaaaaaa-1111-4111-8111-111111111111';
let dir: string;
let store: TranscriptStore;
let app: FastifyInstance;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'transcript-routes-'));
  store = new TranscriptStore(() => dir);
  await store.load(true);
  app = Fastify({ logger: false });
  registerTranscriptRoutes(app, createMockRouteContext({ sessionId: SID }) as never, store);
  installRouteErrorHandler(app);
  await app.ready();
});
afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('transcript routes', () => {
  it('searches a session transcript', async () => {
    await store.save(SID, 'one\nneedle here\nthree');
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SID}/transcript/search?q=NEEDLE` });
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.total).toBe(1);
    expect(body.data.matches[0].text).toBe('needle here');
  });

  it('returns the lines around a hit, clamped to the file', async () => {
    await store.save(SID, 'a\nb\nc\nd\ne');
    const res = await app.inject({ method: 'GET', url: `/api/sessions/${SID}/transcript/lines?line=2&radius=1` });
    expect(res.json().data).toEqual({ start: 1, lines: ['a', 'b', 'c'] });
    const past = await app.inject({ method: 'GET', url: `/api/sessions/${SID}/transcript/lines?line=99` });
    expect(past.json().data).toBeNull();
    const bad = await app.inject({ method: 'GET', url: `/api/sessions/${SID}/transcript/lines?line=0` });
    expect(bad.json().success).toBe(false);
  });

  it('answers null data when nothing is saved and 400 without a query', async () => {
    const none = await app.inject({ method: 'GET', url: `/api/sessions/${SID}/transcript/search?q=x` });
    expect(none.json()).toEqual({ success: true, data: null });
    const bad = await app.inject({ method: 'GET', url: `/api/sessions/${SID}/transcript/search` });
    expect(bad.json().success).toBe(false);
  });

  it('404s for a session that does not exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sessions/nope/transcript/search?q=x' });
    expect(res.statusCode).toBe(404);
  });

  it('deletes one session transcript, and all of them', async () => {
    await store.save(SID, 'a');
    await store.save('other', 'b');
    expect((await app.inject({ method: 'DELETE', url: `/api/sessions/${SID}/transcript` })).json().success).toBe(true);
    expect(readdirSync(dir)).toEqual(['other.txt']);
    const all = await app.inject({ method: 'DELETE', url: '/api/transcripts' });
    expect(all.json().data.removed).toBe(1);
    expect(readdirSync(dir)).toEqual([]);
  });
});
