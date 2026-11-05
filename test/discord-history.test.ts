/** Exact native history fixtures; no live transcripts, SSH, Discord or model execution. */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
import { readDiscordHistory, historyPage, parseDiscordHistory, discordHistoryCommand } from '../src/discord-history.js';
const id = '12345678-1234-1234-1234-123456789abc';
const other = '12345678-1234-1234-1234-123456789def';
const packet = (rows: unknown[]) =>
  JSON.stringify({
    offset: 0,
    data: Buffer.from(rows.map((x) => JSON.stringify(x) + '\n').join('')).toString('base64'),
    partial: false,
  });
describe('Discord native history', () => {
  it('exports text only, retaining roles/times and excluding tools, reasoning, synthetic context and foreign conversations', () => {
    const rows = [
      { type: 'user', sessionId: id, timestamp: '2026-01-01', message: { content: 'hello' } },
      {
        type: 'assistant',
        sessionId: id,
        message: {
          content: [
            { type: 'thinking', thinking: 'SECRET' },
            { type: 'tool_use', input: 'SECRET' },
            { type: 'text', text: 'answer' },
          ],
        },
      },
      { type: 'user', sessionId: other, message: { content: 'FOREIGN' } },
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'SECRET' }] } },
      { type: 'user', isMeta: true, message: { content: 'SECRET' } },
      { type: 'user', message: { content: '<system-reminder>SECRET</system-reminder>' } },
    ];
    const got = parseDiscordHistory({ mode: 'claude', conversationId: id }, packet(rows));
    expect(got.turns.map((t) => t.text)).toEqual(['hello', 'answer']);
    expect(got.turns[0].timestamp).toBe('2026-01-01');
  });
  it('deduplicates Codex event/response representations without exporting reasoning', () => {
    const got = parseDiscordHistory(
      { mode: 'codex', conversationId: id },
      packet([
        { type: 'response_item', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] } },
        { type: 'event_msg', payload: { type: 'agent_message', message: 'answer' } },
        { type: 'response_item', payload: { type: 'reasoning', summary: [{ text: 'SECRET' }] } },
      ])
    );
    expect(got.turns.map((t) => t.text)).toEqual(['answer']);
  });
  it('paginates with stable conversation/row cursors and rejects stale or foreign cursors', () => {
    const history = parseDiscordHistory(
      { mode: 'claude', conversationId: id },
      packet(
        Array.from({ length: 40 }, (_, i) => ({
          type: i % 2 ? 'assistant' : 'user',
          message: { content: 'turn ' + i },
        }))
      )
    );
    const page = historyPage(history);
    expect(page.turns).toHaveLength(12);
    expect(page.older).toBeDefined();
    const older = historyPage(history, page.older);
    expect(older.turns.at(-1)?.text).toBe('turn 27');
    expect(() => historyPage(history, 'foreign')).toThrow('cursor');
  });
  for (const mode of ['claude', 'codex'])
    it(`reads exact ${mode} identity, rejects ambiguous copies and missing identity`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'discord-history-'));
      try {
        const base = join(root, mode === 'claude' ? 'projects' : 'sessions');
        await mkdir(join(base, 'a'), { recursive: true });
        const name = mode === 'claude' ? id + '.jsonl' : 'rollout-2026-' + id + '.jsonl';
        const data =
          (mode === 'codex' ? JSON.stringify({ type: 'session_meta', payload: { id } }) + '\n' : '') +
          JSON.stringify(
            mode === 'codex'
              ? { type: 'event_msg', payload: { type: 'user_message', message: 'exact' } }
              : { type: 'user', sessionId: id, message: { content: 'exact' } }
          ) +
          '\n';
        await writeFile(join(base, 'a', name), data);
        expect((await readDiscordHistory({ mode, conversationId: id, configHome: root })).turns[0].text).toBe('exact');
        await expect(readDiscordHistory({ mode, conversationId: other, configHome: root })).rejects.toThrow();
        await mkdir(join(base, 'b'));
        await writeFile(join(base, 'b', name), data);
        await expect(readDiscordHistory({ mode, conversationId: id, configHome: root })).rejects.toThrow();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  it('exports bounded tool result text only when explicitly requested, never tool arguments or reasoning', () => {
    const data = packet([
      { type: 'user', message: { content: [{ type: 'tool_result', content: 'visible tool output' }] } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', input: { password: 'SECRET' } },
            { type: 'thinking', thinking: 'SECRET' },
          ],
        },
      },
    ]);
    expect(parseDiscordHistory({ mode: 'claude', conversationId: id }, data).turns).toEqual([]);
    const verbose = parseDiscordHistory({ mode: 'claude', conversationId: id, includeTools: true }, data);
    expect(verbose.turns.map((t) => [t.role, t.text])).toEqual([['tool', 'visible tool output']]);
  });
  it('retains Markdown headings and mixed event/response output while rejecting typed reasoning content', () => {
    const got = parseDiscordHistory(
      { mode: 'codex', conversationId: id },
      packet([
        { type: 'event_msg', payload: { type: 'user_message', message: 'question' } },
        {
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'assistant',
            content: [
              { type: 'output_text', text: '# Answer\nDetails' },
              { type: 'reasoning_text', text: 'SECRET' },
            ],
          },
        },
        {
          type: 'response_item',
          payload: { type: 'reasoning', role: 'assistant', content: [{ type: 'output_text', text: 'SECRET' }] },
        },
      ])
    );
    expect(got.turns.map((t) => t.text)).toEqual(['question', '# Answer\nDetails']);
  });
  it('refuses unsupported providers and non-UUID identities before starting subprocesses', () => {
    expect(() => discordHistoryCommand({ mode: 'shell', conversationId: id })).toThrow();
    expect(() => discordHistoryCommand({ mode: 'claude', conversationId: '../../etc/passwd' })).toThrow();
  });
});
