/**
 * @fileoverview Clone Repo must not lend the server account's git sign-in to
 * non-admins in multi-user mode (PR #472 review).
 *
 * Every Codeman user's git runs as the one server account, so a credential
 * helper that account has (the Docker image's opt-in `gh`/`az` helpers, or any
 * `gh auth setup-git`) would otherwise clone a PRIVATE repository with the
 * signed-in admin's credentials into a non-admin's case space, the same
 * boundary the local-transport rule guards. These tests pin the ROUTE decision:
 * who gets `withoutCredentialHelpers`. The argv it becomes is pinned in
 * `test/git-clone.test.ts`, and the real-git clone path in
 * `case-clone-routes.test.ts`.
 *
 * Only the two network calls are mocked, so no git runs and nothing leaves the
 * machine; everything else in `git-clone.ts` (URL parsing included) is real.
 *
 * Port: N/A (app.inject).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRouteTestHarness } from './_route-test-utils.js';
import { registerCaseRoutes } from '../../src/web/routes/case-routes.js';

const calls = vi.hoisted(() => ({
  probe: [] as Array<{ repository: string; opts: unknown }>,
  clone: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../src/git-clone.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/git-clone.js')>();
  return {
    ...actual,
    isGitAvailable: () => true,
    probeGitRemote: async (repository: string, _timeoutMs?: number, opts?: unknown) => {
      calls.probe.push({ repository, opts });
      return { reachable: false, branches: [], tags: [] };
    },
    cloneRepository: async (opts: Record<string, unknown>) => {
      calls.clone.push(opts);
      return { ok: false, failure: { code: 'AUTH_REQUIRED', message: 'needs auth', stderr: '' } };
    },
  };
});

const REPO = 'https://github.com/example/private-repo.git';

type Who = { username: string; role: 'admin' | 'user' } | undefined;

async function run(who: Who, multiUser: boolean): Promise<{ probe: unknown; clone: unknown }> {
  const prev = process.env.CODEMAN_MULTIUSER;
  if (multiUser) process.env.CODEMAN_MULTIUSER = '1';
  else delete process.env.CODEMAN_MULTIUSER;
  try {
    const { app } = await createRouteTestHarness(registerCaseRoutes, who ? { authUser: who } : undefined);
    await app.inject({ method: 'POST', url: '/api/cases/clone-preflight', payload: { repository: REPO } });
    await app.inject({
      method: 'POST',
      url: '/api/cases/clone',
      payload: { name: `cred-${Math.random().toString(36).slice(2, 10)}`, repository: REPO },
    });
    await app.close();
    expect(calls.probe, 'the preflight never reached probeGitRemote').toHaveLength(1);
    expect(calls.clone, 'the clone never reached cloneRepository').toHaveLength(1);
    return {
      probe: (calls.probe[0].opts as { withoutCredentialHelpers?: boolean } | undefined)?.withoutCredentialHelpers,
      clone: calls.clone[0].withoutCredentialHelpers,
    };
  } finally {
    if (prev === undefined) delete process.env.CODEMAN_MULTIUSER;
    else process.env.CODEMAN_MULTIUSER = prev;
  }
}

describe('Clone Repo credential helpers by caller', () => {
  beforeEach(() => {
    calls.probe.length = 0;
    calls.clone.length = 0;
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('clears them for a NON-ADMIN in multi-user mode (preflight AND clone)', async () => {
    expect(await run({ username: 'mallory', role: 'user' }, true)).toEqual({ probe: true, clone: true });
  });

  it('keeps them for an admin in multi-user mode', async () => {
    expect(await run({ username: 'root', role: 'admin' }, true)).toEqual({ probe: false, clone: false });
  });

  it('keeps them in single-user mode, where the sole user owns the account', async () => {
    expect(await run(undefined, false)).toEqual({ probe: false, clone: false });
  });
});
