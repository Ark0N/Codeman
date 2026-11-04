/**
 * @fileoverview Discord bridge type definitions.
 *
 * The option lists and the config, result and status shapes of the two-way Discord bridge, kept apart
 * from the IO module (`src/discord-bridge.ts`, which pulls in `ws`) so the request schemas and the
 * route can import them alone, as the webhook's equivalents live in `push.ts`.
 *
 * Key exports:
 * - DISCORD_THREAD_CREATION, DISCORD_ON_DELETE, DISCORD_PING_MODES (+ their types): the option lists
 * - DiscordConfig: `~/.codeman/discord.json` (mode 0600; the bot token is a secret)
 * - DiscordResult, DiscordGatewayState, DiscordStatus: what `GET /api/discord` reports
 *
 * No dependencies on other domain modules but `push.ts` (the shared scope list).
 */

import type { WebhookScope } from './push.js';

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
  /** What to do with threads the bridge made that no tab maps to any more: checked after boot, then daily. */
  staleThreads: DiscordOnDelete;
  pingMode: DiscordPingMode;
  /** `attention` skips info-level events (a finished response); `all` sends them too. */
  scope: WebhookScope;
  /** Tell each session how to reach the user (see DISCORD_STARTUP_HINT). On by default while the bridge is on. */
  startupHint: boolean;
  /**
   * Also type the hint, once, as the first message to a brand-new non-Claude CLI tab. Off by default: it spends a
   * model turn per tab, and for a spawned worker or a cron session it lands on the same first idle as the real prompt.
   */
  typedHint: boolean;
}

export interface DiscordResult {
  ok: boolean;
  /** True when the same event for the same tab was posted within the last few seconds, so nothing was sent. */
  deduped?: boolean;
  status?: number;
  error?: string;
  at: number;
}

export type DiscordGatewayState = 'off' | 'connecting' | 'connected' | 'error';

/** `GET /api/discord`: the config without its token, plus what the bridge is doing. */
export type DiscordStatus = Omit<DiscordConfig, 'token'> & {
  hasToken: boolean;
  tokenMasked: string;
  gateway: DiscordGatewayState;
  gatewayError: string | null;
  lastResult: DiscordResult | null;
};
