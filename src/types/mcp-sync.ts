/**
 * @fileoverview Response types for MCP server sync (`GET`/`POST /api/mcp-sync`, src/mcp-sync.ts).
 *
 * These are returned over HTTP, so they carry server NAMES only: never env values or headers,
 * and never file content (a parse failure is reported by position, see `describeMcpSyncError`).
 */

/** One participating CLI in a sync result. */
export interface McpSyncTargetResult {
  id: string;
  label: string;
  /** The config file read (and written). For a `skipped` target, the unresolved location. */
  file: string;
  /**
   * `absent`: not installed and no config file, so neither read nor created.
   * `skipped`: the CLI's config location could not be resolved safely (e.g. its relocation env
   * var is a relative path), so it is neither read nor written; `error` says why.
   * `unreadable`: the file exists but cannot be parsed safely, so it is not written.
   * `failed`: a read or write error (the file may be unchanged).
   */
  status: 'ok' | 'absent' | 'skipped' | 'unreadable' | 'failed';
  /** Why the target is not `ok`. Position or category only, never file content. */
  error?: string;
  servers: string[];
  /** Servers added (apply) or that would be added (plan). */
  added: string[];
  /** Missing servers this dialect cannot express. */
  skipped: string[];
}

/** The `data` of `GET`/`POST /api/mcp-sync`. */
export interface McpSyncResult {
  applied: boolean;
  targets: McpSyncTargetResult[];
  /** Names defined differently by different CLIs; existing definitions are left untouched. */
  conflicts: string[];
  /** Names left out because the only definitions are switched off in their own CLI. */
  disabled: string[];
  /** Installed, enabled agent CLIs with no known MCP config file, so sync cannot touch them. */
  unsupported: string[];
}
