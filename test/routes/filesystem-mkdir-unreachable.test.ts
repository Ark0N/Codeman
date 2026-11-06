/**
 * @fileoverview `POST /api/filesystem/mkdir` probes the folder bounded before the picker's
 * resolver runs `realpathSync` on it (#516): a mount that stopped answering is refused, and
 * the request never reaches a synchronous call that would freeze the server.
 *
 * The probe is mocked: a mount that never answers cannot be made here. Port: none (inject).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/utils/bounded-path-probe.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/utils/bounded-path-probe.js')>();
  return { ...actual, probePathKind: vi.fn(actual.probePathKind) };
});

import { probePathKind } from '../../src/utils/bounded-path-probe.js';
import { registerFileRoutes } from '../../src/web/routes/file-routes.js';
import { createRouteTestHarness } from './_route-test-utils.js';

describe('POST /api/filesystem/mkdir on an unresponsive mount', () => {
  afterEach(() => vi.mocked(probePathKind).mockClear());

  it('refuses before the picker resolver touches the path', async () => {
    vi.mocked(probePathKind).mockResolvedValueOnce('unknown');
    const { app } = await createRouteTestHarness(registerFileRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/api/filesystem/mkdir',
      payload: { path: '/mnt/dead/projects', name: 'fresh' },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().errorCode).toBe('OPERATION_FAILED');
    expect(res.json().error).toMatch(/not responding|not checked/);
    expect(probePathKind).toHaveBeenCalledWith('/mnt/dead/projects', { pastCap: true });
  });
});
