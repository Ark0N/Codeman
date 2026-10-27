/** @fileoverview Bounded JSONL inspection: cursors, byte budgets and file generations. */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, writeFile, appendFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INSPECT_CURSORS_PER_SCOPE, InspectionReader } from '../src/agent-inspection.js';
let dir: string;
let file: string;
let reader: InspectionReader;
const scope = { owner: 'alice', sessionId: 's', generation: 'pane-1', conversationId: 'thread-1' };
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'inspect-'));
  file = join(dir, 'rollout.jsonl');
  reader = new InspectionReader();
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
it('returns complete UTF8 records within the byte budget and resumes exactly', async () => {
  const row = JSON.stringify({ text: 'é😀' }) + '\n';
  await writeFile(file, row + row);
  const first = await reader.read(file, scope, Buffer.byteLength(row));
  expect(first.evidence).toBe(row);
  expect(first.truncated).toBe(true);
  await appendFile(file, row);
  const next = await reader.read(file, scope, 1024, first.cursor);
  expect(next.evidence).toBe(row);
  expect(next.truncated).toBe(false);
});
it('does not consume partial final records', async () => {
  await writeFile(file, '{"text":"hello');
  const first = await reader.read(file, scope, 100);
  expect(first.evidence).toBe('');
  await appendFile(file, '"}\n');
  const next = await reader.read(file, scope, 100, first.cursor);
  expect(next.evidence).toBe('{"text":"hello"}\n');
});
it('reports an oversized incremental record without splitting it or advancing past it', async () => {
  await writeFile(file, '{}\n');
  const initial = await reader.read(file, scope, 100);
  await appendFile(file, JSON.stringify({ text: 'x'.repeat(300000) }) + '\n');
  const result = await reader.read(file, scope, 100, initial.cursor);
  expect(result.evidence).toBe('');
  expect(result.truncated).toBe(true);
  expect(result.blockedReason).toBe('record-exceeds-scan-limit');
  expect(result.scannedBytes).toBeLessThanOrEqual(262144);
});
it('rejects malformed, cross-owner and changed-session cursors', async () => {
  await writeFile(file, '{}\n');
  const first = await reader.read(file, scope, 100);
  for (const changed of [
    { ...scope, owner: 'bob' },
    { ...scope, sessionId: 'other' },
    { ...scope, generation: 'new' },
    { ...scope, conversationId: 'new' },
  ]) {
    await expect(reader.read(file, changed, 100, first.cursor)).rejects.toThrow(/cursor/i);
  }
  await expect(reader.read(file, scope, 100, 'garbage')).rejects.toThrow(/cursor/i);
});
it('rejects truncation, replacement and rewritten consumed evidence', async () => {
  await writeFile(file, '{}\n{}\n');
  const first = await reader.read(file, scope, 100);
  await writeFile(file, '{}\n');
  await expect(reader.read(file, scope, 100, first.cursor)).rejects.toThrow(/cursor/i);
  await writeFile(file, '{}\n{}\n');
  const second = await reader.read(file, scope, 100);
  await writeFile(file, '[]\n[]\n');
  await expect(reader.read(file, scope, 100, second.cursor)).rejects.toThrow(/cursor/i);
  const third = await reader.read(file, scope, 100);
  await rename(file, join(dir, 'old'));
  await writeFile(file, '[]\n[]\n');
  await expect(reader.read(file, scope, 100, third.cursor)).rejects.toThrow(/cursor/i);
});
it('expires cursors and bounds retained state', async () => {
  await writeFile(file, '{}\n');
  let now = 0;
  reader = new InspectionReader(() => now, 2, 1000);
  const first = await reader.read(file, scope, 100);
  await reader.read(file, scope, 100);
  await reader.read(file, scope, 100);
  await expect(reader.read(file, scope, 100, first.cursor)).rejects.toThrow(/cursor/i);
  const last = await reader.read(file, scope, 100);
  now = 1001;
  await expect(reader.read(file, scope, 100, last.cursor)).rejects.toThrow(/cursor/i);
});
it('bounds strict attribution itself and refuses an incomplete inventory', async () => {
  const { mkdir } = await import('node:fs/promises');
  const { findExactCodexConversation } = await import('../src/agent-codex-identity.js');
  const home = join(dir, 'codex');
  const sessions = join(home, 'sessions');
  await mkdir(sessions, { recursive: true });
  const id = '11111111-1111-4111-8111-111111111111';
  await writeFile(
    join(sessions, `rollout-${id}.jsonl`),
    JSON.stringify({ type: 'session_meta', payload: { id, cwd: dir, originator: 'codeman_s' } }) + '\n'
  );
  await writeFile(join(sessions, 'other.txt'), 'other');
  const options = { codexHome: home, sessionId: 's', workingDir: dir };
  expect((await findExactCodexConversation(options))?.id).toBe(id);
  expect(await findExactCodexConversation(options, { maxEntries: 1, maxBytes: 16384 })).toBeUndefined();
});

