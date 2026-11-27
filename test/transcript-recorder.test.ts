/** The timer that fills saved transcripts (src/web/transcript-recorder.ts). */
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TranscriptStore } from '../src/transcript-store.js';
import { TranscriptRecorder, type RecordableSession } from '../src/web/transcript-recorder.js';

let dir: string;
let store: TranscriptStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'transcript-recorder-'));
  store = new TranscriptStore(() => dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fake(id: string, text: string | null) {
  let calls = 0;
  const s: RecordableSession & { text: string | null; calls: () => number } = {
    id,
    text,
    calls: () => calls,
    async captureTranscriptText() {
      calls++;
      return s.text;
    },
  };
  return s;
}

describe('TranscriptRecorder', () => {
  it('does not even capture while the setting is off', async () => {
    const s = fake('s1', 'hello');
    await new TranscriptRecorder(store, () => [s]).recordAll();
    expect(s.calls()).toBe(0);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('saves each live session and skips a session with nothing to save', async () => {
    await store.load(true);
    const a = fake('a', 'alpha');
    const b = fake('b', null);
    await new TranscriptRecorder(store, () => [a, b]).recordAll();
    expect(readdirSync(dir)).toEqual(['a.txt']);
    expect(readFileSync(join(dir, 'a.txt'), 'utf-8')).toBe('alpha');
  });

  it('does not rewrite an unchanged snapshot, but writes again after a delete', async () => {
    await store.load(true);
    const a = fake('a', 'alpha');
    const rec = new TranscriptRecorder(store, () => [a]);
    await rec.recordAll();
    rmSync(join(dir, 'a.txt'));
    await rec.recordAll();
    // Deleted behind the store's back: same text, same generation, so not rewritten.
    expect(readdirSync(dir)).toEqual([]);
    await store.remove('a');
    await rec.recordAll();
    expect(readdirSync(dir)).toEqual(['a.txt']);
  });

  it('forces a write after a delete, and does not force while nothing was deleted', async () => {
    await store.load(true);
    const seen: boolean[] = [];
    const s: RecordableSession = {
      id: 'a',
      captureTranscriptText: async (force) => {
        seen.push(force === true);
        return force ? 'text' : null;
      },
    };
    const rec = new TranscriptRecorder(store, () => [s]);
    await rec.recordAll();
    await rec.recordAll();
    await store.remove('a');
    await rec.recordAll();
    expect(seen).toEqual([true, false, true]);
    expect(readdirSync(dir)).toEqual(['a.txt']);
  });

  it('keeps going when one session fails', async () => {
    await store.load(true);
    const bad: RecordableSession = {
      id: 'bad',
      captureTranscriptText: async () => {
        throw new Error('boom');
      },
    };
    await new TranscriptRecorder(store, () => [bad, fake('ok', 'fine')]).recordAll();
    expect(readdirSync(dir)).toEqual(['ok.txt']);
  });
});
