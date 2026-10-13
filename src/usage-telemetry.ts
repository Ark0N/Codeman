/**
 * @fileoverview Pure parsing + formatting of Claude and Codex plan telemetry.
 *
 * Claude Code (v2.1.80+) pipes a JSON blob to a configured `statusLine.command`
 * on each render. On Pro/Max subscriptions that blob carries a `rate_limits`
 * object with the 5-hour rolling and 7-day weekly plan windows. The
 * Codeman-managed statusLine exporter (see `hooks-config.generateStatusLineCommand`)
 * POSTs that blob to `/api/status-telemetry`; these helpers normalize the subset
 * Codeman displays and format the compact in-terminal footer string.
 *
 * Confirmed schema (empirically captured, CC 2.1.177, Claude Max — see
 * `docs/usage-limits-display-plan.md`):
 *   rate_limits.{five_hour,seven_day}.{used_percentage: number 0-100,
 *                                      resets_at: number EPOCH-SECONDS}
 * Only those two windows exist (no Opus-weekly field). `rate_limits` is absent
 * before the first API response and for non-subscriber auth — both yield null.
 *
 * Since Claude Code v2.1.251 the same blob carries a `prompt_cache` object for the
 * main conversation (`warm`, `ttl`, `expires_at`, `recache_tokens_if_cold`,
 * `misses`, `last_miss_cause`, ...). `parsePromptCache` normalizes the subset
 * Codeman reads, and the footer shows it as `cache:until HH:MM` while warm and
 * `cache:cold` otherwise. Claude re-runs the statusline when `expires_at` passes,
 * so the footer flips to cold on its own.
 *
 * The Codex parser consumes the read-only `account/rateLimits/read` app-server
 * response and selects only the main `codex` bucket, excluding model-specific
 * buckets. All functions are pure for testability. See
 * `test/usage-telemetry.test.ts` and `test/codex-plan-usage.test.ts`.
 *
 * @module usage-telemetry
 */

import type { PromptCacheStatus } from './types/index.js';

export type { PromptCacheStatus };

/** A single normalized plan-usage window. */
export interface UsageWindow {
  /** Percent of the window consumed, 0–100. */
  usedPercentage: number;
  /** Epoch MILLISECONDS when the window resets (statusline reports seconds). */
  resetAt: number;
}

/** Normalized telemetry Codeman broadcasts to the UI. */
export interface StatusTelemetry {
  fiveHour?: UsageWindow;
  sevenDay?: UsageWindow;
  /** Context-window percent used, 0–100 (bonus field from the same payload). */
  contextUsedPercentage?: number;
  /** Session cost in USD (bonus field). */
  costUsd?: number;
  /** Model display name, e.g. "Opus 4.8 (1M context)" (bonus field). */
  modelDisplayName?: string;
}

/** Raw subset of the statusline stdin JSON (snake_case, as Claude emits it). */
export interface RawStatuslinePayload {
  rate_limits?: {
    five_hour?: { used_percentage?: number; resets_at?: number };
    seven_day?: { used_percentage?: number; resets_at?: number };
  };
  context_window?: { used_percentage?: number; total_input_tokens?: number; total_output_tokens?: number };
  cost?: { total_cost_usd?: number };
  model?: { display_name?: string };
  /** Main-conversation prompt-cache statistics (Claude Code v2.1.251+); absent before the first API response. */
  prompt_cache?: RawPromptCache | null;
}

/** Raw `prompt_cache` object as Claude emits it (the subset Codeman reads; every field null-tolerant). */
export interface RawPromptCache {
  warm?: boolean | null;
  ttl?: string | null;
  /** Epoch SECONDS when the cached prefix goes cold; null once the last response reported no cache tokens. */
  expires_at?: number | null;
  /** Null right after a compaction or tool-result clearing, until the next request records the rewritten size. */
  recache_tokens_if_cold?: number | null;
  misses?: number | null;
  /** Cache rebuilds that followed a compaction or a clearing of old tool results (the compaction signal). */
  expected_rebuilds?: number | null;
  /** Cache read tokens as a fraction of all input tokens this session, 0-1; null while those counts are all zero. */
  hit_ratio?: number | null;
  last_miss_cause?: { causes?: unknown } | null;
}

interface RawCodexRateLimitWindow {
  usedPercent?: unknown;
  windowDurationMins?: unknown;
  resetsAt?: unknown;
}

interface RawCodexRateLimitSnapshot {
  primary?: RawCodexRateLimitWindow | null;
  secondary?: RawCodexRateLimitWindow | null;
}

