/**
 * @fileoverview Two-way Discord bridge: one thread per tab, alerts out, replies typed back in.
 *
 * Split like webhook-notify.ts, so the parts that matter are testable without a network:
 *   - pure: `sanitiseReply`, `threadNameFor`, `buildPost`, `discordConfigProblem`, `maskToken`
 *   - store: `~/.codeman/discord.json` (bot token, 0600 via tmp+rename) and
 *     `~/.codeman/discord-bridge.json` (sessionId -> threadId, not secret)
 *   - IO: `DiscordApi` (REST, injected fetch), `DiscordGateway` (inbound WebSocket, injected
 *     socket factory) and `DiscordBridge` (the rules that tie them to sessions)
 *
 * Rules the code keeps and the tests pin:
 *   - The bot token lives only in `discord.json`; it is never returned, logged, or put in an error.
 *   - Only messages from `allowedUserIds`, in `guildId`, inside a thread this bridge created, are
 *     acted on. Everything else is dropped without being read further.
 *   - A reply becomes one printable line plus Enter. Embedded newlines would submit early. A lone digit
 *     while a permission or question is pending goes as the key alone (see onGatewayMessage).
 *   - Posts never ping unless `pingMode` says so, and then only the allowlisted user ids.
 *   - A Discord outage or a bad token never reaches a session: every IO path catches and backs off.
 *
 * @module discord-bridge
 */

import { existsSync, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { probePathKind } from './utils/bounded-path-probe.js';
import WebSocket from 'ws';
import { WEBHOOK_SCOPES, type WebhookUrgency } from './types/push.js';
import {
  DISCORD_ON_DELETE,
  DISCORD_PING_MODES,
  DISCORD_THREAD_CREATION,
  type DiscordConfig,
  type DiscordGatewayState,
  type DiscordPingMode,
  type DiscordResult,
} from './types/discord.js';

const CONFIG_FILE = 'discord.json';
const THREADS_FILE = 'discord-bridge.json';
const API = 'https://discord.com/api/v10';
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const SEND_TIMEOUT_MS = 8000;
const MAX_CONTENT = 1900;
const MAX_THREAD_NAME = 100;
/** Longest reply typed into a session; Discord allows 2000, a CLI prompt rarely needs more than this. */
export const MAX_REPLY_CHARS = 1000;
const REPLY_MIN_INTERVAL_MS = 1000;
const DEDUPE_WINDOW_MS = 3000;
/** GUILDS | GUILD_MESSAGES | MESSAGE_CONTENT (privileged, switched on in the Developer Portal). */
const GATEWAY_INTENTS = (1 << 0) | (1 << 9) | (1 << 15);
/** Gateway close codes that retrying cannot fix: bad token, bad intents, bad shard. */
const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const SNOWFLAKE = /^\d{15,25}$/;
/** Stale-thread sweep: a thread younger than this may still be between creation and its map entry. */
const STALE_MIN_AGE_MS = 60 * 60 * 1000;
const STALE_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** At most this many threads closed in one sweep, so a damaged map cannot empty the channel in one go. */
const STALE_MAX_PER_SWEEP = 25;
const DISCORD_EPOCH_MS = 1420070400000;
/** A Markdown table wider or longer than this is posted as it was written, not padded into a code block. */
const TABLE_MAX_COLS = 24;
const TABLE_MAX_ROWS = 200;
/** Reading a CLI's transcript must not hold an alert back for long. */
const FULL_TEXT_TIMEOUT_MS = 4000;

export const DEFAULT_DISCORD_CONFIG: DiscordConfig = {
  enabled: false,
  token: '',
  guildId: '',
  parentChannelId: '',
  allowedUserIds: [],
  threadCreation: 'lazy',
  onSessionDelete: 'archive',
  staleThreads: 'keep',
  pingMode: 'critical',
  scope: 'attention',
  startupHint: true,
  typedHint: false,
};

export interface DiscordMessage {
  event: string;
  title: string;
  body: string;
  urgency: WebhookUrgency;
  sessionId?: string;
  sessionName?: string;
  /** The tail of what the CLI last printed, so the reader can see what it is asking. */
  tail?: string | (() => string);
  /**
   * The CLI's whole last message, read from its transcript. When it yields text the post carries that
   * (split over as many posts as it needs, markdown kept) instead of the screen tail.
   */
  fullText?: () => Promise<{ text: string; version?: string } | undefined>;
  host?: string;
  /** A file to upload with the post (already read and size-checked by the caller). */
  file?: DiscordFile;
}

export interface DiscordFile {
  name: string;
  data: Uint8Array;
}

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

/** Why `cfg` cannot be saved as an enabled config, or null. */
export function discordConfigProblem(cfg: DiscordConfig): string | null {
  if (cfg.token && (/\s/.test(cfg.token) || cfg.token.length > 200)) return 'The bot token looks wrong';
  if (cfg.guildId && !SNOWFLAKE.test(cfg.guildId)) return 'Guild ID must be a number (Copy ID in Discord)';
  if (cfg.parentChannelId && !SNOWFLAKE.test(cfg.parentChannelId)) return 'Channel ID must be a number';
  if (cfg.allowedUserIds.some((id) => !SNOWFLAKE.test(id))) return 'Each allowed user ID must be a number';
  if (cfg.allowedUserIds.length > 20) return 'At most 20 allowed user IDs';
  if (cfg.enabled) {
    if (!cfg.token) return 'Add the bot token before enabling';
    if (!cfg.guildId || !cfg.parentChannelId) return 'Add the guild ID and parent channel ID before enabling';
    if (cfg.allowedUserIds.length === 0) return 'Add at least one allowed user ID: nobody could reply otherwise';
  }
  return null;
}

/** First four and last two characters, so the user can tell which token is saved. */
export function maskToken(token: string): string {
  return token.length > 12 ? `${token.slice(0, 4)}•••${token.slice(-2)}` : token ? '•••' : '';
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * A Discord reply as one printable line plus Enter, or null when nothing printable is left. The caller
 * drops the Enter for a lone digit answering a pending dialog.
 */
export function sanitiseReply(raw: string, files: string[] = []): string | null {
  // eslint-disable-next-line no-control-regex
  const line = raw.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  const trimmed = clip(line.trim(), MAX_REPLY_CHARS);
  // Paths are ours (a working folder plus a sanitised name), appended after the cap so they are never cut.
  const attached = files.length ? `${trimmed ? ' ' : ''}[attached: ${files.join(', ')}]` : '';
  // eslint-disable-next-line no-control-regex
  const out = `${trimmed}${attached}`.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  return out ? `${out}\r` : null;
}

export function threadNameFor(sessionName: string | undefined, sessionId: string): string {
  const name = (sessionName ?? '').replace(/[\r\n]+/g, ' ').trim();
  return clip(name || sessionId.slice(0, 8), MAX_THREAD_NAME);
}

/** Whether `urgency` earns a ping under `mode`. */
export function shouldPing(mode: DiscordPingMode, urgency: WebhookUrgency, explicitUrgent = false): boolean {
  if (mode === 'off') return false;
  return mode === 'all' || explicitUrgent || urgency === 'critical';
}

export function shouldSendDiscord(cfg: DiscordConfig, urgency: WebhookUrgency): boolean {
  if (!cfg.enabled || !cfg.token) return false;
  return cfg.scope === 'all' || urgency !== 'info';
}

/** Largest single file taken from Discord, or sent to it. Discord's own free limit is higher. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES_PER_REPLY = 5;
const DOWNLOAD_TIMEOUT_MS = 30_000;
/** Where a session's received files go, relative to its working folder. */
export const RECEIVED_DIR = '.codeman-discord';

/**
 * What a session is told about the bridge. Claude gets it as `--append-system-prompt`; every other
 * CLI is sent it once as its first message, only when `typedHint` is on (see DiscordBridge.sessionIdle). No apostrophes: it is
 * rendered into a shell command.
 */
export const DISCORD_STARTUP_HINT =
  'Codeman note: if you are blocked on something only the user can do (a physical step such as ' +
  'pressing a button, an answer you cannot work out, or a wait that timed out), run: ' +
  'codeman notify "message that leads with the action" --urgent (lead with the action). The user reads a Discord thread for ' +
  'this tab and their reply is typed to you as one line; a file they attach is saved and its path is ' +
  'given in that line. Add --file <path> to send a file from your working folder. Not for routine progress.';

let activeStartupHint: string | undefined;
/** The hint to launch Claude with, or undefined while the bridge or the setting is off. */
export function getDiscordStartupHint(): string | undefined {
  return activeStartupHint;
}

/**
 * The last lines of a rendered screen for a post: colour and charset codes removed, blank lines and
 * pure rule lines (box drawing, dashes) dropped, the last 14 lines, at most 900 characters, cut on a line.
 * With `composerGlyph` (the CLI's own prompt mark), the composer row and everything under it (the status
 * and mode hints) is cut first, but only within the last 8 rows and never a dialog's selected option
 * (`❯ 1. Yes`), so a question's choices stay.
 */
export function screenTail(screen: string, maxLines = 14, maxChars = 900, composerGlyph?: string): string {
  let lines = screen
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b[()][A-Za-z0-9]|\u001b[@-Z\\-_]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '' && !/^[\s\-_=\u2500-\u257f]+$/.test(l));
  if (composerGlyph) {
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 8); i--) {
      const row = lines[i].trimStart();
      if (row.startsWith(composerGlyph) && !/^\S+\s+\d+[.)]/.test(row)) {
        lines = lines.slice(0, i);
        break;
      }
    }
  }
  let out = lines.slice(-maxLines);
  while (out.length > 1 && out.join('\n').length > maxChars) out = out.slice(1);
  return out.join('\n').slice(-maxChars);
}

