import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm, symlink, truncate } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  readDiscordHistory,
  readDiscordGeneratedImage,
  readDiscordSessionGeneratedImage,
  discordHistoryCommand,
} from '../src/discord-history.js';
const id = '12345678-1234-1234-1234-123456789abc',
  imageId = 'exec-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5p0AAAAASUVORK5CYII=',
  'base64'
);
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function fixture(large = false, overrides: Record<string, unknown> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'discord-generated-'));
  dirs.push(home);
  await mkdir(join(home, 'sessions'));
  await mkdir(join(home, 'generated_images', id), { recursive: true });
  const path = join(home, 'generated_images', id, imageId + '.png');
  await writeFile(path, png);
  const header = JSON.stringify({ type: 'session_meta', payload: { id, cwd: home } }) + '\n';
  const user =
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-11-08T00:00:00Z',
      payload: { type: 'user_message', message: 'Make an image' },
    }) + '\n';
  const event = JSON.stringify({
    type: 'event_msg',
    timestamp: '2026-11-08T00:01:00Z',
    payload: {
      type: 'item_completed',
      thread_id: id,
      item: {
        type: 'Extension',
        kind: 'image_gen.generation',
        id: imageId,
        status: 'completed',
        failure: null,
        savedPath: path,
        result: large ? 'SECRET_PIXELS'.repeat(200000) : 'SECRET_PIXELS',
        revisedPrompt: 'PRIVATE_PROMPT',
        ...overrides,
      },
    },
  });
  const answer =
    JSON.stringify({
      type: 'event_msg',
      timestamp: '2026-11-08T00:02:00Z',
      payload: { type: 'agent_message', message: 'Concept complete.' },
    }) + '\n';
  await writeFile(join(home, 'sessions', 'rollout-' + id + '.jsonl'), header + user + event + '\n' + answer);
  const image = {
    id: imageId,
    cursor: `${id}:${Buffer.byteLength(header + user)}:${createHash('sha256').update(event).digest('hex').slice(0, 16)}`,
    timestamp: '2026-11-08T00:01:00Z',
  };
  const after = `${id}:${Buffer.byteLength(header)}:${createHash('sha256').update(user.trimEnd()).digest('hex').slice(0, 16)}`;
  return { home, path, image, after, source: { mode: 'codex', conversationId: id, configHome: home } };
}
it('projects completed native image metadata without exporting the prompt/base64 and continues its real cursor', async () => {
  const f = await fixture(true);
  const h = await readDiscordHistory({ ...f.source, after: f.after });
  expect(h.generatedImages).toEqual([f.image]);
  expect(h.scannedCursor).toBe(f.image.cursor);
  expect(h.hasMore).toBe(true);
  expect(JSON.stringify(h)).not.toMatch(/SECRET_PIXELS|PRIVATE_PROMPT/);
  const next = await readDiscordHistory({ ...f.source, after: f.image.cursor });
  expect(next.turns.map((t) => t.text)).toEqual(['Concept complete.']);
  expect(next.generatedImages).toBeUndefined();
  expect(Buffer.from((await readDiscordGeneratedImage(f.source, f.image)).data)).toEqual(png);
});
it('extracts bounded historical metadata without exporting the generated result body', async () => {
  const f = await fixture();
  const h = await readDiscordHistory(f.source);
  expect(h.generatedImages).toEqual([f.image]);
  expect(JSON.stringify(h)).not.toMatch(/SECRET_PIXELS|PRIVATE_PROMPT/);
});
it.each([
  { status: 'failed' },
  { status: 'running' },
  { failure: 'failed' },
  { savedPath: '/tmp/auth.json' },
  { id: '../auth' },
])('refuses unverified image events %j', async (overrides) => {
  const f = await fixture(false, overrides);
  await expect(readDiscordGeneratedImage(f.source, f.image)).rejects.toThrow();
});
it('rejects a changed native cursor, foreign conversation and invalid IDs before image access', async () => {
  const f = await fixture();
  await expect(
    readDiscordGeneratedImage(f.source, {
      ...f.image,
      cursor: f.image.cursor.slice(0, -1) + (f.image.cursor.endsWith('0') ? '1' : '0'),
    })
  ).rejects.toThrow();
  expect(() => discordHistoryCommand(f.source, { ...f.image, id: '../auth' })).toThrow();
  expect(() =>
    discordHistoryCommand({ ...f.source, conversationId: '12345678-1234-1234-1234-123456789def' }, f.image)
  ).toThrow();
});
it('rejects a symlinked generated file even if its target is a PNG', async () => {
  const f = await fixture();
  await rm(f.path);
  const outside = join(f.home, 'outside.png');
  await writeFile(outside, png);
  await symlink(outside, f.path);
  await expect(readDiscordGeneratedImage(f.source, f.image)).rejects.toThrow();
});
it('rejects a symlinked generated directory, non-PNG files and files over 8 MB', async () => {
  const f = await fixture();
  await writeFile(f.path, 'not a PNG');
  await expect(readDiscordGeneratedImage(f.source, f.image)).rejects.toThrow();
  await truncate(f.path, 8 * 1024 * 1024 + 1);
  await expect(readDiscordGeneratedImage(f.source, f.image)).rejects.toThrow();
  await rm(join(f.home, 'generated_images', id), { recursive: true });
  const other = join(f.home, 'outside');
  await mkdir(other);
  await writeFile(join(other, imageId + '.png'), png);
  await symlink(other, join(f.home, 'generated_images', id));
  await expect(readDiscordGeneratedImage(f.source, f.image)).rejects.toThrow();
});

it('binds image reads to the current local profile and refuses a profile change during read', async () => {
  const f = await fixture();
  const session = {
    mode: 'codex',
    id: 'session',
    workingDir: f.home,
    nativeResumeId: id,
    lastSubmitAt: Date.now(),
    nativeModelSettingsRevision: 0,
    envOverrideValue: () => f.home,
  } as unknown as import('../src/session.js').Session;
  expect(Buffer.from((await readDiscordSessionGeneratedImage(session, f.image)).data)).toEqual(png);
  let reads = 0;
  Object.defineProperty(session, 'nativeModelSettingsRevision', { get: () => (reads++ === 0 ? 0 : 1) });
  await expect(readDiscordSessionGeneratedImage(session, f.image)).rejects.toThrow(/changed/);
});
it('does not read host-generated images for container sessions', async () => {
  const f = await fixture();
  await expect(
    readDiscordSessionGeneratedImage(
      {
        mode: 'codex',
        docker: {},
        envOverrideValue: () => {
          throw Error('must not read');
        },
      } as unknown as import('../src/session.js').Session,
      f.image
    )
  ).rejects.toThrow('Container history');
});
