/**
 * @fileoverview Web Push notification type definitions.
 *
 * Types for the Web Push notification layer (layer 5 of the 5-layer notification system).
 *
 * Key exports:
 * - PushSubscriptionRecord — a registered push endpoint with per-event preferences
 * - VapidKeys — VAPID key pair (public + private) for Web Push authentication
 *
 * Persistence:
 * - VAPID keys: `~/.codeman/push-keys.json` (auto-generated on first use)
 * - Subscriptions: `~/.codeman/push-subscriptions.json` (expired auto-cleaned on 410/404)
 *
 * Managed by PushStore (`src/push-store.ts`). Served at `GET /api/push/vapid-key`,
 * `POST /api/push/subscribe`. No dependencies on other domain modules.
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
