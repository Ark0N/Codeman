/**
 * @fileoverview Loads, merges and re-validates the CLI registry.
 *
 * `~/.codeman/clis.json` holds OVERRIDES and CUSTOM entries only — never a full copy of the
 * stock catalog — so a shipped fix to a stock definition actually reaches an existing
 * install, and the file stays small enough to hand-edit.
 *
 * Resolution: start from `STOCK_CLIS` → deep-merge each override by id (objects merge
 * key-wise, arrays replace wholesale) → validate every resulting entry. A stock entry that
 * fails validation after merge falls back to its pristine stock definition (a fat-fingered
 * override cannot brick a shipped CLI); a custom entry that fails is dropped with a warning
 * rather than failing the whole load. Stock entries are always emitted, so `shell` and
 * `claude` can be disabled but can never go missing — large parts of the app assume at
 * minimum that a shell fallback exists.
 *
 * ⚠️ READ-ONLY. Nothing in this module writes, creates or migrates the file. That is a
 * deliberate property, not a missing feature: there is no settings UI and no write API yet,
 * so there is nothing to persist, and it means importing the registry — which
 * `src/web/schemas.ts` does, transitively, just to validate a request — performs no
 * filesystem writes. A `seededStockIds` ratchet belongs with the write API that needs it.
 * The one exception is the quarantine RENAME of a file that fails to parse (see
 * `readRegistryFile`), which happens on first use rather than at import.
 *
 * ⚠️ The file must be mode 0600. `isUnsafePermissions` refuses ANY group/world bit, read
 * bits included, so a file created with a normal umask (0644) is ignored. Every reason the
 * file was ignored, or an entry in it dropped, is logged ONCE on first load: the warnings
 * used to be returned to a caller that nobody wired up, so a normally-created file was
 * ignored with no feedback anywhere (found reviewing #347).
 *
 * @module config/cli-registry/registry
 */

import { existsSync, readFileSync, renameSync, statSync } from 'node:fs';
import { dataPath } from '../instance.js';
import type { CliEntry, CliId, CliRegistryFile } from './types.js';
import { CliEntrySchema } from './schema.js';
import { STOCK_CLIS } from './stock.js';

/** Construct a validated CliId. Throws if `raw` is not a well-formed id — call at API boundaries. */
export function asCliId(raw: string): CliId {
  if (!/^[a-z][a-z0-9-]{0,23}$/.test(raw)) {
    throw new Error(`invalid CLI id: ${JSON.stringify(raw)}`);
  }
  return raw as CliId;
}

function filePath(): string {
  return dataPath('clis.json');
}

/**
 * The resolved path of `~/.codeman/clis.json`, exported for the write API
 * (`cli-registry-writer.ts`, docs/cli-enable-disable-plan.md Phases 3/5) so both the read and
 * write sides resolve the SAME path through the SAME instance-scoped helper — never a second
 * `dataPath('clis.json')` call that could drift from this one under a future `dataPath()` change.
 */
export function registryFilePath(): string {
  return filePath();
}

/**
 * Keys that must never be merged out of a hand-editable JSON file.
 *
 * `JSON.parse` produces `__proto__` as an ORDINARY own property, but `result[key] = …` on a
 * plain object walks the setter chain and would set the merged object's PROTOTYPE instead.
 * Not exploitable today — every merged entry is spread into `{ ...merged, id, stock }` and
 * then Zod-parsed before anything reads it, which drops the effect — but "not exploitable
 * because of what a caller happens to do afterwards" is a property that quietly stops
 * holding. A `continue` in the loop that reads the file is the cheap end of that trade.
 */
const UNMERGEABLE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Plain-object deep merge: nested objects merge key-wise, arrays and primitives replace. */
function deepMerge<T>(base: T, override: unknown): T {
  if (override === null || typeof override !== 'object' || Array.isArray(override)) {
    return (override === undefined ? base : (override as T)) ?? base;
  }
  if (base === null || typeof base !== 'object' || Array.isArray(base)) {
    return override as T;
  }
  const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
    if (UNMERGEABLE_KEYS.has(key)) continue;
    result[key] = deepMerge((base as Record<string, unknown>)[key], value);
  }
  return result as T;
}

export interface LoadResult {
  entries: CliEntry[];
  warnings: string[];
}

/**
 * Refuse a registry file with any group/world permission bit — same posture as the ssh-key
 * discipline, so 0600 is the only accepted mode. This file selects the binaries Codeman
 * spawns, so a writable one is a way to redirect every session.
 *
 * POSIX only: Windows has no meaningful group/world bits on NTFS (Node reports every file
 * as mode 0o666 there regardless of its actual ACL), so this check would flag every file on
 * Windows and silently ignore all user config. `win32` relies on NTFS ACLs instead, which
 * this check cannot see and does not attempt to.
 *
 * Exported for `registry-writer.ts`, which must refuse the same files: rewriting a refused
 * file as 0600 would silently turn it into trusted config.
 */
