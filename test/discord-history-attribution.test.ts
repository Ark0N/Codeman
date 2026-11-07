/** @fileoverview Exact local history attribution and bounded Node reader regressions. */
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readDiscordHistory, readDiscordSessionHistory } from '../src/discord-history.js';
import type { Session } from '../src/session.js';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const managed = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'discord-attribution-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
it('ignores a neighboring tab timestamp and attributes only the exact Codeman originator', async () => {
  const home = join(root, 'codex');
  await mkdir(join(home, 'sessions'), { recursive: true });
  const rollout = (id: string, owner: string, text: string) =>
    JSON.stringify({ type: 'session_meta', payload: { id, cwd: root, originator: `codeman_${owner}` } }) +
    '\n' +
    JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: text } }) +
    '\n';
  await writeFile(join(home, 'sessions', `rollout-${A}.jsonl`), rollout(A, managed, 'OWN'));
  await writeFile(join(home, 'sessions', `rollout-${B}.jsonl`), rollout(B, 'other-tab', 'FOREIGN'));
  const lastSubmitAt = Date.now();
  await writeFile(
    join(home, 'history.jsonl'),
    JSON.stringify({ session_id: B, ts: Math.floor((lastSubmitAt + 5000) / 1000) }) + '\n'
  );
  const session = {
    id: managed,
    mode: 'codex',
    workingDir: root,
    lastSubmitAt,
    codexConfig: {},
    envOverrideValue: () => home,
  } as unknown as Session;
  const history = await readDiscordSessionHistory(session);
  expect(history.conversationId).toBe(A);
  expect(history.turns.map((t) => t.text)).toEqual(['OWN']);
  Object.assign(session, { nativeResumeId: B });
  await expect(readDiscordSessionHistory(session)).rejects.toThrow('identity');
});
it('reads the hook-vouched Claude chain tail instead of a cwd-correlated neighbor', async () => {
  await mkdir(join(root, 'projects', 'project'), { recursive: true });
  for (const [id, text] of [
    [A, 'OWN'],
    [B, 'FOREIGN'],
  ])
    await writeFile(
      join(root, 'projects', 'project', `${id}.jsonl`),
      JSON.stringify({ type: 'user', sessionId: id, message: { content: text } }) + '\n'
    );
  const session = {
    id: managed,
    mode: 'claude',
    workingDir: root,
    claudeSessionId: B,
    claudeSessionIdIsFirstHand: false,
    claudeSessionChain: [A],
    envOverrideValue: () => root,
  } as unknown as Session;
  expect((await readDiscordSessionHistory(session)).turns.map((t) => t.text)).toEqual(['OWN']);
  Object.assign(session, { claudeSessionChain: [] });
  await expect(readDiscordSessionHistory(session)).rejects.toThrow();
});
it('refuses symlinks and FIFOs without spawning Python or blocking on a read', async () => {
  const project = join(root, 'projects', 'project');
  await mkdir(project, { recursive: true });
  const path = join(project, `${A}.jsonl`);
  await writeFile(join(root, 'foreign'), '{}\n');
  await symlink(join(root, 'foreign'), path);
  await expect(readDiscordHistory({ mode: 'claude', conversationId: A, configHome: root })).rejects.toThrow();
  await rm(path);
  execFileSync('mkfifo', [path]);
  await expect(readDiscordHistory({ mode: 'claude', conversationId: A, configHome: root })).rejects.toThrow();
});
it('reads complete bounded tail rows and waits for a final newline', async () => {
  const project = join(root, 'projects', 'project');
  await mkdir(project, { recursive: true });
  const row = (text: string) => JSON.stringify({ type: 'assistant', sessionId: A, message: { content: text } });
  const path = join(project, `${A}.jsonl`);
  await writeFile(path, row('x'.repeat(2200000)) + '\n' + row('complete') + '\n' + row('unfinished'));
  const source = { mode: 'claude', conversationId: A, configHome: root };
  const history = await readDiscordHistory(source);
  expect(history.partial).toBe(true);
  expect(history.turns.map((t) => t.text)).toEqual(['complete']);
});
it('rechecks the configured root before using a warm transcript path cache', async () => {
  const project = join(root, 'projects', 'project');
  await mkdir(project, { recursive: true });
  await writeFile(
    join(project, `${A}.jsonl`),
    JSON.stringify({ type: 'user', sessionId: A, message: { content: 'own' } }) + '\n'
  );
  const source = { mode: 'claude', conversationId: A, configHome: root };
  expect((await readDiscordHistory(source)).turns[0].text).toBe('own');
  const probe = await import('../src/utils/bounded-path-probe.js');
  const original = probe.probePathKind;
  const { vi } = await import('vitest');
  const mock = vi
    .spyOn(probe, 'probePathKind')
    .mockImplementation((path, options) => (path === root ? Promise.resolve('unknown') : original(path, options)));
  try {
    await expect(readDiscordHistory(source)).rejects.toThrow('root unavailable');
  } finally {
    mock.mockRestore();
  }
});
