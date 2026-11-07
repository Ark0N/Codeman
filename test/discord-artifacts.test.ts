import { describe, expect, it } from 'vitest';
import { discordArtifactPaths } from '../src/discord-artifacts.js';

describe('explicit Discord artifact references', () => {
  it('recognizes output links, images and explicit downloads with local URI decoding and deduplication', () => {
    expect(
      discordArtifactPaths(
        '![Mockup](./out/pic.png)\n[Report](file:///work/report%20one.pdf)\n[Download source](src/app.ts)\n[artifact: /work/data.json]\n![again](out/pic.png)'
      )
    ).toEqual(['out/pic.png', '/work/report one.pdf', 'src/app.ts', '/work/data.json']);
  });
  it('supports angle-quoted filenames, sandbox paths and page fragments', () => {
    expect(
      discordArtifactPaths(
        '[Report](<./out/report (final).pdf>)\n![Image](sandbox:/work/pic.png)\n[Report](/work/report.pdf#page=3)'
      )
    ).toEqual(['out/report (final).pdf', '/work/pic.png', '/work/report.pdf']);
  });
  it('never interprets code examples, quotations, source citations or prose paths as output declarations', () => {
    expect(
      discordArtifactPaths(
        '```md\n![Example](/work/fake.png)\n```\n~~~\n[artifact: /work/fake.pdf]\n~~~\n> ![quoted](/work/quote.png)\n    [indented](/work/a.pdf)\n`[artifact: /work/inline.pdf]`\n[src](/work/app.ts#L2) and [docs](README.md)\nSaved /work/unlinked.png'
      )
    ).toEqual([]);
  });
  it.each([
    'https://example.com/pic.png',
    '//example.com/pic.png',
    'file://otherhost/work/pic.png',
    'data:image/png;base64,aaa',
    'javascript:foo.png',
    'file:///work/pic.png?token=secret',
    '/work/a%0Ab.png',
    '/work/bad%XX.png',
  ])('ignores nonlocal or malformed destination %s', (path) => {
    expect(discordArtifactPaths(`![Output](${path})`)).toEqual([]);
  });
  it('bounds discovered outputs with one overflow indicator', () => {
    expect(
      discordArtifactPaths(Array.from({ length: 30 }, (_, i) => `[artifact: /work/${i}.txt]`).join('\n'))
    ).toHaveLength(5);
  });
});
