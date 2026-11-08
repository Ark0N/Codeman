/**
 * Cross-workspace attachment extensions with real files.
 * Port: N/A (app.inject doesn't open ports)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachmentRegistry } from '../../src/attachment-registry.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';
import { createRouteTestHarness, type RouteTestHarness } from './_route-test-utils.js';

describe('cross-workspace attachment extensions (real fs)', () => {
  let harness: RouteTestHarness;
  let workDir: string;
  let outsideDir: string;

  beforeEach(async () => {
    vi.stubEnv('CODEMAN_ATTACHMENT_CONFINE', undefined);
    vi.stubEnv('CODEMAN_ATTACHMENT_BLOCKED_PATHS', undefined);
    harness = await createRouteTestHarness(registerFileRoutes);
    workDir = realpathSync(mkdtempSync(join(tmpdir(), 'codeman-attachment-ws-')));
    outsideDir = realpathSync(mkdtempSync(join(tmpdir(), 'codeman-attachment-out-')));
    harness.ctx._session.workingDir = workDir;
    attachmentRegistry.clearSession(harness.ctx._sessionId);
  });

  afterEach(async () => {
    await harness.app.close();
    attachmentRegistry.clearSession(harness.ctx._sessionId);
    rmSync(workDir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it.each(['prod.env', 'CONFIG.ENV', 'unsupported.xyz'])(
    'refuses outside %s as an unsupported attachment without an id',
    async (fileName) => {
      const path = join(outsideDir, fileName);
      writeFileSync(path, 'FIXTURE_ONLY=value\n');

      const res = await harness.app.inject({
        method: 'POST',
        url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
        payload: { path },
      });
      const body = res.json();

      expect.soft(res.statusCode).toBe(400);
      expect.soft(body.success).toBe(false);
      expect.soft(body.errorCode).toBe('INVALID_INPUT');
      expect.soft(body.data?.attachmentId).toBe(undefined);
      expect.soft(body.attachmentId).toBe(undefined);
    }
  );

  it('registers outside notes.md with default attachment settings', async () => {
    const path = join(outsideDir, 'notes.md');
    const content = '# Outside notes\n';
    writeFileSync(path, content);

    const res = await harness.app.inject({
      method: 'POST',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments`,
      payload: { path },
    });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.fileName).toBe('notes.md');
    expect(body.data.extension).toBe('md');
    expect(body.data.size).toBe(Buffer.byteLength(content));

    const raw = await harness.app.inject({
      method: 'GET',
      url: `/api/sessions/${harness.ctx._sessionId}/attachments/${body.data.attachmentId}/raw`,
    });
    expect(raw.statusCode).toBe(200);
    expect(raw.body).toBe(content);
  });
});