/**
 * Discord does not render Markdown tables: a `| a | b |` block shows as raw pipes. Each table outside a
 * code fence becomes a code block with the columns padded to their widest cell (right-aligned where the
 * separator row says `---:`), which a monospace font lines up. Bold and code marks inside a cell are
 * dropped, since a code block would show them literally.
 */
export function tablesToCodeBlocks(text: string): string {
  const cells = (row: string): string[] => {
    let r = row.trim();
    if (r.startsWith('|')) r = r.slice(1);
    if (r.endsWith('|') && !r.endsWith('\\|')) r = r.slice(0, -1);
    return r.split(/(?<!\\)\|/).map((c) =>
      c
        .replace(/\\\|/g, '|')
        .replace(/\*\*|`/g, '')
        .trim()
    );
  };
  // Whitespace stripped first, so the pattern has none to backtrack over (a run of spaces made the old one quadratic).
  const isSeparator = (row: string) => {
    const r = row.replace(/\s+/g, '');
    return r.includes('|') && /^\|?:?-+:?(\|:?-+:?)*\|?$/.test(r);
  };
  const lines = text.split('\n');
  const out: string[] = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) fence = !fence;
    if (fence || !line.includes('|') || i + 1 >= lines.length || !isSeparator(lines[i + 1])) {
      out.push(line);
      continue;
    }
    // Rows belong to the table while they carry a pipe, and start with one when the header does, so a
    // sentence with a pipe under a table stays prose.
    const piped = line.trim().startsWith('|');
    let j = i + 2;
    while (
      j < lines.length &&
      lines[j].trim() !== '' &&
      lines[j].includes('|') &&
      (!piped || lines[j].trim().startsWith('|'))
    ) {
      j++;
    }
    const header = cells(line);
    // A table past these bounds is left as it was (raw pipes): formatting costs columns times rows, and the
    // text can be steered by whatever the agent read.
    if (header.length > TABLE_MAX_COLS || j - i - 1 > TABLE_MAX_ROWS) {
      for (let k = i; k < j; k++) out.push(lines[k]); // a loop: a spread of 200,000 lines overflows the stack
      i = j - 1;
      continue;
    }
    const align = cells(lines[i + 1]).map((c) => (c.endsWith(':') ? 'right' : 'left'));
    const rows = [header];
    for (let k = i + 2; k < j; k++) rows.push(cells(lines[k]));
    let cols = 0;
    for (const r of rows) if (r.length > cols) cols = r.length;
    if (cols > TABLE_MAX_COLS) {
      for (let k = i; k < j; k++) out.push(lines[k]); // a loop: a spread of 200,000 lines overflows the stack
      i = j - 1;
      continue;
    }
    const width = Array.from({ length: cols }, () => 1);
    for (const r of rows) for (let c = 0; c < r.length; c++) width[c] = Math.max(width[c], [...r[c]].length);
    const pad = (v: string, c: number) => (align[c] === 'right' ? v.padStart(width[c]) : v.padEnd(width[c]));
    const fmt = (r: string[]) =>
      Array.from({ length: cols }, (_, c) => pad((r[c] ?? '').replace(/```/g, '\u2019\u2019\u2019'), c))
        .join('  ')
        .trimEnd();
    out.push('```', fmt(header), width.map((w) => '-'.repeat(w)).join('  '), ...rows.slice(1).map(fmt), '```');
    i = j - 1;
  }
  return out.join('\n');
}

/**
 * Split a long message into posts of at most `max` characters, on blank lines first, then lines, then
 * (for one huge line) by length. A code fence the cut lands inside is closed and reopened, so each post
 * renders on its own. At most `maxPosts`; the last carries a note when text is left over.
 */
