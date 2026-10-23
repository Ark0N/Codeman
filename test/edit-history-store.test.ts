/**
 * Edit history store: byte ranges, cursors, dedupe, cap, persistence.
 * Transcript bytes are built from JSONL lines shaped like real claude records.
 */
import { mkdtempSync, rmSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EditHistoryStore,
  entryBytes,
  MAIN_SOURCE,
  MAX_AGENT_META_CHARS,
  MAX_ENTRIES,
  MAX_STORE_BYTES,
  parseAgentMeta,
} from '../src/edit-history-store.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'edit-history-store-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.parse('2026-10-15T19:00:00.000Z');
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

function editLine(id: string, sec: number, path = `/work/${id}.ts`, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: 'user',
    timestamp: iso(sec),
    cwd: '/work',
    message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: 'ok' }] },
    toolUseResult: {
      filePath: path,
      oldString: 'a',
      newString: 'b',
      originalFile: 'a',
      structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }],
      userModified: false,
      replaceAll: false,
    },
    ...extra,
  });
}

/** An Edit whose diff carries `size` bytes of added text. */
function bigEditLine(id: string, sec: number, size: number): string {
  const line = JSON.parse(editLine(id, sec));
  line.toolUseResult.structuredPatch[0].lines = ['-a', '+' + 'x'.repeat(size)];
  return JSON.stringify(line);
}

function bashUse(id: string, sec: number, command: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: iso(sec),
    cwd: '/work',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
  });
}

function bashResult(id: string, sec: number): string {
  return JSON.stringify({
    type: 'user',
    timestamp: iso(sec),
    cwd: '/work',
    message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: '' }] },
    toolUseResult: { stdout: '', stderr: '', interrupted: false, isImage: false },
  });
}

const jsonl = (lines: string[]) => Buffer.from(lines.map((l) => l + '\n').join(''));

/** Read like the sync will: ask the store for a range, slice it out of `file`, apply. */
function syncForward(store: EditHistoryStore, file: Buffer, budget?: number, source = MAIN_SOURCE, tid = 'conv-1') {
  const range = store.nextRange(source, file.length, tid, budget);
  if (!range) return null;
  const chunk = file.subarray(range.offset, range.offset + range.len);
  return store.apply({ transcriptId: tid, source, startOffset: range.offset, chunk, size: file.length });
}

function syncOlder(store: EditHistoryStore, file: Buffer, budget?: number, source = MAIN_SOURCE, tid = 'conv-1') {
  const range = store.olderRange(source, budget);
  if (!range) return null;
  const chunk = file.subarray(range.offset, range.offset + range.len);
  return store.applyOlder({ transcriptId: tid, source, startOffset: range.offset, chunk, size: file.length });
}

const ids = (store: EditHistoryStore) => store.list().map((e) => e.id);