interface RawCodexRateLimitsResponse {
  rateLimits?: RawCodexRateLimitSnapshot | null;
  rateLimitsByLimitId?: Record<string, RawCodexRateLimitSnapshot | null> | null;
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function parseWindow(w?: { used_percentage?: number; resets_at?: number }): UsageWindow | undefined {
  if (!w || typeof w.used_percentage !== 'number' || typeof w.resets_at !== 'number') return undefined;
  if (!Number.isFinite(w.resets_at) || w.resets_at <= 0) return undefined;
  return { usedPercentage: clampPct(w.used_percentage), resetAt: Math.round(w.resets_at * 1000) };
}

/**
 * Normalize a raw statusline payload to the telemetry Codeman displays. Returns
 * null when there is no plan-limit data to show (pre-first-response or a
 * non-subscriber account) so the caller can skip broadcasting.
 */
export function parseStatusTelemetry(data: RawStatuslinePayload | undefined): StatusTelemetry | null {
  if (!data) return null;
  const fiveHour = parseWindow(data.rate_limits?.five_hour);
  const sevenDay = parseWindow(data.rate_limits?.seven_day);
  if (!fiveHour && !sevenDay) return null;

  const t: StatusTelemetry = {};
  if (fiveHour) t.fiveHour = fiveHour;
  if (sevenDay) t.sevenDay = sevenDay;
  if (typeof data.context_window?.used_percentage === 'number') {
    t.contextUsedPercentage = clampPct(data.context_window.used_percentage);
  }
  if (typeof data.cost?.total_cost_usd === 'number' && Number.isFinite(data.cost.total_cost_usd)) {
    t.costUsd = data.cost.total_cost_usd;
  }
  if (typeof data.model?.display_name === 'string' && data.model.display_name) {
    t.modelDisplayName = data.model.display_name.slice(0, 60);
  }
  return t;
}

/**
 * Normalize the statusline's `prompt_cache` object. Null when the payload has none
 * (pre-first-response, or a Claude Code older than v2.1.251) or when `warm` is not
 * a boolean, so the caller can treat the cache state as unknown rather than cold.
 */
export function parsePromptCache(data: RawStatuslinePayload | undefined): PromptCacheStatus | null {
  const pc = data?.prompt_cache;
  if (!pc || typeof pc.warm !== 'boolean') return null;
  const s: PromptCacheStatus = { warm: pc.warm };
  if (pc.ttl === '5m' || pc.ttl === '1h') s.ttl = pc.ttl;
  if (typeof pc.expires_at === 'number' && Number.isFinite(pc.expires_at) && pc.expires_at > 0) {
    // Validate the CONVERTED ms, not just the seconds: a huge seconds value overflows to
    // Infinity or lands outside the Date range after *1000, which renders "cache:until
    // NaN:NaN". 8.64e15 is the max absolute epoch ms a Date can represent.
    const ms = Math.round(pc.expires_at * 1000);
    if (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15) s.expiresAt = ms;
  }
  if (typeof pc.recache_tokens_if_cold === 'number' && Number.isFinite(pc.recache_tokens_if_cold)) {
    s.recacheTokensIfCold = Math.max(0, Math.round(pc.recache_tokens_if_cold));
  }
  if (typeof pc.misses === 'number' && Number.isFinite(pc.misses)) {
    s.misses = Math.max(0, Math.round(pc.misses));
  }
  if (typeof pc.expected_rebuilds === 'number' && Number.isFinite(pc.expected_rebuilds)) {
    s.expectedRebuilds = Math.max(0, Math.round(pc.expected_rebuilds));
  }
  if (typeof pc.hit_ratio === 'number' && Number.isFinite(pc.hit_ratio)) {
    s.hitRatio = Math.min(1, Math.max(0, pc.hit_ratio));
  }
  const causes = pc.last_miss_cause?.causes;
  if (Array.isArray(causes)) {
    const names = causes.filter((c): c is string => typeof c === 'string' && c.length > 0).map((c) => c.slice(0, 60));
    if (names.length) s.lastMissCauses = names;
  }
  return s;
}

/** Normalize the main Codex app-server bucket into the chip's two known windows. */
export function parseCodexRateLimitsResponse(value: unknown): StatusTelemetry | null {
  if (!value || typeof value !== 'object') return null;
  const response = value as RawCodexRateLimitsResponse;
  const snapshot = response.rateLimitsByLimitId?.codex ?? response.rateLimits;
  if (!snapshot || typeof snapshot !== 'object') return null;

  const telemetry: StatusTelemetry = {};
  for (const window of [snapshot.primary, snapshot.secondary]) {
    if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent)) continue;
    if (window.windowDurationMins !== 300 && window.windowDurationMins !== 10_080) continue;
    const resetsAt =
      typeof window.resetsAt === 'number' && Number.isFinite(window.resetsAt) && window.resetsAt > 0
        ? Math.round(window.resetsAt * 1000)
        : 0;
    const normalized = { usedPercentage: clampPct(window.usedPercent), resetAt: resetsAt };
    if (window.windowDurationMins === 300) telemetry.fiveHour = normalized;
    if (window.windowDurationMins === 10_080) telemetry.sevenDay = normalized;
  }

  return telemetry.fiveHour || telemetry.sevenDay ? telemetry : null;
}

