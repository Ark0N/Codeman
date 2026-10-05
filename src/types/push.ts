/**
 * @fileoverview Web Push notification type definitions.
 *
 * Types for the Web Push notification layer (layer 4 of the 5-layer notification system).
 *
 * Key exports:
 * - PushSubscriptionRecord — a registered push endpoint with per-event preferences
 * - VapidKeys — VAPID key pair (public + private) for Web Push authentication
 * - WebhookConfig, WebhookStatus, WebhookResult (+ the kind/scope lists): the webhook channel
 *   (ntfy, Slack, Discord, generic JSON) that carries the same events as Web Push
 *
 * Persistence:
 * - VAPID keys: `~/.codeman/push-keys.json` (auto-generated on first use)
 * - Subscriptions: `~/.codeman/push-subscriptions.json` (expired auto-cleaned on 410/404)
 * - Webhook: `~/.codeman/webhook.json` (mode 0600; the URL is a bearer secret)
 *
 * Push is managed by PushStore (`src/push-store.ts`), served at `GET /api/push/vapid-key`,
 * `POST /api/push/subscribe`. The webhook is managed by `src/webhook-notify.ts`, served at
 * `GET`/`PUT /api/webhook` and `POST /api/webhook/test`. No dependencies on other domain modules.
 */

/** A registered push subscription */
export interface PushSubscriptionRecord {
  id: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent: string;
  createdAt: number;
  lastUsedAt: number;
  pushPreferences: Record<string, boolean>;
}

/** VAPID key pair for Web Push */
export interface VapidKeys {
  publicKey: string;
  privateKey: string;
  generatedAt: number;
}

/** Services the webhook channel can format a message for. */
export const WEBHOOK_KINDS = ['ntfy', 'slack', 'discord', 'generic'] as const;
export type WebhookKind = (typeof WEBHOOK_KINDS)[number];

/** `attention`: only events that need a human (critical / warning). `all`: also "response complete". */
export const WEBHOOK_SCOPES = ['attention', 'all'] as const;
export type WebhookScope = (typeof WEBHOOK_SCOPES)[number];

export type WebhookUrgency = 'critical' | 'warning' | 'info';

/** The stored webhook config (`~/.codeman/webhook.json`). `url` is a secret and is never returned. */
export interface WebhookConfig {
  enabled: boolean;
  kind: WebhookKind;
  url: string;
  scope: WebhookScope;
}

/** One delivery attempt. `error` never contains the URL. */
export interface WebhookResult {
  ok: boolean;
  status?: number;
  error?: string;
  at: number;
}

/** `GET /api/webhook`: the config without its URL, plus the last delivery result. */
export interface WebhookStatus {
  enabled: boolean;
  kind: WebhookKind;
  scope: WebhookScope;
  hasUrl: boolean;
  /** Scheme + host only; the path and query are the secret. */
  urlMasked: string;
  lastResult: WebhookResult | null;
}
