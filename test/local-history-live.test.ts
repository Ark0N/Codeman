/**
 * @fileoverview The offline history reader against rollouts that change while
 * it reads them: a running Codex appending to its own rollout (or a child's),
 * an unrelated rollout rewritten mid-scan, and a selected rollout replaced
 * outright. `node:fs/promises` is wrapped so a test can act at an exact point
 * of the read (after the open, after a read call) without timing races.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFile, mkdtemp, rename, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Hook = (path: string, openCount: number, handle: import('node:fs/promises').FileHandle) => Promise<void> | void;
const hooks: { onOpen?: Hook } = {};
const opens = new Map<string, number>();

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const path = String(args[0]);
      const count = (opens.get(path) ?? 0) + 1;
      opens.set(path, count);
      await hooks.onOpen?.(path, count, handle);
      return handle;
    },
  };
});

const history = await import('../src/local-history.js');
const { assistantTurn, realMeta, settingsApplied, userTurn, writeRollout } =
  await import('./fixtures/codex-rollout.js');

const ROOT = 'aaaaaaaa-1111-4111-8111-111111111111';
const CHILD = 'bbbbbbbb-1111-4111-8111-111111111111';
let dir: string;
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'local-history-live-'));
  opens.clear();
  hooks.onOpen = undefined;
});
afterEach(async () => {
  hooks.onOpen = undefined;
  await rm(dir, { recursive: true, force: true });
});

describe('rollouts that change while they are read', () => {
  it('reads a snapshot of a rollout a running Codex appends to after attribution', async () => {
    const path = await writeRollout(dir, 'rollout-root.jsonl', [realMeta({ id: ROOT }), ...userTurn('question')]);
    hooks.onOpen = async (opened, count) => {
      // The second open is the transcript read; Codex writes a whole record and starts the next.
      if (opened === path && count === 2) {
        await appendFile(path, assistantTurn('answer').map(line).join(''));
        await appendFile(path, '{"timestamp":"2026-10-24T01:00:02.000Z","type":"event_');
      }
    };
    const result = await history.readLocalHistory({ sessionId: ROOT, sessionsRoot: dir });
    expect(result.records.map((r) => r.message)).toEqual(['question', 'answer']);
    // The record cut mid-write is reported, not parsed and not fatal.
    expect(result.scan.partialRecords).toBe(1);
    expect(result.scan.malformedRecords).toBe(0);
    expect(result.complete).toBe(false);
  });

  it('reads a family whose child is still running', async () => {
    await writeRollout(dir, 'rollout-root.jsonl', [realMeta({ id: ROOT }), ...userTurn('root question')]);
    const child = await writeRollout(dir, 'rollout-child.jsonl', [
      realMeta({ id: CHILD, parent: ROOT, mode: 'legacy' }),
      ...userTurn('child task'),
    ]);
    hooks.onOpen = async (opened, count) => {
      // Grows during the metadata scan and again before its transcript read.
      if (opened === child)
        await appendFile(child, assistantTurn(`child progress ${count}`, 'commentary').map(line).join(''));
    };
    const result = await history.readLocalHistory({ rootSessionId: ROOT, sessionsRoot: dir });
    expect(result.records.map((r) => r.message)).toEqual([
      'root question',
      'child task',
      'child progress 1',
      'child progress 2',
    ]);
    expect(result.complete).toBe(true);
  });

  it('counts an unrelated rollout that shrinks during its head read as unattributed', async () => {
    await writeRollout(dir, 'rollout-root.jsonl', [realMeta({ id: ROOT }), ...userTurn('question')]);
    const other = await writeRollout(dir, 'rollout-other.jsonl', [realMeta({ id: CHILD }), ...userTurn('other')]);
    hooks.onOpen = async (opened, count, handle) => {
      if (opened !== other || count !== 1) return;
      const read = handle.read.bind(handle) as (...args: unknown[]) => Promise<unknown>;
      (handle as unknown as { read: (...args: unknown[]) => Promise<unknown> }).read = async (...args) => {
        const result = await read(...args);
        await truncate(other, 10);
        return result;
      };
    };
    const result = await history.readLocalHistory({ sessionId: ROOT, sessionsRoot: dir });
    expect(result.records.map((r) => r.message)).toEqual(['question']);
    expect(result.scan.unattributedFiles).toBe(1);
    expect(result.complete).toBe(false);
  });

  it('still refuses a selected rollout replaced by another file after attribution', async () => {
    const path = await writeRollout(dir, 'rollout-root.jsonl', [realMeta({ id: ROOT }), ...userTurn('question')]);
    hooks.onOpen = async (opened, count) => {
      if (opened !== path || count !== 1) return;
      const replacement = join(dir, 'replacement.tmp');
      await writeFile(replacement, [realMeta({ id: ROOT }), ...userTurn('rewritten')].map(line).join(''));
      await rename(replacement, path);
    };
    await expect(history.readLocalHistory({ sessionId: ROOT, sessionsRoot: dir })).rejects.toThrow(
      /changed after attribution/
    );
  });

  it('still refuses a selected rollout truncated after attribution', async () => {
    const path = await writeRollout(dir, 'rollout-root.jsonl', [realMeta({ id: ROOT }), ...userTurn('question')]);
    hooks.onOpen = async (opened, count) => {
      if (opened === path && count === 2) await truncate(path, 100);
    };
    await expect(history.readLocalHistory({ sessionId: ROOT, sessionsRoot: dir })).rejects.toThrow(
      /changed after attribution/
    );
  });
  it('leaves a child readable, with an unproven cut, when its parent is replaced after attribution', async () => {
    const parentSettings = [settingsApplied(), ...userTurn('parent second question')];
    const parent = await writeRollout(dir, 'rollout-root.jsonl', [
      realMeta({ id: ROOT }),
      ...userTurn('parent question'),
      ...parentSettings,
    ]);
    const child = await writeRollout(dir, 'rollout-child.jsonl', [
      realMeta({ id: CHILD, parent: ROOT }),
      realMeta({ id: ROOT }),
      ...userTurn('parent question'),
      ...parentSettings,
      settingsApplied(),
      ...userTurn('child task'),
    ]);
    hooks.onOpen = async (opened, count) => {
      // The child's transcript read comes before the parent's proof read: replace the parent in between.
      if (opened !== child || count !== 2) return;
      const replacement = join(dir, 'replacement.tmp');
      await writeFile(replacement, [realMeta({ id: ROOT }), ...userTurn('rewritten')].map(line).join(''));
      await rename(replacement, parent);
    };
    const result = await history.readLocalHistory({ sessionId: CHILD, sessionsRoot: dir });
    expect(result.records.map((r) => r.message)).toEqual(['child task']);
    expect(result.scan.unverifiedPrefixes).toBe(1);
    expect(result.complete).toBe(false);
  });
});
