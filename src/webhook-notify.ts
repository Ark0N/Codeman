/**
 * @fileoverview Webhook notifications (ntfy, Slack, Discord, generic JSON) for the events that
 * already trigger Web Push, so a headless server can reach a phone without a browser tab or a
 * push subscription.
 *
 * Split in three, so the parts that matter are testable without a network:
 *   - pure: `webhookUrlProblem`, `maskWebhookUrl`, `shouldSendWebhook`, `buildWebhookRequest`
 *   - store: `~/.codeman/webhook.json`, written 0600 via tmp+rename (the URL is a bearer secret:
 *     anyone holding a Slack/Discord webhook URL can post as it)
 *   - IO: `sendWebhook` (injected fetch) and `WebhookNotifier` (dedupe, in-flight cap, last result)
 *
 * Rules the code keeps and the tests pin:
 *   - The URL is configured only through the admin-only `/api/webhook` routes and kept OUT of
 *     `settings.json`, which every logged-in user can read through `GET /api/settings`.
 *   - Delivery goes through `webviewFetch`: link-local and cloud-metadata targets are refused on
 *     the RESOLVED address at connect time, redirects are not followed, and the call is bounded
 *     by a timeout. Loopback and LAN stay allowed on purpose (a local ntfy is the feature).
 *   - The URL never appears in a log line, a result, or an error message.
 *   - Session names and error text are user/agent-controlled, so they cannot ping a channel:
 *     Discord gets `allowed_mentions: { parse: [] }` and Slack control characters are escaped.
 *
 * @module webhook-notify
 */

import { existsSync, mkdirSync } from 'node:fs';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { blockedWebviewHostReason } from './web/webview-egress-policy.js';
import { isEgressBlockedError } from './web/webview-egress.js';
import {
  WEBHOOK_KINDS,
  WEBHOOK_SCOPES,
  type WebhookConfig,
  type WebhookKind,
  type WebhookResult,
  type WebhookScope,
  type WebhookUrgency,
} from './types/push.js';

const WEBHOOK_FILE = 'webhook.json';
const MAX_URL_LENGTH = 2048;
const SEND_TIMEOUT_MS = 5000;
const MAX_BODY_CHARS = 500;
/** Same event + session within this window is sent once: a flapping prompt must not flood a channel. */
const DEDUPE_WINDOW_MS = 3000;
const MAX_IN_FLIGHT = 5;

export const DEFAULT_WEBHOOK_CONFIG: WebhookConfig = { enabled: false, kind: 'ntfy', url: '', scope: 'attention' };

export interface WebhookMessage {
  event: string;
  title: string;
  body: string;
  urgency: WebhookUrgency;
  sessionId?: string;
  sessionName?: string;
  /** The Codeman instance's window title, so several machines are told apart. */
  host?: string;
}

// ---------------------------------------------------------------------------
// Pure
// ---------------------------------------------------------------------------

/** Why `raw` cannot be a webhook URL, or null. Used at save time; delivery re-checks the resolved address. */
export function webhookUrlProblem(raw: string): string | null {
  if (raw.length > MAX_URL_LENGTH) return 'URL is too long';
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Not a valid URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Only http and https URLs are allowed';
  if (url.username || url.password) return 'Put credentials in the path or a header-less token, not user:password@';
  const blocked = blockedWebviewHostReason(url.hostname);
  if (blocked) return `Refused: ${blocked}`;
  return null;
}

