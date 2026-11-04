/**
 * Edit history end to end: the real reader (edit-history-local-source.ts), sync and store on
 * temp transcripts — what the fakes in edit-history-sync.test.ts cannot show (file order,
 * a new conversation next to the old one, every line read exactly once).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaudeEditSources } from '../src/edit-history-local-source.js';
import { EditHistoryStore } from '../src/edit-history-store.js';
import { EditHistorySync, MAX_FORWARD_PASSES, type EditHistorySession } from '../src/web/edit-history-sync.js';

let root: string;
const opened: EditHistoryStore[] = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'edit-pipeline-'));
});
afterEach(async () => {
  await Promise.all(opened.splice(0).map((s) => s.remove()));
  rmSync(root, { recursive: true, force: true });
});

const T0 = Date.parse('2026-10-15T20:00:00.000Z');

/** One edit result line of `pad` bytes or more, newline included. */
function editLine(id: string, i: number, pad = 0, agentId?: string): string {
  const rec: Record<string, unknown> = {
    type: 'user',
    timestamp: new Date(T0 + i * 1000).toISOString(),
    cwd: '/w',
    message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: 'ok' }] },
    toolUseResult: {
      filePath: `/w/${id}.ts`,
      oldString: 'a',
      newString: 'b',
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
    },
    pad: '',
  };
  if (agentId) rec.agentId = agentId;
  rec.pad = 'p'.repeat(Math.max(0, pad - JSON.stringify(rec).length - 1));
  return JSON.stringify(rec) + '\n';
}

function setup(budget?: number, base = root) {
  const project = join(base, 'projects', 'p');
  mkdirSync(project, { recursive: true });
  const at = (transcriptId: string) => join(project, `${transcriptId}.jsonl`);
  /** The transcript watcher's path (the hooks report it; `/clear` moves it). */
  let current = at('convA');
  const sync = new EditHistorySync({
    transcriptPath: async () => (existsSync(current) ? current : null),
    readSources: readClaudeEditSources,
    probe: async (paths) => paths.map(() => null),
    loadStore: async (id) => {
      const store = await EditHistoryStore.load(id, { dir: join(base, 'store'), debounceMs: 10 });
      opened.push(store);
      return store;
    },
    deleteStore: (id) => EditHistoryStore.delete(id, { dir: join(base, 'store') }),
    sweepStores: async () => 0,
    budget,
  });
  const session: EditHistorySession = { id: 's1', mode: 'claude', remote: undefined, claudeSessionId: 'convA' };
  const ids = async () =>
    (await sync.getStore('s1'))
      .list()
      .map((e) => e.id)
      .sort();
  return {
    project,
    at,
    sync,
    session,
    ids,
    switchTo: (transcriptId: string) => (current = at(transcriptId)),
  };
}

describe('a new conversation (/clear, resume)', () => {
  it('reads the previous transcript to its end before the new one', async () => {
    const { at, sync, session, ids, switchTo } = setup();
    appendFileSync(at('convA'), editLine('a1', 1));
    await sync.sync(session);
    // The turn's last edits land, then /clear before the panel's debounced re-read.
    appendFileSync(at('convA'), editLine('a2', 2) + editLine('a3', 3));
    switchTo('convB');
    appendFileSync(at('convB'), editLine('b1', 4));
    await sync.sync(session);
    expect(await ids()).toEqual(['a1', 'a2', 'a3', 'b1']);
    const store = await sync.getStore('s1');
    expect(store.getTranscriptId()).toBe('convB');
    expect(store.knownSources()).toEqual(['main']);
  });

  it('a previous backlog larger than one sync reads on with the next ones; the new transcript follows', async () => {
    const { at, sync, session, ids, switchTo } = setup(600);
    appendFileSync(at('convA'), editLine('a0', 0));
    await sync.sync(session);
    const backlog = Array.from({ length: MAX_FORWARD_PASSES * 3 }, (_, i) => `a${i + 1}`);
    appendFileSync(at('convA'), backlog.map((id, i) => editLine(id, i + 1, 500)).join(''));
    switchTo('convB');
    appendFileSync(at('convB'), editLine('b1', 99));
    await sync.sync(session);
    expect(await ids()).not.toContain('b1');
    for (let i = 0; i < 5; i++) await sync.sync(session);
    expect(await ids()).toEqual(['a0', ...backlog, 'b1'].sort());
  });

  it('subagents of the previous conversation are read to their end too', async () => {
    const { project, at, sync, session, ids, switchTo } = setup();
    const sub = join(project, 'convA', 'subagents');
    mkdirSync(sub, { recursive: true });
    appendFileSync(at('convA'), editLine('a1', 1));
    appendFileSync(join(sub, 'agent-x.jsonl'), editLine('x1', 2, 0, 'x'));
    await sync.sync(session);
    appendFileSync(join(sub, 'agent-x.jsonl'), editLine('x2', 3, 0, 'x'));
    switchTo('convB');
    appendFileSync(at('convB'), editLine('b1', 4));
    await sync.sync(session);
    expect(await ids()).toEqual(['a1', 'b1', 'x1', 'x2']);
  });

  it('a previous transcript that is gone does not hold up the new one', async () => {
    const { at, sync, session, ids, switchTo } = setup();
    appendFileSync(at('convA'), editLine('a1', 1));
    await sync.sync(session);
    rmSync(at('convA'));
    switchTo('convB');
    appendFileSync(at('convB'), editLine('b1', 2));
    await sync.sync(session);
    expect(await ids()).toEqual(['a1', 'b1']);
  });

  it('"Load older" before the forward read moved on reads the stored conversation, not the new file', async () => {
    const { at, sync, session, ids, switchTo } = setup(600);
    const older = Array.from({ length: 4 }, (_, i) => `a${i}`);
    appendFileSync(at('convA'), older.map((id, i) => editLine(id, i, 500)).join(''));
    await sync.sync(session);
    expect(await ids()).toEqual(['a3']);
    switchTo('convB');
    appendFileSync(at('convB'), editLine('b1', 99));
    await sync.sync(session, { older: true });
    expect(await ids()).toEqual(['a2', 'a3']);
  });
});

