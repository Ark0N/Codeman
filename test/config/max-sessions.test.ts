/**
 * @fileoverview The global session cap can be set with `CODEMAN_MAX_SESSIONS`.
 *
 * Tested through `sessionCapacityState` / `sessionCapacityMessage`, the check every
 * session-creating route goes through, so a regression in the env parsing OR in
 * the wiring from `map-limits` to the routes (and to the derived per-user cap in
 * multi-user mode) fails here.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

type Helpers = typeof import('../../src/web/route-helpers.js');

/** A sessions map of the given size, every session owned by `owner`. */
function sessionsOf(n: number, owner?: string): ReadonlyMap<string, never> {
  return new Map(Array.from({ length: n }, (_, i) => [`s${i}`, { id: `s${i}`, owner } as never]));
}

/** Fresh module graph, so map-limits re-reads the environment at import. */
async function loadWithEnv(env: Record<string, string | undefined>): Promise<Helpers> {
  vi.resetModules();
  vi.stubEnv('CODEMAN_MAX_SESSIONS', undefined);
  vi.stubEnv('CODEMAN_MAX_SESSIONS_PER_USER', undefined);
  vi.stubEnv('CODEMAN_MULTIUSER', undefined);
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  return import('../../src/web/route-helpers.js');
}

describe('global session cap (CODEMAN_MAX_SESSIONS)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('stays at 50 when the variable is not set', async () => {
    const { sessionCapacityState, sessionCapacityMessage } = await loadWithEnv({});
    expect(sessionCapacityState(sessionsOf(49)).atGlobalCap).toBe(false);
    expect(sessionCapacityState(sessionsOf(50)).atGlobalCap).toBe(true);
    expect(sessionCapacityMessage(sessionsOf(50))).toContain('(50)');
  });

  it('raises the cap', async () => {
    const { sessionCapacityState, sessionCapacityMessage } = await loadWithEnv({ CODEMAN_MAX_SESSIONS: '120' });
    expect(sessionCapacityState(sessionsOf(50)).atGlobalCap).toBe(false);
    expect(sessionCapacityState(sessionsOf(119)).atGlobalCap).toBe(false);
    expect(sessionCapacityState(sessionsOf(120)).atGlobalCap).toBe(true);
    expect(sessionCapacityMessage(sessionsOf(120))).toContain('(120)');
  });

  it('lowers the cap, ignoring surrounding whitespace', async () => {
    const { sessionCapacityState } = await loadWithEnv({ CODEMAN_MAX_SESSIONS: ' 3 ' });
    expect(sessionCapacityState(sessionsOf(2)).atGlobalCap).toBe(false);
    expect(sessionCapacityState(sessionsOf(3)).atGlobalCap).toBe(true);
  });

  it.each(['1000', '500', '463', '99999999999999999999'])('clamps %j to the ceiling of 462', async (value) => {
    const { sessionCapacityState, sessionCapacityMessage } = await loadWithEnv({ CODEMAN_MAX_SESSIONS: value });
    expect(sessionCapacityState(sessionsOf(461)).atGlobalCap).toBe(false);
    expect(sessionCapacityState(sessionsOf(462)).atGlobalCap).toBe(true);
    expect(sessionCapacityMessage(sessionsOf(462))).toContain('(462)');
  });

  it('keeps the ceiling inside the tab-layout budget next to the saved web tabs', async () => {
    vi.resetModules();
    const { MAX_CONCURRENT_SESSIONS_CEILING } = await import('../../src/config/map-limits.js');
    const { MAX_WEBVIEWS } = await import('../../src/config/webview-limits.js');
    const { MAX_TAB_REFS } = await import('../../src/tab-layout.js');
    expect(MAX_CONCURRENT_SESSIONS_CEILING + MAX_WEBVIEWS).toBeLessThanOrEqual(MAX_TAB_REFS);
  });

  it.each(['', '0', '-5', '2.5', 'abc', '1e3'])('falls back to 50 for an unusable value %j', async (value) => {
    const { sessionCapacityState } = await loadWithEnv({ CODEMAN_MAX_SESSIONS: value });
    expect(sessionCapacityState(sessionsOf(49)).atGlobalCap).toBe(false);
    expect(sessionCapacityState(sessionsOf(50)).atGlobalCap).toBe(true);
  });

  it('derives the multi-user per-user cap (half the global cap) from it', async () => {
    const { sessionCapacityState, sessionCapacityMessage } = await loadWithEnv({
      CODEMAN_MAX_SESSIONS: '100',
      CODEMAN_MULTIUSER: '1',
    });
    expect(sessionCapacityState(sessionsOf(49, 'alice'), 'alice').atUserCap).toBe(false);
    expect(sessionCapacityState(sessionsOf(50, 'alice'), 'alice')).toEqual({ atGlobalCap: false, atUserCap: true });
    expect(sessionCapacityMessage(sessionsOf(50, 'alice'), 'alice')).toContain('(50)');
  });

  it('leaves an explicit CODEMAN_MAX_SESSIONS_PER_USER in charge of the per-user cap', async () => {
    const { sessionCapacityState } = await loadWithEnv({
      CODEMAN_MAX_SESSIONS: '100',
      CODEMAN_MAX_SESSIONS_PER_USER: '10',
      CODEMAN_MULTIUSER: '1',
    });
    expect(sessionCapacityState(sessionsOf(9, 'alice'), 'alice').atUserCap).toBe(false);
    expect(sessionCapacityState(sessionsOf(10, 'alice'), 'alice').atUserCap).toBe(true);
  });
});
