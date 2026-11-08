/** @fileoverview Render Markdown tables as labeled records that wrap naturally in narrow Discord views. */
const MAX_COLS = 24;
const MAX_ROWS = 200;
function cells(row: string): string[] {
  const text = row.trim();
  const result: string[] = [];
  let cell = '',
    ticks = 0,
    lastDelimiter = false;
  for (let i = text.startsWith('|') ? 1 : 0; i < text.length; i++) {
    const char = text[i];
    lastDelimiter = false;
    if (char === '\\' && text[i + 1] === '|') {
      cell += '|';
      i++;
      continue;
    }
    if (!ticks && char === '\\' && text[i + 1]) {
      cell += char + text[++i];
      continue;
    }
    if (char === '`') {
      let end = i + 1;
      while (text[end] === '`') end++;
      const length = end - i;
      if (!ticks) ticks = length;
      else if (ticks === length) ticks = 0;
      cell += text.slice(i, end);
      i = end - 1;
      continue;
    }
    if (char === '|' && !ticks) {
      result.push(cell.trim());
      cell = '';
      lastDelimiter = true;
    } else cell += char;
  }
  if (!lastDelimiter) result.push(cell.trim());
  return result;
}
function separator(row: string): boolean {
  const compact = row.replace(/\s+/g, '');
  return compact.includes('|') && /^\|?:?-+:?(\|:?-+:?)*\|?$/.test(compact);
}
function inlineTicks(line: string, initial = 0): number {
  let ticks = initial;
  for (const match of line.matchAll(/`+/g)) {
    let slashes = 0;
    for (let at = match.index - 1; at >= 0 && line[at] === '\\'; at--) slashes++;
    if (slashes % 2) continue;
    if (!ticks) ticks = match[0].length;
    else if (ticks === match[0].length) ticks = 0;
  }
  return ticks;
}
export interface DiscordTable {
  header: string[];
  rows: string[][];
  source: string;
}
export type DiscordTablePart = { text: string } | { table: DiscordTable };
/** Shared code-aware parser. Invalid or excessive tables remain literal text. */
export function discordTableParts(text: string): DiscordTablePart[] {
  const parts: DiscordTablePart[] = [];
  const flush = () => {
    if (out.length) parts.push({ text: out.splice(0).join('\n') });
  };
  const lines = text.split('\n'),
    out: string[] = [];
  let fence: { char: string; length: number } | undefined;
  let inline = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!fence && inline) {
      inline = inlineTicks(line, inline);
      out.push(line);
      continue;
    }
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      out.push(line);
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim())
        fence = undefined;
      continue;
    }
    if (marker && !(marker[1][0] === '`' && marker[2].includes('`'))) {
      fence = { char: marker[1][0], length: marker[1].length };
      out.push(line);
      continue;
    }
    if (!/^( {4}|\t| {0,3}>)/.test(line)) inline = inlineTicks(line);
    if (
      inline ||
      /^( {4}|\t| {0,3}>)/.test(line) ||
      !line.includes('|') ||
      i + 1 >= lines.length ||
      !separator(lines[i + 1])
    ) {
      out.push(line);
      continue;
    }
    const piped = line.trim().startsWith('|');
    let end = i + 2;
    while (
      end < lines.length &&
      lines[end].trim() &&
      lines[end].includes('|') &&
      (!piped || lines[end].trim().startsWith('|'))
    )
      end++;
    const header = cells(line);
    const original = () => {
      for (let j = i; j < end; j++) out.push(lines[j]);
    };
    if (
      header.length > MAX_COLS ||
      end - i - 2 > MAX_ROWS ||
      cells(lines[i + 1]).length !== header.length ||
      end === i + 2
    ) {
      original();
      i = end - 1;
      continue;
    }
    const rows: string[][] = [];
    let width = header.length,
      sourceLength = 0;
    for (let j = i; j < end; j++) sourceLength += lines[j].length + 1;
    for (let j = i + 2; j < end; j++) {
      const row = cells(lines[j]);
      rows.push(row);
      width = Math.max(width, row.length);
    }
    if (width > MAX_COLS) {
      original();
      i = end - 1;
      continue;
    }
    // Bound interactive snapshots; normalize missing and extra columns without dropping values.
    if (sourceLength > 64 * 1024) {
      original();
      i = end - 1;
      continue;
    }
    flush();
    parts.push({
      table: {
        header: Array.from({ length: width }, (_, col) => header[col] ?? `Column ${col + 1}`),
        rows: rows.map((r) => Array.from({ length: width }, (_, col) => r[col] ?? '')),
        source: lines.slice(i, end).join('\n'),
      },
    });
    i = end - 1;
  }
  flush();
  return parts;
}

export function formatDiscordTables(text: string): string {
  return discordTableParts(text)
    .map((part) => {
      if ('text' in part) return part.text;
      const { header, rows, source } = part.table;
      const labels = header.map((label, col) => label.trim() || `Column ${col + 1}`);
      const formatted: string[] = [];
      let size = 0;
      const budget = Math.max(4096, source.length * 4);
      for (const row of rows) {
        if (formatted.length) formatted.push('');
        for (let col = 0; col < header.length; col++) {
          const label = /[`*_[\]]/.test(labels[col]) ? labels[col] + ':' : `**${labels[col]}:**`;
          const field = `${label} ${row[col] || '—'}`;
          size += field.length + 1;
          if (size > budget) return source;
          formatted.push(field);
        }
      }
      return formatted.join('\n');
    })
    .join('\n');
}
