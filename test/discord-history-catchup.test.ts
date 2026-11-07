/** Cursor recovery uses temporary exact transcripts, never production histories or agents. */
import { mkdtemp, mkdir, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { readDiscordHistory, discordHistoryCommand } from '../src/discord-history.js';
const id = '12345678-1234-1234-1234-123456789abc';
const row = (v: unknown) => JSON.stringify(v) + '\n';
async function fixture(mode: 'claude' | 'codex', run: (root: string, path: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'history-catchup-'));
  const base = join(root, mode === 'claude' ? 'projects' : 'sessions', 'fixture');
  await mkdir(base, { recursive: true });
  const path = join(base, mode === 'claude' ? id + '.jsonl' : 'rollout-' + id + '.jsonl');
  await writeFile(path, mode === 'codex' ? row({ type: 'session_meta', payload: { id } }) : '');
  try {
    await run(root, path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const answer = (mode: string, text: string) =>
  mode === 'codex'
    ? { type: 'event_msg', payload: { type: 'agent_message', message: text, phase: 'final_answer' } }
    : { type: 'assistant', sessionId: id, message: { content: text, stop_reason: 'end_turn' } };

describe('bounded native cursor catch-up', () => {
  it.each(['claude', 'codex'] as const)(
    'recovers %s beyond the tail through tool-only pages without losing replies',
    async (mode) => {
      await fixture(mode, async (root, path) => {
        const source = { mode, conversationId: id, configHome: root };
        await appendFile(path, row(answer(mode, 'Already delivered')));
        const anchor = (await readDiscordHistory(source)).turns[0].cursor;
        const tools = Array.from({ length: 24 }, () =>
          row({ type: 'ignored-tool-record', output: 'x'.repeat(300000) })
        ).join('');
        await appendFile(path, tools + row(answer(mode, 'Missed answer')));
        expect((await readDiscordHistory(source)).turns.some((t) => t.cursor === anchor)).toBe(false);
        let cursor = anchor;
        const visible: string[] = [];
        let toolOnly = false;
        for (let i = 0; i < 6; i++) {
          const page = await readDiscordHistory({ ...source, after: cursor });
          expect(page.verifiedAfter).toBe(cursor);
          const anchorAt = page.turns.findIndex((t) => t.cursor === cursor);
          visible.push(...page.turns.slice(anchorAt + 1).map((t) => t.text));
          toolOnly ||= page.turns.length === 0;
          expect(page.scannedCursor).toBeDefined();
          expect(page.scannedCursor).not.toBe(cursor);
          cursor = page.scannedCursor!;
          if (!page.hasMore) break;
        }
        expect(toolOnly).toBe(true);
        expect(visible).toEqual(['Missed answer']);
        const again = await readDiscordHistory({ ...source, after: cursor });
        expect(again.turns.filter((t) => t.cursor !== cursor)).toEqual([]);
        expect(again.hasMore).toBe(false);
      });
    }
  );
  it('crosses a multi-megabyte compaction record using a verified metadata anchor', async () => {
    await fixture('codex', async (root, path) => {
      const source = { mode: 'codex', conversationId: id, configHome: root };
      await appendFile(path, row(answer('codex', 'previous')));
      const after = (await readDiscordHistory(source)).turns[0].cursor;
      await appendFile(
        path,
        row({ type: 'compacted', replacement_history: 'PRIVATE'.repeat(850000) }) +
          row(answer('codex', 'After compaction'))
      );
      const first = await readDiscordHistory({ ...source, after });
      expect(first.scannedCursor).not.toBe(after);
      expect(first.hasMore).toBe(true);
      expect(first.turns.map((t) => t.text)).toEqual(['previous']);
      const second = await readDiscordHistory({ ...source, after: first.scannedCursor });
      expect(second.turns.map((t) => t.text)).toEqual(['After compaction']);
      expect(second.hasMore).toBe(false);
      expect(JSON.stringify(second)).not.toContain('PRIVATE');
    });
  });
  it('rejects edited and truncated anchors without guessing a replacement', async () => {
    await fixture('codex', async (root, path) => {
      const source = { mode: 'codex', conversationId: id, configHome: root };
      const header = row({ type: 'session_meta', payload: { id } });
      await appendFile(path, row(answer('codex', 'original')));
      const after = (await readDiscordHistory(source)).turns[0].cursor;
      await writeFile(path, header + row(answer('codex', 'replaced')));
      await expect(readDiscordHistory({ ...source, after })).rejects.toThrow('record changed');
      await writeFile(path, header);
      await expect(readDiscordHistory({ ...source, after })).rejects.toThrow('beyond the transcript');
      await writeFile(
        path,
        row({ type: 'session_meta', payload: { id: 'different' } }) + row(answer('codex', 'original'))
      );
      await expect(readDiscordHistory({ ...source, after })).rejects.toThrow();
    });
  });
  it('leaves an incomplete final row for the next read', async () => {
    await fixture('codex', async (root, path) => {
      const source = { mode: 'codex', conversationId: id, configHome: root };
      await appendFile(path, row(answer('codex', 'previous')));
      const after = (await readDiscordHistory(source)).turns[0].cursor;
      const next = row(answer('codex', 'complete later'));
      await appendFile(path, next.slice(0, -4));
      const partial = await readDiscordHistory({ ...source, after });
      expect(partial.scannedCursor).toBe(after);
      expect(partial.hasMore).toBe(true);
      await appendFile(path, next.slice(-4));
      expect((await readDiscordHistory({ ...source, after })).turns.at(-1)?.text).toBe('complete later');
    });
  });
  it('refuses a single oversized record rather than silently dropping it', async () => {
    await fixture('codex', async (root, path) => {
      const source = { mode: 'codex', conversationId: id, configHome: root };
      await appendFile(path, row(answer('codex', 'previous')));
      const after = (await readDiscordHistory(source)).turns[0].cursor;
      await appendFile(path, row({ type: 'ignored', text: 'x'.repeat(2300000) }));
      await expect(readDiscordHistory({ ...source, after })).rejects.toThrow('bounded recovery size');
    });
  });
  it.each(['wrong:1:0123456789abcdef', `${id}:-1:0123456789abcdef`, `${id}:9007199254740999:0123456789abcdef`])(
    'rejects unsafe cursor %s before starting a reader',
    (after) => {
      expect(() => discordHistoryCommand({ mode: 'codex', conversationId: id, after })).toThrow();
    }
  );
});
