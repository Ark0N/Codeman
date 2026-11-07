import { describe, it, expect } from 'vitest';
import { readDiscordTaskUpdates, renderDiscordTaskUpdates } from '../src/discord-task-updates.js';
import { discordDetailPages } from '../src/discord-response-format.js';
import type { DiscordHistory } from '../src/discord-history.js';
describe('exact task updates', () => {
  it('continues bounded native pages, retains full updates, and fences the next prompt', async () => {
    const read = async (after: string): Promise<DiscordHistory> => {
      const n = Number(after.slice(1));
      return {
        conversationId: 'c',
        partial: false,
        verifiedAfter: after,
        hasMore: true,
        scannedCursor: `p${n + 1}`,
        turns:
          n === 10
            ? [
                { cursor: 'next', role: 'user', text: 'Next task', timestamp: '' },
                { cursor: 'foreign', role: 'assistant', phase: 'commentary', text: 'Never include', timestamp: '' },
              ]
            : [
                {
                  cursor: `p${n + 1}`,
                  role: 'assistant',
                  phase: 'commentary',
                  text: `Update ${n + 1} ` + 'x'.repeat(600),
                  timestamp: '2026-11-07T00:00:00Z',
                },
              ],
      };
    };
    let state = await readDiscordTaskUpdates(read, 'c', 'u0');
    expect(state.complete).toBe(false);
    expect(state.updates).toHaveLength(8);
    state = await readDiscordTaskUpdates(read, 'c', 'u0', state);
    expect(state.complete).toBe(true);
    expect(state.updates).toHaveLength(10);
    const output = renderDiscordTaskUpdates(state.updates);
    expect(output).toContain('x'.repeat(600));
    expect(output).not.toContain('Never include');
    expect(discordDetailPages(output).length).toBeGreaterThan(3);
  });
  it.each(['foreign', 'unverified', 'stalled'])('refuses %s history without switching tasks', async (kind) => {
    await expect(
      readDiscordTaskUpdates(
        async () => ({
          conversationId: kind === 'foreign' ? 'other' : 'c',
          partial: false,
          verifiedAfter: kind === 'unverified' ? undefined : 'u',
          turns: [],
          hasMore: true,
          scannedCursor: 'u',
        }),
        'c',
        'u'
      )
    ).rejects.toThrow();
  });
  it('can find an old response before the next task and never returns a later one', async () => {
    const read = async (): Promise<DiscordHistory> => ({
      conversationId: 'c',
      partial: false,
      verifiedAfter: 'u',
      turns: [
        { cursor: 'r', role: 'assistant', text: 'Exact answer', timestamp: '' },
        { cursor: 'u2', role: 'user', text: 'Later', timestamp: '' },
        { cursor: 'r2', role: 'assistant', text: 'Other answer', timestamp: '' },
      ],
    });
    expect((await readDiscordTaskUpdates(read, 'c', 'u', undefined, 'r')).response?.text).toBe('Exact answer');
    expect((await readDiscordTaskUpdates(read, 'c', 'u', undefined, 'r2')).response).toBeUndefined();
  });
  it('pages beyond chat limits without clipping text or splitting emoji', () => {
    const text = '😀'.repeat(90000) + 'LAST_SENTINEL';
    const pages = discordDetailPages(text);
    expect(pages.length).toBeGreaterThan(64);
    expect(pages.join('').replaceAll('\n', '')).toBe(text);
    expect(pages.every((p) => p.length < 1700)).toBe(true);
  });
});
