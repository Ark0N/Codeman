/**
 * @fileoverview Multi-user mode: server-wide settings writes are admin-only.
 *
 * `~/.codeman/settings.json` is ONE file for the whole server (feature switches, the
 * plan-usage collection switch, run mode, respawn presets, the tunnel). Before this,
 * any signed-in NON-ADMIN could rewrite it through PUT /api/settings, although
 * docs/multi-user-plan.md makes settings writes admin-only. Pinned here:
 *  - a non-admin PUT /api/settings is 403 FORBIDDEN before anything is parsed (an
 *    invalid body is still 403, not 400), written, toggled or started (watchers, the
 *    tunnel, the tmux history limit);
 *  - the same gate on the other server-wide writes: PUT /api/execution/model-config,
 *    PUT /api/config and PUT /api/cases/order;
 *  - an admin, and single-user mode, write as before; GET /api/settings stays readable,
 *    but a non-admin reads it without the admin's Deepgram key and case names
 *    (settingsForNonAdmin).
 *
 * Uses app.inject(), so no real HTTP port is needed. Port: N/A.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSystemRoutes, settingsForNonAdmin } from '../../src/web/routes/system-routes.js';
import { registerCaseRoutes } from '../../src/web/routes/case-routes.js';

const { STORED, subagentWatcher, imageWatcher, workflowRunWatcher } = vi.hoisted(() => {
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
      __reset: () => {
        isOn = running;
      },
    };
  };
  return {
    // The persisted settings.json these tests start from.
    STORED: { subagentTrackingEnabled: false, imageWatcherEnabled: true, cliManagementEnabled: false },
    subagentWatcher: makeWatcher(false),
    imageWatcher: makeWatcher(true),
    workflowRunWatcher: makeWatcher(false),
  };
});

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async () => JSON.stringify(STORED)),
    writeFile: vi.fn(async () => undefined),
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(() => true), mkdirSync: vi.fn(), readdirSync: vi.fn(() => []) };
});

vi.mock('../../src/subagent-watcher.js', () => ({ subagentWatcher }));
vi.mock('../../src/image-watcher.js', () => ({ imageWatcher }));
vi.mock('../../src/workflow-run-watcher.js', () => ({ workflowRunWatcher }));

import fs from 'node:fs/promises';
const writeFile = vi.mocked(fs.writeFile);
const readFile = vi.mocked(fs.readFile);

const NON_ADMIN = { username: 'bob', role: 'user' } as const;
const ADMIN = { username: 'root', role: 'admin' } as const;

function makeTunnelManager() {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    isRunning: vi.fn(() => false),
    getUrl: vi.fn(() => null),
    getStatus: vi.fn(() => ({ running: false })),
  };
}

/** A body that would touch everything PUT /api/settings can act on. */
const EVERYTHING = {
  tunnelEnabled: true,
  subagentTrackingEnabled: true,
  imageWatcherEnabled: false,
  showUltracodeAgents: true,
  tmuxHistoryLimit: 50000,
  cliManagementEnabled: true,
  runMode: 'shell',
};

