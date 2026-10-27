/**
 * Reading a DeepSeek Harness session transcript.
 *
 * Two of these assertions exist because the obvious implementation was measured
 * to be wrong against real files:
 *
 * - dsh appends ONE ZSTD FRAME PER WRITE, and Node's `zlib` zstd decoder
 *   before 24.22 and 26.10 stops at the first frame end. A 56-line transcript
 *   decoded as 1 line / 158 bytes, which reads as "the worker never answered"
 *   rather than as an error. Newer Node decodes every frame (nodejs/node#65865),
 *   so the multi-frame fixtures below pin the walker itself, not Node's decoder.
 * - a fresh worker in a case directory that had been used before answered its
 *   first `last-response` with the PREVIOUS session's reply. Session-to-
 *   transcript pairing is therefore its own describe block.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as zlib from 'node:zlib';

import {
  decodeZstdFrames,
  findDeepSeekTranscript,
  parseDeepSeekTranscript,
  readDeepSeekLastResponse,
  resetDeepSeekTranscriptMemoForTest,
  resolveDeepSeekHome,
  zstdFrameRanges,
  zstdSupported,
} from '../src/deepseek-transcript.js';

const zstdCompressSync = (zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync;

/** Compress each line into its own frame — exactly how dsh appends. */
function framed(lines: string[]): Buffer {
  if (!zstdCompressSync) throw new Error('zstd unavailable');
  return Buffer.concat(lines.map((line) => zstdCompressSync(Buffer.from(`${line}\n`, 'utf8'))));
}

const sessionHeader = (cwd: string, createdAt: number, id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee') =>
  JSON.stringify({ type: 'session', version: 0, id, createdAt, cwd, delegationDepth: 0 });

const userPrompt = (text: string) =>
  JSON.stringify({
    type: 'user/message',
    data: { content: [{ type: 'text', text }], source: { kind: 'user' }, role: 'user' },
  });

const pluginContext = (text: string) =>
  JSON.stringify({
    type: 'user/message',
    data: { content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } },
  });

const assistantMessage = (text: string, turn = 1, step = 1, time = 1_700_000_000_000) =>
  JSON.stringify({
    type: 'assistant/message',
    time,
    data: { turn, step, message: { role: 'assistant', content: [{ type: 'text', text }] } },
  });

const turnEnd = (turn: number, reason: Record<string, unknown>, time = 1_700_000_000_001) =>
  JSON.stringify({ type: 'turn/end', time, data: { turn, reason } });

describe.skipIf(!zstdSupported())('zstd frame walking', () => {
  it('decodes every frame, not just the first (the silent-truncation bug)', () => {
    const lines = Array.from({ length: 40 }, (_, i) => JSON.stringify({ type: 'noise', seq: i }));
    const buf = framed(lines);

    expect(zstdFrameRanges(buf)).toHaveLength(40);
    expect(decodeZstdFrames(buf).trim().split('\n')).toHaveLength(40);
  });

  it('round-trips a single-frame file', () => {
    const buf = framed(['{"type":"session"}']);
    expect(decodeZstdFrames(buf)).toBe('{"type":"session"}\n');
  });

  it('passes an uncompressed transcript straight through', () => {
    const plain = Buffer.from('{"type":"session"}\n{"type":"turn/start"}\n', 'utf8');
    expect(decodeZstdFrames(plain)).toBe('{"type":"session"}\n{"type":"turn/start"}\n');
  });

  it('keeps the whole frames before a torn tail instead of failing the read', () => {
    const buf = framed(['{"a":1}', '{"b":2}', '{"c":3}']);
    const torn = buf.subarray(0, buf.length - 4);
    const decoded = decodeZstdFrames(torn);
    expect(decoded).toContain('{"a":1}');
    expect(decoded).toContain('{"b":2}');
    expect(decoded).not.toContain('{"c":3}');
  });

  it('refuses to walk a buffer that is not zstd', () => {
    expect(zstdFrameRanges(Buffer.from('not zstd at all', 'utf8'))).toEqual([]);
  });
});

