import { describe, it, expect } from 'vitest';
import {
  parseStatusTelemetry,
  parseSessionStatus,
  parsePromptCache,
  formatSessionStatusText,
  telemetrySignature,
  type RawStatuslinePayload,
} from '../src/usage-telemetry.js';

// Mirrors the real captured statusline payload (CC 2.1.177, Claude Max) — see
// docs/usage-limits-display-plan.md. resets_at is epoch SECONDS.
const REAL: RawStatuslinePayload = {
  rate_limits: {
    five_hour: { used_percentage: 15, resets_at: 1781409000 },
    seven_day: { used_percentage: 34, resets_at: 1781827200 },
  },
  context_window: { used_percentage: 56, total_input_tokens: 562411, total_output_tokens: 1188 },
  cost: { total_cost_usd: 0.0415495 },
  model: { display_name: 'Opus 4.8 (1M context)' },
};

describe('parseStatusTelemetry', () => {
  it('normalizes the real payload, converting resets_at seconds → ms', () => {
    const t = parseStatusTelemetry(REAL);
    expect(t).not.toBeNull();
    expect(t!.fiveHour).toEqual({ usedPercentage: 15, resetAt: 1781409000 * 1000 });
    expect(t!.sevenDay).toEqual({ usedPercentage: 34, resetAt: 1781827200 * 1000 });
    expect(t!.contextUsedPercentage).toBe(56);
    expect(t!.costUsd).toBeCloseTo(0.0415495);
    expect(t!.modelDisplayName).toBe('Opus 4.8 (1M context)');
  });

  it('returns null when there is no rate_limits (pre-first-response / non-subscriber)', () => {
    expect(parseStatusTelemetry({})).toBeNull();
    expect(parseStatusTelemetry(undefined)).toBeNull();
    expect(parseStatusTelemetry({ context_window: { used_percentage: 5 } })).toBeNull();
    expect(parseStatusTelemetry({ rate_limits: {} })).toBeNull();
  });

  it('accepts a single window when only one is present', () => {
    const t = parseStatusTelemetry({ rate_limits: { five_hour: { used_percentage: 50, resets_at: 1781409000 } } });
    expect(t!.fiveHour?.usedPercentage).toBe(50);
    expect(t!.sevenDay).toBeUndefined();
  });

  it('drops a window with a missing or non-numeric field', () => {
    const t = parseStatusTelemetry({
      rate_limits: {
        five_hour: { used_percentage: 20 }, // no resets_at → dropped
        seven_day: { used_percentage: 40, resets_at: 1781827200 },
      },
    });
    expect(t!.fiveHour).toBeUndefined();
    expect(t!.sevenDay?.usedPercentage).toBe(40);
  });

  it('clamps percentages to 0–100', () => {
    const t = parseStatusTelemetry({
      rate_limits: {
        five_hour: { used_percentage: 150, resets_at: 1781409000 },
        seven_day: { used_percentage: -5, resets_at: 1781827200 },
      },
    });
    expect(t!.fiveHour?.usedPercentage).toBe(100);
    expect(t!.sevenDay?.usedPercentage).toBe(0);
  });

  it('ignores a zero/negative reset timestamp', () => {
    expect(parseStatusTelemetry({ rate_limits: { five_hour: { used_percentage: 10, resets_at: 0 } } })).toBeNull();
  });

  it('keeps a NaN percentage as 0 and drops a window with a non-finite reset', () => {
    const t = parseStatusTelemetry({
      rate_limits: {
        five_hour: { used_percentage: NaN, resets_at: 1781409000 },
        seven_day: { used_percentage: 40, resets_at: Infinity },
      },
    });
    expect(t!.fiveHour).toEqual({ usedPercentage: 0, resetAt: 1781409000 * 1000 });
    expect(t!.sevenDay).toBeUndefined();
  });

  it('rounds a fractional resets_at to whole milliseconds', () => {
    const t = parseStatusTelemetry({
      rate_limits: { five_hour: { used_percentage: 10, resets_at: 1781409000.7 } },
    });
    expect(t!.fiveHour?.resetAt).toBe(Math.round(1781409000.7 * 1000));
  });
});

// Mirrors a captured `prompt_cache` object (CC 2.1.280, Claude Max, 1h TTL) from a
// session whose first turn finished at 23:00:06Z; expires_at is epoch SECONDS.
const EXPIRES_AT_S = Date.UTC(2026, 9, 6, 23, 0, 6) / 1000;
const WARM_CACHE: RawStatuslinePayload = {
  prompt_cache: {
    warm: true,
    ttl: '1h',
    expires_at: EXPIRES_AT_S,
    recache_tokens_if_cold: 109833,
    misses: 0,
    last_miss_cause: null,
  },
};

