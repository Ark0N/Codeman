/**
 * @fileoverview The last message a CLI wrote, read through the response viewer's reader (the one the
 * Discord bridge posts from), with a message that asks SEVERAL questions: every question must come
 * back whole, in order, on its own line, and survive the split into Discord posts.
 *
 * Uses app.inject() with a temporary HOME and CODEX_HOME; no real ports or user transcripts.
 * Port: N/A
 *
 * Covered here: claude (JSONL transcript), codex (rollout), the codex-shaped pane CLIs (opencode,
 * gemini, antigravity, pi) and copilot (its own pane dialect). deepseek and omp read their own
 * transcript formats and are covered by their reader's tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { splitForDiscord } from '../../src/discord-bridge.js';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';

const QUESTIONS = [
  'Should the sweep run daily or hourly?',
  'Do you want archived threads deleted as well?',
  'Is one channel per Codeman acceptable?',
];
const INTRO = 'I have three questions before I continue:';
const OUTRO = 'Once you answer, I will apply the change.';

/** The message as the CLI wrote it: an intro, a numbered list of questions, an outro. */
const MESSAGE = [INTRO, '', ...QUESTIONS.map((q, i) => `${i + 1}. ${q}`), '', OUTRO].join('\n');

/** Every question present, in order, each on a line of its own. */
function expectWholeQuestions(text: string): void {
  let from = 0;
  for (const q of QUESTIONS) {
    const at = text.indexOf(q, from);
    expect(at, `missing or out of order: ${q}`).toBeGreaterThanOrEqual(from);
    from = at + q.length;
  }
  const lines = text.split('\n').map((l) => l.trim());
  for (const [i, q] of QUESTIONS.entries()) expect(lines.some((l) => l.endsWith(q))).toBe(true);
  expect(text).toContain(INTRO);
  expect(text).toContain(OUTRO);
  // What goes to Discord: the same questions after the split, joined back.
  expectWholeQuestionsAfterSplit(text);
}

function expectWholeQuestionsAfterSplit(text: string): void {
  const joined = splitForDiscord(text).join('\n');
  for (const q of QUESTIONS) expect(joined).toContain(q);
}

async function createHarness(): Promise<{ app: FastifyInstance; ctx: MockRouteContext }> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const ctx = createMockRouteContext();
  registerSessionRoutes(app, ctx);
  app.addHook('preSerialization', (req, _reply, payload: unknown, done) => {
    if (!req.url.startsWith('/api') || payload === null || typeof payload !== 'object') return done(null, payload);
    const p = payload as { success?: unknown };
    return done(null, p.success === undefined ? { success: true, data: payload } : payload);
  });
  installRouteErrorHandler(app);
  await app.ready();
  return { app, ctx };
}

describe('the last message with several questions, per CLI', () => {
  let harness: { app: FastifyInstance; ctx: MockRouteContext };
  let home: string;
  let prevHome: string | undefined;
  let prevCodexHome: string | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let session: any;

  async function lastText(): Promise<string> {
    const res = await harness.app.inject({ method: 'GET', url: `/api/sessions/${session.id}/last-response` });
    return JSON.parse(res.body).data.text as string;
  }

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'codeman-discord-last-'));
    prevHome = process.env.HOME;
    prevCodexHome = process.env.CODEX_HOME;
    process.env.HOME = home;
    process.env.CODEX_HOME = join(home, '.codex');
    harness = await createHarness();
    session = harness.ctx._session;
  });

  afterEach(async () => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    rmSync(home, { recursive: true, force: true });
    await harness.app.close();
  });

  it('claude: reads the whole message from the JSONL transcript', async () => {
    const id = '40568a29-d4eb-4eb6-b671-8401428e4f39';
    session.mode = 'claude';
    session.claudeSessionId = id;
    session.adoptClaudeSessionId = () => undefined;
    const dir = join(home, '.claude', 'projects', '-workspace');
    mkdirSync(dir, { recursive: true });
    const row = (type: string, text: string, ts: string) => ({
      type,
      timestamp: ts,
      message: { content: [{ type: 'text', text }] },
    });
    writeFileSync(
      join(dir, `${id}.jsonl`),
      [row('user', 'plan the cleanup', '2026-10-30T00:00:00Z'), row('assistant', MESSAGE, '2026-10-30T00:00:01Z')]
        .map((e) => JSON.stringify(e))
        .join('\n')
    );
    const text = await lastText();
    expect(text).toBe(MESSAGE);
    expectWholeQuestions(text);
  });

  it('codex: reads the whole message from the rollout', async () => {
    const uuid = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const workdir = join(home, 'work');
    mkdirSync(workdir, { recursive: true });
    session.mode = 'codex';
    session.workingDir = workdir;
    session.codexConfig = { resumeSessionId: uuid };
    const dir = join(home, '.codex', 'sessions', '2026', '10', '30');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `rollout-2026-10-30T00-00-00-${uuid}.jsonl`);
    const entries = [
      {
        timestamp: '2026-10-30T00:00:00Z',
        type: 'session_meta',
        payload: { id: uuid, cwd: workdir, originator: 'codex_cli_rs' },
      },
      {
        timestamp: '2026-10-30T00:00:01Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'plan the cleanup' },
      },
      {
        timestamp: '2026-10-30T00:00:02Z',
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: MESSAGE }] },
      },
    ];
    writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
    utimesSync(file, 1_750_000_000, 1_750_000_000);
    const text = await lastText();
    expectWholeQuestions(text);
  });

  for (const mode of ['opencode', 'gemini', 'antigravity', 'pi'] as const) {
    it(`${mode}: reads the whole message from the pane`, async () => {
      session.mode = mode;
      session.terminalBuffer = [
        '› plan the cleanup',
        '',
        'model · project · main · Ready · Context 100% left',
        '',
        '• Called write_file',
        '',
        MESSAGE,
      ].join('\n');
      expectWholeQuestions(await lastText());
    });
  }

  it('copilot: reads the whole message from the pane screen', async () => {
    session.mode = 'copilot';
    const screen = [
      ' ❯ plan the cleanup   10:01',
      '',
      ` ● ${INTRO}`,
      '',
      ...QUESTIONS.map((q, i) => `   ${i + 1}. ${q}`),
      '',
      `   ${OUTRO}`,
      '',
      ' ~/project  Session: 1 AIC used',
      '────────────────────────────────',
      ' ❯ ',
      '────────────────────────────────',
      ' ← open sidebar · / commands · ? help',
    ].join('\n');
    harness.ctx.mux = { ...(harness.ctx.mux as object), capturePaneText: () => screen } as typeof harness.ctx.mux;
    expectWholeQuestions(await lastText());
  });
});
