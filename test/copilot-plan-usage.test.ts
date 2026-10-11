/**
 * @fileoverview GitHub Copilot's monthly premium-request quota for the shared plan-usage chip:
 * the quota parser, the sign-in token lookup and the read-only HTTP reader.
 *
 * The fixture is the shape `GET /copilot_internal/user` returned for a Business seat (values rounded);
 * `chat` and `completions` are `unlimited`, only `premium_interactions` is metered.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCopilotQuotaResponse, telemetrySignature } from '../src/usage-telemetry.js';
import { COPILOT_QUOTA_URL, readCopilotPlanUsage, resolveCopilotToken } from '../src/utils/copilot-plan-usage.js';

const RESPONSE = {
  copilot_plan: 'business',
  quota_reset_date_utc: '2026-11-01T00:00:00.000Z',
  quota_reset_date: '2026-11-01',
  quota_snapshots: {
    chat: { entitlement: 0, remaining: 0, percent_remaining: 100, unlimited: true },
    completions: { entitlement: 0, remaining: 0, percent_remaining: 100, unlimited: true },
    premium_interactions: {
      entitlement: 5000,
      remaining: 3785,
      percent_remaining: 75.7,
      unlimited: false,
      overage_permitted: true,
      overage_count: 0,
    },
  },
};

describe('parseCopilotQuotaResponse', () => {
  it('maps premium_interactions to a monthly window with counts and the reset instant', () => {
    expect(parseCopilotQuotaResponse(RESPONSE)).toEqual({
      monthly: {
        usedPercentage: expect.closeTo(24.3, 5),
        resetAt: Date.parse('2026-11-01T00:00:00.000Z'),
        used: 1215,
        limit: 5000,
      },
    });
  });

  it('ignores the unlimited chat and completions buckets entirely', () => {
    const only = { quota_snapshots: { chat: RESPONSE.quota_snapshots.chat } };
    expect(parseCopilotQuotaResponse(only)).toBeNull();
  });

  it('has nothing to meter for an unlimited premium quota', () => {
    const unlimited = {
      quota_snapshots: {
        premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 100, unlimited: true },
      },
    };
    expect(parseCopilotQuotaResponse(unlimited)).toBeNull();
  });

  it('derives the percent from the counts when percent_remaining is missing', () => {
    const result = parseCopilotQuotaResponse({
      quota_snapshots: { premium_interactions: { entitlement: 300, remaining: 75 } },
      quota_reset_date: '2026-11-01',
    });
    expect(result?.monthly?.usedPercentage).toBe(75);
    expect(result?.monthly?.used).toBe(225);
  });

  it('clamps overage to 100% and keeps the real count', () => {
    const result = parseCopilotQuotaResponse({
      quota_snapshots: { premium_interactions: { entitlement: 300, remaining: -40, percent_remaining: -13.3 } },
    });
    expect(result?.monthly?.usedPercentage).toBe(100);
    expect(result?.monthly?.used).toBe(340);
  });

  it('rejects anything it cannot read as a quota', () => {
    for (const bad of [
      null,
      undefined,
      'x',
      3,
      {},
      { quota_snapshots: {} },
      { quota_snapshots: { premium_interactions: 'x' } },
    ]) {
      expect(parseCopilotQuotaResponse(bad)).toBeNull();
    }
  });

  it('feeds the change-detection signature without disturbing the Claude/Codex one', () => {
    const copilot = parseCopilotQuotaResponse(RESPONSE)!;
    expect(telemetrySignature(copilot)).not.toBe(telemetrySignature({}));
    // A Claude-only payload has exactly the four-element signature it always had.
    expect(JSON.parse(telemetrySignature({ fiveHour: { usedPercentage: 10, resetAt: 1 } }))).toEqual([
      10,
      1,
      null,
      null,
    ]);
  });
});

describe('resolveCopilotToken', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const home = (config?: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'copilot-token-'));
    dirs.push(dir);
    if (config !== undefined) {
      mkdirSync(join(dir, '.copilot'));
      writeFileSync(join(dir, '.copilot', 'config.json'), config);
    }
    return dir;
  };
  const CONFIG = [
    '// User settings belong in settings.json.',
    JSON.stringify({
      lastLoggedInUser: { host: 'https://github.com', login: 'octo' },
      authTokens: {
        'https://github.com:octo': { token: 'file-token' },
        'https://github.com:other': { token: 'other-token' },
      },
    }),
  ].join('\n');

  it('prefers the environment, in the order Copilot itself reads it', () => {
    const h = home(CONFIG);
    expect(resolveCopilotToken({ GITHUB_TOKEN: 'c', GH_TOKEN: 'b', COPILOT_GITHUB_TOKEN: 'a' }, h)).toBe('a');
    expect(resolveCopilotToken({ GITHUB_TOKEN: 'c', GH_TOKEN: 'b' }, h)).toBe('b');
    expect(resolveCopilotToken({ GITHUB_TOKEN: 'c' }, h)).toBe('c');
  });

  it("falls back to the signed-in user's token in the commented config.json", () => {
    expect(resolveCopilotToken({}, home(CONFIG))).toBe('file-token');
  });

  it('honours COPILOT_HOME', () => {
    const elsewhere = home();
    mkdirSync(join(elsewhere, 'cp'));
    writeFileSync(join(elsewhere, 'cp', 'config.json'), CONFIG.replace('file-token', 'relocated'));
    expect(resolveCopilotToken({ COPILOT_HOME: join(elsewhere, 'cp') }, home())).toBe('relocated');
  });

  it('reads no file token for another host, a missing file or a broken one', () => {
    const ghe = CONFIG.replace('"host":"https://github.com"', '"host":"https://ghe.example.com"');
    expect(resolveCopilotToken({}, home(ghe))).toBeNull();
    expect(resolveCopilotToken({}, home())).toBeNull();
    expect(resolveCopilotToken({}, home('{ not json'))).toBeNull();
  });
});

describe('readCopilotPlanUsage', () => {
  const ok = (body: unknown, status = 200) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it('asks api.github.com with the bearer token, no redirects, and normalizes the answer', async () => {
    const fetchFn = ok(RESPONSE);
    const usage = await readCopilotPlanUsage({ token: 'tok', fetchFn });
    expect(usage?.monthly?.limit).toBe(5000);
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(COPILOT_QUOTA_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    expect(init.redirect).toBe('error');
  });

  it('sends nothing when there is no token', async () => {
    const fetchFn = ok(RESPONSE);
    expect(await readCopilotPlanUsage({ token: null, fetchFn })).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('answers null, never throws, on an HTTP error, a network failure or a changed shape', async () => {
    expect(await readCopilotPlanUsage({ token: 't', fetchFn: ok({ message: 'Bad credentials' }, 401) })).toBeNull();
    expect(await readCopilotPlanUsage({ token: 't', fetchFn: ok({ unexpected: true }) })).toBeNull();
    const down = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await readCopilotPlanUsage({ token: 't', fetchFn: down })).toBeNull();
  });

  it('never puts the token in anything it returns', async () => {
    const usage = await readCopilotPlanUsage({ token: 'super-secret-token', fetchFn: ok(RESPONSE) });
    expect(JSON.stringify(usage)).not.toContain('super-secret-token');
  });
});
