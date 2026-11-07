import { mkdtemp, writeFile, rm, symlink, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDiscordModelCatalog, readDiscordModelCatalog } from '../src/discord-model-catalog.js';
import type { Session } from '../src/session.js';

let dir: string;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
const model = {
  slug: 'gpt-6.1-sol',
  display_name: 'GPT-6.1-Sol',
  supported_reasoning_levels: [{ effort: 'high' }, { effort: 'max' }],
};
describe('native model catalog metadata', () => {
  it('returns only public selection fields and treats nullable levels as empty', () => {
    expect(
      parseDiscordModelCatalog({
        identity: { token: 'never-return-this' },
        models: [model, { ...model, slug: 'other', supported_reasoning_levels: null }],
      })
    ).toEqual([
      { id: 'gpt-6.1-sol', label: 'GPT-6.1-Sol', efforts: ['high', 'max'] },
      { id: 'other', label: 'GPT-6.1-Sol', efforts: [] },
    ]);
  });
  it.each([null, {}, { models: null }, { models: [null, true, 'model', { slug: '--flag', display_name: 'bad' }] }])(
    'fails closed on invalid catalog metadata',
    (value) => expect(parseDiscordModelCatalog(value)).toEqual([])
  );
  it('reads a bounded regular file from this session config home', async () => {
    dir = await mkdtemp(join(tmpdir(), 'discord-model-catalog-'));
    await writeFile(join(dir, 'models_cache.json'), JSON.stringify({ models: [model], account: 'private' }));
    const session = { workingDir: dir, envOverrideValue: () => dir } as unknown as Session;
    expect(await readDiscordModelCatalog(session)).toEqual([
      { id: model.slug, label: model.display_name, efforts: ['high', 'max'] },
    ]);
  });
  it('refuses a symlink or an oversized file instead of reading through it', async () => {
    dir = await mkdtemp(join(tmpdir(), 'discord-model-catalog-'));
    const target = join(dir, 'other.json');
    await writeFile(target, JSON.stringify({ models: [model] }));
    const path = join(dir, 'models_cache.json');
    await symlink(target, path);
    const session = { workingDir: dir, envOverrideValue: () => dir } as unknown as Session;
    expect(await readDiscordModelCatalog(session)).toEqual([]);
    await rm(path);
    const file = await open(path, 'w');
    await file.truncate(4 * 1024 * 1024 + 1);
    await file.close();
    expect(await readDiscordModelCatalog(session)).toEqual([]);
  });
});
