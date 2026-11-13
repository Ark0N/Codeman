/**
 * @fileoverview Boot recovery rebuilds a saved custom-model selection through the SAME
 * context-length resolution the routes use: the model's discovered figure, falling back to
 * the endpoint's `defaultContextLength` (`resolveCustomModelContextLength`). Before the
 * shared helper, `_rebuildCustomModelEnv` read `modelContextLengths` alone, so a session
 * on a model that only the endpoint default covers came back from a Codeman restart with
 * `CLAUDE_CODE_MAX_CONTEXT_TOKENS` (or a config file's context figure) silently gone,
 * re-arming exactly the window overflow the var exists to prevent.
 *
 * `_rebuildCustomModelEnv` reads no `this` state (it re-derives everything from the endpoint
 * store and the Session it is handed), so it is driven straight off the prototype with an
 * empty receiver: `restoreMuxSessions()` itself cannot be reached under vitest, the same
 * constraint recorded in test/session-model-recovery.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { getDataDir } from '../src/config/instance.js';
import { writeCustomModelHosts, type CustomModelHost } from '../src/custom-model-hosts.js';
import { customModelConfigDir, removeConfigDir, type AppliedCustomModel } from '../src/custom-model-injection-apply.js';
import { Session } from '../src/session.js';
import { WebServer } from '../src/web/server.js';
import type { CustomModelBookkeeping } from '../src/types/session.js';

type RebuildFn = (session: Session, saved: CustomModelBookkeeping) => Promise<AppliedCustomModel | undefined>;

/** The real method, with an empty receiver, see the file header for why that is sound. */
function rebuildCustomModelEnv(session: Session, saved: CustomModelBookkeeping) {
  const fn = (WebServer.prototype as unknown as { _rebuildCustomModelEnv: RebuildFn })._rebuildCustomModelEnv;
  expect(typeof fn, '_rebuildCustomModelEnv vanished from WebServer.prototype').toBe('function');
  return fn.call({}, session, saved);
}

function endpoint(overrides: Partial<CustomModelHost> = {}): CustomModelHost {
  return {
    id: 'ep',
    label: 'Ep',
    baseUrl: 'http://localhost:8080',
    apiKey: 'recovery-probe-key',
    models: ['qwen3'],
    ...overrides,
  };
}

describe('_rebuildCustomModelEnv: context-length fallback on boot recovery', () => {
  const configs: string[] = [];

  afterEach(() => {
    for (const id of configs.splice(0)) removeConfigDir(customModelConfigDir(id));
  });

  it('falls back to the endpoint defaultContextLength when discovery recorded no per-model figure', async () => {
    await writeCustomModelHosts(getDataDir(), [endpoint({ defaultContextLength: 32768 })]);
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    configs.push(session.id);

    const env = await rebuildCustomModelEnv(session, { endpointId: 'ep', modelId: 'qwen3', envKeys: [] });

    expect(env?.envOverrides.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('32768');
  });

  it('a discovered per-model figure still wins over the endpoint default', async () => {
    await writeCustomModelHosts(getDataDir(), [
      endpoint({ modelContextLengths: { qwen3: 131072 }, defaultContextLength: 32768 }),
    ]);
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    configs.push(session.id);

    const env = await rebuildCustomModelEnv(session, { endpointId: 'ep', modelId: 'qwen3', envKeys: [] });

    expect(env?.envOverrides.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('131072');
  });

  it('states nothing rather than guessing when neither source knows a window', async () => {
    await writeCustomModelHosts(getDataDir(), [endpoint()]);
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    configs.push(session.id);

    const env = await rebuildCustomModelEnv(session, { endpointId: 'ep', modelId: 'qwen3', envKeys: [] });

    expect(env?.envOverrides.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBeUndefined();
  });

  it('drops the selection to undefined (kept for clearing) when the endpoint no longer exists', async () => {
    await writeCustomModelHosts(getDataDir(), []);
    const session = new Session({ workingDir: '/tmp', mode: 'claude' });
    configs.push(session.id);

    await expect(rebuildCustomModelEnv(session, { endpointId: 'gone', modelId: 'qwen3', envKeys: [] })).resolves.toBe(
      undefined
    );
  });
});
