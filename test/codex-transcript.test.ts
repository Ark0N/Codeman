/**
 * Reading codex's own rollout store for Past Sessions rows.
 *
 * Three of these assertions exist because the obvious implementation was
 * measured to be wrong against real files (codex CLI 0.152.1):
 *
 * - codex 0.152.1 emits NO `event_msg`/`user_message` rows at all. It writes
 *   `event_msg`/`item_completed` carrying an `item.type` of `UserMessage`
 *   instead, so a scanner that knew only the older shape found a prompt for
 *   July rollouts and nothing for September ones.
 * - the `response_item` fallback sees codex's injected context, and on a real
 *   store the FIRST such row is the repository's AGENTS.md every time. Taking
 *   it literally titled every row with the same instructions block.
 * - codex spawns sub-agent threads into the same store, stamped
 *   `thread_source: 'subagent'`. On the store this was built against they
 *   outnumbered the threads a person can actually resume.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { appendFile, mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  scanCodexSessionsHistory,
  codexThreadBySessionId,
  __clearCodexIdentityCache,
} from '../src/codex-transcript.js';

let home: string;
let prevCodexHome: string | undefined;

/** A rollout's opening line, as codex writes it. */
const sessionMeta = (opts: { id: string; cwd?: string; threadSource?: string; originator?: string }) =>
  JSON.stringify({
    timestamp: '2026-09-02T07:05:37.421Z',
    type: 'session_meta',
    payload: {
      id: opts.id,
      session_id: opts.id,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      originator: opts.originator ?? 'codex-tui',
      ...(opts.threadSource ? { thread_source: opts.threadSource } : {}),
      // The real thing embeds full base instructions here; padded so the file
      // clears the size floor and exercises the head window.
      base_instructions: { text: 'x'.repeat(500) },
    },
  });

/** codex 0.152.1's user-input row. */
const itemCompletedUser = (text: string) =>
  JSON.stringify({
    type: 'event_msg',
    payload: { type: 'item_completed', item: { type: 'UserMessage', id: 'i1', content: [{ type: 'text', text }] } },
  });

/** The shape older codex versions wrote. */
const legacyUserMessage = (text: string) =>
  JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: text } });

/** The last-resort shape, which also carries codex's injected context. */
const responseItemUser = (text: string) =>
  JSON.stringify({ type: 'response_item', payload: { role: 'user', content: [{ type: 'text', text }] } });

async function writeRollout(id: string, lines: string[], mtime?: Date): Promise<string> {
  const dir = join(home, 'sessions', '2026', '09', '02');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `rollout-2026-09-02T09-05-37-${id}.jsonl`);
  await writeFile(path, lines.join('\n') + '\n', 'utf-8');
  if (mtime) await utimes(path, mtime, mtime);
  return path;
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'codex-transcript-'));
  prevCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = home;
  __clearCodexIdentityCache();
});

afterEach(async () => {
  if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = prevCodexHome;
  await rm(home, { recursive: true, force: true });
});