export function splitForDiscord(text: string, max = 1900, maxPosts = 8): string[] {
  const posts: string[] = [];
  let cur = '';
  let fence = false;
  let cut = false;
  const flush = () => {
    if (cur.trim()) posts.push(fence ? `${cur.trimEnd()}\n\`\`\`` : cur.trimEnd());
    cur = fence ? '```\n' : '';
  };
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let line of lines) {
    if (posts.length >= maxPosts) {
      cut = true;
      break;
    }
    while (line.length > max - 8) {
      if (cur.trim()) flush();
      cur += line.slice(0, max - 8) + '\n';
      line = line.slice(max - 8);
      flush();
      if (posts.length >= maxPosts) {
        cut = true;
        break;
      }
    }
    if (cut) break;
    if (cur.length + line.length + 1 > max - 8) flush();
    cur += `${line}\n`;
    if (/^\s*```/.test(line)) fence = !fence;
  }
  if (!cut && cur.trim()) posts.push(cur.trimEnd());
  if (cut && posts.length > 0) posts[posts.length - 1] += '\n*(The message continues in the tab.)*';
  return posts.slice(0, maxPosts);
}

/** Final path segment only, `[A-Za-z0-9._-]`, no leading dot, at most 80 characters. */
export function safeAttachmentName(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '');
  return clip(base, 80) || 'file';
}

/** Discord's own CDN over https: the only place an attachment URL may point. */
export function isDiscordCdnUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && /(^|\.)(discordapp\.com|discordapp\.net|discord\.com)$/.test(u.hostname);
  } catch {
    return false;
  }
}

export interface DiscordPost {
  content: string;
  allowed_mentions: { parse: string[]; users: string[] };
}

export function buildPost(msg: DiscordMessage, cfg: DiscordConfig, explicitUrgent = false): DiscordPost {
  const ping = shouldPing(cfg.pingMode, msg.urgency, explicitUrgent) ? cfg.allowedUserIds : [];
  const mentions = ping.map((id) => `<@${id}>`).join(' ');
  const head = `${mentions ? `${mentions} ` : ''}**${clip(msg.title, 120)}**`;
  // Built here, not by the caller, so the screen is only read for a post that is really going out.
  let tailText: string | undefined;
  try {
    tailText = typeof msg.tail === 'function' ? msg.tail() : msg.tail;
  } catch {
    tailText = undefined;
  }
  const fence = tailText?.trim() ? `\n\`\`\`\n${tailText.trim().replace(/```/g, "'''")}\n\`\`\`` : '';
  const host = msg.host ? ` (${clip(msg.host, 60)})` : '';
  const content = clip(`${head}${host}${msg.body ? `\n${msg.body}` : ''}${fence}`, MAX_CONTENT);
  // Agent output and session names must not be able to @everyone the server; only the allowlisted ids ping.
  return { content, allowed_mentions: { parse: [], users: ping } };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function discordConfigPath(configDir: string): string {
  return join(configDir, CONFIG_FILE);
}

const oneOf = <T extends string>(list: readonly T[], v: unknown, fallback: T): T =>
  (list as readonly unknown[]).includes(v) ? (v as T) : fallback;

function coerce(raw: unknown): DiscordConfig {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_DISCORD_CONFIG;
  return {
    enabled: r.enabled === true,
    token: typeof r.token === 'string' ? r.token : '',
    guildId: typeof r.guildId === 'string' ? r.guildId : '',
    parentChannelId: typeof r.parentChannelId === 'string' ? r.parentChannelId : '',
    allowedUserIds: Array.isArray(r.allowedUserIds)
      ? r.allowedUserIds.filter((x): x is string => typeof x === 'string')
      : [],
    threadCreation: oneOf(DISCORD_THREAD_CREATION, r.threadCreation, d.threadCreation),
    onSessionDelete: oneOf(DISCORD_ON_DELETE, r.onSessionDelete, d.onSessionDelete),
    staleThreads: oneOf(DISCORD_ON_DELETE, r.staleThreads, d.staleThreads),
    pingMode: oneOf(DISCORD_PING_MODES, r.pingMode, d.pingMode),
    scope: oneOf(WEBHOOK_SCOPES, r.scope, d.scope),
    startupHint: r.startupHint === undefined ? d.startupHint : r.startupHint === true,
    typedHint: r.typedHint === true,
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** A failure with a reason worth showing as it is (unlike a network error, whose text is not). */
class BridgeProblem extends Error {}

export async function readDiscordConfig(configDir: string): Promise<DiscordConfig> {
  try {
    return coerce(JSON.parse(await fs.readFile(discordConfigPath(configDir), 'utf-8')));
  } catch {
    return { ...DEFAULT_DISCORD_CONFIG };
  }
}

async function writePrivate(target: string, data: unknown, mode: number): Promise<void> {
  // A unique name: two writes at once (two admin tabs) must not share one tmp file.
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data, null, 2), { mode });
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

/** 0600 via tmp+rename: `mode` on writeFile only applies to a file being created. */
export async function writeDiscordConfig(configDir: string, cfg: DiscordConfig): Promise<void> {
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  await writePrivate(discordConfigPath(configDir), coerce(cfg), 0o600);
}

/** The thread map plus the parent channel it was built under. */
async function readThreadFile(configDir: string): Promise<{ parent: string; threads: Record<string, string> }> {
  try {
    const raw = JSON.parse(await fs.readFile(join(configDir, THREADS_FILE), 'utf-8')) as Record<string, unknown>;
    const threads: Record<string, string> = {};
    const saved = typeof raw.threads === 'object' && raw.threads !== null ? raw.threads : {};
    for (const [k, v] of Object.entries(saved)) if (typeof v === 'string' && SNOWFLAKE.test(v)) threads[k] = v;
    return { parent: typeof raw.parentChannelId === 'string' ? raw.parentChannelId : '', threads };
  } catch {
    return { parent: '', threads: {} };
  }
}

export async function readThreadMap(configDir: string): Promise<Record<string, string>> {
  return (await readThreadFile(configDir)).threads;
}

async function writeThreadMap(
  configDir: string,
  parentChannelId: string,
  threads: Record<string, string>
): Promise<void> {
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  await writePrivate(join(configDir, THREADS_FILE), { parentChannelId, threads }, 0o600);
}

// ---------------------------------------------------------------------------
// IO: REST
// ---------------------------------------------------------------------------

export interface DiscordThreadInfo {
  id: string;
  parent_id?: string;
  owner_id?: string;
  thread_metadata?: { archived?: boolean };
}

export type DiscordFetch = (target: URL, init: RequestInit) => Promise<Response>;

export class DiscordHttpError extends Error {
  constructor(
    readonly status: number,
    /** Discord's own error code (10003 unknown channel, 50001 missing access ...). */
    readonly code?: number
  ) {
    super(`Discord HTTP ${status}${code ? ` (code ${code})` : ''}`);
  }
}

/** Thin REST client. The token goes only in the Authorization header and never into a message. */
export class DiscordApi {
  constructor(
    private readonly token: () => string,
    private readonly fetchImpl: DiscordFetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))
  ) {}

  async request<T = unknown>(method: string, path: string, body?: unknown, retried = false): Promise<T | null> {
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    const res = await this.fetchImpl(new URL(`${API}${path}`), {
      method,
      headers: {
        Authorization: `Bot ${this.token()}`,
        // A form body sets its own multipart Content-Type (with the boundary).
        ...(isForm ? {} : { 'Content-Type': 'application/json' }),
        'User-Agent': 'DiscordBot (https://github.com/Ark0N/Codeman, 1)',
      },
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (res.status === 429 && !retried) {
      const j = (await res.json().catch(() => ({}))) as { retry_after?: number };
      await this.sleep(Math.min(Math.max((j.retry_after ?? 1) * 1000, 100), 10_000));
      return this.request<T>(method, path, body, true);
    }
    if (!res.ok) {
      const j = (await res.json().catch(() => ({}))) as { code?: number };
      throw new DiscordHttpError(res.status, j.code);
    }
    if (res.status === 204) return null;
    return (await res.json().catch(() => null)) as T | null;
  }

  createThread(parentId: string, name: string): Promise<{ id: string } | null> {
    // type 11 = public thread. A week of inactivity before Discord archives it.
    return this.request('POST', `/channels/${parentId}/threads`, { name, type: 11, auto_archive_duration: 10080 });
  }
  post(channelId: string, p: DiscordPost): Promise<{ id: string } | null> {
    return this.request('POST', `/channels/${channelId}/messages`, p);
  }
  postWithFile(channelId: string, p: DiscordPost, file: DiscordFile): Promise<{ id: string } | null> {
    const form = new FormData();
    form.append('payload_json', JSON.stringify(p));
    form.append('files[0]', new Blob([Buffer.from(file.data)]), safeAttachmentName(file.name));
    return this.request('POST', `/channels/${channelId}/messages`, form);
  }
  rename(threadId: string, name: string): Promise<unknown> {
    return this.request('PATCH', `/channels/${threadId}`, { name });
  }
  archive(threadId: string): Promise<unknown> {
    return this.request('PATCH', `/channels/${threadId}`, { archived: true });
  }
  remove(threadId: string): Promise<unknown> {
    return this.request('DELETE', `/channels/${threadId}`);
  }
  botUserId(): Promise<{ id: string } | null> {
    return this.request('GET', '/users/@me');
  }
  /** Active threads of the guild (all channels: the caller filters by parent). */
  activeThreads(guildId: string): Promise<{ threads: DiscordThreadInfo[] } | null> {
    return this.request('GET', `/guilds/${guildId}/threads/active`);
  }
  /** The most recent archived public threads of a channel (one page). */
  archivedThreads(parentId: string): Promise<{ threads: DiscordThreadInfo[] } | null> {
    return this.request('GET', `/channels/${parentId}/threads/archived/public?limit=100`);
  }
  react(channelId: string, messageId: string, emoji: string): Promise<unknown> {
    return this.request(
      'PUT',
      `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`
    );
  }
}

// ---------------------------------------------------------------------------
// IO: gateway
// ---------------------------------------------------------------------------

export interface GatewayMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  content: string;
  author: { id: string; bot?: boolean };
  attachments?: Array<{ id: string; filename: string; size: number; url: string }>;
}