/** Scheme + host only: the path and query of a webhook URL are the secret. */
export function maskWebhookUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}/•••`;
  } catch {
    return '';
  }
}

export function shouldSendWebhook(cfg: WebhookConfig, urgency: WebhookUrgency): boolean {
  if (!cfg.enabled || !cfg.url) return false;
  return cfg.scope === 'all' || urgency !== 'info';
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A header value must be single-line printable ASCII; anything else goes out RFC 2047 encoded. */
function headerSafe(value: string): string {
  const oneLine = value.replace(/[\r\n]+/g, ' ').trim();
  return /^[\x20-\x7e]*$/.test(oneLine) ? oneLine : `=?UTF-8?B?${Buffer.from(oneLine, 'utf8').toString('base64')}?=`;
}

/** Slack parses `<!channel>`, `<@U123>` and `<url|text>`; escaping the three control characters turns them to text. */
const slackEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const NTFY_PRIORITY: Record<WebhookUrgency, string> = { critical: '5', warning: '4', info: '3' };
const NTFY_TAGS: Record<WebhookUrgency, string> = {
  critical: 'rotating_light',
  warning: 'bell',
  info: 'white_check_mark',
};

export interface WebhookRequest {
  method: 'POST';
  headers: Record<string, string>;
  body: string;
}

export function buildWebhookRequest(kind: WebhookKind, msg: WebhookMessage, now: Date = new Date()): WebhookRequest {
  const title = clip(msg.title, 120);
  const body = clip(msg.body, MAX_BODY_CHARS);
  const prefix = msg.host ? `${clip(msg.host, 60)}: ` : '';
  switch (kind) {
    case 'ntfy':
      return {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          Title: headerSafe(`${prefix}${title}`),
          Priority: NTFY_PRIORITY[msg.urgency],
          Tags: NTFY_TAGS[msg.urgency],
        },
        body: body || title,
      };
    case 'slack':
      return {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: `*${slackEscape(`${prefix}${title}`)}*${body ? `\n${slackEscape(body)}` : ''}` }),
      };
    case 'discord':
      return {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: clip(`**${prefix}${title}**${body ? `\n${body}` : ''}`, 1900),
          // Agent output and session names are not trusted to @everyone a channel.
          allowed_mentions: { parse: [] },
        }),
      };
    case 'generic':
      return {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: msg.event,
          title,
          body,
          urgency: msg.urgency,
          sessionId: msg.sessionId ?? null,
          sessionName: msg.sessionName ?? null,
          host: msg.host ?? null,
          at: now.toISOString(),
        }),
      };
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function webhookConfigPath(configDir: string): string {
  return join(configDir, WEBHOOK_FILE);
}

function coerce(raw: unknown): WebhookConfig {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    enabled: r.enabled === true,
    kind: (WEBHOOK_KINDS as readonly unknown[]).includes(r.kind)
      ? (r.kind as WebhookKind)
      : DEFAULT_WEBHOOK_CONFIG.kind,
    url: typeof r.url === 'string' ? r.url : '',
    scope: (WEBHOOK_SCOPES as readonly unknown[]).includes(r.scope)
      ? (r.scope as WebhookScope)
      : DEFAULT_WEBHOOK_CONFIG.scope,
  };
}

export async function readWebhookConfig(configDir: string): Promise<WebhookConfig> {
  try {
    return coerce(JSON.parse(await fs.readFile(webhookConfigPath(configDir), 'utf-8')));
  } catch {
    return { ...DEFAULT_WEBHOOK_CONFIG };
  }
}

/** 0600 via tmp+rename: `mode` on writeFile only applies to a file being created. */
export async function writeWebhookConfig(configDir: string, cfg: WebhookConfig): Promise<void> {
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  const target = webhookConfigPath(configDir);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(coerce(cfg), null, 2), { mode: 0o600 });
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

export type WebhookFetch = (target: URL, init: RequestInit) => Promise<Response>;

/**
 * What went wrong, without the URL: blocked / timed out / refused / an HTTP status. An egress
 * refusal is recognised by its `CODEMAN_EGRESS_BLOCKED` code anywhere in the cause chain (undici
 * wraps the lookup's error as `TypeError('fetch failed', { cause })`), never by message text.
 */
function describeError(err: unknown): string {
  const e = err as { name?: string; cause?: { code?: string } };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'Timed out';
  if (isEgressBlockedError(err)) return 'Refused: target is a link-local or cloud-metadata address';
  if (e?.cause?.code === 'ENOTFOUND') return 'Host not found';
  if (e?.cause?.code === 'ECONNREFUSED') return 'Connection refused';
  return 'Network error';
}

export async function sendWebhook(
  cfg: Pick<WebhookConfig, 'kind' | 'url'>,
  msg: WebhookMessage,
  fetchImpl: WebhookFetch
): Promise<WebhookResult> {
  const at = Date.now();
  const problem = webhookUrlProblem(cfg.url);
  if (problem) return { ok: false, error: problem, at };
  const req = buildWebhookRequest(cfg.kind, msg);
  try {
    const res = await fetchImpl(new URL(cfg.url), {
      method: req.method,
      headers: req.headers,
      body: req.body,
      redirect: 'manual',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    void res.body?.cancel().catch(() => undefined);
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, status: res.status, error: 'The URL redirects; use the final URL', at };
    }
    return res.ok
      ? { ok: true, status: res.status, at }
      : { ok: false, status: res.status, error: `HTTP ${res.status}`, at };
  } catch (err) {
    return { ok: false, error: describeError(err), at };
  }
}

/**
 * Sends the notifications the server decides on. Fire-and-forget by design (a slow webhook must
 * never delay Web Push or a request), so it dedupes, caps what is in flight, and remembers only
 * the last result for the Settings status line.
 */
export class WebhookNotifier {
  private lastSent = new Map<string, number>();
  private inFlight = 0;
  private last: WebhookResult | null = null;

  constructor(
    private readonly load: () => Promise<WebhookConfig>,
    private readonly fetchImpl: WebhookFetch,
    private readonly now: () => number = Date.now
  ) {}

  get lastResult(): WebhookResult | null {
    return this.last;
  }

  async notify(msg: WebhookMessage): Promise<void> {
    const cfg = await this.load();
    if (!shouldSendWebhook(cfg, msg.urgency)) return;
    const key = `${msg.event}:${msg.sessionId ?? ''}`;
    const t = this.now();
    const prev = this.lastSent.get(key);
    if (prev !== undefined && t - prev < DEDUPE_WINDOW_MS) return;
    if (this.inFlight >= MAX_IN_FLIGHT) return;
    this.lastSent.set(key, t);
    if (this.lastSent.size > 256) {
      for (const [k, v] of this.lastSent) if (t - v > DEDUPE_WINDOW_MS) this.lastSent.delete(k);
    }
    this.inFlight++;
    try {
      this.last = await sendWebhook(cfg, msg, this.fetchImpl);
    } finally {
      this.inFlight--;
    }
  }

  /** A deliberate test send: bypasses `enabled`, scope and dedupe, and records the result. */
  async sendTest(cfg: Pick<WebhookConfig, 'kind' | 'url'>, host?: string): Promise<WebhookResult> {
    const result = await sendWebhook(
      cfg,
      {
        event: 'webhook:test',
        title: 'Codeman test notification',
        body: 'If you can read this, webhook notifications are working.',
        urgency: 'info',
        host,
      },
      this.fetchImpl
    );
    this.last = result;
    return result;
  }
}
