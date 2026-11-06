/**
 * @fileoverview PUT /api/settings must not reset service state on a PARTIAL body.
 *
 * The three service toggles (subagent watcher, workflow-run watcher, image
 * watcher) used to read the RAW REQUEST BODY with `??` defaults, so any key the
 * caller omitted was treated as "apply the default". A body of just
 * `{showPlanUsageLimits:true}` therefore STARTED the subagent watcher (`?? true`)
 * and STOPPED the workflow + image watchers (`?? false`), silently undoing the
 * persisted config. Nothing triggered it in practice only because every shipped
 * client sends a full settings payload rebuilt from the DOM.
 *
 * They now resolve from `merged` (existing settings.json + incoming), so a PUT
 * reconciles services to the effective stored state. These tests pin that:
 * omitted keys preserve state, explicit keys still take effect.
 *
 * Uses app.inject() — no real HTTP ports needed. Port: N/A.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSystemRoutes } from '../../src/web/routes/system-routes.js';

// vi.mock factories are hoisted above module-level consts, so the stubs and the
// persisted-settings fixture have to be built inside vi.hoisted().
const { EXISTING_SETTINGS, subagentWatcher, imageWatcher, workflowRunWatcher } = vi.hoisted(() => {
  /** Watcher stub whose isRunning() reflects its persisted state. */
  const makeWatcher = (running: boolean) => {
    let isOn = running;
    return {
      isRunning: vi.fn(() => isOn),
      start: vi.fn(() => {
        isOn = true;
      }),
      stop: vi.fn(() => {
        isOn = false;
      }),
      getStats: vi.fn(() => ({})),
      watchSession: vi.fn(),
      getRecentRunSummaries: vi.fn(() => []),
      // The stubs are module singletons (vi.mock needs them hoisted), so a
      // start()/stop() in one test would otherwise carry into the next and make
      // its "not called" assertion pass vacuously — isRunning() already matches
      // the expected end state, so toggleService short-circuits.
      __resetRunning: () => {
        isOn = running;
      },
    };
  };
  return {
    // Persisted settings.json for these tests: two watchers ON, subagent tracking OFF,
    // agent inbox snapshot ON.
    EXISTING_SETTINGS: {
      subagentTrackingEnabled: false,
      imageWatcherEnabled: true,
      showUltracodeAgents: true,
      promptCacheKeepWarm: false,
      promptCacheKeepWarmMaxHours: 2,
      agentInboxPersistEnabled: true,
    },
    subagentWatcher: makeWatcher(false),
    imageWatcher: makeWatcher(true),
    workflowRunWatcher: makeWatcher(true),
  };
});

// setEnabled(false) deletes the snapshot file, so a wrong default here loses mail.
const { agentInboxPersistence } = vi.hoisted(() => ({ agentInboxPersistence: { setEnabled: vi.fn() } }));

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async () => JSON.stringify(EXISTING_SETTINGS)),
    writeFile: vi.fn(async () => undefined),
    // settings.json is written to a temp file and renamed over the real one (settings-writer.ts).
    realpath: vi.fn(async (p: string) => p),
    mkdir: vi.fn(async () => undefined),
    rename: vi.fn(async () => undefined),
    rm: vi.fn(async () => undefined),
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(() => true), mkdirSync: vi.fn(), readdirSync: vi.fn(() => []) };
});

vi.mock('../../src/subagent-watcher.js', () => ({ subagentWatcher }));
vi.mock('../../src/image-watcher.js', () => ({ imageWatcher }));
vi.mock('../../src/workflow-run-watcher.js', () => ({ workflowRunWatcher }));
vi.mock('../../src/web/agent-inbox-persistence.js', () => ({ agentInboxPersistence }));

describe('PUT /api/settings — partial body must not reset service toggles', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerSystemRoutes);
    for (const w of [subagentWatcher, imageWatcher, workflowRunWatcher]) {
      w.start.mockClear();
      w.stop.mockClear();
      w.__resetRunning(); // running state, not just call records — see makeWatcher
    }
    agentInboxPersistence.setEnabled.mockClear();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('leaves all three watchers alone when the body omits their keys', async () => {
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings',
      // Minimal single-key body: the exact shape that used to flip all three watchers.
      payload: { showPlanUsageLimits: true },
    });

    expect(res.statusCode).toBe(200);
    // Persisted OFF and omitted — must NOT be started by the `?? true` default.
    expect(subagentWatcher.start).not.toHaveBeenCalled();
    // Persisted ON and omitted — must NOT be stopped by the `?? false` defaults.
    expect(imageWatcher.stop).not.toHaveBeenCalled();
    expect(workflowRunWatcher.stop).not.toHaveBeenCalled();
  });

  it('still starts a watcher when the body explicitly enables it', async () => {
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { subagentTrackingEnabled: true },
    });

    expect(res.statusCode).toBe(200);
    expect(subagentWatcher.start).toHaveBeenCalledTimes(1);
    // Unrelated watchers stay untouched.
    expect(imageWatcher.stop).not.toHaveBeenCalled();
    expect(workflowRunWatcher.stop).not.toHaveBeenCalled();
  });

  it('still stops a watcher when the body explicitly disables it', async () => {
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { imageWatcherEnabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(imageWatcher.stop).toHaveBeenCalledTimes(1);
    expect(subagentWatcher.start).not.toHaveBeenCalled();
    expect(workflowRunWatcher.stop).not.toHaveBeenCalled();
  });

  it('keeps the workflow watcher running when only one of its two keys is sent', async () => {
    // Either showUltracodeAgents OR ultracodeFloatingWindows keeps it alive, and
    // the OR must be evaluated over merged state, not over this partial body.
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { ultracodeFloatingWindows: false },
    });

    expect(res.statusCode).toBe(200);
    // showUltracodeAgents is still true in settings.json, so it stays up.
    expect(workflowRunWatcher.stop).not.toHaveBeenCalled();
  });

  /**
   * The browser sends both keep-warm keys on every App Settings save, so testing for the keys in
   * the body re-read the settings and re-evaluated every session on each save of anything.
   */
  it('re-evaluates the prompt-cache keep-warm only when its default or cap changes', async () => {
    const put = (payload: Record<string, unknown>) =>
      harness.app.inject({ method: 'PUT', url: '/api/settings', payload });

    expect((await put({ promptCacheKeepWarm: false, promptCacheKeepWarmMaxHours: 2 })).statusCode).toBe(200);
    expect(harness.ctx.keepWarm.rescheduleAll).not.toHaveBeenCalled();

    expect((await put({ promptCacheKeepWarm: false, promptCacheKeepWarmMaxHours: 3 })).statusCode).toBe(200);
    expect(harness.ctx.keepWarm.rescheduleAll).toHaveBeenCalledTimes(1);

    expect((await put({ promptCacheKeepWarm: true })).statusCode).toBe(200);
    expect(harness.ctx.keepWarm.rescheduleAll).toHaveBeenCalledTimes(2);
  });

  it('keeps the agent inbox snapshot on when the body omits its key', async () => {
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { showPlanUsageLimits: true },
    });
    expect(res.statusCode).toBe(200);
    expect(agentInboxPersistence.setEnabled).toHaveBeenCalledWith(true);
    expect(agentInboxPersistence.setEnabled).not.toHaveBeenCalledWith(false);
  });

  it('switches the agent inbox snapshot off when the body says so', async () => {
    const res = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { agentInboxPersistEnabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(agentInboxPersistence.setEnabled).toHaveBeenCalledWith(false);
  });
});