/** The subset of `ws` the gateway uses, so tests can drive it without a socket. */
export interface GatewaySocket {
  send(data: string): void;
  close(code?: number): void;
  on(event: 'message', cb: (data: { toString(): string }) => void): void;
  on(event: 'close', cb: (code: number) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}
export type SocketFactory = (url: string) => GatewaySocket;

const defaultSocket: SocketFactory = (url) => new WebSocket(url) as unknown as GatewaySocket;

/**
 * Inbound half: identify, heartbeat, resume and reconnect with backoff. Only MESSAGE_CREATE is
 * surfaced. A close code that retrying cannot fix (bad token, intent not enabled) stops it and
 * records `lastError` for the Settings status line.
 */
export class DiscordGateway {
  state: DiscordGatewayState = 'off';
  lastError: string | null = null;
  private sock: GatewaySocket | null = null;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private hb: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private acked = true;
  private attempts = 0;
  private stopped = true;

  constructor(
    private readonly token: () => string,
    private readonly onMessage: (m: GatewayMessage) => void,
    private readonly socketFactory: SocketFactory = defaultSocket,
    private readonly backoffMs: (attempt: number) => number = (n) => Math.min(1000 * 2 ** n, 60_000)
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.state = 'off';
    this.clearTimers();
    const s = this.sock;
    this.sock = null;
    try {
      s?.close(1000);
    } catch {
      /* already closed */
    }
  }

  private clearTimers(): void {
    if (this.hb) clearInterval(this.hb);
    if (this.retry) clearTimeout(this.retry);
    this.hb = this.retry = null;
  }

