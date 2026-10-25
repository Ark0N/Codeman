/**
 * @fileoverview Codex rollout lines shaped like real ones, for the offline
 * history tests. The structure (keys, their order, the event types around a
 * fork boundary) was taken from real rollouts written by codex 0.120 to 0.163
 * and from codex-rs `SessionMeta` (`protocol/src/protocol.rs`); no
 * conversation content was copied.
 *
 * A forked or spawned thread's file, as `record_initial_history` writes it for
 * `ForkPersistence::Copied`:
 *
 *   own session_meta, parent session_meta, copied parent records,
 *   thread_settings_applied, the child's own records
 *
 * In paginated history every line also carries an `ordinal`, and the child's
 * own `session_meta` declares `subagent_history_start_ordinal`.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Codex's base instructions make every real session_meta line about 20 KiB. */
export const BASE_INSTRUCTIONS_BYTES = 19 * 1024;

export interface MetaOptions {
  id: string;
  /** Spawn parent: sets parent_thread_id, forked_from_id and source.subagent.thread_spawn. */
  parent?: string;
  /** Shared root (`session_id`); defaults to `parent ?? id`, as Codex writes it. */
  root?: string;
  mode?: 'legacy' | 'paginated';
  historyStart?: number;
  timestamp?: string;
  baseInstructionsBytes?: number;
}

export function realMeta(options: MetaOptions): Record<string, unknown> {
  const { id, parent, mode = 'legacy', timestamp = '2026-10-24T01:00:00.000Z' } = options;
  const payload: Record<string, unknown> = {
    session_id: options.root ?? parent ?? id,
    id,
    ...(parent ? { forked_from_id: parent, parent_thread_id: parent } : {}),
    timestamp,
    cwd: '/work/repo',
    originator: 'codex_exec',
    cli_version: '0.163.0',
    source: parent
      ? {
          subagent: {
            thread_spawn: {
              parent_thread_id: parent,
              depth: 1,
              agent_path: null,
              agent_nickname: 'Kepler',
              agent_role: null,
            },
          },
        }
      : 'exec',
    thread_source: parent ? 'subagent' : 'user',
    ...(parent ? { agent_nickname: 'Kepler' } : {}),
    model_provider: 'openai',
    base_instructions: { text: 'b'.repeat(options.baseInstructionsBytes ?? BASE_INSTRUCTIONS_BYTES) },
    history_mode: mode,
    ...(options.historyStart !== undefined ? { subagent_history_start_ordinal: options.historyStart } : {}),
    ...(parent ? { multi_agent_version: 'v1' } : {}),
    context_window: { window_id: `${id.slice(0, 8)}-window` },
  };
  return { timestamp, type: 'session_meta', payload };
}

export const taskStarted = () => ({
  timestamp: '2026-10-24T01:00:00.000Z',
  type: 'event_msg',
  payload: { type: 'task_started' },
});
export const settingsApplied = () => ({
  timestamp: '2026-10-24T01:00:00.000Z',
  type: 'event_msg',
  payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-5.5', cwd: '/work/repo' } },
});
export const developer = () => ({
  timestamp: '2026-10-24T01:00:00.000Z',
  type: 'response_item',
  payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'policy' }] },
});
export const injected = (tag = 'environment_context') => ({
  timestamp: '2026-10-24T01:00:00.000Z',
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `<${tag}>\n  ctx\n</${tag}>` }] },
});
/** A real user turn: the response_item Codex sent plus its user_message event twin. */
export const userTurn = (text: string, timestamp = '2026-10-24T01:00:00.000Z') => [
  {
    timestamp,
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  },
  { timestamp, type: 'event_msg', payload: { type: 'user_message', message: text, images: [] } },
];
/** An assistant message: the event and the response_item, both carrying Codex's phase. */
export const assistantTurn = (text: string, phase: 'commentary' | 'final_answer' = 'final_answer') => [
  {
    timestamp: '2026-10-24T01:00:01.000Z',
    type: 'event_msg',
    payload: { type: 'agent_message', message: text, phase },
  },
  {
    timestamp: '2026-10-24T01:00:01.000Z',
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }], phase },
  },
];

/** Number every line, as paginated history does. */
export function withOrdinals(lines: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return lines.map((line, ordinal) => {
    const { timestamp, type, payload, ...rest } = line;
    return { timestamp, ordinal, type, payload, ...rest };
  });
}

export async function writeRollout(dir: string, name: string, lines: unknown[]): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  return path;
}
