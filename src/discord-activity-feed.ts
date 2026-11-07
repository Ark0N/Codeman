/** Meaningful native activity only: cosmetic refreshes and reads never advance recency. */
import { z } from 'zod';
import type { DiscordHistory } from './discord-history.js';
import { discordDisplayText } from './discord-display-text.js';
export const DiscordActivityRecordSchema = z
  .object({
    scope: z.string().max(200),
    session: z.string().max(100),
    channel: z.string().regex(/^\d{15,25}$/),
    conversation: z.string().max(200),
    kind: z.enum(['prompt', 'update', 'response', 'completed', 'question', 'error', 'interrupted']),
    cursor: z.string().max(250),
    at: z.number().finite().nonnegative(),
    summary: z.string().max(180),
    responseCursor: z.string().max(200).optional(),
    message: z
      .string()
      .regex(/^\d{15,25}$/)
      .optional(),
  })
  .strict();
export type DiscordActivityRecord = z.infer<typeof DiscordActivityRecordSchema>;
export type DiscordActivityEvent = Omit<DiscordActivityRecord, 'scope' | 'session' | 'channel'>;
export type DiscordActivityView = 'recent' | 'working' | 'finished' | 'attention';
export const DISCORD_ACTIVITY_VIEWS = {
  recent: ['Recent', 'Latest meaningful activity first'],
  working: ['Working', 'Sessions with work in progress'],
  finished: ['Finished', 'Verified completions in the last hour'],
  attention: ['Needs you', 'Questions, permissions and errors'],
} as const;
export const activityText = (text: string, max = 160): string =>
  discordDisplayText(text.slice(0, 4000))
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f@`*_~<>[\]\\#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
/** Discord cannot mask a URL inside another masked link's label. Normalize only the preview. */
export function activityPreviewText(text: string, max = 120): string {
  const prose = discordDisplayText(text.slice(0, 4000))
    .replace(/(?:[a-z][a-z0-9+.-]{0,20}:\/\/|www\.)[^\s<>]*/gi, (url) => /[.!?,;:]+$/.exec(url)?.[0] ?? '')
    .replace(/[()]/g, ' ')
    .replace(/\s+([.!?,;:])/g, '$1');
  const label = activityText(prose, max).replace(/\s+([.!?,;:])/g, '$1');
  return /[\p{L}\p{N}]/u.test(label) ? label : '';
}
const rank = { prompt: 0, update: 1, response: 2, interrupted: 3, question: 4, error: 5, completed: 6 };
export function newerActivity(old: DiscordActivityEvent | undefined, next: DiscordActivityEvent): boolean {
  return !old || next.at > old.at || (next.at === old.at && rank[next.kind] > rank[old.kind]);
}
export function activityFromHistory(history: DiscordHistory, now: number): DiscordActivityEvent | undefined {
  let latest: DiscordActivityEvent | undefined, user: string | undefined;
  const record = (event: DiscordActivityEvent) => {
    if (newerActivity(latest, event)) latest = event;
  };
  const time = (value: string | undefined) => {
    const n = Date.parse(value ?? '');
    return Number.isFinite(n) && n >= 0 && n <= now + 60000 ? Math.min(n, now) : undefined;
  };
  for (const turn of history.turns) {
    if (turn.role === 'user') user = turn.cursor;
    const at = time(turn.timestamp);
    if (at === undefined || turn.role === 'tool') continue;
    const text = turn.role === 'assistant' ? activityText(turn.text) : 'New prompt submitted.';
    if (!text) continue;
    const proof = user ? history.executions?.find((e) => e.userCursor === user) : undefined;
    const final = turn.role === 'assistant' && turn.phase !== 'commentary';
    record({
      conversation: history.conversationId,
      cursor: turn.cursor,
      at,
      kind:
        turn.role === 'user' ? 'prompt' : final ? (proof?.state === 'completed' ? 'completed' : 'response') : 'update',
      summary: text,
      ...(final ? { responseCursor: turn.cursor } : {}),
    });
  }
  // Completion can arrive in a later page/poll than the visible final answer.
  for (const execution of history.executions ?? []) {
    const at = time(execution.timestamp);
    if (
      at === undefined ||
      !execution.cursor ||
      !['completed', 'interrupted', 'execution_error'].includes(execution.state)
    )
      continue;
    const start = history.turns.findIndex((t) => t.cursor === execution.userCursor);
    if (start < 0) continue;
    const tail = history.turns.slice(start + 1),
      end = tail.findIndex((t) => t.role === 'user');
    const response = (end < 0 ? tail : tail.slice(0, end))
      .filter((t) => t.role === 'assistant' && t.phase !== 'commentary')
      .at(-1);
    record({
      conversation: history.conversationId,
      cursor: execution.cursor,
      at,
      kind: execution.state === 'completed' ? 'completed' : execution.state === 'interrupted' ? 'interrupted' : 'error',
      summary: response
        ? activityText(response.text)
        : execution.state === 'completed'
          ? 'The agent finished this turn.'
          : 'Open the thread for execution details.',
      ...(response ? { responseCursor: response.cursor } : {}),
    });
  }
  return latest;
}
