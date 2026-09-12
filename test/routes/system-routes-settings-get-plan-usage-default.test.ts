/**
 * @fileoverview GET /api/settings must reconcile `showPlanUsageLimits` the
 * first time it is ever read, closing the gap left by PR #361.
 *
 * planUsageChipEnabled() (settings-ui.js) shows the header chip and the App
 * Settings checkbox as already ON whenever this key has never been set — a
 * discoverability default from 1.9.3. readPlanUsageTelemetryEnabled()
 * (hooks-config.ts) deliberately treats an absent key as "no telemetry" —
 * a privacy default, pinned by its own unit tests. Nothing reconciled those
 * two independent guesses, so a fresh install showed a checked box that
 * silently collected nothing until the user opened Settings and hit Save
 * at least once.
 *
 * These tests pin the fix: GET /api/settings persists the resolved default
 * ONCE when the key is truly absent, and never overwrites an explicit value
 * either way afterward.
 *
 * Uses app.inject() — no real HTTP ports needed. Port: N/A.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSystemRoutes } from '../../src/web/routes/system-routes.js';

// vi.mock factories are hoisted above module-level consts, so the mutable
// persisted-settings fixture has to be built inside vi.hoisted().
const { state } = vi.hoisted(() => ({
  // Mutated per-test to control what "disk" holds before the GET.
  state: { persisted: {} as Record<string, unknown>, exists: true },
}));

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async () => {
      if (!state.exists) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return JSON.stringify(state.persisted);
    }),
    writeFile: vi.fn(async (_path: string, content: string) => {
      state.persisted = JSON.parse(content);
      state.exists = true;
    }),
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(() => true), mkdirSync: vi.fn(), readdirSync: vi.fn(() => []) };
});

describe('GET /api/settings — showPlanUsageLimits default reconciliation', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerSystemRoutes);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('persists the resolved default (true) the first time the key is absent', async () => {
    state.persisted = { someOtherSetting: true };
    state.exists = true;

    const res = await harness.app.inject({ method: 'GET', url: '/api/settings' });

    expect(res.statusCode).toBe(200);
    expect(res.json().showPlanUsageLimits).toBe(true);
    // Reconciliation actually reached disk, not just the response.
    expect(state.persisted.showPlanUsageLimits).toBe(true);
  });

  it('reconciles even when settings.json does not exist at all', async () => {
    state.exists = false;

    const res = await harness.app.inject({ method: 'GET', url: '/api/settings' });

    expect(res.statusCode).toBe(200);
    expect(res.json().showPlanUsageLimits).toBe(true);
    expect(state.persisted.showPlanUsageLimits).toBe(true);
  });

  it('never overwrites an explicit false', async () => {
    state.persisted = { showPlanUsageLimits: false };
    state.exists = true;

    const res = await harness.app.inject({ method: 'GET', url: '/api/settings' });

    expect(res.statusCode).toBe(200);
    expect(res.json().showPlanUsageLimits).toBe(false);
    // Untouched — reconciliation must not have written anything.
    expect(state.persisted.showPlanUsageLimits).toBe(false);
  });

  it('never rewrites an explicit true', async () => {
    state.persisted = { showPlanUsageLimits: true };
    state.exists = true;

    const res = await harness.app.inject({ method: 'GET', url: '/api/settings' });

    expect(res.statusCode).toBe(200);
    expect(res.json().showPlanUsageLimits).toBe(true);
  });
});