  private connect(): void {
    if (this.stopped) return;
    this.state = 'connecting';
    let sock: GatewaySocket;
    try {
      sock = this.socketFactory(this.resumeUrl ?? GATEWAY_URL);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.sock = sock;
    sock.on('message', (data) => this.handle(sock, data.toString()));
    sock.on('error', () => undefined); // 'close' follows and drives the reconnect
    sock.on('close', (code) => {
      if (this.sock !== sock) return; // a replaced socket's late close
      this.sock = null;
      this.clearTimers();
      if (this.stopped) return;
      if (FATAL_CLOSE_CODES.has(code)) {
        this.state = 'error';
        this.lastError =
          code === 4004
            ? 'Discord refused the bot token'
            : code === 4014
              ? 'Message Content Intent is off in the Developer Portal'
              : `Discord closed the connection (${code})`;
        return;
      }
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.state = 'connecting';
    this.retry = setTimeout(() => this.connect(), this.backoffMs(this.attempts++));
  }

  private handle(sock: GatewaySocket, raw: string): void {
    // `ws` keeps emitting while a socket closes: a frame after stop() or from a replaced socket must start nothing.
    if (this.stopped || sock !== this.sock) return;
    let p: { op: number; d?: unknown; s?: number | null; t?: string | null };
    try {
      p = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof p.s === 'number') this.seq = p.s;
    switch (p.op) {
      case 10: {
        const interval = Number((p.d as { heartbeat_interval?: number })?.heartbeat_interval) || 41_250;
        this.acked = true;
        this.hb = setInterval(() => {
          if (!this.acked) {
            // Zombie connection: no ack since the last beat. Resume on a fresh socket.
            try {
              sock.close(4000);
            } catch {
              /* already closed */
            }
            return;
          }
          this.acked = false;
          sock.send(JSON.stringify({ op: 1, d: this.seq }));
        }, interval);
        if (this.sessionId && this.seq !== null) {
          sock.send(JSON.stringify({ op: 6, d: { token: this.token(), session_id: this.sessionId, seq: this.seq } }));
        } else {
          sock.send(
            JSON.stringify({
              op: 2,
              d: {
                token: this.token(),
                intents: GATEWAY_INTENTS,
                properties: { os: 'linux', browser: 'codeman', device: 'codeman' },
              },
            })
          );
        }
        break;
      }
      case 11:
        this.acked = true;
        break;
      case 1:
        sock.send(JSON.stringify({ op: 1, d: this.seq }));
        break;
      case 7: // server asked us to reconnect (resumable)
        sock.close(4000);
        break;
      case 9: // invalid session: resumable only if d === true
        if (p.d !== true) {
          this.sessionId = null;
          this.seq = null;
          this.resumeUrl = null;
        }
        sock.close(4000);
        break;
      case 0:
        if (p.t === 'READY') {
          const d = p.d as { session_id?: string; resume_gateway_url?: string };
          this.sessionId = d.session_id ?? null;
          this.resumeUrl = d.resume_gateway_url ? `${d.resume_gateway_url}/?v=10&encoding=json` : null;
          this.state = 'connected';
          this.lastError = null;
          this.attempts = 0;
        } else if (p.t === 'RESUMED') {
          this.state = 'connected';
          this.attempts = 0;
        } else if (p.t === 'MESSAGE_CREATE') {
          this.onMessage(p.d as GatewayMessage);
        }
        break;
    }
  }
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

/**
 * Create or re-verify `<workingDir>/.codeman-discord`, or null when it is not safe to write there.
 * Same safeguards as the prompt uploads folder: the workspace is probed with the bounded probe before
 * the first disk touch (a dead mount must not hang the event loop), a symlink or a non-directory at
 * the folder is refused (an agent could plant `.codeman-discord -> ~/.ssh`), and the folder ignores
 * itself with a `.gitignore` of `*`, written once with O_EXCL so an `git add -A` never commits what was
 * sent and a file already there stays the user's.
 */
export async function ensureReceivedDir(workingDir: string): Promise<string | null> {
  if ((await probePathKind(workingDir, { pastCap: true })) !== 'directory') return null;
  const dir = join(workingDir, RECEIVED_DIR);
  try {
    const st = await fs.lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return null;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return null;
    try {
      await fs.mkdir(dir);
    } catch (mkErr) {
      if ((mkErr as NodeJS.ErrnoException).code !== 'EEXIST') return null;
      const again = await fs.lstat(dir).catch(() => null);
      if (!again || again.isSymbolicLink() || !again.isDirectory()) return null;
    }
  }
  const ignore = join(dir, '.gitignore');
  try {
    await fs.writeFile(ignore, '*\n', { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return dir;
    // An empty ignore file would read as the user's next time, so take it back.
    await fs.rm(ignore, { force: true }).catch(() => undefined);
    return null;
  }
  return dir;
}

export interface DiscordBridgeDeps {
  configDir: string;
  fetchImpl: DiscordFetch;
  /**
   * Types `text` into the session (a line ending in Enter, or a lone digit for a dialog). False when the
   * session is gone. `fromUser` is true only for what a person typed (a Discord reply), false for text
   * Codeman types itself.
   */
  sendInput: (sessionId: string, text: string, fromUser: boolean) => Promise<boolean>;
  /** True once the tab's agent has exited: tmux still accepts keys for a dead pane, so a tick would lie. */
  agentExited?: (sessionId: string) => boolean;
  /** True while the session shows a permission or question dialog, which acts on a bare keypress. */
  awaitingChoice?: (sessionId: string) => boolean;
  /** A session's working folder, where received files are saved. Undefined when it is gone or remote. */
  sessionDir?: (sessionId: string) => string | undefined;
  socketFactory?: SocketFactory;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  backoffMs?: (attempt: number) => number;
}

export class DiscordBridge {
  private cfg: DiscordConfig = { ...DEFAULT_DISCORD_CONFIG };
  private threads: Record<string, string> = {};
  private loaded = false;
  private gateway: DiscordGateway | null = null;
  /** The token the running gateway was started with ('' when none). */
  private gatewayToken = '';
  private lastSent = new Map<string, number>();
  private lastReply = new Map<string, number>();
  /** The last name seen per session, so only a real rename touches the thread. */
  private names = new Map<string, string>();
  /** Brand-new sessions that have not yet been sent the startup hint (non-Claude CLIs). */
  private fresh = new Set<string>();
  private pending = new Map<string, Promise<string | DiscordResult>>();
  /** Tabs closed while their thread was still being created: the creation applies `onSessionDelete` to it. */
  private closedWhilePending = new Set<string>();
  /** The last whole message posted per tab, so the same text is not posted twice (idle, then stop). */
  private lastFull = new Map<string, string>();
  /** The parent channel the thread map was built under. */
  private threadsParent = '';
  /** True from boot until the restored tabs exist (see hold). */
  private held = false;
  /** Thread-map writes run one after another: concurrent creations must not interleave on the tmp file. */
  private persistChain: Promise<void> = Promise.resolve();
  /** Per-thread chain of inbound messages (see onGatewayMessage). */
  private inbound = new Map<string, Promise<void>>();
  private mapLoad?: Promise<void>;
  private sweepTimer?: ReturnType<typeof setInterval>;
  /** The first full load (config, thread map, gateway), shared by every caller that arrives before it ends. */
  private firstLoad?: Promise<void>;
  private last: DiscordResult | null = null;
  private readonly api: DiscordApi;
  private readonly now: () => number;

  constructor(private readonly deps: DiscordBridgeDeps) {
    this.now = deps.now ?? Date.now;
    this.api = new DiscordApi(() => this.cfg.token, deps.fetchImpl, deps.sleep);
  }

  get lastResult(): DiscordResult | null {
    return this.last;
  }
  get gatewayState(): DiscordGatewayState {
    return this.gateway?.state ?? 'off';
  }
  get gatewayError(): string | null {
    return this.gateway?.lastError ?? null;
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.firstLoad ??= this.reload();
    await this.firstLoad;
  }

  /** Forget thread entries for tabs that no longer exist (dropped without a delete, for example). Once, at boot. */
  async prune(liveIds: Iterable<string>): Promise<void> {
    await this.ensureLoaded();
    const live = new Set(liveIds);
    if (live.size === 0) return; // nothing restored: more likely a failed restore than an empty server
    const stale = Object.keys(this.threads).filter((id) => !live.has(id));
    if (stale.length === 0) return;
    for (const id of stale) delete this.threads[id];
    await this.persistThreads();
  }

  /**
   * Close threads in the parent channel that this bot made and no tab maps to (`staleThreads`). Runs after
   * the boot prune, then daily. Never touches a thread someone else made (owner is the bot), a young one
   * (its map entry may not be written yet), or anything while the map is empty (a lost map would make
   * every thread look stale). Returns how many it archived or deleted. Never throws.
   */
  async sweepStaleThreads(): Promise<number> {
    try {
      await this.ensureLoaded();
      const c = this.cfg;
      if (c.staleThreads === 'keep' || !c.enabled || !c.token || !c.guildId || !c.parentChannelId) return 0;
      if (Object.keys(this.threads).length === 0 || this.pending.size > 0) return 0;
      const me = (await this.api.botUserId())?.id;
      if (!me) return 0;
      const known = new Set(Object.values(this.threads));
      const cutoff = this.now() - STALE_MIN_AGE_MS;
      const stale = (list: DiscordThreadInfo[] | undefined, archived: boolean) =>
        (list ?? [])
          .filter(
            (t) =>
              t.parent_id === c.parentChannelId &&
              t.owner_id === me &&
              SNOWFLAKE.test(t.id) &&
              !known.has(t.id) &&
              Number((BigInt(t.id) >> 22n) + BigInt(DISCORD_EPOCH_MS)) < cutoff &&
              // An archived thread has nothing left to archive.
              !(archived && c.staleThreads === 'archive')
          )
          .map((t) => t.id);
      const ids = [
        ...stale((await this.api.activeThreads(c.guildId))?.threads, false),
        ...(c.staleThreads === 'delete'
          ? stale((await this.api.archivedThreads(c.parentChannelId))?.threads, true)
          : []),
      ].slice(0, STALE_MAX_PER_SWEEP);
      let done = 0;
      for (const id of ids) {
        const ok = await (c.staleThreads === 'delete' ? this.api.remove(id) : this.api.archive(id)).then(
          () => true,
          () => false
        );
        if (ok) done++;
      }
      return done;
    } catch {
      return 0;
    }
  }

  /** Sweep now, then daily. The timer does not keep the process alive and `stop()` clears it. */
  startStaleSweep(): void {
    clearInterval(this.sweepTimer);
    void this.sweepStaleThreads();
    this.sweepTimer = setInterval(() => void this.sweepStaleThreads(), STALE_SWEEP_INTERVAL_MS);
    this.sweepTimer.unref?.();
  }

  /** Hold the gateway back (boot): a reply must not arrive before the restored tabs exist. */
  hold(): void {
    this.held = true;
  }

  /** Boot is done: start the gateway if the bridge is on. */
  async release(): Promise<void> {
    if (!this.held) return;
    this.held = false;
    await this.reload();
  }

  /** (Re)read the config and start or stop the gateway to match. Call at boot and after a save. */
  async reload(): Promise<void> {
    this.cfg = await readDiscordConfig(this.deps.configDir);
    // The thread map is read once, by whoever gets here first; everyone else waits for that read. A second
    // read finishing later would replace the map and drop threads made in between.
    this.mapLoad ??= readThreadFile(this.deps.configDir).then((saved) => {
      this.threads = { ...saved.threads, ...this.threads };
      this.threadsParent ||= saved.parent;
      this.loaded = true;
    });
    await this.mapLoad;
    // Threads belong to the channel they were made under: a new parent channel (or guild) starts afresh,
    // or every tab would keep posting into the old one.
    const parent = this.cfg.parentChannelId;
    if (parent && parent !== this.threadsParent) {
      this.threads = {};
      this.pending.clear();
      this.closedWhilePending.clear();
      this.threadsParent = parent;
      await this.persistThreads();
    }
    activeStartupHint = this.cfg.enabled && this.cfg.token && this.cfg.startupHint ? DISCORD_STARTUP_HINT : undefined;
    // A save that changed neither the switch nor the token keeps the gateway session, so it can resume.
    // A gateway that gave up (a fatal close, such as a missing intent) is replaced, or a fix could never take.
    const want = this.cfg.enabled && this.cfg.token && !this.held ? this.cfg.token : '';
    if (this.gateway && this.gateway.state !== 'error' && want && want === this.gatewayToken) return;
    this.gateway?.stop();
    this.gateway = null;
    this.gatewayToken = want;
    if (want) {
      this.gateway = new DiscordGateway(
        () => this.cfg.token,
        (m) => void this.onGatewayMessage(m).catch(() => undefined),
        this.deps.socketFactory,
        this.deps.backoffMs
      );
      this.gateway.start();
    }
  }

  stop(): void {
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    this.gateway?.stop();
    this.gateway = null;
    this.gatewayToken = '';
    activeStartupHint = undefined;
    this.lastSent.clear();
    this.lastReply.clear();
    this.names.clear();
    this.fresh.clear();
    this.lastFull.clear();
    this.inbound.clear();
  }

  private fail(err: unknown): DiscordResult {
    const status = err instanceof DiscordHttpError ? err.status : undefined;
    const code = err instanceof DiscordHttpError ? err.code : undefined;
    const error =
      status === 401
        ? 'The bot token was refused'
        : status === 403 || code === 50001
          ? 'The bot cannot see the parent channel (check its role and the channel ID)'
          : status === 404
            ? 'Channel not found (check the IDs)'
            : status
              ? `HTTP ${status}`
              : err instanceof BridgeProblem
                ? err.message
                : (err as { name?: string })?.name === 'TimeoutError'
                  ? 'Timed out'
                  : 'Network error';
    return { ok: false, status, error, at: this.now() };
  }

  private persistThreads(): Promise<void> {
    this.persistChain = this.persistChain
      .then(() => writeThreadMap(this.deps.configDir, this.threadsParent, { ...this.threads }))
      .catch(() => undefined);
    return this.persistChain;
  }

  /** The thread for a session, creating it when absent. Concurrent callers share one creation. */
  private threadFor(sessionId: string, name: string | undefined): Promise<string | DiscordResult> {
    const existing = this.threads[sessionId];
    if (existing) return Promise.resolve(existing);
    const inflight = this.pending.get(sessionId);
    if (inflight) return inflight;
    const parent = this.cfg.parentChannelId;
    const mine: { p?: Promise<string | DiscordResult> } = {};
    const p = (mine.p = (async () => {
      try {
        const t = await this.api.createThread(parent, threadNameFor(name, sessionId));
        if (!t?.id) return this.fail(new BridgeProblem('Discord did not return a thread'));
        // A save moved the bridge to another channel meanwhile: this thread belongs to the old one.
        if (parent !== this.cfg.parentChannelId) {
          await this.closeThread(t.id); // made in the old channel: tidy it
          return this.fail(new BridgeProblem('The parent channel changed'));
        }
        if (this.closedWhilePending.has(sessionId)) {
          await this.closeThread(t.id);
          return this.fail(new BridgeProblem('The tab was closed'));
        }
        this.threads[sessionId] = t.id;
        await this.persistThreads();
        return t.id;
      } catch (err) {
        return this.fail(err);
      } finally {
        // Only this creation's own entry: a newer one for the same tab may have replaced it.
        if (this.pending.get(sessionId) === mine.p) {
          this.pending.delete(sessionId);
          this.closedWhilePending.delete(sessionId);
        }
      }
    })());
    this.pending.set(sessionId, p);
    return p;
  }

  /** Post an alert. Session-less messages go to the parent channel. Never throws. */
  async notify(
    msg: DiscordMessage,
    opts: { urgent?: boolean; deliberate?: boolean } = {}
  ): Promise<DiscordResult | null> {
    const explicitUrgent = opts.urgent === true;
    await this.ensureLoaded();
    if (!shouldSendDiscord(this.cfg, msg.urgency)) return null;
    const key = `${msg.event}:${msg.sessionId ?? ''}`;
    const t = this.now();
    const prev = this.lastSent.get(key);
    // A deliberate post (an agent's own `codeman notify`) is never deduped: a second, different message is real.
    // Automatic events are, and say so, which is not the same answer as "the bridge is off" (null).
    if (!opts.deliberate && prev !== undefined && t - prev < DEDUPE_WINDOW_MS) {
      return { ok: true, deduped: true, at: t };
    }
    this.lastSent.set(key, t);
    if (this.lastSent.size > 256) {
      for (const [k, v] of this.lastSent) if (t - v > DEDUPE_WINDOW_MS) this.lastSent.delete(k);
    }
    let chunks: string[] = [];
    // Remembered only once the first post is out: a failed post must leave the message to be sent again.
    let posted: string | undefined;
    if (msg.fullText) {
      try {
        const got = await withTimeout(msg.fullText(), FULL_TEXT_TIMEOUT_MS);
        const text = got?.text.trim();
        const sid = msg.sessionId;
        if (text && sid) {
          // Keyed on the text and the turn it came from, so a later turn that ends on the same words is posted.
          const key = `${got?.version ?? ''}\u0000${text}`;
          msg = { ...msg, tail: undefined };
          if (this.lastFull.get(sid) !== key) {
            chunks = splitForDiscord(tablesToCodeBlocks(text));
            posted = key;
          } // else: said already, so only the header goes
        }
      } catch {
        // no transcript to read: the screen tail stands in
      }
    }
    const post = buildPost(msg, this.cfg, explicitUrgent);
    // One post when the head and the first part fit together, the rest follow without a ping.
    if (chunks.length > 0 && post.content.length + 1 + chunks[0].length <= MAX_CONTENT) {
      post.content += `\n${chunks.shift()}`;
    }
    // Claimed just before the first post and given back if it fails, so an alert for the same tab that
    // overlaps this one does not post the message too, and a failed post is still sent again.
    let claimed: { sid: string; before: string | undefined } | undefined;
    try {
      let target = this.cfg.parentChannelId;
      if (msg.sessionId) {
        const thread = await this.threadFor(msg.sessionId, msg.sessionName);
        if (typeof thread !== 'string') return (this.last = thread);
        target = thread;
      }
      const send = (to: string) => (msg.file ? this.api.postWithFile(to, post, msg.file) : this.api.post(to, post));
      if (posted && msg.sessionId) {
        claimed = { sid: msg.sessionId, before: this.lastFull.get(msg.sessionId) };
        this.lastFull.set(msg.sessionId, posted);
      }
      try {
        await send(target);
      } catch (err) {
        // The thread was deleted by hand: forget it, make a new one, once.
        if (msg.sessionId && err instanceof DiscordHttpError && err.status === 404) {
          delete this.threads[msg.sessionId];
          const fresh = await this.threadFor(msg.sessionId, msg.sessionName);
          if (typeof fresh !== 'string') return (this.last = fresh);
          await send(fresh);
        } else {
          throw err;
        }
      }
      // Parts 2 to 8 are best effort on purpose: the first post, which carries the title, is what is reported.
      for (const part of chunks) await this.say(this.threads[msg.sessionId ?? ''] ?? target, part);
      return (this.last = { ok: true, at: this.now() });
    } catch (err) {
      if (claimed) {
        if (claimed.before === undefined) this.lastFull.delete(claimed.sid);
        else this.lastFull.set(claimed.sid, claimed.before);
      }
      return (this.last = this.fail(err));
    }
  }

  /** A deliberate test send to the parent channel: bypasses `enabled`, scope and dedupe. */
  async sendTest(cfg: DiscordConfig, host?: string): Promise<DiscordResult> {
    // Its own client: swapping this.cfg would undo a save that lands while the post is in flight.
    const api = new DiscordApi(() => cfg.token, this.deps.fetchImpl, this.deps.sleep);
    try {
      await api.post(
        cfg.parentChannelId,
        buildPost(
          {
            event: 'discord:test',
            title: 'Codeman test notification',
            body: 'If you can read this, the Discord bridge can post. Replies in session threads are typed into that tab.',
            urgency: 'info',
            host,
          },
          { ...cfg, pingMode: 'off' }
        )
      );
      return (this.last = { ok: true, at: this.now() });
    } catch (err) {
      return (this.last = this.fail(err));
    }
  }

  /** Session tab created: make its thread now when `threadCreation` is `onSessionStart`. */
  async sessionCreated(sessionId: string, name: string | undefined, createdAt?: number): Promise<void> {
    await this.ensureLoaded();
    // Only a tab made just now: the same event also fires for sessions restored at server start.
    if (createdAt !== undefined && this.now() - createdAt < 60_000) this.fresh.add(sessionId);
    if (!this.cfg.enabled || this.cfg.threadCreation !== 'onSessionStart') return;
    const made = await this.threadFor(sessionId, name);
    if (typeof made !== 'string') this.last = made;
  }

  /**
   * First idle of a brand-new non-Claude session means its prompt is up: type the startup hint once.
   * Claude gets the same text as a launch flag instead, and a shell must never receive it.
   */
  async sessionIdle(sessionId: string, hintable: boolean): Promise<void> {
    if (!this.fresh.has(sessionId)) return;
    if (!hintable || !this.cfg.enabled || !this.cfg.startupHint || !this.cfg.typedHint) {
      this.fresh.delete(sessionId); // no longer new: turning the hint on later must not reach this tab
      return;
    }
    // A dialog is up (codex's trust prompt reads as idle): Enter would pick its highlighted option, so wait for the next idle.
    if (this.deps.awaitingChoice?.(sessionId)) return;
    this.fresh.delete(sessionId);
    const text = sanitiseReply(`${DISCORD_STARTUP_HINT} Reply with just: ok`);
    // fromUser false: this is Codeman talking, so it must not auto-name the tab or count as the person's input.
    if (text) await this.deps.sendInput(sessionId, text, false).catch(() => false);
  }

  async sessionRenamed(sessionId: string, name: string | undefined): Promise<void> {
    const seen = this.names.get(sessionId);
    this.names.set(sessionId, name ?? '');
    // First sight only records the name: the thread was made with it, so a PATCH would spend a rename for nothing.
    if (seen === undefined || seen === (name ?? '')) return;
    const thread = this.threads[sessionId];
    if (!thread || !this.cfg.enabled) return;
    await this.api.rename(thread, threadNameFor(name, sessionId)).catch(() => undefined);
  }

  /**
   * Drop the per-tab state only, keeping the thread and its map entry. For a session that is discarded
   * but can come back under the same id (a failed reboot-restore rebuild stays on offer for a retry).
   * Per-tab state goes whether or not the tab ever had a thread, so these maps cannot grow for the life of the server.
   */
  forgetTab(sessionId: string): void {
    this.lastReply.delete(sessionId);
    this.names.delete(sessionId);
    this.fresh.delete(sessionId);
    this.lastFull.delete(sessionId);
  }

  /** Session tab deleted: apply `onSessionDelete` and forget the mapping. */
  async sessionDeleted(sessionId: string): Promise<void> {
    this.forgetTab(sessionId);
    // A thread still being created is closed by its creation, which finds no entry to remove here.
    if (this.pending.has(sessionId)) this.closedWhilePending.add(sessionId);
    const thread = this.threads[sessionId];
    if (!thread) return;
    delete this.threads[sessionId];
    await this.persistThreads();
    await this.closeThread(thread);
  }

  /** Apply `onSessionDelete` to a thread. */
  private async closeThread(thread: string): Promise<void> {
    if (!this.cfg.enabled) return;
    if (this.cfg.onSessionDelete === 'delete') await this.api.remove(thread).catch(() => undefined);
    else if (this.cfg.onSessionDelete === 'archive') await this.api.archive(thread).catch(() => undefined);
  }

  private say(channelId: string, content: string): Promise<unknown> {
    return this.api.post(channelId, { content, allowed_mentions: { parse: [], users: [] } }).catch(() => undefined);
  }

  /**
   * Save a reply's attachments under the session's working folder and return the paths. Only Discord
   * CDN URLs, at most 5 files of 8 MB each, names reduced to safe characters. Anything skipped is
   * named in `refused`, so the person is not left guessing why a file did not arrive.
   */
  private async saveAttachments(sessionId: string, m: GatewayMessage): Promise<{ paths: string[]; refused?: string }> {
    const list = m.attachments ?? [];
    if (list.length === 0) return { paths: [] };
    const dir = this.deps.sessionDir?.(sessionId);
    if (!dir) return { paths: [], refused: 'That tab has no local folder to save files in, so no file was saved.' };
    // The message id goes into a file name, so it must be a snowflake and nothing else.
    if (!SNOWFLAKE.test(m.id)) return { paths: [], refused: 'That message could not be saved.' };
    const target = await ensureReceivedDir(dir);
    if (!target) return { paths: [], refused: 'The tab folder is not safe to write to, so no file was saved.' };
    const paths: string[] = [];
    const skipped: string[] = [];
    for (const [i, a] of list.entries()) {
      const name = safeAttachmentName(a.filename ?? 'file');
      if (i >= MAX_FILES_PER_REPLY || !isDiscordCdnUrl(a.url) || !(a.size <= MAX_FILE_BYTES)) {
        skipped.push(name);
        continue;
      }
      try {
        const res = await this.deps.fetchImpl(new URL(a.url), {
          redirect: 'manual',
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
        const buf = res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
        if (!buf || buf.byteLength > MAX_FILE_BYTES) {
          skipped.push(name);
          continue;
        }
        const dest = join(target, `${m.id}-${name}`);
        // 'wx' (O_EXCL) also refuses a symlink planted at the name.
        await fs.writeFile(dest, buf, { mode: 0o600, flag: 'wx' });
        paths.push(dest);
      } catch {
        skipped.push(name);
      }
    }
    return {
      paths,
      refused: skipped.length
        ? `Not saved (over 8 MB, more than ${MAX_FILES_PER_REPLY} files, or not downloadable): ${skipped.join(', ')}`
        : undefined,
    };
  }

  /** Inbound reply. One chain per thread, so a reply that waits on a file download cannot be overtaken by a later one. */
  async onGatewayMessage(m: GatewayMessage): Promise<void> {
    const key = String(m.channel_id);
    const run = (this.inbound.get(key) ?? Promise.resolve()).then(() => this.handleMessage(m)).catch(() => undefined);
    this.inbound.set(key, run);
    await run;
    if (this.inbound.get(key) === run) this.inbound.delete(key);
  }

  /** Every gate here drops silently: a stranger learns nothing. */
  private async handleMessage(m: GatewayMessage): Promise<void> {
    if (!this.cfg.enabled || m.author?.bot) return;
    if (m.guild_id !== this.cfg.guildId) return;
    if (!this.cfg.allowedUserIds.includes(m.author?.id)) return;
    const sessionId = Object.keys(this.threads).find((k) => this.threads[k] === m.channel_id);
    if (!sessionId) return;
    const t = this.now();
    const prev = this.lastReply.get(sessionId);
    if (prev !== undefined && t - prev < REPLY_MIN_INTERVAL_MS) {
      // Too soon after the last reply: say it was not typed, instead of dropping it silently.
      await this.api.react(m.channel_id, m.id, '⏳').catch(() => undefined);
      return;
    }
    if (this.deps.agentExited?.(sessionId)) {
      await this.say(m.channel_id, 'The agent in that tab has exited, so nothing was typed.');
      return;
    }
    this.lastReply.set(sessionId, t);
    const saved = await this.saveAttachments(sessionId, m);
    const text = sanitiseReply(m.content ?? '', saved.paths);
    if (!text) {
      if (saved.refused) await this.say(m.channel_id, saved.refused);
      return;
    }
    if (saved.refused) await this.say(m.channel_id, saved.refused);
    // A lone digit answers a dialog by itself: an Enter after it would land on whatever comes next.
    const keys = /^\d\r$/.test(text) && this.deps.awaitingChoice?.(sessionId) ? text.slice(0, -1) : text;
    const ok = await this.deps.sendInput(sessionId, keys, true).catch(() => false);
    const reply = ok
      ? this.api.react(m.channel_id, m.id, '✅')
      : this.api.post(m.channel_id, {
          content: 'That tab is gone, so nothing was typed.',
          allowed_mentions: { parse: [], users: [] },
        });
    await reply.catch(() => undefined);
  }
}
