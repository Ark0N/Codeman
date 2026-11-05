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
    expect(await restored.get('a'.repeat(64))).toEqual(value);
    expect(await restored.get('b'.repeat(64))).toEqual(value);
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
