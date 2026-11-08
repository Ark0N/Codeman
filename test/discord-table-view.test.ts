import { describe, expect, it } from 'vitest';
import { discordTableParts } from '../src/discord-tables.js';
import {
  discordTablePage,
  discordTableCsv,
  discordTableSvg,
  discordTablePng,
  interactiveDiscordTable,
} from '../src/discord-table-view.js';
const table = {
  header: ['Pod', 'Namespace', 'Purpose', 'Observed state'],
  rows: Array.from({ length: 7 }, (_, i) => [`pod-${i}`, 'hdai', 'Preflight check', i === 0 ? 'Pending' : 'Completed']),
  source: 'original',
};
describe('Components V2 table views', () => {
  it('keeps schema and every value in order, with three rows and separators per page', () => {
    const page = discordTablePage(table, 0);
    const text = JSON.stringify(page);
    expect(text).toContain('Namespace · Purpose · Observed state');
    expect(text).toContain('hdai · Preflight check · Pending');
    expect(text).toContain('Showing 1–3 of 7');
    expect(text).not.toContain('pod-3');
    expect(page.filter((c) => c.type === 14)).toHaveLength(2);
    const last = JSON.stringify(discordTablePage(table, 2));
    expect(last).toContain('pod-6');
    expect(last).toContain('Showing 7–7 of 7');
    for (const page of [-1, 3, NaN, 0.5]) expect(() => discordTablePage(table, page)).toThrow();
  });
  it('exports all rows with CSV quoting, Unicode and formula protection', () => {
    const csv = discordTableCsv({
      ...table,
      rows: [
        ['家', 'a,b', '"quoted"', '=HYPERLINK("bad")'],
        ['x', '@SUM(1)', '\t=bad', '+1'],
      ],
    }).toString();
    expect(csv).toContain('"a,b"');
    expect(csv).toContain('""quoted""');
    expect(csv).toContain('"\'=HYPERLINK');
    expect(csv).toContain('"\'@SUM');
    expect(csv).toContain('家');
    expect(discordTableCsv(table).toString().match(/pod-/g)).toHaveLength(7);
  });
  it('renders a real PNG without evaluating cell markup or loading external URLs', async () => {
    const hostile = {
      ...table,
      rows: [['<image href="https://bad.test/x"/>', '& <script>bad</script>', '[link](https://example.test)', '🧠']],
    };
    const svg = discordTableSvg(hostile, 0);
    expect(svg).not.toContain('<image');
    expect(svg).not.toContain('<script>');
    expect(svg).not.toMatch(/<(?:image|use|a)\b/);
    expect(svg).toContain('&lt;');
    const png = await discordTablePng(table, 0);
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(png.length).toBeGreaterThan(1000);
  });
  it('preserves multiple tables, prose, escaped pipes and code samples', () => {
    const source =
      'Before\n| A | B |\n|---|---|\n| `a | b` | x \\| y |\n\nAfter\n```\n| A | B |\n|---|---|\n| x | y |\n```\n\n| C | D |\n|---|---|\n| z | q |';
    const parts = discordTableParts(source),
      tables = parts.filter((p) => 'table' in p);
    expect(tables).toHaveLength(2);
    expect(tables[0].table.rows[0]).toEqual(['`a | b`', 'x | y']);
    expect(
      parts
        .filter((p) => 'text' in p)
        .map((p) => p.text)
        .join('\n')
    ).toContain('```\n| A | B |');
  });
  it('refuses oversized interactive cells and leaves oversized source literal', () => {
    expect(interactiveDiscordTable({ ...table, rows: [['x'.repeat(1000)]] })).toBe(false);
    const source = '| A | B |\n|---|---|\n| x | ' + 'a'.repeat(66000) + ' |';
    expect(discordTableParts(source)).toEqual([{ text: source }]);
  });
});

it('leaves multiline inline-code and quoted table examples unchanged', () => {
  for (const text of ['`example\n| A | B |\n|---|---|\n| x | y |\n`', '> | A | B |\n> |---|---|\n> | x | y |'])
    expect(discordTableParts(text)).toEqual([{ text }]);
});
it('keeps tall previews bounded and falls back to the selected table page', async () => {
  const tall = {
    ...table,
    rows: Array.from({ length: 100 }, (_, i) => [`pod-${i}`, 'hdai', 'Preflight check', 'Ready']),
  };
  expect(() => discordTableSvg(tall)).toThrow('too tall');
  expect(discordTableSvg(tall, 2)).toContain('rows 7–9 of 100');
  expect((await discordTablePng(tall, 2)).subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
});
it('keeps identifiers intact in plain image text and includes all rows in a small preview', () => {
  const svg = discordTableSvg({
    ...table,
    rows: [['pod_with_underscores', 'hdai', 'Some purpose', 'Ready'], ...table.rows],
  });
  expect(svg).toContain('pod_with_underscores');
  expect(svg).toContain('rows 1–8 of 8');
});
