/**
 * @fileoverview MCP sync targets that are not Codeman run modes.
 *
 * `mcpSyncTargets()` (routes/mcp-sync-routes.ts) takes the registry's enabled CLIs that declare an
 * `mcpConfig`. Some tools read an MCP server list worth keeping in step with the others but are not
 * something Codeman launches, so they have no registry entry (and no id to branch on): GitHub
 * Copilot CLI is the first. It is also a run mode that declares its own `mcpConfig`, so while that
 * entry is enabled this row is skipped (`mcpSyncOnlyTargets` drops ids the registry already
 * supplies); it applies when the run mode is disabled but the tool is still on the machine. They are
 * plain data here, take part only when installed or when their config file already exists (an
 * absent tool is reported `absent`, never created), and sort after the registry CLIs, so when two
 * definitions of a name differ the registry CLI's is the one copied.
 *
 * @module mcp-sync-targets
 */

import { accessSync, constants as fsConstants } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { McpConfigFormat } from './config/cli-registry/types.js';
import type { McpSyncTarget } from './mcp-sync.js';

export interface McpSyncOnlyTool {
  id: string;
  label: string;
  /** Home-relative default location of the MCP config file. */
  path: string;
  format: McpConfigFormat;
  /** The env var the tool reads to move its home, and the file under it. */
  relocation?: { envVar: string; path: string };
  /** The executable whose presence on this machine means the tool is installed. */
  binary: string;
}

export const MCP_SYNC_ONLY_TOOLS: readonly McpSyncOnlyTool[] = [
  {
    id: 'copilot',
    label: 'GitHub Copilot CLI',
    path: '.copilot/mcp-config.json',
    format: 'copilot-json',
    // COPILOT_HOME replaces ~/.copilot (checked: `COPILOT_HOME=<dir> copilot mcp list` reads <dir>).
    relocation: { envVar: 'COPILOT_HOME', path: 'mcp-config.json' },
    binary: 'copilot',
  },
];

/** `name` is an executable file in the server's PATH, `~/.local/bin` or `/usr/local/bin`. */
export function binaryOnPath(name: string, env: Record<string, string | undefined> = process.env): boolean {
  const dirs = [
    ...(env.PATH ?? '').split(delimiter).filter(Boolean),
    join(homedir(), '.local', 'bin'),
    '/usr/local/bin',
  ];
  return dirs.some((dir) => {
    try {
      accessSync(join(dir, name), fsConstants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/** The sync-only tools as sync targets, skipping any id the registry already provides. */
export function mcpSyncOnlyTargets(
  taken: ReadonlySet<string>,
  isInstalled: (binary: string) => boolean = binaryOnPath
): McpSyncTarget[] {
  return MCP_SYNC_ONLY_TOOLS.filter((t) => !taken.has(t.id)).map((t) => ({
    id: t.id,
    label: t.label,
    path: t.path,
    format: t.format,
    ...(t.relocation ? { relocation: t.relocation } : {}),
    installed: isInstalled(t.binary),
  }));
}