/** The footer prints the server-local clock, so derive the expected text the same way. */
function localHHMM(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

describe('parsePromptCache', () => {
  it('normalizes the captured object, converting expires_at seconds to ms', () => {
    expect(parsePromptCache(WARM_CACHE)).toEqual({
      warm: true,
      ttl: '1h',
      expiresAt: EXPIRES_AT_S * 1000,
      recacheTokensIfCold: 109833,
      misses: 0,
    });
  });

  it('keeps a cold report (warm:false, null expires_at) and the diagnosed miss causes', () => {
    expect(
      parsePromptCache({
        prompt_cache: {
          warm: false,
          ttl: '1h',
          expires_at: null,
          misses: 1,
          // Real shape: numeric detail keys ride next to `causes`
          last_miss_cause: { causes: ['ttl_expired_1h', 7, ''] } as never,
        },
      })
    ).toEqual({ warm: false, ttl: '1h', misses: 1, lastMissCauses: ['ttl_expired_1h'] });
  });

  it('returns null when the payload has no prompt_cache or warm is not a boolean (state unknown, not cold)', () => {
    expect(parsePromptCache(undefined)).toBeNull();
    expect(parsePromptCache({})).toBeNull();
    expect(parsePromptCache({ prompt_cache: null })).toBeNull();
    expect(parsePromptCache({ prompt_cache: { warm: null, ttl: '1h' } })).toBeNull();
  });

  it('drops a TTL it does not know and a non-positive or non-finite expiry', () => {
    expect(parsePromptCache({ prompt_cache: { warm: true, ttl: '2h', expires_at: 0 } })).toEqual({ warm: true });
    expect(parsePromptCache({ prompt_cache: { warm: true, expires_at: Number.NaN } })).toEqual({ warm: true });
    expect(parsePromptCache({ prompt_cache: { warm: true, expires_at: -5 } })).toEqual({ warm: true });
  });

  it('drops an expiry that overflows or leaves the Date range after the seconds->ms multiply', () => {
    // These pass `expires_at > 0 && isFinite` on the SECONDS but render "cache:until NaN:NaN"
    // once converted, so the converted ms must be validated too (finite, within Date range).
    expect(parsePromptCache({ prompt_cache: { warm: true, expires_at: Number.POSITIVE_INFINITY } })).toEqual({
      warm: true,
    });
    expect(parsePromptCache({ prompt_cache: { warm: true, expires_at: 1e308 } })).toEqual({ warm: true }); // *1000 = Infinity
    expect(parsePromptCache({ prompt_cache: { warm: true, expires_at: 1e14 } })).toEqual({ warm: true }); // 1e17 ms, out of range
    // The documented boundary still parses (8.64e15 ms = 8.64e12 s).
    expect(parsePromptCache({ prompt_cache: { warm: true, expires_at: 8.64e12 } })).toEqual({
      warm: true,
      expiresAt: 8.64e15,
    });
  });

  it('keeps hit_ratio (clamped 0-1) and expected_rebuilds (rounded, non-negative)', () => {
    expect(parsePromptCache({ prompt_cache: { warm: true, hit_ratio: 0.91, expected_rebuilds: 2 } })).toEqual({
      warm: true,
      hitRatio: 0.91,
      expectedRebuilds: 2,
    });
    // Out-of-range or non-finite values are clamped or dropped, never stored as-is.
    expect(parsePromptCache({ prompt_cache: { warm: true, hit_ratio: 1.5 } })).toEqual({ warm: true, hitRatio: 1 });
    expect(parsePromptCache({ prompt_cache: { warm: true, hit_ratio: -0.2 } })).toEqual({ warm: true, hitRatio: 0 });
    // expected_rebuilds is rounded and floored at 0 (it indexes the compaction rise).
    expect(parsePromptCache({ prompt_cache: { warm: true, expected_rebuilds: 2.9 } })).toEqual({
      warm: true,
      expectedRebuilds: 3,
    });
    expect(parsePromptCache({ prompt_cache: { warm: true, expected_rebuilds: -4 } })).toEqual({
      warm: true,
      expectedRebuilds: 0,
    });
    expect(parsePromptCache({ prompt_cache: { warm: true, hit_ratio: null, expected_rebuilds: null } })).toEqual({
      warm: true,
    });
  });
});

describe('parseSessionStatus', () => {
  it('carries the prompt-cache state into the footer status', () => {
    expect(parseSessionStatus({ ...REAL, ...WARM_CACHE })?.cache).toEqual(parsePromptCache(WARM_CACHE));
    // prompt_cache alone IS session status (a cold flip arrives with nothing else changed)
    expect(parseSessionStatus(WARM_CACHE)).toEqual({ cache: parsePromptCache(WARM_CACHE) });
  });

  it('extracts model, token totals, and context % for the footer', () => {
    const s = parseSessionStatus(REAL);
    expect(s).toEqual({
      modelDisplayName: 'Opus 4.8 (1M context)',
      inputTokens: 562411,
      outputTokens: 1188,
      contextUsedPercentage: 56,
    });
  });

  it('returns null when none of the footer fields are present', () => {
    expect(parseSessionStatus({})).toBeNull();
    expect(parseSessionStatus(undefined)).toBeNull();
    // rate_limits alone is not session status
    expect(parseSessionStatus({ rate_limits: { five_hour: { used_percentage: 5, resets_at: 1 } } })).toBeNull();
  });
});

describe('formatSessionStatusText', () => {
  it('formats the footer with comma-grouped tokens', () => {
    expect(formatSessionStatusText(parseSessionStatus(REAL))).toBe(
      'Opus 4.8 (1M context)  in:562,411 out:1,188  ctx:56%'
    );
  });

  it('omits groups that are missing', () => {
    expect(formatSessionStatusText({ contextUsedPercentage: 12 })).toBe('ctx:12%');
    expect(formatSessionStatusText({ modelDisplayName: 'Opus 4.8 (1M context)' })).toBe('Opus 4.8 (1M context)');
  });

  it('prints nothing when there is no data (a bare brand word reads as a broken statusline)', () => {
    expect(formatSessionStatusText(null)).toBe('');
    expect(formatSessionStatusText({} as never)).toBe('');
  });

  it('shows the warm cache as a server-local clock time, not a countdown that would sit stale', () => {
    const expiresAt = EXPIRES_AT_S * 1000;
    const now = expiresAt - 42 * 60_000;
    expect(formatSessionStatusText(parseSessionStatus({ ...REAL, ...WARM_CACHE }), now)).toBe(
      `Opus 4.8 (1M context)  in:562,411 out:1,188  ctx:56%  cache:until ${localHHMM(expiresAt)}`
    );
  });

  it('shows cache:cold once Claude reports it cold or the render happened past expires_at', () => {
    const expiresAt = EXPIRES_AT_S * 1000;
    expect(formatSessionStatusText({ cache: { warm: false } })).toBe('cache:cold');
    expect(formatSessionStatusText({ cache: { warm: true, expiresAt } }, expiresAt + 1)).toBe('cache:cold');
    // warm without an expiry is unknowable, so it is not promised as warm
    expect(formatSessionStatusText({ cache: { warm: true } })).toBe('cache:cold');
  });
});

describe('telemetrySignature', () => {
  it('is stable for equal telemetry and changes when a percentage moves', () => {
    const a = parseStatusTelemetry(REAL)!;
    const b = parseStatusTelemetry(REAL)!;
    expect(telemetrySignature(a)).toBe(telemetrySignature(b));

    const moved = parseStatusTelemetry({
      ...REAL,
      rate_limits: { ...REAL.rate_limits, five_hour: { used_percentage: 16, resets_at: 1781409000 } },
    })!;
    expect(telemetrySignature(moved)).not.toBe(telemetrySignature(a));
  });

  it('ignores contextUsedPercentage (not displayed) so it does not churn each message', () => {
    const base = { rate_limits: { five_hour: { used_percentage: 15, resets_at: 1781409000 } } };
    const a = parseStatusTelemetry({ ...base, context_window: { used_percentage: 56 } })!;
    const b = parseStatusTelemetry({ ...base, context_window: { used_percentage: 91 } })!;
    expect(telemetrySignature(a)).toBe(telemetrySignature(b));
  });

  it('keys on the ROUNDED window percentage (matches the chip) — sub-integer drift is ignored', () => {
    const sig = (p: number) =>
      telemetrySignature(
        parseStatusTelemetry({ rate_limits: { five_hour: { used_percentage: p, resets_at: 1781409000 } } })!
      );
    expect(sig(15.1)).toBe(sig(15.4)); // both render as 15%
    expect(sig(15.1)).not.toBe(sig(15.6)); // 15% vs 16%
  });

  it('excludes cost/model (not shown in the chip) from the signature', () => {
    const base = { rate_limits: { five_hour: { used_percentage: 15, resets_at: 1781409000 } } };
    const a = parseStatusTelemetry({ ...base, cost: { total_cost_usd: 0.01 }, model: { display_name: 'A' } })!;
    const b = parseStatusTelemetry({ ...base, cost: { total_cost_usd: 9.99 }, model: { display_name: 'B' } })!;
    expect(telemetrySignature(a)).toBe(telemetrySignature(b));
  });
});
