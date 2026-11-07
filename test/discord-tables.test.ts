import { describe, expect, it } from 'vitest';
import { formatDiscordTables } from '../src/discord-tables.js';
import { splitForDiscord } from '../src/discord-bridge.js';
describe('mobile Discord table records', () => {
  it('renders a long status as wrapping labeled text without padding, rules or code fences', () => {
    const status = "Live. Run 5's stuck push cleared, so the retry path now works. " + 'More detail. '.repeat(80);
    const out = formatDiscordTables(`| Item | Status |\n|---|---|\n| BUILD-1234 | ${status} |`);
    expect(out).toBe('**Item:** BUILD-1234\n**Status:** ' + status.trim());
    expect(out).not.toContain('```');
    expect(out).not.toMatch(/-{3,}/);
    expect(out.length).toBeLessThan(status.length + 100);
  });
  it('retains every field in multi-column records, including links, Unicode and inline code', () => {
    const out = formatDiscordTables(
      '| Project | Status | Link |\n|---|---|---|\n| 🧠 Brain | **Ready** | [Open](https://example.test) |\n| 家 | `queued` | — |'
    );
    expect(out).toContain('**Project:** 🧠 Brain\n**Status:** **Ready**\n**Link:** [Open](https://example.test)');
    expect(out).toContain('**Project:** 家\n**Status:** `queued`');
  });
  it('keeps escaped pipes and pipes in inline code inside their original cells', () => {
    const out = formatDiscordTables('| Command | Meaning |\n|---|---|\n| `a | b` | x \\| y |');
    expect(out).toBe('**Command:** `a | b`\n**Meaning:** x | y');
  });
  it('uses explicit missing-field and extra-column labels rather than dropping values', () => {
    const out = formatDiscordTables('| a | b |\n|---|---|\n| x |\n| p | q | extra |');
    expect(out).toContain('**a:** x\n**b:** —\n**Column 3:** —');
    expect(out).toContain('**Column 3:** extra');
  });
  it.each(['```', '````', '~~~'])('preserves literal tables inside %s fences', (fence) => {
    const table = '| A | B |\n|---|---|\n| x | y |';
    const literal = fence + 'text\n' + table + '\n' + fence;
    expect(formatDiscordTables(literal + '\n\n' + table)).toBe(literal + '\n\n**A:** x\n**B:** y');
  });
  it('preserves indented examples, empty table templates and mismatched separators', () => {
    for (const text of [
      '    | A | B |\n    |---|---|\n    |x|y|',
      '| A | B |\n|---|---|',
      '| A | B |\n|---|\n| x | y |',
    ])
      expect(formatDiscordTables(text)).toBe(text);
  });
  it('bounds repeated-header expansion while preserving the original data on oversized input', () => {
    const text =
      '| ' + 'x'.repeat(4000) + ' | value |\n|---|---|\n' + Array.from({ length: 100 }, () => '| a | b |').join('\n');
    expect(formatDiscordTables(text)).toBe(text);
  });
  it('keeps long Unicode cell content well formed through Discord message splitting', () => {
    const value = '🧠'.repeat(2200);
    const out = formatDiscordTables('| Item | Status |\n|---|---|\n| test | ' + value + ' |');
    const parts = splitForDiscord(out, 1900, 8);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((p) => p.length <= 1900 && p.isWellFormed())).toBe(true);
    expect(parts.join('').match(/🧠/gu)).toHaveLength(2200);
  });
});
