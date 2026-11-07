import { expect, it } from 'vitest';
import { mkdtemp, stat, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiscordHistoryWarnings } from '../src/discord-history-warnings.js';
it('keeps unresolved warning intent and message identity across restart until explicitly cleared', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'history-warning-'));
  try {
    const key = 'a'.repeat(64);
    const store = new DiscordHistoryWarnings(dir);
    await store.set(key, null);
    expect(await new DiscordHistoryWarnings(dir).get(key)).toEqual({ pending: true, message: null });
    await store.set(key, '111111111111111111');
    expect(await new DiscordHistoryWarnings(dir).get(key)).toEqual({ pending: true, message: '111111111111111111' });
    expect((await stat(join(dir, 'discord-history-warnings.json'))).mode & 0o777).toBe(0o600);
    await store.set(key, undefined);
    expect(await new DiscordHistoryWarnings(dir).get(key)).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it('rejects corrupt or symlink state instead of forgetting deduplication', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'history-warning-'));
  try {
    const p = join(dir, 'discord-history-warnings.json');
    await writeFile(p, 'broken');
    await expect(new DiscordHistoryWarnings(dir).get('a'.repeat(64))).rejects.toThrow();
    await rm(p);
    await writeFile(join(dir, 'other'), '[]');
    await symlink(join(dir, 'other'), p);
    await expect(new DiscordHistoryWarnings(dir).get('a'.repeat(64))).rejects.toThrow();
    expect(await readFile(join(dir, 'other'), 'utf8')).toBe('[]');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it('allows only one warning publisher under concurrent synchronization and idle hooks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'history-warning-'));
  try {
    const store = new DiscordHistoryWarnings(dir);
    const key = 'b'.repeat(64);
    const results = await Promise.all(Array.from({ length: 20 }, () => store.claim(key)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await new DiscordHistoryWarnings(dir).claim(key)).toBe(false);
    await store.set(key, undefined);
    expect(await store.claim(key)).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
