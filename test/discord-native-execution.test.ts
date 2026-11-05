import { it, expect } from 'vitest';
import { nativeExecutions } from '../src/discord-native-execution.js';
const turn = (cursor: string) => ({ cursor, role: 'user' as const, text: 'hello', timestamp: '' });
it('requires native Codex turn IDs, and does not let queued input steal prior completion', () => {
  const rows = [
    { value: { type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn1' } }, cursor: '0' },
    { value: { type: 'event_msg', payload: { type: 'user_message' } }, cursor: '1' },
    { value: { type: 'event_msg', payload: { type: 'user_message' } }, cursor: '2' },
    { value: { type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn1' } }, cursor: '3' },
  ];
  expect(nativeExecutions('codex-rollout', 'native', rows, [turn('1'), turn('2')]).map((x) => x.state)).toEqual([
    'completed',
    'submitted',
  ]);
});
it('requires Claude parent ancestry and excludes foreign/sidechain completion', () => {
  const rows = [
    { value: { type: 'user', uuid: 'u' }, cursor: '1' },
    { value: { type: 'assistant', uuid: 'a', parentUuid: 'u', message: { stop_reason: 'tool_use' } }, cursor: '2' },
    {
      value: { type: 'assistant', parentUuid: 'a', isSidechain: true, message: { stop_reason: 'end_turn' } },
      cursor: '3',
    },
    { value: { type: 'assistant', parentUuid: 'elsewhere', message: { stop_reason: 'end_turn' } }, cursor: '4' },
  ];
  expect(nativeExecutions('claude-jsonl', 'native', rows, [turn('1')])[0].state).toBe('running');
  rows.push({ value: { type: 'assistant', parentUuid: 'a', message: { stop_reason: 'end_turn' } }, cursor: '5' });
  expect(nativeExecutions('claude-jsonl', 'native', rows, [turn('1')])[0].state).toBe('completed');
});
