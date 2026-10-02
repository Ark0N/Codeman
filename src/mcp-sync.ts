/**
 * @fileoverview MCP server sync between the enabled agent CLIs.
 *
 * Each CLI keeps its own user-level MCP list in its own dialect (`CliEntry.capabilities.mcpConfig`
 * names the file and the dialect). This module reads every participating CLI's list into one
 * neutral shape, and adds any server a CLI is missing from the others. The whole feature is
 * opt-in (`mcpSyncEnabled`, default OFF; the route enforces it) because it writes OTHER tools'
 * own user config.
 *
 * Deliberately conservative:
 *   - ADDITIVE only. A server already present under a name (in ANY shape, even one this module
 *     does not understand) is never rewritten and nothing is ever removed. Same name with a
 *     different definition is reported as a conflict and left alone.
 *   - A server the user has switched off in its own CLI (codex `enabled = false`, opencode
 *     `enabled: false`, antigravity `disabled: true`) is not propagated: copying it would
 *     switch it on in every other CLI.
 *   - A file that does not parse (e.g. opencode JSONC with comments, a TOML file with a
 *     duplicate table) is never written, and a write is only made after the NEW text has been
 *     parsed again and every added server comes back as intended.
 *   - Only the MCP table is touched; every other key in the file is preserved. Files are
 *     re-read immediately before the write and replaced via tmp+rename next to the REAL target
 *     (a symlinked dotfile stays a symlink), with the old file kept as `<file>.codeman-bak`
 *     (overwritten by each sync).
 *   - Copied servers can carry secrets in `env`/`headers`: a file that receives any is left
 *     readable by its owner only.
 *   - Servers a dialect cannot express (SSE for codex) are skipped and reported.
 *   - Only one apply runs at a time.
 *
 * The result types never carry env values or headers: those commonly hold secrets and the
 * result is returned over HTTP.
 *
 * @module mcp-sync
 */

import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { McpConfigFormat } from './config/cli-registry/types.js';

export type McpFormat = McpConfigFormat;

export interface McpServer {
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  /** Switched off in the CLI that defines it. Never propagated. */
  disabled?: boolean;
}

export type McpServerMap = Record<string, McpServer>;

export interface McpSyncTarget {
  id: string;
  label: string;
  path: string;
  format: McpFormat;
  /** The CLI's binary resolves on this machine. A CLI that is not installed and has no config file is left alone. */
  installed: boolean;
}

export interface McpSyncTargetResult {
  id: string;
  label: string;
  file: string;
  /**
   * `absent`: not installed and no config file, so neither read nor created.
   * `unreadable`: the file exists but cannot be parsed safely, so it is not written.
   * `failed`: a read or write error (the file may be unchanged).
   */
  status: 'ok' | 'absent' | 'unreadable' | 'failed';
  error?: string;
  servers: string[];
  /** Servers added (apply) or that would be added (plan). */
  added: string[];
  /** Missing servers this dialect cannot express. */
  skipped: string[];
}

export interface McpSyncResult {
  applied: boolean;
  targets: McpSyncTargetResult[];
  /** Names defined differently by different CLIs; existing definitions are left untouched. */
  conflicts: string[];
  /** Names left out because the only definitions are switched off in their own CLI. */
  disabled: string[];
  /** Enabled agent CLIs with no known MCP config file, so sync cannot touch them. */
  unsupported: string[];
}