describe('parseDeepSeekTranscript', () => {
  it('returns the last turn text and skips plugin-injected context', () => {
    const raw = [
      sessionHeader('/w', 1),
      userPrompt('what is 2+2?'),
      pluginContext('Current runtime context. This snapshot supersedes earlier snapshots.'),
      assistantMessage('4.'),
      turnEnd(1, { kind: 'completed' }),
    ].join('\n');

    const result = parseDeepSeekTranscript(raw, { blocks: true });
    expect(result.text).toBe('4.');
    expect(result.cwd).toBe('/w');
    expect(result.blocks.filter((b) => b.kind === 'prompt').map((b) => b.text)).toEqual(['what is 2+2?']);
    expect(result.blocks.some((b) => b.text.includes('runtime context'))).toBe(false);
  });

  it('drops a leaked reasoning prefix at the closing tag', () => {
    const raw = [
      sessionHeader('/w', 1),
      assistantMessage('I should read the file first.</think>\n\nThe add function is wrong.'),
      turnEnd(1, { kind: 'completed' }),
    ].join('\n');
    expect(parseDeepSeekTranscript(raw).text).toBe('The add function is wrong.');
  });

  it('renders tool calls and tool results as tool blocks', () => {
    const raw = [
      sessionHeader('/w', 1),
      JSON.stringify({
        type: 'assistant/message',
        data: {
          turn: 1,
          step: 1,
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Reading it.' },
              { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"calc.py"}' },
            ],
          },
        },
      }),
      JSON.stringify({
        type: 'tool/result',
        data: {
          turn: 1,
          step: 1,
          message: {
            content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'def add' }] }],
          },
        },
      }),
      assistantMessage('It subtracts instead of adding.', 1, 2),
      turnEnd(1, { kind: 'completed' }),
    ].join('\n');

    const result = parseDeepSeekTranscript(raw, { blocks: true });
    expect(result.blocks.filter((b) => b.kind === 'tool').map((b) => b.text)).toEqual([
      'read({"file_path":"calc.py"})',
      'def add',
    ]);
    // Both steps of the turn read back, in order.
    expect(result.text).toBe('Reading it.\n\nIt subtracts instead of adding.');
  });

  it('uses streamed deltas only for a step the model never finalized', () => {
    const raw = [
      sessionHeader('/w', 1),
      JSON.stringify({
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Par' } },
      }),
      JSON.stringify({
        type: 'text-chunks',
        seq: null,
        data: { turn: 1, step: 1, index: 0, texts: ['is is ', 'the'] },
      }),
      JSON.stringify({
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: ' capital.' } },
      }),
    ].join('\n');
    // Still streaming: the partial answer is readable.
    expect(parseDeepSeekTranscript(raw).text).toBe('Paris is the capital.');

    // Once finalized, the deltas must not be appended a second time.
    const finalized = `${raw}\n${assistantMessage('Paris is the capital.')}\n${turnEnd(1, { kind: 'completed' })}`;
    expect(parseDeepSeekTranscript(finalized).text).toBe('Paris is the capital.');
  });

  it('does not resurrect raw deltas for a step whose reply was all reasoning', () => {
    // Measured on a real conversation: step 1 finalized as reasoning only, so
    // its text stripped to '' and the (unstripped) deltas took its place,
    // putting `</think>` and the monologue back in front of the caller.
    const raw = [
      sessionHeader('/w', 1),
      JSON.stringify({
        type: 'assistant/chunk',
        data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: "I'll read the file.</think>\n\n" } },
      }),
      assistantMessage("I'll read the file.</think>\n\n", 1, 1),
      assistantMessage('The add function is wrong.', 1, 2),
      turnEnd(1, { kind: 'completed' }),
    ].join('\n');
    expect(parseDeepSeekTranscript(raw).text).toBe('The add function is wrong.');
  });

  it('answers a failed turn with its error rather than the previous turn text', () => {
    const raw = [
      sessionHeader('/w', 1),
      assistantMessage('First answer.', 1),
      turnEnd(1, { kind: 'completed' }),
      turnEnd(2, { kind: 'error', error: { message: '400: model does not support tools', code: 'INVALID_REQUEST' } }),
    ].join('\n');
    expect(parseDeepSeekTranscript(raw).text).toBe('Turn error: 400: model does not support tools');
  });

  it('calls an early stop an ending, not an error, and keeps the text it did produce', () => {
    const raw = [sessionHeader('/w', 1), assistantMessage('Most'), turnEnd(1, { kind: 'max-tokens' })].join('\n');
    const result = parseDeepSeekTranscript(raw, { blocks: true });
    expect(result.text).toBe('Most');
    expect(result.blocks.map((b) => b.text)).toContain('Turn ended: max-tokens');
  });

  it('survives a torn last line', () => {
    const raw = [sessionHeader('/w', 1), assistantMessage('Complete.'), '{"type":"turn/e'].join('\n');
    expect(parseDeepSeekTranscript(raw).text).toBe('Complete.');
  });

  it('is empty for a session that has said nothing', () => {
    expect(parseDeepSeekTranscript(sessionHeader('/w', 1)).text).toBe('');
  });
});

describe('resolveDeepSeekHome', () => {
  it('prefers the session override over the environment', () => {
    const previous = process.env.DSH_HOME;
    process.env.DSH_HOME = '/from-env';
    try {
      expect(resolveDeepSeekHome({ deepSeekHomeOverride: '/from-session' })).toBe('/from-session');
      expect(resolveDeepSeekHome({})).toBe('/from-env');
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
    }
  });

  it('falls back to ~/.dsh', () => {
    const previous = process.env.DSH_HOME;
    delete process.env.DSH_HOME;
    try {
      expect(resolveDeepSeekHome({})).toMatch(/\.dsh$/);
    } finally {
      if (previous !== undefined) process.env.DSH_HOME = previous;
    }
  });
});

