/**
 * Saved transcripts (src/transcript-store.ts): off writes nothing, a transcript is private
 * (0600), bounded, searchable, and every way of deleting one actually deletes it.
 */
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_MATCHES, MAX_TRANSCRIPT_BYTES, TranscriptStore } from '../src/transcript-store.js';

let dir: string;
let store: TranscriptStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'transcript-store-'));
  store = new TranscriptStore(() => dir);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('TranscriptStore', () => {
  it('writes nothing while off', async () => {
    await store.save('s1', 'hello');
    expect(readdirSync(dir)).toEqual([]);
    expect(await store.search('s1', 'hello')).toBeNull();
  });

  it('saves 0600 and finds a word case-insensitively with context', async () => {
    await store.load(true);
    await store.save('s1', ['one', 'two', 'The Deploy Key is here', 'four', 'five', 'six'].join('\n'));
    expect(statSync(join(dir, 's1.txt')).mode & 0o777).toBe(0o600);
    const r = await store.search('s1', 'deploy key');
    expect(r?.total).toBe(1);
    expect(r?.matches[0]).toMatchObject({
      line: 3,
      text: 'The Deploy Key is here',
      before: ['one', 'two'],
      after: ['four', 'five'],
    });
  });

  it('replaces the file as a whole instead of appending', async () => {
    await store.load(true);
    await store.save('s1', 'alpha');
    await store.save('s1', 'beta');
    expect((await store.search('s1', 'alpha'))?.total).toBe(0);
    expect((await store.search('s1', 'beta'))?.total).toBe(1);
  });

  it('caps the stored size to the newest part, on a line boundary', async () => {
    await store.load(true);
    const line = `${'x'.repeat(98)}\n`;
    const old = 'OLDEST\n';
    await store.save('s1', old + line.repeat(Math.ceil(MAX_TRANSCRIPT_BYTES / line.length) + 10) + 'NEWEST\n');
    expect(statSync(join(dir, 's1.txt')).size).toBeLessThanOrEqual(MAX_TRANSCRIPT_BYTES);
    expect((await store.search('s1', 'oldest'))?.total).toBe(0);
    expect((await store.search('s1', 'newest'))?.total).toBe(1);
  });

  it('bounds the matches returned but still counts them all', async () => {
    await store.load(true);
    await store.save('s1', 'hit\n'.repeat(MAX_MATCHES + 50));
    const r = await store.search('s1', 'hit');
    expect(r?.matches).toHaveLength(MAX_MATCHES);
    expect(r?.total).toBe(MAX_MATCHES + 50);
  });

  it('refuses a session id that could leave the folder', async () => {
    await store.load(true);
    await store.save('../evil', 'x');
    await store.save('a/b', 'x');
    expect(readdirSync(dir)).toEqual([]);
    expect(await store.search('../evil', 'x')).toBeNull();
  });

  it('remove deletes one transcript, even while the setting is off', async () => {
    await store.load(true);
    await store.save('s1', 'a');
    await store.save('s2', 'b');
    await store.setEnabled(false);
    // Off already deleted both; put one back by hand to prove remove() works with the setting off.
    writeFileSync(join(dir, 's3.txt'), 'c');
    await store.remove('s3');
    expect(existsSync(join(dir, 's3.txt'))).toBe(false);
  });

  it('turning it off deletes every transcript, and load(false) removes leftovers', async () => {
    await store.load(true);
    await store.save('s1', 'a');
    await store.save('s2', 'b');
    await store.setEnabled(false);
    expect(readdirSync(dir)).toEqual([]);
    writeFileSync(join(dir, 'left.txt'), 'x');
    await new TranscriptStore(() => dir).load(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('sweep removes transcripts no session owns and stray temp files', async () => {
    await store.load(true);
    await store.save('keep', 'a');
    await store.save('gone', 'b');
    writeFileSync(join(dir, 'gone.txt.123.tmp'), 'half');
    expect(await store.sweep((id) => id === 'keep')).toBe(1);
    expect(readdirSync(dir)).toEqual(['keep.txt']);
  });

  it('removeAll reports how many it deleted and bumps the generation', async () => {
    await store.load(true);
    await store.save('s1', 'a');
    await store.save('s2', 'b');
    const before = store.generation;
    expect(await store.removeAll()).toBe(2);
    expect(store.generation).toBeGreaterThan(before);
  });

  it('does not leave a file behind when the setting flips during a write', async () => {
    await store.load(true);
    const pending = store.save('s1', 'secret');
    await store.setEnabled(false);
    await pending;
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe('TranscriptStore.window', () => {
  it('returns the lines around a line, clamped, and null past the end or while off', async () => {
    const d = mkdtempSync(join(tmpdir(), 'transcript-window-'));
    try {
      const s = new TranscriptStore(() => d);
      await s.load(true);
      await s.save('sid', 'a\nb\nc\nd\ne');
      expect(await s.window('sid', 1, 1)).toEqual({ start: 1, lines: ['a', 'b'] });
      expect(await s.window('sid', 5, 2)).toEqual({ start: 3, lines: ['c', 'd', 'e'] });
      expect(await s.window('sid', 6)).toBeNull();
      expect(await s.window('../x', 1)).toBeNull();
      await s.setEnabled(false);
      expect(await s.window('sid', 1)).toBeNull();
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
