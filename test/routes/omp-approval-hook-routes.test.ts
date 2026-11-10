/**
 * @fileoverview The omp approval hook module on BOTH session create paths.
 *
 * `POST /api/quick-start` is how the Run button, the agent skill's `spawn_worker` and
 * `codeman agent spawn` start omp, so installing only from `POST /api/sessions` left the
 * usual omp launch silent. These tests pin, on disk:
 *  - both paths write `.claude/hooks/pre/codeman-approval.ts` into a local workspace;
 *  - neither writes Claude's `.claude/settings.local.json` hook block for omp (only
 *    claude reads it) or, for a Docker case, a CLAUDE.md;
 *  - `workspaceHooksEnabled: false` writes nothing;
 *  - a create refused by the launch pre-flight leaves nothing behind.
 *
 * The launch pre-flight is mocked so the result does not depend on whether omp is
 * installed on the machine running the suite. Uses app.inject(), no port.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyCookie from '@fastify/cookie';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMockRouteContext, safeRmHomeTree } from '../mocks/index.js';
import { installRouteErrorHandler } from '../../src/web/route-error-handler.js';
import { registerSessionRoutes } from '../../src/web/routes/session-routes.js';
import { OMP_APPROVAL_HOOK_DIR, OMP_APPROVAL_HOOK_FILE } from '../../src/hooks-config.js';
import { getDataDir } from '../../src/config/instance.js';
import { CASES_DIR } from '../../src/web/route-helpers.js';
import { Session } from '../../src/session.js';

const launch = vi.hoisted(() => ({ error: null as string | null }));
vi.mock('../../src/utils/cli-launcher.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/utils/cli-launcher.js')>()),
  resolveCliLaunchError: vi.fn(async () => launch.error),
}));

const hookFileIn = (dir: string) => join(dir, OMP_APPROVAL_HOOK_DIR, OMP_APPROVAL_HOOK_FILE);
const claudeSettingsIn = (dir: string) => join(dir, '.claude', 'settings.local.json');

/**
 * A create that SUCCEEDED. The status alone cannot say so: `createErrorResponse()`
 * envelopes come back as 200 here (no preSerialization hook), so an early refusal would
 * make every "wrote nothing" assertion below pass vacuously. A success body is the raw
 * payload (no envelope), so the proof is a real session id in it.
 */
function expectCreated(res: { statusCode: number; body: string }) {
  expect(res.statusCode).toBe(200);
  const body = JSON.parse(res.body) as { success?: boolean; session?: { id?: string }; sessionId?: string };
  expect(body.success, res.body).not.toBe(false);
  expect(body.session?.id ?? body.sessionId, res.body).toBeTruthy();
}