describe('EditHistoryStore: forward reads', () => {
  it('reads a small file whole, then only what was appended', () => {
    const store = new EditHistoryStore('s1', { dir });
    let file = jsonl([editLine('e1', 1), editLine('e2', 2)]);
    expect(syncForward(store, file)?.added).toBe(2);
    expect(store.getCursor(MAIN_SOURCE)).toEqual({ offset: file.length, floor: 0 });
    expect(syncForward(store, file)).toBeNull();
    file = Buffer.concat([file, jsonl([editLine('e3', 3)])]);
    expect(syncForward(store, file)?.added).toBe(1);
    expect(ids(store)).toEqual(['e3', 'e2', 'e1']);
    expect(store.backfillTruncated).toBe(false);
  });

  it('leaves a partial last line (still being written) for the next read', () => {
    const store = new EditHistoryStore('s1', { dir });
    const full = jsonl([editLine('e1', 1), editLine('e2', 2)]);
    const firstLineEnd = full.indexOf(0x0a) + 1;
    const partial = full.subarray(0, firstLineEnd + 30);
    expect(syncForward(store, partial)?.added).toBe(1);
    expect(store.getCursor(MAIN_SOURCE)?.offset).toBe(firstLineEnd);
    expect(syncForward(store, full)?.added).toBe(1);
    expect(ids(store)).toEqual(['e2', 'e1']);
  });

  it('deduplicates by tool_use_id', () => {
    const store = new EditHistoryStore('s1', { dir });
    const file = jsonl([editLine('e1', 1), editLine('e1', 1)]);
    expect(syncForward(store, file)?.added).toBe(1);
    expect(store.list()).toHaveLength(1);
  });

  it('starts a large file near its end, drops the cut line and keeps the floor there', () => {
    const store = new EditHistoryStore('s1', { dir });
    const lines = Array.from({ length: 20 }, (_, i) => editLine(`e${i}`, i));
    const file = jsonl(lines);
    const budget = Math.floor(file.length / 3);
    syncForward(store, file, budget);
    const cursor = store.getCursor(MAIN_SOURCE)!;
    expect(cursor.offset).toBe(file.length);
    expect(cursor.floor).toBeGreaterThan(file.length - budget);
    expect(file[cursor.floor - 1]).toBe(0x0a);
    expect(store.backfillTruncated).toBe(true);
    expect(ids(store)[0]).toBe('e19');
    expect(ids(store)).not.toContain('e0');
  });

  it('reads a backlog in budget-sized forward steps without losing a line', () => {
    const store = new EditHistoryStore('s1', { dir });
    const first = jsonl([editLine('e0', 0)]);
    syncForward(store, first);
    const more = Array.from({ length: 30 }, (_, i) => editLine(`e${i + 1}`, i + 1));
    const file = Buffer.concat([first, jsonl(more)]);
    const budget = 700;
    for (let i = 0; i < 100 && syncForward(store, file, budget); i++);
    expect(store.list()).toHaveLength(31);
    expect(store.getCursor(MAIN_SOURCE)?.offset).toBe(file.length);
  });

  it('skips a line longer than the budget instead of re-reading it forever', () => {
    const store = new EditHistoryStore('s1', { dir });
    const huge = editLine('big', 1, '/work/big.ts', { pad: 'x'.repeat(5000) });
    const first = jsonl([editLine('e0', 0)]);
    syncForward(store, first);
    const file = Buffer.concat([first, jsonl([huge, editLine('e2', 2)])]);
    for (let i = 0; i < 50 && syncForward(store, file, 1000); i++);
    expect(ids(store)).toEqual(['e2', 'e0']);
    expect(store.getCursor(MAIN_SOURCE)?.offset).toBe(file.length);
  });

  it('keeps a multibyte character split by the chunk boundary intact', () => {
    const store = new EditHistoryStore('s1', { dir });
    const path = '/work/Größe – Ümlaut 😀.ts';
    const file = jsonl([editLine('e1', 1), editLine('e2', 2, path)]);
    const emoji = file.indexOf(Buffer.from('😀'));
    // Cut inside the 4-byte emoji, then continue.
    const cut = file.subarray(0, emoji + 2);
    syncForward(store, cut);
    syncForward(store, file);
    expect(store.get('e2')?.path).toBe(path);
  });

  it('restarts a file that shrank (replaced) from its end', () => {
    const store = new EditHistoryStore('s1', { dir });
    syncForward(store, jsonl([editLine('e1', 1), editLine('e2', 2)]));
    const replaced = jsonl([editLine('n1', 3)]);
    expect(syncForward(store, replaced)?.added).toBe(1);
    expect(store.getCursor(MAIN_SOURCE)?.offset).toBe(replaced.length);
  });

  it('ignores a chunk that does not start at the cursor', () => {
    const store = new EditHistoryStore('s1', { dir });
    const file = jsonl([editLine('e1', 1), editLine('e2', 2)]);
    syncForward(store, file);
    const res = store.apply({ transcriptId: 'conv-1', source: MAIN_SOURCE, startOffset: 3, chunk: file, size: 999 });
    expect(res.added).toBe(0);
  });
});

