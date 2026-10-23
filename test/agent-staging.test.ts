/** @fileoverview Guarded staging one-shot and content-verification safety. */
import { beforeEach, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { GuardedStageStore, type GuardedInputTarget } from '../src/agent-staging.js';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
let store: GuardedStageStore;
let time: number;
let generation: string;
let revision: number;
let composer: string | null;
let writes: string[];
let fail: boolean;
let target: GuardedInputTarget;
beforeEach(() => {
  time = 0;
  generation = 'pane-1';
  revision = 0;
  composer = '';
  writes = [];
  fail = false;
  store = new GuardedStageStore(() => time, 2, 1000);
  target = {
    id: 's',
    snapshot: () => (composer === null ? null : { generation, revision, composerSha: sha(composer) }),
    submit: async () => target.write('\r'),
    write: async (text) => {
      writes.push(text);
      revision++;
      if (fail) return false;
      composer = text === '\r' ? '' : composer + text;
      return true;
    },
  };
});
it('stages without Enter, stores only a hash, and submits exactly once', async () => {
  const receipt = await store.stage(target, 'alice', 'hello');
  expect(writes).toEqual(['hello']);
  expect(receipt.sha256).toBe(sha('hello'));
  expect(JSON.stringify(receipt)).not.toContain('hello');
  await store.submit(target, 'alice', receipt.stageId, receipt.sha256);
  expect(writes).toEqual(['hello', '\r']);
  await expect(store.submit(target, 'alice', receipt.stageId, receipt.sha256)).rejects.toThrow();
});
it('refuses multiline, controls, oversized prompts and nonempty or unprovable composers before writing', async () => {
  for (const text of ['', 'one\ntwo', 'one\rtwo', '\u001b', '\u0085', 'x'.repeat(20000), '\ud800'])
    await expect(store.stage(target, 'alice', text)).rejects.toThrow();
  composer = 'existing';
  await expect(store.stage(target, 'alice', 'hello')).rejects.toThrow();
  composer = null;
  await expect(store.stage(target, 'alice', 'hello')).rejects.toThrow();
  expect(writes).toEqual([]);
});
it('refuses altered composer including whitespace-only differences', async () => {
  const receipt = await store.stage(target, 'alice', 'hello world');
  composer = 'helloworld';
  await expect(store.submit(target, 'alice', receipt.stageId, receipt.sha256)).rejects.toThrow();
  expect(writes).toEqual(['hello world']);
});
it('refuses changed generation, intervening input, wrong owner/session/hash and expiry', async () => {
  for (const change of [
    () => {
      generation = 'pane-2';
    },
    () => {
      revision++;
    },
    () => {
      time += 1001;
    },
  ]) {
    composer = '';
    const receipt = await store.stage(target, 'alice', 'hello');
    change();
    await expect(store.submit(target, 'alice', receipt.stageId, receipt.sha256)).rejects.toThrow();
  }
  composer = '';
  const receipt = await store.stage(target, 'alice', 'hello');
  await expect(store.submit(target, 'bob', receipt.stageId, receipt.sha256)).rejects.toThrow();
  await expect(store.submit({ ...target, id: 'other' }, 'alice', receipt.stageId, receipt.sha256)).rejects.toThrow();
  await expect(store.submit(target, 'alice', receipt.stageId, sha('other'))).rejects.toThrow();
  expect(writes.filter((s) => s === '\r')).toHaveLength(0);
});
it('consumes before write so concurrent and failed deliveries never replay Enter', async () => {
  const receipt = await store.stage(target, 'alice', 'hello');
  fail = true;
  const results = await Promise.allSettled([
    store.submit(target, 'alice', receipt.stageId, receipt.sha256),
    store.submit(target, 'alice', receipt.stageId, receipt.sha256),
  ]);
  expect(results.every((r) => r.status === 'rejected')).toBe(true);
  expect(writes).toEqual(['hello', '\r']);
  await expect(store.submit(target, 'alice', receipt.stageId, receipt.sha256)).rejects.toThrow();
});
it('does not issue a receipt on failed staging or intervening input during its write', async () => {
  fail = true;
  await expect(store.stage(target, 'alice', 'hello')).rejects.toThrow();
  fail = false;
  composer = '';
  const altered = {
    ...target,
    write: async (s: string) => {
      await target.write(s);
      revision++;
      return true;
    },
  };
  await expect(store.stage(altered, 'alice', 'hello')).rejects.toThrow();
});

it('reads exact composer spaces and refuses wrapped or modal frames', async () => {
  const { readGuardedCodexComposer } = await import('../src/agent-staging.js');
  expect(readGuardedCodexComposer('› hello  world\n  GPT-6-Luna default · ~/case\n')).toBe('hello  world');
  expect(
    readGuardedCodexComposer(
      '› \x1b[2mAsk Codex to do anything\x1b[0m\n  GPT-6-Luna default · ~/case\n  ← for agents · ? for shortcuts'
    )
  ).toBe('');
  expect(readGuardedCodexComposer('› wrapped\n  more text\n  GPT-6-Luna default · ~/case')).toBeNull();
  expect(readGuardedCodexComposer('› 1. Yes\n  Press enter to confirm')).toBeNull();
  expect(readGuardedCodexComposer('› hello\n')).toBeNull();
});
it('requires capture cursor geometry, rejecting invisible trailing edits and moved cursors', async () => {
  const { readGuardedCodexSnapshot } = await import('../src/agent-staging.js');
  const { formatPaneSnapshot } = await import('../src/tmux-manager.js');
  const frame = (text: string, x: number, y = 0) =>
    formatPaneSnapshot([`› ${text}`, '  GPT-6-Luna default · ~/case'], { cols: 100, rows: 20, cursorX: x, cursorY: y });
  expect(readGuardedCodexSnapshot(frame('hello', 7))).toBe('hello');
  expect(readGuardedCodexSnapshot(frame('hello', 8))).toBeNull();
  expect(readGuardedCodexSnapshot(frame('hello', 4))).toBeNull();
  expect(readGuardedCodexSnapshot(frame('hello', 7, 1))).toBeNull();
  expect(readGuardedCodexSnapshot('› hello\n  GPT-6-Luna default · ~/case')).toBeNull();
  expect(readGuardedCodexSnapshot(frame('你好', 6))).toBe('你好');
  expect(readGuardedCodexSnapshot(frame('\x1b[38;2;2;100;100mhello\x1b[0m', 7))).toBe('hello');
});
it('reserves receipt capacity before concurrent stages type', async () => {
  store = new GuardedStageStore(() => time, 1, 1000);
  let release: (() => void) | undefined;
  const firstTarget = {
    ...target,
    write: async (text: string) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return target.write(text);
    },
  };
  const first = store.stage(firstTarget, 'alice', 'hello');
  const otherTarget = { ...target, id: 'other' };
  await expect(store.stage(otherTarget, 'alice', 'other')).rejects.toThrow(/capacity/i);
  expect(writes).toEqual([]);
  release!();
  await first;
});
