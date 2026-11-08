/** Bounded, data-only Discord table views and exports. No HTML or external resources are evaluated. */
import type { DiscordTable } from './discord-tables.js';

export function interactiveDiscordTable(table: DiscordTable): boolean {
  return (
    table.rows.length > 0 &&
    table.header.join(' · ').length <= 500 &&
    table.rows.every((r) => r.join(' · ').length <= 950)
  );
}
export function discordTablePage(table: DiscordTable, page: number): Array<Record<string, unknown>> {
  const pages = Math.ceil(table.rows.length / 3);
  if (!Number.isInteger(page) || page < 0 || page >= pages) throw new Error('Invalid table page');
  const start = page * 3;
  const components: Array<Record<string, unknown>> = [
    {
      type: 10,
      content: `**${table.header[0] || 'Item'}**${table.header.length > 1 ? '\n-# ' + table.header.slice(1).join(' · ') : ''}`,
    },
  ];
  for (const [i, r] of table.rows.slice(start, start + 3).entries()) {
    if (i) components.push({ type: 14, divider: true, spacing: 1 });
    // Preserve source Markdown and column order; never infer statuses or discard fields.
    const first = r[0] || '—';
    components.push({
      type: 10,
      content: `${first.includes('`') || first.includes('**') ? first : '**' + first + '**'}${
        r.length > 1
          ? '\n' +
            r
              .slice(1)
              .map((v) => v || '—')
              .join(' · ')
          : ''
      }`,
    });
  }
  components.push({
    type: 10,
    content: `-# Showing ${start + 1}–${Math.min(start + 3, table.rows.length)} of ${table.rows.length}`,
  });
  return components;
}
export function discordTableCsv(table: DiscordTable): Buffer {
  // RFC 4180 quoting plus spreadsheet formula-injection protection. Markdown is retained verbatim.
  const cell = (s: string) => '"' + (/^[\s]*[=+\-@\t\r]/.test(s) ? "'" + s : s).replace(/"/g, '""') + '"';
  return Buffer.from('\uFEFF' + [table.header, ...table.rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n');
}
const xml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
/** Plain text only in SVG: links, images and SVG markup from cells cannot load resources. */
const plain = (s: string) =>
  s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`+/g, '')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f]/g, ' ');
export function discordTableSvg(table: DiscordTable, page?: number): string {
  if (!interactiveDiscordTable(table))
    throw new Error('Table is too large for an image preview. Download CSV instead.');
  if (page !== undefined) discordTablePage(table, page); // Validate before slicing.
  const start = page === undefined ? 0 : page * 3;
  const rows = page === undefined ? table.rows : table.rows.slice(start, start + 3);
  const cols = table.header.length,
    width = Math.max(720, Math.min(2400, cols * 280)),
    colWidth = (width - 48) / cols;
  const wrap = (s: string) => {
    const chars = Array.from(plain(s)),
      n = Math.max(3, Math.floor((colWidth - 24) / 12));
    const lines: string[] = [];
    while (chars.length) {
      let width = 0,
        count = 0;
      while (count < chars.length) {
        const units = chars[count].codePointAt(0)! > 0x2ff ? 2 : 1;
        if (width + units > n) break;
        width += units;
        count++;
      }
      count = Math.max(1, count);
      if (count < chars.length) {
        const space = chars.slice(0, count).lastIndexOf(' ');
        if (space > count / 2) count = space + 1;
      }
      lines.push(chars.splice(0, count).join('').trim());
    }
    return lines.length ? lines : [''];
  };
  let y = 74;
  const body: string[] = [];
  for (const [index, r] of [table.header, ...rows].entries()) {
    const lines = r.map(wrap),
      height = Math.max(...lines.map((l) => l.length)) * 25 + 28;
    if (y + height > 4096) throw new Error('Table preview is too tall. Download CSV instead.');
    body.push(
      `<rect x="24" y="${y}" width="${width - 48}" height="${height}" fill="${index === 0 ? '#35404d' : index % 2 ? '#25282e' : '#2c3037'}"/>`
    );
    lines.forEach((ls, col) =>
      ls.forEach((line, n) =>
        body.push(
          `<text x="${36 + col * colWidth}" y="${y + 28 + n * 25}" fill="${index === 0 ? '#9ccaff' : '#e7e9ee'}" font-size="18"${index === 0 ? ' font-weight="bold"' : ''}>${xml(line)}</text>`
        )
      )
    );
    y += height + 2;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${y + 48}" font-family="DejaVu Sans Mono, monospace"><rect width="100%" height="100%" fill="#1e2025"/><text x="24" y="44" font-size="24" fill="#e7e9ee">Table · rows ${start + 1}–${start + rows.length} of ${table.rows.length}</text>${body.join('')}<text x="24" y="${y + 30}" font-size="16" fill="#a5acb8">Codeman · Download CSV for all rows and original cell text</text></svg>`;
}
export async function discordTablePng(table: DiscordTable, page: number): Promise<Buffer> {
  const { Resvg } = await import('@resvg/resvg-js');
  let svg: string;
  try {
    svg = discordTableSvg(table);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('Table preview is too tall')) throw error;
    svg = discordTableSvg(table, page);
  }
  return new Resvg(svg, { font: { loadSystemFonts: true } }).render().asPng();
}