describe('EditHistoryStore: conversations and sources', () => {
  it('starts new cursors for a new transcriptId and keeps the old entries', () => {
    const store = new EditHistoryStore('s1', { dir });
    syncForward(store, jsonl([editLine('e1', 1)]));
    const second = jsonl([editLine('f1', 5)]);
    expect(store.nextRange(MAIN_SOURCE, second.length, 'conv-2')).toEqual({ offset: 0, len: second.length });
    syncForward(store, second, undefined, MAIN_SOURCE, 'conv-2');
    expect(store.getTranscriptId()).toBe('conv-2');
    expect(ids(store)).toEqual(['f1', 'e1']);
  });

  it('keeps one cursor per source and the subagent id on its entries', () => {
    const store = new EditHistoryStore('s1', { dir });
    const main = jsonl([editLine('m1', 1)]);
    const sub = jsonl([editLine('s1', 2, '/work/s.ts', { isSidechain: true, agentId: 'a1' })]);
    const subSource = 'subagents/agent-a1.jsonl';
    syncForward(store, main);
    syncForward(store, sub, undefined, subSource);
    expect(store.getCursor(MAIN_SOURCE)?.offset).toBe(main.length);
    expect(store.getCursor(subSource)?.offset).toBe(sub.length);
    expect(store.get('s1')?.agentId).toBe('a1');
  });

  it('records agent meta from meta.json text', () => {
    const store = new EditHistoryStore('s1', { dir });
    store.setAgentMeta(
      'a1',
      JSON.stringify({
        agentType: 'coding',
        description: 'Impl: fix',
        worktreePath: '/w/.claude/worktrees/agent-a1',
        worktreeBranch: 'worktree-agent-a1',
        toolUseId: 'toolu_x',
      })
    );
    store.setAgentMeta('a2', 'not json');
    expect(store.getAgents()).toEqual({
      a1: {
        description: 'Impl: fix',
        agentType: 'coding',
        worktreePath: '/w/.claude/worktrees/agent-a1',
        worktreeBranch: 'worktree-agent-a1',
      },
    });
    expect(store.hasAgentMeta('a2')).toBe(false);
    expect(parseAgentMeta('{"description":"d"}')).toEqual({ description: 'd', agentType: '' });
  });
});

describe('EditHistoryStore: older blocks', () => {
  it('loads older lines block by block down to the start, without duplicates at the seam', () => {
    const store = new EditHistoryStore('s1', { dir });
    const file = jsonl(Array.from({ length: 30 }, (_, i) => editLine(`e${i}`, i)));
    const budget = Math.floor(file.length / 4);
    syncForward(store, file, budget);
    const before = store.list().length;
    expect(before).toBeLessThan(30);
    let rounds = 0;
    while (syncOlder(store, file, budget) && rounds < 20) rounds++;
    expect(rounds).toBeGreaterThan(1);
    expect(store.list()).toHaveLength(30);
    expect(store.getCursor(MAIN_SOURCE)?.floor).toBe(0);
    expect(store.backfillTruncated).toBe(false);
    expect(store.olderRange(MAIN_SOURCE, budget)).toBeNull();
  });

  it('refuses an older chunk that does not end at the floor', () => {
    const store = new EditHistoryStore('s1', { dir });
    const file = jsonl(Array.from({ length: 10 }, (_, i) => editLine(`e${i}`, i)));
    syncForward(store, file, 300);
    const res = store.applyOlder({
      transcriptId: 'conv-1',
      source: MAIN_SOURCE,
      startOffset: 0,
      chunk: file.subarray(0, 10),
      size: file.length,
    });
    expect(res.added).toBe(0);
  });
});

describe('EditHistoryStore: Bash images', () => {
  it('pairs a Bash call and its result across a chunk boundary', () => {
    const store = new EditHistoryStore('s1', { dir });
    const part1 = jsonl([bashUse('b1', 1, 'python render.py -o out/frame.png')]);
    const file = Buffer.concat([part1, jsonl([bashResult('b1', 4)])]);
    expect(syncForward(store, part1)?.candidates).toEqual([]);
    const res = syncForward(store, file)!;
    expect(res.candidates).toEqual([
      { toolUseId: 'b1', start: T0 + 1000, end: T0 + 4000, paths: ['/work/out/frame.png'] },
    ]);
  });

  it('adds confirmed images as entries without a diff, once', () => {
    const store = new EditHistoryStore('s1', { dir });
    const img = { toolUseId: 'b1', path: '/work/out/frame.png', ts: T0 + 4000, agentId: 'a1' };
    expect(store.addImageEntries([img, img])).toBe(1);
    expect(store.addImageEntries([img])).toBe(0);
    expect(store.list()[0]).toEqual({
      id: 'b1:/work/out/frame.png',
      ts: T0 + 4000,
      path: '/work/out/frame.png',
      kind: 'image',
      tool: 'bash',
      created: false,
      added: 0,
      removed: 0,
      hunks: [],
      truncated: false,
      agentId: 'a1',
    });
  });
});

