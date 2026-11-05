/** Strict execution proof from native events, separate from transport acceptance and display activity. */
import { createHash } from 'node:crypto';
import type { DiscordHistoryTurn } from './discord-history.js';
export interface DiscordNativeExecution {
  userCursor: string;
  promptHash: string;
  state: 'submitted' | 'running' | 'completed' | 'interrupted' | 'execution_error';
}
interface Row {
  type?: string;
  uuid?: string;
  parentUuid?: string;
  isSidechain?: boolean;
  sessionId?: string;
  payload?: { type?: string; turn_id?: string };
  message?: { stop_reason?: string };
}
export function nativeExecutions(
  format: string,
  conversationId: string,
  rows: Array<{ value: unknown; cursor: string }>,
  turns: DiscordHistoryTurn[]
): DiscordNativeExecution[] {
  const users = new Map(turns.filter((t) => t.role === 'user').map((t) => [t.cursor, t]));
  const result: DiscordNativeExecution[] = [];
  const ancestry = new Map<string, DiscordNativeExecution>();
  const byNativeTurn = new Map<string, DiscordNativeExecution>();
  let activeTurn: string | undefined;
  for (const row of rows) {
    const e = row.value as Row;
    if (!e || typeof e !== 'object' || e.isSidechain || (e.sessionId && e.sessionId !== conversationId)) continue;
    const user = users.get(row.cursor);
    if (format === 'codex-rollout') {
      if (e.type === 'event_msg' && e.payload?.type === 'task_started') {
        activeTurn = e.payload.turn_id;
      }
      if (user) {
        const execution: DiscordNativeExecution = {
          userCursor: user.cursor,
          promptHash: hashDiscordPrompt(user.text),
          state: 'submitted',
        };
        result.push(execution);
        const turn = e.payload?.turn_id ?? activeTurn;
        if (turn && !byNativeTurn.has(turn)) {
          byNativeTurn.set(turn, execution);
          execution.state = 'running';
        }
      }
      if (e.type === 'event_msg' && e.payload?.turn_id) {
        const execution = byNativeTurn.get(e.payload.turn_id);
        if (!execution) continue;
        if (e.payload.type === 'task_complete') execution.state = 'completed';
        if (e.payload.type === 'turn_aborted') execution.state = 'interrupted';
        if (e.payload.type === 'task_failed') execution.state = 'execution_error';
      }
    } else if (format === 'claude-jsonl') {
      const parent = e.parentUuid ? ancestry.get(e.parentUuid) : undefined;
      if (user && e.type === 'user') {
        const execution: DiscordNativeExecution = {
          userCursor: user.cursor,
          promptHash: hashDiscordPrompt(user.text),
          state: 'submitted',
        };
        result.push(execution);
        if (e.uuid) ancestry.set(e.uuid, execution);
      } else if (parent) {
        if (e.uuid) ancestry.set(e.uuid, parent);
        if (e.type === 'assistant')
          parent.state =
            e.message?.stop_reason === 'end_turn' || e.message?.stop_reason === 'stop_sequence'
              ? 'completed'
              : 'running';
      }
    }
  }
  return result;
}
export function hashDiscordPrompt(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n?/g, '\n').trim()).digest('hex');
}