/** A second apply was requested while one was running. */
export class McpSyncBusyError extends Error {
  constructor() {
    super('An MCP sync is already running');
    this.name = 'McpSyncBusyError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Names that would reach Object.prototype through a plain-object table (`out[name] = ...`). */
const UNSAFE_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

/** A table keyed by untrusted names: no prototype, so `toString`/`hasOwnProperty` are ordinary keys. */
function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** Own, safe keys of an untrusted table. */
function safeKeys(table: Record<string, unknown>): string[] {
  return Object.keys(table).filter((k) => !UNSAFE_NAMES.has(k));
}

function strMap(v: unknown): Record<string, string> | undefined {
  if (!isRecord(v)) return undefined;
  const out = dict<string>();
  for (const k of safeKeys(v)) if (typeof v[k] === 'string') out[k] = v[k] as string;
  return Object.keys(out).length ? out : undefined;
}

function strArr(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
}

/** Drop undefined/empty fields so equal servers compare equal. */
function clean(s: McpServer): McpServer {
  const out: McpServer = { transport: s.transport };
  if (s.command) out.command = s.command;
  if (s.args?.length) out.args = s.args;
  if (s.env && Object.keys(s.env).length) out.env = s.env;
  if (s.cwd) out.cwd = s.cwd;
  if (s.url) out.url = s.url;
  if (s.headers && Object.keys(s.headers).length) out.headers = s.headers;
  if (s.disabled) out.disabled = true;
  return out;
}

const sortedEntries = (m: Record<string, string> | undefined): [string, string][] =>
  Object.entries(m ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** Identity for conflict detection: what the server runs/connects to, not how it is spelled. */
function fingerprint(s: McpServer): string {
  const t = s.transport === 'stdio' ? 'stdio' : 'url';
  return JSON.stringify([t, s.command ?? null, s.args ?? [], s.url ?? null]);
}

/** Fingerprint plus the secrets-bearing maps: what must survive a write unchanged. */
function fullIdentity(s: McpServer): string {
  return JSON.stringify([fingerprint(s), sortedEntries(s.env), sortedEntries(s.headers)]);
}

const carriesSecrets = (m: McpServerMap): boolean => Object.values(m).some((s) => s.env || s.headers);

// ---------------------------------------------------------------------------
// JSON dialects
// ---------------------------------------------------------------------------

function fromClaude(raw: unknown): McpServer | null {
  if (!isRecord(raw)) return null;
  const type = raw.type;
  if ((type === 'http' || type === 'sse') && typeof raw.url === 'string') {
    return clean({ transport: type, url: raw.url, headers: strMap(raw.headers) });
  }
  if (typeof raw.command === 'string') {
    return clean({ transport: 'stdio', command: raw.command, args: strArr(raw.args), env: strMap(raw.env) });
  }
  return null;
}

function toClaude(s: McpServer): Record<string, unknown> {
  if (s.transport === 'stdio') return { type: 'stdio', command: s.command, args: s.args ?? [], env: s.env ?? {} };
  return { type: s.transport, url: s.url, ...(s.headers ? { headers: s.headers } : {}) };
}

function fromGemini(raw: unknown): McpServer | null {
  if (!isRecord(raw)) return null;
  // `httpUrl` is the legacy streamable-http key; `url` + `type` is what `gemini mcp add` writes
  // today, and a bare `url` with no type is the legacy SSE form.
  if (typeof raw.httpUrl === 'string')
    return clean({ transport: 'http', url: raw.httpUrl, headers: strMap(raw.headers) });
  if (typeof raw.url === 'string') {
    return clean({ transport: raw.type === 'http' ? 'http' : 'sse', url: raw.url, headers: strMap(raw.headers) });
  }
  if (typeof raw.command === 'string') {
    return clean({
      transport: 'stdio',
      command: raw.command,
      args: strArr(raw.args),
      env: strMap(raw.env),
      cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
    });
  }
  return null;
}

function toGemini(s: McpServer): Record<string, unknown> {
  if (s.transport === 'stdio') {
    return {
      command: s.command,
      args: s.args ?? [],
      ...(s.env ? { env: s.env } : {}),
      ...(s.cwd ? { cwd: s.cwd } : {}),
    };
  }
  return { url: s.url, type: s.transport, ...(s.headers ? { headers: s.headers } : {}) };
}

/** Antigravity (`agy mcp add`): stdio or http only; http servers use `serverUrl`. */
function fromAntigravity(raw: unknown): McpServer | null {
  if (!isRecord(raw)) return null;
  const disabled = raw.disabled === true;
  if (typeof raw.serverUrl === 'string')
    return clean({ transport: 'http', url: raw.serverUrl, headers: strMap(raw.headers), disabled });
  if (typeof raw.command === 'string') {
    return clean({
      transport: 'stdio',
      command: raw.command,
      args: strArr(raw.args),
      env: strMap(raw.env),
      disabled,
    });
  }
  return null;
}

function toAntigravity(s: McpServer): Record<string, unknown> | null {
  if (s.transport === 'sse') return null;
  if (s.transport === 'stdio') {
    return { command: s.command, args: s.args ?? [], ...(s.env ? { env: s.env } : {}), disabled: false };
  }
  return { serverUrl: s.url, ...(s.headers ? { headers: s.headers } : {}), disabled: false };
}

function fromOpencode(raw: unknown): McpServer | null {
  if (!isRecord(raw)) return null;
  const disabled = raw.enabled === false;
  if (raw.type === 'remote' && typeof raw.url === 'string') {
    return clean({ transport: 'http', url: raw.url, headers: strMap(raw.headers), disabled });
  }
  if (raw.type === 'local') {
    const cmd = strArr(raw.command);
    if (!cmd?.length) return null;
    return clean({
      transport: 'stdio',
      command: cmd[0],
      args: cmd.slice(1),
      env: strMap(raw.environment),
      disabled,
    });
  }
  return null;
}

function toOpencode(s: McpServer): Record<string, unknown> {
  if (s.transport === 'stdio') {
    return {
      type: 'local',
      command: [s.command, ...(s.args ?? [])],
      ...(s.env ? { environment: s.env } : {}),
      enabled: true,
    };
  }
  return { type: 'remote', url: s.url, ...(s.headers ? { headers: s.headers } : {}), enabled: true };
}

interface JsonDialect {
  /** Key holding the server table. */
  key: string;
  from(raw: unknown): McpServer | null;
  to(s: McpServer): Record<string, unknown> | null;
  /** Top-level keys to seed when creating the file from nothing. */
  seed?: Record<string, unknown>;
}

const JSON_DIALECTS: Record<Exclude<McpFormat, 'codex-toml'>, JsonDialect> = {
  'claude-json': { key: 'mcpServers', from: fromClaude, to: toClaude },
  'gemini-json': { key: 'mcpServers', from: fromGemini, to: toGemini },
  'antigravity-json': { key: 'mcpServers', from: fromAntigravity, to: toAntigravity },
  'opencode-json': {
    key: 'mcp',
    from: fromOpencode,
    to: toOpencode,
    seed: { $schema: 'https://opencode.ai/config.json' },
  },
};

// ---------------------------------------------------------------------------
// Codex TOML (the `[mcp_servers.*]` tables only)
// ---------------------------------------------------------------------------

function fromCodex(t: Record<string, unknown>): McpServer | null {
  const disabled = t.enabled === false;
  if (typeof t.url === 'string') {
    return clean({ transport: 'http', url: t.url, headers: strMap(t.http_headers), disabled });
  }
  if (typeof t.command === 'string') {
    return clean({ transport: 'stdio', command: t.command, args: strArr(t.args), env: strMap(t.env), disabled });
  }
  return null;
}

const tomlStr = (v: string): string => JSON.stringify(v);
const tomlKey = (k: string): string => (/^[A-Za-z0-9_-]+$/.test(k) ? k : tomlStr(k));

function toCodexToml(name: string, s: McpServer): string {
  const head = `[mcp_servers.${tomlKey(name)}]`;
  const lines = [head];
  if (s.transport === 'stdio') {
    lines.push(`command = ${tomlStr(s.command ?? '')}`);
    lines.push(`args = [${(s.args ?? []).map(tomlStr).join(', ')}]`);
    if (s.env) {
      lines.push('', `[mcp_servers.${tomlKey(name)}.env]`);
      for (const [k, v] of Object.entries(s.env)) lines.push(`${tomlKey(k)} = ${tomlStr(v)}`);
    }
  } else {
    lines.push(`url = ${tomlStr(s.url ?? '')}`);
    if (s.headers) {
      lines.push('', `[mcp_servers.${tomlKey(name)}.http_headers]`);
      for (const [k, v] of Object.entries(s.headers)) lines.push(`${tomlKey(k)} = ${tomlStr(v)}`);
    }
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Dialect entry points
// ---------------------------------------------------------------------------

export interface ParsedConfig {
  /** Servers this module understands. */
  servers: McpServerMap;
  /** Every name defined under the MCP table, in any shape: these are never appended over. */
  names: Set<string>;
}

/** The MCP table of a config file's text (null = file absent). Throws if it cannot be read safely. */
function mcpTable(format: McpFormat, text: string | null): Record<string, unknown> {
  if (text === null || !text.trim()) return dict<unknown>();
  if (format === 'codex-toml') {
    const doc = parseToml(text);
    const table = doc.mcp_servers;
    if (table === undefined) return dict<unknown>();
    if (!isRecord(table)) throw new Error('"mcp_servers" is not a table');
    return table;
  }
  const dialect = JSON_DIALECTS[format];
  const doc: unknown = JSON.parse(text);
  if (!isRecord(doc)) throw new Error('top level is not a JSON object');
  const table = doc[dialect.key];
  if (table === undefined) return dict<unknown>();
  if (!isRecord(table)) throw new Error(`"${dialect.key}" is not an object`);
  return table;
}

/** Parse a config file's text (null = file absent). Throws if it cannot be read safely. */
export function parseConfig(format: McpFormat, text: string | null): ParsedConfig {
  const table = mcpTable(format, text);
  const servers = dict<McpServer>();
  const names = new Set<string>();
  for (const name of safeKeys(table)) {
    names.add(name);
    const raw = table[name];
    const s =
      format === 'codex-toml'
        ? isRecord(raw)
          ? fromCodex(raw)
          : null
        : JSON_DIALECTS[format as Exclude<McpFormat, 'codex-toml'>].from(raw);
    if (s) servers[name] = s;
  }
  return { servers, names };
}

/** The servers of a config file's text. */
export function parseServers(format: McpFormat, text: string | null): McpServerMap {
  return parseConfig(format, text).servers;
}

/** Whether this dialect can express the server. */
function canExpress(format: McpFormat, s: McpServer): boolean {
  if (format === 'codex-toml' || format === 'antigravity-json') return s.transport !== 'sse';
  return true;
}

/**
 * Add servers to a config file's text and return the new text. A name already defined under the
 * MCP table (in any shape) is skipped; the new text is parsed again and every added server must
 * come back as intended, otherwise this throws and nothing should be written.
 */
export function addServers(format: McpFormat, text: string | null, add: McpServerMap): string {
  const before = parseConfig(format, text);
  const todo = dict<McpServer>();
  for (const n of safeKeys(add)) if (!before.names.has(n) && canExpress(format, add[n])) todo[n] = add[n];
  const names = Object.keys(todo);
  if (names.length === 0) return text ?? '';

  let out: string;
  if (format === 'codex-toml') {
    const base = text ?? '';
    const eol = base.includes('\r\n') ? '\r\n' : '\n';
    const sep =
      base.length === 0
        ? ''
        : base.endsWith('\n\n') || base.endsWith('\r\n\r\n')
          ? ''
          : base.endsWith('\n')
            ? eol
            : eol + eol;
    const blocks = names.map((n) => toCodexToml(n, todo[n]).replace(/\n/g, eol));
    out = base + sep + blocks.join(eol);
  } else {
    const dialect = JSON_DIALECTS[format];
    const doc: Record<string, unknown> =
      text && text.trim() ? (JSON.parse(text) as Record<string, unknown>) : { ...dialect.seed };
    const existing = doc[dialect.key];
    const table: Record<string, unknown> = isRecord(existing) ? existing : {};
    for (const n of names) {
      const entry = dialect.to(todo[n]);
      if (entry) table[n] = entry;
    }
    doc[dialect.key] = table;
    out = JSON.stringify(doc, null, 2) + '\n';
  }

  // Re-read what we are about to write.
  const after = parseConfig(format, out);
  for (const n of before.names) {
    if (!after.names.has(n)) throw new Error(`refusing to write: "${n}" would be lost`);
  }
  for (const n of names) {
    const got = after.servers[n];
    if (!got || fullIdentity(got) !== fullIdentity(todo[n])) {
      throw new Error(`refusing to write: "${n}" does not read back as written`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write `text` over `file`, keeping the old content as `<file>.codeman-bak`. Follows a symlink
 * to the real file so a symlinked dotfile stays a symlink. When `secret` is set the result is
 * readable by its owner only.
 */
async function writeAtomic(file: string, text: string, secret: boolean): Promise<void> {
  let target = file;
  try {
    if ((await fs.lstat(file)).isSymbolicLink()) target = await fs.realpath(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // ENOENT from realpath on a dangling link, or lstat on a missing file: tell them apart.
    try {
      await fs.lstat(file);
      throw new Error('config path is a dangling symlink');
    } catch (inner) {
      if ((inner as NodeJS.ErrnoException).code !== 'ENOENT') throw inner;
    }
  }

  let mode = 0o600;
  try {
    mode = (await fs.stat(target)).mode & 0o777;
    await fs.copyFile(target, `${target}.codeman-bak`);
    await fs.chmod(`${target}.codeman-bak`, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (secret) mode &= ~0o077;

  await fs.mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.codeman-tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
  try {
    await fs.writeFile(tmp, text, { mode });
    // writeFile's mode is masked by the umask; the mode we computed is the one we mean.
    await fs.chmod(tmp, mode);
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export interface McpSyncOptions {
  /** false = report what would change without writing. */
  apply: boolean;
  home?: string;
}

let applying = false;

/**
 * Sync across `targets` (already filtered to enabled CLIs with an `mcpConfig`, in priority
 * order: when two CLIs define a name differently, the first one's definition is the one copied).
 * Throws `McpSyncBusyError` if another apply is running.
 */
export async function syncMcpServers(
  targets: McpSyncTarget[],
  opts: McpSyncOptions,
  unsupported: string[] = []
): Promise<McpSyncResult> {
  if (opts.apply) {
    if (applying) throw new McpSyncBusyError();
    applying = true;
  }
  try {
    return await run(targets, opts, unsupported);
  } finally {
    if (opts.apply) applying = false;
  }
}

async function run(targets: McpSyncTarget[], opts: McpSyncOptions, unsupported: string[]): Promise<McpSyncResult> {
  const home = opts.home ?? homedir();
  const seen = new Set<string>();
  const live = targets.filter((t) => (seen.has(t.path) ? false : (seen.add(t.path), true)));

  const state = live.map((t) => {
    const file = join(home, t.path);
    const res: McpSyncTargetResult = {
      id: t.id,
      label: t.label,
      file,
      status: 'ok',
      servers: [],
      added: [],
      skipped: [],
    };
    return { t, file, res, servers: dict<McpServer>(), names: new Set<string>() };
  });

  for (const s of state) {
    try {
      if (!s.t.installed && !(await exists(s.file))) {
        s.res.status = 'absent';
        continue;
      }
      const parsed = parseConfig(s.t.format, await readText(s.file));
      s.servers = parsed.servers;
      s.names = parsed.names;
      s.res.servers = [...parsed.names];
    } catch (err) {
      s.res.status = 'unreadable';
      s.res.error = err instanceof Error ? err.message : String(err);
    }
  }

  // Union, first enabled definition wins; a later, different definition of the same name is a conflict.
  const union = dict<McpServer>();
  const conflicts = new Set<string>();
  const switchedOff = new Set<string>();
  for (const s of state) {
    if (s.res.status !== 'ok') continue;
    for (const name of Object.keys(s.servers)) {
      const def = s.servers[name];
      if (def.disabled) {
        switchedOff.add(name);
        continue;
      }
      if (!(name in union)) union[name] = def;
      else if (fingerprint(union[name]) !== fingerprint(def)) conflicts.add(name);
    }
  }
  const disabled = [...switchedOff].filter((n) => !(n in union)).sort();

  for (const s of state) {
    if (s.res.status !== 'ok') continue;
    const add = dict<McpServer>();
    for (const name of Object.keys(union)) {
      if (s.names.has(name)) continue;
      if (canExpress(s.t.format, union[name])) add[name] = union[name];
      else s.res.skipped.push(name);
    }
    s.res.added = Object.keys(add);
    if (!opts.apply || s.res.added.length === 0) continue;
    try {
      // Re-read right before writing: claude rewrites ~/.claude.json constantly.
      const fresh = await readText(s.file);
      const out = addServers(s.t.format, fresh, add);
      const current = parseConfig(s.t.format, fresh);
      const written = Object.keys(add).filter((n) => !current.names.has(n));
      if (written.length === 0) {
        s.res.added = [];
        continue;
      }
      const subset = dict<McpServer>();
      for (const n of written) subset[n] = add[n];
      await writeAtomic(s.file, out, carriesSecrets(subset));
      s.res.added = written;
    } catch (err) {
      s.res.status = 'failed';
      s.res.error = err instanceof Error ? err.message : String(err);
      s.res.added = [];
    }
  }

  return {
    applied: opts.apply,
    targets: state.map((s) => s.res),
    conflicts: [...conflicts].sort(),
    disabled,
    unsupported,
  };
}
