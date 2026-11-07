/** Bounded, exact-task progress reads. Continuations retain all loaded text without crossing the next prompt. */
import type { DiscordHistory, DiscordHistoryTurn } from './discord-history.js';
import { discordDisplayText } from './discord-display-text.js';
export interface DiscordTaskUpdates {
  updates: DiscordHistoryTurn[];
  after: string;
  complete: boolean;
  bytes: number;
  response?: DiscordHistoryTurn;
}
export async function readDiscordTaskUpdates(
  read: (after: string) => Promise<DiscordHistory>,
  conversation: string,
  userCursor: string,
  previous?: DiscordTaskUpdates,
  responseCursor?: string
): Promise<DiscordTaskUpdates> {
  const state: DiscordTaskUpdates = previous
    ? { ...previous, updates: [...previous.updates] }
    : { updates: [], after: userCursor, complete: false, bytes: 0 };
  if (state.complete || state.response) return state;
  const seen = new Set(state.updates.map((t) => t.cursor));
  for (let page = 0; page < 8; page++) {
    const h = await read(state.after);
    if (h.conversationId !== conversation) throw new Error('Task conversation changed.');
    let turns = h.turns;
    if (h.verifiedAfter !== state.after) {
      const anchor = turns.findIndex((t) => t.cursor === state.after);
      if (anchor < 0) throw new Error('Original task history is unavailable or unverified.');
      turns = turns.slice(anchor + 1);
    }
    for (const turn of turns) {
      if (turn.role === 'user') {
        state.complete = true;
        return state;
      }
      if (turn.role !== 'assistant') continue;
      if (responseCursor && turn.cursor === responseCursor) {
        state.response = { ...turn, text: discordDisplayText(turn.text) };
        return state;
      }
      if (turn.phase !== 'commentary' || seen.has(turn.cursor)) continue;
      const text = discordDisplayText(turn.text);
      if (!text.trim()) continue;
      state.bytes += Buffer.byteLength(text);
      if (state.bytes > 8 * 1024 * 1024)
        throw new Error('Task updates exceed the 8 MB Discord export limit. Use the web transcript.');
      state.updates.push({ ...turn, text });
      seen.add(turn.cursor);
    }
    if (!h.hasMore) {
      state.complete = true;
      return state;
    }
    const next = h.scannedCursor ?? turns.at(-1)?.cursor;
    if (!next || next === state.after) throw new Error('Task history made no verified progress.');
    state.after = next;
  }
  return state;
}
export function renderDiscordTaskUpdates(updates: DiscordHistoryTurn[]): string {
  return updates
    .map((t, i) => {
      const time = Date.parse(t.timestamp),
        label = Number.isFinite(time) ? ` · <t:${Math.floor(time / 1000)}:t>` : '';
      return `**Update ${i + 1}**${label}\n${t.text}`;
    })
    .join('\n\n');
}