describe('scanCodexSessionsHistory', () => {
  it('returns nothing when the store does not exist', async () => {
    process.env.CODEX_HOME = join(home, 'nope');
    expect(await scanCodexSessionsHistory()).toEqual([]);
  });

  it('reads the thread id, working directory and opening prompt', async () => {
    await writeRollout('01a060f0-0361-7f91-abde-b283020db0d7', [
      sessionMeta({ id: '01a060f0-0361-7f91-abde-b283020db0d7', cwd: '/repo/one' }),
      itemCompletedUser('Continue the audit log architecture'),
    ]);

    const rows = await scanCodexSessionsHistory();
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe('01a060f0-0361-7f91-abde-b283020db0d7');
    expect(rows[0].workingDir).toBe('/repo/one');
    expect(rows[0].firstPrompt).toBe('Continue the audit log architecture');
    expect(rows[0].sizeBytes).toBeGreaterThan(0);
  });

  it('still reads the prompt shape older codex versions wrote', async () => {
    await writeRollout('11111111-1111-7111-8111-111111111111', [
      sessionMeta({ id: '11111111-1111-7111-8111-111111111111', cwd: '/repo/two' }),
      legacyUserMessage('$pr-review-comment-fixer 349'),
    ]);

    const rows = await scanCodexSessionsHistory();
    expect(rows[0].firstPrompt).toBe('$pr-review-comment-fixer 349');
  });

  it('skips injected context when only the fallback shape is present', async () => {
    await writeRollout('22222222-2222-7222-8222-222222222222', [
      sessionMeta({ id: '22222222-2222-7222-8222-222222222222', cwd: '/repo/three' }),
      responseItemUser('# AGENTS.md instructions for /repo/three\n<INSTRUCTIONS> ...'),
      responseItemUser('<environment_context>cwd=/repo/three</environment_context>'),
      responseItemUser('Replace PanicOnError with Require().NoError'),
    ]);

    const rows = await scanCodexSessionsHistory();
    expect(rows[0].firstPrompt).toBe('Replace PanicOnError with Require().NoError');
  });

  it('prefers a real user row over the injection-prone fallback', async () => {
    await writeRollout('33333333-3333-7333-8333-333333333333', [
      sessionMeta({ id: '33333333-3333-7333-8333-333333333333', cwd: '/repo/four' }),
      responseItemUser('Some earlier response_item row'),
      itemCompletedUser('The prompt the user actually typed'),
    ]);

    const rows = await scanCodexSessionsHistory();
    expect(rows[0].firstPrompt).toBe('The prompt the user actually typed');
  });

  it('leaves out sub-agent threads, which nobody resumes', async () => {
    await writeRollout('44444444-4444-7444-8444-444444444444', [
      sessionMeta({ id: '44444444-4444-7444-8444-444444444444', cwd: '/repo/five' }),
      itemCompletedUser('a real conversation'),
    ]);
    await writeRollout('55555555-5555-7555-8555-555555555555', [
      sessionMeta({ id: '55555555-5555-7555-8555-555555555555', cwd: '/repo/five', threadSource: 'subagent' }),
      itemCompletedUser('work codex gave itself'),
    ]);

    const rows = await scanCodexSessionsHistory();
    expect(rows.map((r) => r.sessionId)).toEqual(['44444444-4444-7444-8444-444444444444']);
  });

  it('reports the most recent prompt as well as the first', async () => {
    await writeRollout('66666666-6666-7666-8666-666666666666', [
      sessionMeta({ id: '66666666-6666-7666-8666-666666666666', cwd: '/repo/six' }),
      itemCompletedUser('the opening question'),
      itemCompletedUser('a follow-up'),
      itemCompletedUser('the latest thing asked'),
    ]);

    const rows = await scanCodexSessionsHistory();
    expect(rows[0].firstPrompt).toBe('the opening question');
    expect(rows[0].lastPrompt).toBe('the latest thing asked');
  });

  it('orders rows newest first', async () => {
    await writeRollout(
      '77777777-7777-7777-8777-777777777777',
      [sessionMeta({ id: '77777777-7777-7777-8777-777777777777', cwd: '/repo/old' }), itemCompletedUser('older')],
      new Date('2026-08-01T00:00:00Z')
    );
    await writeRollout(
      '88888888-8888-7888-8888-888888888888',
      [sessionMeta({ id: '88888888-8888-7888-8888-888888888888', cwd: '/repo/new' }), itemCompletedUser('newer')],
      new Date('2026-09-05T00:00:00Z')
    );

    const rows = await scanCodexSessionsHistory();
    expect(rows.map((r) => r.workingDir)).toEqual(['/repo/new', '/repo/old']);
  });

  it('ignores a file too short to hold a session_meta line', async () => {
    const dir = join(home, 'sessions', '2026', '09', '02');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'rollout-2026-09-02T09-05-37-short.jsonl'), '{}\n', 'utf-8');

    expect(await scanCodexSessionsHistory()).toEqual([]);
  });

  it('survives a rollout whose lines are malformed', async () => {
    await writeRollout('99999999-9999-7999-8999-999999999999', [
      sessionMeta({ id: '99999999-9999-7999-8999-999999999999', cwd: '/repo/seven' }),
      '{not json at all',
      itemCompletedUser('still found me'),
    ]);

    const rows = await scanCodexSessionsHistory();
    expect(rows[0].firstPrompt).toBe('still found me');
  });

  it('reports the originator, which is how a fresh pane finds its own rollout', async () => {
    await writeRollout('bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb', [
      sessionMeta({
        id: 'bbbbbbbb-bbbb-7bbb-8bbb-bbbbbbbbbbbb',
        cwd: '/repo/nine',
        originator: 'codeman_2f1c9a44-1111-2222-3333-444455556666',
      }),
      itemCompletedUser('hello'),
    ]);

    const rows = await scanCodexSessionsHistory();
    expect(rows[0].originator).toBe('codeman_2f1c9a44-1111-2222-3333-444455556666');
  });

  it('drops a rollout that records no working directory', async () => {
    // Emitting workingDir: '' would make a click post an empty directory.
    await writeRollout('cccccccc-cccc-7ccc-8ccc-cccccccccccc', [
      sessionMeta({ id: 'cccccccc-cccc-7ccc-8ccc-cccccccccccc' }),
      itemCompletedUser('nowhere to resume into'),
    ]);

    expect(await scanCodexSessionsHistory()).toEqual([]);
  });

  it('picks up a prompt written after an earlier scan saw none', async () => {
    // The bug this pins: the identity cache was written as soon as the thread id
    // was known, but codex writes the first UserMessage only when the user
    // submits. Any scan in that window — the home screen, the command palette,
    // the search-index refresh — pinned `firstPrompt: undefined` until restart.
    const id = 'dddddddd-dddd-7ddd-8ddd-dddddddddddd';
    const path = await writeRollout(id, [sessionMeta({ id, cwd: '/repo/ten' })]);

    const before = await scanCodexSessionsHistory();
    expect(before).toHaveLength(1);
    expect(before[0].firstPrompt).toBeUndefined();

    await appendFile(path, itemCompletedUser('the prompt, typed a moment later') + '\n', 'utf-8');

    const after = await scanCodexSessionsHistory();
    expect(after[0].firstPrompt).toBe('the prompt, typed a moment later');
  });

  it('does not spend the lastPrompt budget on rollouts it never returns', async () => {
    // The budget used to count file index, so a store whose newest files are all
    // sub-agent threads exhausted it before the first row that needed it.
    for (let i = 0; i < 3; i++) {
      await writeRollout(
        `eeeeeeee-eeee-7eee-8eee-00000000000${i}`,
        [
          sessionMeta({ id: `eeeeeeee-eeee-7eee-8eee-00000000000${i}`, cwd: '/repo/sub', threadSource: 'subagent' }),
          itemCompletedUser('subagent work'),
        ],
        new Date('2026-09-05T00:00:00Z')
      );
    }
    await writeRollout(
      'ffffffff-ffff-7fff-8fff-ffffffffffff',
      [
        sessionMeta({ id: 'ffffffff-ffff-7fff-8fff-ffffffffffff', cwd: '/repo/real' }),
        itemCompletedUser('opening'),
        itemCompletedUser('the latest thing asked'),
      ],
      new Date('2026-09-04T00:00:00Z')
    );

    const rows = await scanCodexSessionsHistory();
    expect(rows).toHaveLength(1);
    expect(rows[0].lastPrompt).toBe('the latest thing asked');
  });

  it('collapses a long prompt to a single capped line', async () => {
    await writeRollout('aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', [
      sessionMeta({ id: 'aaaaaaaa-aaaa-7aaa-8aaa-aaaaaaaaaaaa', cwd: '/repo/eight' }),
      itemCompletedUser('line one\nline two\n' + 'y'.repeat(500)),
    ]);

    const rows = await scanCodexSessionsHistory();
    expect(rows[0].firstPrompt).not.toContain('\n');
    expect(rows[0].firstPrompt!.length).toBeLessThanOrEqual(201);
    expect(rows[0].firstPrompt!.endsWith('…')).toBe(true);
  });
});

describe('codexThreadBySessionId', () => {
  const row = (sessionId: string, originator?: string) =>
    ({ sessionId, originator, workingDir: '/w', sizeBytes: 1, lastModified: '2026-09-02T00:00:00.000Z' }) as never;

  it('maps a Codeman-spawned pane to the thread it is writing', () => {
    const map = codexThreadBySessionId([row('thread-a', 'codeman_sess-1')]);
    expect(map.get('sess-1')).toBe('thread-a');
  });

  it('ignores a rollout codex started on its own', () => {
    expect(codexThreadBySessionId([row('thread-a', 'codex-tui')]).size).toBe(0);
    expect(codexThreadBySessionId([row('thread-a', undefined)]).size).toBe(0);
  });

  it('keeps the newest rollout when a pane has several', () => {
    // `/new` inside the codex TUI leaves the pane's originator on more than one
    // rollout; the pane is on the most recent, and rows arrive newest-first.
    const map = codexThreadBySessionId([row('thread-new', 'codeman_sess-1'), row('thread-old', 'codeman_sess-1')]);
    expect(map.get('sess-1')).toBe('thread-new');
  });
});
