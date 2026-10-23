/**
 * Local edit-source reader against a temp projects dir: the transcript lookup, byte-offset
 * reads of the main transcript and its subagents, and the image probe.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  findClaudeTranscript,
  probeLocalPaths,
  readClaudeEditSources,
  resolveClaudeTranscript,
} from '../src/edit-history-local-source.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'edit-src-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(rel: string, content: string | Buffer, mtimeSec?: number): string {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
  if (mtimeSec) utimesSync(path, mtimeSec, mtimeSec);
  return path;
}

describe('findClaudeTranscript', () => {
  it('returns null when no transcript exists under any id', async () => {
    put('p/other.jsonl', 'x\n');
    expect(await findClaudeTranscript(['sid'], root)).toBeNull();
    expect(await findClaudeTranscript(['sid'], join(root, 'missing'))).toBeNull();
  });

  it('takes the first id that has a transcript, the newest one across project dirs', async () => {
    put('a/sid.jsonl', 'old\n', 1000);
    const newest = put('b/sid.jsonl', 'new\n', 2000);
    put('c/second.jsonl', 'x\n');
    expect(await findClaudeTranscript(['bad id!', 'sid', 'second'], root)).toBe(newest);
  });
});

describe('resolveClaudeTranscript', () => {
  it('takes the watcher path (what the hooks reported) as is', async () => {
    expect(await resolveClaudeTranscript('/hooked/conv.jsonl', ['sid'], join(root, 'cfg'))).toBe('/hooked/conv.jsonl');
  });

  it("without one, looks under the session's own claude config dir", async () => {
    const path = put('cfg/projects/p/sid.jsonl', 'x\n');
    expect(await resolveClaudeTranscript(null, ['sid'], join(root, 'cfg'))).toBe(path);
    expect(await resolveClaudeTranscript(undefined, ['other'], join(root, 'cfg'))).toBeNull();
  });
});

describe('readClaudeEditSources', () => {
  it('returns null for a missing file or a path that is not an absolute <id>.jsonl', async () => {
    const path = put('p/sid.jsonl', 'x\n');
    expect(await readClaudeEditSources(join(root, 'p/gone.jsonl'), [], 100)).toBeNull();
    expect(await readClaudeEditSources('p/sid.jsonl', [], 100)).toBeNull();
    expect(await readClaudeEditSources(path.replace('.jsonl', '.txt'), [], 100)).toBeNull();
    expect(await readClaudeEditSources(put('p/bad id.jsonl', 'x\n'), [], 100)).toBeNull();
  });

  it('names the conversation after the file', async () => {
    const res = await readClaudeEditSources(put('p/conv-1.jsonl', 'x\n'), [], 100);
    expect(res?.transcriptId).toBe('conv-1');
  });

  it('reads a new file from its end within the budget, a requested one from its offset', async () => {
    const path = put('p/sid.jsonl', '0123456789');
    const fresh = await readClaudeEditSources(path, [], 4);
    expect(fresh?.files).toEqual([{ relPath: 'main', size: 10, startOffset: 6, chunk: Buffer.from('6789') }]);
    const cont = await readClaudeEditSources(path, [{ relPath: 'main', offset: 3, len: 2 }], 100);
    expect(cont?.files[0]).toMatchObject({ startOffset: 3, chunk: Buffer.from('34') });
  });

  it('clamps an offset past the end to the size (a replaced, shorter file)', async () => {
    const path = put('p/sid.jsonl', 'abc');
    const res = await readClaudeEditSources(path, [{ relPath: 'main', offset: 50 }], 100);
    expect(res?.files[0]).toMatchObject({ size: 3, startOffset: 3, chunk: Buffer.alloc(0) });
  });

  it('lists subagents with their meta for new ones only, and shares the budget main first', async () => {
    const path = put('p/sid.jsonl', 'MAIN');
    put('p/sid/subagents/agent-a1.jsonl', 'AAAA');
    put('p/sid/subagents/agent-a1.meta.json', '{"description":"Fix it"}');
    put('p/sid/subagents/agent-b2.jsonl', 'BBBB');
    put('p/sid/subagents/agent-b2.meta.json', '{"description":"Other"}');
    put('p/sid/subagents/notes.txt', 'ignored');
    const res = await readClaudeEditSources(path, [{ relPath: 'subagents/agent-b2.jsonl', offset: 0 }], 6);
    expect(res?.files.map((f) => [f.relPath, f.startOffset, f.chunk.toString()])).toEqual([
      ['main', 0, 'MAIN'],
      ['subagents/agent-a1.jsonl', 2, 'AA'],
      ['subagents/agent-b2.jsonl', 0, ''],
    ]);
    expect(res?.metas).toEqual({ a1: '{"description":"Fix it"}' });
  });

  it('ignores invalid requests', async () => {
    const path = put('p/sid.jsonl', 'abcdef');
    const res = await readClaudeEditSources(
      path,
      [
        { relPath: '../etc/passwd', offset: 0 },
        { relPath: 'main', offset: -1 },
      ],
      3
    );
    // The invalid main request is dropped, so main is read like a new file.
    expect(res?.files[0]).toMatchObject({ startOffset: 3, chunk: Buffer.from('def') });
  });

  it('keeps multibyte bytes intact (byte offsets, not string lengths)', async () => {
    const path = put('p/sid.jsonl', Buffer.from('äöü\n', 'utf8'));
    const res = await readClaudeEditSources(path, [{ relPath: 'main', offset: 2 }], 100);
    expect(res?.files[0].chunk).toEqual(Buffer.from('äöü\n', 'utf8').subarray(2));
  });

  it('with onlyRequested, reads the requested files and nothing else', async () => {
    const path = put('p/sid.jsonl', 'MAIN');
    put('p/sid/subagents/agent-a1.jsonl', 'AAAA');
    put('p/sid/subagents/agent-b2.jsonl', 'BBBB');
    const res = await readClaudeEditSources(path, [{ relPath: 'subagents/agent-b2.jsonl', offset: 1, len: 2 }], 100, {
      onlyRequested: true,
    });
    expect(res?.files.map((f) => [f.relPath, f.startOffset, f.chunk.toString()])).toEqual([
      ['subagents/agent-b2.jsonl', 1, 'BB'],
    ]);
  });

  it('reads the end of a block that does not fit the budget', async () => {
    const path = put('p/sid.jsonl', '0123456789');
    const res = await readClaudeEditSources(path, [{ relPath: 'main', offset: 2, len: 6 }], 3);
    expect(res?.files[0]).toMatchObject({ startOffset: 5, chunk: Buffer.from('567') });
  });
});

describe('probeLocalPaths', () => {
  it('reports kind, size and mtime, expands ~/ against home, null for missing', async () => {
    put('home/img.png', 'PNG!', 1_700_000_000);
    mkdirSync(join(root, 'dir'));
    const res = await probeLocalPaths(['~/img.png', join(root, 'dir'), join(root, 'nope.png')], join(root, 'home'));
    expect(res[0]).toEqual({ realPath: join(root, 'home/img.png'), kind: 'file', size: 4, mtimeMs: 1_700_000_000_000 });
    expect(res[1]).toMatchObject({ kind: 'directory', size: 0 });
    expect(res[2]).toBeNull();
  });
});
