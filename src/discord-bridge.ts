import { discordDisplayText } from './discord-display-text.js';
import { DiscordCaseCategories } from './discord-case-categories.js';
import { DiscordCaseThreads, type DiscordStarter } from './discord-case-threads.js';
import type { DiscordCaseIdentity } from './discord-case-identity.js';
import { hashDiscordPrompt } from './discord-native-execution.js';
import { DiscordConversationProgressStore } from './discord-conversation-progress.js';
import { renderHistory } from './discord-history.js';
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
 *   - A reply retains Markdown and line breaks in one bracketed paste plus Enter. A lone digit
 *     while a permission or question is pending goes as the key alone (see onGatewayMessage).
 *   - Posts never ping unless `pingMode` says so, and then only the allowlisted user ids.
 *   - A Discord outage or a bad token never reaches a session: every IO path catches and backs off.
 *
 * @module discord-bridge
 */

import { existsSync, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { boundedDiscordDownload } from './discord-file-transfers.js';
import { probePathKind } from './utils/bounded-path-probe.js';
import { DISCORD_RECEIVED_DIR } from './web/paste-image-gc.js';
import WebSocket from 'ws';
import { stripVTControlCharacters } from 'node:util';
import { DiscordDeliveryError, DiscordDeliveryJournal, type DiscordDelivery } from './discord-delivery.js';
import { DiscordChannelProblem, type DiscordManagedChannel } from './discord-session-channels.js';
import { WEBHOOK_SCOPES, type WebhookUrgency } from './types/push.js';
import {
  DISCORD_MODES,
  DISCORD_ON_DELETE,
  DISCORD_PING_MODES,
  DISCORD_THREAD_CREATION,
  type DiscordConfig,
  type DiscordGatewayState,
  type DiscordPingMode,
  type DiscordResult,
  type DiscordSessionSync,
} from './types/discord.js';

const CONFIG_FILE = 'discord.json';
const THREADS_FILE = 'discord-bridge.json';
const API = 'https://discord.com/api/v10';
const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json';
const SEND_TIMEOUT_MS = 8000;
const MAX_CONTENT = 1900;
const MAX_THREAD_NAME = 100;
/** Bound structured prompts without silently truncating user instructions. */
export const MAX_REPLY_CHARS = 20_000;
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
/**
 * The most of a last message worth converting: what 8 posts can carry, twice over, since a table can
 * shrink when formatted. The rest could never be posted, and a padded table costs its widest cell
 * times its rows, so an agent-steerable message must not reach the conversion whole.
 */
const MAX_CONVERTED_TEXT = MAX_CONTENT * 8 * 2;
/** Reading a CLI's transcript must not hold an alert back for long. */
const FULL_TEXT_TIMEOUT_MS = 4000;

export const DEFAULT_DISCORD_CONFIG: DiscordConfig = {
  enabled: false,
  mode: 'notifications',
  categoryId: '',
  onChannelDelete: 'keep',
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
export function discordConfigProblem(cfg: DiscordConfig, allowMissingCategory = false): string | null {
  if (cfg.token && (/\s/.test(cfg.token) || cfg.token.length > 200)) return 'The bot token looks wrong';
  if (cfg.guildId && !SNOWFLAKE.test(cfg.guildId)) return 'Guild ID must be a number (Copy ID in Discord)';
  if (cfg.parentChannelId && !SNOWFLAKE.test(cfg.parentChannelId)) return 'Channel ID must be a number';
  if (cfg.categoryId && !SNOWFLAKE.test(cfg.categoryId)) return 'Case category ID must be a number';
  if (cfg.allowedUserIds.some((id) => !SNOWFLAKE.test(id))) return 'Each allowed user ID must be a number';
  if (cfg.allowedUserIds.length > 20) return 'At most 20 allowed user IDs';
  if (cfg.enabled) {
    if (!cfg.token) return 'Add the bot token before enabling';
    if (!cfg.guildId || !cfg.parentChannelId) return 'Add the guild ID and parent channel ID before enabling';
    if (cfg.mode === 'full' && !cfg.categoryId && !allowMissingCategory)
      return 'Choose a case category before enabling Full interface mode';
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
 * A Discord reply preserving Markdown/whitespace plus Enter, or null when empty or oversized. The caller
 * drops the Enter for a lone digit answering a pending dialog.
 */
export function sanitiseReply(raw: string, files: string[] = []): string | null {
  // Preserve Markdown, indentation and line breaks. Never pass terminal control sequences through.
  const text = stripVTControlCharacters(raw)
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
  if (text.length > MAX_REPLY_CHARS) return null;
  const attached = files.length ? `${text ? ' ' : ''}[attached: ${files.join(', ')}]` : '';
  return text.trim() || attached ? `${text}${attached}\r` : null;
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
export const RECEIVED_DIR = DISCORD_RECEIVED_DIR;

/**
 * What a session is told about the bridge. Claude gets it as `--append-system-prompt`; no other CLI
 * is told. No apostrophes: it is rendered into a shell command.
 */
export const DISCORD_STARTUP_HINT =
  'Codeman note: if you are blocked on something only the user can do (a physical step such as ' +
  'pressing a button, an answer you cannot work out, or a wait that timed out), run: ' +
  'codeman notify "message that leads with the action" --urgent (lead with the action). The user reads a Discord thread for ' +
  'this tab and their reply is pasted with its formatting and line breaks; a file they attach is saved and its path is ' +
  'given in that reply. Add --file <path> to send a file from your working folder. Not for routine progress.';

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
  if (!Number.isInteger(max) || max < 128 || max > 1900 || !Number.isInteger(maxPosts) || maxPosts < 1 || maxPosts > 64)
    throw new RangeError('Invalid Discord message chunk limits');
  const posts: string[] = [];
  let cur = '';
  let fence: string | null = null;
  let cut = false;
  const budget = max - 64; // Reserve a closing fence and the explicit overflow note.
  const opening = () => (fence === null ? '' : '```' + fence + '\n');
  const flush = () => {
    if (cur.trim() && cur !== opening()) posts.push(cur.trimEnd() + (fence !== null ? '\n```' : ''));
    cur = opening();
  };
  for (let line of text.replace(/\r\n?/g, '\n').split('\n')) {
    if (posts.length >= maxPosts) {
      cut = true;
      break;
    }
    const fenceLine = /^\s*`{3}([^`]*)$/.exec(line);
    // Carry language hints across chunks, bounded so a hostile hint cannot fill a post.
    const nextFence: string | null = fenceLine && fence === null ? fenceLine[1].trim().slice(0, 32) : null;
    if (fenceLine && fence === null) line = '```' + nextFence;
    if (cur.length + line.length + 1 > budget && cur.trim() && cur !== opening()) flush();
    while (line.length > budget - cur.length) {
      let end = budget - cur.length;
      // Do not split a UTF-16 surrogate pair (emoji and non-BMP characters).
      if (end > 0 && /[\uD800-\uDBFF]/.test(line[end - 1]) && /[\uDC00-\uDFFF]/.test(line[end] ?? '')) end--;
      cur += line.slice(0, end) + '\n';
      line = line.slice(end);
      flush();
      if (posts.length >= maxPosts) {
        cut = true;
        break;
      }
    }
    if (cut) break;
    if (cur.length + line.length + 1 > budget) flush();
    cur += line + '\n';
    if (fenceLine) {
      if (fence === null) fence = nextFence ?? '';
      else if (!fenceLine[1].trim()) fence = null;
    }
  }
  if (!cut) flush();
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

export interface DiscordControlReply {
  text: string;
  locateSessionId?: string;
  file?: DiscordFile;
  actions?: Array<{ label: string; command: string; validity: string; style?: number }>;
}
export interface DiscordInteraction {
  id: string;
  application_id: string;
  token: string;
  guild_id?: string;
  channel_id?: string;
  type: number;
  data?: { custom_id?: string };
  member?: { user?: { id: string } };
  user?: { id: string };
  message?: { id: string };
}
interface DiscordBoundAction {
  sessionId: string;
  channel: string;
  command: string;
  validity: string;
  expiresAt: number;
  messageId?: string;
}
export interface DiscordPost {
  content: string;
  allowed_mentions: { parse: string[]; users: string[] };
  nonce?: string;
  enforce_nonce?: boolean;
  components?: Array<{
    type: number;
    components: Array<{ type: number; style: number; label: string; custom_id: string }>;
  }>;
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
  tailText = tailText ? discordDisplayText(tailText) : undefined;
  const fence = tailText?.trim() ? `\n\`\`\`\n${tailText.trim().replace(/```/g, "'''")}\n\`\`\`` : '';
  const host = msg.host ? ` (${clip(msg.host, 60)})` : '';
  const content = clip(`${head}${host}${msg.body ? `\n${discordDisplayText(msg.body)}` : ''}${fence}`, MAX_CONTENT);
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
    mode: oneOf(DISCORD_MODES, r.mode, d.mode),
    categoryId: typeof r.categoryId === 'string' ? r.categoryId : '',
    onChannelDelete: oneOf(['keep', 'retain', 'delete'] as const, r.onChannelDelete, d.onChannelDelete),
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
interface ThreadFile {
  parent: string;
  threads: Record<string, string>;
  scope: string;
  scopes: Record<string, Record<string, string>>;
}
async function readThreadFile(configDir: string): Promise<ThreadFile> {
  try {
    const raw = JSON.parse(await fs.readFile(join(configDir, THREADS_FILE), 'utf-8')) as Record<string, unknown>;
    const clean = (value: unknown): Record<string, string> => {
      const out: Record<string, string> = {};
      if (value && typeof value === 'object')
        for (const [k, v] of Object.entries(value)) if (typeof v === 'string' && SNOWFLAKE.test(v)) out[k] = v;
      return out;
    };
    const scopes: Record<string, Record<string, string>> = {};
    if (raw.scopes && typeof raw.scopes === 'object')
      for (const [key, map] of Object.entries(raw.scopes)) scopes[key] = clean(map);
    return {
      parent: typeof raw.parentChannelId === 'string' ? raw.parentChannelId : '',
      threads: clean(raw.threads),
      scope: typeof raw.scope === 'string' ? raw.scope : '',
      scopes,
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new BridgeProblem('Discord session mapping cannot be read; sync is paused');
    return { parent: '', threads: {}, scope: '', scopes: {} };
  }
}

export async function readThreadMap(configDir: string): Promise<Record<string, string>> {
  return (await readThreadFile(configDir)).threads;
}

async function writeThreadMap(
  configDir: string,
  parentChannelId: string,
  threads: Record<string, string>,
  scope: string,
  scopes: Record<string, Record<string, string>>
): Promise<void> {
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  await writePrivate(join(configDir, THREADS_FILE), { parentChannelId, threads, scope, scopes }, 0o600);
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

  async request<T = unknown>(method: string, path: string, body?: unknown, attempt = 0): Promise<T | null> {
    const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
    const payload = isForm ? JSON.parse(String((body as FormData).get('payload_json') ?? '{}')) : body;
    const retrySafe = method !== 'POST' || !!(payload as DiscordPost | undefined)?.enforce_nonce;
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(`${API}${path}`), {
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
    } catch (err) {
      // Creating a thread/channel has no idempotency key: a lost response must not create a duplicate.
      if (!retrySafe || attempt >= 2) throw err;
      await this.sleep(500 * 2 ** attempt);
      return this.request<T>(method, path, body, attempt + 1);
    }
    if (res.status === 429 && attempt < 2) {
      const j = (await res.json().catch(() => ({}))) as { retry_after?: number };
      const delay = Number.isFinite(j.retry_after) ? Math.max((j.retry_after ?? 1) * 1000, 100) : 1000;
      // Never retry earlier than Discord permits. A longer wait is surfaced instead of blocking a session chain.
      if (delay > 30_000) throw new DiscordHttpError(429);
      await this.sleep(delay);
      return this.request<T>(method, path, body, attempt + 1);
    }
    if (res.status >= 500 && retrySafe && attempt < 2) {
      await this.sleep(500 * 2 ** attempt);
      return this.request<T>(method, path, body, attempt + 1);
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
  getMessage(parent: string, id: string): Promise<DiscordStarter | null> {
    return this.request('GET', `/channels/${parent}/messages/${id}`);
  }
  channelMessages(parent: string): Promise<DiscordStarter[] | null> {
    return this.request('GET', `/channels/${parent}/messages?limit=100`);
  }
  createThreadFromMessage(parent: string, id: string, name: string): Promise<DiscordManagedChannel | null> {
    return this.request('POST', `/channels/${parent}/messages/${id}/threads`, { name, auto_archive_duration: 10080 });
  }
  getChannel(id: string): Promise<DiscordManagedChannel | null> {
    return this.request('GET', `/channels/${id}`);
  }
  guildChannels(id: string): Promise<DiscordManagedChannel[] | null> {
    return this.request('GET', `/guilds/${id}/channels`);
  }
  createTextChannel(id: string, body: Record<string, unknown>): Promise<DiscordManagedChannel | null> {
    return this.request('POST', `/guilds/${id}/channels`, body);
  }
  editChannel(id: string, body: Record<string, unknown>): Promise<unknown> {
    return this.request('PATCH', `/channels/${id}`, body);
  }
  post(channelId: string, p: DiscordPost): Promise<{ id: string } | null> {
    return this.request('POST', `/channels/${channelId}/messages`, {
      ...p,
      nonce: p.nonce ?? randomUUID().replaceAll('-', '').slice(0, 24),
      enforce_nonce: true,
    });
  }
  postWithFile(channelId: string, p: DiscordPost, file: DiscordFile): Promise<{ id: string } | null> {
    const form = new FormData();
    form.append(
      'payload_json',
      JSON.stringify({
        ...p,
        nonce: p.nonce ?? randomUUID().replaceAll('-', '').slice(0, 24),
        enforce_nonce: true,
      })
    );
    form.append('files[0]', new Blob([Buffer.from(file.data)]), safeAttachmentName(file.name));
    return this.request('POST', `/channels/${channelId}/messages`, form);
  }
  editMessage(channelId: string, id: string, post: Partial<DiscordPost>): Promise<unknown> {
    return this.request('PATCH', `/channels/${channelId}/messages/${id}`, post);
  }
  respondInteraction(id: string, token: string, body: unknown): Promise<unknown> {
    return this.request('POST', `/interactions/${encodeURIComponent(id)}/${encodeURIComponent(token)}/callback`, body);
  }
  finishInteraction(appId: string, token: string, content: string): Promise<unknown> {
    return this.request(
      'PATCH',
      `/webhooks/${encodeURIComponent(appId)}/${encodeURIComponent(token)}/messages/@original`,
      { content, allowed_mentions: { parse: [], users: [] } }
    );
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
    private readonly backoffMs: (attempt: number) => number = (n) => Math.min(1000 * 2 ** n, 60_000),
    private readonly onInteraction?: (interaction: DiscordInteraction) => void
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
        } else if (p.t === 'INTERACTION_CREATE') {
          this.onInteraction?.(p.d as DiscordInteraction);
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
   * Types a person's Discord reply into the session (a line ending in Enter, or a lone digit for a
   * dialog). False when the session is gone.
   */
  sendInput: (sessionId: string, text: string) => Promise<boolean>;
  /** True once the tab's agent has exited: tmux still accepts keys for a dead pane, so a tick would lie. */
  agentExited?: (sessionId: string) => boolean;
  /** True while the session shows a permission or question dialog, which acts on a bare keypress. */
  awaitingChoice?: (sessionId: string) => boolean;
  /** A session's working folder, where received files are saved. Undefined when it is gone or remote. */
  sessionDir?: (sessionId: string) => string | undefined;
  caseForSession?: (sessionId: string) => Promise<DiscordCaseIdentity | undefined>;
  control?: (sessionId: string, command: string) => Promise<DiscordControlReply>;
  controlCurrent?: (sessionId: string, validity: string) => boolean;
  history?: (
    sessionId: string,
    options?: { includeTools?: boolean }
  ) => Promise<import('./discord-history.js').DiscordHistory>;
  saveRemoteAttachment?: (sessionId: string, name: string, bytes: Uint8Array) => Promise<string>;
  getAttachment?: (sessionId: string, path: string) => Promise<DiscordFile>;
  /** Snapshot only: never discovers or starts agents. Called after restoration is released. */
  sessions?: () => Array<{ id: string; name?: string; remote?: boolean; working?: boolean }>;
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
  private pending = new Map<string, Promise<string | DiscordResult>>();
  /** Tabs closed while their thread was still being created: the creation applies `onSessionDelete` to it. */
  private closedWhilePending = new Set<string>();
  /** The last whole message posted per tab, so the same text is not posted twice (idle, then stop). */
  private lastFull = new Map<string, string>();
  /** The parent channel the thread map was built under. */
  private threadsParent = '';
  private threadsScope = '';
  private threadScopes: Record<string, Record<string, string>> = {};
  /** True from boot until the restored tabs exist (see hold). */
  private held = false;
  /** Thread-map writes run one after another: concurrent creations must not interleave on the tmp file. */
  private persistChain: Promise<void> = Promise.resolve();
  private mapRevision = 0;
  private persistedMapRevision = 0;
  /** Per-thread chain of inbound messages (see onGatewayMessage). */
  private inbound = new Map<string, Promise<void>>();
  private outbound = new Map<string, Promise<DiscordResult | null>>();
  private pendingNotifications = 0;
  private mapLoad?: Promise<void>;
  private sweepTimer?: ReturnType<typeof setInterval>;
  /** The first full load (config, thread map, gateway), shared by every caller that arrives before it ends. */
  private firstLoad?: Promise<void>;
  private last: DiscordResult | null = null;
  private syncRun?: Promise<DiscordSessionSync>;
  private syncQueued = false;
  private syncState: DiscordSessionSync = { state: 'idle', total: 0, ready: 0, failed: 0 };
  private stopped = false;
  private outputTimer?: ReturnType<typeof setInterval>;
  private outputReads = new Map<string, { remote: boolean; run: Promise<void> }>();
  private outputIndex = 0;
  private actions = new Map<string, DiscordBoundAction>();
  private outputDue = new Map<string, number>();
  private readonly api: DiscordApi;
  private readonly now: () => number;
  private readonly deliveries: DiscordDeliveryJournal;
  private readonly channels: DiscordCaseThreads;
  private readonly categories: DiscordCaseCategories;
  private readonly conversationProgress: DiscordConversationProgressStore;
  private readonly conversationRuns = new Map<string, Promise<void>>();

  constructor(private readonly deps: DiscordBridgeDeps) {
    this.now = deps.now ?? Date.now;
    this.conversationProgress = new DiscordConversationProgressStore(deps.configDir);
    this.deliveries = new DiscordDeliveryJournal(deps.configDir, this.now);
    this.api = new DiscordApi(() => this.cfg.token, deps.fetchImpl, deps.sleep);
    this.categories = new DiscordCaseCategories(deps.configDir);
    this.channels = new DiscordCaseThreads(
      deps.configDir,
      {
        get: (id) => this.api.getChannel(id),
        list: (id) => this.api.guildChannels(id),
        create: (id, body) => this.api.createTextChannel(id, body),
        edit: (id, body) => this.api.editChannel(id, body),
        remove: (id) => this.api.remove(id),
        botId: async () => {
          const me = await this.api.botUserId();
          if (!me?.id) throw new DiscordChannelProblem('Discord bot identity unavailable');
          return me.id;
        },
        postStarter: (id, body) => this.api.post(id, body),
        getStarter: (parent, id) => this.api.getMessage(parent, id),
        listStarters: (parent) => this.api.channelMessages(parent),
        createThread: (parent, starter, name) => this.api.createThreadFromMessage(parent, starter, name),
      },
      async (id) =>
        deps.caseForSession
          ? deps.caseForSession(id)
          : {
              key: createHash('sha256')
                .update('unlinked:' + id)
                .digest('hex'),
              name: 'unlinked-' + id.slice(0, 8),
            },
      this.now,
      (scope, id) =>
        !this.stopped &&
        this.cfg.enabled &&
        this.cfg.mode === 'full' &&
        this.cfg.guildId === scope.guildId &&
        this.cfg.categoryId === scope.categoryId &&
        (!this.deps.sessions || this.deps.sessions().some((s) => s.id === id))
    );
  }

  async provisionCategory(config: DiscordConfig): Promise<string> {
    const api = new DiscordApi(() => config.token, this.deps.fetchImpl, this.deps.sleep);
    return this.categories.forConfig(config, {
      botId: async () => {
        const me = await api.botUserId();
        if (!me?.id) throw new DiscordChannelProblem('Bot identity unavailable');
        return me.id;
      },
      get: (id) => api.getChannel(id),
      list: (id) => api.guildChannels(id),
      create: (guild, body) => api.createTextChannel(guild, body),
      edit: (id, body) => api.editChannel(id, body),
      remove: (id) => api.remove(id),
    });
  }

  get acceptsControls(): boolean {
    return !this.stopped && this.cfg.enabled && this.cfg.mode === 'full' && !!this.cfg.token;
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
  get sessionSync(): DiscordSessionSync {
    return { ...this.syncState };
  }
  recentDeliveries(): Promise<DiscordDelivery[]> {
    return this.deliveries.recent();
  }
  private destinationScope(): string {
    return JSON.stringify([this.cfg.mode, this.cfg.guildId, this.cfg.parentChannelId, this.cfg.categoryId]);
  }
  private destinationMatches(id: string, channel: string): boolean {
    if (id.startsWith('__case__:'))
      return this.cfg.mode === 'full' && this.channels.caseForChannel(this.cfg, channel) === id.slice(9);
    if (id === '__management__')
      return this.cfg.mode === 'full' && !!this.cfg.parentChannelId && this.cfg.parentChannelId === channel;
    return this.cfg.mode === 'full'
      ? this.channels.channelForSession(this.cfg, id) === channel
      : this.threads[id] === channel;
  }

  /** Full-mode discovery is bounded to the current session snapshot, without replaying any prompts. */
  syncSessions(): Promise<DiscordSessionSync> {
    if (this.syncRun) return this.syncRun;
    const run = this.runSessionSync().finally(() => {
      if (this.syncRun === run) {
        this.syncRun = undefined;
        if (this.syncQueued) {
          this.syncQueued = false;
          void this.syncSessions().catch(() => undefined);
        }
      }
    });
    this.syncRun = run;
    return run;
  }

  private async runSessionSync(): Promise<DiscordSessionSync> {
    await this.ensureLoaded();
    if (this.stopped || this.held || !this.cfg.enabled || !this.cfg.token || this.cfg.mode !== 'full')
      return this.sessionSync;
    const parent = this.destinationScope();
    const sessions = this.deps.sessions?.() ?? [];
    this.syncState = { state: 'syncing', total: sessions.length, ready: 0, failed: 0 };
    try {
      try {
        await this.channels.flushRetirements(this.cfg.guildId);
      } catch (err) {
        this.last = this.fail(err);
        this.syncState.failed++;
      }
      for (const session of sessions) {
        if (
          this.stopped ||
          this.held ||
          !this.cfg.enabled ||
          this.cfg.mode !== 'full' ||
          parent !== this.destinationScope()
        ) {
          this.syncState.state = 'idle';
          return this.sessionSync;
        }
        // A tab may have been deleted while the previous Discord request was in flight.
        if (!this.deps.sessions?.().some((current) => current.id === session.id)) continue;
        const result = await this.threadFor(session.id, session.name);
        if (typeof result === 'string') {
          this.syncState.ready++;
          try {
            await this.seedConversation(session.id, result);
          } catch {
            this.syncState.failed++;
            this.last = this.fail(
              new BridgeProblem('History unavailable; retry synchronization or use !codeman history')
            );
            if (this.destinationMatches(session.id, result))
              await this.deliverPost(
                result,
                {
                  content:
                    'History is unavailable or partial. Use !codeman history to retry; this session channel remains available.',
                  allowed_mentions: { parse: [], users: [] },
                },
                undefined,
                session.id,
                'history-unavailable'
              ).catch(() => undefined);
          }
        } else {
          this.syncState.failed++;
          this.last = result;
        }
      }
      this.syncState.state = this.syncState.failed ? 'error' : 'complete';
    } catch {
      this.syncState.state = 'error';
      this.syncState.failed++;
    }
    return this.sessionSync;
  }

  private conversationKey(sessionId: string, channel: string): string {
    return createHash('sha256')
      .update(JSON.stringify([this.cfg.guildId, channel, sessionId]))
      .digest('hex');
  }
  /** No body is persisted: only exact native cursors and per-turn confirmed delivery progress. */
  private seedConversation(sessionId: string, channel: string): Promise<void> {
    if (!this.deps.history || this.cfg.mode !== 'full') return Promise.resolve();
    const key = this.conversationKey(sessionId, channel);
    const pending = this.conversationRuns.get(key);
    if (pending) return pending;
    const run = (async () => {
      const history = await this.deps.history!(sessionId);
      let progress = await this.conversationProgress.get(key);
      if (!progress || progress.conversationId !== history.conversationId) {
        progress = {
          conversationId: history.conversationId,
          seed: history.turns.slice(-6).map((t) => t.cursor),
          seedIndex: 0,
          seeded: false,
          cursor: history.turns.at(-1)?.cursor,
        };
        await this.conversationProgress.set(key, progress);
      }
      if (progress.seeded) return;
      for (let i = progress.seedIndex; i < progress.seed.length; i++) {
        if (
          this.stopped ||
          !this.cfg.enabled ||
          this.cfg.mode !== 'full' ||
          !this.destinationMatches(sessionId, channel)
        )
          throw new BridgeProblem('Session changed during history sync');
        const turn = history.turns.find((t) => t.cursor === progress!.seed[i]);
        if (!turn) throw new BridgeProblem('Historical boundary expired; use !codeman history for catch-up');
        const visible = turn.role === 'assistant' ? discordDisplayText(turn.text) : turn.text;
        if (!visible.trim()) {
          progress = { ...progress, seedIndex: i + 1 };
          await this.conversationProgress.set(key, progress);
          continue;
        }
        const text =
          '**Historical context**' +
          (history.partial ? ' (partial)' : '') +
          '\n' +
          renderHistory([{ ...turn, text: clip(visible, 1000) }], { includeTimestamps: false }) +
          '\n`!codeman history` / `!codeman transcript` for more';
        await this.deliverPost(
          channel,
          { content: text, allowed_mentions: { parse: [], users: [] } },
          undefined,
          sessionId,
          `history:${turn.cursor}`
        );
        progress = { ...progress, seedIndex: i + 1 };
        await this.conversationProgress.set(key, progress);
      }
      progress = { ...progress, seeded: true };
      await this.conversationProgress.set(key, progress);
    })().finally(() => {
      if (this.conversationRuns.get(key) === run) this.conversationRuns.delete(key);
    });
    this.conversationRuns.set(key, run);
    return run;
  }

  /** Bounded round-robin polling: only native text, never redraw/scrollback snapshots. */
  async pollConversations(): Promise<void> {
    if (this.stopped || this.held || !this.cfg.enabled || this.cfg.mode !== 'full' || !this.deps.history) return;
    await this.refreshControls();
    const sessions = this.deps.sessions?.() ?? [];
    if (!sessions.length) return;
    const batch = Array.from(
      { length: Math.min(8, sessions.length) },
      (_, i) => sessions[(this.outputIndex + i) % sessions.length]
    );
    this.outputIndex = (this.outputIndex + batch.length) % sessions.length;
    const reads: Promise<void>[] = [];
    for (const session of batch) {
      if (this.outputReads.has(session.id) || (this.outputDue.get(session.id) ?? 0) > this.now()) continue;
      const remote = !!session.remote;
      if ([...this.outputReads.values()].filter((r) => r.remote === remote).length >= (remote ? 2 : 4)) continue;
      const channel = this.channels.channelForSession(this.cfg, session.id);
      if (!channel) continue;
      this.outputDue.set(
        session.id,
        this.now() + (remote ? (session.working ? 10000 : 60000) : session.working ? 3000 : 15000)
      );
      const run = this.observeConversation(session.id, channel)
        .catch(() => {
          this.last = this.fail(
            new BridgeProblem(
              'Live output paused: transcript/delivery boundary unavailable; use status/history or retry synchronization'
            )
          );
        })
        .finally(() => {
          if (this.outputReads.get(session.id)?.run === run) this.outputReads.delete(session.id);
        });
      this.outputReads.set(session.id, { remote, run });
      reads.push(run);
    }
    await Promise.all(reads);
  }
  private async observeConversation(sessionId: string, channel: string): Promise<void> {
    await this.seedConversation(sessionId, channel);
    const key = this.conversationKey(sessionId, channel);
    const active = this.conversationRuns.get(key);
    if (active) {
      await active;
      return;
    }
    const run = (async () => {
      let progress = await this.conversationProgress.get(key);
      if (!progress?.seeded) return;
      if (progress.streamOff) return;
      const history = await this.deps.history!(sessionId, { includeTools: progress.verbose });
      if (history.conversationId !== progress.conversationId)
        throw new BridgeProblem('Conversation changed; synchronize history first');
      await this.deliveries.reconcileNative(sessionId, history);
      const at = progress.cursor ? history.turns.findIndex((t) => t.cursor === progress!.cursor) : -1;
      if (progress.cursor && at < 0) throw new BridgeProblem('Live boundary expired; request history');
      for (const turn of history.turns.slice(at + 1, at + 21)) {
        if (
          this.stopped ||
          !this.cfg.enabled ||
          this.cfg.mode !== 'full' ||
          !this.destinationMatches(sessionId, channel)
        )
          throw new BridgeProblem('Session changed');
        if (turn.role === 'assistant' || (turn.role === 'tool' && progress.verbose)) {
          const visible = turn.role === 'assistant' ? discordDisplayText(turn.text) : turn.text;
          const chunks = splitForDiscord(
            tablesToCodeBlocks((turn.role === 'tool' ? '**Tool output**\n' : '') + visible)
          );
          for (const [i, content] of chunks.entries())
            await this.deliverPost(
              channel,
              { content, allowed_mentions: { parse: [], users: [] } },
              undefined,
              sessionId,
              `native:${turn.cursor}:${i}`
            );
          if (visible.length > 12000)
            await this.deliverPost(
              channel,
              { content: 'Full user-visible response', allowed_mentions: { parse: [], users: [] } },
              { name: 'response.txt', data: Buffer.from(visible) },
              sessionId,
              `native:${turn.cursor}:overflow`
            );
        }
        progress = { ...progress, cursor: turn.cursor };
        await this.conversationProgress.set(key, progress);
      }
      const latest = history.executions?.at(-1);
      const stateLabels = {
        submitted: '📨 Sent to the agent',
        running: '⏳ Working…',
        completed: '✅ Done',
        interrupted: '⏸️ Interrupted',
        execution_error: '⚠️ Task failed',
      };
      const status = this.deps.awaitingChoice?.(sessionId)
        ? '❓ Needs your answer'
        : latest
          ? stateLabels[latest.state]
          : this.deps.sessions?.().find((s) => s.id === sessionId)?.working
            ? '⏳ Working…'
            : '💬 Ready for your next message';
      const hash = createHash('sha256').update(status).digest('hex');
      if (progress.statusHash !== hash) {
        if (
          this.stopped ||
          !this.cfg.enabled ||
          this.cfg.mode !== 'full' ||
          !this.destinationMatches(sessionId, channel)
        )
          return;
        try {
          await this.channels.assertOwned(this.cfg, sessionId, channel);
          let id = progress.statusMessageId;
          if (id) {
            try {
              await this.api.editMessage(channel, id, { content: status, allowed_mentions: { parse: [], users: [] } });
            } catch (err) {
              if (!(err instanceof DiscordHttpError) || err.status !== 404) throw err;
              id = undefined;
            }
          }
          if (!id)
            id = (
              (await this.deliverPost(
                channel,
                { content: status, allowed_mentions: { parse: [], users: [] } },
                undefined,
                sessionId,
                `native-status:${progress.conversationId}:${progress.statusMessageId ?? 'initial'}`
              )) as { id?: string }
            )?.id;
          progress = { ...progress, statusMessageId: id, statusHash: hash };
          await this.conversationProgress.set(key, progress);
        } catch {
          // Native cursor progress is already durable. A cosmetic status failure must not
          // resend the response body through the idle-alert fallback; retry status next poll.
          this.last = this.fail(new BridgeProblem('Response delivered; its status could not be updated yet'));
        }
      }
    })().finally(() => {
      if (this.conversationRuns.get(key) === run) this.conversationRuns.delete(key);
    });
    this.conversationRuns.set(key, run);
    await run;
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
    if (this.cfg.mode === 'full') return;
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
      if (c.mode === 'full') return 0;
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
    this.stopped = false;
    this.cfg = await readDiscordConfig(this.deps.configDir);
    // The thread map is read once, by whoever gets here first; everyone else waits for that read. A second
    // read finishing later would replace the map and drop threads made in between.
    this.mapLoad ??= readThreadFile(this.deps.configDir).then((saved) => {
      this.threads = { ...saved.threads, ...this.threads };
      this.threadsParent ||= saved.parent;
      this.threadScopes = saved.scopes;
      this.threadsScope = saved.scope || (saved.parent ? JSON.stringify([this.cfg.guildId, saved.parent]) : '');
      if (this.threadsScope) this.threadScopes[this.threadsScope] = this.threads;
      this.loaded = true;
    });
    await this.mapLoad;
    try {
      await this.channels.load();
      this.channels.resetBotIdentity();
      await this.deliveries.load();
    } catch (err) {
      this.last = this.fail(err);
      this.gateway?.stop();
      this.gateway = null;
      this.gatewayToken = '';
      throw err;
    }
    // Threads belong to the channel they were made under: a new parent channel (or guild) starts afresh,
    // or every tab would keep posting into the old one.
    const parent = this.cfg.parentChannelId;
    const scope = JSON.stringify([this.cfg.guildId, parent]);
    if (parent && scope !== this.threadsScope) {
      if (this.threadsScope) this.threadScopes[this.threadsScope] = this.threads;
      this.threads = this.threadScopes[scope] ?? {};
      this.threadScopes[scope] = this.threads;
      this.threadsScope = scope;
      this.pending.clear();
      this.closedWhilePending.clear();
      this.threadsParent = parent;
      await this.persistThreads();
    }
    activeStartupHint = this.cfg.enabled && this.cfg.token && this.cfg.startupHint ? DISCORD_STARTUP_HINT : undefined;
    // A save that changed neither the switch nor the token keeps the gateway session, so it can resume.
    // A gateway that gave up (a fatal close, such as a missing intent) is replaced, or a fix could never take.
    const want = this.cfg.enabled && this.cfg.token && !this.held ? this.cfg.token : '';
    if (want)
      void this.channels.flushRetirements(this.cfg.guildId).catch((err) => {
        this.last = this.fail(err);
      });
    // Do not hold Settings saves behind a potentially large series of Discord requests.
    if (want && this.cfg.mode === 'full') {
      this.syncQueued ||= !!this.syncRun;
      void this.syncSessions().catch(() => undefined);
    }
    if (want && this.cfg.mode === 'full' && this.deps.history && !this.outputTimer) {
      this.outputTimer = setInterval(() => void this.pollConversations().catch(() => undefined), 5000);
      this.outputTimer.unref();
    } else if (!want || this.cfg.mode !== 'full') {
      clearInterval(this.outputTimer);
      this.outputTimer = undefined;
    }
    if (this.gateway && this.gateway.state !== 'error' && want && want === this.gatewayToken) return;
    this.gateway?.stop();
    this.gateway = null;
    this.gatewayToken = want;
    if (want) {
      this.gateway = new DiscordGateway(
        () => this.cfg.token,
        (m) => void this.onGatewayMessage(m).catch(() => undefined),
        this.deps.socketFactory,
        this.deps.backoffMs,
        (interaction) => void this.onGatewayInteraction(interaction).catch(() => undefined)
      );
      this.gateway.start();
    }
  }

  stop(): void {
    this.stopped = true;
    this.actions.clear();
    this.syncQueued = false;
    clearInterval(this.outputTimer);
    this.outputTimer = undefined;
    clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
    this.gateway?.stop();
    this.gateway = null;
    this.gatewayToken = '';
    activeStartupHint = undefined;
    this.lastSent.clear();
    this.lastReply.clear();
    this.names.clear();
    this.lastFull.clear();
    this.inbound.clear();
  }

  private fail(err: unknown): DiscordResult {
    const status = err instanceof DiscordHttpError ? err.status : undefined;
    const code = err instanceof DiscordHttpError ? err.code : undefined;
    const error =
      code === 30013 || code === 30030
        ? 'Discord channel capacity reached; choose another case category or free unused channels'
        : status === 401
          ? 'The bot token was refused'
          : status === 403 || code === 50001
            ? 'The bot cannot see the parent channel (check its role and the channel ID)'
            : status === 404
              ? 'Channel not found (check the IDs)'
              : status
                ? `HTTP ${status}`
                : err instanceof BridgeProblem ||
                    err instanceof DiscordDeliveryError ||
                    err instanceof DiscordChannelProblem
                  ? err.message
                  : (err as { name?: string })?.name === 'TimeoutError'
                    ? 'Timed out'
                    : 'Network error';
    return { ok: false, status, error, at: this.now() };
  }

  private persistThreads(): Promise<void> {
    const revision = ++this.mapRevision;
    const parent = this.threadsParent;
    const threads = { ...this.threads };
    const scope = this.threadsScope;
    this.threadScopes[scope] = this.threads;
    const scopes = Object.fromEntries(Object.entries(this.threadScopes).map(([key, map]) => [key, { ...map }]));
    const run = this.persistChain
      .catch(() => undefined)
      .then(() => writeThreadMap(this.deps.configDir, parent, threads, scope, scopes))
      .then(() => {
        this.persistedMapRevision = revision;
      })
      .catch(() => {
        const error = new BridgeProblem('Discord session mapping could not be saved; retry after checking storage');
        this.last = this.fail(error);
        throw error;
      });
    this.persistChain = run;
    return run;
  }

  /** The thread for a session, creating it when absent. Concurrent callers share one creation. */
  private threadFor(sessionId: string, name: string | undefined): Promise<string | DiscordResult> {
    if (this.cfg.mode === 'full') {
      const scope = this.destinationScope();
      return this.channels
        .forSession(this.cfg, sessionId, name)
        .then((id) =>
          scope === this.destinationScope()
            ? id
            : this.fail(new BridgeProblem('Discord destination configuration changed'))
        )
        .catch((err) => this.fail(err));
    }
    const existing = this.threads[sessionId];
    if (existing)
      return this.persistedMapRevision < this.mapRevision
        ? this.persistThreads().then(
            () => existing,
            (err) => this.fail(err)
          )
        : Promise.resolve(existing);
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
  notify(msg: DiscordMessage, opts: { urgent?: boolean; deliberate?: boolean } = {}): Promise<DiscordResult | null> {
    if (this.pendingNotifications >= 128)
      return Promise.resolve(this.fail(new BridgeProblem('Discord delivery queue is full')));
    this.pendingNotifications++;
    const key = msg.sessionId ?? '@general';
    const run = (this.outbound.get(key) ?? Promise.resolve())
      .then(() => this.notifyNow(msg, opts))
      .catch((err) => (this.last = this.fail(err)));
    this.outbound.set(key, run);
    return run.finally(() => {
      this.pendingNotifications--;
      if (this.outbound.get(key) === run) this.outbound.delete(key);
    });
  }

  private async notifyNow(
    msg: DiscordMessage,
    opts: { urgent?: boolean; deliberate?: boolean }
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
    // Native conversation output owns routine responses in Full mode. Await the exact destination's
    // observer before suppressing an alert, so a failed/off stream retains its fallback notification.
    if (
      this.cfg.mode === 'full' &&
      this.deps.history &&
      msg.sessionId &&
      !opts.deliberate &&
      !msg.file &&
      ['hook:idle_prompt', 'hook:stop'].includes(msg.event) &&
      !this.deps.awaitingChoice?.(msg.sessionId)
    ) {
      try {
        const channel = await this.threadFor(msg.sessionId, msg.sessionName);
        if (typeof channel === 'string') {
          await this.observeConversation(msg.sessionId, channel);
          const progress = await this.conversationProgress.get(this.conversationKey(msg.sessionId, channel));
          if (
            progress?.seeded &&
            !!progress.cursor &&
            !progress.streamOff &&
            !this.deps.awaitingChoice?.(msg.sessionId) &&
            this.cfg.mode === 'full' &&
            this.cfg.enabled &&
            !this.stopped &&
            this.destinationMatches(msg.sessionId, channel)
          )
            return { ok: true, deduped: true, at: this.now() };
        }
      } catch {
        /* preserve the ordinary alert when native delivery is unavailable */
      }
    }
    let chunks: string[] = [];
    // Remembered only once the first post is out: a failed post must leave the message to be sent again.
    let posted: string | undefined;
    if (msg.fullText) {
      try {
        const got = await withTimeout(msg.fullText(), FULL_TEXT_TIMEOUT_MS);
        const text = got?.text ? discordDisplayText(got.text).trim() : undefined;
        const sid = msg.sessionId;
        if (got?.text && !text) msg = { ...msg, tail: undefined };
        if (text && sid) {
          // Keyed on the text and the turn it came from, so a later turn that ends on the same words is posted.
          const key = `${got?.version ?? ''}\u0000${text}`;
          msg = { ...msg, tail: undefined };
          if (this.lastFull.get(sid) !== key) {
            chunks = splitForDiscord(tablesToCodeBlocks(text.slice(0, MAX_CONVERTED_TEXT)), 1520);
            posted = key;
          } // else: said already, so only the header goes
        }
      } catch {
        // no transcript to read: the screen tail stands in
      }
    }
    if (this.cfg.mode === 'full' && msg.sessionId && msg.urgency !== 'info' && this.deps.control) {
      try {
        const prompt = await this.deps.control(msg.sessionId, 'pending');
        if (prompt.actions?.length) {
          const channel = await this.threadFor(msg.sessionId, msg.sessionName);
          if (typeof channel === 'string') {
            await this.postControlReply(
              msg.sessionId,
              channel,
              prompt,
              `pending:${msg.sessionId}:${createHash('sha256').update(prompt.text).digest('hex')}`,
              shouldPing(this.cfg.pingMode, msg.urgency, explicitUrgent)
            );
            return { ok: true, at: this.now() };
          }
        }
      } catch {
        /* preserve the ordinary alert if structured controls are unavailable */
      }
    }
    const post = buildPost(msg, this.cfg, explicitUrgent);
    // One post when the head and the first part fit together, the rest follow without a ping.
    if (chunks.length > 0) {
      post.content = clip(post.content, 350);
      post.content += `\n${chunks.shift()}`;
    }
    // Claimed just before the first post and given back if it fails, so an alert for the same tab that
    // overlaps this one does not post the message too, and a failed post is still sent again.
    let claimed: { sid: string; before: string | undefined } | undefined;
    try {
      let target = this.cfg.parentChannelId;
      if (msg.sessionId) {
        const thread = await this.threadFor(msg.sessionId, msg.sessionName);
        if (typeof thread !== 'string') {
          this.lastSent.delete(key);
          return (this.last = thread);
        }
        target = thread;
      }
      const deliveryKey = !opts.deliberate && posted ? `${msg.sessionId}:${posted}` : randomUUID();
      const send = (to: string) => this.deliverPost(to, post, msg.file, msg.sessionId, `${deliveryKey}:0`);
      if (posted && msg.sessionId) {
        claimed = { sid: msg.sessionId, before: this.lastFull.get(msg.sessionId) };
        this.lastFull.set(msg.sessionId, posted);
      }
      try {
        await send(target);
      } catch (err) {
        // The thread was deleted by hand: forget it, make a new one, once.
        if (msg.sessionId && err instanceof DiscordHttpError && err.status === 404) {
          if (this.cfg.mode !== 'full') delete this.threads[msg.sessionId];
          const fresh = await this.threadFor(msg.sessionId, msg.sessionName);
          if (typeof fresh !== 'string')
            throw new BridgeProblem(fresh.error ?? 'Could not recreate the session thread');
          target = fresh;
          await send(fresh);
        } else {
          throw err;
        }
      }
      // Every part must be delivered; a missing tail must never be reported as a successful response.
      for (const [i, part] of chunks.entries())
        await this.deliverPost(
          this.cfg.mode === 'full' ? target : (this.threads[msg.sessionId ?? ''] ?? target),
          { content: part, allowed_mentions: { parse: [], users: [] } },
          undefined,
          msg.sessionId,
          `${deliveryKey}:${i + 1}`
        );
      return (this.last = { ok: true, at: this.now() });
    } catch (err) {
      this.lastSent.delete(key);
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
  async sessionCreated(sessionId: string, name: string | undefined): Promise<void> {
    await this.ensureLoaded();
    if (!this.cfg.enabled || this.stopped) return;
    if (this.cfg.mode === 'full' ? this.held : this.cfg.threadCreation !== 'onSessionStart') return;
    const made = await this.threadFor(sessionId, name);
    if (typeof made !== 'string') this.last = made;
    else if (this.cfg.mode === 'full')
      await this.seedConversation(sessionId, made).catch(() => {
        this.last = this.fail(new BridgeProblem('History unavailable; retry synchronization to seed it'));
      });
  }

  async sessionRenamed(sessionId: string, name: string | undefined): Promise<void> {
    const seen = this.names.get(sessionId);
    this.names.set(sessionId, name ?? '');
    // First sight only records the name: the thread was made with it, so a PATCH would spend a rename for nothing.
    if (seen === undefined || seen === (name ?? '')) return;
    if (this.cfg.enabled && this.cfg.mode === 'full') {
      await this.channels.rename(this.cfg, sessionId, name).catch((err) => {
        this.last = this.fail(err);
      });
      return;
    }
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
    this.outputDue.delete(sessionId);
    this.lastReply.delete(sessionId);
    this.names.delete(sessionId);
    this.lastFull.delete(sessionId);
  }

  /** Session tab deleted: apply `onSessionDelete` and forget the mapping. */
  async sessionDeleted(sessionId: string): Promise<void> {
    this.forgetTab(sessionId);
    await this.channels
      .deleted(sessionId, this.cfg.onSessionDelete, this.cfg.enabled ? this.cfg.guildId : undefined)
      .catch((err) => {
        this.last = this.fail(err);
      });
    // Full mode preserves legacy notification resources after switching layouts.
    if (this.cfg.mode === 'full') return;
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

  private async deliverPost(
    channelId: string,
    post: DiscordPost,
    file: DiscordFile | undefined,
    sessionId: string | undefined,
    key: string
  ): Promise<unknown> {
    if (this.cfg.mode === 'full' && sessionId) {
      if (!this.destinationMatches(sessionId, channelId)) throw new BridgeProblem('Discord destination changed');
      if (sessionId.startsWith('__case__:'))
        await this.channels.assertCaseOwned(this.cfg, sessionId.slice(9), channelId);
      else if (sessionId !== '__management__') await this.channels.assertOwned(this.cfg, sessionId, channelId);
    }
    const id = createHash('sha256').update(`${this.cfg.guildId}:${channelId}:${key}`).digest('hex');
    const hash = createHash('sha256').update(
      JSON.stringify({ content: post.content, components: post.components, file: file?.name })
    );
    if (file) hash.update(file.data);
    const payloadHash = hash.digest('hex');
    const claim = await this.deliveries.claim({
      id,
      direction: 'outbound',
      sessionId,
      channelId,
      guildId: this.cfg.guildId,
      payloadHash,
    });
    if (!claim.fresh && claim.record.payloadHash !== payloadHash)
      throw new BridgeProblem('Response formatting changed since the previous delivery; review it before resending');
    if (!claim.fresh && claim.record.state === 'delivered') return { id: claim.record.messageId };
    if (!claim.fresh && ['uncertain', 'submitting'].includes(claim.record.state)) {
      throw new BridgeProblem('Previous Discord delivery is uncertain; it will not be replayed automatically');
    }
    await this.deliveries.update(id, 'submitting');
    const payload = { ...post, nonce: id.slice(0, 24), enforce_nonce: true };
    try {
      const result = file
        ? await this.api.postWithFile(channelId, payload, file)
        : await this.api.post(channelId, payload);
      if (!result?.id) throw new BridgeProblem('Discord did not confirm delivery');
      await this.deliveries.annotate(id, { messageId: result.id });
      await this.deliveries.update(id, 'delivered');
      return result;
    } catch (err) {
      const refused = err instanceof DiscordHttpError && err.status < 500;
      await this.deliveries.update(
        id,
        refused ? 'failed' : 'uncertain',
        refused ? 'discord_refused' : 'delivery_uncertain'
      );
      throw err;
    }
  }

  private say(channelId: string, content: string): Promise<unknown> {
    return this.api.post(channelId, { content, allowed_mentions: { parse: [], users: [] } }).catch(() => undefined);
  }

  private async postControlReply(
    sessionId: string,
    channel: string,
    result: DiscordControlReply,
    key: string,
    notifyUsers = false
  ): Promise<void> {
    if (result.locateSessionId) {
      if (!this.deps.sessions?.().some((s) => s.id === result.locateSessionId))
        throw new BridgeProblem('Session no longer exists');
      const destination = await this.threadFor(result.locateSessionId, undefined);
      result = {
        ...result,
        text:
          result.text +
          (typeof destination === 'string'
            ? '\n<#' + destination + '>'
            : '\nDestination unavailable; retry synchronization.'),
      };
    }
    const users = notifyUsers ? this.cfg.allowedUserIds.slice(0, 20) : [];
    const mentions = users.length ? users.map((id) => `<@${id}>`).join(' ') + '\n' : '';
    const ids: string[] = [];
    for (const action of (result.actions ?? []).slice(0, 5)) {
      if (this.actions.size >= 256) break;
      const id =
        'codeman:' +
        createHash('sha256')
          .update(key + ':' + action.command)
          .digest('hex')
          .slice(0, 32);
      ids.push(id);
      this.actions.set(id, { ...action, sessionId, channel, expiresAt: this.now() + 10 * 60 * 1000 });
    }
    const components = ids.length
      ? [
          {
            type: 1,
            components: ids.map((id, i) => ({
              type: 2,
              style: result.actions![i].style ?? 2,
              label: result.actions![i].label.slice(0, 80),
              custom_id: id,
            })),
          },
        ]
      : undefined;
    for (const [i, content] of splitForDiscord(tablesToCodeBlocks(result.text), 1900 - mentions.length).entries()) {
      const posted = (await this.deliverPost(
        channel,
        {
          content: (i === 0 ? mentions : '') + content,
          allowed_mentions: { parse: [], users: i === 0 ? users : [] },
          components: i === 0 ? components : undefined,
        },
        i === 0 ? result.file : undefined,
        sessionId,
        key + ':' + i
      )) as { id?: string };
      if (i === 0)
        for (const id of ids) {
          const action = this.actions.get(id);
          if (action) action.messageId = posted?.id;
        }
    }
  }
  private async refreshControls(): Promise<void> {
    const disabled = new Set<string>();
    for (const [id, action] of this.actions) {
      if (
        action.expiresAt > this.now() &&
        this.destinationMatches(action.sessionId, action.channel) &&
        this.deps.controlCurrent?.(action.sessionId, action.validity)
      )
        continue;
      this.actions.delete(id);
      if (action.messageId && !disabled.has(action.messageId)) {
        disabled.add(action.messageId);
        await this.api.editMessage(action.channel, action.messageId, { components: [] }).catch(() => undefined);
      }
    }
  }
  /** Gateway interactions need no slash-command registration or public callback server. */
  async onGatewayInteraction(m: DiscordInteraction): Promise<void> {
    if (
      !SNOWFLAKE.test(m.id) ||
      !SNOWFLAKE.test(m.application_id) ||
      typeof m.token !== 'string' ||
      !/^[\x21-\x7e]{1,2048}$/.test(m.token)
    )
      return;
    const reply = (text: string) =>
      this.api
        .respondInteraction(m.id, m.token, {
          type: 4,
          data: { content: text, flags: 64, allowed_mentions: { parse: [], users: [] } },
        })
        .catch(() => undefined);
    const user = m.member?.user?.id ?? m.user?.id;
    if (
      this.stopped ||
      !this.cfg.enabled ||
      this.cfg.mode !== 'full' ||
      m.guild_id !== this.cfg.guildId ||
      !user ||
      !this.cfg.allowedUserIds.includes(user)
    ) {
      await reply('This control is not available to this user.');
      return;
    }
    const action = m.data?.custom_id ? this.actions.get(m.data.custom_id) : undefined;
    if (
      m.type !== 3 ||
      !action ||
      action.channel !== m.channel_id ||
      action.messageId !== m.message?.id ||
      action.expiresAt <= this.now() ||
      !this.destinationMatches(action.sessionId, action.channel) ||
      !this.deps.controlCurrent?.(action.sessionId, action.validity)
    ) {
      await reply('This control expired, changed or was already resolved. Use !codeman pending again.');
      return;
    }
    // Consume every button for this prompt before any await; the shared answer service also takes atomically.
    for (const [id, bound] of this.actions)
      if (bound.sessionId === action.sessionId && bound.validity === action.validity) this.actions.delete(id);
    try {
      await this.api.respondInteraction(m.id, m.token, { type: 5, data: { flags: 64 } });
    } catch {
      return;
    }
    const key = action.channel;
    const run = (this.inbound.get(key) ?? Promise.resolve())
      .then(async () => {
        const id = `interaction:${m.guild_id}:${m.id}`;
        const claim = await this.deliveries.claim({
          id,
          direction: 'inbound',
          sessionId: action.sessionId,
          channelId: key,
          guildId: m.guild_id!,
        });
        if (!claim.fresh) return;
        if (
          !this.cfg.enabled ||
          this.stopped ||
          this.cfg.mode !== 'full' ||
          this.cfg.guildId !== m.guild_id ||
          !this.cfg.allowedUserIds.includes(user) ||
          !this.destinationMatches(action.sessionId, key) ||
          !this.deps.controlCurrent?.(action.sessionId, action.validity)
        )
          throw new BridgeProblem('Control changed');
        if (action.sessionId.startsWith('__case__:'))
          await this.channels.assertCaseOwned(this.cfg, action.sessionId.slice(9), key);
        else if (action.sessionId !== '__management__')
          await this.channels.assertOwned(this.cfg, action.sessionId, key);
        const result = await this.deps.control!(action.sessionId, action.command);
        if (result.locateSessionId)
          await this.postControlReply(action.sessionId, key, result, `interaction-result:${m.id}`);
        await this.deliveries.update(id, 'delivered');
        await this.api.finishInteraction(m.application_id, m.token, clip(result.text, 1800));
        if (action.messageId)
          await this.api.editMessage(key, action.messageId, { components: [] }).catch(() => undefined);
      })
      .catch(async () => {
        await this.api
          .finishInteraction(
            m.application_id,
            m.token,
            'Control could not be confirmed. Check status/pending before trying again; no action will be replayed automatically.'
          )
          .catch(() => undefined);
      });
    this.inbound.set(key, run);
    await run;
    if (this.inbound.get(key) === run) this.inbound.delete(key);
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
    if (!dir && !this.deps.saveRemoteAttachment)
      return { paths: [], refused: 'That tab has no available folder to save files in.' };
    // The message id goes into a file name, so it must be a snowflake and nothing else.
    if (!SNOWFLAKE.test(m.id)) return { paths: [], refused: 'That message could not be saved.' };
    const target = dir ? await ensureReceivedDir(dir) : undefined;
    if (dir && !target) return { paths: [], refused: 'The tab folder is not safe to write to, so no file was saved.' };
    const paths: string[] = [];
    const skipped: string[] = [];
    for (const [i, a] of list.entries()) {
      const name = safeAttachmentName(a.filename ?? 'file');
      if (
        i >= MAX_FILES_PER_REPLY ||
        !isDiscordCdnUrl(a.url) ||
        !(Number.isFinite(a.size) && a.size >= 0 && a.size <= MAX_FILE_BYTES)
      ) {
        skipped.push(name);
        continue;
      }
      try {
        const res = await this.deps.fetchImpl(new URL(a.url), {
          redirect: 'manual',
          signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
        });
        const buf = await boundedDiscordDownload(res);
        if (!buf || buf.byteLength > MAX_FILE_BYTES) {
          skipped.push(name);
          continue;
        }
        if (!target) {
          paths.push(await this.deps.saveRemoteAttachment!(sessionId, name, buf));
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
    if (!this.cfg.enabled || this.stopped || m.author?.bot) return;
    if (m.guild_id !== this.cfg.guildId) return;
    if (!this.cfg.allowedUserIds.includes(m.author?.id)) return;
    const mappedSessionId =
      this.cfg.mode === 'full'
        ? this.channels.sessionForChannel(this.cfg, m.channel_id)
        : Object.keys(this.threads).find((k) => this.threads[k] === m.channel_id);
    const caseKey = this.cfg.mode === 'full' ? this.channels.caseForChannel(this.cfg, m.channel_id) : undefined;
    const sessionId =
      mappedSessionId ??
      (caseKey ? '__case__:' + caseKey : undefined) ??
      (this.cfg.mode === 'full' &&
      this.cfg.parentChannelId === m.channel_id &&
      /^!codeman(?:\s|$)/i.test(m.content ?? '')
        ? '__management__'
        : undefined);
    if (!sessionId || typeof m.id !== 'string' || !m.id || m.id.length > 100) return;
    if (!m.content?.trim() && !m.attachments?.length) return;
    const id = `in:${m.guild_id}:${m.id}`;
    let claim;
    try {
      claim = await this.deliveries.claim({
        id,
        direction: 'inbound',
        sessionId,
        channelId: m.channel_id,
        guildId: m.guild_id!,
      });
    } catch {
      await this.say(m.channel_id, 'Input is paused because delivery tracking is unavailable. Nothing was typed.');
      return;
    }
    if (!claim.fresh) {
      // Redelivery must never submit the same task twice, even after a process restart.
      await this.api
        .react(
          m.channel_id,
          m.id,
          ['input_accepted', 'running', 'completed', 'delivered'].includes(claim.record.state) ? '✅' : '⏳'
        )
        .catch(() => undefined);
      return;
    }
    try {
      if (caseKey && !/^!codeman(?:\s|$)/i.test(m.content ?? '')) {
        const live = this.deps.sessions?.() ?? [];
        const threads = this.channels
          .sessionsForCase(this.cfg, caseKey)
          .filter((t) => live.some((s) => s.id === t.sessionId));
        const links = threads
          .slice(0, 10)
          .map((t) => `<#${t.threadId}> — ${threadNameFor(live.find((s) => s.id === t.sessionId)?.name, t.sessionId)}`)
          .join('\n');
        await this.postControlReply(
          sessionId,
          m.channel_id,
          {
            text:
              'Choose a session thread below. Nothing was submitted. Send messages and attachments inside that thread.\n' +
              (links || 'No active sessions. Use !codeman cases and !codeman help to create one.') +
              (threads.length > 10 ? '\nMore sessions: !codeman sessions' : ''),
          },
          `case-selection:${m.id}`
        );
        await this.deliveries.update(id, 'delivered');
        return;
      }
      if ((m.content ?? '').length > MAX_REPLY_CHARS) {
        await this.deliveries.update(id, 'failed', 'input_too_large');
        await this.say(
          m.channel_id,
          `That reply exceeds ${MAX_REPLY_CHARS.toLocaleString('en-US')} characters. Nothing was typed; shorten it or attach a file.`
        );
        return;
      }
      if (/^!codeman(?:\s|$)/i.test(m.content ?? '')) {
        if (
          this.stopped ||
          !this.cfg.enabled ||
          (this.cfg.mode !== 'full' && !/^!codeman file /i.test(m.content)) ||
          this.cfg.guildId !== m.guild_id ||
          !this.cfg.allowedUserIds.includes(m.author.id) ||
          !this.destinationMatches(sessionId, m.channel_id)
        )
          throw new BridgeProblem('Discord configuration changed');
        if (this.cfg.mode === 'full' && sessionId !== '__management__') {
          if (caseKey) await this.channels.assertCaseOwned(this.cfg, caseKey, m.channel_id);
          else await this.channels.assertOwned(this.cfg, sessionId, m.channel_id);
        }
        const command = (m.content ?? '').replace(/^!codeman\s*/i, '');
        if (
          (caseKey || sessionId === '__management__') &&
          !/^(sessions|open|cases|groups|recoveries|create|recover|reconnect|confirm|help)(?:\s|$)/i.test(command)
        ) {
          await this.postControlReply(
            sessionId,
            m.channel_id,
            {
              text: 'Open a session thread for task, history, stream and file commands. Use !codeman sessions to find it. Nothing was submitted.',
            },
            `choose-thread:${m.id}`
          );
          await this.deliveries.update(id, 'delivered');
          return;
        }
        const stream = /^stream (responses|verbose|off)$/.exec(command);
        if (stream && this.cfg.mode === 'full') {
          await this.seedConversation(sessionId, m.channel_id);
          const key = this.conversationKey(sessionId, m.channel_id);
          const progress = await this.conversationProgress.get(key);
          if (!progress) throw new BridgeProblem('History unavailable');
          await this.conversationProgress.set(key, {
            ...progress,
            verbose: stream[1] === 'verbose',
            streamOff: stream[1] === 'off',
          });
          await this.deliverPost(
            m.channel_id,
            { content: 'Live output: ' + stream[1], allowed_mentions: { parse: [], users: [] } },
            undefined,
            sessionId,
            `stream-command:${m.id}`
          );
          await this.deliveries.update(id, 'delivered');
          return;
        }
        if (!/^file(?:\s|$)/i.test(command) && this.deps.control && this.cfg.mode === 'full') {
          const result = await this.deps.control(sessionId, command);
          if (!this.destinationMatches(sessionId, m.channel_id)) throw new BridgeProblem('Session changed');
          await this.postControlReply(sessionId, m.channel_id, result, `control:${m.id}`);
          await this.deliveries.update(id, 'delivered');
          await this.api.react(m.channel_id, m.id, '✅').catch(() => undefined);
          return;
        }
        const match = /^!codeman file ([^\r\n]+)$/i.exec(m.content ?? '');
        if (!match || !this.deps.getAttachment) {
          await this.say(m.channel_id, 'Usage: !codeman file /absolute/path');
          await this.deliveries.update(id, 'failed', 'invalid_command');
          return;
        }
        try {
          await this.api.react(m.channel_id, m.id, '📤').catch(() => undefined);
          const path = match[1].replace(/^("|')(.*)\1$/, '$2');
          const file = await this.deps.getAttachment(sessionId, path);
          if (!this.destinationMatches(sessionId, m.channel_id)) throw new BridgeProblem('Session changed');
          await this.deliverPost(
            m.channel_id,
            { content: 'Session file', allowed_mentions: { parse: [], users: [] } },
            file,
            sessionId,
            `file:${m.id}`
          );
          await this.deliveries.update(id, 'delivered');
          await this.api.react(m.channel_id, m.id, '✅').catch(() => undefined);
        } catch {
          await this.deliveries.update(id, 'failed', 'transfer_failed');
          await this.say(
            m.channel_id,
            'File transfer failed. Use an existing regular file inside this session workspace, up to 8 MB; sensitive paths are blocked.'
          );
        }
        return;
      }
      const t = this.now();
      const prev = this.lastReply.get(sessionId);
      if (prev !== undefined && t - prev < REPLY_MIN_INTERVAL_MS) {
        await this.deliveries.update(id, 'failed', 'rate_limited');
        await this.api.react(m.channel_id, m.id, '⏳').catch(() => undefined);
        await this.say(
          m.channel_id,
          'That reply arrived too quickly and was not typed. Please send it again as a new message.'
        );
        return;
      }
      if (this.deps.agentExited?.(sessionId)) {
        await this.deliveries.update(id, 'failed', 'session_unavailable');
        await this.say(
          m.channel_id,
          'The agent in that tab has exited, so nothing was typed. Reconnect or recover it first.'
        );
        return;
      }
      if (this.cfg.mode === 'full' && this.deps.awaitingChoice?.(sessionId)) {
        await this.deliveries.update(id, 'failed', 'invalid_command');
        await this.say(
          m.channel_id,
          'A question or permission dialog is pending. Use its buttons or !codeman pending for a prompt-bound answer; nothing was typed.'
        );
        return;
      }
      this.lastReply.set(sessionId, t);
      if (m.attachments?.length) await this.api.react(m.channel_id, m.id, '📥').catch(() => undefined);
      const saved = await this.saveAttachments(sessionId, m);
      if (saved.paths.length && !saved.refused) await this.api.react(m.channel_id, m.id, '📎').catch(() => undefined);
      const text = sanitiseReply(m.content ?? '', saved.paths);
      if (saved.refused) await this.say(m.channel_id, saved.refused);
      if (!text || saved.refused) {
        await this.deliveries.update(id, 'failed', saved.refused ? 'transfer_failed' : 'empty');
        if (text && saved.refused)
          await this.say(
            m.channel_id,
            'Nothing was typed because an attachment failed. Send a new message after fixing the transfer.'
          );
        return;
      }
      if (this.cfg.mode === 'full' && this.deps.history) {
        try {
          const baseline = await this.deps.history(sessionId);
          await this.deliveries.annotate(id, {
            native: {
              conversationId: baseline.conversationId,
              afterCursor: baseline.turns.at(-1)?.cursor,
              promptHash: hashDiscordPrompt(text),
            },
          });
        } catch {
          /* no native proof; transport acceptance must remain unconfirmed */
        }
      }
      await this.deliveries.update(id, 'files_transferred');
      // Persist the submission boundary before the final live routing check.
      await this.deliveries.update(id, 'submitting');
      // Downloads can wait: recheck routing and permission immediately before any terminal write.
      if (
        !this.cfg.enabled ||
        this.stopped ||
        this.cfg.guildId !== m.guild_id ||
        !this.cfg.allowedUserIds.includes(m.author.id) ||
        !this.destinationMatches(sessionId, m.channel_id) ||
        this.deps.agentExited?.(sessionId)
      ) {
        await this.deliveries.update(id, 'failed', 'scope_changed');
        await this.say(m.channel_id, 'The session or Discord configuration changed. Nothing was typed.');
        return;
      }
      const keys = /^\d\r$/.test(text) && this.deps.awaitingChoice?.(sessionId) ? text.slice(0, -1) : text;
      // A crash beyond the durable boundary is ambiguous; never retry the whole input.
      if (this.cfg.mode === 'full') await this.channels.assertOwned(this.cfg, sessionId, m.channel_id);
      const ok = await this.deps.sendInput(sessionId, keys);
      await this.deliveries.update(id, ok ? 'input_accepted' : 'uncertain', ok ? undefined : 'input_uncertain');
      if (ok) await this.api.react(m.channel_id, m.id, '✅').catch(() => undefined);
      else
        await this.say(
          m.channel_id,
          'Delivery is uncertain: the tab may be gone or disconnected. Check the terminal before sending again; this message will not be replayed automatically.'
        );
    } catch {
      await this.deliveries.update(id, 'uncertain', 'input_uncertain').catch(() => undefined);
      await this.say(
        m.channel_id,
        'Delivery could not be confirmed. Check the session before sending again; this message will not be replayed automatically.'
      );
    }
  }
}
