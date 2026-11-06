import { mkdtemp, readFile, stat, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { it, expect } from 'vitest';
import { DiscordConversationProgressStore } from '../src/discord-conversation-progress.js';
it('persists private bounded metadata and serializes concurrent destination updates', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'discord-boundary-'));
  try {
    const store = new DiscordConversationProgressStore(dir);
    const value = {
      conversationId: 'native1',
      seed: ['native1:1:abc'],
      seedIndex: 0,
      seeded: false,
      cursor: 'native1:1:abc',
    };
    await Promise.all([store.set('a'.repeat(64), value), store.set('b'.repeat(64), value)]);
    const restored = new DiscordConversationProgressStore(dir);
    expect(await restored.get('a'.repeat(64))).toMatchObject(value);
    expect(await restored.get('b'.repeat(64))).toMatchObject(value);
    const path = join(dir, 'discord-conversations.json');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).not.toContain('prompt');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('fails closed on corrupt, symlinked or invalid progress instead of replaying history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'discord-boundary-'));
  try {
    const path = join(dir, 'discord-conversations.json');
    await writeFile(path, '{broken');
    await expect(new DiscordConversationProgressStore(dir).get('a')).rejects.toThrow('paused');
    await rm(path);
    await writeFile(join(dir, 'other'), '[]');
    await symlink(join(dir, 'other'), path);
    await expect(new DiscordConversationProgressStore(dir).get('a')).rejects.toThrow('paused');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('deletes session boundaries across scopes and ages out only finished entries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'discord-boundary-retention-'));
  let now = 1000;
  const store = new DiscordConversationProgressStore(dir, () => now);
  const value = { conversationId: 'native1', sessionId: 's1', seed: [], seedIndex: 0, seeded: true, streamOff: true };
  try {
    await store.set('a'.repeat(64), value);
    await store.set('b'.repeat(64), { ...value, sessionId: 's2' });
    await store.reconcile(new Set(['a'.repeat(64)]));
    now += 8 * 86400000;
    await store.set('c'.repeat(64), { ...value, sessionId: 's1' });
    expect((await store.get('a'.repeat(64)))?.streamOff).toBe(true);
    expect(await store.get('b'.repeat(64))).toBeUndefined();
    await store.deleteSession('s1');
    expect(await store.get('a'.repeat(64))).toBeUndefined();
    expect(await store.get('c'.repeat(64))).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('reuses capacity after 1024 finished boundaries age out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'discord-boundary-capacity-'));
  try {
    const rows = Array.from({ length: 1024 }, (_, i) => [
      i.toString(16).padStart(64, '0'),
      { conversationId: 'native1', seed: [], seedIndex: 0, seeded: true, finishedAt: 1 },
    ]);
    await writeFile(join(dir, 'discord-conversations.json'), JSON.stringify(rows));
    const store = new DiscordConversationProgressStore(dir, () => 8 * 86400000);
    await store.set('f'.repeat(64), { conversationId: 'native2', seed: [], seedIndex: 0, seeded: true });
    expect((await store.get('f'.repeat(64)))?.conversationId).toBe('native2');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('reactivates an old scope without deleting its saved stream preference', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'discord-boundary-reactivate-'));
  let now = 1000;
  const store = new DiscordConversationProgressStore(dir, () => now);
  try {
    await store.set('a'.repeat(64), {
      conversationId: 'native1',
      seed: [],
      seedIndex: 0,
      seeded: true,
      streamOff: true,
    });
    await store.reconcile(new Set());
    now += 8 * 86400000;
    await store.reconcile(new Set(['a'.repeat(64)]));
    expect((await store.get('a'.repeat(64)))?.streamOff).toBe(true);
    expect((await store.get('a'.repeat(64)))?.finishedAt).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
