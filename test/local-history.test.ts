import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmod, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as history from '../src/local-history.js';
import { Command } from 'commander';
import { registerHistoryCommands } from '../src/cli-history.js';
import {
  assistantTurn,
  developer,
  injected,
  realMeta,
  settingsApplied,
  taskStarted,
  userTurn,
  withOrdinals,
  writeRollout,
} from './fixtures/codex-rollout.js';

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
  it('refuses a later session_meta whose id is not a declared ancestor', async () => {
    // ROOT declares no parent, fork source or shared root, so CHILD can only be another conversation.
    const file = await fixture(ROOT, [row('user', 'root question'), meta(CHILD), row('assistant', 'child answer')]);
    await expect(history.readLocalHistory({ file })).rejects.toThrow(/conflicting.*metadata/);
    // A fork child is refused too when the inherited metadata names a thread it does not descend from.
    const forked = await writeRollout(dir, 'unrelated-fork.jsonl', [
      realMeta({ id: CHILD, parent: ROOT, mode: 'legacy' }),
      realMeta({ id: GRANDCHILD, mode: 'legacy' }),
      row('assistant', 'not ours'),
      settingsApplied(),
      row('assistant', 'child answer'),
    ]);
    await expect(history.readLocalHistory({ file: forked })).rejects.toThrow(/conflicting.*metadata/);
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

const messages = (result: history.LocalHistoryResult) =>
  result.records.map((r) => `${r.sessionId.slice(0, 1)}:${r.message}`);

/** A parent R, and a legacy child C whose file copies R's history before its own, as Codex writes it. */
async function legacyFamily(root: string, parentExtra: unknown[] = [], copiedExtra: unknown[] = []) {
  await mkdir(root, { recursive: true });
  const parentHistory = [
    taskStarted(),
    developer(),
    injected(),
    ...userTurn('parent question'),
    ...assistantTurn('parent commentary', 'commentary'),
    ...assistantTurn('parent answer'),
  ];
  await writeRollout(root, `rollout-${ROOT}.jsonl`, [
    realMeta({ id: ROOT }),
    ...parentHistory,
    ...parentExtra,
    ...userTurn('parent later question'),
    ...assistantTurn('parent later answer'),
  ]);
  return writeRollout(root, `rollout-${CHILD}.jsonl`, [
    realMeta({ id: CHILD, parent: ROOT }),
    realMeta({ id: ROOT }),
    ...parentHistory,
    ...copiedExtra,
    settingsApplied(),
    taskStarted(),
    ...userTurn('child task'),
    ...assistantTurn('child commentary', 'commentary'),
    ...assistantTurn('child answer'),
  ]);
}

describe('forked and spawned threads', () => {
  it('drops the parent history a legacy fork copies, so the child reads as itself', async () => {
    const childFile = await legacyFamily(dir);
    const child = await history.readLocalHistory({ sessionId: CHILD, sessionsRoot: dir });
    expect(messages(child)).toEqual(['b:child task', 'b:child commentary', 'b:child answer']);
    expect(child.complete).toBe(true);
    expect(child.scan.inheritedPrefixes).toBe(1);
    expect(child.sessions[0]).toMatchObject({ sessionId: CHILD, parentSessionId: ROOT, rootSessionId: ROOT });
    // The whole family: every message once, the copy not repeated under the child.
    const family = await history.readLocalHistory({ rootSessionId: ROOT, sessionsRoot: dir });
    expect(messages(family)).toEqual([
      'a:parent question',
      'a:parent commentary',
      'a:parent answer',
      'a:parent later question',
      'a:parent later answer',
      'b:child task',
      'b:child commentary',
      'b:child answer',
    ]);
    expect(family.complete).toBe(true);
    // An explicit file needs no store: the copy ends at the one thread_settings_applied.
    const file = await history.readLocalHistory({ file: childFile });
    expect(messages(file)).toEqual(['b:child task', 'b:child commentary', 'b:child answer']);
    expect(file.complete).toBe(true);
  });

  it('finds the end of a legacy copy that carries the parent own thread_settings_applied events', async () => {
    // The parent compacted (or checkpointed its first turn) before the fork, so the copy holds that event too.
    const parentSettings = [
      settingsApplied(),
      ...userTurn('parent second question'),
      ...assistantTurn('parent second answer'),
    ];
    const childFile = await legacyFamily(dir, parentSettings, parentSettings);
    const child = await history.readLocalHistory({ sessionId: CHILD, sessionsRoot: dir });
    expect(messages(child)).toEqual(['b:child task', 'b:child commentary', 'b:child answer']);
    expect(child.complete).toBe(true);
    // Without the parent's file the boundary cannot be proven: nothing of the parent is attributed to the child.
    const alone = await history.readLocalHistory({ file: childFile });
    expect(messages(alone)).toEqual(['b:child task', 'b:child commentary', 'b:child answer']);
    expect(alone.scan.unverifiedPrefixes).toBe(1);
    expect(alone.complete).toBe(false);
  });

  it('keeps the child own later thread_settings_applied events on its side of the cut', async () => {
    await legacyFamily(dir);
    const path = join(dir, `rollout-${CHILD}.jsonl`);
    const { appendFile } = await import('node:fs/promises');
    await appendFile(
      path,
      [settingsApplied(), ...userTurn('child second task'), ...assistantTurn('child second answer')]
        .map((line) => JSON.stringify(line))
        .join('\n') + '\n'
    );
    const child = await history.readLocalHistory({ sessionId: CHILD, sessionsRoot: dir });
    expect(messages(child)).toEqual([
      'b:child task',
      'b:child commentary',
      'b:child answer',
      'b:child second task',
      'b:child second answer',
    ]);
    expect(child.complete).toBe(true);
  });

  it('accepts the copied metadata of an ancestor that was itself a fork', async () => {
    const file = await writeRollout(dir, 'grandchild.jsonl', [
      realMeta({ id: GRANDCHILD, parent: CHILD, root: ROOT }),
      realMeta({ id: CHILD, parent: ROOT }),
      realMeta({ id: ROOT }),
      ...userTurn('root question'),
      settingsApplied(),
      ...userTurn('child question'),
      settingsApplied(),
      ...userTurn('grandchild task'),
      ...assistantTurn('grandchild answer'),
    ]);
    const result = await history.readLocalHistory({ file });
    expect(messages(result)).toEqual(['c:grandchild task', 'c:grandchild answer']);
    expect(result.records[0].rootSessionId).toBe(ROOT);
  });

  it('marks a legacy copy that never reached its end marker incomplete and keeps none of it', async () => {
    const file = await writeRollout(dir, 'cut.jsonl', [
      realMeta({ id: CHILD, parent: ROOT }),
      realMeta({ id: ROOT }),
      ...userTurn('parent question'),
    ]);
    await expect(history.readLocalHistory({ file })).rejects.toThrow(/evidence/);
    await writeRollout(dir, 'cut.jsonl', [
      realMeta({ id: CHILD, parent: ROOT }),
      ...userTurn('child before copy'),
      realMeta({ id: ROOT }),
      ...userTurn('parent question'),
    ]);
    const result = await history.readLocalHistory({ file });
    expect(messages(result)).toEqual(['b:child before copy']);
    expect(result.scan.incompletePrefixes).toBe(1);
    expect(result.complete).toBe(false);
  });

  it('drops the inherited records of a paginated sub-agent by ordinal, as Codex projects them', async () => {
    const inherited = [
      realMeta({ id: CHILD, parent: ROOT, mode: 'paginated', historyStart: 7 }),
      realMeta({ id: ROOT, mode: 'paginated' }),
      taskStarted(),
      injected(),
      ...userTurn('parent question'),
      ...assistantTurn('parent answer').slice(1),
    ];
    expect(inherited).toHaveLength(7);
    const lines = withOrdinals([
      ...inherited,
      settingsApplied(),
      taskStarted(),
      ...assistantTurn('child commentary', 'commentary'),
      ...assistantTurn('child answer'),
    ]);
    await writeRollout(
      dir,
      `rollout-${ROOT}.jsonl`,
      withOrdinals([realMeta({ id: ROOT, mode: 'paginated' }), ...userTurn('parent question')])
    );
    await writeRollout(dir, `rollout-${CHILD}.jsonl`, lines);
    const child = await history.readLocalHistory({ sessionId: CHILD, sessionsRoot: dir });
    expect(messages(child)).toEqual(['b:child commentary', 'b:child answer']);
    expect(child.records.map((r) => r.phase)).toEqual(['commentary', 'final_answer']);
    expect(child.complete).toBe(true);
    const family = await history.readLocalHistory({ rootSessionId: ROOT, sessionsRoot: dir });
    expect(messages(family)).toEqual(['a:parent question', 'b:child commentary', 'b:child answer']);
  });

  it('reports a paginated copy that ends before its declared start ordinal', async () => {
    const file = await writeRollout(
      dir,
      'paginated-cut.jsonl',
      withOrdinals([
        realMeta({ id: CHILD, parent: ROOT, mode: 'paginated', historyStart: 9 }),
        realMeta({ id: ROOT, mode: 'paginated' }),
        ...userTurn('parent question'),
        ...assistantTurn('parent answer'),
      ])
    );
    await expect(history.readLocalHistory({ file })).rejects.toThrow(/evidence/);
    // In a family read the parent still answers, and the cut child makes the result incomplete.
    await writeRollout(
      dir,
      `rollout-${ROOT}.jsonl`,
      withOrdinals([realMeta({ id: ROOT, mode: 'paginated' }), ...userTurn('parent question')])
    );
    const family = await history.readLocalHistory({ rootSessionId: ROOT, sessionsRoot: dir });
    expect(messages(family)).toEqual(['a:parent question']);
    expect(family.scan.incompletePrefixes).toBe(1);
    expect(family.complete).toBe(false);
    await rm(join(dir, `rollout-${ROOT}.jsonl`));
    // A paginated record without an ordinal is skipped, visibly, as Codex's projection skips it.
    const lines = withOrdinals([
      realMeta({ id: CHILD, parent: ROOT, mode: 'paginated', historyStart: 2 }),
      realMeta({ id: ROOT, mode: 'paginated' }),
      settingsApplied(),
      ...assistantTurn('child answer'),
    ]);
    await writeRollout(dir, 'paginated-cut.jsonl', [...lines, assistantTurn('stray')[0]]);
    const result = await history.readLocalHistory({ file });
    expect(messages(result)).toEqual(['b:child answer']);
    expect(result.scan.malformedRecords).toBe(1);
    expect(result.complete).toBe(false);
  });
});

describe('one read per file, and a parent that cannot be read', () => {
  const parentSettings = [
    settingsApplied(),
    ...userTurn('parent second question'),
    ...assistantTurn('parent second answer'),
  ];
  const sizes = async () => {
    const { stat } = await import('node:fs/promises');
    const parent = (await stat(join(dir, `rollout-${ROOT}.jsonl`))).size;
    const child = (await stat(join(dir, `rollout-${CHILD}.jsonl`))).size;
    return { parent, child };
  };

  it('charges the parent of a legacy copy to --scan-bytes once, even when it proves the boundary', async () => {
    await legacyFamily(dir, parentSettings, parentSettings);
    const { parent, child } = await sizes();
    // A budget of exactly the two files: the family read selects the parent and proves the child's cut with it.
    const family = await history.readLocalHistory({
      rootSessionId: ROOT,
      sessionsRoot: dir,
      scanBytes: parent + child,
    });
    expect(family.scan.bytesRead).toBe(parent + child);
    expect(family.complete).toBe(true);
    expect(messages(family).filter((m) => m.startsWith('b:'))).toEqual([
      'b:child task',
      'b:child commentary',
      'b:child answer',
    ]);
    // One byte less fails closed rather than returning less.
    await expect(
      history.readLocalHistory({ rootSessionId: ROOT, sessionsRoot: dir, scanBytes: parent + child - 1 })
    ).rejects.toThrow(/scan byte budget/);
    // A child read pays for the parent it proves against, once.
    const alone = await history.readLocalHistory({ sessionId: CHILD, sessionsRoot: dir, scanBytes: parent + child });
    expect(alone.scan.bytesRead).toBe(parent + child);
    expect(alone.complete).toBe(true);
  });

  it('counts a parent record once when the parent is both selected and the proof of a child', async () => {
    await legacyFamily(dir, parentSettings, parentSettings);
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(dir, `rollout-${ROOT}.jsonl`), '{not json\n');
    const family = await history.readLocalHistory({ rootSessionId: ROOT, sessionsRoot: dir });
    expect(family.scan.malformedRecords).toBe(1);
    expect(family.scan.inheritedPrefixes).toBe(1);
  });

  it('falls back to the unproven cut when the parent file cannot be read, instead of failing the child', async () => {
    await legacyFamily(dir, parentSettings, parentSettings);
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(dir, `rollout-${ROOT}.jsonl`), Buffer.from([0xff, 0x0a]));
    const child = await history.readLocalHistory({ sessionId: CHILD, sessionsRoot: dir });
    expect(messages(child)).toEqual(['b:child task', 'b:child commentary', 'b:child answer']);
    expect(child.scan.unverifiedPrefixes).toBe(1);
    expect(child.complete).toBe(false);
    // The parent's own read still fails: its evidence is what is broken.
    await expect(history.readLocalHistory({ sessionId: ROOT, sessionsRoot: dir })).rejects.toThrow(/invalid UTF8/);
  });

  it('still fails when the parent read runs out of budget', async () => {
    await legacyFamily(dir, parentSettings, parentSettings);
    const { child } = await sizes();
    await expect(
      history.readLocalHistory({ sessionId: CHILD, sessionsRoot: dir, scanBytes: child + 1 })
    ).rejects.toThrow(/scan byte budget/);
  });
});

