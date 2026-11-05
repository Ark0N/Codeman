import { describe, expect, it } from 'vitest';
import { discordDisplayText } from '../src/discord-display-text.js';
import { renderHistory } from '../src/discord-history.js';
import { buildPost, DEFAULT_DISCORD_CONFIG } from '../src/discord-bridge.js';
const metadata =
  '<oai-mem-citation>\n<citation_entries>\nMEMORY.md:1-2|note=[internal]\n</citation_entries>\n<rollout_ids>\nprivate-id\n</rollout_ids>\n</oai-mem-citation>';
describe('Discord assistant display metadata filtering', () => {
  it('keeps visible Markdown and ordinary citations, removing the internal footer', () => {
    const body = '**Done**\n\n[Source](https://example.test)';
    expect(discordDisplayText(body + '\n\n' + metadata)).toBe(body);
  });
  it('hides incomplete metadata and incomplete reserved tags at the stream boundary', () => {
    expect(discordDisplayText('Answer\n<oai-mem-citation>\n<citation_entries>\ninternal')).toBe('Answer');
    expect(discordDisplayText('Answer\n<oai-mem-cit')).toBe('Answer');
  });
  it('retains text after a metadata block and handles multiple blocks', () => {
    expect(discordDisplayText(metadata + '\nNext\n' + metadata)).toBe('Next');
    expect(discordDisplayText('<oai-mem-citation>private</oai-mem-citation>Visible')).toBe('Visible');
  });
  it.each(['```xml', '~~~xml', '````xml'])('preserves literal examples inside %s fences', (fence) => {
    const close = fence.replace('xml', '');
    const literal = fence + '\n' + metadata + '\n' + close;
    expect(discordDisplayText(literal + '\n' + metadata)).toBe(literal);
  });
  it('preserves inline, quoted and indented code and unrelated XML', () => {
    for (const value of [
      '`<oai-mem-citation>`',
      '> <oai-mem-citation>',
      '    <oai-mem-citation>',
      '<citation>ordinary</citation>',
      'Use <oai-mem-citation> literally',
    ])
      expect(discordDisplayText(value)).toBe(value);
  });
  it('does not mistake a one-line backtick span for a block fence', () => {
    expect(discordDisplayText('```inline code```\n' + metadata)).toBe('```inline code```');
  });
  it('cleans assistant history/export text but preserves literal user/tool content', () => {
    const rows = [
      { cursor: 'a', role: 'assistant' as const, text: 'Answer\n' + metadata, timestamp: '' },
      { cursor: 'b', role: 'user' as const, text: metadata, timestamp: '' },
    ];
    expect(renderHistory(rows)).toContain('Answer');
    expect(renderHistory(rows).match(/<oai-mem-citation>/g)).toHaveLength(1);
    expect(renderHistory([rows[0]])).not.toContain('MEMORY.md');
  });
  it('cleans fallback alert bodies and terminal tails before they are fenced', () => {
    const post = buildPost(
      { event: 'error', title: 'Error', body: 'Visible\n' + metadata, tail: 'Tail\n' + metadata, urgency: 'critical' },
      DEFAULT_DISCORD_CONFIG
    );
    expect(post.content).toContain('Visible');
    expect(post.content).toContain('Tail');
    expect(post.content).not.toContain('oai-mem');
  });
});
