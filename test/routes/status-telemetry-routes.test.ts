/**
 * Route tests for POST /api/status-telemetry — the Claude statusline exporter
 * endpoint that feeds the header "Plan Usage Limits" chip.
 *
 * Covers: broadcast on real telemetry + footer print-through, unknown-session
 * skip, per-session change-detection (dedup), rebroadcast on a displayed change,
 * NO rebroadcast on context-only drift, null-tolerance of Claude's undocumented
 * fields (the .nullish() schema — the project's recurring .optional()/null trap),
 * the prompt-cache group of the footer (warm and cold shapes of `prompt_cache`),
 * and 400 on a malformed body. Also the session's model (`displayModel`) the route
 * records off the same payload.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerStatusTelemetryRoutes } from '../../src/web/routes/status-telemetry-routes.js';
import { SessionPromptCache, SessionStatusTelemetry } from '../../src/web/sse-events.js';
import { Session } from '../../src/session.js';

const SID = 'test-session-1'; // default id created by createMockRouteContext

const REAL = {
  rate_limits: {
    five_hour: { used_percentage: 15, resets_at: 1781409000 },
    seven_day: { used_percentage: 34, resets_at: 1781827200 },
  },
  context_window: { used_percentage: 56, total_input_tokens: 562411, total_output_tokens: 1188 },
  cost: { total_cost_usd: 0.0415 },
  model: { display_name: 'Opus 4.8 (1M context)' },
};

describe('POST /api/status-telemetry', () => {
  let h: RouteTestHarness;

  beforeEach(async () => {
    h = await createRouteTestHarness(registerStatusTelemetryRoutes, { sessionId: SID });
  });

  const post = (body: unknown) => h.app.inject({ method: 'POST', url: '/api/status-telemetry', payload: body });

  it('broadcasts plan-usage telemetry and returns the session-status footer', async () => {
    const res = await post({ sessionId: SID, data: REAL });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toBe('Opus 4.8 (1M context)  in:562,411 out:1,188  ctx:56%');
    expect(h.ctx.broadcast).toHaveBeenCalledTimes(1);
    const [event, payload] = h.ctx.broadcast.mock.calls[0];
    expect(event).toBe(SessionStatusTelemetry);
    expect(payload).toMatchObject({
      sessionId: SID,
      fiveHour: { usedPercentage: 15 },
      sevenDay: { usedPercentage: 34 },
    });
  });

  it('does not broadcast for an unknown session; returns an EMPTY footer, never a brand word', async () => {
    const res = await post({ sessionId: 'does-not-exist', data: REAL });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    expect(h.ctx.broadcast).not.toHaveBeenCalled();
  });

  it('dedups identical telemetry — rebroadcasts only once', async () => {
    await post({ sessionId: SID, data: REAL });
    await post({ sessionId: SID, data: REAL });
    expect(h.ctx.broadcast).toHaveBeenCalledTimes(1);
  });

  it('rebroadcasts when a displayed window percentage changes', async () => {
    await post({ sessionId: SID, data: REAL });
    const moved = {
      ...REAL,
      rate_limits: { ...REAL.rate_limits, five_hour: { used_percentage: 16, resets_at: 1781409000 } },
    };
    await post({ sessionId: SID, data: moved });
    expect(h.ctx.broadcast).toHaveBeenCalledTimes(2);
  });

  it('does NOT rebroadcast on context-only drift (the chip never shows context %)', async () => {
    await post({ sessionId: SID, data: REAL });
    await post({ sessionId: SID, data: { ...REAL, context_window: { ...REAL.context_window, used_percentage: 91 } } });
    expect(h.ctx.broadcast).toHaveBeenCalledTimes(1);
  });

  it("tolerates null in Claude's undocumented fields (no 400) and ignores them", async () => {
    const res = await post({
      sessionId: SID,
      data: {
        rate_limits: { five_hour: { used_percentage: 20, resets_at: 1781409000 }, seven_day: null },
        cost: { total_cost_usd: null },
        model: { display_name: null },
        context_window: { used_percentage: null, total_input_tokens: null, total_output_tokens: null },
      },
    });
    expect(res.statusCode).toBe(200);
    expect(h.ctx.broadcast).toHaveBeenCalledTimes(1);
    const [, payload] = h.ctx.broadcast.mock.calls[0];
    expect(payload).toMatchObject({ fiveHour: { usedPercentage: 20 } });
    expect(payload.sevenDay).toBeUndefined();
  });

  it('prints the prompt-cache state in the footer: a clock time while warm, cold once Claude says so', async () => {
    const expiresAtS = Math.floor(Date.now() / 1000) + 3600;
    const warm = await post({
      sessionId: SID,
      data: {
        ...REAL,
        prompt_cache: { warm: true, ttl: '1h', expires_at: expiresAtS, recache_tokens_if_cold: 109833 },
      },
    });
    expect(warm.statusCode).toBe(200);
    expect(warm.body).toMatch(/^Opus 4\.8 \(1M context\)  in:562,411 out:1,188  ctx:56%  cache:until \d\d:\d\d$/);

    // The cold flip Claude sends when expires_at passes: null expiry, and a last_miss_cause
    // that carries numeric detail keys beside `causes` (must not 400, which would blank the footer).
    const cold = await post({
      sessionId: SID,
      data: {
        ...REAL,
        prompt_cache: {
          warm: false,
          ttl: '1h',
          expires_at: null,
          misses: 1,
          last_miss_cause: { causes: ['ttl_expired_1h'], system_char_delta: 0 },
        },
      },
    });
    expect(cold.statusCode).toBe(200);
    expect(cold.body.endsWith('  cache:cold')).toBe(true);

    // The report is kept on the session (toState / Session Options readout) and each CHANGE
    // is broadcast on its own event; the plan chip did not change, so it broadcast once.
    const session = h.ctx.sessions.get(SID) as unknown as { promptCache: { warm: boolean } | null };
    expect(session.promptCache).toMatchObject({
      warm: false,
      ttl: '1h',
      misses: 1,
      lastMissCauses: ['ttl_expired_1h'],
    });
    const events = h.ctx.broadcast.mock.calls.map(([name]) => name);
    expect(events.filter((e) => e === SessionStatusTelemetry)).toHaveLength(1);
    expect(events.filter((e) => e === SessionPromptCache)).toHaveLength(2);
    expect(h.ctx.broadcast).toHaveBeenCalledWith(
      SessionPromptCache,
      expect.objectContaining({ sessionId: SID, warm: true, ttl: '1h', recacheTokensIfCold: 109833 })
    );
  });

  it('does not rebroadcast an unchanged prompt-cache report', async () => {
    const pc = { warm: true, ttl: '1h', expires_at: Math.floor(Date.now() / 1000) + 3600 };
    await post({ sessionId: SID, data: { ...REAL, prompt_cache: pc } });
    await post({ sessionId: SID, data: { ...REAL, prompt_cache: pc } });
    const events = h.ctx.broadcast.mock.calls.map(([name]) => name);
    expect(events.filter((e) => e === SessionPromptCache)).toHaveLength(1);
  });

  it('rejects a malformed body (missing sessionId) with 400', async () => {
    const res = await post({ data: REAL });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/status-telemetry: the session model (displayModel)', () => {
  let h: RouteTestHarness;

  beforeEach(async () => {
    h = await createRouteTestHarness(registerStatusTelemetryRoutes, { sessionId: SID });
  });

  const post = (body: unknown) => h.app.inject({ method: 'POST', url: '/api/status-telemetry', payload: body });

  /** A real claude session in the route's map, so displayModel is the shipped resolver's. */
  function realSession(mode: 'claude' | 'codex', id: string): Session {
    const session = new Session({ id, workingDir: '/tmp', mode } as ConstructorParameters<typeof Session>[0]);
    (h.ctx.sessions as unknown as Map<string, unknown>).set(id, session);
    return session;
  }

  it('records the model the statusline names, from the first render (no rate limits yet)', async () => {
    const session = realSession('claude', 'claude-1');
    const changed = vi.fn();
    session.on('displayModelChanged', changed);
    const res = await post({ sessionId: 'claude-1', data: { model: { display_name: 'Haiku 4.5' } } });
    expect(res.statusCode).toBe(200);
    expect(session.toState().displayModel).toEqual({ model: 'Haiku 4.5', source: 'statusline' });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('follows a model switch, and says nothing for an unchanged one', async () => {
    const session = realSession('claude', 'claude-2');
    const changed = vi.fn();
    session.on('displayModelChanged', changed);
    await post({ sessionId: 'claude-2', data: REAL });
    await post({ sessionId: 'claude-2', data: REAL });
    expect(changed).toHaveBeenCalledTimes(1);
    await post({ sessionId: 'claude-2', data: { ...REAL, model: { display_name: 'Sonnet 4.6' } } });
    expect(session.toState().displayModel).toEqual({ model: 'Sonnet 4.6', source: 'statusline' });
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('keeps a model name with markup as text, and a null name changes nothing', async () => {
    const session = realSession('claude', 'claude-3');
    await post({ sessionId: 'claude-3', data: { model: { display_name: '<b>Opus</b>' } } });
    expect(session.toState().displayModel?.model).toBe('<b>Opus</b>');
    await post({ sessionId: 'claude-3', data: { model: { display_name: null } } });
    expect(session.toState().displayModel?.model).toBe('<b>Opus</b>');
  });

  it('takes no model from a CLI that has no statusline exporter', async () => {
    const session = realSession('codex', 'codex-1');
    await post({ sessionId: 'codex-1', data: { model: { display_name: 'Opus 4.8' } } });
    expect(session.toState().displayModel).toBeUndefined();
  });

  it('broadcasts the STORED prompt-cache object, so a compaction stamp reaches the live readout', async () => {
    const session = realSession('claude', 'claude-compact');
    const expiresAtS = Math.floor(Date.now() / 1000) + 3600;
    // A normal warm report (rebuild baseline 0), then Claude Code's idle compaction: recache
    // goes null (absent), expected_rebuilds rises above the known baseline, still warm. The
    // session stamps compactedAt in setPromptCache.
    await post({
      sessionId: 'claude-compact',
      data: {
        prompt_cache: {
          warm: true,
          ttl: '1h',
          expires_at: expiresAtS,
          expected_rebuilds: 0,
          recache_tokens_if_cold: 500000,
        },
      },
    });
    await post({
      sessionId: 'claude-compact',
      data: { prompt_cache: { warm: true, ttl: '1h', expires_at: expiresAtS, expected_rebuilds: 1 } },
    });
    expect(typeof session.toState().promptCache?.compactedAt).toBe('number');
    // The broadcast must carry the stored object, not just the freshly parsed one, or the
    // frontend's live update would never see the stamp (only a modal reopen would).
    const last = (h.ctx.broadcast.mock.calls as [string, Record<string, unknown>][])
      .filter(([name]) => name === SessionPromptCache)
      .at(-1)?.[1];
    expect(last).toMatchObject({ sessionId: 'claude-compact', warm: true });
    expect(typeof last?.compactedAt).toBe('number');
  });
});
