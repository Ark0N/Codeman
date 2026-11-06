/**
 * @fileoverview Ralph file routes for a REMOTE (SSH) session.
 *
 * A remote session's `workingDir` is a path on the remote host. `fix-plan/read`
 * used to read `@fix_plan.md` with local `fs`, and `fix-plan/write` and
 * `ralph-prompt/write` wrote their files with it, so with a same-named local folder
 * (an sshfs mount, a shared home layout) they read and wrote the LOCAL twin. Now:
 *  - `fix-plan/read` reads the file on the remote host through `src/remote-files.ts`
 *    (the File Viewer's ssh path), and a missing remote file is the same 404 as a
 *    missing local one;
 *  - both writes are refused (remote writes are out of scope, like the File Viewer's
 *    remote edit).
 *
 * The workspace path EXISTS locally here, holding a different `@fix_plan.md`, so a
 * route that fell back to local `fs` would visibly import or overwrite the wrong file.
 * The ssh layer is mocked (no connection is opened); the pure builders and
 * `RemoteFileAccessError` stay real.
 *
 * Port: N/A (app.inject doesn't open ports)
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';
import { safeRmHomeTree } from '../mocks/test-helpers.js';
import { registerRalphRoutes } from '../../src/web/routes/ralph-routes.js';
import type { RemoteProbe } from '../../src/remote-files.js';
import type { SessionRemote } from '../../src/types/session.js';

vi.mock('../../src/remote-files.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/remote-files.js')>();
  return { ...actual, remoteProbePaths: vi.fn(), remoteReadFile: vi.fn() };
});

import { remoteProbePaths, remoteReadFile, RemoteFileAccessError } from '../../src/remote-files.js';

const mockedProbePaths = vi.mocked(remoteProbePaths);
const mockedReadFile = vi.mocked(remoteReadFile);

// The local twin of the remote workspace: same absolute path, different file.
const TWIN = join(homedir(), '.codeman-test-ralph-remote-twin');
const LOCAL_PLAN = '# Fix Plan\n\n- [ ] LOCAL task\n';
const REMOTE_PLAN = '# Fix Plan\n\n- [ ] REMOTE task\n';
const remote: SessionRemote = {
  hostId: 'host-1',
  label: 'testhost',
  host: '192.0.2.10',
  username: 'j',
  remotePath: TWIN,
};

function fileProbe(size = REMOTE_PLAN.length): RemoteProbe {
  return { realPath: join(TWIN, '@fix_plan.md'), kind: 'file', size, mtimeMs: 1_700_000_000_000 };
}

const rootProbe: RemoteProbe = { realPath: TWIN, kind: 'directory', size: 0, mtimeMs: 0 };

describe('ralph file routes for a remote (SSH) session', () => {
  let harness: RouteTestHarness;
  let importFixPlanMarkdown: ReturnType<typeof vi.fn>;

  beforeAll(() => {
    mkdirSync(TWIN, { recursive: true });
  });

  afterAll(() => {
    safeRmHomeTree(TWIN);
  });

  beforeEach(async () => {
    writeFileSync(join(TWIN, '@fix_plan.md'), LOCAL_PLAN);
    harness = await createRouteTestHarness(registerRalphRoutes);
    importFixPlanMarkdown = vi.fn(() => 1);
    const session = harness.ctx._session as unknown as Record<string, unknown>;
    session.workingDir = TWIN;
    session.remote = { ...remote };
    session.ralphTracker = {
      generateFixPlanMarkdown: vi.fn(() => '# Fix Plan\n\n- [ ] generated\n'),
      importFixPlanMarkdown,
      todos: [],
    };
    mockedProbePaths.mockResolvedValue([fileProbe(), rootProbe]);
    mockedReadFile.mockResolvedValue(Buffer.from(REMOTE_PLAN));
  });

  afterEach(async () => {
    await harness.app.close();
    vi.clearAllMocks();
  });

  const post = (route: string, payload?: unknown) =>
    harness.app.inject({ method: 'POST', url: `/api/sessions/${harness.ctx._sessionId}/${route}`, payload });

  describe('POST fix-plan/read', () => {
    it('imports the file from the remote host, not the local twin', async () => {
      const res = await post('fix-plan/read');
      expect(JSON.parse(res.body)).toMatchObject({ success: true, data: { importedCount: 1 } });
      expect(mockedProbePaths).toHaveBeenCalledWith(remote, [join(TWIN, '@fix_plan.md'), TWIN]);
      expect(mockedReadFile).toHaveBeenCalledWith(remote, join(TWIN, '@fix_plan.md'), expect.any(Number));
      expect(importFixPlanMarkdown).toHaveBeenCalledWith(REMOTE_PLAN);
      expect(harness.ctx.persistSessionState).toHaveBeenCalled();
    });

    it('answers the same not-found as a local read when the remote file is missing', async () => {
      mockedProbePaths.mockResolvedValue([null, rootProbe]);
      const res = await post('fix-plan/read');
      expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: 'NOT_FOUND' });
      expect(mockedReadFile).not.toHaveBeenCalled();
      expect(importFixPlanMarkdown).not.toHaveBeenCalled();
    });

    it('treats a @fix_plan.md that resolves outside the workspace as missing', async () => {
      // e.g. a symlink to ~/.ssh/id_rsa on the remote host: the File Viewer's confinement applies.
      mockedProbePaths.mockResolvedValue([{ ...fileProbe(), realPath: '/home/j/.ssh/id_rsa' }, rootProbe]);
      const res = await post('fix-plan/read');
      expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: 'NOT_FOUND' });
      expect(mockedReadFile).not.toHaveBeenCalled();
      expect(importFixPlanMarkdown).not.toHaveBeenCalled();
    });

    it('refuses a remote path that is not a regular file, or one over the cap, without reading it', async () => {
      for (const probe of [
        { ...fileProbe(), kind: 'directory' as const },
        { ...fileProbe(), kind: 'other' as const },
        fileProbe(64 * 1024 * 1024),
      ]) {
        mockedProbePaths.mockResolvedValue([probe, rootProbe]);
        const res = await post('fix-plan/read');
        expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: 'OPERATION_FAILED' });
      }
      expect(mockedReadFile).not.toHaveBeenCalled();
      expect(importFixPlanMarkdown).not.toHaveBeenCalled();
    });

    it('reports an unreachable host as a failed read, never a local fallback', async () => {
      mockedProbePaths.mockRejectedValue(new RemoteFileAccessError('remote host testhost unreachable: timeout'));
      const res = await post('fix-plan/read');
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({ success: false, errorCode: 'OPERATION_FAILED' });
      expect(body.error).toContain('unreachable');
      expect(body.error).not.toContain('RemoteFileAccessError');
      expect(importFixPlanMarkdown).not.toHaveBeenCalled();
    });
  });

  describe('writes', () => {
    it('refuses fix-plan/write and leaves the local twin alone', async () => {
      const res = await post('fix-plan/write');
      expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
      expect(readFileSync(join(TWIN, '@fix_plan.md'), 'utf-8')).toBe(LOCAL_PLAN);
    });

    it('refuses ralph-prompt/write and creates nothing locally', async () => {
      const res = await post('ralph-prompt/write', { content: 'do the thing' });
      expect(JSON.parse(res.body)).toMatchObject({ success: false, errorCode: 'INVALID_INPUT' });
      expect(existsSync(join(TWIN, '@ralph_prompt.md'))).toBe(false);
    });
  });

  describe('a local session is unchanged', () => {
    beforeEach(() => {
      delete (harness.ctx._session as unknown as Record<string, unknown>).remote;
    });

    it('reads the local file without touching ssh', async () => {
      const res = await post('fix-plan/read');
      expect(JSON.parse(res.body)).toMatchObject({ success: true });
      expect(importFixPlanMarkdown).toHaveBeenCalledWith(LOCAL_PLAN);
      expect(mockedProbePaths).not.toHaveBeenCalled();
      expect(mockedReadFile).not.toHaveBeenCalled();
    });

    it('writes the local files', async () => {
      expect(JSON.parse((await post('fix-plan/write')).body)).toMatchObject({ success: true });
      expect(readFileSync(join(TWIN, '@fix_plan.md'), 'utf-8')).toContain('generated');
      expect(JSON.parse((await post('ralph-prompt/write', { content: 'do the thing' })).body)).toMatchObject({
        success: true,
      });
      expect(readFileSync(join(TWIN, '@ralph_prompt.md'), 'utf-8')).toBe('do the thing');
    });
  });
});
