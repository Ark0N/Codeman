/**
 * @fileoverview Claude transcript normalization tests for the response viewer.
 *
 * Uses app.inject() with a temporary HOME; no real ports or user transcripts.
 * Port: N/A
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { ApiErrorCode, httpStatusForErrorCode } from '../../src/types.js';
import { createMockRouteContext, type MockRouteContext } from '../mocks/index.js';

interface LocalHarness {
  app: FastifyInstance;
  ctx: MockRouteContext;
}

async function createEnvelopeHarness(): Promise<LocalHarness> {
  const app = Fastify({ logger: false });
  await app.register(fastifyCookie);
  const ctx = createMockRouteContext();
  registerSessionRoutes(app, ctx);

  app.addHook('preSerialization', (req, reply, payload: unknown, done) => {
    if (!req.url.startsWith('/api') || payload === null || typeof payload !== 'object') {
      return done(null, payload);
    }
    const response = payload as { success?: unknown; errorCode?: unknown };
    if (response.success === false) {
      if (reply.statusCode === 200 && typeof response.errorCode === 'string') {
        reply.code(httpStatusForErrorCode(response.errorCode as ApiErrorCode));
      }
      return done(null, payload);
    }
    if (response.success === true) return done(null, payload);
    return done(null, { success: true, data: payload });
  });

  installRouteErrorHandler(app);
  await app.ready();
  return { app, ctx };
}

const userEntry = (text: string, extras: Record<string, unknown> = {}) => ({
  type: 'user',
  timestamp: '2026-07-21T00:00:00Z',
  message: { content: [{ type: 'text', text }] },
  ...extras,
});

const assistantEntry = (text: string, timestamp: string) => ({
  type: 'assistant',
  timestamp,
  message: { content: [{ type: 'text', text }] },
});

/**
 * A prompt typed while Claude is working. Shape copied from a real CLI 2.1.251
 * row: the CLI's own queue entries carry commandMode 'task-notification' and no
 * `origin` key at all, which is what separates them from the human's.
 */
const queuedEntry = (prompt: string, timestamp: string, kind: 'human' | 'task-notification' = 'human') => ({
  type: 'attachment',
  timestamp,
  attachment: {
    type: 'queued_command',
    prompt,
    source_uuid: `src-${timestamp}`,
    commandMode: kind === 'human' ? 'prompt' : 'task-notification',
    ...(kind === 'human' ? { origin: { kind: 'human' } } : {}),
    timestamp,
  },
});

