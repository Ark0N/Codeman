import { describe, it, expect } from 'vitest';
import { activityFromHistory, activityText, activityPreviewText, newerActivity } from '../src/discord-activity-feed.js';
import { nativeExecutions } from '../src/discord-native-execution.js';
describe('meaningful Discord activity', () => {
  it('ignores invalid times, tools and internal display annotations', () => {
    expect(
      activityFromHistory(
        {
          conversationId: 'c',
          partial: false,
          turns: [
            { role: 'tool', cursor: 't', timestamp: '2026-01-01', text: 'Tool noise' },
            { role: 'assistant', cursor: 'a', timestamp: '', text: 'No timestamp' },
          ],
        },
        Date.now()
      )
    ).toBeUndefined();
    expect(activityText('@everyone **Done** <script>')).not.toContain('@');
    expect(activityText('x'.repeat(9999))).toHaveLength(160);
  });
  it('uses real native completion timestamps, never observation time or completion prose', () => {
    const at = '2026-11-07T08:00:00Z';
    const now = Date.parse(at) + 60000;
    const turns = [
      { role: 'user' as const, cursor: 'u', timestamp: at, text: 'Secret prompt' },
      { role: 'assistant' as const, cursor: 'a', timestamp: at, text: 'Done!' },
    ];
    const rows = [
      { cursor: 'u', value: { type: 'event_msg', payload: { type: 'user_message', turn_id: 'task' } } },
      {
        cursor: 'complete',
        value: { type: 'event_msg', timestamp: at, payload: { type: 'task_complete', turn_id: 'task' } },
      },
    ];
    const executions = nativeExecutions('codex-rollout', 'c', rows, turns);
    expect(executions[0]).toMatchObject({ timestamp: at, cursor: 'complete', state: 'completed' });
    expect(activityFromHistory({ conversationId: 'c', partial: false, turns }, now)?.kind).toBe('response');
    const first = activityFromHistory({ conversationId: 'c', partial: false, turns, executions }, now)!;
    expect(first.kind).toBe('completed');
    expect(first.at).toBe(Date.parse(at));
    expect(
      newerActivity(
        first,
        activityFromHistory({ conversationId: 'c', partial: false, turns, executions }, now + 60000)!
      )
    ).toBe(false);
  });
  it('never stores prompt content as an activity excerpt', () => {
    const event = activityFromHistory(
      {
        conversationId: 'c',
        partial: false,
        turns: [{ role: 'user', cursor: 'u', timestamp: '2026-11-07T08:00:00Z', text: 'Private credentials' }],
      },
      Date.parse('2026-11-07T09:00:00Z')
    )!;
    expect(event.summary).toBe('New prompt submitted.');
  });
});

it.each([
  [
    'Reverted and deployed [176](https://github.com/johoja12/Codeman/pull/176). Titles are plain bold again.',
    'Reverted and deployed 176. Titles are plain bold again.',
  ],
  [
    'The fault matches an OpenSSL bug (https://github.com/openssl/openssl/pull/33481): this is fixed.',
    'The fault matches an OpenSSL bug: this is fixed.',
  ],
  ['See https://example.test/a?x=1&y=2 for details.', 'See for details.'],
  ['Read <https://example.test/path> and www.example.test/docs.', 'Read and.'],
  [
    'The response has (balanced notes) and https://example.test/path(with-parentheses). More detail.',
    'The response has balanced notes and. More detail.',
  ],
  ['A restored preview ending (https://github.com/johoja12/Code', 'A restored preview ending'],
])('normalizes nested URL labels: %s', (input, expected) => {
  const label = activityPreviewText(input, 180);
  expect(label).toBe(expected);
  expect(label).not.toMatch(/:\/\/|www\.|[\[\]<>]/i);
});
it('bounds long labels and leaves URL-only labels empty for the UI fallback', () => {
  expect(activityPreviewText('x'.repeat(9000))).toHaveLength(120);
  expect(activityPreviewText('https://example.test')).toBe('');
});