describe('compressed rollouts', () => {
  const ZSTD = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x04, 0x00, 0x00, 0x00]);
  const compressedName = (id: string) => `rollout-2026-10-24T01-00-00-${id}.jsonl.zst`;

  it('counts a .jsonl.zst rollout, so a family with a compressed member is incomplete', async () => {
    await legacyFamily(dir);
    await mkdir(join(dir, '2026', '10', '24'), { recursive: true });
    await writeFile(join(dir, '2026', '10', '24', compressedName(GRANDCHILD)), ZSTD);
    const family = await history.readLocalHistory({ rootSessionId: ROOT, sessionsRoot: dir });
    expect(family.scan.compressedFiles).toBe(1);
    expect(family.scan.unattributedFiles).toBe(0);
    expect(family.complete).toBe(false);
  });

  it('names the compressed rollout when the wanted thread is not otherwise found', async () => {
    await fixture(ROOT, [row('assistant', 'root')]);
    const path = join(dir, compressedName(CHILD));
    await writeFile(path, ZSTD);
    const error = await history.readLocalHistory({ sessionId: CHILD.slice(0, 8), sessionsRoot: dir }).catch((e) => e);
    expect(error.message).toContain(path);
    expect(error.message).toMatch(/compressed rollout/);
    // A compressed file whose name does not carry the id is still reported, by count.
    const other = await history.readLocalHistory({ sessionId: GRANDCHILD, sessionsRoot: dir }).catch((e) => e);
    expect(other.message).toMatch(/1 compressed \.jsonl\.zst rollout\(s\) could not be read/);
  });

  it('skips a compressed rollout whose plain sibling exists, as Codex does', async () => {
    const plain = await fixture(ROOT, [row('assistant', 'root')]);
    await writeFile(`${plain}.zst`, ZSTD);
    const result = await history.readLocalHistory({ sessionId: ROOT, sessionsRoot: dir });
    expect(result.scan.compressedFiles).toBe(0);
    expect(result.complete).toBe(true);
  });

  it('refuses a Zstandard file given to --file, and counts one in the store whatever its name', async () => {
    const file = join(dir, 'renamed.jsonl');
    await writeFile(file, ZSTD);
    await expect(history.readLocalHistory({ file })).rejects.toThrow(/Zstandard-compressed/);
    await fixture(ROOT, [row('assistant', 'root')]);
    const result = await history.readLocalHistory({ sessionId: ROOT, sessionsRoot: dir });
    expect(result.scan.unattributedFiles).toBe(1);
    expect(result.complete).toBe(false);
  });
});