describe('GET /api/sessions/:id/last-response (claude)', () => {
  let harness: LocalHarness;
  let testHome: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    testHome = mkdtempSync(join(tmpdir(), 'codeman-claude-rv-'));
    previousHome = process.env.HOME;
    process.env.HOME = testHome;
    harness = await createEnvelopeHarness();
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(testHome, { recursive: true, force: true });
    await harness.app.close();
  });

  function writeTranscript(sessionId: string, entries: unknown[]): void {
    const projectDir = join(testHome, '.claude', 'projects', '-workspace');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(join(projectDir, `${sessionId}.jsonl`), entries.map((entry) => JSON.stringify(entry)).join('\n'));
  }

  async function getLastResponse(sessionId: string, full = false) {
    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/last-response${full ? '?context=full' : ''}`,
    });
    return { response, body: JSON.parse(response.body) };
  }

  it('recovers a placeholder tmux session by UUID prefix and renders one message per model message', async () => {
    const restoredId = 'restored-40568a29';
    const conversationId = '40568a29-d4eb-4eb6-b671-8401428e4f39';
    const session = harness.ctx._session as typeof harness.ctx._session & {
      claudeSessionId: string;
      adoptClaudeSessionId: ReturnType<typeof vi.fn>;
    };
    harness.ctx.sessions.delete(session.id);
    session.id = restoredId;
    session.mode = 'claude';
    session.workingDir = '/wrong/recovered/cwd';
    session.claudeSessionId = restoredId;
    session.adoptClaudeSessionId = vi.fn((newId: string) => {
      session.claudeSessionId = newId;
    });
    harness.ctx.sessions.set(restoredId, session);

    writeTranscript(conversationId, [
      userEntry('first prompt'),
      userEntry('first prompt'), // restore replay before any assistant output
      { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'hidden' }] } },
      assistantEntry('Checking the files.', '2026-07-21T00:00:01Z'),
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tool-1' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1' }] } },
      assistantEntry('Checking the files.', '2026-07-21T00:00:02Z'), // replayed snapshot
      assistantEntry('The first result is ready.', '2026-07-21T00:00:03Z'),
      userEntry('[Image dimensions generated by the CLI]', { isMeta: true }),
      userEntry('<command-name>/status</command-name>'),
      userEntry('Another Claude session sent a message: <teammate-message>done</teammate-message>'),
      userEntry('<task-notification>background agent completed</task-notification>'),
      userEntry('This session is being continued from a previous conversation', { isCompactSummary: true }),
      userEntry('second prompt'),
      assistantEntry('First half.', '2026-07-21T00:00:04Z'),
      { ...assistantEntry('sidechain text', '2026-07-21T00:00:05Z'), isSidechain: true },
      assistantEntry('Second half.', '2026-07-21T00:00:06Z'),
    ]);

    const full = await getLastResponse(restoredId, true);
    expect(full.response.statusCode).toBe(200);
    expect(full.body.data).toEqual({
      text: 'Second half.',
      timestamp: '2026-07-21T00:00:06Z',
      // #169's guarantees all still hold and this array proves them: the replayed
      // 'first prompt' row, the replayed 'Checking the files.' snapshot, the
      // sidechain row and all five synthetic rows are absent. Only the GROUPING
      // UNIT narrows, from one card per human turn to one card per model
      // message, carried by `turn` instead of by a '\n\n' joiner.
      messages: [
        {
          kind: 'prompt',
          label: 'Prompt',
          role: 'user',
          text: 'first prompt',
          timestamp: '2026-07-21T00:00:00Z',
          turn: 1,
        },
        {
          kind: 'response',
          label: 'Response',
          role: 'assistant',
          text: 'Checking the files.',
          timestamp: '2026-07-21T00:00:01Z',
          turn: 1,
        },
        {
          kind: 'response',
          label: 'Response',
          role: 'assistant',
          text: 'The first result is ready.',
          timestamp: '2026-07-21T00:00:03Z',
          turn: 1,
        },
        {
          kind: 'prompt',
          label: 'Prompt',
          role: 'user',
          text: 'second prompt',
          timestamp: '2026-07-21T00:00:00Z',
          turn: 2,
        },
        {
          kind: 'response',
          label: 'Response',
          role: 'assistant',
          text: 'First half.',
          timestamp: '2026-07-21T00:00:04Z',
          turn: 2,
        },
        {
          kind: 'response',
          label: 'Response',
          role: 'assistant',
          text: 'Second half.',
          timestamp: '2026-07-21T00:00:06Z',
          turn: 2,
        },
      ],
    });
    expect(session.adoptClaudeSessionId).toHaveBeenCalledWith(conversationId);

    const brief = await getLastResponse(restoredId);
    expect(brief.body.data).toEqual({ text: 'Second half.', timestamp: '2026-07-21T00:00:06Z' });
  });

  it('keeps an identical user prompt when it occurs again after an assistant response', async () => {
    const sessionId = harness.ctx._session.id;
    const session = harness.ctx._session as typeof harness.ctx._session & {
      claudeSessionId: string;
      adoptClaudeSessionId: ReturnType<typeof vi.fn>;
    };
    session.claudeSessionId = sessionId;
    session.adoptClaudeSessionId = vi.fn();
    writeTranscript(sessionId, [
      userEntry('continue'),
      assistantEntry('First answer.', '2026-07-21T00:00:01Z'),
      userEntry('continue'),
      assistantEntry('Second answer.', '2026-07-21T00:00:02Z'),
    ]);

    const { body } = await getLastResponse(sessionId, true);
    expect(body.data.messages.map((message: { role: string; text: string }) => [message.role, message.text])).toEqual([
      ['user', 'continue'],
      ['assistant', 'First answer.'],
      ['user', 'continue'],
      ['assistant', 'Second answer.'],
    ]);
  });

  /**
   * A prompt typed while Claude is working is absorbed mid-turn and recorded
   * ONLY as an attachment row — 160 of the 347 user cards across a real
   * ~/.claude/projects. Reading only `user` rows lost them outright AND lost the
   * turn boundary they carry, which is what let an assistant run fuse.
   */
  it('surfaces a prompt the user queued while Claude was working', async () => {
    const sessionId = harness.ctx._session.id;
    const session = harness.ctx._session as typeof harness.ctx._session & {
      claudeSessionId: string;
      adoptClaudeSessionId: ReturnType<typeof vi.fn>;
    };
    session.claudeSessionId = sessionId;
    session.adoptClaudeSessionId = vi.fn();
    writeTranscript(sessionId, [
      userEntry('start the job'),
      assistantEntry('Working on it.', '2026-07-21T00:00:01Z'),
      queuedEntry('actually use PowerShell', '2026-07-21T00:00:02Z'),
      queuedEntry('background agent finished', '2026-07-21T00:00:03Z', 'task-notification'),
      // The most common attachment subtype; it carries no prompt/origin at all.
      { type: 'attachment', attachment: { type: 'total_tokens_reminder', tokens: 1 } },
      assistantEntry('Switched to PowerShell.', '2026-07-21T00:00:04Z'),
    ]);

    const { body } = await getLastResponse(sessionId, true);
    const messages = body.data.messages as Array<{ role: string; text: string; turn: number; queued?: boolean }>;
    expect(messages.map((message) => [message.role, message.text, message.turn])).toEqual([
      ['user', 'start the job', 1],
      ['assistant', 'Working on it.', 1],
      ['user', 'actually use PowerShell', 2],
      ['assistant', 'Switched to PowerShell.', 2],
    ]);
    expect(messages[2].queued).toBe(true);
    expect(messages[0].queued).toBeUndefined();
  });

  /**
   * Mostly forward insurance. A queued prompt re-emitted as a `user` row AFTER
   * its attachment row — the shape that would double-render — is not observed on
   * CLI 2.1.220-2.1.251 (0 of 163 measured 2026-09-01). The only exact-text
   * collisions are three occurrences of the same one-character nudge in a single
   * transcript, and the guard fires on one of them, which is why 163 human
   * queued rows yield 162 cards. The guard exists so a CLI that starts writing
   * both rows does not double every absorbed prompt.
   */
  it('renders an absorbed prompt once when the CLI also writes it as a user row', async () => {
    const sessionId = harness.ctx._session.id;
    const session = harness.ctx._session as typeof harness.ctx._session & {
      claudeSessionId: string;
      adoptClaudeSessionId: ReturnType<typeof vi.fn>;
    };
    session.claudeSessionId = sessionId;
    session.adoptClaudeSessionId = vi.fn();
    writeTranscript(sessionId, [
      userEntry('go'),
      assistantEntry('OK.', '2026-07-21T00:00:01Z'),
      queuedEntry('switch to PowerShell', '2026-07-21T00:00:02Z'),
      userEntry('switch to PowerShell'),
      assistantEntry('Done.', '2026-07-21T00:00:03Z'),
    ]);

    const { body } = await getLastResponse(sessionId, true);
    const messages = body.data.messages as Array<{ role: string; text: string; queued?: boolean }>;
    const absorbed = messages.filter((message) => message.role === 'user' && message.text === 'switch to PowerShell');
    expect(absorbed).toHaveLength(1);
    expect(absorbed[0].queued).toBe(true);
  });

  /**
   * The brief response is what agent pollers hash (skills/codeman/preamble.sh
   * last_text()). It must stay the last assistant row and must NEVER be derived
   * from messages.at(-1), which can be the user's own queued prompt.
   */
  it('keeps the brief response on the last assistant row while a turn is in flight', async () => {
    const sessionId = harness.ctx._session.id;
    const session = harness.ctx._session as typeof harness.ctx._session & {
      claudeSessionId: string;
      adoptClaudeSessionId: ReturnType<typeof vi.fn>;
    };
    session.claudeSessionId = sessionId;
    session.adoptClaudeSessionId = vi.fn();
    writeTranscript(sessionId, [
      userEntry('go'),
      assistantEntry('Let me look.', '2026-07-21T00:00:01Z'),
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] } },
    ]);

    const brief = await getLastResponse(sessionId);
    expect(brief.body.data).toEqual({ text: 'Let me look.', timestamp: '2026-07-21T00:00:01Z' });

    const { body } = await getLastResponse(sessionId, true);
    const messages = body.data.messages as Array<{ role: string; text: string }>;
    expect(messages.at(-1)).toMatchObject({ role: 'assistant', text: 'Let me look.' });
    expect(body.data.text).toBe('Let me look.');
  });

  it('answers context=turn with the last answered turn only, text still on the last row', async () => {
    const sessionId = harness.ctx._session.id;
    const session = harness.ctx._session as typeof harness.ctx._session & {
      claudeSessionId: string;
      adoptClaudeSessionId: ReturnType<typeof vi.fn>;
    };
    session.claudeSessionId = sessionId;
    session.adoptClaudeSessionId = vi.fn();
    writeTranscript(sessionId, [
      userEntry('first'),
      assistantEntry('Old answer.', '2026-07-21T00:00:01Z'),
      userEntry('second'),
      assistantEntry('Looking at the file.', '2026-07-21T00:00:02Z'),
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'x' }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] } },
      assistantEntry('The bug is on line 3.', '2026-07-21T00:00:03Z'),
      assistantEntry('Done.', '2026-07-21T00:00:04Z'),
      // A prompt queued after the answer opens a new, unanswered turn.
      queuedEntry('third', '2026-07-21T00:00:05Z'),
    ]);

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/last-response?context=turn`,
    });
    expect(response.statusCode).toBe(200);
    const data = JSON.parse(response.body).data as {
      text: string;
      timestamp: string;
      messages: Array<{ role: string; text: string; turn: number }>;
    };
    // The frozen brief contract holds: still the last assistant row.
    expect(data.text).toBe('Done.');
    expect(data.timestamp).toBe('2026-07-21T00:00:04Z');
    // The turn view is that row's whole turn, assistant rows only, and not the
    // queued prompt that has no answer yet.
    expect(data.messages.map((m) => [m.role, m.text, m.turn])).toEqual([
      ['assistant', 'Looking at the file.', 2],
      ['assistant', 'The bug is on line 3.', 2],
      ['assistant', 'Done.', 2],
    ]);

    const brief = await getLastResponse(sessionId);
    expect(brief.body.data).toEqual({ text: 'Done.', timestamp: '2026-07-21T00:00:04Z' });
  });

  it('answers context=turn with an empty list when nothing has been answered yet', async () => {
    const sessionId = harness.ctx._session.id;
    const session = harness.ctx._session as typeof harness.ctx._session & {
      claudeSessionId: string;
      adoptClaudeSessionId: ReturnType<typeof vi.fn>;
    };
    session.claudeSessionId = sessionId;
    session.adoptClaudeSessionId = vi.fn();
    writeTranscript(sessionId, [userEntry('go')]);

    const response = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${sessionId}/last-response?context=turn`,
    });
    expect(JSON.parse(response.body).data).toEqual({ text: '', timestamp: '', messages: [] });
  });

  /**
   * A multi-line paste absorbed mid-turn arrives as N queued rows within a few
   * hundred milliseconds (observed: 5 rows inside ~360ms). They are one turn, so
   * the viewer renders them under one badge instead of N.
   */
  it('groups a burst of queued prompts into one turn', async () => {
    const sessionId = harness.ctx._session.id;
    const session = harness.ctx._session as typeof harness.ctx._session & {
      claudeSessionId: string;
      adoptClaudeSessionId: ReturnType<typeof vi.fn>;
    };
    session.claudeSessionId = sessionId;
    session.adoptClaudeSessionId = vi.fn();
    writeTranscript(sessionId, [
      userEntry('go'),
      assistantEntry('OK.', '2026-07-21T00:00:01Z'),
      queuedEntry('one more thing', '2026-07-21T00:00:02.100Z'),
      queuedEntry('and the requirements are', '2026-07-21T00:00:02.360Z'),
      queuedEntry('finally, keep it fast', '2026-07-21T00:00:02.480Z'),
      assistantEntry('Understood.', '2026-07-21T00:00:05Z'),
    ]);

    const { body } = await getLastResponse(sessionId, true);
    const messages = body.data.messages as Array<{ role: string; turn: number }>;
    expect(messages.map((message) => [message.role, message.turn])).toEqual([
      ['user', 1],
      ['assistant', 1],
      ['user', 2],
      ['user', 2],
      ['user', 2],
      ['assistant', 2],
    ]);
  });
});

/**
 * Which conversation a pane is on is decided by the pane's own Enter, not by
 * "newest entry for this cwd" — a cwd is shared with every other tab on it,
 * with tabs long since closed, and with any plain `claude` the user runs in
 * their own terminal.
 */
describe('GET /api/sessions/:id/last-response (claude conversation pinning)', () => {
  let harness: LocalHarness;
  let testHome: string;
  let previousHome: string | undefined;
  const WORKDIR = '/workspace';
  const NOW = 1_770_000_000_000;

  beforeEach(async () => {
    testHome = mkdtempSync(join(tmpdir(), 'codeman-claude-pin-'));
    previousHome = process.env.HOME;
    process.env.HOME = testHome;
    harness = await createEnvelopeHarness();
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    rmSync(testHome, { recursive: true, force: true });
    await harness.app.close();
  });

  /** A transcript whose only assistant turn is `text`, stamped at `mtimeMs`. */
  function writeTranscript(conversationId: string, text: string, mtimeMs: number): void {
    const projectDir = join(testHome, '.claude', 'projects', '-workspace');
    mkdirSync(projectDir, { recursive: true });
    const path = join(projectDir, `${conversationId}.jsonl`);
    writeFileSync(
      path,
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(mtimeMs).toISOString(),
        message: { content: [{ type: 'text', text }] },
      })
    );
    utimesSync(path, mtimeMs / 1000, mtimeMs / 1000);
  }

  function writeHistory(entries: Array<{ sessionId: string; timestamp: number; project?: string }>): void {
    const claudeDir = join(testHome, '.claude');
    mkdirSync(claudeDir, { recursive: true });
    writeFileSync(
      join(claudeDir, 'history.jsonl'),
      entries
        .map((entry) => JSON.stringify({ display: 'prompt', project: entry.project ?? WORKDIR, ...entry }))
        .join('\n')
    );
  }

  /** Replaces the pre-seeded mock session with a Claude pane in WORKDIR. */
  function addPane(id: string, conversationId: string, lastSubmitAt: number, firstHand = false) {
    const base = harness.ctx._session;
    const pane = Object.create(Object.getPrototypeOf(base)) as typeof base & {
      claudeSessionId: string;
      lastSubmitAt: number;
      claudeSessionIdIsFirstHand: boolean;
      adoptClaudeSessionId: ReturnType<typeof vi.fn>;
    };
    Object.assign(pane, base, { id, mode: 'claude', workingDir: WORKDIR, docker: undefined });
    pane.claudeSessionId = conversationId;
    pane.lastSubmitAt = lastSubmitAt;
    pane.claudeSessionIdIsFirstHand = firstHand;
    pane.adoptClaudeSessionId = vi.fn((newId: string) => {
      pane.claudeSessionId = newId;
    });
    harness.ctx.sessions.set(id, pane);
    return pane;
  }

  async function getLastResponse(sessionId: string) {
    const response = await harness.app.inject({ method: 'GET', url: `/api/sessions/${sessionId}/last-response` });
    return JSON.parse(response.body).data as { text: string };
  }

  it('does not adopt a conversation from another claude process sharing the cwd', async () => {
    // The pane typed hours ago; a `claude` running in the user's own terminal
    // is the newest thing in this cwd. Before this fix the viewer followed it.
    const pane = addPane('pane-1', 'pane-conversation', NOW - 6 * 3600_000);
    writeTranscript('pane-conversation', 'my own answer', NOW - 6 * 3600_000);
    writeTranscript('someone-elses-conversation', 'a stranger answer', NOW);
    writeHistory([{ sessionId: 'someone-elses-conversation', timestamp: NOW }]);

    expect(await getLastResponse('pane-1')).toEqual({ text: 'my own answer', timestamp: expect.any(String) });
    expect(pane.adoptClaudeSessionId).not.toHaveBeenCalled();
  });

  it('follows /clear onto the new conversation the pane submitted into', async () => {
    const pane = addPane('pane-1', 'before-clear', NOW);
    writeTranscript('before-clear', 'answer before clear', NOW - 60_000);
    writeTranscript('after-clear', 'answer after clear', NOW + 500);
    writeHistory([{ sessionId: 'after-clear', timestamp: NOW + 120 }]);

    expect(await getLastResponse('pane-1')).toEqual({ text: 'answer after clear', timestamp: expect.any(String) });
    expect(pane.adoptClaudeSessionId).toHaveBeenCalledWith('after-clear');
  });

  it('stays put when the pane has never submitted through Codeman', async () => {
    const pane = addPane('pane-1', 'pane-conversation', 0);
    writeTranscript('pane-conversation', 'my own answer', NOW - 60_000);
    writeTranscript('unrelated-conversation', 'a stranger answer', NOW);
    writeHistory([{ sessionId: 'unrelated-conversation', timestamp: NOW }]);

    expect(await getLastResponse('pane-1')).toEqual({ text: 'my own answer', timestamp: expect.any(String) });
    expect(pane.adoptClaudeSessionId).not.toHaveBeenCalled();
  });

  /**
   * The whole point of the UserPromptSubmit hook: a pane driven by attaching to
   * tmux directly never bumps `lastSubmitAt` (only Codeman's own write path
   * does), so before this the correlation could not run at all for it and the
   * viewer stayed pinned to the launch conversation for the pane's whole life.
   */
  it("trusts the pane's own hook over any history correlation", async () => {
    const pane = addPane('pane-1', 'hook-conversation', 0, true);
    writeTranscript('hook-conversation', 'the answer this pane gave', NOW - 60_000);
    // A newer, closer entry that the correlation would otherwise have claimed.
    writeTranscript('decoy-conversation', 'a stranger answer', NOW);
    writeHistory([{ sessionId: 'decoy-conversation', timestamp: NOW }]);

    expect(await getLastResponse('pane-1')).toEqual({
      text: 'the answer this pane gave',
      timestamp: expect.any(String),
    });
    expect(pane.adoptClaudeSessionId).not.toHaveBeenCalled();
  });

  it('never lets a correlation override a first-hand id, even a well-anchored one', async () => {
    // Same shape as the /clear-following test above, which DOES adopt — the only
    // difference is that this pane's id came from its own hook.
    const pane = addPane('pane-1', 'before-clear', NOW, true);
    writeTranscript('before-clear', 'answer before clear', NOW - 60_000);
    writeTranscript('after-clear', 'answer after clear', NOW + 500);
    writeHistory([{ sessionId: 'after-clear', timestamp: NOW + 120 }]);

    expect(await getLastResponse('pane-1')).toEqual({
      text: 'answer before clear',
      timestamp: expect.any(String),
    });
    expect(pane.adoptClaudeSessionId).not.toHaveBeenCalled();
  });

  it('credits a shared-cwd entry to the pane whose Enter is closest to it', async () => {
    const near = addPane('pane-near', 'near-conversation', NOW);
    const far = addPane('pane-far', 'far-conversation', NOW - 4_000);
    writeTranscript('near-conversation', 'near answer', NOW - 60_000);
    writeTranscript('far-conversation', 'far answer', NOW - 60_000);
    writeTranscript('fresh-conversation', 'the freshly cleared answer', NOW + 500);
    writeHistory([{ sessionId: 'fresh-conversation', timestamp: NOW + 100 }]);

    // Both panes are inside the match window; only the closest may claim it.
    expect(await getLastResponse('pane-far')).toEqual({ text: 'far answer', timestamp: expect.any(String) });
    expect(far.adoptClaudeSessionId).not.toHaveBeenCalled();
    expect(await getLastResponse('pane-near')).toEqual({
      text: 'the freshly cleared answer',
      timestamp: expect.any(String),
    });
    expect(near.adoptClaudeSessionId).toHaveBeenCalledWith('fresh-conversation');
  });
});
