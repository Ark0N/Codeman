import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { registerSystemRoutes } from '../../src/web/routes/system-routes.js';

const { subagentWatcher, imageWatcher, workflowRunWatcher, fileSystem } = vi.hoisted(() => {
  const makeWatcher = () => ({
    isRunning: vi.fn(() => false),
    start: vi.fn(),
    stop: vi.fn(),
    getStats: vi.fn(() => ({})),
    watchSession: vi.fn(),
    getRecentRunSummaries: vi.fn(() => []),
  });

  // Simulate in-memory file storage
  let storedSettings: Record<string, unknown> = {};

  return {
    subagentWatcher: makeWatcher(),
    imageWatcher: makeWatcher(),
    workflowRunWatcher: makeWatcher(),
    fileSystem: {
      storedSettings,
    },
  };
});

vi.mock('node:fs/promises', () => ({
  default: {
    readFile: vi.fn(async () => JSON.stringify(fileSystem.storedSettings)),
    writeFile: vi.fn(async (_path: string, content: string) => {
      fileSystem.storedSettings = JSON.parse(content);
    }),
  },
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(() => true), mkdirSync: vi.fn(), readdirSync: vi.fn(() => []) };
});

vi.mock('../../src/subagent-watcher.js', () => ({ subagentWatcher }));
vi.mock('../../src/image-watcher.js', () => ({ imageWatcher }));
vi.mock('../../src/workflow-run-watcher.js', () => ({ workflowRunWatcher }));

describe('showSplitButton setting', () => {
  let harness: RouteTestHarness;

  beforeEach(async () => {
    harness = await createRouteTestHarness(registerSystemRoutes);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('round-trips through PUT and GET /api/settings', async () => {
    const putRes = await harness.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { showSplitButton: true },
    });
    expect(putRes.statusCode).toBe(200);

    const getRes = await harness.app.inject({ method: 'GET', url: '/api/settings' });
    const body = JSON.parse(getRes.body);
    expect(body.showSplitButton).toBe(true);
  });
});
