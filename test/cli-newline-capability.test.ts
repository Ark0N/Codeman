// @vitest-environment node
// capabilities.newline: the bytes Shift+Enter types into a CLI's pane. Data in the registry, not
// a branch on the CLI id (test/cli-registry-no-id-branching.test.ts keeps the latter true).

import { describe, expect, it } from 'vitest';
import { CliEntrySchema } from '../src/config/cli-registry/schema.js';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';
import type { CliEntry } from '../src/config/cli-registry/types.js';

const claude = () => structuredClone(STOCK_CLIS.find((e) => (e.id as string) === 'claude')!) as CliEntry;

describe('capabilities.newline', () => {
  it('only codex declares a non-default chord today', () => {
    const declared = Object.fromEntries(
      STOCK_CLIS.filter((e) => e.capabilities.newline).map((e) => [e.id as string, e.capabilities.newline])
    );
    expect(declared).toEqual({ codex: 'esc-enter' });
  });

  it.each(['line-feed', 'esc-enter'])('schema accepts %s', (value) => {
    const e = claude();
    (e.capabilities as Record<string, unknown>).newline = value;
    expect(CliEntrySchema.safeParse(e).success).toBe(true);
  });

  it.each(['lf', 'crlf', '\x1b\r', '', 0])('schema rejects %j (no free-form byte strings in config)', (value) => {
    const e = claude();
    (e.capabilities as Record<string, unknown>).newline = value;
    expect(CliEntrySchema.safeParse(e).success).toBe(false);
  });

  it('is optional, so an entry that declares nothing keeps the line feed', () => {
    const e = claude();
    delete (e.capabilities as Record<string, unknown>).newline;
    expect(CliEntrySchema.safeParse(e).success).toBe(true);
  });
});
