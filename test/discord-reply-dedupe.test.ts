import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DiscordReplyDedupe } from '../src/discord-reply-dedupe.js';
import fs from 'node:fs/promises';
let dir: string;
const guild = '111111111111111111',
  channel = '222222222222222222',
  message = '333333333333333333';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'discord-replies-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
it('claims once across concurrent events and restarts, without storing message content', async () => {
  const store = new DiscordReplyDedupe(dir);
  expect(await Promise.all([store.claim(guild, channel, message), store.claim(guild, channel, message)])).toEqual([
    true,
    false,
  ]);
  expect(await new DiscordReplyDedupe(dir).claim(guild, channel, message)).toBe(false);
  expect((await stat(join(dir, 'discord-reply-dedupe.json'))).mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(join(dir, 'discord-reply-dedupe.json'), 'utf8'))).toEqual([
    [`${guild}:${channel}:${message}`, expect.any(Number)],
  ]);
});
it('falls back on corrupt metadata, logs once, retries after recovery, and retains memory claims', async () => {
  const path = join(dir, 'discord-reply-dedupe.json');
  await writeFile(path, '{');
  const warn = vi.fn(),
    store = new DiscordReplyDedupe(dir, Date.now, warn);
  expect(await store.claim(guild, channel, message)).toBe(true);
  expect(await store.claim(guild, channel, message)).toBe(false);
  expect(warn).toHaveBeenCalledTimes(1);
  await rm(path);
  expect(await store.claim(guild, channel, '444444444444444444')).toBe(true);
  expect(await new DiscordReplyDedupe(dir).claim(guild, channel, message)).toBe(false);
});
it('does not poison metadata with incomplete restored configuration', async () => {
  const store = new DiscordReplyDedupe(dir);
  expect(await store.claim('', channel, message)).toBe(true);
  expect(await store.claim(guild, channel, message)).toBe(true);
  expect(await new DiscordReplyDedupe(dir).claim(guild, channel, message)).toBe(false);
});
it('keeps accepting new replies during ENOSPC and persists memory claims when writes recover', async () => {
  const warn = vi.fn();
  const store = new DiscordReplyDedupe(dir, Date.now, warn);
  const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(Object.assign(new Error('full'), { code: 'ENOSPC' }));
  try {
    expect(await store.claim(guild, channel, message)).toBe(true);
    expect(await store.claim(guild, channel, message)).toBe(false);
    expect(await store.claim(guild, channel, '444444444444444444')).toBe(true);
    expect(await new DiscordReplyDedupe(dir).claim(guild, channel, message)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  } finally {
    rename.mockRestore();
  }
});
it('evicts old records rather than refusing replies at capacity', async () => {
  await writeFile(
    join(dir, 'discord-reply-dedupe.json'),
    JSON.stringify(
      Array.from({ length: 2048 }, (_, i) => [
        `${guild}:${channel}:${String(100000000000000000n + BigInt(i))}`,
        Date.now(),
      ])
    )
  );
  expect(await new DiscordReplyDedupe(dir).claim(guild, channel, message)).toBe(true);
  expect(JSON.parse(await readFile(join(dir, 'discord-reply-dedupe.json'), 'utf8'))).toHaveLength(2048);
});
