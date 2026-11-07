/** @fileoverview Response presentation preserves code/content while adding native Discord hierarchy. */
import { describe, expect, it } from 'vitest';
import {
  discordResponsePosts,
  formatDiscordResponseText,
  DISCORD_COMPONENTS_V2,
  DISCORD_SUPPRESS_NOTIFICATIONS,
  discordProgressPost,
} from '../src/discord-response-format.js';
const body = (post: ReturnType<typeof discordResponsePosts>[number]) =>
  post.components
    ?.flatMap((c) =>
      c.type === 17
        ? (c.components as { type: number; content?: string }[]).filter(
            (n, i) => i !== 0 || !/^\*\*[^\n*]+\*\*(?:\n-# [^\n]*)?$/.test(n.content ?? '')
          )
        : [c]
    )
    .filter((c) => c.type === 10 && !c.content?.startsWith('-#'))
    .map((c) => c.content)
    .join('\n') ?? '';
describe('readable Discord responses', () => {
  it('separates and emphasizes short numbered labels without rewriting prose', () => {
    const body =
      'The revised flow needs:\n1. Spread: show separate GPUs.\n2. Transition to Shared.\n3. Shared: show all three workloads.\n4. Compare: matched five-minute windows.';
    expect(formatDiscordResponseText(body)).toBe(
      'The revised flow needs:\n\n1. **Spread:** show separate GPUs.\n\n2. Transition to Shared.\n\n3. **Shared:** show all three workloads.\n\n4. **Compare:** matched five-minute windows.'
    );
  });
  it('styles obvious file paths while preserving URLs, Markdown links and inline code', () => {
    const body =
      'Saved (output/demo-revision-20261106/STORYBOARD.md).\n[Open](https://example.test/demo.md) https://example.test/demo.md\n`output/literal.md` and /tmp/already.py';
    const formatted = formatDiscordResponseText(body);
    expect(formatted).toContain('(`output/demo-revision-20261106/STORYBOARD.md`)');
    expect(formatted).toContain('[Open](https://example.test/demo.md) https://example.test/demo.md');
    expect(formatted).toContain('`output/literal.md` and /tmp/already.py');
    expect(formatDiscordResponseText(formatted)).toBe(formatted);
  });
  it.each(['```', '````', '~~~'])('preserves literal code inside %s fences, indentation and blockquotes', (fence) => {
    const code = `${fence}text\n1. Literal: /tmp/file.py  \n| a | b |\n|---|---|\n| x | y |\n${fence}\n    1. Literal: /tmp/file.py\n> 1. Quote: /tmp/file.py`;
    expect(formatDiscordResponseText(code)).toBe(code);
  });
  it('preserves existing emphasis and nested lists rather than promoting them to headings', () => {
    const body = '1. **Spread:** details\n   - nested bullet\n   - next bullet\n\n2. **Shared:** details';
    expect(formatDiscordResponseText(body)).toBe(body);
  });
  it('keeps the heading and body together in one native card and suppresses URL previews', () => {
    const posts = discordResponsePosts('1. Spread: details\n2. Shared: details\n\nhttps://example.test/demo');
    expect(posts).toHaveLength(1);
    expect(body(posts[0])).toBe('1. **Spread:** details\n\n2. **Shared:** details\n\nhttps://example.test/demo');
    expect(posts[0].embeds).toBeUndefined();
    expect(posts[0].flags).toBe(DISCORD_COMPONENTS_V2 | 4);
    expect(posts[0].components?.[0]).toMatchObject({ type: 17 });
    expect((posts[0].components?.[0].components as { type: number; content?: string }[])[0]).toEqual({
      type: 10,
      content: '**Response**',
    });
    expect(posts[0].components).toHaveLength(1);
    expect((posts[0].components?.[0].components as { type: number; content?: string }[])[1]).toMatchObject({
      type: 10,
      content: body(posts[0]),
    });
    expect(posts[0].allowed_mentions).toEqual({ parse: [], users: [] });
  });
  it.each(['User prompt', 'Response received'])('keeps %s text and response actions inside the same card', (title) => {
    const controls = [
      { type: 1, components: [{ type: 2, style: 5, label: 'Open session', url: 'https://example.test' }] },
    ];
    const post = discordResponsePosts('First line\nSecond line', { title, controls })[0];
    expect(post.components).toHaveLength(1);
    const card = post.components![0];
    expect(card.type).toBe(17);
    expect(card.components).toEqual([
      { type: 10, content: `**${title}**` },
      { type: 10, content: 'First line\nSecond line' },
      { type: 14, divider: true, spacing: 1 },
      ...controls,
    ]);
  });
  it('keeps long responses within message limits, numbers continuations and pings only the first part', () => {
    const text = Array.from({ length: 80 }, (_, i) => `Paragraph ${i}: ` + 'detail '.repeat(15)).join('\n\n');
    const posts = discordResponsePosts(text, { users: ['333333333333333333'] });
    expect(posts.length).toBeGreaterThan(1);
    expect(posts.length).toBeLessThanOrEqual(8);
    expect(posts.every((p) => body(p).length <= 2000)).toBe(true);
    expect(body(posts[0])).toContain('<@333333333333333333>');
    expect(
      (posts[0].components?.[0].components as { content?: string }[]).some((c) =>
        c.content?.includes(`1 / ${posts.length}`)
      )
    ).toBe(true);
    expect(
      posts
        .slice(1)
        .every(
          (p) =>
            !body(p).includes('<@333333333333333333>') &&
            p.allowed_mentions.users.length === 0 &&
            !body(p).includes('**Response**')
        )
    ).toBe(true);
    const visible = posts.map((p) => body(p)).join('\n');
    for (let i = 0; i < 80; i++) expect(visible).toContain(`Paragraph ${i}:`);
  });
  it.each(['```', '````', '~~~'])('closes and reopens long %s code blocks without altering their rows', (fence) => {
    const lines = Array.from({ length: 400 }, (_, i) => `const row${i} = ${i};`);
    const posts = discordResponsePosts(`${fence}js\n${lines.join('\n')}\n${fence}`);
    expect(posts.length).toBeGreaterThan(1);
    for (const post of posts) {
      expect(body(post).includes(fence + 'js\n')).toBe(true);
      expect(body(post).endsWith(fence)).toBe(true);
    }
    const combined = posts.map((p) => body(p)).join('\n');
    for (const line of lines) expect(combined.split(line)).toHaveLength(2);
  });
  it('makes truncation explicit and does not turn output mentions into notification permissions', () => {
    const posts = discordResponsePosts('@everyone ' + 'x'.repeat(100000));
    expect(posts).toHaveLength(8);
    expect(body(posts.at(-1)!)).toContain('The message continues in the tab.');
    expect(posts.every((p) => p.allowed_mentions.parse.length === 0 && p.allowed_mentions.users.length === 0)).toBe(
      true
    );
  });
  it('leaves unusually large lines untouched by prose heuristics', () => {
    const text = 'a/'.repeat(100000) + 'file.md';
    expect(formatDiscordResponseText(text)).toBe(text);
  });
});
it('keeps multiline inline-code content literal', () => {
  const text = 'An inline span: `start\n1. Literal: output/example.md\nend`\n\n1. Label: normal prose';
  expect(formatDiscordResponseText(text)).toBe(
    'An inline span: `start\n1. Literal: output/example.md\nend`\n\n1. **Label:** normal prose'
  );
});
it('bounds prose-formatting CPU on steerable punctuation and long path-like input', () => {
  const text = Array(80).fill('['.repeat(8190)).join('\n') + '\n' + 'a/'.repeat(100000);
  const before = process.cpuUsage();
  expect(formatDiscordResponseText(text)).toBe(text);
  const used = process.cpuUsage(before);
  expect((used.user + used.system) / 1000).toBeLessThan(300);
});

it('keeps completion evidence separate from silent progress prose', () => {
  const post = discordProgressPost('Working', 'The checks passed.\nStill building.', 2);
  expect(post.flags).toBe(DISCORD_COMPONENTS_V2 | 4 | DISCORD_SUPPRESS_NOTIFICATIONS);
  expect(post.components?.[0].content).toBe('-# Working · 2 progress updates');
  expect(post.components?.[1].content).toBe('The checks passed. Still building.');
  expect(post.components?.some((c) => c.type === 17)).toBe(false);
});

it('silences every update chunk and only allows the first final chunk to notify', () => {
  const text = 'Update with details.\n'.repeat(350);
  const updates = discordResponsePosts(text, { silent: true });
  expect(updates.length).toBeGreaterThan(1);
  expect(updates.every((p) => !!(p.flags! & DISCORD_SUPPRESS_NOTIFICATIONS))).toBe(true);
  const final = discordResponsePosts(text);
  expect(final[0].flags! & DISCORD_SUPPRESS_NOTIFICATIONS).toBe(0);
  expect(final.slice(1).every((p) => !!(p.flags! & DISCORD_SUPPRESS_NOTIFICATIONS))).toBe(true);
});
