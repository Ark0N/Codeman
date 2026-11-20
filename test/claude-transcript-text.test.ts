/** Claude conversation file to searchable text (src/claude-transcript-text.ts). */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  claudeJsonlToText,
  ClaudeTranscriptReader,
  findClaudeTranscriptPath,
  READ_TAIL_BYTES,
} from '../src/claude-transcript-text.js';

const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const user = (text: unknown, extra = {}) => line({ type: 'user', message: { role: 'user', content: text }, ...extra });
const assistant = (blocks: unknown[], extra = {}) => line({ type: 'assistant', message: { role: 'assistant', content: blocks }, ...extra });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'claude-transcript-text-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('claudeJsonlToText', () => {
  it('keeps what was typed, what Claude said and one line per tool call', () => {
    const text = claudeJsonlToText(
      user('How hard would it be?') +
        user([{ type: 'text', text: 'second prompt' }]) +
        assistant([{ type: 'text', text: 'Easy.\nReally.' }, { type: 'tool_use', name: 'Bash', input: { command: 'git status\n--short' } }])
    );
    expect(text).toBe('You: How hard would it be?\nYou: second prompt\nClaude: Easy.\nReally.\n[Bash] git status --short');
  });

  it('leaves out tool results, thinking, meta and sidechain entries, and other entry types', () => {
    const text = claudeJsonlToText(
      user([{ type: 'tool_result', content: 'HUGE OUTPUT' }]) +
        assistant([{ type: 'thinking', thinking: 'secret musings' }]) +
        user('meta text', { isMeta: true }) +
        assistant([{ type: 'text', text: 'side' }], { isSidechain: true }) +
        line({ type: 'api-request', model: 'x' }) +
        'not json\n' +
        user('kept')
    );
    expect(text).toBe('You: kept');
  });

  it('clips a long tool argument to one line', () => {
    const t = claudeJsonlToText(assistant([{ type: 'tool_use', name: 'Read', input: { file_path: `/a/${'b'.repeat(500)}` } }]));
    expect(t.startsWith('[Read] /a/b')).toBe(true);
    expect(t.length).toBeLessThan(330);
  });
});

describe('findClaudeTranscriptPath', () => {
  it('finds the file under any project folder and refuses an unsafe id', async () => {
    mkdirSync(join(dir, 'proj-a'));
    writeFileSync(join(dir, 'proj-a', 'abc-123.jsonl'), '');
    expect(await findClaudeTranscriptPath(dir, [null, 'abc-123'])).toBe(join(dir, 'proj-a', 'abc-123.jsonl'));
    expect(await findClaudeTranscriptPath(dir, ['../abc-123', 'zzz'])).toBeNull();
    expect(await findClaudeTranscriptPath(join(dir, 'nope'), ['abc-123'])).toBeNull();
  });
});

describe('ClaudeTranscriptReader', () => {
  it('reads once, skips an unchanged file, and reads again when forced or grown', async () => {
    const p = join(dir, 't.jsonl');
    writeFileSync(p, user('hello'));
    const r = new ClaudeTranscriptReader();
    expect(await r.read(p)).toBe('You: hello');
    expect(await r.read(p)).toBeNull();
    expect(await r.read(p, true)).toBe('You: hello');
    appendFileSync(p, user('more'));
    expect(await r.read(p)).toBe('You: hello\nYou: more');
  });

  it('reads only the tail of a huge file, from a line start', async () => {
    const p = join(dir, 'big.jsonl');
    const filler = user('x'.repeat(1000));
    writeFileSync(p, user('OLDEST') + filler.repeat(Math.ceil(READ_TAIL_BYTES / filler.length) + 5) + user('NEWEST'));
    const text = (await new ClaudeTranscriptReader().read(p)) ?? '';
    expect(text).toContain('You: NEWEST');
    expect(text).not.toContain('OLDEST');
  });

  it('answers null for a missing file', async () => {
    expect(await new ClaudeTranscriptReader().read(join(dir, 'missing.jsonl'))).toBeNull();
  });
});
