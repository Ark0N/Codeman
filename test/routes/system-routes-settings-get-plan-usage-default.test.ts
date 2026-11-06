/**
 * @fileoverview GET /api/settings is a plain read and must NEVER write
 * settings.json.
 *
 * PR #361 once made it reconcile `showPlanUsageLimits` on first read: if the
 * key was absent, the route persisted `true`. But readJsonConfig() answers
 * `{}` for ANY read failure (parse error, EACCES, EMFILE, and at the time a read
 * landing inside PUT's non-atomic write), not only ENOENT, and every page load calls this
 * route, so one unlucky read replaced the whole settings file with a one-key
 * file. The default now lives in the readers instead: an absent key means ON
 * to readPlanUsageTelemetryEnabled() (pinned in test/hooks-config.test.ts) and
 * to planUsageChipEnabled() on the client.
 *
 * Uses app.inject() with a mocked filesystem. Port: N/A.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSystemRoutes } from '../../src/web/routes/system-routes.js';

// vi.mock factories are hoisted above module-level consts, so the mutable
// "disk" fixture has to be built inside vi.hoisted().
const { state, writeFile } = vi.hoisted(() => ({
  // `raw` is what readFile returns; `failWith` makes it throw with that code.
  state: { raw: '{}', failWith: null as string | null },
  writeFile: vi.fn(async () => {}),
}));

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async () => {
      if (state.failWith) {
        const err = new Error(state.failWith) as NodeJS.ErrnoException;
        err.code = state.failWith;
        throw err;
      }
      return state.raw;
    }),
    writeFile,
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(() => true), mkdirSync: vi.fn(), readdirSync: vi.fn(() => []) };
});

describe('GET /api/settings never writes settings.json', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    state.raw = '{}';
    state.failWith = null;
    writeFile.mockClear();
    harness = await createRouteTestHarness(registerSystemRoutes);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('returns the file content unchanged when showPlanUsageLimits is absent, and writes nothing', async () => {
    state.raw = JSON.stringify({ someOtherSetting: true });

    const res = await harness.app.inject({ method: 'GET', url: '/api/settings' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ someOtherSetting: true });
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('answers {} for a missing settings.json without creating one', async () => {
    state.failWith = 'ENOENT';

    const res = await harness.app.inject({ method: 'GET', url: '/api/settings' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('leaves an unreadable settings.json alone (EACCES is not "absent")', async () => {
    state.failWith = 'EACCES';
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await harness.app.inject({ method: 'GET', url: '/api/settings' });

    quiet.mockRestore();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('leaves a garbage settings.json alone (a parse error is not "absent")', async () => {
    state.raw = '{ "showPlanUsageLimits": tru';
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await harness.app.inject({ method: 'GET', url: '/api/settings' });

    quiet.mockRestore();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('passes an explicit value through either way', async () => {
    for (const value of [true, false]) {
      state.raw = JSON.stringify({ showPlanUsageLimits: value });
      const res = await harness.app.inject({ method: 'GET', url: '/api/settings' });
      expect(res.json().showPlanUsageLimits).toBe(value);
    }
    expect(writeFile).not.toHaveBeenCalled();
  });
});
