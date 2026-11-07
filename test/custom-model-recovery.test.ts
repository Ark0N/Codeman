/**
 * @fileoverview Boot recovery re-derives a saved custom-model selection through
 * `_rebuildCustomModelEnv` and rebuilds the BOOKKEEPING from what the CURRENT recipe
 * applied, not from the saved record. A selection persisted while deepseek still used
 * the old env redirect comes back env-shaped (envKeys `DEEPSEEK_BASE_URL`/
 * `DEEPSEEK_API_KEY`, no `configDir`) although the recipe now writes a per-session patch
 * home: restoring the saved record unchanged left `DSH_HOME` on a generated config dir
 * that clearing could never delete.
 *
 * Real-home resolution reads the record's `ownEnv` on this path, never the session's
 * overrides: the first apply's links are still in the generated directory, and an entry
 * that is missing links from the own home, or with none from the server's `DSH_HOME` or
 * the recipe's `realHomeFallback` (~/.dsh), see `_rebuildCustomModelEnv`'s comment. The
 * own home itself comes back on clear from `ownEnv`, the last block here.
 *
 * `_restoreCustomModel` reads no `this` state beyond the rebuild helper (it re-derives
 * everything from the endpoint store and the Session it is handed), so it is driven off
 * the prototype with a minimal receiver: `restoreMuxSessions()` itself cannot be
 * reached under vitest, the same constraint recorded in test/session-model-recovery.test.ts.
 */
import { existsSync, mkdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
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

  describe("a session's own value across a restart", () => {
    const OWN_HOME = '/home/u/my-dsh';
    const ORIGINAL_MULTIUSER = process.env.CODEMAN_MULTIUSER;

    afterEach(() => {
      if (ORIGINAL_MULTIUSER === undefined) delete process.env.CODEMAN_MULTIUSER;
      else process.env.CODEMAN_MULTIUSER = ORIGINAL_MULTIUSER;
    });

    /** What a previous run left in state.json for a deepseek session on its own home. */
    function savedByPreviousRun(): CustomModelBookkeeping {
      const previous = new Session({ workingDir: '/tmp', mode: 'deepseek', envOverrides: { DSH_HOME: OWN_HOME } });
      configs.push(previous.id);
      previous.setCustomModel(
        {
          endpointId: 'ep',
          modelId: 'qwen3',
          envKeys: ['DSH_HOME', 'CODEMAN_CUSTOM_MODEL_API_KEY'],
          configDir: customModelConfigDir(previous.id),
          homeEnvVar: 'DSH_HOME',
        },
        { DSH_HOME: customModelConfigDir(previous.id), CODEMAN_CUSTOM_MODEL_API_KEY: 'k' }
      );
      return JSON.parse(JSON.stringify(previous.getCustomModelForPersist())) as CustomModelBookkeeping;
    }

    it('gets DSH_HOME back from state.json, which is the only copy left', async () => {
      await writeCustomModelHosts(getDataDir(), [endpoint()]);
      const session = new Session({ workingDir: '/tmp', mode: 'deepseek' });
      configs.push(session.id);

      await restoreCustomModel(session, savedByPreviousRun());
      expect(session.envOverrideValue('DSH_HOME')).toBe(customModelConfigDir(session.id));

      session.setCustomModel(undefined);
      expect(session.envOverrideValue('DSH_HOME')).toBe(OWN_HOME);
    });

    it('never fills an entry the own home lacks from the server home', async () => {
      // The first apply skipped `settings.yaml`, since the own home has none. Recovery finds
      // that gap and, with no lookup, used to fill it with the server's settings.
      const serverHome = join(homedir(), 'codeman-recovery-server-dsh');
      const ownHome = join(homedir(), 'codeman-recovery-own-dsh');
      mkdirSync(join(ownHome, 'profiles'), { recursive: true });
      mkdirSync(serverHome, { recursive: true });
      writeFileSync(join(serverHome, 'settings.yaml'), 'server: true\n');
      vi.stubEnv('DSH_HOME', serverHome);
      await writeCustomModelHosts(getDataDir(), [endpoint()]);
      const session = new Session({ workingDir: '/tmp', mode: 'deepseek' });
      configs.push(session.id);

      await restoreCustomModel(session, {
        endpointId: 'ep',
        modelId: 'qwen3',
        envKeys: ['DSH_HOME', 'CODEMAN_CUSTOM_MODEL_API_KEY'],
        homeEnvVar: 'DSH_HOME',
        ownEnv: { DSH_HOME: ownHome },
      });

      const configDir = customModelConfigDir(session.id);
      expect(readlinkSync(join(configDir, 'profiles'))).toBe(join(ownHome, 'profiles'));
      expect(existsSync(join(configDir, 'settings.yaml'))).toBe(false);
      rmSync(ownHome, { recursive: true, force: true });
      rmSync(serverHome, { recursive: true, force: true });
    });

    it('keeps it when the endpoint is gone', async () => {
      await writeCustomModelHosts(getDataDir(), []);
      const session = new Session({ workingDir: '/tmp', mode: 'deepseek' });

      await restoreCustomModel(session, savedByPreviousRun());

      session.setCustomModel(undefined);
      expect(session.envOverrideValue('DSH_HOME')).toBe(OWN_HOME);
    });

    it('never reads what the previous run injected as the session own value', async () => {
      // A record from before `ownEnv` existed. `__envOverrides` holds the isolated
      // CLAUDE_CONFIG_DIR and the injected limit, which must go on clear, or the session
      // stays pinned to a directory the clear just deleted.
      await writeCustomModelHosts(getDataDir(), [endpoint()]);
      const session = new Session({
        workingDir: '/tmp',
        mode: 'claude',
        envOverrides: { CLAUDE_CONFIG_DIR: '/isolated/old', CLAUDE_CODE_MAX_CONTEXT_TOKENS: '32768' },
      });
      configs.push(session.id);

      await restoreCustomModel(session, {
        endpointId: 'ep',
        modelId: 'qwen3',
        envKeys: ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS'],
      });

      session.setCustomModel(undefined);
      expect(session.envOverrideValue('CLAUDE_CONFIG_DIR')).toBeUndefined();
      expect(session.envOverrideValue('CLAUDE_CODE_MAX_CONTEXT_TOKENS')).toBeUndefined();
    });

    it('does not give a revoked owner their DSH_HOME back from disk', async () => {
      // DSH_HOME is a privileged key: the reboot-restore clamp strips `__envOverrides`, and
      // this record must not be a way around it.
      await writeCustomModelHosts(getDataDir(), [endpoint()]);
      const saved = savedByPreviousRun();
      process.env.CODEMAN_MULTIUSER = '1';
      const session = new Session({ workingDir: '/tmp', mode: 'deepseek', owner: 'nobody' });
      configs.push(session.id);

      await restoreCustomModel(session, saved);

      session.setCustomModel(undefined);
      expect(session.envOverrideValue('DSH_HOME')).toBeUndefined();
    });
  });
});
