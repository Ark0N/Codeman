import { describe, it, expect } from 'vitest';
import {
  parseStatusTelemetry,
  parseSessionStatus,
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

describe('parseSessionStatus', () => {
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

  it('prints nothing when there is no data, never a brand string', () => {
    expect(formatSessionStatusText(null)).toBe('');
    expect(formatSessionStatusText({})).toBe('');
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
