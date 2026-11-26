/**
 * @fileoverview The incremental Claude transcript reader behind `last-response`
 * (src/web/claude-response-transcript.ts).
 *
 * Every read must answer what a parse of the whole file answers, whatever the file did between
 * reads: grew, grew by half a line, shrank, was replaced, or was rewritten in place. A read must
 * also parse only the bytes appended since the last one, and overlapping reads of one file must
 * share their passes.
 */

import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ClaudeResponseParser,
  ClaudeTranscriptReader,
  parseClaudeResponseTranscript,
} from '../src/web/claude-response-transcript.js';
import { KEEP_WARM_NUDGE } from '../src/prompt-cache-keepwarm.js';

const user = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', timestamp: '2026-11-27T10:00:00Z', message: { content: text }, ...extra });
const assistant = (text: string, ts = '2026-11-27T10:00:01Z') =>
  JSON.stringify({ type: 'assistant', timestamp: ts, message: { content: [{ type: 'text', text }] } });
const toolUse = () =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } });
const toolResult = () =>
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } });
const queued = (prompt: string) =>
  JSON.stringify({
    type: 'attachment',
    attachment: { type: 'queued_command', prompt, commandMode: 'prompt', origin: { kind: 'human' } },
  });

/** A conversation that exercises turns, queued prompts, replays, keep-warm turns and tool rows. */
const LINES = [
  user('first prompt'),
  user('first prompt'), // a replayed row, collapsed
  toolUse(),
  toolResult(),
  assistant('first answer'),
  assistant('first answer'), // a replayed snapshot, collapsed
  user('second prompt'),
  queued('queued while working'),
  assistant('second answer — with ünïcödé and 漢字 to cut mid-character'),
  JSON.stringify({ type: 'user', isSidechain: true, message: { content: 'sidechain' } }),
  user(KEEP_WARM_NUDGE),
  assistant('ok'),
  '{ not json',
  user('<system-reminder>synthetic</system-reminder>'),
  user('third prompt'),
  assistant('third answer'),
];

describe('ClaudeResponseParser', () => {
  it('answers the same whether fed at once or line by line, and its answers never change later', () => {
    const whole = parseClaudeResponseTranscript(LINES.join('\n') + '\n');
    const parser = new ClaudeResponseParser();
    const early = (() => {
      for (const line of LINES.slice(0, 5)) parser.feedLine(line);
      return parser.result();
    })();
    for (const line of LINES.slice(5)) parser.feedLine(line);
    expect(parser.result()).toEqual(whole);
    expect(early.messages).toHaveLength(2);
    expect(whole.text).toBe('third answer');
    expect(whole.messages.map((m) => m.text)).toEqual([
      'first prompt',
      'first answer',
      'second prompt',
      'queued while working',
      'second answer — with ünïcödé and 漢字 to cut mid-character',
      KEEP_WARM_NUDGE,
      'ok',
      'third prompt',
      'third answer',
    ]);
    expect(whole.messages.filter((m) => m.keepAlive).map((m) => m.text)).toEqual([KEEP_WARM_NUDGE, 'ok']);
  });

  it('leaves the original untouched when a clone parses more', () => {
    const parser = new ClaudeResponseParser();
    parser.feedLine(user('p'));
    const copy = parser.clone();
    copy.feedLine(assistant('a'));
    expect(parser.result().messages).toHaveLength(1);
    expect(copy.result().messages).toHaveLength(2);
  });
});

