/**
 * @fileoverview Boot recovery re-derives a saved custom-model selection through
 * `_rebuildCustomModelEnv` and rebuilds the BOOKKEEPING from what the CURRENT recipe
 * applied, not from the saved record. A selection persisted while deepseek still used
 * the old env redirect comes back env-shaped (envKeys `DEEPSEEK_BASE_URL`/
 * `DEEPSEEK_API_KEY`, no `configDir`) although the recipe now writes a per-session patch
 * home: restoring the saved record unchanged left `DSH_HOME` on a generated config dir
 * that clearing could never delete.
 *
 * Real-home resolution is NOT recovered from the session's env overrides any more:
 * `getEnvOverridesForPersist()` keeps only `CLAUDE_CODE_*`/`CLAUDE_CONFIG_DIR`, so a
 * session's own `DSH_HOME` never survives a real restart and the lookup only ever hit on
 * the first apply in-process. Recovery falls back to the server's `DSH_HOME` or the
 * recipe's `realHomeFallback` (~/.dsh), see `_rebuildCustomModelEnv`'s comment.
 *
 * `_restoreCustomModel` reads no `this` state beyond the rebuild helper (it re-derives
 * everything from the endpoint store and the Session it is handed), so it is driven off
 * the prototype with a minimal receiver: `restoreMuxSessions()` itself cannot be
 * reached under vitest, the same constraint recorded in test/session-model-recovery.test.ts.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDataDir } from '../src/config/instance.js';
import { writeCustomModelHosts, type CustomModelHost } from '../src/custom-model-hosts.js';
import { customModelConfigDir, removeConfigDir } from '../src/custom-model-injection-apply.js';
import { Session } from '../src/session.js';
import { WebServer } from '../src/web/server.js';
import type { CustomModelBookkeeping } from '../src/types/session.js';

/** The real pair, on a receiver that only carries the rebuild helper, see the header. */
async function restoreCustomModel(session: Session, saved: CustomModelBookkeeping): Promise<void> {
  const proto = WebServer.prototype as unknown as {
    _rebuildCustomModelEnv: (session: Session, saved: CustomModelBookkeeping) => Promise<unknown>;
    _restoreCustomModel: (session: Session, saved: CustomModelBookkeeping) => Promise<void>;
  };
  expect(typeof proto._restoreCustomModel, '_restoreCustomModel vanished from WebServer.prototype').toBe('function');
  await proto._restoreCustomModel.call({ _rebuildCustomModelEnv: proto._rebuildCustomModelEnv }, session, saved);
}

function endpoint(): CustomModelHost {
  return {
    id: 'ep',
    label: 'Ep',
    baseUrl: 'http://localhost:8080',
    apiKey: 'recovery-probe-key',
    models: ['qwen3'],
  };
}

describe('_restoreCustomModel: bookkeeping rebuilt from the current recipe', () => {
  const configs: string[] = [];

  afterEach(() => {
    for (const id of configs.splice(0)) removeConfigDir(customModelConfigDir(id));
    vi.unstubAllEnvs();
  });

  it('carries the configDir and env-key union for a selection saved by the old env recipe', async () => {
    // Saved exactly as 1.31.0-1.47.0 persisted a deepseek selection: the env recipe's two
    // keys, no configDir. The rebuilt record must carry the per-session config dir the
    // CURRENT recipe wrote (so clearing deletes it) while KEEPING the saved keys, which
    // the tmux session may still carry `setenv`s for (the union is what a clear unsets).
    const dshHome = join(homedir(), 'codeman-recovery-dsh-home');
    mkdirSync(join(dshHome, 'profiles'), { recursive: true });
    vi.stubEnv('DSH_HOME', dshHome);
    await writeCustomModelHosts(getDataDir(), [endpoint()]);
    const session = new Session({ workingDir: '/tmp', mode: 'deepseek' });
    configs.push(session.id);

    await restoreCustomModel(session, {
      endpointId: 'ep',
      modelId: 'qwen3',
      label: 'Ep',
      envKeys: ['DEEPSEEK_BASE_URL', 'DEEPSEEK_API_KEY'],
    });

    const persisted = session.getCustomModelForPersist();
    expect(persisted?.configDir).toBe(customModelConfigDir(session.id));
    expect(persisted?.launchModel).toBeUndefined();
    expect(new Set(persisted?.envKeys)).toEqual(
      new Set(['DEEPSEEK_BASE_URL', 'DEEPSEEK_API_KEY', 'DSH_HOME', 'CODEMAN_CUSTOM_MODEL_API_KEY'])
    );
    rmSync(dshHome, { recursive: true, force: true });
  });

  it('restores an env-shaped record unchanged when the endpoint is gone, so a clear still works', async () => {
    await writeCustomModelHosts(getDataDir(), []);
    const session = new Session({ workingDir: '/tmp', mode: 'deepseek' });
    const saved: CustomModelBookkeeping = {
      endpointId: 'gone',
      modelId: 'qwen3',
      label: 'Gone',
      envKeys: ['DEEPSEEK_BASE_URL', 'DEEPSEEK_API_KEY'],
    };

    await restoreCustomModel(session, saved);

    expect(session.getCustomModelForPersist()).toEqual(saved);
  });
});
