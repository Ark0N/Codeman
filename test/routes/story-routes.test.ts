/**
 * @fileoverview GET /api/sessions/:id/story (Story Mode) against invented transcripts in a temp dir,
 * plus the reader's incremental tail read. Port: N/A (app.inject()).
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerStoryRoutes } from '../../src/web/routes/story-routes.js';
import { clearStoryReaderCache, readStoryEntries } from '../../src/story-reader.js';
import { bash, demoTurn, edit, end, prompt, read, resetClock, result, said, tool } from '../story-fixtures.js';

const URL = '/api/sessions/test-session-1/story';
const jsonl = (lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

let dir: string;
let transcript: string;

async function setup(opts: { hookPath?: string | null; mode?: string; remote?: unknown; docker?: unknown } = {}) {
  const h = await createRouteTestHarness((app, ctx) => registerStoryRoutes(app, ctx));
  const session = h.ctx._session as unknown as Record<string, unknown>;
  if (opts.mode) session.mode = opts.mode;
  if (opts.remote) session.remote = opts.remote;
  if (opts.docker) session.docker = opts.docker;
  h.ctx.getTranscriptPath.mockReturnValue(opts.hookPath === undefined ? transcript : opts.hookPath);
  return h;
}

beforeEach(() => {
  resetClock();
  clearStoryReaderCache();
  dir = mkdtempSync(join(tmpdir(), 'story-route-'));
  transcript = join(dir, 'conversation.jsonl');
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/sessions/:id/story', () => {
  it('draws the newest turn of the hook-reported transcript', async () => {
    writeFileSync(transcript, jsonl([prompt('first job'), said('Done.'), end(2000), ...demoTurn()]));
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.supported).toBe(true);
    expect(body.data.turns.map((t: { prompt: string }) => t.prompt)).toEqual([
      'first job',
      'The checkout button does nothing on phones. Can you fix it?',
    ]);
    expect(body.data.page.panels.map((p: { kind: string }) => p.kind)).toEqual([
      'mission',
      'investigate',
      'plan',
      'backup',
      'loop',
      'save',
      'complete',
    ]);
    // Nothing a Read or an Edit result carried in full ever leaves the server.
    expect(res.body).not.toContain('FILE CONTENT');
    expect(res.body).not.toContain('WHOLE ORIGINAL FILE');
  });

  it('draws an older turn by id and answers page null for an unknown one', async () => {
    writeFileSync(transcript, jsonl([prompt('first job'), said('Done.'), end(2000), ...demoTurn()]));
    const { app } = await setup();
    const list = (await app.inject({ method: 'GET', url: URL })).json().data.turns;
    const older = await app.inject({ method: 'GET', url: `${URL}?turn=${encodeURIComponent(list[0].id)}` });
    expect(older.json().data.page).toMatchObject({ prompt: 'first job', complete: true });
    const gone = await app.inject({ method: 'GET', url: `${URL}?turn=nope` });
    expect(gone.json().data.page).toBeNull();
  });

  it('is supported with no turns when there is no transcript yet', async () => {
    const { app } = await setup({ hookPath: null });
    const res = await app.inject({ method: 'GET', url: URL });
    expect(res.json()).toEqual({ success: true, data: { supported: true, turns: [], page: null } });
  });

  it('answers unsupported for a CLI that writes no Claude transcript', async () => {
    const { app } = await setup({ mode: 'codex' });
    const data = (await app.inject({ method: 'GET', url: URL })).json().data;
    expect(data.supported).toBe(false);
    expect(data.reason).toMatch(/shell or another CLI/);
  });

  it('answers unsupported for remote and Docker sessions, whose transcript is not on this host', async () => {
    for (const where of [{ remote: { hostId: 'h1' } }, { docker: { containerName: 'c1' } }]) {
      clearStoryReaderCache();
      const { app } = await setup(where);
      const data = (await app.inject({ method: 'GET', url: URL })).json().data;
      expect(data).toMatchObject({ supported: false });
    }
  });

  it('never reads a hook path that is not a transcript', async () => {
    writeFileSync(join(dir, 'secret.txt'), jsonl(demoTurn()));
    const { app } = await setup({ hookPath: join(dir, 'secret.txt') });
    const res = await app.inject({ method: 'GET', url: URL });
    expect(res.json().data).toEqual({ supported: true, turns: [], page: null });
  });

  it('fails with OPERATION_FAILED when the transcript cannot be read', async () => {
    const { app } = await setup({ hookPath: join(dir, 'missing.jsonl') });
    const res = await app.inject({ method: 'GET', url: URL });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toMatchObject({ success: false, errorCode: 'OPERATION_FAILED' });
  });

  it('404s an unknown session', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/sessions/nope/story' });
    expect(res.statusCode).toBe(404);
  });

  it('answers 304 to a matching If-None-Match until the transcript changes', async () => {
    writeFileSync(transcript, jsonl(demoTurn()));
    const { app } = await setup();
    const first = await app.inject({ method: 'GET', url: URL });
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^W\/"story-/);
    expect(first.headers['cache-control']).toBe('no-cache');
    const again = await app.inject({ method: 'GET', url: URL, headers: { 'if-none-match': etag } });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
    appendFileSync(transcript, jsonl([prompt('next job')]));
    const changed = await app.inject({ method: 'GET', url: URL, headers: { 'if-none-match': etag } });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(etag);
    // Another turn of the same file is another page, so another tag.
    const other = await app.inject({
      method: 'GET',
      url: `${URL}?turn=x`,
      headers: { 'if-none-match': changed.headers.etag as string },
    });
    expect(other.statusCode).toBe(200);
  });

  it('reads further back when a long turn does not fit the first tail', async () => {
    // A prompt, then ~10 MB of tool results (Read results carry whole files), then the turn's end.
    const big = 'x'.repeat(100_000);
    const lines: unknown[] = [prompt('a turn longer than eight megabytes')];
    for (let i = 0; i < 100; i++) lines.push(...bash(`b${i}`, `cat big${i}.txt`, `Show file ${i}`, big));
    lines.push(end(60_000));
    writeFileSync(transcript, jsonl(lines));
    const { app } = await setup();
    const page = (await app.inject({ method: 'GET', url: URL })).json().data.page;
    expect(page).toMatchObject({ prompt: 'a turn longer than eight megabytes', partial: false, complete: true });
    expect(page.toolCalls).toBe(100);
    expect(page.panels[0].kind).toBe('mission');
  });

  it('a live turn grows as the transcript grows', async () => {
    writeFileSync(transcript, jsonl([prompt('go'), ...read('r1', '/w/a.ts')]));
    const { app } = await setup();
    const before = (await app.inject({ method: 'GET', url: URL })).json().data.page;
    expect(before.panels.map((p: { kind: string }) => p.kind)).toEqual(['mission', 'investigate']);
    expect(before.panels[1].live).toBe(true);

    appendFileSync(transcript, jsonl([...bash('b1', 'npm test', 'Run tests', ' Tests  4 passed (4)'), end(9000)]));
    const after = (await app.inject({ method: 'GET', url: URL })).json().data.page;
    expect(after.panels.map((p: { kind: string }) => p.kind)).toEqual(['mission', 'investigate', 'check', 'complete']);
    expect(after.complete).toBe(true);
  });
});

describe('GET /api/sessions/:id/story/helpers/:agentId', () => {
  const side = (lines: unknown[]) => lines.map((l) => ({ ...(l as object), isSidechain: true }));

  it("draws a helper's own steps, and the main page carries its agentId", async () => {
    writeFileSync(
      transcript,
      jsonl([
        prompt('Write the docs with a helper'),
        tool('a1', 'Agent', {
          description: 'Write README',
          subagent_type: 'general-purpose',
          prompt: 'Write README.md',
        }),
        result('a1', 'Done', {
          toolUseResult: {
            status: 'completed',
            agentId: 'abc123',
            content: [{ type: 'text', text: 'README written.' }],
            totalToolUseCount: 2,
          },
        }),
        end(5000),
      ])
    );
    const sub = join(dir, 'conversation', 'subagents');
    mkdirSync(sub, { recursive: true });
    writeFileSync(
      join(sub, 'agent-abc123.jsonl'),
      jsonl(
        side([
          prompt('Write README.md for the script'),
          ...read('r1', '/w/script.sh'),
          ...edit('e1', '/w/README.md', ['+# Script', '+Usage'], 1),
        ])
      )
    );
    writeFileSync(
      join(sub, 'agent-abc123.meta.json'),
      JSON.stringify({ agentType: 'general-purpose', description: 'Write README', finished: true })
    );
    const { app } = await setup();

    const main = (await app.inject({ method: 'GET', url: URL })).json().data.page;
    expect(main.events.find((e: { helper?: unknown }) => e.helper).helper).toMatchObject({
      agentId: 'abc123',
      toolUses: 2,
    });

    const res = await app.inject({ method: 'GET', url: `${URL}/helpers/abc123` });
    const data = res.json().data;
    expect(data.helper).toEqual({
      agentId: 'abc123',
      type: 'general-purpose',
      description: 'Write README',
      finished: true,
    });
    expect(data.page.prompt).toBe('Write README.md for the script');
    expect(data.page.panels.map((p: { kind: string }) => p.kind)).toEqual([
      'mission',
      'investigate',
      'fix',
      'complete',
    ]);
    expect(res.headers.etag).toMatch(/^W\/"story-/);
    const again = await app.inject({
      method: 'GET',
      url: `${URL}/helpers/abc123`,
      headers: { 'if-none-match': res.headers.etag as string },
    });
    expect(again.statusCode).toBe(304);
  });

  it('answers page null for a helper that has not written anything yet', async () => {
    writeFileSync(transcript, jsonl(demoTurn()));
    const { app } = await setup();
    const data = (await app.inject({ method: 'GET', url: `${URL}/helpers/notyet1` })).json().data;
    expect(data).toEqual({ supported: true, helper: { agentId: 'notyet1' }, page: null });
  });

  it('refuses an id that could leave the subagents folder', async () => {
    const { app } = await setup();
    for (const bad of ['..', '..%2F..%2Fsecret', 'a.b', 'x'.repeat(65)]) {
      const res = await app.inject({ method: 'GET', url: `${URL}/helpers/${bad}` });
      // `..` never reaches the route (the URL is normalized first: 404); the rest hit the id check (400).
      expect([400, 404], bad).toContain(res.statusCode);
    }
  });
});

describe('readStoryEntries', () => {
  it('leaves a line that is still being written for the next read', async () => {
    const full = JSON.stringify(prompt('half written'));
    writeFileSync(transcript, jsonl([prompt('one')]) + full.slice(0, 20));
    const first = await readStoryEntries(transcript);
    expect(first.entries.map((e) => e.k)).toEqual(['prompt']);
    appendFileSync(transcript, full.slice(20) + '\n');
    const second = await readStoryEntries(transcript);
    expect(second.entries.filter((e) => e.k === 'prompt')).toHaveLength(2);
  });

  it('starts over when the file was replaced by a shorter one', async () => {
    writeFileSync(transcript, jsonl([prompt('one'), prompt('two'), prompt('three')]));
    await readStoryEntries(transcript);
    writeFileSync(transcript, jsonl([prompt('new')]));
    const again = await readStoryEntries(transcript);
    expect(again.entries.map((e) => (e.k === 'prompt' ? e.text : e.k))).toEqual(['new']);
  });

  it('shares one read between concurrent callers', async () => {
    writeFileSync(transcript, jsonl(demoTurn()));
    const [a, b] = await Promise.all([readStoryEntries(transcript), readStoryEntries(transcript)]);
    expect(a.entries).toBe(b.entries);
  });
});