describe('large and untidy stores', () => {
  it('finds one id among thousands of rollouts with real-sized session_meta at the default budgets', async () => {
    const count = 3500;
    const base = realMeta({ id: ROOT });
    const pad = JSON.stringify(base).length;
    expect(pad).toBeGreaterThan(19 * 1024);
    const writes: Array<Promise<void>> = [];
    for (let i = 0; i < count; i++) {
      const day = join(dir, '2026', String(1 + (i % 12)).padStart(2, '0'), String(1 + (i % 28)).padStart(2, '0'));
      const id = `${i.toString(16).padStart(8, '0')}-2222-4222-8222-222222222222`;
      writes.push(
        mkdir(day, { recursive: true }).then(() =>
          writeFile(
            join(day, `rollout-${id}.jsonl`),
            [realMeta({ id }), ...userTurn(`question ${i}`), ...assistantTurn(`answer ${i}`)]
              .map((line) => JSON.stringify(line))
              .join('\n') + '\n'
          )
        )
      );
    }
    await Promise.all(writes);
    const target = `${(count - 1).toString(16).padStart(8, '0')}-2222-4222-8222-222222222222`;
    const result = await history.readLocalHistory({ sessionId: target, sessionsRoot: dir });
    expect(messages(result)).toEqual([`0:question ${count - 1}`, `0:answer ${count - 1}`]);
    expect(result.complete).toBe(true);
    // Metadata is charged to its own budget; the transcript budget only paid for the one rollout.
    expect(result.scan.metadataBytesRead).toBeGreaterThan(history.HISTORY_MAX_SCAN_BYTES / 4);
    expect(result.scan.bytesRead).toBeLessThan(64 * 1024);
    // The store-wide caps fail closed and are raisable.
    await expect(
      history.readLocalHistory({ sessionId: target, sessionsRoot: dir, metadataBytes: 1024 * 1024 })
    ).rejects.toThrow(/metadata.*--metadata-bytes/);
    await expect(history.readLocalHistory({ sessionId: target, sessionsRoot: dir, maxEntries: 100 })).rejects.toThrow(
      /entry budget.*--max-entries/
    );
  }, 60_000);

  it('reads only the head of each rollout to attribute it, not its whole window', async () => {
    await writeRollout(dir, 'rollout-big.jsonl', [
      realMeta({ id: ROOT }),
      ...Array.from({ length: 400 }, (_, i) => assistantTurn(`${i} ${'x'.repeat(2048)}`)).flat(),
    ]);
    const result = await history.readLocalHistory({ sessionId: ROOT, sessionsRoot: dir, scanBytes: 8 * 1024 * 1024 });
    expect(result.records).toHaveLength(400);
    // One 32 KiB step holds the ~20 KiB session_meta line; the 128 KiB window is only the ceiling.
    expect(result.scan.metadataBytesRead).toBe(32 * 1024);
  });

  it.each([
    ['invalid UTF8 in its head', Buffer.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a])],
    [
      'no session_meta within 128 KiB',
      Buffer.from(`${JSON.stringify({ type: 'event_msg', payload: {} })}\n`.repeat(6000)),
    ],
  ])('counts one unrelated file with %s as unattributed instead of failing the lookup', async (_label, bytes) => {
    await fixture(ROOT, [row('user', 'question'), row('assistant', 'answer')]);
    await writeFile(join(dir, 'rollout-broken.jsonl'), bytes);
    const result = await history.readLocalHistory({ sessionId: ROOT, sessionsRoot: dir });
    expect(result.records.map((r) => r.message)).toEqual(['question', 'answer']);
    expect(result.scan.unattributedFiles).toBe(1);
    expect(result.complete).toBe(false);
    // The same file named explicitly is still an error.
    await expect(history.readLocalHistory({ file: join(dir, 'rollout-broken.jsonl') })).rejects.toThrow(/UTF8|128 KiB/);
  });

  it('counts an unreadable directory instead of failing the lookup', async () => {
    await fixture(ROOT, [row('assistant', 'answer')]);
    const locked = join(dir, 'locked');
    await mkdir(locked);
    await chmod(locked, 0);
    try {
      const result = await history.readLocalHistory({ sessionId: ROOT, sessionsRoot: dir });
      expect(result.records[0].message).toBe('answer');
      expect(result.scan.unreadableDirectories).toBe(process.getuid?.() === 0 ? 0 : 1);
    } finally {
      await chmod(locked, 0o700);
    }
  });

  it('follows a sessions root that is itself a symlink, and still skips links below it', async () => {
    const real = join(dir, 'real-sessions');
    await mkdir(real);
    await writeRollout(real, 'rollout-root.jsonl', [
      realMeta({ id: ROOT }),
      ...userTurn('question'),
      ...assistantTurn('answer'),
    ]);
    const linkedRoot = join(dir, 'sessions-link');
    await symlink(real, linkedRoot);
    const result = await history.readLocalHistory({ sessionId: ROOT, sessionsRoot: linkedRoot });
    expect(result.records.map((r) => r.message)).toEqual(['question', 'answer']);
    expect(result.complete).toBe(true);
    await symlink(join(real, 'rollout-root.jsonl'), join(real, 'rollout-link.jsonl'));
    const withLink = await history.readLocalHistory({ sessionId: ROOT, sessionsRoot: linkedRoot });
    expect(withLink.scan.skippedSymlinks).toBe(1);
    await expect(
      history.readLocalHistory({ sessionId: ROOT, sessionsRoot: join(real, 'rollout-root.jsonl') })
    ).rejects.toThrow(/must be a directory/);
  });
});

