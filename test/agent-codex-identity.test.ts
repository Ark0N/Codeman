/** @fileoverview Strict bounded native rollout attribution without viewer heuristics. */
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findExactCodexConversation, resolveEffectiveCodexHome } from '../src/agent-codex-identity.js';
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-attribution-'));
  roots.push(root);
  const home = join(root, 'home');
  await mkdir(join(home, 'sessions'), { recursive: true });
  const options = { codexHome: home, sessionId: 'managed', workingDir: root };
  const put = async (id: string, payload: object = {}, text?: string) => {
    const path = join(home, 'sessions', `rollout-${id}.jsonl`);
    await writeFile(
      path,
      text ??
        JSON.stringify({
          type: 'session_meta',
          payload: { id, cwd: root, originator: 'codeman_managed', ...payload },
        }) + '\n'
    );
    return path;
  };
  return { root, home, options, put };
}
it('requires one complete native session_meta matching the rollout ID, managed originator and canonical workspace', async () => {
  const f = await fixture();
  const path = await f.put(A);
  expect(await findExactCodexConversation(f.options)).toEqual({ id: A, path });
  await f.put(A, { id: B });
  expect(await findExactCodexConversation(f.options)).toBeUndefined();
});
it('never chooses newest cwd files or an ambiguous managed originator', async () => {
  const f = await fixture();
  await f.put(A, { originator: 'codex_cli' });
  expect(await findExactCodexConversation(f.options)).toBeUndefined();
  await f.put(A);
  await f.put(B);
  expect(await findExactCodexConversation(f.options)).toBeUndefined();
});
it('allows an explicit resume identity but still requires native metadata and the workspace', async () => {
  const f = await fixture();
  const path = await f.put(A, { originator: 'original-launch' });
  expect(await findExactCodexConversation({ ...f.options, resumeSessionId: A })).toEqual({ id: A, path });
  await f.put(B);
  expect(await findExactCodexConversation({ ...f.options, resumeSessionId: A })).toBeUndefined();
  await f.put(A, { cwd: f.home });
  expect(await findExactCodexConversation({ ...f.options, resumeSessionId: A })).toBeUndefined();
});
it.each(['partial', 'duplicate', 'oversized'] as const)('refuses %s metadata', async (kind) => {
  const f = await fixture();
  const row = JSON.stringify({ type: 'session_meta', payload: { id: A, cwd: f.root, originator: 'codeman_managed' } });
  await f.put(
    A,
    {},
    kind === 'partial'
      ? row
      : kind === 'duplicate'
        ? row + '\n' + row + '\n'
        : row.slice(0, -2) + ',"instructions":"' + 'x'.repeat(140000) + '"}}\n'
  );
  expect(await findExactCodexConversation(f.options)).toBeUndefined();
});
it('enforces traversal/read caps and ignores symlinked directories', async () => {
  const f = await fixture();
  await f.put(A);
  expect(await findExactCodexConversation(f.options, { maxEntries: 0, maxBytes: 1048576 })).toBeUndefined();
  expect(await findExactCodexConversation(f.options, { maxEntries: 8192, maxBytes: 128 })).toBeUndefined();
  await mkdir(join(f.root, 'elsewhere'));
  await symlink(join(f.root, 'elsewhere'), join(f.home, 'sessions', 'alias'));
  expect((await findExactCodexConversation(f.options))?.id).toBe(A);
});
it('resolves per-session, process and default CODEX_HOME relative to the session workspace', () => {
  expect(resolveEffectiveCodexHome('custom', '/tmp/work', { CODEX_HOME: '/other' })).toBe('/tmp/work/custom');
  expect(resolveEffectiveCodexHome(undefined, '/tmp/work', { CODEX_HOME: 'process' })).toBe('/tmp/work/process');
  expect(resolveEffectiveCodexHome(undefined, '/tmp/work', { HOME: '/tmp/user' })).toBe('/tmp/user/.codex');
});

it.each([
  ['trailing-space', 'codex-home ', 'codex-home'],
  ['whitespace-only', '   ', '.codex'],
])(
  'keeps the raw %s CODEX_HOME namespace through the Session getter and attribution helper',
  async (_label, configured, wrongHome) => {
    const { Session } = await import('../src/session.js');
    const f = await fixture();
    const expectedHome = join(f.root, configured);
    const siblingHome = join(f.root, wrongHome);
    const record =
      JSON.stringify({ type: 'session_meta', payload: { id: A, cwd: f.root, originator: 'codeman_managed' } }) + '\n';
    for (const home of [expectedHome, siblingHome]) {
      await mkdir(join(home, 'sessions'), { recursive: true });
      await writeFile(join(home, 'sessions', `rollout-${A}.jsonl`), record);
    }
    const session = new Session({
      id: 'managed',
      workingDir: f.root,
      mode: 'codex',
      envOverrides: { CODEX_HOME: configured },
    });
    try {
      const codexHome = resolveEffectiveCodexHome(session.getCodexHomeOverride(), session.workingDir, { HOME: f.root });
      expect(await findExactCodexConversation({ ...f.options, codexHome })).toEqual({
        id: A,
        path: join(expectedHome, 'sessions', `rollout-${A}.jsonl`),
      });
      expect(session.getCodexHomeOverride()).toBe(configured);
    } finally {
      await session.stop(false);
    }
  }
);

it('attributes an owned rollout among 320 unrelated full-size metadata prefixes', async () => {
  const f = await fixture();
  const path = await f.put(A);
  await Promise.all(
    Array.from({ length: 320 }, (_, n) => {
      const id = `10000000-1111-4111-8111-${String(n).padStart(12, '0')}`;
      return f.put(id, { originator: 'codex_cli', instructions: 'x'.repeat(5000) });
    })
  );
  expect(await findExactCodexConversation(f.options)).toEqual({ id: A, path });
  expect(
    await findExactCodexConversation(f.options, { maxEntries: 8192, maxBytes: 1048576, maxPrefixBytes: 4096 })
  ).toBeUndefined();
});

it.each(['workspace', 'metadata'] as const)(
  'probes %s bounded past the cap before canonical filesystem reads',
  async (where) => {
    const { vi } = await import('vitest');
    const probe = await import('../src/utils/bounded-path-probe.js');
    const f = await fixture();
    const alias = join(f.root, 'workspace-alias');
    await symlink(f.root, alias);
    await f.put(A, { cwd: where === 'metadata' ? alias : f.root });
    const blocked = where === 'workspace' ? f.root : alias;
    const spy = vi
      .spyOn(probe, 'probePathKind')
      .mockImplementation(async (path) => (path === blocked ? 'unknown' : 'directory'));
    try {
      expect(await findExactCodexConversation(f.options)).toBeUndefined();
      expect(spy).toHaveBeenCalledWith(blocked, { pastCap: true });
    } finally {
      spy.mockRestore();
    }
  }
);
