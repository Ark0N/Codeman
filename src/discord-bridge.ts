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
 *   - A reply becomes one printable line plus Enter. Embedded newlines would submit early.
 *   - Posts never ping unless `pingMode` says so, and then only the allowlisted user ids.
 *   - A Discord outage or a bad token never reaches a session: every IO path catches and backs off.
 *
 * @module discord-bridge
 */

import { existsSync, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import WebSocket from 'ws';
import { WEBHOOK_SCOPES, type WebhookScope, type WebhookUrgency } from './types/push.js';

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

export const DISCORD_THREAD_CREATION = ['lazy', 'onSessionStart'] as const;
export type DiscordThreadCreation = (typeof DISCORD_THREAD_CREATION)[number];
export const DISCORD_ON_DELETE = ['keep', 'archive', 'delete'] as const;
export type DiscordOnDelete = (typeof DISCORD_ON_DELETE)[number];
export const DISCORD_PING_MODES = ['off', 'critical', 'all'] as const;
export type DiscordPingMode = (typeof DISCORD_PING_MODES)[number];

export interface DiscordConfig {
  enabled: boolean;
  token: string;
  guildId: string;
  parentChannelId: string;
  allowedUserIds: string[];
  threadCreation: DiscordThreadCreation;
  onSessionDelete: DiscordOnDelete;
  pingMode: DiscordPingMode;
  /** `attention` skips info-level events (a finished response); `all` sends them too. */
  scope: WebhookScope;
}

export const DEFAULT_DISCORD_CONFIG: DiscordConfig = {
  enabled: false,
  token: '',
  guildId: '',
  parentChannelId: '',
  allowedUserIds: [],
  threadCreation: 'lazy',
  onSessionDelete: 'archive',
  pingMode: 'critical',
  scope: 'attention',
};

export interface DiscordMessage {
  event: string;
  title: string;
  body: string;
  urgency: WebhookUrgency;
  sessionId?: string;
  sessionName?: string;
  /** The tail of what the CLI last printed, so the reader can see what it is asking. */
  tail?: string;
  host?: string;
}

export interface DiscordResult {
  ok: boolean;
  status?: number;
  error?: string;
  at: number;
}

export type DiscordGatewayState = 'off' | 'connecting' | 'connected' | 'error';

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

/** A Discord reply as one printable line plus Enter, or null when nothing printable is left. */
export function sanitiseReply(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  const line = raw.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  const trimmed = clip(line.trim(), MAX_REPLY_CHARS);
  return trimmed ? `${trimmed}\r` : null;
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

export interface DiscordPost {
  content: string;
  allowed_mentions: { parse: string[]; users: string[] };
}

export function buildPost(msg: DiscordMessage, cfg: DiscordConfig, explicitUrgent = false): DiscordPost {
  const ping = shouldPing(cfg.pingMode, msg.urgency, explicitUrgent) ? cfg.allowedUserIds : [];
  const mentions = ping.map((id) => `<@${id}>`).join(' ');
  const head = `${mentions ? `${mentions} ` : ''}**${clip(msg.title, 120)}**`;
  const fence = msg.tail?.trim() ? `\n\`\`\`\n${msg.tail.trim().replace(/```/g, "'''")}\n\`\`\`` : '';
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
    pingMode: oneOf(DISCORD_PING_MODES, r.pingMode, d.pingMode),
    scope: oneOf(WEBHOOK_SCOPES, r.scope, d.scope),
  };
}

export async function readDiscordConfig(configDir: string): Promise<DiscordConfig> {
  try {
    return coerce(JSON.parse(await fs.readFile(discordConfigPath(configDir), 'utf-8')));
  } catch {
    return { ...DEFAULT_DISCORD_CONFIG };
  }
}

async function writePrivate(target: string, data: unknown, mode: number): Promise<void> {
  const tmp = `${target}.${process.pid}.tmp`;
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

export async function readThreadMap(configDir: string): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(await fs.readFile(join(configDir, THREADS_FILE), 'utf-8')) as Record<string, unknown>;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && SNOWFLAKE.test(v)) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

async function writeThreadMap(configDir: string, map: Record<string, string>): Promise<void> {
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  await writePrivate(join(configDir, THREADS_FILE), map, 0o600);
}

