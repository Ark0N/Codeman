/**
 * @fileoverview The Codex rollout shape helpers shared by the Past Sessions
 * scanner (codex-transcript.ts) and the offline history reader
 * (local-history.ts): store location, message shapes and the injected-context
 * rule. Both readers' own tests cover their use of these; this pins the shared
 * contract itself.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import {
  codexContentText,
  codexHomeDir,
  codexMessageFromLine,
  codexSessionsRoot,
  isCodexInjectedContext,
} from '../src/codex-rollout-format.js';

const savedHome = process.env.CODEX_HOME;
afterEach(() => {
  if (savedHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedHome;
});

describe('codex rollout format', () => {
  it('resolves the store from CODEX_HOME, else ~/.codex', () => {
    process.env.CODEX_HOME = '/custom/codex';
    expect(codexHomeDir()).toBe('/custom/codex');
    expect(codexSessionsRoot()).toBe(join('/custom/codex', 'sessions'));
    process.env.CODEX_HOME = '';
    expect(codexSessionsRoot()).toBe(join(process.env.HOME!, '.codex', 'sessions'));
  });

  it('reads all three message shapes with their role, shape and phase', () => {
    expect(codexMessageFromLine({ type: 'event_msg', payload: { type: 'user_message', message: 'hi' } })).toEqual({
      role: 'user',
      text: 'hi',
      shape: 'event',
      phase: undefined,
      injectionProne: false,
    });
    expect(
      codexMessageFromLine({
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'ok', phase: 'commentary' },
      })
    ).toMatchObject({ role: 'assistant', shape: 'event', phase: 'commentary', injectionProne: false });
    expect(
      codexMessageFromLine({
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'AgentMessage', phase: 'final_answer', content: [{ type: 'Text', text: 'done' }] },
        },
      })
    ).toMatchObject({ role: 'assistant', text: 'done', shape: 'item', phase: 'final_answer' });
    expect(
      codexMessageFromLine({
        type: 'response_item',
        payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'typed' }] },
      })
    ).toMatchObject({ role: 'user', text: 'typed', shape: 'response', injectionProne: true });
    expect(
      codexMessageFromLine({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'a' }] },
      })
    ).toMatchObject({ role: 'assistant', shape: 'response', injectionProne: false });
  });

  it('ignores every other line, empty text and malformed input', () => {
    for (const value of [
      null,
      42,
      'text',
      [],
      { type: 'session_meta', payload: { id: 'x' } },
      { type: 'response_item', payload: { type: 'message', role: 'developer', content: 'policy' } },
      { type: 'response_item', payload: { type: 'reasoning', summary: [] } },
      { type: 'event_msg', payload: { type: 'user_message', message: '' } },
      { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'CommandExecution' } } },
    ])
      expect(codexMessageFromLine(value)).toBeNull();
  });

  it('flattens only blocks that carry text', () => {
    expect(codexContentText('plain')).toBe('plain');
    expect(
      codexContentText([
        { type: 'input_text', text: 'a' },
        { type: 'input_image', image_url: 'x' },
        { text: 'b' },
        null,
      ])
    ).toBe('a\nb');
    expect(codexContentText(undefined)).toBe('');
  });

  it('treats a heading or a tag as injected context, wherever the wrapper name is new', () => {
    for (const text of [
      '# AGENTS.md instructions for /repo',
      '<environment_context>',
      '<recommended_plugins>',
      '<subagent_notification>',
      '<codex_internal_context source="goal">',
      '<image name=[Image #1]>',
      '  <turn_aborted>',
    ])
      expect(isCodexInjectedContext(text)).toBe(true);
    for (const text of ['fix the bug', 'You are a reviewer', '$skill run', 'a <b> tag later'])
      expect(isCodexInjectedContext(text)).toBe(false);
  });
});