/**
 * Current-session status for the in-terminal statusline footer. This is the
 * "status of the current session" the user sees in Claude's footer — distinct
 * from the account-wide plan limits, which live ONLY in the Codeman header chip.
 */
export interface SessionStatus {
  modelDisplayName?: string;
  inputTokens?: number;
  outputTokens?: number;
  contextUsedPercentage?: number;
  /** Prompt-cache state of the main conversation, when the statusline reports it. */
  cache?: PromptCacheStatus;
}

/** Group a non-negative integer with thousands separators: 562411 → "562,411". */
function withCommas(n: number): string {
  return Math.max(0, Math.round(n))
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Extract current-session status (footer) from the raw payload. */
export function parseSessionStatus(data: RawStatuslinePayload | undefined): SessionStatus | null {
  if (!data) return null;
  const s: SessionStatus = {};
  if (typeof data.model?.display_name === 'string' && data.model.display_name) {
    s.modelDisplayName = data.model.display_name.slice(0, 60);
  }
  const cw = data.context_window;
  if (typeof cw?.total_input_tokens === 'number' && Number.isFinite(cw.total_input_tokens)) {
    s.inputTokens = Math.max(0, cw.total_input_tokens);
  }
  if (typeof cw?.total_output_tokens === 'number' && Number.isFinite(cw.total_output_tokens)) {
    s.outputTokens = Math.max(0, cw.total_output_tokens);
  }
  if (typeof cw?.used_percentage === 'number') {
    s.contextUsedPercentage = clampPct(cw.used_percentage);
  }
  const cache = parsePromptCache(data);
  if (cache) s.cache = cache;
  return Object.keys(s).length ? s : null;
}

/**
 * `cache:until 19:00` (server-local clock) while the prefix is warm, `cache:cold`
 * once Claude reports it cold or the render happened past `expires_at`. A clock
 * time rather than a countdown because the footer only re-renders on statusline
 * triggers, so a countdown would sit stale on screen between turns.
 */
function formatCacheGroup(c: PromptCacheStatus, now: number): string {
  if (!c.warm || c.expiresAt == null || c.expiresAt <= now) return 'cache:cold';
  const d = new Date(c.expiresAt);
  return `cache:until ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/**
 * Format the in-terminal statusline footer: the CURRENT SESSION's status —
 * `Opus 4.8 (1M context)  in:562,411 out:1,188  ctx:56%  cache:until 19:00` — NOT
 * the plan limits, which live in the Codeman header chip. Claude requires a
 * statusLine command to emit the rate_limits JSON at all, so this is what that
 * command prints back when it has no statusline of the user's own to wrap. With
 * nothing to show it returns '' rather than a brand word: a bare `codeman` on the
 * statusline is the symptom discussion #405 opened with. `now` is injectable so
 * the cache group is testable.
 */
export function formatSessionStatusText(s: SessionStatus | null, now: number = Date.now()): string {
  if (!s) return '';
  const groups: string[] = [];
  if (s.modelDisplayName) groups.push(s.modelDisplayName);
  const tok: string[] = [];
  if (s.inputTokens != null) tok.push(`in:${withCommas(s.inputTokens)}`);
  if (s.outputTokens != null) tok.push(`out:${withCommas(s.outputTokens)}`);
  if (tok.length) groups.push(tok.join(' '));
  if (s.contextUsedPercentage != null) groups.push(`ctx:${Math.round(clampPct(s.contextUsedPercentage))}%`);
  if (s.cache) groups.push(formatCacheGroup(s.cache, now));
  return groups.length ? groups.join('  ') : '';
}

/**
 * Stable signature for change-detection — the statusline fires on every
 * assistant message, so the route only rebroadcasts when this value changes.
 *
 * Keys on EXACTLY the values the header chip displays: the two windows' ROUNDED
 * percentages (the chip renders `Math.round`) + their reset times. Deliberately
 * excludes contextUsedPercentage / costUsd / modelDisplayName — none are shown
 * in the chip, and contextUsedPercentage in particular drifts on every assistant
 * message, which would defeat the dedup and fan out a redundant SSE broadcast +
 * localStorage write + identical chip re-render each time.
 */
export function telemetrySignature(t: StatusTelemetry): string {
  return JSON.stringify([
    t.fiveHour ? Math.round(t.fiveHour.usedPercentage) : null,
    t.fiveHour?.resetAt ?? null,
    t.sevenDay ? Math.round(t.sevenDay.usedPercentage) : null,
    t.sevenDay?.resetAt ?? null,
  ]);
}
