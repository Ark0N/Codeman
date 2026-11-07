import { describe, expect, it } from 'vitest';
import { claudePromptSuggestion } from '../src/session-submit-verifier.js';
const rule = '────────────────────────────────────────────';
const frame = (composer: string) => `❯ old prompt\n● Done\n${rule}\n${composer}\n${rule}\n  auto mode on`;
describe('Claude native prompt suggestion', () => {
  it('reads the measured inverse cursor plus faint ghost text', () => {
    expect(
      claudePromptSuggestion(frame('\x1b[39m❯\u00a0\x1b[7mw\x1b[0;2m\x1b[39m\x1b[49mrite tests for add\x1b[0m'))
    ).toBe('write tests for add');
  });
  it('reads a faint suggestion without a cursor, including wrapped lines', () => {
    expect(claudePromptSuggestion(frame('❯ \x1b[2mRun tests\n  and fix failures\x1b[0m'))).toBe(
      'Run tests and fix failures'
    );
  });
  it.each([
    '❯ private typed draft',
    '❯ \x1b[7mp\x1b[0mrivate draft',
    '❯ \x1b[2mghost\x1b[22m typed',
    '❯ \n  private continuation',
    '❯ [Pasted text #1 +40 lines]',
    '❯',
    '❯ \x1b[2mTry "fix lint errors"\x1b[0m',
  ])('does not expose a draft, empty composer or hint: %s', (composer) => {
    expect(claudePromptSuggestion(frame(composer))).toBeUndefined();
  });
  it('requires a bounded current composer and refuses oversized suggestions', () => {
    expect(claudePromptSuggestion('❯ \x1b[2mNot a current composer\x1b[0m')).toBeUndefined();
    expect(claudePromptSuggestion(frame('❯ \x1b[2m' + 'x'.repeat(1001) + '\x1b[0m'))).toBeUndefined();
  });
});