it('starts at recent complete records past oversized bootstrap evidence, labeling all omission', async () => {
  const old = JSON.stringify({ system: 'x'.repeat(300000) }) + '\n';
  const latest = JSON.stringify({ assistant: 'latest 😀' }) + '\n';
  await writeFile(file, old + latest);
  const result = await reader.read(file, scope, Buffer.byteLength(latest));
  expect(result.evidence).toBe(latest);
  expect(result.omittedBeforeBytes).toBe(Buffer.byteLength(old));
  expect(result.truncated).toBe(true);
  await appendFile(file, '{"assistant":"next"}\n');
  expect((await reader.read(file, scope, 100, result.cursor)).evidence).toBe('{"assistant":"next"}\n');
});
it('attributes a real-sized session_meta row rather than requiring a tiny header', async () => {
  const { mkdir } = await import('node:fs/promises');
  const { findExactCodexConversation } = await import('../src/agent-codex-identity.js');
  const home = join(dir, 'codex');
  await mkdir(join(home, 'sessions'), { recursive: true });
  const id = '11111111-1111-4111-8111-111111111111';
  await writeFile(
    join(home, 'sessions', `rollout-${id}.jsonl`),
    JSON.stringify({
      type: 'session_meta',
      payload: { id, cwd: dir, originator: 'codeman_s', instructions: 'x'.repeat(20000) },
    }) + '\n'
  );
  expect(
    (
      await findExactCodexConversation(
        { codexHome: home, sessionId: 's', workingDir: dir },
        { maxEntries: 8192, maxBytes: 1048576 }
      )
    )?.id
  ).toBe(id);
});
it('rejects same-size rewrites outside the bounded cursor anchors', async () => {
  const { utimes } = await import('node:fs/promises');
  const row = JSON.stringify({ text: 'a'.repeat(20000) }) + '\n';
  await writeFile(file, row);
  await utimes(file, 1, 1);
  const first = await reader.read(file, scope, 30000);
  await writeFile(file, row.slice(0, 10000) + 'b' + row.slice(10001));
  await expect(reader.read(file, scope, 30000, first.cursor)).rejects.toThrow(/cursor/i);
});
it('keeps cursor capacity bounded across concurrent reads', async () => {
  await writeFile(file, '{}\n');
  reader = new InspectionReader(Date.now, 2);
  const results = await Promise.all(Array.from({ length: 16 }, () => reader.read(file, scope, 100)));
  const resumed = await Promise.allSettled(results.map((result) => reader.read(file, scope, 100, result.cursor)));
  expect(resumed.filter((result) => result.status === 'fulfilled').length).toBeLessThanOrEqual(2);
});
it('caps cursors per owner and session, so one polling scope cannot evict another', async () => {
  await writeFile(file, '{}\n');
  const other = { ...scope, owner: 'bob', sessionId: 't' };
  const bobs = await reader.read(file, other, 100);
  // Alice polls every second for well past the old global FIFO of 1,024.
  let last = await reader.read(file, scope, 100);
  for (let i = 0; i < 1100; i++) last = await reader.read(file, scope, 100, last.cursor);
  // Bob's cursor survives, and so does a retry of Alice's last call.
  await expect(reader.read(file, other, 100, bobs.cursor)).resolves.toMatchObject({ evidence: '' });
  await expect(reader.read(file, scope, 100, last.cursor)).resolves.toMatchObject({ evidence: '' });
  // Alice keeps only her newest cursors: the oldest of one more than the cap is retired.
  const issued: string[] = [];
  for (let i = 0; i <= INSPECT_CURSORS_PER_SCOPE; i++) issued.push((await reader.read(file, scope, 100)).cursor);
  await expect(reader.read(file, scope, 100, issued[0])).rejects.toThrow(/cursor/i);
  await expect(reader.read(file, scope, 100, issued[issued.length - 1])).resolves.toBeDefined();
  // The cap counts owner and session: a new pane generation of Alice's session shares
  // it, Bob's session does not.
  const nextPane = { ...scope, generation: 'pane-2' };
  for (let i = 0; i < INSPECT_CURSORS_PER_SCOPE; i++) await reader.read(file, nextPane, 100);
  await expect(reader.read(file, scope, 100, issued[issued.length - 1])).rejects.toThrow(/cursor/i);
  await expect(reader.read(file, other, 100, bobs.cursor)).resolves.toBeDefined();
});
it('keeps an incomplete UTF8 sequence pending until its JSONL record is complete', async () => {
  const row = Buffer.from('{"text":"😀"}\n');
  const split = row.indexOf(Buffer.from('😀')) + 2;
  await writeFile(file, row.subarray(0, split));
  const first = await reader.read(file, scope, 100);
  expect(first.evidence).toBe('');
  await appendFile(file, row.subarray(split));
  expect((await reader.read(file, scope, 100, first.cursor)).evidence).toBe(row.toString('utf8'));
});

it('treats a full incremental page as pageable rather than a blocked oversized record', async () => {
  await writeFile(file, '{}\n');
  const initial = await reader.read(file, scope, 100);
  await appendFile(file, '{}\n{}\n');
  const page = await reader.read(file, scope, 3, initial.cursor);
  expect(page.evidence).toBe('{}\n');
  expect(page.truncated).toBe(true);
  expect(page.blockedReason).toBeUndefined();
  const next = await reader.read(file, scope, 3, page.cursor);
  expect(next.evidence).toBe('{}\n');
});

it('still labels the first selected oversized tail record after omitted older bytes', async () => {
  await writeFile(file, '{}\n' + JSON.stringify({ text: 'x'.repeat(100) }) + '\n');
  const page = await reader.read(file, scope, 10);
  expect(page.evidence).toBe('');
  expect(page.blockedReason).toBe('record-exceeds-output-budget');
});