describe.skipIf(!zstdSupported())('session-to-transcript pairing', () => {
  let dshHome: string;
  const workspace = '/home/tester/cases/worker-1';
  const sessionStart = 1_800_000_000_000;

  /** Write a transcript for `cwd`, created at `createdAt`, mtime `mtime`. */
  async function writeTranscript(name: string, cwd: string, createdAt: number, mtime: number, answer?: string) {
    const dir = join(dshHome, 'sessions', '--home-tester-cases-worker-1--', name);
    await mkdir(dir, { recursive: true });
    const lines = [sessionHeader(cwd, createdAt, name)];
    if (answer) lines.push(assistantMessage(answer), turnEnd(1, { kind: 'completed' }));
    const path = join(dir, 'session.jsonl.zstd');
    await writeFile(path, framed(lines));
    await utimes(path, new Date(mtime), new Date(mtime));
    return path;
  }

  beforeAll(async () => {
    dshHome = await mkdtemp(join(tmpdir(), 'dsh-home-'));
  });
  afterAll(async () => {
    await rm(dshHome, { recursive: true, force: true });
  });

  it("never hands a fresh session its predecessor's answer", async () => {
    await writeTranscript('older', workspace, sessionStart - 600_000, sessionStart - 590_000, 'stale answer');
    const found = await findDeepSeekTranscript({ dshHome, workingDir: workspace, startedAt: sessionStart });
    expect(found).toBeNull();

    const result = await readDeepSeekLastResponse({
      workingDir: workspace,
      createdAt: sessionStart,
      deepSeekHomeOverride: dshHome,
    });
    expect(result).not.toBeNull();
    expect(result?.text).toBe('');
  });

  it('pairs on the boot window even when a sibling wrote more recently', async () => {
    await writeTranscript('mine', workspace, sessionStart + 2_000, sessionStart + 2_000, 'my answer');
    await writeTranscript('sibling', workspace, sessionStart + 300_000, sessionStart + 400_000, 'sibling answer');

    const found = await findDeepSeekTranscript({ dshHome, workingDir: workspace, startedAt: sessionStart });
    expect(found).toContain('/mine/');

    const result = await readDeepSeekLastResponse({
      workingDir: workspace,
      createdAt: new Date(sessionStart),
      deepSeekHomeOverride: dshHome,
    });
    expect(result?.text).toBe('my answer');
  });

  it('ignores a transcript recorded for another workspace', async () => {
    const other = await mkdtemp(join(tmpdir(), 'dsh-home-'));
    try {
      const dir = join(other, 'sessions', '--home-tester-cases-worker-1--', 'foreign');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'session.jsonl.zstd'),
        framed([sessionHeader('/somewhere/else', sessionStart + 1_000), assistantMessage('not yours')])
      );
      const found = await findDeepSeekTranscript({ dshHome: other, workingDir: workspace, startedAt: sessionStart });
      expect(found).toBeNull();
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('reads a transcript created later in the session (a /new conversation)', async () => {
    const later = await mkdtemp(join(tmpdir(), 'dsh-home-'));
    try {
      const dir = join(later, 'sessions', '--home-tester-cases-worker-1--', 'after-new');
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'session.jsonl.zstd'),
        framed([
          sessionHeader(workspace, sessionStart + 1_800_000),
          assistantMessage('after /new'),
          turnEnd(1, { kind: 'completed' }),
        ])
      );
      const result = await readDeepSeekLastResponse({
        workingDir: workspace,
        createdAt: sessionStart,
        deepSeekHomeOverride: later,
      });
      expect(result?.text).toBe('after /new');
    } finally {
      await rm(later, { recursive: true, force: true });
    }
  });

  it('reports an unreadable home as empty, not as an error', async () => {
    const result = await readDeepSeekLastResponse({
      workingDir: workspace,
      createdAt: sessionStart,
      deepSeekHomeOverride: join(tmpdir(), 'dsh-home-that-does-not-exist'),
    });
    expect(result).toEqual({ text: '', timestamp: '', blocks: [] });
  });

  it('serves an unchanged transcript from the memo and re-reads when the stat moves', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-home-'));
    try {
      const dir = join(home, 'sessions', '--home-tester-cases-worker-1--', 'memo');
      await mkdir(dir, { recursive: true });
      const path = join(dir, 'session.jsonl');
      const stamp = new Date(sessionStart + 1_000);
      const read = () =>
        readDeepSeekLastResponse({ workingDir: workspace, createdAt: sessionStart, deepSeekHomeOverride: home });
      const body = (answer: string) =>
        `${[sessionHeader(workspace, sessionStart + 1_000), assistantMessage(answer), turnEnd(1, { kind: 'completed' })].join('\n')}\n`;

      resetDeepSeekTranscriptMemoForTest();
      await writeFile(path, body('AAAA'));
      await utimes(path, stamp, stamp);
      expect((await read())?.text).toBe('AAAA');

      // Same byte length, same forced mtime: indistinguishable from unchanged
      // by stat, and deliberately served from the memo — the 1s/poll skill loop
      // must not decode an unchanged file, and dsh only ever APPENDS, so a
      // same-stat rewrite does not exist outside a test.
      await writeFile(path, body('BBBB'));
      await utimes(path, stamp, stamp);
      expect((await read())?.text).toBe('AAAA');

      // An append moves mtime (and normally size), which is the invalidation.
      await utimes(path, new Date(sessionStart + 2_000), new Date(sessionStart + 2_000));
      expect((await read())?.text).toBe('BBBB');
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