describe('records, filters and output', () => {
  it('gives user records no phase and keeps the phase Codex recorded on assistant messages', async () => {
    const file = await writeRollout(dir, 'phases.jsonl', [
      realMeta({ id: ROOT }),
      ...userTurn('question'),
      ...assistantTurn('working', 'commentary'),
      ...assistantTurn('done'),
      row('assistant', 'legacy answer without a phase'),
    ]);
    const result = await history.readLocalHistory({ file });
    expect(result.records.map((r) => [r.role, r.phase])).toEqual([
      ['user', null],
      ['assistant', 'commentary'],
      ['assistant', 'final_answer'],
      ['assistant', null],
    ]);
  });

  it('drops every injected-context wrapper but never a typed prompt that starts with #', async () => {
    const file = await writeRollout(dir, 'injected.jsonl', [
      realMeta({ id: ROOT }),
      injected('environment_context'),
      injected('recommended_plugins'),
      injected('subagent_notification'),
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: '# AGENTS.md instructions for /x' }],
        },
      },
      ...userTurn('# a heading the user typed'),
      ...assistantTurn('answer'),
    ]);
    const result = await history.readLocalHistory({ file });
    expect(result.records.map((r) => r.message)).toEqual(['# a heading the user typed', 'answer']);
  });

  it('compares date bounds as UTC calendar dates', async () => {
    const file = await writeRollout(dir, 'dates.jsonl', [
      realMeta({ id: ROOT }),
      // 23:30 at UTC-2 is 01:30 UTC the next day.
      ...userTurn('late evening west of UTC', '2026-10-24T23:30:00.000-02:00'),
      ...userTurn('plain UTC', '2026-10-24T12:00:00.000Z'),
    ]);
    const after = await history.readLocalHistory({ file, after: '2026-10-25' });
    expect(after.records.map((r) => r.message)).toEqual(['late evening west of UTC']);
    const on = await history.readLocalHistory({ file, before: '2026-10-24' });
    expect(on.records.map((r) => r.message)).toEqual(['plain UTC']);
  });

  it('reads the default store at $CODEX_HOME/sessions, else ~/.codex/sessions', async () => {
    const saved = { CODEX_HOME: process.env.CODEX_HOME, HOME: process.env.HOME };
    try {
      process.env.CODEX_HOME = join(dir, 'codex-home');
      await mkdir(join(dir, 'codex-home', 'sessions', '2026', '10', '24'), { recursive: true });
      await writeRollout(join(dir, 'codex-home', 'sessions', '2026', '10', '24'), 'rollout-a.jsonl', [
        realMeta({ id: ROOT }),
        ...userTurn('from CODEX_HOME'),
      ]);
      expect((await history.readLocalHistory({ sessionId: ROOT })).records[0].message).toBe('from CODEX_HOME');
      delete process.env.CODEX_HOME;
      process.env.HOME = join(dir, 'home');
      await mkdir(join(dir, 'home', '.codex', 'sessions'), { recursive: true });
      await writeRollout(join(dir, 'home', '.codex', 'sessions'), 'rollout-b.jsonl', [
        realMeta({ id: ROOT }),
        ...userTurn('from ~/.codex'),
      ]);
      const result = await history.readLocalHistory({ sessionId: ROOT });
      expect(result.records[0].message).toBe('from ~/.codex');
      expect(result.sessions[0].path).toBe(join(dir, 'home', '.codex', 'sessions', 'rollout-b.jsonl'));
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe('history CLI flags', () => {
  const run = async (args: string[]) => {
    let output = '';
    const program = new Command().exitOverride().configureOutput({
      writeOut: (text) => {
        output += text;
      },
      writeErr: () => {},
    });
    registerHistoryCommands(program);
    await program.parseAsync(['history', 'read', ...args], { from: 'user' });
    return output;
  };

  it('prints text with --format text, a header line and one block per record', async () => {
    const file = await writeRollout(dir, 'text.jsonl', [
      realMeta({ id: ROOT }),
      ...userTurn('question'),
      ...assistantTurn('answer'),
    ]);
    const output = await run(['--file', file, '--format', 'text']);
    const blocks = output.trimEnd().split('\n\n');
    expect(blocks[0]).toMatch(/^source=codex-jsonl complete=true scannedBytes=\d+ metadataBytes=\d+$/);
    expect(blocks[1]).toBe(`[root=${ROOT} session=${ROOT} 2026-10-24T01:00:00.000Z user]\nquestion`);
    expect(blocks[2]).toBe(`[root=${ROOT} session=${ROOT} 2026-10-24T01:00:01.000Z assistant final_answer]\nanswer`);
    expect(() => JSON.parse(output)).toThrow();
  });

  it('refuses --json together with --format text, and accepts either alone', async () => {
    const file = await writeRollout(dir, 'flags.jsonl', [realMeta({ id: ROOT }), ...assistantTurn('answer')]);
    await expect(run(['--file', file, '--json', '--format', 'text'])).rejects.toThrow(
      /--json conflicts with --format text/
    );
    expect(JSON.parse(await run(['--file', file, '--json'])).records[0].message).toBe('answer');
    expect(JSON.parse(await run(['--file', file, '--json', '--format', 'json'])).records[0].message).toBe('answer');
    expect(await run(['--file', file, '--format', 'text'])).toMatch(/^source=codex-jsonl/);
  });

  it('validates --max-bytes before any file is read', async () => {
    // A missing store would be the first thing a read touches; an invalid --max-bytes must be refused first.
    const missing = join(dir, 'no-such-store');
    for (const value of ['0', String(history.HISTORY_MAX_OUTPUT_BYTES + 1), 'lots', '0x10', '1e3', ' 5'])
      await expect(run(['--session-id', ROOT, '--sessions-root', missing, '--max-bytes', value])).rejects.toThrow(
        /Invalid --max-bytes/
      );
    await expect(run(['--session-id', ROOT, '--sessions-root', missing, '--max-bytes', '65536'])).rejects.toThrow(
      /Sessions root not found/
    );
  });

  it('reads budget flags as plain decimal integers only', async () => {
    await fixture(ROOT, [row('assistant', 'answer')]);
    await expect(run(['--session-id', ROOT, '--sessions-root', dir, '--scan-bytes', '0x100000'])).rejects.toThrow(
      /Invalid --scan-bytes/
    );
    await expect(run(['--session-id', ROOT, '--sessions-root', dir, '--max-entries', '1e3'])).rejects.toThrow(
      /Invalid --max-entries/
    );
    expect(
      JSON.parse(await run(['--session-id', ROOT, '--sessions-root', dir, '--scan-bytes', '1048576'])).complete
    ).toBe(true);
  });

  it('passes the store caps through and validates them', async () => {
    await fixture(ROOT, [row('assistant', 'answer')]);
    await fixture(CHILD, [row('assistant', 'child')], ROOT);
    await expect(run(['--session-id', ROOT, '--sessions-root', dir, '--max-entries', '1'])).rejects.toThrow(
      /--max-entries/
    );
    expect(JSON.parse(await run(['--session-id', ROOT, '--sessions-root', dir, '--max-entries', '2'])).complete).toBe(
      true
    );
    await expect(run(['--session-id', ROOT, '--sessions-root', dir, '--metadata-bytes', '16'])).rejects.toThrow(
      /--metadata-bytes/
    );
    await expect(run(['--session-id', ROOT, '--sessions-root', dir, '--metadata-bytes', 'lots'])).rejects.toThrow(
      /Invalid --metadata-bytes/
    );
    await expect(run(['--session-id', ROOT, '--sessions-root', dir, '--max-entries', '0'])).rejects.toThrow(
      /Invalid --max-entries/
    );
  });
});