describe('omp approval hook on the create paths', () => {
  let app: FastifyInstance;

  const useApp = async (workspaceHooksEnabled = true) => {
    await app?.close();
    app = Fastify({ logger: false });
    await app.register(fastifyCookie);
    registerSessionRoutes(app, createMockRouteContext({ workspaceHooksEnabled }));
    installRouteErrorHandler(app);
    await app.ready();
  };

  beforeEach(async () => {
    launch.error = null;
    vi.spyOn(Session.prototype, 'startInteractive').mockResolvedValue(undefined);
    vi.spyOn(Session.prototype, 'startShell').mockResolvedValue(undefined);
    await useApp();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
    await rm(join(getDataDir(), 'docker-hosts.json'), { force: true });
    await rm(join(getDataDir(), 'docker-cases.json'), { force: true });
    // CASES_DIR sits under the (redirected) test HOME; safeRmHomeTree refuses anything else.
    safeRmHomeTree(CASES_DIR);
  });

  describe('POST /api/sessions', () => {
    let workingDir: string;
    const createSession = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/sessions', payload });

    beforeEach(async () => {
      workingDir = await mkdtemp(join(tmpdir(), 'codeman-omp-create-'));
    });

    afterEach(async () => {
      await rm(workingDir, { recursive: true, force: true });
    });

    it('installs the module, and no Claude hook block', async () => {
      expectCreated(await createSession({ name: 'omp-create', mode: 'omp', workingDir }));
      expect(existsSync(hookFileIn(workingDir))).toBe(true);
      expect(existsSync(claudeSettingsIn(workingDir))).toBe(false);
    });

    it('writes nothing when workspaceHooksEnabled is off', async () => {
      await useApp(false);
      expectCreated(await createSession({ name: 'omp-off', mode: 'omp', workingDir }));
      expect(existsSync(join(workingDir, '.claude'))).toBe(false);
    });

    it('leaves nothing behind when the launch pre-flight refuses the create', async () => {
      launch.error = 'omp: command not found';
      const res = await createSession({ name: 'omp-missing', mode: 'omp', workingDir });
      expect(res.json().success).toBe(false);
      expect(existsSync(join(workingDir, '.claude'))).toBe(false);
    });

    it('gives claude no module', async () => {
      expectCreated(await createSession({ name: 'claude-create', mode: 'claude', workingDir }));
      expect(existsSync(hookFileIn(workingDir))).toBe(false);
    });
  });

  describe('POST /api/quick-start', () => {
    const quickStart = (payload: Record<string, unknown>) =>
      app.inject({ method: 'POST', url: '/api/quick-start', payload });

    it('installs the module into an EXISTING case, and no Claude hook block', async () => {
      const casePath = join(CASES_DIR, 'ompexisting');
      await mkdir(casePath, { recursive: true });
      expectCreated(await quickStart({ caseName: 'ompexisting', mode: 'omp' }));
      expect(existsSync(hookFileIn(casePath))).toBe(true);
      expect(existsSync(claudeSettingsIn(casePath))).toBe(false);
    });

    it('installs the module into a case it scaffolds, and no Claude hook block', async () => {
      expectCreated(await quickStart({ caseName: 'ompnew', mode: 'omp' }));
      const casePath = join(CASES_DIR, 'ompnew');
      expect(existsSync(hookFileIn(casePath))).toBe(true);
      expect(existsSync(claudeSettingsIn(casePath))).toBe(false);
    });

    it('writes nothing into an existing case when workspaceHooksEnabled is off', async () => {
      await useApp(false);
      const casePath = join(CASES_DIR, 'ompoff');
      await mkdir(casePath, { recursive: true });
      expectCreated(await quickStart({ caseName: 'ompoff', mode: 'omp' }));
      expect(existsSync(join(casePath, '.claude'))).toBe(false);
    });

    it('leaves nothing behind when the launch pre-flight refuses', async () => {
      launch.error = 'omp: command not found';
      const casePath = join(CASES_DIR, 'ompmissing');
      await mkdir(casePath, { recursive: true });
      const res = await quickStart({ caseName: 'ompmissing', mode: 'omp' });
      expect(res.json().success).toBe(false);
      expect(existsSync(join(casePath, '.claude'))).toBe(false);
    });

    it('writes neither the module nor a Claude block (or CLAUDE.md) into a Docker case', async () => {
      const ws = await mkdtemp(join(tmpdir(), 'codeman-docker-omp-'));
      try {
        await mkdir(getDataDir(), { recursive: true });
        await writeFile(
          join(getDataDir(), 'docker-hosts.json'),
          JSON.stringify([{ id: 'd1', label: 'box', image: 'codeman/agent:base' }])
        );
        await writeFile(
          join(getDataDir(), 'docker-cases.json'),
          JSON.stringify([{ name: 'dockomp', type: 'docker', hostId: 'd1', hostWorkspacePath: ws }])
        );
        expectCreated(await quickStart({ caseName: 'dockomp', mode: 'omp' }));
        expect(existsSync(hookFileIn(ws))).toBe(false);
        expect(existsSync(claudeSettingsIn(ws))).toBe(false);
        expect(existsSync(join(ws, 'CLAUDE.md'))).toBe(false);
      } finally {
        await rm(ws, { recursive: true, force: true });
      }
    });
  });
});