describe('ClaudeTranscriptReader', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claude-transcript-reader-'));
    file = join(dir, 'conversation.jsonl');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  const whole = () => parseClaudeResponseTranscript(LINES.join('\n') + '\n');

  it('answers a parse of the whole file after each append, at any byte boundary', async () => {
    const bytes = Buffer.from(LINES.join('\n') + '\n', 'utf8');
    // A tiny chunk size makes reads cut lines and multi-byte characters.
    const reader = new ClaudeTranscriptReader({ chunkBytes: 7 });
    writeFileSync(file, '');
    for (let cut = 0; cut < bytes.length; ) {
      const next = Math.min(bytes.length, cut + 1 + ((cut * 37) % 53));
      appendFileSync(file, bytes.subarray(cut, next));
      cut = next;
      const expected = parseClaudeResponseTranscript(bytes.subarray(0, cut).toString('utf8'));
      // A cut inside a multi-byte character leaves a line that is not JSON either way.
      expect(await reader.read(file)).toEqual(expected);
    }
    expect(await reader.read(file)).toEqual(whole());
  });

  it('parses only the bytes appended since the last read', async () => {
    writeFileSync(file, LINES.slice(0, 8).join('\n') + '\n');
    const reader = new ClaudeTranscriptReader();
    await reader.read(file);
    const expected = whole();
    const feed = vi.spyOn(ClaudeResponseParser.prototype, 'feedLine');
    appendFileSync(file, LINES.slice(8).join('\n') + '\n');
    expect(await reader.read(file)).toEqual(expected);
    // Only the appended lines; the empty string after the last newline is never fed.
    expect(feed.mock.calls.map(([line]) => line)).toEqual(LINES.slice(8));
    feed.mockClear();
    expect(await reader.read(file)).toEqual(expected);
    expect(feed).not.toHaveBeenCalled();
  });

  it('answers a last line that has no newline yet, and parses it once its newline arrives', async () => {
    writeFileSync(file, `${user('p')}\n${assistant('a')}`);
    const reader = new ClaudeTranscriptReader();
    expect((await reader.read(file)).text).toBe('a');
    appendFileSync(file, `\n${assistant('b')}\n`);
    expect(await reader.read(file)).toEqual(
      parseClaudeResponseTranscript(`${user('p')}\n${assistant('a')}\n${assistant('b')}\n`)
    );
  });

  it('starts again from byte 0 when the file shrank', async () => {
    writeFileSync(file, LINES.join('\n') + '\n');
    const reader = new ClaudeTranscriptReader();
    await reader.read(file);
    writeFileSync(file, `${user('new')}\n${assistant('fresh')}\n`);
    expect(await reader.read(file)).toEqual(parseClaudeResponseTranscript(`${user('new')}\n${assistant('fresh')}\n`));
  });

  it('starts again from byte 0 when another file replaced it', async () => {
    writeFileSync(file, `${user('p')}\n${assistant('a')}\n`);
    const reader = new ClaudeTranscriptReader();
    await reader.read(file);
    const replacement = join(dir, 'replacement.jsonl');
    writeFileSync(replacement, LINES.join('\n') + '\n');
    renameSync(replacement, file);
    expect(await reader.read(file)).toEqual(whole());
  });

  it('starts again from byte 0 when the file was rewritten in place to a larger size', async () => {
    writeFileSync(file, `${user('p')}\n${assistant('a')}\n`);
    const reader = new ClaudeTranscriptReader();
    await reader.read(file);
    const handle = await fs.open(file, 'r+');
    await handle.truncate(0);
    await handle.write(LINES.join('\n') + '\n', 0);
    await handle.close();
    expect(await reader.read(file)).toEqual(whole());
  });

  it('shares one pass between reads asked for while a read runs', async () => {
    writeFileSync(file, LINES.join('\n') + '\n');
    const reader = new ClaudeTranscriptReader();
    const open = vi.spyOn(fs, 'open');
    const results = await Promise.all([reader.read(file), reader.read(file), reader.read(file), reader.read(file)]);
    for (const result of results) expect(result).toEqual(whole());
    // The first read, then one pass for every read that waited on it.
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('sees bytes appended while an earlier read ran', async () => {
    writeFileSync(file, `${user('p')}\n`);
    const reader = new ClaudeTranscriptReader();
    const first = reader.read(file);
    appendFileSync(file, `${assistant('late')}\n`);
    const second = reader.read(file);
    await first;
    expect((await second).text).toBe('late');
  });

  it('rejects for a missing file, and reads it once it exists', async () => {
    const reader = new ClaudeTranscriptReader();
    await expect(reader.read(file)).rejects.toThrow();
    writeFileSync(file, `${assistant('there')}\n`);
    expect((await reader.read(file)).text).toBe('there');
  });

  it('awaits between chunks, so a large first read does not hold the event loop in one step', async () => {
    const big = Array.from({ length: 4000 }, (_, i) => `${user(`p${i}`)}\n${assistant(`a${i}`)}`).join('\n') + '\n';
    writeFileSync(file, big);
    const reader = new ClaudeTranscriptReader({ chunkBytes: 16 * 1024 });
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    const result = await reader.read(file);
    clearInterval(timer);
    expect(result).toEqual(parseClaudeResponseTranscript(big));
    expect(ticks).toBeGreaterThan(0);
  });
});