// ---------------------------------------------------------------------------
// IO: REST
// ---------------------------------------------------------------------------

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
    const res = await this.fetchImpl(new URL(`${API}${path}`), {
      method,
      headers: {
        Authorization: `Bot ${this.token()}`,
        'Content-Type': 'application/json',
        'User-Agent': 'DiscordBot (https://github.com/Ark0N/Codeman, 1)',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
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
  rename(threadId: string, name: string): Promise<unknown> {
    return this.request('PATCH', `/channels/${threadId}`, { name });
  }
  archive(threadId: string): Promise<unknown> {
    return this.request('PATCH', `/channels/${threadId}`, { archived: true });
  }
  remove(threadId: string): Promise<unknown> {
    return this.request('DELETE', `/channels/${threadId}`);
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

export interface DiscordBridgeDeps {
  configDir: string;
  fetchImpl: DiscordFetch;
  /** Types `text` (already ending in Enter) into the session. False when the session is gone. */
  sendInput: (sessionId: string, text: string) => Promise<boolean>;
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
  private lastSent = new Map<string, number>();
  private lastReply = new Map<string, number>();
  /** The last name seen per session, so only a real rename touches the thread. */
  private names = new Map<string, string>();
  private pending = new Map<string, Promise<string | null>>();
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

  /** (Re)read the config and start or stop the gateway to match. Call at boot and after a save. */
  async reload(): Promise<void> {
    this.cfg = await readDiscordConfig(this.deps.configDir);
    if (!this.loaded) {
      this.threads = await readThreadMap(this.deps.configDir);
      this.loaded = true;
    }
    this.gateway?.stop();
    this.gateway = null;
    if (this.cfg.enabled && this.cfg.token) {
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
    this.gateway?.stop();
    this.gateway = null;
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
              : (err as { name?: string })?.name === 'TimeoutError'
                ? 'Timed out'
                : 'Network error';
    return { ok: false, status, error, at: this.now() };
  }

  /** The thread for a session, creating it when absent. Concurrent callers share one creation. */
  private threadFor(sessionId: string, name: string | undefined): Promise<string | null> {
    const existing = this.threads[sessionId];
    if (existing) return Promise.resolve(existing);
    const inflight = this.pending.get(sessionId);
    if (inflight) return inflight;
    const p = (async () => {
      try {
        const t = await this.api.createThread(this.cfg.parentChannelId, threadNameFor(name, sessionId));
        if (!t?.id) return null;
        this.threads[sessionId] = t.id;
        await writeThreadMap(this.deps.configDir, this.threads).catch(() => undefined);
        return t.id;
      } catch (err) {
        this.last = this.fail(err);
        return null;
      } finally {
        this.pending.delete(sessionId);
      }
    })();
    this.pending.set(sessionId, p);
    return p;
  }

  /** Post an alert. Session-less messages go to the parent channel. Never throws. */
  async notify(msg: DiscordMessage, explicitUrgent = false): Promise<DiscordResult | null> {
    if (!this.loaded) await this.reload();
    if (!shouldSendDiscord(this.cfg, msg.urgency)) return null;
    const key = `${msg.event}:${msg.sessionId ?? ''}`;
    const t = this.now();
    const prev = this.lastSent.get(key);
    if (!explicitUrgent && prev !== undefined && t - prev < DEDUPE_WINDOW_MS) return null;
    this.lastSent.set(key, t);
    if (this.lastSent.size > 256) {
      for (const [k, v] of this.lastSent) if (t - v > DEDUPE_WINDOW_MS) this.lastSent.delete(k);
    }
    const post = buildPost(msg, this.cfg, explicitUrgent);
    try {
      let target = this.cfg.parentChannelId;
      if (msg.sessionId) {
        const thread = await this.threadFor(msg.sessionId, msg.sessionName);
        if (!thread) return this.last;
        target = thread;
      }
      try {
        await this.api.post(target, post);
      } catch (err) {
        // The thread was deleted by hand: forget it, make a new one, once.
        if (msg.sessionId && err instanceof DiscordHttpError && err.status === 404) {
          delete this.threads[msg.sessionId];
          const fresh = await this.threadFor(msg.sessionId, msg.sessionName);
          if (!fresh) return this.last;
          await this.api.post(fresh, post);
        } else {
          throw err;
        }
      }
      return (this.last = { ok: true, at: this.now() });
    } catch (err) {
      return (this.last = this.fail(err));
    }
  }

  /** A deliberate test send to the parent channel: bypasses `enabled`, scope and dedupe. */
  async sendTest(cfg: DiscordConfig, host?: string): Promise<DiscordResult> {
    const saved = this.cfg;
    this.cfg = cfg;
    try {
      await this.api.post(
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
    } finally {
      this.cfg = saved;
    }
  }

  /** Session tab created: make its thread now when `threadCreation` is `onSessionStart`. */
  async sessionCreated(sessionId: string, name: string | undefined): Promise<void> {
    if (!this.loaded) await this.reload();
    if (!this.cfg.enabled || this.cfg.threadCreation !== 'onSessionStart') return;
    await this.threadFor(sessionId, name);
  }

  async sessionRenamed(sessionId: string, name: string | undefined): Promise<void> {
    if (this.names.get(sessionId) === (name ?? '')) return;
    this.names.set(sessionId, name ?? '');
    const thread = this.threads[sessionId];
    if (!thread || !this.cfg.enabled) return;
    await this.api.rename(thread, threadNameFor(name, sessionId)).catch(() => undefined);
  }

  /** Session tab deleted: apply `onSessionDelete` and forget the mapping. */
  async sessionDeleted(sessionId: string): Promise<void> {
    const thread = this.threads[sessionId];
    if (!thread) return;
    delete this.threads[sessionId];
    this.lastReply.delete(sessionId);
    this.names.delete(sessionId);
    await writeThreadMap(this.deps.configDir, this.threads).catch(() => undefined);
    if (!this.cfg.enabled) return;
    if (this.cfg.onSessionDelete === 'delete') await this.api.remove(thread).catch(() => undefined);
    else if (this.cfg.onSessionDelete === 'archive') await this.api.archive(thread).catch(() => undefined);
  }

  /** Inbound reply. Every gate here drops silently: a stranger learns nothing. */
  async onGatewayMessage(m: GatewayMessage): Promise<void> {
    if (!this.cfg.enabled || m.author?.bot) return;
    if (m.guild_id !== this.cfg.guildId) return;
    if (!this.cfg.allowedUserIds.includes(m.author?.id)) return;
    const sessionId = Object.keys(this.threads).find((k) => this.threads[k] === m.channel_id);
    if (!sessionId) return;
    const t = this.now();
    const prev = this.lastReply.get(sessionId);
    if (prev !== undefined && t - prev < REPLY_MIN_INTERVAL_MS) return;
    this.lastReply.set(sessionId, t);
    const text = sanitiseReply(m.content ?? '');
    if (!text) return;
    const ok = await this.deps.sendInput(sessionId, text).catch(() => false);
    const reply = ok
      ? this.api.react(m.channel_id, m.id, '✅')
      : this.api.post(m.channel_id, {
          content: 'That tab is gone, so nothing was typed.',
          allowed_mentions: { parse: [], users: [] },
        });
    await reply.catch(() => undefined);
  }
}
