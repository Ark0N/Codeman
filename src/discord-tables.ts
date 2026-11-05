/** Render Markdown tables as labeled records that wrap naturally in narrow Discord views. */
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
export function formatDiscordTables(text: string): string {
  const lines = text.split('\n'),
    out: string[] = [];
  let fence: { char: string; length: number } | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i],
      marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
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
    if (/^( {4}|\t)/.test(line) || !line.includes('|') || i + 1 >= lines.length || !separator(lines[i + 1])) {
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
    const labels = Array.from(
      { length: width },
      (_, col) => (header[col] ?? '').replace(/\*\*|`/g, '').trim() || `Column ${col + 1}`
    );
    const formatted: string[] = [];
    let size = 0,
      exceeded = false;
    const budget = Math.max(4096, sourceLength * 4);
    for (const row of rows) {
      if (formatted.length) {
        formatted.push('');
        size++;
      }
      for (let col = 0; col < width; col++) {
        const field = `**${labels[col]}:** ${row[col] || '—'}`;
        size += field.length + 1;
        if (size > budget) {
          exceeded = true;
          break;
        }
        formatted.push(field);
      }
      if (exceeded) break;
    }
    if (exceeded) original();
    else {
      for (const field of formatted) out.push(field);
    }
    i = end - 1;
  }
  return out.join('\n');
}
