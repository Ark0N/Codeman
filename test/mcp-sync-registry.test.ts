// @vitest-environment node
// The registry half of MCP sync: which CLIs declare an MCP config file, and that the schema
// guards the path (sync writes to it) so a user clis.json cannot aim a write outside $HOME.

import { describe, expect, it } from 'vitest';
import { CliEntrySchema } from '../src/config/cli-registry/schema.js';
import { STOCK_CLIS } from '../src/config/cli-registry/stock.js';
import type { CliEntry } from '../src/config/cli-registry/types.js';

const claude = () => structuredClone(STOCK_CLIS.find((e) => (e.id as string) === 'claude')!) as CliEntry;

function withMcp(mcpConfig: unknown) {
  const e = claude();
  (e.capabilities as Record<string, unknown>).mcpConfig = mcpConfig;
  return CliEntrySchema.safeParse(e);
}

describe('capabilities.mcpConfig', () => {
  it('is declared by exactly the CLIs whose format is verified', () => {
    const declared = STOCK_CLIS.filter((e) => e.capabilities.mcpConfig).map((e) => e.id as string);
    expect(declared.sort()).toEqual(['antigravity', 'claude', 'codex', 'gemini', 'opencode']);
  });

  it('every stock declaration passes the schema, with a distinct file per CLI', () => {
    for (const e of STOCK_CLIS) expect(CliEntrySchema.safeParse(e).success, e.id as string).toBe(true);
    const paths = STOCK_CLIS.flatMap((e) => (e.capabilities.mcpConfig ? [e.capabilities.mcpConfig.path] : []));
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('accepts a home-relative path with a known format', () => {
    expect(withMcp({ path: '.tool/mcp.json', format: 'claude-json' }).success).toBe(true);
  });

  it.each([
    ['parent traversal', { path: '../evil.json', format: 'claude-json' }],
    ['nested traversal', { path: '.a/../../evil.json', format: 'claude-json' }],
    ['absolute path', { path: '/etc/cron.d/x', format: 'claude-json' }],
    ['shell metacharacters', { path: '.a;rm -rf', format: 'claude-json' }],
    ['unknown format', { path: '.a/mcp.json', format: 'yaml' }],
    ['extra key', { path: '.a/mcp.json', format: 'claude-json', mode: 'rw' }],
  ])('rejects %s', (_label, value) => {
    expect(withMcp(value).success).toBe(false);
  });
});