describe('EditHistoryStore: cap', () => {
  it(`keeps the newest ${MAX_ENTRIES} entries`, () => {
    const store = new EditHistoryStore('s1', { dir });
    const file = jsonl(Array.from({ length: MAX_ENTRIES + 20 }, (_, i) => editLine(`e${i}`, i)));
    const res = syncForward(store, file, file.length);
    expect(res?.added).toBe(MAX_ENTRIES);
    expect(store.list()).toHaveLength(MAX_ENTRIES);
    expect(store.get('e19')).toBeUndefined();
    expect(store.get('e20')).toBeDefined();
    // Older than everything kept: counts as nothing added.
    expect(store.addImageEntries([{ toolUseId: 'old', path: '/a.png', ts: T0 - 1000 }])).toBe(0);
  });

  it('offers no older block once the cap is full (it would be dropped on read)', () => {
    const store = new EditHistoryStore('s1', { dir });
    const lines = Array.from({ length: MAX_ENTRIES + 20 }, (_, i) => editLine(`e${i}`, i));
    const file = jsonl(lines);
    const tail = jsonl(lines.slice(-MAX_ENTRIES)).length;
    syncForward(store, file, tail + 10);
    expect(store.list()).toHaveLength(MAX_ENTRIES);
    expect(store.getCursor(MAIN_SOURCE)!.floor).toBeGreaterThan(0);
    expect(store.backfillTruncated).toBe(false);
  });

  it(`keeps at most ${MAX_STORE_BYTES} bytes of diff text, dropping the oldest`, () => {
    const store = new EditHistoryStore('s1', { dir });
    const n = 300;
    const file = jsonl(Array.from({ length: n }, (_, i) => bigEditLine(`e${i}`, i, 20_000)));
    syncForward(store, file, file.length);
    const kept = store.list();
    expect(kept.length).toBeLessThan(n);
    expect(kept.reduce((sum, e) => sum + entryBytes(e), 0)).toBeLessThanOrEqual(MAX_STORE_BYTES);
    expect(store.get(`e${n - 1}`)).toBeDefined();
    expect(store.get('e0')).toBeUndefined();
  });

  it('offers no older block once the byte cap is full', () => {
    const store = new EditHistoryStore('s1', { dir });
    const file = jsonl(Array.from({ length: 300 }, (_, i) => bigEditLine(`e${i}`, i, 20_000)));
    syncForward(store, file, 5_000_000);
    expect(store.list().length).toBeLessThan(MAX_ENTRIES);
    expect(store.getCursor(MAIN_SOURCE)!.floor).toBeGreaterThan(0);
    expect(store.backfillTruncated).toBe(false);
  });

  it('caps the agent meta strings', () => {
    const meta = parseAgentMeta(JSON.stringify({ description: 'd'.repeat(5000), agentType: 'coding' }));
    expect(meta?.description).toHaveLength(MAX_AGENT_META_CHARS);
    expect(meta?.agentType).toBe('coding');
  });
});

