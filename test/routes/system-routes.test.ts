/**
 * @fileoverview Tests for system route handlers.
 *
 * Uses app.inject() — no real HTTP ports needed.
 * Port: N/A (app.inject doesn't open ports)
 *
 * Mocks: fs (promises + sync), subagentWatcher, imageWatcher,
 * session-lifecycle-log, and opencode-cli-resolver singletons.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSystemRoutes } from '../../src/web/routes/system-routes.js';

// ── Mocks ──────────────────────────────────────────────────────────

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async () => '{}'),
    writeFile: vi.fn(async () => undefined),
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn(() => []),
  };
});

vi.mock('../../src/subagent-watcher.js', () => ({
  subagentWatcher: {
    getSubagents: vi.fn(() => []),
    getRecentSubagents: vi.fn(() => []),
    getSubagentsForSession: vi.fn(() => []),
    getSubagent: vi.fn(() => null),
    getTranscript: vi.fn(async () => []),
    formatTranscript: vi.fn(() => ''),
    killSubagent: vi.fn(async () => false),
    cleanupNow: vi.fn(() => 0),
    clearAll: vi.fn(() => 0),
    getStats: vi.fn(() => ({
      totalAgents: 0,
      activeAgents: 0,
      fileDebouncerCount: 0,
      dirWatcherCount: 0,
      idleTimerCount: 0,
    })),
    isRunning: vi.fn(() => true),
    start: vi.fn(),
    stop: vi.fn(),
  },
}));

vi.mock('../../src/image-watcher.js', () => ({
  imageWatcher: {
    isRunning: vi.fn(() => false),
    start: vi.fn(),
    stop: vi.fn(),
    watchSession: vi.fn(),
  },
}));

vi.mock('../../src/session-lifecycle-log.js', () => ({
  getLifecycleLog: vi.fn(() => ({
    log: vi.fn(),
    query: vi.fn(async () => []),
  })),
}));

vi.mock('../../src/utils/opencode-cli-resolver.js', () => ({
  isOpenCodeAvailable: vi.fn(() => false),
  resolveOpenCodeDir: vi.fn(() => null),
}));

vi.mock('../../src/utils/gemini-cli-resolver.js', () => ({
  isGeminiAvailable: vi.fn(() => false),
  resolveGeminiDir: vi.fn(() => null),
}));

vi.mock('../../src/utils/antigravity-cli-resolver.js', () => ({
  isAntigravityAvailable: vi.fn(() => false),
  resolveAntigravityDir: vi.fn(() => null),
}));

vi.mock('../../src/utils/pi-cli-resolver.js', () => ({
  isPiAvailable: vi.fn(() => false),
  resolvePiDir: vi.fn(() => null),
  getPiCliVersion: vi.fn(() => null),
}));

vi.mock('../../src/utils/grok-cli-resolver.js', () => ({
  isGrokAvailable: vi.fn(() => false),
  resolveGrokDir: vi.fn(() => null),
  getGrokCliVersion: vi.fn(() => null),
}));

import fs from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { subagentWatcher } from '../../src/subagent-watcher.js';
import { getLifecycleLog } from '../../src/session-lifecycle-log.js';
import { isOpenCodeAvailable, resolveOpenCodeDir } from '../../src/utils/opencode-cli-resolver.js';
import { isGeminiAvailable, resolveGeminiDir } from '../../src/utils/gemini-cli-resolver.js';
import { isAntigravityAvailable, resolveAntigravityDir } from '../../src/utils/antigravity-cli-resolver.js';
import { isPiAvailable, resolvePiDir, getPiCliVersion } from '../../src/utils/pi-cli-resolver.js';
import { isGrokAvailable, resolveGrokDir, getGrokCliVersion } from '../../src/utils/grok-cli-resolver.js';

const mockedReadFile = vi.mocked(fs.readFile);
const mockedWriteFile = vi.mocked(fs.writeFile);
const mockedExistsSync = vi.mocked(existsSync);
const mockedReaddirSync = vi.mocked(readdirSync);
const mockedSubagentWatcher = vi.mocked(subagentWatcher);
const mockedGetLifecycleLog = vi.mocked(getLifecycleLog);
const mockedIsOpenCodeAvailable = vi.mocked(isOpenCodeAvailable);
const mockedResolveOpenCodeDir = vi.mocked(resolveOpenCodeDir);
const mockedIsGeminiAvailable = vi.mocked(isGeminiAvailable);
const mockedResolveGeminiDir = vi.mocked(resolveGeminiDir);
const mockedIsAntigravityAvailable = vi.mocked(isAntigravityAvailable);
const mockedResolveAntigravityDir = vi.mocked(resolveAntigravityDir);
const mockedIsPiAvailable = vi.mocked(isPiAvailable);
const mockedResolvePiDir = vi.mocked(resolvePiDir);
const mockedGetPiCliVersion = vi.mocked(getPiCliVersion);
const mockedIsGrokAvailable = vi.mocked(isGrokAvailable);
const mockedResolveGrokDir = vi.mocked(resolveGrokDir);
const mockedGetGrokCliVersion = vi.mocked(getGrokCliVersion);

describe('system-routes', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerSystemRoutes);
    vi.clearAllMocks();

    // Re-apply defaults after clearAllMocks
    mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockedWriteFile.mockResolvedValue(undefined);
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue([]);
    mockedSubagentWatcher.getSubagents.mockReturnValue([]);
    mockedSubagentWatcher.getStats.mockReturnValue({
      totalAgents: 0,
      activeAgents: 0,
      fileDebouncerCount: 0,
      dirWatcherCount: 0,
      idleTimerCount: 0,
    } as never);
    mockedGetLifecycleLog.mockReturnValue({
      log: vi.fn(),
      query: vi.fn(async () => []),
    } as never);
    mockedIsOpenCodeAvailable.mockReturnValue(false);
    mockedResolveOpenCodeDir.mockReturnValue(null);
    mockedIsGeminiAvailable.mockReturnValue(false);
    mockedResolveGeminiDir.mockReturnValue(null);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  // ========== GET /api/status ==========

  describe('GET /api/status', () => {
    it('returns server status', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/status' });
      expect(res.statusCode).toBe(200);
      expect(harness.ctx.getLightState).toHaveBeenCalled();
    });
  });

  // ========== GET /api/config ==========

  describe('GET /api/config', () => {
    it('returns config', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/config' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.config).toBeDefined();
    });
  });

  // ========== PUT /api/config ==========

  describe('PUT /api/config', () => {
    it('updates config with valid payload', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/config',
        payload: { maxConcurrentSessions: 10 },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.config).toBeDefined();
      expect(harness.ctx.store.setConfig).toHaveBeenCalled();
    });

    it('rejects unknown config fields (strict schema)', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/config',
        payload: { unknownField: 'invalid' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== GET /api/stats ==========

  describe('GET /api/stats', () => {
    it('returns aggregate stats', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/stats' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.stats).toBeDefined();
    });
  });

  // ========== GET /api/token-stats ==========

  describe('GET /api/token-stats', () => {
    it('returns daily and aggregate token stats', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/token-stats' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.daily).toBeDefined();
      expect(body.totals).toBeDefined();
    });
  });

  // ========== GET /api/away-digest ==========

  describe('GET /api/away-digest', () => {
    it('returns a classified digest from lifecycle, active sessions, and token stats', async () => {
      const lifecycleQuery = vi.fn(async () => [
        {
          ts: Date.now() - 1000,
          event: 'exit',
          sessionId: harness.ctx._sessionId,
          name: 'Route Session',
          exitCode: 7,
        },
      ]);
      mockedGetLifecycleLog.mockReturnValue({
        log: vi.fn(),
        query: lifecycleQuery,
      } as never);
      harness.ctx._session.name = 'Route Session';
      harness.ctx._session.status = 'working';
      harness.ctx.store.getDailyStats.mockReturnValue([
        {
          // LOCAL date (not toISOString/UTC): away-digest's dayOverlapsRange parses
          // the date as local midnight, so a UTC date near the local-midnight boundary
          // (e.g. running at 01:xx CEST = prior-day UTC) would fall outside the 1h
          // window and make this assertion TZ/hour-flaky.
          date: new Date().toLocaleDateString('en-CA'),
          inputTokens: 100,
          outputTokens: 200,
          estimatedCost: 0.02,
          sessions: 1,
        },
      ]);

      const res = await harness.app.inject({ method: 'GET', url: '/api/away-digest?range=1h' });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.digest.sections.needsAttention[0]).toMatchObject({
        sessionId: harness.ctx._sessionId,
        source: 'lifecycle',
      });
      expect(body.digest.sections.stillRunning[0]).toMatchObject({
        sessionId: harness.ctx._sessionId,
        source: 'status',
      });
      expect(body.digest.totals).toMatchObject({
        activeSessions: 1,
        needsAttention: 1,
        inputTokens: 100,
        outputTokens: 200,
        tokenWindowPrecision: 'day',
      });
      expect(lifecycleQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 1000,
        })
      );
    });

    it('rejects invalid ranges', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/away-digest?range=forever' });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.message ?? body.error).toMatch(/range/i);
    });
  });

  // ========== GET /api/debug/memory ==========

  describe('GET /api/debug/memory', () => {
    it('returns memory and map usage info', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/debug/memory' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.memory).toBeDefined();
      expect(body.memory.rssMB).toBeGreaterThan(0);
      expect(body.mapSizes).toBeDefined();
      expect(body.uptime).toBeDefined();
    });
  });

  // ========== GET /api/system/stats ==========

  describe('GET /api/system/stats', () => {
    it('returns CPU and memory stats', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/system/stats' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('cpu');
      expect(body).toHaveProperty('memory');
    });
  });

  // ========== POST /api/cleanup-state ==========

  describe('POST /api/cleanup-state', () => {
    it('cleans up stale session state', async () => {
      const runStaleSessionCleanup = vi.fn(
        async (_activeIds: Set<string>, action: (ids: ReadonlySet<string>) => unknown) => action(new Set())
      );
      harness.ctx.tabLayouts.runStaleSessionCleanup = runStaleSessionCleanup;
      const res = await harness.app.inject({ method: 'POST', url: '/api/cleanup-state' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.cleanedSessions).toBe(0);
      expect(harness.ctx.store.cleanupSessionsByIds).toHaveBeenCalledWith(new Set());
      expect(runStaleSessionCleanup).toHaveBeenCalledOnce();
    });
  });

  // ========== GET /api/subagents ==========

  describe('GET /api/subagents', () => {
    it('returns subagent list', async () => {
      const res = await harness.app.inject({ method: 'GET', url: '/api/subagents' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toBeDefined();
    });

    it('filters by minutes when query param provided', async () => {
      mockedSubagentWatcher.getRecentSubagents.mockReturnValue([]);
      const res = await harness.app.inject({ method: 'GET', url: '/api/subagents?minutes=30' });
      expect(res.statusCode).toBe(200);
      expect(mockedSubagentWatcher.getRecentSubagents).toHaveBeenCalledWith(30);
    });
  });

  // ========== POST /api/auth/revoke ==========

  describe('POST /api/auth/revoke', () => {
    it('returns success even without auth sessions', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/revoke',
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({});
    });

    it('revokes a specific session token', async () => {
      const authSessions = new Map();
      authSessions.set('tok-123', { ip: '1.2.3.4', ua: 'test', createdAt: Date.now(), method: 'basic' });
      harness.ctx.authSessions = authSessions;

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/revoke',
        payload: { sessionToken: 'tok-123' },
      });
      expect(res.statusCode).toBe(200);
      expect(authSessions.has('tok-123')).toBe(false);
    });

    it('clears all sessions when no token specified', async () => {
      const authSessions = new Map();
      authSessions.set('a', { ip: '1', ua: '', createdAt: 0, method: 'basic' });
      authSessions.set('b', { ip: '2', ua: '', createdAt: 0, method: 'qr' });
      harness.ctx.authSessions = authSessions;

      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/auth/revoke',
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(authSessions.size).toBe(0);
    });
  });

  // ========== GET /api/settings ==========

  describe('GET /api/settings', () => {
    it('reconciles showPlanUsageLimits to true when the settings file does not exist', async () => {
      // The chip/checkbox default to ON client-side (planUsageChipEnabled()) whenever
      // this key is absent, but readPlanUsageTelemetryEnabled() deliberately treats
      // absence as "no telemetry" — nothing reconciled those two defaults, so a fresh
      // install showed a checked box that silently collected nothing. GET now persists
      // the resolved default the first time anything reads settings.
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const res = await harness.app.inject({ method: 'GET', url: '/api/settings' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ showPlanUsageLimits: true });
      // Reconciliation actually reached disk, not just the response.
      expect(mockedWriteFile).toHaveBeenCalledWith(
        expect.anything(),
        JSON.stringify({ showPlanUsageLimits: true }, null, 2)
      );
    });

    it('reconciles showPlanUsageLimits to true when the file exists but omits it', async () => {
      const settings = { subagentTrackingEnabled: true, showSystemStats: false };
      mockedReadFile.mockResolvedValue(JSON.stringify(settings) as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/settings' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ ...settings, showPlanUsageLimits: true });
    });

    it('never overwrites an explicit false', async () => {
      const settings = { subagentTrackingEnabled: true, showPlanUsageLimits: false };
      mockedReadFile.mockResolvedValue(JSON.stringify(settings) as never);
      mockedWriteFile.mockClear();

      const res = await harness.app.inject({ method: 'GET', url: '/api/settings' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual(settings);
      // No reconciliation write when the key is already explicit.
      expect(mockedWriteFile).not.toHaveBeenCalled();
    });
  });

  // ========== PUT /api/settings ==========

  describe('PUT /api/settings', () => {
    it('saves valid settings', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { showSystemStats: true, subagentTrackingEnabled: false },
      });
      expect(res.statusCode).toBe(200);
      expect(mockedWriteFile).toHaveBeenCalled();
    });

    it('merges with existing settings', async () => {
      mockedReadFile.mockResolvedValue(JSON.stringify({ showCost: true }) as never);

      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { showTokenCount: false },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({});

      // Verify writeFile was called with merged content
      const writtenContent = JSON.parse(mockedWriteFile.mock.calls[0][1] as string);
      expect(writtenContent.showCost).toBe(true);
      expect(writtenContent.showTokenCount).toBe(false);
    });

    it('rejects unknown settings fields (strict schema)', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { unknownField: 'bad' },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });

    it('saves lastUsedCase as partial update without overwriting other settings', async () => {
      mockedReadFile.mockResolvedValue(
        JSON.stringify({ showCost: true, showTokenCount: false, subagentTrackingEnabled: true }) as never
      );

      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { lastUsedCase: 'my-test-case' },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({});

      const writtenContent = JSON.parse(mockedWriteFile.mock.calls[0][1] as string);
      expect(writtenContent.lastUsedCase).toBe('my-test-case');
      expect(writtenContent.showCost).toBe(true);
      expect(writtenContent.showTokenCount).toBe(false);
      expect(writtenContent.subagentTrackingEnabled).toBe(true);
    });

    it('rejects settings with modelConfig (strict schema prevents full-object PUT)', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: { lastUsedCase: 'test', modelConfig: { model: 'something' } },
      });
      // Fastify rejects unknown fields at schema validation level (400) before handler runs
      expect(res.statusCode).toBe(400);
    });

    it('rejects non-object body', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/settings',
        payload: 'not-an-object',
        headers: { 'content-type': 'application/json' },
      });
      // Fastify will reject non-object JSON before it reaches the handler
      expect(res.statusCode).not.toBe(200);
    });
  });

  // ========== GET /api/subagent-window-states ==========

  describe('GET /api/subagent-window-states', () => {
    it('returns default when file does not exist', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const res = await harness.app.inject({ method: 'GET', url: '/api/subagent-window-states' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ minimized: {}, open: [] });
    });

    it('returns persisted window states', async () => {
      const states = { minimized: { 'agent-1': true }, open: ['agent-2'] };
      mockedReadFile.mockResolvedValue(JSON.stringify(states) as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/subagent-window-states' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual(states);
    });
  });

  // ========== PUT /api/subagent-window-states ==========

  describe('PUT /api/subagent-window-states', () => {
    it('saves valid window states', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/subagent-window-states',
        payload: { minimized: { 'agent-1': true }, open: ['agent-2'] },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({});
      expect(mockedWriteFile).toHaveBeenCalled();
    });

    it('accepts empty state', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/subagent-window-states',
        payload: { minimized: {}, open: [] },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({});
    });

    it('rejects invalid minimized values', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/subagent-window-states',
        payload: { minimized: { 'agent-1': 'not-a-boolean' } },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== GET /api/subagent-parents ==========

  describe('GET /api/subagent-parents', () => {
    it('returns empty object when file does not exist', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const res = await harness.app.inject({ method: 'GET', url: '/api/subagent-parents' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({});
    });

    it('returns persisted parent map', async () => {
      const parents = { 'agent-1': 'session-abc', 'agent-2': 'session-xyz' };
      mockedReadFile.mockResolvedValue(JSON.stringify(parents) as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/subagent-parents' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual(parents);
    });
  });

  // ========== PUT /api/subagent-parents ==========

  describe('PUT /api/subagent-parents', () => {
    it('saves valid parent map', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/subagent-parents',
        payload: { 'agent-1': 'session-abc' },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({});
      expect(mockedWriteFile).toHaveBeenCalled();
    });

    it('accepts empty parent map', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/subagent-parents',
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({});
    });

    it('rejects non-string values in parent map', async () => {
      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/subagent-parents',
        payload: { 'agent-1': 123 },
      });
      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
    });
  });

  // ========== GET /api/screenshots ==========

  describe('GET /api/screenshots', () => {
    it('returns empty list when directory does not exist', async () => {
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({ method: 'GET', url: '/api/screenshots' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ files: [] });
    });

    it('returns image files sorted in reverse order', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReaddirSync.mockReturnValue([
        'screenshot_2026-01-01_00-00-00.png',
        'screenshot_2026-01-02_00-00-00.png',
        'not-an-image.txt',
        'screenshot_2026-01-03_00-00-00.jpg',
      ] as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/screenshots' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.files).toHaveLength(3); // excludes .txt
      // Sorted reverse: 03, 02, 01
      expect(body.files[0].name).toBe('screenshot_2026-01-03_00-00-00.jpg');
      expect(body.files[1].name).toBe('screenshot_2026-01-02_00-00-00.png');
      expect(body.files[2].name).toBe('screenshot_2026-01-01_00-00-00.png');
    });
  });

  // ========== GET /api/screenshots/:name ==========

  describe('GET /api/screenshots/:name', () => {
    it('rejects path traversal attempts', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/screenshots/..%2F..%2Fetc%2Fpasswd',
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 404 when screenshot does not exist', async () => {
      mockedExistsSync.mockReturnValue(false);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/screenshots/nonexistent.png',
      });
      expect(res.statusCode).toBe(404);
    });

    it('serves existing screenshot with correct content type', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFile.mockResolvedValue(Buffer.from('fake-png-data') as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/screenshots/test-image.png',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
    });

    it('serves jpeg with correct content type', async () => {
      mockedExistsSync.mockReturnValue(true);
      mockedReadFile.mockResolvedValue(Buffer.from('fake-jpg-data') as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/screenshots/photo.jpg',
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
    });
  });

  // ========== POST /api/screenshots ==========

  describe('POST /api/screenshots', () => {
    it('rejects non-multipart content type', async () => {
      const res = await harness.app.inject({
        method: 'POST',
        url: '/api/screenshots',
        payload: { file: 'data' },
        headers: { 'content-type': 'application/json' },
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('multipart');
    });
  });

  // ========== GET /api/session-lifecycle ==========

  describe('GET /api/session-lifecycle', () => {
    it('returns lifecycle entries', async () => {
      const mockEntries = [{ event: 'session_created', sessionId: 'test-1', timestamp: Date.now() }];
      mockedGetLifecycleLog.mockReturnValue({
        log: vi.fn(),
        query: vi.fn(async () => mockEntries),
      } as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/session-lifecycle' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.entries).toEqual(mockEntries);
    });

    it('passes filter query params to lifecycle log', async () => {
      const queryFn = vi.fn(async () => []);
      mockedGetLifecycleLog.mockReturnValue({
        log: vi.fn(),
        query: queryFn,
      } as never);

      await harness.app.inject({
        method: 'GET',
        url: '/api/session-lifecycle?sessionId=s1&event=session_created&since=1000&limit=50',
      });

      expect(queryFn).toHaveBeenCalledWith({
        sessionId: 's1',
        event: 'session_created',
        since: 1000,
        limit: 50,
      });
    });

    it('caps limit at 1000', async () => {
      const queryFn = vi.fn(async () => []);
      mockedGetLifecycleLog.mockReturnValue({
        log: vi.fn(),
        query: queryFn,
      } as never);

      await harness.app.inject({
        method: 'GET',
        url: '/api/session-lifecycle?limit=5000',
      });

      expect(queryFn).toHaveBeenCalledWith(expect.objectContaining({ limit: 1000 }));
    });

    it('defaults limit to 200 when not specified', async () => {
      const queryFn = vi.fn(async () => []);
      mockedGetLifecycleLog.mockReturnValue({
        log: vi.fn(),
        query: queryFn,
      } as never);

      await harness.app.inject({ method: 'GET', url: '/api/session-lifecycle' });

      expect(queryFn).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }));
    });
  });

  // ========== GET /api/opencode/status ==========

  describe('GET /api/opencode/status', () => {
    it('returns unavailable when opencode is not installed', async () => {
      mockedIsOpenCodeAvailable.mockReturnValue(false);
      mockedResolveOpenCodeDir.mockReturnValue(null);

      const res = await harness.app.inject({ method: 'GET', url: '/api/opencode/status' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.available).toBe(false);
      expect(body.path).toBeNull();
    });

    it('returns available with path when opencode is installed', async () => {
      mockedIsOpenCodeAvailable.mockReturnValue(true);
      mockedResolveOpenCodeDir.mockReturnValue('/usr/local/bin');

      const res = await harness.app.inject({ method: 'GET', url: '/api/opencode/status' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.available).toBe(true);
      expect(body.path).toBe('/usr/local/bin');
    });
  });

  // ========== GET /api/gemini/status ==========

  describe('GET /api/gemini/status', () => {
    it('returns unavailable when gemini is not installed', async () => {
      mockedIsGeminiAvailable.mockReturnValue(false);
      mockedResolveGeminiDir.mockReturnValue(null);

      const res = await harness.app.inject({ method: 'GET', url: '/api/gemini/status' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.available).toBe(false);
      expect(body.path).toBeNull();
    });

    it('returns available with path when gemini is installed', async () => {
      mockedIsGeminiAvailable.mockReturnValue(true);
      mockedResolveGeminiDir.mockReturnValue('/usr/local/bin');

      const res = await harness.app.inject({ method: 'GET', url: '/api/gemini/status' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.available).toBe(true);
      expect(body.path).toBe('/usr/local/bin');
    });
  });

  // ========== GET /api/antigravity/status ==========

  describe('GET /api/antigravity/status', () => {
    it('returns unavailable when agy is not installed', async () => {
      mockedIsAntigravityAvailable.mockReturnValue(false);
      mockedResolveAntigravityDir.mockReturnValue(null);

      const res = await harness.app.inject({ method: 'GET', url: '/api/antigravity/status' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.available).toBe(false);
      expect(body.path).toBeNull();
    });

    it('returns available with path when agy is installed', async () => {
      mockedIsAntigravityAvailable.mockReturnValue(true);
      mockedResolveAntigravityDir.mockReturnValue('/home/user/.local/bin');

      const res = await harness.app.inject({ method: 'GET', url: '/api/antigravity/status' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.available).toBe(true);
      expect(body.path).toBe('/home/user/.local/bin');
    });
  });

  // ========== GET /api/pi/status ==========

  describe('GET /api/pi/status', () => {
    it('returns unavailable when pi is not installed', async () => {
      mockedIsPiAvailable.mockReturnValue(false);
      mockedResolvePiDir.mockReturnValue(null);
      mockedGetPiCliVersion.mockReturnValue(null);

      const res = await harness.app.inject({ method: 'GET', url: '/api/pi/status' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.available).toBe(false);
      expect(body.path).toBeNull();
      expect(body.version).toBeNull();
    });

    it('returns available with path AND version when pi is installed', async () => {
      // `version` is pi-specific: `pi` is a generic binary name, so the resolver
      // version-probes it and this endpoint is where a misresolution shows up.
      mockedIsPiAvailable.mockReturnValue(true);
      mockedResolvePiDir.mockReturnValue('/home/user/.local/bin');
      mockedGetPiCliVersion.mockReturnValue('0.84.1');

      const res = await harness.app.inject({ method: 'GET', url: '/api/pi/status' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.available).toBe(true);
      expect(body.path).toBe('/home/user/.local/bin');
      expect(body.version).toBe('0.84.1');
    });
  });

  // ========== GET /api/grok/status ==========

  describe('GET /api/grok/status', () => {
    it('returns unavailable when grok is not installed', async () => {
      mockedIsGrokAvailable.mockReturnValue(false);
      mockedResolveGrokDir.mockReturnValue(null);
      mockedGetGrokCliVersion.mockReturnValue(null);

      const res = await harness.app.inject({ method: 'GET', url: '/api/grok/status' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.available).toBe(false);
      expect(body.path).toBeNull();
      expect(body.version).toBeNull();
    });

    it('returns available with path AND version when grok is installed', async () => {
      // `version` matters for the same reason as pi: `grok` has known squatters,
      // so this endpoint is where a misresolution shows up.
      mockedIsGrokAvailable.mockReturnValue(true);
      mockedResolveGrokDir.mockReturnValue('/home/user/.grok/bin');
      mockedGetGrokCliVersion.mockReturnValue('1.0.5');

      const res = await harness.app.inject({ method: 'GET', url: '/api/grok/status' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.available).toBe(true);
      expect(body.path).toBe('/home/user/.grok/bin');
      expect(body.version).toBe('1.0.5');
    });
  });

  // ========== GET /api/execution/model-config ==========

  describe('GET /api/execution/model-config', () => {
    it('returns empty data when settings file does not exist', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const res = await harness.app.inject({ method: 'GET', url: '/api/execution/model-config' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toEqual({});
    });

    it('returns model config from settings', async () => {
      const settings = { modelConfig: { model: 'claude-3', temperature: 0.7 } };
      mockedReadFile.mockResolvedValue(JSON.stringify(settings) as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/execution/model-config' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toEqual(settings.modelConfig);
    });

    it('returns empty data when settings has no modelConfig', async () => {
      mockedReadFile.mockResolvedValue(JSON.stringify({ showCost: true }) as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/execution/model-config' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toEqual({});
    });
  });

  // ========== PUT /api/execution/model-config ==========

  describe('PUT /api/execution/model-config', () => {
    it('saves valid model config', async () => {
      mockedReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/execution/model-config',
        payload: { model: 'claude-3', temperature: 0.5 },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({});
      expect(mockedWriteFile).toHaveBeenCalled();

      // Verify the written content contains modelConfig
      const writtenContent = JSON.parse(mockedWriteFile.mock.calls[0][1] as string);
      expect(writtenContent.modelConfig).toEqual({ model: 'claude-3', temperature: 0.5 });
    });

    it('preserves existing settings when updating model config', async () => {
      mockedReadFile.mockResolvedValue(JSON.stringify({ showCost: true, other: 'value' }) as never);

      const res = await harness.app.inject({
        method: 'PUT',
        url: '/api/execution/model-config',
        payload: { model: 'new-model' },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({});

      const writtenContent = JSON.parse(mockedWriteFile.mock.calls[0][1] as string);
      expect(writtenContent.showCost).toBe(true);
      expect(writtenContent.other).toBe('value');
      expect(writtenContent.modelConfig).toEqual({ model: 'new-model' });
    });
  });

  // ========== GET /api/subagents/:agentId ==========

  describe('GET /api/subagents/:agentId', () => {
    it('returns 200 with error for unknown agent', async () => {
      mockedSubagentWatcher.getSubagent.mockReturnValue(null);

      const res = await harness.app.inject({ method: 'GET', url: '/api/subagents/unknown-agent' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });

    it('returns agent info for known agent', async () => {
      const agentInfo = { agentId: 'agent-1', status: 'active', pid: 1234 };
      mockedSubagentWatcher.getSubagent.mockReturnValue(agentInfo as never);

      const res = await harness.app.inject({ method: 'GET', url: '/api/subagents/agent-1' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toEqual(agentInfo);
    });
  });

  // ========== GET /api/subagents/:agentId/transcript ==========

  describe('GET /api/subagents/:agentId/transcript', () => {
    it('returns raw transcript by default', async () => {
      const transcript = [{ role: 'assistant', content: 'hello' }];
      mockedSubagentWatcher.getTranscript.mockResolvedValue(transcript as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/subagents/agent-1/transcript',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toEqual(transcript);
    });

    it('returns formatted transcript when format=formatted', async () => {
      const transcript = [{ role: 'assistant', content: 'hello' }];
      mockedSubagentWatcher.getTranscript.mockResolvedValue(transcript as never);
      mockedSubagentWatcher.formatTranscript.mockReturnValue('## Formatted\nhello');

      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/subagents/agent-1/transcript?format=formatted',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.formatted).toBe('## Formatted\nhello');
      expect(body.data.entryCount).toBe(1);
    });

    it('passes limit parameter', async () => {
      mockedSubagentWatcher.getTranscript.mockResolvedValue([] as never);

      await harness.app.inject({
        method: 'GET',
        url: '/api/subagents/agent-1/transcript?limit=10',
      });
      expect(mockedSubagentWatcher.getTranscript).toHaveBeenCalledWith('agent-1', 10);
    });
  });

  // ========== DELETE /api/subagents/:agentId ==========

  describe('DELETE /api/subagents/:agentId', () => {
    it('returns error for unknown agent', async () => {
      mockedSubagentWatcher.getSubagent.mockReturnValue(null);

      const res = await harness.app.inject({ method: 'DELETE', url: '/api/subagents/unknown' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('not found');
    });

    it('kills a known agent successfully', async () => {
      mockedSubagentWatcher.getSubagent.mockReturnValue({ agentId: 'agent-1' } as never);
      mockedSubagentWatcher.killSubagent.mockResolvedValue(true);

      const res = await harness.app.inject({ method: 'DELETE', url: '/api/subagents/agent-1' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.status).toBe('killed');
    });

    it('returns error when kill fails', async () => {
      mockedSubagentWatcher.getSubagent.mockReturnValue({ agentId: 'agent-1' } as never);
      mockedSubagentWatcher.killSubagent.mockResolvedValue(false);

      const res = await harness.app.inject({ method: 'DELETE', url: '/api/subagents/agent-1' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(false);
      expect(body.error).toContain('already completed');
    });
  });

  // ========== POST /api/subagents/cleanup ==========

  describe('POST /api/subagents/cleanup', () => {
    it('triggers cleanup and returns count', async () => {
      mockedSubagentWatcher.cleanupNow.mockReturnValue(3);
      mockedSubagentWatcher.getSubagents.mockReturnValue([{ agentId: 'a' }, { agentId: 'b' }] as never);

      const res = await harness.app.inject({ method: 'POST', url: '/api/subagents/cleanup' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.removed).toBe(3);
      expect(body.data.remaining).toBe(2);
    });
  });

  // ========== DELETE /api/subagents ==========

  describe('DELETE /api/subagents', () => {
    it('clears all subagents', async () => {
      mockedSubagentWatcher.clearAll.mockReturnValue(5);

      const res = await harness.app.inject({ method: 'DELETE', url: '/api/subagents' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data.cleared).toBe(5);
    });
  });

  // ========== GET /api/sessions/:id/subagents ==========

  describe('GET /api/sessions/:id/subagents', () => {
    it('returns 404 for unknown session', async () => {
      const res = await harness.app.inject({
        method: 'GET',
        url: '/api/sessions/nonexistent/subagents',
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns subagents for valid session', async () => {
      mockedSubagentWatcher.getSubagentsForSession.mockReturnValue([{ agentId: 'sub-1', status: 'active' }] as never);

      const res = await harness.app.inject({
        method: 'GET',
        url: `/api/sessions/${harness.ctx._sessionId}/subagents`,
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
      expect(body.data).toHaveLength(1);
    });
  });

  // ========== POST /api/tunnel/qr/regenerate ==========

  describe('POST /api/tunnel/qr/regenerate', () => {
    it('calls regenerateQrToken on tunnel manager', async () => {
      // Set up a mock tunnel manager
      harness.ctx.tunnelManager = {
        regenerateQrToken: vi.fn(),
        getStatus: vi.fn(() => ({ running: false })),
        getUrl: vi.fn(() => null),
        getQrSvg: vi.fn(),
        consumeToken: vi.fn(),
        isRunning: vi.fn(() => false),
        start: vi.fn(),
        stop: vi.fn(),
      } as never;

      // Re-create the harness since tunnelManager was null originally
      await harness.app.close();
      harness = await createRouteTestHarness(registerSystemRoutes);
      harness.ctx.tunnelManager = {
        regenerateQrToken: vi.fn(),
        getStatus: vi.fn(() => ({ running: false })),
        getUrl: vi.fn(() => null),
        getQrSvg: vi.fn(),
        consumeToken: vi.fn(),
        isRunning: vi.fn(() => false),
        start: vi.fn(),
        stop: vi.fn(),
      } as never;

      const res = await harness.app.inject({ method: 'POST', url: '/api/tunnel/qr/regenerate' });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({});
    });
  });
});