export function isUnsafePermissions(path: string): boolean {
  if (process.platform === 'win32') return false;
  try {
    const mode = statSync(path).mode & 0o777;
    return (mode & 0o077) !== 0;
  } catch {
    return false;
  }
}

function readRegistryFile(path: string, warnings: string[]): CliRegistryFile | null {
  if (!existsSync(path)) return null;
  if (isUnsafePermissions(path)) {
    warnings.push(
      `${path} must be mode 0600 (no group/world permission bits; run \`chmod 600 ${path}\`); ignoring it and falling back to stock CLIs.`
    );
    return null;
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    warnings.push(`Failed to read ${path}: ${(err as Error).message}. Falling back to stock CLIs.`);
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as CliRegistryFile;
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.clis !== 'object') {
      throw new Error('missing "clis" object');
    }
    return parsed;
  } catch (err) {
    // QUARANTINE, never overwrite: the file is hand-editable, so a syntax error is far more
    // likely to be a half-finished edit than junk. Renaming keeps the user's work.
    const quarantined = `${path}.invalid-${Date.now()}`;
    try {
      renameSync(path, quarantined);
      warnings.push(`${path} was not valid JSON (${(err as Error).message}); moved to ${quarantined}.`);
    } catch {
      warnings.push(
        `${path} was not valid JSON (${(err as Error).message}); left in place, falling back to stock CLIs.`
      );
    }
    return null;
  }
}

/**
 * Merge the stock catalog with a (possibly absent) registry file. PURE — no IO, which is
 * what lets the load tests drive every merge case directly.
 */
export function resolveRegistry(stock: CliEntry[], file: CliRegistryFile | null, warnings: string[]): LoadResult {
  const stockById = new Map(stock.map((e) => [e.id as string, e]));
  const overrides = file?.clis ?? {};
  const entries: CliEntry[] = [];

  for (const stockEntry of stock) {
    const id = stockEntry.id as string;
    const override = overrides[id];
    const merged = override ? deepMerge(stockEntry, override) : stockEntry;
    // `stock: true` is forced here rather than read from the merged object, so an override
    // can never flip a custom entry's provenance or vice versa.
    const parsed = CliEntrySchema.safeParse({ ...merged, id, stock: true });
    if (parsed.success) {
      entries.push(parsed.data as CliEntry);
    } else {
      warnings.push(
        `Override for stock CLI "${id}" failed validation; using the shipped definition. ${parsed.error.message}`
      );
      entries.push(stockEntry);
    }
  }

  for (const [id, raw] of Object.entries(overrides)) {
    if (stockById.has(id)) continue; // already merged above
    // Same forcing in the other direction: a custom entry claiming `stock: true` cannot
    // shadow or impersonate a shipped one.
    const parsed = CliEntrySchema.safeParse({ ...(raw as object), id, stock: false });
    if (parsed.success) {
      entries.push(parsed.data as CliEntry);
    } else {
      warnings.push(`Custom CLI "${id}" failed validation and was dropped. ${parsed.error.message}`);
    }
  }

  entries.sort((a, b) => a.order - b.order);
  return { entries, warnings };
}

let cache: LoadResult | null = null;

/**
 * Load the effective registry (stock + user overrides). Memoized for the process lifetime;
 * `reloadCliRegistry()` invalidates.
 */
export function loadCliRegistry(): LoadResult {
  if (cache) return cache;
  const warnings: string[] = [];
  const existing = readRegistryFile(filePath(), warnings);
  cache = resolveRegistry(STOCK_CLIS, existing, warnings);
  // Once per process (the result is memoized): silence here is what made a 0644 file look
  // like "the override feature does nothing".
  for (const warning of warnings) console.warn(`[cli-registry] ${warning}`);
  return cache;
}

/** Drop the memoized registry so the next `loadCliRegistry()` re-reads the file. */
export function reloadCliRegistry(): void {
  cache = null;
}

export function listClis(): CliEntry[] {
  return loadCliRegistry().entries;
}

export function enabledClis(): CliEntry[] {
  return listClis().filter((e) => e.enabled);
}

export function getCli(id: string): CliEntry | undefined {
  return listClis().find((e) => (e.id as string) === id);
}

export function cliIds(): string[] {
  return listClis().map((e) => e.id as string);
}

/** Every enabled entry's id, in registry order. */
export function enabledCliIds(): string[] {
  return enabledClis().map((e) => e.id as string);
}

/**
 * Resolve the install command for the current platform, falling back to the linux one (the
 * common case for a `curl | bash` or `npm install -g` line) and then to whatever is
 * declared. Display text only — never executed. See CliDiscovery.install.command.
 */
export function resolveInstallCommandForPlatform(entry: CliEntry): string | undefined {
  const { command } = entry.discovery.install;
  const platform = process.platform as 'linux' | 'darwin' | 'win32';
  return command[platform] ?? command.linux ?? Object.values(command)[0];
}