describe('server-wide settings writes are admin-only in multi-user mode', () => {
  const savedMultiUser = process.env.CODEMAN_MULTIUSER;
  let harness: RouteTestHarness | undefined;
  let tunnel: ReturnType<typeof makeTunnelManager>;

  async function as(user: typeof NON_ADMIN | typeof ADMIN | null, register = registerSystemRoutes) {
    if (user) process.env.CODEMAN_MULTIUSER = '1';
    else delete process.env.CODEMAN_MULTIUSER;
    harness = await createRouteTestHarness(register, user ? { authUser: user } : undefined);
    tunnel = makeTunnelManager();
    (harness.ctx as unknown as { tunnelManager: unknown }).tunnelManager = tunnel;
    return harness;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    for (const w of [subagentWatcher, imageWatcher, workflowRunWatcher]) w.__reset();
  });

  afterEach(async () => {
    await harness?.app.close();
    harness = undefined;
    if (savedMultiUser === undefined) delete process.env.CODEMAN_MULTIUSER;
    else process.env.CODEMAN_MULTIUSER = savedMultiUser;
  });

  describe('PUT /api/settings', () => {
    it('refuses a non-admin with 403 FORBIDDEN, and nothing is written, toggled or started', async () => {
      const { app, ctx } = await as(NON_ADMIN);
      const res = await app.inject({ method: 'PUT', url: '/api/settings', payload: EVERYTHING });

      expect(res.statusCode).toBe(403);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.errorCode).toBe('FORBIDDEN');
      expect(writeFile).not.toHaveBeenCalled();
      for (const w of [subagentWatcher, imageWatcher, workflowRunWatcher]) {
        expect(w.start).not.toHaveBeenCalled();
        expect(w.stop).not.toHaveBeenCalled();
      }
      expect(tunnel.start).not.toHaveBeenCalled();
      expect(ctx.mux.setHistoryLimit).not.toHaveBeenCalled();
    });

    it('refuses a non-admin before the body is even parsed (an invalid body is 403, not 400)', async () => {
      const { app } = await as(NON_ADMIN);
      const res = await app.inject({ method: 'PUT', url: '/api/settings', payload: { notASetting: 1 } });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).errorCode).toBe('FORBIDDEN');
      expect(writeFile).not.toHaveBeenCalled();
    });

    it('still lets a non-admin READ the settings', async () => {
      const { app } = await as(NON_ADMIN);
      const res = await app.inject({ method: 'GET', url: '/api/settings' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual(STORED);
    });

    for (const [label, user] of [
      ['an admin in multi-user mode', ADMIN],
      ['single-user mode', null],
    ] as const) {
      it(`writes, reconciles watchers and starts the tunnel for ${label}`, async () => {
        const { app, ctx } = await as(user);
        // Single-user mode with no CODEMAN_PASSWORD needs the COD-55 tunnel acknowledgement
        // (multi-user mode counts as authenticated); that guard is not what this file tests.
        const payload = user ? EVERYTHING : { ...EVERYTHING, acknowledgeUnauthTunnel: true };
        const res = await app.inject({ method: 'PUT', url: '/api/settings', payload });

        expect(res.statusCode).toBe(200);
        expect(writeFile).toHaveBeenCalledTimes(1);
        const written = JSON.parse(String(writeFile.mock.calls[0][1]));
        expect(written).toMatchObject({ ...STORED, ...EVERYTHING });
        expect(subagentWatcher.start).toHaveBeenCalledTimes(1);
        expect(imageWatcher.stop).toHaveBeenCalledTimes(1);
        expect(workflowRunWatcher.start).toHaveBeenCalledTimes(1);
        expect(tunnel.start).toHaveBeenCalledTimes(1);
        expect(ctx.mux.setHistoryLimit).toHaveBeenCalledTimes(1);
      });
    }
  });

  describe("GET /api/settings: what is the admin's stays the admin's", () => {
    // An admin's App Settings save stores the Deepgram key (voiceSettings.apiKey) here, and
    // the admin's own cases are named in caseOrder / lastUsedCase.
    const WITH_SECRETS = {
      autoNameSessions: true,
      runMode: 'shell',
      caseOrder: ['rootcase', 'secret-project'],
      lastUsedCase: 'secret-project',
      voiceSettings: { provider: 'deepgram', apiKey: 'dg-SECRET-probe-123', language: 'en' },
    };

    it('gives a non-admin the settings without the Deepgram key and the case names', async () => {
      const { app } = await as(NON_ADMIN);
      readFile.mockResolvedValueOnce(JSON.stringify(WITH_SECRETS));
      const res = await app.inject({ method: 'GET', url: '/api/settings' });
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain('dg-SECRET-probe-123');
      expect(res.body).not.toContain('secret-project');
      expect(JSON.parse(res.body)).toEqual({
        autoNameSessions: true,
        runMode: 'shell',
        voiceSettings: { provider: 'deepgram', language: 'en' },
      });
    });

    for (const [label, user] of [
      ['an admin in multi-user mode', ADMIN],
      ['single-user mode', null],
    ] as const) {
      it(`gives ${label} the file as it is`, async () => {
        const { app } = await as(user);
        readFile.mockResolvedValueOnce(JSON.stringify(WITH_SECRETS));
        const res = await app.inject({ method: 'GET', url: '/api/settings' });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toEqual(WITH_SECRETS);
      });
    }

    it('settingsForNonAdmin leaves its input alone and passes a non-object through', () => {
      const input = structuredClone(WITH_SECRETS);
      settingsForNonAdmin(input);
      expect(input).toEqual(WITH_SECRETS);
      expect(settingsForNonAdmin([1, 2])).toEqual([1, 2]);
      expect(settingsForNonAdmin(null)).toBe(null);
      expect(settingsForNonAdmin({ voiceSettings: { language: 'de' } })).toEqual({ voiceSettings: { language: 'de' } });
    });
  });

  describe('PUT /api/execution/model-config', () => {
    const config = { defaultModel: 'opus', agentTypeOverrides: { explore: 'sonnet' } };

    it('refuses a non-admin with 403 FORBIDDEN and writes nothing', async () => {
      const { app } = await as(NON_ADMIN);
      const res = await app.inject({ method: 'PUT', url: '/api/execution/model-config', payload: config });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).errorCode).toBe('FORBIDDEN');
      expect(writeFile).not.toHaveBeenCalled();
    });

    it('writes it for an admin', async () => {
      const { app } = await as(ADMIN);
      const res = await app.inject({ method: 'PUT', url: '/api/execution/model-config', payload: config });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(String(writeFile.mock.calls[0][1])).modelConfig).toEqual(config);
    });

    it('stays readable by a non-admin', async () => {
      const { app } = await as(NON_ADMIN);
      const res = await app.inject({ method: 'GET', url: '/api/execution/model-config' });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('PUT /api/config', () => {
    it('refuses a non-admin with 403 FORBIDDEN and changes nothing', async () => {
      const { app, ctx } = await as(NON_ADMIN);
      const res = await app.inject({ method: 'PUT', url: '/api/config', payload: { maxConcurrentSessions: 50 } });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).errorCode).toBe('FORBIDDEN');
      expect(ctx.store.setConfig).not.toHaveBeenCalled();
    });

    it('updates it for an admin', async () => {
      const { app, ctx } = await as(ADMIN);
      const res = await app.inject({ method: 'PUT', url: '/api/config', payload: { maxConcurrentSessions: 10 } });
      expect(res.statusCode).toBe(200);
      expect(ctx.store.setConfig).toHaveBeenCalledTimes(1);
    });
  });

  describe('PUT /api/cases/order (the one global caseOrder in settings.json)', () => {
    it('refuses a non-admin with 403 FORBIDDEN and writes nothing', async () => {
      const { app, ctx } = await as(NON_ADMIN, registerCaseRoutes);
      const res = await app.inject({ method: 'PUT', url: '/api/cases/order', payload: { order: ['b', 'a'] } });
      expect(res.statusCode).toBe(403);
      expect(JSON.parse(res.body).errorCode).toBe('FORBIDDEN');
      expect(writeFile).not.toHaveBeenCalled();
      expect(ctx.broadcast).not.toHaveBeenCalled();
    });

    for (const [label, user] of [
      ['an admin in multi-user mode', ADMIN],
      ['single-user mode', null],
    ] as const) {
      it(`writes it for ${label}`, async () => {
        const { app } = await as(user, registerCaseRoutes);
        const res = await app.inject({ method: 'PUT', url: '/api/cases/order', payload: { order: ['b', 'a'] } });
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(String(writeFile.mock.calls[0][1])).caseOrder).toEqual(['b', 'a']);
      });
    }
  });
});
