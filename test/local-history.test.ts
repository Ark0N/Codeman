import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as history from '../src/local-history.js';
import { Command } from 'commander';
import { registerHistoryCommands } from '../src/cli-history.js';

const ROOT = 'aaaaaaaa-1111-4111-8111-111111111111';
const CHILD = 'bbbbbbbb-1111-4111-8111-111111111111';
const GRANDCHILD = 'cccccccc-1111-4111-8111-111111111111';
let dir: string;
const meta = (id: string, parent?: string) => ({
  type: 'session_meta',
  payload: {
    id,
    timestamp: '2026-10-24T01:00:00Z',
    ...(parent ? { source: { subagent: { thread_spawn: { parent_thread_id: parent } } } } : {}),
  },
});
const row = (role: string, text: string, timestamp = '2026-10-24T01:00:00Z') => ({
  type: 'response_item',
  timestamp,
  payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
});
async function fixture(id: string, records: unknown[], parent?: string) {
  const path = join(dir, `rollout-${id}.jsonl`);
  await writeFile(path, [meta(id, parent), ...records].map((r) => JSON.stringify(r)).join('\n') + '\n');
  return path;
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'local-history-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('offline native history', () => {
  it('reads a native transcript without a server and preserves identity and timestamps', async () => {
    const file = await fixture(ROOT, [row('user', 'question'), row('assistant', 'answer')]);
    const result = await history.readLocalHistory({ file });
    expect(result.records.map((r) => r.message)).toEqual(['question', 'answer']);
    expect(result.records[0]).toMatchObject({
      sessionId: ROOT,
      rootSessionId: ROOT,
      timestamp: '2026-10-24T01:00:00Z',
    });
    expect(result.complete).toBe(true);
  });
  it('resolves metadata identities rather than filenames', async () => {
    await fixture(ROOT, [row('assistant', 'yes')]);
    const result = await history.readLocalHistory({ sessionId: ROOT.slice(0, 8), sessionsRoot: dir });
    expect(result.records[0].sessionId).toBe(ROOT);
  });
  it('rejects ambiguous native prefixes', async () => {
    await fixture(ROOT, [row('assistant', 'one')]);
    await fixture('aaaaaaaa-2222-4222-8222-222222222222', [row('assistant', 'two')]);
    await expect(history.readLocalHistory({ sessionId: 'aaaaaaaa', sessionsRoot: dir })).rejects.toThrow(/ambiguous/);
  });
  it('gathers transitive children and retains a whole topic/date matching turn', async () => {
    await fixture(ROOT, [row('user', 'other'), row('assistant', 'unrelated')]);
    await fixture(
      CHILD,
      [row('user', 'topic question'), row('assistant', 'answer after midnight', '2026-10-25T00:01:00Z')],
      ROOT
    );
    await fixture(GRANDCHILD, [row('user', 'topic child'), row('assistant', 'child answer')], CHILD);
    const result = await history.readLocalHistory({
      rootSessionId: ROOT,
      sessionsRoot: dir,
      topic: 'TOPIC',
      before: '2026-10-24',
    });
    expect(result.sessions).toHaveLength(3);
    expect(result.records.map((r) => r.message)).toEqual([
      'topic question',
      'answer after midnight',
      'topic child',
      'child answer',
    ]);
    expect(result.records.every((r) => r.rootSessionId === ROOT)).toBe(true);
  });
  it('resolves the real native root when querying a child by id', async () => {
    await fixture(ROOT, [row('assistant', 'root')]);
    await fixture(CHILD, [row('assistant', 'child')], ROOT);
    await fixture(GRANDCHILD, [row('assistant', 'grandchild')], CHILD);
    const result = await history.readLocalHistory({ sessionId: GRANDCHILD, sessionsRoot: dir });
    expect(result.records[0].rootSessionId).toBe(ROOT);
    expect(result.sessions[0]).toMatchObject({ parentSessionId: CHILD, rootSessionId: ROOT });
  });
  it('labels a file-only child root unknown rather than inventing an ancestor', async () => {
    const file = await fixture(CHILD, [row('assistant', 'child')], ROOT);
    const result = await history.readLocalHistory({ file });
    expect(result.records[0].rootSessionId).toBeNull();
    expect(result.sessions[0]).toMatchObject({ parentSessionId: ROOT, rootSessionId: null });
  });
  it('labels missing ancestors unknown and refuses cyclic ancestry', async () => {
    await fixture(CHILD, [row('assistant', 'child')], ROOT);
    expect(
      (await history.readLocalHistory({ sessionId: CHILD, sessionsRoot: dir })).records[0].rootSessionId
    ).toBeNull();
    await fixture(ROOT, [row('assistant', 'root')], CHILD);
    await expect(history.readLocalHistory({ sessionId: CHILD, sessionsRoot: dir })).rejects.toThrow(/cyclic/);
  });
  it('supports legacy shared session_id genealogy', async () => {
    await fixture(ROOT, [row('assistant', 'root')]);
    await writeFile(
      join(dir, 'legacy.jsonl'),
      [{ type: 'session_meta', payload: { id: CHILD, session_id: ROOT } }, row('assistant', 'legacy child')]
        .map((r) => JSON.stringify(r))
        .join('\n') + '\n'
    );
    expect((await history.readLocalHistory({ rootSessionId: ROOT, sessionsRoot: dir })).sessions).toHaveLength(2);
  });
  it('parses modern events and removes adjacent duplicate representations without erasing repeated turns', async () => {
    const file = await fixture(ROOT, [
      row('user', 'question'),
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'UserMessage', content: [{ type: 'Text', text: 'question' }] },
        },
      },
      row('assistant', 'answer'),
      {
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'Text', text: 'answer' }] },
        },
      },
      { type: 'event_msg', payload: { type: 'user_message', message: 'question' } },
      { type: 'event_msg', payload: { type: 'agent_message', message: 'answer' } },
    ]);
    expect((await history.readLocalHistory({ file })).records.map((r) => r.message)).toEqual([
      'question',
      'answer',
      'question',
      'answer',
    ]);
  });
  it('preserves genuinely repeated identical messages from the same representation', async () => {
    const file = await fixture(ROOT, [row('user', 'repeat'), row('user', 'repeat'), row('assistant', 'answer')]);
    expect((await history.readLocalHistory({ file })).records.map((r) => r.message)).toEqual([
      'repeat',
      'repeat',
      'answer',
    ]);
  });
  it('labels unreadable metadata as incomplete rather than hiding possible children', async () => {
    await fixture(ROOT, [row('assistant', 'root')]);
    await writeFile(join(dir, 'unattributed.jsonl'), '{bad metadata}\n');
    const result = await history.readLocalHistory({ rootSessionId: ROOT, sessionsRoot: dir });
    expect(result.complete).toBe(false);
    expect(result.scan.unattributedFiles).toBe(1);
  });
  it('refuses conflicting session metadata instead of attributing another conversation answer', async () => {
    const file = await fixture(ROOT, [row('user', 'root question'), meta(CHILD), row('assistant', 'child answer')]);
    await expect(history.readLocalHistory({ file })).rejects.toThrow(/conflicting.*metadata/);
  });
  it('accepts repeated metadata only when native identity and genealogy agree', async () => {
    const file = await fixture(ROOT, [row('user', 'question'), meta(ROOT), row('assistant', 'answer')]);
    expect((await history.readLocalHistory({ file })).records.map((record) => record.message)).toEqual([
      'question',
      'answer',
    ]);
    await fixture(CHILD, [meta(CHILD, GRANDCHILD), row('assistant', 'child answer')], ROOT);
    await expect(history.readLocalHistory({ sessionId: CHILD, sessionsRoot: dir })).rejects.toThrow(
      /conflicting.*metadata/
    );
  });
  it('labels skipped malformed and pending partial records', async () => {
    const file = await fixture(ROOT, [row('assistant', 'complete')]);
    const { appendFile } = await import('node:fs/promises');
    await appendFile(file, 'not json\n{"type":');
    const result = await history.readLocalHistory({ file });
    expect(result.complete).toBe(false);
    expect(result.scan.malformedRecords).toBe(1);
    expect(result.scan.partialRecords).toBe(1);
    expect(result.records[0].message).toBe('complete');
  });
  it('rejects invalid UTF8, nonregular inputs and symlinks', async () => {
    const file = await fixture(ROOT, [row('assistant', 'answer')]);
    const linked = join(dir, 'linked.jsonl');
    await symlink(file, linked);
    await expect(history.readLocalHistory({ file: linked })).rejects.toThrow(/regular|symlink/);
    await expect(history.readLocalHistory({ file: dir })).rejects.toThrow(/regular/);
    await writeFile(file, Buffer.from([0xff, 0x0a]));
    await expect(history.readLocalHistory({ file })).rejects.toThrow(/UTF8/);
  });
  it('fails closed for byte budgets and preserves valid JSON for successful output', async () => {
    const file = await fixture(ROOT, [row('assistant', '😀'.repeat(80))]);
    await expect(history.readLocalHistory({ file, scanBytes: 32 })).rejects.toThrow(/scan.*budget/);
    const result = await history.readLocalHistory({ file });
    expect(() => history.formatLocalHistory(result, 'json', 40)).toThrow(/output.*budget/);
    const output = history.formatLocalHistory(result, 'json', 8192);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(8192);
    expect(JSON.parse(output).records[0].message).toBe('😀'.repeat(80));
  });
  it.each([{ after: '2026-02-30' }, { before: 'bad' }, { after: '2026-10-25', before: '2026-10-24' }, { topic: ' ' }])(
    'rejects invalid filters %j',
    async (filter) => {
      const file = await fixture(ROOT, [row('assistant', 'answer')]);
      await expect(history.readLocalHistory({ file, ...filter })).rejects.toThrow(/date|topic/);
    }
  );
  it('rejects missing selectors, multiple selectors, empty matches and absent native ids', async () => {
    const file = await fixture(ROOT, [row('assistant', 'answer')]);
    await expect(history.readLocalHistory({})).rejects.toThrow(/exactly one/);
    await expect(history.readLocalHistory({ file, sessionId: ROOT })).rejects.toThrow(/exactly one/);
    await expect(history.readLocalHistory({ file, topic: 'absent' })).rejects.toThrow(/evidence/);
    await expect(history.readLocalHistory({ sessionId: CHILD, sessionsRoot: dir })).rejects.toThrow(/missing/);
  });
  it('rejects exhausted directory traversal rather than returning an incomplete family', async () => {
    await fixture(ROOT, [row('assistant', 'root')]);
    await mkdir(join(dir, 'nested'));
    await fixture(CHILD, [row('assistant', 'child')], ROOT);
    await expect(history.readLocalHistory({ rootSessionId: ROOT, sessionsRoot: dir, maxEntries: 1 })).rejects.toThrow(
      /scan.*budget/
    );
  });
  it('executes the offline CLI with complete JSON and no internal parser fields', async () => {
    const file = await fixture(ROOT, [row('assistant', 'offline')]);
    let output = '';
    const program = new Command().exitOverride().configureOutput({
      writeOut: (text) => {
        output += text;
      },
      writeErr: () => {},
    });
    registerHistoryCommands(program);
    await program.parseAsync(['history', 'read', '--file', file, '--json'], { from: 'user' });
    const result = JSON.parse(output);
    expect(result.records[0].message).toBe('offline');
    expect(result.records[0]).not.toHaveProperty('representation');
    await expect(
      program.parseAsync(['history', 'read', '--file', file, '--session-id', ROOT], { from: 'user' })
    ).rejects.toThrow(/exactly one/);
  });
  it('registers offline commands and reports invalid selectors without process exit', async () => {
    const program = new Command().exitOverride();
    registerHistoryCommands(program);
    expect(program.commands.find((c) => c.name() === 'history')?.commands.map((c) => c.name())).toEqual(['read']);
  });
});