describe('EditHistoryStore: persistence', () => {
  it('reloads entries, cursors, pending Bash calls and agents from disk', async () => {
    const store = new EditHistoryStore('s1', { dir, debounceMs: 60_000 });
    const file = jsonl([editLine('e1', 1), bashUse('b1', 2, 'render > a.png')]);
    syncForward(store, file);
    store.setAgentMeta('a1', '{"description":"d","agentType":"coding"}');
    await store.flush();
    const loaded = await EditHistoryStore.load('s1', { dir });
    expect(ids(loaded)).toEqual(['e1']);
    expect(loaded.getCursor(MAIN_SOURCE)).toEqual(store.getCursor(MAIN_SOURCE));
    expect(loaded.getTranscriptId()).toBe('conv-1');
    expect(loaded.getAgents()).toEqual({ a1: { description: 'd', agentType: 'coding' } });
    const done = Buffer.concat([file, jsonl([bashResult('b1', 3)])]);
    expect(syncForward(loaded, done)?.candidates[0]?.paths).toEqual(['/work/a.png']);
  });

  it('writes the file 0600 in a 0700 directory, also over a wider existing file', async () => {
    const sub = join(dir, 'edit-history');
    const store = new EditHistoryStore('s1', { dir: sub, debounceMs: 60_000 });
    syncForward(store, jsonl([editLine('e1', 1)]));
    await store.flush();
    expect(statSync(sub).mode & 0o777).toBe(0o700);
    expect(statSync(join(sub, 's1.json')).mode & 0o777).toBe(0o600);
    writeFileSync(join(sub, 's1.json'), '{}', { mode: 0o644 });
    await store.flush();
    expect(statSync(join(sub, 's1.json')).mode & 0o777).toBe(0o600);
  });

  it('applies the caps and drops malformed entries when loading', async () => {
    const store = new EditHistoryStore('s1', { dir, debounceMs: 60_000 });
    syncForward(store, jsonl(Array.from({ length: MAX_ENTRIES }, (_, i) => editLine(`e${i}`, i))));
    await store.flush();
    const data = JSON.parse(readFileSync(join(dir, 's1.json'), 'utf-8'));
    const extra = JSON.parse(editLine('late', MAX_ENTRIES + 1));
    data.entries.push(
      { ...store.get('e0')!, id: 'newest', ts: T0 + 10_000_000 },
      { id: 'broken', path: 7, hunks: [] },
      { id: 'nohunks', path: '/a.ts' },
      extra
    );
    writeFileSync(join(dir, 's1.json'), JSON.stringify(data));
    const loaded = await EditHistoryStore.load('s1', { dir });
    expect(loaded.list()).toHaveLength(MAX_ENTRIES);
    expect(loaded.get('newest')).toBeDefined();
    expect(loaded.get('e0')).toBeUndefined();
    expect(loaded.get('broken')).toBeUndefined();
    expect(loaded.get('nohunks')).toBeUndefined();
  });

  it('ignores a file of an unknown version', async () => {
    writeFileSync(join(dir, 'v9.json'), JSON.stringify({ version: 9, entries: [{ id: 'x' }] }));
    expect((await EditHistoryStore.load('v9', { dir })).list()).toEqual([]);
  });

  it('writes debounced', async () => {
    const store = new EditHistoryStore('s1', { dir, debounceMs: 20 });
    syncForward(store, jsonl([editLine('e1', 1)]));
    const path = join(dir, 's1.json');
    expect(existsSync(path)).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(JSON.parse(readFileSync(path, 'utf-8')).entries).toHaveLength(1);
  });

  it('starts empty from a missing or corrupt file', async () => {
    expect((await EditHistoryStore.load('none', { dir })).list()).toEqual([]);
    const store = new EditHistoryStore('bad', { dir });
    await store.flush();
    writeFileSync(join(dir, 'bad.json'), '{broken');
    expect((await EditHistoryStore.load('bad', { dir })).list()).toEqual([]);
  });

  it('remove() deletes the file and stops later writes', async () => {
    const store = new EditHistoryStore('s1', { dir, debounceMs: 10 });
    syncForward(store, jsonl([editLine('e1', 1)]));
    await store.flush();
    await store.remove();
    expect(existsSync(join(dir, 's1.json'))).toBe(false);
    syncForward(store, jsonl([editLine('e1', 1), editLine('e2', 2)]));
    await new Promise((r) => setTimeout(r, 40));
    await store.flush();
    expect(existsSync(join(dir, 's1.json'))).toBe(false);
  });

  it('defaults to the data directory', () => {
    const store = new EditHistoryStore('s1');
    expect((store as unknown as { file: string }).file).toMatch(/edit-history[\\/]s1\.json$/);
  });
});