describe('every line exactly once (seeded random transcripts)', () => {
  /** Deterministic: a seed fixes budget, line lengths, subagents, partial writes and sync points. */
  async function run(seed: number): Promise<string | null> {
    let state = seed;
    const rnd = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
    const ri = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
    const budget = ri(400, 1500);
    const { project, at, sync, session } = setup(budget, mkdtempSync(join(root, 'run-')));
    const main = at('convA');
    const subDir = join(project, 'convA', 'subagents');
    const expected = new Set<string>();
    const tooLong = new Set<string>();
    const agents: string[] = [];
    const tails = new Map<string, string>();
    let n = 0;
    const write = () => {
      if (rnd() < 0.15 && agents.length < 6) {
        mkdirSync(subDir, { recursive: true });
        agents.push(`a${agents.length}`);
      }
      const k = ri(0, agents.length);
      const agent = k === 0 ? undefined : agents[k - 1];
      const file = agent ? join(subDir, `agent-${agent}.jsonl`) : main;
      const id = `e${n++}`;
      // Some lines are longer than the budget: skipped, never shown, never blocking.
      const line = editLine(id, n, rnd() < 0.12 ? ri(budget + 2, budget * 3) : ri(250, budget - 2), agent);
      if (Buffer.byteLength(line) < budget) expected.add(id);
      else if (Buffer.byteLength(line) > budget) tooLong.add(id);
      // Sometimes half a line: claude is still writing it.
      const cut = rnd() < 0.15 ? ri(1, line.length - 1) : line.length;
      appendFileSync(file, (tails.get(file) ?? '') + line.slice(0, cut));
      if (cut < line.length) tails.set(file, line.slice(cut));
      else tails.delete(file);
    };
    for (let i = ri(0, 20); i > 0; i--) write(); // backlog before the panel opens
    if (!existsSync(main)) appendFileSync(main, '');
    for (let r = ri(5, 25); r > 0; r--) {
      for (let i = ri(0, 6); i > 0; i--) write();
      await sync.sync(session);
    }
    for (const [file, rest] of tails) appendFileSync(file, rest);
    for (let i = 0; i < 40; i++) await sync.sync(session);
    const store = await sync.getStore('s1');
    for (let clicks = 0; store.backfillTruncated && clicks < 400; clicks++) await sync.sync(session, { older: true });
    const got = new Set(store.list().map((e) => e.id));
    const missing = [...expected].filter((id) => !got.has(id));
    const extra = [...got].filter((id) => tooLong.has(id));
    if (missing.length || extra.length || store.backfillTruncated) {
      return `seed ${seed} (budget ${budget}): missing ${missing.join(',')} extra ${extra.join(',')}`;
    }
    return null;
  }

  it('reads every line shorter than the budget once, forward and back, and none longer', async () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 40; seed++) {
      await Promise.all(opened.splice(0).map((s) => s.remove()));
      const r = await run(seed);
      if (r) failures.push(r);
    }
    expect(failures).toEqual([]);
  });
});
