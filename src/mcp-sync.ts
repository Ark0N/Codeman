/**
 * @fileoverview MCP server sync between the enabled agent CLIs.
 *
 * Each CLI keeps its own user-level MCP list in its own dialect (`CliEntry.capabilities.mcpConfig`
 * names the file and the dialect). This module reads every enabled CLI's list into one neutral
 * shape, and adds any server a CLI is missing from the others.
 *
 * Deliberately conservative:
 *   - ADDITIVE only. A server already present under a name is never rewritten and nothing is
 *     ever removed, so a sync cannot lose a hand-tuned entry. Same name with a different
 *     definition is reported as a conflict and left alone.
 *   - A file that does not parse (e.g. opencode JSONC with comments) is never written.
 *   - Only the MCP table is touched; every other key in the file is preserved. JSON files are
 *     re-read immediately before the write, and written via tmp+rename with the old file kept
 *     as `<file>.codeman-bak`.
 *   - Servers a dialect cannot express (SSE for codex) are skipped and reported.
 *
 * The result types never carry env values or headers: those commonly hold secrets and the
 * result is returned over HTTP.
 *
 * @module mcp-sync
 */

import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export type McpFormat = 'claude-json' | 'gemini-json' | 'codex-toml' | 'opencode-json';

export interface McpServer {
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

export type McpServerMap = Record<string, McpServer>;

export interface McpSyncTarget {
  id: string;
  label: string;
  path: string;
  format: McpFormat;
}

export interface McpSyncTargetResult {
  id: string;
  label: string;
  file: string;
  status: 'ok' | 'unreadable';
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
  /** Names defined differently by different CLIs; left untouched. */
  conflicts: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function strMap(v: unknown): Record<string, string> | undefined {
  if (!isRecord(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) if (typeof val === 'string') out[k] = val;
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
  return out;
}

/** Identity for conflict detection: what the server runs/connects to, not how it is spelled. */
function fingerprint(s: McpServer): string {
  const t = s.transport === 'stdio' ? 'stdio' : 'url';
  return JSON.stringify([t, s.command ?? null, s.args ?? [], s.url ?? null]);
}

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
  if (typeof raw.httpUrl === 'string')
    return clean({ transport: 'http', url: raw.httpUrl, headers: strMap(raw.headers) });
  if (typeof raw.url === 'string') return clean({ transport: 'sse', url: raw.url, headers: strMap(raw.headers) });
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
  return { [s.transport === 'http' ? 'httpUrl' : 'url']: s.url, ...(s.headers ? { headers: s.headers } : {}) };
}

function fromOpencode(raw: unknown): McpServer | null {
  if (!isRecord(raw)) return null;
  if (raw.type === 'remote' && typeof raw.url === 'string') {
    return clean({ transport: 'http', url: raw.url, headers: strMap(raw.headers) });
  }
  if (raw.type === 'local') {
    const cmd = strArr(raw.command);
    if (!cmd?.length) return null;
    return clean({ transport: 'stdio', command: cmd[0], args: cmd.slice(1), env: strMap(raw.environment) });
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

const JSON_DIALECTS: Record<'claude-json' | 'gemini-json' | 'opencode-json', JsonDialect> = {
  'claude-json': { key: 'mcpServers', from: fromClaude, to: toClaude },
  'gemini-json': { key: 'mcpServers', from: fromGemini, to: toGemini },
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

type TomlValue = string | string[] | Record<string, string> | boolean | number | null;

/** Parse one TOML value starting at `i`; returns the value and the index after it. */
function parseTomlValue(src: string, start: number): [TomlValue, number] {
  let i = start;
  const ws = () => {
    while (i < src.length && /[ \t\r\n]/.test(src[i])) i++;
  };
  ws();
  const c = src[i];
  if (c === '"') {
    if (src.startsWith('"""', i)) {
      const end = src.indexOf('"""', i + 3);
      return [src.slice(i + 3, end < 0 ? src.length : end).replace(/^\n/, ''), end < 0 ? src.length : end + 3];
    }
    let out = '';
    i++;
    while (i < src.length && src[i] !== '"') {
      if (src[i] === '\\') {
        const n = src[i + 1];
        const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };
        if (n === 'u') {
          out += String.fromCodePoint(parseInt(src.slice(i + 2, i + 6), 16));
          i += 6;
          continue;
        }
        out += map[n] ?? n;
        i += 2;
      } else out += src[i++];
    }
    return [out, i + 1];
  }
  if (c === "'") {
    const end = src.indexOf("'", i + 1);
    return [src.slice(i + 1, end < 0 ? src.length : end), end < 0 ? src.length : end + 1];
  }
  if (c === '[') {
    const arr: string[] = [];
    i++;
    for (;;) {
      ws();
      if (src[i] === '#') {
        while (i < src.length && src[i] !== '\n') i++;
        continue;
      }
      if (src[i] === ']' || i >= src.length) return [arr, i + 1];
      if (src[i] === ',') {
        i++;
        continue;
      }
      const [v, next] = parseTomlValue(src, i);
      if (typeof v === 'string') arr.push(v);
      i = next;
    }
  }
  if (c === '{') {
    const obj: Record<string, string> = {};
    i++;
    for (;;) {
      ws();
      if (src[i] === '}' || i >= src.length) return [obj, i + 1];
      if (src[i] === ',') {
        i++;
        continue;
      }
      const [k, afterKey] = parseTomlKey(src, i);
      i = afterKey;
      ws();
      if (src[i] === '=') i++;
      const [v, next] = parseTomlValue(src, i);
      if (typeof v === 'string') obj[k] = v;
      i = next;
    }
  }
  const m = /^[^\s,\]}#]+/.exec(src.slice(i));
  const tok = m ? m[0] : '';
  const after = i + tok.length;
  if (tok === 'true') return [true, after];
  if (tok === 'false') return [false, after];
  const num = Number(tok);
  return [Number.isNaN(num) ? null : num, Math.max(after, i + 1)];
}

function parseTomlKey(src: string, start: number): [string, number] {
  let i = start;
  while (src[i] === ' ' || src[i] === '\t') i++;
  if (src[i] === '"' || src[i] === "'") {
    const [v, next] = parseTomlValue(src, i);
    return [String(v), next];
  }
  const m = /^[A-Za-z0-9_-]+/.exec(src.slice(i));
  const key = m ? m[0] : '';
  return [key, i + Math.max(key.length, 1)];
}

/** Split a table header like `mcp_servers."my.srv".env` into dotted key parts. */
function parseTomlHeader(line: string): string[] | null {
  const m = /^\[([^\]\[].*)\]\s*(#.*)?$/.exec(line.trim());
  if (!m) return null;
  const body = m[1];
  const parts: string[] = [];
  let i = 0;
  while (i < body.length) {
    while (body[i] === ' ') i++;
    const [k, next] = parseTomlKey(body, i);
    if (!k) return null;
    parts.push(k);
    i = next;
    while (body[i] === ' ') i++;
    if (body[i] === '.') i++;
    else if (i < body.length) return null;
  }
  return parts;
}

/** Returns each `mcp_servers.<name>` table as `{ ...keys, env?: {...}, http_headers?: {...} }`. */
function parseCodexTables(text: string): Record<string, Record<string, TomlValue>> {
  const out: Record<string, Record<string, TomlValue>> = {};
  let current: Record<string, TomlValue> | null = null;
  let sub: string | null = null;
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('[')) {
      current = null;
      sub = null;
      if (trimmed.startsWith('[[')) continue;
      const parts = parseTomlHeader(trimmed);
      if (parts && parts[0] === 'mcp_servers' && (parts.length === 2 || parts.length === 3)) {
        current = out[parts[1]] ??= {};
        sub = parts.length === 3 ? parts[2] : null;
        if (sub && !isRecord(current[sub])) current[sub] = {};
      }
      continue;
    }
    if (!current) continue;
    // key = value; a value may span lines (arrays), so feed the parser the remainder of the file.
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const offset = lines.slice(0, n).reduce((a, l) => a + l.length + 1, 0);
    const [key, afterKey] = parseTomlKey(text, offset + (line.length - line.trimStart().length));
    const valueStart = text.indexOf('=', afterKey) + 1;
    const [value, end] = parseTomlValue(text, valueStart);
    // Skip the lines the value consumed.
    const consumed = text.slice(valueStart, end).split('\n').length - 1;
    n += consumed;
    if (sub) (current[sub] as Record<string, string>)[key] = typeof value === 'string' ? value : '';
    else current[key] = value;
  }
  return out;
}

function fromCodex(t: Record<string, TomlValue>): McpServer | null {
  if (typeof t.url === 'string') {
    const headers = strMap(t.http_headers);
    return clean({ transport: 'http', url: t.url, headers });
  }
  if (typeof t.command === 'string') {
    return clean({ transport: 'stdio', command: t.command, args: strArr(t.args), env: strMap(t.env) });
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

/** Parse a config file's text (null = file absent) into servers. Throws if it cannot be read safely. */
export function parseServers(format: McpFormat, text: string | null): McpServerMap {
  const out: McpServerMap = {};
  if (text === null || !text.trim()) return out;
  if (format === 'codex-toml') {
    for (const [name, table] of Object.entries(parseCodexTables(text))) {
      const s = fromCodex(table);
      if (s) out[name] = s;
    }
    return out;
  }
  const dialect = JSON_DIALECTS[format];
  const doc: unknown = JSON.parse(text);
  if (!isRecord(doc)) throw new Error('top level is not a JSON object');
  const table = doc[dialect.key];
  if (table === undefined) return out;
  if (!isRecord(table)) throw new Error(`"${dialect.key}" is not an object`);
  for (const [name, raw] of Object.entries(table)) {
    const s = dialect.from(raw);
    if (s) out[name] = s;
  }
  return out;
}

/** Whether this dialect can express the server. */
export function canExpress(format: McpFormat, s: McpServer): boolean {
  if (format === 'codex-toml') return s.transport !== 'sse';
  return true;
}

/** Add servers to a config file's text and return the new text. Existing names are never touched. */
export function addServers(format: McpFormat, text: string | null, add: McpServerMap): string {
  const names = Object.keys(add);
  if (format === 'codex-toml') {
    const base = text ?? '';
    const sep = base.length === 0 ? '' : base.endsWith('\n\n') ? '' : base.endsWith('\n') ? '\n' : '\n\n';
    return base + sep + names.map((n) => toCodexToml(n, add[n])).join('\n');
  }
  const dialect = JSON_DIALECTS[format];
  const doc: Record<string, unknown> =
    text && text.trim() ? (JSON.parse(text) as Record<string, unknown>) : { ...dialect.seed };
  const existing = doc[dialect.key];
  const table: Record<string, unknown> = isRecord(existing) ? existing : {};
  for (const n of names) {
    if (n in table) continue;
    const entry = dialect.to(add[n]);
    if (entry) table[n] = entry;
  }
  doc[dialect.key] = table;
  return JSON.stringify(doc, null, 2) + '\n';
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

async function writeAtomic(file: string, text: string): Promise<void> {
  let mode = 0o600;
  try {
    mode = (await fs.stat(file)).mode & 0o777;
    await fs.copyFile(file, `${file}.codeman-bak`);
    await fs.chmod(`${file}.codeman-bak`, 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.codeman-tmp-${process.pid}`;
  await fs.writeFile(tmp, text, { mode });
  await fs.rename(tmp, file);
}

export interface McpSyncOptions {
  /** false = report what would change without writing. */
  apply: boolean;
  home?: string;
}

/**
 * Sync across `targets` (already filtered to enabled CLIs with an `mcpConfig`, in priority
 * order: when two CLIs define a name differently, the first one's definition is the one copied).
 */
export async function syncMcpServers(targets: McpSyncTarget[], opts: McpSyncOptions): Promise<McpSyncResult> {
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
    return { t, file, res, servers: {} as McpServerMap };
  });

  for (const s of state) {
    try {
      s.servers = parseServers(s.t.format, await readText(s.file));
      s.res.servers = Object.keys(s.servers);
    } catch (err) {
      s.res.status = 'unreadable';
      s.res.error = err instanceof Error ? err.message : String(err);
    }
  }

  // Union, first definition wins; a later, different definition of the same name is a conflict.
  const union: McpServerMap = {};
  const conflicts = new Set<string>();
  for (const s of state) {
    if (s.res.status !== 'ok') continue;
    for (const [name, def] of Object.entries(s.servers)) {
      if (!(name in union)) union[name] = def;
      else if (fingerprint(union[name]) !== fingerprint(def)) conflicts.add(name);
    }
  }

  for (const s of state) {
    if (s.res.status !== 'ok') continue;
    const add: McpServerMap = {};
    for (const [name, def] of Object.entries(union)) {
      if (name in s.servers) continue;
      if (canExpress(s.t.format, def)) add[name] = def;
      else s.res.skipped.push(name);
    }
    s.res.added = Object.keys(add);
    if (!opts.apply || s.res.added.length === 0) continue;
    try {
      // Re-read right before writing: claude rewrites ~/.claude.json constantly.
      const fresh = await readText(s.file);
      const stillMissing: McpServerMap = {};
      const current = parseServers(s.t.format, fresh);
      for (const [n, d] of Object.entries(add)) if (!(n in current)) stillMissing[n] = d;
      if (Object.keys(stillMissing).length === 0) {
        s.res.added = [];
        continue;
      }
      await writeAtomic(s.file, addServers(s.t.format, fresh, stillMissing));
      s.res.added = Object.keys(stillMissing);
    } catch (err) {
      s.res.status = 'unreadable';
      s.res.error = err instanceof Error ? err.message : String(err);
      s.res.added = [];
    }
  }

  return { applied: opts.apply, targets: state.map((s) => s.res), conflicts: [...conflicts].sort() };
}
