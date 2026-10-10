// @vitest-environment node
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { binaryOnPath, MCP_SYNC_ONLY_TOOLS, mcpSyncOnlyTargets } from '../src/mcp-sync-targets.js';
import { mcpSyncTargets } from '../src/web/routes/mcp-sync-routes.js';

describe('sync-only MCP targets (tools that are not Codeman run modes)', () => {
  it('declares GitHub Copilot CLI with its config file, dialect and relocation var', () => {
    const t = mcpSyncOnlyTargets(new Set(), () => true).find((x) => x.id === 'copilot')!;
    expect(t).toMatchObject({
      label: 'GitHub Copilot CLI',
      path: '.copilot/mcp-config.json',
      format: 'copilot-json',
      relocation: { envVar: 'COPILOT_HOME', path: 'mcp-config.json' },
      installed: true,
    });
  });

  it('asks about the declared binary, and reports it not installed when it is missing', () => {
    const asked: string[] = [];
    const t = mcpSyncOnlyTargets(new Set(), (b) => (asked.push(b), false));
    expect(asked).toEqual(MCP_SYNC_ONLY_TOOLS.map((x) => x.binary));
    expect(t.every((x) => x.installed === false)).toBe(true);
  });

  it('yields to a registry CLI that already uses the id', () => {
    expect(mcpSyncOnlyTargets(new Set(['copilot']), () => true)).toEqual([]);
  });

  it('comes after the registry CLIs in the targets the route syncs', () => {
    const ids = mcpSyncTargets({}).map((t) => t.id);
    expect(ids).toContain('copilot');
    expect(ids.indexOf('copilot')).toBe(ids.length - 1);
  });
});

describe('binaryOnPath', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bin-on-path-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('finds an executable in PATH and ignores a non-executable file of the same name', () => {
    writeFileSync(join(dir, 'fake-tool'), '#!/bin/sh\n');
    chmodSync(join(dir, 'fake-tool'), 0o644);
    expect(binaryOnPath('fake-tool', { PATH: dir })).toBe(false);
    chmodSync(join(dir, 'fake-tool'), 0o755);
    expect(binaryOnPath('fake-tool', { PATH: dir })).toBe(true);
    expect(binaryOnPath('no-such-tool-xyz', { PATH: dir })).toBe(false);
  });
});
